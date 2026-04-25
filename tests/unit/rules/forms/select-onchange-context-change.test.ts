import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/select-onchange-context-change.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/select-onchange-context-change", () => {
  describe("fires a violation when", () => {
    it("HTML <select onchange> assigns location.href", () => {
      const violations = runRule(
        rule,
        `<form>
          <select onchange="location.href=this.value">
            <option value="/en">English</option>
            <option value="/fr">Français</option>
          </select>
        </form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/select-onchange-context-change");
      expect(violations[0]?.message).toMatch(/location\./);
      expect(violations[0]?.suggestion).toMatch(/Apply/);
    });

    it("HTML <select onchange> calls window.open", () => {
      const violations = runRule(
        rule,
        `<select onchange="window.open(this.value)">
          <option value="https://docs">Docs</option>
        </select>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/window\.open/);
    });

    it("HTML <select onchange> calls this.form.submit()", () => {
      const violations = runRule(
        rule,
        `<form action="/sort">
          <select name="sort" onchange="this.form.submit()">
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/submit\(\)/);
    });

    it("JSX inline arrow handler calls router.push", () => {
      const violations = runRule(
        rule,
        `export function LangPicker({ router }) {
          return (
            <select onChange={(e) => router.push(e.target.value)}>
              <option value="/en">English</option>
              <option value="/fr">Français</option>
            </select>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/router\.push/);
    });

    it("JSX function-reference handler whose body navigates", () => {
      const violations = runRule(
        rule,
        `import { useNavigate } from "react-router";
        export function LangPicker() {
          const navigate = useNavigate();
          const handleChange = (e) => {
            navigate(e.target.value);
          };
          return (
            <select onChange={handleChange}>
              <option value="/en">English</option>
              <option value="/fr">Français</option>
            </select>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/handleChange/);
      expect(violations[0]?.message).toMatch(/navigate\(/);
    });

    it("JSX function-declaration body that calls Router.push", () => {
      const violations = runRule(
        rule,
        `function onPick(e) {
          Router.push(e.target.value);
        }
        export function LangPicker() {
          return (
            <select onChange={onPick}>
              <option value="/en">English</option>
              <option value="/fr">Français</option>
            </select>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Router\.push/);
    });
  });

  describe("does not fire when", () => {
    it("HTML <select onchange> only updates state (no context change)", () => {
      const violations = runRule(
        rule,
        `<select onchange="updatePreview(this.value)">
          <option value="grid">Grid</option>
          <option value="list">List</option>
        </select>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML <select> with no onchange handler", () => {
      const violations = runRule(
        rule,
        `<form>
          <select name="lang">
            <option value="en">English</option>
          </select>
          <button type="submit">Apply</button>
        </form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX onChange handler is a controlled-component setter", () => {
      const violations = runRule(
        rule,
        `export function Picker({ value, setValue }) {
          return (
            <select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="a">A</option>
              <option value="b">B</option>
            </select>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX function-reference handler whose body only updates state", () => {
      const violations = runRule(
        rule,
        `export function Picker({ setValue }) {
          const handleChange = (e) => {
            setValue(e.target.value);
          };
          return (
            <select onChange={handleChange}>
              <option value="a">A</option>
            </select>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML user-defined identifier `myLocation.set` is not the DOM `location`", () => {
      const violations = runRule(
        rule,
        `<select onchange="myLocation.set(this.value)">
          <option value="a">A</option>
        </select>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("does not fire on a non-<select> element with onchange", () => {
      // The rule is scoped to <select>; other form controls can be
      // covered by sibling rules. Confirms scope-lock.
      const violations = runRule(rule, `<input type="text" onchange="location.href='/done'" />`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("JSX onChange whose function reference is unresolved (defined elsewhere) stays silent", () => {
      // Conservative — when we can't see the function body in this
      // file, we don't fire. The agent reading the file will follow
      // the import.
      const violations = runRule(
        rule,
        `import { handlePick } from "./handlers";
        export function Picker() {
          return (
            <select onChange={handlePick}>
              <option value="a">A</option>
            </select>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("emits exactly one finding per offending <select> even when multiple tokens match", () => {
      const violations = runRule(
        rule,
        `<select onchange="window.open(this.value); location.href = this.value">
          <option value="/a">A</option>
        </select>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });
});
