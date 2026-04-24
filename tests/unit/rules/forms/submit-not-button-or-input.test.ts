import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/submit-not-button-or-input.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/submit-not-button-or-input", () => {
  describe("fires a violation when", () => {
    it("an HTML <form> has only an <a class=btn> as the apparent submit", () => {
      const violations = runRule(
        rule,
        `<form action="/login" method="post">
  <input type="text" name="user">
  <a href="index.html" class="btn btn-lg btn-success btn-block">Login</a>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/submit-not-button-or-input");
      expect(violations[0]?.message).toMatch(/submit control/i);
      expect(violations[0]?.suggestion).toMatch(/<button type="submit"/);
      expect(violations[0]?.suggestion).toMatch(/Login/);
    });

    it("an HTML <form> has only an <a role=button> as the apparent submit", () => {
      const violations = runRule(
        rule,
        `<form action="/contact">
  <input type="email" name="email">
  <a href="#" role="button">Send</a>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/announce it as a link/);
      expect(violations[0]?.suggestion).toMatch(/Send/);
    });

    it("a JSX <form> has only an <a className=btn> as the apparent submit", () => {
      const violations = runRule(
        rule,
        `export const LoginForm = () => (
  <form action="/login">
    <input type="email" name="email" />
    <a href="/" className="btn btn-primary">Sign in</a>
  </form>
);`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/className="btn btn-primary"/);
      expect(violations[0]?.suggestion).toMatch(/Sign in/);
    });
  });

  describe("does not fire when", () => {
    it("the form has a real <button type=submit>", () => {
      const violations = runRule(
        rule,
        `<form action="/login">
  <input type="text" name="user">
  <button type="submit">Login</button>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the form has a bare <button> (defaults to type=submit) AND a button-styled cancel link", () => {
      const violations = runRule(
        rule,
        `<form action="/save">
  <input type="text" name="title">
  <button>Save</button>
  <a href="/back" class="btn btn-secondary">Cancel</a>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the form has an <input type=submit>", () => {
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

    it("the form has an <input type=image>", () => {
      const violations = runRule(
        rule,
        `<form action="/search">
  <input type="text" name="q">
  <input type="image" src="/go.png" alt="Search">
  <a href="/help" class="btn btn-link">Help</a>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the form has no submit AND no anchor at all (out of scope here — pure-JS forms)", () => {
      const violations = runRule(
        rule,
        `<form>
  <input type="text" name="search" onkeydown="submitOnEnter(event)">
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the form contains an <a> without btn class (regular link, not styled as button)", () => {
      const violations = runRule(
        rule,
        `<form>
  <input type="text" name="q">
  <button type="submit">Search</button>
  <p>See also <a href="/help">help</a>.</p>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("substring 'button' or 'btn' inside a longer class token does NOT trigger", () => {
      // `printable-button` is not Bootstrap's `btn` token.
      const violations = runRule(
        rule,
        `<form>
  <input type="text" name="q">
  <a href="/print" class="printable-button">Print</a>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("<button type=button> does NOT count as a submit (only type=submit / default)", () => {
      const violations = runRule(
        rule,
        `<form>
  <input type="text" name="q">
  <button type="button" onclick="reset()">Reset</button>
  <a href="/go" class="btn btn-primary">Go</a>
</form>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("a nested <form> inside another <form> is each independently evaluated", () => {
      // HTML forbids nested forms but the parser tolerates them; rule
      // shouldn't crash and each form is checked on its own merits.
      // The outer form has a real submit; the inner one has only an
      // anchor-as-button, so we expect exactly one violation (the
      // inner form). This rehearses an invariant of the walker, not
      // the forbidden HTML.
      const violations = runRule(
        rule,
        `<form action="/outer">
  <input type="text" name="a">
  <button type="submit">Outer</button>
  <form action="/inner">
    <input type="text" name="b">
    <a href="/x" class="btn">Inner</a>
  </form>
</form>`,
        { filePath: "input.html" },
      );
      // Note: outer's walkHtmlElements descends into inner — outer
      // sees the inner button-styled anchor too, but outer's own
      // <button type=submit> short-circuits before we ever look for
      // anchors. So outer: clean. Inner: anchor-as-submit, no real
      // submit → violation.
      expect(violations).toHaveLength(1);
    });
  });
});
