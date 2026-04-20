import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/nested-interactive.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/nested-interactive", () => {
  describe("HTML: fires when", () => {
    it("button is nested inside a[href]", () => {
      const violations = runRule(
        rule,
        `<a href="/card"><button type="button">Action</button></a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/nested-interactive");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).toContain("<button>");
      expect(violations[0]?.message).toContain("<a href>");
    });

    it("a[href] is nested inside another a[href]", () => {
      const violations = runRule(
        rule,
        `<a href="/outer"><span><a href="/inner">Inner</a></span></a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<a href>");
    });

    it("button is nested inside a button", () => {
      const violations = runRule(rule, `<button>Outer <button>Inner</button></button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("input is nested inside a[href]", () => {
      const violations = runRule(rule, `<a href="/x"><input type="text" /></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<input>");
    });

    it("select is nested inside a button", () => {
      const violations = runRule(
        rule,
        `<button>Pick <select><option>a</option></select></button>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<select>");
    });

    it("an element with role=button is nested inside an a[href]", () => {
      const violations = runRule(rule, `<a href="/x"><span role="button">Do it</span></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`role="button"`);
    });

    it("textarea is nested inside a[href]", () => {
      const violations = runRule(rule, `<a href="/x"><textarea></textarea></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("deeply nested: reports the inner/outer pair (not every ancestor)", () => {
      const violations = runRule(
        rule,
        `<a href="/x"><div><section><button>Go</button></section></div></a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<button>");
    });
  });

  describe("HTML: does not fire when", () => {
    it("a non-interactive element is inside an a[href]", () => {
      const violations = runRule(
        rule,
        `<a href="/x"><span>Text</span><svg aria-hidden="true"></svg></a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("input type=hidden is inside an a[href]", () => {
      const violations = runRule(rule, `<a href="/x">Label<input type="hidden" value="1" /></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("an <a> with no href (just an anchor target) contains a button", () => {
      const violations = runRule(rule, `<a name="top"><button type="button">Action</button></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("a <video> without controls contains a button", () => {
      const violations = runRule(
        rule,
        `<video src="/v.mp4"><button type="button">Play</button></video>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("two sibling buttons are side-by-side", () => {
      const violations = runRule(rule, `<div><button>One</button><button>Two</button></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("button is nested inside an a[href]", () => {
      const violations = runRule(
        rule,
        `const X = <a href="/x"><button type="button">Go</button></a>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<button>");
    });

    it("role=button span is nested inside an a[href]", () => {
      const violations = runRule(rule, `const X = <a href="/x"><span role="button">Go</span></a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`role="button"`);
    });

    it("role=Button (PascalCase) span is nested inside an a[href] — case-insensitive", () => {
      const violations = runRule(rule, `const X = <a href="/x"><span role="Button">Go</span></a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`role="button"`);
    });
  });

  describe("JSX: does not fire when", () => {
    it("a PascalCase component is between the outer a[href] and an inner button", () => {
      // PascalCase is opaque — we don't traverse through it, and we
      // don't flag a child of it as nested under an outer native
      // interactive element.
      const violations = runRule(
        rule,
        `const X = <a href="/x"><Card><button>Go</button></Card></a>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("an a[href] contains only a PascalCase child", () => {
      const violations = runRule(rule, `const X = <a href="/x"><Icon name="chev" /></a>;`);
      expect(violations).toHaveLength(0);
    });

    it("a plain span containing text is inside an a[href]", () => {
      const violations = runRule(rule, `const X = <a href="/x"><span>Settings</span></a>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("native <details>/<summary> nesting is allowed", () => {
    it("HTML: <summary> inside <details> does not flag (defined native toggle)", () => {
      const v = runRule(rule, `<details><summary>More info</summary><p>body</p></details>`, {
        filePath: "a.html",
      });
      expect(v).toHaveLength(0);
    });

    it('HTML: <summary role="button"> inside <details> does not flag', () => {
      const v = runRule(
        rule,
        `<details><summary role="button">More info</summary><p>body</p></details>`,
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("HTML: nested <details> inside <details> does not flag (valid flow content)", () => {
      const v = runRule(
        rule,
        `<details><summary>Outer</summary><details><summary>Inner</summary><p>body</p></details></details>`,
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("HTML: <details> inside an <a href> still flags (real nesting violation)", () => {
      const v = runRule(rule, `<a href="/x"><details><summary>x</summary></details></a>`, {
        filePath: "a.html",
      });
      expect(v.length).toBeGreaterThan(0);
    });

    it("JSX: <summary> inside <details> does not flag", () => {
      const v = runRule(
        rule,
        `const X = <details><summary role="button">More</summary><p>body</p></details>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("JSX: nested <details> inside <details> does not flag", () => {
      const v = runRule(
        rule,
        `const X = <details><summary>Outer</summary><details><summary>Inner</summary></details></details>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("HTML: <a href> inside <details> panel body (outside <summary>) does not flag", () => {
      const v = runRule(
        rule,
        `<details><summary>More</summary><ul><li><a href="/x">Link</a></li></ul></details>`,
        { filePath: "a.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("HTML: <a href> inside <summary> inside <details> DOES flag (summary is the activator)", () => {
      const v = runRule(
        rule,
        `<details><summary><a href="/x">Link</a></summary><p>body</p></details>`,
        { filePath: "a.html" },
      );
      expect(v.length).toBeGreaterThan(0);
    });

    it("JSX: <button> inside <details> panel body does not flag", () => {
      const v = runRule(
        rule,
        `const X = <details><summary>More</summary><button>Action</button></details>;`,
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("composite-widget role enrichment (ARIA 1.2)", () => {
    // Per the ARIA 1.2 composite-widget pattern, `tab` / `menuitem` /
    // `option` / `treeitem` / `gridcell` / `row` delegate focus to
    // interactive descendants via roving tabindex rather than taking
    // focus themselves. The finding still fires (surface-don't-suppress),
    // but the reason text is enriched so a consuming agent can dismiss-
    // or-verify in one read rather than flattening idiomatic markup.

    it("HTML: <a href> inside <div role=tab> fires with composite-widget note", () => {
      const v = runRule(rule, `<div role="tab"><a href="#panel">Section 1</a></div>`, {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain(`role="tab"`);
      expect(v[0]?.message).toContain("composite-widget");
      expect(v[0]?.message).toContain("roving tabindex");
      expect(v[0]?.suggestion).toContain("composite widget");
    });

    it("HTML: <button> inside <li role=menuitem> fires with composite-widget note", () => {
      const v = runRule(rule, `<li role="menuitem"><button type="button">Open</button></li>`, {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain(`role="menuitem"`);
      expect(v[0]?.message).toContain("composite-widget");
    });

    it("HTML: <a href> inside <button> fires WITHOUT composite-widget note (both native interactives)", () => {
      const v = runRule(rule, `<button>Go <a href="/x">link</a></button>`, {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).not.toContain("composite-widget");
      expect(v[0]?.suggestion).not.toContain("composite widget");
    });

    it("HTML: <a href> inside <div role=tablist> does NOT fire (tablist is the container, not delegating role)", () => {
      // `tablist` is the composite container, not in INTERACTIVE_ROLES —
      // so the rule never triggers in the first place. This guards
      // against regression where someone adds `tablist` to either set.
      const v = runRule(rule, `<div role="tablist"><a href="#p1">Tab 1</a></div>`, {
        filePath: "a.html",
      });
      expect(v).toHaveLength(0);
    });

    it("HTML: composite-widget framing fires for each delegating role that is also interactive-by-role", () => {
      // The rule's outer-interactive predicate (INTERACTIVE_ROLES) covers
      // tab/menuitem/option/treeitem today. `gridcell` and `row` are in
      // COMPOSITE_WIDGET_DELEGATING_ROLES per ARIA 1.2 but don't currently
      // trigger the rule as outer elements — the enrichment constant
      // lists them so widening INTERACTIVE_ROLES in the future picks up
      // the framing automatically.
      for (const role of ["tab", "menuitem", "option", "treeitem"]) {
        const v = runRule(rule, `<div role="${role}"><a href="/x">x</a></div>`, {
          filePath: "a.html",
        });
        expect(v).toHaveLength(1);
        expect(v[0]?.message).toContain("composite-widget");
      }
    });

    it("JSX: <button> inside <li role=menuitem> fires with composite-widget note", () => {
      const v = runRule(rule, `const X = <li role="menuitem"><button>Open</button></li>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain(`role="menuitem"`);
      expect(v[0]?.message).toContain("composite-widget");
    });

    it("JSX: <a href> inside <button> fires WITHOUT composite-widget note", () => {
      const v = runRule(rule, `const X = <button>Go <a href="/x">link</a></button>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).not.toContain("composite-widget");
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:4.1.2 and wcag21:4.1.2", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });

    it("is document-scoped and severity=error", () => {
      expect(rule.scope).toBe("document");
      expect(rule.severity).toBe("error");
    });
  });
});
