import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/heading-class-on-nonheading.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/heading-class-on-nonheading", () => {
  describe("fires a violation when", () => {
    it("div uses Bootstrap .h1 class (HTML)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div class="h1">Main Title</div></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("semantics/heading-class-on-nonheading");
      // Suggestion must be context-aware: cite the actual class token and tag.
      expect(violations[0]?.suggestion).toContain('<h1 class="h1">');
      expect(violations[0]?.suggestion).toContain('aria-level="1"');
      expect(violations[0]?.message).toContain(".h1");
      expect(violations[0]?.message).toContain("<div");
    });

    it("p uses Bootstrap .display-4 class (HTML)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><p class="display-4">Marketing Headline</p></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("display-heading");
      expect(violations[0]?.suggestion).toContain("<h4>");
      expect(violations[0]?.suggestion).toContain('aria-level="4"');
    });

    it("span uses .h3 class in JSX", () => {
      const violations = runRule(
        rule,
        `export default function Page() { return <span className="h3">Sub Title</span>; }`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("<h3>");
      expect(violations[0]?.message).toContain("<span");
    });

    it('role="heading" without aria-level does not excuse the class (HTML)', () => {
      // role="heading" alone isn't a valid heading per ARIA — aria-level is
      // required. We treat missing aria-level as "not a satisfying heading
      // role" so the class-based lie still gets surfaced.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div class="h2" role="heading">Partial</div></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("does not fire when", () => {
    it("heading tag uses a Bootstrap heading class (HTML)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><h1 class="display-4">Hero</h1></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("non-heading element uses unrelated typography utility", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><p class="lead small text-muted">Lead paragraph</p></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("font-size utility .fs-1 is not a heading class", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div class="fs-1 fw-bold">Big text</div></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('element has role="heading" AND aria-level (JSX)', () => {
      const violations = runRule(
        rule,
        `export default function Page() {
           return <div className="h2" role="heading" aria-level="2">Section</div>;
         }`,
      );
      expect(violations).toHaveLength(0);
    });

    it("no class attribute at all", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div>Plain block</div></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("matches the first heading-like token and reports one violation per element", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div class="mb-3 h1 text-center">Title</div></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(".h1");
    });

    it("is case-sensitive — .H1 (uppercase) does not match (Bootstrap is lowercase)", () => {
      // Bootstrap's heading classes are lowercase. Uppercase .H1 is almost
      // certainly a bespoke class, not the Bootstrap one — we don't claim
      // it means "heading" without evidence.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div class="H1">Not Bootstrap</div></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("whole-token match — .h10 and .heading are not flagged", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
           <div class="h10">Scale 10</div>
           <div class="heading">Generic heading div</div>
           <div class="subheading">Sub</div>
         </body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("anchor element with .h2 class is still flagged", () => {
      // Anchors are not headings; Bootstrap's visual class on a link is
      // exactly the pattern we want to catch (a link that looks like a
      // section heading but announces as a link).
      const violations = runRule(
        rule,
        `<!doctype html><html><body><a href="#s1" class="h2">Jump to section</a></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<a");
    });
  });
});
