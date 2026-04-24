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

  describe("value-shape branch (label text looks like a displayed value)", () => {
    it("HTML: plain-number label text fires with value-shape message", () => {
      const v = runRule(rule, '<label for="range">50</label><input id="range" type="range">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain('"50"');
      expect(v[0]?.message).toContain("looks like a value");
      expect(v[0]?.message).toContain("a labelling element should name what the control controls");
    });

    it("HTML: decimal-number label text fires", () => {
      const v = runRule(rule, '<label for="x">1.5</label><input id="x">', { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('"1.5"');
    });

    it("HTML: currency label text fires", () => {
      const v = runRule(rule, '<label for="p">$9.99</label><input id="p" name="price">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('"$9.99"');
    });

    it("HTML: percentage label text fires", () => {
      const v = runRule(rule, '<label for="b">75%</label><input id="b">', { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('"75%"');
    });

    it("HTML: ISO-date label text fires", () => {
      const v = runRule(rule, '<label for="d">2024-03-14</label><input id="d" type="date">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('"2024-03-14"');
    });

    it("HTML: slash-date label text fires", () => {
      const v = runRule(rule, '<label for="d2">3/14/2024</label><input id="d2">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('"3/14/2024"');
    });

    it("HTML: time label text fires", () => {
      const v = runRule(rule, '<label for="t">12:30</label><input id="t" type="time">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('"12:30"');
    });

    it("HTML: time-with-seconds label text fires", () => {
      const v = runRule(rule, '<label for="t2">12:30:45</label><input id="t2">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('"12:30:45"');
    });

    it("HTML: suggestion cross-references the matching control", () => {
      const v = runRule(rule, '<label for="range">50</label><input id="range" type="range">', {
        filePath: "a.html",
      });
      expect(v[0]?.suggestion).toContain('for="range"');
      expect(v[0]?.suggestion).toContain('<input type="range">');
      expect(v[0]?.suggestion).toContain("`<output>`");
    });

    it("HTML: empty label still emits the empty-branch message, not the value-shape one", () => {
      const v = runRule(rule, '<label for="x"></label><input id="x">', { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("<label> is empty");
      expect(v[0]?.message).not.toContain("looks like a value");
    });

    it("HTML: label with a real name does NOT fire", () => {
      const v = runRule(rule, '<label for="q">Quantity</label><input id="q">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(0);
    });

    it("HTML: label text that embeds a number inside prose does NOT fire", () => {
      // "Age (in years)" should not match — only pure value shapes do.
      const v = runRule(rule, '<label for="a">Age (in years)</label><input id="a">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(0);
    });

    it("HTML: label text that looks like an identifier/word does NOT fire", () => {
      const v = runRule(rule, '<label for="t">Temperature</label><input id="t">', {
        filePath: "a.html",
      });
      expect(v).toHaveLength(0);
    });

    it("HTML: unmatched for target → generic value-shape advice", () => {
      const v = runRule(rule, '<label for="ghost">50</label>', { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain('for="ghost"');
      expect(v[0]?.suggestion).toContain("no <input>, <select>, or <textarea>");
    });

    it("HTML: bare <label> with no for and value-shape text → generic advice only", () => {
      const v = runRule(rule, "<label>75%</label>", { filePath: "a.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("`<output>`");
    });

    it("JSX: value-shape text fires with htmlFor cross-reference", () => {
      const v = runRule(
        rule,
        '<label htmlFor="range">50</label><input id="range" type="range" />',
        { filePath: "a.tsx" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('"50"');
      expect(v[0]?.suggestion).toContain('htmlFor="range"');
    });

    it("JSX: empty label and value-shape label on same file emit separate findings", () => {
      const v = runRule(rule, `<><label htmlFor="a"></label><label htmlFor="b">50</label></>`, {
        filePath: "a.tsx",
      });
      expect(v).toHaveLength(2);
      const messages = v.map((x) => x.message);
      expect(messages.some((m) => m.includes("<label> is empty"))).toBe(true);
      expect(messages.some((m) => m.includes("looks like a value"))).toBe(true);
    });
  });

  it("cites WCAG 2.4.6, 1.3.1, and 3.3.2 across both 2.1 and 2.2", () => {
    expect(rule.satisfies).toContain("wcag22:2.4.6");
    expect(rule.satisfies).toContain("wcag21:2.4.6");
    expect(rule.satisfies).toContain("wcag22:1.3.1");
    expect(rule.satisfies).toContain("wcag22:3.3.2");
    expect(rule.satisfies).toContain("wcag21:3.3.2");
  });

  // V1-LIQUID-TEMPLATE-EXPRESSION-AS-SOLE-CHILD-REASON-ENRICHMENT:
  // `<label>{{ form.email }}</label>` has its only child stripped by
  // the HTML parser — rendered text depends on runtime interpolation.
  // Surface-don't-suppress: finding still emits at `error`; reason
  // text carries the template_directive_stripped signal.
  describe("HTML: template-directive enrichment", () => {
    it("enriches reason when sole child is a Liquid interpolation", () => {
      const v = runRule(rule, `<label for="email">{{ form.email }}</label>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("template expression");
      expect(v[0]?.message).toContain("ra11y-disable");
    });

    it("does NOT enrich reason when label is plainly empty", () => {
      const v = runRule(rule, `<label for="email"></label>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).not.toContain("template expression");
    });
  });
});
