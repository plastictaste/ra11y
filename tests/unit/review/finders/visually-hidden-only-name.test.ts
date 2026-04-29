/**
 * Unit tests for the review/visually-hidden-only-name finder
 * (wcag22:2.4.4 + wcag21:2.4.4).
 *
 * Pins:
 *   - The canonical carousel-control shape (anchor with .visually-hidden
 *     text + aria-hidden icon sibling) fires.
 *   - Equivalent shapes on <button> and inside JSX <Link> wrappers fire.
 *   - Candidate `reason` echoes the visually-hidden text so the agent
 *     can spot the copy-paste-regression case in one read.
 *   - Negatives: aria-label / aria-labelledby / title on the
 *     interactive element each silence the finder (different question);
 *     missing aria-hidden icon silences (no cross-channel mismatch);
 *     missing visually-hidden text silences (no hidden-only-name shape);
 *     visible non-hidden text alongside silences (the visible text IS
 *     the accessible name, no mismatch to verify).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/visually-hidden-only-name.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return [...out.map((c) => c.criterionId)].sort();
}

describe("review/visually-hidden-only-name — HTML positive cases", () => {
  it("flags the canonical carousel previous-button shape", () => {
    const source = `<a href="#prev"><span class="visually-hidden">Previous</span><span aria-hidden="true" class="icon-prev"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out.length).toBe(2);
    expect(criterionIds(out)).toEqual(["wcag21:2.4.4", "wcag22:2.4.4"]);
    expect(out[0]?.confidence).toBe("medium");
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain('"Previous"');
    expect(reason).toContain("aria-hidden");
    expect(reason).toContain("<a>");
  });

  it("flags the carousel next-button shape (sr-only token variant)", () => {
    const source = `<a href="#next"><span class="sr-only">Next</span><span aria-hidden="true" class="icon-next"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain('"Next"');
  });

  it("flags <button> with the same visually-hidden + aria-hidden shape", () => {
    const source = `<button><span class="visually-hidden">Close</span><span aria-hidden="true" class="icon-x"></span></button>`;
    const out = runFinder(finder, source, { filePath: "modal.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("<button>");
    expect(out[0]?.reason).toContain('"Close"');
  });

  it("flags when the icon precedes the visually-hidden text", () => {
    const source = `<a href="#prev"><i aria-hidden="true" class="icon-prev"></i><span class="visually-hidden">Previous slide</span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out.length).toBe(2);
  });

  it("recognises screen-reader-text and screenreader-only tokens", () => {
    const source = `<a href="#x"><span class="screen-reader-text">Open menu</span><span aria-hidden="true" class="icon"></span></a>`;
    const out = runFinder(finder, source, { filePath: "menu.html" });
    expect(out.length).toBe(2);
  });

  it("emits at the interactive element's start line", () => {
    const source = `<nav>
  <a href="#prev"><span class="visually-hidden">Previous</span><span aria-hidden="true"></span></a>
</nav>`;
    const out = runFinder(finder, source, { filePath: "nav.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.location.line).toBe(2);
  });

  it("collapses whitespace inside the hidden text echoed in the reason", () => {
    const source = `<a href="#prev"><span class="visually-hidden">  Previous   slide  </span><span aria-hidden="true"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain('"Previous slide"');
  });

  it("flags when the aria-hidden icon is nested deeper (not a direct child)", () => {
    const source = `<a href="#prev"><span class="visually-hidden">Previous</span><span class="wrap"><i aria-hidden="true"></i></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out.length).toBe(2);
  });
});

describe("review/visually-hidden-only-name — HTML negative cases", () => {
  it("does NOT fire when the interactive element carries aria-label", () => {
    const source = `<a href="#prev" aria-label="Previous"><span class="visually-hidden">Previous</span><span aria-hidden="true"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the interactive element carries aria-labelledby", () => {
    const source = `<a href="#prev" aria-labelledby="prev-label"><span class="visually-hidden">Previous</span><span aria-hidden="true"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the interactive element carries a title attribute", () => {
    const source = `<a href="#prev" title="Previous slide"><span class="visually-hidden">Previous</span><span aria-hidden="true"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when there is no aria-hidden icon (visually-hidden text alone is not the cross-channel mismatch)", () => {
    const source = `<a href="#prev"><span class="visually-hidden">Previous</span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when there is no visually-hidden child", () => {
    const source = `<a href="#prev"><span aria-hidden="true" class="icon"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when visible non-hidden text accompanies the icon", () => {
    // The visible text "Previous" IS the accessible name; the
    // visually-hidden span is then redundant but not the cross-channel
    // mismatch this finder targets.
    const source = `<a href="#prev"><span class="visually-hidden">Previous</span><span aria-hidden="true"></span> Previous</a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on <a> without href (not interactive in the link sense)", () => {
    const source = `<a><span class="visually-hidden">Previous</span><span aria-hidden="true"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the visually-hidden span is empty", () => {
    const source = `<a href="#prev"><span class="visually-hidden"></span><span aria-hidden="true"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a non-interactive element wrapping the same shape", () => {
    const source = `<div><span class="visually-hidden">Previous</span><span aria-hidden="true"></span></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when a non-empty aria-label silences even with the visually-hidden + icon shape", () => {
    // Empty aria-label is treated as missing per the accessible-name
    // algorithm — an empty override does NOT silence the finder.
    const sourceEmpty = `<a href="#prev" aria-label=""><span class="visually-hidden">Previous</span><span aria-hidden="true"></span></a>`;
    const outEmpty = runFinder(finder, sourceEmpty, { filePath: "carousel.html" });
    expect(outEmpty.length).toBe(2);

    const sourceFilled = `<a href="#prev" aria-label="Previous"><span class="visually-hidden">Previous</span><span aria-hidden="true"></span></a>`;
    const outFilled = runFinder(finder, sourceFilled, { filePath: "carousel.html" });
    expect(outFilled).toEqual([]);
  });
});

describe("review/visually-hidden-only-name — JSX positive cases", () => {
  it("flags a JSX anchor with the carousel-control shape", () => {
    const source = `const Prev = () => (
  <a href="#prev">
    <span className="visually-hidden">Previous</span>
    <span aria-hidden="true" className="icon-prev"></span>
  </a>
);`;
    const out = runFinder(finder, source, { filePath: "Carousel.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain('"Previous"');
  });

  it("flags a <Link> wrapper with the same shape", () => {
    const source = `const Prev = () => (
  <Link to="/prev">
    <span className="sr-only">Previous</span>
    <span aria-hidden="true" className="icon-prev"></span>
  </Link>
);`;
    const out = runFinder(finder, source, { filePath: "Carousel.tsx" });
    expect(out.length).toBe(2);
  });

  it("flags a JSX <button> with the close-icon shape", () => {
    const source = `const Close = () => (
  <button>
    <span className="visually-hidden">Close</span>
    <span aria-hidden="true" className="icon-x"></span>
  </button>
);`;
    const out = runFinder(finder, source, { filePath: "Modal.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("<button>");
  });
});

describe("review/visually-hidden-only-name — JSX negative cases", () => {
  it("does NOT fire when the JSX anchor carries aria-label", () => {
    const source = `const Prev = () => (
  <a href="#prev" aria-label="Previous">
    <span className="visually-hidden">Previous</span>
    <span aria-hidden="true"></span>
  </a>
);`;
    const out = runFinder(finder, source, { filePath: "Carousel.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when JSX has an opaque expression child (visible / hidden partition is unobservable)", () => {
    const source = `const Prev = ({label}) => (
  <a href="#prev">
    <span className="visually-hidden">{label}</span>
    <span aria-hidden="true"></span>
  </a>
);`;
    const out = runFinder(finder, source, { filePath: "Carousel.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on <a> without an href / to attribute", () => {
    const source = `const X = () => (
  <a>
    <span className="visually-hidden">Previous</span>
    <span aria-hidden="true"></span>
  </a>
);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the aria-hidden icon is missing (visually-hidden alone)", () => {
    const source = `const Prev = () => (
  <a href="#prev">
    <span className="visually-hidden">Previous</span>
  </a>
);`;
    const out = runFinder(finder, source, { filePath: "Carousel.tsx" });
    expect(out).toEqual([]);
  });
});

describe("review/visually-hidden-only-name — finder metadata", () => {
  it("declares wcag22:2.4.4 and wcag21:2.4.4", () => {
    expect([...finder.criterionIds].sort()).toEqual(["wcag21:2.4.4", "wcag22:2.4.4"]);
  });

  it("scopes to .html, .htm, .tsx, .jsx", () => {
    expect(finder.appliesTo?.fileExtensions).toEqual([".html", ".htm", ".tsx", ".jsx"]);
  });

  it("declares confidence 'medium' on every emitted candidate", () => {
    const source = `<a href="#prev"><span class="visually-hidden">Previous</span><span aria-hidden="true"></span></a>`;
    const out = runFinder(finder, source, { filePath: "carousel.html" });
    expect(out.length).toBe(2);
    for (const candidate of out) {
      expect(candidate.confidence).toBe("medium");
    }
  });
});
