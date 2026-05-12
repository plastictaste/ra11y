import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/button-name-only-symbol.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/button-name-only-symbol", () => {
  describe("HTML: fires on single-codepoint symbol-only accessible names", () => {
    it("× (U+00D7 multiplication sign — canonical 'close' button)", () => {
      const violations = runRule(rule, `<button>×</button>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/button-name-only-symbol");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.criteria).toContain("wcag21:4.1.2");
      expect(violations[0]?.message).toContain("×");
      // Suggestion mentions "Close" as the canonical aria-label for ×.
      expect(violations[0]?.suggestion).toMatch(/Close/);
    });

    it("+ (U+002B plus sign — 'add' control)", () => {
      const violations = runRule(rule, `<button>+</button>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Add/);
    });

    it("- (U+002D hyphen-minus — 'remove' control)", () => {
      const violations = runRule(rule, `<button>-</button>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Remove/);
    });

    it("? (U+003F question mark — 'help' button)", () => {
      const violations = runRule(rule, `<button>?</button>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Help/);
    });

    it("X (single ASCII letter is NOT in scope — letter exits the rule)", () => {
      // A letter is real text — \p{P}/\p{S} does NOT cover \p{L}. The
      // backlog item names "X" as a symbol-shaped close button, but
      // statically it's indistinguishable from the start of "Xeon" or
      // a real one-letter abbreviation. The rule intentionally stays
      // tight: punctuation/symbol only.
      const violations = runRule(rule, `<button>X</button>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("› (U+203A single right angle — 'next' button)", () => {
      const violations = runRule(rule, `<button>›</button>`, { filePath: "wizard.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Next/);
    });

    it("→ (U+2192 right arrow — 'continue' button)", () => {
      const violations = runRule(rule, `<button>→</button>`, { filePath: "form.html" });
      expect(violations).toHaveLength(1);
    });

    it("★ (U+2605 black star — 'favorite' toggle)", () => {
      const violations = runRule(rule, `<button>★</button>`, { filePath: "post.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Favorite/);
    });

    it("⏵ (U+23F5 black medium right-pointing triangle — 'play')", () => {
      const violations = runRule(rule, `<button>⏵</button>`, { filePath: "player.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Play/);
    });

    it("⏸ (U+23F8 double vertical bar — 'pause')", () => {
      const violations = runRule(rule, `<button>⏸</button>`, { filePath: "player.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Pause/);
    });

    it("… (U+2026 horizontal ellipsis — 'more options')", () => {
      const violations = runRule(rule, `<button>…</button>`, { filePath: "menu.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/More options/);
    });

    it("&times; (named entity surviving the parser)", () => {
      const violations = runRule(rule, `<button>&times;</button>`, { filePath: "modal.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("×");
    });

    it("numeric entity that decodes to a symbol (&#171; → «)", () => {
      // Numeric entities are decoded by the HTML parser upstream — the
      // text node arrives here as the literal codepoint, so the rule
      // matches it the same way as a raw glyph.
      const violations = runRule(rule, `<button>&#171;</button>`, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("two-character paired symbols (≪) inside one button", () => {
      const violations = runRule(rule, `<button>«‹</button>`, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("two-character sequence");
    });

    it("symbol surrounded by whitespace (  ×  ) — collapses then matches", () => {
      const violations = runRule(rule, `<button>  ×  </button>`, { filePath: "modal.html" });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("button has aria-label override naming the action", () => {
      const violations = runRule(rule, `<button aria-label="Close dialog">×</button>`, {
        filePath: "modal.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("button has aria-labelledby (override resolved cross-element)", () => {
      const violations = runRule(rule, `<button aria-labelledby="close-label">×</button>`, {
        filePath: "modal.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("button has title attribute as fallback name", () => {
      const violations = runRule(rule, `<button title="Close dialog">×</button>`, {
        filePath: "modal.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("button's accessible name contains a real word (no override needed)", () => {
      const violations = runRule(rule, `<button>Close</button>`, { filePath: "modal.html" });
      expect(violations).toHaveLength(0);
    });

    it("button mixes a glyph with a word ('× Close')", () => {
      const violations = runRule(rule, `<button>× Close</button>`, { filePath: "modal.html" });
      expect(violations).toHaveLength(0);
    });

    it("button's name is a digit (step number) — different SC failure mode", () => {
      // Digits are \p{N} — not \p{P}/\p{S}. A wizard step button labeled
      // "2" may still be problematic ("Step 2 of 5" is more descriptive),
      // but that's a separate concern owned by the contextual-name rules.
      const violations = runRule(rule, `<button>2</button>`, { filePath: "wizard.html" });
      expect(violations).toHaveLength(0);
    });

    it("button itself has aria-hidden='true' (removed from a11y tree)", () => {
      const violations = runRule(rule, `<button aria-hidden="true">×</button>`, {
        filePath: "modal.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("button's symbol child is aria-hidden alongside a real visible label", () => {
      // The visible accessible name (excluding the aria-hidden span) is
      // "Close" — well above the symbol-only threshold.
      const html = `<button><span aria-hidden="true">×</span> Close</button>`;
      const violations = runRule(rule, html, { filePath: "modal.html" });
      expect(violations).toHaveLength(0);
    });

    it("button wraps a non-empty <img> (alt text supplies the name)", () => {
      const html = `<button><img src="close.png" alt="Close dialog"></button>`;
      const violations = runRule(rule, html, { filePath: "modal.html" });
      expect(violations).toHaveLength(0);
    });

    it("non-button element with symbol text and no role='button' (out of scope)", () => {
      const violations = runRule(rule, `<span>×</span>`, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("empty button (no visible text) — handled by semantics/button-name, not this rule", () => {
      // Empty content has zero codepoints; the symbol-only predicate
      // requires 1–2 codepoints. Stay silent so `semantics/button-name`
      // remains the canonical rule for the empty-button case.
      const violations = runRule(rule, `<button></button>`, { filePath: "modal.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: role='button' fires the same way as <button>", () => {
    it("<div role='button'>×</div> with no name fires", () => {
      const violations = runRule(rule, `<div role="button">×</div>`, { filePath: "modal.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/role="button"/);
    });

    it("<span role='button' aria-label='Close'>×</span> does not fire", () => {
      const violations = runRule(rule, `<span role="button" aria-label="Close">×</span>`, {
        filePath: "modal.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: edge cases", () => {
    it("real-world toolbar: ×, ?, !, … each fire once", () => {
      const html = `<div role="toolbar">
  <button>×</button>
  <button>?</button>
  <button>!</button>
  <button>…</button>
</div>`;
      const violations = runRule(rule, html, { filePath: "toolbar.html" });
      expect(violations).toHaveLength(4);
    });

    it("three-character symbol sequence falls outside scope (max two)", () => {
      const violations = runRule(rule, `<button>‹‹‹</button>`, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("aria-label that exactly duplicates the glyph still suppresses (override path)", () => {
      // A rare authoring shape — `<button aria-label="×">×</button>`. The
      // override is honoured (override-trumps-content is the documented
      // convention); the agent reads the file and decides whether the
      // literal-glyph aria-label is intentional or a typo.
      const violations = runRule(rule, `<button aria-label="×">×</button>`, {
        filePath: "modal.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires on symbol-only buttons", () => {
    it("<button> with single × child", () => {
      const violations = runRule(rule, `export const Close = () => <button>×</button>;`, {
        filePath: "Close.tsx",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/button-name-only-symbol");
    });

    it("<button> with + plus glyph (add control)", () => {
      const violations = runRule(rule, `export const Add = () => <button>+</button>;`, {
        filePath: "Add.tsx",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Add/);
    });

    it("<IconButton>×</IconButton> mapped wrapper", () => {
      const violations = runRule(
        rule,
        `export const Close = () => <IconButton>×</IconButton>;`,
        {
          filePath: "Close.tsx",
          nativeWrapperElements: { IconButton: "button" },
        },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("button has aria-label override", () => {
      const violations = runRule(
        rule,
        `export const Close = () => <button aria-label="Close dialog">×</button>;`,
        { filePath: "Close.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("button child is a JSX expression — opaque static evidence", () => {
      // `<button>{label}</button>` — the static view sees no text child;
      // the runtime value of `label` may carry any name. Per the
      // surface-don't-suppress doctrine we still skip rather than guess
      // (consistent with the link sibling), since firing on opaque
      // children would mostly produce noise.
      const violations = runRule(
        rule,
        `export const Dyn = ({ label }: { label: string }) => <button>{label}</button>;`,
        { filePath: "Dyn.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("button has a literal text child with a real word", () => {
      const violations = runRule(
        rule,
        `export const Save = () => <button>Save</button>;`,
        { filePath: "Save.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("<div role='button'> in JSX with aria-label does not fire", () => {
      const violations = runRule(
        rule,
        `export const Close = () => <div role="button" aria-label="Close">×</div>;`,
        { filePath: "Close.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });
});
