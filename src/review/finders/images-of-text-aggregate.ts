/**
 * Aggregation helper for `review/images-of-text` — collapses a run of
 * adjacent same-shape sibling `<img>` candidates into a single
 * consolidated `ReviewCandidate` carrying `siblingOccurrences`.
 *
 * Canonical repro (jekyll/jekyll README.markdown:58-67): ten adjacent
 * `<a href="..."><img class="sponsor-logo" alt="Jekyll Sponsor N"/></a>`
 * siblings. Before aggregation each `<img>` produced one candidate per
 * 1.4.5-family criterion — ten near-identical candidates per criterion
 * that read as noise to the consuming agent. Aggregation reduces that
 * to one consolidated candidate per criterion whose
 * `siblingOccurrences` list carries every member's `{ line, alt, href }`.
 *
 * Honest-aggregation discipline (AI-first doctrine, "Labeled buckets
 * are suppression too"): aggregation only emits when the group label
 * is provable from the AST — NOT a heuristic. The four preconditions
 * a candidate run must satisfy, ALL from direct AST evidence:
 *
 *   1. Same DOM parent node.
 *   2. Same wrapping shape ({@link AggregationShape.Kind}).
 *   3. Alt-text normalizes to the same token count, with at most one
 *      token position varying across members (enumerated-token).
 *   4. ≥4 consecutive siblings match (MIN_GROUP_SIZE).
 *
 * When any precondition fails the run is NOT aggregated — the caller
 * still emits each member individually per the existing finder path,
 * preserving the surface-don't-suppress floor.
 *
 * See docs/kb/architecture/ai-first-consumer.md "Labeled buckets are
 * suppression too" for the rationale: a label is honest only when it's
 * correct 100% of the time from the scanner's evidence. Same-parent +
 * same-wrapping + token-divergence satisfies that bar; looser rules
 * (e.g. "any two imgs on the same page") would not.
 */

import type { ReviewCandidateSibling } from "../../types/review.ts";

/** Minimum consecutive sibling count to trigger aggregation. */
export const MIN_GROUP_SIZE = 4;

/**
 * Structural shape of a sibling's wrapping. Two members are
 * same-shape iff their kind matches. The "linked" kind covers
 * `<a><img/></a>` and `<a><img/><whitespace/></a>` equivalently —
 * the enumerated-token walk already ignores whitespace around the
 * wrapper, so padding doesn't break grouping.
 */
export type AggregationShapeKind = "bare-img" | "linked-img";

/**
 * Per-sibling summary the aggregator consumes. One entry is built per
 * direct child of the parent that qualifies as a candidate image
 * (either bare `<img>` or `<a>` wrapping exactly one `<img>`).
 */
export interface SiblingSummary {
  /** Position of this sibling in the parent's children list. */
  readonly parentIndex: number;
  /** Line of the `<img>` (not the wrapper). */
  readonly line: number;
  /** Wrapping kind used for same-shape matching. */
  readonly shape: AggregationShapeKind;
  /**
   * Collapsed / normalized alt text (what the finder would echo into
   * its reason). Used for enumerated-token matching. `null` when the
   * `<img>` had no alt text the finder could use.
   */
  readonly altRaw: string | null;
  /**
   * Normalized form of `altRaw` (lowercase, non-alphanumerics
   * collapsed to spaces). `null` when normalization produced no
   * tokens. This is the form enumerated-token matching operates on.
   */
  readonly altNormalized: string | null;
  /**
   * `href` from the wrapping `<a>`, when shape is `"linked-img"`.
   * `null` otherwise — keeps the field shape consistent across kinds.
   */
  readonly href: string | null;
}

/**
 * One aggregation group — a contiguous run of same-shape,
 * enumerated-token siblings. Only groups with `members.length >=
 * MIN_GROUP_SIZE` are emitted by {@link computeAggregationGroups}.
 */
export interface AggregationGroup {
  readonly members: readonly SiblingSummary[];
  /** Derived: the aggregated reason text describing the run. */
  readonly reasonFragment: string;
  /** Derived: `siblingOccurrences` list for the emitted candidate. */
  readonly occurrences: readonly ReviewCandidateSibling[];
}

/**
 * Walks a sibling-summary list left-to-right collapsing runs of
 * same-shape, enumerated-token neighbors into groups. A run breaks
 * on the first sibling whose shape differs OR whose alt tokens fail
 * the enumerated-token check against the current run's first member.
 *
 * Groups shorter than {@link MIN_GROUP_SIZE} are discarded — the
 * caller falls back to per-sibling emission for those members.
 */
export function computeAggregationGroups(
  siblings: readonly SiblingSummary[],
): readonly AggregationGroup[] {
  const out: AggregationGroup[] = [];
  let run: SiblingSummary[] = [];
  const flush = (): void => {
    if (run.length >= MIN_GROUP_SIZE && isEnumeratedRun(run)) {
      out.push(buildGroup(run));
    }
    run = [];
  };
  for (const s of siblings) {
    if (run.length === 0) {
      run.push(s);
      continue;
    }
    const head = run[0]!;
    if (s.shape === head.shape && isEnumeratedExtension(run, s)) {
      run.push(s);
      continue;
    }
    flush();
    run.push(s);
  }
  flush();
  return out;
}

/**
 * Decides whether `candidate` extends an ongoing `run` as another
 * enumerated-token member. The strict rule is: same token count AND
 * at most one token position differs across all run members so far
 * (including `candidate`). This catches "Sponsor 1" → "Sponsor 2" →
 * … → "Sponsor 10" and "Partner A" → "Partner B" → "Partner C"
 * while excluding runs with divergent shapes ("Sponsor 1", "Gold
 * Sponsor", …).
 */
function isEnumeratedExtension(run: readonly SiblingSummary[], candidate: SiblingSummary): boolean {
  return isEnumeratedRun([...run, candidate]);
}

/**
 * True when every member's normalized alt has the same token count
 * and at most one token position (`varyingIndex`) carries divergent
 * values across members. Members with a `null` normalized alt are
 * rejected — aggregation needs a readable alt to group on.
 */
function isEnumeratedRun(run: readonly SiblingSummary[]): boolean {
  if (run.length < 2) return true;
  const tokenLists: readonly string[][] = run.map((s) =>
    s.altNormalized === null ? [] : s.altNormalized.split(" "),
  );
  for (const list of tokenLists) {
    if (list.length === 0) return false;
  }
  const firstList = tokenLists[0]!;
  const length = firstList.length;
  for (const list of tokenLists) {
    if (list.length !== length) return false;
  }
  let varyingIndices = 0;
  for (let position = 0; position < length; position += 1) {
    const first = firstList[position];
    for (let member = 1; member < tokenLists.length; member += 1) {
      const token = tokenLists[member]![position];
      if (token !== first) {
        varyingIndices += 1;
        break;
      }
    }
    if (varyingIndices > 1) return false;
  }
  return true;
}

/**
 * Builds an `AggregationGroup` from a qualifying run. The
 * `reasonFragment` names the group size and shape so an agent reading
 * the primary candidate's reason-text sees "this is one of N siblings"
 * without needing to drill into `siblingOccurrences`. The
 * `occurrences` list is populated per-sibling for iteration.
 */
function buildGroup(members: readonly SiblingSummary[]): AggregationGroup {
  const shapeLabel = members[0]!.shape === "linked-img" ? "<a><img/></a>" : "<img/>";
  const reasonFragment =
    `aggregated from ${members.length} adjacent sibling images sharing the same ` +
    `parent and same ${shapeLabel} wrapping, with alt text differing only by an ` +
    `enumerated-token (see siblingOccurrences for the per-sibling line/alt/href trail)`;
  const occurrences = members.map((m) => occurrenceFor(m));
  return { members, reasonFragment, occurrences };
}

function occurrenceFor(m: SiblingSummary): ReviewCandidateSibling {
  return {
    line: m.line,
    ...(m.altRaw === null ? {} : { alt: m.altRaw }),
    ...(m.href === null ? {} : { href: m.href }),
  };
}
