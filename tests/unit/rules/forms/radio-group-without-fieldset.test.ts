import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/radio-group-without-fieldset.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/radio-group-without-fieldset", () => {
  describe("HTML: fires a violation when", () => {
    it("two radios share a name with no wrapping fieldset or radiogroup", () => {
      const violations = runRule(
        rule,
        `<form>
          <label><input type="radio" name="speed" value="std"> Standard</label>
          <label><input type="radio" name="speed" value="exp"> Express</label>
          <button type="submit">Ship it</button>
        </form>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/radio-group-without-fieldset");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).toContain(`name="speed"`);
      expect(violations[0]?.message).toContain('2 <input type="radio"');
      expect(violations[0]?.suggestion).toMatch(/fieldset/);
      expect(violations[0]?.suggestion).toMatch(/legend/);
    });

    it("radios are wrapped by a <fieldset> that has no <legend> and no aria-label", () => {
      const violations = runRule(
        rule,
        `<fieldset>
          <label><input type="radio" name="priority" value="low"> Low</label>
          <label><input type="radio" name="priority" value="med"> Medium</label>
          <label><input type="radio" name="priority" value="hi"> High</label>
        </fieldset>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/wrapped by a <fieldset>/);
      expect(violations[0]?.message).toMatch(/no <legend>/);
      expect(violations[0]?.suggestion).toMatch(/<legend>/);
    });

    it("radios are wrapped by role='radiogroup' with no aria-label or aria-labelledby", () => {
      const violations = runRule(
        rule,
        `<div role="radiogroup">
          <label><input type="radio" name="size" value="s"> Small</label>
          <label><input type="radio" name="size" value="m"> Medium</label>
          <label><input type="radio" name="size" value="l"> Large</label>
        </div>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/role="radiogroup"/);
      expect(violations[0]?.message).toMatch(/no accessible name/);
      expect(violations[0]?.suggestion).toMatch(/aria-label/);
    });

    it("role='radiogroup' container has an empty aria-label", () => {
      const violations = runRule(
        rule,
        `<div role="radiogroup" aria-label="   ">
          <label><input type="radio" name="color" value="r"> Red</label>
          <label><input type="radio" name="color" value="b"> Blue</label>
        </div>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/radiogroup/);
    });

    it("fires one violation per group, not one per input", () => {
      const violations = runRule(
        rule,
        `<form>
          <label><input type="radio" name="a" value="1"> One</label>
          <label><input type="radio" name="a" value="2"> Two</label>
          <label><input type="radio" name="a" value="3"> Three</label>
          <label><input type="radio" name="a" value="4"> Four</label>
        </form>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('4 <input type="radio"');
    });

    it("fires separately for each independently-named radio group", () => {
      const violations = runRule(
        rule,
        `<form>
          <label><input type="radio" name="speed" value="a"> A</label>
          <label><input type="radio" name="speed" value="b"> B</label>
          <label><input type="radio" name="priority" value="x"> X</label>
          <label><input type="radio" name="priority" value="y"> Y</label>
        </form>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(2);
      const names = violations.map((v) => v.message).sort();
      expect(names[0]).toContain(`name="priority"`);
      expect(names[1]).toContain(`name="speed"`);
    });
  });

  describe("HTML: does not fire when", () => {
    it("radios are wrapped by <fieldset> with a non-empty <legend>", () => {
      const violations = runRule(
        rule,
        `<fieldset>
          <legend>Shipping speed</legend>
          <label><input type="radio" name="speed" value="std"> Standard</label>
          <label><input type="radio" name="speed" value="exp"> Express</label>
        </fieldset>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("fieldset has no <legend> but carries aria-label", () => {
      const violations = runRule(
        rule,
        `<fieldset aria-label="Shipping speed">
          <label><input type="radio" name="speed" value="std"> Standard</label>
          <label><input type="radio" name="speed" value="exp"> Express</label>
        </fieldset>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("fieldset has aria-labelledby pointing at a heading", () => {
      const violations = runRule(
        rule,
        `<h2 id="ship-heading">Shipping speed</h2>
        <fieldset aria-labelledby="ship-heading">
          <label><input type="radio" name="speed" value="std"> Standard</label>
          <label><input type="radio" name="speed" value="exp"> Express</label>
        </fieldset>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role='radiogroup' container has aria-label with text", () => {
      const violations = runRule(
        rule,
        `<div role="radiogroup" aria-label="Shipping speed">
          <label><input type="radio" name="speed" value="std"> Standard</label>
          <label><input type="radio" name="speed" value="exp"> Express</label>
        </div>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role='radiogroup' container has aria-labelledby", () => {
      const violations = runRule(
        rule,
        `<h3 id="ship-label">Shipping speed</h3>
        <div role="radiogroup" aria-labelledby="ship-label">
          <label><input type="radio" name="speed" value="std"> Standard</label>
          <label><input type="radio" name="speed" value="exp"> Express</label>
        </div>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("only one radio carries the shared name (no group — solo button)", () => {
      const violations = runRule(
        rule,
        `<form>
          <label><input type="radio" name="solo" value="only"> Just me</label>
        </form>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("inputs are not type=radio (checkboxes sharing a name)", () => {
      const violations = runRule(
        rule,
        `<form>
          <label><input type="checkbox" name="opt" value="a"> A</label>
          <label><input type="checkbox" name="opt" value="b"> B</label>
        </form>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: edge cases", () => {
    it("radios with no name attribute are ignored (cannot form a group)", () => {
      const violations = runRule(
        rule,
        `<form>
          <input type="radio" value="a">
          <input type="radio" value="b">
        </form>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("fieldset ancestor wins over a bad radiogroup ancestor further out", () => {
      const violations = runRule(
        rule,
        `<div role="radiogroup">
          <fieldset>
            <legend>Nested group</legend>
            <label><input type="radio" name="x" value="1"> One</label>
            <label><input type="radio" name="x" value="2"> Two</label>
          </fieldset>
        </div>`,
        { filePath: "form.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("radios share a name with no wrapper", () => {
      const violations = runRule(
        rule,
        `export function ShippingForm() {
          return (
            <form>
              <label><input type="radio" name="speed" value="std" /> Standard</label>
              <label><input type="radio" name="speed" value="exp" /> Express</label>
            </form>
          );
        }`,
        { filePath: "form.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/radio-group-without-fieldset");
      expect(violations[0]?.message).toContain(`name="speed"`);
    });

    it("fieldset wraps radios but has no legend", () => {
      const violations = runRule(
        rule,
        `export function X() {
          return (
            <fieldset>
              <label><input type="radio" name="size" value="s" /> Small</label>
              <label><input type="radio" name="size" value="l" /> Large</label>
            </fieldset>
          );
        }`,
        { filePath: "form.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/no <legend>/);
    });

    it("role='radiogroup' container has no accessible name", () => {
      const violations = runRule(
        rule,
        `export function X() {
          return (
            <div role="radiogroup">
              <label><input type="radio" name="color" value="r" /> Red</label>
              <label><input type="radio" name="color" value="b" /> Blue</label>
            </div>
          );
        }`,
        { filePath: "form.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/radiogroup/);
    });
  });

  describe("JSX: does not fire when", () => {
    it("fieldset has a legend with static text", () => {
      const violations = runRule(
        rule,
        `export function X() {
          return (
            <fieldset>
              <legend>Shipping speed</legend>
              <label><input type="radio" name="speed" value="std" /> Standard</label>
              <label><input type="radio" name="speed" value="exp" /> Express</label>
            </fieldset>
          );
        }`,
        { filePath: "form.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("fieldset has a legend containing a JSX expression (dynamic text)", () => {
      const violations = runRule(
        rule,
        `export function X({ title }: { title: string }) {
          return (
            <fieldset>
              <legend>{title}</legend>
              <label><input type="radio" name="speed" value="std" /> Standard</label>
              <label><input type="radio" name="speed" value="exp" /> Express</label>
            </fieldset>
          );
        }`,
        { filePath: "form.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role='radiogroup' with aria-label containing a static string", () => {
      const violations = runRule(
        rule,
        `export function X() {
          return (
            <div role="radiogroup" aria-label="Shipping speed">
              <label><input type="radio" name="speed" value="std" /> Standard</label>
              <label><input type="radio" name="speed" value="exp" /> Express</label>
            </div>
          );
        }`,
        { filePath: "form.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role='radiogroup' with aria-label from a dynamic expression", () => {
      const violations = runRule(
        rule,
        `export function X({ label }: { label: string }) {
          return (
            <div role="radiogroup" aria-label={label}>
              <label><input type="radio" name="speed" value="std" /> Standard</label>
              <label><input type="radio" name="speed" value="exp" /> Express</label>
            </div>
          );
        }`,
        { filePath: "form.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });
});
