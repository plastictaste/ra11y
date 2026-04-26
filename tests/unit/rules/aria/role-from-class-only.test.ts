import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/aria/role-from-class-only.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule aria/role-from-class-only", () => {
  describe("HTML: fires when", () => {
    it("a div classed as 'note warning' has no role and no severity prefix", () => {
      const v = runRule(
        rule,
        `<div class="note warning">Don't forget to run bundle install.</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("aria/role-from-class-only");
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain('"note"');
      expect(v[0]?.message).toContain('"warning"');
      expect(v[0]?.suggestion).toContain('role="alert"');
      expect(v[0]?.suggestion).toContain("Warning:");
    });

    it("a div classed 'alert' has text that does not start with a severity word", () => {
      const v = runRule(rule, `<div class="alert">Your session will expire in 5 minutes.</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain('role="alert"');
    });

    it("a paragraph classed 'tip' carries only the body text", () => {
      const v = runRule(rule, `<p class="tip">Press Ctrl+K to open the command palette.</p>`, {
        filePath: "docs.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain('role="note"');
      expect(v[0]?.suggestion).toContain("Tip:");
    });

    it("a block uses uppercase class names (case-insensitive match)", () => {
      const v = runRule(rule, `<div class="NOTE CAUTION">Review the migration guide.</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it('role is set but is not a severity role (e.g. role="region")', () => {
      const v = runRule(
        rule,
        `<div class="warning" role="region">Unsaved changes will be lost.</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('role="region"');
    });
  });

  describe("HTML: does NOT fire when", () => {
    it('the element has role="alert"', () => {
      const v = runRule(
        rule,
        `<div class="note warning" role="alert">Don't forget to run bundle install.</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it('the element has role="note"', () => {
      const v = runRule(
        rule,
        `<div class="note" role="note">Friendly aside about the next step.</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it('the element has role="status"', () => {
      const v = runRule(rule, `<div class="info" role="status">Saved a minute ago.</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("the visible text begins with a severity prefix ('Warning:')", () => {
      const v = runRule(rule, `<div class="warning">Warning: this action cannot be undone.</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("the severity word is emphasised in a child element", () => {
      const v = runRule(
        rule,
        `<div class="note warning"><strong>Warning</strong> — restart required.</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("the class list contains no admonition token (e.g. 'card primary')", () => {
      const v = runRule(rule, `<div class="card primary">Just a card.</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("the admonition class name is a substring but not whole-word (e.g. 'noteworthy')", () => {
      const v = runRule(rule, `<div class="noteworthy-block">Nothing to see.</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it('the element has a suppressing role such as role="button"', () => {
      const v = runRule(rule, `<div class="alert" role="button">Dismiss</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("HTML: heading-as-label refinement", () => {
    it("soft-fires at info severity when the first child heading text IS a severity word ('Tip')", () => {
      // <div class="note info"><h5>Tip</h5><p>…</p></div> — AT announces
      // "heading level 5: Tip", so the severity label is announced via
      // the heading. Surface as a soft candidate rather than a warning
      // so the agent verifies the visual/AT mapping rather than
      // reflexively adding role.
      const v = runRule(
        rule,
        `<div class="note info">
  <h5>Tip</h5>
  <p>Press Ctrl+K to open the command palette.</p>
</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain('first child heading reads "tip"');
      expect(v[0]?.suggestion).toContain("severity-word dictionary");
    });

    it("soft-fires at info when the heading text is 'Warning' (severity word)", () => {
      const v = runRule(
        rule,
        `<div class="warning"><h3>Warning</h3><p>This action cannot be undone.</p></div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain('reads "warning"');
    });

    it("soft-fires at info even with trailing punctuation in heading ('Note:')", () => {
      const v = runRule(
        rule,
        `<div class="note"><h4>Note:</h4><p>Friendly aside about the next step.</p></div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain('reads "note"');
    });

    it("still warns when the first child heading text is NOT a severity word ('Topic')", () => {
      // The heading provides structure but no severity signal — AT
      // announces "heading level 5: Topic" which conveys topic but not
      // severity. The role/severity gap is unchanged.
      const v = runRule(
        rule,
        `<div class="note info">
  <h5>Topic</h5>
  <p>Body content describing the note.</p>
</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });

    it("still warns when the heading text is a multi-word topic label ('Breaking change')", () => {
      const v = runRule(
        rule,
        `<div class="warning"><h3>Breaking change</h3><p>Migration steps below.</p></div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });

    it("still warns when the heading text contains a severity word but is multi-word ('Performance note')", () => {
      // "Performance note" — the heading is a topic label that happens
      // to include "note", not a severity announcement. The dictionary
      // match is whole-word-only on a single-word heading.
      const v = runRule(
        rule,
        `<div class="caution">\n    <h4>Performance note</h4>\n    <p>Body.</p>\n  </div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });
  });

  describe("HTML: heading-first-child structural cases", () => {
    it("still warns when the wrapper has only prose (no heading first child)", () => {
      const v = runRule(rule, `<div class="note info"><p>just prose, no heading.</p></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });

    it("still warns when leading text precedes the heading (heading is no longer the announced label)", () => {
      // Non-whitespace text before the heading defeats the heading-as-
      // label pattern — AT hears the prose first, so the heading is not
      // functioning as the block's announced label.
      const v = runRule(
        rule,
        `<div class="warning">Heads up: <h3>Important</h3><p>Body.</p></div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });

    it("still warns when the first element child is a non-heading (p, div, span)", () => {
      const v = runRule(rule, `<div class="alert"><span>just a span</span><h3>X</h3></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });

    it("soft-fires at info when whitespace-only text precedes a severity-word heading", () => {
      // Whitespace formatting between the open tag and the heading is
      // ignored, so <h4>Tip</h4> is still recognised as the first
      // element child and the severity-word match applies.
      const v = runRule(
        rule,
        `<div class="caution">\n    <h4>Caution</h4>\n    <p>Body.</p>\n  </div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain('reads "caution"');
    });
  });

  describe("JSX: fires when", () => {
    it("a JSX div uses className with an admonition class and no role", () => {
      const v = runRule(
        rule,
        `export const X = () => <div className="note warning">Don't forget to run bundle install.</div>;`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('"note"');
      expect(v[0]?.suggestion).toContain("Warning:");
    });

    it("className is a plain 'danger' with body text only", () => {
      const v = runRule(
        rule,
        `export const X = () => <p className="danger">This deletes your data.</p>;`,
      );
      expect(v).toHaveLength(1);
    });
  });

  describe("JSX: does NOT fire when", () => {
    it('the JSX element has role="alert"', () => {
      const v = runRule(
        rule,
        `export const X = () => <div className="note warning" role="alert">Body.</div>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("the JSX text starts with a severity prefix", () => {
      const v = runRule(
        rule,
        `export const X = () => <div className="warning">Warning: this is destructive.</div>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("the element is a React component (PascalCase), not a native div", () => {
      // Component may render its own role internally; we treat it as opaque.
      const v = runRule(
        rule,
        `export const X = () => <Callout className="warning">Body.</Callout>;`,
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: heading-as-label refinement", () => {
    it("soft-fires at info when the first child heading is a severity word ('Tip')", () => {
      const v = runRule(
        rule,
        `export const X = () => (
  <div className="note info">
    <h5>Tip</h5>
    <p>Body.</p>
  </div>
);`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain('reads "tip"');
    });

    it("still warns when the first child heading is a non-severity topic ('Topic')", () => {
      const v = runRule(
        rule,
        `export const X = () => (
  <div className="note info">
    <h5>Topic</h5>
    <p>Body.</p>
  </div>
);`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });
  });

  describe("edge cases", () => {
    it("empty class attribute does not fire", () => {
      const v = runRule(rule, `<div class="">Body.</div>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("admonition class with empty body and no role still fires (programmatic label still missing)", () => {
      const v = runRule(rule, `<div class="warning"></div>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no visible text");
    });

    it("multiple space-separated roles: one is a severity role → does not fire", () => {
      const v = runRule(rule, `<div class="warning" role="presentation alert">Content.</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("rule metadata", () => {
    it("satisfies WCAG 1.3.3, 1.4.1, and 4.1.2 across 2.1 and 2.2", () => {
      expect(rule.satisfies).toContain("wcag22:1.3.3");
      expect(rule.satisfies).toContain("wcag21:1.3.3");
      expect(rule.satisfies).toContain("wcag22:1.4.1");
      expect(rule.satisfies).toContain("wcag21:1.4.1");
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });

    it("has a normativeQuote citing WCAG", () => {
      expect(rule.docs.normativeQuote).toBeDefined();
      expect(rule.docs.normativeQuote.length).toBeGreaterThan(0);
      expect(rule.docs.references[0]).toContain("WCAG22");
    });
  });
});
