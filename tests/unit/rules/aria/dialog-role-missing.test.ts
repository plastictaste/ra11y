import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/dialog-role-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/dialog-role-missing", () => {
  describe("HTML: fires when", () => {
    it("modal-class container has all dialog signals but no role and no aria-modal", () => {
      const violations = runRule(
        rule,
        `<div class="modal-content" tabindex="-1" aria-labelledby="dlg-title" aria-hidden="false">
  <h2 id="dlg-title">Confirm</h2>
</div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/dialog-role-missing");
      expect(violations[0]?.message).toContain('role="dialog"');
      expect(violations[0]?.suggestion).toContain('role="dialog"');
      expect(violations[0]?.suggestion).toContain("aria-modal");
    });

    it("offcanvas-body container missing role + aria-modal", () => {
      const violations = runRule(
        rule,
        `<div class="offcanvas-body" tabindex="-1" aria-labelledby="oc-title" aria-hidden="true">
  <h3 id="oc-title">Menu</h3>
</div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("offcanvas");
    });

    it("popover_inner container missing role + aria-modal", () => {
      const violations = runRule(
        rule,
        `<div class="popover_inner" tabindex="-1" aria-label="Filters" aria-hidden="false"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("popover");
      // aria-label was used; message should name it as the source.
      expect(violations[0]?.message).toContain("aria-label");
    });

    it("drawer-style container missing role + aria-modal", () => {
      const violations = runRule(
        rule,
        `<aside class="drawer" tabindex="-1" aria-labelledby="d-title" aria-hidden="true">
  <h3 id="d-title">Cart</h3>
</aside>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("aside");
    });
  });

  describe("HTML: does not fire when", () => {
    it("role=dialog is set", () => {
      const violations = runRule(
        rule,
        `<div role="dialog" class="modal-content" tabindex="-1" aria-labelledby="dlg" aria-hidden="false">
  <h2 id="dlg">Confirm</h2>
</div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role=alertdialog is set", () => {
      const violations = runRule(
        rule,
        `<div role="alertdialog" class="modal" tabindex="-1" aria-labelledby="dlg" aria-hidden="false">
  <h2 id="dlg">Delete?</h2>
</div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("aria-modal is set even without role", () => {
      // Many handcrafted shells lean on the native <dialog>'s implicit
      // role plus aria-modal; `aria-modal` alone is treated as enough
      // signal that AT will announce dialog framing.
      const violations = runRule(
        rule,
        `<div aria-modal="true" class="modal" tabindex="-1" aria-labelledby="dlg" aria-hidden="false">
  <h2 id="dlg">Confirm</h2>
</div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("class token is unrelated", () => {
      const violations = runRule(
        rule,
        `<div class="card" tabindex="-1" aria-labelledby="c" aria-hidden="false">
  <h2 id="c">Title</h2>
</div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("tabindex is not -1 (not a focus-trap shell)", () => {
      const violations = runRule(
        rule,
        `<div class="modal-content" tabindex="0" aria-labelledby="dlg" aria-hidden="false"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("there is no accessible name reference", () => {
      const violations = runRule(
        rule,
        `<div class="modal-content" tabindex="-1" aria-hidden="false"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("aria-hidden is absent (no managed visibility signal)", () => {
      const violations = runRule(
        rule,
        `<div class="modal-content" tabindex="-1" aria-labelledby="dlg"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("native <dialog> element is used (implicit role=dialog)", () => {
      const violations = runRule(
        rule,
        `<dialog class="modal-content" tabindex="-1" aria-labelledby="dlg" aria-hidden="false">
  <h2 id="dlg">Confirm</h2>
</dialog>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: edge cases", () => {
    it("class-token boundary: 'modally' does NOT match", () => {
      const violations = runRule(
        rule,
        `<div class="modally-styled" tabindex="-1" aria-labelledby="x" aria-hidden="false"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("class-token boundary: 'drawerless' does NOT match", () => {
      const violations = runRule(
        rule,
        `<div class="drawerless" tabindex="-1" aria-labelledby="x" aria-hidden="false"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("multi-class string with one matching token still fires", () => {
      const violations = runRule(
        rule,
        `<div class="ui-shell modal-content fade-in" tabindex="-1" aria-labelledby="x" aria-hidden="true"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("PascalCase 'Modal' token still matches (case-insensitive)", () => {
      const violations = runRule(
        rule,
        `<div class="Modal" tabindex="-1" aria-labelledby="x" aria-hidden="false"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("aria-hidden='true' (managed-hidden state) still satisfies the signal", () => {
      const violations = runRule(
        rule,
        `<div class="modal-content" tabindex="-1" aria-labelledby="x" aria-hidden="true"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: fires when", () => {
    it("modal-content div with all signals, no role, no aria-modal", () => {
      // Using string-literal forms for tabIndex / aria-hidden — JSX
      // expression-form values (`tabIndex={-1}`) parse as Expression,
      // not StringLiteral, and `getJsxAttributeString` only inspects
      // string literals (matches the project-wide JSX attribute model
      // in `aria/hidden-focus`, `aria/required-attrs`, etc.). Authors
      // routinely use both forms; AT only sees the rendered DOM, where
      // both forms produce string attributes, so the rule's premise
      // holds for either — but matching JSX expressions is a separate
      // primitive (would need to live in `ast-helpers.ts`) and out of
      // scope for this rule.
      const violations = runRule(
        rule,
        `export function Modal() {
  return (
    <div className="modal-content" tabIndex="-1" aria-labelledby="dlg-title" aria-hidden="false">
      <h2 id="dlg-title">Confirm</h2>
    </div>
  );
}`,
        { filePath: "Modal.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/dialog-role-missing");
    });
  });

  describe("JSX: does not fire when", () => {
    it("role='dialog' is set", () => {
      const violations = runRule(
        rule,
        `export function Modal() {
  return (
    <div role="dialog" className="modal-content" tabIndex="-1" aria-labelledby="dlg" aria-hidden="false">
      <h2 id="dlg">Confirm</h2>
    </div>
  );
}`,
        { filePath: "Modal.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the tag is a PascalCase component (not an HTML element)", () => {
      // PascalCase tagNames may render to anything at runtime — we only
      // emit on lowercase HTML hosts where the role-presence check is
      // unambiguous in source.
      const violations = runRule(
        rule,
        `export function Wrapper() {
  return (
    <Modal className="modal-content" tabIndex="-1" aria-labelledby="dlg" aria-hidden="false">
      <h2 id="dlg">Confirm</h2>
    </Modal>
  );
}`,
        { filePath: "Wrapper.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });
});
