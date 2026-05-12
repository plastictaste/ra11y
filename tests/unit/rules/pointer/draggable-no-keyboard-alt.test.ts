import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/pointer/draggable-no-keyboard-alt.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule pointer/draggable-no-keyboard-alt", () => {
  describe("fires a violation when", () => {
    it("flags a natively-interactive JSX element with draggable but no keyboard handler", () => {
      // <a draggable="true"> is keyboard-focusable for Enter/Space
      // activation, but the drag operation itself is keyboard-
      // inoperable. `keyboard/handler-missing` exempts native
      // interactive tags, so this rule is the canonical 2.1.1 emitter
      // for the drag-on-native shape.
      const violations = runRule(
        rule,
        `const X = <a href="#" draggable="true">Drag me</a>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("pointer/draggable-no-keyboard-alt");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.suggestion).toMatch(/onKeyDown/);
      expect(violations[0]?.suggestion).toMatch(/Arrow keys/);
    });

    it("flags a button[draggable] with no keyboard handler", () => {
      const violations = runRule(
        rule,
        `const X = <button draggable="true" type="button">Drag</button>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/draggable="true"/);
    });

    it("flags a JSX PascalCase component with draggable and no keyboard handler", () => {
      // `keyboard/handler-missing` trusts PascalCase components by
      // default (it can't see their internals). This rule still fires
      // because the draggable attribute is observable on the JSX
      // surface — the agent reads the component source to confirm
      // keyboard wiring is missing.
      const violations = runRule(
        rule,
        `const X = <DragHandle draggable="true">Drag me</DragHandle>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/custom component/);
    });

    it("flags an HTML <a> with draggable and no keyboard handler", () => {
      const violations = runRule(
        rule,
        `<a href="#" draggable="true">Drag</a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/onkeydown/);
    });
  });

  describe("does not fire when", () => {
    it("a natively-interactive element carries onKeyDown alongside draggable", () => {
      const violations = runRule(
        rule,
        `const X = <a href="#" draggable="true" onKeyDown={handleArrows}>Drag</a>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML <a> carries onkeydown alongside draggable", () => {
      const violations = runRule(
        rule,
        `<a href="#" draggable="true" onkeydown="handleArrows(event)">Drag</a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the element does not opt into native drag (no draggable=\"true\")", () => {
      const violations = runRule(rule, `const X = <a href="#">Static content</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("the natively-interactive element is disabled", () => {
      const violations = runRule(
        rule,
        `const X = <button draggable="true" disabled>Drag</button>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("draggable is explicitly set to \"false\"", () => {
      const violations = runRule(rule, `const X = <a href="#" draggable="false">Static</a>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("co-rule coalescing", () => {
    // The bare <div draggable="true"> case is covered by:
    //   - keyboard/handler-missing for SC 2.1.1
    //   - pointer/drag-alternative for SC 2.5.7
    // Emitting a third finding from this rule on the same element
    // would duplicate the agent's budget with overlapping criteria.
    // Per AI-first doctrine "Composite headline counts are dishonest"
    // and "Per-tool lane and warning-set classification must agree."
    it("does not fire on a bare <div draggable=\"true\"> (co-rules cover it)", () => {
      const violations = runRule(rule, `const X = <div draggable="true">Drag</div>;`);
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a bare <span draggable=\"true\"> (co-rules cover it)", () => {
      const violations = runRule(rule, `const X = <span draggable="true">Drag</span>;`);
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a bare <li draggable=\"true\"> (co-rules cover it)", () => {
      const violations = runRule(rule, `const X = <li draggable="true">Item</li>;`);
      expect(violations).toHaveLength(0);
    });

    it("does not fire on HTML <div draggable=\"true\"> (co-rules cover it)", () => {
      const violations = runRule(rule, `<div draggable="true">Drag</div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("suggestion shape", () => {
    it("does not contain the suppress-with pragma cue (would route to suppress-recommended lane)", () => {
      // Doctrine "Suppress-recommended is a distinct discriminator
      // from guidance": when the rule honestly emits a real violation,
      // the suggestion must not concede a pragma — that would route
      // the per-call suggest_fix shape into the suppress-recommended
      // lane and `plan.fixesByClass.suppressRecommended`, mismatching
      // the rule's `fixClass: "verify-in-source"` declaration.
      const violations = runRule(rule, `const X = <a href="#" draggable="true">Drag</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).not.toContain("suppress with");
      expect(violations[0]?.suggestion).not.toContain("ra11y-disable");
    });

    it("HTML emission suggestion is also free of suppression cues", () => {
      const violations = runRule(rule, `<a href="#" draggable="true">Drag</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).not.toContain("suppress with");
      expect(violations[0]?.suggestion).not.toContain("ra11y-disable");
    });
  });

  describe("edge cases", () => {
    it("accepts onKeyUp or onKeyPress as the keyboard handler (binary predicate)", () => {
      const onKeyUp = runRule(rule, `const X = <a href="#" draggable="true" onKeyUp={h}>Drag</a>;`);
      expect(onKeyUp).toHaveLength(0);
      const onKeyPress = runRule(
        rule,
        `const X = <a href="#" draggable="true" onKeyPress={h}>Drag</a>;`,
      );
      expect(onKeyPress).toHaveLength(0);
    });

    it("does not inspect handler body — an empty onKeyDown still satisfies the predicate (documented limitation)", () => {
      // Per the rule's knownLimitations: the static check is binary
      // (handler present vs absent). The agent reads the handler body
      // to verify it implements move/pick-up/drop semantics.
      const violations = runRule(
        rule,
        `const X = <a href="#" draggable="true" onKeyDown={() => {}}>Drag</a>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("aria-disabled exempts the element from emission", () => {
      const violations = runRule(
        rule,
        `const X = <a href="#" draggable="true" aria-disabled="true">Drag</a>;`,
      );
      expect(violations).toHaveLength(0);
    });
  });
});
