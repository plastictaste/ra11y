/**
 * Unit tests for the review/meaningful-sequence finder
 * (wcag22:1.3.2 + wcag21:1.3.2 — Meaningful Sequence).
 *
 * Pins the pivot from CSS-selector-definition scope (false-positive
 * vendor utility-CSS noise) to HTML/JSX consumer scope (the real
 * reorder site) + authored-CSS rules on non-utility selectors. The
 * utility-class *definition* sites (`.order-3 { order: 3 }`) are
 * silenced; authored-CSS reorders (`.product-grid { flex-direction:
 * row-reverse }`) keep surfacing.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/meaningful-sequence.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

describe("review/meaningful-sequence — HTML consumer scope", () => {
  it("flags `<div class='order-2'>` with the order-utility reason", () => {
    const source = `<div class="order-2">first in DOM, later visually</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("order-2");
    expect(out[0]?.reason).toContain("order");
    expect(out[0]?.confidence).toBe("high");
  });

  it("flags Bootstrap-style `order-0` through `order-12`", () => {
    for (const n of [0, 1, 5, 12]) {
      const source = `<div class="order-${n}">x</div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBe(2);
      expect(out[0]?.reason).toContain(`order-${n}`);
    }
  });

  it("flags Tailwind named `order-first` / `order-last` / `order-none`", () => {
    for (const token of ["order-first", "order-last", "order-none"]) {
      const source = `<div class="${token}">x</div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBe(2);
      expect(out[0]?.reason).toContain(token);
    }
  });

  it("flags Tailwind responsive prefix `md:order-2`", () => {
    const source = `<div class="md:order-2">x</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("order-2");
  });

  it("flags stacked prefix chain `sm:md:hover:order-1`", () => {
    const source = `<div class="sm:md:hover:order-1">x</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("order-1");
  });

  it("flags `flex-row-reverse` utility class", () => {
    const source = `<div class="flex flex-row-reverse">children reversed</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("flex-row-reverse");
    expect(out[0]?.reason).toContain("reverse");
  });

  it("flags `flex-col-reverse` and `flex-column-reverse`", () => {
    for (const token of ["flex-col-reverse", "flex-column-reverse"]) {
      const source = `<div class="flex ${token}">x</div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBe(2);
      expect(out[0]?.reason).toContain(token);
    }
  });

  it("flags `grid-flow-row-dense` / `grid-flow-col-dense`", () => {
    for (const token of ["grid-flow-row-dense", "grid-flow-col-dense"]) {
      const source = `<div class="grid ${token}">x</div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBe(2);
      expect(out[0]?.reason).toContain(token);
      expect(out[0]?.reason).toContain("dense");
    }
  });

  it("emits one candidate per element even when multiple utility tokens present", () => {
    // First match wins — the agent reads the class list and
    // enumerates the rest. Per AI-first: point, don't enumerate.
    const source = `<div class="order-2 flex-row-reverse">x</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
  });
});

describe("review/meaningful-sequence — HTML negatives", () => {
  it("does NOT fire on unrelated class names", () => {
    const source = `<div class="hero main-content">x</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on substring lookalikes (`order-panel`, `border-2`)", () => {
    const source = `<div class="order-panel border-2">x</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on `flex-row` / `flex-col` (non-reverse)", () => {
    const source = `<div class="flex flex-row">x</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on an element with no class attribute", () => {
    const source = `<div>plain</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });
});

describe("review/meaningful-sequence — JSX consumer scope", () => {
  it("flags JSX `className='order-2'`", () => {
    const source = `const C = () => <div className="order-2">x</div>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("order-2");
  });

  it("flags JSX `class` fallback (non-React JSX dialect)", () => {
    const source = `const C = () => <div class="order-3">x</div>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("order-3");
  });

  it("flags JSX `className='flex-row-reverse'`", () => {
    const source = `const C = () => <div className="flex flex-row-reverse">x</div>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("flex-row-reverse");
  });

  it("flags JSX Tailwind prefix `lg:order-last`", () => {
    const source = `const C = () => <div className="lg:order-last">x</div>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("order-last");
  });

  it("does NOT fire on JSX `className={expr}` (expression binding, not literal)", () => {
    // Expression-bound className is unresolvable statically — the
    // scanner does not guess. The agent sees the file and reads the
    // variable source.
    const source = `const C = ({ cls }) => <div className={cls}>x</div>;`;
    const out = runFinder(finder, source, { filePath: "c.tsx" });
    expect(out).toEqual([]);
  });
});

describe("review/meaningful-sequence — CSS authored-reorder path", () => {
  it("fires on authored selector with `order: N`", () => {
    const source = `.product-grid-item { order: 2; }`;
    const out = runFinder(finder, source, { filePath: "site.css" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("`order`");
  });

  it("fires on authored selector with `flex-direction: row-reverse`", () => {
    const source = `.hero-reversed { display: flex; flex-direction: row-reverse; }`;
    const out = runFinder(finder, source, { filePath: "site.css" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("flex-direction");
  });

  it("fires on `.product-grid .order-row { flex-direction: row-reverse }` (multi-selector, not utility)", () => {
    // Selector has a descendant combinator — not a bare utility-class
    // definition, so surfaces. This is an authored-component reorder.
    const source = `.product-grid .order-row { flex-direction: row-reverse; }`;
    const out = runFinder(finder, source, { filePath: "site.css" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("flex-direction");
  });
});

describe("review/meaningful-sequence — CSS utility-definition silence", () => {
  it("silences `.order-3 { order: 3 }` (bare utility-class definition)", () => {
    const source = `.order-3 { order: 3; }`;
    const out = runFinder(finder, source, { filePath: "bootstrap.css" });
    expect(out).toEqual([]);
  });

  it("silences every `.order-0` .. `.order-13` definition (Bootstrap utility shape)", () => {
    const rules = Array.from({ length: 14 }, (_, n) => `.order-${n} { order: ${n}; }`).join("\n");
    const out = runFinder(finder, rules, { filePath: "bootstrap.css" });
    expect(out).toEqual([]);
  });

  it("silences `.order-first` / `.order-last` / `.order-none` named utility definitions", () => {
    const source = `.order-first { order: -1; }
.order-last { order: 9999; }
.order-none { order: 0; }`;
    const out = runFinder(finder, source, { filePath: "utilities.css" });
    expect(out).toEqual([]);
  });

  it("silences `.flex-row-reverse { flex-direction: row-reverse }` utility definition", () => {
    const source = `.flex-row-reverse { flex-direction: row-reverse; }`;
    const out = runFinder(finder, source, { filePath: "bootstrap.css" });
    expect(out).toEqual([]);
  });

  it("silences `.flex-column-reverse { flex-direction: column-reverse }` (Bootstrap variant)", () => {
    const source = `.flex-column-reverse { flex-direction: column-reverse; }`;
    const out = runFinder(finder, source, { filePath: "bootstrap.css" });
    expect(out).toEqual([]);
  });

  it("silences `.grid-flow-row-dense` utility definition", () => {
    const source = `.grid-flow-row-dense { grid-auto-flow: row dense; }`;
    const out = runFinder(finder, source, { filePath: "tailwind.css" });
    // `grid-auto-flow` isn't an `order` / `flex-direction: *-reverse`
    // declaration, so nothing fires regardless — but even if it did,
    // the utility-definition gate silences it. Both invariants
    // preserved: empty output.
    expect(out).toEqual([]);
  });
});

describe("review/meaningful-sequence — response shape invariants", () => {
  it("always emits exactly 2 candidates (wcag22 + wcag21) per matched element", () => {
    const source = `<div class="order-2">x</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:1.3.2")).toBe(true);
    expect(ids.has("wcag21:1.3.2")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("carries `confidence: 'high'` on every candidate (deterministic token match)", () => {
    const source = `<div class="order-2">x</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.every((c) => c.confidence === "high")).toBe(true);
  });
});
