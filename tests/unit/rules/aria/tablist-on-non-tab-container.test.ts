import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/tablist-on-non-tab-container.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/tablist-on-non-tab-container", () => {
  describe('fires on HTML when role="tablist"', () => {
    it("contains only tabpanel direct children (the canonical inversion)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<div class="tab-content" role="tablist">
  <div role="tabpanel" id="panel-1">Panel 1</div>
  <div role="tabpanel" id="panel-2">Panel 2</div>
</div>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/tablist-on-non-tab-container");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).toMatch(/no descendant carrying role="tab"/);
      expect(violations[0]?.message).toMatch(/direct child carries role="tabpanel"/);
      expect(violations[0]?.suggestion).toMatch(/Move role="tablist"/);
    });

    it("contains plain children with no role=tab anywhere", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<ul role="tablist">
  <li><a href="#one">One</a></li>
  <li><a href="#two">Two</a></li>
</ul>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/Either add role="tab"/);
    });

    it("contains a tabpanel deep in the subtree but no role=tab anywhere", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<section role="tablist">
  <div class="wrapper">
    <div class="inner">
      <div role="tabpanel">Some content</div>
    </div>
  </div>
</section>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/A descendant carries role="tabpanel"/);
    });

    it("appears multiple times (one violation per offending tablist)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<div role="tablist"><span>One</span></div>
<div role="tablist"><div role="tabpanel">Panel</div></div>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(2);
    });
  });

  describe("does not fire on HTML when", () => {
    it("the tablist contains a role=tab child", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<div role="tablist">
  <button role="tab" aria-selected="true" aria-controls="panel-1">Tab 1</button>
  <button role="tab" aria-selected="false" aria-controls="panel-2">Tab 2</button>
</div>
<div role="tabpanel" id="panel-1">Panel 1</div>
<div role="tabpanel" id="panel-2">Panel 2</div>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the tablist wraps tabs through a presentational li (canonical APG pattern)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<ul role="tablist">
  <li role="presentation"><button role="tab" aria-selected="true">One</button></li>
  <li role="presentation"><button role="tab" aria-selected="false">Two</button></li>
</ul>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the role is something other than tablist", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<div role="navigation"><div role="tabpanel">Not a tabs widget</div></div>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('fires on JSX when role="tablist"', () => {
    it("contains only tabpanel direct children", () => {
      const violations = runRule(
        rule,
        `export default function Tabs() {
  return (
    <div className="tab-content" role="tablist">
      <div role="tabpanel" id="panel-1">Panel 1</div>
      <div role="tabpanel" id="panel-2">Panel 2</div>
    </div>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/JSX modules are file-scoped/);
      expect(violations[0]?.couldBeWrongBecause).toEqual([
        "tablist-tab-may-live-in-sibling-template-id-resolution-is-file-scoped",
      ]);
    });

    it("contains a deeply nested tabpanel but no role=tab", () => {
      const violations = runRule(
        rule,
        `export default function Tabs() {
  return (
    <section role="tablist">
      <div>
        <div>
          <div role="tabpanel">Body</div>
        </div>
      </div>
    </section>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("does not fire on JSX when", () => {
    it("a role=tab descendant exists", () => {
      const violations = runRule(
        rule,
        `export default function Tabs() {
  return (
    <div role="tablist">
      <button role="tab" aria-selected={true}>One</button>
      <button role="tab" aria-selected={false}>Two</button>
    </div>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a composed (Capitalized) descendant could supply role=tab", () => {
      // Suppress on opaque composed subtree — the wrapping component
      // might render role=tab itself; the cross-file token surfaces the
      // gap on the per-rule coverage line.
      const violations = runRule(
        rule,
        `export default function Tabs() {
  return (
    <div role="tablist">
      <TabButton />
      <TabButton />
    </div>
  );
}`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("treats a multi-token role list whose first token is tablist as tablist", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<div role="tablist menu"><span>Not a tab</span></div>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("treats role attribute as case-insensitive", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<div role="TabList"><span>Not a tab</span></div>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("fires on an empty tablist (no role=tab owned children)", () => {
      // The WAI-ARIA "Required Owned Elements" clause for tablist
      // requires at least one role=tab descendant; an empty container
      // declaring role="tablist" is still a structural break — AT
      // announces "tab list" and finds nothing to navigate.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
<div role="tablist"></div>
</body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });
});
