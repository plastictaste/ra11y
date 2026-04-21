/**
 * The `conformance_statement` MCP tool. Given a conformance profile
 * (standardId + level), inspects the evidence ledger produced by a
 * fresh scan and either returns a statement with `conformant: true`
 * or refuses with the full blocker list.
 *
 * This is the tool an agent calls after it believes the codebase is
 * ready to claim conformance (e.g. after fixing violations, running
 * manual review, and attesting n/a for media criteria in a text-only
 * app). The response's `blockers` array tells the agent exactly what
 * evidence is still missing, routed by `reason` to the next tool call
 * (`attest`, `suggest_fix`, `checklist`).
 *
 * Read-only and idempotent — same ledger + profile in, same statement
 * out. Doesn't mutate the project; the audit trail lives in
 * `.ra11y/attestations.jsonl` (via `attest`).
 */

import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import {
  BUILTIN_PROFILES,
  getProfile,
  type ConformanceProfile as NamedConformanceProfile,
  resolveProfile,
} from "../config/profiles.ts";
import { type ParsedFile, runScan } from "../engine/scanner.ts";
import { createGitStalenessProbe } from "../reports/attestation-surface.ts";
import {
  buildConformanceStatement,
  type ConformanceProfile,
  renderConformanceMarkdown,
} from "../reports/conformance.ts";
import type { ConfigFingerprint, FileManifestEntry } from "../reports/conformance-signature.ts";
import type { LoadedConfig } from "../types/config.ts";
import type { AttestationRecord } from "../types/evidence.ts";
import { headSha } from "../utils/git.ts";
import { VERSION } from "../version.ts";
import { buildDerivativeScanWarnings } from "./response-assembler.ts";
import {
  applyRuleSettings,
  errorResult,
  firstUnknownStandard,
  loadDurableAttestations,
  type McpTool,
  parseFiles,
  resolveLevel,
  resolveStandards,
  satisfyingRulesForCriterion,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";

export const conformanceStatementTool: McpTool = {
  def: {
    name: "conformance_statement",
    description:
      'Produce a conformance claim for this project against a WCAG (or other standard) profile. Returns `conformant: true` only when every in-scope criterion is backed by a non-candidate evidence source (static pass, attested, or sampled) with a final status of pass or n/a. Otherwise returns `conformant: false` plus a `blockers` list — one entry per criterion still missing evidence, with a `reason` routing the agent to the next tool:\n\n  - `"failing"` → call `suggest_fix` on the cited findings.\n  - `"candidate-only"` → call `attest` after reviewing, or dismiss with a source pragma.\n  - `"no-evidence"` → call `attest` to record the evidence, or run `checklist` to work through manual review.\n  - `"partially-attested"` → some rules under the criterion have been attested but the union does not yet cover every satisfying rule. Call `attest` with the missing `ruleIds` to close the gap (see ADR 0013).\n  - `"runtime-evidence-required"` → a runtime-dependent criterion (keyboard, focus-visible, rendered contrast, heading adequacy, …) has zero fail-evidence but also no attested/sampled source closing the gap. The blocker carries `status: "undetermined"` and the criterion appears in the top-level `limitations[]` prose list. Run a runtime harness or manual audit, then call `attest` with the verdict.\n\nThe response carries a top-level `limitations[]` array — present-when-non-empty — listing criteria whose only signal was absence-of-static-findings against a runtime-only requirement. A claim consumer reading `status === "pass"` unconditionally must also inspect `limitations[]` to stay honest. A Markdown rendering (`markdown` field) is suitable for dropping into a release note or audit bundle. Read-only.',
    inputSchema: {
      type: "object",
      properties: {
        standard: {
          type: "string",
          description:
            "Standard ID (e.g. `wcag22`, `wcag21`, `section508`). Defaults to session config.",
        },
        level: {
          type: "string",
          enum: ["A", "AA", "AAA", "base"],
          description:
            "Conformance level to claim. A|AA|AAA for WCAG-like standards; `base` for standards that don't stratify by level (Section 508, plugins).",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional scan paths. Omit to scan the whole project rooted at `cwd`.",
        },
        cwd: {
          type: "string",
          description:
            "Project root — used to resolve paths and load `.ra11y/attestations.jsonl`. Defaults to the MCP server's spawn directory.",
        },
        profile: {
          type: "string",
          description:
            "Named conformance profile (e.g. `wcag22-aa`, `wcag21-aa`, `section508`, `en301549`). When supplied the claim's in-scope criterion set narrows to the profile's `standards` + `level?` tuple — the same scope `/coverage` honors — so the statement only stands on evidence for criteria inside the profile. Resolves against built-in profiles first, then `Config.profiles` user overrides. Omit to claim against the full `standard` + `level` pair above.",
        },
        technologiesReliedUpon: {
          type: "array",
          items: { type: "string" },
          description:
            'Web content technologies the claim relies upon, per WCAG §5.3.1(5) — e.g. `["HTML", "CSS", "ECMAScript", "WAI-ARIA"]`. Omit to fall back to the safe web-project default; override when the product declares a narrower or broader set.',
        },
        technologiesNotReliedUpon: {
          type: "array",
          items: { type: "string" },
          description:
            "Technologies explicitly excluded from the claim — useful for e.g. no-JS fallback claims. Defaults to `[]`.",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const cwd = strParam(params, "cwd") ?? process.cwd();
    const paths = strArrayParam(params, "paths") ?? [cwd];

    const profileResolution = await resolveNamedProfile(strParam(params, "profile"), session, cwd);
    if (profileResolution.error !== undefined) return profileResolution.error;
    const namedProfile = profileResolution.profile;

    const standards = resolveStandards(strParam(params, "standard"), session);
    const unknown = firstUnknownStandard(standards, session);
    if (unknown !== null) {
      return errorResult({
        code: "standard-not-found",
        message: `Unknown standard '${unknown}'. Loaded: ${session.registry.standards.map((s) => s.id).join(", ")}.`,
        details: { requested: unknown, loaded: session.registry.standards.map((s) => s.id) },
        remediation: "Pass `standard` with a loaded ID, or omit to use the session default.",
      });
    }
    if (standards.length !== 1) {
      return errorResult({
        code: "invalid-param",
        message:
          "conformance_statement targets exactly one standard at a time. Pass `standard` explicitly when the session default resolves to more than one.",
        details: { requested: standards },
      });
    }
    const standardId = standards[0];
    if (standardId === undefined) {
      return errorResult({
        code: "invalid-param",
        message: "conformance_statement requires a `standard` value.",
      });
    }

    const levelParam = strParam(params, "level");
    const profile: ConformanceProfile = {
      standardId,
      level: resolveProfileLevel(levelParam, session),
    };

    const files = await parseFiles(paths, session, cwd);
    const attestations = await loadDurableAttestations(cwd);
    const loadedConfig = await loadProjectConfigSafe(session, cwd);
    const { ledger } = runScan({
      standards: session.registry.standards,
      rules: applyRuleSettings(session.registry.rules, session.config.rules),
      enabled: [standardId],
      files,
      finders: session.registry.finders,
      ...(profile.level !== "base" && { level: profile.level }),
      ...(attestations.length > 0 && { attestations }),
    });

    const signingContext = buildSigningContext({
      cwd,
      files,
      attestations,
      loadedConfig,
      session,
      profile,
      standardId,
      params,
    });

    const stalenessProbe = createGitStalenessProbe(cwd);
    const statement = buildConformanceStatement(
      assembleBuilderInputs({
        ledger,
        profile,
        files,
        params,
        session,
        namedProfile,
        signing: signingContext.signing,
        stalenessProbe,
        loadedConfig,
      }),
    );

    // Merge the tool-level signing warning with the builder's own
    // warnings (e.g. `stale_probe_unavailable`) and the shared
    // scan-confidence codes emitted by `buildDerivativeScanWarnings`
    // (ADR 0024 stage 4) so the agent reads one deduplicated set.
    // Order is alphabetical for determinism.
    //
    // Doctrine (CLAUDE.md §1 "Zero-output success is ambiguous failure"):
    // a `conformance_statement` response on a real-but-empty scan root
    // would otherwise read as a conformance verdict over "the whole
    // project" when the scanner saw zero parseable files — the
    // `scanned_zero_files` code surfaces that honestly. `rootSource:
    // null` mirrors `checklist` / `coverage`: this tool takes `paths`
    // directly, defaulting to `[cwd]`, so `root_source_defaulted` has
    // no meaning here. `configSource: undefined` suppresses
    // `no_config_found` for parity with those sibling tools —
    // conformance uses the loaded config for signing-fingerprint
    // inputs, not as a scan gating signal, and emitting the code here
    // would diverge from the derivative-tool contract. `analysisCoverage`
    // / `filesByExtension` aren't computed in this handler, so
    // extension-skip / Tailwind-undercount codes simply don't fire
    // until those signals are plumbed through.
    const derivativeWarnings = buildDerivativeScanWarnings({
      filesScanned: files.length,
      rootSource: null,
      configSource: undefined,
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    const toolWarnings = new Set<string>(statement.warnings ?? []);
    for (const code of derivativeWarnings.warnings ?? []) toolWarnings.add(code);
    if (signingContext.signing === undefined) toolWarnings.add("non_git_repo_signature_omitted");
    const mergedWarnings = [...toolWarnings].sort();

    return textResult({
      ...statement,
      markdown: renderConformanceMarkdown(statement),
      nextStep: buildNextStep(statement),
      ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
      ...(derivativeWarnings.warningsDetails === undefined
        ? {}
        : { warningsDetails: derivativeWarnings.warningsDetails }),
    });
  },
};

/**
 * Builds the `nextStep` hint for the agent. Splits the hard "not
 * conformant" case on whether the blockers include a structural gap
 * (stale attestation, missing process config) vs a content gap (missing
 * evidence, failing rules) so the agent routes to the right tool
 * without scanning every blocker's reason.
 */
function buildNextStep(statement: ReturnType<typeof buildConformanceStatement>): string {
  if (statement.conformant) {
    return "Conformant. Drop the `markdown` block into your release notes or audit bundle; commit `.ra11y/attestations.jsonl` so the evidence trail persists.";
  }
  const hasStale = statement.blockers.some((b) => b.reason === "stale-attestation");
  const hasMissingProcess = statement.blockers.some((b) => b.reason === "missing-process-config");
  const hasRuntimeEvidence = statement.blockers.some(
    (b) => b.reason === "runtime-evidence-required",
  );
  const extras: string[] = [];
  if (hasStale) {
    extras.push(
      "`stale-attestation` → re-run `attest` for the cited criteria; files in the attestation's scope changed since it was recorded.",
    );
  }
  if (hasMissingProcess) {
    extras.push(
      "`missing-process-config` → declare a `processes` entry in `ra11y.config.ts` covering the ordered page set (ADR 0016), then re-run.",
    );
  }
  if (hasRuntimeEvidence) {
    extras.push(
      "`runtime-evidence-required` (also surfaced in `limitations[]`) → run a runtime harness or manual keyboard/focus/contrast audit, then call `attest` with the verdict; static analysis cannot prove pass on these criteria.",
    );
  }
  const base =
    "Not conformant — read `blockers[]`. Each entry's `reason` tells you which tool to call next: `failing` → suggest_fix; `candidate-only` or `no-evidence` → attest (or checklist); `partially-attested` → attest with the missing ruleIds.";
  if (extras.length === 0) return base;
  return `${base} ${extras.join(" ")}`;
}

/**
 * Assembles the builder inputs from the tool's request context. Split
 * from the handler body to keep the handler under the project's
 * complexity budget; the work done here is mechanical forwarding —
 * extract `files[].filePath`, snapshot the session config for the
 * scope, and conditional-spread the optional technology overrides.
 */
function assembleBuilderInputs(ctx: {
  readonly ledger: Parameters<typeof buildConformanceStatement>[0]["ledger"];
  readonly profile: ConformanceProfile;
  readonly files: ReadonlyArray<{ readonly filePath: string }>;
  readonly params: Record<string, unknown>;
  readonly session: Parameters<typeof conformanceStatementTool.handler>[1];
  readonly namedProfile: NamedConformanceProfile | undefined;
  readonly signing:
    | NonNullable<Parameters<typeof buildConformanceStatement>[0]["signing"]>
    | undefined;
  readonly stalenessProbe:
    | NonNullable<Parameters<typeof buildConformanceStatement>[0]["stalenessProbe"]>
    | undefined;
  readonly loadedConfig: LoadedConfig | null;
}): Parameters<typeof buildConformanceStatement>[0] {
  const technologiesReliedUpon = strArrayParam(ctx.params, "technologiesReliedUpon");
  const technologiesNotReliedUpon = strArrayParam(ctx.params, "technologiesNotReliedUpon");
  const configSnapshot: Record<string, unknown> = {
    standard: ctx.session.config.standard,
    level: ctx.session.config.level,
    exclude: [...ctx.session.config.exclude],
    nativeWrappers: [...ctx.session.config.nativeWrappers],
  };
  const processes = ctx.loadedConfig?.processes;
  return {
    ledger: ctx.ledger,
    profile: ctx.profile,
    standards: ctx.session.registry.standards,
    rulesForCriterion: (criterionId: string) =>
      satisfyingRulesForCriterion(criterionId, ctx.session),
    files: ctx.files.map((f) => f.filePath),
    ...(ctx.signing !== undefined && { commitHash: ctx.signing.commitHash }),
    configSnapshot,
    ...(technologiesReliedUpon !== undefined && { technologiesReliedUpon }),
    ...(technologiesNotReliedUpon !== undefined && { technologiesNotReliedUpon }),
    ...(ctx.namedProfile !== undefined && { scope: ctx.namedProfile }),
    ...(ctx.signing !== undefined && { signing: ctx.signing }),
    ...(ctx.stalenessProbe !== undefined && { stalenessProbe: ctx.stalenessProbe }),
    ...(processes !== undefined && processes.length > 0 && { processes }),
  };
}

function resolveProfileLevel(
  raw: string | undefined,
  session: { readonly config: { readonly level: "A" | "AA" | "AAA" } },
): "A" | "AA" | "AAA" | "base" {
  if (raw === "base") return "base";
  return resolveLevel(raw, session as never);
}

/**
 * Loads the project config, swallowing any error (malformed user
 * config, missing file) and returning `null`. Called from the signing
 * path so a broken config doesn't block statement emission — the
 * signing fingerprint falls back to session-only values when this
 * returns `null`, keeping standards + level pinned even without a
 * file-loaded config.
 */
async function loadProjectConfigSafe(
  session: Parameters<typeof conformanceStatementTool.handler>[1],
  cwd: string,
): Promise<LoadedConfig | null> {
  try {
    return await session.loadProjectConfig(cwd);
  } catch {
    return null;
  }
}

/**
 * Resolves the named-profile parameter. Returns `{ profile }` on
 * success, `{ error }` with a structured-error result when the caller
 * passed an unknown profile name. Split from the handler body to keep
 * its complexity under the project budget — the profile resolution
 * owns config-load + built-in/user overlay lookup + error envelope
 * construction, which is enough branching to warrant its own scope.
 */
async function resolveNamedProfile(
  profileName: string | undefined,
  session: Parameters<typeof conformanceStatementTool.handler>[1],
  cwd: string,
): Promise<{
  readonly profile: NamedConformanceProfile | undefined;
  readonly error?: ReturnType<typeof errorResult>;
}> {
  if (profileName === undefined) return { profile: undefined };
  // Load project config only when the caller asked for a profile —
  // built-ins cover the common case without touching disk. User
  // overrides layer on top via `LoadedConfig.profiles`; resolution
  // falls through built-ins → user-declared per `resolveProfile`'s
  // contract in src/config/profiles.ts.
  let userProfiles: readonly NamedConformanceProfile[] = [];
  try {
    const loaded = await session.loadProjectConfig(cwd);
    userProfiles = loaded.profiles;
  } catch {
    // Config-load failures (malformed user config) fall through to
    // built-in-only resolution.
  }
  const resolved = getProfile(profileName) ?? resolveProfile(profileName, userProfiles);
  if (resolved !== undefined) return { profile: resolved };
  const valid = [...BUILTIN_PROFILES.map((p) => p.name), ...userProfiles.map((p) => p.name)];
  return {
    profile: undefined,
    error: errorResult({
      code: "invalid-param",
      message: `Unknown profile '${profileName}'. Valid profiles: ${valid.join(", ")}.`,
      details: { requested: profileName, valid },
      remediation:
        "Pass a named profile from the built-in set (wcag22-aa, wcag21-aa, section508, en301549, …) or declare one in `ra11y.config.ts` `profiles[]`.",
    }),
  };
}

/**
 * Assembles the signing inputs used by the conformance-statement
 * signature. Returns `{ signing: undefined }` when the project is not
 * a git repo — `headSha()` returning `null` is the signal, and the
 * caller surfaces a top-level `warnings: ["non_git_repo_signature_omitted"]`
 * so the agent knows the claim stands on commit-less evidence.
 *
 * When inside a repo, packs `commitHash`, the durable attestation
 * ledger, the file-content manifest, the config fingerprint, and the
 * tool version into the shape `buildConformanceStatement` digests.
 */
function buildSigningContext(args: {
  readonly cwd: string;
  readonly files: readonly ParsedFile[];
  readonly attestations: readonly AttestationRecord[];
  readonly loadedConfig: LoadedConfig | null;
  readonly session: Parameters<typeof conformanceStatementTool.handler>[1];
  readonly profile: ConformanceProfile;
  readonly standardId: string;
  readonly params: Record<string, unknown>;
}): {
  readonly signing:
    | NonNullable<Parameters<typeof buildConformanceStatement>[0]["signing"]>
    | undefined;
} {
  const commitHash = headSha(args.cwd);
  if (commitHash === null) return { signing: undefined };
  const configFingerprint = buildConfigFingerprint({
    standardId: args.standardId,
    level: args.profile.level,
    profileName: strParam(args.params, "profile"),
    loadedConfig: args.loadedConfig,
    sessionNativeWrappers: args.session.config.nativeWrappers,
    additionalPaths: strArrayParam(args.params, "paths"),
  });
  return {
    signing: {
      commitHash,
      attestations: args.attestations,
      configFingerprint,
      fileManifest: buildFileManifest(args.files, args.cwd),
      toolVersion: VERSION,
    },
  };
}

/**
 * Builds a per-file SHA-256 manifest over the parsed sources, keyed by
 * relative path from the scan root. Path normalization to relative form
 * means the signature doesn't drift across machines with different
 * absolute cwds; sorting happens inside the signature canonicalizer.
 */
function buildFileManifest(
  files: readonly ParsedFile[],
  cwd: string,
): readonly FileManifestEntry[] {
  return files.map((f) => {
    const path = isAbsolute(f.filePath) ? relative(cwd, f.filePath) : f.filePath;
    const sha256 = createHash("sha256").update(f.source, "utf8").digest("hex");
    return { path, sha256 };
  });
}

/**
 * Builds the {@link ConfigFingerprint} for the signing input. Pulls the
 * resolved config slice the scan ran with — when a project config
 * loaded, that's the source of truth (rules, nativeWrappers, processes).
 * When no config resolved, falls back to the session's values so the
 * fingerprint still pins standards + level + session wrappers. Optional
 * fields are conditional-spread so empty user-config sections don't
 * widen the digest with `[]` / `{}` sentinels.
 */
function buildConfigFingerprint(args: {
  readonly standardId: string;
  readonly level: "A" | "AA" | "AAA" | "base";
  readonly profileName: string | undefined;
  readonly loadedConfig: LoadedConfig | null;
  readonly sessionNativeWrappers: readonly string[];
  readonly additionalPaths: readonly string[] | undefined;
}): ConfigFingerprint {
  const standards = args.loadedConfig?.standards ?? [args.standardId];
  const nativeWrappers = args.loadedConfig?.nativeWrappers ?? args.sessionNativeWrappers;
  const rulesMap = args.loadedConfig?.rules;
  const processes = args.loadedConfig?.processes;
  return {
    standards: [...standards],
    ...(args.level !== "base" && { level: args.level }),
    ...(args.profileName !== undefined && { profile: args.profileName }),
    ...(rulesMap !== undefined && Object.keys(rulesMap).length > 0 && { rules: { ...rulesMap } }),
    ...(nativeWrappers.length > 0 && { nativeWrappers: [...nativeWrappers] }),
    ...(processes !== undefined &&
      processes.length > 0 && {
        processes: processes.map((p) => ({ name: p.name, pages: [...p.pages] })),
      }),
    ...(args.additionalPaths !== undefined &&
      args.additionalPaths.length > 0 && { additionalPaths: [...args.additionalPaths] }),
  };
}
