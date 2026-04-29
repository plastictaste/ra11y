/**
 * Unit tests for the review/status-message-plus-minus-readout finder
 * (wcag22:4.1.3 + wcag21:4.1.3).
 *
 * Pins:
 *   - The canonical positive: <button>+</button><span>10</span><button>-</button>
 *     fires on the middle <span> with no aria-live / role=status / role=alert.
 *   - The U+2212 MINUS SIGN variant fires (the typographically-correct
 *     decrement glyph modern design systems ship).
 *   - The opt-in negatives: aria-live / role="status" / role="alert" each
 *     silence the finder.
 *   - <output> is treated as implicit role="status" — never fires when
 *     the middle element is <output>.
 *   - The triple shape is conservative: a button whose visible text is
 *     `+1` (verbose label) does NOT fire; a `<a>` instead of `<button>`
 *     does NOT fire; an EN DASH (–) does NOT fire (range/parenthetical
 *     glyph, not a decrement).
 *   - HTML and JSX surfaces both exercised inline.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/status-message-plus-minus-readout.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return [...out.map((c) => c.criterionId)].sort();
}

describe("review/status-message-plus-minus-readout — HTML positive cases", () => {
  it("flags the canonical <button>+</button><span>10</span><button>-</button> triple", () => {
    const source = `<div><button>+</button><span id="size">10</span><button>-</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(criterionIds(out)).toEqual(["wcag21:4.1.3", "wcag22:4.1.3"]);
    expect(out[0]?.confidence).toBe("high");
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("counter-shaped");
    expect(reason).toContain("aria-live");
  });

  it("flags the U+2212 MINUS SIGN variant", () => {
    const source = `<div><button>+</button><span>10</span><button>−</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("flags <button>-</button><div>10</div><button>+</button> (order reversed, <div> middle)", () => {
    // The strict shape doesn't require a particular ordering of + and -;
    // either glyph on either side counts as long as both buttons match.
    const source = `<div><button>-</button><div>10</div><button>+</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("<div>");
  });

  it("collapses surrounding whitespace inside button text", () => {
    const source = `<div><button>  +  </button><span>10</span><button>  -  </button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("emits at the middle element's location", () => {
    const source = `<main>
  <div>
    <button>+</button>
    <span id="size">10</span>
    <button>-</button>
  </div>
</main>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.location.line).toBe(4);
  });

  it("fires when the triple sits at the document root (no enclosing element)", () => {
    const source = `<button>+</button><span>10</span><button>-</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });
});

describe("review/status-message-plus-minus-readout — HTML negative (opt-in) cases", () => {
  it("does NOT fire when the middle element has aria-live", () => {
    const source = `<div><button>+</button><span aria-live="polite">10</span><button>-</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the middle element has role='status'", () => {
    const source = `<div><button>+</button><span role="status">10</span><button>-</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the middle element has role='alert'", () => {
    const source = `<div><button>+</button><span role="alert">10</span><button>-</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the middle element is <output> (implicit role='status')", () => {
    const source = `<div><button>+</button><output>10</output><button>-</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });
});

describe("review/status-message-plus-minus-readout — HTML negative (shape) cases", () => {
  it("does NOT fire when the buttons' text is '+1' / '-1' (verbose labels)", () => {
    const source = `<div><button>+1</button><span>10</span><button>-1</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the flanking elements are <a> instead of <button>", () => {
    const source = `<div><a href="#">+</a><span>10</span><a href="#">-</a></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on EN DASH (–, U+2013) — range glyph, not decrement", () => {
    const source = `<div><button>+</button><span>10</span><button>–</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when only one button is +/- (the other carries verbose text)", () => {
    const source = `<div><button>+</button><span>10</span><button>Reset</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the middle element is not span/div/output", () => {
    const source = `<div><button>+</button><h2>10</h2><button>-</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a plain <button>+</button> with no flanking buttons", () => {
    const source = `<button>+</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when only two siblings exist (need three)", () => {
    const source = `<div><button>+</button><span>10</span></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });
});

describe("review/status-message-plus-minus-readout — JSX positive cases", () => {
  it("flags <button>+</button><span>{count}</span><button>-</button>", () => {
    const source = `export const Counter = () => (
      <div>
        <button>+</button>
        <span>{count}</span>
        <button>-</button>
      </div>
    );`;
    const out = runFinder(finder, source, { filePath: "Counter.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.confidence).toBe("high");
  });

  it("flags the Pascal-cased <Button>+</Button><span>10</span><Button>-</Button> wrapper variant", () => {
    const source = `export const X = () => (
      <div>
        <Button>+</Button>
        <span>10</span>
        <Button>-</Button>
      </div>
    );`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
  });

  it("flags the U+2212 MINUS SIGN variant in JSX", () => {
    const source = `export const X = () => (
      <div>
        <button>+</button>
        <span>10</span>
        <button>−</button>
      </div>
    );`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
  });
});

describe("review/status-message-plus-minus-readout — JSX negative cases", () => {
  it("does NOT fire when the middle element has aria-live", () => {
    const source = `export const X = () => (
      <div>
        <button>+</button>
        <span aria-live="polite">10</span>
        <button>-</button>
      </div>
    );`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the middle element has role='status'", () => {
    const source = `export const X = () => (
      <div>
        <button>+</button>
        <span role="status">10</span>
        <button>-</button>
      </div>
    );`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the middle element is <output>", () => {
    const source = `export const X = () => (
      <div>
        <button>+</button>
        <output>10</output>
        <button>-</button>
      </div>
    );`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on verbose +1 / -1 button labels", () => {
    const source = `export const X = () => (
      <div>
        <button>+1</button>
        <span>10</span>
        <button>-1</button>
      </div>
    );`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });
});

describe("review/status-message-plus-minus-readout — finder metadata", () => {
  it("declares wcag22:4.1.3 and wcag21:4.1.3", () => {
    expect([...finder.criterionIds].sort()).toEqual(["wcag21:4.1.3", "wcag22:4.1.3"]);
  });

  it("scopes to .html, .htm, .tsx, .jsx", () => {
    expect(finder.appliesTo?.fileExtensions).toEqual([".html", ".htm", ".tsx", ".jsx"]);
  });

  it("declares confidence 'high' on every emitted candidate", () => {
    const source = `<div><button>+</button><span>10</span><button>-</button></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    for (const candidate of out) {
      expect(candidate.confidence).toBe("high");
    }
  });
});
