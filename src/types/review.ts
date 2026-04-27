/**
 * Types for the assisted manual review system.
 *
 * A {@link ReviewCandidate} is a location in source code where a human
 * reviewer should look for a specific accessibility criterion. Unlike a
 * {@link Violation}, it makes no pass/fail claim — the scanner found the
 * needle, the reviewer makes the call.
 *
 * A {@link CandidateFinder} is the structural analog of a {@link Rule}
 * for the review system: a pure function that walks ASTs and emits
 * candidates. Finders declare which criterion IDs they surface
 * candidates for via `criterionIds`.
 *
 * See docs/architecture.md for context on how this fits the three-layer model.
 */

import type { Ast } from "./ast.ts";
import type { Process } from "./config.ts";
import type { AppliesTo, FileContext, RuleContext } from "./rule.ts";
import type { Location } from "./violation.ts";

/**
 * How strongly the finder's static evidence supports this being a real
 * review candidate. Same enum, same semantics as the `confidence` field
 * on automated findings (see `severityToConfidence` in
 * src/mcp/tools-helpers.ts) so an agent's threshold/filter logic reads
 * the same way across surfaces.
 *
 * - `"high"`: deterministic match. The scanner can name the exact static
 *   evidence (element tag, attribute combination, known library import,
 *   cross-file ordering divergence) and a reviewer's next read confirms
 *   or rejects the question the criterion asks. Near-zero false-positive
 *   floor.
 * - `"medium"`: concrete evidence exists but the question the finder
 *   surfaces depends on context the scanner can't see (e.g.
 *   "setTimeout" — real session timeout vs debounce). The candidate is
 *   always worth reading; the dismissal is often one file Read away.
 * - `"low"`: heuristic match on narrow evidence (text-regex, className
 *   convention, structural proxy for a page-set concern). The finder's
 *   docstring typically notes it is "biased toward false positives."
 *   Still surface — an agent dismisses in milliseconds — but threshold
 *   filtering here is meaningful for batch workflows.
 */
export type ReviewConfidence = "high" | "medium" | "low";

/**
 * One sibling in an aggregated review candidate. Present when a finder
 * collapses a run of adjacent same-shape elements (e.g. ten
 * `<a><img/></a>` sponsor-logo siblings whose alt text differs only by
 * an enumerated token) into a single consolidated candidate. The
 * primary {@link ReviewCandidate#location} names the group's anchor
 * (usually the first sibling); `siblingOccurrences` enumerates every
 * member so an agent can iterate the group without re-parsing. Per the
 * AI-first consumer model, aggregation is only emitted when the group
 * label is provable from the AST — same parent, same wrapping, and
 * enumerated-only alt-text divergence — never on heuristic evidence.
 */
export interface ReviewCandidateSibling {
  /** 1-based line of this sibling in the source file. */
  readonly line: number;
  /**
   * Short alt text (or accessible name) on this sibling, for agent-
   * facing enumeration. Populated when the finder had the value; omit
   * rather than emit `""` when absent (present-when-meaningful).
   */
  readonly alt?: string;
  /**
   * Link target when the sibling is wrapped in (or is) an anchor.
   * Omitted when the wrapping shape has no href.
   */
  readonly href?: string;
}

/** A location where a human reviewer should verify a manual criterion. */
export interface ReviewCandidate {
  /** The criterion this candidate is relevant to (e.g., "wcag22:1.2.1"). */
  readonly criterionId: string;
  /** Where in the source file the candidate was found. */
  readonly location: Location;
  /** Short explanation of why this location needs review. */
  readonly reason: string;
  /**
   * How strongly the finder's static evidence supports this candidate.
   * Required — every grounded candidate carries a confidence value.
   * Finders choose the value based on what their static signal can
   * actually claim; see {@link ReviewConfidence}.
   */
  readonly confidence: ReviewConfidence;
  /** Optional source snippet for context in reports. */
  readonly snippet?: string;
  /**
   * Present when the finder aggregated ≥2 adjacent same-shape siblings
   * into this single consolidated candidate. The list enumerates every
   * group member (including the one at {@link ReviewCandidate#location})
   * so agents can trail-dismiss by reading one candidate instead of N.
   * Omitted when the candidate is not aggregated — never sentinel-empty,
   * per the "present-when-meaningful" rule.
   */
  readonly siblingOccurrences?: readonly ReviewCandidateSibling[];
  /**
   * Additive structured evidence that the cited file looks like
   * third-party / build-output code rather than the page author's
   * source. True when a finder's path-shape predicates (vendor library
   * basename match such as `bootstrap.js` / `jquery-1.10.2.js`,
   * `.min.` infix, or single-line minified shape) classify the file
   * as a vendor / build-output drop. The agent reading the candidate
   * uses this to decide whether the call site is library internals
   * the page author can't change.
   *
   * Strictly additive per ai-first-consumer.md "Numeric-threshold
   * heuristics are suppression" — the candidate still surfaces at the
   * same confidence and every WCAG criterion stays attached. Omitted
   * (not `false`) when the file is an ordinary authored source so
   * presence reads as positive evidence (present-when-meaningful);
   * `false` is reserved for finders that need to communicate "this
   * predicate ran and answered no" alongside other vendor signals.
   */
  readonly vendorPathHint?: boolean;
  /**
   * Additive structured evidence for timing-related candidates: the
   * duration argument of the underlying `setTimeout` / `setInterval`
   * call resolved to a millisecond count when — and only when — the
   * second argument is a numeric literal (`300`, `60_000`, `0x100`,
   * `5e2`, `1.5`).
   *
   * Strictly typed as `number | undefined`: the field is omitted when
   * the duration is non-literal (member access, identifier, call,
   * computed expression) so the agent never has to type-check before
   * reading. The non-literal case surfaces as a sibling
   * {@link ReviewCandidate#durationExpression} carrying the verbatim
   * expression — separating "literal value" and "non-literal handle"
   * into two single-typed fields rather than a polymorphic
   * `number | "non-literal"` (per ai-first-consumer.md "Ambiguous
   * field shapes are dishonest" — a polymorphic field forces a
   * type-check on every read).
   *
   * Also omitted when the candidate has no duration to report (e.g.
   * `<meta http-equiv="refresh">` or a degenerate `setTimeout(fn)`
   * with no second argument). Per the same doctrine the field is
   * additive context only — never gates suppression, never adjusts
   * confidence on a numeric threshold; the agent reading the
   * surrounding code is the only correct arbiter of whether the
   * duration governs a user-facing time limit.
   */
  readonly durationLiteralMs?: number;
  /**
   * Verbatim non-literal duration expression for timing-related
   * candidates — populated when the second argument of the underlying
   * `setTimeout` / `setInterval` call is not a numeric literal (member
   * access `self.options.interval`, identifier `delay`, call
   * `getDelay()`, computed `delay * 2`). Sibling to
   * {@link ReviewCandidate#durationLiteralMs}: exactly one of the two
   * is populated when the call has a duration argument; both are
   * omitted otherwise. The verbatim text lets the agent grep for the
   * binding in the surrounding code without parsing the reason text.
   * Truncated by {@link truncateForEcho} so a pathological computed
   * expression can't balloon the field.
   */
  readonly durationExpression?: string;
  /**
   * Number of source occurrences this candidate represents. When a finder
   * deduplicates near-identical candidates by accessible-name pattern
   * (e.g. ten `<img alt="Sponsor 1">` … `<img alt="Sponsor 10">` whose
   * normalized alt collapses to the same `Sponsor <num>` stem), it
   * collapses the run into ONE candidate carrying `sourceCount: N` and a
   * matching `siblingOccurrences` list of the per-source `{ line, alt? }`
   * entries. Omitted on singleton candidates — present-when-meaningful
   * per CLAUDE.md §1 "Ambiguous field shapes are dishonest." Honest
   * aggregation per the AI-first consumer model: the stem is provable
   * from the AST (digit/ordinal-suffix-strip on the normalized alt), not
   * a heuristic on weaker evidence.
   */
  readonly sourceCount?: number;
  /**
   * Byte offset (0-based, into the file's `source` string) of the
   * literal token the finder matched. When present alongside
   * {@link ReviewCandidate#matchLength}, the snippet builder can anchor
   * a tight clamped window on the matched evidence (the literal
   * sentence/clause containing the match) rather than emitting a
   * fixed-width ±N-line window — addressing the "snippet doesn't show
   * the matched evidence" failure mode the agent hits when the cited
   * `line` carries multiple sentences and the fixed window picks the
   * wrong one.
   *
   * Present-when-meaningful per CLAUDE.md §1 — finders that don't track
   * the literal byte offset (AST-element finders that emit at the
   * element's source position rather than a regex match offset) omit
   * the field. The snippet builder falls back to its existing
   * fixed-window mode when the pair is absent. Strictly additive: never
   * gates suppression, never alters confidence.
   */
  readonly matchOffset?: number;
  /**
   * Byte length of the literal token at {@link ReviewCandidate#matchOffset}.
   * Pairs with that field — both must be present together for the tight-
   * snippet path to fire. Omitted alongside `matchOffset` (per the
   * "present-when-meaningful" rule); a `matchOffset` without a
   * `matchLength` is treated as "no anchor" and falls back to the
   * fixed-window snippet builder.
   */
  readonly matchLength?: number;
}

/** Scope for a candidate finder — same semantics as RuleScope minus "project". */
export type CandidateFinderScope = "node" | "document";

/** Documentation for a candidate finder. */
export interface CandidateFinderDocs {
  /** One-line description of what the finder looks for. */
  readonly description: string;
  /** What the human reviewer should check at each candidate location. */
  readonly reviewPrompt: string;
  /** Spec URLs and references. */
  readonly references: readonly string[];
}

/**
 * The minimal per-file record a project-scoped finder sees. This is the
 * already-parsed material the scanner collected on the per-file pass;
 * project finders MUST NOT re-parse.
 */
export interface ProjectFile {
  readonly filePath: string;
  readonly source: string;
  readonly ast: Ast;
  readonly disableMap: ReadonlyMap<number, ReadonlySet<string>>;
}

/**
 * Context passed to a candidate finder's `afterProject` hook. Carries
 * every parsed file the scanner touched plus the enabled-standards set,
 * so a cross-file finder (e.g. WCAG 3.2.3 Consistent Navigation) can
 * compare structures between routes without reopening files.
 */
export interface ProjectCandidateContext {
  readonly files: readonly ProjectFile[];
  readonly enabledStandards: ReadonlySet<string>;
  /**
   * Declared process page-sets (`LoadedConfig.processes`) — ordered,
   * named sets of page file paths that together form a user journey.
   * Cross-page criteria (3.2.3 Consistent navigation, 3.2.4 Consistent
   * identification, 2.4.5 Multiple ways) key off this primitive because
   * they cannot be answered from a single page in isolation.
   *
   * Omitted (rather than `[]`) when the caller did not thread the
   * processes config through; finders that require a declared page set
   * MUST treat both `undefined` and `[]` as "no process evidence" and
   * emit zero candidates — honest "needs config" per ADR 0016, never
   * a heuristic fallback.
   */
  readonly processes?: readonly Process[];
}

/**
 * A candidate finder — finds locations that need human review for
 * manual accessibility criteria. Structurally parallel to Rule but
 * emits ReviewCandidate[] instead of Violation[].
 */
export interface CandidateFinder {
  /** Unique identifier (e.g., "review/media-alternatives"). */
  readonly id: string;
  /** Criterion IDs this finder surfaces candidates for. */
  readonly criterionIds: readonly string[];
  readonly scope: CandidateFinderScope;
  readonly appliesTo?: AppliesTo;
  readonly docs: CandidateFinderDocs;
  /**
   * When true, the engine keeps at most one emitted candidate per
   * criterion across all files. Used for page-set-level checks whose
   * question ("does the site offer multiple ways to navigate?") is
   * shared by every plausible root layout — otherwise the reviewer
   * sees the same prompt once per root file.
   */
  readonly uniquePerCriterion?: boolean;
  /** Node-scoped finder — called once per file, finder iterates internally. */
  find?(ctx: RuleContext): readonly ReviewCandidate[] | undefined;
  /** Document-scoped finder — called after file parsing. */
  afterFile?(ctx: FileContext): readonly ReviewCandidate[] | undefined;
  /**
   * Project-scoped finder — called once after every file has been
   * processed. Used for cross-file checks like WCAG 3.2.3 Consistent
   * Navigation, where a candidate only exists relative to other
   * files. The returned candidates' `location.filePath` MUST be one
   * of the paths in `ctx.files`; the scanner applies per-file
   * disableMap filtering before surfacing them.
   */
  afterProject?(ctx: ProjectCandidateContext): readonly ReviewCandidate[] | undefined;
}
