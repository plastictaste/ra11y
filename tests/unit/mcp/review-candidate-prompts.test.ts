/**
 * Unit coverage for `buildReviewCandidatePrompts` — the helper that
 * folds per-criterion shared-reason text into a top-level prompts-
 * style map. Pinning the predicate at the unit level keeps the
 * cross-surface integration test (the wire-shape rehearsal) free
 * from re-asserting algorithmic edge cases.
 *
 * Three predicate axes pinned here:
 *   1. all-shared → criterion lands in the map with `genericReason`
 *      = the verbatim text every emission carried.
 *   2. varying → criterion is OMITTED from the map (per the
 *      "Ambiguous field shapes are dishonest" rule, varying reason
 *      means the per-candidate `reason` field is the agent's
 *      authoritative read; a top-level `genericReason` would lie).
 *   3. `manualIds` filter → criteria outside the filter never reach
 *      the map even when their reasons are shared (mirrors the
 *      filter `buildScanProjectReviewCandidates` applies upstream).
 */

import { describe, expect, it } from "bun:test";
import { buildReviewCandidatePrompts } from "../../../src/mcp/review-candidate-prompts.ts";
import type { ReviewCandidate } from "../../../src/types/review.ts";

function candidate(args: { criterionId: string; reason: string; line?: number }): ReviewCandidate {
  return {
    criterionId: args.criterionId,
    location: { filePath: "x.html", line: args.line ?? 1, column: 1 },
    reason: args.reason,
    confidence: "high",
  };
}

describe("buildReviewCandidatePrompts", () => {
  it("hoists the shared reason when every emission of a criterion carries the same text", () => {
    const candidates: readonly ReviewCandidate[] = [
      candidate({
        criterionId: "wcag22:1.2.1",
        reason: "audio element -- verify transcript",
        line: 5,
      }),
      candidate({
        criterionId: "wcag22:1.2.1",
        reason: "audio element -- verify transcript",
        line: 6,
      }),
      candidate({
        criterionId: "wcag22:1.2.1",
        reason: "audio element -- verify transcript",
        line: 7,
      }),
    ];
    const out = buildReviewCandidatePrompts({ candidates });
    expect(out["wcag22:1.2.1"]).toBeDefined();
    expect(out["wcag22:1.2.1"]?.genericReason).toBe("audio element -- verify transcript");
  });

  it("omits the criterion entirely when reasons vary across emissions", () => {
    const candidates: readonly ReviewCandidate[] = [
      candidate({ criterionId: "wcag22:1.2.1", reason: "reason A", line: 5 }),
      candidate({ criterionId: "wcag22:1.2.1", reason: "reason B", line: 6 }),
    ];
    const out = buildReviewCandidatePrompts({ candidates });
    expect(out["wcag22:1.2.1"]).toBeUndefined();
  });

  it("hoists per-criterion: shared criterion lands; varying criterion is omitted in the same call", () => {
    const candidates: readonly ReviewCandidate[] = [
      candidate({
        criterionId: "wcag22:1.2.1",
        reason: "audio element -- verify transcript",
        line: 5,
      }),
      candidate({
        criterionId: "wcag22:1.2.1",
        reason: "audio element -- verify transcript",
        line: 6,
      }),
      candidate({ criterionId: "wcag22:1.2.8", reason: "AAA-shape A", line: 5 }),
      candidate({ criterionId: "wcag22:1.2.8", reason: "AAA-shape B", line: 6 }),
    ];
    const out = buildReviewCandidatePrompts({ candidates });
    expect(out["wcag22:1.2.1"]?.genericReason).toBe("audio element -- verify transcript");
    expect(out["wcag22:1.2.8"]).toBeUndefined();
  });

  it("returns an empty map when given no candidates (caller conditional-spreads — never `{}` on the wire)", () => {
    const out = buildReviewCandidatePrompts({ candidates: [] });
    expect(Object.keys(out).length).toBe(0);
  });

  it("respects the optional manualIds filter — criteria outside the set never reach the map", () => {
    const candidates: readonly ReviewCandidate[] = [
      candidate({
        criterionId: "wcag22:1.2.1",
        reason: "audio element -- verify transcript",
        line: 5,
      }),
      candidate({
        criterionId: "wcag22:1.2.1",
        reason: "audio element -- verify transcript",
        line: 6,
      }),
      candidate({ criterionId: "wcag22:1.4.5", reason: "image of text", line: 5 }),
    ];
    const out = buildReviewCandidatePrompts({
      candidates,
      manualIds: new Set(["wcag22:1.2.1"]),
    });
    expect(out["wcag22:1.2.1"]).toBeDefined();
    expect(out["wcag22:1.4.5"]).toBeUndefined();
  });

  it("preserves byte-identical reason text verbatim — leading/trailing whitespace, special chars, casing", () => {
    const verbatim = "  audio element -- verify TRANSCRIPT is provided  (1.2.1) ";
    const candidates: readonly ReviewCandidate[] = [
      candidate({ criterionId: "wcag22:1.2.1", reason: verbatim, line: 5 }),
      candidate({ criterionId: "wcag22:1.2.1", reason: verbatim, line: 6 }),
    ];
    const out = buildReviewCandidatePrompts({ candidates });
    expect(out["wcag22:1.2.1"]?.genericReason).toBe(verbatim);
  });

  it("treats a singleton emission as 'shared' — the predicate is 'every emission shared the reason'", () => {
    // Edge case: only one candidate for the criterion. Every
    // emission shares (vacuously) so the entry lands. This is the
    // honest read — there's no varying signal to omit on. Agents
    // reading the prompts can use the entry to recognize the form
    // when a sibling later joins.
    const candidates: readonly ReviewCandidate[] = [
      candidate({ criterionId: "wcag22:1.2.1", reason: "single", line: 5 }),
    ];
    const out = buildReviewCandidatePrompts({ candidates });
    expect(out["wcag22:1.2.1"]?.genericReason).toBe("single");
  });
});
