import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/section-accessible-name-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/section-accessible-name-missing", () => {
  describe("fires a violation when", () => {
    it("a <section> is a direct child of <body> with no accessible name", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <section>",
        "      <p>Featured content goes here.</p>",
        "    </section>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/section-accessible-name-missing");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("direct child of <body>");
      expect(violations[0]?.suggestion).toContain("aria-label");
    });

    it("a <section> sits as a sibling to <main> under a wrapping <div>", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <div class='layout'>",
        "      <main>primary</main>",
        "      <section>",
        "        <p>Related items.</p>",
        "      </section>",
        "    </div>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("alongside other landmarks");
      // Line 5 in the 1-indexed source above.
      expect(violations[0]?.location.line).toBe(5);
    });

    it("a <section> with aria-labelledby missing (has attribute placeholder stripped) is flagged when bare", () => {
      // Whitespace-only aria-labelledby doesn't count — the author's
      // reference is empty, so the section has no programmatic name.
      const source = [
        "<html>",
        "  <body>",
        "    <section aria-labelledby='   '>",
        "      <p>content</p>",
        "    </section>",
        "    <aside>sidebar</aside>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("heading");
    });
  });

  describe("does not fire when", () => {
    it("the <section> has aria-label", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <main>content</main>",
        "    <section aria-label='Related articles'>",
        "      <p>items</p>",
        "    </section>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the <section> has aria-labelledby pointing somewhere", () => {
      // This rule doesn't validate the target id — that's the
      // aria/labelledby-target-exists rule's job. Presence of a
      // non-whitespace token is enough to pass the name check here.
      const source = [
        "<html>",
        "  <body>",
        "    <section aria-labelledby='nonexistent-id'>",
        "      <p>content</p>",
        "    </section>",
        "    <aside>sidebar</aside>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the <section> has a direct-child <h2>", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <main>content</main>",
        "    <section>",
        "      <h2>Related articles</h2>",
        "      <p>items</p>",
        "    </section>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the <section> is nested deep inside a <div> with no landmark siblings", () => {
      // Many legitimate section usages are inside articles/cards for
      // prose grouping — those don't need names per spec. Over-firing
      // here would be noisy, so the rule deliberately stays silent.
      const source = [
        "<html>",
        "  <body>",
        "    <main>",
        "      <article>",
        "        <div class='card'>",
        "          <section>",
        "            <p>Inner sub-grouping.</p>",
        "          </section>",
        "        </div>",
        "      </article>",
        "    </main>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the file is a fragment (no <html>, no <body>)", () => {
      // Fragments (Jekyll/Handlebars/Astro partials) compose at
      // render time; we can't decide whether a top-level section
      // will land in a landmark row or not.
      const source = ["<section>", "  <p>fragment content</p>", "</section>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/sidebar.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("aria-label with only whitespace does not count as a name", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <main>content</main>",
        "    <section aria-label='   '>",
        "      <p>items</p>",
        "    </section>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("heading must be a DIRECT child — a <div><h2></div> wrapper does not satisfy the name check", () => {
      // The HTML5 sectioning algorithm uses a direct-child heading to
      // name the section. A heading buried in a wrapper div does not
      // count — this is the spec-accurate shape.
      const source = [
        "<html>",
        "  <body>",
        "    <main>content</main>",
        "    <section>",
        "      <div>",
        "        <h2>Buried heading</h2>",
        "      </div>",
        "      <p>items</p>",
        "    </section>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("suggestion inlines id/class for disambiguation when multiple sections share a row", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <main>content</main>",
        "    <section id='featured'>",
        "      <p>a</p>",
        "    </section>",
        "    <section class='newsletter'>",
        "      <p>b</p>",
        "    </section>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.suggestion).toContain('id="featured"');
      expect(violations[1]?.suggestion).toContain('class="newsletter"');
    });

    it("non-HTML files are not scanned", () => {
      const violations = runRule(rule, "export const x = 1;", { filePath: "a.tsx" });
      expect(violations).toHaveLength(0);
    });
  });
});
