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
 *     `plan.findingsByFile` already ships `{ path, count }` entries,
 *     so we reuse that field rather than introducing a parallel
 *     `topFiles` sibling. Same shape, one name.
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
  return {
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
}
