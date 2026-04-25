import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/invalid-role.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/invalid-role", () => {
  describe("HTML: fires a violation when", () => {
    it("role is a typo of a real role", () => {
      const violations = runRule(rule, `<div role="buton">Save</div>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/invalid-role");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
    });

    it("suggestion mentions the nearest valid role for typos", () => {
      const violations = runRule(rule, `<div role="buton">Save</div>`, { filePath: "index.html" });
      expect(violations[0]?.suggestion).toContain("button");
    });

    it("role is an abstract WAI-ARIA role (widget)", () => {
      const violations = runRule(rule, `<div role="widget"></div>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
    });

    it("role is completely made up", () => {
      const violations = runRule(rule, `<div role="notarealrole"></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("role is a valid ARIA role", () => {
      const violations = runRule(rule, `<div role="button" tabindex="0">Save</div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("role has uppercase letters (case-insensitive)", () => {
      const violations = runRule(rule, `<div role="BUTTON"></div>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("role is a DPUB-ARIA role", () => {
      const violations = runRule(rule, `<section role="doc-chapter"></section>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("element has no role attribute", () => {
      const violations = runRule(rule, `<div></div>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("role is presentation", () => {
      const violations = runRule(rule, `<img src="x.png" role="presentation" alt="">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("role is a typo", () => {
      const violations = runRule(rule, `const X = <div role="buton">Save</div>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/invalid-role");
    });

    it("multiple offending elements produce multiple violations", () => {
      const src = `const X = <div><span role="buton" /><span role="linkk" /></div>;`;
      const violations = runRule(rule, src);
      expect(violations).toHaveLength(2);
    });
  });

  describe("JSX: does not fire when", () => {
    it("role is valid", () => {
      const violations = runRule(rule, `const X = <div role="button" tabindex={0}>Save</div>;`);
      expect(violations).toHaveLength(0);
    });

    it("role is an expression (runtime-computed)", () => {
      // If the role is computed at runtime we can't validate it statically.
      const violations = runRule(rule, `const X = <div role={dynamicRole}>x</div>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("multi-role fallback: all invalid fires", () => {
      const violations = runRule(rule, `<div role="buton linkk">x</div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("multi-role fallback with one valid still fires on invalid token", () => {
      // role="nav navigation" — "nav" is invalid, "navigation" is valid.
      // The element has a working fallback but "nav" is dead weight.
      const violations = runRule(rule, `<div role="nav navigation">x</div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("nav");
    });

    it("empty role attribute is treated as 'no role' (no violation)", () => {
      const violations = runRule(rule, `<div role="">x</div>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:4.1.2 and wcag21:4.1.2", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });

    it("has a normativeQuote citing WCAG", () => {
      expect(rule.docs.normativeQuote).toBeDefined();
      expect(rule.docs.references[0]).toContain("WCAG22");
    });
  });

  describe("Q7-SUGGEST-FIX-EDIT-LANE-UNREACHABLE: fixPaths.primary.edit", () => {
    // Doctrine: a `fixClass: "mechanical"` rule must populate
    // `fixPaths.primary.edit` so `suggest_fix` returns `kind: "edit"`.
    // For typos within 2 edits of a real role, the replacement is
    // deterministic (the `nearest` helper picks exactly one candidate);
    // for invented roles with no close match, the primary path ships
    // guidance only.
    it("HTML typo: primary.edit replaces the misspelled token with the nearest valid role", () => {
      const source = `<div role="buton">Save</div>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const edit = violations[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.oldText).toBe(`role="buton"`);
      expect(edit?.newText).toBe(`role="button"`);
      expect(source.includes(edit?.oldText ?? "")).toBe(true);
    });

    it("JSX typo: primary.edit mirrors the HTML shape", () => {
      const source = `const X = <div role="buton">Save</div>;`;
      const violations = runRule(rule, source);
      expect(violations).toHaveLength(1);
      const edit = violations[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.oldText).toBe(`role="buton"`);
      expect(edit?.newText).toBe(`role="button"`);
    });

    it("invented role with no near match: primary carries no edit (falls into guidance lane)", () => {
      const source = `<div role="widget"></div>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.fixPaths?.primary.edit).toBeUndefined();
      expect(violations[0]?.fixPaths?.primary.label).toContain("remove");
    });

    it("fallback chain: only the first invalid token is rewritten, downstream tokens preserved", () => {
      const source = `<div role="buton button">x</div>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const edit = violations[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.oldText).toBe(`role="buton button"`);
      expect(edit?.newText).toBe(`role="button button"`);
    });
  });
});
