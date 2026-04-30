import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/interactive-ancestor-of-heading.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/interactive-ancestor-of-heading", () => {
  describe("HTML: fires when", () => {
    it("<a href> directly wraps an <h2> with text", () => {
      const violations = runRule(rule, `<a href="post.html"><h2>Post Title</h2></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/interactive-ancestor-of-heading");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.message).toContain("<h2>");
      expect(violations[0]?.message).toContain("<a href>");
      expect(violations[0]?.suggestion).toMatch(/Invert the nesting/);
    });

    it("<button> wraps an <h3>", () => {
      const violations = runRule(rule, `<button type="button"><h3>Expand section</h3></button>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<h3>");
      expect(violations[0]?.message).toContain("<button>");
    });

    it("<a href> wraps multiple headings — one violation per heading", () => {
      const violations = runRule(rule, `<a href="post.html"><h2>Title</h2><h3>Subhead</h3></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(2);
      expect(violations.map((v) => v.message)).toEqual([
        expect.stringContaining("<h2>"),
        expect.stringContaining("<h3>"),
      ]);
    });

    it("the heading is a deep descendant of <a href>", () => {
      const violations = runRule(
        rule,
        `<a href="card.html"><div class="card-body"><h2>Card</h2></div></a>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<a href>");
    });

    it("the heading carries an aria-label even when text is empty", () => {
      const violations = runRule(rule, `<a href="x.html"><h2 aria-label="Untitled"></h2></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("the heading wraps the <a href> (idiomatic shape)", () => {
      const violations = runRule(rule, `<h2><a href="post.html">Post Title</a></h2>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<a> has no href (placeholder, non-interactive)", () => {
      const violations = runRule(rule, `<a><h2>Anchor placeholder</h2></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("the heading is empty and has no accessible name source", () => {
      const violations = runRule(rule, `<a href="x.html"><h2></h2></a>`, {
        filePath: "index.html",
      });
      // Empty heading is the empty-heading rule's domain on a different
      // SC; this rule stays quiet because there's no heading semantics
      // for the interactive role to subsume.
      expect(violations).toHaveLength(0);
    });

    it("a non-interactive ancestor (<div>) wraps the heading", () => {
      const violations = runRule(rule, `<div role="article"><h2>Card</h2></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("the heading is a sibling of the <a href>, not a descendant", () => {
      const violations = runRule(
        rule,
        `<article><h2>Title</h2><a href="post.html">Read more</a></article>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("<a href> wraps an <h2> with text", () => {
      const violations = runRule(
        rule,
        `export const Card = () => (
          <a href="/post"><h2>Post Title</h2></a>
        );`,
        { filePath: "Card.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<h2>");
      expect(violations[0]?.message).toContain("<a href>");
    });

    it("<button> wraps an <h3>", () => {
      const violations = runRule(
        rule,
        `export const Toggle = () => (
          <button type="button"><h3>Expand</h3></button>
        );`,
        { filePath: "Toggle.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<button>");
    });

    it("the heading uses an expression child (treated as text content)", () => {
      const violations = runRule(
        rule,
        `export const Card = ({ title }: { title: string }) => (
          <a href="/post"><h2>{title}</h2></a>
        );`,
        { filePath: "Card.tsx" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("the heading wraps the <a href>", () => {
      const violations = runRule(
        rule,
        `export const Heading = () => (
          <h2><a href="/post">Post Title</a></h2>
        );`,
        { filePath: "Heading.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a PascalCase ancestor sits between the heading and an <a href>", () => {
      const violations = runRule(
        rule,
        `export const Wrapped = () => (
          <a href="/post">
            <Card>
              <h2>Inside an opaque wrapper</h2>
            </Card>
          </a>
        );`,
        { filePath: "Wrapped.tsx" },
      );
      // The PascalCase Card is opaque — agent reads its definition.
      expect(violations).toHaveLength(0);
    });

    it("<a> without href wraps a heading", () => {
      const violations = runRule(
        rule,
        `export const Placeholder = () => (
          // biome-ignore lint/a11y/useValidAnchor: literal href-less anchor on purpose
          <a><h2>Anchor placeholder</h2></a>
        );`,
        { filePath: "Placeholder.tsx" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("nested <a href> wrapping a heading inside an outer <a href> reports each ancestor pair once", () => {
      // Outer <a> is also an ancestor; the rule walks up and stops at
      // the first interactive ancestor — here that's the inner <a>.
      // The outer <a>+<a> pairing is caught by nested-interactive on a
      // different SC; this rule reports the closer interactive ancestor.
      const violations = runRule(rule, `<a href="/outer"><a href="/inner"><h2>Title</h2></a></a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("CSS files are ignored (extension out of scope)", () => {
      const violations = runRule(rule, `.card { color: red; }`, { filePath: "styles.css" });
      expect(violations).toHaveLength(0);
    });
  });
});
