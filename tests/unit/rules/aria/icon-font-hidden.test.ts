import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/icon-font-hidden.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/icon-font-hidden", () => {
  describe("fires a violation when", () => {
    it("Font Awesome glyph sits inside a <button> with aria-label", () => {
      const violations = runRule(
        rule,
        `<button aria-label="Close"><i class="fas fa-times"></i></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/icon-font-hidden");
      expect(violations[0]?.severity).toBe("info");
      expect(violations[0]?.message).toMatch(/Font Awesome/);
      expect(violations[0]?.message).toMatch(/aria-hidden/);
      expect(violations[0]?.suggestion).toMatch(/aria-hidden="true"/);
    });

    it("Material Icons span sits inside a labeled link", () => {
      const violations = runRule(
        rule,
        `<a href="/home"><span class="material-icons">home</span>Home</a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Material Icons/);
      expect(violations[0]?.message).toMatch(/<a>/);
    });

    it('Bootstrap Icons <i class="bi bi-*"> sits inside an aria-labelledby button', () => {
      const violations = runRule(
        rule,
        `<span id="lbl">Search</span>
         <button aria-labelledby="lbl"><i class="bi bi-search"></i></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Bootstrap Icons/);
    });

    it("Ionicons <ion-icon> custom element sits inside a labeled button", () => {
      const violations = runRule(
        rule,
        `<button aria-label="Share"><ion-icon name="share"></ion-icon></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Ionicons/);
    });

    it("Glyphicon sits inside a named link (text sibling)", () => {
      const violations = runRule(
        rule,
        `<a href="/next"><span class="glyphicon glyphicon-arrow-right"></span> Next</a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Glyphicons/);
    });

    it("fires in JSX when <button> has aria-label and an <i class='fa-*'> child", () => {
      const violations = runRule(
        rule,
        `export const X = () => (
          <button aria-label="Menu"><i className="fas fa-bars" /></button>
        );`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Font Awesome/);
    });

    it("fires on role=button ancestor with aria-label and an icon child", () => {
      const violations = runRule(
        rule,
        `<div role="button" aria-label="Toggle"><i class="fa fa-bars"></i></div>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<div>/);
    });
  });

  describe("does not fire when", () => {
    it('icon already carries aria-hidden="true"', () => {
      const violations = runRule(
        rule,
        `<button aria-label="Close"><i class="fas fa-times" aria-hidden="true"></i></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('icon carries role="presentation"', () => {
      const violations = runRule(
        rule,
        `<button aria-label="Close"><i class="fas fa-times" role="presentation"></i></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("parent <button> has no accessible name (out of scope — button-name fires instead)", () => {
      const violations = runRule(rule, `<button><i class="fas fa-times"></i></button>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("icon-font class appears on a non-interactive ancestor (decorative context)", () => {
      const violations = runRule(
        rule,
        `<div class="footer"><i class="fas fa-copyright"></i> 2026</div>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("element is not an icon-font host (unrelated class starting with 'fa')", () => {
      const violations = runRule(
        rule,
        `<button aria-label="Favorite"><span class="favorite"></span></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("link has text-only visible label, no icon-font descendant", () => {
      const violations = runRule(rule, `<a href="/docs">Docs</a>`, { filePath: "input.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("accessible name from visible text sibling (not icon-derived) still triggers when icon is unannotated", () => {
      const violations = runRule(
        rule,
        `<button><i class="fas fa-arrow-left"></i> Previous</button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("nested labeled interactive ancestors only report each icon once", () => {
      // The inner <button> is the direct interactive ancestor; the outer
      // <div role="group"> is not interactive. Only one finding expected.
      const violations = runRule(
        rule,
        `<div role="group" aria-label="Toolbar">
           <button aria-label="Close"><i class="fas fa-times"></i></button>
         </div>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("Material Symbols (newer family) is detected alongside legacy material-icons", () => {
      const violations = runRule(
        rule,
        `<button aria-label="Star"><span class="material-symbols-rounded">star</span></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Material Icons/);
    });
  });

  // The social-icon-row anti-pattern: `<a title="X"><i class="fa fa-…"></i></a>`.
  // Crediting `title` as a real accessible name was teaching the agent to add
  // aria-hidden to the icon, which regresses the link to no announced name on
  // iOS (VoiceOver ignores title for links). The rule now drops title from the
  // accessible-name computation entirely, then surfaces the row through a
  // separate "relies-on-title" finding that points at the real fix
  // (promote title → aria-label).
  describe("title-as-name anti-pattern", () => {
    it("does NOT emit the original double-announce finding for <a title='X'><i class='fa-*'></i></a>", () => {
      const violations = runRule(
        rule,
        `<a href="#" title="Facebook"><i class="fa fa-facebook"></i></a>`,
        { filePath: "input.html" },
      );
      // No finding suggests "add aria-hidden because the parent already
      // carries the accessible name" — that suggestion is the regression.
      const doubleAnnounce = violations.filter((v) =>
        /already carries the accessible name/.test(v.suggestion ?? ""),
      );
      expect(doubleAnnounce).toHaveLength(0);
    });

    it("emits the relies-on-title finding for <a title='X'><i class='fa-*'></i></a>", () => {
      const violations = runRule(
        rule,
        `<a href="#" title="Facebook"><i class="fa fa-facebook"></i></a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/relying on title is unreliable/);
      expect(violations[0]?.message).toMatch(/Facebook/);
      expect(violations[0]?.suggestion).toMatch(/aria-label="Facebook"/);
      // The suggestion must NOT teach the original anti-pattern as the
      // primary fix.
      expect(violations[0]?.suggestion).not.toMatch(
        /^Add aria-hidden="true" to the <i class="fa fa-facebook">/,
      );
    });

    it("aria-label still wins over title — no relies-on-title finding when both present", () => {
      const violations = runRule(
        rule,
        `<a href="#" aria-label="Facebook" title="Facebook"><i class="fa fa-facebook"></i></a>`,
        { filePath: "input.html" },
      );
      // Single double-announce finding (aria-label is the real name);
      // the relies-on-title path is suppressed because the ancestor has
      // a real accessible-name source.
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Font Awesome/);
      expect(violations[0]?.message).toMatch(/double-announce/);
    });

    it("visible text still wins over title — no relies-on-title finding when ancestor has real text", () => {
      const violations = runRule(
        rule,
        `<a href="#" title="Facebook"><i class="fa fa-facebook"></i> Facebook</a>`,
        { filePath: "input.html" },
      );
      // Visible text "Facebook" is the real accessible name; the
      // original double-announce finding fires (icon needs aria-hidden).
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/double-announce/);
    });

    it("does not fire when title-only ancestor has no icon-font descendant", () => {
      const violations = runRule(
        rule,
        `<a href="#" title="Facebook"><span class="visually-hidden">Facebook</span></a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("fires for JSX <a title='X'><i className='fa-*'></i></a>", () => {
      const violations = runRule(
        rule,
        `export const X = () => (
          <a href="#" title="Facebook"><i className="fa fa-facebook" /></a>
        );`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/relying on title is unreliable/);
      expect(violations[0]?.suggestion).toMatch(/aria-label="Facebook"/);
    });

    it("fires for <button title='X'><span class='material-icons'>…</span></button>", () => {
      const violations = runRule(
        rule,
        `<button title="Settings"><span class="material-icons">settings</span></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Material Icons/);
      expect(violations[0]?.message).toMatch(/relying on title is unreliable/);
    });

    it("does not fire when title is empty/whitespace", () => {
      const violations = runRule(
        rule,
        `<a href="#" title="  "><i class="fa fa-facebook"></i></a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("relies-on-title finding has a distinct findingId from the double-announce finding", () => {
      // Two ancestors, two different finding kinds, same icon family.
      // variantKey "relies-on-title" must keep them separable at the
      // engine layer (suppress / dedup flows depend on it).
      const violations = runRule(
        rule,
        `<a href="#" title="Facebook"><i class="fa fa-facebook"></i></a>
         <a href="#" aria-label="Twitter"><i class="fa fa-twitter"></i></a>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(2);
      const ids = new Set(violations.map((v) => v.findingId));
      expect(ids.size).toBe(2);
    });
  });

  // Non-interactive prose context: an icon-font glyph dropped into
  // running text (h1..h6, p, li, etc.) carries meaning the surrounding
  // text doesn't always name. Sighted users see the glyph; SR users
  // hear silence (the empty <i>) or the private-use-area codepoint.
  // The rule fires unless the icon is aria-hidden, is itself named, or
  // sits next to an sr-only sibling that carries the meaning.
  describe("non-interactive prose context", () => {
    it("fires for the canonical heart-in-h3 case (verb-icon in prose)", () => {
      const violations = runRule(
        rule,
        `<h3>Double click on the image to <i class="fas fa-heart"></i> it</h3>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Font Awesome/);
      expect(violations[0]?.message).toMatch(/non-interactive prose <h3>/);
      expect(violations[0]?.suggestion).toMatch(/aria-hidden="true"/);
      expect(violations[0]?.suggestion).toMatch(/sr-only/);
    });

    it("fires for icon inside a <p> with no aria-hidden / no sr-only", () => {
      const violations = runRule(rule, `<p>See <i class="fa fa-arrow-right"></i> for next</p>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/non-interactive prose <p>/);
    });

    it("fires for icon inside a list item", () => {
      const violations = runRule(rule, `<ul><li>Status <i class="fa fa-check"></i></li></ul>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/non-interactive prose <li>/);
    });

    it("does NOT fire when icon already carries aria-hidden", () => {
      const violations = runRule(
        rule,
        `<h3><i class="fa fa-star" aria-hidden="true"></i> Title</h3>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("does NOT fire when an sr-only sibling carries the name", () => {
      const violations = runRule(
        rule,
        `<h3><i class="fa fa-star"></i> <span class="sr-only">star</span> Title</h3>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("does NOT fire when a visually-hidden sibling carries the name (Bootstrap variant)", () => {
      const violations = runRule(
        rule,
        `<p>Status: <i class="fa fa-check"></i><span class="visually-hidden">complete</span></p>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("does NOT fire when the icon itself carries aria-label", () => {
      const violations = runRule(
        rule,
        `<h3>Click <i class="fa fa-heart" aria-label="like"></i> to like</h3>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("does NOT fire when the direct parent of the icon carries aria-label", () => {
      const violations = runRule(
        rule,
        `<p>Click <span aria-label="like"><i class="fa fa-heart"></i></span> to like</p>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("does NOT fire on icons inside a labeled-interactive nested in prose (labeled-interactive pass owns it)", () => {
      // The <button> labeled-interactive pass already emits one
      // double-announce finding for this icon. The prose-context pass
      // must NOT also emit on the same icon.
      const violations = runRule(
        rule,
        `<p>Click <button aria-label="Close"><i class="fa fa-times"></i></button> to dismiss</p>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/double-announce/);
    });

    it("fires once (not twice) on an icon inside nested prose containers", () => {
      // Both the <li> and the <p> are prose containers. The walker
      // should not double-emit — we stop at nested prose containers
      // during descent, and the outer per-prose-ancestor walk owns
      // the icons inside its closest prose ancestor.
      const violations = runRule(rule, `<li><p>Status <i class="fa fa-check"></i></p></li>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("fires for Bootstrap <span class='text-danger'> prose container", () => {
      const violations = runRule(
        rule,
        `<span class="text-danger">Error <i class="fa fa-exclamation"></i></span>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/non-interactive prose <span>/);
    });

    it("does NOT fire for plain <span> without a text-* class (too broad)", () => {
      const violations = runRule(rule, `<span><i class="fa fa-star"></i></span>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("fires for table cells (<td> is in the prose-container set)", () => {
      const violations = runRule(
        rule,
        `<table><tr><td>Status <i class="fa fa-check"></i></td></tr></table>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/non-interactive prose <td>/);
    });

    it("fires for JSX <h3> verb-icon prose case", () => {
      const violations = runRule(
        rule,
        `export const X = () => (
          <h3>Double click on the image to <i className="fas fa-heart" /> it</h3>
        );`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/non-interactive prose <h3>/);
    });

    it("does NOT fire in JSX when icon has aria-label", () => {
      const violations = runRule(
        rule,
        `export const X = () => (
          <p>Click <i className="fa fa-heart" aria-label="like" /> to like</p>
        );`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("does NOT fire in JSX when sr-only sibling carries the name", () => {
      const violations = runRule(
        rule,
        `export const X = () => (
          <h3><i className="fa fa-star" /> <span className="sr-only">star</span> Title</h3>
        );`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("prose-context finding has a distinct findingId from the double-announce finding", () => {
      // One prose-context icon, one labeled-interactive icon — the
      // variantKey "prose-context" must keep the engine's findingId
      // hash separable from the unannotated/double-announce kind.
      const violations = runRule(
        rule,
        `<h3>Click <i class="fa fa-heart"></i> to like</h3>
         <button aria-label="Close"><i class="fa fa-times"></i></button>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(2);
      const ids = new Set(violations.map((v) => v.findingId));
      expect(ids.size).toBe(2);
    });
  });
});
