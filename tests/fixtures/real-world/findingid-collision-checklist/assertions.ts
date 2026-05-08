/**
 * findingid-collision-checklist — guards that distinct review-candidate
 * emissions at the same `(filePath, line, column)` whose criterion union
 * happens to be identical but whose `reason` text differs each get a
 * unique `findingId` on every surface that ships them.
 *
 * Field report: `checklist.items[*].candidates[*].findingId` shipped 7
 * duplicate ids on a vanilla-stack catalog response. Same `(rule, file,
 * line, column)` but two distinct `reason` strings — calling
 * `suggest_fix(findingId)` on a colliding id resolves ambiguously, and
 * suppressing on the id silences a sibling reason the agent never read.
 *
 * Per AI-first doctrine "Per-finding identifiers must be addressable,
 * not collision-prone" (`docs/kb/architecture/ai-first-consumer.md`):
 * every `findingId` in a single response must be unique, and the
 * per-call surface must address one emission per id.
 *
 * Closure: include the reason-discriminator in the `findingId` hash so
 * each emission gets a unique id, even when the per-position criteria
 * union is identical across two finders firing at the same byte.
 *
 * Why this corpus:
 *
 *   - `<img alt="Profile">` inside `<a href="/profile">` followed by
 *     visible "Profile" sibling text triggers BOTH
 *     `review/alt-duplicates-sibling-text` (alt text repeated by an
 *     interactive sibling) AND `review/redundant-alt-text` (short alt
 *     repeated in adjacent live text). Each finder's `criterionIds`
 *     are `["wcag22:1.1.1", "wcag21:1.1.1"]` → identical criteria
 *     unions per position-group, but distinct `reason` text.
 *
 *   - The `<button>` plus image+text sibling block reproduces the same
 *     two-finder co-fire on a different element so the integration
 *     test has ≥2 collision sites in one response, mirroring the
 *     "7 duplicate ids" signal in the field report.
 *
 * The scan-time assertions below lock in that the source motivates the
 * bug — both finders must continue to fire on the same byte position so
 * the per-emission addressability invariant has something to address.
 * The cross-surface uniqueness invariant itself is asserted in
 * `tests/integration/mcp-consistency/findingid-collision-checklist.test.ts`,
 * which drives the live MCP `checklist` tool against this fixture and
 * asserts every `findingId` is unique within the response.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Two interactive elements (<a> and <button>) each contain an <img alt='X'> followed by sibling text matching the alt — triggers BOTH review/alt-duplicates-sibling-text AND review/redundant-alt-text on the same byte position, with identical criterion unions but distinct reason text. Used by the findingid-collision-checklist integration test to verify each emission receives a unique findingId.",
  origin: {
    notes:
      "checklist.items[*].candidates[*].findingId shipped 7 duplicate ids on a vanilla-stack catalog. Same (rule, file, line, column) but distinct reason strings — suggest_fix(findingId) resolves ambiguously, suppress silences a sibling reason. Sanitized to a two-element fixture so both collision sites show up in one response and the integration test can assert findingIds.size === findings.length.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Both finders share criterion family wcag22:1.1.1 / wcag21:1.1.1
    // and emit at the same line+column on each <img>. The integration
    // test verifies every findingId in checklist + scan_file is unique
    // across the response.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.1.1",
      reasonIncludes: "alt text is repeated by sibling text",
    },
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.1.1",
      reasonIncludes: "repeated in an immediate sibling text node",
    },
  ],
};
