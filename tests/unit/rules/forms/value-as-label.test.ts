import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/value-as-label.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/value-as-label", () => {
  describe("fires a violation when", () => {
    it("HTML input type=text has value='Username' but no label", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" value="Username">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/value-as-label");
      // Context-aware message quotes the actual value text and the descriptor
      expect(violations[0]?.message).toContain('value="Username"');
      expect(violations[0]?.message).toContain('<input type="text">');
      // Suggestion carries the load-bearing prose: pre-filled input text, not a label channel.
      expect(violations[0]?.suggestion).toMatch(/pre-filled content, not a label channel/);
      expect(violations[0]?.suggestion).toMatch(/verify intent/);
    });

    it("HTML input with NO type attribute and value='Email' fires (defaults to text)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input value="Email">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('value="Email"');
      // No type attribute renders descriptor without type.
      expect(violations[0]?.message).toContain("<input>");
    });

    it("JSX input with literal value='Search' and no label", () => {
      const violations = runRule(
        rule,
        `export default function Form() {
          return (
            <form>
              <input type="search" value="Search" />
            </form>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/value-as-label");
      expect(violations[0]?.message).toContain('value="Search"');
    });

    it("HTML input type=email with value='Email address' fires", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="email" value="Email address">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('value="Email address"');
    });
  });

  describe("does not fire when", () => {
    it("HTML input has <label for=id> association", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <label for="user">Username</label>
          <input id="user" type="text" value="John">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input has aria-label", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" aria-label="Username" value="Username">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input has aria-labelledby referencing a heading", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <h2 id="user-heading">Username</h2>
          <input type="text" aria-labelledby="user-heading" value="Username">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input is wrapped inside a <label> (implicit label)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <label>Username <input type="text" value="John"></label>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input has a placeholder (placeholder-as-label territory, not us)", () => {
      // When placeholder is also present, the more specific rule
      // forms/placeholder-as-label is the right surface; this rule
      // defers to avoid double-firing on the same control with the
      // same primary remediation.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" value="Username" placeholder="Username">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input has empty value='' and no label", () => {
      // Empty value carries no label-like content; the broader
      // forms/labels-required rule covers the missing-label case.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" value="">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input type=submit with value='Send' does not fire (value is the accessible name)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="submit" value="Send">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input type=hidden with value='abc' does not fire", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="hidden" value="csrf-token-abc">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input type=checkbox with value='option1' does not fire", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="checkbox" value="option1">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX expression-valued value={username} does not fire (controlled-input binding)", () => {
      const violations = runRule(
        rule,
        `export default function Form({ username }: { username: string }) {
          return (
            <form>
              <input type="text" value={username} />
            </form>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("numeric-only value='42' does not fire (default value, not label)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" value="42">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("whitespace-only value='   ' does not fire", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" value="   ">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("title attribute counts as an accessible name (legacy channel)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" title="Username" value="Username">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX input with htmlFor-associated <label>", () => {
      const violations = runRule(
        rule,
        `export default function Form() {
          return (
            <form>
              <label htmlFor="user">Username</label>
              <input id="user" type="text" value="John" />
            </form>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("PascalCase wrapper opted in via nativeWrapperElements: { TextField: 'input' } fires", () => {
      const violations = runRule(
        rule,
        `export default function Form() {
          return (
            <form>
              <TextField value="Username" />
            </form>
          );
        }`,
        {
          filePath: "input.tsx",
          nativeWrapperElements: { TextField: "input" },
        },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/value-as-label");
      expect(violations[0]?.message).toContain('value="Username"');
    });

    it("alphanumeric-mixed value='Order123' fires (alphabetic chars present)", () => {
      // The predicate gates on "contains alphabetic characters" so
      // mixed values still surface — the agent decides whether the
      // copy is label-shaped or a real default identifier.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" value="Order123">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('value="Order123"');
    });

    it("multiple unlabeled value-as-label inputs fire independently (no collapse)", () => {
      // Sibling-collapse exists for placeholder-as-label but is
      // intentionally not implemented here — the value-as-label
      // antipattern is rarer in the wild, and per-finding emission
      // gives the agent a per-input line trail until field reports
      // surface clusters that justify collapse.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" value="Username">
          <input type="email" value="Email">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(2);
    });
  });
});
