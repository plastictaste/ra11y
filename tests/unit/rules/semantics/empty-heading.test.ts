import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/empty-heading.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/empty-heading", () => {
  describe("HTML: fires when", () => {
    it("heading is completely empty", () => {
      const v = runRule(rule, `<h1></h1>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("<h1>");
    });

    it("heading contains only whitespace", () => {
      const v = runRule(rule, `<h2>   </h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("<h2>");
    });

    it("heading contains only a non-text child without alt (svg)", () => {
      const v = runRule(rule, `<h3><svg aria-hidden="true"></svg></h3>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("heading contains img without alt", () => {
      const v = runRule(rule, `<h2><img src="icon.png"></h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("heading contains img with empty alt", () => {
      const v = runRule(rule, `<h2><img src="icon.png" alt=""></h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("heading has text content", () => {
      const v = runRule(rule, `<h1>Welcome</h1>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("heading has aria-label", () => {
      const v = runRule(rule, `<h2 aria-label="Section title"></h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("heading has aria-labelledby", () => {
      const v = runRule(rule, `<h2 aria-labelledby="ref"></h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("heading contains img with alt text", () => {
      const v = runRule(rule, `<h2><img src="logo.png" alt="Company Logo"></h2>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("heading has deeply nested text", () => {
      const v = runRule(rule, `<h3><span><strong>Title</strong></span></h3>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("heading is self-closing", () => {
      const v = runRule(rule, `const X = <h1 />;`);
      expect(v).toHaveLength(1);
    });

    it("heading is empty", () => {
      const v = runRule(rule, `const X = <h2></h2>;`);
      expect(v).toHaveLength(1);
    });

    it("heading contains only whitespace text", () => {
      const v = runRule(rule, `const X = <h3>   </h3>;`);
      expect(v).toHaveLength(1);
    });
  });

  describe("JSX: does NOT fire when", () => {
    it("heading has text content", () => {
      const v = runRule(rule, `const X = <h1>Welcome</h1>;`);
      expect(v).toHaveLength(0);
    });

    it("heading has aria-label", () => {
      const v = runRule(rule, `const X = <h2 aria-label="Section" />;`);
      expect(v).toHaveLength(0);
    });

    it("heading has expression child (runtime content)", () => {
      const v = runRule(rule, `const X = <h1>{title}</h1>;`);
      expect(v).toHaveLength(0);
    });

    it("heading wraps a PascalCase component (assumed accessible)", () => {
      const v = runRule(rule, `const X = <h2><Icon /></h2>;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: primitive component definition (info, not error)", () => {
    it("empty <h1> with spread props emits info, not error", () => {
      const v = runRule(rule, `const H1 = (props) => <h1 {...props} />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain("spread");
    });

    it("empty <h2> without spread stays an error", () => {
      const v = runRule(rule, `const X = <h2 />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    it("<h3> with spread and children emits nothing (children resolve it)", () => {
      const v = runRule(rule, `const X = <h3 {...props}>{children}</h3>;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("flags multiple empty headings independently", () => {
      const v = runRule(rule, `<h1></h1><h2></h2><h3></h3>`, { filePath: "index.html" });
      expect(v).toHaveLength(3);
    });

    it("does not flag non-heading elements", () => {
      const v = runRule(rule, `<p></p><div></div>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("suggestion mentions replacing with styled element for visual-only headings", () => {
      const v = runRule(rule, `<h4></h4>`, { filePath: "index.html" });
      expect(v[0]?.suggestion).toContain("styled");
    });
  });

  describe("context-aware fix: preceding heading", () => {
    it("empty h3 after h2 inlines the h2's text and level", () => {
      const source = `<h2>Contact Information</h2>\n<h3></h3>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      const empty = violations.find((v) => v.location.line === 2);
      expect(empty?.suggestion).toContain("<h3>");
      expect(empty?.suggestion).toContain("<h2>Contact Information</h2>");
      expect(empty?.suggestion).toContain("line 1");
      expect(empty?.suggestion).toContain("Contact Information");
    });

    it("empty h2 after a sibling h2 mentions the sibling branch", () => {
      const source = `<h2>Overview</h2>\n<p>intro copy</p>\n<h2></h2>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      const empty = violations[0];
      expect(empty?.location.line).toBe(3);
      expect(empty?.suggestion).toContain("sibling");
      expect(empty?.suggestion).toContain("<h2>Overview</h2>");
    });

    it("empty h2 after an h4 flags the hierarchy break", () => {
      const source = `<h4>Details</h4>\n<h2></h2>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      const empty = violations.find((v) => v.location.line === 2);
      expect(empty?.suggestion).toContain("hierarchy");
      expect(empty?.suggestion).toContain("<h4>Details</h4>");
      expect(empty?.suggestion).toContain("semantics/heading-hierarchy");
    });

    it("empty heading at start of document uses the fallback branch", () => {
      const source = `<h1></h1>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations[0]?.suggestion).toContain("start of document");
      expect(violations[0]?.suggestion).toContain("navigation gap");
    });

    it("truncates very long preceding heading text in the fix", () => {
      const long = "A".repeat(120);
      const source = `<h2>${long}</h2>\n<h3></h3>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      const empty = violations.find((v) => v.location.line === 2);
      // Inlined text should be truncated with an ellipsis, not pasted raw.
      expect(empty?.suggestion).not.toContain(long);
      expect(empty?.suggestion).toMatch(/…/);
    });

    it("JSX empty h3 after h2 inlines the preceding heading", () => {
      const source = `const Page = () => (<div><h2>Pricing</h2><h3></h3></div>);`;
      const violations = runRule(rule, source);
      const empty = violations[0];
      expect(empty?.suggestion).toContain("<h2>Pricing</h2>");
      expect(empty?.suggestion).toContain("<h3>");
    });
  });

  it("cites wcag22:2.4.6 and wcag21:2.4.6", () => {
    expect(rule.satisfies).toContain("wcag22:2.4.6");
    expect(rule.satisfies).toContain("wcag21:2.4.6");
  });
});
