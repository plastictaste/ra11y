import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/redundant-role-on-host-element.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/redundant-role-on-host-element", () => {
  describe("HTML: fires a violation when", () => {
    it("<button role='button'>", () => {
      const violations = runRule(rule, `<button type="button" role="button">Save</button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/redundant-role-on-host-element");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.message).toContain("button");
      expect(violations[0]?.message).toContain("redundant");
      expect(violations[0]?.suggestion).toContain('Remove role="button"');
    });

    it("<nav role='navigation'>", () => {
      const violations = runRule(rule, `<nav role="navigation">Links</nav>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("navigation");
    });

    it("<main role='main'>", () => {
      const violations = runRule(rule, `<main role="main">Content</main>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("<a href='/x' role='link'>", () => {
      const violations = runRule(rule, `<a href="/docs" role="link">Read</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain('role="link"');
    });

    it("<img alt='…' role='img'>", () => {
      const violations = runRule(rule, `<img src="hero.jpg" alt="Team photo" role="img">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("img");
    });

    it("<form role='form'>", () => {
      const violations = runRule(rule, `<form action="/submit" role="form">x</form>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("aria-label");
    });
  });

  describe("HTML: does not fire when", () => {
    it("<a> has no href (no implicit role to be redundant against)", () => {
      const violations = runRule(rule, `<a role="link">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<img> has empty alt (implicit role is presentation, not img)", () => {
      const violations = runRule(rule, `<img src="deco.png" alt="" role="img">`, {
        filePath: "index.html",
      });
      // With alt="" the implicit role is "presentation"; role="img" is
      // technically a conflict (different rule's territory), not a
      // redundancy. We stay quiet here so there is no overlap.
      expect(violations).toHaveLength(0);
    });

    it("<img> has no alt attribute (alt-text rule's territory)", () => {
      const violations = runRule(rule, `<img src="hero.jpg" role="img">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<div role='button'> — div has no implicit role to be redundant against", () => {
      const violations = runRule(rule, `<div role="button" tabindex="0">Save</div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<button role='link'> — conflict, owned by aria/conflicting-role", () => {
      const violations = runRule(rule, `<button role="link">Save</button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<header role='banner'> — context-dependent implicit role, out of scope", () => {
      const violations = runRule(rule, `<header role="banner">Top</header>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<footer role='contentinfo'> — context-dependent, out of scope", () => {
      const violations = runRule(rule, `<footer role="contentinfo">Bot</footer>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<section role='region'> — name-dependent implicit role, out of scope", () => {
      const violations = runRule(rule, `<section role="region">x</section>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("element has no role attribute", () => {
      const violations = runRule(rule, `<button type="button">Save</button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("empty role attribute", () => {
      const violations = runRule(rule, `<button role="">Save</button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("<button role='button'>", () => {
      const violations = runRule(rule, `const X = <button role="button">Save</button>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/redundant-role-on-host-element");
    });

    it("<nav role='navigation'>", () => {
      const violations = runRule(rule, `const X = <nav role="navigation">x</nav>;`);
      expect(violations).toHaveLength(1);
    });

    it("<a href={url} role='link'> — href expression still counts as having href", () => {
      const violations = runRule(rule, `const X = ({ url }) => <a href={url} role="link">Go</a>;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("<a role='link'> without href (handler-less anchor used as styled div)", () => {
      const violations = runRule(rule, `const X = <a role="link">Click</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("role is an expression (runtime-computed)", () => {
      const violations = runRule(rule, `const X = <button role={dynamicRole}>x</button>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("multi-role fallback — first token is checked", () => {
      // role="navigation foo" — first token matches <nav>'s implicit role.
      const violations = runRule(rule, `<nav role="navigation foo">x</nav>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("role attribute casing is normalized (BUTTON vs button)", () => {
      const violations = runRule(rule, `<button role="BUTTON">Save</button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("flags multiple redundant roles in the same document", () => {
      const violations = runRule(rule, `<nav role="navigation">x</nav><main role="main">y</main>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(2);
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
});
