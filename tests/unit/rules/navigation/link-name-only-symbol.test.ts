import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/link-name-only-symbol.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/link-name-only-symbol", () => {
  describe("HTML: fires on single-codepoint symbol-only accessible names", () => {
    it("« (U+00AB left guillemet — pagination 'previous')", () => {
      const violations = runRule(rule, `<a href="/prev">«</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-name-only-symbol");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.criteria).toContain("wcag22:2.4.4");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.message).toContain("«");
      expect(violations[0]?.suggestion).toMatch(/aria-label/);
    });

    it("× (U+00D7 multiplication sign — common 'close' button shape)", () => {
      const violations = runRule(rule, `<a href="/close">×</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("×");
      // Suggestion mentions "Close" as the canonical aria-label for ×.
      expect(violations[0]?.suggestion).toMatch(/Close/);
    });

    it("› (U+203A single right angle — pagination 'next')", () => {
      const violations = runRule(rule, `<a href="/page-3">›</a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Next page/);
    });

    it("→ (U+2192 right arrow as 'continue' link)", () => {
      const violations = runRule(rule, `<a href="/checkout">→</a>`, { filePath: "cart.html" });
      expect(violations).toHaveLength(1);
    });

    it("★ (U+2605 black star as 'favorite' control)", () => {
      const violations = runRule(rule, `<a href="/star/123">★</a>`, { filePath: "post.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Favorite/);
    });

    it("&lsaquo; (named entity surviving the parser)", () => {
      const violations = runRule(rule, `<a href="/prev">&lsaquo;</a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      // Decoded glyph appears in the message after local entity decode.
      expect(violations[0]?.message).toContain("‹");
    });

    it("&times; (named entity surviving the parser)", () => {
      const violations = runRule(rule, `<a href="/close">&times;</a>`, { filePath: "modal.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("×");
    });

    it("numeric entity that decodes to a symbol (&#171; → «)", () => {
      // Numeric entities are decoded by the HTML parser upstream — the
      // text node arrives here as the literal codepoint, so the rule
      // matches it the same way as a raw glyph.
      const violations = runRule(rule, `<a href="/prev">&#171;</a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("two-character paired symbols (« ‹) inside one anchor", () => {
      const violations = runRule(rule, `<a href="/first">«‹</a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("two-character sequence");
    });

    it("symbol surrounded by whitespace ( »  ) — collapses then matches", () => {
      // Leading/trailing whitespace inside the anchor's text node should
      // not save the link; the visible accessible name is still just »
      // after collapse.
      const violations = runRule(rule, `<a href="/next">  »  </a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("anchor has aria-label override naming the destination", () => {
      const violations = runRule(rule, `<a href="/prev" aria-label="Previous page">«</a>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("anchor has aria-labelledby (override resolved cross-element)", () => {
      const violations = runRule(rule, `<a href="/prev" aria-labelledby="prev-label">«</a>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("anchor has title attribute as fallback name", () => {
      const violations = runRule(rule, `<a href="/prev" title="Previous page">«</a>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("anchor's accessible name contains a real word (no override needed)", () => {
      const violations = runRule(rule, `<a href="/prev">Previous</a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("anchor mixes a glyph with a word ('« Previous')", () => {
      const violations = runRule(rule, `<a href="/prev">« Previous</a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("anchor's name is a digit (page number) — different SC failure mode", () => {
      // Pagination "1 2 3" anchors carry digits, which are \p{N} — not
      // \p{P}/\p{S}. They may still be problematic ("Page 2" is more
      // descriptive), but that's a separate concern owned by the
      // generic-phrase / context rules.
      const violations = runRule(rule, `<a href="/page-2">2</a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("anchor has no href (handled by other rules)", () => {
      const violations = runRule(rule, `<a>«</a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("anchor itself has aria-hidden='true' (removed from a11y tree)", () => {
      const violations = runRule(rule, `<a href="/prev" aria-hidden="true">«</a>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("anchor's symbol child is aria-hidden alongside a real visible label", () => {
      // The visible accessible name (excluding the aria-hidden span) is
      // "Previous page" — well above the symbol-only threshold.
      const html = `<a href="/prev"><span aria-hidden="true">«</span> Previous page</a>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("anchor wraps a non-empty <img> (alt text supplies the name)", () => {
      const html = `<a href="/star"><img src="star.png" alt="Favorite this post"></a>`;
      const violations = runRule(rule, html, { filePath: "post.html" });
      expect(violations).toHaveLength(0);
    });

    it("non-anchor element with symbol text (only <a> is in scope)", () => {
      const violations = runRule(rule, `<span>«</span>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: edge cases", () => {
    it("real-world pagination: « 1 2 3 › fires twice (once on each glyph anchor)", () => {
      const html = `<nav>
  <a href="/page-1">«</a>
  <a href="/page-1">1</a>
  <a href="/page-2">2</a>
  <a href="/page-3">3</a>
  <a href="/page-3">›</a>
</nav>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.message).toContain("«");
      expect(violations[1]?.message).toContain("›");
    });

    it("three-character symbol sequence falls outside scope (max two)", () => {
      // "‹‹‹" or "..." — over the two-character ceiling. The rule
      // intentionally gives up rather than guess at intent; longer
      // glyph runs are rare and a separate review concern.
      const violations = runRule(rule, `<a href="/first">‹‹‹</a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("empty anchor (no visible text at all) does not fire — separate icon-only rule path", () => {
      const violations = runRule(rule, `<a href="/empty"></a>`, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("aria-label that exactly duplicates the glyph still suppresses (override path)", () => {
      // A rare authoring shape — `<a aria-label="«">«</a>`. The override
      // is honoured (override-trumps-content is the documented
      // convention shared with the pagination finder); the agent reads
      // the file and decides whether the literal-glyph aria-label is
      // intentional or a typo.
      const violations = runRule(rule, `<a href="/prev" aria-label="«">«</a>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires on symbol-only anchors", () => {
    it("<a href> with single chevron child", () => {
      const violations = runRule(rule, `export const Prev = () => <a href="/prev">«</a>;`, {
        filePath: "Prev.tsx",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-name-only-symbol");
    });

    it("<Link to> wrapper with single arrow child (React Router shape)", () => {
      const violations = runRule(
        rule,
        `import { Link } from "react-router";
export const Next = () => <Link to="/next">→</Link>;`,
        { filePath: "Next.tsx" },
      );
      expect(violations).toHaveLength(1);
    });

    it("<NavLink to> wrapper with × close glyph", () => {
      const violations = runRule(
        rule,
        `import { NavLink } from "react-router";
export const Close = () => <NavLink to="/close">×</NavLink>;`,
        { filePath: "Close.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Close/);
    });
  });

  describe("JSX: does not fire when", () => {
    it("anchor has aria-label override", () => {
      const violations = runRule(
        rule,
        `export const Prev = () => <a href="/prev" aria-label="Previous page">«</a>;`,
        { filePath: "Prev.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("anchor child is a JSX expression — opaque static evidence", () => {
      // `<a href="/x">{label}</a>` — the static view sees no text child;
      // the runtime value of `label` may carry any name. Per the
      // surface-don't-suppress doctrine we still skip rather than guess
      // (consistent with the pagination finder), since firing on opaque
      // children would mostly produce noise.
      const violations = runRule(
        rule,
        `export const Dyn = ({ label }: { label: string }) => <a href="/x">{label}</a>;`,
        { filePath: "Dyn.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("anchor has no href (different rule's scope)", () => {
      const violations = runRule(rule, `export const X = () => <a>«</a>;`, { filePath: "X.tsx" });
      expect(violations).toHaveLength(0);
    });
  });
});
