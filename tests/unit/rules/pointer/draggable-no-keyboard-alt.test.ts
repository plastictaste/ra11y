import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/pointer/draggable-no-keyboard-alt.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule pointer/draggable-no-keyboard-alt", () => {
  describe("fires a violation when", () => {
    it('flags a JSX element with draggable="true" and no keyboard handler', () => {
      const violations = runRule(rule, `const X = <div draggable="true">Drag me</div>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("pointer/draggable-no-keyboard-alt");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.suggestion).toMatch(/onKeyDown/);
      expect(violations[0]?.suggestion).toMatch(/Arrow keys/);
    });

    it('flags an HTML element with draggable="true" and no keyboard handler', () => {
      const violations = runRule(rule, `<li draggable="true">Item</li>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("pointer/draggable-no-keyboard-alt");
      expect(violations[0]?.suggestion).toMatch(/onkeydown/);
    });

    it("flags a JSX element whose only handler is onClick (no keyboard handler)", () => {
      const violations = runRule(
        rule,
        `const X = <div draggable="true" onClick={c} onDragStart={s}>Drag me</div>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/draggable="true"/);
    });
  });

  describe("does not fire when", () => {
    it('the JSX element carries onKeyDown alongside draggable="true"', () => {
      const violations = runRule(
        rule,
        `const X = <div draggable="true" onKeyDown={handleArrows}>Drag me</div>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it('the HTML element carries onkeydown alongside draggable="true"', () => {
      const violations = runRule(
        rule,
        `<li draggable="true" onkeydown="handleArrows(event)">Item</li>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the element does not opt into native drag (no draggable="true")', () => {
      const violations = runRule(rule, `const X = <div>Static content</div>;`);
      expect(violations).toHaveLength(0);
    });

    it("the JSX element is disabled", () => {
      const violations = runRule(rule, `const X = <div draggable="true" disabled>Drag me</div>;`);
      expect(violations).toHaveLength(0);
    });

    it('draggable is explicitly set to "false"', () => {
      const violations = runRule(rule, `const X = <div draggable="false">Static</div>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("accepts onKeyUp or onKeyPress as the keyboard handler (binary predicate)", () => {
      const onKeyUp = runRule(rule, `const X = <div draggable="true" onKeyUp={h}>Drag</div>;`);
      expect(onKeyUp).toHaveLength(0);
      const onKeyPress = runRule(
        rule,
        `const X = <div draggable="true" onKeyPress={h}>Drag</div>;`,
      );
      expect(onKeyPress).toHaveLength(0);
    });

    it("does not inspect handler body — an empty onKeyDown still satisfies the predicate (documented limitation)", () => {
      // Per the rule's knownLimitations: the static check is binary
      // (handler present vs absent). The agent reads the handler body
      // to verify it implements move/pick-up/drop semantics.
      const violations = runRule(
        rule,
        `const X = <div draggable="true" onKeyDown={() => {}}>Drag</div>;`,
      );
      expect(violations).toHaveLength(0);
    });
  });
});
