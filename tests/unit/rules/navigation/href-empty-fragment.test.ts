import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/href-empty-fragment.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/href-empty-fragment", () => {
  describe("HTML: fires on bare fragment #", () => {
    it('href="#" (bare placeholder)', () => {
      const violations = runRule(rule, `<a href="#">Click</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.criteria).toContain("wcag22:2.1.1");
    });

    it('href="  #  " (whitespace trimmed before comparison)', () => {
      const violations = runRule(rule, `<a href="  #  ">Click</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: fires on empty href", () => {
    // Per HTML spec, an empty href resolves to the current document URL —
    // activating the link reloads the page rather than navigating. The
    // anchor still announces as a link, so the role/behavior contradict
    // the same way `href="#"` does. `link-no-href` only catches the
    // empty-href case when an onClick is also present (its scope is the
    // <a onClick> keyboard-trap pattern); the bare-text case below is
    // common in legacy form pages ("Forgot password?", social-share
    // rows wired up later) and was previously silent in both rules.

    it('href="" (empty placeholder, no onClick — Forgot password? pattern)', () => {
      const violations = runRule(rule, `<a href="">Forgot password?</a>`, {
        filePath: "signin.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
    });

    it('href="   " (whitespace-only collapses to empty after trim)', () => {
      const violations = runRule(rule, `<a href="   ">Click</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
    });
  });

  describe("HTML: does not fire on javascript: schemes or real URLs", () => {
    it('href="javascript:void(0)" — handled by navigation/href-javascript-scheme', () => {
      const violations = runRule(rule, `<a href="javascript:void(0)">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("real URL path", () => {
      const violations = runRule(rule, `<a href="/dashboard">Dashboard</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("https:// URL", () => {
      const violations = runRule(rule, `<a href="https://example.com">Example</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("fragment to an in-page id", () => {
      const violations = runRule(rule, `<a href="#section-2">Section 2</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("mailto: URL", () => {
      const violations = runRule(rule, `<a href="mailto:hi@example.com">Email</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("bare <a> with no href attribute (not this rule's concern)", () => {
      const violations = runRule(rule, `<a>plain text</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires on bare fragment", () => {
    it('href="#"', () => {
      const violations = runRule(rule, `const X = <a href="#">Click</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
    });
  });

  describe("JSX: fires on empty href", () => {
    it('href="" (empty placeholder, no onClick)', () => {
      const violations = runRule(rule, `const X = <a href="">Forgot password?</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/href-empty-fragment");
    });
  });

  describe("JSX: does not fire", () => {
    it("real URL", () => {
      const violations = runRule(rule, `const X = <a href="/x">Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("fragment to a named id", () => {
      const violations = runRule(rule, `const X = <a href="#top">Top</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("expression-form href={url} (opaque — agent investigates if suspicious)", () => {
      const violations = runRule(rule, `const X = <a href={url}>Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("PascalCase Link component is not a bare <a>", () => {
      const violations = runRule(rule, `const X = <Link href="#">Go</Link>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("context-aware fix suggestion", () => {
    it('bare # → suggests <button type="button"> or a real fragment id', () => {
      const violations = runRule(rule, `<a href="#">x</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`<button type="button"`);
      expect(sugg).toContain("section-id");
    });

    it("empty href → message names page-reload behavior; suggestion offers real path or <button>", () => {
      const violations = runRule(rule, `<a href="">Forgot password?</a>`, {
        filePath: "signin.html",
      });
      expect(violations).toHaveLength(1);
      const message = violations[0]?.message ?? "";
      const sugg = violations[0]?.suggestion ?? "";
      expect(message).toContain("reloads");
      expect(sugg).toContain('href="/real/path"');
      expect(sugg).toContain(`<button type="button"`);
    });
  });

  describe("edge cases", () => {
    it("multiple offending anchors fire once each", () => {
      const violations = runRule(rule, `<a href="#">A</a><a href="">B</a><a href="/real">C</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(2);
    });

    it('fragment-nav case `<a href="#non-empty-id">` still does NOT fire', () => {
      // Regression guard — extending coverage to empty href must not
      // sweep up legitimate in-page fragment navigation. Real fragment
      // ids land on a node and scroll/focus it; that's real navigation.
      const violations = runRule(rule, `<a href="#non-empty-id">Skip to main</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  // Belt-and-braces DOM-origin gate: an `<a href="">` substring inside a
  // packed plugin or minified `.js` bundle is not a real anchor — the
  // surrounding code may be a string-template factory, a JS-API wrapper,
  // or a build-time interpolation. Only act on JSX nodes parsed out of
  // `.tsx` / `.jsx` (and the JSX-bearing `.mdx` / `.astro` aliases).
  describe("non-JSX JS gate", () => {
    it("does not fire on a bare .js file containing a placeholder anchor substring", () => {
      const source = `var html = '<a href="">click</a>';`;
      const violations = runRule(rule, source, { filePath: "vendor.js" });
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a bare .ts file containing a bare-fragment anchor substring", () => {
      const source = `const tpl = \`<a href="#">x</a>\`;`;
      const violations = runRule(rule, source, { filePath: "build.ts" });
      expect(violations).toHaveLength(0);
    });

    it("still fires on a .tsx file containing the same placeholder anchor", () => {
      const violations = runRule(rule, `function F(){return <a href="">x</a>}`, {
        filePath: "Link.tsx",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("pagination-context fix suggestion", () => {
    // The current `suggest_fix` output, before this branch, pointed at
    // accessible-name fixes (aria-label, visible text) when a pagination
    // anchor was emitted. The actual issue is the placeholder href, not
    // the accessible name — labelling a link that goes nowhere is still a
    // link that goes nowhere. When an ancestor's class contains a known
    // pagination token (`pagination`, `pager`, `page-link`, `page-item`,
    // `paginator`), the suggestion branches: <button type="button"> for
    // action-only behaviors, real href for navigation behaviors.

    it('HTML: bare # inside <ul class="pagination"> branches the suggestion', () => {
      const violations = runRule(
        rule,
        `<ul class="pagination"><li><a href="#">Next</a></li></ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain("pagination context");
      expect(sugg).toContain("pagination");
      expect(sugg).toContain(`<button type="button"`);
      // The fix path also names supplying a real href as the alternative.
      expect(sugg).toMatch(/href=/);
      // Does NOT recommend aria-label as the fix — the underlying issue
      // is the placeholder href, not the accessible name. (The reason
      // text explicitly tells the agent not to paper over with aria-label.)
      expect(sugg).toContain("Don't paper over with `aria-label`");
    });

    it('HTML: empty href inside <nav class="pager"> branches the suggestion', () => {
      const violations = runRule(rule, `<nav class="pager"><a href="">Previous</a></nav>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain("pagination context");
      expect(sugg).toContain("pager");
      expect(sugg).toContain(`<button type="button"`);
    });

    it('HTML: bare # on an <a class="page-link"> directly (token on the anchor itself) branches', () => {
      const violations = runRule(rule, `<a class="page-link" href="#">2</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain("pagination context");
      expect(sugg).toContain("page-link");
    });

    it("HTML: bare # outside any pagination context keeps the original generic suggestion", () => {
      const violations = runRule(rule, `<div class="content"><a href="#">x</a></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      // Generic suggestion mentions section-id (in-page nav) — pagination
      // suggestion does not, so this asserts we did NOT branch.
      expect(sugg).toContain("section-id");
      expect(sugg).not.toContain("pagination context");
    });

    it("JSX: bare # inside className=pagination branches the suggestion", () => {
      const violations = runRule(
        rule,
        `function F(){return <ul className="pagination"><li><a href="#">Next</a></li></ul>}`,
        { filePath: "Page.tsx" },
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain("pagination context");
      expect(sugg).toContain(`<button type="button"`);
    });

    it("HTML: case-insensitive — class=Pagination still branches", () => {
      const violations = runRule(rule, `<ul class="Pagination"><a href="#">x</a></ul>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("pagination context");
    });

    it("HTML: deeper nesting — pagination class on grandparent still inherits", () => {
      const violations = runRule(
        rule,
        `<nav class="pagination"><ul><li><span><a href="#">x</a></span></li></ul></nav>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("pagination context");
    });
  });

  // When the flagged anchor sits inside a docs-example wrapper (or is
  // synthesized from a docs-component template-literal `code` prop), the
  // rule appends a one-read dismissal hint to message + suggestion so the
  // agent can recognize demonstration code in one pass. Reason-enrichment
  // only — emission and severity stay unchanged.
  describe("docs-example ancestor hint", () => {
    it("JSX: anchor inside <Example> ancestor adds the component hint", () => {
      const violations = runRule(
        rule,
        `function F(){return <Example><a href="#">x</a></Example>}`,
        { filePath: "Page.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).toContain("<Example> component");
      expect(violations[0]?.suggestion).toContain("<Example> component");
    });

    it("JSX: anchor inside nested <CodeBlock> ancestor adds the component hint", () => {
      const violations = runRule(
        rule,
        `function F(){return <CodeBlock><div><a href="">x</a></div></CodeBlock>}`,
        { filePath: "Page.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<CodeBlock> component");
    });

    it("HTML: anchor inside <pre><code> adds a code-display block hint", () => {
      // The ancestor walk goes child → parent, so <code> is the closest
      // matching ancestor and wins. Either tag is a valid hint — assert
      // on the substring "block" to keep the test robust to either.
      const violations = runRule(rule, `<pre><code><a href="#">x</a></code></pre>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("block");
      expect(violations[0]?.message).toContain("<code> block");
    });

    it("HTML: anchor inside class-tagged wrapper adds the class-name hint", () => {
      const violations = runRule(rule, `<div class="docs-example"><a href="#">x</a></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("example");
    });

    it("HTML: anchor outside any docs-example wrapper has no hint appended", () => {
      const violations = runRule(rule, `<div><a href="#">x</a></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).not.toContain("demonstration code");
      expect(violations[0]?.suggestion).not.toContain("demonstration code");
    });

    it("JSX: existing emission is preserved when no example ancestor exists", () => {
      // Regression guard — without a docs-example ancestor the message is
      // unchanged from the pre-hint shape.
      const violations = runRule(rule, `const X = <a href="#">x</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).not.toContain("demonstration code");
    });
  });

  // MDX docs-component template-literal `code` prop — Starlight /
  // Docusaurus / Next MDX docs ship rendered HTML previews inside a JSX
  // attribute whose value is a substitution-free template literal. The
  // in-house MDX parser extracts that body and synthesizes JSX elements
  // for it (see `src/input/parsers/mdx-example-extractor.ts`); each
  // synthesized element carries `synthesized.source === "mdx-example-code"`.
  // When the flagged anchor is one of those, the hint names the code-prop
  // origin so an agent can dismiss in one read.
  describe("docs-example code-prop template-literal hint (MDX)", () => {
    it('MDX: <Example code={`<a href="#"></a>`}/> adds the code-prop hint', () => {
      const source = 'function F(){return <Example code={`<a href="#"></a>`}/>}';
      const violations = runRule(rule, source, { filePath: "Page.mdx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).toContain("code prop in JSX template literal");
      expect(violations[0]?.message).toContain("<Example>");
      expect(violations[0]?.suggestion).toContain("code prop in JSX template literal");
    });

    it('MDX: <Demo code={`<a href=""></a>`}/> names the Demo component in the hint', () => {
      const source = 'function F(){return <Demo code={`<a href=""></a>`}/>}';
      const violations = runRule(rule, source, { filePath: "Page.mdx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("code prop in JSX template literal");
      expect(violations[0]?.message).toContain("<Demo>");
    });

    it("MDX: nested anchor inside a wrapper element in the template body inherits the code-prop hint", () => {
      // The synthesized marker propagates to every element produced by
      // the extractor, so a nested `<div><a href="#"/></div>` in the
      // template body still names the code-prop origin.
      const source = 'function F(){return <Example code={`<div><a href="#"></a></div>`}/>}';
      const violations = runRule(rule, source, { filePath: "Page.mdx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("code prop in JSX template literal");
    });

    it("MDX: a real (non-synthesized) anchor in MDX body has no code-prop hint", () => {
      // Regression guard — only synthesized anchors get the code-prop
      // hint; an anchor authored directly as MDX content does not.
      const source = 'function F(){return <a href="#">x</a>}';
      const violations = runRule(rule, source, { filePath: "Page.mdx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).not.toContain("code prop in JSX template literal");
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:4.1.2 + wcag22:2.1.1 and the 2.1 equivalents", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag22:2.1.1");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
      expect(rule.satisfies).toContain("wcag21:2.1.1");
    });
  });
});
