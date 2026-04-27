import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/tab-widget-roles.ts";
import { runRule } from "../../../helpers/run-rule.ts";

const FULL_PAGE_PREFIX =
  '<!doctype html><html lang="en"><head><title>Tabs</title></head><body><h1>Tabs demo</h1>';
const FULL_PAGE_SUFFIX = "</body></html>";

function fullPage(body: string): string {
  return `${FULL_PAGE_PREFIX}${body}${FULL_PAGE_SUFFIX}`;
}

describe("rule aria/tab-widget-roles", () => {
  describe("fires a violation when", () => {
    it("Bootstrap-4 idiom (data-toggle=tab) lacks the role triple entirely", () => {
      const violations = runRule(
        rule,
        fullPage(`<ul>
  <li><a data-toggle="tab" href="#panel-1">Tab 1</a></li>
  <li><a data-toggle="tab" href="#panel-2">Tab 2</a></li>
</ul>
<div id="panel-1">Panel 1</div>
<div id="panel-2">Panel 2</div>`),
        { filePath: "index.html" },
      );
      // One emit per tab member (two members, two emits).
      expect(violations).toHaveLength(2);
      const first = violations[0];
      expect(first?.ruleId).toBe("aria/tab-widget-roles");
      expect(first?.severity).toBe("error");
      expect(first?.message).toContain('data-toggle="tab"');
      expect(first?.message).toContain('no role="tab"');
      expect(first?.message).toContain("no aria-selected");
      expect(first?.message).toContain('parent has no role="tablist"');
      expect(first?.message).toContain('the controlled panel has no role="tabpanel"');
      expect(first?.suggestion).toContain('role="tab"');
      expect(first?.suggestion).toContain("aria-selected");
      expect(first?.suggestion).toContain('role="tablist"');
      expect(first?.suggestion).toContain('role="tabpanel"');
    });

    it("Bootstrap-5 idiom (data-bs-toggle=tab) on a button lacks the role triple", () => {
      const violations = runRule(
        rule,
        fullPage(`<div class="nav">
  <button data-bs-toggle="tab" data-bs-target="#panel-a">Tab A</button>
</div>
<div id="panel-a">Panel A</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('data-bs-toggle="tab"');
      expect(violations[0]?.message).toContain('no role="tab"');
      expect(violations[0]?.message).toContain("no aria-selected");
      expect(violations[0]?.message).toContain('parent has no role="tablist"');
    });

    it('role="tab" present but aria-selected missing fires (partial role triple)', () => {
      const violations = runRule(
        rule,
        fullPage(`<ul role="tablist">
  <li><a role="tab" data-toggle="tab" href="#panel-1" aria-controls="panel-1" id="tab-1">Tab 1</a></li>
</ul>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel 1</div>`),
        { filePath: "index.html" },
      );
      // role=tab + tablist parent + tabpanel target are all in place;
      // only aria-selected is missing — and the immediate parent is the
      // <li>, which is not the tablist. So gaps fire for both.
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("no aria-selected");
      // Parent of the tab is the <li>, not the <ul role="tablist"> —
      // still surfaces (the WAI-ARIA tabs APG requires direct parent).
      expect(violations[0]?.message).toContain('parent has no role="tablist"');
    });

    it("role=tab on a member whose aria-controls target is not a tabpanel fires panel-role gap", () => {
      const violations = runRule(
        rule,
        fullPage(`<div role="tablist">
  <button role="tab" aria-selected="true" aria-controls="region-1" id="tab-1">Tab</button>
</div>
<div role="region" id="region-1">Not a tabpanel</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('the controlled panel has no role="tabpanel"');
      expect(violations[0]?.severity).toBe("error");
    });
  });

  describe("does not fire when", () => {
    it("a fully APG-conformant tab widget is present (HTML)", () => {
      const violations = runRule(
        rule,
        fullPage(`<div role="tablist">
  <button role="tab" aria-selected="true" aria-controls="panel-1" id="tab-1">Tab 1</button>
  <button role="tab" aria-selected="false" aria-controls="panel-2" id="tab-2">Tab 2</button>
</div>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel 1</div>
<div role="tabpanel" id="panel-2" aria-labelledby="tab-2">Panel 2</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the file contains no tab-widget idiom signals", () => {
      const violations = runRule(
        rule,
        fullPage(`<nav>
  <ul>
    <li><a href="/about">About</a></li>
    <li><a href="/contact">Contact</a></li>
  </ul>
</nav>
<main><h2>Welcome</h2><p>Body copy.</p></main>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a fully APG-conformant tab widget is present (JSX)", () => {
      const violations = runRule(
        rule,
        `function Tabs() {
  return (
    <>
      <div role="tablist">
        <button role="tab" aria-selected="true" aria-controls="panel-1" id="tab-1">Tab 1</button>
        <button role="tab" aria-selected="false" aria-controls="panel-2" id="tab-2">Tab 2</button>
      </div>
      <div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel 1</div>
      <div role="tabpanel" id="panel-2" aria-labelledby="tab-2">Panel 2</div>
    </>
  );
}`,
        { filePath: "Tabs.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("downgrades panel-only gaps to info on fragment files (panel may live in sibling include)", () => {
      const violations = runRule(
        rule,
        `<div role="tablist">
  <button role="tab" aria-selected="true" aria-controls="panel-in-sibling" id="tab-1">Tab</button>
</div>`,
        { filePath: "_includes/tablist.html" },
      );
      // Parent role=tablist, role=tab present, aria-selected present,
      // and aria-controls dangles in this fragment — that's a
      // panel-only situation, downgrade to info.
      expect(violations).toHaveLength(0);
    });

    it("data-toggle with a non-tab value (e.g. data-toggle=dropdown) does not trigger detection", () => {
      const violations = runRule(
        rule,
        fullPage(`<button data-toggle="dropdown">Menu</button>
<ul class="dropdown-menu"><li><a href="/a">Item</a></li></ul>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("data-bs-toggle=Tab (mixed case) is still recognised as the tab idiom", () => {
      const violations = runRule(
        rule,
        fullPage(`<button data-bs-toggle="Tab" data-bs-target="#p">Tab</button>
<div id="p">Panel</div>`),
        { filePath: "index.html" },
      );
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]?.message).toContain('data-bs-toggle="Tab"');
    });

    it("treats role=presentation wrapper as transparent (canonical WAI-ARIA APG tabs pattern)", () => {
      // The APG tabs pattern places <li role="presentation"> between
      // <ul role="tablist"> and <button role="tab"> as a styling-only
      // wrapper; the accessibility tree strips presentation roles so
      // the button's effective parent IS the tablist. The rule must
      // walk past the presentational <li> when resolving the parent.
      // https://www.w3.org/WAI/ARIA/apg/patterns/tabs/
      const violations = runRule(
        rule,
        fullPage(`<ul role="tablist">
  <li role="presentation"><button role="tab" aria-selected="true" aria-controls="panel-1" id="tab-1">Tab 1</button></li>
  <li role="presentation"><button role="tab" aria-selected="false" aria-controls="panel-2" id="tab-2">Tab 2</button></li>
</ul>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel 1</div>
<div role="tabpanel" id="panel-2" aria-labelledby="tab-2">Panel 2</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("treats role=none wrapper as transparent (alias of presentation in WAI-ARIA 1.2)", () => {
      const violations = runRule(
        rule,
        fullPage(`<ul role="tablist">
  <li role="none"><button role="tab" aria-selected="true" aria-controls="panel-1" id="tab-1">Tab 1</button></li>
</ul>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel 1</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("still fires when ancestors are presentational but no role=tablist exists anywhere", () => {
      // Negative: presentation/none wrappers shouldn't *suppress* the
      // gap when there's genuinely no tablist ancestor — the walk must
      // surface the missing tablist on the next non-presentational
      // ancestor (or the document root).
      const violations = runRule(
        rule,
        fullPage(`<div role="presentation">
  <span role="none"><button role="tab" aria-selected="true" aria-controls="panel-1" id="tab-1">Tab 1</button></span>
</div>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel 1</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('parent has no role="tablist"');
    });

    it("treats role=presentation wrapper as transparent in JSX (canonical APG pattern)", () => {
      const violations = runRule(
        rule,
        `function Tabs() {
  return (
    <>
      <ul role="tablist">
        <li role="presentation"><button role="tab" aria-selected="true" aria-controls="panel-1" id="tab-1">Tab 1</button></li>
      </ul>
      <div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel 1</div>
    </>
  );
}`,
        { filePath: "Tabs.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("flags every tab member separately (one emit per member, not aggregated)", () => {
      const violations = runRule(
        rule,
        fullPage(`<ul>
  <li><a data-toggle="tab" href="#a">A</a></li>
  <li><a data-toggle="tab" href="#b">B</a></li>
  <li><a data-toggle="tab" href="#c">C</a></li>
</ul>
<div id="a">A</div><div id="b">B</div><div id="c">C</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(3);
      // Each emit is on a distinct line (the <a> elements are on
      // different lines in the fixture), so line numbers should differ.
      const lines = new Set(violations.map((v) => v.location.line));
      expect(lines.size).toBe(3);
    });
  });
});
