import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/link-no-href.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/link-no-href", () => {
  describe("HTML: fires when", () => {
    it("a has onclick but no href", () => {
      const violations = runRule(rule, `<a onclick="doThing()">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-no-href");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:2.1.1");
    });
  });

  describe("HTML: does not fire when", () => {
    it("a has a real href", () => {
      const violations = runRule(rule, `<a href="/dashboard" onclick="doThing()">Go</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("a has only href (no handler)", () => {
      const violations = runRule(rule, `<a href="/dashboard">Go</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("a has neither href nor onclick (named anchor placeholder)", () => {
      // Bare <a> without href is valid HTML (used to be a named anchor).
      // Without a click handler there's no keyboard trap — the element
      // is just inert text. We only flag the a+onclick combo.
      const violations = runRule(rule, `<a name="section">Section heading</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("href is a fragment id (#section-name) — legitimate in-page navigation", () => {
      // Fragment navigation actually navigates — the browser scrolls to
      // and focuses the matching id. Don't flag it.
      const violations = runRule(rule, `<a href="#top" onclick="doThing()">Top</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("href is a plain URL (no handler)", () => {
      const violations = runRule(rule, `<a href="/docs#anchor">Docs</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: fires on placeholder href", () => {
    // From a screen-reader and keyboard perspective, href="" and
    // href="#" are indistinguishable from a missing href — both are
    // non-navigating placeholders. Bootstrap's docs use href="#" in
    // dropdown/modal/carousel examples; treat those like missing href.

    it("href is empty string with onclick", () => {
      const violations = runRule(rule, `<a href="" onclick="doThing()">Go</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-no-href");
      expect(violations[0]?.severity).toBe("error");
    });

    it("href is '#' with onclick (Bootstrap dropdown pattern)", () => {
      const violations = runRule(rule, `<a href="#" onclick="toggle()">Menu</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-no-href");
    });

    it("href is '  #  ' (whitespace trimmed before comparison)", () => {
      const violations = runRule(rule, `<a href="  #  " onclick="doThing()">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("href is all-whitespace (treated as empty placeholder)", () => {
      const violations = runRule(rule, `<a href="   " onclick="doThing()">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: fires when", () => {
    it("a has onClick but no href", () => {
      const violations = runRule(rule, `const X = <a onClick={handle}>Click</a>;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("a has href and onClick", () => {
      const violations = runRule(rule, `const X = <a href="/x" onClick={handle}>Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("a has only href", () => {
      const violations = runRule(rule, `const X = <a href="/x">Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("custom component (PascalCase Link) is ignored", () => {
      // This rule only applies to lowercase <a>. React component links
      // like Next.js <Link> are a separate question.
      const violations = runRule(rule, `const X = <Link onClick={handle}>Go</Link>;`);
      expect(violations).toHaveLength(0);
    });

    it("a has fragment href (#anchor) and onClick", () => {
      // In-page fragment navigation — real navigation, stays silent.
      const violations = runRule(rule, `const X = <a href="#top" onClick={handle}>Top</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("a has expression-form href={...} (opaque, assume real)", () => {
      // An expression-form href may resolve to anything at runtime;
      // static analysis can't prove it's a placeholder. Let the agent
      // investigate if the expression is suspicious.
      const violations = runRule(rule, `const X = <a href={url} onClick={handle}>Go</a>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires on placeholder href", () => {
    it("href is empty string with onClick", () => {
      const violations = runRule(rule, `const X = <a href="" onClick={handle}>Go</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-no-href");
    });

    it("href='#' with onClick (dropdown-style placeholder)", () => {
      const violations = runRule(rule, `const X = <a href="#" onClick={handle}>Menu</a>;`);
      expect(violations).toHaveLength(1);
    });

    it("href=' # ' (whitespace trimmed before comparison)", () => {
      const violations = runRule(rule, `const X = <a href=" # " onClick={handle}>X</a>;`);
      expect(violations).toHaveLength(1);
    });

    it("navigation-intent suggestion still routes through onClick body", () => {
      // href="#" doesn't affect the intent probe — that probe reads
      // the onClick expression, not the href. Placeholder href +
      // navigating handler still lands on the navigation suggestion.
      const violations = runRule(
        rule,
        `const X = <a href="#" onClick={() => navigate("/x")}>Go</a>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
    });
  });

  describe("context-aware fix suggestion", () => {
    it("navigation-intent: onClick calls navigate(...) → suggests real href", () => {
      const violations = runRule(
        rule,
        `const X = <a onClick={() => navigate("/dashboard")}>Go</a>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
      expect(violations[0]?.suggestion).toContain('href="..."');
      expect(violations[0]?.suggestion).toContain("preventDefault");
    });

    it("navigation-intent: onClick calls history.push(...) → suggests real href", () => {
      const violations = runRule(rule, `const X = <a onClick={() => history.push("/x")}>Go</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
    });

    it("navigation-intent: onClick calls router.replace(...) → suggests real href", () => {
      const violations = runRule(rule, `const X = <a onClick={() => router.replace("/y")}>Go</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
    });

    it("mutation-intent: React setter pattern setOpen(...) → suggests <button>", () => {
      const violations = runRule(rule, `const X = <a onClick={() => setOpen(true)}>Open</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("mutation");
      expect(violations[0]?.suggestion).toContain(`<button type="button"`);
    });

    it("mutation-intent: onClick calls toggle(...) → suggests <button>", () => {
      const violations = runRule(rule, `const X = <a onClick={() => toggleMenu()}>Menu</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("mutation");
      expect(violations[0]?.suggestion).toContain(`<button type="button"`);
    });

    it("unknown-intent: empty arrow body → generic either-or suggestion", () => {
      const violations = runRule(rule, `const X = <a onClick={() => {}}>Click</a>;`);
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain("decide the intent");
      expect(sugg).toContain("navigates");
      expect(sugg).toContain("action");
    });

    it("unknown-intent: bare identifier handler → generic either-or suggestion", () => {
      // The probe is text-level; a bare `handle` reference doesn't
      // name any navigation or mutation keyword, so unknown is correct.
      const violations = runRule(rule, `const X = <a onClick={handle}>Click</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("decide the intent");
    });

    it("HTML: onclick with window.location → navigation-intent", () => {
      const violations = runRule(rule, `<a onclick="window.location='/go'">Go</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
    });
  });

  describe("HTML: fires on absent href + interactive class signal (no inline handler)", () => {
    // Real-world pattern: carousel / dropdown / tab controls where the
    // click handler is wired at runtime by a sibling <script>. The
    // markup carries no `onclick` attribute, but the class is a strong
    // signal the anchor is a control rather than a fragment target.

    it("a.prev with no href, no onclick (carousel control)", () => {
      const violations = runRule(
        rule,
        `<a class="prev"><i class="fa fa-chevron-circle-left"></i></a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-no-href");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).toContain("prev");
      expect(violations[0]?.suggestion).toContain("prev");
    });

    it("a.next with no href (carousel pager)", () => {
      const violations = runRule(rule, `<a class="next"><span>Next</span></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("next");
    });

    it("a.btn with no href (Bootstrap button-as-anchor)", () => {
      const violations = runRule(rule, `<a class="btn btn-primary">Submit</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("btn");
    });

    it("a.dropdown-toggle with no href (Bootstrap dropdown trigger)", () => {
      const violations = runRule(rule, `<a class="dropdown-toggle">Menu</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("dropdown-toggle");
    });

    it("a.nav-link with no href (Bootstrap nav anchor)", () => {
      const violations = runRule(rule, `<a class="nav-link">Home</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
    });

    it("a.tab with no href (tab-panel switcher)", () => {
      const violations = runRule(rule, `<a class="tab">Details</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
    });

    it("a.slide with no href (carousel slide control)", () => {
      const violations = runRule(rule, `<a class="slide">3</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
    });

    it("a.accordion-toggle with no href", () => {
      const violations = runRule(rule, `<a class="accordion-toggle">Section 1</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("class signal with placeholder href='#' still fires", () => {
      const violations = runRule(rule, `<a class="prev" href="#"><i class="fa-arrow"></i></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("prev");
    });

    it("class signal with real href stays silent (link is keyboard-operable)", () => {
      const violations = runRule(rule, `<a class="btn btn-primary" href="/checkout">Pay</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("token match is whole-word: a.user-tab-item does NOT match `tab`", () => {
      const violations = runRule(rule, `<a class="user-tab-item">User</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("token match is whole-word: a.previous-month does NOT match `prev`", () => {
      const violations = runRule(rule, `<a class="previous-month">January</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: stays silent on truly decorative anchors (no signals)", () => {
    it("a#section1 (fragment target, no class, no handler)", () => {
      // Legitimate in-page anchor target — not a control. Stays silent.
      const violations = runRule(rule, `<a id="section1"></a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("a[name=legacy] (legacy named anchor, no class, no handler)", () => {
      const violations = runRule(rule, `<a name="legacy">Legacy</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("a with non-interactive class (e.g. text-muted) stays silent", () => {
      const violations = runRule(rule, `<a class="text-muted">read-only badge</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires on absent href + interactive className signal", () => {
    it("a.prev with no href, no onClick (string-literal className)", () => {
      const violations = runRule(rule, `const X = <a className="prev"><Icon /></a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("prev");
    });

    it("a.btn with no href (string-literal className)", () => {
      const violations = runRule(rule, `const X = <a className="btn btn-link">Action</a>;`);
      expect(violations).toHaveLength(1);
    });

    it("expression-form className={...} is opaque — stays silent without a handler", () => {
      // We don't try to resolve expression-form className at static-
      // analysis time; the agent reading the file can. The handler-only
      // check still covers the case where opaque className co-exists
      // with onClick.
      const violations = runRule(rule, `const X = <a className={cn("prev")}>Prev</a>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("class-signal context-aware suggestion", () => {
    it("names the matched token in the suggestion (carousel prev)", () => {
      const violations = runRule(rule, `<a class="prev"><i class="ico"></i></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain("prev");
      expect(sugg).toContain(`<button type="button" class="prev">`);
      expect(sugg).toContain("runtime");
    });
  });

  describe("structural-ancestor constraint: suggestion does NOT recommend a bare <a> → <button> swap", () => {
    // When the flagged <a> sits inside a parent whose role contract
    // restricts descendant shape (menu / menubar / listbox / tablist /
    // tree, or `<select>` / `<datalist>` / `<table>` etc.), the bare
    // swap loses the parent's keyboard model OR produces invalid markup.
    // The suggestion must (a) name the constraint and (b) propose a
    // within-constraint alternative.

    it('HTML: <a onclick> inside <ul role="menu"> — names the menu constraint and avoids unconstrained swap', () => {
      const violations = runRule(
        rule,
        `<ul role="menu"><li><a onclick="doThing()">Action</a></li></ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`role="menu"`);
      expect(sugg).toContain("menuitem");
      // Must NOT contain the bare swap recommendation that doesn't
      // mention the menu constraint — the prior bug recommended
      // changing `<a>` to `<button>` with no acknowledgment of the
      // ancestor's keyboard model.
      expect(sugg).toContain("HOWEVER");
    });

    it('HTML: <a onclick> inside <ul class="dropdown-menu"> — names the Bootstrap dropdown constraint', () => {
      const violations = runRule(
        rule,
        `<ul class="dropdown-menu"><li><a onclick="doThing()">Action</a></li></ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain("dropdown-menu");
      expect(sugg).toContain("Bootstrap");
      expect(sugg.toLowerCase()).toContain("keyboard model");
    });

    it('HTML: <a onclick> inside <ul role="menubar"> — names the menubar constraint', () => {
      const violations = runRule(
        rule,
        `<ul role="menubar"><li><a onclick="doThing()">Action</a></li></ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`role="menubar"`);
    });

    it('HTML: <a onclick> inside <ul role="tablist"> — names the tabs constraint', () => {
      const violations = runRule(
        rule,
        `<ul role="tablist"><li><a onclick="select()">Tab 1</a></li></ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`role="tablist"`);
      expect(sugg).toContain(`role="tab"`);
    });

    it('HTML: <a onclick> inside <ul role="listbox"> — names the listbox constraint', () => {
      const violations = runRule(
        rule,
        `<ul role="listbox"><li><a onclick="pick()">Option</a></li></ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`role="listbox"`);
      expect(sugg).toContain(`role="option"`);
    });

    it('HTML: <a onclick> inside <ul role="tree"> — names the tree constraint', () => {
      const violations = runRule(
        rule,
        `<ul role="tree"><li><a onclick="expand()">Node</a></li></ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`role="tree"`);
      expect(sugg).toContain("treeitem");
    });

    it("HTML: <a onclick> inside <table>/<tr>/<td> ladder — names the table content-model constraint", () => {
      const violations = runRule(
        rule,
        `<table><tbody><tr><td><a onclick="edit()">Edit</a></td></tr></tbody></table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      // Closest ancestor classified is the <td> not in the constraint
      // list — but <tr>/<tbody>/<table> ARE; we walk through <td> until
      // a constraint hits.
      expect(sugg).toContain("table");
      expect(sugg).toContain("table-structural");
    });

    it('JSX: <a onClick> inside <ul role="menu"> — names the menu constraint', () => {
      const violations = runRule(
        rule,
        `const X = <ul role="menu"><li><a onClick={doThing}>Action</a></li></ul>;`,
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain(`role="menu"`);
      expect(sugg).toContain("menuitem");
    });

    it('JSX: <a onClick> inside <ul className="dropdown-menu"> — names the Bootstrap dropdown constraint', () => {
      const violations = runRule(
        rule,
        `const X = <ul className="dropdown-menu"><li><a onClick={doThing}>Action</a></li></ul>;`,
      );
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain("dropdown-menu");
      expect(sugg).toContain("Bootstrap");
    });

    it('HTML: <a> with class="dropdown-toggle" outside any <ul role="menu"> — generic suggestion (no false-positive constraint match)', () => {
      // The dropdown-toggle is a TRIGGER (sibling to the menu, not
      // inside it). The constraint must not falsely apply.
      const violations = runRule(rule, `<a class="dropdown-toggle">Account</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      // Generic class-trigger suggestion should fire; no constraint hit.
      expect(sugg).not.toContain("HOWEVER");
    });

    it("HTML: bare <a onclick> with no constrained ancestor — keeps the original suggestion shape", () => {
      const violations = runRule(rule, `<div><a onclick="doThing()">Click</a></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).not.toContain("HOWEVER");
      // Original shape: "decide the intent" / "<button type=\"button\">".
      expect(sugg).toContain("decide the intent");
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:2.1.1, wcag21:2.1.1, wcag22:4.1.2, wcag21:4.1.2", () => {
      expect(rule.satisfies).toContain("wcag22:2.1.1");
      expect(rule.satisfies).toContain("wcag21:2.1.1");
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });
  });
});
