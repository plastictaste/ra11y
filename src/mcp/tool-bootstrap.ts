/**
 * The `bootstrap` MCP meta-tool. One round-trip composes four onboarding
 * primitives — `detect_native_wrappers`, `propose_config`,
 * `scan_project`, and (opt-in) `baseline create` — plus a copy-pasteable
 * GitHub Actions snippet wiring `baseline check` into CI.
 *
 * Read-only by default: `writeBaseline` defaults to false so no file
 * lands on disk unless the agent opts in. Sub-handlers dispatch via
 * `Promise.allSettled` so one rejection doesn't sink the others
 * (mirrors the audit meta-tool, commit 048dfcc). `scan_project` is the
 * mandatory spine — its rejection hard-errors since the other payloads
 * compose onto it; detect + propose_config legs degrade gracefully and
 * surface a `bootstrap_<leg>_failed` warning code.
 *
 * Shape contract (AI-first doctrine, `docs/kb/architecture/ai-first-consumer.md`):
 *   - `baseline` is omitted entirely in dry-run (writeBaseline: false)
 *     and a `baseline_dry_run` warning code is emitted alongside, so
 *     dry-run is distinguishable from baseline-creation-failed by the
 * response shape alone.
 *     When `writeBaseline: true` succeeds, `baseline` is the
 *     `BaselineSummary` record; when the leg fails the field is
 *     omitted and `bootstrap_baseline_failed` fires.
 *   - `ciSnippet` always populated (even on clean scans) so agents
 *     preserve CI wiring regardless of current violations.
 *   - `warnings` propagates scan-leg codes verbatim plus
 *     `bootstrap_<leg>_failed` entries and `baseline_dry_run` when
 *     applicable; omitted when empty. `warningsDetails` ships
 *     alongside, forwarding the upstream scan's payloads verbatim
 *     and stamping fall-through entries (`{}` markers for binary-
 *     presence codes including the bootstrap-local ones) for codes
 *     without a forwarded payload, so the membership-vs-payload
 *     invariant holds at the bootstrap surface (every code in
 *     `warnings[]` resolves to a `warningsDetails.<code>` entry —
 *     CLAUDE.md §1 "Empty `warningsDetails.<code>: {}` is dishonest"
 *     extension: missing entirely is the worse case).
 *   - `scan` subset preserves the upstream `plan` split verbatim —
 *     `violationsCount` and `notesCount` stay separate (no
 *     `totalFindings` re-sum), and the per-lane `fixesByClass` tally
 *     forwards from the upstream plan when present. Per CLAUDE.md §1
 *     "Composite headline counts are dishonest," the former summed
 *     `totalFindings` inflated the work budget by mixing info-severity
 *     notes with violations; the former `safeEditsAvailable` sibling
 *     was dropped at the upstream shape
 *     (Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT) because it
 *     disagreed with `fixesByClass.mechanical` on the same response —
 *     callers sum `fixesByClass.mechanical + fixesByClass.verifyInSource`
 *     when they want the apply-now subset.
 *   - `wrappers` subset enumerates the same discriminator field set the
 *     standalone `detect_native_wrappers` surface ships — `candidates`
 *     + `projectKind` always; `inapplicable` / `emptyReason` /
 *     `opaqueCustomComponentNames` / `absentDeclaredWrappers` /
 *     `suggestedConfigSnippet` present-when-meaningful. Per
 *     `docs/kb/architecture/ai-first-consumer.md` "Bootstrap-class
 *     lanes must equal project-rooted lanes" + "Per-tool review-
 *     candidate shape must agree across surfaces," dropping any of
 *     these on the bootstrap surface forces the agent to re-call
 *     `detect_native_wrappers` to disambiguate "tool doesn't apply on
 *     this projectKind" from "ran clean / coverage miss" — a silent
 *     gap the regression closure pins via integration test on
 *     identical cwd.
 */

import { existsSync } from "node:fs";
import { BASELINE_FILENAME } from "../engine/baseline.ts";
import { gitRoot } from "../utils/git.ts";
import {
  type BulkCatalogTriggerToken,
  buildBulkCatalogWorkflowRecommendation,
} from "./config-snippet.ts";
import { detectForeignEcosystem, type ForeignEcosystem } from "./ecosystem-detect.ts";
import { requireBooleanParam, requireStringArrayParam } from "./param-validators.ts";
import { scannedProject } from "./scanned-envelope.ts";
import { baselineTool } from "./tool-baseline.ts";
import { detectNativeWrappersTool } from "./tool-detect-wrappers.ts";
import { proposeConfigTool } from "./tool-propose-config.ts";
import { scanProjectTool } from "./tool-scan-project.ts";
import {
  errorResult,
  type McpTool,
  type McpToolResult,
  type StructuredError,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import { fallThroughDetailEntry } from "./warnings.ts";

/** Sub-legs the bootstrap composes; surfaces as `bootstrap_<leg>_failed` codes. */
type SubLeg = "detect" | "propose_config" | "baseline";

export const bootstrapTool: McpTool = {
  def: {
    name: "bootstrap",
    description:
      "One-shot onboarding: run `detect_native_wrappers` + `propose_config` + `scan_project` and (optionally) write a `.ra11y-baseline.json`, all in a single round-trip. Returns the wrapper candidates, the proposed ra11y.config.ts body (as `suggestedConfig`), a subset of the scan payload, the baseline status, and a copy-pasteable CI snippet that wires `baseline check` into GitHub Actions.\n\nRead-only by default: `writeBaseline` is false unless the caller opts in. When `writeBaseline: true`, the tool writes `.ra11y-baseline.json` into `cwd` via the `baseline` tool's `create` mode — same on-disk shape as calling `baseline` directly. Use this once when adopting ra11y on a new codebase; prefer the individual tools for iterative work.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Project root. Defaults to the git root of the MCP server's spawn directory, then process.cwd(). Pass your repo root so the scan sees both `ra11y.config.ts` (if present) and the project's `.gitignore`.",
        },
        additionalPaths: {
          type: "array",
          items: { type: "string" },
          description:
            'Paths to scan in addition to the auto-discovered tree, bypassing `.gitignore` and the default build-dir skips. Forwarded verbatim to `scan_project`. Typically used for post-compile CSS/HTML (`["dist/assets"]`) so color-contrast and focus-visible rules have real styles to evaluate.',
        },
        writeBaseline: {
          type: "boolean",
          description:
            "When true, write `.ra11y-baseline.json` at the scan root containing every current violation — grandfathered so future regressions fail `baseline check` in CI. Defaults to false (dry-run): the scan payload is still returned, but no file is written. In dry-run mode the `baseline` field is omitted from the response and a `baseline_dry_run` code joins `warnings`, so callers can distinguish dry-run from baseline-creation-failed (which surfaces as `bootstrap_baseline_failed`) without reading the docstring.",
        },
      },
    },
    annotations: { idempotentHint: true },
  },
  async handler(params, session) {
    // Type-check `writeBaseline` and `additionalPaths` up front. A
    // wrong-type `writeBaseline: "true"` (string) used to silently
    // leave the baseline un-written, and the agent would see
    // `baseline_dry_run` in warnings indistinguishable from "I asked
    // for dry-run." Same shape as `configure-opts.ts.allowWrite`.
    const paramTypeError = validateBootstrapParamTypes(params);
    if (paramTypeError !== undefined) return errorResult(paramTypeError);
    const explicitCwd = strParam(params, "cwd");
    if (explicitCwd !== undefined && !existsSync(explicitCwd)) {
      return errorResult({
        code: "cwd-not-found",
        message: `Requested cwd does not exist on disk: ${explicitCwd}`,
        details: { cwd: explicitCwd },
        remediation:
          "Pass `cwd` as a path to an existing directory. Relative paths resolve against the MCP server's spawn directory.",
      });
    }
    const spawnCwd = process.cwd();
    const root = explicitCwd ?? gitRoot(spawnCwd) ?? spawnCwd;
    const writeBaseline = params["writeBaseline"] === true;
    const additionalPaths = Array.isArray(params["additionalPaths"])
      ? (params["additionalPaths"] as string[])
      : [];

    // scan_project is mandatory; detect + propose_config best-effort.
    const scanParams: Record<string, unknown> = { cwd: root };
    if (additionalPaths.length > 0) scanParams["additionalPaths"] = additionalPaths;
    const [detectSettled, proposeSettled, scanSettled] = await Promise.allSettled([
      Promise.resolve().then(() => detectNativeWrappersTool.handler({ cwd: root }, session)),
      Promise.resolve().then(() => proposeConfigTool.handler({ cwd: root }, session)),
      Promise.resolve().then(() => scanProjectTool.handler(scanParams, session)),
    ]);

    if (scanSettled.status === "rejected") {
      return errorResult({
        code: "audit-sub-tool-threw",
        message: `bootstrap scan_project leg rejected: ${describeRejection(scanSettled.reason)}`,
        details: { failedLeg: "scan_project" },
      });
    }
    const scanRes = scanSettled.value;
    const scan = unwrapPayload(scanRes);
    if (scan === null) {
      return errorResult({
        code: "audit-sub-tool-unparseable",
        message: "bootstrap scan_project leg returned an unparseable payload",
        details: { failedLeg: "scan_project" },
      });
    }

    const failedLegs: SubLeg[] = [];
    const wrappersPayload = extractWrappersSubset(detectSettled, failedLegs);
    const proposedConfigBase = extractProposedConfig(proposeSettled, failedLegs);
    // Workflow-recommendation extension to the proposed config: when
    // the scan-leg's `warningsDetails.bulk_catalog_detected` payload
    // fires (any of the three triggers — `slow_and_vendor_heavy`,
    // `bulk_and_vendor_heavy`, `small_demo_catalog`), append a paste-
    // safe TS comment block AFTER the `});` close that names the
    // catalog-shape narrowing levers (`groupBy: "firstChildDir"` and
    // example `restrictToPaths`). Per AI-first doctrine "Bootstrap
    // output must be paste-safe" extension: paste-safety covers
    // workflow recommendations on detected shapes — without this
    // append, the agent gets severity overrides and no scope guidance
    // for the catalog shape that drives the noise floor. The append
    // never modifies the `defineConfig({...})` body itself; line
    // comments past the export are valid TS.
    const suggestedConfig = appendBulkCatalogWorkflowRecommendation(
      proposedConfigBase,
      readBulkCatalogDetection(scan),
    );

    // Baseline runs sequentially when opted in. In dry-run the field is
    // omitted from the response entirely and a `baseline_dry_run` code
    // fires under `warnings` so dry-run stays distinguishable from
    // baseline-creation-failed (which leaves `baseline` undefined too,
    // but surfaces under `bootstrap_baseline_failed`). The former
    // `baseline: null` sentinel collapsed those states into one
    // ambiguous value (CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest").
    const baseline = writeBaseline ? await runBaseline(root, session, failedLegs) : null;

    const scanSubset = extractScanSubset(scan);
    const scanWarnings = readStringArray(scan, "warnings");
    const warnings: string[] = [
      ...scanWarnings,
      ...failedLegs.map((leg) => `bootstrap_${leg}_failed`),
      ...(writeBaseline ? [] : ["baseline_dry_run"]),
    ];
    // Forward the underlying scan's `warningsDetails` payloads verbatim,
    // attach the structured `baseline_dry_run` payload (the bootstrap
    // call site is the predicate authority — it knows `writeBaseline`
    // is `false` AND has the upstream `violationsCount` ready), and
    // stamp fall-through entries for any remaining codes
    // (`bootstrap_<leg>_failed` tool-local strings) so the membership-
    // vs-payload invariant holds at the bootstrap surface (every code
    // in `warnings[]` resolves to a `warningsDetails.<code>` entry).
    // Without the structured `baseline_dry_run` payload, an agent
    // reading the bare code learns "dry run" but cannot answer
    // "would the create have produced a non-empty baseline?" without
    // another round trip — the same silent miss the doctrine bullet
    // "Empty `warningsDetails.<code>: {}` is dishonest" warns against.
    // `fallThroughDetailEntry` returns `{}` for binary-presence codes
    // and the truncation sentinel for payload-bearing codes whose
    // summarizer didn't run on this surface, so each remaining entry
    // honestly signals what shape the agent should expect.
    const scanWarningsDetails = readWarningsDetails(scan);
    const warningsDetails = buildWarningsDetails(
      warnings,
      scanWarningsDetails,
      buildBootstrapLocalWarningsDetails({
        writeBaseline,
        violationsCount: scanSubset.violationsCount,
      }),
    );

    // Snippet content tracks actual baseline-existence on disk: pasting
    // a `baseline check` incantation into CI before `.ra11y-baseline.json`
    // lands fails on the first run. Probe the scan root for the file so
    // the three branches (exists / just-written-here / dry-run) emit
    // honest instructions.
    const baselineExistsOnDisk = existsSync(`${root}/${BASELINE_FILENAME}`);
    // Ecosystem detection drives the snippet preface only — the ra11y
    // job itself is IDENTICAL across ecosystems because `@ra11y/core` is
    // a Node-based tool regardless of the repo's primary language. For
    // foreign-ecosystem roots (Ruby / Python / Go / Rust without
    // `package.json`) the preface clarifies this is a ra11y-only step
    // added alongside the consumer's existing CI, so a reader pasting
    // the snippet doesn't mistake `actions/setup-node@v4` for an
    // instruction to replace their existing Ruby/Python/Go setup
    // actions. Per ai-first-consumer.md "Surface, don't suppress," the
    // node-setup step stays — suppressing it would produce a snippet
    // that silently fails when the CI runs. Reuses the Q4 ecosystem
    // detector (d8fdce5) so the predicate matches propose_config.
    const foreignEcosystem = detectForeignEcosystem(root);
    const ciSnippet = buildCiSnippet({
      baselineExists: baselineExistsOnDisk,
      writeBaseline,
      baselineWrittenByThisCall: baseline?.written === true,
      foreignEcosystem,
    });
    const nextStep = buildNextStep({
      scan: scanSubset,
      baseline,
      writeBaseline,
      failedLegs,
    });

    // Canonical key is `suggestedConfig` (matches `propose_config` +
    // `detect_native_wrappers.suggestedConfigSnippet`). Conditional
    // spread per CLAUDE.md §1 "Ambiguous field shapes are dishonest" —
    // omitted when the propose_config leg degraded.
    return textResult({
      wrappers: wrappersPayload,
      ...(suggestedConfig === null ? {} : { suggestedConfig }),
      scan: scanSubset,
      // Conditional-spread per CLAUDE.md §1 "Ambiguous field shapes are
      // dishonest" — the field is present only when it carries a
      // populated baseline summary. Dry-run and creation-failed both
      // omit; the warnings channel discriminates them.
      ...(baseline === null ? {} : { baseline }),
      ciSnippet,
      nextStep,
      nextStepStructured: buildNextStepStructured({
        scanSubset,
        baseline,
        writeBaseline,
        wrappers: wrappersPayload,
        root,
        embeddedScan: scan,
      }),
      meta: {
        scanned: scannedProject(root),
        writeBaseline,
        ...(additionalPaths.length > 0 ? { additionalPaths } : {}),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      // `warningsDetails` ships only when at least one code fired —
      // membership-vs-payload invariant (every `warnings[]` code has a
      // `warningsDetails.<code>` key, no extras when codes is empty).
      ...(Object.keys(warningsDetails).length > 0 ? { warningsDetails } : {}),
    });
  },
};

/**
 * Subset of the {@link detectNativeWrappersTool} response forwarded onto
 * the bootstrap `wrappers` field. Mirrors every discriminator the
 * standalone tool ships so an agent calling `bootstrap` first can tell
 * "tool doesn't apply on this projectKind" from "ran clean / coverage
 * miss" without a follow-up `detect_native_wrappers` call. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Bootstrap-class lanes
 * must equal project-rooted lanes" + "Per-tool review-candidate shape
 * must agree across surfaces" — the bootstrap surface must enumerate
 * the same field set the upstream surface enumerates so the two
 * surfaces' mental models stay in lockstep.
 *
 * The `nextStep` and `scanned` fields from the upstream response are
 * intentionally NOT forwarded — bootstrap composes its own top-level
 * `nextStep` / `nextStepStructured` (covering the wrappers + scan +
 * baseline triple) and its own `meta.scanned`, so duplicating those
 * here would be redundant. Every other field from the upstream
 * response is forwarded with conditional spread (present-when-
 * meaningful) so the empty / inapplicable / opaque-only branches each
 * surface their own discriminator.
 */
interface WrappersSubset {
  readonly candidates: readonly unknown[];
  /**
   * Project-kind classifier forwarded verbatim from the upstream
   * `detect_native_wrappers.projectKind` discriminator. `"jsx"` /
   * `"static-site"` / `"ruby"` / `"python"` / `"go"` / `"unknown"` —
   * lets the agent route on the same signal it would read off the
   * standalone tool. Always present so empty `candidates` on a Rails
   * site reads as "tool doesn't apply" rather than "coverage miss."
   */
  readonly projectKind: string;
  /**
   * Top-level "tool inapplicable" block forwarded from the upstream
   * `inapplicable: { reason, filesByExtension }` shape. Present only
   * on the no-JSX-in-tree branch — distinct from `emptyReason`
   * (which signals "tool ran on real input but came up empty")
   * because the detector's evidence model never had a surface here.
   * Per `docs/kb/architecture/ai-first-consumer.md` "Zero-output
   * success is ambiguous failure," dropping this block on the
   * bootstrap surface would force the agent to re-call
   * `detect_native_wrappers` to disambiguate.
   */
  readonly inapplicable?: {
    readonly reason: string;
    readonly filesByExtension: Readonly<Record<string, number>>;
  };
  /**
   * Structured `emptyReason` discriminator forwarded from the upstream
   * success branch — `"no-pascalcase-onclick-components"` when the
   * scan parsed JSX but found no PascalCase tags;
   * `"no-jsx-onclick-candidates-found-but-opaque-components-present"`
   * when PascalCase components exist but none carry the detector's
   * required props. Conditional spread: omitted when `candidates`
   * is non-empty (the discriminator only fires on the empty branch).
   */
  readonly emptyReason?: string;
  /**
   * Inlined inventory of opaque PascalCase component names forwarded
   * from the upstream `opaqueCustomComponentNames` field. Present
   * only when `emptyReason` names the opaque-components branch —
   * lets the agent open each component directly without a follow-up
   * `scan_project` call (per "One tool call should answer 'what
   * next?'").
   */
  readonly opaqueCustomComponentNames?: readonly string[];
  /**
   * Declared-but-absent diff forwarded from the upstream
   * `absentDeclaredWrappers` field — wrapper names declared in
   * config that no component matched in this scan. Conditional
   * spread: present-when-non-empty (mirrors the upstream gate).
   */
  readonly absentDeclaredWrappers?: readonly string[];
  /**
   * Paste-safe `nativeWrappers` config snippet forwarded from the
   * upstream `suggestedConfigSnippet` field. Conditional spread:
   * present-when-non-empty.
   */
  readonly suggestedConfigSnippet?: string;
}

/**
 * Up-front type validation for the `bootstrap` handler. Closes the
 * silent-drop class for `writeBaseline` and `additionalPaths` —
 * wrong-type inputs used to silently fall through (writeBaseline:
 * "true" stayed dry-run; additionalPaths: "dist" stayed empty).
 * Mirrors `configure-opts.ts.allowWrite`.
 */
function validateBootstrapParamTypes(params: Record<string, unknown>): StructuredError | undefined {
  const writeBaseline = requireBooleanParam(params, "writeBaseline");
  if (!writeBaseline.ok) return writeBaseline.error;
  const additionalPaths = requireStringArrayParam(params, "additionalPaths");
  if (!additionalPaths.ok) return additionalPaths.error;
  return undefined;
}

function settledRecord(
  settled: PromiseSettledResult<McpToolResult>,
): Record<string, unknown> | null {
  if (settled.status === "rejected") return null;
  const payload = unwrapPayload(settled.value);
  if (payload === null || typeof payload !== "object") return null;
  return payload as Record<string, unknown>;
}

/**
 * Extracts the bootstrap `wrappers` subset from the settled
 * `detect_native_wrappers` leg. Forwards every discriminator the
 * upstream surface ships (`candidates`, `projectKind`, `inapplicable`,
 * `emptyReason`, `opaqueCustomComponentNames`, `absentDeclaredWrappers`,
 * `suggestedConfigSnippet`) so the bootstrap surface enumerates the
 * same field set per "Bootstrap-class lanes must equal project-rooted
 * lanes." Conditional spread for each optional field keeps the shape
 * present-when-meaningful — empty-record sentinels would re-introduce
 * the ambiguity the doctrine bullet "Ambiguous field shapes are
 * dishonest" warns against.
 *
 * On detect-leg failure, falls back to a degraded `{ candidates: [],
 * projectKind: "unknown" }` shape — `projectKind` stays populated as
 * a schema-required scalar (the agent can still route on the
 * "unknown" signal), and the failure surfaces through
 * `bootstrap_detect_failed` in `warnings[]` so the degraded path is
 * distinguishable from a clean-but-inapplicable scan.
 */
function extractWrappersSubset(
  settled: PromiseSettledResult<McpToolResult>,
  failedLegs: SubLeg[],
): WrappersSubset {
  const record = settledRecord(settled);
  if (record === null) {
    failedLegs.push("detect");
    return { candidates: [], projectKind: "unknown" };
  }
  const candidates = Array.isArray(record["candidates"])
    ? (record["candidates"] as readonly unknown[])
    : [];
  const projectKindRaw = record["projectKind"];
  const projectKind = typeof projectKindRaw === "string" ? projectKindRaw : "unknown";
  const snippet = record["suggestedConfigSnippet"];
  const emptyReason = record["emptyReason"];
  const opaqueNames = record["opaqueCustomComponentNames"];
  const absent = record["absentDeclaredWrappers"];
  const inapplicable = record["inapplicable"];
  return {
    candidates,
    projectKind,
    ...(isInapplicableBlock(inapplicable) ? { inapplicable } : {}),
    ...(typeof emptyReason === "string" && emptyReason.length > 0 ? { emptyReason } : {}),
    ...(Array.isArray(opaqueNames) && opaqueNames.every((n) => typeof n === "string")
      ? { opaqueCustomComponentNames: opaqueNames as readonly string[] }
      : {}),
    ...(Array.isArray(absent) && absent.every((n) => typeof n === "string")
      ? { absentDeclaredWrappers: absent as readonly string[] }
      : {}),
    ...(typeof snippet === "string" && snippet.length > 0
      ? { suggestedConfigSnippet: snippet }
      : {}),
  };
}

/**
 * Type guard for the upstream `inapplicable: { reason, filesByExtension }`
 * block. Defensive over forwarded JSON the bootstrap doesn't own —
 * any wire-shape regression upstream falls through to "skip the field"
 * rather than ship a partially-populated block that would be
 * indistinguishable from a degraded payload.
 */
function isInapplicableBlock(value: unknown): value is {
  readonly reason: string;
  readonly filesByExtension: Readonly<Record<string, number>>;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record["reason"] !== "string") return false;
  const filesByExtension = record["filesByExtension"];
  if (!filesByExtension || typeof filesByExtension !== "object") return false;
  for (const v of Object.values(filesByExtension)) {
    if (typeof v !== "number") return false;
  }
  return true;
}

function extractProposedConfig(
  settled: PromiseSettledResult<McpToolResult>,
  failedLegs: SubLeg[],
): string | null {
  const record = settledRecord(settled);
  const cfg = record?.["suggestedConfig"];
  if (typeof cfg !== "string" || cfg.length === 0) {
    failedLegs.push("propose_config");
    return null;
  }
  return cfg;
}

/**
 * Subset of {@link import("./bulk-catalog.ts").BulkCatalogDetection}
 * the bootstrap surface reads off the scan-leg's
 * `warningsDetails.bulk_catalog_detected` payload. Carries only the
 * fields the workflow-recommendation builder consumes — `trigger` (to
 * name the regime in the comment header) and the optional
 * `siblingShape.exampleSiblings[0]` (to fill the `restrictToPaths`
 * example with a concrete path on the small_demo_catalog trigger). On
 * the vendor-heavy triggers the warning payload omits `siblingShape`,
 * and the recommendation falls back to a placeholder example.
 */
interface ReadBulkCatalogResult {
  readonly trigger: BulkCatalogTriggerToken;
  readonly exampleSibling?: string;
}

/**
 * Reads the bulk-catalog warning payload off the scan-leg response.
 * The scan-family ships `warningsDetails.bulk_catalog_detected` with
 * a `trigger` discriminator and (for the small_demo_catalog trigger)
 * a `siblingShape.exampleSiblings[]` array. Returns `null` when the
 * warning didn't fire, the payload is malformed, or the trigger
 * value isn't one of the three known tokens.
 *
 * Defensive on every step: this is forwarded JSON the bootstrap tool
 * doesn't own, so any wire-shape regression upstream falls through
 * to "skip the recommendation" rather than throw — the bootstrap
 * surface stays paste-safe even when the upstream shape drifts.
 */
function readBulkCatalogDetection(scan: unknown): ReadBulkCatalogResult | null {
  if (!scan || typeof scan !== "object") return null;
  const details = (scan as Record<string, unknown>)["warningsDetails"];
  if (!details || typeof details !== "object") return null;
  const payload = (details as Record<string, unknown>)["bulk_catalog_detected"];
  if (!payload || typeof payload !== "object") return null;
  const triggerRaw = (payload as Record<string, unknown>)["trigger"];
  if (
    triggerRaw !== "slow_and_vendor_heavy" &&
    triggerRaw !== "bulk_and_vendor_heavy" &&
    triggerRaw !== "small_demo_catalog"
  ) {
    return null;
  }
  const trigger = triggerRaw;
  const siblingShape = (payload as Record<string, unknown>)["siblingShape"];
  let exampleSibling: string | undefined;
  if (siblingShape && typeof siblingShape === "object") {
    const examples = (siblingShape as Record<string, unknown>)["exampleSiblings"];
    if (Array.isArray(examples) && typeof examples[0] === "string" && examples[0].length > 0) {
      exampleSibling = examples[0];
    }
  }
  return exampleSibling === undefined ? { trigger } : { trigger, exampleSibling };
}

/**
 * Appends the workflow-recommendation comment block to a `propose_config`
 * `suggestedConfig` string when the scan-leg's bulk-catalog warning
 * fired. Returns the input unchanged when:
 *   - `suggestedConfig` is null (propose_config leg degraded — no
 *     base string to append onto), or
 *   - `detection` is null (the warning didn't fire on this scan, so
 *     the recommendation is not relevant).
 *
 * The comment block is appended AFTER `suggestedConfig`'s trailing
 * newline. The base string already ends with `});` + `\n` (per
 * `tool-propose-config.ts.buildConfigString`), so the append produces
 * a single string with the comment block following the export. Line
 * comments past the export statement are valid top-level TS — the
 * paste-safety guarantee holds.
 */
function appendBulkCatalogWorkflowRecommendation(
  suggestedConfig: string | null,
  detection: ReadBulkCatalogResult | null,
): string | null {
  if (suggestedConfig === null) return null;
  if (detection === null) return suggestedConfig;
  const recommendation = buildBulkCatalogWorkflowRecommendation({
    trigger: detection.trigger,
    ...(detection.exampleSibling === undefined ? {} : { exampleSibling: detection.exampleSibling }),
  });
  return `${suggestedConfig}${recommendation}`;
}

interface FixesByClassLaneSubset {
  readonly source: number;
  readonly buildArtifact: number;
}

interface FixesByClassSubset {
  readonly mechanical: FixesByClassLaneSubset;
  readonly guidance: FixesByClassLaneSubset;
  readonly runtimeOnly: FixesByClassLaneSubset;
  readonly verifyInSource: FixesByClassLaneSubset;
  /**
   * Per-emission `suppress-recommended` derivation lane forwarded
   * verbatim from the upstream `plan.fixesByClass.suppressRecommended`.
   * Mirrors the per-call `suggest_fix` `kind: "suppress-recommended"`
   * discriminator so the per-class plan tally stays consistent across
   * the project-rooted (`scan_project.plan.fixesByClass`) and
   * bootstrap-class surfaces (`docs/kb/architecture/ai-first-consumer.md`
   * "Bootstrap-class lanes must equal project-rooted lanes"). Without
   * this lane the bootstrap subset silently drops every finding routed
   * into suppress-recommended (343-finding gap on the original
   * regression corpus); the bootstrap-derived `violationsCount` then
   * undercounts the upstream by the lane's source-count.
   */
  readonly suppressRecommended: FixesByClassLaneSubset;
}

/**
 * Per-scan-kind manual-review lane forwarded from the upstream
 * `plan.actionableManualItemsBySource`. Same shape as
 * {@link FixesByClassLaneSubset} on the manual-review axis — see
 * `docs/kb/architecture/ai-first-consumer.md` "Bootstrap-class lanes
 * must equal project-rooted lanes."
 */
interface ActionableManualSubsetLane {
  readonly source: number;
  readonly buildArtifact: number;
}

interface ScanSubset {
  readonly filesScanned: number;
  /**
   * Count of violations (severity `error` / `warning`) — the
   * "things-needing-a-fix" total the bootstrap report budgets against.
   * Derived from `plan.fixesByClass` (sum of the five lanes,
   * including `suppressRecommended`) per the wire-level
   * `plan.violations` headline was deleted because it summed across
   * categorically different remediation lanes under one number. The bootstrap
   * subset still carries a flat `violationsCount` because it's an
   * internal structured-output field consumed by the bootstrap
   * report assembler (not a user-facing surface). Distinct from
   * `notesCount` which counts info-severity findings — both are
   * single-kind tallies on different axes.
   */
  readonly violationsCount: number;
  /**
   * Count of info-severity notes — observations the engine surfaced
   * without asserting a failure (wrapper-drift telemetry, etc.).
   * Separated from {@link violationsCount} so the agent can decide
   * whether to iterate (violations > 0) independently of whether any
   * notes are worth inspecting.
   */
  readonly notesCount: number;
  readonly scanMode?: string;
  /**
   * Per-scan-kind manual-review tally forwarded verbatim from the
   * upstream `plan.actionableManualItemsBySource`. Replaces the bare
   * `actionableManualItems` scalar that was dropped because on a
   * `scan_file` of `dist/*.min.css` it read 1 while every contributing
   * candidate sat on the `buildArtifact` lane (per
   * `docs/kb/architecture/ai-first-consumer.md` "Composite headline
   * counts are dishonest"). Conditional-spread: omitted when the
   * upstream `plan.actionableManualItemsBySource` is absent / unread-
   * able. Per the doctrine bullet "Bootstrap-class lanes must equal
   * project-rooted lanes," the bootstrap subset mirrors the
   * scan_project lane shape one-to-one.
   */
  readonly actionableManualItemsBySource?: ActionableManualSubsetLane;
  /**
   * Per-`fixClass` remediation-lane tally forwarded verbatim from the
   * upstream `plan.fixesByClass` (set by `scan-assembly.ts` when
   * violations > 0). Keyed by camelCased `FixClass` so callers can
   * budget per-lane (mechanical edits vs. guidance rewrites vs.
   * runtime harness vs. source-read decisions) without summing.
   * Conditional-spread: omitted on clean scans where upstream also
   * omits it.
   *
   * Callers that want the former `safeEditsAvailable` slice ("apply-fix
   * can batch this now") sum
   * `fixesByClass.mechanical + fixesByClass.verifyInSource` — the
   * former composite headline was dropped per
   * Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT.
   */
  readonly fixesByClass?: FixesByClassSubset;
  /**
   * Static-analysis caveat prose forwarded verbatim from
   * `scan_project`'s `plan.limitations`. Tells the agent (and, via
   * `ciSnippet`, any CI reader) which runtime-only checks the scanner
   * cannot verify — e.g. live-region announcements, ARIA state
   * transitions, focus traps — so a clean scan is not mistaken for
   * WCAG conformance. Present-when-meaningful: omitted only when the
   * upstream scan emits no limitations prose (not currently
   * reachable on a real scan, but the shape is conditional so the
   * subset stays honest if upstream ever drops the field).
   */
  readonly limitations?: readonly string[];
}

function extractScanSubset(scan: unknown): ScanSubset {
  if (scan === null || typeof scan !== "object") {
    return { filesScanned: 0, violationsCount: 0, notesCount: 0 };
  }
  const record = scan as Record<string, unknown>;
  const meta = record["meta"];
  const plan = record["plan"];
  const filesScanned = readNumberFromRecord(meta, "filesScanned") ?? 0;
  // the wire-level `plan.violations`
  // headline was deleted because it summed across the five
  // `fixesByClass` lanes under one composite number. The bootstrap
  // subset still carries a flat `violationsCount` (it's an internal
  // structured-output field consumed by the bootstrap report
  // assembler, not a user-facing surface) — we derive it from
  // `plan.fixesByClass` so the count tracks the honest per-lane
  // source. `plan.infoSeverityFindings` (renamed from the opaque
  // `notes`) survives unchanged (severity-info, not a composite of
  // categorically different lanes).
  //
  // Per `docs/kb/architecture/ai-first-consumer.md` "Bootstrap-class
  // lanes must equal project-rooted lanes," the sum spans every lane
  // the upstream `plan.fixesByClass` enumerates — including
  // `suppressRecommended`. Dropping any one (the original regression
  // dropped suppressRecommended) makes the bootstrap-derived count
  // undercount the upstream by that lane's totals.
  const fixesByClass = readFixesByClass(plan);
  const violationsCount =
    fixesByClass === null
      ? 0
      : laneSum(fixesByClass.mechanical) +
        laneSum(fixesByClass.guidance) +
        laneSum(fixesByClass.runtimeOnly) +
        laneSum(fixesByClass.verifyInSource) +
        laneSum(fixesByClass.suppressRecommended);
  const notesCount = readNumberFromRecord(plan, "infoSeverityFindings") ?? 0;
  const scanMode = readStringFromRecord(meta, "scanMode");
  const actionableBySource = readActionableManualLane(plan);
  const limitations = readStringArray(plan, "limitations");
  return {
    filesScanned,
    violationsCount,
    notesCount,
    ...(scanMode === null ? {} : { scanMode }),
    ...(actionableBySource === null ? {} : { actionableManualItemsBySource: actionableBySource }),
    ...(fixesByClass === null ? {} : { fixesByClass }),
    ...(limitations.length > 0 ? { limitations } : {}),
  };
}

/**
 * Reads the upstream `plan.actionableManualItemsBySource` pair into
 * the bootstrap subset shape. Mirrors {@link readFixesByClass} on the
 * manual-review axis. Returns `null` when the field is absent or
 * malformed so the caller can conditional-spread it out — never
 * emit a sentinel `{ source: 0, buildArtifact: 0 }` per the
 * "Bootstrap-class lanes must equal project-rooted lanes" + present-
 * when-meaningful rules. The upstream emits the field
 * deterministically (zero-actionable scans surface as
 * `{ source: 0, buildArtifact: 0 }` — honest "axis tallied, found
 * zero" signal), so a `null` here means the caller built the
 * subset from a non-scan-family payload.
 */
function readActionableManualLane(plan: unknown): ActionableManualSubsetLane | null {
  if (plan === null || typeof plan !== "object") return null;
  const raw = (plan as Record<string, unknown>)["actionableManualItemsBySource"];
  if (raw === null || typeof raw !== "object") return null;
  const pair = raw as Record<string, unknown>;
  const source = pair["source"];
  const buildArtifact = pair["buildArtifact"];
  if (typeof source !== "number" || typeof buildArtifact !== "number") return null;
  return { source, buildArtifact };
}

/**
 * Reads the upstream `plan.fixesByClass` record into the subset shape.
 * Upstream emits the lane tally only when violations > 0 (see
 * `scan-assembly.ts`'s `emitFixesByClass` gate) — mirror that: when the
 * field is absent or malformed, return null so the subset omits it
 * rather than emitting an all-zeros tally whose only signal is "no
 * violations." Conditional-spread at the call site keeps the shape
 * present-when-meaningful.
 */
function readFixesByClass(plan: unknown): FixesByClassSubset | null {
  if (!plan || typeof plan !== "object") return null;
  const raw = (plan as Record<string, unknown>)["fixesByClass"];
  if (!raw || typeof raw !== "object") return null;
  const mechanical = readLane(raw, "mechanical");
  const guidance = readLane(raw, "guidance");
  const runtimeOnly = readLane(raw, "runtimeOnly");
  const verifyInSource = readLane(raw, "verifyInSource");
  const suppressRecommended = readLane(raw, "suppressRecommended");
  if (
    mechanical === null ||
    guidance === null ||
    runtimeOnly === null ||
    verifyInSource === null ||
    suppressRecommended === null
  ) {
    return null;
  }
  return { mechanical, guidance, runtimeOnly, verifyInSource, suppressRecommended };
}

/**
 * Reads one {@link FixesByClassLaneSubset} from a `fixesByClass` parent
 * record. Each lane is a `{ source, buildArtifact }` pair carrying the
 * per-scan-kind split so the bootstrap subset preserves the same axis
 * `plan.violationsByScanKind` carries at the cross-lane aggregate
 * level. Returns null on malformed input — the parent helper folds
 * any null lane back into a null subset (matching the upstream
 * conditional-spread gate so an absent / partial `fixesByClass` lands
 * as "subset omits the field").
 */
function readLane(parent: unknown, key: string): FixesByClassLaneSubset | null {
  if (!parent || typeof parent !== "object") return null;
  const raw = (parent as Record<string, unknown>)[key];
  if (!raw || typeof raw !== "object") return null;
  const source = readNumberFromRecord(raw, "source");
  const buildArtifact = readNumberFromRecord(raw, "buildArtifact");
  if (typeof source !== "number" || typeof buildArtifact !== "number") {
    return null;
  }
  return { source, buildArtifact };
}

function laneSum(lane: FixesByClassLaneSubset): number {
  return lane.source + lane.buildArtifact;
}

interface BaselineSummary {
  readonly written: boolean;
  readonly path: string;
  readonly entriesWritten?: number;
}

async function runBaseline(
  cwd: string,
  session: import("./session.ts").McpSession,
  failedLegs: SubLeg[],
): Promise<BaselineSummary | null> {
  const fail = (): null => {
    failedLegs.push("baseline");
    return null;
  };
  try {
    const res = await baselineTool.handler({ mode: "create", cwd }, session);
    const payload = unwrapPayload(res);
    if (payload === null || typeof payload !== "object") return fail();
    const record = payload as Record<string, unknown>;
    if (record["error"] !== undefined) return fail();
    const baselinePath =
      readStringFromRecord(record, "baselinePath") ?? `${cwd}/${BASELINE_FILENAME}`;
    const entries = readNumberFromRecord(record, "entriesWritten");
    return {
      written: true,
      path: baselinePath,
      ...(typeof entries === "number" ? { entriesWritten: entries } : {}),
    };
  } catch {
    return fail();
  }
}

function describeRejection(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function unwrapPayload(res: McpToolResult): unknown {
  if (res.isError) {
    const raw = res.content[0]?.text ?? "";
    try {
      return { error: JSON.parse(raw) };
    } catch {
      return { error: raw };
    }
  }
  const first = res.content[0];
  if (!first || first.type !== "text") return null;
  try {
    return JSON.parse(first.text);
  } catch {
    return null;
  }
}

function readStringArray(value: unknown, key: string): readonly string[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/**
 * Reads the `warningsDetails` object off the upstream scan response.
 * Returns an empty record when the scan emitted no payloads (e.g.
 * clean Node-toolchain repo with no warnings) so the merge site can
 * unconditionally spread without a null guard.
 */
function readWarningsDetails(scan: unknown): Record<string, unknown> {
  if (!scan || typeof scan !== "object") return {};
  const raw = (scan as Record<string, unknown>)["warningsDetails"];
  if (!raw || typeof raw !== "object") return {};
  return raw as Record<string, unknown>;
}

/**
 * Builds the bootstrap-surface `warningsDetails` payload by forwarding
 * every entry from the upstream scan's `warningsDetails`, layering in
 * any bootstrap-local rich payloads (e.g. the structured
 * `baseline_dry_run` shape the bootstrap call site computes), and
 * stamping fall-through entries for any code in `warnings[]` that
 * still lacks one.
 *
 * Layering order: upstream scan details first → bootstrap-local rich
 * overrides → fall-through. Bootstrap-local entries override the
 * upstream value when the same code lands on both surfaces (rare —
 * `baseline_dry_run` is bootstrap-only by construction). The fall-
 * through covers tool-local strings (`bootstrap_<leg>_failed`) the
 * dispatch table can't summarize.
 *
 * `fallThroughDetailEntry` discriminates binary-presence codes (where
 * `{}` is the honest wire shape — the bootstrap-local
 * `bootstrap_<leg>_failed` strings) from payload-bearing codes whose
 * summarizer didn't run on this surface (sentinel `{ truncated: true,
 * reason: "summarizer_inputs_unavailable" }`). Either way the
 * membership-vs-payload invariant holds: every code has a key, and
 * the agent reads a definite shape rather than `undefined`.
 */
function buildWarningsDetails(
  warnings: readonly string[],
  baseDetails: Record<string, unknown>,
  bootstrapLocalDetails: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...baseDetails, ...bootstrapLocalDetails };
  for (const code of warnings) {
    if (out[code] !== undefined) continue;
    out[code] = fallThroughDetailEntry(code);
  }
  return out;
}

/**
 * Builds the bootstrap-local rich payloads layered into
 * {@link buildWarningsDetails}. Today's only entry is the structured
 * `baseline_dry_run` payload (`{ didWrite: false, wouldHaveAdded }`) —
 * the bootstrap call site is the predicate authority because it
 * knows `writeBaseline` is `false` AND has the upstream
 * `violationsCount` from the scan subset already in scope. Without
 * the structured payload, an agent reading the bare code learns
 * "dry run" but cannot answer "would the create have produced a
 * non-empty baseline?" without another round trip — the same silent
 * miss the doctrine bullet "Empty `warningsDetails.<code>: {}` is
 * dishonest" warns against.
 *
 * Pure over its inputs; the conditional-spread shape keeps the
 * payload absent when `writeBaseline: true` (the dry-run code never
 * fires, so the bootstrap merge wouldn't read this entry anyway —
 * the omission is defensive, not load-bearing).
 */
function buildBootstrapLocalWarningsDetails(args: {
  readonly writeBaseline: boolean;
  readonly violationsCount: number;
}): Record<string, unknown> {
  if (args.writeBaseline) return {};
  return {
    baseline_dry_run: { didWrite: false, wouldHaveAdded: args.violationsCount },
  };
}

function readNumberFromRecord(value: unknown, key: string): number | null | undefined {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" ? raw : null;
}

function readStringFromRecord(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : null;
}

interface CiSnippetArgs {
  /** True when `.ra11y-baseline.json` already exists at the scan root. */
  readonly baselineExists: boolean;
  /** Forwarded from the caller's `writeBaseline` param. */
  readonly writeBaseline: boolean;
  /**
   * True only when this very `bootstrap` call wrote the baseline (i.e.
   * `writeBaseline: true` AND the baseline leg succeeded). Distinguishes
   * "baseline exists because we just wrote it" from "baseline exists
   * because a prior run wrote it" — the commit-and-check prelude is
   * relevant in the first case, not the second.
   */
  readonly baselineWrittenByThisCall: boolean;
  /**
   * Detected foreign ecosystem tag (`ruby` / `python` / `go` / `rust`)
   * when `package.json` is absent and a canonical foreign marker
   * resolves at the scan root; `null` for Node projects. Drives the
   * snippet preface only — the ra11y job body (including
   * `actions/setup-node@v4`) is identical across ecosystems because
   * `@ra11y/core` is a Node-based tool regardless of the consumer's
   * primary language. For foreign ecosystems we emit a clarifying
   * comment that the job is additive and the node-setup step is
   * ra11y-only, so a reader pasting the snippet doesn't mistake it
   * for an instruction to replace their existing Ruby / Python / Go
   * setup actions.
   */
  readonly foreignEcosystem: ForeignEcosystem | null;
}

/**
 * GitHub Actions snippet wiring `baseline check` into CI. Dry; pasteable.
 *
 * Gates the snippet content on actual baseline-existence rather than
 * emitting the happy-path incantation unconditionally — a caller
 * pasting `npx @ra11y/core --baseline check` into CI before
 * `.ra11y-baseline.json` is committed fails on the first run, and the
 * silent-miss framing in `docs/kb/architecture/ai-first-consumer.md`
 * ("Zero-output success is ambiguous failure") applies equally to a
 * lying snippet as to a lying response field. Three branches:
 *
 *   1. baseline on disk already — emit the plain `--baseline check`
 *      snippet; no prelude needed.
 *   2. baseline absent but this call wrote it (`writeBaseline: true`,
 *      baseline leg succeeded) — emit the plain `--baseline check`
 *      snippet plus a comment reminding the caller to commit
 *      `.ra11y-baseline.json` before CI runs.
 *   3. pure dry-run (no baseline on disk, `writeBaseline: false`) —
 *      prepend a `# create baseline first:` comment and a
 *      `npx @ra11y/core --baseline create` step so the copy-paste path
 *      is honest about first-run ordering.
 *
 * Foreign-ecosystem preface: when the scan root has no `package.json`
 * but carries a canonical Ruby / Python / Go / Rust manifest, prepend
 * an extra header comment clarifying the job is additive — added
 * alongside the consumer's existing CI rather than replacing it — and
 * that the `actions/setup-node@v4` step is a ra11y-only dependency
 * (because `@ra11y/core` is a Node-based CLI). Per
 * `docs/kb/architecture/ai-first-consumer.md` "Surface, don't
 * suppress," we do NOT strip the node-setup step for foreign
 * ecosystems — doing so would produce a snippet that silently fails
 * when CI runs. Only the prose preface changes; the job body is
 * identical for Node and foreign roots.
 */
function buildCiSnippet(args: CiSnippetArgs): string {
  const { baselineExists, writeBaseline, baselineWrittenByThisCall, foreignEcosystem } = args;
  const prefaceLines: string[] =
    foreignEcosystem === null
      ? ["# .github/workflows/a11y.yml"]
      : [
          "# .github/workflows/a11y.yml",
          `# Add this job to your existing CI — it runs alongside your ${foreignEcosystem} workflow.`,
          "# ra11y is a Node-based tool, so this job sets up Node for itself; your existing",
          `# ${foreignEcosystem} setup actions are not affected.`,
        ];
  const header = [
    ...prefaceLines,
    "name: a11y",
    "on: [push, pull_request]",
    "jobs:",
    "  ra11y:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: lts/*",
  ];
  if (baselineExists) {
    const reminder: string[] = baselineWrittenByThisCall
      ? [`      # commit ${BASELINE_FILENAME} before pushing so CI has a baseline to check against`]
      : [];
    return [...header, ...reminder, "      - run: npx @ra11y/core --baseline check", ""].join("\n");
  }
  if (writeBaseline) {
    // writeBaseline: true but baseline absent means the baseline leg
    // failed (degraded path). Mirror the dry-run snippet so CI can still
    // bootstrap itself on first run.
    return [
      ...header,
      `      # create ${BASELINE_FILENAME} first — commit it, then CI can run \`--baseline check\`:`,
      "      - run: npx @ra11y/core --baseline create",
      "      - run: npx @ra11y/core --baseline check",
      "",
    ].join("\n");
  }
  // Pure dry-run: no baseline on disk, no write requested this call.
  return [
    ...header,
    `      # create ${BASELINE_FILENAME} first — commit it, then CI can run \`--baseline check\`:`,
    "      - run: npx @ra11y/core --baseline create",
    "      - run: npx @ra11y/core --baseline check",
    "",
  ].join("\n");
}

interface NextStepArgs {
  readonly scan: ScanSubset;
  readonly baseline: BaselineSummary | null;
  readonly writeBaseline: boolean;
  readonly failedLegs: readonly SubLeg[];
}

function buildNextStep(args: NextStepArgs): string {
  const { scan, baseline, writeBaseline, failedLegs } = args;
  const parts: string[] = [buildHeadline(scan)];
  const hasViolations = scan.violationsCount > 0;
  if (writeBaseline && baseline !== null) {
    parts.push(
      `Baseline written to ${baseline.path}. Commit the file and add the \`ciSnippet\` to catch regressions.`,
    );
  } else if (!writeBaseline && hasViolations) {
    parts.push(
      "To grandfather the current violations and fail CI only on regressions, rerun `bootstrap` with `writeBaseline: true`.",
    );
  }
  if (failedLegs.length > 0) {
    parts.push(
      `Degraded legs: ${failedLegs.join(", ")} — re-run the individual tool to recover the missing payload.`,
    );
  }
  return parts.join(" ");
}

/**
 * Headline fragment for {@link buildNextStep}. Branch for the three
 * scan shapes: zero files (warnings-referral), clean (success prose),
 * or non-empty (split "N violations + M notes" by kind, never a
 * summed composite per CLAUDE.md §1).
 */
function buildHeadline(scan: ScanSubset): string {
  if (scan.filesScanned === 0) {
    return "Scan ran but parsed zero files — check `warnings` for why (nonexistent cwd, no matching extensions, or everything ignored).";
  }
  if (scan.violationsCount === 0 && scan.notesCount === 0) {
    return "Scan clean. Paste `suggestedConfig` into ra11y.config.ts if a config is not already committed, then add the `ciSnippet` to your CI workflow.";
  }
  const fragments: string[] = [];
  if (scan.violationsCount > 0) {
    fragments.push(pluralize(scan.violationsCount, "violation"));
  }
  if (scan.notesCount > 0) {
    fragments.push(pluralize(scan.notesCount, "note"));
  }
  return `${fragments.join(" + ")} from scan_project. Paste \`suggestedConfig\` into ra11y.config.ts, then work through the findings — call \`scan_project\` again to iterate.`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface NextStepStructured {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

function buildNextStepStructured(args: {
  readonly scanSubset: ScanSubset;
  readonly baseline: BaselineSummary | null;
  readonly writeBaseline: boolean;
  readonly wrappers: WrappersSubset;
  readonly root: string;
  readonly embeddedScan: unknown;
}): NextStepStructured {
  // Truncation / bulk-catalog override: when the embedded `scan_project`
  // leg shipped a truncation- or bulk-shape warning code AND the
  // upstream response carries a narrowing `nextStepStructured`,
  // propagate it verbatim to the bootstrap surface. The upstream
  // already routes to a scope-narrowing call (`scan_file` on the
  // top-impact non-vendor file, `coverage` on the manual-review
  // angle, or `propose_config` for a bulk-vendor exclude block) per
  // `scan-project-slim-next-step.ts` and the bulk-vendor / small-
  // demo-catalog overrides; bootstrap re-emitting `{ tool:
  // "scan_project", args: {} }` would point the agent back at the
  // same scope that just produced the truncation. Per
  // `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
  // must terminate at a narrowing tool, never form a cycle between
  // transport-failing siblings": when truncation/bulk fires, the
  // forward step must reduce scope. Checked first so the override
  // wins over the baseline-written and dry-run-with-violations
  // branches below — narrowing is the load-bearing recommendation
  // when the embedded scan signals it couldn't fit the full result.
  const embeddedNarrowing = readEmbeddedNarrowingNextStep(args.embeddedScan);
  if (embeddedNarrowing !== null) {
    return embeddedNarrowing;
  }
  // Post-write: the grandfathered baseline is on disk, and the
  // canonical verify-in-CI move is `baseline check`. Checked first so
  // the write path wins over the violations branch below (writing a
  // baseline implies violations > 0 at the time of the write).
  if (args.baseline?.written) {
    return { tool: "baseline", args: { mode: "check" } };
  }
  // Dry-run with violations is where the former self-loop lived
  // (`{ tool: "bootstrap", args: { writeBaseline: true } }`). That
  // pointed the agent at a re-invocation of this same tool with a
  // different flag — a recursive loop, not a forward step. The
  // grandfather-via-baseline option is still surfaced as a
  // grandfather-alternative in the prose `nextStep`, which is where
  // the two options belong per the "One tool call should answer
  // 'what next?'" rule. The structured hint now picks the forward
  // option: either `detect_native_wrappers` when the detect leg
  // surfaced wrapper candidates that haven't been written into
  // config yet (the agent's more actionable first move — confirming
  // wrappers changes which findings are real), or `scan_project` to
  // iterate on findings after the agent fixes them.
  //
  // The "unconfirmed wrappers" proxy here is the presence of any
  // candidates on the detect leg's subset — non-empty means the
  // scanner found PascalCase+onClick components the agent hasn't
  // yet folded into `nativeWrappers` config. A stronger
  // "still-assumed-not-confirmed" signal (per wrapper-source
  // telemetry on `scan_project`) isn't cheaply reachable from the
  // composed-legs result here without re-threading the scan meta,
  // so we use the candidate-list proxy and accept it may over-route
  // to `detect_native_wrappers` in cases where the user has
  // already declared the wrappers and detect just re-reported
  // them. That's an honest over-surface (one extra tool call), not
  // the silent-miss direction. TODO:
  // thread `meta.activeNativeWrappers` from the scan leg so this
  // branch can discriminate "detected but unconfirmed" from
  // "detected and already in config."
  if (!args.writeBaseline && args.scanSubset.violationsCount > 0) {
    if (args.wrappers.candidates.length > 0) {
      return { tool: "detect_native_wrappers", args: { cwd: args.root } };
    }
    return { tool: "scan_project", args: {} };
  }
  return { tool: "scan_project", args: {} };
}

/**
 * Warning codes whose presence on the embedded scan-leg response
 * means the underlying scan was scope-bounded — either truncated by
 * the host token cap, dropped per-file findings to fit the envelope,
 * or detected a bulk-catalog corpus shape that argues for scope
 * narrowing. Per `docs/kb/architecture/ai-first-consumer.md`
 * "NextStep handoffs must terminate at a narrowing tool, never form
 * a cycle between transport-failing siblings": when any of these
 * fires, the forward step must reduce scope rather than re-issue
 * `scan_project` against the same args that produced the truncation.
 */
const TRUNCATION_OR_BULK_WARNING_CODES = new Set<string>([
  "response_token_budget_truncated",
  "truncated_files_dropped",
  "response_dropped_files_oversize",
  "bulk_catalog_detected",
]);

/**
 * Reads a narrowing `nextStepStructured` off the embedded scan-leg
 * response when the scan's own warnings include a truncation- or
 * bulk-shape code. Returns the upstream structured hint verbatim so
 * the bootstrap surface forwards the same scope-narrowing
 * recommendation the upstream already produced (e.g. `scan_file`
 * on the top non-vendor file, `coverage` on the manual-review
 * angle, or `propose_config` on a bulk-vendor exclude block). The
 * upstream's narrowing logic lives in `scan-project-slim-next-step.ts`
 * and the bulk-vendor / small-demo-catalog overrides in
 * `tool-scan-project.ts`; bootstrap re-deriving narrowing here would
 * duplicate that logic.
 *
 * Returns `null` when:
 *   - the embedded scan is not an object (defensive over forwarded
 *     JSON the bootstrap doesn't own),
 *   - no truncation/bulk warning fired (the override doesn't apply
 *     and the existing baseline / wrappers / scan_project branches
 *     pick the next step), or
 *   - the upstream `nextStepStructured` is missing or malformed (no
 *     narrowing recommendation to propagate; fall through to the
 *     existing logic rather than synthesize one).
 *
 * The override stays additive: when it returns null, the existing
 * branch logic runs unchanged.
 */
function readEmbeddedNarrowingNextStep(scan: unknown): NextStepStructured | null {
  if (!scan || typeof scan !== "object") return null;
  const record = scan as Record<string, unknown>;
  const warnings = readStringArray(record, "warnings");
  if (!warnings.some((code) => TRUNCATION_OR_BULK_WARNING_CODES.has(code))) {
    return null;
  }
  const upstreamNext = record["nextStepStructured"];
  if (!upstreamNext || typeof upstreamNext !== "object") return null;
  const upstreamRecord = upstreamNext as Record<string, unknown>;
  const tool = upstreamRecord["tool"];
  const upstreamArgs = upstreamRecord["args"];
  if (typeof tool !== "string" || tool.length === 0) return null;
  if (!upstreamArgs || typeof upstreamArgs !== "object") return null;
  return { tool, args: upstreamArgs as Record<string, unknown> };
}
