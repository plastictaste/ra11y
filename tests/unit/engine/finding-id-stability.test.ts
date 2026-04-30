/**
 * `findingId` and `findingGroupId` stability across scans of the same
 * source.
 *
 * Two complementary identity tokens carry opposite invariants:
 *
 *   `findingId`      — per-emission unique within a response. Hashes
 *                      `(ruleId, file, line, column, variantKey?)`.
 *                      Two scans of the same source produce the same
 *                      `findingId` for an unchanged finding because
 *                      its `(line, column)` are unchanged.
 *
 *   `findingGroupId` — line-drift resilient. Hashes the normalized
 *                      text of the violation line, NOT the line
 *                      number. Editing an unrelated line above the
 *                      violation does not invalidate the cross-run
 *                      identity baselines depend on.
 *
 * Prior recipe (pre-V1) hashed a ±3-line source window around each
 * violation. That made the id drift whenever another finding's
 * `apply_fix` edit landed inside the window — a finding three lines
 * away from the fix would silently receive a new id even though its
 * own line text was byte-identical. The fix narrowed `findingGroupId`
 * to the single violation line's normalized text (see
 * `src/utils/finding-id.ts`); per-emission addressability moved to
 * `findingId` (which now includes line + column).
 *
 * Invariants covered here:
 *   (a) Two scans of the same source produce the same per-emission
 *       `findingId` set AND the same `findingGroupId` set.
 *   (b) Editing an unrelated line above the violation keeps the
 *       unchanged finding's `findingGroupId` stable; a new finding
 *       introduced at the edited line gets a fresh group id.
 *
 * Cross-commit rule-rename stability is explicitly out of scope (the
 * baseline-matching ADR owns that).
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../../src/engine/scanner.ts";
import { parseHtml } from "../../../src/input/parsers/index.ts";
import { BUILTIN_RULES } from "../../../src/rules/index.ts";
import { wcag22 } from "../../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../../src/types/ast.ts";
import {
  computeFindingGroupId,
  computeFindingId,
  extractNormalizedLineText,
} from "../../../src/utils/finding-id.ts";

function htmlFile(path: string, source: string): ParsedFile {
  const parsed = parseHtml(source);
  const ast: Ast = { language: "html", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

function runImgScan(file: ParsedFile) {
  return runScan({
    standards: [wcag22],
    rules: BUILTIN_RULES,
    enabled: ["wcag22"],
    files: [file],
  }).result;
}

describe("Violation.findingId / findingGroupId — stability across scans", () => {
  it("(a) two scans of the same source produce identical id sets", () => {
    // Two `<img>` elements, both missing `alt`, on different lines.
    // Each produces one `media/alt-text-missing` finding. Scanning
    // the same source twice must produce the same two findingIds and
    // the same two findingGroupIds in the same order.
    const source = `<!doctype html><html lang="en"><body>
<p>Top paragraph.</p>
<img src="a.png">
<p>Middle paragraph.</p>
<p>Another paragraph.</p>
<img src="b.png">
<p>Trailing paragraph.</p>
</body></html>`;
    const file = htmlFile("index.html", source);
    const first = runImgScan(file);
    const second = runImgScan(file);
    const firstFindings = first.violations.filter((v) => v.ruleId === "media/alt-text-missing");
    const secondFindings = second.violations.filter((v) => v.ruleId === "media/alt-text-missing");
    const firstIds = firstFindings.map((v) => v.findingId);
    const secondIds = secondFindings.map((v) => v.findingId);
    const firstGroupIds = firstFindings.map((v) => v.findingGroupId);
    const secondGroupIds = secondFindings.map((v) => v.findingGroupId);
    expect(firstIds.length).toBe(2);
    expect(firstIds).toEqual(secondIds);
    expect(firstGroupIds).toEqual(secondGroupIds);
    // Per-emission addressability invariant: the two findings within
    // one response carry distinct `findingId`s.
    expect(new Set(firstIds).size).toBe(firstIds.length);
  });

  it("(b) editing an unrelated line keeps the unchanged finding's findingGroupId stable", () => {
    // Setup: two `<img>` elements on lines 3 and 6. Scan once.
    // Between the two scans, rewrite line 3 (the first <img>) to add
    // `alt=""`, resolving that finding. Line 6's <img> is unchanged.
    // Its `findingGroupId` MUST match the id it had in scan 1; the
    // per-emission `findingId` is also unchanged because line + column
    // didn't shift either.
    //
    // Under the old ±3-line-window recipe, line 6's context window
    // covered lines 3..9 — so rewriting line 3 changed its id. The
    // new recipe hashes only the violation line's text for
    // `findingGroupId`, so line 6's group id depends only on its own
    // text and is byte-stable here.
    const before = `<!doctype html><html lang="en"><body>
<p>Intro.</p>
<img src="first.png">
<p>Between.</p>
<p>More between.</p>
<img src="second.png">
<p>End.</p>
</body></html>`;
    // Same byte layout, but the first <img> now has `alt=""` —
    // resolving its finding without shifting any line numbers.
    const after = `<!doctype html><html lang="en"><body>
<p>Intro.</p>
<img src="first.png" alt="">
<p>Between.</p>
<p>More between.</p>
<img src="second.png">
<p>End.</p>
</body></html>`;

    const beforeScan = runImgScan(htmlFile("index.html", before));
    const afterScan = runImgScan(htmlFile("index.html", after));

    const beforeImgs = beforeScan.violations.filter((v) => v.ruleId === "media/alt-text-missing");
    const afterImgs = afterScan.violations.filter((v) => v.ruleId === "media/alt-text-missing");
    expect(beforeImgs.length).toBe(2);
    expect(afterImgs.length).toBe(1);

    // The surviving finding is the `second.png` <img> on line 6; its
    // ids must match what it had in the pre-edit scan.
    const survivingBefore = beforeImgs.find((v) => v.location.line === 6);
    const survivingAfter = afterImgs.find((v) => v.location.line === 6);
    expect(survivingBefore).toBeDefined();
    expect(survivingAfter).toBeDefined();
    expect(survivingAfter?.findingId).toBe(survivingBefore?.findingId);
    expect(survivingAfter?.findingGroupId).toBe(survivingBefore?.findingGroupId);

    // The line-3 finding (`first.png`) disappeared; its group id must
    // NOT appear in the after-scan (otherwise we'd be calling a
    // resolved finding unresolved at the baseline-matching layer).
    const resolvedGroupId = beforeImgs.find((v) => v.location.line === 3)?.findingGroupId;
    expect(resolvedGroupId).toBeDefined();
    expect(afterImgs.map((v) => v.findingGroupId)).not.toContain(resolvedGroupId);
  });

  it("a new finding introduced at a previously-clean line gets a fresh id", () => {
    // Same shape as (b) but inverted: start with one <img> (line 3),
    // end with two <img>s (lines 3 and 6). The pre-existing finding's
    // ids must remain; the new finding's ids must differ from it.
    const before = `<!doctype html><html lang="en"><body>
<p>Intro.</p>
<img src="original.png">
<p>Middle.</p>
<p>More middle.</p>
<img src="unchanged.png" alt="">
<p>End.</p>
</body></html>`;
    const after = `<!doctype html><html lang="en"><body>
<p>Intro.</p>
<img src="original.png">
<p>Middle.</p>
<p>More middle.</p>
<img src="unchanged.png">
<p>End.</p>
</body></html>`;

    const beforeScan = runImgScan(htmlFile("index.html", before));
    const afterScan = runImgScan(htmlFile("index.html", after));
    const beforeImgs = beforeScan.violations.filter((v) => v.ruleId === "media/alt-text-missing");
    const afterImgs = afterScan.violations.filter((v) => v.ruleId === "media/alt-text-missing");
    expect(beforeImgs.length).toBe(1);
    expect(afterImgs.length).toBe(2);

    const originalBefore = beforeImgs.find((v) => v.location.line === 3);
    const originalAfter = afterImgs.find((v) => v.location.line === 3);
    const newFinding = afterImgs.find((v) => v.location.line === 6);
    expect(originalBefore).toBeDefined();
    expect(originalAfter).toBeDefined();
    expect(newFinding).toBeDefined();
    // Pre-existing finding's ids survive the introduction of a
    // sibling finding on another line.
    expect(originalAfter?.findingId).toBe(originalBefore?.findingId);
    expect(originalAfter?.findingGroupId).toBe(originalBefore?.findingGroupId);
    // Newly-introduced finding gets a distinct id (line + column
    // differ; line text differs).
    expect(newFinding?.findingId).not.toBe(originalBefore?.findingId);
    expect(newFinding?.findingGroupId).not.toBe(originalBefore?.findingGroupId);
  });
});

describe("computeFindingId — per-emission address recipe inputs", () => {
  it("differs when (line, column) differ — per-emission uniqueness", () => {
    // Two emissions of the same rule against the same file at
    // different `(line, column)` MUST get distinct ids. This is the
    // addressability invariant `suggest_fix(findingId)` and the
    // source-level disable pragma both depend on.
    const base = {
      ruleId: "media/alt-text-missing",
      filePath: "index.html",
      line: 5,
      column: 1,
    };
    const a = computeFindingId(base);
    const b = computeFindingId({ ...base, line: 6 });
    const c = computeFindingId({ ...base, column: 14 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("equals when (rule, file, line, column, variantKey) all match", () => {
    // Determinism: same inputs → same id, regardless of how often
    // recomputed. Pure function over its inputs.
    const inputs = {
      ruleId: "media/alt-text-missing",
      filePath: "index.html",
      line: 7,
      column: 12,
    };
    expect(computeFindingId(inputs)).toBe(computeFindingId(inputs));
  });

  it("different variantKeys produce different ids on the same site", () => {
    const base = {
      ruleId: "navigation/link-descriptive-text",
      filePath: "index.html",
      line: 2,
      column: 1,
    };
    const generic = computeFindingId({ ...base, variantKey: "generic-phrase" });
    const duplicate = computeFindingId({ ...base, variantKey: "duplicate-name" });
    expect(generic).not.toBe(duplicate);
  });

  it("omitted variantKey equals empty variantKey (conditional fold)", () => {
    // Belt-and-braces: rules that don't pass a variantKey stay at the
    // base hash. An empty string variantKey collapses to the same
    // canonical input.
    const base = {
      ruleId: "media/alt-text-missing",
      filePath: "index.html",
      line: 1,
      column: 1,
    };
    const omitted = computeFindingId(base);
    const empty = computeFindingId({ ...base, variantKey: "" });
    expect(omitted).toBe(empty);
  });
});

describe("computeFindingGroupId — cross-run recipe inputs", () => {
  it("differs when the violation line's text differs", () => {
    const base = {
      ruleId: "media/alt-text-missing",
      filePath: "index.html",
      source: `<body>
<img src="a.png">
</body>`,
      line: 2,
    };
    const a = computeFindingGroupId(base);
    const b = computeFindingGroupId({
      ...base,
      source: `<body>
<img src="b.png">
</body>`,
    });
    expect(a).not.toBe(b);
  });

  it("does NOT differ when other lines' text changes (line-drift resilience)", () => {
    // Same violation line at line 2; the surrounding lines differ.
    // Under the old ±3-line-window recipe these two would produce
    // different ids; under the new single-line recipe they match,
    // which is what makes baselines survive unrelated edits.
    const a = computeFindingGroupId({
      ruleId: "media/alt-text-missing",
      filePath: "index.html",
      source: `<p>First surrounding paragraph.</p>
<img src="a.png">
<p>Third surrounding paragraph.</p>`,
      line: 2,
    });
    const b = computeFindingGroupId({
      ruleId: "media/alt-text-missing",
      filePath: "index.html",
      source: `<p>Different first paragraph entirely.</p>
<img src="a.png">
<p>And a different third.</p>`,
      line: 2,
    });
    expect(a).toBe(b);
  });

  it("different variantKeys produce different ids on the same site", () => {
    const base = {
      ruleId: "navigation/link-descriptive-text",
      filePath: "index.html",
      source: `<body>
<a href="/x">Read more</a>
</body>`,
      line: 2,
    };
    const generic = computeFindingGroupId({ ...base, variantKey: "generic-phrase" });
    const duplicate = computeFindingGroupId({ ...base, variantKey: "duplicate-name" });
    expect(generic).not.toBe(duplicate);
  });

  it("omitted variantKey equals empty variantKey (conditional fold)", () => {
    const base = {
      ruleId: "media/alt-text-missing",
      filePath: "index.html",
      source: `<img src="a.png">`,
      line: 1,
    };
    const omitted = computeFindingGroupId(base);
    const empty = computeFindingGroupId({ ...base, variantKey: "" });
    expect(omitted).toBe(empty);
  });
});

describe("extractNormalizedLineText", () => {
  it("returns the line at the 1-based index with trailing whitespace stripped", () => {
    const source = "first\n  second   \nthird";
    expect(extractNormalizedLineText(source, 1)).toBe("first");
    expect(extractNormalizedLineText(source, 2)).toBe("  second");
    expect(extractNormalizedLineText(source, 3)).toBe("third");
  });

  it("returns empty string when source is empty", () => {
    expect(extractNormalizedLineText("", 1)).toBe("");
    expect(extractNormalizedLineText("", 99)).toBe("");
  });

  it("returns empty string when line is out of bounds or non-positive", () => {
    const source = "only\nline";
    expect(extractNormalizedLineText(source, 0)).toBe("");
    expect(extractNormalizedLineText(source, -1)).toBe("");
    expect(extractNormalizedLineText(source, 99)).toBe("");
  });
});
