/**
 * Criterion subset-relation table + per-line dedup helper.
 *
 * Some WCAG criteria are subset signals of others: when an automated
 * rule fires a deterministic violation against the subset criterion at
 * a given source location, the parent-criterion review candidate at the
 * SAME location is implied and surfacing it as a separate manual-review
 * prompt double-budgets the agent's attention against one underlying
 * defect.
 *
 * Canonical case driving this module:
 *   - `forms/autocomplete-missing` deterministically fires for
 *     `wcag22:1.3.5` (Identify Input Purpose, AA) on an `<input
 *     type="email" name="email">` lacking `autocomplete=`.
 *   - `review/identify-purpose` emits a manual-review candidate for
 *     `wcag22:1.3.6` (Identify Purpose, AAA) on the same input element
 *     because 1.3.6 broadens 1.3.5's scope to all UI components
 *     collecting user information; the static evidence is identical
 *     (no `autocomplete=`).
 *
 * Pre-fold the agent reads two surfaces against the same line — one
 * automated violation citing 1.3.5, one manual-review candidate citing
 * 1.3.6 — and has to reconcile that fixing the 1.3.5 finding also
 * satisfies the 1.3.6 prompt. Post-fold the candidate is suppressed
 * because the agent will already see and act on the 1.3.5 violation;
 * the 1.3.6 prompt would survey the same input under a different
 * conceptual badge with no new information.
 *
 * Doctrine fit (`docs/kb/architecture/ai-first-consumer.md`):
 *   - "Cross-surface count invariant" — the same `(filePath, line)`
 *     shouldn't show as both a violation and a manual-review candidate
 *     when one subsumes the other; the integrator-doctrine answer is
 *     to compute the dedup once at the scan-graph level so all
 *     consumers (`scan_project`, `checklist`, `coverage`,
 *     `review_candidates`) see the same pruned candidate set.
 *   - This is NOT heuristic suppression — the relation is conceptual
 *     and provable from the criteria's normative text (1.3.6 explicitly
 *     extends 1.3.5 from input fields to UI components); the gating
 *     evidence is a deterministic violation, not a guess at composition
 *     or filename pattern. See the "no heuristic suppression" rule for
 *     the predicate-strength bar this clears.
 *
 * Encoded as a structural rule rather than a hard-coded
 * `wcag22:1.3.5/1.3.6` carve-out so future subset relations (1.3.6 ↔
 * 1.3.5 is the seed; the table is open to additions) drop in as data
 * without touching the dedup logic. The expansion helper walks the
 * registered standards' `equivalentTo` map at scan time so a single
 * declaration like `{ parent: "wcag22:1.3.6", subsets: ["wcag22:1.3.5"] }`
 * automatically covers `wcag21:1.3.6` ↔ `wcag21:1.3.5` and any future
 * cross-standard equivalents (Section 508 / EN 301 549) without needing
 * a per-standard duplicate row in the table.
 */

import type { ReviewCandidate } from "../types/review.ts";
import type { Criterion } from "../types/standard.ts";
import type { Violation } from "../types/violation.ts";

/**
 * Declaration of a subset relation: a `parent` criterion is implied by
 * any violation citing one of its `subsets`. The expansion helper
 * cross-multiplies via the registered standards' `equivalentTo` index
 * so a single row covers every cross-standard pair.
 */
interface SubsetRelationDeclaration {
  readonly parent: string;
  readonly subsets: readonly string[];
}

/**
 * Seed relations. Add new rows here when an automated rule's
 * deterministic violation conceptually covers a finder-emitted
 * candidate at the same location. Keep the table small — over-broad
 * declarations risk silent under-surfacing per the AI-first consumer
 * model's asymmetry rule (a wrong subset row hides a real candidate;
 * a missing row leaves a redundant candidate the agent dismisses in
 * one read).
 */
const SUBSET_RELATIONS: readonly SubsetRelationDeclaration[] = [
  // 1.3.6 Identify Purpose (AAA) is broader than 1.3.5 Identify Input
  // Purpose (AA): 1.3.6 extends the programmatic-purpose requirement
  // from input fields to all UI components collecting user
  // information. `forms/autocomplete-missing` deterministically detects
  // the input-field case (1.3.5); `review/identify-purpose` surfaces
  // the broader prompt (1.3.6) as a manual-review candidate at the
  // same input element. When the deterministic 1.3.5 violation fires
  // at the input's source position, the 1.3.6 candidate at the same
  // position is implied — fixing the violation will satisfy the
  // candidate's same-line concern.
  { parent: "wcag22:1.3.6", subsets: ["wcag22:1.3.5"] },
];

/**
 * Compiled subset table: candidate criterion ID → set of criterion IDs
 * whose presence in a violation's `criteria` array implies the
 * candidate at the same `(filePath, line)`. Built once per scan from
 * {@link SUBSET_RELATIONS} cross-multiplied against the registered
 * standards' `equivalentTo` index so a single row covers WCAG 2.2 ↔
 * WCAG 2.1 ↔ Section 508 ↔ EN 301 549 pairs without duplicate
 * declarations.
 */
export type SubsetClosure = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Builds a subset closure from {@link SUBSET_RELATIONS} expanded across
 * the supplied criteria index's `equivalentTo` graph. Result is keyed
 * by parent criterion ID (and every parent equivalent); each value is
 * the union of subset criteria PLUS every subset's equivalents.
 *
 * Design choice — equivalent-only expansion (no transitive subset-of-
 * subset chasing): a single row in {@link SUBSET_RELATIONS} cleanly
 * declares one conceptual subset relation; chaining through other rows
 * would couple unrelated declarations and make the table hard to
 * audit. If a transitive relation is genuinely needed, declare it
 * directly.
 */
export function buildSubsetClosure(criteria: readonly Criterion[]): SubsetClosure {
  const equivalents = buildEquivalentIndex(criteria);
  const out = new Map<string, Set<string>>();
  for (const row of SUBSET_RELATIONS) {
    expandRowInto(out, row, equivalents);
  }
  return out;
}

/**
 * Expands a single declaration row across the equivalents index and
 * unions the result into the closure map. Extracted so
 * {@link buildSubsetClosure} stays under the cognitive-complexity cap.
 */
function expandRowInto(
  closure: Map<string, Set<string>>,
  row: SubsetRelationDeclaration,
  equivalents: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const parents = expandWithEquivalents(row.parent, equivalents);
  const subsetUnion = unionExpanded(row.subsets, equivalents);
  for (const parent of parents) {
    const existing = closure.get(parent);
    if (existing === undefined) {
      closure.set(parent, new Set(subsetUnion));
    } else {
      for (const s of subsetUnion) existing.add(s);
    }
  }
}

/**
 * Returns the union of every expanded subset ID for a declaration row.
 * The expansion runs `expandWithEquivalents` per ID so cross-standard
 * subset members (e.g. `wcag22:1.3.5` ↔ `wcag21:1.3.5`) are folded in.
 */
function unionExpanded(
  ids: readonly string[],
  equivalents: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const id of ids) {
    for (const equiv of expandWithEquivalents(id, equivalents)) out.add(equiv);
  }
  return out;
}

/**
 * Walks the supplied criteria's `equivalentTo` field to produce a
 * symmetric index: every criterion ID maps to the set containing
 * itself plus every cross-standard equivalent. The standards module
 * already builds a reciprocal closure at registry init (via
 * `criteriaRegistry.rebuild`), but the registry isn't always in scope
 * here — this helper recomputes the closure from the raw criteria
 * input so the subset table can be built from any criteria array
 * (including test fixtures).
 */
function buildEquivalentIndex(
  criteria: readonly Criterion[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const adjacency = seedAdjacencyFromEquivalentTo(criteria);
  closeAdjacencyTransitively(adjacency);
  return adjacency;
}

/**
 * Seeds the adjacency map: every criterion gets a bucket containing
 * itself plus every direct `equivalentTo` neighbor (reciprocal — the
 * neighbor's bucket also gets back-edged so a one-way `equivalentTo`
 * declaration produces a symmetric index).
 */
function seedAdjacencyFromEquivalentTo(criteria: readonly Criterion[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const ensureBucket = (id: string): Set<string> => {
    let bucket = adjacency.get(id);
    if (bucket === undefined) {
      bucket = new Set([id]);
      adjacency.set(id, bucket);
    }
    return bucket;
  };
  for (const c of criteria) {
    const bucket = ensureBucket(c.id);
    for (const other of c.equivalentTo ?? []) {
      bucket.add(other);
      ensureBucket(other).add(c.id);
    }
  }
  return adjacency;
}

/**
 * Iterates the adjacency map until no bucket grows: a third-party
 * WCAG ↔ Section 508 ↔ EN 301 549 chain may need one closure pass to
 * surface every transitive member from any seed.
 */
function closeAdjacencyTransitively(adjacency: Map<string, Set<string>>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const bucket of adjacency.values()) {
      if (mergeNeighborsInto(bucket, adjacency)) changed = true;
    }
  }
}

/**
 * Folds every neighbor's bucket into `bucket`. Returns true if `bucket`
 * grew during the merge (drives the outer fixed-point loop).
 */
function mergeNeighborsInto(
  bucket: Set<string>,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const before = bucket.size;
  for (const other of [...bucket]) {
    const otherBucket = adjacency.get(other);
    if (otherBucket === undefined) continue;
    for (const x of otherBucket) bucket.add(x);
  }
  return bucket.size !== before;
}

function expandWithEquivalents(
  id: string,
  equivalents: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  return equivalents.get(id) ?? new Set([id]);
}

/**
 * Drops review candidates whose criterion is implied by an automated
 * violation at the same `(filePath, line)`.
 *
 * A candidate at `(file, line, criterionId)` is dropped iff there
 * exists a violation at `(file, line)` whose `criteria` array includes
 * any criterion ID in `subsetClosure.get(criterionId)`. The position
 * key matches the rule's emit site (the input element's `<` position
 * for both `forms/autocomplete-missing` and
 * `review/identify-purpose`); column is intentionally NOT part of the
 * key because rules and finders observing the same element may report
 * subtly different columns when an attribute's source range differs
 * from the element's start range.
 *
 * Pure function over its inputs. When `subsetClosure` is empty (the
 * common case before this module is wired into the scanner) the helper
 * returns the input array unmodified.
 */
export function pruneCandidatesCoveredByViolations(
  candidates: readonly ReviewCandidate[],
  violations: readonly Violation[],
  subsetClosure: SubsetClosure,
): readonly ReviewCandidate[] {
  if (subsetClosure.size === 0 || candidates.length === 0 || violations.length === 0) {
    return candidates;
  }
  const violationCriteriaByPosition = indexViolationsByPosition(violations);
  return candidates.filter((c) => {
    const subsets = subsetClosure.get(c.criterionId);
    if (subsets === undefined || subsets.size === 0) return true;
    const key = positionKey(c.location.filePath, c.location.line);
    const firedCriteria = violationCriteriaByPosition.get(key);
    if (firedCriteria === undefined) return true;
    for (const subset of subsets) {
      if (firedCriteria.has(subset)) return false;
    }
    return true;
  });
}

/**
 * Builds a `(filePath, line) → fired criteria` index. Same-line
 * granularity is the right scope for the dedup: rules and finders
 * observing the same element emit at the element's start line, but
 * may differ on column (`<input` vs the `name="..."` attribute span,
 * for example).
 */
function indexViolationsByPosition(
  violations: readonly Violation[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const v of violations) {
    const key = positionKey(v.location.filePath, v.location.line);
    let bucket = out.get(key);
    if (bucket === undefined) {
      bucket = new Set();
      out.set(key, bucket);
    }
    for (const c of v.criteria) bucket.add(c);
  }
  return out;
}

function positionKey(filePath: string, line: number): string {
  return `${filePath}\x00${line}`;
}
