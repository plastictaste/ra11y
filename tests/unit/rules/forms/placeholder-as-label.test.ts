import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/placeholder-as-label.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/placeholder-as-label", () => {
  describe("fires a violation when", () => {
    it("HTML input has placeholder but no label of any kind", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="email" placeholder="Email">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/placeholder-as-label");
      // Context-aware message quotes the actual placeholder text
      expect(violations[0]?.message).toContain('placeholder="Email"');
      expect(violations[0]?.message).toContain('<input type="email">');
      // Suggestion carries the required phrase from the antipattern fix prose
      expect(violations[0]?.suggestion).toMatch(/AT-unstable/);
      expect(violations[0]?.suggestion).toMatch(/verify accuracy/);
    });

    it("HTML textarea has placeholder but no label", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <textarea placeholder="Write your message here"></textarea>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<textarea>");
      expect(violations[0]?.message).toContain('placeholder="Write your message here"');
    });

    it("JSX input with placeholder prop and no label", () => {
      const violations = runRule(
        rule,
        `export default function Form() {
          return (
            <form>
              <input type="text" placeholder="Your name" />
            </form>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/placeholder-as-label");
      expect(violations[0]?.message).toContain('placeholder="Your name"');
    });

    it("HTML select has placeholder attribute and no label", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <select placeholder="Pick a country">
            <option value="">--</option>
          </select>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<select>");
    });
  });

  describe("does not fire when", () => {
    it("HTML input has <label for=id> association", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <label for="email">Email</label>
          <input id="email" type="email" placeholder="name@example.com">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input has aria-label", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="search" aria-label="Search products" placeholder="Try 'blue shoes'">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input has aria-labelledby referencing a heading", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <h2 id="email-heading">Your email address</h2>
          <input type="email" aria-labelledby="email-heading" placeholder="name@example.com">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input is wrapped inside a <label> (implicit label)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <label>Email <input type="email" placeholder="name@example.com"></label>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input has no placeholder at all (labels-required territory, not us)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="email">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      // Important distinction: forms/labels-required fires here, but
      // this rule only fires when placeholder is also present.
      expect(violations).toHaveLength(0);
    });

    it("JSX input has htmlFor-associated <label>", () => {
      const violations = runRule(
        rule,
        `export default function Form() {
          return (
            <form>
              <label htmlFor="email">Email</label>
              <input id="email" type="email" placeholder="name@example.com" />
            </form>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("empty placeholder='' is not the antipattern", () => {
      // placeholder="" carries no label-like content; the rule treats
      // it as "no placeholder" and defers to forms/labels-required.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="email" placeholder="">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("input type=submit with placeholder does not fire (value carries name, not placeholder)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="submit" value="Send" placeholder="click here">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX expression-valued placeholder fires with generic phrasing", () => {
      const violations = runRule(
        rule,
        `export default function Form() {
          const hint = "Email";
          return (
            <form>
              <input type="email" placeholder={hint} />
            </form>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("expression-valued placeholder");
    });

    it("title attribute counts as an accessible name (legacy channel)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="email" title="Your email" placeholder="name@example.com">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("placeholder with only whitespace is treated as empty", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="email" placeholder="   ">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });
});
