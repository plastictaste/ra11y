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
import type { CandidateFinder, ReviewCandidate } from "../types/review.ts";
import type { Standard } from "../types/standard.ts";
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
      "List tier-1 manual-review candidates with source context. Use this to drive an LLM-assisted manual review loop: iterate candidates, read the snippet, answer the prompt, report verdict. The pass/fail review prompt is deduped to `prompts[criterionId].text` at the top level — each candidate carries `criterionId`, look up the prompt there. Pair with `scan` for full coverage.",
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

    const candidates = (report.candidates ?? []).filter((c) => {
      if (filterCriterion && c.criterionId !== filterCriterion) return false;
      return isCriterionInLevel(c.criterionId, level, session);
    });

    const findersByCriterion = indexFindersByCriterion(session);
    const standardsById = new Map(session.registry.standards.map((s) => [s.id, s]));
    const sources = sourceIndex(files);

    // Build the keyed prompt map on the fly from the criterion IDs
    // actually present in the candidate list. We only emit an entry when
    // a finder exists for that criterion — omission is the honest
    // signal (see CLAUDE.md §1 "Ambiguous field shapes are dishonest")
    // rather than `{ text: "", finderId: null }`.
    const prompts: Record<string, { readonly text: string; readonly finderId: string }> = {};
    for (const c of candidates) {
      if (prompts[c.criterionId] !== undefined) continue;
      const finder = findersByCriterion.get(c.criterionId);
      if (finder === undefined) continue;
      prompts[c.criterionId] = {
        text: finder.docs.reviewPrompt,
        finderId: finder.id,
      };
    }
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
              "For each candidate: read the `snippet` + `reason`, look up `prompts[criterionId].text` for the pass/fail question, then verdict. Run the `ra11y/triage` prompt (via `prompts/get`) to batch-process all candidates in one structured pass.",
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
 * Maps one engine-emitted {@link ReviewCandidate} onto the
 * `review_candidates` wire shape. Extracted from the tool's main
 * handler so the per-candidate present-when-meaningful spreads
 * (siblingOccurrences, vendorPathHint, vendorContext, predicateConceded,
 * durationLiteralMs, durationExpression, sourceCount) live in one place rather than
 * inflating the handler's cognitive complexity above the linter's
 * cap. `confidence` is required on every grounded candidate;
 * `title` / `level` come from the standard's criterion record and
 * conditional-spread when the resolution succeeds.
 */
function mapCandidateOut(
  c: ReviewCandidate,
  standardsById: ReadonlyMap<string, Standard>,
  sources: ReadonlyMap<string, SourceEntry>,
): Record<string, unknown> {
  const standardId = c.criterionId.split(":")[0] ?? "";
  const standard = standardsById.get(standardId);
  const criterion = standard?.criteria.find((ck) => ck.id === c.criterionId);
  const snippet = candidateSnippet(c, sources);
  return {
    criterionId: c.criterionId,
    ...(criterion?.title ? { title: criterion.title } : {}),
    ...(criterion?.level ? { level: criterion.level } : {}),
    location: c.location,
    reason: c.reason,
    confidence: c.confidence,
    ...(snippet === undefined ? {} : { snippet }),
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
