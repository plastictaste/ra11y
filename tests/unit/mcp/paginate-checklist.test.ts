/**
 * Unit tests for the `checklist` tool's pagination.
 *
 * Two orthogonal axes are under test:
 *   - limit / offset paginate the flattened candidate stream across
 *     all items; `truncated: true` + `nextOffset` flip on when the
 *     global limit clips the list.
 *   - maxCandidatesPerCriterion clips each item independently;
 *     `perCriterionClipped: true` flips on when any single item was
 *     clipped. Orthogonal to truncation — either, both, or neither
 *     may be set on a response.
 *
 * We exercise the pure helpers directly (rather than through an MCP
 * subprocess) so the contract is testable without staging fixtures
 * that coincidentally happen to produce N candidates.
 */
import { describe, expect, it } from "bun:test";
import {
  type ChecklistPageParams,
  paginateChecklistItems,
  readChecklistPageParams,
} from "../../../src/mcp/tool-checklist.ts";
import type { ReviewConfidence } from "../../../src/types/review.ts";

/**
 * Builds a synthetic item shaped like the real `ChecklistItemOut`,
 * carrying `candidateCount` candidates with unique paths so slicing
 * is observable.
 */
function makeItem(
  criterionId: string,
  candidateCount: number,
  confidence: ReviewConfidence = "medium",
) {
  const candidates = Array.from({ length: candidateCount }, (_, i) => ({
    path: `${criterionId}-${i}.tsx`,
    line: i + 1,
    reason: "manual review candidate",
    confidence,
    suppressWith: `{/* ra11y-disable ${criterionId} */}`,
  }));
  return {
    criterionId,
    title: `Criterion ${criterionId}`,
    level: "AA",
    priority: "high" as const,
    confidence,
    candidates,
  };
}

/**
 * Builds a flat list of N items each carrying exactly one candidate,
 * for testing global limit/offset across items.
 */
function singleCandidateItems(n: number) {
  return Array.from({ length: n }, (_, i) => makeItem(`wcag22:1.${i}.${i}`, 1));
}

const fullParams = (partial: Partial<ChecklistPageParams> = {}): ChecklistPageParams => ({
  limit: partial.limit ?? 200,
  offset: partial.offset ?? 0,
  maxCandidatesPerCriterion: partial.maxCandidatesPerCriterion ?? 10,
  ...(partial.cursor ? { cursor: partial.cursor } : {}),
});

describe("readChecklistPageParams", () => {
  it("returns defaults when no params supplied", () => {
    expect(readChecklistPageParams({})).toEqual({
      limit: 200,
      offset: 0,
      maxCandidatesPerCriterion: 10,
    });
  });

  it("clamps limit up to the min when given zero or negative", () => {
    expect(readChecklistPageParams({ limit: 0 }).limit).toBe(1);
    expect(readChecklistPageParams({ limit: -5 }).limit).toBe(1);
  });

  it("clamps limit down to the max when given a huge value", () => {
    expect(readChecklistPageParams({ limit: 3000 }).limit).toBe(2000);
    expect(readChecklistPageParams({ limit: 999999 }).limit).toBe(2000);
  });

  it("clamps maxCandidatesPerCriterion to [1, 100]", () => {
    expect(
      readChecklistPageParams({ maxCandidatesPerCriterion: 0 }).maxCandidatesPerCriterion,
    ).toBe(1);
    expect(
      readChecklistPageParams({ maxCandidatesPerCriterion: 500 }).maxCandidatesPerCriterion,
    ).toBe(100);
  });

  it("floors fractional values", () => {
    const got = readChecklistPageParams({
      limit: 42.9,
      offset: 5.7,
      maxCandidatesPerCriterion: 8.4,
    });
    expect(got).toEqual({ limit: 42, offset: 5, maxCandidatesPerCriterion: 8 });
  });

  it("falls back to defaults on non-numeric input", () => {
    const got = readChecklistPageParams({
      limit: "200",
      offset: null,
      maxCandidatesPerCriterion: "10",
    });
    expect(got).toEqual({ limit: 200, offset: 0, maxCandidatesPerCriterion: 10 });
  });

  it("clamps negative offset to 0", () => {
    expect(readChecklistPageParams({ offset: -10 }).offset).toBe(0);
  });
});

describe("paginateChecklistItems — limit / offset axis", () => {
  it("returns everything with no pagination fields when the inventory fits", () => {
    const items = singleCandidateItems(50);
    const page = paginateChecklistItems(items, fullParams({ limit: 200 }));
    expect(page.items.length).toBe(50);
    expect(page.totalCandidates).toBe(50);
    // Honest-shape: fields absent, not `truncated: false`.
    expect(page.paginationFields.truncated).toBeUndefined();
    expect(page.paginationFields.nextOffset).toBeUndefined();
    expect(page.paginationFields.perCriterionClipped).toBeUndefined();
  });

  it("emits truncated + nextOffset when the global cap clips the list", () => {
    const items = singleCandidateItems(50);
    const page = paginateChecklistItems(items, fullParams({ limit: 10 }));
    expect(page.items.length).toBe(10);
    expect(page.totalCandidates).toBe(50);
    expect(page.paginationFields.truncated).toBe(true);
    expect(page.paginationFields.nextOffset).toBe(10);
    expect(page.paginationFields.perCriterionClipped).toBeUndefined();
  });

  it("drops truncated on the last page and preserves totalCandidates", () => {
    const items = singleCandidateItems(50);
    const page = paginateChecklistItems(items, fullParams({ limit: 10, offset: 40 }));
    expect(page.items.length).toBe(10);
    expect(page.totalCandidates).toBe(50);
    // Last page — no more to fetch, so truncated/nextOffset omitted.
    expect(page.paginationFields.truncated).toBeUndefined();
    expect(page.paginationFields.nextOffset).toBeUndefined();
  });

  it("works fine at the max-limit boundary (no off-by-one clamp fail)", () => {
    const items = singleCandidateItems(50);
    const page = paginateChecklistItems(items, fullParams({ limit: 2000 }));
    expect(page.items.length).toBe(50);
    expect(page.paginationFields.truncated).toBeUndefined();
  });

  it("paginates mid-item boundaries across a multi-candidate criterion", () => {
    // One item with 30 candidates (post-clip we'll set max=100 so no
    // per-criterion clipping kicks in), limit=5, offset=10 → middle 5.
    const items = [makeItem("wcag22:2.4.5", 30)];
    const page = paginateChecklistItems(
      items,
      fullParams({ limit: 5, offset: 10, maxCandidatesPerCriterion: 100 }),
    );
    expect(page.items.length).toBe(1);
    expect(page.items[0].candidates.length).toBe(5);
    expect(page.items[0].candidates[0].path).toBe("wcag22:2.4.5-10.tsx");
    expect(page.items[0].candidates[4].path).toBe("wcag22:2.4.5-14.tsx");
    expect(page.paginationFields.truncated).toBe(true);
    expect(page.paginationFields.nextOffset).toBe(15);
  });
});

describe("paginateChecklistItems — maxCandidatesPerCriterion axis", () => {
  it("clips a noisy criterion and flags perCriterionClipped", () => {
    // One criterion with 30 candidates, capped at 5.
    const items = [makeItem("wcag22:2.4.5", 30)];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 5 }));
    expect(page.items.length).toBe(1);
    expect(page.items[0].candidates.length).toBe(5);
    // totalCandidates reports the pre-clip count so the agent can see
    // how much was elided.
    expect(page.totalCandidates).toBe(30);
    expect(page.paginationFields.perCriterionClipped).toBe(true);
    // Per-criterion clip does NOT trigger `truncated` — that's the
    // different axis. (Here post-clip total is 5 which fits in 200.)
    expect(page.paginationFields.truncated).toBeUndefined();
    expect(page.paginationFields.nextOffset).toBeUndefined();
  });

  it("leaves perCriterionClipped absent when no item exceeds the cap", () => {
    const items = [makeItem("wcag22:1.4.3", 3), makeItem("wcag22:2.4.5", 5)];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 10 }));
    expect(page.paginationFields.perCriterionClipped).toBeUndefined();
    expect(page.totalCandidates).toBe(8);
  });

  it("perCriterionClipped and truncated are orthogonal — can coexist", () => {
    // 3 items, each with 30 candidates, cap 5 → post-clip 15 total.
    // Limit 10 → page has 10, 5 remain, truncated=true.
    const items = [
      makeItem("wcag22:1.4.3", 30),
      makeItem("wcag22:2.4.5", 30),
      makeItem("wcag22:3.3.1", 30),
    ];
    const page = paginateChecklistItems(
      items,
      fullParams({ limit: 10, maxCandidatesPerCriterion: 5 }),
    );
    expect(page.paginationFields.perCriterionClipped).toBe(true);
    expect(page.paginationFields.truncated).toBe(true);
    expect(page.paginationFields.nextOffset).toBe(10);
    // Pre-clip total is 90; totalCandidates reports that.
    expect(page.totalCandidates).toBe(90);
  });

  it("drops items entirely outside the offset window", () => {
    // 3 items x 5 candidates each post-clip; offset=7, limit=3 →
    // spans the end of item[1] (one candidate) + start of item[2]
    // (two candidates). item[0] is entirely skipped.
    const items = [
      makeItem("wcag22:1.4.3", 5),
      makeItem("wcag22:2.4.5", 5),
      makeItem("wcag22:3.3.1", 5),
    ];
    const page = paginateChecklistItems(
      items,
      fullParams({ limit: 3, offset: 7, maxCandidatesPerCriterion: 10 }),
    );
    // item[0] (indices 0..4) dropped.
    // item[1] (5..9): candidates 7, 8, 9 would be in range — but
    // limit=3 caps at index 9, so slice is 7..9 = 3 candidates.
    expect(page.items.length).toBe(1);
    expect(page.items[0].criterionId).toBe("wcag22:2.4.5");
    expect(page.items[0].candidates.length).toBe(3);
    expect(page.items[0].candidates[0].path).toBe("wcag22:2.4.5-2.tsx");
    expect(page.paginationFields.truncated).toBe(true);
    expect(page.paginationFields.nextOffset).toBe(10);
  });

  it("empty inventory yields empty page with no pagination fields", () => {
    const page = paginateChecklistItems([], fullParams());
    expect(page.items).toEqual([]);
    expect(page.totalCandidates).toBe(0);
    expect(page.paginationFields.truncated).toBeUndefined();
    expect(page.paginationFields.perCriterionClipped).toBeUndefined();
  });
});

describe("paginateChecklistItems — Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE effective-limit surface", () => {
  it("omits requestedLimit / effectiveLimit / pageClipReason when the whole inventory fits on page 1", () => {
    // Page 1, offset 0, whole thing fits → pagination is NOT active and
    // the honest shape omits the limit echo entirely. Cross-surface with
    // scan_project's paginateFiles (paginate-files.test.ts) where the
    // same invariant holds on the "one-page, no offset" branch.
    const items = singleCandidateItems(5);
    const page = paginateChecklistItems(items, fullParams({ limit: 200 }));
    expect(page.paginationFields.truncated).toBeUndefined();
    expect(page.paginationFields.requestedLimit).toBeUndefined();
    expect(page.paginationFields.effectiveLimit).toBeUndefined();
    expect(page.paginationFields.pageClipReason).toBeUndefined();
  });

  it("emits requestedLimit + effectiveLimit on a full mid-page without pageClipReason", () => {
    // limit 10, offset 0, 50 items × 1 candidate → page 1 returns 10,
    // truncated: true, pagination active. The full page carries
    // requestedLimit=10 + effectiveLimit=10 so consumers read one
    // shape on every paginated response; pageClipReason is omitted
    // because nothing clipped below the ask.
    const items = singleCandidateItems(50);
    const page = paginateChecklistItems(items, fullParams({ limit: 10 }));
    expect(page.paginationFields.truncated).toBe(true);
    expect(page.paginationFields.requestedLimit).toBe(10);
    expect(page.paginationFields.effectiveLimit).toBe(10);
    expect(page.paginationFields.pageClipReason).toBeUndefined();
  });

  it("emits pageClipReason: 'end_of_results' on the last page when the tail ran out", () => {
    // offset 40, limit 20, 50 items × 1 candidate → 10 candidates
    // returned. No more pages (not truncated) but effective (10) <
    // requested (20), so pageClipReason names the regime. Same
    // vocabulary as scan_project paginateFiles.
    const items = singleCandidateItems(50);
    const page = paginateChecklistItems(items, fullParams({ limit: 20, offset: 40 }));
    expect(page.items.length).toBe(10);
    expect(page.paginationFields.truncated).toBeUndefined();
    expect(page.paginationFields.requestedLimit).toBe(20);
    expect(page.paginationFields.effectiveLimit).toBe(10);
    expect(page.paginationFields.pageClipReason).toBe("end_of_results");
  });

  it("emits pageClipReason: 'per_criterion_cap' when per-criterion clipping brought the page below the ask", () => {
    // 1 criterion × 30 candidates, cap 5 (post-clip total = 5),
    // limit 10, offset 0 → returned 5, not truncated (5 < 10 fits),
    // perCriterionClipped true. `effectiveLimit: 5 < requestedLimit:
    // 10`, so pageClipReason fires as `per_criterion_cap` — the
    // proximate cause is the per-criterion cap, not the end of the
    // inventory (the inventory has 30 total). Same three-regime
    // vocabulary as scan_project.
    const items = [makeItem("wcag22:2.4.5", 30)];
    const page = paginateChecklistItems(
      items,
      fullParams({ limit: 10, maxCandidatesPerCriterion: 5 }),
    );
    expect(page.items.length).toBe(1);
    expect(page.items[0].candidates.length).toBe(5);
    expect(page.paginationFields.truncated).toBeUndefined();
    expect(page.paginationFields.perCriterionClipped).toBe(true);
    expect(page.paginationFields.requestedLimit).toBe(10);
    expect(page.paginationFields.effectiveLimit).toBe(5);
    expect(page.paginationFields.pageClipReason).toBe("per_criterion_cap");
  });
});

describe("paginateChecklistItems — end-to-end via readChecklistPageParams", () => {
  it("clamped inputs flow through: limit:0 → 1-item truncated page; limit:3000 clamps to 2000", () => {
    const items = singleCandidateItems(50);
    const pageLow = paginateChecklistItems(items, readChecklistPageParams({ limit: 0 }));
    // limit clamps to 1 → 1 item returned, truncated=true.
    expect(pageLow.items.length).toBe(1);
    expect(pageLow.paginationFields.truncated).toBe(true);
    expect(pageLow.paginationFields.nextOffset).toBe(1);
    // 3000 clamps to 2000, comfortably fits 50 items → no truncation.
    const pageHigh = paginateChecklistItems(items, readChecklistPageParams({ limit: 3000 }));
    expect(pageHigh.items.length).toBe(50);
    expect(pageHigh.paginationFields.truncated).toBeUndefined();
  });
});

/**
 * the per-criterion elision
 * resume-token contract. Orthogonal to the flat-stream `limit`/`offset`
 * axis: when a criterion's candidate list is clipped by
 * `maxCandidatesPerCriterion`, the response emits an opaque `nextCursor`
 * (`{ afterCriterion, afterCandidateIndex }`) that, passed back verbatim,
 * resumes INSIDE that criterion at the next candidate. Three branches:
 *   (a) small response, nothing clipped → no cursor, no warning.
 *   (b) per-criterion clip → cursor emitted; round-trip fetches the tail.
 *   (c) cursor input honored → the pager resumes at the named criterion.
 */
describe("paginateChecklistItems — per-criterion cursor resume", () => {
  it("does not emit nextCursor when response fits (no per-criterion clip)", () => {
    // 5 items × 3 candidates each, cap 10 → nothing clipped. The
    // cursor rides on the per-criterion axis; it MUST stay absent
    // when no elision happened so the agent doesn't re-page after a
    // clean scan. Honest-shape: absent, not `nextCursor: null`.
    const items = [
      makeItem("wcag22:1.4.3", 3),
      makeItem("wcag22:2.4.5", 3),
      makeItem("wcag22:3.3.1", 3),
    ];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 10 }));
    expect(page.paginationFields.perCriterionClipped).toBeUndefined();
    expect(page.paginationFields.nextCursor).toBeUndefined();
    expect(page.items.length).toBe(3);
  });

  it("emits nextCursor pointing at the first clipped criterion when per-criterion cap fires", () => {
    // 3 items × 30 candidates, cap 5 → each criterion clipped to 5.
    // Cursor points at the FIRST clipped criterion's last served
    // index (4, since cap=5 means candidates 0..4 shipped). A later
    // resume will start at index 5.
    const items = [
      makeItem("wcag22:1.4.3", 30),
      makeItem("wcag22:2.4.5", 30),
      makeItem("wcag22:3.3.1", 30),
    ];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 5 }));
    expect(page.paginationFields.perCriterionClipped).toBe(true);
    expect(page.paginationFields.nextCursor).toEqual({
      afterCriterion: "wcag22:1.4.3",
      afterCandidateIndex: 4,
    });
  });

  // when `nextCursor` is emitted,
  // `nextCursorClipDetails` ships alongside it with the load-bearing
  // scalars an agent reading the warning channel needs (criterionId,
  // clippedAt, totalAvailable). The two surfaces are populated together
  // so cross-channel readers (top-level pagination block, warning
  // details payload) never disagree on which criterion the cursor
  // names. Closes the "Empty `warningsDetails.<code>: {}` is dishonest"
  // case for `results_truncated_use_nextcursor`.
  it("populates nextCursorClipDetails alongside nextCursor on the initial branch", () => {
    const items = [makeItem("wcag22:2.4.5", 30)];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 5 }));
    expect(page.paginationFields.nextCursor).toEqual({
      afterCriterion: "wcag22:2.4.5",
      afterCandidateIndex: 4,
    });
    expect(page.paginationFields.nextCursorClipDetails).toEqual({
      criterionId: "wcag22:2.4.5",
      clippedAt: 5,
      totalAvailable: 30,
    });
  });

  // Resume branch parity: when `paginateChecklistResume` re-emits a
  // `nextCursor` because the tail still overflows the cap, the paired
  // `nextCursorClipDetails` carries the SAME criterion + the new clip
  // boundaries (clippedAt = post-resume slice end, totalAvailable =
  // criterion's full pre-clip count). Same shape as the initial branch
  // so consumers don't branch on which path emitted the cursor.
  it("populates nextCursorClipDetails on the resume branch with the same shape", () => {
    const items = [makeItem("wcag22:2.4.5", 30)];
    const page1 = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 5 }));
    const cursor = page1.paginationFields.nextCursor;
    expect(cursor).toBeDefined();
    const page2 = paginateChecklistItems(
      items,
      fullParams({ maxCandidatesPerCriterion: 5, ...(cursor ? { cursor } : {}) }),
    );
    expect(page2.paginationFields.nextCursor).toEqual({
      afterCriterion: "wcag22:2.4.5",
      afterCandidateIndex: 9,
    });
    expect(page2.paginationFields.nextCursorClipDetails).toEqual({
      criterionId: "wcag22:2.4.5",
      clippedAt: 10,
      totalAvailable: 30,
    });
  });

  // Honest-shape: absent when nothing clipped (parallel to nextCursor).
  it("omits nextCursorClipDetails when nothing was per-criterion clipped", () => {
    const items = [makeItem("wcag22:1.4.3", 3), makeItem("wcag22:2.4.5", 5)];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 10 }));
    expect(page.paginationFields.nextCursor).toBeUndefined();
    expect(page.paginationFields.nextCursorClipDetails).toBeUndefined();
  });

  it("round-trip: page 1 nextCursor → page 2 cursor resumes the elided tail", () => {
    // 30 candidates on one criterion, cap 5. Page 1 serves [0..4],
    // emits nextCursor {afterCandidateIndex:4}. Page 2 with that
    // cursor serves [5..9] — the next 5 of the pre-clip stream.
    // Inventory-wide totalCandidates stays 30 on both pages; the
    // agent's headline count is stable.
    const items = [makeItem("wcag22:2.4.5", 30)];
    const page1 = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 5 }));
    expect(page1.items[0].candidates.length).toBe(5);
    expect(page1.items[0].candidates[0].path).toBe("wcag22:2.4.5-0.tsx");
    expect(page1.items[0].candidates[4].path).toBe("wcag22:2.4.5-4.tsx");
    const cursor = page1.paginationFields.nextCursor;
    expect(cursor).toBeDefined();
    const page2 = paginateChecklistItems(
      items,
      fullParams({
        maxCandidatesPerCriterion: 5,
        ...(cursor ? { cursor } : {}),
      }),
    );
    expect(page2.items.length).toBe(1);
    expect(page2.items[0].criterionId).toBe("wcag22:2.4.5");
    expect(page2.items[0].candidates.length).toBe(5);
    expect(page2.items[0].candidates[0].path).toBe("wcag22:2.4.5-5.tsx");
    expect(page2.items[0].candidates[4].path).toBe("wcag22:2.4.5-9.tsx");
    // Page 2 still has more tail (10..29) — the cursor threads forward.
    expect(page2.paginationFields.nextCursor).toEqual({
      afterCriterion: "wcag22:2.4.5",
      afterCandidateIndex: 9,
    });
    expect(page2.totalCandidates).toBe(30);
  });

  it("round-trip terminates: last cursor call yields the tail without a further cursor", () => {
    // 12 candidates, cap 5 → three pages: [0..4], [5..9], [10..11].
    // The final page's resumeEnd equals total length, so no further
    // nextCursor is emitted — the agent reads absence as "you have
    // everything on this criterion." Honest-shape terminator.
    const items = [makeItem("wcag22:2.4.5", 12)];
    const page1 = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 5 }));
    const cursor1 = page1.paginationFields.nextCursor;
    expect(cursor1).toEqual({ afterCriterion: "wcag22:2.4.5", afterCandidateIndex: 4 });
    const page2 = paginateChecklistItems(
      items,
      fullParams({
        maxCandidatesPerCriterion: 5,
        ...(cursor1 ? { cursor: cursor1 } : {}),
      }),
    );
    const cursor2 = page2.paginationFields.nextCursor;
    expect(cursor2).toEqual({ afterCriterion: "wcag22:2.4.5", afterCandidateIndex: 9 });
    const page3 = paginateChecklistItems(
      items,
      fullParams({
        maxCandidatesPerCriterion: 5,
        ...(cursor2 ? { cursor: cursor2 } : {}),
      }),
    );
    expect(page3.items[0].candidates.length).toBe(2);
    expect(page3.items[0].candidates[0].path).toBe("wcag22:2.4.5-10.tsx");
    expect(page3.items[0].candidates[1].path).toBe("wcag22:2.4.5-11.tsx");
    expect(page3.paginationFields.nextCursor).toBeUndefined();
  });

  it("cursor resume yields empty page with no nextCursor when the criterion no longer exists", () => {
    // Ranker-order drift or skipCriterion can drop the criterion the
    // cursor named. The honest fallback is empty page + no cursor —
    // the caller re-queries from scratch. We don't error because the
    // cursor is opaque to the caller and drift is a tool-side concern.
    const items = [makeItem("wcag22:1.4.3", 5)];
    const page = paginateChecklistItems(
      items,
      fullParams({
        maxCandidatesPerCriterion: 5,
        cursor: { afterCriterion: "wcag22:2.4.5", afterCandidateIndex: 4 },
      }),
    );
    expect(page.items).toEqual([]);
    expect(page.paginationFields.nextCursor).toBeUndefined();
    // totalCandidates still reports the full inventory so the agent
    // can detect that the criterion count drifted.
    expect(page.totalCandidates).toBe(5);
  });

  /**
   * when the per-criterion
   * cap clips at least one criterion, the response carries
   * `maxCandidatesPerCriterionHint: N` so the caller can raise the
   * input param to a useful target in one shot instead of paginating
   * through `nextCursor`. The hint is `min(largestUncappedCount, 100)`
   * — the noisiest criterion's pre-clip count, capped by the input
   * band's ceiling. Honest-shape: absent when nothing was clipped.
   */
  it("emits maxCandidatesPerCriterionHint when per-criterion cap fires (default 10)", () => {
    // 84-candidate criterion, cap defaults to 10. Hint should be 84
    // (the largest uncapped count, well below the 100 ceiling) so the
    // caller knows raising to 84 covers the elided tail.
    const items = [makeItem("wcag22:1.3.2", 84)];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 10 }));
    expect(page.paginationFields.perCriterionClipped).toBe(true);
    expect(page.paginationFields.maxCandidatesPerCriterionHint).toBe(84);
  });

  it("caps the hint at the input band's ceiling (100)", () => {
    // 250 candidates with cap 10 → hint clamps at 100, not 250. Lets
    // the caller pass it back as maxCandidatesPerCriterion without
    // tripping the silent-clamp warning.
    const items = [makeItem("wcag22:1.3.2", 250)];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 10 }));
    expect(page.paginationFields.perCriterionClipped).toBe(true);
    expect(page.paginationFields.maxCandidatesPerCriterionHint).toBe(100);
  });

  it("hint picks the noisiest criterion across multiple clipped items", () => {
    // Three clipped criteria with 30, 50, 20 candidates respectively;
    // hint should be 50 (the largest), not 30 (the first) — the agent's
    // question is "how high to set this to see everything?" — answered
    // by the loudest criterion.
    const items = [
      makeItem("wcag22:1.4.3", 30),
      makeItem("wcag22:2.4.5", 50),
      makeItem("wcag22:3.3.1", 20),
    ];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 5 }));
    expect(page.paginationFields.perCriterionClipped).toBe(true);
    expect(page.paginationFields.maxCandidatesPerCriterionHint).toBe(50);
  });

  it("omits the hint when no criterion exceeds the cap (honest-shape)", () => {
    // Nothing clipped → no hint. Absent, not 0 or null.
    const items = [makeItem("wcag22:1.4.3", 3), makeItem("wcag22:2.4.5", 5)];
    const page = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 10 }));
    expect(page.paginationFields.perCriterionClipped).toBeUndefined();
    expect(page.paginationFields.maxCandidatesPerCriterionHint).toBeUndefined();
  });

  it("caller-supplied maxCandidatesPerCriterion: 50 is honored within the [1, 100] band", () => {
    // Acceptance-test the documented input band: caller asks for 50
    // (above default 10, below ceiling 100), no clamp warning, no
    // silent override. 60 candidates with cap 50 → 50 ship, hint=60.
    const items = [makeItem("wcag22:1.3.2", 60)];
    const params = readChecklistPageParams({ maxCandidatesPerCriterion: 50 });
    expect(params.maxCandidatesPerCriterion).toBe(50);
    const page = paginateChecklistItems(items, params);
    expect(page.items[0]?.candidates.length).toBe(50);
    expect(page.paginationFields.perCriterionClipped).toBe(true);
    expect(page.paginationFields.maxCandidatesPerCriterionHint).toBe(60);
  });

  it("default maxCandidatesPerCriterion is at most 20 (V1 default-lower invariant)", () => {
    // The acceptance criterion: the default must stay ≤ 20 so a bulk
    // catalog scan can't blow the MCP host token budget on a single
    // noisy criterion. Pin the invariant so a future bump is a
    // conscious choice, not a drive-by.
    const params = readChecklistPageParams({});
    expect(params.maxCandidatesPerCriterion).toBeLessThanOrEqual(20);
  });

  it("resume branch carries the hint when more tail remains", () => {
    // 30 candidates, cap 5. Page 2 cursor-resume yields [5..9] with
    // [10..29] still pending; hint = min(30, 100) = 30 so the agent
    // can switch to a one-shot deep-cut instead of three more cursor
    // round-trips.
    const items = [makeItem("wcag22:2.4.5", 30)];
    const page1 = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 5 }));
    const cursor = page1.paginationFields.nextCursor;
    expect(cursor).toBeDefined();
    const page2 = paginateChecklistItems(
      items,
      fullParams({
        maxCandidatesPerCriterion: 5,
        ...(cursor ? { cursor } : {}),
      }),
    );
    expect(page2.paginationFields.nextCursor).toBeDefined();
    expect(page2.paginationFields.maxCandidatesPerCriterionHint).toBe(30);
  });

  it("resume branch omits the hint when the criterion is fully drained", () => {
    // 7 candidates, cap 5. Page 2 cursor-resume yields [5..6] — the
    // criterion is fully drained, no further nextCursor, no hint
    // (absent rather than 7, since the agent has everything already).
    const items = [makeItem("wcag22:2.4.5", 7)];
    const page1 = paginateChecklistItems(items, fullParams({ maxCandidatesPerCriterion: 5 }));
    const cursor = page1.paginationFields.nextCursor;
    expect(cursor).toBeDefined();
    const page2 = paginateChecklistItems(
      items,
      fullParams({
        maxCandidatesPerCriterion: 5,
        ...(cursor ? { cursor } : {}),
      }),
    );
    expect(page2.paginationFields.nextCursor).toBeUndefined();
    expect(page2.paginationFields.maxCandidatesPerCriterionHint).toBeUndefined();
  });

  it("readChecklistPageParams parses a valid cursor and drops malformed shapes", () => {
    // Valid cursor threads through.
    const got = readChecklistPageParams({
      cursor: { afterCriterion: "wcag22:2.4.5", afterCandidateIndex: 9 },
    });
    expect(got.cursor).toEqual({ afterCriterion: "wcag22:2.4.5", afterCandidateIndex: 9 });
    // Missing fields → dropped entirely (not partially applied). A
    // partially-applied cursor would silently skip candidates, which
    // the honest-shape rule treats as worse than "no cursor."
    expect(readChecklistPageParams({ cursor: {} }).cursor).toBeUndefined();
    expect(
      readChecklistPageParams({ cursor: { afterCriterion: "wcag22:2.4.5" } }).cursor,
    ).toBeUndefined();
    // Negative index → dropped.
    expect(
      readChecklistPageParams({
        cursor: { afterCriterion: "wcag22:2.4.5", afterCandidateIndex: -1 },
      }).cursor,
    ).toBeUndefined();
    // Fractional index → floored (resume still works predictably).
    expect(
      readChecklistPageParams({
        cursor: { afterCriterion: "wcag22:2.4.5", afterCandidateIndex: 4.9 },
      }).cursor,
    ).toEqual({ afterCriterion: "wcag22:2.4.5", afterCandidateIndex: 4 });
  });
});
