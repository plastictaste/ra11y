/**
 * Unit tests for the review/alt-duplicates-sibling-text finder
 * (wcag22:1.1.1 + wcag21:1.1.1).
 *
 * Pins:
 *   - The canonical labeled-button positive: <button><p>Fly</p><img alt="fly"></button>
 *     fires (block sibling, same interactive ancestor).
 *   - The anchor positive: <a href="…"><span>Home</span><img alt="home"></a>
 *     fires.
 *   - Inline siblings (<span>) trigger as well as block siblings (<p>).
 *   - Negative — alt="" already correct, no fire.
 *   - Negative — JSX expression alt={var}, no literal, no fire.
 *   - Negative — aria-hidden="true" sibling silenced.
 *   - Negative — generic placeholder alt ("image"), routed to alt-text-
 *     placeholder rule, no fire here.
 *   - Negative — no interactive ancestor (bare <div><p>Fly</p><img alt="fly">).
 *   - Negative — anchor without href and without role="link".
 *   - Negative — alt text not present in sibling content.
 *   - HTML and JSX surfaces both exercised inline.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/alt-duplicates-sibling-text.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return [...out.map((c) => c.criterionId)].sort();
}

describe("review/alt-duplicates-sibling-text — HTML positive cases", () => {
  it("flags <button><p>Fly</p><img alt='fly'></button>", () => {
    const source = `<button class="choose-insect-btn"><p>Fly</p><img alt="fly"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(criterionIds(out)).toEqual(["wcag21:1.1.1", "wcag22:1.1.1"]);
    expect(out[0]?.confidence).toBe("medium");
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("button");
    expect(reason).toContain("fly");
    expect(reason).toContain('alt=""');
  });

  it("flags an anchor with sibling span: <a href='/'><span>Home</span><img alt='home'></a>", () => {
    const source = `<a href="/home"><span>Home</span><img alt="home"></a>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("<a>");
  });

  it("flags an anchor with role='link' and no href", () => {
    const source = `<a role="link"><span>Profile</span><img alt="profile"></a>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("flags case-insensitive matches (alt='FLY' vs sibling 'Fly')", () => {
    const source = `<button><p>Fly</p><img alt="FLY"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("flags when alt has multiple words and all appear together in sibling text", () => {
    const source = `<button><p>Sign Up</p><img alt="sign up"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("flags when sibling text wraps the matched phrase in additional copy", () => {
    const source = `<button><p>Choose Fly to continue</p><img alt="fly"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("emits at the <img> location, not the <button> location", () => {
    const source = `<main>
  <button>
    <p>Fly</p>
    <img alt="fly">
  </button>
</main>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    // <img> sits on line 4 of the source.
    expect(out[0]?.location.line).toBe(4);
  });

  it("uses the nearest enclosing interactive ancestor when nested", () => {
    // Outer <a href> wraps an inner <button>; the img is inside the
    // button so the button is the closest interactive ancestor.
    const source = `<a href="/"><button><p>Fly</p><img alt="fly"></button></a>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("<button>");
  });
});

describe("review/alt-duplicates-sibling-text — HTML negative cases", () => {
  it("does NOT fire on alt='' (already correct)", () => {
    const source = `<button><p>Fly</p><img alt=""></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a generic placeholder alt ('image')", () => {
    const source = `<button><p>Image</p><img alt="image"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a generic placeholder alt ('photo')", () => {
    const source = `<button><p>Photo</p><img alt="photo"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when sibling text does not contain alt", () => {
    const source = `<button><p>Bee</p><img alt="fly"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when there is no interactive ancestor", () => {
    const source = `<div><p>Fly</p><img alt="fly"></div>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on an anchor without href and without role='link'", () => {
    // Bare <a> with no href is a placeholder anchor (named anchor target),
    // not interactive in the WCAG/ARIA accessible-name sense.
    const source = `<a name="frag"><span>Home</span><img alt="home"></a>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when sibling text is inside aria-hidden='true' subtree", () => {
    // The aria-hidden span is silenced for assistive tech, so it doesn't
    // participate in the accessible-name calculation; the alt isn't
    // duplicated against anything live.
    const source = `<button><span aria-hidden="true">Fly</span><img alt="fly"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when alt text is too long (sentence-length)", () => {
    // A six-word alt isn't the duplicate-label shape this finder targets.
    const source = `<button><p>Fly to the next page now</p><img alt="fly to the next page now"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when alt is a substring of one larger word", () => {
    // Whole-word matching prevents alt='cat' from firing on
    // sibling text 'caterpillar'.
    const source = `<button><p>caterpillar</p><img alt="cat"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });
});

describe("review/alt-duplicates-sibling-text — JSX positive cases", () => {
  it("flags <button><p>Fly</p><img alt='fly' /></button>", () => {
    const source = `export const X = () => (<button><p>Fly</p><img alt="fly" /></button>);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.confidence).toBe("medium");
    expect(out[0]?.reason).toContain("button");
  });

  it("flags <a href='/' ><span>Home</span><img alt='home' /></a>", () => {
    const source = `export const X = () => (<a href="/"><span>Home</span><img alt="home" /></a>);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
  });

  it("matches alt={'literal'} via the curly-string escape", () => {
    const source = `export const X = () => (<button><p>Fly</p><img alt={"fly"} /></button>);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
  });
});

describe("review/alt-duplicates-sibling-text — JSX negative cases", () => {
  it("does NOT fire on alt={variable} (non-literal expression)", () => {
    const source = `export const X = ({label}: {label: string}) => (<button><p>Fly</p><img alt={label} /></button>);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on alt='' in JSX", () => {
    const source = `export const X = () => (<button><p>Fly</p><img alt="" /></button>);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a placeholder alt ('image') in JSX", () => {
    const source = `export const X = () => (<button><p>Image</p><img alt="image" /></button>);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when JSX img has no interactive ancestor", () => {
    const source = `export const X = () => (<div><p>Fly</p><img alt="fly" /></div>);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when sibling content is in aria-hidden subtree (JSX)", () => {
    const source = `export const X = () => (<button><span aria-hidden="true">Fly</span><img alt="fly" /></button>);`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });
});

describe("review/alt-duplicates-sibling-text — finder metadata", () => {
  it("declares wcag22:1.1.1 and wcag21:1.1.1", () => {
    expect([...finder.criterionIds].sort()).toEqual(["wcag21:1.1.1", "wcag22:1.1.1"]);
  });

  it("scopes to .html, .htm, .tsx, .jsx", () => {
    expect(finder.appliesTo?.fileExtensions).toEqual([".html", ".htm", ".tsx", ".jsx"]);
  });

  it("declares confidence 'medium' on every emitted candidate", () => {
    const source = `<button><p>Fly</p><img alt="fly"></button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    for (const candidate of out) {
      expect(candidate.confidence).toBe("medium");
    }
  });
});
