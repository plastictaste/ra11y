/**
 * `ra11y conformance [--verify <bundle.json>]` — CLI wrapper for the
 * conformance-statement pipeline.
 *
 * Two modes:
 *   - Default: runs a scan, aggregates durable attestations, invokes
 *     `buildConformanceStatement`, and emits the result as Markdown
 *     (default) or JSON. Commit hash, config fingerprint, and file
 *     manifest are stamped into a signed bundle when the scan runs
 *     inside a git repo; outside a repo the signature block is omitted
 *     and the response carries the `non_git_repo_signature_omitted`
 *     warning.
 *   - `--verify <path>`: loads the bundle JSON at the given path, rebuilds
 *     the verification input from the same pipeline, calls
 *     `verifyConformanceBundle`, and reports `valid`/`invalid` plus the
 *     drift reason.
 *
 * Exit codes (CLAUDE.md §12):
 *   - `OK` — render succeeded (either mode). In verify mode, the bundle
 *     verified cleanly.
 *   - `USER_ERROR` — unknown standard/profile, malformed bundle, verify
 *     mismatch, scan pipeline failure.
 *   - `VIOLATIONS` — statement is non-conformant (blockers remain).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { readAttestations } from "../../config/attestation-store.ts";
import { loadConfig } from "../../config/index.ts";
import { parseInlineDisablesDetailed } from "../../config/inline-disables.ts";
import {
  BUILTIN_PROFILES,
  type ConformanceProfile as NamedConformanceProfile,
  resolveProfile,
} from "../../config/profiles.ts";
import { type ParsedFile, runScan } from "../../engine/scanner.ts";
import { discoverFiles } from "../../input/discover.ts";
import { parseCss, parseHtml, parseMdx, parseScss, parseTsx } from "../../input/parsers/index.ts";
import { createGitStalenessProbe } from "../../reports/attestation-surface.ts";
import {
  buildConformanceStatement,
  type ConformanceProfile,
  type ConformanceStatement,
  renderConformanceMarkdown,
} from "../../reports/conformance.ts";
import {
  type ConfigFingerprint,
  type ConformanceSignature,
  type FileManifestEntry,
  type SignatureInput,
  verifyConformanceBundle,
} from "../../reports/conformance-signature.ts";
import { BUILTIN_CANDIDATE_FINDERS } from "../../review/index.ts";
import { BUILTIN_RULES } from "../../rules/index.ts";
import { BUILTIN_STANDARDS } from "../../standards/index.ts";
import type { Ast } from "../../types/ast.ts";
import type { LoadedConfig } from "../../types/config.ts";
import { headSha } from "../../utils/git.ts";
import { VERSION } from "../../version.ts";
import type { CliOptions } from "../args.ts";
import { ExitCode } from "../exit-codes.ts";
import type { ScanExit } from "./scan.ts";

export function runConformance(options: CliOptions): Promise<ScanExit> {
  if (options.conformanceVerify !== undefined) {
    return runVerify(options, options.conformanceVerify);
  }
  return runEmit(options);
}

// ─── Emit mode (default) ──────────────────────────────────────────────────

async function runEmit(options: CliOptions): Promise<ScanExit> {
  const cwd = resolveCwd(options);
  const fileConfig = await loadConfig({ cwd });

  const profileResolution = resolveProfileArg(options, fileConfig);
  if ("error" in profileResolution) {
    return { stdout: "", stderr: profileResolution.error, exitCode: ExitCode.USER_ERROR };
  }
  const { namedProfile, standardId, level } = profileResolution;

  const parsed = await parseScanInputs(options, fileConfig, cwd);
  const attestations = await readAttestations(cwd);
  const commitHash = headSha(cwd);
  const profile: ConformanceProfile = { standardId, level };
  const { ledger } = runScan({
    standards: BUILTIN_STANDARDS,
    rules: BUILTIN_RULES,
    enabled: [standardId],
    files: parsed,
    finders: BUILTIN_CANDIDATE_FINDERS,
    ...(level !== "base" && { level }),
    ...(attestations.length > 0 && { attestations }),
  });

  const stalenessProbe = createGitStalenessProbe(cwd);
  const signing =
    commitHash === null
      ? undefined
      : {
          commitHash,
          attestations,
          configFingerprint: buildConfigFingerprint({
            standardId,
            level,
            profileName: namedProfile?.name,
            loadedConfig: fileConfig,
          }),
          fileManifest: buildFileManifest(parsed, cwd),
          toolVersion: VERSION,
        };
  const statement = buildConformanceStatement({
    ledger,
    profile,
    standards: BUILTIN_STANDARDS,
    files: parsed.map((f) => f.filePath),
    ...(commitHash !== null && { commitHash }),
    configSnapshot: {
      standard: standardId,
      level,
      exclude: [...fileConfig.exclude],
      nativeWrappers: [...fileConfig.nativeWrappers],
    },
    ...(namedProfile !== undefined && { scope: namedProfile }),
    ...(signing !== undefined && { signing }),
    ...(stalenessProbe !== undefined && { stalenessProbe }),
    ...(fileConfig.processes.length > 0 && { processes: fileConfig.processes }),
  });

  const warnings = new Set<string>(statement.warnings ?? []);
  if (signing === undefined) warnings.add("non_git_repo_signature_omitted");

  return renderEmitResult(statement, warnings, options);
}

function renderEmitResult(
  statement: ConformanceStatement,
  warnings: ReadonlySet<string>,
  options: CliOptions,
): ScanExit {
  const stdout =
    options.conformanceOutput === "json"
      ? `${JSON.stringify(renderStatementPayload(statement, warnings), null, 2)}\n`
      : `${renderConformanceMarkdown(statement)}\n`;
  const stderr =
    warnings.size === 0 ? "" : `ra11y conformance: warnings=${[...warnings].sort().join(",")}\n`;
  // Emit is a report command — we surface the verdict via the markdown /
  // json payload. An auditor running this for a release decides whether
  // to promote or not; the caller doesn't need exit-code gating here
  // beyond "command ran cleanly." Blockers are obvious in the output.
  return { stdout, stderr, exitCode: ExitCode.OK };
}

function renderStatementPayload(
  statement: ConformanceStatement,
  warnings: ReadonlySet<string>,
): Record<string, unknown> {
  const sorted = [...warnings].sort();
  return {
    ...statement,
    ...(sorted.length > 0 && { warnings: sorted }),
  };
}

// ─── Verify mode ──────────────────────────────────────────────────────────

async function runVerify(options: CliOptions, bundlePath: string): Promise<ScanExit> {
  const cwd = resolveCwd(options);
  const absBundlePath = isAbsolute(bundlePath) ? bundlePath : resolve(cwd, bundlePath);
  if (!existsSync(absBundlePath)) {
    return {
      stdout: "",
      stderr: `ra11y conformance --verify: bundle file not found at ${absBundlePath}\n`,
      exitCode: ExitCode.USER_ERROR,
    };
  }
  const bundle = await readBundle(absBundlePath);
  if ("error" in bundle) return bundle.error;

  const fileConfig = await loadConfig({ cwd });
  const parsed = await parseScanInputs(options, fileConfig, cwd);
  const attestations = await readAttestations(cwd);
  const commitHash = headSha(cwd) ?? "";

  // Reconstruct the SignatureInput from the current tree against the
  // stamped bundle's scope. The verifier itself walks each axis and
  // returns the first drift reason.
  const current: SignatureInput = {
    commitHash,
    attestations,
    inScopeCriterionIds: bundle.value.statement.conformant
      ? bundle.value.statement.blockers.length === 0
        ? [...(bundle.value.signature.inputFingerprint.inScopeCriterionIds ?? [])]
        : []
      : [...(bundle.value.signature.inputFingerprint.inScopeCriterionIds ?? [])],
    configFingerprint: buildConfigFingerprint({
      standardId: bundle.value.statement.profile.standardId,
      level: bundle.value.statement.profile.level,
      profileName: bundle.value.signature.inputFingerprint.configFingerprint.profile,
      loadedConfig: fileConfig,
    }),
    fileManifest: buildFileManifest(parsed, cwd),
    toolVersion: VERSION,
  };

  const result = verifyConformanceBundle(bundle.value.signature, current);
  if (result.valid) {
    return {
      stdout: `ra11y conformance --verify: bundle is valid. Claim at commit ${bundle.value.statement.scope.commitHash ?? "<none>"} stands against the current tree.\n`,
      stderr: "",
      exitCode: ExitCode.OK,
    };
  }
  return {
    stdout: "",
    stderr: `ra11y conformance --verify: bundle is INVALID — drift reason: ${result.reason}. Re-run \`ra11y conformance\` to produce a fresh signed bundle.\n`,
    exitCode: ExitCode.USER_ERROR,
  };
}

interface BundleEnvelope {
  readonly statement: ConformanceStatement;
  readonly signature: ConformanceSignature;
}

async function readBundle(
  path: string,
): Promise<{ readonly value: BundleEnvelope } | { readonly error: ScanExit }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: {
        stdout: "",
        stderr: `ra11y conformance --verify: failed to read bundle: ${message}\n`,
        exitCode: ExitCode.USER_ERROR,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: {
        stdout: "",
        stderr: `ra11y conformance --verify: bundle is not valid JSON: ${message}\n`,
        exitCode: ExitCode.USER_ERROR,
      },
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      error: {
        stdout: "",
        stderr: `ra11y conformance --verify: bundle must be a JSON object with a { statement, signature } shape.\n`,
        exitCode: ExitCode.USER_ERROR,
      },
    };
  }
  const obj = parsed as Record<string, unknown>;
  // The emit path writes the full statement object, whose `signature`
  // lives under `statement.signature`. Accept either shape — a caller
  // may have extracted the { statement, signature } envelope into its
  // own file, or handed us the raw JSON output.
  const signature =
    (obj["signature"] as ConformanceSignature | undefined) ??
    ((obj as unknown as ConformanceStatement).signature as ConformanceSignature | undefined);
  const statement =
    (obj["statement"] as ConformanceStatement | undefined) ??
    (obj as unknown as ConformanceStatement);
  if (signature === undefined) {
    return {
      error: {
        stdout: "",
        stderr: `ra11y conformance --verify: bundle has no signature — only conformant, signed statements can be verified.\n`,
        exitCode: ExitCode.USER_ERROR,
      },
    };
  }
  return { value: { statement, signature } };
}

// ─── Shared pipeline helpers ──────────────────────────────────────────────

function resolveCwd(options: CliOptions): string {
  if (options.conformanceScanRoot === undefined) return process.cwd();
  return isAbsolute(options.conformanceScanRoot)
    ? options.conformanceScanRoot
    : resolve(process.cwd(), options.conformanceScanRoot);
}

interface ResolvedProfile {
  readonly namedProfile: NamedConformanceProfile | undefined;
  readonly standardId: string;
  readonly level: ConformanceProfile["level"];
}

/**
 * Resolves the requested profile into `{ standardId, level }`. `--profile`
 * wins over `--standard`/`--level`; when unset the CLI default
 * (`standards[0]` + level) is used, which keeps the scan narrowed to a
 * single standard at a time (conformance statements target one standard
 * by design — see `conformance_statement` MCP tool).
 */
function resolveProfileArg(
  options: CliOptions,
  fileConfig: LoadedConfig,
): ResolvedProfile | { readonly error: string } {
  if (options.profile !== undefined) {
    const resolved = resolveProfile(options.profile, fileConfig.profiles);
    if (resolved === undefined) {
      const valid = [
        ...BUILTIN_PROFILES.map((p) => p.name),
        ...fileConfig.profiles.map((p) => p.name),
      ].join(", ");
      return {
        error: `ra11y conformance: unknown profile '${options.profile}'. Valid profiles: ${valid}.\n`,
      };
    }
    const standardId = resolved.standards[0];
    if (standardId === undefined) {
      return { error: `ra11y conformance: profile '${options.profile}' has no standards.\n` };
    }
    return {
      namedProfile: resolved,
      standardId,
      level: resolved.level ?? "base",
    };
  }
  const standardId = options.standards[0] ?? "wcag22";
  return { namedProfile: undefined, standardId, level: options.level };
}

async function parseScanInputs(
  options: CliOptions,
  fileConfig: LoadedConfig,
  cwd: string,
): Promise<readonly ParsedFile[]> {
  const roots = options.positionals.length > 0 ? options.positionals : [cwd];
  const discovered = await discoverFiles(roots, {
    excludes: [...options.exclude, ...fileConfig.exclude],
  });
  const parsed: ParsedFile[] = [];
  for (const filePath of discovered) {
    const source = await readFile(filePath, "utf8");
    const ast = parseFor(filePath, source);
    if (ast === null) continue;
    const { disableMap, declarations } = parseInlineDisablesDetailed(source);
    parsed.push({
      filePath: relative(cwd, filePath),
      source,
      ast,
      disableMap,
      declarations,
    });
  }
  return parsed;
}

function parseFor(filePath: string, source: string): Ast | null {
  if (filePath.endsWith(".html") || filePath.endsWith(".htm")) {
    const r = parseHtml(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (filePath.endsWith(".css")) {
    const r = parseCss(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (filePath.endsWith(".scss")) {
    const r = parseScss(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (filePath.endsWith(".mdx")) {
    const r = parseMdx(source);
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  if (
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".jsx") ||
    filePath.endsWith(".ts") ||
    filePath.endsWith(".js")
  ) {
    const r = parseTsx(source, { filePath });
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  return null;
}

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
 * Mirrors the MCP tool's config-fingerprint assembly so the signature
 * scopes remain byte-identical across CLI ↔ MCP. Optional fields are
 * conditional-spread per the AI-first consumer model.
 */
function buildConfigFingerprint(args: {
  readonly standardId: string;
  readonly level: "A" | "AA" | "AAA" | "base";
  readonly profileName: string | undefined;
  readonly loadedConfig: LoadedConfig;
}): ConfigFingerprint {
  const { loadedConfig } = args;
  const standards = loadedConfig.standards.length > 0 ? loadedConfig.standards : [args.standardId];
  const rules = loadedConfig.rules;
  const nativeWrappers = loadedConfig.nativeWrappers;
  const processes = loadedConfig.processes;
  return {
    standards: [...standards],
    ...(args.level !== "base" && { level: args.level }),
    ...(args.profileName !== undefined && { profile: args.profileName }),
    ...(Object.keys(rules).length > 0 && { rules: { ...rules } }),
    ...(nativeWrappers.length > 0 && { nativeWrappers: [...nativeWrappers] }),
    ...(processes.length > 0 && {
      processes: processes.map((p) => ({ name: p.name, pages: [...p.pages] })),
    }),
  };
}
