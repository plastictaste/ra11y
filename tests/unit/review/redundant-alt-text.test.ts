/**
 * Unit tests for the review/redundant-alt-text finder (wcag22:1.1.1).
 *
 * Counterpart to review/images-of-text — covers the "short alt text
 * is repeated in adjacent live text" predicate that historically lived
 * in `images-of-text.ts` under 1.4.5. The predicate is a 1.1.1 (Non-text
 * Content) concern: alt-text being a redundant alternative to visible
 * page copy is orthogonal to whether the image's pixels render text
 * (which is what 1.4.5 governs).
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../src/review/finders/redundant-alt-text.ts";
import { runFinder } from "../../helpers/run-finder.ts";

describe("review/redundant-alt-text", () => {
  describe("repeated-text predicate", () => {
    it("flags HTML img whose short alt text is repeated in surrounding text", () => {
      const source = `<a href="/sale"><img alt="Summer Sale" src="/promo.png"><span>Summer Sale</span></a>`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]?.criterionId).toBe("wcag22:1.1.1");
      expect(out[0]?.reason).toContain("surrounding text");
    });

    it("flags HTML img whose alt text is repeated in an immediate sibling text node", () => {
      const source = `<div><img alt="Sale" src="/p.png"> Sale </div>`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out.length).toBeGreaterThan(0);
      const aa = out.find((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa?.reason).toContain("immediate sibling text node");
    });

    it("flags JSX img whose alt is repeated in inline-sibling text", () => {
      const source = `
        const x = (
          <a href="/sale">
            <img alt="Summer Sale" src="/promo.png" />
            <span>Summer Sale</span>
          </a>
        );
      `;
      const out = runFinder(finder, source);
      expect(out.length).toBeGreaterThan(0);
      const aa = out.find((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa?.reason).toContain("surrounding text");
    });

    it("does not flag long alt text echoed nearby", () => {
      const source = `
        <div>
          <img alt="This banner contains more than five words" src="/hero-art.png">
          This banner contains more than five words
        </div>
      `;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out).toEqual([]);
    });

    it("does not flag unrelated surrounding text", () => {
      const source = `<div><img alt="Download" src="/cta.png">Upload</div>`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out).toEqual([]);
    });

    it("does not flag ordinary photos without redundant text", () => {
      const source = `<img src="/photos/mountains.jpg" alt="Mountains at sunset">`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      expect(out).toEqual([]);
    });

    it("does not flag non-img JSX components", () => {
      const source = `const x = <Image src="/brand.png" alt="Acme" />;`;
      const out = runFinder(finder, source);
      expect(out).toEqual([]);
    });
  });

  describe("cross-standard cardinality", () => {
    it("emits one candidate per matching 1.1.1 criterion id", () => {
      const source = `<a href="/sale"><img alt="Summer Sale" src="/promo.png"><span>Summer Sale</span></a>`;
      const out = runFinder(finder, source, { filePath: "input.html" });
      const ids = new Set(out.map((c) => c.criterionId));
      expect(ids.has("wcag22:1.1.1")).toBe(true);
      expect(ids.has("wcag21:1.1.1")).toBe(true);
      expect(out.length).toBe(2);
    });
  });

  describe("parent-text corpus partitions <svg> subtrees", () => {
    // When the only "surrounding text" match for an <img>'s short alt
    // attribute lives inside a sibling <svg>'s <text>/<tspan> descendant,
    // the reason names the sibling <svg> as the match source — the alt
    // is duplicating glyphs already painted by the SVG.

    it("names the sibling <svg> when the match is SVG-only (HTML img)", () => {
      const source = `<div><img alt="First slide" src="/p.png"><svg><text>First slide</text></svg></div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBeGreaterThan(0);
      const aa = out.find((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa?.reason).toContain("inside a sibling <svg>");
      expect(aa?.reason).not.toContain("is repeated in surrounding text");
    });

    it("names the sibling <svg> when the match is in a <tspan> (HTML img)", () => {
      const source = `<div><img alt="Hello" src="/p.png"><svg><text><tspan>Hello</tspan></text></svg></div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBeGreaterThan(0);
      const aa = out.find((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa?.reason).toContain("inside a sibling <svg>");
    });

    it("prefers live-HTML phrasing when BOTH live text and SVG text match", () => {
      // Live HTML text equivalence IS present — agent should see the
      // existing phrasing, not the SVG-only variant.
      const source = `<div><img alt="Sale" src="/p.png"><svg><text>Sale</text></svg><span>Sale</span></div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      expect(out.length).toBeGreaterThan(0);
      const aa = out.find((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa?.reason).toContain("is repeated in surrounding text");
      expect(aa?.reason).not.toContain("inside a sibling <svg>");
    });

    it("names the sibling <svg> when the match is SVG-only (JSX img)", () => {
      const source = `
        const x = (
          <div>
            <img alt="First slide" src="/p.png" />
            <svg><text>First slide</text></svg>
          </div>
        );
      `;
      const out = runFinder(finder, source);
      expect(out.length).toBeGreaterThan(0);
      const aa = out.find((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa?.reason).toContain("inside a sibling <svg>");
    });
  });

  describe("markdown link syntax FP scope-tightening", () => {
    // Captured case (jekyll README.markdown:58-67,78): rows of
    // `[![Sponsor N](logo-N.png)](sponsor-N-url)` produced one
    // candidate per row because each next-line URL slug
    // (`/sponsor-N`) normalized to "sponsor N" and matched the
    // adjacent `<img>`'s alt via the immediate-sibling text-node
    // predicate. The fix drops that signal in markdown contexts when
    // the adjacent text contains markdown link syntax (`](`).

    it("drops sibling-text fire when adjacent text is a markdown link slug (.markdown)", () => {
      const source = [
        "[![Sponsor 1](logo1.png)](https://example.com/sponsor-1)",
        "[![Sponsor 2](logo2.png)](https://example.com/sponsor-2)",
      ].join("\n");
      const out = runFinder(finder, source, { filePath: "README.markdown" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa).toEqual([]);
    });

    it("drops sibling-text fire when adjacent text is a markdown link slug (.md)", () => {
      const source = [
        "[![Acme](acme.png)](https://acme.example/acme-page)",
        "[![Bravo](bravo.png)](https://bravo.example/bravo-page)",
      ].join("\n");
      const out = runFinder(finder, source, { filePath: "docs/README.md" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa).toEqual([]);
    });

    it("still fires on non-markdown adjacent text (unrelated prose) in markdown files", () => {
      // Prose without markdown link syntax must still trigger the
      // sibling-text signal — the carve-out is scoped to "](" markers,
      // not to all markdown files.
      const source = `<img alt="Buy Now" src="/promo.png">Buy Now`;
      const out = runFinder(finder, source, { filePath: "page.markdown" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0]?.reason).toContain("immediate sibling text node");
    });

    it('still fires in HTML files (.html) when adjacent text contains "]("', () => {
      // The carve-out is markdown-only — `.html` files don't go through
      // the markdown rewrite, so a literal `](` in HTML text is just
      // text, and the signal must still fire.
      const source = `<div><img alt="Sale" src="/p.png">Sale](nope)</div>`;
      const out = runFinder(finder, source, { filePath: "page.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa.length).toBeGreaterThan(0);
    });
  });

  describe("photo-with-block-level-label FP scope-tightening", () => {
    // Captured case (insect-catch-game/index.html:21,27,36,45):
    // `<button class="choose-insect-btn"><img alt="fly"><p>Fly</p></button>`
    // groups produced redundant-alt candidates because the `<p>` label's
    // text matched the `<img>`'s alt via the parent-text-corpus path. The
    // partition treats block-level descendants as a "labeled-photo"
    // pattern that the agent triages differently from the inline-sibling
    // shape — replacing alt with empty would hide the button's meaning
    // for SR users; rewriting alt is the better fix. To keep the
    // migration behavior-preserving, block-level-only matches drop.

    it("drops fire when alt only matches block-level <p> sibling text (HTML)", () => {
      const source = `<button class="choose-insect-btn"><img alt="fly" src="/fly.png"><p>Fly</p></button>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa).toEqual([]);
    });

    it("drops fire when alt only matches block-level <h2> sibling text", () => {
      const source = `<section><img alt="Pricing" src="/p.png"><h2>Pricing</h2></section>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa).toEqual([]);
    });

    it("drops fire when alt only matches <figcaption> text", () => {
      const source = `<figure><img alt="Mountains" src="/m.jpg"><figcaption>Mountains</figcaption></figure>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa).toEqual([]);
    });

    it("still fires when alt matches inline <span> sibling text (existing pattern preserved)", () => {
      const source = `<a href="/sale"><img alt="Summer Sale" src="/promo.png"><span>Summer Sale</span></a>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0]?.reason).toContain("surrounding text");
    });

    it("still fires when alt matches direct text child of parent", () => {
      const source = `<div><img alt="Sale" src="/p.png"> Sale </div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa.length).toBeGreaterThan(0);
    });

    it("still fires when alt matches immediate sibling text node alongside block-sibling label", () => {
      const source = `<div><img alt="Sale" src="/p.png">Sale<p>Sale</p></div>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0]?.reason).toContain("immediate sibling text node");
    });

    it("drops fire when alt only matches block-level <p> sibling text (JSX)", () => {
      const source = `
        const x = (
          <button className="choose-insect-btn">
            <img alt="fly" src="/fly.png" />
            <p>Fly</p>
          </button>
        );
      `;
      const out = runFinder(finder, source);
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa).toEqual([]);
    });

    it("still fires in JSX when alt matches inline <span> sibling text", () => {
      const source = `
        const x = (
          <a href="/sale">
            <img alt="Summer Sale" src="/promo.png" />
            <span>Summer Sale</span>
          </a>
        );
      `;
      const out = runFinder(finder, source);
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0]?.reason).toContain("surrounding text");
    });

    it("treats nested block descendants as block-sibling text", () => {
      // The first wrapping direct-child of the parent is what
      // determines the bucket. Here the parent is <section> and its
      // direct child is <div> (block-level). Text deeper inside <div>
      // — even via an inline <span> — is still classified as
      // block-sibling text.
      const source = `<section><img alt="Hello" src="/h.png"><div><span>Hello</span></div></section>`;
      const out = runFinder(finder, source, { filePath: "x.html" });
      const aa = out.filter((c) => c.criterionId === "wcag22:1.1.1");
      expect(aa).toEqual([]);
    });
  });
});
