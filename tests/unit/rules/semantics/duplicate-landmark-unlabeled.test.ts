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

    it("a fragment file contains TWO unlabeled <form> elements", () => {
      // Two same-type landmarks in one fragment is a deterministic
      // duplicate — observable from the file, fires per instance.
      // On `html_partial` classification the framing is reshaped:
      // severity drops to `info` and the message reads "this partial
      // supplies N <form> landmarks" rather than "Document has N".
      // Pairs with the partial-input couldBeWrongBecause concession
      // code so the agent reads the dismissal hatch in one pass.
      const source = [
        "<section>",
        "  <form action='/search'>search</form>",
        "  <form action='/subscribe'>subscribe</form>",
        "</section>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/footer.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.message).toContain("<form>");
      expect(violations[0]?.severity).toBe("info");
      expect(violations[0]?.message).toContain("partial");
      expect(violations[0]?.message).not.toContain("Document has");
      expect(violations[0]?.couldBeWrongBecause).toContain(
        "partial_input_duplicate_landmark_in_fragment",
      );
      expect(violations[0]?.suggestion).toContain("ra11y-disable");
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

    it("a full page has two body-level <header> elements", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header>Site title</header>",
        "    <main>content</main>",
        "    <header>Promo banner</header>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.message).toContain("<header>");
      expect(violations[0]?.suggestion).toContain("Site header");
    });

    it("a full page has two body-level <footer> elements", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <footer>Legal</footer>",
        "    <footer>Sitemap</footer>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.message).toContain("<footer>");
      expect(violations[0]?.suggestion).toContain("Site footer");
    });

    it("one <header> labeled, one body-level <header> unlabeled → only the unlabeled fires", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header aria-label='Site'>logo</header>",
        "    <header>Promo</header>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.location.line).toBe(4);
      expect(violations[0]?.suggestion).toContain("1 does");
    });

    it("two body-level <header> elements in a layout file (not fragment-classified)", () => {
      // _layouts/ is the page envelope under the unified classifier —
      // `inLayoutsDir: true` vetoes the `isFragment` label. The
      // duplicate-in-document framing stays correct, the emit stays
      // at `warning`, and no partial concession fires.
      const source = [
        "<header>Site title</header>",
        "<main>article body</main>",
        "<header>Article header</header>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "_layouts/page.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.message).toContain("<header>");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("Document has");
      expect(violations[0]?.couldBeWrongBecause).toBeUndefined();
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

    it("a fragment file contains a single unlabeled <nav>", () => {
      // Predicting that this partial composes alongside another
      // unlabeled <nav> is a guess about an unseen layout — the
      // rule no longer emits on a single observable instance. This
      // case belongs on the review-candidate surface.
      const source = ["<header>", "  <nav><a href='/a'>A</a></nav>", "</header>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/header.html" });
      expect(violations).toHaveLength(0);
    });

    it("a fragment file contains a single unlabeled <aside>", () => {
      const source = ["<aside>", "  <p>related links</p>", "</aside>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/sidebar.html" });
      expect(violations).toHaveLength(0);
    });

    it("a fragment file contains a single unlabeled <form>", () => {
      const source = ["<form action='/search'>", "  <input type='text' />", "</form>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/search.html" });
      expect(violations).toHaveLength(0);
    });

    it("a body-level <header> coexists with a <header> inside <article> (not a duplicate)", () => {
      // The <header> inside <article> is a generic group, not a banner
      // landmark, so it does not count toward the duplicate predicate.
      // Only one banner landmark exists → no firing.
      const source = [
        "<html>",
        "  <body>",
        "    <header>Site</header>",
        "    <article>",
        "      <header><h1>Article title</h1><p>byline</p></header>",
        "      <p>body</p>",
        "    </article>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("two <footer> elements both nested inside <article>/<section> (no contentinfo landmark)", () => {
      // Both footers are nested inside sectioning content, so neither is
      // a contentinfo landmark; the duplicate predicate does not fire.
      const source = [
        "<html>",
        "  <body>",
        "    <main>",
        "      <article>",
        "        <p>article 1 body</p>",
        "        <footer>article 1 metadata</footer>",
        "      </article>",
        "      <section>",
        "        <p>section body</p>",
        "        <footer>section metadata</footer>",
        "      </section>",
        "    </main>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a body-level <header> alongside two <header>s nested in sectioning content", () => {
      // Only the body-level <header> is a banner landmark; the two nested
      // ones are generic groups. One landmark total → no duplicate.
      const source = [
        "<html>",
        "  <body>",
        "    <header>Site</header>",
        "    <main>",
        "      <article>",
        "        <header><h1>Article 1</h1></header>",
        "        <p>body</p>",
        "      </article>",
        "      <section>",
        "        <header><h2>Sub-section</h2></header>",
        "        <p>body</p>",
        "      </section>",
        "    </main>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a single body-level <header> with a labeled second body-level <header>", () => {
      // Two banner landmarks but both have aria-label → no duplicate
      // ambiguity in the screen-reader landmark list.
      const source = [
        "<html>",
        "  <body>",
        "    <header aria-label='Site'>logo</header>",
        "    <header aria-label='Promotional'>announcement</header>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a single body-level <header> alone (no duplicate)", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header>Site</header>",
        "    <main>content</main>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a fragment with a single body-level <footer> does not fire", () => {
      // Single landmark in a fragment is the heuristic-emission case
      // the rule deliberately avoids — same shape as single <nav>.
      const source = ["<footer>", "  <p>contact info</p>", "</footer>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/footer.html" });
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
      // This exercises the duplicate path inside a fragment — the
      // emit fires but downgrades to `info` and reframes to
      // "this partial supplies N" because `_includes/nav.html` is
      // an `html_partial` whose composing parent is unobservable.
      const source = ["<nav><a href='/a'>A</a></nav>", "<nav><a href='/b'>B</a></nav>"].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/nav.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.severity).toBe("info");
      expect(violations[0]?.message).toContain("partial");
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

    it("<header> inside <aside> is excluded (aside is sectioning content)", () => {
      // Two body-level <header>s would normally fire; the <header>
      // inside <aside> is a generic group and does not count. Only
      // one banner landmark observable → no duplicate.
      const source = [
        "<html>",
        "  <body>",
        "    <header>Site</header>",
        "    <aside>",
        "      <header>Sidebar heading</header>",
        "      <p>related content</p>",
        "    </aside>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("html_partial with 2 <nav> emits at info severity with partial framing (not 'Document has 2')", () => {
      // Backlog regression: a Jekyll _includes/header.html with two
      // <nav>s previously fired at severity="warning" with message
      // "Document has 2 <nav> landmarks" — dishonest because the
      // file is a partial. Closure: severity drops to info, message
      // reframes to "this partial supplies", couldBeWrongBecause
      // surfaces the partial-input concession code, suggestion
      // names the dismissal hatch (ra11y-disable pragma).
      const source = [
        "<header>",
        "  <nav><a href='/primary'>Primary</a></nav>",
        "  <nav><a href='/utility'>Utility</a></nav>",
        "</header>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "_includes/header.html" });
      expect(violations).toHaveLength(2);
      for (const v of violations) {
        expect(v.severity).toBe("info");
        expect(v.message).not.toContain("Document has");
        expect(v.message).toContain("partial");
        expect(v.couldBeWrongBecause).toContain("partial_input_duplicate_landmark_in_fragment");
        expect(v.suggestion).toContain("this partial");
        expect(v.suggestion).toContain("ra11y-disable");
      }
    });

    it("two body-level <header>s both unlabeled, suggestion enumerates the other line", () => {
      const source = [
        "<html>",
        "  <body>",
        "    <header>Site</header>",
        "    <main>content</main>",
        "    <header>Promo</header>",
        "  </body>",
        "</html>",
      ].join("\n");
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      // First flagged <header> at line 3; suggestion should reference line 5.
      expect(violations[0]?.location.line).toBe(3);
      expect(violations[0]?.suggestion).toContain("line 5");
      // Second flagged <header> at line 5; suggestion should reference line 3.
      expect(violations[1]?.location.line).toBe(5);
      expect(violations[1]?.suggestion).toContain("line 3");
    });
  });
});
