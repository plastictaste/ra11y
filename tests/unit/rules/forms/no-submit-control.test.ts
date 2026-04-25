import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/no-submit-control.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/no-submit-control", () => {
  describe("fires a violation when", () => {
    it("an HTML <form> has a text input but only a type=button (Reset) button", () => {
      const violations = runRule(
        rule,
        `<form action="/contact" method="post">
  <label>Name <input type="text" name="name"></label>
  <button type="button">Reset</button>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/no-submit-control");
      expect(violations[0]?.message).toMatch(/no submit control/i);
      expect(violations[0]?.suggestion).toMatch(/<button>Send<\/button>/);
    });

    it("an HTML <form> has a textarea but no buttons or submit inputs at all", () => {
      const violations = runRule(
        rule,
        `<form action="/feedback">
  <label>Message <textarea name="message"></textarea></label>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<form action="\/feedback">/);
    });

    it("a JSX <form> has an email input but only a type=button cancel", () => {
      const violations = runRule(
        rule,
        `export const ContactForm = () => (
  <form action="/contact">
    <input type="email" name="email" />
    <button type="button">Cancel</button>
  </form>
);`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/<button>Send<\/button>/);
    });
  });

  describe("does not fire when", () => {
    it("the HTML form has a bare <button> (defaults to type=submit)", () => {
      const violations = runRule(
        rule,
        `<form action="/contact">
  <input type="text" name="name">
  <button>Send</button>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the HTML form has an <input type=submit>", () => {
      const violations = runRule(
        rule,
        `<form action="/login">
  <input type="text" name="user">
  <input type="submit" value="Login">
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the HTML form has an explicit <button type=submit>", () => {
      const violations = runRule(
        rule,
        `<form action="/contact">
  <textarea name="msg"></textarea>
  <button type="submit">Send</button>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the JSX form has an onSubmit handler (submission path implied)", () => {
      const violations = runRule(
        rule,
        `export const ChatForm = ({ onSubmit }) => (
  <form onSubmit={onSubmit}>
    <input type="text" name="message" />
  </form>
);`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the form's only inputs are radio / checkbox / hidden (not a contact-form pattern)", () => {
      const violations = runRule(
        rule,
        `<form action="/poll">
  <input type="hidden" name="csrf" value="abc">
  <label><input type="radio" name="vote" value="a"> Option A</label>
  <label><input type="radio" name="vote" value="b"> Option B</label>
  <label><input type="checkbox" name="agree"> I agree</label>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the form is empty (no inputs at all — not this rule's concern)", () => {
      const violations = runRule(rule, `<form action="/empty"></form>`, {
        filePath: "input.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("treats an <input> with no type attribute as text (HTML spec default)", () => {
      const violations = runRule(
        rule,
        `<form action="/contact">
  <input name="message">
  <button type="button">Reset</button>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("treats an unknown input type as text (HTML spec fallback)", () => {
      const violations = runRule(
        rule,
        `<form action="/contact">
  <input type="bogus-type" name="message">
  <button type="button">Reset</button>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("accepts <input type=image> as a submit control (HTML spec)", () => {
      const violations = runRule(
        rule,
        `<form action="/search">
  <input type="text" name="q">
  <input type="image" src="/go.png" alt="Search">
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });
});
