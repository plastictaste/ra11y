/**
 * Unit tests for the review/toggle-button-pressed-missing finder
 * (wcag22:4.1.2 + wcag21:4.1.2).
 *
 * Pins:
 *   - The class-token positive: a <button class="toggle"> / "switch" /
 *     "*-mode" with no aria-pressed/aria-checked/role=switch fires.
 *   - The visible-text positive: a <button>Dark mode</button> with no
 *     opt-in fires.
 *   - The opt-in negatives: aria-pressed, aria-checked, role="switch"
 *     each silence the finder.
 *   - The conservative negatives: a <button>Submit form</button> on no
 *     toggle class does NOT fire (the visible-text predicate is
 *     whole-string match against a curated list).
 *   - HTML and JSX surfaces both exercised inline.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/toggle-button-pressed-missing.ts";
import type { ReviewCandidate } from "../../../../src/types/review.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

function criterionIds(out: readonly ReviewCandidate[]): readonly string[] {
  return [...out.map((c) => c.criterionId)].sort();
}

describe("review/toggle-button-pressed-missing — HTML class-token positive cases", () => {
  it("flags <button class='toggle'>Dark mode</button>", () => {
    const source = `<button class="toggle">Dark mode</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(criterionIds(out)).toEqual(["wcag21:4.1.2", "wcag22:4.1.2"]);
    expect(out[0]?.confidence).toBe("medium");
    const reason = out[0]?.reason ?? "";
    expect(reason).toContain("aria-pressed");
    expect(reason).toContain("toggle");
  });

  it("flags <button class='theme-toggle'> via the toggle substring", () => {
    const source = `<button class="theme-toggle">X</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("theme-toggle");
  });

  it("flags <button class='mode-switcher'> via the switch substring", () => {
    const source = `<button class="mode-switcher">X</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("flags <button class='dark-mode-button'> via the mode substring", () => {
    const source = `<button class="dark-mode-button">X</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("matches case-insensitively on class tokens", () => {
    const source = `<button class="TOGGLE">x</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("emits at the <button> location", () => {
    const source = `<main>
  <button class="toggle">Dark mode</button>
</main>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.location.line).toBe(2);
  });
});

describe("review/toggle-button-pressed-missing — HTML visible-text positive cases", () => {
  it("flags <button>Dark mode</button> with no toggle class", () => {
    const source = `<button>Dark mode</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    expect(out[0]?.reason).toContain("visible text");
    expect(out[0]?.reason).toContain("dark mode");
  });

  it("flags <button>Toggle</button>", () => {
    const source = `<button>Toggle</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("flags <button>Mute</button> and <button>Unmute</button>", () => {
    const muteOut = runFinder(finder, `<button>Mute</button>`, { filePath: "page.html" });
    const unmuteOut = runFinder(finder, `<button>Unmute</button>`, { filePath: "page.html" });
    expect(muteOut.length).toBe(2);
    expect(unmuteOut.length).toBe(2);
  });

  it("matches case-insensitively on visible text", () => {
    const source = `<button>DARK MODE</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });

  it("collapses whitespace in visible text", () => {
    const source = `<button>  dark   mode  </button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
  });
});

describe("review/toggle-button-pressed-missing — HTML negative cases", () => {
  it("does NOT fire when aria-pressed is present", () => {
    const source = `<button class="toggle" aria-pressed="false">Dark mode</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when aria-checked is present", () => {
    const source = `<button class="toggle" aria-checked="false">Dark mode</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when role='switch' is present", () => {
    const source = `<button class="toggle" role="switch">Dark mode</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on <button>Submit form</button> (no class match, no visible-text match)", () => {
    const source = `<button>Submit form</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on <button>Save</button> (off-list label)", () => {
    const source = `<button>Save</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on <button class='btn primary'>Cancel</button>", () => {
    const source = `<button class="btn primary">Cancel</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when the visible text is a noun phrase containing 'toggle'", () => {
    // Whole-string match — "Dark mode toggle" is not in the curated
    // label list, so the visible-text predicate stays silent. The
    // class predicate is also absent here.
    const source = `<button>Dark mode toggle</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on a non-button element", () => {
    const source = `<a class="toggle">Dark mode</a>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out).toEqual([]);
  });
});

describe("review/toggle-button-pressed-missing — JSX positive cases", () => {
  it("flags <button className='toggle'>Dark mode</button>", () => {
    const source = `export const X = () => <button className="toggle">Dark mode</button>;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
    expect(out[0]?.confidence).toBe("medium");
  });

  it("flags <button>Toggle</button> via visible text", () => {
    const source = `export const X = () => <button>Toggle</button>;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
  });

  it("flags <button className='mode-switcher'>x</button>", () => {
    const source = `export const X = () => <button className="mode-switcher">x</button>;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out.length).toBe(2);
  });
});

describe("review/toggle-button-pressed-missing — JSX negative cases", () => {
  it("does NOT fire when aria-pressed is present", () => {
    const source = `export const X = () => <button className="toggle" aria-pressed={false}>Dark mode</button>;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire when role='switch' is present", () => {
    const source = `export const X = () => <button className="toggle" role="switch">Dark mode</button>;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });

  it("does NOT fire on <button>Submit form</button>", () => {
    const source = `export const X = () => <button>Submit form</button>;`;
    const out = runFinder(finder, source, { filePath: "X.tsx" });
    expect(out).toEqual([]);
  });
});

describe("review/toggle-button-pressed-missing — finder metadata", () => {
  it("declares wcag22:4.1.2 and wcag21:4.1.2", () => {
    expect([...finder.criterionIds].sort()).toEqual(["wcag21:4.1.2", "wcag22:4.1.2"]);
  });

  it("scopes to .html, .htm, .tsx, .jsx", () => {
    expect(finder.appliesTo?.fileExtensions).toEqual([".html", ".htm", ".tsx", ".jsx"]);
  });

  it("declares confidence 'medium' on every emitted candidate", () => {
    const source = `<button class="toggle">Dark mode</button>`;
    const out = runFinder(finder, source, { filePath: "page.html" });
    expect(out.length).toBe(2);
    for (const candidate of out) {
      expect(candidate.confidence).toBe("medium");
    }
  });
});
