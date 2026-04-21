import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/disabled-link-surrogate.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/disabled-link-surrogate", () => {
  describe("HTML: fires a violation when", () => {
    it("a <span class='previous'> sits next to <a class='page'> links with no aria-disabled", () => {
      const source = `<ul class="pagination">
  <li><span class="previous">&lsaquo; Previous</span></li>
  <li><a class="page" href="/p/2">2</a></li>
  <li><a class="page" href="/p/3">3</a></li>
</ul>`;
      const violations = runRule(rule, source, { filePath: "pager.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/disabled-link-surrogate");
      expect(violations[0]?.criteria).toContain("wcag22:4.1.2");
      expect(violations[0]?.suggestion).toMatch(/aria-disabled="true"/);
    });

    it("a <span class='disabled'> sits in a button group with sibling anchors", () => {
      const source = `<div class="btn-group">
  <span class="disabled">Edit</span>
  <a href="/save">Save</a>
  <a href="/cancel">Cancel</a>
</div>`;
      const violations = runRule(rule, source, { filePath: "toolbar.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/disabled/);
    });

    it("a <div class='next'> in pagination with sibling <a> has no aria-disabled", () => {
      const source = `<nav class="pager">
  <a class="page" href="/p/1">1</a>
  <a class="page current" href="/p/2">2</a>
  <div class="next">Next &rsaquo;</div>
</nav>`;
      const violations = runRule(rule, source, { filePath: "pager.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/role="link"/);
    });
  });

  describe("HTML: does not fire when", () => {
    it("the surrogate already carries aria-disabled='true'", () => {
      const source = `<ul class="pagination">
  <li><span class="previous" aria-disabled="true">&lsaquo; Previous</span></li>
  <li><a class="page" href="/p/2">2</a></li>
</ul>`;
      const violations = runRule(rule, source, { filePath: "pager.html" });
      expect(violations).toHaveLength(0);
    });

    it("the surrogate has role='link' and aria-disabled='true'", () => {
      const source = `<ul class="pagination">
  <li><span class="previous" role="link" aria-disabled="true">&lsaquo; Previous</span></li>
  <li><a class="page" href="/p/2">2</a></li>
</ul>`;
      const violations = runRule(rule, source, { filePath: "pager.html" });
      expect(violations).toHaveLength(0);
    });

    it("the visible text includes a disabled-state word", () => {
      const source = `<ul class="pagination">
  <li><span class="previous">Previous (unavailable)</span></li>
  <li><a class="page" href="/p/2">2</a></li>
</ul>`;
      const violations = runRule(rule, source, { filePath: "pager.html" });
      expect(violations).toHaveLength(0);
    });

    it("a <span class='disabled'>Unavailable</span> stands alone with no sibling anchor (not a surrogate)", () => {
      const source = `<p>Status: <span class="disabled">Unavailable</span></p>`;
      const violations = runRule(rule, source, { filePath: "status.html" });
      expect(violations).toHaveLength(0);
    });

    it("the element is an actual <a class='disabled'> anchor, not a surrogate span", () => {
      const source = `<ul class="pagination">
  <li><a class="disabled" href="#">&lsaquo; Previous</a></li>
  <li><a class="page" href="/p/2">2</a></li>
</ul>`;
      const violations = runRule(rule, source, { filePath: "pager.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("a <span className='previous'> sits next to <a> sibling links", () => {
      const source = `export function Pager() {
  return (
    <ul className="pagination">
      <li><span className="previous">‹ Previous</span></li>
      <li><a className="page" href="/p/2">2</a></li>
      <li><a className="page" href="/p/3">3</a></li>
    </ul>
  );
}`;
      const violations = runRule(rule, source, { filePath: "Pager.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/aria-disabled="true"/);
    });
  });

  describe("JSX: does not fire when", () => {
    it("the span carries aria-disabled", () => {
      const source = `export function Pager() {
  return (
    <ul className="pagination">
      <li><span className="previous" aria-disabled="true">‹ Previous</span></li>
      <li><a className="page" href="/p/2">2</a></li>
    </ul>
  );
}`;
      const violations = runRule(rule, source, { filePath: "Pager.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("the tag is a PascalCase component (opaque, may render anything)", () => {
      const source = `export function Pager() {
  return (
    <ul className="pagination">
      <li><PrevLink className="previous">‹ Previous</PrevLink></li>
      <li><a className="page" href="/p/2">2</a></li>
    </ul>
  );
}`;
      const violations = runRule(rule, source, { filePath: "Pager.tsx" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("whole-word matching — 'noteworthy' does not match 'note' nor 'previous' pattern", () => {
      const source = `<div class="btn-group">
  <span class="noteworthy">Highlighted</span>
  <a href="/save">Save</a>
</div>`;
      const violations = runRule(rule, source, { filePath: "form.html" });
      expect(violations).toHaveLength(0);
    });

    it("directional token without any sibling anchor does not fire (not a surrogate)", () => {
      // <span class="next"> in a card is decorative, not a disabled link.
      const source = `<article class="card">
  <h2>Article title</h2>
  <span class="next">See the next section</span>
</article>`;
      const violations = runRule(rule, source, { filePath: "article.html" });
      expect(violations).toHaveLength(0);
    });

    it("case-insensitive token matching — class='Is-Disabled' still trips", () => {
      const source = `<div class="toolbar">
  <span class="Is-Disabled">Submit</span>
  <a href="/draft">Draft</a>
</div>`;
      const violations = runRule(rule, source, { filePath: "toolbar.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/Is-Disabled/);
    });

    it("sibling anchor wrapped one level deep (pagination <li><a>) still counts", () => {
      const source = `<ul class="pagination">
  <li><span class="first">‹‹</span></li>
  <li><span class="previous">‹</span></li>
  <li><a href="/p/2">2</a></li>
</ul>`;
      const violations = runRule(rule, source, { filePath: "pager.html" });
      // Both spans fire — they share a parent (<ul>) and the parent has sibling <li> wrappers containing <a>.
      // Each span's sibling-list is {<li><span.previous>, <li><a>, <li><span.first>}, so each finds an anchor.
      expect(violations.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:4.1.2 in satisfies", () => {
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });

    it("has a normativeQuote citing the Name, Role, Value SC", () => {
      expect(rule.docs.normativeQuote).toMatch(/programmatically determined/);
      expect(rule.docs.references[0]).toMatch(/WCAG22/);
    });
  });
});
