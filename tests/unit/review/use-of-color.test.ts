/**
 * Unit tests for the review/use-of-color finder (wcag22:1.4.1).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/use-of-color.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/use-of-color", () => {
  it("flags a JSX element with a status-color class and visible text", () => {
    const source = `const x = <span className="text-red-600">3 unread</span>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("text-red-600");
  });

  it("flags bg-danger on a status badge with non-status-word text", () => {
    const source = `const x = <div className="bg-danger-500">3</div>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });

  it("flags an HTML element with class attribute and visible text", () => {
    const source = `<span class="text-red-500">3</span>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not flag when aria-label is present", () => {
    const source = `const x = <span className="text-red-600" aria-label="Error" />;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("still surfaces the candidate when visible text carries a status word, with enriched reason", () => {
    // Finder doctrine differs from rule doctrine. The rule suppresses
    // emission on this branch because the rule's `error` severity must
    // agree with its reason; the finder is a "please verify" candidate
    // surface, so enrichment is the consistent direction. Color may
    // still be the sole signal for a screen-reader user (no audible
    // status framing) or under a color-inverted theme — the agent
    // reads the enriched reason and dismisses (or doesn't) per case.
    const source = `const x = <span className="text-red-600">Error</span>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.reason).toContain("visible text already carries status word");
      expect(c.reason).toContain('"Error"');
    }
  });

  it("enriches reason on HTML elements whose visible text carries a status word", () => {
    // Finder's status-color-class regex matches `bg-`/`text-`/`border-`
    // and friends with hue/keyword suffixes; `btn-danger` is the rule's
    // shape, not the finder's. Use `bg-danger` here.
    const source = `<span class="bg-danger">Danger</span>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.reason).toContain("visible text already carries status word");
      expect(c.reason).toContain('"Danger"');
      expect(c.reason).toContain("color-inverted");
    }
  });

  it("does not enrich when visible text contains no status word", () => {
    // "Design" is not in the status-word set; reason should not claim
    // status-word containment when none is present.
    const source = `const x = <strong className="text-success-emphasis">Design</strong>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.reason).not.toContain("visible text already carries status word");
    }
  });

  it("does not flag when an Icon sibling is present", () => {
    const source = `const x = <span className="text-red-600"><AlertIcon /></span>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag non-status colors (blue/indigo/primary)", () => {
    const source = `const x = <span className="text-blue-500" />;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag when an <svg> child is present in HTML", () => {
    const source = `<span class="text-red-500"><svg></svg></span>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out).toEqual([]);
  });

  it("does not flag a shape-signal glyph (required asterisk idiom)", () => {
    // `*` conveys "required" by shape/convention alone — it's a G182
    // additional visual cue, so a sighted colorblind user reading the
    // form gets the signal independent of color.
    const source = `const x = <span className="text-error">*</span>;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag shape-signal glyphs (✓ / ✗ / ⚠ / →)", () => {
    for (const glyph of ["✓", "✗", "⚠", "→"]) {
      const source = `const x = <span className="text-red-600">${glyph}</span>;`;
      expect(runFinder(finder, source)).toEqual([]);
    }
  });

  it("still flags a geometric-only shape that carries no meaning by shape", () => {
    // Counterexample from the Codex review of the reverted aria-hidden
    // commit: a red dot paired with sr-only text. The dot isn't a
    // shape signal — a colorblind user sees a gray mark and learns
    // nothing from the shape alone. Must stay flagged (WCAG F81).
    const source = `const x = <span className="text-red-500">●</span>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });

  it("emits one candidate per matching criterion id", () => {
    const source = `const x = <span className="text-red-600">3</span>;`;
    const out = runFinder(finder, source);
    const ids = new Set(out.map((c) => c.criterionId));
    expect(ids.has("wcag22:1.4.1")).toBe(true);
    expect(ids.has("wcag21:1.4.1")).toBe(true);
  });

  it("emits the 'visible text' variant when the element has non-status-word text (JSX)", () => {
    // Real-world repro: Bootstrap docs html-colors fixture renders
    // <strong class="... text-success-emphasis">Design</strong>. The
    // textContent is "Design" — not a status word, not a shape glyph —
    // so the element isn't filtered, but the reason must not claim
    // "no visible text."
    const source = `const x = <strong className="text-success-emphasis">Design</strong>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.reason).not.toContain("no visible text");
      expect(c.reason).toContain("color-only indicator check");
      expect(c.reason).toContain("text-success");
    }
  });

  it("emits the 'visible text' variant when HTML element has non-status-word text", () => {
    const source = `<strong class="text-success-emphasis">Design</strong>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.reason).not.toContain("no visible text");
      expect(c.reason).toContain("color-only indicator check");
    }
  });

  it("does not flag an empty-body JSX element (validation-placeholder pattern)", () => {
    // Empty body → color cannot be the sole signal of *nothing*.
    // Field-test: 10/10 sampled candidates from a templates corpus
    // were empty-body placeholders awaiting JS-injected text.
    const source = `const x = <span className="text-red-600" />;`;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag an empty-body HTML element (validation-placeholder pattern)", () => {
    const source = `<p class="help-block text-danger"></p>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out).toEqual([]);
  });

  it("does not flag an HTML element whose only body content is a <script>", () => {
    // <script> is not user-perceivable, so the body is effectively
    // empty — same case as the validation-placeholder pattern.
    const source = `<p class="text-danger"><script>renderError()</script></p>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out).toEqual([]);
  });

  it("does not flag an HTML element whose body is only an aria-hidden subtree", () => {
    // aria-hidden=true subtree is removed from the accessibility tree;
    // a colorblind user gets no text signal from it.
    const source = `<p class="text-danger"><span aria-hidden="true">●</span></p>`;
    const out = runFinder(finder, source, { filePath: "input.html" });
    expect(out).toEqual([]);
  });

  it("flags an HTML element whose visible text lives in a descendant", () => {
    // Real-world repro: `<span class="badge bg-success">New</span>`
    // ships in cheatsheet templates. The text is the element's text
    // node child; the finder must walk the body to see it and quote
    // the snippet back so the agent doesn't re-read just to triage.
    const source = `<span class="badge bg-success"><strong>New</strong></span>`;
    const out = runFinder(finder, source, { filePath: "cheatsheet.html" });
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.reason).toContain("New");
      expect(c.reason).toContain("color-only indicator check");
    }
  });

  it("flags a JSX element whose body is an expression interpolation", () => {
    // `<small className="text-success">{version}</small>` is the
    // AddedIn.astro shape — the runtime text is unknown statically,
    // but the body is non-empty and the candidate must not be
    // silently dropped as if it were a placeholder.
    const source = `const x = <small className="text-success">{version}</small>;`;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      // Reason quotes the expression as a content sentinel so the
      // agent knows the body is interpolated rather than empty.
      expect(c.reason).toContain("{version}");
    }
  });

  it("collapses multi-line body whitespace before quoting it in the reason", () => {
    // Reason text is a single-line snippet; raw newlines in the body
    // would balloon the response without adding signal.
    const source = `<p class="text-warning">No grid classes\n      were detected here.</p>`;
    const out = runFinder(finder, source, { filePath: "grid.html" });
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.reason).not.toContain("\n");
      expect(c.reason).toContain("No grid classes");
    }
  });
});
