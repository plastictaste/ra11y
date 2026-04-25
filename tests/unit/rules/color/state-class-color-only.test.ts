import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/color/state-class-color-only.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule color/state-class-color-only", () => {
  describe("fires a violation when", () => {
    it("a `.active` class declares only color and background-color", () => {
      const src = `.tab.active { color: #1a56db; background-color: #fff; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("color/state-class-color-only");
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("color");
      expect(v[0]?.message).toContain(".active");
      expect(v[0]?.suggestion).toContain("non-color");
    });

    it("a `.is-selected` class declares only color-family longhands", () => {
      const src = `.list-item.is-selected { color: white; background-color: navy; border-color: navy; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(".is-selected");
    });

    it('a `[aria-selected="true"]` selector declares only color cues', () => {
      const src = `[aria-selected="true"] { color: blue; background-color: lightblue; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("aria-selected");
    });

    it("a `[aria-current]` attribute selector declares only color cues", () => {
      const src = `nav a[aria-current] { color: #c00; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });

    it("a `:checked` pseudo-class declares only color cues", () => {
      const src = `input:checked + label { color: green; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("checked");
    });

    it("a `.disabled` class with only `background` shorthand carrying a pure color", () => {
      const src = `.btn.disabled { background: #eee; color: #aaa; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });
  });

  describe("does not fire when", () => {
    it("the state class adds `font-weight: bold`", () => {
      const src = `.tab.active { color: #1a56db; background-color: #fff; font-weight: 600; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("the state class adds `text-decoration: underline`", () => {
      const src = `.tab.active { color: #1a56db; text-decoration: underline; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("the state class declares a non-color border", () => {
      const src = `.tab.active { color: #1a56db; border-bottom: 2px solid #1a56db; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("the state class declares a `background-image`", () => {
      const src = `.tab.selected { color: white; background-image: url('checkmark.svg'); }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("the state class declares an `outline` with thickness/style", () => {
      const src = `.option.selected { color: blue; outline: 2px solid blue; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("the selector is `:hover` (transient interaction, not state)", () => {
      const src = `.btn:hover { color: blue; background-color: lightblue; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("the selector is `:focus-visible` (focus indicator, not state)", () => {
      const src = `.btn:focus-visible { color: blue; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("a longer class name contains `.active` as a substring", () => {
      const src = `.activeMenu { color: red; background-color: white; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("the state class adds `transform`", () => {
      const src = `.tab.active { color: blue; transform: scale(1.05); }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("the state class adds `content` via `::after`", () => {
      const src = `.tab.active::after { content: " ●"; color: blue; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("emits one finding per matching CSS rule, not one per declaration", () => {
      const src = `.tab.active { color: blue; background-color: white; border-color: blue; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });

    it("emits separate findings for multiple state-class rules in the same file", () => {
      const src = `
        .tab.active { color: blue; background-color: white; }
        .tab.disabled { color: gray; }
      `;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(2);
    });

    it("does not fire on rules with empty declaration body", () => {
      const src = `.tab.active { }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(0);
    });

    it("fires inside an `@media` block (walker descends into at-rules)", () => {
      const src = `@media (min-width: 600px) { .tab.active { color: blue; background-color: white; } }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });

    it("fires on `text-decoration-color` longhand alone (color-family longhand, no line)", () => {
      const src = `.tab.active { text-decoration-color: red; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
    });

    it("severity is `warning` not `error` (predicate concedes the cascade may carry a second channel)", () => {
      const src = `.tab.active { color: #1a56db; }`;
      const v = runRule(rule, src, { filePath: "styles.css" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });
  });
});
