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
});
