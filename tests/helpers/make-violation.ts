/**
 * Test helper: construct a {@link Violation} from a partial literal
 * and auto-stamp the engine-owned opaque tokens (`findingId`,
 * `findingGroupId`, `groupKey`).
 *
 * Most test data in this repo uses inline `Violation` literals for
 * formatter + report snapshots. The engine stamps both id tokens
 * (per-emission `findingId`, cross-run `findingGroupId`) and
 * `groupKey` from per-rule and per-emission inputs; tests don't
 * usually have those on hand, so `withFindingId` synthesizes all
 * three from placeholder inputs — enough to satisfy the required-
 * field invariants and stay deterministic across runs. Real end-to-
 * end assertions (line-drift resilience, per-emission addressability,
 * cross-file grouping) live in the scanner-driven tests, which run
 * the full scanner over real source strings and check the token
 * values directly.
 */

import type { Violation } from "../../src/types/violation.ts";
import { computeFindingGroupId, computeFindingId } from "../../src/utils/finding-id.ts";
import { computeGroupKey, UNKNOWN_SHAPE } from "../../src/utils/group-key.ts";

/**
 * Stamps `findingId`, `findingGroupId`, and `groupKey` derived from
 * the given violation. Test fixtures rarely have a parsed AST on hand,
 * so `groupKey` uses the `UNKNOWN_SHAPE` sentinel — deterministic
 * per-ruleId and correctly groups every synthetic test Violation
 * from the same rule.
 */
export function withFindingId(
  v: Omit<Violation, "findingId" | "findingGroupId" | "groupKey">,
): Violation {
  const findingId = computeFindingId({
    ruleId: v.ruleId,
    filePath: v.location.filePath,
    line: v.location.line,
    column: v.location.column,
  });
  const findingGroupId = computeFindingGroupId({
    ruleId: v.ruleId,
    filePath: v.location.filePath,
    // Empty source is fine for test fixtures — the normalized-line-
    // text component collapses to the empty string, so the hash is
    // stable for the (ruleId, path) pair, which is all these tests
    // need.
    source: "",
    line: v.location.line,
  });
  const groupKey = computeGroupKey({ ruleId: v.ruleId, shape: UNKNOWN_SHAPE });
  return { ...v, findingId, findingGroupId, groupKey };
}

/** Maps `withFindingId` over an array of partial violations. */
export function withFindingIds(
  vs: readonly Omit<Violation, "findingId" | "findingGroupId" | "groupKey">[],
): Violation[] {
  return vs.map(withFindingId);
}
