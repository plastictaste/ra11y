/**
 * Co-firing rule merger.
 *
 * Some rule pairs deterministically co-fire on the same source element
 * because their predicates overlap on a single defect with a single fix
 * path. Pre-fold the agent reads two findings against the same
 * `(filePath, line, column)` and has to reconcile that one edit closes
 * both — once the more specific rule emits, the less specific rule's
 * finding adds attention-budget cost without adding signal.
 *
 * Canonical cases driving this module:
 *
 *   - `<a href="#"><i class="fa..."></i></a>` fires both
 *     `navigation/href-empty-fragment` (severity:error, "this isn't a
 *     real link — replace with a real URL or a `<button>`") AND
 *     `navigation/link-descriptive-text` (severity:warning, "icon-only
 *     anchor has no name"). One edit (replace the placeholder href with
 *     a real destination, or convert to `<button>`) closes both. The
 *     more specific rule names the actual defect; the descriptive-text
 *     warning is downstream of the same authoring mistake.
 *
 *   - `<input type="email" placeholder="Email">` fires both
 *     `forms/labels-required` (severity:error, "no accessible name")
 *     AND `forms/placeholder-as-label` (severity:warning, "the
 *     placeholder IS the label — promote it"). One edit (move
 *     placeholder copy into a `<label>` or `aria-label`) closes both.
 *     The placeholder-as-label rule names the specific authoring
 *     mistake; labels-required is the generic predicate that the same
 *     element fails.
 *
 * Doctrine fit (`docs/kb/architecture/ai-first-consumer.md`):
 *
 *   - "Composite headline counts are dishonest" — when two findings on
 *     one element + one fix sum into the headline counter, the agent
 *     budgets against an inflated count of "distinct defects."
 *   - "Cross-surface count invariant" — the merged finding cites both
 *     rules' criteria via the union of `criteria` arrays, so coverage,
 *     vpat, and checklist surfaces all agree the same WCAG criteria
 *     were exercised. Information is preserved; only the duplicate
 *     finding is folded.
 *   - This is NOT heuristic suppression — the relation is provable from
 *     the rule predicates: when both rules fire on the same
 *     `(filePath, line, column)`, by construction they observed the
 *     same element and the same defect. No filename heuristics, no
 *     structural guesses.
 *
 * Encoded as a small explicit table rather than a global cross-rule
 * scan so adding a new pair is a one-line declaration with reviewable
 * intent. The pre-existing `forms/labels-required` ↔
 * `forms/label-adjacent-unassociated` dedup remains in-rule (the more
 * specific rule's predicate detection lives in
 * `src/rules/forms/_label-adjacency.ts` and `labels-required` consults
 * the suppression set in-place) because its discriminator is
 * structural (preceding-sibling shape) — not a same-`(file, line, col)`
 * coincidence. The two mechanisms compose: in-rule suppression handles
 * predicates that share STRUCTURE; this post-pass handles predicates
 * that share LOCATION but have independent emit paths.
 *
 * The post-pass walks emitted violations once, groups by `(filePath,
 * line, column)`, and for each pair where BOTH primary and secondary
 * are present at the same key:
 *   1. Drop the secondary's Violation from the output list.
 *   2. Merge the secondary's `criteria` and `criteriaTitles` into the
 *      primary's, preserving ordering and de-duplicating.
 *
 * Pure function over its inputs; no I/O, no global state. Caller
 * concatenates the result and sorts — this function preserves the
 * input ordering for non-merged entries.
 */

import type { Violation } from "../types/violation.ts";

/**
 * Declaration of a co-firing rule pair: when both `primary` and
 * `secondary` emit a violation at the same `(filePath, line, column)`,
 * the secondary's violation is folded into the primary and dropped
 * from the output list.
 *
 * Choose `primary` as the rule whose finding text + fix path more
 * directly names the underlying authoring mistake. The secondary is
 * usually the more general predicate that the same defect happens to
 * also fail. Severity is NOT the discriminator — `href-empty-fragment`
 * (error) is primary over `link-descriptive-text` (warning) AND
 * `placeholder-as-label` (warning) is primary over `labels-required`
 * (error). Specificity wins.
 */
interface CoFirePair {
  readonly primary: string;
  readonly secondary: string;
}

/**
 * Co-firing pairs. Add new rows here when two rules deterministically
 * emit on the same `(filePath, line, column)` and one edit closes
 * both. Keep the table small — a wrong row hides a real finding (the
 * merge is silent), so each row should clear the same predicate-
 * strength bar as in-rule suppression: the merge must be provable from
 * the rules' predicates, not guessed from filename / structure / spec
 * exemption heuristics.
 */
const CO_FIRE_PAIRS: readonly CoFirePair[] = [
  // `<a href="#"><i class="fa-..."></i></a>` and `<a href=""></a>`
  // shapes: href-empty-fragment names the placeholder-href authoring
  // mistake (error); link-descriptive-text observes the same anchor
  // has no descriptive text (warning). One fix (replace the
  // placeholder with a real URL or convert to <button>) closes both —
  // the descriptive-text concern is downstream of the same mistake.
  {
    primary: "navigation/href-empty-fragment",
    secondary: "navigation/link-descriptive-text",
  },
  // `<input type="email" placeholder="Email">` and similar shapes:
  // placeholder-as-label names the specific authoring mistake (the
  // placeholder is being used in lieu of a label); labels-required is
  // the general predicate the same element also fails. One fix (move
  // placeholder copy into a real <label>) closes both — promoting the
  // placeholder satisfies both rules.
  {
    primary: "forms/placeholder-as-label",
    secondary: "forms/labels-required",
  },
];

/**
 * Merges co-firing rule pairs. Walks `violations` once, groups by
 * `(filePath, line, column)`, and folds each known secondary into the
 * primary at the same key:
 *
 *   - The primary's `criteria` array gains the secondary's criteria
 *     (union, ordered by primary-first then secondary's added order,
 *     de-duplicated).
 *   - The primary's `criteriaTitles` array gains the secondary's
 *     titles aligned index-for-index against the merged `criteria`.
 *   - The secondary's Violation is dropped from the output.
 *
 * Other Violation fields stay on the primary unchanged. The primary's
 * `severity`, `message`, `suggestion`, `fix`, `findingId`,
 * `findingGroupId`, `groupKey`, and `fixClass` are preserved — folding
 * the secondary does not
 * synthesize a new identity; the agent reads the same primary record
 * with a wider `criteria` array.
 *
 * Pure function. Input ordering is preserved for entries that are not
 * dropped; merged primaries stay at their original position.
 */
export function mergeCoFiringRules(violations: readonly Violation[]): readonly Violation[] {
  if (violations.length === 0) return violations;
  if (CO_FIRE_PAIRS.length === 0) return violations;

  // Index violations by `(filePath, line, column, ruleId)` so we can
  // resolve "is the partner present at this location?" in O(1).
  const byKey = indexByLocationAndRule(violations);

  // Determine which violations should be dropped (folded secondaries)
  // and which should be replaced with merged primaries. We materialize
  // both decisions before the rebuild loop so the rebuild reads as a
  // single linear pass over the input ordering.
  const drop = new Set<Violation>();
  const replace = new Map<Violation, Violation>();

  for (const pair of CO_FIRE_PAIRS) {
    foldPairAtMatchingLocations(violations, byKey, pair, drop, replace);
  }

  if (drop.size === 0) return violations;

  const out: Violation[] = [];
  for (const v of violations) {
    if (drop.has(v)) continue;
    out.push(replace.get(v) ?? v);
  }
  return out;
}

/**
 * Builds a lookup from `(filePath, line, column, ruleId)` → Violation
 * so the pair-folding loop can ask "is rule X present at this
 * location?" without re-scanning the violations list per pair.
 *
 * If the same `(filePath, line, column, ruleId)` triple repeats (e.g.
 * a rule emits twice at the same anchor with different `variantKey`
 * values), the FIRST occurrence wins. Variant-keyed siblings are
 * independent findings — folding both into one primary would silently
 * drop a distinct defect — so the second occurrence stays unfolded.
 */
function indexByLocationAndRule(violations: readonly Violation[]): ReadonlyMap<string, Violation> {
  const out = new Map<string, Violation>();
  for (const v of violations) {
    const key = locationRuleKey(v);
    if (!out.has(key)) out.set(key, v);
  }
  return out;
}

/**
 * For one pair declaration, walk every primary-side emission in the
 * violations list and check whether the secondary fires at the exact
 * same `(filePath, line, column)`. When both are present, mark the
 * secondary for drop and stage a merged-primary replacement.
 */
function foldPairAtMatchingLocations(
  violations: readonly Violation[],
  byKey: ReadonlyMap<string, Violation>,
  pair: CoFirePair,
  drop: Set<Violation>,
  replace: Map<Violation, Violation>,
): void {
  for (const v of violations) {
    if (v.ruleId !== pair.primary) continue;
    const partnerKey = `${v.location.filePath} ${v.location.line} ${v.location.column} ${pair.secondary}`;
    const partner = byKey.get(partnerKey);
    if (!partner) continue;
    if (drop.has(partner)) continue;
    drop.add(partner);
    replace.set(v, mergeCriteriaInto(v, partner));
  }
}

/**
 * Returns a new Violation that is `primary` with `secondary`'s
 * criteria + criteriaTitles unioned in. Index alignment between
 * `criteria[i]` and `criteriaTitles[i]` is preserved by appending in
 * lock-step.
 */
function mergeCriteriaInto(primary: Violation, secondary: Violation): Violation {
  const merged = unionCriteriaWithTitles(
    primary.criteria,
    primary.criteriaTitles,
    secondary.criteria,
    secondary.criteriaTitles,
  );
  return {
    ...primary,
    criteria: merged.criteria,
    ...(merged.criteriaTitles === undefined ? {} : { criteriaTitles: merged.criteriaTitles }),
  };
}

interface MergedCriteria {
  readonly criteria: readonly string[];
  readonly criteriaTitles?: readonly string[];
}

/**
 * Union two `(criteria, criteriaTitles)` arrays. Output preserves
 * index alignment: `result.criteriaTitles[i]` is the title for
 * `result.criteria[i]`.
 *
 * `criteriaTitles` is optional on Violation — when neither side
 * supplies titles, the result also omits them. When one side supplies
 * titles and the other doesn't, the missing titles fall back to the
 * criterion ID itself (mirrors the engine's stamping behavior in
 * `standard-filter.ts` `titlesForCriteria`: an unresolved title emits
 * the ID as its own title rather than an empty string, per CLAUDE.md
 * §1 "Ambiguous field shapes are dishonest").
 */
function unionCriteriaWithTitles(
  primaryCriteria: readonly string[],
  primaryTitles: readonly string[] | undefined,
  secondaryCriteria: readonly string[],
  secondaryTitles: readonly string[] | undefined,
): MergedCriteria {
  const seen = new Set<string>();
  const criteria: string[] = [];
  const titles: string[] = [];
  const haveTitles = primaryTitles !== undefined || secondaryTitles !== undefined;

  appendCriteriaWithTitles(primaryCriteria, primaryTitles, seen, criteria, titles, haveTitles);
  appendCriteriaWithTitles(secondaryCriteria, secondaryTitles, seen, criteria, titles, haveTitles);

  if (!haveTitles) return { criteria };
  return { criteria, criteriaTitles: titles };
}

function appendCriteriaWithTitles(
  ids: readonly string[],
  titles: readonly string[] | undefined,
  seen: Set<string>,
  outIds: string[],
  outTitles: string[],
  haveTitles: boolean,
): void {
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (id === undefined) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    outIds.push(id);
    if (haveTitles) outTitles.push(titles?.[i] ?? id);
  }
}

function locationRuleKey(v: Violation): string {
  return `${v.location.filePath} ${v.location.line} ${v.location.column} ${v.ruleId}`;
}
