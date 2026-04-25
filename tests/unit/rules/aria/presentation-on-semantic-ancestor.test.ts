import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/presentation-on-semantic-ancestor.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/presentation-on-semantic-ancestor", () => {
  describe("HTML: fires when", () => {
    it('a <table role="presentation"> contains a <th> header', () => {
      const violations = runRule(
        rule,
        `<table role="presentation">
          <thead><tr><th scope="col">Quarter</th><th scope="col">Revenue</th></tr></thead>
          <tbody><tr><td>Q1</td><td>$1.2M</td></tr></tbody>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/presentation-on-semantic-ancestor");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toContain("<table");
      expect(violations[0]?.message).toContain("<th>");
      expect(violations[0]?.suggestion).toContain('role="presentation"');
    });

    it('a <table role="none"> contains a <caption>', () => {
      const violations = runRule(
        rule,
        `<table role="none">
          <caption>Quarterly results</caption>
          <tbody><tr><td>Q1</td><td>$1.2M</td></tr></tbody>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<caption>");
    });

    it('a <ul role="presentation"> contains <li> items', () => {
      const violations = runRule(
        rule,
        `<ul role="presentation">
          <li>First</li>
          <li>Second</li>
        </ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<li>");
      expect(violations[0]?.suggestion).toContain("unordered list");
    });

    it('a <ol role="none"> contains <li> items', () => {
      const violations = runRule(
        rule,
        `<ol role="none">
          <li>Step one</li>
          <li>Step two</li>
        </ol>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("ordered list");
    });

    it('a <dl role="presentation"> contains <dt> / <dd> pairs', () => {
      const violations = runRule(
        rule,
        `<dl role="presentation">
          <dt>HTML</dt><dd>HyperText Markup Language</dd>
          <dt>CSS</dt><dd>Cascading Style Sheets</dd>
        </dl>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("description list");
    });

    it('a <figure role="presentation"> contains a <figcaption>', () => {
      const violations = runRule(
        rule,
        `<figure role="presentation">
          <img src="chart.png" alt="">
          <figcaption>Revenue over time</figcaption>
        </figure>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<figcaption>");
    });

    it('a <form role="presentation"> contains a <legend>', () => {
      const violations = runRule(
        rule,
        `<form role="presentation">
          <fieldset>
            <legend>Account info</legend>
            <input type="text" name="username">
          </fieldset>
        </form>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<legend>");
      expect(violations[0]?.suggestion).toContain("form landmark");
    });

    it("matches role values case-insensitively (PRESENTATION)", () => {
      const violations = runRule(
        rule,
        `<ul role="PRESENTATION">
          <li>x</li>
        </ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it('flags the outer host when nested inner host carries the same trigger ("opaque" descent works in reverse too)', () => {
      // The outer <ul role="presentation"> contains <li>, so the outer fires.
      // The inner <ul> has its own <li> but no role, so the inner is clean.
      const violations = runRule(
        rule,
        `<ul role="presentation">
          <li>outer item
            <ul>
              <li>inner item</li>
            </ul>
          </li>
        </ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.location.line).toBe(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("the host has no role attribute (default semantics intact)", () => {
      const violations = runRule(
        rule,
        `<table>
          <thead><tr><th>A</th></tr></thead>
          <tbody><tr><td>1</td></tr></tbody>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('the host has a non-presentational role (e.g. role="grid")', () => {
      const violations = runRule(
        rule,
        `<table role="grid">
          <thead><tr><th>A</th></tr></thead>
          <tbody><tr><td>1</td></tr></tbody>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a <table role="presentation"> with no <th> / <caption> (genuine layout table)', () => {
      const violations = runRule(
        rule,
        `<table role="presentation">
          <tr><td>Layout cell A</td><td>Layout cell B</td></tr>
          <tr><td>Layout cell C</td><td>Layout cell D</td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a <ul role="presentation"> with no <li> children (e.g. only flow content)', () => {
      const violations = runRule(
        rule,
        `<ul role="presentation">
          <p>Not a list item</p>
        </ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('role="" (empty) is treated as absent, no fire', () => {
      const violations = runRule(
        rule,
        `<ul role="">
          <li>x</li>
        </ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a non-host element with role="presentation" is out of scope (e.g. <div>)', () => {
      const violations = runRule(
        rule,
        `<div role="presentation">
          <p>Decorative wrapper</p>
        </div>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it('a JSX <table role="presentation"> contains <th>', () => {
      const violations = runRule(
        rule,
        `export function Quarterly() {
  return (
    <table role="presentation">
      <thead><tr><th scope="col">Quarter</th></tr></thead>
      <tbody><tr><td>Q1</td></tr></tbody>
    </table>
  );
}`,
        { filePath: "Quarterly.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("aria/presentation-on-semantic-ancestor");
      expect(violations[0]?.message).toContain("<th>");
    });

    it('a JSX <ul role="none"> contains <li>', () => {
      const violations = runRule(
        rule,
        `export function Items() {
  return (
    <ul role="none">
      <li>First</li>
      <li>Second</li>
    </ul>
  );
}`,
        { filePath: "Items.tsx" },
      );
      expect(violations).toHaveLength(1);
    });

    it('a JSX <figure role="presentation"> contains <figcaption>', () => {
      const violations = runRule(
        rule,
        `export function Chart() {
  return (
    <figure role="presentation">
      <img src="chart.png" alt="" />
      <figcaption>Revenue</figcaption>
    </figure>
  );
}`,
        { filePath: "Chart.tsx" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("the role is an expression (runtime-determined; rule skips conservatively)", () => {
      const violations = runRule(
        rule,
        `export function Maybe({ asLayout }: { asLayout: boolean }) {
  return (
    <ul role={asLayout ? "presentation" : undefined}>
      <li>First</li>
    </ul>
  );
}`,
        { filePath: "Maybe.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it('a JSX <table role="presentation"> with no <th> / <caption> (genuine layout)', () => {
      const violations = runRule(
        rule,
        `export function EmailHeader() {
  return (
    <table role="presentation">
      <tr><td><img src="logo.png" alt="Acme" /></td><td>Welcome</td></tr>
    </table>
  );
}`,
        { filePath: "EmailHeader.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("descent stops at nested same-host (inner <ul role='presentation'> with <li> fires; outer <ul> has no role so no fire)", () => {
      const violations = runRule(
        rule,
        `<ul>
          <li>outer
            <ul role="presentation">
              <li>inner item</li>
            </ul>
          </li>
        </ul>`,
        { filePath: "index.html" },
      );
      // Only the inner <ul role="presentation"> with <li> fires.
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<li>");
    });

    it('a <table role="presentation"> where the only marker is a nested data <table> with <th> does not fire (descent stops at nested table)', () => {
      const violations = runRule(
        rule,
        `<table role="presentation">
          <tr><td>
            <table>
              <thead><tr><th>Inner</th></tr></thead>
              <tbody><tr><td>data</td></tr></tbody>
            </table>
          </td></tr>
        </table>`,
        { filePath: "index.html" },
      );
      // Outer is layout (no <th>/<caption> directly under it; descent stops at
      // the inner <table>). The inner table has no role and no fire.
      expect(violations).toHaveLength(0);
    });

    it('the role attribute may use a space-separated fallback chain — first token decides ("presentation foo")', () => {
      const violations = runRule(
        rule,
        `<ul role="presentation foo">
          <li>x</li>
        </ul>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });
});
