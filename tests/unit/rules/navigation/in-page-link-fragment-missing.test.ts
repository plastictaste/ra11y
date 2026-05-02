import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/in-page-link-fragment-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/in-page-link-fragment-missing", () => {
  describe("HTML: fires when fragment id has no matching target", () => {
    it("simple typo: link to #mian but element id is #main", () => {
      // Two-character transposition is within Levenshtein distance 2,
      // so the suggestion surfaces the nearest id.
      const source = `<!doctype html><html><body><a href="#mian">Skip</a><main id="main"><h1>X</h1></main></body></html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/in-page-link-fragment-missing");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.criteria).toContain("wcag22:2.4.1");
      expect(violations[0]?.criteria).toContain("wcag21:2.4.1");
      // Suggests the nearest matching id.
      expect(violations[0]?.suggestion).toContain(`href="#main"`);
      expect(violations[0]?.suggestion).toContain("Did you mean");
    });

    it("link to #section-2 with no element carrying that id at all", () => {
      const source = `<!doctype html><html><body><a href="#section-2">Section 2</a><section id="section-1"><h2>One</h2></section></body></html>`;
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("`#section-2`");
    });

    it("multiple dangling fragments fire once each", () => {
      const source = `<!doctype html><html><body><nav><a href="#alpha">A</a><a href="#bravo">B</a><a href="#charlie">C</a></nav><section id="alpha"><h2>A</h2></section></body></html>`;
      const violations = runRule(rule, source, { filePath: "toc.html" });
      expect(violations).toHaveLength(2);
    });
  });

  describe("HTML: does not fire when fragment id resolves", () => {
    it("matching id on a sibling element", () => {
      const source = `<!doctype html><html><body><a href="#main">Skip</a><main id="main"><h1>X</h1></main></body></html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("matching id on a deeply nested element", () => {
      const source = `<!doctype html><html><body><a href="#deep"></a><div><div><div><span id="deep"></span></div></div></div></body></html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("legacy <a name='X'> satisfies href='#X'", () => {
      // HTML4 / XHTML 1.0 idiom — `<a name>` is the historical fragment-target
      // form and browsers still honor it. Including it on the lookup avoids
      // false positives on older content.
      const source = `<!doctype html><html><body><a href="#chapter-3">Chapter 3</a><h2><a name="chapter-3"></a>Chapter 3</h2></body></html>`;
      const violations = runRule(rule, source, { filePath: "book.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: edge cases out of scope (no emit)", () => {
    it("href='#' (bare placeholder — owned by navigation/href-empty-fragment)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><a href="#">x</a></body></html>`,
        {
          filePath: "page.html",
        },
      );
      expect(violations).toHaveLength(0);
    });

    it("href='' (empty — owned by navigation/href-empty-fragment)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><a href="">x</a></body></html>`,
        {
          filePath: "page.html",
        },
      );
      expect(violations).toHaveLength(0);
    });

    it("href='#top' (universal browser convention for top-of-page) does not fire even without #top element", () => {
      // Per the HTML "scroll to the fragment identifier" algorithm, `#top`
      // always scrolls to the top of the document regardless of whether
      // any `id="top"` element exists. Suppressing this case is honest.
      const source = `<!doctype html><html><body><a href="#top">Back to top</a><main><h1>Page</h1></main></body></html>`;
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("href='#TOP' (case-insensitive top convention)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><a href="#TOP">x</a></body></html>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("cross-document fragment href='/path#section' (out of scope)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><a href="/other#section-2">link</a></body></html>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("absolute URL with fragment href='https://example.com#section' (out of scope)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><a href="https://example.com#section">link</a></body></html>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("templated fragment href='#{{ section.slug }}' (Liquid/Jinja — runtime-resolved)", () => {
      // The fragment is a template expression resolved at render time;
      // the static scanner cannot know the rendered id, and echoing the
      // raw token as "the missing id" would leak directives into agent
      // output. The integration test
      // tests/integration/liquid-raw-directive-no-quote.test.ts is the
      // corpus-wide guard; this is the per-rule probe.
      const source = `<!doctype html><html><body><a href="#{{ section.slug }}">Skip</a></body></html>`;
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("templated fragment with ERB '#<%= chapter.id %>' is also skipped", () => {
      const source = `<!doctype html><html><body><a href="#<%= chapter.id %>">Chapter</a></body></html>`;
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("anchor without href attribute (not this rule's concern)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><a>plain text</a></body></html>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: fragment files omit emission entirely", () => {
    // Per the AI-first consumer doctrine bullet "Heuristic emission is
    // the symmetric twin of heuristic suppression": the predicate
    // "no element with this id exists in the rendered DOM" is
    // structurally unverifiable from a single fragment — the target
    // id may be supplied by the composing parent layout or a sibling
    // fragment composed into the same rendered page. Emitting at any
    // severity (even `info` with a hedge) leaks heuristic uncertainty
    // into a slot the agent reads as "the scanner saw evidence of
    // this." Honest shape: omit. Scan-confidence is preserved by the
    // FRAGMENT_DOWNGRADE_RULE_IDS entry in src/mcp/scan-assembly.ts.

    it("file under _includes/ omits emission entirely", () => {
      const source = `<a href="#sidebar">Open sidebar</a><nav>links</nav>`;
      const violations = runRule(rule, source, { filePath: "site/_includes/header.html" });
      expect(violations).toHaveLength(0);
    });

    it("bare HTML fragment (no <html>/<body>/<head>) omits emission", () => {
      const source = `<div class="card"><a href="#missing-target">Open</a></div>`;
      const violations = runRule(rule, source, { filePath: "card.html" });
      expect(violations).toHaveLength(0);
    });

    it("file under _partials/ omits emission", () => {
      const source = `<a href="#nope">x</a>`;
      const violations = runRule(rule, source, { filePath: "site/_partials/footer.html" });
      expect(violations).toHaveLength(0);
    });

    it("front-matter-prefixed source (markdown-residue / Jekyll) omits emission", () => {
      const source = `---\ntitle: Page\n---\n<a href="#missing">x</a>`;
      const violations = runRule(rule, source, { filePath: "post.html" });
      expect(violations).toHaveLength(0);
    });

    it("full HTML document with <html> envelope still emits (composing-page evidence is positive)", () => {
      // Counter-test: a file that declares itself a complete page
      // (positive `<html>` opener evidence) is NOT fragment-classified;
      // the rule emits as before. This pins that the omit-on-fragment
      // gate doesn't accidentally cover full-page documents.
      const source = `<!doctype html><html><body><a href="#missing">x</a><h1>Page</h1></body></html>`;
      const violations = runRule(rule, source, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("warning");
    });
  });

  describe("JSX: fires on dangling fragment", () => {
    it("string-literal href='#missing' with no matching id", () => {
      const source = `function P(){return <div><a href="#summary">Jump</a><section id="overview">x</section></div>;}`;
      const violations = runRule(rule, source, { filePath: "Page.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/in-page-link-fragment-missing");
    });
  });

  describe("JSX: does not fire", () => {
    it("matching id resolves", () => {
      const source = `function P(){return <div><a href="#main">x</a><main id="main">x</main></div>;}`;
      const violations = runRule(rule, source, { filePath: "Page.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("expression-form href={url} (opaque at static analysis)", () => {
      const source = `function P(){return <a href={url}>x</a>;}`;
      const violations = runRule(rule, source, { filePath: "Page.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("PascalCase Link component is not a bare <a>", () => {
      const source = `function P(){return <Link href="#missing">x</Link>;}`;
      const violations = runRule(rule, source, { filePath: "Page.tsx" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("non-JSX JS gate (DOM-origin guard)", () => {
    // Bare `.js` / `.ts` files routinely embed JSX-shaped substrings
    // inside string templates; the parser's heuristic JSX gate can be
    // fooled. Match the pattern in navigation/href-empty-fragment.
    it("does not fire on a .js file containing a fragment-href substring", () => {
      const source = `var html = '<a href="#missing">x</a>';`;
      const violations = runRule(rule, source, { filePath: "vendor.js" });
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a .ts file containing a fragment-href in a template", () => {
      const source = `const tpl = \`<a href="#missing">x</a>\`;`;
      const violations = runRule(rule, source, { filePath: "build.ts" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("context-aware fix suggestion", () => {
    it("typo within Levenshtein distance 2 surfaces nearest id", () => {
      const source = `<!doctype html><html><body><a href="#main-contnet">x</a><main id="main-content">x</main></body></html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("Did you mean");
      expect(violations[0]?.suggestion).toContain(`#main-content`);
    });

    it("no near match: suggestion describes adding the id or correcting the href", () => {
      const source = `<!doctype html><html><body><a href="#xyzzy">x</a><main id="main"><h1>X</h1></main></body></html>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`Add \`id="xyzzy"\``);
      expect(sugg).not.toContain("Did you mean");
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:2.4.1 + wcag21:2.4.1", () => {
      expect(rule.satisfies).toContain("wcag22:2.4.1");
      expect(rule.satisfies).toContain("wcag21:2.4.1");
    });

    it("declares scope=document and severity=warning", () => {
      expect(rule.scope).toBe("document");
      expect(rule.severity).toBe("warning");
    });
  });
});
