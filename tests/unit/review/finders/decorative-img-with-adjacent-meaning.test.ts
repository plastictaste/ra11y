/**
 * Unit tests for the review/decorative-img-with-adjacent-meaning
 * finder (wcag22:1.1.1 + wcag21:1.1.1).
 *
 * Pins the three positive conditions (sole <img>, explicit alt="",
 * short adjacent sibling matching the affect/status dictionary) and
 * the negatives that must NOT fire (multi-img parent, alt-missing,
 * alt-non-empty, long sibling text, off-dictionary word). Both HTML
 * and JSX surfaces exercised inline; no file fixtures needed — the
 * pattern is structurally small.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/decorative-img-with-adjacent-meaning.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return out.map((c) => c.criterionId).sort();
}

describe("review/decorative-img-with-adjacent-meaning — HTML positive cases", () => {
  it("flags <img alt=''> with adjacent <small> naming affect", () => {
    const source = `<div><img alt="" src="unhappy.svg"><small>Unhappy</small></div>`;
    const out = runFinder(finder, source, { filePath: "feedback.html" });
    expect(out.length).toBe(2); // wcag22 + wcag21
    expect(criterionIds(out)).toEqual(["wcag21:1.1.1", "wcag22:1.1.1"]);
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("image marked decorative");
    expect(reason).toContain("'unhappy'");
    expect(reason).toContain("verify");
    expect(out[0]?.confidence).toBe("low");
  });

  it("flags multiple <div> siblings each matching the pattern", () => {
    const source = `<section>
      <div><img alt="" src="unhappy.svg"><small>Unhappy</small></div>
      <div><img alt="" src="happy.svg"><small>Happy</small></div>
    </section>`;
    const out = runFinder(finder, source, { filePath: "feedback.html" });
    // Two parents → two pairs of candidates (wcag22+wcag21 each).
    expect(out.length).toBe(4);
    const words = out.map((c) => c.reason).filter((r) => /'[a-z]+'/.test(r));
    expect(words.some((r) => r.includes("'unhappy'"))).toBe(true);
    expect(words.some((r) => r.includes("'happy'"))).toBe(true);
  });

  it("flags adjacent bare text node (no wrapping element)", () => {
    const source = `<div><img alt="">Success</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'success'");
  });

  it("flags adjacent <span> naming a status term", () => {
    const source = `<div><img alt="" src="ok.svg"><span>Warning</span></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'warning'");
  });

  it("matches 3-word adjacent text containing one dictionary word", () => {
    const source = `<div><img alt=""><small>No items found</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'no'");
  });

  it("emits candidate at the <img> location (not the parent)", () => {
    const source = `<div>
  <img alt="" src="error.svg">
  <small>Error</small>
</div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out.length).toBe(2);
    // <img> is on line 2 of the source. Candidate should point there.
    expect(out[0]?.location.line).toBe(2);
  });
});

describe("review/decorative-img-with-adjacent-meaning — HTML negative cases", () => {
  it("does NOT fire when the parent has two <img> children", () => {
    const source = `<div><img alt=""><img alt=""><small>Happy</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when alt attribute is absent", () => {
    const source = `<div><img src="happy.svg"><small>Happy</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when alt is a non-empty string", () => {
    // A populated alt means the author already made the image
    // non-decorative; the finder's "marked decorative" premise doesn't
    // apply. Other 1.1.1 checks handle populated-alt quality.
    const source = `<div><img alt="smiley" src="happy.svg"><small>Happy</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when adjacent text exceeds 3 words", () => {
    const source = `<div><img alt=""><small>We could not load your data</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when adjacent text is off-dictionary", () => {
    const source = `<div><img alt=""><small>Inbox</small></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the parent contains only the <img> (no sibling text)", () => {
    const source = `<div><img alt="" src="decorative.svg"></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when sibling is whitespace-only", () => {
    const source = `<div><img alt="">   \n   </div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on non-text-bearing sibling element (<svg>)", () => {
    // An <svg> sibling might itself carry text, but it's not in the
    // narrow allowlist — conservative by design to avoid matching
    // inline graphic variants we don't understand.
    const source = `<div><img alt=""><svg>error</svg></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the matched word is embedded in longer prose (>3 words)", () => {
    const source = `<div><img alt=""><p>This process has failed twice today</p></div>`;
    const out = runFinder(finder, source, { filePath: "x.html" });
    expect(out).toEqual([]);
  });
});

describe("review/decorative-img-with-adjacent-meaning — JSX positive cases", () => {
  it("flags JSX <img alt=''> with adjacent <small> naming affect", () => {
    const source = `const Row = () => (<div><img alt="" src="unhappy.svg" /><small>Unhappy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Feedback.tsx" });
    expect(out.length).toBe(2);
    expect(criterionIds(out)).toEqual(["wcag21:1.1.1", "wcag22:1.1.1"]);
    expect(out[0]?.reason).toContain("'unhappy'");
  });

  it("flags JSX with expression-bound src but literal alt=''", () => {
    // alt must be a literal empty string for the finder to see it.
    // A dynamic `alt={x}` attribute resolves to null at the finder
    // and the candidate is skipped — correct per AI-first "point,
    // don't guess" doctrine.
    const source = `const Row = ({ src }) => (<div><img alt="" src={src} /><small>Failed</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'failed'");
  });

  it("flags nested parents — inner <div> wraps the img+text pair", () => {
    const source = `const Page = () => (
      <section>
        <div><img alt="" /><span>Success</span></div>
      </section>
    );`;
    const out = runFinder(finder, source, { filePath: "Page.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("'success'");
  });
});

describe("review/decorative-img-with-adjacent-meaning — JSX negative cases", () => {
  it("does NOT fire when alt is an expression (dynamic)", () => {
    const source = `const Row = ({ label }) => (<div><img alt={label} /><small>Happy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when alt is a non-empty string", () => {
    const source = `const Row = () => (<div><img alt="smiley" /><small>Happy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on PascalCase component <Img /> (wrappers stay opaque)", () => {
    const source = `const Row = () => (<div><Img alt="" /><small>Happy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the parent has two <img> children", () => {
    const source = `const Row = () => (<div><img alt="" /><img alt="" /><small>Happy</small></div>);`;
    const out = runFinder(finder, source, { filePath: "Row.tsx" });
    expect(out).toEqual([]);
  });
});
