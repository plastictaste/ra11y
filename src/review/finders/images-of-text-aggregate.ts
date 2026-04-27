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
 * is provable from the AST — NOT a heuristic. Two predicate variants
 * qualify a run for collapse — both with the same baseline
 * preconditions (1)-(3) plus a kind-specific alt-text rule.
 *
 *   Baseline (every variant):
 *   1. Same DOM parent node.
 *   2. Same wrapping shape ({@link AggregationGroupKind}).
 *   3. ≥4 consecutive siblings match (MIN_GROUP_SIZE).
 *
 *   Variant `"enumerated-token"` (preferred when both fit):
 *   4a. Alt-text normalizes to the same token count, with at most one
 *       token position varying across members ("Sponsor 1/2/…").
 *
 *   Variant `"parent-shape-contiguous-range"` (relaxed fallback,
 *   covering contributor-list / sponsor-avatar clusters where each row
 *   carries a person name and the strict enumerated-token check does
 *   not fit):
 *   4b. The strict enumerated-token check did not qualify the run, but
 *       baseline (1)-(3) still hold. Honest aggregation: parent
 *       identity, wrapping shape, and ≥4 contiguous count are
 *       deterministic AST facts; the per-sibling alt trail is preserved
 *       fully via `siblingOccurrences` so no fidelity is lost.
 *
 * When the run does not reach (3), no aggregation fires and the caller
 * still emits each member individually per the existing finder path,
 * preserving the surface-don't-suppress floor.
 *
 * See docs/kb/architecture/ai-first-consumer.md "Labeled buckets are
 * suppression too" for the rationale: a label is honest only when it's
 * correct 100% of the time from the scanner's evidence. Same-parent +
 * same-wrapping + ≥4-contiguous satisfies that bar; looser rules
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
 * Why this aggregation fired. Two provable-from-AST predicates qualify
 * a run for collapse, in tightening-then-relaxing order:
 *
 *   - `"enumerated-token"` — the strict, original predicate: same
 *     parent, same wrapping shape, alt-text token-count matches and at
 *     most one token position varies across the run ("Sponsor 1/2/…").
 *     Catches the canonical jekyll README sponsor-row repro.
 *   - `"parent-shape-contiguous-range"` — the relaxed fallback: same
 *     parent, same wrapping shape, ≥4 consecutive members, but alt-text
 *     token shape diverges in more than one position so the strict
 *     enumerated-token check rejects the run. Catches contiguous
 *     contributor-list / sponsor-avatar clusters where each row's alt
 *     is a person name (no enumerated suffix). Honest aggregation per
 *     the AI-first consumer model: the parent identity and wrapping
 *     shape are deterministic AST facts, and ≥4 contiguous siblings
 *     sharing both is a defensible "contiguous range" predicate.
 */
export type AggregationGroupKind = "enumerated-token" | "parent-shape-contiguous-range";

/**
 * One aggregation group — a contiguous run of same-shape siblings
 * that qualified under one of the two {@link AggregationGroupKind}
 * predicates. Only groups with `members.length >= MIN_GROUP_SIZE` are
 * emitted by {@link computeAggregationGroups}.
 */
export interface AggregationGroup {
  readonly kind: AggregationGroupKind;
  readonly members: readonly SiblingSummary[];
  /** Derived: the aggregated reason text describing the run. */
  readonly reasonFragment: string;
  /** Derived: `siblingOccurrences` list for the emitted candidate. */
  readonly occurrences: readonly ReviewCandidateSibling[];
}

/**
 * Walks a sibling-summary list left-to-right collapsing runs of
 * same-shape neighbors into groups. A run extends across siblings
 * sharing the same wrapping shape; it breaks on the first sibling
 * whose shape differs.
 *
 * At flush time, a run of `MIN_GROUP_SIZE+` qualifies under one of
 * the two {@link AggregationGroupKind} predicates:
 *
 *   1. `"enumerated-token"` (preferred when both fit) — alt-text
 *      tokens match in count with at most one varying position. The
 *      historical predicate; emits the existing reason fragment.
 *   2. `"parent-shape-contiguous-range"` (fallback) — same parent,
 *      same shape, ≥4 contiguous siblings, but the enumerated-token
 *      check fails. Emits the contiguous-range reason fragment naming
 *      the line range so an agent reading the consolidated candidate
 *      sees "and N similar at lines X-Y" without drilling into the
 *      occurrences list.
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
    if (run.length >= MIN_GROUP_SIZE) {
      const kind: AggregationGroupKind = isEnumeratedRun(run)
        ? "enumerated-token"
        : "parent-shape-contiguous-range";
      out.push(buildGroup(run, kind));
    }
    run = [];
  };
  for (const s of siblings) {
    if (run.length === 0) {
      run.push(s);
      continue;
    }
    const head = run[0]!;
    if (s.shape === head.shape) {
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
 * True when every member's normalized alt has the same token count
 * and at most one token position (`varyingIndex`) carries divergent
 * values across members. Members with a `null` normalized alt are
 * rejected — aggregation needs a readable alt to qualify under the
 * enumerated-token predicate. Used at flush time only — the run-
 * extension loop no longer gates on this; runs extend on
 * same-wrapping-shape alone, and the enumerated-token check chooses
 * between the two {@link AggregationGroupKind} variants for the run
 * that did extend.
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
 * `reasonFragment` names the group size, shape, and (for the
 * contiguous-range variant) the line span so an agent reading the
 * primary candidate's reason-text sees "this is one of N siblings"
 * without needing to drill into `siblingOccurrences`. The
 * `occurrences` list is populated per-sibling for iteration.
 */
function buildGroup(
  members: readonly SiblingSummary[],
  kind: AggregationGroupKind,
): AggregationGroup {
  const shapeLabel = members[0]!.shape === "linked-img" ? "<a><img/></a>" : "<img/>";
  const reasonFragment =
    kind === "enumerated-token"
      ? `aggregated from ${members.length} adjacent sibling images sharing the same ` +
        `parent and same ${shapeLabel} wrapping, with alt text differing only by an ` +
        `enumerated-token (see siblingOccurrences for the per-sibling line/alt/href trail)`
      : buildContiguousRangeFragment(members, shapeLabel);
  const occurrences = members.map((m) => occurrenceFor(m));
  return { kind, members, reasonFragment, occurrences };
}

/**
 * Reason fragment for the parent-shape-contiguous-range variant.
 * Names the span ("lines X-Y") so an agent reading the consolidated
 * candidate's reason sees the contiguous-cluster framing per the Q7
 * "and N similar at lines X-Y" intent. Honest aggregation per the
 * AI-first consumer model — same parent + same wrapping shape + ≥4
 * contiguous members are deterministic AST facts; alt-text divergence
 * is preserved fully via `siblingOccurrences` so no fidelity is lost.
 */
function buildContiguousRangeFragment(
  members: readonly SiblingSummary[],
  shapeLabel: string,
): string {
  const firstLine = members[0]!.line;
  const lastLine = members[members.length - 1]!.line;
  const lineSpan = firstLine === lastLine ? `line ${firstLine}` : `lines ${firstLine}-${lastLine}`;
  return (
    `aggregated from ${members.length} adjacent sibling images at ${lineSpan} sharing the ` +
    `same parent and same ${shapeLabel} wrapping; alt text varies (the enumerated-token ` +
    `predicate did not fit, but the contiguous-range cluster of same-parent same-shape ` +
    `siblings is provable from the AST — see siblingOccurrences for the per-sibling ` +
    `line/alt/href trail)`
  );
}

function occurrenceFor(m: SiblingSummary): ReviewCandidateSibling {
  return {
    line: m.line,
    ...(m.altRaw === null ? {} : { alt: m.altRaw }),
    ...(m.href === null ? {} : { href: m.href }),
  };
}
