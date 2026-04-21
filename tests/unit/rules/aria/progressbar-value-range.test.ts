import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/progressbar-value-range.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/progressbar-value-range", () => {
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

  describe("skeleton contract", () => {
    it("emits no violations until detection logic lands (see follow-up commit)", () => {
      // Canonical good shape — will continue to emit zero once the
      // check() logic is implemented.
      const violations = runRule(
        rule,
        `<div role="progressbar" aria-valuenow="30" aria-valuemin="0" aria-valuemax="100" aria-label="Upload"></div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });
});
