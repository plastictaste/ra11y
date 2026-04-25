import { describe, expect, it } from "bun:test";
import { rule, TOOLTIP_JS_ENHANCER_PRESENT } from "../../../../src/rules/tooltip/dismissable.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule tooltip/dismissable", () => {
  describe("HTML: fires a violation when", () => {
    it("button has a title attribute", () => {
      const violations = runRule(rule, `<button title="Save document">💾</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("tooltip/dismissable");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.criteria).toContain("wcag22:1.4.13");
      expect(violations[0]?.criteria).toContain("wcag21:1.4.13");
      expect(violations[0]?.suggestion).toMatch(/aria-label="Save document"/);
    });

    it("anchor with href has a title attribute", () => {
      const violations = runRule(rule, `<a href="/help" title="Help center">Help</a>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<a>/);
    });

    it("input has a title attribute", () => {
      const violations = runRule(rule, `<input type="text" title="Enter your full name" />`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<input>/);
    });

    it("select has a title attribute", () => {
      const violations = runRule(
        rule,
        `<select title="Choose a country"><option>UK</option></select>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("multiple interactive elements with title each fire", () => {
      const violations = runRule(
        rule,
        `<div><button title="A">a</button><button title="B">b</button></div>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(2);
    });

    it("truncates long title values in messaging", () => {
      const longTitle = "This is a very very very very very long descriptive title indeed";
      const violations = runRule(rule, `<button title="${longTitle}">x</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(1);
      // Ellipsis is the shared truncateForEcho sentinel (U+2026),
      // not three ASCII dots. See src/engine/ast-helpers.ts.
      expect(violations[0]?.message).toContain("\u2026");
    });
  });

  describe("HTML: does not fire when", () => {
    it("abbr has a title (canonical legitimate use)", () => {
      const violations = runRule(
        rule,
        `<p>The <abbr title="World Health Organization">WHO</abbr> said so.</p>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("dfn has a title", () => {
      const violations = runRule(
        rule,
        `<p><dfn title="A widget is a small device">widget</dfn></p>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("title is absent on the interactive element", () => {
      const violations = runRule(rule, `<button>Save</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("title is the empty string", () => {
      const violations = runRule(rule, `<button title="">Save</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("title is whitespace-only", () => {
      const violations = runRule(rule, `<button title="   ">Save</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("anchor without href has a title (anchor is non-interactive)", () => {
      const violations = runRule(rule, `<a title="Section anchor">x</a>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("input type=hidden has a title", () => {
      const violations = runRule(
        rule,
        `<input type="hidden" name="csrf" title="CSRF token" value="abc" />`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("non-interactive span has a title", () => {
      const violations = runRule(rule, `<span title="metadata">label</span>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: edge cases", () => {
    it("div with role='button' and title fires", () => {
      const violations = runRule(
        rule,
        `<div role="button" tabindex="0" title="Open menu">☰</div>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<div>/);
    });

    it("span with role='link' and title fires", () => {
      const violations = runRule(
        rule,
        `<span role="link" tabindex="0" title="Open profile">user</span>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("summary element with title fires (interactive disclosure)", () => {
      const violations = runRule(
        rule,
        `<details><summary title="Click to expand">More</summary></details>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("button JSX has a title prop", () => {
      const violations = runRule(rule, `<button title="Save">💾</button>`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("tooltip/dismissable");
    });

    it("anchor JSX with href has a title prop", () => {
      const violations = runRule(rule, `<a href="/help" title="Help">?</a>`);
      expect(violations).toHaveLength(1);
    });

    it("expression-valued title on a button fires", () => {
      const violations = runRule(
        rule,
        `const label = "Save"; const x = <button title={label}>💾</button>;`,
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("custom Tooltip component has a title prop (out of scope)", () => {
      const violations = runRule(
        rule,
        `const x = <Tooltip title="hi"><button>x</button></Tooltip>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("button has aria-label instead of title", () => {
      const violations = runRule(rule, `<button aria-label="Save">💾</button>`);
      expect(violations).toHaveLength(0);
    });

    it("abbr in JSX with title is exempt", () => {
      const violations = runRule(
        rule,
        `const x = <abbr title="World Health Organization">WHO</abbr>;`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  // Elements with a JS-tooltip-library trigger attribute on the same
  // node as the title still fire the rule (surface-don't-suppress),
  // but the emitted message gains a short enrichment clause and the
  // violation carries the `tooltip_js_enhancer_present`
  // couldBeWrongBecause code so the agent can read the file and
  // dismiss quickly when the runtime widget is in fact compliant.
  // See ADR 0009 and the bootstrap-data-bs-toggle-tooltip real-world
  // fixture.
  describe("JS-tooltip-enhancer enrichment", () => {
    const ENRICHMENT_TOKEN = "JS tooltip library";

    it("HTML: data-bs-toggle='tooltip' sibling enriches message + couldBeWrongBecause", () => {
      const violations = runRule(
        rule,
        `<button data-bs-toggle="tooltip" title="Tooltip on top">x</button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.message).toContain(`data-bs-toggle="tooltip"`);
      expect(violations[0]?.couldBeWrongBecause).toContain(TOOLTIP_JS_ENHANCER_PRESENT);
      // Severity must not be downgraded — this is enrichment, not suppression.
      expect(violations[0]?.severity).toBe("warning");
    });

    it("HTML: data-bs-toggle='popover' sibling enriches", () => {
      const violations = runRule(
        rule,
        `<button data-bs-toggle="popover" title="Popover title">x</button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.couldBeWrongBecause).toContain(TOOLTIP_JS_ENHANCER_PRESENT);
    });

    it("HTML: BS4 legacy data-toggle='tooltip' sibling enriches", () => {
      const violations = runRule(
        rule,
        `<button data-toggle="tooltip" title="Legacy tooltip">x</button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.couldBeWrongBecause).toContain(TOOLTIP_JS_ENHANCER_PRESENT);
    });

    it("HTML: BS4 legacy data-toggle='popover' sibling enriches", () => {
      const violations = runRule(
        rule,
        `<a href="/x" data-toggle="popover" title="Legacy popover">x</a>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.couldBeWrongBecause).toContain(TOOLTIP_JS_ENHANCER_PRESENT);
    });

    it("HTML: data-tippy-content sibling (any non-empty value) enriches", () => {
      const violations = runRule(
        rule,
        `<a href="/x" data-tippy-content="Help center details" title="Help">x</a>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.message).toContain("data-tippy-content");
      expect(violations[0]?.couldBeWrongBecause).toContain(TOOLTIP_JS_ENHANCER_PRESENT);
    });

    it("HTML: plain title with no enhancer attribute keeps the original message", () => {
      // Negative control — the sibling-attribute absence must NOT add
      // the enrichment or the couldBeWrongBecause code. This is the
      // guard that prevents the enrichment from leaking onto every
      // finding.
      const violations = runRule(rule, `<button title="Save document">x</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).not.toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("HTML: data-bs-toggle='modal' does NOT enrich (value-sensitive)", () => {
      // The trigger is tooltip/popover specifically — other
      // data-bs-toggle values (collapse, modal, dropdown, …) do not
      // replace the native title at all. Must not enrich.
      const violations = runRule(
        rule,
        `<button data-bs-toggle="modal" title="Open modal">x</button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).not.toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("HTML: empty data-tippy-content does NOT enrich", () => {
      // Tippy needs a non-empty content string; an empty attribute is
      // structurally inert, so we don't surface the enrichment signal.
      const violations = runRule(rule, `<button data-tippy-content="" title="Save">x</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).not.toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("JSX: data-bs-toggle='tooltip' sibling enriches", () => {
      const violations = runRule(
        rule,
        `const x = <button data-bs-toggle="tooltip" title="Tooltip">x</button>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.couldBeWrongBecause).toContain(TOOLTIP_JS_ENHANCER_PRESENT);
    });

    it("JSX: data-tippy-content sibling enriches", () => {
      const violations = runRule(
        rule,
        `const x = <a href="/x" data-tippy-content="Details" title="Help">x</a>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ENRICHMENT_TOKEN);
      expect(violations[0]?.couldBeWrongBecause).toContain(TOOLTIP_JS_ENHANCER_PRESENT);
    });
  });

  // When the flagged element's visible text already equals the title
  // value (trimmed, case-insensitive), the "replace with visible text"
  // and "use aria-label" alternatives just re-state the existing DOM —
  // the accessible name is already there, the WCAG 1.4.13 failure is
  // the keyboard-dismiss behavior. The rule still fires; only the
  // suggestion drops the redundant alternatives. Per
  // docs/kb/architecture/ai-first-consumer.md "the tool must not
  // suggest alternatives that re-state the existing state of the DOM."
  describe("suggestion: visible text equals title", () => {
    it("HTML: button text == title — suggestion omits visible-text and aria-label alternatives", () => {
      const violations = runRule(rule, `<button title="Tooltip on top">Tooltip on top</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      // Rule still fires at the same severity — this is reason-text
      // adjustment, not suppression or downgrade.
      expect(violations[0]?.severity).toBe("warning");
      // Redundant alternatives must NOT appear when text already matches.
      expect(suggestion).not.toMatch(/aria-label="Tooltip on top"/);
      expect(suggestion).not.toMatch(/visible text label inside the element/);
      // The remaining guidance is the keyboard-dismiss / library upgrade path.
      expect(suggestion).toMatch(/Escape-to-dismiss/);
      expect(suggestion).toMatch(/custom tooltip component/);
    });

    it("HTML: text == title differs only in case/whitespace — same suppression of redundant alternatives", () => {
      const violations = runRule(
        rule,
        `<button title="Tooltip on top">  TOOLTIP on TOP  </button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).not.toMatch(/aria-label=/);
      expect(suggestion).not.toMatch(/visible text label inside the element/);
    });

    it("HTML: text != title — full three-alternative suggestion preserved", () => {
      const violations = runRule(rule, `<button title="Hover info">Help</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      // All three alternatives must remain when the visible text does
      // not already convey the title content.
      expect(suggestion).toMatch(/visible text label inside the element/);
      expect(suggestion).toMatch(/aria-label="Hover info"/);
      expect(suggestion).toMatch(/custom tooltip component/);
    });

    it("JSX: text == title (string-literal title) drops redundant alternatives", () => {
      const violations = runRule(
        rule,
        `const x = <button title="Tooltip on top">Tooltip on top</button>;`,
      );
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).not.toMatch(/aria-label="Tooltip on top"/);
      expect(suggestion).not.toMatch(/visible text label inside the element/);
    });

    it("JSX: expression-valued title keeps the full three-alternative suggestion (text not statically known)", () => {
      // For title={expr}, static analysis cannot determine whether the
      // runtime value equals the visible text, so we keep the full menu
      // — agent reads the file and decides. Surfacing the full set is
      // the correct conservative move.
      const violations = runRule(
        rule,
        `const label = "Tooltip on top"; const x = <button title={label}>Tooltip on top</button>;`,
      );
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).toMatch(/visible text label inside the element/);
      expect(suggestion).toMatch(/custom tooltip component/);
    });
  });

  // Belt-and-braces DOM-origin gate: a `title="…"` attribute substring
  // inside a packed plugin or minified `.js` bundle is not a real
  // interactive element — the surrounding code may be a string-template
  // factory, a JS-API wrapper, or a build-time interpolation. Only act on
  // JSX nodes parsed out of `.tsx` / `.jsx` (and the JSX-bearing `.mdx` /
  // `.astro` aliases).
  describe("non-JSX JS gate", () => {
    it("does not fire on a bare .js file containing a button-with-title substring", () => {
      const source = `var html = '<button title="Save document">x</button>';`;
      const violations = runRule(rule, source, { filePath: "vendor.js" });
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a bare .ts file containing a button-with-title substring", () => {
      const source = `const tpl = \`<button title="Save document">x</button>\`;`;
      const violations = runRule(rule, source, { filePath: "build.ts" });
      expect(violations).toHaveLength(0);
    });

    it("still fires on a .tsx file containing the same titled interactive element", () => {
      const violations = runRule(rule, `function F(){return <button title="Save">x</button>}`, {
        filePath: "Btn.tsx",
      });
      expect(violations).toHaveLength(1);
    });
  });
});
