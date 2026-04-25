import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/parsing/malformed-tag.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule parsing/malformed-tag", () => {
  describe("fires a violation when", () => {
    it("an orphan closing tag </h33> appears (canonical field shape)", () => {
      // Closing-typo case: opener is valid, closer is `</h33>`. The
      // parser preserves only `<h3>` in the AST and flags the closer
      // as a generic stray-close error — the rule re-scans source so
      // the bad token reaches the agent at file:line.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><h3>Section</h33></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("parsing/malformed-tag");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.message).toMatch(/<\/h33> is not a valid HTML element/);
      expect(violations[0]?.suggestion).toMatch(/Rename <\/h33> to <\/h3>/);
    });

    it("a paired malformed heading <h33>...</h33> appears", () => {
      // Paired case: parser accepts `h33` as the element tag name.
      // Walks element list, finds impossible heading shape, emits at
      // the opening location. Source-scan path skips the closer
      // because the opener already covered the name.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><h33>Section title</h33></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<h33> is not a valid HTML element/);
      expect(violations[0]?.suggestion).toMatch(/Rename <h33> to <h3>/);
      expect(violations[0]?.suggestion).toMatch(/heading list/);
    });

    it("a zero-level heading <h0> appears (off-by-one typo)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><h0>Bad heading</h0></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<h0> is not a valid HTML element/);
      // Nearest valid level for 0 is h1.
      expect(violations[0]?.suggestion).toMatch(/Rename <h0> to <h1>/);
    });

    it("an over-level heading <h7> appears (clamps to h6)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><h7>Out of range</h7></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<h7> is not a valid HTML element/);
      expect(violations[0]?.suggestion).toMatch(/Rename <h7> to <h6>/);
    });

    it("multiple impossible headings appear in one document", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><h33>A</h33><h0>B</h0><h44>C</h44></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(3);
      const names = violations.map((v) => v.message.match(/<(h\d+)>/)?.[1]).sort();
      expect(names).toEqual(["h0", "h33", "h44"]);
    });
  });

  describe("does not fire when", () => {
    it("all heading levels are valid (h1 through h6)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a custom element with a hyphen appears (legal per HTML5)", () => {
      // Custom elements MUST contain a hyphen per the HTML spec —
      // `<my-widget>` is a perfectly legal coined name and the rule
      // must stay silent.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><my-widget>custom</my-widget></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("an unknown element with no digits appears (out of scope)", () => {
      // `<foo>` is unknown but not heading-shaped — outside this
      // rule's scope. Wider malformed-tag detection lives in a
      // future rule.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><foo>unknown but legal</foo></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("hgroup (a real HTML element) appears", () => {
      // `hgroup` is a legitimate HTML5 element name, distinct from
      // the `h\d+` shape. Keep the rule's regex anchored.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><hgroup><h1>Title</h1><p>Subtitle</p></hgroup></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("emits at the opening tag's line/column (not the closer)", () => {
      const violations = runRule(
        rule,
        `<!doctype html>\n<html>\n  <body>\n    <h33>Title</h33>\n  </body>\n</html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      // Opening `<h33>` sits on line 4; column 5 (after 4 spaces of
      // indent). Mirrors HtmlElement.loc.start in the AST walk.
      expect(violations[0]?.location.line).toBe(4);
      expect(violations[0]?.location.column).toBe(5);
    });

    it("emits at the closing tag's line/column for orphan closes", () => {
      // Multiline orphan-close case: `<h3>` opens on line 4,
      // `</h33>` closes on line 5. Source-scan path should report
      // the closer's position.
      const violations = runRule(
        rule,
        `<!doctype html>\n<html>\n  <body>\n    <h3>Section\n    text</h33>\n  </body>\n</html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.location.line).toBe(5);
      // `</h33>` starts at column 9 (after 8 spaces of `    text`).
      expect(violations[0]?.location.column).toBe(9);
    });

    it("treats h0 (single digit, leading-zero edge) as impossible", () => {
      // Sanity edge case: `h0` is the only single-digit impossible
      // member; ensure the digit-validity check rejects it.
      const violations = runRule(rule, `<!doctype html><html><body><h0>x</h0></body></html>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(1);
    });
  });
});
