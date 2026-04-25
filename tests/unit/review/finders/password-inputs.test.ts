/**
 * Unit tests for the review/password-inputs finder.
 *
 * The finder asks: is there an `<input type="password">` that creates a
 * WCAG 3.3.8 (Accessible Authentication) review obligation?
 *
 * Tests exercise both HTML and JSX surfaces, cover the reason-text encoding
 * (id, name, autocomplete, sibling input names), verify negative cases
 * (non-password input types, PascalCase wrappers), and confirm the finder
 * surfaces the right criterion, confidence, and line number.
 */

import { describe, expect, it } from "bun:test";
import { finder } from "../../../../src/review/finders/password-inputs.ts";
import { runFinder } from "../../../helpers/run-finder.ts";

describe("review/password-inputs", () => {
  // ---------- positive: finder fires on password inputs ----------

  it("flags <input type='password'> in HTML", () => {
    const source = `<form><input type="password" id="pass"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("password");
  });

  it("flags <input type='password'> without enclosing form in HTML", () => {
    const source = `<input type="password" id="standalone-pass">`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("password");
  });

  it("emits candidate for wcag22:3.3.8", () => {
    const source = `<form><input type="password"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    const criteria = new Set(out.map((c) => c.criterionId));
    expect(criteria.has("wcag22:3.3.8")).toBe(true);
  });

  it("reports confidence as high", () => {
    const source = `<form><input type="password"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.confidence).toBe("high");
  });

  it("anchors candidate at the input's line number", () => {
    const source = [
      "<form>",
      "  <label for='p'>Password</label>",
      '  <input type="password" id="p">',
      "</form>",
    ].join("\n");
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.location.line).toBe(3);
  });

  it("includes the field id in the reason text", () => {
    const source = `<form><input type="password" id="current-pass"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain('id="current-pass"');
  });

  it("falls back to name when id is absent", () => {
    const source = `<form><input type="password" name="pass"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain('name="pass"');
  });

  it("notes the autocomplete value when present", () => {
    const source = `<form><input type="password" id="p" autocomplete="current-password"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("current-password");
  });

  it("flags autocomplete='off' explicitly in the reason text", () => {
    const source = `<form><input type="password" id="p" autocomplete="off"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("autocomplete=\"off\"");
  });

  it("notes missing autocomplete in the reason text", () => {
    const source = `<form><input type="password" id="p"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("no autocomplete attribute");
  });

  it("includes sibling input names from the same form", () => {
    const source = `
      <form>
        <input type="text" id="username" name="username">
        <input type="password" id="pass" name="password">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    // The password input's reason should mention its sibling.
    expect(out[0]?.reason).toContain("username");
  });

  it("includes the WCAG 3.3.8 verification guidance in the reason text", () => {
    const source = `<form><input type="password"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("WCAG 3.3.8");
  });

  // ---------- JSX branch ----------

  it("flags JSX <input type='password' />", () => {
    const source = `
      const Login = () => (
        <form>
          <input type="password" id="pass" />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("password");
  });

  it("includes sibling input names from JSX form", () => {
    const source = `
      const Login = () => (
        <form>
          <input type="text" id="username" name="username" />
          <input type="password" id="pass" name="password" />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.reason).toContain("username");
  });

  it("flags JSX <input type={'password'} />", () => {
    const source = `
      const Form = () => <input type={"password"} id="p" />;
    `;
    const out = runFinder(finder, source);
    expect(out.length).toBeGreaterThan(0);
  });

  // ---------- negative: finder does NOT fire ----------

  it("does not flag <input type='text'>", () => {
    const source = `<form><input type="text" id="name"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag <input type='email'>", () => {
    const source = `<form><input type="email" id="email"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag <input type='hidden'>", () => {
    const source = `<form><input type="hidden" name="csrf"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag <input type='submit'>", () => {
    const source = `<form><input type="submit" value="Log in"></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag a form with no inputs", () => {
    const source = `<form><button type="submit">Submit</button></form>`;
    const out = runFinder(finder, source, { filePath: "form.html" });
    expect(out).toEqual([]);
  });

  it("does not flag JSX PascalCase <Password /> wrapper", () => {
    const source = `
      const Login = () => (
        <form>
          <Password id="pass" />
        </form>
      );
    `;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  it("does not flag JSX <input type='text' />", () => {
    const source = `
      const Form = () => <input type="text" id="name" />;
    `;
    const out = runFinder(finder, source);
    expect(out).toEqual([]);
  });

  // ---------- edge cases ----------

  it("emits one candidate per criterion for a single password input", () => {
    const source = `<form><input type="password" id="pass"></form>`;
    const out = runFinder(finder, source, { filePath: "login.html" });
    // Only one criterion: wcag22:3.3.8.
    expect(out).toHaveLength(1);
  });

  it("emits one candidate per password input when a form has multiple password fields", () => {
    const source = `
      <form>
        <input type="password" id="pass" name="password">
        <input type="password" id="confirm" name="confirm_password">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "register.html" });
    // Two password inputs × one criterion = 2 candidates.
    expect(out).toHaveLength(2);
  });

  it("does not include self in the sibling list", () => {
    const source = `
      <form>
        <input type="password" id="pass" name="password">
      </form>
    `;
    const out = runFinder(finder, source, { filePath: "login.html" });
    expect(out.length).toBeGreaterThan(0);
    // The password field itself should not appear in its own sibling list.
    expect(out[0]?.reason).not.toContain("sibling inputs");
  });
});
