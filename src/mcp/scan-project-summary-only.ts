/**
 * `scan_project({ summaryOnly: true })` envelope builder.
 *
 * First-call ergonomics for bulk-corpus scans (catalogs of 4000+ files
 * producing 40k+ findings). The default per-file `files[]` array on
 * such corpora ships post-clip envelopes that still cross the host
 * token cap; the slim-envelope fallback inside
 * `scan-project-budget.ts` already handles this defensively, but it
 * fires only after the full envelope was assembled and measured —
 * which leaves the bulk-corpus first-call paying the full assembly
 * cost on every retry.
 *
 * The summary-only flag is the agent-facing first-call shortcut: skip
 * the per-file `files[]` array entirely, ship the headline structured
 * counters (`plan` with `topRules`, `findingsByFile`, `findingsByRule`,
 * `fixesByClass`, `summary`), the scan-confidence telemetry the agent reads to decide
 * whether the scan had teeth (`meta.filesByExtension`, `configSource`,
 * `rulesEvaluated`, `analysisCoverage`), and `nextStep` so the second
 * call can route at a narrower scope (or drop `summaryOnly` once the
 * scope is small enough to ship per-file findings).
 *
 * Doctrine alignment per `docs/kb/architecture/ai-first-consumer.md`:
 *
 *   - "Surface, don't suppress" — the per-file findings still exist
 *     at the engine; this mode opts the *response* out of shipping
 *     them, not the scan out of producing them. The default per-file
 *     `files[]` shape is unchanged.
 *   - "One tool call should answer 'what next?'" — the slim envelope
 *     carries `nextStep` recommending the agent scope down (or drop
 *     `summaryOnly`) so the second call lands somewhere productive.
 *   - "Sibling fields naming the same concept must use one shape" —
 *     the spec calls the per-file rollup `topFiles`; the existing
 *     `plan.findingsByFile` already ships `{ path, errorWarningCount }`
 *     entries, so we reuse that field rather than introducing a
 *     parallel `topFiles` sibling. Same shape, one name. The
 *     `errorWarningCount` slice-explicit name (renamed from bare
 *     `count`) keeps the field honest against the parallel `scan_file`
 *     `totalFindings` (paging-load-bearing, all-severity) — see
 *     `findings-by-file.ts` for the cross-surface identity.
 *   - "Truncated containers must rename or sentinel, not retain" —
 *     `files` is OMITTED entirely (not `[]`) so the agent reading
 *     the response can't confuse "summary-only mode" with "clean scan
 *     of zero files." The discriminator is the top-level boolean
 *     `summaryOnly: true` and the pairing `filesArrayDropped: true`.
 *
 * Lives in its own file so `tool-scan-project.ts` stays under the
 * 500-effective-line file budget enforced by `scripts/check-limits.ts`.
 */

import type { NextStepStructured } from "./next-step.ts";
import {
  guardOversizeEnvelope,
  type OversizeEnvelopeReason,
  oversizeEnvelopeWarningsField,
} from "./oversize-envelope.ts";
import type { ScanFormatted } from "./tools-helpers.ts";
import type { ScanWarningCode, ScanWarningDetails } from "./warnings.ts";

/**
 * Subset of `meta` carried on summary-only responses. Mirrors the
 * scan-confidence telemetry the slim envelope (`scan-project-budget.ts`)
 * preserves — the keys an agent reads to decide whether the scan had
 * teeth and what the next call should look like — plus
 * `filesByExtension` and `analysisCoverage` (which the spec names
 * explicitly so the agent sees per-extension counts inline).
 *
 * Intentionally small: bulk-corpus repros have shown the full meta
 * block (perRuleCoverage rows, scannedBuildArtifacts groups, scope
 * file paths) crossing 40 KB on its own — keeping it would defeat the
 * 20 KB envelope target the summary-only mode exists to honor.
 *
 * `analysisCoverage` is preserved because the agent reads
 * `parseErrorFiles` / `partialParseFiles` / `fragmentFiles` /
 * `skippedByExtension` to decide whether the scan covered the inputs
 * it expected — without those, an agent calling `summaryOnly: true`
 * cannot tell "the scan ran on every file" from "the scan parsed half
 * the corpus and the rest came back as text-source skips." That
 * miss is the same silent-failure shape the doctrine warns about.
 */
const SUMMARY_META_KEYS: readonly string[] = [
  "tool",
  "version",
  "standards",
  "level",
  "filesScanned",
  "durationMs",
  "configSource",
  "scanned",
  "scanMode",
  "rootSource",
  "filesByExtension",
  "rulesEvaluated",
  "filesWithAnyRuleEvaluated",
  "filesWithZeroRuleEvaluation",
  "rulesNotEvaluatedDueToInputType",
  "analysisCoverage",
  "hostDeclaredRoots",
  "rootsOverlapNote",
];

/**
 * Builds the spreadable `meta` slice for `summaryOnly: true`. Drops
 * every per-rule / per-file fan-out that doesn't fit under the 20 KB
 * envelope target on bulk-corpus responses. Retained keys are listed
 * in {@link SUMMARY_META_KEYS}; everything else (perRuleCoverage,
 * scannedBuildArtifacts grouped + ungrouped, scope.files,
 * additionalPathsScanned, restrictToPathsApplied, …) is dropped.
 *
 * Caller threads the dropped-keys list into the response as
 * `metaFieldsDroppedForSummary` so the agent reading the slim meta
 * can distinguish "no scan-confidence concerns" from "the meta was
 * trimmed for the summary envelope." Symmetric to the slim-envelope
 * `metaFieldsDropped` channel — same doctrine bullet ("Truncated
 * containers must rename or sentinel, not retain").
 */
export function buildSummaryMeta(fullMeta: Record<string, unknown>): {
  readonly meta: Record<string, unknown>;
  readonly metaFieldsDropped: readonly string[];
} {
  const slim: Record<string, unknown> = {};
  for (const key of SUMMARY_META_KEYS) {
    if (key in fullMeta) {
      slim[key] = fullMeta[key];
    }
  }
  const metaFieldsDropped = Object.keys(fullMeta).filter((k) => !(k in slim));
  return { meta: slim, metaFieldsDropped };
}

/**
 * Recommended `nextStep` prose for `summaryOnly: true` responses.
 * Routes the agent at the narrowing tools rather than back at
 * `scan_project` itself with the same params that produced the
 * summary — per the doctrine bullet "NextStep handoffs must terminate
 * at a narrowing tool, never form a cycle between transport-failing
 * siblings," echoing `summaryOnly: true` would force the agent into a
 * transport cycle on bulk corpora.
 *
 * Two recommendations in order of effectiveness:
 *
 *   1. Read `plan.topRules` and call `explain_rule({ ruleId })` on
 *      the dominant rule to learn whether the wave is a single-fix
 *      mechanical edit or a vendor-noise mass-suppress candidate.
 *   2. Use `plan.findingsByFile[0].path` as a starting point for
 *      `scan_project({ restrictToPaths: ["<path>"] })` — drops
 *      `summaryOnly` for the second call so the agent gets per-file
 *      findings on the narrower scope.
 */
export const SUMMARY_ONLY_NEXT_STEP_PROSE =
  "Summary-only mode skipped per-file findings to fit under the response envelope. Read `plan.topRules` to identify the dominant rules, then either call `explain_rule({ ruleId: plan.topRules[0].ruleId })` for context, or re-call `scan_project({ restrictToPaths: [<dominant path from plan.findingsByFile>] })` (without `summaryOnly`) to get per-file findings on the narrower scope.";

/**
 * Builds the structured `nextStepStructured` form for the
 * summary-only response. Routes the agent at `explain_rule` on the
 * top-firing rule when one exists, falling back to `scan_project`
 * with `restrictToPaths` naming the densest file when no `topRules`
 * entry survived.
 *
 * Reads off `formatted.plan` because the topRules / findingsByFile
 * rollups are already stamped there by `withTopRules` /
 * `withFindingsByFile` upstream of this builder. Returns `undefined`
 * when neither rollup carries an entry the structured pointer can
 * name — the prose `nextStep` still rides on the response, but the
 * structured form stays present-when-meaningful per CLAUDE.md §1.
 */
export function buildSummaryNextStepStructured(
  plan: Record<string, unknown>,
): NextStepStructured | undefined {
  const topRules = plan["topRules"];
  if (Array.isArray(topRules) && topRules.length > 0) {
    const head = topRules[0] as { readonly ruleId?: unknown };
    if (typeof head.ruleId === "string" && head.ruleId.length > 0) {
      return { tool: "explain_rule", args: { ruleId: head.ruleId } };
    }
  }
  const findingsByFile = plan["findingsByFile"];
  if (Array.isArray(findingsByFile) && findingsByFile.length > 0) {
    const head = findingsByFile[0] as { readonly path?: unknown };
    if (typeof head.path === "string" && head.path.length > 0) {
      return {
        tool: "scan_project",
        args: { restrictToPaths: [head.path] },
      };
    }
  }
  return undefined;
}

/**
 * Composes the full summary-only response shape. Caller passes the
 * post-`withTopRules` / post-`withFindingsByFile` plan reference plus
 * the full meta block; this helper does not run any of the rollups
 * itself — the input is the same shape the standard assembly path
 * would consume, just routed through a different envelope builder.
 *
 * Output shape:
 *   - `plan` — unchanged from the caller's `formatted.plan`. Carries
 *     `topRules`, `findingsByFile`, `findingsByRule`, `fixesByClass`,
 *     `summary`, `actionableManualItems`, `untargetedCriteriaForProject`,
 *     etc. (project-walk surface — the per-file lane ships the parallel
 *     `untargetedCriteriaForFile` instead).
 *   - `meta` — slimmed to {@link SUMMARY_META_KEYS}.
 *   - `summaryOnly: true` — discriminator flag. Lets the agent (and
 *     downstream snapshot tests) distinguish summary mode from a
 *     clean scan of zero files.
 *   - `filesArrayDropped: true` — sibling boolean naming the
 *     `files[]` discard. Symmetric to the slim-envelope path; pairs
 *     with the `summaryOnly: true` flag so the agent can branch on
 *     either signal.
 *   - `totalFilesWithFindings` — full pre-drop inventory size so the
 *     agent reads "how many files had findings" without paging
 *     through `files[]`.
 *   - `metaFieldsDroppedForSummary` — keys that the meta-trim
 *     dropped, present-when-meaningful (omitted on the small-corpus
 *     case where the full meta already fit under the summary cap).
 *   - `nextStep` / `nextStepStructured` — narrowing routing per
 *     {@link SUMMARY_ONLY_NEXT_STEP_PROSE} /
 *     {@link buildSummaryNextStepStructured}.
 *   - `warnings` / `warningsDetails` — pass-through from the upstream
 *     scan; summary-only mode does NOT add or drop warning codes
 *     beyond what the normal scan path emits, so the agent reads the
 *     same scan-confidence telemetry on both surfaces.
 *
 * `files` is intentionally OMITTED entirely (not `[]`). Per the
 * doctrine bullet "Truncated containers must rename or sentinel, not
 * retain," shipping `files: []` next to `summaryOnly: true` would
 * read as "summary-only ran but found nothing" — the discriminator
 * is the top-level `summaryOnly: true` + `filesArrayDropped: true`
 * pair, not a sentinel-empty array.
 */
export function buildSummaryOnlyResponse(args: {
  readonly formatted: ScanFormatted;
  readonly fullMeta: Record<string, unknown>;
  readonly warnings?: readonly ScanWarningCode[];
  readonly warningsDetails?: ScanWarningDetails;
}): Record<string, unknown> {
  const { formatted, fullMeta, warnings, warningsDetails } = args;
  const { meta, metaFieldsDropped } = buildSummaryMeta(fullMeta);
  const nextStepStructured = buildSummaryNextStepStructured(formatted.plan);
  const assembled: Record<string, unknown> = {
    plan: formatted.plan,
    summaryOnly: true as const,
    filesArrayDropped: true as const,
    totalFilesWithFindings: formatted.files.length,
    ...(metaFieldsDropped.length > 0 ? { metaFieldsDroppedForSummary: metaFieldsDropped } : {}),
    nextStep: SUMMARY_ONLY_NEXT_STEP_PROSE,
    ...(nextStepStructured === undefined ? {} : { nextStepStructured }),
    ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
    ...(warningsDetails === undefined || Object.keys(warningsDetails).length === 0
      ? {}
      : { warningsDetails }),
    meta,
  };
  // Q17 oversize-envelope guard: when even the summary envelope crosses
  // the host token ceiling, fall back to a further-slimmed shape and
  // emit `response_dropped_files_oversize` so the agent reads an honest
  // "scope down further" signal. Without this guard, bulk-vendor
  // corpora can produce summary envelopes that still transport-fail
  // — succeed-then-evaporate — with no warning telling the caller.
  // Per AI-first doctrine "Oversize-success is ambiguous failure."
  const budgeted = applySummaryOnlyBudget({
    response: assembled,
    totalFilesWithFindings: formatted.files.length,
  });
  return budgeted.response;
}

/**
 * Top-level meta keys the summary-only slim envelope keeps when the
 * post-summary response is STILL over the host ceiling. Subset of
 * {@link SUMMARY_META_KEYS} — drops the verbose per-extension /
 * per-file fans (`filesByExtension`, `analysisCoverage`,
 * `rulesNotEvaluatedDueToInputType`) so the surviving envelope fits
 * under the minimum target.
 *
 * Mirrors `SLIM_META_KEYS` in `scan-project-budget.ts` for the
 * standard slim path; the two key lists are intentionally close so the
 * agent reading either slim envelope reads the same scan-confidence
 * scalars.
 */
const SUMMARY_SLIM_META_KEYS: readonly string[] = [
  "tool",
  "version",
  "standards",
  "level",
  "filesScanned",
  "durationMs",
  "configSource",
  "scanned",
  "rootSource",
  "scanMode",
  "hostDeclaredRoots",
  "rootsOverlapNote",
];

/**
 * Head-slice cap for `plan.topRules` on the summary-slim envelope. The
 * full rollup carries up to {@link import("./scan-assembly.ts").TOP_RULES_DEFAULT_LIMIT}
 * (10) entries at ~250 chars each. Mirrors `SLIM_TOP_RULES_CAP` in
 * `scan-project-budget.ts` so the cross-surface slim shape stays
 * symmetric.
 */
const SUMMARY_SLIM_TOP_RULES_CAP = 3;

/**
 * Head-slice cap for `plan.findingsByFile` on the summary-slim
 * envelope. Mirrors `SLIM_FINDINGS_BY_FILE_CAP` in
 * `scan-project-budget.ts`.
 */
const SUMMARY_SLIM_FINDINGS_BY_FILE_CAP = 3;

/**
 * Head-slice cap for `plan.findingsByRule` on the summary-slim
 * envelope. The full map keys every rule that emitted at least one
 * error/warning finding — on a corpus where 80+ distinct rules fired,
 * the map alone can carry ~5KB. Cap at 10 entries (sorted by count
 * descending so the dominant rules survive); the truncated count
 * lands in `slimTruncations`.
 *
 * Slightly higher than `SUMMARY_SLIM_TOP_RULES_CAP` because
 * `findingsByRule` is the agent's canonical "which rules fired and how
 * many of each" surface, used to estimate rule-by-rule fix cost. Three
 * entries would force a re-call to learn the per-rule distribution;
 * ten preserves the routing utility while still trimming the long tail.
 */
const SUMMARY_SLIM_FINDINGS_BY_RULE_CAP = 10;

interface SummaryTruncationEntry {
  readonly fieldPath: string;
  readonly shown: number;
  readonly total: number;
}

/**
 * Result of {@link applySummaryOnlyBudget}.
 */
export interface ApplySummaryOnlyBudgetResult {
  readonly response: Record<string, unknown>;
  /** True when the slim guard fired. */
  readonly truncated: boolean;
}

/**
 * Applies the oversize-envelope guard to a `summaryOnly: true`
 * response. Pure: never mutates `args.response`. The slim builder owns
 * its own response shape — this helper only routes between
 * pass-through and slim.
 *
 * Pass-through is reference-stable when the response fits under the
 * host ceiling — the under-cap path returns the input by reference so
 * downstream consumers see no churn on common-case responses.
 *
 * Slim path: head-slices verbose plan rollups (`topRules`,
 * `findingsByFile`, `findingsByRule`), drops verbose meta keys
 * (`filesByExtension`, `analysisCoverage`,
 * `rulesNotEvaluatedDueToInputType`), and stamps
 * `response_dropped_files_oversize` with `slimTruncations` /
 * `metaFieldsDropped` so the agent reads an honest "scope down
 * further" signal.
 *
 * Per AI-first doctrine "Oversize-success is ambiguous failure" —
 * when the summary envelope itself crosses the host ceiling, the
 * caller needs the same minimum-honest envelope behavior the standard
 * `scan_project` slim path offers.
 */
export function applySummaryOnlyBudget(args: {
  readonly response: Record<string, unknown>;
  readonly hardCeilingChars?: number;
  readonly totalFilesWithFindings?: number;
}): ApplySummaryOnlyBudgetResult {
  const { response, hardCeilingChars, totalFilesWithFindings } = args;
  // The summary envelope already dropped `files[]`; the post-summary
  // inventory denominator is `totalFilesWithFindings` from the response
  // when the caller didn't supply one explicitly. Default to 0 when
  // both are absent — defensive, matches the helper's behavior on
  // hostile inputs (`oversize-envelope.ts` does the same).
  const totalFromResponse =
    typeof response["totalFilesWithFindings"] === "number"
      ? (response["totalFilesWithFindings"] as number)
      : 0;
  const total = totalFilesWithFindings ?? totalFromResponse;
  const guarded = guardOversizeEnvelope({
    original: response,
    // The summary envelope has no `files[]` — set `arrayKey` to a key
    // that will resolve to a non-array so `droppedFileCountFromRequestedLimit`
    // defaults to 0 (no per-file entries to drop on this surface).
    // The honest count is in `totalFilesWithFindings`.
    arrayKey: "files",
    totalFilesWithFindings: total,
    ...(hardCeilingChars === undefined ? {} : { hardCeilingChars }),
    buildSlim: (reason) =>
      buildSummarySlimEnvelope({
        original: response,
        reason,
        totalFilesWithFindings: total,
      }),
  });
  return { response: guarded.response, truncated: guarded.triggered };
}

/**
 * Builds the minimum-honest envelope when the post-summary response is
 * still over the host ceiling. Trims verbose plan rollups, drops
 * verbose meta keys, and stamps `response_dropped_files_oversize` with
 * the byte arithmetic + per-field truncation summary.
 *
 * Retains the discriminator pair (`summaryOnly: true` +
 * `filesArrayDropped: true`) so an agent reading the slim response can
 * still tell summary-only mode from a clean scan of zero files. The
 * slim path adds the warning, it does NOT strip the mode flag.
 *
 * Drops `metaFieldsDroppedForSummary` (the prior summary-trim audit
 * field) — the canonical `metaFieldsDropped` payload on
 * `warningsDetails.response_dropped_files_oversize` carries the
 * superset (every key the slim builder discarded), so retaining the
 * earlier field would create redundant overlapping signals per
 * "Truncation reporters must reconcile across warnings."
 *
 * Pure: returns a fresh response object; never mutates `original`.
 */
function buildSummarySlimEnvelope(args: {
  readonly original: Record<string, unknown>;
  readonly reason: OversizeEnvelopeReason;
  readonly totalFilesWithFindings: number;
}): Record<string, unknown> {
  const { original, reason, totalFilesWithFindings } = args;
  // Slim the meta block further. `original.meta` was already trimmed
  // by `buildSummaryMeta` — the slim path drops the remaining verbose
  // sub-fields (`filesByExtension`, `analysisCoverage`, etc.) so the
  // surviving envelope fits under the minimum target.
  const summaryMeta = readMeta(original) ?? {};
  const slimMeta: Record<string, unknown> = {};
  for (const key of SUMMARY_SLIM_META_KEYS) {
    if (key in summaryMeta) slimMeta[key] = summaryMeta[key];
  }
  // metaFieldsDropped here is the SUPERSET of the prior summary-trim
  // and the additional slim-trim — every meta key the agent would have
  // seen in the full meta block but isn't on the wire now. Reconstruct
  // by reading the prior summary trim audit (`metaFieldsDroppedForSummary`)
  // and unioning with the new slim drops.
  const summaryAlreadyDropped = readStringArray(original, "metaFieldsDroppedForSummary") ?? [];
  const slimNewlyDropped = Object.keys(summaryMeta).filter((k) => !(k in slimMeta));
  const metaFieldsDropped = unionInOrder(summaryAlreadyDropped, slimNewlyDropped);
  // Trim verbose plan arrays / maps. Each cap fires only when the
  // input exceeded it; the truncations array reports each field
  // independently so `slimTruncations` carries the per-field
  // shown/total pair the agent can act on.
  const originalPlan = readPlan(original) ?? {};
  const { plan: slimPlan, truncations: planTruncations } = trimSummaryPlan(originalPlan);
  // Pre-existing warnings + warningsDetails ride through the merge so
  // codes like `scanned_build_artifacts_present` accumulated upstream
  // are preserved on the slim envelope. Same shape as the standard
  // `scan_project` slim path.
  const baseWarnings = readWarnings(original);
  const baseWarningsDetails = readWarningsDetails(original);
  const merged = oversizeEnvelopeWarningsField({
    reason,
    ...(baseWarnings === undefined ? {} : { baseWarnings }),
    ...(baseWarningsDetails === undefined ? {} : { baseWarningsDetails }),
    ...(metaFieldsDropped.length > 0 ? { metaFieldsDropped } : {}),
    ...(planTruncations.length > 0 ? { slimTruncations: planTruncations } : {}),
  });
  // Derive a fresh `nextStepStructured` aligned with the slim prose's
  // "Scope down further" action verb — do NOT propagate the upstream
  // summary-only response's structured hint (commonly
  // `explain_rule({ ruleId: plan.topRules[0].ruleId })`). Propagating
  // the upstream verbatim is the canonical "NextStep prose and
  // structured channels must agree" doctrine miss
  // (`docs/kb/architecture/ai-first-consumer.md`): the prose tells the
  // agent to scope down via `restrictToPaths` or `propose_config`, but
  // the structured channel hands the agent `explain_rule` to call
  // instead — two channels, two contradictory next moves. The
  // structured field MUST encode the same scope-narrowing call the
  // prose names so the agent's executed handoff matches the
  // prose-stated intent.
  const nextStepStructured = buildSummarySlimNextStepStructured(slimPlan);
  return {
    plan: slimPlan,
    summaryOnly: true as const,
    filesArrayDropped: true as const,
    totalFilesWithFindings,
    nextStep: SUMMARY_SLIM_NEXT_STEP_PROSE,
    nextStepStructured,
    warnings: merged.warnings,
    warningsDetails: merged.warningsDetails,
    meta: slimMeta,
  };
}

/**
 * Builds the structured `nextStepStructured` for the summary-slim
 * envelope. Derived from the same predicate as
 * {@link SUMMARY_SLIM_NEXT_STEP_PROSE}'s "Scope down further" action
 * verb so the prose and structured channels can never silently
 * disagree on the agent's next move. Two arms, in priority order:
 *
 *   1. **`plan.findingsByFile[0].path` exists** → `scan_project`
 *      with `restrictToPaths: [<head path>]`. This is the prose's
 *      primary recommendation verbatim — the agent re-issues
 *      `scan_project` against the densest single sub-tree, which
 *      narrows scope by construction (per the
 *      `nextstep-cycle-avoidance` walk-one-hop predicate, a non-empty
 *      `restrictToPaths` is the narrowing signature).
 *   2. **No addressable head path** (slim plan dropped
 *      `findingsByFile` entirely, or the head entry lacks a `path`
 *      string) → `propose_config({})`. The deterministic
 *      exclude-emission tool is the documented narrowing-recovery
 *      surface — calling it materially narrows the next
 *      `scan_project` scope by emitting an `exclude` block from the
 *      build-artifact classifier. Same fallback the standard slim
 *      envelope uses on its all-vendor branch.
 *
 * Per the AI-first doctrine "NextStep prose and structured channels
 * must agree": when prose advises a scope-narrowing call, the
 * structured field MUST encode that same call's tool + args. The
 * cycle-avoidance invariant (every recommendation must narrow scope or
 * route to a deterministic narrowing tool) is upheld on both arms by
 * construction.
 *
 * Pure: derives entirely from the slim plan; never reads the upstream
 * structured hint (intentional — propagating the upstream is the
 * specific regression this helper closes).
 */
function buildSummarySlimNextStepStructured(slimPlan: Record<string, unknown>): NextStepStructured {
  const findingsByFile = slimPlan["findingsByFile"];
  if (Array.isArray(findingsByFile) && findingsByFile.length > 0) {
    const head = findingsByFile[0] as { readonly path?: unknown };
    if (typeof head.path === "string" && head.path.length > 0) {
      return { tool: "scan_project", args: { restrictToPaths: [head.path] } };
    }
  }
  return { tool: "propose_config", args: {} };
}

/**
 * Trims the verbose plan arrays / maps the summary-slim envelope
 * head-slices. Three plan fields grow linearly with input fan-out and
 * cross the slim budget on bulk-vendor corpora: `topRules`,
 * `findingsByFile`, `findingsByRule`.
 *
 * Returns a `{ plan, truncations }` pair so the caller threads the
 * truncation summary into the warnings-channel payload. Pure: never
 * mutates the input plan.
 */
function trimSummaryPlan(plan: Record<string, unknown>): {
  readonly plan: Record<string, unknown>;
  readonly truncations: readonly SummaryTruncationEntry[];
} {
  let next: Record<string, unknown> = plan;
  const truncations: SummaryTruncationEntry[] = [];
  const trimArray = (key: string, cap: number): void => {
    const value = plan[key];
    if (!Array.isArray(value) || value.length <= cap) return;
    const trimmed = value.slice(0, cap);
    next = { ...next, [key]: trimmed };
    truncations.push({ fieldPath: `plan.${key}`, shown: trimmed.length, total: value.length });
  };
  trimArray("topRules", SUMMARY_SLIM_TOP_RULES_CAP);
  trimArray("findingsByFile", SUMMARY_SLIM_FINDINGS_BY_FILE_CAP);
  // findingsByRule is a `Record<string, number>` (one entry per
  // rule that emitted at least one error/warning), not an array.
  // Head-slice by sorting entries descending and keeping the top
  // SUMMARY_SLIM_FINDINGS_BY_RULE_CAP. Tie-break by ruleId
  // alphabetically for deterministic wire shape across runs.
  const findingsByRule = plan["findingsByRule"];
  if (
    findingsByRule !== undefined &&
    findingsByRule !== null &&
    typeof findingsByRule === "object"
  ) {
    const entries: [string, number][] = [];
    for (const [k, v] of Object.entries(findingsByRule as Record<string, unknown>)) {
      if (typeof v === "number") entries.push([k, v]);
    }
    if (entries.length > SUMMARY_SLIM_FINDINGS_BY_RULE_CAP) {
      const sorted = [...entries].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });
      const trimmed = sorted.slice(0, SUMMARY_SLIM_FINDINGS_BY_RULE_CAP);
      const trimmedMap: Record<string, number> = {};
      for (const [k, v] of trimmed) trimmedMap[k] = v;
      next = { ...next, findingsByRule: trimmedMap };
      truncations.push({
        fieldPath: "plan.findingsByRule",
        shown: trimmed.length,
        total: entries.length,
      });
    }
  }
  return { plan: next, truncations };
}

/**
 * Prose for the summary-slim envelope's nextStep. Names the recovery
 * the agent needs to perform when even the summary envelope crossed
 * the host ceiling: scope down further (the recovery direction is
 * the same as the standard slim path, but the framing is explicit
 * about "summary mode was already the fallback — scope down one
 * more level").
 *
 * Per AI-first doctrine "NextStep handoffs must terminate at a
 * narrowing tool, never form a cycle between transport-failing
 * siblings": the summary-slim envelope must NOT route the agent back
 * at `scan_project({ summaryOnly: true })` with the same params —
 * that would cycle. The recovery names `restrictToPaths` (a real
 * narrowing knob) and `propose_config` (a deterministic excludes
 * generator) as concrete next moves.
 */
const SUMMARY_SLIM_NEXT_STEP_PROSE =
  "Even the summary-only envelope crossed the MCP host's token ceiling on this corpus, so verbose plan rollups (topRules / findingsByFile / findingsByRule) and per-extension meta were further trimmed to keep the response routable. " +
  "Scope down further before re-calling: pass a tighter `cwd` to a single sub-tree, use `restrictToPaths: [<dominant path from plan.findingsByFile>]`, " +
  "or call `propose_config` to emit an `exclude` block from the build-artifact classifier and re-run `scan_project` over the narrowed file set. " +
  "Do NOT re-call `scan_project({ summaryOnly: true })` with the same scope — the envelope was already over the ceiling on that scope.";

function readMeta(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const m = response["meta"];
  if (m === undefined || m === null || typeof m !== "object") return undefined;
  return m as Record<string, unknown>;
}

function readPlan(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const p = response["plan"];
  if (p === undefined || p === null || typeof p !== "object") return undefined;
  return p as Record<string, unknown>;
}

function readWarnings(response: Record<string, unknown>): readonly ScanWarningCode[] | undefined {
  const w = response["warnings"];
  if (!Array.isArray(w)) return undefined;
  return w as readonly ScanWarningCode[];
}

function readWarningsDetails(response: Record<string, unknown>): ScanWarningDetails | undefined {
  const d = response["warningsDetails"];
  if (d === undefined || d === null || typeof d !== "object") return undefined;
  return d as ScanWarningDetails;
}

function readStringArray(
  response: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const v = response[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Concatenates two ordered string lists into one, dropping duplicates
 * while preserving the first-seen order. Used to merge the prior
 * summary-trim drops with the new slim-trim drops so
 * `metaFieldsDropped` lists every key the agent would have seen on the
 * full meta block but doesn't see on the slim envelope.
 */
function unionInOrder(first: readonly string[], second: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of first) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  for (const s of second) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
