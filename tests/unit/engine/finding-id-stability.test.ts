/**
 * V1-FINDING-ID-STABILITY: `findingId` must stay stable across scans
 * of the same source, and must stay stable for an unchanged finding
 * even when an UNRELATED line in the same file was edited between the
 * two scans.
 *
 * Prior recipe (pre-V1) hashed a ±3-line source window around each
 * violation. That made the id drift whenever another finding's
 * `apply_fix` edit landed inside the window — a finding three lines
 * away from the fix would silently receive a new id even though its
 * own line text was byte-identical. Field report: 50p50d
 * `password-generator` row 11 dry-run shifted `373b28c71fbf` →
 * `c8bad95295ec` at line 34 with identical evidence.
 *
 * The fix narrows the hash input to the single violation line's
 * normalized text (see `src/utils/finding-id.ts`), so an edit to any
 * other line — whether preceding or following the finding — no longer
 * churns its id.
 *
 * Invariants covered here:
 *   (a) Two scans of the same source produce the same findingId set.
 *   (b) Editing an unrelated line in between two scans keeps the
 *       unchanged finding's id stable; a new finding introduced at
 *       the edited line gets a fresh id.
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
import { computeFindingId, extractNormalizedLineText } from "../../../src/utils/finding-id.ts";

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

describe("Violation.findingId — stability across scans", () => {
  it("(a) two scans of the same source produce identical findingIds", () => {
    // Two `<img>` elements, both missing `alt`, on different lines.
    // Each produces one `media/alt-text-missing` finding. Scanning
    // the same source twice must produce the same two findingIds in
    // the same order.
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
    const firstIds = first.violations
      .filter((v) => v.ruleId === "media/alt-text-missing")
      .map((v) => v.findingId);
    const secondIds = second.violations
      .filter((v) => v.ruleId === "media/alt-text-missing")
      .map((v) => v.findingId);
    expect(firstIds.length).toBe(2);
    expect(firstIds).toEqual(secondIds);
  });

  it("(b) editing an unrelated line keeps the unchanged finding's id stable", () => {
    // Setup: two `<img>` elements on lines 3 and 6. Scan once.
    // Between the two scans, rewrite line 3 (the first <img>) to add
    // `alt=""`, resolving that finding. Line 6's <img> is unchanged.
    // Its findingId MUST match the id it had in scan 1.
    //
    // Under the old ±3-line-window recipe, line 6's context window
    // covered lines 3..9 — so rewriting line 3 changed its id. The
    // new recipe hashes only the violation line's text, so line 6's
    // id depends only on its own text and is byte-stable here.
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
    // id must match the id it had in the pre-edit scan.
    const survivingBefore = beforeImgs.find((v) => v.location.line === 6);
    const survivingAfter = afterImgs.find((v) => v.location.line === 6);
    expect(survivingBefore).toBeDefined();
    expect(survivingAfter).toBeDefined();
    expect(survivingAfter?.findingId).toBe(survivingBefore?.findingId);

    // The line-3 finding (`first.png`) disappeared; its id must NOT
    // appear in the after-scan (otherwise we'd be calling a resolved
    // finding unresolved).
    const resolvedId = beforeImgs.find((v) => v.location.line === 3)?.findingId;
    expect(resolvedId).toBeDefined();
    expect(afterImgs.map((v) => v.findingId)).not.toContain(resolvedId);
  });

  it("a new finding introduced at a previously-clean line gets a fresh id", () => {
    // Same shape as (b) but inverted: start with one <img> (line 3),
    // end with two <img>s (lines 3 and 6). The pre-existing finding's
    // id must remain; the new finding's id must differ from it.
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
    // Pre-existing finding's id survives the introduction of a
    // sibling finding on another line.
    expect(originalAfter?.findingId).toBe(originalBefore?.findingId);
    // Newly-introduced finding gets a distinct id (line text differs).
    expect(newFinding?.findingId).not.toBe(originalBefore?.findingId);
  });
});

describe("computeFindingId — recipe inputs", () => {
  it("differs when the violation line's text differs", () => {
    const base = {
      ruleId: "media/alt-text-missing",
      filePath: "index.html",
      source: `<body>
<img src="a.png">
</body>`,
      line: 2,
    };
    const a = computeFindingId(base);
    const b = computeFindingId({
      ...base,
      source: `<body>
<img src="b.png">
</body>`,
    });
    expect(a).not.toBe(b);
  });

  it("does NOT differ when other lines' text changes", () => {
    // Same violation line at line 2; the surrounding lines differ.
    // Under the old ±3-line-window recipe these two would produce
    // different ids; under the new single-line recipe they match.
    const a = computeFindingId({
      ruleId: "media/alt-text-missing",
      filePath: "index.html",
      source: `<p>First surrounding paragraph.</p>
<img src="a.png">
<p>Third surrounding paragraph.</p>`,
      line: 2,
    });
    const b = computeFindingId({
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
      source: `<img src="a.png">`,
      line: 1,
    };
    const omitted = computeFindingId(base);
    const empty = computeFindingId({ ...base, variantKey: "" });
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
