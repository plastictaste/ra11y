/**
 * Unit tests for the review/data-bg-image finder
 * (wcag22:1.1.1 + wcag21:1.1.1).
 *
 * Pins the positive conditions (recognized data-* attribute name
 * resolving to a known image extension on a structural container
 * tag) and the negatives that must NOT fire (off-list attribute name,
 * non-image extension, dynamic JSX expression, `<img>` element). Both
 * HTML and JSX surfaces are exercised inline.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/data-bg-image.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return [...out.map((c) => c.criterionId)].sort();
}

describe("review/data-bg-image — HTML positive cases", () => {
  it("flags <div data-src> resolving to a .jpg", () => {
    const source = `<div data-src="path/to/hero.jpg"></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2); // wcag22 + wcag21
    expect(criterionIds(out)).toEqual(["wcag21:1.1.1", "wcag22:1.1.1"]);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("data-src");
    expect(reason).toContain(".jpg");
    expect(reason).toContain("verify");
    expect(out[0]?.confidence).toBe("low");
  });

  it("flags <span data-bg> resolving to a .png", () => {
    const source = `<span data-bg="banner.png"></span>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("data-bg");
    expect(out[0]?.reason).toContain(".png");
  });

  it("flags <section data-background-image> resolving to a .webp", () => {
    const source = `<section data-background-image="cover.webp"></section>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("data-background-image");
  });

  it("flags <article data-background> with .gif", () => {
    const source = `<article data-background="anim.gif"></article>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("flags <li data-bg-image> with .svg", () => {
    const source = `<li data-bg-image="icon.svg"></li>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".svg");
  });

  it("matches case-insensitively on the attribute name", () => {
    const source = `<div DATA-SRC="hero.jpg"></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("data-src");
  });

  it("ignores query / fragment when matching the extension", () => {
    const source = `<div data-src="https://cdn.example/hero.jpg?v=2#frag"></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain(".jpg");
  });

  it("emits at the element location (not the attribute)", () => {
    const source = `<main>
  <div data-src="hero.jpg"></div>
</main>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    // <div> is on line 2.
    expect(out[0]?.location.line).toBe(2);
  });

  it("flags multiple distinct elements separately", () => {
    const source = `<section>
      <div data-src="a.jpg"></div>
      <div data-bg="b.png"></div>
    </section>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    // 2 elements × 2 criteria = 4 candidates
    expect(out.length).toBe(4);
  });
});

describe("review/data-bg-image — HTML negative cases", () => {
  it("does NOT fire on <img data-src> (handled by alt-text rules instead)", () => {
    const source = `<img data-src="hero.jpg" />`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the data-* name is off-list", () => {
    const source = `<div data-image="hero.jpg"></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the value resolves to a non-image extension", () => {
    const source = `<div data-src="manifest.json"></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a JS file URL even via data-src", () => {
    const source = `<div data-src="lazy.js"></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the data-* attribute is empty", () => {
    const source = `<div data-src=""></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a non-structural tag like <p>", () => {
    const source = `<p data-src="hero.jpg">text</p>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });
});

describe("review/data-bg-image — JSX positive cases", () => {
  it("flags <div data-src='hero.jpg' /> with a string-literal attribute", () => {
    const source = `export const X = () => <div data-src="hero.jpg" />;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("data-src");
    expect(out[0]?.reason).toContain(".jpg");
  });

  it('flags <div data-bg={"banner.png"} /> with a curly-wrapped string literal', () => {
    const source = `export const X = () => <div data-bg={"banner.png"} />;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("data-bg");
  });

  it("flags <section data-background-image='cover.webp' />", () => {
    const source = `export const X = () => <section data-background-image="cover.webp" />;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("data-background-image");
  });
});

describe("review/data-bg-image — JSX negative cases", () => {
  it("does NOT fire on dynamic expression value (agent investigates separately)", () => {
    const source = `export const X = ({ url }: { url: string }) => <div data-src={url} />;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on <img data-src='hero.jpg' /> in JSX either", () => {
    const source = `export const X = () => <img data-src="hero.jpg" alt="" />;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the JSX value resolves to a non-image extension", () => {
    const source = `export const X = () => <div data-src="manifest.json" />;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });
});

describe("review/data-bg-image — finder metadata", () => {
  it("declares wcag22:1.1.1 and wcag21:1.1.1", () => {
    expect([...finder.criterionIds].sort()).toEqual(["wcag21:1.1.1", "wcag22:1.1.1"]);
  });

  it("scopes to .html, .htm, .tsx, .jsx", () => {
    expect(finder.appliesTo?.fileExtensions).toEqual([".html", ".htm", ".tsx", ".jsx"]);
  });
});
