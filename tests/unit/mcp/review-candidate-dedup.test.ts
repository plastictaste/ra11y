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
import {
  dedupeReviewCandidatesByReason,
  dedupeReviewCandidatesForSingleFile,
  filterCandidatesCoveredByFindings,
} from "../../../src/mcp/review-candidate-dedup.ts";
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

  it("populates findingId via location-coordinate hash with sorted-criteria-joined ruleId slot", () => {
    // Two finders at the same byte position fold to one entry. The
    // emitted findingId must be deterministic from the sorted-criteria
    // union + path + line + column — that's the canonical recipe the
    // shared `computeCandidateFindingId` helper applies on every
    // surface that ships review candidates. Per AI-first doctrine
    // "Per-finding identifiers must be addressable, not collision-
    // prone."
    const out = dedupeReviewCandidatesForSingleFile([
      candidate("wcag22:1.3.6", "reason A", 7, 2),
      candidate("wcag22:3.3.8", "reason B", 7, 2),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.findingId).toBeDefined();
    // Length is the FINDING_ID_LENGTH (12) hex chars used by the
    // rule surface — the shared helper preserves that contract.
    expect(out[0]?.findingId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("findingId distinguishes two candidates that differ only by line", () => {
    const a = dedupeReviewCandidatesForSingleFile([candidate("wcag22:3.3.8", "r", 5, 2)]);
    const b = dedupeReviewCandidatesForSingleFile([candidate("wcag22:3.3.8", "r", 12, 2)]);
    expect(a[0]?.findingId).not.toBe(b[0]?.findingId);
  });

  it("findingId is stable across runs of the same input", () => {
    const a = dedupeReviewCandidatesForSingleFile([candidate("wcag22:3.3.8", "r", 7, 2)]);
    const b = dedupeReviewCandidatesForSingleFile([candidate("wcag22:3.3.8", "r", 7, 2)]);
    expect(a[0]?.findingId).toBe(b[0]?.findingId);
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

describe("dedupeReviewCandidatesForSingleFile — minified-vendor-no-sourcemap stamp", () => {
  it("drops priority to 'low' and stamps couldBeWrongBecause when path is in buildArtifactPaths AND vendorPathHint is true", () => {
    // The two-component gate (vendorPathHint + path-in-build-artifact-set)
    // composes both channels at the materializer: priority drops to "low"
    // AND `couldBeWrongBecause` lands as
    // `["minified_vendor_no_sourcemap"]` so the agent reads the budget
    // signal AND the predicate-strength concession from one entry. Per
    // doctrine "Reason / priority / fix-description must agree across
    // all three channels."
    const levels = new Map<string, string>([["wcag22:2.2.1", "A"]]);
    const buildArtifactPaths = new Set([FILE]);
    const out = dedupeReviewCandidatesForSingleFile(
      [candidate("wcag22:2.2.1", "setTimeout call", 5, 2, { vendorPathHint: true })],
      levels,
      buildArtifactPaths,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.priority).toBe("low");
    expect(out[0]?.couldBeWrongBecause).toEqual(["minified_vendor_no_sourcemap"]);
  });

  it("vendorPathHint without buildArtifactPaths membership keeps priority, omits couldBeWrongBecause", () => {
    // First leg fires but the second does not — a hand-readable vendor
    // file the build-artifact classifier did not flag. Stays "high"
    // (no other gates trigger), and `couldBeWrongBecause` is omitted
    // entirely per CLAUDE.md §1 "Ambiguous field shapes are dishonest."
    const levels = new Map<string, string>([["wcag22:2.2.1", "A"]]);
    const buildArtifactPaths = new Set<string>(); // empty
    const out = dedupeReviewCandidatesForSingleFile(
      [candidate("wcag22:2.2.1", "setTimeout call", 5, 2, { vendorPathHint: true })],
      levels,
      buildArtifactPaths,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.priority).toBe("high");
    expect(out[0]?.couldBeWrongBecause).toBeUndefined();
  });

  it("buildArtifactPaths membership without vendorPathHint keeps existing gates' behavior", () => {
    // Symmetric: the candidate's path is classified as a build artifact
    // (e.g. an authored CSS file the bundler tagged) but the finder
    // didn't populate vendorPathHint — the gate doesn't fire because
    // the predicate-strength concession the gate names ("can't resolve
    // without a sourcemap") only applies to vendor-shape evidence.
    const levels = new Map<string, string>([["wcag22:2.2.1", "A"]]);
    const buildArtifactPaths = new Set([FILE]);
    const out = dedupeReviewCandidatesForSingleFile(
      [candidate("wcag22:2.2.1", "setTimeout call", 5, 2)],
      levels,
      buildArtifactPaths,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.priority).toBe("high");
    expect(out[0]?.couldBeWrongBecause).toBeUndefined();
  });
});

describe("dedupeReviewCandidatesByReason — cross-criterion fold for the by-row surface", () => {
  // The by-row review-candidates surface uses Pass-1-only semantics:
  // same finder, same evidence, distinct criteria fold; cross-finder
  // coincidences at the same `(line, column)` with different reasons
  // stay distinct so each finder's WCAG-specific framing survives.
  // The per-position surfaces (`scan_file.reviewCandidates[]` /
  // `scan_project.reviewCandidates[]`) collapse cross-finder hits via
  // `dedupeReviewCandidatesForSingleFile`'s Pass 2 because that surface
  // is a per-position tree rather than a flat by-row list.

  it("folds N per-criterion copies of one finder into one row carrying every covered criterion", () => {
    const r = "<input> no autocomplete attribute";
    const out = dedupeReviewCandidatesByReason([
      candidate("wcag22:1.3.6", r, 5, 4),
      candidate("wcag21:1.3.6", r, 5, 4),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.criteria).toEqual(["wcag21:1.3.6", "wcag22:1.3.6"]);
    // Sorted-first canonical: matches the per-position surfaces so the
    // canonical `criterionId` slot reads identically across surface
    // families.
    expect(out[0]?.criterionId).toBe("wcag21:1.3.6");
    expect(out[0]?.reason).toBe(r);
  });

  it("keeps cross-finder coincidences at the same (line, column) as distinct rows when reasons differ", () => {
    // Pass-1-only: the by-row surface is a flat list, not a per-
    // position tree, so each finder's WCAG-specific framing survives
    // as its own row. (The per-position surface collapses these via
    // Pass 2 because that surface only carries one entry per byte
    // position.)
    const out = dedupeReviewCandidatesByReason([
      candidate("wcag22:1.3.6", "reason A", 7, 2),
      candidate("wcag22:3.3.8", "reason B", 7, 2),
    ]);
    expect(out).toHaveLength(2);
  });

  it("operates across multiple files in one call", () => {
    const fileA = "/repo/a.html";
    const fileB = "/repo/b.html";
    const out = dedupeReviewCandidatesByReason([
      // File A: two per-criterion copies of one finder fold to 1 row.
      {
        criterionId: "wcag22:1.3.6",
        location: { filePath: fileA, line: 5, column: 4 },
        reason: "<input> no autocomplete attribute",
        confidence: "medium",
      },
      {
        criterionId: "wcag21:1.3.6",
        location: { filePath: fileA, line: 5, column: 4 },
        reason: "<input> no autocomplete attribute",
        confidence: "medium",
      },
      // File B: one row, distinct evidence — survives.
      {
        criterionId: "wcag22:3.3.8",
        location: { filePath: fileB, line: 7, column: 2 },
        reason: '<input type="password">',
        confidence: "medium",
      },
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((c) => c.location.filePath === fileA);
    const b = out.find((c) => c.location.filePath === fileB);
    expect(a?.criteria).toEqual(["wcag21:1.3.6", "wcag22:1.3.6"]);
    expect(b?.criteria).toEqual(["wcag22:3.3.8"]);
  });

  it("does NOT fold candidates at the same (line, column) across different files (multi-file safety)", () => {
    // Latent-issue guard: the per-position helper folds by (line,
    // column) without filePath in its key, which would silently merge
    // two distinct files' rows on the same line/column. The by-row
    // helper buckets by filePath first so this collision cannot occur.
    const fileA = "/repo/a.html";
    const fileB = "/repo/b.html";
    const out = dedupeReviewCandidatesByReason([
      {
        criterionId: "wcag22:1.3.6",
        location: { filePath: fileA, line: 5, column: 4 },
        reason: "same reason",
        confidence: "medium",
      },
      {
        criterionId: "wcag22:1.3.6",
        location: { filePath: fileB, line: 5, column: 4 },
        reason: "same reason",
        confidence: "medium",
      },
    ]);
    expect(out).toHaveLength(2);
  });

  it("preserves singleton candidates with criteria of length 1", () => {
    // No fold — `criteria` length-1 still ships, but the wire-shape
    // mapper at the surface layer omits the field per CLAUDE.md §1.
    const out = dedupeReviewCandidatesByReason([
      candidate("wcag22:2.2.1", "setTimeout call", 5, 2),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.criteria).toEqual(["wcag22:2.2.1"]);
    expect(out[0]?.criterionId).toBe("wcag22:2.2.1");
  });

  it("passes through finder-level fingerprints (handlerFunctionName, dismissalKey, couldBeWrongBecause)", () => {
    const r = "<button onClick={navigateToUrl}>";
    const out = dedupeReviewCandidatesByReason([
      candidate("wcag22:1.3.6", r, 5, 4, {
        handlerFunctionName: "navigateToUrl",
        dismissalKey: "abc12345",
        couldBeWrongBecause: ["minified_vendor_no_sourcemap"],
      }),
      candidate("wcag21:1.3.6", r, 5, 4, {
        handlerFunctionName: "navigateToUrl",
        dismissalKey: "abc12345",
        couldBeWrongBecause: ["minified_vendor_no_sourcemap"],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.handlerFunctionName).toBe("navigateToUrl");
    expect(out[0]?.dismissalKey).toBe("abc12345");
    expect(out[0]?.couldBeWrongBecause).toEqual(["minified_vendor_no_sourcemap"]);
  });

  it("takes the highest confidence across the folded copies", () => {
    const r = "<input> no autocomplete attribute";
    const out = dedupeReviewCandidatesByReason([
      candidate("wcag22:1.3.6", r, 5, 4, { confidence: "low" }),
      candidate("wcag21:1.3.6", r, 5, 4, { confidence: "high" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe("high");
  });
});

describe("filterCandidatesCoveredByFindings — per-element dedup against rule findings", () => {
  it("elides candidate whose (file, line, criterion) matches a finding's (file, line, satisfied criterion)", () => {
    // Canonical Q14 case: `aria/expanded-on-disclosure` fires on a
    // `.navbar-toggle` button at line 12 satisfying wcag22:4.1.2;
    // a parallel review candidate fires on the same button under
    // wcag22:4.1.2 (e.g. cross-file-click-handler review). Filter
    // elides the candidate so the agent reads the rule emission once.
    const out = filterCandidatesCoveredByFindings({
      candidates: [candidate("wcag22:4.1.2", "<button class='navbar-toggle'> verify aria-expanded", 12, 2)],
      findings: [{ file: FILE, line: 12, criteria: ["wcag22:4.1.2", "wcag21:4.1.2"] }],
    });
    expect(out).toHaveLength(0);
  });

  it("keeps candidate when the line matches but the criterion does not intersect", () => {
    // Two channels narrating different criteria at the same line is
    // honest signal — both go to the agent; the line just happens to
    // host two distinct WCAG concerns. Strict per-criterion gate.
    const out = filterCandidatesCoveredByFindings({
      candidates: [candidate("wcag22:3.3.8", "password input", 12, 2)],
      findings: [{ file: FILE, line: 12, criteria: ["wcag22:4.1.2"] }],
    });
    expect(out).toHaveLength(1);
  });

  it("keeps candidate when the criterion matches but the line does not", () => {
    const out = filterCandidatesCoveredByFindings({
      candidates: [candidate("wcag22:4.1.2", "another control", 25, 2)],
      findings: [{ file: FILE, line: 12, criteria: ["wcag22:4.1.2"] }],
    });
    expect(out).toHaveLength(1);
  });

  it("keeps candidate when the file does not match", () => {
    const out = filterCandidatesCoveredByFindings({
      candidates: [candidate("wcag22:4.1.2", "control on other file", 12, 2)],
      findings: [{ file: "/repo/other.html", line: 12, criteria: ["wcag22:4.1.2"] }],
    });
    expect(out).toHaveLength(1);
  });

  it("elides each per-criterion finder copy independently when its criterionId matches", () => {
    // Pre-cross-standard-fold input — the cross-file-click-handler
    // finder emits one candidate per criterion (`wcag22:2.1.1`,
    // `wcag21:2.1.1`, `wcag22:4.1.2`, `wcag21:4.1.2`). When a rule
    // finding satisfies 4.1.2 (both 22 and 21), both 4.1.2 copies
    // elide; the 2.1.1 pair survives because the keyboard rule
    // didn't fire on this line.
    const r = "<button class='navbar-toggle'> review";
    const out = filterCandidatesCoveredByFindings({
      candidates: [
        candidate("wcag22:2.1.1", r, 12, 2),
        candidate("wcag21:2.1.1", r, 12, 2),
        candidate("wcag22:4.1.2", r, 12, 2),
        candidate("wcag21:4.1.2", r, 12, 2),
      ],
      findings: [{ file: FILE, line: 12, criteria: ["wcag22:4.1.2", "wcag21:4.1.2"] }],
    });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.criterionId).sort()).toEqual(["wcag21:2.1.1", "wcag22:2.1.1"]);
  });

  it("returns input unchanged when findings array is empty (fast path)", () => {
    const candidates = [candidate("wcag22:4.1.2", "x", 12, 2)];
    const out = filterCandidatesCoveredByFindings({ candidates, findings: [] });
    expect(out).toBe(candidates);
  });

  it("returns input unchanged when candidates array is empty (fast path)", () => {
    const out = filterCandidatesCoveredByFindings({
      candidates: [],
      findings: [{ file: FILE, line: 12, criteria: ["wcag22:4.1.2"] }],
    });
    expect(out).toEqual([]);
  });

  it("indexes by (file, line) so a candidate's filePath is honored", () => {
    const out = filterCandidatesCoveredByFindings({
      candidates: [
        candidate("wcag22:4.1.2", "x", 12, 2, { location: { filePath: "/a.html", line: 12, column: 2 } }),
        candidate("wcag22:4.1.2", "x", 12, 2, { location: { filePath: "/b.html", line: 12, column: 2 } }),
      ],
      findings: [{ file: "/a.html", line: 12, criteria: ["wcag22:4.1.2"] }],
    });
    // Only the /a.html candidate elides; /b.html survives.
    expect(out).toHaveLength(1);
    expect(out[0]?.location.filePath).toBe("/b.html");
  });
});
