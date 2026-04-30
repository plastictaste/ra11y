/**
 * Unit tests for `dedupeReviewCandidatesForSingleFile`. Two passes:
 *
 *   Pass 1 (within-finder cross-standard fold) collapses per-criterion
 *   copies a single finder emits with identical reason text — the
 *   `wcag22:1.3.6` + `wcag21:1.3.6` pair from `review/identify-purpose`
 *   on the same `<input>` is the canonical shape. Pre-fold N entries,
 *   post-fold one with `criteria` carrying both IDs.
 *
 *   Pass 2 (cross-finder positional fold) collapses entries from
 *   distinct finders that emit at the same `(line, column)` for
 *   genuinely different criteria. Canonical shape: `<input
 *   type="password">` triggers BOTH `review/identify-purpose` (1.3.6)
 *   AND `review/password-inputs` (3.3.8) at the same byte position;
 *   pre-fold the agent saw two entries with different reasons,
 *   post-fold one entry with `criteria` listing both standards and
 *   `reason` concatenating the per-finder framings via `" | "` so
 *   each finder's WCAG-specific guidance survives.
 *
 * The asymmetry the dedup fixes: `checklist.items[].candidates`
 * already annotates cross-criterion sharing via `criteria: [...]` on
 * every instance per `annotateSharedCandidates`. Without Pass 2,
 * `scan_file.reviewCandidates` shipped the same line under N
 * different reasons in one tool and under one merged badge in the
 * other — a cross-surface drift the AI-first consumer model warns
 * against.
 */

import { describe, expect, it } from "bun:test";
import { dedupeReviewCandidatesForSingleFile } from "../../../src/mcp/review-candidate-dedup.ts";
import type { ReviewCandidate } from "../../../src/types/review.ts";

const FILE = "/repo/page.html";

function candidate(
  criterionId: string,
  reason: string,
  line: number,
  column: number,
  extras: Partial<ReviewCandidate> = {},
): ReviewCandidate {
  return {
    criterionId,
    location: { filePath: FILE, line, column },
    reason,
    confidence: "medium",
    ...extras,
  } satisfies ReviewCandidate;
}

describe("dedupeReviewCandidatesForSingleFile — Pass 1 (within-finder cross-standard fold)", () => {
  it("collapses per-criterion copies with identical reason into one entry", () => {
    const r = "<input> no autocomplete attribute";
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("wcag22:1.3.6", r, 5, 4),
      candidate("wcag21:1.3.6", r, 5, 4),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.criteria).toEqual(["wcag21:1.3.6", "wcag22:1.3.6"]);
    expect(out[0]?.reason).toBe(r);
  });

  it("keeps entries with different reasons as distinct collapsed groups (when positions differ)", () => {
    // images-of-text emits a logotype-exemption hint on 1.4.5 that 1.4.9
    // doesn't carry — these are genuine per-criterion reason variants.
    // When positions differ, both entries survive distinct.
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("wcag22:1.4.5", "image-of-text — logotype exemption may apply", 3, 2),
      candidate("wcag22:1.4.9", "image-of-text — strict no-text-rendering", 9, 4),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("dedupeReviewCandidatesForSingleFile — Pass 2 (cross-finder positional fold)", () => {
  it("folds two finders at the same (line, column) with different reasons into one entry", () => {
    // Canonical case: `<input type="password">` at line 7, column 2
    // triggers `review/identify-purpose` for 1.3.6 and
    // `review/password-inputs` for 3.3.8.
    const reasonAutocomplete =
      "<input> no autocomplete attribute — if this control collects information matching a WCAG Input Purpose, set autocomplete=...";
    const reasonAuth =
      '<input type="password" name="pw"> — autocomplete attribute missing — verify that the authentication step does not rely solely on a cognitive function test';
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("wcag22:1.3.6", reasonAutocomplete, 7, 2),
      candidate("wcag21:1.3.6", reasonAutocomplete, 7, 2),
      candidate("wcag22:3.3.8", reasonAuth, 7, 2),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.criteria).toEqual(["wcag21:1.3.6", "wcag22:1.3.6", "wcag22:3.3.8"]);
    // Reason text concatenates with " | " so each finder's framing
    // survives. Order = first-seen by within-finder collapse.
    expect(out[0]?.reason).toBe(`${reasonAutocomplete} | ${reasonAuth}`);
  });

  it("keeps entries at different positions distinct even when reasons share fragments", () => {
    // Two password inputs on different lines must stay separate — the
    // positional fold only collapses the same byte position, never
    // across lines.
    const r = '<input type="password">';
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("wcag22:3.3.8", r, 5, 2),
      candidate("wcag22:3.3.8", r, 12, 2),
    ]);
    expect(out).toHaveLength(2);
  });

  it("idempotent: running pass 2 on already-merged data does not duplicate the reason fragment", () => {
    const a = "reason A";
    const b = "reason B";
    // Three finders at the same position; second and third both
    // contribute new reasons. Reason should be `A | B | C`, NOT
    // `A | B | A | B | C` after multiple round-trips.
    const c = "reason C";
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("std:a", a, 4, 0),
      candidate("std:b", b, 4, 0),
      candidate("std:c", c, 4, 0),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe(`${a} | ${b} | ${c}`);
    expect(out[0]?.criteria).toEqual(["std:a", "std:b", "std:c"]);
  });

  it("back-fills structured evidence (vendorPathHint, durationLiteralMs, snippet) from later finders", () => {
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("std:a", "reason A", 4, 0),
      candidate("std:b", "reason B", 4, 0, {
        vendorPathHint: true,
        durationLiteralMs: 2000,
        snippet: '<button onclick="...">',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.vendorPathHint).toBe(true);
    expect(out[0]?.durationLiteralMs).toBe(2000);
    expect(out[0]?.snippet).toBe('<button onclick="...">');
  });

  it("back-fills durationExpression from a later finder when the first carries no duration evidence", () => {
    // Mirror of the durationLiteralMs back-fill: the non-literal
    // sibling string field must traverse the cross-finder fold the
    // same way so that an agent reading the deduped surface sees the
    // verbatim expression regardless of which finder contributed it.
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("std:a", "reason A", 4, 0),
      candidate("std:b", "reason B", 4, 0, {
        durationExpression: "self.options.interval",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.durationExpression).toBe("self.options.interval");
    // Single-typed channels: literal field stays absent because no
    // numeric literal was observed at this site.
    expect(out[0]?.durationLiteralMs).toBeUndefined();
  });

  it("preserves first-seen order across pass 2 folds", () => {
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("std:a", "rA", 5, 0),
      candidate("std:b", "rB", 9, 0),
      candidate("std:c", "rC", 5, 0), // folds with first
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.line).toBe(5);
    expect(out[1]?.line).toBe(9);
  });
});

describe("dedupeReviewCandidatesForSingleFile — priority and confidence", () => {
  it("populates priority + confidence from the shared resolver (defaults to medium when no level map supplied)", () => {
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("wcag22:1.4.3", "ordinary reason", 5, 4),
    ]);
    expect(out).toHaveLength(1);
    // No level map → resolver's no-level base → "medium"
    expect(out[0]?.priority).toBe("medium");
    expect(out[0]?.confidence).toBe("medium");
  });

  it("resolves priority from the criterionLevels map (AA → high)", () => {
    const levels = new Map<string, string>([["wcag22:1.4.3", "AA"]]);
    const out = dedupeReviewCandidatesForSingleFile(
      [candidate("wcag22:1.4.3", "ordinary reason", 5, 4)],
      levels,
    );
    expect(out[0]?.priority).toBe("high");
  });

  it("downgrades priority to medium when the candidate carries vendorContext", () => {
    const levels = new Map<string, string>([["wcag22:2.2.1", "A"]]);
    const out = dedupeReviewCandidatesForSingleFile(
      [
        candidate("wcag22:2.2.1", "vendor lib timer", 5, 4, {
          vendorContext: {
            signal: { kind: "vendor-bundle-basename" },
          },
        }),
      ],
      levels,
    );
    expect(out[0]?.priority).toBe("medium");
  });

  it("downgrades priority to medium when the reason text hedges", () => {
    const levels = new Map<string, string>([["wcag22:1.3.1", "A"]]);
    const out = dedupeReviewCandidatesForSingleFile(
      [
        candidate(
          "wcag22:1.3.1",
          "if this is a standalone single-page file the criterion may not apply",
          5,
          4,
        ),
      ],
      levels,
    );
    expect(out[0]?.priority).toBe("medium");
  });

  it("takes the strongest-attention level across the union of criteria (mixed AA + AAA → AA → high)", () => {
    const levels = new Map<string, string>([
      ["wcag22:1.4.3", "AA"],
      ["wcag22:1.4.6", "AAA"],
    ]);
    // Same reason → Pass 1 collapses both into one entry; the union
    // criteria carries AA + AAA. The strongest-attention level is AA
    // → priority "high".
    const out = dedupeReviewCandidatesForSingleFile(
      [
        candidate("wcag22:1.4.3", "same reason", 7, 2),
        candidate("wcag22:1.4.6", "same reason", 7, 2),
      ],
      levels,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.priority).toBe("high");
  });

  it("takes the highest confidence across the cross-finder fold (Pass 2)", () => {
    const levels = new Map<string, string>([
      ["std:a", "AA"],
      ["std:b", "AA"],
    ]);
    // Two finders at the same position; one carries low confidence,
    // the other high. The folded entry takes "high" — a single high
    // hit sizes the entry honestly.
    const out = dedupeReviewCandidatesForSingleFile(
      [
        candidate("std:a", "reason A", 7, 2, { confidence: "low" }),
        candidate("std:b", "reason B", 7, 2, { confidence: "high" }),
      ],
      levels,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe("high");
  });
});
