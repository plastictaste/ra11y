/**
 * jekyll-readme-sponsor-logos — guards the review/images-of-text
 * aggregation contract: when ≥4 adjacent sibling `<img>` elements share
 * a structural pattern (same parent, same `<a><img/></a>` wrapping,
 * alt-text differing only by an enumerated token — "Jekyll Sponsor 1",
 * "Jekyll Sponsor 2", …), the finder emits ONE consolidated candidate
 * per criterion whose `siblingOccurrences` list carries every matched
 * sibling's `{ line, alt, href }`.
 *
 * Before aggregation, the canonical repro (jekyll/jekyll
 * `README.markdown:58-67` — ten sponsor `<a><img/></a>` siblings)
 * produced ten near-identical review candidates per 1.4.5-family
 * criterion. Per the AI-first consumer model this is honest pattern
 * aggregation, not heuristic suppression: the provable-from-evidence
 * fact (same parent, same wrapping shape, enumerated-token alt) is
 * deterministic from the AST, and the agent reads the aggregated
 * candidate's `siblingOccurrences` to enumerate the full per-sibling
 * trail. See docs/kb/architecture/ai-first-consumer.md "Labeled
 * buckets are suppression too" — aggregation is honest when the group
 * label is provable from the AST, which it is here.
 *
 * What the fixture locks in:
 *   - Zero parse errors.
 *   - The review/images-of-text finder still surfaces the 1.4.5
 *     family (surface, don't suppress — the candidate itself must
 *     remain visible).
 *   - Exactly ONE candidate per 1.4.5-family criterion, not ten —
 *     the aggregation cap. A regression that reverts aggregation
 *     would push candidate-count back to 10 and trip this assertion.
 *   - The candidate's reason text names the aggregation shape, so an
 *     agent reading the reason alone learns it's looking at a group,
 *     not a singleton — and knows to read `siblingOccurrences` for
 *     the full trail.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "review/images-of-text aggregates ≥4 adjacent sibling <img> elements sharing " +
    "a structural pattern and enumerated-token alt text into ONE consolidated " +
    "candidate per criterion, with siblingOccurrences carrying the full " +
    "per-sibling trail. Guards against regression to the pre-aggregation " +
    "ten-candidate noise shape (jekyll/jekyll README.markdown:58-67).",
  origin: {
    notes:
      "Sanitized from jekyll/jekyll README.markdown:58-67 — ten adjacent " +
      "<a href='...'><img class='sponsor-logo' alt='Jekyll Sponsor N'/></a> " +
      "siblings. Pairs with closed Q6-ICON-FONT-HIDDEN-GROUP-DEDUP-CLASS-PATTERN " +
      "(per-rule meta concentration, different surface) and open " +
      "Q6-PATTERN-FINGERPRINT-CROSS-TEMPLATE (cross-file sibling of the same " +
      "honest-pattern-aggregation doctrine).",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Surface, don't suppress: aggregation collapses 10 candidates into
    // 1 per criterion, but the 1 still fires. A regression that removed
    // the 1.4.5 signal entirely (silent-miss failure) would trip this.
    { kind: "candidate-present", criterionId: "wcag22:1.4.5" },

    // Aggregation cap — locks the 10 → 1 contract for every 1.4.5
    // family criterion the finder carries. Before the fix these counts
    // were 10; after the fix each is exactly 1.
    {
      kind: "candidate-count",
      criterionId: "wcag22:1.4.5",
      predicate: { equals: 1 },
    },
    {
      kind: "candidate-count",
      criterionId: "wcag21:1.4.5",
      predicate: { equals: 1 },
    },
    {
      kind: "candidate-count",
      criterionId: "section508:1.4.5",
      predicate: { equals: 1 },
    },
    {
      kind: "candidate-count",
      criterionId: "en301549:9.1.4.5",
      predicate: { equals: 1 },
    },
    {
      kind: "candidate-count",
      criterionId: "wcag22:1.4.9",
      predicate: { equals: 1 },
    },
    {
      kind: "candidate-count",
      criterionId: "wcag21:1.4.9",
      predicate: { equals: 1 },
    },

    // The aggregated candidate's reason must name the group shape —
    // "10 adjacent sibling" + "enumerated-token" — so an agent reading
    // the reason alone knows this is a grouped finding. The structured
    // siblingOccurrences list carries the per-sibling detail; the
    // reason is the human-scannable prose counterpart.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.4.5",
      reasonIncludes: "10 adjacent sibling",
    },
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.4.5",
      reasonIncludes: "enumerated-token",
    },
  ],
};
