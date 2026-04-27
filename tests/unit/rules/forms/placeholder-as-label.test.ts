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

  // Sibling-collapse: when ≥3 direct-child labelable controls under one
  // parent share the same `(tagName, type, attributes-modulo-id)`
  // fingerprint AND all carry the placeholder-as-label antipattern,
  // the rule emits ONE canonical finding carrying `siblingInstances`
  // instead of N near-identical findings. Mirrors `forms/labels-
  // required` precedent so a sign-up form with six placeholder-only
  // inputs reads as one row with the per-sibling line trail —
  // surface-don't-suppress is preserved (the collapsed finding still
  // fires and enumerates every sibling), and the line-text-keyed
  // `findingId` collision is no longer worn by N entries on the wire.
  describe("HTML: sibling collapse", () => {
    it("collapses 6 visually-grouped sign-up <input> siblings into one finding with siblingInstances", () => {
      const source = `<form>
        <input type="email" placeholder="Email">
        <input type="email" placeholder="Email">
        <input type="email" placeholder="Email">
        <input type="email" placeholder="Email">
        <input type="email" placeholder="Email">
        <input type="email" placeholder="Email">
      </form>`;
      const v = runRule(rule, source, { filePath: "signup.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.siblingInstances).toBeDefined();
      expect(v[0]?.siblingInstances?.length).toBe(6);
      // Message names the rollup so an agent reading the message alone
      // knows it is one finding standing in for N siblings; quotes the
      // shared placeholder copy so the antipattern is concrete.
      expect(v[0]?.message).toContain("siblingInstances");
      expect(v[0]?.message).toContain("5 adjacent sibling");
      expect(v[0]?.message).toContain('placeholder="Email"');
    });

    it("emits per-element when 2 sibling inputs share a fingerprint (below threshold)", () => {
      const source = `<form>
        <input type="text" placeholder="First name">
        <input type="text" placeholder="First name">
      </form>`;
      const v = runRule(rule, source, { filePath: "pair.html" });
      expect(v).toHaveLength(2);
      expect(v[0]?.siblingInstances).toBeUndefined();
      expect(v[1]?.siblingInstances).toBeUndefined();
    });

    it("does not collapse siblings under different parents", () => {
      const source = `<form>
        <input type="text" placeholder="First name">
        <input type="text" placeholder="First name">
      </form>
      <form>
        <input type="text" placeholder="First name">
        <input type="text" placeholder="First name">
      </form>`;
      const v = runRule(rule, source, { filePath: "two-forms.html" });
      expect(v).toHaveLength(4);
      for (const finding of v) {
        expect(finding.siblingInstances).toBeUndefined();
      }
    });

    it("groups siblings by fingerprint within one parent (different placeholders do not cross-collapse)", () => {
      // One parent, three identical "Email" inputs and three identical
      // "Phone" inputs — two separate groups, each ≥3, each collapses
      // independently because the `placeholder` attribute participates
      // in the fingerprint.
      const source = `<form>
        <input type="text" placeholder="Email">
        <input type="text" placeholder="Email">
        <input type="text" placeholder="Email">
        <input type="text" placeholder="Phone">
        <input type="text" placeholder="Phone">
        <input type="text" placeholder="Phone">
      </form>`;
      const v = runRule(rule, source, { filePath: "mixed.html" });
      expect(v).toHaveLength(2);
      expect(v[0]?.siblingInstances?.length).toBe(3);
      expect(v[1]?.siblingInstances?.length).toBe(3);
      expect(v[0]?.location.line).not.toBe(v[1]?.location.line);
    });
  });

  describe("JSX: sibling collapse", () => {
    it("collapses 4 sign-up JSX <input> siblings into one finding", () => {
      const source = `const X = (
        <form>
          <input type="text" placeholder="Given name" />
          <input type="text" placeholder="Given name" />
          <input type="text" placeholder="Given name" />
          <input type="text" placeholder="Given name" />
        </form>
      );`;
      const v = runRule(rule, source, { filePath: "signup.tsx" });
      expect(v).toHaveLength(1);
      expect(v[0]?.siblingInstances?.length).toBe(4);
      expect(v[0]?.message).toContain("siblingInstances");
      expect(v[0]?.message).toContain('placeholder="Given name"');
    });
  });
});
