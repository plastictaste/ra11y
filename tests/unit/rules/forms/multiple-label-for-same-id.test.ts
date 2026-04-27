import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/multiple-label-for-same-id.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/multiple-label-for-same-id", () => {
  describe("HTML: fires when", () => {
    it("two labels reference the same existing id (visible + sr-only duplicate shape)", () => {
      const v = runRule(
        rule,
        `<label for="email">Email</label>\n<label for="email" class="sr-only">Email address</label>\n<input id="email" type="email">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("forms/multiple-label-for-same-id");
      expect(v[0]?.severity).toBe("warning");
      // The duplicate (second label) is the one that gets emitted on.
      expect(v[0]?.location.line).toBe(2);
      expect(v[0]?.message).toContain("line 1");
      expect(v[0]?.message).toContain("email");
    });

    it("three labels reference the same id — emits once per duplicate (lines 2 and 3)", () => {
      const v = runRule(
        rule,
        `<label for="x">A</label>\n<label for="x">B</label>\n<label for="x">C</label>\n<input id="x" type="text">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(2);
      expect(v[0]?.location.line).toBe(2);
      expect(v[1]?.location.line).toBe(3);
    });

    it("suggestion echoes both labels' text and offers concrete fix paths", () => {
      const v = runRule(
        rule,
        `<label for="pw">Password</label>\n<label for="pw" class="sr-only">Choose a strong password</label>\n<input id="pw" type="password">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("Password");
      expect(v[0]?.suggestion).toContain("Choose a strong password");
      expect(v[0]?.suggestion).toContain("aria-describedby");
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("each label points at a distinct existing id", () => {
      const v = runRule(
        rule,
        `<label for="email">Email</label>\n<label for="pw">Password</label>\n<input id="email" type="email">\n<input id="pw" type="password">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("a label has no for= at all (wrapping form is a different rule's surface)", () => {
      const v = runRule(
        rule,
        `<label>Name <input type="text"></label>\n<label for="email">Email</label>\n<input id="email" type="email">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("two labels share a for= that does NOT resolve to any id (dangling — handled by label-for-id-mismatch)", () => {
      // Avoid double-counting with forms/label-for-id-mismatch. Both labels
      // there are dangling; that rule fires on each independently.
      const v = runRule(
        rule,
        `<label for="ghost">A</label>\n<label for="ghost">B</label>\n<input id="email" type="email">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX", () => {
    it("fires when two <label htmlFor='X'> point at the same existing id", () => {
      const v = runRule(
        rule,
        `const Form = () => (\n  <form>\n    <label htmlFor="email">Email</label>\n    <label htmlFor="email" className="sr-only">Email address</label>\n    <input id="email" type="email" />\n  </form>\n);`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("email");
    });

    it("accepts the non-React `for` spelling alongside `htmlFor`", () => {
      const v = runRule(
        rule,
        `const Form = () => (\n  <form>\n    <label for="email">Email</label>\n    <label htmlFor="email">Email address</label>\n    <input id="email" type="email" />\n  </form>\n);`,
      );
      expect(v).toHaveLength(1);
    });

    it("does not fire when each label targets its own distinct id", () => {
      const v = runRule(
        rule,
        `const Form = () => (\n  <form>\n    <label htmlFor="email">Email</label>\n    <label htmlFor="pw">Password</label>\n    <input id="email" type="email" />\n    <input id="pw" type="password" />\n  </form>\n);`,
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("groups labels per (file, target-id) — distinct ids each with duplicates emit per group", () => {
      const v = runRule(
        rule,
        `<label for="a">A1</label>\n<label for="a">A2</label>\n<label for="b">B1</label>\n<label for="b">B2</label>\n<input id="a" type="text">\n<input id="b" type="text">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(2);
      // One emission per duplicate group (the second label of each pair).
      expect(v.map((x) => x.location.line).sort()).toEqual([2, 4]);
    });
  });

  it("cites wcag22:1.3.1 + 4.1.2 and their 2.1 equivalents", () => {
    expect(rule.satisfies).toContain("wcag22:1.3.1");
    expect(rule.satisfies).toContain("wcag21:1.3.1");
    expect(rule.satisfies).toContain("wcag22:4.1.2");
    expect(rule.satisfies).toContain("wcag21:4.1.2");
  });
});
