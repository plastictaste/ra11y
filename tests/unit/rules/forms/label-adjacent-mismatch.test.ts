import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/label-adjacent-mismatch.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/label-adjacent-mismatch", () => {
  describe("fires a violation when", () => {
    it("the canonical password-strength-background shape: <label for='email'>Password</label> sits above <input id='password'> while id='email' lives elsewhere in the document", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Password:</label>
  <input id="password" type="password">
  <input id="email" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/label-adjacent-mismatch");
      expect(violations[0]?.message).toMatch(/for="email"/);
      expect(violations[0]?.message).toMatch(/id="password"/);
      expect(violations[0]?.message).toMatch(/copy-paste mismatch/);
      // The suggestion should name BOTH the change-to and the verify-other side.
      expect(violations[0]?.suggestion).toMatch(/for="password"/);
      expect(violations[0]?.suggestion).toMatch(/verify/i);
    });

    it("fires on JSX with htmlFor mismatch — label points elsewhere, adjacent input has different id", () => {
      const jsx = `function Form() {
  return (
    <form>
      <label htmlFor="email">Password</label>
      <input id="password" type="password" />
      <input id="email" type="text" />
    </form>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "Form.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/htmlFor="email"/);
      expect(violations[0]?.suggestion).toMatch(/htmlFor="password"/);
    });

    it("fires when the adjacent control has NO id at all (the for= still resolves elsewhere, so the intent is contradicted either way)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Password:</label>
  <input type="password" class="form-control">
  <input id="email" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/has no id at all/);
      // Suggestion guides the agent to add an id and change for= to match.
      expect(violations[0]?.suggestion).toMatch(/Add an id/);
    });

    it("fires when id='X' resolves to a non-form element (button) — the for= is still wrong for the adjacent input", () => {
      // Edge case from the dispatch prompt: id 'X' may resolve to a
      // <button>, <a>, or other non-form element. The mismatch holds
      // regardless of where for= does land.
      const html = `<!DOCTYPE html>
<html><body>
  <label for="open-modal">Username</label>
  <input id="username" type="text">
  <button id="open-modal">Open</button>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/for="open-modal"/);
      expect(violations[0]?.suggestion).toMatch(/for="username"/);
    });

    it("fires on <select> and <textarea> adjacency, not just <input>", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="msg">Country</label>
  <select id="country"><option>US</option></select>
  <textarea id="msg"></textarea>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/select id="country"/);
    });
  });

  describe("does not fire when", () => {
    it("the label's for= matches the adjacent input's id (correctly associated)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="x">x</label>
  <input id="x" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the label's for= resolves nowhere — that's forms/label-for-id-mismatch's territory, not ours", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="zzz">z</label>
  <input id="other" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the label is not immediately adjacent to a labelable control (intervening div breaks adjacency)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="x">x</label>
  <div></div>
  <input id="other" type="text">
  <input id="x" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the label has no for= attribute (forms/label-adjacent-unassociated owns this)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>Password</label>
  <input id="password" type="password">
  <input id="email" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the adjacent control is excluded by type (submit/hidden/button/reset/image)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Go</label>
  <input id="go" type="submit" value="Submit">
  <input id="email" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("whitespace-only text and comments between label and control are transparent (formatting, not content)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Password</label>
  <!-- copy-paste residue from the email field above -->
  <input id="password" type="password">
  <input id="email" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/copy-paste mismatch/);
    });

    it("non-whitespace text between label and control breaks adjacency — let the agent read the file", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Password</label>
  please enter your password
  <input id="password" type="password">
  <input id="email" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("JSX with spread props on the adjacent input stays silent (spread may carry a matching id at runtime)", () => {
      // Canonical react-hook-form shape: `<input {...register("password")}/>`
      // — the spread might supply id="email" matching the label's for=.
      // We can't see through it; default to surfacing nothing rather
      // than emitting a false positive.
      const jsx = `function Form({ register }: { register: (n: string) => object }) {
  return (
    <form>
      <label htmlFor="email">Password</label>
      <input type="password" {...register("password")} />
      <input id="email" type="text" />
    </form>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "Form.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("does not double-fire when label-for-id-mismatch would also fire (we skip when for= is dangling)", () => {
      // The label's for="zzz" resolves nowhere — even though the adjacent
      // input has a different id ("other"), THIS rule defers to
      // forms/label-for-id-mismatch and stays silent. Verifies the two
      // rules are mutually exclusive by shape.
      const html = `<!DOCTYPE html>
<html><body>
  <label for="zzz">z</label>
  <input id="other" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("fires twice on the same page when two distinct mismatch shapes are present", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Password:</label>
  <input id="password" type="password">
  <label for="phone">Address:</label>
  <input id="address" type="text">
  <input id="email" type="text">
  <input id="phone" type="tel">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
    });
  });
});
