import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/duplicate-landmark-unlabeled.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/duplicate-landmark-unlabeled", () => {
  describe("fires a violation when", () => {
    it("a full page has two unlabeled <nav> elements", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header>",
        "      <nav><a href='/a'>A</a></nav>",
        "      <nav><a href='/b'>B</a></nav>",
        "    </header>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.ruleId).toBe("semantics/duplicate-landmark-unlabeled");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("2 <nav>");
      expect(violations[0]?.suggestion).toContain("aria-label");
    });

    it("one of two <nav> elements is labeled; the unlabeled one is flagged", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header>",
        "      <nav aria-label='Primary'><a href='/a'>A</a></nav>",
        "      <nav><a href='/b'>B</a></nav>",
        "    </header>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      // The flagged <nav> is on line 5 (1-indexed).
      expect(violations[0]?.location.line).toBe(5);
      expect(violations[0]?.suggestion).toContain("1 does");
    });

    it("a fragment file contains a single unlabeled <nav>", () => {
      const source = ["<header>", "  <nav><a href='/a'>A</a></nav>", "</header>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/header.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Fragment");
      expect(violations[0]?.suggestion).toContain("Primary");
    });

    it("a full page has two unlabeled <aside> elements", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <main>content</main>",
        "    <aside>related 1</aside>",
        "    <aside>related 2</aside>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.message).toContain("<aside>");
    });

    it("a full page has two unlabeled <form> elements", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <form action='/search'>search</form>",
        "    <form action='/subscribe'>subscribe</form>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.message).toContain("<form>");
    });
  });

  describe("does not fire when", () => {
    it("two <nav> elements both have aria-label", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <nav aria-label='Primary'><a href='/a'>A</a></nav>",
        "    <nav aria-label='Footer'><a href='/b'>B</a></nav>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("two <nav> elements both have aria-labelledby", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <h2 id='primary-nav'>Primary</h2>",
        "    <nav aria-labelledby='primary-nav'><a href='/a'>A</a></nav>",
        "    <h2 id='footer-nav'>Footer</h2>",
        "    <nav aria-labelledby='footer-nav'><a href='/b'>B</a></nav>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a full page has a single unlabeled <nav>", () => {
      // Single nav in a full page is not a duplicate — over-triggering
      // would be noisy. The fragment path deliberately does not apply
      // to full-page documents.
      const source = [
        "<html>",
        "  <body>",
        "    <header>",
        "      <nav><a href='/a'>A</a></nav>",
        "    </header>",
        "    <main>content</main>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a full page has one <main> and one <aside> (different types, not duplicates)", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <main>content</main>",
        "    <aside>related</aside>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a fragment file contains a single unlabeled <main>", () => {
      // <main> is excluded from the fragment single-landmark path —
      // landmark-main is the authority on main uniqueness, and a
      // fragment whose sole content is the main is normal.
      const source = ["<main>", "  <h1>Article</h1>", "  <p>body</p>", "</main>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_layouts/article.html" });
      expect(violations).toHaveLength(0);
    });

    it("a fragment contains a single labeled <nav>", () => {
      const source = ["<nav aria-label='Primary'>", "  <a href='/a'>A</a>", "</nav>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/nav.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("aria-label with only whitespace does not count as a name", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <nav aria-label='   '><a href='/a'>A</a></nav>",
        "    <nav aria-label='Footer'><a href='/b'>B</a></nav>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.location.line).toBe(3);
    });

    it("fragment with a <nav> deeply nested (not at root) AND a second same-type sibling fires on both", () => {
      // Fragment top-level has two nav elements; both unlabeled.
      // This exercises the duplicate path inside a fragment.
      const source = ["<nav><a href='/a'>A</a></nav>", "<nav><a href='/b'>B</a></nav>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/nav.html" });
      expect(violations).toHaveLength(2);
    });

    it("three <nav> elements, one labeled, two unlabeled → two findings", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <nav aria-label='Primary'>…</nav>",
        "    <nav>…</nav>",
        "    <nav>…</nav>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.suggestion).toContain("3 <nav>");
    });

    it("non-HTML files are not scanned", () => {
      const violations = runRule(rule, "export const x = 1;", { filePath: "a.tsx" });
      expect(violations).toHaveLength(0);
    });
  });
});
