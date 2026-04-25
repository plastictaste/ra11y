import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/tab-controls-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

const FULL_PAGE_PREFIX =
  '<!doctype html><html lang="en"><head><title>Tabs</title></head><body><h1>Tabs demo</h1>';
const FULL_PAGE_SUFFIX = "</body></html>";

function fullPage(body: string): string {
  return `${FULL_PAGE_PREFIX}${body}${FULL_PAGE_SUFFIX}`;
}

describe("rule aria/tab-controls-missing", () => {
  describe("HTML branch A: missing aria-controls on tab", () => {
    it("fires error on a role=tab with no aria-controls", () => {
      const violations = runRule(
        rule,
        fullPage(`<div role="tablist">
  <button role="tab" aria-selected="true">Tab 1</button>
</div>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/tab-controls-missing");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).toContain("no aria-controls attribute");
      expect(violations[0]?.suggestion).toContain('aria-controls="<panel-id>"');
    });

    it('fires error on a role=tab with empty aria-controls=""', () => {
      const violations = runRule(
        rule,
        fullPage(`<button role="tab" aria-controls="">Tab</button>
<div role="tabpanel" id="p" aria-labelledby="t">Panel</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("names no panel id");
    });

    it("stays at error severity even when the file is a fragment (attribute is absent)", () => {
      // Fragment-classified files (no <html>/<body>/<head>) downgrade
      // branches B+C to info because the panel might live in a sibling
      // file, but branch A is "the attribute belongs on the tab in this
      // template regardless of where the panel renders" — stays at
      // error so the agent gets the strongest signal.
      const violations = runRule(rule, `<button role="tab" aria-selected="true">Tab</button>`, {
        filePath: "_includes/tablist.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("error");
    });
  });

  describe("HTML branch B: aria-controls points at nothing or wrong role", () => {
    it("fires error on a tab whose aria-controls token has no matching id", () => {
      const violations = runRule(
        rule,
        fullPage(`<button role="tab" aria-controls="missing-panel" id="tab-1">Tab 1</button>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('"missing-panel"');
      expect(violations[0]?.message).toContain("does not match any element's id");
      expect(violations[0]?.severity).toBe("error");
    });

    it("fires error when the target id resolves to a non-tabpanel role", () => {
      const violations = runRule(
        rule,
        fullPage(`<button role="tab" aria-controls="region-1" id="tab-1">Tab 1</button>
<div role="region" id="region-1" aria-labelledby="tab-1">Not a tabpanel</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('role="region"');
      expect(violations[0]?.message).toContain('not role="tabpanel"');
    });

    it("flags every dangling token in a multi-token aria-controls list", () => {
      const violations = runRule(
        rule,
        fullPage(`<button role="tab" aria-controls="panel-1 missing-one missing-two" id="tab-1">Tab</button>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('"missing-one"');
      expect(violations[0]?.message).toContain('"missing-two"');
    });

    it("downgrades to info + couldBeWrongBecause on fragment files", () => {
      const violations = runRule(
        rule,
        `<button role="tab" aria-controls="panel-in-sibling-template" id="tab-1">Tab</button>`,
        { filePath: "_includes/tablist.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("info");
      expect(violations[0]?.couldBeWrongBecause).toBeDefined();
      expect(violations[0]?.couldBeWrongBecause?.[0]).toContain("sibling-template");
      expect(violations[0]?.message).toContain("fragment");
    });
  });

  describe("HTML branch C: tabpanel missing aria-labelledby and not referenced by any tab", () => {
    it("fires error on a tabpanel with neither aria-labelledby nor an inbound aria-controls", () => {
      const violations = runRule(
        rule,
        fullPage(`<button role="tab" aria-controls="other-panel" id="tab-1">Tab</button>
<div role="tabpanel" id="other-panel" aria-labelledby="tab-1">OK</div>
<div role="tabpanel" id="orphan-panel">Orphan with no name and no inbound tab</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('id="orphan-panel"');
      expect(violations[0]?.message).toContain("no aria-labelledby");
      expect(violations[0]?.severity).toBe("error");
    });

    it("does NOT fire when a tab in the same file references the panel via aria-controls", () => {
      // Reciprocal-pair contract: if the tab→panel link resolves, the
      // panel's missing aria-labelledby is suppressed (the relationship
      // resolves in one direction).
      const violations = runRule(
        rule,
        fullPage(`<button role="tab" aria-controls="panel-1" id="tab-1">Tab</button>
<div role="tabpanel" id="panel-1">Panel — named only by the tab's aria-controls</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("downgrades to info + couldBeWrongBecause on fragment files", () => {
      const violations = runRule(
        rule,
        `<div role="tabpanel" id="panel-1">Panel rendered standalone in a fragment include</div>`,
        { filePath: "_partials/panel.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("info");
      expect(violations[0]?.couldBeWrongBecause).toBeDefined();
    });
  });

  describe("HTML reciprocal-pair good fixtures (no violations)", () => {
    it("passes a fully-wired tablist + tabpanels", () => {
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

    it("ignores elements without role=tab / role=tabpanel even when ids look tab-like", () => {
      const violations = runRule(
        rule,
        fullPage(`<button id="tab-1">Tab-shaped id but no role</button>
<div id="panel-1">Panel-shaped id but no role</div>`),
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("treats space-separated role lists where 'tab' is the first token as role=tab", () => {
      const violations = runRule(
        rule,
        fullPage(`<button role="tab presentation">Tab</button>
<div role="tabpanel" id="p" aria-labelledby="t">Panel</div>`),
        { filePath: "index.html" },
      );
      // First role token is `tab`; missing aria-controls should still fire.
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("no aria-controls attribute");
    });
  });

  describe("JSX (file-scoped, fragment-style enrichment)", () => {
    it("fires on a JSX role='tab' with no aria-controls (branch A)", () => {
      const violations = runRule(
        rule,
        `export function Tabs() {
  return (
    <div role="tablist">
      <button role="tab" aria-selected={true}>Tab 1</button>
      <div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel</div>
    </div>
  );
}`,
        { filePath: "Tabs.tsx" },
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const branchA = violations.find((v) => v.message.includes("no aria-controls attribute"));
      expect(branchA).toBeDefined();
      // Branch A stays at error even on JSX (the attribute belongs here).
      expect(branchA?.severity).toBe("error");
    });

    it("downgrades branch B to info on JSX (panel might live in a sibling component)", () => {
      const violations = runRule(
        rule,
        `export function Tab() {
  return <button role="tab" aria-controls="panel-rendered-elsewhere" id="tab-1">Tab</button>;
}`,
        { filePath: "Tab.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("info");
      expect(violations[0]?.couldBeWrongBecause).toBeDefined();
    });

    it("does NOT fire on a fully-wired JSX tablist + tabpanel pair in the same file", () => {
      const violations = runRule(
        rule,
        `export function Tabs() {
  return (
    <>
      <button role="tab" aria-controls="panel-1" id="tab-1">Tab</button>
      <div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel</div>
    </>
  );
}`,
        { filePath: "Tabs.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("emits an info note when aria-controls is a JSX expression (not a string literal)", () => {
      const violations = runRule(
        rule,
        `export function Tab({ panelId }: { panelId: string }) {
  return <button role="tab" aria-controls={panelId} id="tab-1">Tab</button>;
}`,
        { filePath: "Tab.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("info");
      expect(violations[0]?.message).toContain("JSX expression");
    });

    it("ignores capitalized JSX components (cannot statically know the rendered role)", () => {
      const violations = runRule(
        rule,
        `export function Wrap() {
  return <Tab role="tab" aria-selected={true}>Custom component</Tab>;
}`,
        { filePath: "Wrap.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("does not double-emit when a tab is both missing aria-controls AND in a fragment", () => {
      const violations = runRule(rule, `<button role="tab" aria-selected="true">Tab</button>`, {
        filePath: "_includes/tablist.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("treats role attribute case-insensitively", () => {
      const violations = runRule(
        rule,
        fullPage(`<button role="TAB" aria-selected="true">Tab</button>
<div role="TABPANEL" id="p" aria-labelledby="t">Panel</div>`),
        { filePath: "index.html" },
      );
      // Both tab (missing aria-controls) and tabpanel (no inbound link)
      // should fire — case-insensitive match for the role token.
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const tabFinding = violations.find((v) => v.message.includes("no aria-controls"));
      expect(tabFinding).toBeDefined();
    });
  });
});
