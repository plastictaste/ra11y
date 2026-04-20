import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/non-empty-label.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/non-empty-label", () => {
  describe("fires when", () => {
    it("an HTML label is empty", () => {
      const v = runRule(rule, '<label for="email"></label><input id="email">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("<label> is empty");
    });

    it("an HTML label contains only whitespace", () => {
      const v = runRule(rule, '<label for="x">   \n\t  </label>', { filePath: "a.html" });
      expect(v).toHaveLength(1);
    });

    it("a JSX label is empty", () => {
      const v = runRule(rule, '<label htmlFor="email"></label>', { filePath: "a.tsx" });
      expect(v).toHaveLength(1);
    });
  });

  describe("does NOT fire when", () => {
    it("an HTML label contains visible text", () => {
      const v = runRule(rule, '<label for="email">Email</label>', { filePath: "a.html" });
      expect(v).toHaveLength(0);
    });

    it("a JSX label contains visible text", () => {
      const v = runRule(rule, '<label htmlFor="email">Email</label>', { filePath: "a.tsx" });
      expect(v).toHaveLength(0);
    });

    it("the file has no <label> elements at all", () => {
      const v = runRule(rule, "<input>", { filePath: "a.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX primitive component (info, not error)", () => {
    it("empty <label> with spread props emits info", () => {
      const v = runRule(rule, `const Label = (props) => <label {...props} />;`, {
        filePath: "a.tsx",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain("spread");
    });

    it("empty <label> without spread stays an error", () => {
      const v = runRule(rule, `const X = <label htmlFor="x" />;`, { filePath: "a.tsx" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });
  });

  describe("suggestion inlines cross-referenced control context", () => {
    it("HTML: type='email' control with matching id → suggestion names the email-specific candidate", () => {
      const v = runRule(rule, '<label for="email"></label><input id="email" type="email">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain('for="email"');
      expect(v[0]?.suggestion).toContain('<input type="email">');
      expect(v[0]?.suggestion).toContain("Email address");
      expect(v[0]?.suggestion).toContain('type="email"');
    });

    it("HTML: humanizes a snake_case name when type provides no hint", () => {
      const v = runRule(rule, '<label for="pn"></label><input id="pn" name="phone_number">', {
        filePath: "a.html",
      });
      expect(v[0]?.suggestion).toContain('name="phone_number"');
      expect(v[0]?.suggestion).toContain("Phone number");
    });

    it("HTML: placeholder wins over name when type is absent", () => {
      const v = runRule(
        rule,
        '<label for="q"></label><input id="q" name="q" placeholder="Search orders">',
        { filePath: "a.html" },
      );
      expect(v[0]?.suggestion).toContain("Search orders");
      expect(v[0]?.suggestion).toContain("placeholder");
    });

    it("HTML: matching control with no hint → short-noun fallback branch", () => {
      const v = runRule(rule, '<label for="u"></label><input id="u">', {
        filePath: "a.html",
      });
      expect(v[0]?.suggestion).toContain('for="u"');
      expect(v[0]?.suggestion).toContain("no type, name, or placeholder");
      expect(v[0]?.suggestion).toContain("Username");
    });

    it("HTML: unmatched id → flags missing control", () => {
      const v = runRule(rule, '<label for="ghost"></label><input id="other">', {
        filePath: "a.html",
      });
      expect(v[0]?.suggestion).toContain('for="ghost"');
      expect(v[0]?.suggestion).toContain("no <input>, <select>, or <textarea>");
      expect(v[0]?.suggestion).toContain("Verify the id");
    });

    it("HTML: points at the control's line number so the agent can jump to it", () => {
      const src = `<label for="email"></label>
<input id="email" type="email">`;
      const v = runRule(rule, src, { filePath: "a.html" });
      expect(v[0]?.suggestion).toContain("line 2");
    });

    it("HTML: <textarea> with matching id is described with its tag", () => {
      const v = runRule(rule, '<label for="bio"></label><textarea id="bio"></textarea>', {
        filePath: "a.html",
      });
      expect(v[0]?.suggestion).toContain("<textarea>");
    });

    it("JSX: htmlFor + type='tel' → suggestion names the phone candidate", () => {
      const v = runRule(rule, '<label htmlFor="p"></label><input id="p" type="tel" />', {
        filePath: "a.tsx",
      });
      expect(v[0]?.suggestion).toContain('htmlFor="p"');
      expect(v[0]?.suggestion).toContain("Phone number");
    });

    it("JSX: humanizes a camelCase name", () => {
      const v = runRule(rule, '<label htmlFor="fn"></label><input id="fn" name="firstName" />', {
        filePath: "a.tsx",
      });
      expect(v[0]?.suggestion).toContain("First name");
    });

    it("JSX: unmatched htmlFor id → flags missing control", () => {
      const v = runRule(rule, '<label htmlFor="nope"></label>', { filePath: "a.tsx" });
      expect(v[0]?.suggestion).toContain('htmlFor="nope"');
      expect(v[0]?.suggestion).toContain("no <input>, <select>, or <textarea>");
    });

    it("JSX: bare <label/> with no htmlFor falls back to generic JSX advice", () => {
      const v = runRule(rule, "<label></label>", { filePath: "a.tsx" });
      expect(v[0]?.suggestion).toContain("child of the <label> element");
    });
  });

  it("cites WCAG 2.4.6 and 1.3.1 across both 2.1 and 2.2", () => {
    expect(rule.satisfies).toContain("wcag22:2.4.6");
    expect(rule.satisfies).toContain("wcag21:2.4.6");
    expect(rule.satisfies).toContain("wcag22:1.3.1");
  });
});
