/**
 * The `review_candidates` MCP tool. Surfaces the tier-1 manual-review
 * candidates (produced by `src/review/finders/`) with enough source
 * context for an LLM caller to answer the criterion's review prompt
 * pass/fail without further filesystem access.
 *
 * This is the programmatic counterpart to the `checklist` tool:
 * `checklist` groups by criterion; `review_candidates` groups by
 * candidate so an agent can iterate one-by-one.
 *
 * Response shape:
 *   - `prompts: { [criterionId]: { text, finderId } }` — keyed by
 *     criterion, present only when at least one candidate has an
 *     associated finder prompt. The prompt text is identical for every
 *     candidate of the same criterion, so hoisting it to the top level
 *     dedupes the ~450-char prose that would otherwise repeat on each
 *     row (~6 KB of duplication on a 15-candidate criterion).
 *   - `candidates[]` — each entry carries `criterionId`, `location`,
 *     `reason`, optional `snippet`. The caller looks up
 *     `prompts[candidate.criterionId]` when it needs the review prompt;
 *     omission is the honest signal that no finder prompt is available
 *     for that criterion, not a `reviewPrompt: null` sentinel.
 */

import { runScan } from "../engine/scanner.ts";
import type { CandidateFinder } from "../types/review.ts";
import type { Standard } from "../types/standard.ts";
import {
  dedupeReviewCandidatesByReason,
  type ReasonDedupedCandidate,
} from "./review-candidate-dedup.ts";
import { resolveActiveRules } from "./rules-evaluated.ts";
import { buildSnippetForReason, type SourceEntry, sourceIndex } from "./source-snippet.ts";
import {
  errorResult,
  firstUnknownStandard,
  type McpTool,
  parseFiles,
  resolveLevel,
  resolveStandards,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import { warningsField } from "./warnings.ts";

export const reviewCandidatesTool: McpTool = {
  def: {
    name: "review_candidates",
    description:
      "List tier-1 manual-review candidates with source context. Use this to drive an LLM-assisted manual review loop: iterate candidates, read the snippet, answer the prompt, report verdict. The pass/fail review prompt is deduped to `prompts[criterionId].text` at the top level — each candidate carries `criterionId`, look up the prompt there. When a finder declares multiple criterion IDs (e.g. `wcag22:1.3.6` + `wcag21:1.3.6` for the same `<input>`), the candidate is folded into one row carrying `criteria: [...ids]` (sorted union; canonical first ID populates the singular `criterionId` slot for filter compatibility); pass the array through to `verdict_candidate.candidate.criteria` so one verdict applies to every listed criterion atomically. Pair with `scan` for full coverage.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File or directory paths to scan. Omit for project root.",
        },
        standard: { type: "string", description: "Standard ID (e.g. wcag22)." },
        level: {
          type: "string",
          enum: ["A", "AA", "AAA"],
          description: "Conformance level filter.",
        },
        criterionId: {
          type: "string",
          description: "Optional. Filter to candidates for a single criterion (e.g. wcag22:1.2.1).",
        },
        cwd: { type: "string", description: "Base directory for relative paths." },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const cwd = strParam(params, "cwd") ?? process.cwd();
    const paths = strArrayParam(params, "paths") ?? [cwd];

    const standards = resolveStandards(strParam(params, "standard"), session);
    const unknown = firstUnknownStandard(standards, session);
    if (unknown !== null) {
      const known = session.registry.standards.map((s) => s.id).join(", ");
      return errorResult({
        code: "standard-not-found",
        message: `Unknown standard '${unknown}'. Loaded: ${known}.`,
        details: { requested: unknown, loaded: session.registry.standards.map((s) => s.id) },
        remediation:
          "Pass `standard` with one of the loaded IDs, or omit to use the session default.",
      });
    }
    const filterCriterion = strParam(params, "criterionId");
    if (filterCriterion !== undefined && !isKnownCriterion(filterCriterion, session)) {
      return errorResult({
        code: "criterion-not-found",
        message: `Unknown criterion '${filterCriterion}'.`,
        details: { requested: filterCriterion },
        remediation:
          "Use `explain_standard` to list criterion IDs for a given standard (e.g. wcag22:1.2.1).",
      });
    }
    const level = resolveLevel(strParam(params, "level"), session);
    const projectConfig = await session.loadProjectConfig(cwd);
    const files = await parseFiles(paths, session, cwd);

    // Q-SHARED-RULES-EVALUATED-SSOT: load project config and route
    // through resolveActiveRules so the rule set matches scan_project /
    // checklist / coverage on the same cwd — otherwise a `ra11y.config.ts`
    // that silences a rule would be honored by scan_project but ignored
    // here, and the candidate streams would drift.
    const { report } = runScan({
      standards: session.registry.standards,
      rules: resolveActiveRules(session, projectConfig),
      enabled: standards,
      files,
      finders: session.registry.finders,
      level,
    });

    const rawCandidates = (report.candidates ?? []).filter((c) => {
      if (filterCriterion && c.criterionId !== filterCriterion) return false;
      return isCriterionInLevel(c.criterionId, level, session);
    });

    // Cross-criterion dedup: when a finder declares multiple criterion
    // IDs (canonical case: `review/identify-purpose` covering both
    // `wcag22:1.3.6` and `wcag21:1.3.6`), it emits one row per criterion
    // at the same `(file, line, column)` with byte-identical reason
    // text. Pre-fold the agent saw N rows under one location with the
    // same evidence; post-fold one row carrying every covered criterion
    // in `criteria: string[]`. The downstream `verdict_candidate` tool
    // accepts that array and applies one verdict to all listed criteria
    // atomically — same evidence, one agent action. Per
    // `docs/kb/architecture/ai-first-consumer.md` "Per-tool review-
    // candidate shape must agree across surfaces": the by-position
    // surfaces (`scan_file.reviewCandidates[]` /
    // `scan_project.reviewCandidates[]`) already dedup the same union
    // via the per-position helper; the by-row surface dedups via the
    // by-reason helper so the same conceptual candidate carries one
    // identity-shaped entry across both surface families.
    const candidates = dedupeReviewCandidatesByReason(rawCandidates);

    const findersByCriterion = indexFindersByCriterion(session);
    const standardsById = new Map(session.registry.standards.map((s) => [s.id, s]));
    const sources = sourceIndex(files);

    const prompts = buildPromptsMap(candidates, findersByCriterion);
    const hasPrompts = Object.keys(prompts).length > 0;

    // Doctrine (CLAUDE.md §1 "Zero-output success is ambiguous failure"):
    // `{ candidateCount: 0, candidates: [] }` reads as "clean codebase"
    // when it may be "tool never ran." `review_candidates` has no
    // root-resolution step (takes `paths` directly, defaulting to
    // `[cwd]`) and doesn't load project config here; mirror the `scan`
    // tool's warning inputs so the malformed-input case surfaces the
    // honest `scanned_zero_files` code rather than a silent success.
    // `nextStep` is present-when-meaningful (CLAUDE.md §1): when
    // candidates exist, nudge toward the `ra11y/triage` prompt which
    // wraps the scan → read → verdict loop into a single structured
    // pass. Omitted on zero candidates — there is nothing to triage.
    const reviewNextStep =
      candidates.length > 0
        ? {
            nextStep:
              "For each candidate: read the `snippet` + `reason`, look up `prompts[criterionId].text` for the pass/fail question, then verdict. When a candidate carries `criteria: [...ids]` (cross-criterion union: same evidence covers multiple criteria), pass the array through to `verdict_candidate.candidate.criteria` so one verdict applies to every listed criterion atomically. Run the `ra11y/triage` prompt (via `prompts/get`) to batch-process all candidates in one structured pass.",
          }
        : {};
    return textResult({
      level,
      standards,
      candidateCount: candidates.length,
      // Omit `prompts` entirely when empty (zero candidates or zero
      // finder-backed candidates) rather than emitting `prompts: {}`.
      // Per CLAUDE.md §1, conditional-spread at the assembly site.
      ...(hasPrompts ? { prompts } : {}),
      ...reviewNextStep,
      candidates: candidates.map((c) => mapCandidateOut(c, standardsById, sources)),
      ...warningsField({
        filesScanned: files.length,
        rootSource: null,
        configSource: undefined,
        analysisCoverage: undefined,
        filesByExtension: undefined,
      }),
    });
  },
};

/**
 * Builds the top-level `prompts: Record<criterionId, { text, finderId }>`
 * map for the response. Iterates each candidate's full `criteria`
 * array (the cross-criterion fold may have collapsed N per-criterion
 * siblings into one row) so an agent looking up `prompts[id]` for any
 * covered criterion resolves — required when the canonical singular
 * `criterionId` slot holds the sorted-first union member but the agent
 * verdicts via the full union.
 *
 * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest", emits an
 * entry only when a finder exists for that criterion — omission is
 * the honest signal that no finder prompt is available, not a
 * `{ text: "", finderId: null }` sentinel.
 *
 * Extracted from the tool's main handler so the iteration branches
 * stay out of the parent's cognitive-complexity score.
 */
function buildPromptsMap(
  candidates: readonly ReasonDedupedCandidate[],
  findersByCriterion: ReadonlyMap<string, CandidateFinder>,
): Record<string, { readonly text: string; readonly finderId: string }> {
  const out: Record<string, { readonly text: string; readonly finderId: string }> = {};
  for (const c of candidates) {
    for (const cid of c.criteria) {
      if (out[cid] !== undefined) continue;
      const finder = findersByCriterion.get(cid);
      if (finder === undefined) continue;
      out[cid] = { text: finder.docs.reviewPrompt, finderId: finder.id };
    }
  }
  return out;
}

/**
 * Maps one cross-criterion-deduped candidate onto the `review_candidates`
 * wire shape. Extracted from the tool's main handler so the
 * per-candidate present-when-meaningful spreads (siblingOccurrences,
 * vendorPathHint, vendorContext, predicateConceded, durationLiteralMs,
 * durationExpression, sourceCount, dismissalKey) live in one place rather
 * than inflating the handler's cognitive complexity above the linter's
 * cap. `confidence` is required on every grounded candidate; `title` /
 * `level` come from the standard's criterion record (looked up via the
 * canonical `criterionId` slot) and conditional-spread when the
 * resolution succeeds.
 *
 * `criteria` is the cross-criterion union of every ID this candidate's
 * evidence covers, sorted. Omitted when length is 1 per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest" — a length-1 array next to
 * `criterionId` would be redundant noise; the field surfaces only when
 * it carries new information (the multi-criterion union). When emitted,
 * `verdict_candidate` accepts the array on the input candidate and
 * applies one verdict to all listed criteria atomically — same
 * evidence, one agent action.
 */
function mapCandidateOut(
  c: ReasonDedupedCandidate,
  standardsById: ReadonlyMap<string, Standard>,
  sources: ReadonlyMap<string, SourceEntry>,
): Record<string, unknown> {
  const standardId = c.criterionId.split(":")[0] ?? "";
  const standard = standardsById.get(standardId);
  const criterion = standard?.criteria.find((ck) => ck.id === c.criterionId);
  const snippet = candidateSnippet(c, sources);
  return {
    criterionId: c.criterionId,
    ...(c.criteria.length > 1 ? { criteria: c.criteria } : {}),
    ...(criterion?.title ? { title: criterion.title } : {}),
    ...(criterion?.level ? { level: criterion.level } : {}),
    location: c.location,
    reason: c.reason,
    confidence: c.confidence,
    ...(snippet === undefined ? {} : { snippet }),
    ...additiveEvidenceFields(c),
  };
}

/**
 * Conditional-spreads every present-when-meaningful additive evidence
 * field a candidate may carry — extracted from {@link mapCandidateOut}
 * so the per-field branches don't push the parent's cognitive
 * complexity above the lint cap as new evidence sub-fields accrete.
 * Each branch follows the canonical CLAUDE.md §1 shape: omit entirely
 * when the source value is undefined / empty so a downstream consumer
 * never has to disambiguate "absent" from "present-but-empty."
 */
function additiveEvidenceFields(c: ReasonDedupedCandidate): Record<string, unknown> {
  return {
    ...(c.siblingOccurrences !== undefined &&
      c.siblingOccurrences.length > 0 && {
        siblingOccurrences: c.siblingOccurrences,
      }),
    ...(c.vendorPathHint ? { vendorPathHint: c.vendorPathHint } : {}),
    ...(c.vendorContext === undefined ? {} : { vendorContext: c.vendorContext }),
    ...(c.predicateConceded === undefined ? {} : { predicateConceded: c.predicateConceded }),
    ...(c.durationLiteralMs === undefined ? {} : { durationLiteralMs: c.durationLiteralMs }),
    ...(c.durationExpression === undefined ? {} : { durationExpression: c.durationExpression }),
    ...(c.sourceCount !== undefined && { sourceCount: c.sourceCount }),
    ...(c.handlerFunctionName === undefined ? {} : { handlerFunctionName: c.handlerFunctionName }),
    ...(c.dismissalKey === undefined ? {} : { dismissalKey: c.dismissalKey }),
    ...(c.couldBeWrongBecause === undefined || c.couldBeWrongBecause.length === 0
      ? {}
      : { couldBeWrongBecause: [...c.couldBeWrongBecause] }),
  };
}

/**
 * Produces the `snippet` field for a single candidate: prefers the
 * finder-supplied `snippet` when present (finders sometimes know the
 * right window better than ±3 lines — e.g. a cross-file reasoner),
 * falls back to a cache-only lookup on `(filePath, line)`. Returns
 * `undefined` when no honest snippet can be built so the caller
 * conditional-spreads the field away.
 */
function candidateSnippet(
  c: { location: { filePath: string; line: number }; snippet?: string; reason: string },
  sources: ReadonlyMap<string, SourceEntry>,
): string | undefined {
  if (typeof c.snippet === "string" && c.snippet.length > 0) return c.snippet;
  const entry = sources.get(c.location.filePath);
  if (entry === undefined) return undefined;
  return buildSnippetForReason({
    source: entry.source,
    line: c.location.line,
    reason: c.reason,
    language: entry.language,
  });
}

function indexFindersByCriterion(
  session: import("./session.ts").McpSession,
): Map<string, CandidateFinder> {
  const out = new Map<string, CandidateFinder>();
  for (const finder of session.registry.finders) {
    for (const cid of finder.criterionIds) {
      if (!out.has(cid)) out.set(cid, finder);
    }
  }
  return out;
}

function isCriterionInLevel(
  criterionId: string,
  level: string,
  session: import("./session.ts").McpSession,
): boolean {
  const rank: Record<string, number> = { A: 1, AA: 2, AAA: 3 };
  for (const standard of session.registry.standards) {
    const c = standard.criteria.find((x) => x.id === criterionId);
    if (c) return (rank[c.level] ?? 0) <= (rank[level] ?? 3);
  }
  return true;
}

function isKnownCriterion(
  criterionId: string,
  session: import("./session.ts").McpSession,
): boolean {
  for (const std of session.registry.standards) {
    if (std.criteria.some((c) => c.id === criterionId)) return true;
  }
  return false;
}
