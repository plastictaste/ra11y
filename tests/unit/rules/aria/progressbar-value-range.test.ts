import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/progressbar-value-range.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/progressbar-value-range", () => {
  describe("HTML: fires when", () => {
    it("role=progressbar has no aria-valuenow and no indeterminate signal", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Upload"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/progressbar-value-range");
      expect(violations[0]?.message).toContain("aria-valuenow");
      expect(violations[0]?.severity).toBe("error");
    });

    it("aria-valuenow is above aria-valuemax", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuenow="150" aria-valuemin="0" aria-valuemax="100"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("above");
      expect(violations[0]?.suggestion).toContain("aria-valuemax");
    });

    it("aria-valuenow is below aria-valuemin", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuenow="-5" aria-valuemin="0" aria-valuemax="100"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("below");
    });

    it("aria-valuemin > aria-valuemax", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuenow="50" aria-valuemin="100" aria-valuemax="0"></div>`,
        { filePath: "index.html" },
      );
      // Only the bounds violation — range check is skipped when bounds are inverted.
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("inverted");
    });

    it("aria-valuenow is a non-numeric string literal", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuenow="fifty" aria-valuemax="100"></div>`,
        { filePath: "index.html" },
      );
      // Invalid literal is reported; range check is skipped because the
      // unparsable value is treated as "not a literal" downstream.
      const messages = violations.map((v) => v.message);
      expect(messages.some((m) => m.includes("expects a number"))).toBe(true);
    });

    it("uses default 0..100 scale to flag out-of-range when aria-valuemax is omitted", () => {
      const violations = runRule(rule, `<div role="progressbar" aria-valuenow="120"></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("default maximum of 100");
    });
  });

  describe("HTML: does not fire when", () => {
    it("role=progressbar has a valid aria-valuenow within 0..100 defaults", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuenow="30" aria-label="Upload"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role=progressbar has aria-valuenow === aria-valuemax (boundary is inclusive)", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role=progressbar with aria-busy=true and no aria-valuenow (indeterminate)", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-busy="true" aria-label="Loading"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("<progress> native element with a value attribute", () => {
      const violations = runRule(rule, `<progress value="0.7" max="1"></progress>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<progress> native element with no value attribute (native indeterminate)", () => {
      const violations = runRule(rule, `<progress max="1"></progress>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("element has no progressbar role and is not <progress>", () => {
      const violations = runRule(
        rule,
        `<div role="button" aria-valuenow="50">Not a progressbar</div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("aria-valuenow uses a decimal value within range", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuenow="0.75" aria-valuemin="0" aria-valuemax="1"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("role=progressbar has a literal aria-valuenow above literal aria-valuemax", () => {
      const violations = runRule(
        rule,
        `const X = <div role="progressbar" aria-valuenow={150} aria-valuemax={100} />;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("above");
    });

    it("role=progressbar has a non-numeric string literal aria-valuenow", () => {
      const violations = runRule(
        rule,
        `const X = <div role="progressbar" aria-valuenow="fifty" aria-valuemax="100" />;`,
      );
      const messages = violations.map((v) => v.message);
      expect(messages.some((m) => m.includes("expects a number"))).toBe(true);
    });

    it("native <progress> has value above max", () => {
      const violations = runRule(rule, `const X = <progress value={150} max={100} />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("above");
    });
  });

  describe("JSX: emits info (not error) when", () => {
    it("aria-valuenow is a dynamic expression", () => {
      const violations = runRule(
        rule,
        `const X = <div role="progressbar" aria-valuenow={progress} aria-valuemax={100} />;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("info");
      expect(violations[0]?.message).toContain("JSX expression");
    });

    it("role=progressbar has {...spread} and no explicit aria-valuenow", () => {
      const violations = runRule(
        rule,
        `const X = <div role="progressbar" {...props} aria-label="Upload" />;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("info");
      expect(violations[0]?.message).toContain("spread");
    });
  });

  describe("JSX: does not fire when", () => {
    it("role=progressbar has a valid numeric-literal expression aria-valuenow", () => {
      const violations = runRule(
        rule,
        `const X = <div role="progressbar" aria-valuenow={30} aria-valuemin={0} aria-valuemax={100} />;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("role is an expression (runtime-computed)", () => {
      const violations = runRule(rule, `const X = <div role={someRole}>x</div>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("reports invalid-bounds AND missing-valuenow when valuemin>valuemax and valuenow absent", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuemin="100" aria-valuemax="0"></div>`,
        { filePath: "index.html" },
      );
      // Invalid bounds + missing aria-valuenow (not indeterminate).
      expect(violations).toHaveLength(2);
      const messages = violations.map((v) => v.message);
      expect(messages.some((m) => m.includes("inverted"))).toBe(true);
      expect(messages.some((m) => m.includes("missing aria-valuenow"))).toBe(true);
    });

    it("scientific notation is rejected as non-numeric (strict WAI-ARIA <number>)", () => {
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuenow="1e2" aria-valuemax="100"></div>`,
        { filePath: "index.html" },
      );
      // Invalid-literal violation fires; range check is skipped because
      // the value can't be parsed as a number.
      const messages = violations.map((v) => v.message);
      expect(messages.some((m) => m.includes("expects a number"))).toBe(true);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:4.1.2 and wcag21:4.1.2", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });

    it("cites the name-role-value SC in the rule references", () => {
      expect(rule.docs?.references ?? []).toContain(
        "https://www.w3.org/TR/WCAG22/#name-role-value",
      );
    });
  });
});
