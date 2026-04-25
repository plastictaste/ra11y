/**
 * Unit tests for the review/color-class-crossref finder (wcag22:1.4.1).
 *
 * The finder is cross-file (afterProject): it scans CSS files for class
 * rules whose only/dominant declaration is a color property, then finds
 * every HTML/JSX usage of those class names and emits a candidate at
 * each usage site.
 *
 * Tests are driven through runScan so the afterProject hook is exercised
 * end-to-end against the actual scanner lifecycle.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../../../src/engine/scanner.ts";
import { parseCss, parseHtml, parseTsx } from "../../../../src/input/parsers/index.ts";
import { finder } from "../../../../src/review/finders/color-class-crossref.ts";
import { wcag22 } from "../../../../src/standards/wcag22/standard.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cssFile(filePath: string, source: string): ParsedFile {
  const r = parseCss(source);
  return { filePath, source, ast: { language: "css", root: r.root, errors: r.errors } };
}

function htmlFile(filePath: string, source: string): ParsedFile {
  const r = parseHtml(source);
  return { filePath, source, ast: { language: "html", root: r.root, errors: r.errors } };
}

function tsxFile(filePath: string, source: string): ParsedFile {
  const r = parseTsx(source);
  return { filePath, source, ast: { language: "tsx", root: r.root, errors: r.errors } };
}

function runWith(files: readonly ParsedFile[]): readonly ReviewCandidate[] {
  const { report } = runScan({
    standards: [wcag22],
    rules: [],
    enabled: ["wcag22"],
    files,
    finders: [finder],
  });
  return report.candidates ?? [];
}

// ---------------------------------------------------------------------------
// Positive cases — finder must fire
// ---------------------------------------------------------------------------

describe("review/color-class-crossref (positive — should flag)", () => {
  it("flags HTML element using a color-only CSS class", () => {
    const candidates = runWith([
      cssFile("styles.css", `.correct { color: green; }`),
      htmlFile("page.html", `<ul><li class="correct">Q1</li></ul>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged[0]?.reason).toContain("correct");
    expect(flagged[0]?.reason).toContain("color");
    expect(flagged[0]?.reason).toContain("green");
  });

  it("flags HTML element using a background-color-only CSS class", () => {
    const candidates = runWith([
      cssFile("styles.css", `.alert { background-color: #f00; }`),
      htmlFile("page.html", `<div class="alert">Error occurred</div>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged[0]?.reason).toContain("alert");
    expect(flagged[0]?.reason).toContain("background-color");
  });

  it("flags JSX element using a color-only CSS class in className", () => {
    const candidates = runWith([
      cssFile("styles.css", `.incorrect { color: red; }`),
      tsxFile(
        "Status.tsx",
        `export function Status() { return <span className="incorrect">Wrong</span>; }`,
      ),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged[0]?.reason).toContain("incorrect");
    expect(flagged[0]?.reason).toContain("color");
    expect(flagged[0]?.reason).toContain("red");
  });

  it("emits candidates for all four criterion IDs", () => {
    const candidates = runWith([
      cssFile("styles.css", `.pass { color: green; }`),
      htmlFile("page.html", `<p class="pass">Passed</p>`),
    ]);
    const criterionIds = new Set(candidates.map((c) => c.criterionId));
    expect(criterionIds.has("wcag22:1.4.1")).toBe(true);
    expect(criterionIds.has("wcag21:1.4.1")).toBe(true);
    expect(criterionIds.has("section508:1194.22.c")).toBe(true);
    expect(criterionIds.has("en301549:9.1.4.1")).toBe(true);
  });

  it("flags multiple HTML elements using the same color class", () => {
    const candidates = runWith([
      cssFile("styles.css", `.correct { color: green; }`),
      htmlFile("quiz.html", `<ul><li class="correct">Q1</li><li class="correct">Q2</li></ul>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    // Two usages → two candidates
    expect(flagged.length).toBeGreaterThanOrEqual(2);
  });

  it("flags each distinct color class used on the same element", () => {
    const candidates = runWith([
      cssFile("styles.css", `.correct { color: green; }\n.highlight { color: yellow; }`),
      htmlFile("page.html", `<p class="correct highlight">Good and highlighted</p>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    // Two classes on the same element → two candidates (one per matched class)
    expect(flagged.length).toBeGreaterThanOrEqual(2);
    const reasons = flagged.map((c) => c.reason);
    expect(reasons.some((r) => r.includes("correct"))).toBe(true);
    expect(reasons.some((r) => r.includes("highlight"))).toBe(true);
  });

  it("works with multiple CSS files defining color classes", () => {
    const candidates = runWith([
      cssFile("base.css", `.error { color: red; }`),
      cssFile("theme.css", `.success { color: green; }`),
      htmlFile("page.html", `<p class="error">Fail</p><p class="success">Pass</p>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBeGreaterThanOrEqual(2);
    const reasons = flagged.map((c) => c.reason);
    expect(reasons.some((r) => r.includes("error"))).toBe(true);
    expect(reasons.some((r) => r.includes("success"))).toBe(true);
  });

  it("notes a non-color companion when the CSS class also has font-weight", () => {
    const candidates = runWith([
      cssFile("styles.css", `.active { color: blue; font-weight: bold; }`),
      htmlFile("page.html", `<li class="active">Item</li>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    // Finder still emits a candidate — the agent decides, not the scanner.
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    // But the reason text should note the companion.
    expect(flagged[0]?.reason).toContain("non-color visual property");
  });

  it("sets confidence to high — deterministic class-name lookup", () => {
    const candidates = runWith([
      cssFile("styles.css", `.wrong { color: red; }`),
      htmlFile("page.html", `<p class="wrong">Error</p>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged[0]?.confidence).toBe("high");
  });

  it("reports the usage file path, not the CSS file path", () => {
    const candidates = runWith([
      cssFile("src/styles.css", `.fail { color: red; }`),
      htmlFile("src/page.html", `<p class="fail">Error</p>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged[0]?.location.filePath).toContain("page.html");
  });
});

// ---------------------------------------------------------------------------
// Negative cases — finder must not fire
// ---------------------------------------------------------------------------

describe("review/color-class-crossref (negative — should not flag)", () => {
  it("does not flag when there are no CSS files", () => {
    const candidates = runWith([htmlFile("page.html", `<p class="correct">Q1</p>`)]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });

  it("does not flag when the CSS class used on an element has no color property", () => {
    const candidates = runWith([
      cssFile("styles.css", `.large { font-size: 1.5em; }`),
      htmlFile("page.html", `<p class="large">Text</p>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });

  it("does not flag when the CSS class is defined but not used in any HTML/JSX", () => {
    const candidates = runWith([
      cssFile("styles.css", `.correct { color: green; }`),
      htmlFile("page.html", `<p class="other">No color class here</p>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });

  it("does not flag a compound selector (.foo.bar) — not a simple class selector", () => {
    const candidates = runWith([
      cssFile("styles.css", `.item.selected { color: green; }`),
      htmlFile("page.html", `<li class="item selected">Q1</li>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });

  it("does not flag a descendant selector (.list .item) — not a simple class selector", () => {
    const candidates = runWith([
      cssFile("styles.css", `.list .item { color: green; }`),
      htmlFile("page.html", `<ul class="list"><li class="item">Q1</li></ul>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });

  it("does not flag a pseudo-class selector (.button:hover) — context-dependent", () => {
    const candidates = runWith([
      cssFile("styles.css", `.button:hover { color: blue; }`),
      htmlFile("page.html", `<button class="button">Click</button>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });

  it("does not flag a multi-selector (.foo, .bar) — not a simple class selector", () => {
    const candidates = runWith([
      cssFile("styles.css", `.foo, .bar { color: red; }`),
      htmlFile("page.html", `<p class="foo">Text</p>`),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });

  it("does not flag JSX with expression className (not statically analyzable)", () => {
    const candidates = runWith([
      cssFile("styles.css", `.correct { color: green; }`),
      tsxFile(
        "Status.tsx",
        `export function Status({ cls }: { cls: string }) {
          return <span className={cls}>Dynamic</span>;
        }`,
      ),
    ]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });

  it("does not flag when there are no HTML or JSX files with the color class", () => {
    const candidates = runWith([cssFile("styles.css", `.correct { color: green; }`)]);
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });

  it("does not flag a tag-qualified selector (p.correct) — not a simple class selector", () => {
    const candidates = runWith([
      cssFile("styles.css", `p.correct { color: green; }`),
      htmlFile("page.html", `<p class="correct">Q1</p>`),
    ]);
    // p.correct starts with `p`, not `.` — extractor returns null.
    const flagged = candidates.filter((c) => c.criterionId === "wcag22:1.4.1");
    expect(flagged.length).toBe(0);
  });
});
