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

    it("input[type=submit] with value and title fires (value is the name source)", () => {
      // Bare `<input type="text" title="…" />` no longer fires under
      // the sole-name-source gate (no value, no visible text, no
      // aria-label) — see the gate-suppression block below for the
      // explicit coverage. Button-flavored inputs render the value as
      // their accessible name; a non-empty value passes the gate.
      const violations = runRule(
        rule,
        `<input type="submit" value="Save" title="Save and close the document" />`,
        { filePath: "page.html" },
      );
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
        `<div><button title="alpha tooltip">A</button><button title="beta tooltip">B</button></div>`,
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

  // Title-equals-visible-text gate: SC 1.4.13 governs "additional
  // content" that appears on hover or focus. When the title duplicates
  // the visible label exactly (trimmed, case-insensitive), no
  // additional content is presented to a sighted user — the
  // dismissability/hoverability/persistence tests of the success
  // criterion do not apply. Suppress at the rule level. Whitespace and
  // case differences between the two strings still count as
  // equivalent. Expression-valued JSX `title={expr}` is opaque to
  // static analysis and cannot be matched against visible text, so the
  // gate does NOT engage on those — the rule fires as before. Per the
  // rule header gate contract (deterministic from attribute +
  // descendant text alone, no guessed composition).
  describe("title-equals-visible-text gate", () => {
    it("HTML: button text exactly equals title — does NOT fire", () => {
      const violations = runRule(rule, `<button title="Tooltip on top">Tooltip on top</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("HTML: anchor text exactly equals title — does NOT fire", () => {
      // The canonical real-world repro this gate closes: BizPage-style
      // markup commonly emits an anchor with title= duplicating the
      // visible label, e.g. <a title="front matter">front matter</a>.
      const violations = runRule(rule, `<a href="/x" title="front matter">front matter</a>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("HTML: text differs from title only in case — does NOT fire", () => {
      const violations = runRule(rule, `<button title="Tooltip on top">TOOLTIP ON TOP</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("HTML: text differs from title only in surrounding whitespace — does NOT fire", () => {
      const violations = runRule(rule, `<button title="Save">  Save  </button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("HTML: text combines case + whitespace differences — does NOT fire", () => {
      const violations = runRule(
        rule,
        `<button title="Tooltip on top">  TOOLTIP on TOP  </button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML: text differs from title — full three-alternative suggestion preserved", () => {
      const violations = runRule(rule, `<button title="Hover info">Help</button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(1);
      const suggestion = violations[0]?.suggestion ?? "";
      expect(suggestion).toMatch(/visible text label inside the element/);
      expect(suggestion).toMatch(/aria-label="Hover info"/);
      expect(suggestion).toMatch(/custom tooltip component/);
    });

    it("JSX: button string-literal title equals visible text — does NOT fire", () => {
      const violations = runRule(
        rule,
        `const x = <button title="Tooltip on top">Tooltip on top</button>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX: anchor string-literal title equals visible text — does NOT fire", () => {
      const violations = runRule(
        rule,
        `const x = <a href="/x" title="front matter">front matter</a>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX: case-only difference between title and visible text — does NOT fire", () => {
      const violations = runRule(rule, `const x = <button title="save">SAVE</button>;`);
      expect(violations).toHaveLength(0);
    });

    it("JSX: expression-valued title with matching visible text still fires (runtime opaque)", () => {
      // For title={expr}, static analysis cannot determine whether the
      // runtime value equals the visible text, so the gate does not
      // engage and the rule fires as before. Agent reads the file and
      // decides — this is the conservative ("surface, don't suppress")
      // move on the unknown-runtime branch.
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

  // Sole-name-source gate: when `title` is the *only* accessible-name
  // source on the interactive element (no visible text content, no
  // aria-label, no aria-labelledby, no value on a button-input, no
  // alt-bearing descendant <img>), the dismiss path the rule
  // recommends ("add aria-label") would land an aria-label that
  // competes with the existing title for the same name slot — the
  // suggestion would be self-defeating. Suppress on this branch and
  // keep the supplementary-title flagging on the cases where another
  // name source is present and the dismissability failure is the only
  // 1.4.13 issue. Per the backlog
  // gate contract; deterministic from attributes + descendant text
  // alone (no guessed composition), so the gate is honest per
  // docs/kb/architecture/ai-first-consumer.md "the test before adding
  // a gate is whether the predicate is provable from the code."
  describe("sole-name-source gate", () => {
    it("HTML: empty button with only title does NOT fire", () => {
      const violations = runRule(rule, `<button title="Save"></button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("HTML: bare input[type=text] with only title does NOT fire", () => {
      const violations = runRule(rule, `<input type="text" title="Enter your full name" />`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("HTML: bare anchor (with href) and only title does NOT fire", () => {
      const violations = runRule(rule, `<a href="/help" title="Help center"></a>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("HTML: input[type=submit] WITHOUT value and only title does NOT fire", () => {
      const violations = runRule(rule, `<input type="submit" title="Save" />`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("HTML: button wrapping img with no alt and only title does NOT fire", () => {
      const violations = runRule(rule, `<button title="Save"><img src="save.png" /></button>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("HTML: button wrapping img with empty alt does NOT fire", () => {
      // alt="" is explicitly decorative — does not count as a name source.
      const violations = runRule(
        rule,
        `<button title="Save"><img src="save.png" alt="" /></button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML: button with aria-label + title fires (aria-label is the name source)", () => {
      const violations = runRule(
        rule,
        `<button aria-label="Save document" title="Click to persist changes"></button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
      // Reason-text must cite the gate so the agent understands the
      // suggestion's "add aria-label" branch is contextual, not a
      // greenfield instruction.
      expect(violations[0]?.message).toMatch(/already has another name source/);
    });

    it("HTML: button with aria-labelledby + title fires", () => {
      const violations = runRule(
        rule,
        `<h2 id="save-heading">Save</h2><button aria-labelledby="save-heading" title="Click to persist changes"></button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("HTML: button wrapping img WITH alt + title fires", () => {
      const violations = runRule(
        rule,
        `<button title="Save document"><img src="save.png" alt="floppy disk icon" /></button>`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("HTML: input[type=submit] WITH value + title fires (value is the name source)", () => {
      const violations = runRule(
        rule,
        `<input type="submit" value="Save" title="Save and close" />`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("HTML: input[type=button] WITH value + title fires", () => {
      const violations = runRule(
        rule,
        `<input type="button" value="Cancel" title="Discard changes" />`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("HTML: input[type=text] WITH value + title still does NOT fire (value is initial input, not a label)", () => {
      // Text inputs use `value` to seed initial content — that is NOT
      // the accessible name, so it must not pass the gate.
      const violations = runRule(
        rule,
        `<input type="text" value="seed text" title="Enter your name" />`,
        { filePath: "page.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML: div with role=button and only title (empty) does NOT fire", () => {
      const violations = runRule(rule, `<div role="button" tabindex="0" title="Open menu"></div>`, {
        filePath: "page.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("JSX: empty button with only title does NOT fire", () => {
      const violations = runRule(rule, `const x = <button title="Save"></button>;`);
      expect(violations).toHaveLength(0);
    });

    it("JSX: bare input with only title does NOT fire", () => {
      const violations = runRule(rule, `const x = <input type="text" title="Enter your name" />;`);
      expect(violations).toHaveLength(0);
    });

    it("JSX: button with aria-label + title fires", () => {
      const violations = runRule(
        rule,
        `const x = <button aria-label="Save" title="Click to persist"></button>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/already has another name source/);
    });

    it("JSX: button with expression child counts as opaque content (gate passes)", () => {
      // `{label}` is opaque to static analysis — treating it as a
      // possible name source is the conservative ("surface, don't
      // suppress") move on the rule-firing side.
      const violations = runRule(
        rule,
        `const label="x"; const y = <button title="Save">{label}</button>;`,
      );
      expect(violations).toHaveLength(1);
    });

    it("JSX: button wrapping img with alt + title fires", () => {
      const violations = runRule(
        rule,
        `const x = <button title="Save"><img src="s.png" alt="disk icon" /></button>;`,
      );
      expect(violations).toHaveLength(1);
    });

    it("JSX: input[type=submit] with value + title fires", () => {
      const violations = runRule(
        rule,
        `const x = <input type="submit" value="Save" title="Save and close" />;`,
      );
      expect(violations).toHaveLength(1);
    });

    it("JSX: button with aria-labelledby={expr} + title fires (expression treated as present)", () => {
      const violations = runRule(
        rule,
        `const id="h1"; const x = <button aria-labelledby={id} title="Click to save"></button>;`,
      );
      expect(violations).toHaveLength(1);
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
