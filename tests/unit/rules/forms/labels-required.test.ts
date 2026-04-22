import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/labels-required.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/labels-required", () => {
  describe("HTML: fires when", () => {
    it("bare <input> has no label", () => {
      const v = runRule(rule, `<form><input type="text"></form>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("accessible name");
    });

    it("<select> has no label", () => {
      const v = runRule(rule, `<form><select><option>A</option></select></form>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("<textarea> has no label", () => {
      const v = runRule(rule, `<form><textarea></textarea></form>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("<input> id doesn't match any <label for=>", () => {
      const v = runRule(
        rule,
        `<form><label for="name">Name</label><input id="email" type="email"></form>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("input has aria-label", () => {
      const v = runRule(rule, `<input type="text" aria-label="Name">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("input is inside a <label>", () => {
      const v = runRule(rule, `<label>Name<input type="text"></label>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("input id matches a <label for>", () => {
      const v = runRule(rule, `<label for="name">Name</label><input id="name" type="text">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("input has aria-labelledby", () => {
      const v = runRule(
        rule,
        `<h2 id="section">Profile</h2><input type="text" aria-labelledby="section">`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("input type=hidden", () => {
      const v = runRule(rule, `<input type="hidden" name="csrf">`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("input type=submit", () => {
      const v = runRule(rule, `<input type="submit" value="Save">`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("input has no label and no htmlFor association", () => {
      const v = runRule(rule, `const Form = () => <form><input type="email" /></form>;`);
      expect(v).toHaveLength(1);
    });
  });

  describe("JSX: does NOT fire when", () => {
    it("label[htmlFor] matches input id", () => {
      const v = runRule(
        rule,
        `const Form = () => <form><label htmlFor="e">Email</label><input id="e" type="email" /></form>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("input wrapped in <label>", () => {
      const v = runRule(rule, `const Form = () => <label>Name<input type="text" /></label>;`);
      expect(v).toHaveLength(0);
    });

    it("input has aria-label prop", () => {
      const v = runRule(rule, `const X = <input type="text" aria-label="Name" />;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: primitive component (info, not error)", () => {
    it("unlabeled <input> with spread props emits info, not error", () => {
      const v = runRule(rule, `const Input = (props) => <input {...props} />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain("spread");
    });

    it("unlabeled <input> without spread stays an error", () => {
      const v = runRule(rule, `const X = <input type="text" />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });
  });

  it("cites wcag22:3.3.2 and wcag21:3.3.2", () => {
    expect(rule.satisfies).toContain("wcag22:3.3.2");
    expect(rule.satisfies).toContain("wcag21:3.3.2");
  });

  describe("nativeWrapperElements mapping (Q2-WRAPMAP-RULES)", () => {
    it("opts in to the native `input` tag so mapped wrappers fire", () => {
      expect(rule.wrapperTreatsAsElement).toBe("input");
    });

    it("fires on a wrapper declared to render `<input>` via the mapping", () => {
      const v = runRule(rule, `const X = <TextField />;`, {
        nativeWrapperElements: { TextField: "input" },
      });
      expect(v.length).toBeGreaterThan(0);
      expect(v[0]?.ruleId).toBe("forms/labels-required");
    });

    it("silences when the mapped wrapper call site has aria-label", () => {
      const v = runRule(rule, `const X = <TextField aria-label="Email" />;`, {
        nativeWrapperElements: { TextField: "input" },
      });
      expect(v).toHaveLength(0);
    });

    it("silences when the mapped wrapper is wrapped in a JSX <label>", () => {
      const v = runRule(rule, `const X = <label>Email<TextField /></label>;`, {
        nativeWrapperElements: { TextField: "input" },
      });
      expect(v).toHaveLength(0);
    });

    it("does not fire on a wrapper mapped to a non-form tag", () => {
      const v = runRule(rule, `const X = <Row />;`, {
        nativeWrapperElements: { Row: "div" },
      });
      expect(v).toHaveLength(0);
    });

    it("does not fire on an unmapped PascalCase component", () => {
      const v = runRule(rule, `const X = <UnknownInput />;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("HTML: contenteditable hosts (V1-DETECT-LABELS-CONTENTEDITABLE)", () => {
    it('fires on <div contenteditable="true"> with no label', () => {
      const v = runRule(rule, `<div contenteditable="true"></div>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("contenteditable");
      expect(v[0]?.message).toContain("accessible name");
    });

    it("fires on bare <div contenteditable> (bare == true per HTML spec)", () => {
      const v = runRule(rule, `<div contenteditable></div>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    it('fires on <div contenteditable=""> (empty string == true per HTML spec)', () => {
      const v = runRule(rule, `<div contenteditable=""></div>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it('fires on <span contenteditable="true"> (not just <div>)', () => {
      const v = runRule(rule, `<span contenteditable="true"></span>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("accepts aria-label as the accessible name", () => {
      const v = runRule(rule, `<div contenteditable="true" aria-label="Message composer"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("accepts aria-labelledby as the accessible name", () => {
      const v = runRule(
        rule,
        `<h2 id="h">Compose</h2><div contenteditable="true" aria-labelledby="h"></div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it('accepts <label for="id"> matching the contenteditable id', () => {
      const v = runRule(
        rule,
        `<label for="editor">Message</label><div id="editor" contenteditable="true"></div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("accepts a wrapping <label> (implicit label)", () => {
      const v = runRule(rule, `<label>Message<div contenteditable="true"></div></label>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it('does NOT fire on <div contenteditable="false"> — not a form control', () => {
      const v = runRule(rule, `<div contenteditable="false">static</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it('does NOT fire on <div contenteditable="inherit"> — not a form control', () => {
      const v = runRule(rule, `<div contenteditable="inherit">inherits</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on <div> without any contenteditable attribute", () => {
      const v = runRule(rule, `<div>just content</div>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("suggestion references aria-label and <label for> with the element's id", () => {
      const v = runRule(rule, `<div id="composer" contenteditable="true"></div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("aria-label");
      expect(v[0]?.suggestion).toContain("composer");
    });
  });

  describe("JSX: contenteditable hosts (V1-DETECT-LABELS-CONTENTEDITABLE)", () => {
    it('fires on <div contentEditable="true"> with no label', () => {
      const v = runRule(rule, `const X = <div contentEditable="true" />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("contenteditable");
    });

    it("fires on <div contentEditable={true}> (boolean expression)", () => {
      const v = runRule(rule, `const X = <div contentEditable={true} />;`);
      expect(v).toHaveLength(1);
    });

    it("fires on bare <div contentEditable />", () => {
      const v = runRule(rule, `const X = <div contentEditable />;`);
      expect(v).toHaveLength(1);
    });

    it('fires on lowercase <div contenteditable="true"> (author used HTML spelling)', () => {
      const v = runRule(rule, `const X = <div contenteditable="true" />;`);
      expect(v).toHaveLength(1);
    });

    it("accepts aria-label", () => {
      const v = runRule(rule, `const X = <div contentEditable="true" aria-label="Message" />;`);
      expect(v).toHaveLength(0);
    });

    it("accepts aria-labelledby", () => {
      const v = runRule(
        rule,
        `const X = <><h2 id="h">Compose</h2><div contentEditable="true" aria-labelledby="h" /></>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("accepts label[htmlFor] matching id", () => {
      const v = runRule(
        rule,
        `const X = <><label htmlFor="e">Message</label><div id="e" contentEditable="true" /></>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("accepts wrapping <label>", () => {
      const v = runRule(rule, `const X = <label>Message<div contentEditable={true} /></label>;`);
      expect(v).toHaveLength(0);
    });

    it('does NOT fire on <div contentEditable="false">', () => {
      const v = runRule(rule, `const X = <div contentEditable="false">static</div>;`);
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on <div contentEditable={false}>", () => {
      const v = runRule(rule, `const X = <div contentEditable={false}>static</div>;`);
      expect(v).toHaveLength(0);
    });

    it('does NOT fire on <div contentEditable="inherit">', () => {
      const v = runRule(rule, `const X = <div contentEditable="inherit">inherits</div>;`);
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on dynamic contentEditable={isEditing} — ambiguous, agent decides", () => {
      // Expression values that aren't literal `true`/`false` stay unflagged:
      // we can't prove the element is editable at render time, and firing
      // would produce false positives on conditionally-editable regions.
      const v = runRule(rule, `const X = <div contentEditable={isEditing} />;`);
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on <div> without contentEditable", () => {
      const v = runRule(rule, `const X = <div>content</div>;`);
      expect(v).toHaveLength(0);
    });

    it("emits info (not error) when the editable host has {...spread} props", () => {
      const v = runRule(
        rule,
        `const Editor = (props) => <div contentEditable={true} {...props} />;`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain("spread");
    });
  });

  describe("placeholder enrichment (Q6-PLACEHOLDER-IN-FIX-SUGGESTION)", () => {
    it("surfaces the placeholder verbatim in the HTML suggestion when present", () => {
      const v = runRule(rule, `<input type="email" placeholder="Enter email">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain(`"Enter email"`);
      expect(v[0]?.suggestion).toContain("may carry the intent");
      expect(v[0]?.suggestion).toContain("verify");
    });

    it("uses a suitable placeholder as primary label text in the mechanical edit", () => {
      // "Email address" is a short descriptive noun phrase — use it verbatim
      // as the label-text candidate in the `<label>…</label>` edit, and
      // mirror it into the aria-label suggestion.
      const v = runRule(rule, `<input id="email" type="email" placeholder="Email address">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain(`<label for="email">Email address</label>`);
      expect(v[0]?.suggestion).toContain(`aria-label="Email address"`);
    });

    it("does NOT use an instruction-style placeholder as label copy (only as additive context)", () => {
      // "Enter email" reads as an instruction, not a noun phrase — keep the
      // generic "Email" in the edit, but still quote the placeholder verbatim.
      const v = runRule(rule, `<input id="email" type="email" placeholder="Enter email">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      // Label text stays the inferred "Email" (from type="email"), not "Enter email".
      expect(v[0]?.suggestion).toContain(`<label for="email">Email</label>`);
      expect(v[0]?.suggestion).not.toContain(`<label for="email">Enter email</label>`);
      // Placeholder is still echoed as additive context.
      expect(v[0]?.suggestion).toContain(`"Enter email"`);
    });

    it("does NOT use a format-hint placeholder as label copy (contains @ / digits)", () => {
      const v = runRule(rule, `<input id="email" type="email" placeholder="name@example.com">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain(`<label for="email">Email</label>`);
      expect(v[0]?.suggestion).toContain(`"name@example.com"`);
    });

    it("keeps default suggestion unchanged when no placeholder is present", () => {
      const v = runRule(rule, `<input id="name" type="text">`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain(`<label for="name">Label</label>`);
      // No placeholder → no "may carry the intent" tail.
      expect(v[0]?.suggestion).not.toContain("may carry the intent");
    });

    it("treats empty placeholder as absent (no enrichment)", () => {
      const v = runRule(rule, `<input id="name" type="text" placeholder="">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).not.toContain("may carry the intent");
    });

    it("treats whitespace-only placeholder as absent (no enrichment)", () => {
      const v = runRule(rule, `<input id="name" type="text" placeholder="   ">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).not.toContain("may carry the intent");
    });

    it("surfaces placeholder on <textarea> too", () => {
      const v = runRule(rule, `<textarea placeholder="Your message"></textarea>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain(`"Your message"`);
      expect(v[0]?.suggestion).toContain("may carry the intent");
    });

    it("surfaces placeholder verbatim on JSX input suggestions", () => {
      const v = runRule(
        rule,
        `const X = <input id="email" type="email" placeholder="Email address" />;`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain(`"Email address"`);
      expect(v[0]?.suggestion).toContain(`<label for="email">Email address</label>`);
    });

    it("does not enrich JSX suggestion when placeholder is an expression (not a literal)", () => {
      // Expression-valued placeholders are not echoed — we cannot read the
      // literal text and quoting the raw expression adds no signal.
      const v = runRule(
        rule,
        `const X = <input id="email" type="email" placeholder={t('email')} />;`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).not.toContain("may carry the intent");
    });

    it("truncates very long placeholders in the echoed snippet", () => {
      // Placeholder longer than truncateForEcho's default cap (200 chars)
      // must not blow out the suggestion string with raw user text.
      const long = `A`.repeat(300);
      const v = runRule(rule, `<input id="x" type="text" placeholder="${long}">`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      // Raw 300-char string doesn't appear verbatim; truncation applied.
      expect(v[0]?.suggestion.includes(long)).toBe(false);
      // Still additive-context enrichment (placeholder was non-empty).
      expect(v[0]?.suggestion).toContain("may carry the intent");
      // Long strings are NOT suitable as label copy — edit stays generic.
      expect(v[0]?.suggestion).not.toContain(`<label for="x">${long}`);
    });
  });

  describe("polymorphic as/asChild resolution (Q2R2-POLYMORPHIC)", () => {
    it('fires on <Field as="input" /> with no label', () => {
      const v = runRule(rule, `const X = <Field as="input" />;`);
      expect(v.length).toBeGreaterThan(0);
      expect(v[0]?.ruleId).toBe("forms/labels-required");
    });

    it('does not fire when polymorphic `as="input"` call site has aria-label', () => {
      const v = runRule(rule, `const X = <Field as="input" aria-label="Email" />;`);
      expect(v).toHaveLength(0);
    });

    it('does not fire when polymorphic `as="input"` is wrapped in <label>', () => {
      const v = runRule(rule, `const X = <label>Email<Field as="input" /></label>;`);
      expect(v).toHaveLength(0);
    });

    it("does not re-dispatch when `as` is a non-literal expression (honest — agent reads)", () => {
      // `as={inputTag}` is dynamic — the rule stays off this call site
      // and the agent reading the code decides.
      const v = runRule(rule, `const X = <Field as={inputTag} />;`);
      expect(v).toHaveLength(0);
    });

    it('does not re-dispatch when `as="div"` resolves to a non-target tag', () => {
      const v = runRule(rule, `const X = <Field as="div" />;`);
      expect(v).toHaveLength(0);
    });

    it("does not re-dispatch when `as` is absent", () => {
      const v = runRule(rule, `const X = <Field />;`);
      expect(v).toHaveLength(0);
    });
  });
});
