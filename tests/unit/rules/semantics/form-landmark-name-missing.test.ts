import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/form-landmark-name-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/form-landmark-name-missing", () => {
  describe("fires a violation when", () => {
    it("a single <form> has no aria-label, aria-labelledby, or title", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <main>",
        '      <form action="/search">',
        '        <input type="search" name="q">',
        "        <button>Go</button>",
        "      </form>",
        "    </main>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/form-landmark-name-missing");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("form landmark role");
      expect(violations[0]?.suggestion).toContain("aria-label");
      // Form opens on line 4 (1-indexed).
      expect(violations[0]?.location.line).toBe(4);
    });

    it("a single <form> has aria-label but it is whitespace-only", () => {
      const source = [
        "<html>",
        "  <body>",
        '    <form aria-label="   " action="/subscribe">',
        '      <input type="email" name="email">',
        "    </form>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain('action="/subscribe"');
    });

    it("a single <form> in a fragment file has no name", () => {
      // Fragments are NOT skipped — the predicate is purely
      // attribute-level, so the form fails to expose as a landmark
      // regardless of how the partial composes at render time.
      const source = [
        '<form action="/contact">',
        "  <label>Name <input type='text' name='name'></label>",
        "  <button>Send</button>",
        "</form>",
      ].join("\n");
      const violations = runRule(rule, source, {
        filePath: "_includes/contact-form.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/aria-label/);
    });

    it("a single <form> with empty aria-labelledby still fires", () => {
      const source = [
        "<html>",
        "  <body>",
        '    <form action="/login" aria-labelledby="">',
        '      <input type="text" name="user">',
        "    </form>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });
  });

  describe("does not fire when", () => {
    it("the single <form> has aria-label", () => {
      const source = [
        "<html>",
        "  <body>",
        '    <form aria-label="Search the site" action="/search">',
        '      <input type="search" name="q">',
        "    </form>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the single <form> has aria-labelledby pointing at an id", () => {
      // We deliberately don't resolve the labelledby target — that's
      // aria/labelledby-target-exists's job. Presence is sufficient
      // to consider the form labeled for landmark-name purposes.
      const source = [
        "<html>",
        "  <body>",
        '    <h2 id="signin-h">Sign in</h2>',
        '    <form aria-labelledby="signin-h" action="/login">',
        '      <input type="text" name="user">',
        "    </form>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the single <form> has a non-empty title attribute", () => {
      // html-aria accepts title as a name source for <form>, so a
      // title-only form does not fire. Discouraged but valid.
      const source = [
        "<html>",
        "  <body>",
        '    <form title="Newsletter signup" action="/subscribe">',
        '      <input type="email" name="email">',
        "    </form>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the file contains zero <form> elements", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <main>No forms here.</main>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the file contains two <form> elements (ceded to duplicate-landmark-unlabeled)", () => {
      // Multi-form case is owned by semantics/duplicate-landmark-
      // unlabeled. We deliberately stay quiet to avoid double-emission
      // on the same elements.
      const source = [
        "<html>",
        "  <body>",
        '    <form action="/search"><input type="search" name="q"></form>',
        '    <form action="/subscribe"><input type="email" name="email"></form>',
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("non-HTML file extensions are out of scope", () => {
      // Rule only applies to .html / .htm; a .tsx file with a JSX
      // <form> is unaffected (different parsers, different rule shape).
      const source = "const F = () => <form><input /></form>;";
      const violations = runRule(rule, source, { filePath: "Form.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("suggestion includes form identity (action attribute) when present", () => {
      const source = [
        "<html>",
        "  <body>",
        '    <form action="/checkout/payment">',
        '      <input type="text" name="card">',
        "    </form>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain('action="/checkout/payment"');
    });

    it("suggestion falls back to id when action is absent", () => {
      const source = [
        "<html>",
        "  <body>",
        '    <form id="newsletter">',
        '      <input type="email" name="email">',
        "    </form>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain('id="newsletter"');
    });
  });
});
