/**
 * The `checklist` MCP tool. Split into its own file so src/mcp/tools.ts
 * stays under the file budget — the tool now includes element-presence
 * detection and relevance hints, which is meaningful logic to keep out
 * of the central tool-registration module.
 */

import type { ParsedFile, runScan } from "../engine/scanner.ts";
import {
  type AttestationStalenessProbe,
  type AttestationSurface,
  buildAttestationSurface,
  createGitStalenessProbe,
  indexAttestationsByCriterion,
} from "../reports/attestation-surface.ts";
import { buildCoverageReport, type PerStandardCoverage } from "../reports/coverage.ts";
import type { AttestationRecord } from "../types/evidence.ts";
import type {
  ReviewCandidate,
  ReviewCandidatePredicateConceded,
  ReviewCandidateVendorContext,
  ReviewConfidence,
} from "../types/review.ts";
import { buildAnalysisCoverage } from "./analysis-coverage.ts";
import { applyChecklistBudget } from "./checklist-budget.ts";
import { pragmaFormForExtension } from "./checklist-suppress-pragma.ts";
import { sawProjectMarkerInWalk } from "./config-search-marker.ts";
import { runScanForCrossSurfaceParity } from "./cross-surface-scan.ts";
import {
  type Applicability,
  detectApplicability,
  irrelevanceReason,
  isLikelyIrrelevant,
} from "./manual-applicability.ts";
import { tallyManualCriteriaFromCoverage } from "./manual-criteria-tally.ts";
import { applyMetaCacheMode, metaModeSchema } from "./meta-cache.ts";
import { candidateHedges } from "./review-candidate-priority.ts";
import { buildRulesEvaluated, type RulesEvaluated, resolveActiveRules } from "./rules-evaluated.ts";
import { buildScanTimeWarnings } from "./scan-time-warnings.ts";
import { type ScannedEnvelope, scannedProject } from "./scanned-envelope.ts";
import { skipCriterionSchema } from "./skip-criterion.ts";
import {
  buildSnippetForReason,
  buildTightLineSnippet,
  type SourceEntry,
  sourceIndex,
} from "./source-snippet.ts";
import { deriveTestableCriteria } from "./testable-criteria.ts";
import {
  errorResult,
  findStandard,
  firstUnknownStandard,
  loadDurableAttestations,
  type McpTool,
  parseFilesWithDiagnostics,
  resolveLevel,
  resolveStandards,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";

// `suppressWith` is built per-candidate via
// `pragmaFormForExtension(candidate.path, criterionId)` from
// `./checklist-suppress-pragma.ts`. The earlier 4-key
// `{ html, jsx, liquid, hugo }` shape shipped every dialect on
// every candidate regardless of file extension — an agent picking
// the `html` form on a `.scss` candidate would corrupt source
// because HTML-comment syntax is invalid in CSS. The single string
// keyed off the candidate's actual extension is the honest shape
// (see `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
// shapes are dishonest"): the response now advertises the one form
// that is syntactically valid for THAT file. The helper covers
// `.css` / `.scss` / `.sass` / `.less` / `.js` / `.ts` / `.mjs` /
// `.cjs` (block-comment form), `.jsx` / `.tsx` / `.mdx`
// (JSX-expression form), and `.html` / `.htm` / `.xhtml` /
// `.markdown` / `.md` / `.mkdn` / `.svg` / `.astro` / `.vue` /
// `.svelte` / `.erb` / `.liquid` (HTML-comment form).

interface ChecklistCandidateOut {
  readonly path: string;
  readonly line: number;
  readonly reason: string;
  readonly confidence: ReviewConfidence;
  readonly snippet?: string;
  /**
   * Source-level `ra11y-disable` pragma — the canonical region-form
   * spelling for THIS candidate's file extension. Scoped to the owning
   * criterion ID (or, when {@link ChecklistCandidateOut#criteria}
   * lists multiple criteria, to the first criterion — see that field's
   * note on dedup). Always present so an agent dismissing in source
   * has the ready-to-paste form without re-deriving the comment shape.
   *
   * Per-extension forms (see `pragmaFormForExtension`):
   *   - `.jsx` / `.tsx` / `.mdx` → `{/* ra11y-disable <id> *\/}`
   *   - `.css` / `.scss` / `.sass` / `.less` / `.js` / `.ts` / `.mjs` /
   *     `.cjs` → `/* ra11y-disable <id> *\/`
   *   - `.html` / `.htm` / `.xhtml` / `.markdown` / `.md` / `.mkdn` /
   *     `.svg` / `.astro` / `.vue` / `.svelte` / `.erb` / `.liquid` →
   *     `<!-- ra11y-disable <id> -->`
   *
   * The earlier 4-key `{ html, jsx, liquid, hugo }` shape shipped
   * every dialect on every candidate regardless of file extension —
   * an agent picking the `html` form on a `.scss` candidate would
   * corrupt source because HTML-comment syntax is invalid in CSS.
   * The single string keyed off the candidate's actual extension is
   * the honest shape per `docs/kb/architecture/ai-first-consumer.md`
   * "Ambiguous field shapes are dishonest" — the response now
   * advertises the one form that is syntactically valid for THAT
   * file.
   */
  readonly suppressWith: string;
  /**
   * Every criterion ID this candidate covers, sorted, when the same
   * `(path, line, reason)` evidence supports more than one criterion —
   * e.g. a `<video>` at `Home.tsx:42` that surfaces under `wcag22:1.2.1`
   * / `1.2.3` / `1.2.5`. Previously three separate item entries sharing
   * one line; now one emitted shape + `criteria: [...ids...]` so the
   * agent reads the dedup signal as a typed list rather than parsing
   * "this row also matches…" reason text. Always populated with ≥2 IDs
   * when present; omitted (present-when-meaningful per CLAUDE.md §1)
   * when the candidate is single-criterion.
   *
   * The candidate still ships on every owning item per ADR 0010's
   * cross-tool count invariant (`coverage.manualWithCandidates`-vs-
   * `checklist.items` parity is load-bearing — see
   * `tests/integration/mcp-consistency/coverage-checklist-consistency.test.ts`).
   * The `criteria: [...]` array is the agent-side dedup tool: walk the
   * group once via the array rather than re-reading the same file:line
   * under N items.
   *
   * Renamed from `criteriaIds` (2026-04-26) — the new name makes the
   * field a closer mirror of `Violation.criteria` on the rule surface
   * (same shape, same semantics) and removes the awkward singular/
   * plural mismatch between `criterionId` (the owning item's ID) and
   * the array of co-covered criteria. No alias; this is a flat rename
   * before the field had downstream consumers outside the MCP response.
   */
  readonly criteria?: readonly string[];
  /**
   * Structured vendor-path-shape evidence passed through from the
   * finder (see `ReviewCandidate.vendorPathHint`). True when the cited
   * file's basename matches a canonical vendor library bundle name or
   * looks like minified machine output. Present-when-meaningful —
   * omitted when the file is an ordinary authored source.
   */
  readonly vendorPathHint?: boolean;
  /**
   * Sibling structured payload to `vendorPathHint` — carries the
   * vendor-path-shape evidence as a discriminated `signal` plus a
   * stable `redirectTo: "consumer-override"` enum the agent reads
   * to learn the dismissal direction. Drives the per-item priority
   * downgrade in `priorityFor()`: when every grounded candidate
   * carries `vendorContext`, the item priority drops from `"high"`
   * to `"medium"` so the attention budget matches the framing the
   * candidate already concedes (a `reason` containing "minified
   * file — match at byte col …" cannot honestly ride at the same
   * priority as a candidate pointing at hand-authored source).
   *
   * Mirrors the `vendorContext` field on the `suggest_fix` surface
   * (`src/mcp/suggest-fix-vendor-context.ts`) — same `redirectTo`
   * enum, same dismissal direction — so the agent reads the same
   * recommendation across the manual-review and apply-fix lanes.
   * Present-when-meaningful per CLAUDE.md §1.
   */
  readonly vendorContext?: ReviewCandidateVendorContext;
  /**
   * Structured additive evidence that the candidate's own static
   * input concedes the WCAG 1.4.5 logotype exemption — `<img>` whose
   * alt text, class name, or src filename contains `logo` /
   * `logotype` / `brand` / `trademark`. Drives the priority
   * downgrade in `priorityFor()`: when every grounded candidate
   * carries `predicateConceded`, the item priority drops from
   * `"high"` to `"medium"` so the budget signal matches the framing
   * the candidate already concedes. Mirrors `vendorContext` —
   * present-when-meaningful per CLAUDE.md §1, surfaces verbatim from
   * the finder, and never gates suppression.
   */
  readonly predicateConceded?: ReviewCandidatePredicateConceded;
  /**
   * Structured duration evidence for timing-related candidates (see
   * `ReviewCandidate.durationLiteralMs`). Populated only when the
   * duration argument is a numeric literal; non-literal expressions
   * surface on the sibling `durationExpression` field. Omitted when
   * the candidate has no duration to report.
   */
  readonly durationLiteralMs?: number;
  /**
   * Verbatim non-literal duration expression for timing-related
   * candidates (see `ReviewCandidate.durationExpression`). Sibling to
   * `durationLiteralMs`: exactly one is populated when the call has
   * a duration argument; both omitted otherwise.
   */
  readonly durationExpression?: string;
  /**
   * Per-sibling trail for an aggregated/deduped candidate — present
   * when the finder collapsed ≥2 same-shape siblings or ≥2 same-stem
   * candidates into this consolidated entry. Omitted on singletons.
   */
  readonly siblingOccurrences?: readonly {
    readonly line: number;
    readonly alt?: string;
    readonly href?: string;
  }[];
  /**
   * Number of source occurrences this candidate represents — present
   * when stem-dedup collapsed ≥2 candidates whose accessible names
   * share a pattern stem. Omitted on singletons per CLAUDE.md §1.
   */
  readonly sourceCount?: number;
  /**
   * Identifier name passed through from the finder (see
   * `ReviewCandidate.handlerFunctionName`). Populated when the
   * candidate's handler resolves to a named function reference / call
   * the agent can grep for in surrounding source. Omitted when the
   * handler is an inline arrow / function expression (its body is
   * already captured in the candidate's reason / source). Same
   * present-when-meaningful semantics as the review-candidates
   * surface so a checklist consumer that filters by criterion does
   * not have to re-call review_candidates to recover the symbol.
   */
  readonly handlerFunctionName?: string;
  /**
   * Stable content-addressable fingerprint of the candidate's emission
   * shape passed through from the finder (see
   * `ReviewCandidate.dismissalKey`). When the same templated emission
   * shape fans out across many routes, every candidate carries the same
   * key so a checklist consumer can record ONE verdict via `attest` and
   * apply it to every matching sibling. Workflow scaffolding —
   * strictly additive, never gates suppression. Omitted on candidates
   * whose finder does not populate the field.
   */
  readonly dismissalKey?: string;
}

type ChecklistPriority = "high" | "medium" | "low";

interface WcagPrinciple {
  readonly number: 1 | 2 | 3 | 4;
  readonly name: "Perceivable" | "Operable" | "Understandable" | "Robust";
}

interface ChecklistItemOut {
  readonly criterionId: string;
  readonly title: string;
  readonly level: string;
  readonly priority: ChecklistPriority;
  /**
   * Item-level confidence. When the criterion is grounded in at
   * least one finder-emitted candidate, this is the highest
   * confidence across those candidates (a single "high" hit is the
   * signal that sizes the item even if other hits are "low"). When
   * no finder grounded the criterion (a bare-criterion pure WCAG
   * prompt), this is "low" — by definition there is no specific
   * evidence at the criterion level. Same enum/semantics as the
   * per-candidate `confidence`.
   */
  readonly confidence: ReviewConfidence;
  readonly principle?: WcagPrinciple;
  readonly candidates: readonly ChecklistCandidateOut[];
  readonly likelyRelevant?: false;
  readonly relevanceReason?: string;
  /**
   * The most recent durable attestation that speaks to this criterion,
   * when one exists. Surfaced — not suppressive — so the agent sees
   * verdicted + stale entries alongside un-attested ones and decides
   * whether to trust the claim or re-verify.
   *
   * `stale: true` appears when the attestation's stamp commit differs
   * from HEAD AND at least one file in the attestation's scope has
   * changed since the stamp. Omitted when not stale or when the git
   * probe can't answer (not a repo, git unavailable) — honest shape
   * per CLAUDE.md §1.
   *
   * Verdict passes through verbatim; records without an explicit
   * verdict surface as `"pending"` so the agent can distinguish an
   * un-asserted claim from a committed pass/fail/n/a.
   */
  readonly attestation?: AttestationSurface;
}

const CONFIDENCE_RANK: Readonly<Record<ReviewConfidence, number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

function highestConfidence(
  candidates: readonly { readonly confidence: ReviewConfidence }[],
): ReviewConfidence | null {
  let best: ReviewConfidence | null = null;
  for (const c of candidates) {
    if (best === null || CONFIDENCE_RANK[c.confidence] > CONFIDENCE_RANK[best]) {
      best = c.confidence;
    }
  }
  return best;
}

/**
 * Derives the top-level WCAG principle (1. Perceivable, 2. Operable,
 * 3. Understandable, 4. Robust) from a criterion's standard+localId.
 * Deterministic, spec-defined data — the first digit of a WCAG localId
 * IS the principle number. Returns null for non-WCAG standards
 * (Section 508, EN 301 549, etc.) whose IDs don't share the shape.
 */
function wcagPrincipleFor(standardId: string, localId: string): WcagPrinciple | null {
  if (!standardId.startsWith("wcag")) return null;
  const first = localId.split(".")[0];
  if (first === "1") return { number: 1, name: "Perceivable" };
  if (first === "2") return { number: 2, name: "Operable" };
  if (first === "3") return { number: 3, name: "Understandable" };
  if (first === "4") return { number: 4, name: "Robust" };
  return null;
}

/**
 * Priority bucket biased toward actionability. A checklist item with
 * concrete candidate locations is something a reviewer can work from
 * in the next minute; an item with no candidates is a pure WCAG
 * reminder the reviewer already has from reading the spec. We rank by
 * candidates first, level second, so the output doesn't drown real
 * finds in a sea of criterion titles.
 *
 * Hedging-aware downgrade: when every grounded candidate's reason text
 * concedes the predicate may not apply (e.g. "if this is a standalone
 * single-page file or SPA, the criterion may not apply", "flashing
 * only if iteration-count is set to..."), the item is not actually a
 * "do this in the next minute" item — the agent has to verify the
 * applicability question first. Per ai-first-consumer.md "Reason /
 * priority / fix-description must agree across all three channels",
 * the priority must not contradict the reason. Downgrade to "medium"
 * so the budget signal matches the framing the candidate already
 * carries. Mirrors the conceded-uncertainty branch of "Reason text and
 * severity must agree" on the rule surface.
 *
 * Vendor-context downgrade: when every grounded candidate carries a
 * `vendorContext` payload (the cited file matches a vendor-bundle
 * basename or a minified-shape predicate — see
 * `buildVendorContext` in `src/review/finders/timing.ts`), the item
 * is not work the page author can act on in their own source. The
 * dismissal direction is "override the failing concern in your own
 * code" rather than "edit the vendor file." Same doctrine line as
 * the hedging branch — the priority signal must agree with the
 * `vendorContext.redirectTo` framing the candidate already carries.
 * Drop to "medium" so the attention budget matches.
 */
function priorityFor(
  level: string,
  candidates: readonly {
    readonly reason: string;
    readonly vendorContext?: ReviewCandidateVendorContext;
    readonly predicateConceded?: ReviewCandidatePredicateConceded;
  }[],
): ChecklistPriority {
  if (candidates.length === 0) return "low";
  const base: ChecklistPriority = level === "A" || level === "AA" ? "high" : "medium";
  if (base !== "high") return base;
  if (everyCandidateHedges(candidates)) return "medium";
  if (everyCandidateHasVendorContext(candidates)) return "medium";
  if (everyCandidateHasPredicateConceded(candidates)) return "medium";
  return "high";
}

/**
 * True when every grounded candidate carries a `predicateConceded`
 * payload — i.e. every candidate's own static evidence (alt text,
 * class name, src filename) concedes the WCAG 1.4.5 logotype
 * exemption may apply. The all-or-nothing test mirrors
 * `everyCandidateHasVendorContext` and `everyCandidateHedges`: a
 * single candidate without the exemption-shaped evidence keeps the
 * item at `"high"` so the agent doesn't miss the actionable case
 * among the logotype-pathed siblings.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Reason / priority /
 * fix-description must agree across all three channels": a candidate
 * whose evidence concedes the predicate may be satisfied cannot ride
 * at the same attention budget as a candidate pointing at hand-
 * authored source whose static evidence does not name the exemption.
 * The candidate still surfaces (the spec exemption is a verification
 * question only the agent can answer with file context), just at a
 * priority that matches the framing.
 */
function everyCandidateHasPredicateConceded(
  candidates: readonly { readonly predicateConceded?: ReviewCandidatePredicateConceded }[],
): boolean {
  for (const c of candidates) {
    if (c.predicateConceded === undefined) return false;
  }
  return true;
}

/**
 * True when every grounded candidate carries a `vendorContext`
 * payload — i.e. every cited file matches one of the finder's
 * vendor-path-shape predicates. The all-or-nothing test mirrors
 * `everyCandidateHedges`: a single hand-authored sibling on the same
 * criterion keeps the item at `"high"` so the agent doesn't miss the
 * actionable case among the vendor-pathed siblings.
 */
function everyCandidateHasVendorContext(
  candidates: readonly { readonly vendorContext?: ReviewCandidateVendorContext }[],
): boolean {
  for (const c of candidates) {
    if (c.vendorContext === undefined) return false;
  }
  return true;
}

/**
 * Hedging-token check for the per-item rollup. Delegates to the
 * shared {@link candidateHedges} predicate so the per-item gate
 * here and the per-candidate priority resolver in
 * `review-candidate-priority.ts` test the same self-conceding
 * framings — keeping the two surfaces aligned per the doctrine
 * line "Per-tool review-candidate shape must agree across surfaces."
 */
function everyCandidateHedges(candidates: readonly { readonly reason: string }[]): boolean {
  for (const c of candidates) {
    if (!candidateHedges(c)) return false;
  }
  return true;
}

/**
 * validates the bounded
 * pagination params before the handler does any work. Negative
 * (and zero) values are clearly-invalid caller bugs that the
 * pre-existing silent clamp would mask — `limit: -1` was being
 * coerced to 1, returning a paginated-to-one-entry response that
 * looked like a successful narrow scan rather than the validation
 * error the caller's input deserves. Per CLAUDE.md §1 / `ai-first-
 * consumer.md` "ambiguous field shapes are dishonest": silent
 * coercion on invalid input reads as success-with-data when the
 * input never described real work. Reject with the structured
 * `invalid-param` envelope so the agent can branch on `code` +
 * `details.field` and re-issue with a sane bound.
 *
 * Upper-bound behavior is unchanged: `limit > 2000` still silently
 * clamps to 2000 (the existing pattern; callers paginate via
 * `nextOffset`), and `maxCandidatesPerCriterion > 100` still clamps
 * to 100 with a paired `max_candidates_per_criterion_clamped`
 * warning narrated through `detectPerCriterionClamp` below. Only
 * the `< 1` rail is converted from silent clamp to hard reject —
 * that's the side where the caller is asking for "no work" and
 * a one-row response is actively misleading.
 */
function validateChecklistBounds(
  params: Record<string, unknown>,
): { readonly code: "invalid-param"; readonly field: string; readonly value: number } | undefined {
  const rawLimit = params["limit"];
  if (typeof rawLimit === "number" && Number.isFinite(rawLimit) && Math.floor(rawLimit) < 1) {
    return { code: "invalid-param", field: "limit", value: rawLimit };
  }
  const rawPerCriterion = params["maxCandidatesPerCriterion"];
  if (
    typeof rawPerCriterion === "number" &&
    Number.isFinite(rawPerCriterion) &&
    Math.floor(rawPerCriterion) < 1
  ) {
    return { code: "invalid-param", field: "maxCandidatesPerCriterion", value: rawPerCriterion };
  }
  return undefined;
}

/**
 * detects whether
 * the caller-supplied `maxCandidatesPerCriterion` was clamped by the
 * [1, 100] bounds so the handler can narrate it via a structured
 * `warnings: ["max_candidates_per_criterion_clamped"]` + paired
 * `warningsDetails.max_candidates_per_criterion_clamped: { requested,
 * applied }` payload. Silent clamps are the canonical "ambiguous
 * field shapes are dishonest" failure mode — a caller asking for 500
 * and getting back 100 with no signal.
 *
 * Returns `undefined` when the caller omitted the param or passed a
 * non-numeric value (fall back to default, no clamp to narrate) or
 * when the floor of the caller's value equals the applied value (the
 * clamp was a no-op). Extracted to a helper to keep the handler's
 * cognitive complexity under the lint ceiling.
 */
function detectPerCriterionClamp(
  params: Record<string, unknown>,
  applied: number,
): { readonly requested: number; readonly applied: number } | undefined {
  const raw = params["maxCandidatesPerCriterion"];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const requested = Math.floor(raw);
  if (requested === applied) return undefined;
  return { requested, applied };
}

/**
 * Builds the structured `summary.actionable` shape from the cross-tool
 * canonical criteria tally and the paginated checklist page. Three
 * counts: `criteria` (cross-tool canonical, matches
 * `scan_project.plan.actionableManualItems`), `candidatesUncapped`
 * (pre-clip inventory; matches the response-level `totalCandidates`),
 * and `candidatesReturned` (post-clip page count). Extracted to a
 * helper so the main handler stays under the lint's cognitive-
 * complexity ceiling — the per-item summing loop counts as branching.
 */
function buildChecklistSummaryActionable(
  criteriaCount: number,
  page: PaginatedChecklist,
): {
  readonly criteria: number;
  readonly candidatesUncapped: number;
  readonly candidatesReturned: number;
} {
  let candidatesReturned = 0;
  for (const item of page.items) candidatesReturned += item.candidates.length;
  return {
    criteria: criteriaCount,
    candidatesUncapped: page.totalCandidates,
    candidatesReturned,
  };
}

/**
 * Cross-surface count invariant: `summary.actionable.criteria` and
 * `summary.untargetedCriteria` are derived from the shared
 * `tallyManualCriteriaFromCoverage` helper — the same algorithm
 * `scan_project` and `coverage` use over identical inputs. Extracted
 * to a helper so the handler stays under the lint's cognitive-
 * complexity ceiling and so the conditional-skip-set spread (the
 * only branch on this seam) lives next to the helper call.
 */
function computeChecklistSummaryTally(
  coverage: readonly PerStandardCoverage[],
  applicability: Applicability,
  candidates: readonly ReviewCandidate[],
  skipSet: ReadonlySet<string> | undefined,
): { readonly actionable: number; readonly untargeted: number } {
  if (skipSet === undefined) {
    return tallyManualCriteriaFromCoverage(coverage, applicability, candidates);
  }
  return tallyManualCriteriaFromCoverage(coverage, applicability, candidates, {
    skipCriteria: skipSet,
  });
}

/**
 * builds the conditional-spread
 * fragment for `untargetedCriteriaList` based on the tri-state
 * `showUntargeted` input. Default (unset) emits a bare criterion-ID
 * array (cheap enumeration for VPAT prep); `true` upgrades to full
 * items (title + level + principle + empty candidates); `false`
 * omits the list entirely as a size-pressure escape hatch. Extracted
 * to a helper to keep the handler under the lint's cognitive-
 * complexity ceiling.
 */
function buildUntargetedField(
  params: Record<string, unknown>,
  untargeted: readonly ChecklistItemOut[],
): { readonly untargetedCriteriaList?: readonly ChecklistItemOut[] | readonly string[] } {
  const raw = params["showUntargeted"];
  if (raw === true) return { untargetedCriteriaList: untargeted };
  if (raw === false) return {};
  return { untargetedCriteriaList: untargeted.map((i) => i.criterionId) };
}

export const checklistTool: McpTool = {
  def: {
    name: "checklist",
    description:
      "Get the manual review checklist — criteria that can't be fully automated. Returns `items` (criteria with concrete candidate locations — start here) and `likelyIrrelevant` (criteria the scan can tell don't apply, e.g., no <video>/<audio> for 1.2.*). The summary reports `actionable: { criteria, candidatesUncapped, candidatesReturned }` — three honest counts so a clipped/paginated response cannot read as \"N things to verify\" while N criteria carry far more elided candidates. `criteria` is the cross-tool canonical count (matches `scan_project.plan.actionableManualItems` and `coverage[].manualWithCandidates.length`); `candidatesUncapped` is the pre-clip inventory across actionable items; `candidatesReturned` counts what shipped on this page after `limit` / `maxCandidatesPerCriterion`. The summary also reports `untargetedCriteria`: the count of criteria with no candidates the finders could ground in code. By default the response ships `untargetedCriteriaList` as a bare criterion-ID array so you can enumerate those criteria without a second call; pass `showUntargeted: true` to upgrade it to full items (title + level + principle + empty candidates) when you're preparing a VPAT or running a formal audit, or `showUntargeted: false` to omit the list entirely under size pressure. Each candidate also carries `suppressWith: string` — the canonical region-form `ra11y-disable` pragma scoped to the owning criterion AND keyed off the candidate's file extension (HTML comment for .html/.md/.svg/.astro/.vue/.svelte/.erb/.liquid; CSS block comment for .css/.scss/.sass/.less/.js/.ts/.mjs/.cjs; JSX expression for .jsx/.tsx/.mdx). The earlier 4-key `{ html, jsx, liquid, hugo }` shape was replaced because shipping every dialect on every candidate let agents pick a syntactically-invalid form for the file (e.g. an HTML comment in a `.scss` source) and corrupt source. When the same `(path, line, reason)` evidence supports multiple criteria, the candidate carries `criteria: [...]` listing every covered criterion so an agent walking the group dedup-once via the array rather than re-reading the same file:line under N items.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. File or directory paths to scan. Omit for a project-wide checklist rooted at `cwd`.",
        },
        standard: { type: "string", description: "Standard ID." },
        level: { type: "string", enum: ["A", "AA", "AAA"], description: "Conformance level." },
        cwd: {
          type: "string",
          description:
            "Base directory. Used as the scan root when `paths` is omitted, and for resolving relative `paths` when given.",
        },
        showUntargeted: {
          type: "boolean",
          description:
            "Tri-state controller for `untargetedCriteriaList`. Default (unset) emits bare criterion IDs so enumeration is cheap. `true` upgrades to full items (title + level + principle + empty candidates) for VPAT drafting. `false` omits the list entirely — size-pressure escape hatch. The summary always reports `untargetedCriteria` (count) regardless.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of *candidates* (across all items) to include in the response. Defaults to 200, clamped to [1, 2000]. Caps response size for noisy criteria without silencing them — the scan still evaluates everything, and `totalCandidates` reports the pre-paging tally. When the cap truncates, the response carries `truncated: true` and `nextOffset: N`; call again with `offset: N` to page.",
        },
        offset: {
          type: "number",
          description:
            "Starting index into the flat candidates stream (items are walked in priority order; candidates concatenate across items). Defaults to 0. Pair with `limit` and the `nextOffset` from a previous truncated response.",
        },
        maxCandidatesPerCriterion: {
          type: "number",
          description:
            'Caps candidates per criterion within the returned page — orthogonal to `limit`. Defaults to 10 (sized for realistic MCP host token budgets on bulk catalogs), clamped to [1, 100]. When the caller\'s value is outside that range the response carries `warnings: ["max_candidates_per_criterion_clamped"]` + `warningsDetails.max_candidates_per_criterion_clamped: { requested, applied }` so the clamp is narrated, not silent. Prevents one noisy criterion from consuming the whole page without hiding it. When any criterion is clipped, the response carries `perCriterionClipped: true` and `maxCandidatesPerCriterionHint: N` — the smaller of (largest uncapped count, 100). Pass that value back as `maxCandidatesPerCriterion` to get a deeper cut in one shot instead of paginating through `nextCursor`. `totalCandidates` reports the pre-clip tally so the agent sees what was elided.',
        },
        cursor: {
          type: "object",
          description:
            "Resume-token for per-criterion elision. When a previous call emitted `nextCursor`, pass it back verbatim to continue past the per-criterion cap on that criterion. Opaque shape (`{ afterCriterion: string, afterCandidateIndex: number }`) that MUST NOT be synthesized by the caller — the tool's ranker owns item ordering, so a hand-crafted cursor would silently skip or double-read candidates. When `cursor` is set, `offset` is ignored (cursor resumes at a named criterion's candidate index, which doesn't map to a flat-stream offset).",
          properties: {
            afterCriterion: {
              type: "string",
              description: "Criterion ID to resume inside (e.g. `wcag22:2.4.5`).",
            },
            afterCandidateIndex: {
              type: "number",
              description:
                "Zero-based index into that criterion's pre-clip candidates. Resume emits candidates starting at `afterCandidateIndex + 1`.",
            },
          },
          required: ["afterCriterion", "afterCandidateIndex"],
        },
        skipCriterion: skipCriterionSchema,
        metaMode: metaModeSchema,
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    // reject clearly-invalid
    // pagination inputs (`limit < 1`, `maxCandidatesPerCriterion < 1`)
    // up front, before any I/O. The previous silent clamp would coerce
    // `limit: -1` to 1 and return a paginated-to-one-entry response —
    // success-shaped output for input that never described real work.
    // See `validateChecklistBounds` above for the rationale; upper-
    // bound clamps stay silent (limit) / warning-narrated
    // (maxCandidatesPerCriterion) per the existing pattern.
    const boundsError = validateChecklistBounds(params);
    if (boundsError !== undefined) {
      return errorResult({
        code: boundsError.code,
        message: `\`${boundsError.field}\` must be >= 1, got ${boundsError.value}.`,
        details: { field: boundsError.field, value: boundsError.value },
        remediation:
          boundsError.field === "limit"
            ? "limit must be in [1, 2000]."
            : "maxCandidatesPerCriterion must be in [1, 100].",
      });
    }
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
    const level = resolveLevel(strParam(params, "level"), session);
    const projectConfig = await session.loadProjectConfig(cwd);
    // switch to the
    // diagnostics-aware parse entrypoint so the same
    // `skippedByExtension` map `coverage` feeds into its warnings
    // channel is available here too. Without this, `checklist` and
    // `coverage` run on identical inputs but emit different warning
    // shapes (coverage surfaces `text_source_skipped` /
    // `binary_assets_skipped` + paired `warningsDetails`, checklist
    // silently drops both) —
    // the canonical cross-surface drift the AI-first doctrine flags
    // in `ai-first-consumer.md` §"One tool call should answer 'what
    // next?'". Details are computed downstream from `analysisCoverage`.
    const {
      files,
      diagnostics: discoveryDiagnostics,
      jsInnerHtmlDeclinedCount,
      jsInnerHtmlPatternSamples,
    } = await parseFilesWithDiagnostics(paths, session, cwd);
    const attestations = await loadDurableAttestations(cwd);

    // Q-SHARED-RULES-EVALUATED-SSOT: load project config and route
    // through the single resolveActiveRules helper so `meta.rulesEvaluated`
    // agrees with scan_project / propose_config on the same cwd.
    // Previously used `session.config.rules` alone, silently ignoring
    // any rule overrides in the user's `ra11y.config.ts`.
    // (`list_suppressions` no longer emits `rulesEvaluated` — that tool
    // runs zero rules, so the field would lie; see
    //.)
    const activeRules = resolveActiveRules(session, projectConfig);
    // route the scan through the
    // shared cross-surface helper so `nativeWrapperElements` and
    // `processes` are threaded onto {@link runScan} with the same
    // presence rules `scan_project` uses. Without this, a real-corpus
    // scan with `nativeWrappers` configured (or `processes` declared)
    // produced different `result.violations` than `scan_project`'s on
    // the same cwd, and the `outputFilePathSet` derivation silently
    // drifted — feeding mismatched `findingFilePaths` into the
    // `parseErrorFiles` vs `partialParseFiles` bucket assembler. Per
    // `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
    // invariant" the per-bucket axis must agree on identical input,
    // not just the totals.
    const { result, report, perRuleCoverage, filesWithAnyRuleEvaluated, outputFilePaths } =
      runScanForCrossSurfaceParity({
        files,
        session,
        enabled: standards,
        level,
        activeRules,
        attestations,
        projectConfig,
      });

    // thread testableCriteria so the
    // `clean` / `untestable` counters surfaced on
    // `summary.automatedCoverage` use the honest split `coverage`
    // emits (clean = ran + zero findings; untestable = rule declared
    // extension eligibility but saw zero applicable input). The
    // previous lone `automatedCriteriaPassRate` headline conflated
    // "rule ran clean" with "rule never had eligible inputs" with
    // "rule found violations" into one composite — dishonest per
    // `ai-first-consumer.md` §"Composite headline counts are
    // dishonest." Splitting into two non-overlapping counters lets the
    // agent decide; there is no single rate that's honest.
    const testableCriteria = deriveTestableCriteria(
      activeRules,
      perRuleCoverage,
      session.registry.criteria,
    );
    const coverage = buildCoverageReport(result, session.registry.standards, level, undefined, {
      testableCriteria,
    });
    const applicability = detectApplicability(files, discoveryDiagnostics);

    const sources = sourceIndex(files);
    const attestationsByCriterion = indexAttestationsByCriterion(attestations);
    // Probe the git state once per scan — the closure caches per-stamp
    // resolution so every criterion sharing an `attestedAt` pays a
    // single git call across the whole checklist pass. `undefined`
    // signals "not inside a repo, staleness indeterminate" — the
    // per-item builder then omits `stale` across the board, which is
    // honest rather than guessing.
    const stalenessProbe = createGitStalenessProbe(cwd);
    const reportCandidates = report.candidates ?? [];
    const { needsReview, likelyIrrelevant } = bucketChecklistItems(
      coverage,
      reportCandidates,
      applicability,
      sources,
      attestationsByCriterion,
      stalenessProbe,
      session,
    );
    // Actionable items (concrete candidates) stay in `items`; criteria
    // the finders couldn't ground in code move to `untargeted`. Keeping
    // them in separate fields prevents 18 bare WCAG titles from burying
    // 3 real finds, which was the dominant feedback after the first
    // priority pass. Agents that still want the full list can compose
    // [...items, ...untargeted].
    const skipCriterion = strArrayParam(params, "skipCriterion");
    const skipSet = skipCriterion && skipCriterion.length > 0 ? new Set(skipCriterion) : undefined;
    const keep = (i: { criterionId: string }) =>
      skipSet === undefined || !skipSet.has(i.criterionId);
    // annotate candidates whose
    // (file, line, reason) surfaces under ≥2 items with `criteria:
    // [...]` so an agent walking a shared candidate reads one entry
    // per location and knows which criteria it covers. Items stay
    // per-criterion (ADR 0010 cross-tool invariant) — the annotation
    // is the dedup signal the agent consumes.
    const annotatedNeedsReview = annotateSharedCandidates(needsReview);
    const actionable = annotatedNeedsReview.filter((i) => i.candidates.length > 0 && keep(i));
    const untargeted = annotatedNeedsReview.filter((i) => i.candidates.length === 0 && keep(i));
    const filteredIrrelevant = likelyIrrelevant.filter(keep);
    // pagination over the candidate stream. The
    // scan still evaluates every criterion — this caps response size
    // so a noisy finder (say, 200 ambiguous focus-order candidates in
    // a big React tree) can't dominate the agent's token budget. Two
    // orthogonal axes:
    //   - maxCandidatesPerCriterion clips per-criterion, so one loud
    //     criterion can't crowd out quieter ones in the same page.
    //   - limit/offset paginate the flattened candidates stream across
    //     all items.
    // Honest-shape (CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest"): `truncated`/`nextOffset` are spread only when the
    // global limit actually clips; `perCriterionClipped` is spread
    // only when per-criterion clipping actually happened. Consumers
    // branch on presence, not on a sentinel false/0.
    const pageParams = readChecklistPageParams(params);
    const page = paginateChecklistItems(actionable, pageParams);
    const perCriterionClamp = detectPerCriterionClamp(params, pageParams.maxCandidatesPerCriterion);
    // The previous `summary.byPriority: { high, medium, low }` was
    // degenerate — `priorityFor()` returns `"high"` for every A/AA
    // criterion, so the field shipped `{ high: N, medium: 0, low: 0 }`
    // on every corpus. The confidence axis carries the honest per-
    // item signal (an item's `confidence` is the highest-ranked
    // candidate confidence, `"low"` for bare-criterion items). The
    // byPriority composite is dropped per-
    // DEGENERATE; dishonest-counter doctrine (CLAUDE.md §1) applies.
    // The previous `manualReviewRequired = actionable + untargeted`
    // headline summed two categorically different work kinds (grounded
    // file:line candidates vs. bare-criterion WCAG prompts) into a
    // single number that inflated the agent's work budget. Per CLAUDE.md §1
    // "Composite headline counts are dishonest" (ai-first-consumer.md
    // cites this as the canonical example), the field is removed;
    // callers read `actionable` and `untargetedCriteria` separately
    // and never sum them into one headline. The cross-tool invariant
    // test now re-derives the total from the split parts on the fly.
    // ADR 0010 + —
    // `checklist.summary.automatedCoverage` is now a structured split:
    // `{ standardId, criteriaWithRulesAllClean,
    // criteriaWithoutEligibleInputs }`. The previous lone
    // `automatedCriteriaPassRate` scalar bundled "rule fired clean"
    // (clean), "rule found violations" (withFindings), and "rule never
    // had eligible inputs" (untestable) into one ratio — composite
    // headline dishonesty per `ai-first-consumer.md`. The two
    // counters here are non-overlapping concepts:
    //   - `criteriaWithRulesAllClean`: rules ran on eligible input and
    //     emitted zero findings. Maps to coverage report's `clean`.
    //   - `criteriaWithoutEligibleInputs`: rules declared extension
    //     eligibility but the scan saw no applicable input — the
    //     canonical Tailwind-pre-build / vendor-bundle shape. Maps to
    //     coverage report's `untestable`. The agent reads both and
    //     decides; never sums them into a single rate.
    // The full per-standard block (`criteriaTotalForProfile`,
    // `criteriaByLevel`, `criteriaAutomatable`,
    // `criteriaAutomatablePassing`,
    // `failingAutomatedCriteria`, `criteriaEvaluated`) stays canonical
    // in `coverage` — emitting them here would re-create the
    // "three-places-reporting-the-same-shape" drift ADR 0010 closed.
    // Single-standard path flattens to an object; multi-standard keeps
    // the array shape so `Array.isArray(automatedCoverage)` still
    // discriminates.
    const automatedCoverage =
      coverage.length === 1
        ? {
            standardId: coverage[0]?.standardId,
            criteriaWithRulesAllClean: coverage[0]?.clean,
            criteriaWithoutEligibleInputs: coverage[0]?.untestable,
          }
        : coverage.map((c) => ({
            standardId: c.standardId,
            criteriaWithRulesAllClean: c.clean,
            criteriaWithoutEligibleInputs: c.untestable,
          }));
    // Field order is load-bearing — the agent reads top-to-bottom and
    // uses the leading fields as the headline. Actionable-first puts
    // the thing the agent can work on right now above the volumetric
    // counters. The composite `manualReviewRequired` counter (formerly
    // `actionable + untargetedCriteria`) is deliberately absent — see
    // the dishonest-composite note above. The previous prose
    // `headline: "N actionable · M untargeted · K likely irrelevant"`
    // string is also gone — same shape, different layer: a leading
    // composite that consumers read first, summing categorically
    // different sub-buckets (grounded file:line work vs. bare-criterion
    // WCAG prompts vs. provably-not-applicable items) into one summary
    // line. Per CLAUDE.md §1 "Composite headline counts are dishonest"
    // (ai-first-consumer.md worked precedent — `plan.totalFindings`
    // deletion on 2026-04-24), deletion is the durable answer rather
    // than label-stretching; callers compose their own summary line
    // from the per-kind counters below if they need one.
    // Canonical count field is `untargetedCriteria` across all MCP tools.
    // scan_project uses it on `plan`; checklist matches here on `summary`;
    // coverage on its per-standard entry.
    // Previous names (`untargeted` count, `manualUntargetedCount`) are
    // removed — a minor shape break, called out in CHANGELOG so a
    // single grep surfaces the migration.
    //
    // Cross-surface count invariant: `actionable` and `untargetedCriteria`
    // are derived from the shared `tallyManualCriteriaFromCoverage` helper
    // — the same algorithm `scan_project` and `coverage` use over
    // identical `coverage[].manualCriteria` + `applicability` +
    // `candidates` inputs. Computing them off `needsReview.length` (the
    // pre-helper recipe) silently drifted on real corpora when the
    // bucket-iteration order, the shared-candidate dedup pass, or
    // the `findStandard` lookup diverged from the helper's set
    // semantics. The helper subtracts caller `skipCriterion` so the
    // counts match the items the response surfaces.
    const summaryTally = computeChecklistSummaryTally(
      coverage,
      applicability,
      reportCandidates,
      skipSet,
    );
    // Q-doctrine (composite headline counts are dishonest, ai-first-consumer.md):
    // the prior `summary.actionable: number` headline counted *criteria* with
    // grounded candidates. When `perCriterionClipped` (or even just a deep page)
    // elides candidates per criterion, an agent reading "actionable: 2" reads
    // it as "2 things to verify" — but each criterion may carry 10+ candidates
    // beyond the cap. The structured shape splits the headline into the three
    // honest counts (criteria / candidatesUncapped / candidatesReturned) so the
    // agent can budget against the right axis. Always-split is preferred over
    // asymmetric clipped-vs-unclipped per the dispatch — keeps callers from
    // branching on shape. Cross-surface invariant:
    // `scan_file.plan.actionableManualItems` === `summary.actionable.criteria`.
    const summaryActionable = buildChecklistSummaryActionable(summaryTally.actionable, page);
    const summary = {
      actionable: summaryActionable,
      untargetedCriteria: summaryTally.untargeted,
      // One-line gloss: untargeted count is cryptic on its own — the
      // agent's read-order goes summary → items, so the definition
      // belongs here, not buried in the tool docstring.
      untargetedCriteriaMeaning:
        "manual-review criteria whose candidate finder could not ground them in code. By default `untargetedCriteriaList` ships as a bare criterion-ID array; pass `showUntargeted: true` for full items (title + level + principle + empty candidates), or `showUntargeted: false` to omit the list entirely under size pressure.",
      likelyIrrelevant: filteredIrrelevant.length,
      automatedCoverage,
      ...(skipSet === undefined ? {} : { skippedByCaller: [...skipSet].sort() }),
    };

    const untargetedField = buildUntargetedField(params, untargeted);
    // ADR 0010 cross-pointing: the `checklist` tool answers "what
    // should I manually review next, and where?" — its `nextStep`
    // routes callers onward to the matching companion surface:
    //   - actionable.length === 0 → `coverage` (compliance dashboard
    //     is the honest next question when there are no grounded
    //     candidates to iterate);
    //   - truncated pages → `checklist` with `offset: nextOffset`
    //     (keep paging through the same workflow queue);
    //   - otherwise (actionable items, no truncation) → `scan_project`
    //     closed-form; prose also names `attest` as the verdict-
    //     recording step after per-item investigation.
    // Conditional-spread discipline (CLAUDE.md §1): `nextStep` +
    // `nextStepStructured` ship together or not at all.
    const checklistNextStep = buildChecklistNextStep({
      actionableLen: actionable.length,
      truncated: page.paginationFields.truncated === true,
      nextOffset: page.paginationFields.nextOffset,
      nextCursor: page.paginationFields.nextCursor,
      maxCandidatesPerCriterionHint: page.paginationFields.maxCandidatesPerCriterionHint,
      totalCandidates: page.totalCandidates,
      limit: pageParams.limit,
      cwd,
      standard: strParam(params, "standard"),
      level: strParam(params, "level"),
    });
    // Doctrine (CLAUDE.md §1 "Zero-output success is ambiguous failure"):
    // a `checklist` response shaped like `{ items: [], untargetedCriteria: 0 }`
    // is indistinguishable from "tool never ran" unless we surface the
    // honest "scanned_zero_files" code on a real-but-empty scan root.
    // checklist has no root-resolution step (it takes `paths` directly,
    // defaulting to `[cwd]`), mirroring `scan`; pass `rootSource: null`.
    // Config resolution isn't part of this handler, so `configSource:
    // undefined` suppresses `no_config_found`.
    //
    // `analysisCoverage` +
    // `filesByExtension` flow through the same `buildAnalysisCoverage`
    // / `countFilesByExtension` helpers `coverage` uses, so
    // cross-surface consumers see the same warning codes + paired
    // `warningsDetails` shapes on identical inputs. Without the flow
    // here, `scan_project`/`coverage` would surface
    // `text_source_skipped` / `binary_assets_skipped` + their
    // structured payloads while `checklist` silently dropped both —
    // the AI-first doctrine's
    // "cross-surface drift forces wasted round trips" footgun.
    //
    // `meta` is opt-in per metaMode — legacy callers (no metaMode)
    // never saw a `meta` block on this tool, and additive surface
    // creep is avoided by only emitting under `metaMode: "delta"` so
    // the session meta-cache has something to collapse on repeat
    // calls (CLAUDE.md §1 "Verbose meta is signal, not clutter" — the
    // telemetry we DO ship under delta mode is scan-confidence data
    // the agent uses to cross-check parity with the scan-family
    // tools, not trimmed for terseness).
    const analysisCoverageField = buildAnalysisCoverage(
      files,
      session.config.nativeWrappers,
      activeRules,
      false,
      0,
      undefined,
      discoveryDiagnostics,
      // Parse-error split by same rule as the scan surfaces: files
      // that produced at least one violation OR review candidate land
      // in `partialParseFiles` (output present, recall degraded); files
      // whose parser errored without emitting anything stay in
      // `parseErrorFiles` (invisible to rules and finders alike). The
      // candidate union is load-bearing per-
      // MIXED-SIGNAL — a source-text finder (e.g. `review/timing`
      // regex-scanning `ctx.source` even when the AST parse failed) can
      // surface grounded candidates from a file that produced zero
      // rule violations; without the union those files would mis-bucket
      // as `invisible-to-rules` while live candidates reach the caller.
      // Threaded from the shared cross-surface scan helper so the
      // per-bucket assignment agrees with `scan_project` on identical
      // input — not just the totals.
      outputFilePaths,
    );
    const filesByExtension = countFilesByExtension(files);
    // emit the same `scanned` envelope
    // `scan_project`/`coverage` use so an agent cross-referencing the
    // scan-family surfaces sees the same `scanned.root` pointer on
    // identical inputs. `coverage` uses `scannedProject(cwd)`
    // unconditionally (its `paths` default is `[cwd]`); mirror that
    // here so the three tools' scanned envelopes agree on the same
    // project root without splitting shapes on whether `paths` was
    // explicit.
    const scanned = scannedProject(cwd);
    // probe the walk-up range for a project
    // marker so `no_config_found` fires here on the same predicate
    // `scan_project` uses. Without this, a tiny-repo-with-a-parent-
    // package.json scan that fires the code on `scan_project` silently
    // drops it here — the cross-surface drift the AI-first doctrine
    // flags under "one tool call should answer 'what next?'". Cheap
    // read-only walk; runs once per handler invocation, and only when
    // the loader found no config (otherwise the probe result is unused).
    const configSearchSawProjectMarker =
      projectConfig.sourcePath === null ? sawProjectMarkerInWalk(cwd) : false;
    const metaField = buildChecklistMetaField({
      params,
      session,
      filesScanned: files.length,
      filesWithAnyRuleEvaluated,
      rulesEvaluated: buildRulesEvaluated({
        loadedCount: activeRules.length,
        perRuleCoverage,
      }),
      enabledStandards: standards,
      level,
      cwd,
      configSource: projectConfig.sourcePath,
      scanned,
      filesByExtension,
    });
    const warningsFragment = buildChecklistWarnings({
      files,
      analysisCoverageField,
      filesByExtension,
      violations: result.violations,
      nextCursor: page.paginationFields.nextCursor,
      ...(page.paginationFields.nextCursorClipDetails
        ? { nextCursorClipDetails: page.paginationFields.nextCursorClipDetails }
        : {}),
      configSource: projectConfig.sourcePath,
      configSearchSawProjectMarker,
      cwd,
      jsInnerHtmlDeclinedCount,
      jsInnerHtmlPatternSamples,
      ...(perCriterionClamp ? { perCriterionClamp } : {}),
    });
    const fullResponse: Record<string, unknown> = {
      summary,
      items: page.items,
      totalCandidates: page.totalCandidates,
      ...page.paginationFields,
      ...untargetedField,
      likelyIrrelevant: filteredIrrelevant,
      ...checklistNextStep,
      ...metaField,
      // Surface analysisCoverage at the top level (mirror of `coverage`)
      // so the fragment classification, parse-error file lists, and
      // opaque-component telemetry reach checklist consumers identically
      // to scan_project / coverage on the same cwd. Cross-surface drift
      // on the fragment classification was the canonical Q9 closure case
      // — checklist consumers calling first on a static-site corpus had
      // zero signal that the corpus was fragment-heavy until the agent
      // fell back to scan_project. Per
      // `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
      // invariant" — the fragment list on `checklist` must agree with
      // scan_project / coverage / scan_file on the same input.
      ...analysisCoverageField,
      ...warningsFragment,
    };
    // last-resort
    // hard-ceiling guard. After every other clip pass settled (paging,
    // per-criterion clamp, meta-array cap), the assembled response can
    // still be over the MCP host's ~25 k-token wall on bulk-vendor
    // corpora — the verbose `items[]` * `analysisCoverage` *
    // `meta.filesByExtension` envelope inflates independent of the
    // per-criterion fan. When the post-build envelope crosses the hard
    // ceiling, degrade to the minimum-honest envelope rather than
    // letting the host drop the response (which reads to the agent as
    // "tool never ran" — the canonical
    // oversize-success-is-ambiguous-failure shape per doctrine). Per
    // "Per-tool lane and warning-set classification must agree" — same
    // warning code (`response_dropped_files_oversize`) and same
    // byte-arithmetic payload as `scan_project` / `scan_file`.
    const budgeted = applyChecklistBudget({ response: fullResponse });
    return textResult(budgeted.response);
  },
};

/**
 * Assembles the `warnings` + `warningsDetails` fragment for `checklist`.
 * Routes through the shared scan-time helper
 * ({@link buildScanTimeWarnings}) so checklist's scan-time warning code
 * set is identical to `scan_project` / `coverage` on the same cwd —
 * cross-surface drift on this channel is a silent-miss failure mode per
 * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant" (warning-channel extension). Tool-local response-instance
 * codes (`results_truncated_use_nextcursor` for paginated tails,
 * `max_candidates_per_criterion_clamped` for the per-criterion clamp,
 * `response_meta_truncated` when this tool's meta-array cap fires)
 * merge on top — those originate from this tool's own envelope
 * construction and do NOT propagate.
 *
 * Extracted from the handler so the handler stays under the lint's
 * cognitive-complexity cap; the two-channel merge is narrow enough that
 * a helper keeps the handler's shape flat without obscuring intent.
 */
function buildChecklistWarnings(args: {
  readonly files: readonly ParsedFile[];
  readonly analysisCoverageField: ReturnType<typeof buildAnalysisCoverage>;
  readonly filesByExtension: Record<string, number>;
  readonly violations: ReturnType<typeof runScan>["result"]["violations"];
  readonly nextCursor: ChecklistCursor | undefined;
  /**
   * Q13-RESULTS-TRUNCATED-USE-NEXTCURSOR-EMPTY-DETAILS: paired clip
   * details for `nextCursor`. When present, drives the
   * `warningsDetails.results_truncated_use_nextcursor` payload so the
   * warning channel carries the load-bearing scalars (`criterionId`,
   * `clippedAt`, `totalAvailable`) without forcing the agent to
   * cross-reference the top-level pagination block. Always paired with
   * `nextCursor` (the call site populates both together).
   */
  readonly nextCursorClipDetails?: NonNullable<
    PaginatedChecklist["paginationFields"]["nextCursorClipDetails"]
  >;
  /**
   * the resolved `configSource` from the
   * loaded project config. Threaded through so `no_config_found` fires
   * here on the same predicate `scan_project` uses — without it the
   * code silently drops on checklist even when scan_project surfaces
   * it on the same cwd. `null` means the walk-up found nothing.
   */
  readonly configSource: string | null;
  /**
   * true when the walk-up from the scan root
   * saw a `package.json` or `ra11y.config.*` marker. Pairs with
   * `configSource === null` to gate `no_config_found` honestly — tiny
   * demo directories without a parent project root never trip the code.
   */
  readonly configSearchSawProjectMarker: boolean;
  /** Resolved scan root the loader walked from. */
  readonly cwd: string;
  /**
   * Count of innerHTML/insertAdjacentHTML/document.write template-
   * literal patterns the parser declined. Drives
   * `js_innerhtml_template_literal_unparsed` so the code fires on
   * checklist when scan_project's call on the same cwd would.
   */
  readonly jsInnerHtmlDeclinedCount: number;
  /**
   * Per-file inline-HTML pattern detector samples. Cross-referenced
   * against the post-scan finding-bearing path set inside
   * `buildScanTimeWarnings` so the warning's `fileSamples[]` payload
   * names only paths the routed parser produced zero findings on.
   */
  readonly jsInnerHtmlPatternSamples: ReadonlyMap<
    string,
    readonly { readonly path: string; readonly line: number; readonly pattern: string }[]
  >;
  readonly perCriterionClamp?: { readonly requested: number; readonly applied: number };
}): { readonly warnings?: readonly string[]; readonly warningsDetails?: unknown } {
  const scanTime = buildScanTimeWarnings({
    parsedFiles: args.files,
    violations: args.violations,
    root: args.cwd,
    configSource: args.configSource,
    configSearchSawProjectMarker: args.configSearchSawProjectMarker,
    rootSource: null,
    analysisCoverage: args.analysisCoverageField.analysisCoverage,
    filesByExtension: args.filesByExtension,
    jsInnerHtmlDeclinedCount: args.jsInnerHtmlDeclinedCount,
    jsInnerHtmlPatternSamples: args.jsInnerHtmlPatternSamples,
    // Q-SHARED-META-ARRAY-BUDGET-CAP: propagate the coverage helper's
    // truncation bit so `response_meta_truncated` fires AND the paired
    // `warningsDetails.response_meta_truncated.fields` payload names
    // the structured field elided. The coverage helper only caps
    // `analysisCoverage.fragmentFiles` on this seam (build-artifact
    // arrays don't assemble through `checklist`), so the field list
    // resolves to a single dotted path when the cap fired.
    ...(args.analysisCoverageField.metaArrayTruncated === true
      ? { metaArrayTruncatedFields: ["analysisCoverage.fragmentFiles"] }
      : {}),
  });
  const merged = new Set<string>(scanTime.warnings ?? []);
  if (args.nextCursor !== undefined) merged.add("results_truncated_use_nextcursor");
  if (args.perCriterionClamp !== undefined) {
    merged.add("max_candidates_per_criterion_clamped");
  }
  const sorted = [...merged].sort();
  // Checklist owns the `max_candidates_per_criterion_clamped` code +
  // its paired `{ requested, applied }` payload — shape is local to
  // this tool (no other surface has the same per-criterion axis), so
  // the payload is merged directly onto the derivative details rather
  // than routed through `ScanWarningDetails`. Per CLAUDE.md §1
  // "Ambiguous field shapes are dishonest": the warning code alone
  // would leave the caller unable to tell "clamped from 500 to 100"
  // from "clamped from 101 to 100."
  //
  // Q13-RESULTS-TRUNCATED-USE-NEXTCURSOR-EMPTY-DETAILS: same pattern
  // for `results_truncated_use_nextcursor` — the bare code reads as
  // "more candidates exist; pass nextCursor back" but on a multi-
  // criterion page the agent cannot tell which criterion was clipped,
  // how many of its candidates this page shows, or how many were
  // available pre-clip without re-reading the top-level
  // `paginationFields.nextCursorClipDetails`. Mirroring the scalars on
  // the warning channel closes the silent miss of "Empty
  // `warningsDetails.<code>: {}` is dishonest."
  const mergedDetails: Record<string, unknown> = {
    ...(scanTime.warningsDetails === undefined ? {} : { ...scanTime.warningsDetails }),
    ...(args.perCriterionClamp
      ? {
          max_candidates_per_criterion_clamped: {
            requested: args.perCriterionClamp.requested,
            applied: args.perCriterionClamp.applied,
          },
        }
      : {}),
    ...(args.nextCursor !== undefined && args.nextCursorClipDetails !== undefined
      ? {
          results_truncated_use_nextcursor: {
            criterionId: args.nextCursorClipDetails.criterionId,
            clippedAt: args.nextCursorClipDetails.clippedAt,
            totalAvailable: args.nextCursorClipDetails.totalAvailable,
            nextCursor: args.nextCursor,
          },
        }
      : {}),
  };
  // Warnings-details schema discipline: stamp the empty-object
  // marker for every fired code that didn't already get a rich
  // entry. Covers any `ScanWarningCode` from the derivative-scan
  // channel that arrived without a payload. Without this, an agent
  // reading the response sees a code in `warnings[]` but no key in
  // `warningsDetails` and cannot tell "no payload defined" from
  // "this surface didn't compute it." The two checklist-local codes
  // (`max_candidates_per_criterion_clamped`,
  // `results_truncated_use_nextcursor`) are payload-bearing — both
  // ship structured details above and never fall through to `{}`.
  for (const code of sorted) {
    if (mergedDetails[code] !== undefined) continue;
    mergedDetails[code] = {};
  }
  return {
    ...(sorted.length > 0 ? { warnings: sorted } : {}),
    ...(Object.keys(mergedDetails).length > 0 ? { warningsDetails: mergedDetails } : {}),
  };
}

/**
 * Tallies parseable files by extension. Mirrors the private helper in
 * {@link ./tool-coverage.ts `countFilesByExtension`} so `checklist` can
 * feed the same `filesByExtension` signal into the scan-confidence
 * warnings channel (without
 * this, `tailwind_detected_css_undercounted` would fire on `coverage`
 * and `scan_project` but silently not on `checklist` for the same
 * input set).
 */
function countFilesByExtension(files: readonly ParsedFile[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dot = f.filePath.lastIndexOf(".");
    const ext = dot === -1 ? "(no-ext)" : f.filePath.slice(dot);
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Assembles the `meta` field for `checklist`. Always emitted now
 * so an agent reading this response can
 * cross-check scan-confidence telemetry against `scan_project` without
 * a second round trip. The parity subset (configSource, scanned.root,
 * rulesEvaluated, filesByExtension) is the backlog-mandated minimum:
 * field reports showed bulk-template sites where `checklist` shipped
 * no `meta` block at all while `scan_project` on the same corpus
 * surfaced `template_files_parsed_as_literal`, `parse_errors_present`,
 * `text_source_skipped`, `source_language_unsupported` —
 * cross-surface drift the AI-first doctrine names under "one tool call
 * should answer 'what next?'" (verbose meta is scan-confidence signal,
 * not clutter).
 *
 * Under `metaMode: "delta"` the shared meta-cache helper still collapses
 * repeat calls with the same signature to a delta keyed by `sessionRef`;
 * `applyMetaCacheMode` passes through unchanged in the default full
 * mode.
 */
function buildChecklistMetaField(args: {
  readonly params: Record<string, unknown>;
  readonly session: import("./session.ts").McpSession;
  readonly filesScanned: number;
  /**
   * Threaded from {@link import("../engine/scanner.ts").ScanProducts.filesWithAnyRuleEvaluated}
   * so the file-reach split (`filesWithAnyRuleEvaluated` +
   * `filesWithZeroRuleEvaluation`) ships alongside `filesScanned` on
   * every project-rooted tool — `scan_project`, `coverage`,
   * `checklist` — for the cross-surface count invariant. See
   * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
   * invariant" + "Composite headline counts are dishonest."
   */
  readonly filesWithAnyRuleEvaluated: number;
  readonly rulesEvaluated: RulesEvaluated;
  readonly enabledStandards: readonly string[];
  readonly level: "A" | "AA" | "AAA";
  readonly cwd: string;
  readonly configSource: string | null;
  readonly scanned: ScannedEnvelope;
  readonly filesByExtension: Record<string, number>;
}): { readonly meta: Record<string, unknown> } {
  const fullMeta: Record<string, unknown> = {
    cwd: args.cwd,
    filesScanned: args.filesScanned,
    filesWithAnyRuleEvaluated: args.filesWithAnyRuleEvaluated,
    filesWithZeroRuleEvaluation: Math.max(0, args.filesScanned - args.filesWithAnyRuleEvaluated),
    scanned: args.scanned,
    configSource: args.configSource,
    rulesEvaluated: args.rulesEvaluated,
    filesByExtension: args.filesByExtension,
    standards: [...args.enabledStandards],
    level: args.level,
  };
  return {
    meta: applyMetaCacheMode({
      toolName: "checklist",
      params: args.params,
      fullMeta,
      session: args.session,
    }),
  };
}

function mapCandidates(
  criterionId: string,
  candidates: readonly ReviewCandidate[],
  sources: ReadonlyMap<string, SourceEntry>,
): ChecklistCandidateOut[] {
  return candidates
    .filter((c) => c.criterionId === criterionId)
    .map((c) => mapOneCandidate(c, criterionId, sources));
}

/**
 * Maps a single {@link ReviewCandidate} onto one row of the checklist
 * surface — the per-candidate present-when-meaningful spreads (snippet,
 * siblingOccurrences, vendorPathHint, vendorContext, predicateConceded,
 * durationLiteralMs, durationExpression, sourceCount, handlerFunctionName,
 * dismissalKey) live here so {@link mapCandidates} stays under the linter's
 * cognitive-complexity cap. All optional fields conditional-spread per
 * CLAUDE.md §1.
 */
function mapOneCandidate(
  c: ReviewCandidate,
  criterionId: string,
  sources: ReadonlyMap<string, SourceEntry>,
): ChecklistCandidateOut {
  // Prefer a finder-supplied snippet (cross-file finders sometimes
  // know the right window better than ±3 lines), else fall back to
  // a cache-only lookup. Omit the field when neither is available
  // — empty-string is a dishonest shape per CLAUDE.md §1.
  const snippet = finderOrBuiltSnippet(c, sources);
  // `confidence` passes through verbatim from the finder. See
  // CLAUDE.md §1 — this is identity-like metadata, not an
  // optional enrichment, so it is always present.
  return {
    path: c.location.filePath,
    line: c.location.line,
    reason: c.reason,
    confidence: c.confidence,
    suppressWith: pragmaFormForExtension(c.location.filePath, criterionId),
    ...(snippet === undefined ? {} : { snippet }),
    // Pass aggregated siblingOccurrences through to the checklist
    // surface so an agent paginating the checklist sees the full
    // per-sibling trail on a consolidated candidate (whether the
    // group came from same-parent aggregation or stem-dedup).
    // Present-when-meaningful per CLAUDE.md §1.
    ...(c.siblingOccurrences !== undefined &&
      c.siblingOccurrences.length > 0 && {
        siblingOccurrences: c.siblingOccurrences,
      }),
    // Structured additive evidence — vendor-path-shape boolean
    // and duration literal/non-literal sentinel. Same semantics
    // as on the review-candidates surface; surfaced here so a
    // checklist consumer that filters by criterion does not have
    // to re-call review_candidates to recover the typed fields.
    ...(c.vendorPathHint ? { vendorPathHint: c.vendorPathHint } : {}),
    ...(c.vendorContext === undefined ? {} : { vendorContext: c.vendorContext }),
    ...(c.predicateConceded === undefined ? {} : { predicateConceded: c.predicateConceded }),
    ...(c.durationLiteralMs === undefined ? {} : { durationLiteralMs: c.durationLiteralMs }),
    ...(c.durationExpression === undefined ? {} : { durationExpression: c.durationExpression }),
    // sourceCount carries through for stem-deduped candidates so
    // checklist consumers see the source occurrence count on the
    // consolidated row. Omitted on singletons.
    ...(c.sourceCount !== undefined && { sourceCount: c.sourceCount }),
    // handlerFunctionName carries through for on-input/on-focus
    // candidates whose handler resolves to a named symbol — the
    // agent's next Read targets the binding directly instead of
    // re-parsing the reason text. Omitted on inline-body handlers.
    ...(c.handlerFunctionName === undefined ? {} : { handlerFunctionName: c.handlerFunctionName }),
    // dismissalKey carries through so a checklist consumer can record
    // ONE verdict keyed on the hash and apply it to every matching
    // candidate via `attest`. Workflow scaffolding per AI-first
    // doctrine — strictly additive, never gates suppression. Omitted
    // when the emitting finder did not populate the field.
    ...(c.dismissalKey === undefined ? {} : { dismissalKey: c.dismissalKey }),
  };
}

/**
 * when a candidate's
 * `(file, line, reason)` surfaces under multiple checklist items,
 * annotate every instance with `criteria: string[]` listing every
 * criterion the same location satisfies. This is the agent's signal
 * to dedup downstream: a candidate ships on every owning item (so the
 * per-criterion shape stays intact — `items.length` matches
 * `coverage.manualWithCandidates.length` across tools), but repeated
 * reads of "same file:line under wcag22:1.2.1, then 1.2.3, then 1.2.5"
 * carry the `criteria: [1.2.1, 1.2.3, 1.2.5]` badge so the agent
 * walks the group once rather than three times.
 *
 * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": the field
 * is present-when-meaningful — omitted on single-criterion candidates
 * (an always-present length-1 array would be low-signal noise) and
 * populated with ≥2 IDs, in deterministic ranker order, when ≥2
 * criteria share the location.
 *
 * Why not collapse across items: the cross-tool invariant
 * (`checklist.items[].criterionId ≡ coverage.manualWithCandidates[].criterionId`)
 * is load-bearing — it's how
 * the two tools read as one surface per ADR 0010. Dropping secondary
 * items would silently re-classify a
 * shared-candidate criterion as untargeted on checklist while
 * coverage still counts it as grounded; that drift is the canonical
 * "cross-surface drift forces wasted round trips" failure mode the
 * AI-first doctrine warns against. Annotating every instance
 * preserves the invariant AND gives the agent the dedup tool.
 */
function annotateSharedCandidates(items: readonly ChecklistItemOut[]): ChecklistItemOut[] {
  // Map dedup-key → every criterion ID that owns this location.
  const byKey = new Map<string, string[]>();
  for (const item of items) {
    for (const c of item.candidates) {
      const key = `${c.path}\x00${c.line}\x00${c.reason}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, [item.criterionId]);
      } else if (!existing.includes(item.criterionId)) {
        existing.push(item.criterionId);
      }
    }
  }
  return items.map((item) => ({
    ...item,
    candidates: item.candidates.map((c) => {
      const key = `${c.path}\x00${c.line}\x00${c.reason}`;
      const ids = byKey.get(key);
      if (ids === undefined || ids.length <= 1) return c;
      return { ...c, criteria: [...ids].sort() };
    }),
  }));
}

function finderOrBuiltSnippet(
  c: ReviewCandidate,
  sources: ReadonlyMap<string, SourceEntry>,
): string | undefined {
  if (typeof c.snippet === "string" && c.snippet.length > 0) return c.snippet;
  const entry = sources.get(c.location.filePath);
  if (entry === undefined) return undefined;
  // Tight-snippet path: when the finder threaded the literal byte
  // offset of the matched token (regex / text-match-based finders that
  // know the exact span — `setTimeout(...)`, sensory-keyword phrases),
  // anchor the snippet on the match so the cited line and the snippet's
  // visible content describe the same evidence. Falls through to the
  // fixed-window builder when offsets are absent (AST-element finders
  // that emit at the element's source position) — preserves existing
  // behavior for finders that haven't opted into the offset shape.
  if (typeof c.matchOffset === "number" && typeof c.matchLength === "number") {
    const tight = buildTightLineSnippet(entry.source, c.matchOffset, c.matchLength);
    if (tight !== undefined) return tight;
  }
  return buildSnippetForReason({
    source: entry.source,
    line: c.location.line,
    reason: c.reason,
    language: entry.language,
  });
}

function buildChecklistItem(
  criterion: { id: string; standardId: string; localId: string; title: string; level: string },
  candidates: readonly ReviewCandidate[],
  applicability: Applicability,
  sources: ReadonlyMap<string, SourceEntry>,
  attestations: readonly AttestationRecord[],
  stalenessProbe: AttestationStalenessProbe | undefined,
): { item: ChecklistItemOut; relevant: boolean } {
  const mapped = mapCandidates(criterion.id, candidates, sources);
  const principle = wcagPrincipleFor(criterion.standardId, criterion.localId);
  // Bare-criterion items (no candidates grounded by a finder) carry
  // "low" confidence — by definition the scanner has no specific
  // evidence tying this criterion to the scanned code. Grounded
  // items take the highest confidence across their candidates, so a
  // single "high" hit sizes the item honestly even when other hits
  // are lower-signal.
  const itemConfidence: ReviewConfidence = highestConfidence(mapped) ?? "low";
  // Attestation surfacing: "surface, don't suppress" — attestations
  // appear on the item so the agent can decide whether to trust or
  // re-verify. They never filter the criterion out. `stale: true`
  // rides on this shape when the git probe detects code drift since
  // the stamp; absent when the probe can't answer. See
  // src/reports/attestation-surface.ts for the full contract.
  const attestation = buildAttestationSurface(attestations, stalenessProbe);
  const base: ChecklistItemOut = {
    criterionId: criterion.id,
    title: criterion.title,
    level: criterion.level,
    priority: priorityFor(criterion.level, mapped),
    confidence: itemConfidence,
    ...(principle === null ? {} : { principle }),
    candidates: mapped,
    ...(attestation === undefined ? {} : { attestation }),
  };
  if (!isLikelyIrrelevant(criterion.id, applicability)) return { item: base, relevant: true };
  const reason = irrelevanceReason(criterion.id, applicability);
  const item = reason
    ? { ...base, likelyRelevant: false as const, relevanceReason: reason }
    : { ...base, likelyRelevant: false as const };
  return { item, relevant: false };
}

function bucketChecklistItems(
  coverage: readonly PerStandardCoverage[],
  candidates: readonly ReviewCandidate[],
  applicability: Applicability,
  sources: ReadonlyMap<string, SourceEntry>,
  attestationsByCriterion: ReadonlyMap<string, readonly AttestationRecord[]>,
  stalenessProbe: AttestationStalenessProbe | undefined,
  session: import("./session.ts").McpSession,
): { needsReview: ChecklistItemOut[]; likelyIrrelevant: ChecklistItemOut[] } {
  const needsReview: ChecklistItemOut[] = [];
  const likelyIrrelevant: ChecklistItemOut[] = [];
  for (const entry of coverage) {
    const standard = findStandard(entry.standardId, session);
    if (!standard) continue;
    for (const criterionId of entry.manualCriteria) {
      const criterion = standard.criteria.find((c) => c.id === criterionId);
      if (!criterion) continue;
      const { item, relevant } = buildChecklistItem(
        criterion,
        candidates,
        applicability,
        sources,
        attestationsByCriterion.get(criterion.id) ?? [],
        stalenessProbe,
      );
      (relevant ? needsReview : likelyIrrelevant).push(item);
    }
  }
  const rank: Readonly<Record<ChecklistPriority, number>> = { high: 0, medium: 1, low: 2 };
  needsReview.sort((a, b) => rank[a.priority] - rank[b.priority]);
  return { needsReview, likelyIrrelevant };
}

/**
 * Default candidates-per-response cap for the `checklist` tool.
 * Chosen to mirror scan_project's default so
 * both tools paginate at the same ballpark.
 */
const CHECKLIST_DEFAULT_LIMIT = 200;
/** Minimum caller-supplied `limit`. Below this we clamp up. */
const CHECKLIST_MIN_LIMIT = 1;
/** Maximum caller-supplied `limit`. Above this we clamp down. */
const CHECKLIST_MAX_LIMIT = 2000;
/**
 * Default per-criterion candidate cap. Keeps one noisy finder from
 * dominating a single page without silencing it — the agent still
 * sees the criterion appear and `perCriterionClipped: true` flagging
 * that more evidence exists for follow-up.
 */
const CHECKLIST_DEFAULT_MAX_PER_CRITERION = 10;
/** Minimum caller-supplied `maxCandidatesPerCriterion`. */
const CHECKLIST_MIN_MAX_PER_CRITERION = 1;
/** Maximum caller-supplied `maxCandidatesPerCriterion`. */
const CHECKLIST_MAX_MAX_PER_CRITERION = 100;

/**
 * Opaque resume-token emitted when the per-criterion cap elided
 * candidates on at least one criterion AND the caller needs to fetch
 * that elided tail. Keyed by the criterion ID (the ranker-ordered
 * item) rather than a flat-stream offset so paging is stable across
 * ranker-order changes within a single criterion's pre-clip candidate
 * list. Callers pass the value back verbatim; they do not synthesize it.
 */
export interface ChecklistCursor {
  /** Criterion ID to resume at (e.g. `wcag22:2.4.5`). */
  readonly afterCriterion: string;
  /**
   * Zero-based index into the criterion's pre-clip candidates. Resume
   * yields candidates starting at `afterCandidateIndex + 1`, so a caller
   * whose previous page received candidates `[0..9]` passes
   * `afterCandidateIndex: 9`.
   */
  readonly afterCandidateIndex: number;
}

/**
 * Resolved pagination inputs for the `checklist` tool. All numeric
 * fields are clamped to their documented bounds; callers never see
 * un-clamped values.
 */
export interface ChecklistPageParams {
  /** Max candidates across the whole response, clamped to [1, 2000]. */
  readonly limit: number;
  /** Starting index into the flat candidates stream, clamped to >=0. */
  readonly offset: number;
  /** Max candidates per criterion in the page, clamped to [1, 100]. */
  readonly maxCandidatesPerCriterion: number;
  /**
   * Resume-token from a previous truncated response. When set, the
   * pager jumps to `afterCriterion` and begins its candidates at
   * `afterCandidateIndex + 1` — the flat-stream `offset` is ignored
   * because the cursor names a criterion, not a position in the
   * flattened stream. Absent when the caller is starting fresh.
   */
  readonly cursor?: ChecklistCursor;
}

/**
 * Reads `limit` / `offset` / `maxCandidatesPerCriterion` / `cursor`
 * from the MCP params with silent clamping to documented bounds.
 * Non-numeric / missing values fall back to the named defaults.
 * Malformed cursor shapes are dropped silently — honest-shape: a
 * cursor that can't be interpreted is indistinguishable from "no
 * cursor," and fabricating partial resume state would silently skip
 * candidates.
 */
export function readChecklistPageParams(params: Record<string, unknown>): ChecklistPageParams {
  const rawLimit = typeof params["limit"] === "number" ? params["limit"] : CHECKLIST_DEFAULT_LIMIT;
  const rawOffset = typeof params["offset"] === "number" ? params["offset"] : 0;
  const rawPerCriterion =
    typeof params["maxCandidatesPerCriterion"] === "number"
      ? params["maxCandidatesPerCriterion"]
      : CHECKLIST_DEFAULT_MAX_PER_CRITERION;
  const limit = Math.max(CHECKLIST_MIN_LIMIT, Math.min(CHECKLIST_MAX_LIMIT, Math.floor(rawLimit)));
  const offset = Math.max(0, Math.floor(rawOffset));
  const maxCandidatesPerCriterion = Math.max(
    CHECKLIST_MIN_MAX_PER_CRITERION,
    Math.min(CHECKLIST_MAX_MAX_PER_CRITERION, Math.floor(rawPerCriterion)),
  );
  const cursor = readCursor(params["cursor"]);
  return { limit, offset, maxCandidatesPerCriterion, ...(cursor ? { cursor } : {}) };
}

/**
 * Parses the opaque cursor param into a `ChecklistCursor`. Returns
 * `undefined` when the shape is missing or malformed — callers then
 * proceed as if no cursor were provided. We do not reject the call on
 * a malformed cursor because the field is opaque-by-design: the token
 * came from us, so invalid shapes indicate caller tampering, which
 * the ranker cannot recover from (silently skipping candidates would
 * be worse). Proceeding without resume state is the honest fallback.
 */
function readCursor(raw: unknown): ChecklistCursor | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const afterCriterion = record["afterCriterion"];
  const afterCandidateIndex = record["afterCandidateIndex"];
  if (typeof afterCriterion !== "string" || afterCriterion.length === 0) return undefined;
  if (typeof afterCandidateIndex !== "number" || afterCandidateIndex < 0) return undefined;
  return { afterCriterion, afterCandidateIndex: Math.floor(afterCandidateIndex) };
}

/**
 * Paginated checklist output: the clipped + sliced items that fit in
 * the page, the pre-paging / pre-per-criterion-clip total (so the
 * agent sees the full inventory size), and conditionally-spread
 * truncation flags.
 */
export interface PaginatedChecklist {
  /** Items in page order — candidates on each item already clipped and sliced. */
  readonly items: readonly ChecklistItemOut[];
  /**
   * Pre-paging, pre-per-criterion-clip total candidate count across
   * all actionable items. Always present so the agent knows the full
   * inventory even on page 1.
   */
  readonly totalCandidates: number;
  /**
   * Honest-shape pagination fields. `truncated: true` + `nextOffset`
   * appear together iff the global `limit` clipped the flat stream;
   * `perCriterionClipped: true` appears iff at least one criterion
   * was clipped by `maxCandidatesPerCriterion`. Orthogonal signals —
   * either, both, or neither may be present.
   *
   * When pagination is active (any page after the first, or any page
   * where `truncated` fires), the response carries `requestedLimit` +
   * `effectiveLimit` + `pageClipReason` on the SAME surface as
   * `truncated` / `nextOffset` so a caller seeing "returned < limit"
   * can distinguish the clip regimes without descending into
   * `warningsDetails`. Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE: same shape
   * and vocabulary as scan_project's paginateFiles, so cross-surface
   * consumers read the same fields on both tools.
   */
  readonly paginationFields: {
    readonly truncated?: true;
    readonly nextOffset?: number;
    readonly perCriterionClipped?: true;
    readonly requestedLimit?: number;
    readonly effectiveLimit?: number;
    readonly pageClipReason?: "end_of_results" | "per_criterion_cap";
    /**
     * Opaque resume-token emitted when at least one criterion was
     * clipped by `maxCandidatesPerCriterion` AND the caller needs to
     * fetch the elided tail. Naming the first clipped criterion is
     * sufficient: callers walking forward re-page by passing
     * `cursor: nextCursor`, at which point this pager jumps to that
     * criterion and resumes its candidates at `afterCandidateIndex + 1`.
     * Absent when nothing was clipped OR when the current page
     * already consumed every elided criterion's tail (the agent has
     * seen the full inventory).
     */
    readonly nextCursor?: ChecklistCursor;
    /**
     * Q13-RESULTS-TRUNCATED-USE-NEXTCURSOR-EMPTY-DETAILS: structured
     * per-criterion clip event paired with `nextCursor` so the
     * `warningsDetails.results_truncated_use_nextcursor` payload (and
     * any agent reading the pagination block directly) sees the
     * load-bearing scalars in one place: the criterion that was
     * clipped, how many candidates this page shows for it, and how
     * many were available pre-clip. Always populated together with
     * `nextCursor` (and absent otherwise) so the two surfaces never
     * disagree on which criterion the cursor names.
     */
    readonly nextCursorClipDetails?: {
      readonly criterionId: string;
      readonly clippedAt: number;
      readonly totalAvailable: number;
    };
    /**
     * a useful target the
     * caller can pass back as `maxCandidatesPerCriterion` when they
     * want a deeper cut in one shot instead of paginating through
     * `nextCursor`. Computed as `min(largestUncappedCount, 100)` —
     * the smaller of the noisiest criterion's pre-clip count and the
     * caller-supplied input band's ceiling. Present only when the
     * per-criterion cap actually clipped at least one criterion (no
     * suggestion to give if nothing was elided). The default lives at
     * 10 to match realistic MCP host token budgets on bulk catalogs;
     * the hint is the agent-readable bridge from the tight default to
     * the documented [1, 100] band.
     */
    readonly maxCandidatesPerCriterionHint?: number;
  };
}

/**
 * Applies the per-criterion cap, then slices the flattened candidate
 * stream by `offset` + `limit`. Items that end up with zero
 * candidates in the page are dropped — the agent sees only the
 * criteria with live evidence in this slice.
 *
 * Honest-shape: `truncated`/`nextOffset` are spread only when the
 * global cap actually clips the list (CLAUDE.md §1). Per-criterion
 * clipping is an orthogonal signal (`perCriterionClipped: true`),
 * so a page can be truncated without any criterion being clipped,
 * clipped without being truncated, both, or neither.
 *
 * `cursor`-mode: when the caller passes a previously-issued
 * `nextCursor`, the pager resumes INSIDE a single criterion — it
 * discards items before `cursor.afterCriterion`, yields the tail
 * `[afterCandidateIndex + 1 .. min(total, afterCandidateIndex + 1 +
 * maxCandidatesPerCriterion))` of that criterion, and stops. `offset`
 * is ignored in this mode. If the tail still overflows the per-
 * criterion cap, a fresh `nextCursor` is emitted so the caller can
 * re-page. This is the resume lane for the per-criterion elision —
 * the flat-stream `limit`/`offset` lane is orthogonal and unaffected.
 */
export function paginateChecklistItems(
  items: readonly ChecklistItemOut[],
  { limit, offset, maxCandidatesPerCriterion, cursor }: ChecklistPageParams,
): PaginatedChecklist {
  if (cursor !== undefined) {
    return paginateChecklistResume(items, cursor, maxCandidatesPerCriterion);
  }
  // Phase 1 — per-criterion clip. Extracted to a helper so this main
  // function stays under the lint's cognitive-complexity ceiling; the
  // helper returns the clipped item list, the inventory-wide total,
  // the cursor pointing at the first clipped criterion (for later
  // resume calls), and the max uncapped count across clipped items
  // (hint computation).
  const {
    clipped,
    totalCandidates,
    firstClippedCursor,
    firstClippedTotalAvailable,
    largestUncappedCount,
  } = clipChecklistItems(items, maxCandidatesPerCriterion);
  // Phase 2 — flat-stream pagination across clipped items. Walk with
  // a running global index; each item emits the candidate slice that
  // falls inside [offset, offset + limit). Items entirely outside
  // that window are dropped.
  const rangeEnd = offset + limit;
  const pageItems: ChecklistItemOut[] = [];
  let globalIdx = 0;
  let postClipTotal = 0;
  for (const item of clipped) {
    postClipTotal += item.candidates.length;
    const itemStart = globalIdx;
    const itemEnd = globalIdx + item.candidates.length;
    globalIdx = itemEnd;
    if (itemEnd <= offset) continue; // entirely before the window
    if (itemStart >= rangeEnd) continue; // entirely after the window
    const sliceStart = Math.max(0, offset - itemStart);
    const sliceEnd = Math.min(item.candidates.length, rangeEnd - itemStart);
    pageItems.push({
      ...item,
      candidates: item.candidates.slice(sliceStart, sliceEnd),
    });
  }
  const truncated = rangeEnd < postClipTotal;
  // hint = min(largest
  // uncapped count, MAX_MAX_PER_CRITERION). Only meaningful when at
  // least one criterion clipped — otherwise the caller already saw
  // every candidate and there's nothing to bump the cap for.
  const maxCandidatesPerCriterionHint =
    firstClippedCursor === undefined
      ? undefined
      : Math.min(largestUncappedCount, CHECKLIST_MAX_MAX_PER_CRITERION);
  return {
    items: pageItems,
    totalCandidates,
    paginationFields: buildChecklistPaginationFields({
      limit,
      offset,
      pageItems,
      rangeEnd,
      truncated,
      perCriterionClipped: firstClippedCursor !== undefined,
      ...(firstClippedCursor
        ? {
            nextCursor: firstClippedCursor,
            nextCursorClipDetails: {
              criterionId: firstClippedCursor.afterCriterion,
              clippedAt: firstClippedCursor.afterCandidateIndex + 1,
              totalAvailable: firstClippedTotalAvailable,
            },
          }
        : {}),
      ...(maxCandidatesPerCriterionHint === undefined ? {} : { maxCandidatesPerCriterionHint }),
    }),
  };
}

/**
 * Phase-1 helper for {@link paginateChecklistItems} — clips each item's
 * candidate list to `maxCandidatesPerCriterion` and threads back the
 * scalars the caller needs to assemble the response:
 *   - `clipped` — items in input order, with each candidate list sliced
 *     to at most `cap` candidates (untouched when already under).
 *   - `totalCandidates` — pre-clip inventory total (so `totalCandidates`
 *     in the response stays stable across pages).
 *   - `firstClippedCursor` — the first clipped criterion's cursor for
 *     later resume calls; `undefined` when nothing was clipped.
 *   - `largestUncappedCount` — pre-clip count of the noisiest clipped
 * criterion (hint input).
 *     0 when nothing was clipped — read it only when `firstClippedCursor`
 *     is defined.
 *
 * Extracted from the main function so the loop's branching doesn't push
 * `paginateChecklistItems` past the lint's cognitive-complexity cap.
 */
function clipChecklistItems(
  items: readonly ChecklistItemOut[],
  cap: number,
): {
  readonly clipped: readonly ChecklistItemOut[];
  readonly totalCandidates: number;
  readonly firstClippedCursor: ChecklistCursor | undefined;
  readonly firstClippedTotalAvailable: number;
  readonly largestUncappedCount: number;
} {
  let totalCandidates = 0;
  let firstClippedCursor: ChecklistCursor | undefined;
  let firstClippedTotalAvailable = 0;
  let largestUncappedCount = 0;
  const clipped: ChecklistItemOut[] = [];
  for (const item of items) {
    totalCandidates += item.candidates.length;
    if (item.candidates.length <= cap) {
      clipped.push(item);
      continue;
    }
    if (firstClippedCursor === undefined) {
      firstClippedCursor = {
        afterCriterion: item.criterionId,
        afterCandidateIndex: cap - 1,
      };
      firstClippedTotalAvailable = item.candidates.length;
    }
    if (item.candidates.length > largestUncappedCount) {
      largestUncappedCount = item.candidates.length;
    }
    clipped.push({ ...item, candidates: item.candidates.slice(0, cap) });
  }
  return {
    clipped,
    totalCandidates,
    firstClippedCursor,
    firstClippedTotalAvailable,
    largestUncappedCount,
  };
}

/**
 * Resume mode for the per-criterion elision. The caller has a valid
 * `nextCursor` from a previous truncated response; this pass:
 *   1. Finds the named criterion in the ranker-ordered inventory.
 *   2. Drops items ranked above it (already paged past).
 *   3. Yields the elided tail of that criterion starting at
 *      `afterCandidateIndex + 1`, capped by `maxCandidatesPerCriterion`.
 *   4. Emits a fresh `nextCursor` iff the tail still overflows the
 *      cap so the caller can re-page.
 *
 * `totalCandidates` still reports the full inventory's pre-clip tally
 * (stable across pages) so the agent's headline count is consistent
 * call-over-call. `truncated` / `nextOffset` / `perCriterionClipped`
 * stay in the flat-stream semantics from the non-cursor branch — on a
 * cursor call they're implicitly "this page is the tail of a single
 * criterion," so we emit only `nextCursor` when more remains.
 */
function paginateChecklistResume(
  items: readonly ChecklistItemOut[],
  cursor: ChecklistCursor,
  maxCandidatesPerCriterion: number,
): PaginatedChecklist {
  let totalCandidates = 0;
  let target: ChecklistItemOut | undefined;
  for (const item of items) {
    totalCandidates += item.candidates.length;
    if (item.criterionId === cursor.afterCriterion && target === undefined) {
      target = item;
    }
  }
  // Cursor points at a criterion we don't have (ranker-order changed,
  // skipCriterion dropped it, etc.). Honest fallback: empty page, no
  // nextCursor — the caller re-queries from scratch if they suspect
  // drift. This matches the malformed-cursor branch in `readCursor`.
  if (target === undefined) {
    return {
      items: [],
      totalCandidates,
      paginationFields: {},
    };
  }
  const resumeStart = cursor.afterCandidateIndex + 1;
  const resumeEnd = Math.min(target.candidates.length, resumeStart + maxCandidatesPerCriterion);
  const tail = target.candidates.slice(resumeStart, resumeEnd);
  const pageItems: ChecklistItemOut[] = tail.length === 0 ? [] : [{ ...target, candidates: tail }];
  const moreRemaining = resumeEnd < target.candidates.length;
  const nextCursor: ChecklistCursor | undefined = moreRemaining
    ? { afterCriterion: target.criterionId, afterCandidateIndex: resumeEnd - 1 }
    : undefined;
  // same hint shape on the
  // resume branch — only emitted when more tail remains, since the
  // agent has already seen everything we have on the criterion when
  // the resume consumed it. `min(target.candidates.length, 100)` is
  // the smaller of "total candidates on this criterion" and the input
  // band's ceiling.
  const maxCandidatesPerCriterionHint = moreRemaining
    ? Math.min(target.candidates.length, CHECKLIST_MAX_MAX_PER_CRITERION)
    : undefined;
  // Q13-RESULTS-TRUNCATED-USE-NEXTCURSOR-EMPTY-DETAILS: surface the
  // resume-branch clip event with the same shape `paginateChecklistItems`
  // emits — `clippedAt` is the post-resume slice end (cursor naming
  // resumeEnd - 1), `totalAvailable` is the criterion's full pre-clip
  // candidate count. Paired with `nextCursor` so cross-channel readers
  // (top-level pagination block, warning details payload) agree.
  const nextCursorClipDetails = nextCursor
    ? {
        criterionId: target.criterionId,
        clippedAt: resumeEnd,
        totalAvailable: target.candidates.length,
      }
    : undefined;
  return {
    items: pageItems,
    totalCandidates,
    paginationFields: {
      ...(nextCursor ? { nextCursor } : {}),
      ...(nextCursorClipDetails ? { nextCursorClipDetails } : {}),
      ...(maxCandidatesPerCriterionHint === undefined ? {} : { maxCandidatesPerCriterionHint }),
    },
  };
}

/**
 * Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE: assembles the conditional-spread
 * pagination fields for a checklist page. Lives as its own function so
 * {@link paginateChecklistItems} stays under the lint's
 * cognitive-complexity cap; the tri-state `pageClipReason` + the
 * paginationActive gate together pushed the main function past the
 * threshold.
 *
 * Wire shape mirrors scan_project's paginateFiles: the `requestedLimit`
 * / `effectiveLimit` echo is present-when-pagination-is-active (any
 * truncation, non-zero offset, or per-criterion clip), `pageClipReason`
 * names the regime when `effectiveLimit < requestedLimit`. Cross-
 * surface consumers read the same vocabulary on both tools.
 */
function buildChecklistPaginationFields(args: {
  readonly limit: number;
  readonly offset: number;
  readonly pageItems: readonly ChecklistItemOut[];
  readonly rangeEnd: number;
  readonly truncated: boolean;
  readonly perCriterionClipped: boolean;
  readonly nextCursor?: ChecklistCursor;
  readonly nextCursorClipDetails?: NonNullable<
    PaginatedChecklist["paginationFields"]["nextCursorClipDetails"]
  >;
  readonly maxCandidatesPerCriterionHint?: number;
}): PaginatedChecklist["paginationFields"] {
  const {
    limit,
    offset,
    pageItems,
    rangeEnd,
    truncated,
    perCriterionClipped,
    nextCursor,
    nextCursorClipDetails,
    maxCandidatesPerCriterionHint,
  } = args;
  // Count the candidates that actually shipped so `effectiveLimit` is
  // honest about what reached the wire. Summing post-slice captures
  // both the global limit AND per-criterion clip.
  let pageCandidateCount = 0;
  for (const item of pageItems) pageCandidateCount += item.candidates.length;
  // Pagination is active when the response carries any non-trivial
  // paging state. Trivial "whole inventory fit, nothing clipped"
  // pages omit the triple entirely — there's no ambiguity to resolve.
  const paginationActive = truncated || offset > 0 || perCriterionClipped;
  const pageClipReason = computeChecklistPageClipReason({
    truncated,
    perCriterionClipped,
    pageIsShort: pageCandidateCount < limit,
  });
  return {
    ...(truncated ? { truncated: true as const, nextOffset: rangeEnd } : {}),
    ...(perCriterionClipped ? { perCriterionClipped: true as const } : {}),
    ...(paginationActive ? { requestedLimit: limit, effectiveLimit: pageCandidateCount } : {}),
    ...(paginationActive && pageClipReason !== undefined ? { pageClipReason } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    ...(nextCursorClipDetails ? { nextCursorClipDetails } : {}),
    ...(maxCandidatesPerCriterionHint === undefined ? {} : { maxCandidatesPerCriterionHint }),
  };
}

/**
 * Pure tri-state reducer — returns `undefined` when nothing clipped
 * below the ask, or the `PageClipReason`-aligned token when a single-
 * axis regime fired:
 *   - `per_criterion_cap` — per-criterion clip AND no further trunc.
 *   - `end_of_results` — tail ran out, no per-criterion involvement.
 * Mid-page full pages (effective === requested) carry no reason.
 */
function computeChecklistPageClipReason(args: {
  readonly truncated: boolean;
  readonly perCriterionClipped: boolean;
  readonly pageIsShort: boolean;
}): "end_of_results" | "per_criterion_cap" | undefined {
  if (!args.pageIsShort) return undefined;
  if (args.truncated) return undefined;
  if (args.perCriterionClipped) return "per_criterion_cap";
  return "end_of_results";
}

interface ChecklistNextStepInputs {
  readonly actionableLen: number;
  readonly truncated: boolean;
  readonly nextOffset: number | undefined;
  readonly nextCursor: ChecklistCursor | undefined;
  /**
   * when the per-criterion
   * cap clipped, the hint value (smaller of largestUncappedCount and
   * the documented [1, 100] band's ceiling) is the agent-readable
   * target for "raise the cap to see everything in one shot." Threaded
   * into the cursor-branch prose so the recommendation names a concrete
   * number rather than asking the agent to guess.
   */
  readonly maxCandidatesPerCriterionHint: number | undefined;
  /**
   * Pre-clip inventory total across actionable items (matches
   * `summary.actionable.candidatesUncapped`). Used together with
   * `limit` to detect the "near limit" branch where the structured
   * nextStep should advertise paginate args instead of the generic
   * iterate-items[] prose.
   */
  readonly totalCandidates: number;
  /** Effective `limit` after clamping; paired with `totalCandidates`. */
  readonly limit: number;
  readonly cwd: string;
  readonly standard: string | undefined;
  readonly level: string | undefined;
}

/**
 * Threshold at which `nextStep` swaps the iterate-items[] prose for a
 * paginate-recommendation. The doctrine ("one tool call should answer
 * 'what next?'", `docs/kb/architecture/ai-first-consumer.md`) wants the
 * structured hint to be agent-actionable, not generic prose. When the
 * actionable inventory is already pushing the limit, the agent's next
 * call almost always wants explicit paginate args; firing this branch
 * pre-truncation gives the agent the same shape the truncated branch
 * already offers, so call-graph code paths converge.
 */
const CHECKLIST_NEAR_LIMIT_RATIO = 0.8;

/**
 * Builds the `checklist` tool's cross-pointing next-step pair per
 * ADR 0010.
 *
 * Three branches:
 *   - actionable.length === 0 → point at `coverage` (compliance
 *     dashboard is the honest follow-up when there are no grounded
 *     candidates to iterate).
 *   - truncated page → point at `checklist` again with the paging
 *     offset so the caller walks the queue without looking up the
 *     right params.
 *   - otherwise (actionable items present, no truncation) → point at
 *     `scan_project` as the closed-form re-run route, and name
 *     `attest` in prose as the verdict-recording step the agent takes
 *     after investigating an item. `attest` requires `reason` +
 *     `evidenceSource` that must come from the agent's per-item
 *     investigation (we cannot pre-seed them without fabricating
 *     provenance), so structured targets `scan_project { cwd }` —
 *     directly callable, matches the "what next?" doctrine.
 *
 * `nextStep` + `nextStepStructured` are emitted as a pair or not at
 * all — one-sided emission would re-create the drift ADR 0010 closes.
 */
function buildChecklistNextStep(inputs: ChecklistNextStepInputs): {
  readonly nextStep?: string;
  readonly nextStepStructured?: { readonly tool: string; readonly args: Record<string, unknown> };
} {
  const {
    actionableLen,
    truncated,
    nextOffset,
    nextCursor,
    maxCandidatesPerCriterionHint,
    totalCandidates,
    limit,
    cwd,
  } = inputs;
  if (actionableLen === 0) {
    return {
      nextStep:
        "No actionable manual items. Call `coverage` for the per-standard compliance dashboard. For a full end-to-end conformance audit, use the `ra11y/audit` prompt (via `prompts/get`); for per-criterion VPAT narrative drafting, use the `ra11y/vpat-narrative` prompt.",
      nextStepStructured: { tool: "coverage", args: buildChecklistArgs(inputs) },
    };
  }
  if (truncated && typeof nextOffset === "number") {
    return {
      nextStep: `Page truncated. Call \`checklist\` again with \`offset: ${nextOffset}\` to continue; call \`coverage\` for the per-standard compliance dashboard.`,
      nextStepStructured: {
        tool: "checklist",
        args: buildChecklistArgs(inputs, { offset: nextOffset, limit }),
      },
    };
  }
  if (nextCursor !== undefined) {
    const hintClause =
      maxCandidatesPerCriterionHint === undefined
        ? ""
        : ` Raising \`maxCandidatesPerCriterion\` to \`${maxCandidatesPerCriterionHint}\` (the response's \`maxCandidatesPerCriterionHint\`) on the next call is the alternative when you want a deeper cut in one shot.`;
    return {
      nextStep: `At least one criterion's candidate list was clipped by \`maxCandidatesPerCriterion\`. Call \`checklist\` again with \`cursor: nextCursor\` (pass the token back verbatim) to fetch the elided tail of \`${nextCursor.afterCriterion}\`; repeat while a \`nextCursor\` is emitted.${hintClause}`,
      nextStepStructured: {
        tool: "checklist",
        args: buildChecklistArgs(inputs, { cursor: nextCursor }),
      },
    };
  }
  // Near-limit branch: the page fit (no truncation, no per-criterion
  // cursor) but `totalCandidates` is already at >80% of `limit`, so
  // the next call is likely to truncate or already needs deliberate
  // chunking. Per ai-first-consumer.md "One tool call should answer
  // 'what next?'" the structured hint becomes a paginate-recommendation
  // (the same shape the truncated branch ships) instead of pointing at
  // `scan_project` with generic iterate-items[] prose. Args advertise
  // `offset: 0, limit: <current>` so the agent has a directly callable
  // re-page; the prose names the threshold so the agent knows the
  // recommendation is structural (heavy response approaching cap),
  // not arbitrary.
  if (totalCandidates > limit * CHECKLIST_NEAR_LIMIT_RATIO) {
    return {
      nextStep: `Total candidates (${totalCandidates}) is at >${Math.round(CHECKLIST_NEAR_LIMIT_RATIO * 100)}% of \`limit\` (${limit}); the response is near capacity. Call \`checklist\` again with \`offset: <n>, limit: <n>\` to walk the queue deliberately, or raise \`limit\` to fit the full inventory in one page. After verifying each item, call \`attest\` with the item's \`criterionId\`, a \`verdict\` (\`pass\` / \`fail\` / \`n/a\`), a \`reason\`, and an \`evidenceSource\` to record the verdict durably.`,
      nextStepStructured: {
        tool: "checklist",
        args: buildChecklistArgs(inputs, { offset: 0, limit }),
      },
    };
  }
  // Actionable items present, no truncation, response well under the
  // limit. Iterate items[] reading the cited files, then either (a)
  // call `attest` with a `verdict` + `reason` + `evidenceSource` to
  // record the verdict on the evidence ledger, or (b) fix and re-run
  // `scan_project`. Structured points at `scan_project { cwd }`
  // because it's closed-form directly callable; `attest`'s required
  // `reason` + `evidenceSource` cannot be pre-seeded without
  // fabricating provenance.
  return {
    nextStep:
      "Iterate `items[]`, reading each cited file and line. After verifying an item, call `attest` with the item's `criterionId`, a `verdict` (`pass` / `fail` / `n/a`), a `reason`, and an `evidenceSource` to record the verdict durably; call `scan_project` to re-run after fixing violations.",
    nextStepStructured: { tool: "scan_project", args: { cwd } },
  };
}

/**
 * Assembles the `nextStepStructured.args` record for branches that
 * route back to `checklist` or `coverage`. Every branch carries `cwd`;
 * `standard` and `level` conditional-spread as present-when-meaningful
 * (per CLAUDE.md §1 — omit when the caller didn't supply them so the
 * structured arg doesn't fabricate defaults the caller never chose).
 * Extras are the branch-specific keys (`offset`, `cursor`).
 */
function buildChecklistArgs(
  inputs: ChecklistNextStepInputs,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const { cwd, standard, level } = inputs;
  return {
    cwd,
    ...extras,
    ...(standard === undefined ? {} : { standard }),
    ...(level === undefined ? {} : { level }),
  };
}
