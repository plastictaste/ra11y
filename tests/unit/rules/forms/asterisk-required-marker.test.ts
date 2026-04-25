import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/asterisk-required-marker.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/asterisk-required-marker", () => {
  describe("fires a violation when", () => {
    it("an HTML <label>'s text ends with a bare `*` and the for=-paired input lacks required and aria-required", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Email *</label>
  <input id="email" type="email" class="form-control">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      const v = violations[0];
      expect(v?.ruleId).toBe("forms/asterisk-required-marker");
      expect(v?.severity).toBe("warning");
      expect(v?.message).toMatch(/bare `\*`/);
      expect(v?.message).toMatch(/aria-required/);
      expect(v?.suggestion).toMatch(/required/);
    });

    it("an implicit-association <label> wrapping the input fires when the bare `*` is the trailing marker", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>
    Address *
    <input type="text" name="addr">
  </label>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<label>/);
    });

    it("a control's `placeholder` text ends with a bare `*` and the control has no required signal", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <input type="email" placeholder="Email *">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/placeholder/);
      expect(violations[0]?.suggestion).toMatch(/placeholders also disappear on focus/);
    });

    it("a JSX <label> with bare-`*` trailing text fires when the paired input lacks required", () => {
      const jsx = `function ContactForm() {
  return (
    <form>
      <label htmlFor="email">Email *</label>
      <input id="email" type="email" className="form-control" />
    </form>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "ContactForm.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/bare `\*`/);
      expect(violations[0]?.suggestion).toMatch(/required/);
    });

    it("flags <select> and <textarea> the same way as <input> (bare-`*` label)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="country">Country *</label>
  <select id="country"><option>US</option></select>
  <label for="bio">Bio *</label>
  <textarea id="bio"></textarea>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(2);
      const tags = violations.map((v) => v?.message).join("|");
      expect(tags).toMatch(/<select>/);
      expect(tags).toMatch(/<textarea>/);
    });
  });

  describe("does not fire when", () => {
    it("the input carries the boolean `required` attribute (HTML)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Email *</label>
  <input id="email" type="email" required>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the input sets aria-required='true'", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Email *</label>
  <input id="email" type="email" aria-required="true">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the label has no `*` and no required-word at all (plain label)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="nick">Nickname</label>
  <input id="nick" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the `*` is wrapped in an element (sister rule's territory) — this rule yields", () => {
      // `<span>*</span>` is the sister rule's case. We deliberately do
      // NOT fire here so the two rules don't double-emit on the same
      // input. The sister rule (forms/required-marker-without-required-
      // attr) fires at `error`; this rule yields silently.
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Email <span class="text-danger">*</span></label>
  <input id="email" type="email">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the label contains the literal word 'required' (sister rule's territory) — this rule yields", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="ssn">SSN (required) *</label>
  <input id="ssn" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the labelled control is a non-labelable input type (submit, hidden, button)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="go">Go *</label>
  <input id="go" type="submit" value="Submit">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a JSX input with `required` shorthand pairs with a bare-`*` label", () => {
      const jsx = `function Form() {
  return (
    <>
      <label htmlFor="email">Email *</label>
      <input id="email" type="email" required />
    </>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "Form.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("a JSX input uses an expression-valued aria-required={…} (developer trust path)", () => {
      const jsx = `function Form({ isRequired }: { isRequired: boolean }) {
  return (
    <>
      <label htmlFor="email">Email *</label>
      <input id="email" type="email" aria-required={isRequired} />
    </>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "Form.tsx" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("does NOT fire when `*` appears mid-text but not at the trimmed end (footnote-marker false-positive guard)", () => {
      // "First * Last" — a label like "Cell *2*" would also fall here.
      // The mid-text asterisk is too noisy a signal for the
      // asterisk-equals-required convention; we require trailing-`*`.
      const html = `<!DOCTYPE html>
<html><body>
  <label for="x">First * Last</label>
  <input id="x" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("does NOT credit aria-required='false' as satisfying — it actively contradicts the visible marker", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Email *</label>
  <input id="email" type="email" aria-required="false">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("a dangling for= reference does not produce a finding (no control to fire on)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="missing">Email *</label>
  <input id="email" type="email">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("does NOT double-fire when both a bare-`*` label AND a bare-`*` placeholder point at the same input", () => {
      // The control already triggered via the label-text branch; the
      // placeholder branch should observe `flagged` and skip.
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Email *</label>
  <input id="email" type="email" placeholder="you@example.com *">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("trims trailing whitespace before checking for the trailing `*` (newline-then-asterisk still fires)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Email
    *
  </label>
  <input id="email" type="email">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });
  });
});
