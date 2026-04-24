import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/required-marker-without-required-attr.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/required-marker-without-required-attr", () => {
  describe("fires a violation when", () => {
    it("an HTML <label> with a <span class='text-danger'>*</span> marker is paired (via for=) with an <input> that has no required and no aria-required", () => {
      // Canonical Bootstrap-derived shape from the field report —
      // the colour-only `*` is flagged by `color/meaning-by-color-only`,
      // but the input itself was previously silent. This rule covers
      // that gap.
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Username/Email <span class="text-danger">*</span></label>
  <input id="email" type="text" class="form-control">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      const v = violations[0];
      expect(v?.ruleId).toBe("forms/required-marker-without-required-attr");
      expect(v?.message).toMatch(/text-danger/);
      expect(v?.message).toMatch(/aria-required/);
      expect(v?.suggestion).toMatch(/required/);
    });

    it("a label with an <abbr title='required'>*</abbr> marker pairs with an unflagged input", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="phone">Phone <abbr title="required">*</abbr></label>
  <input id="phone" type="tel">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/abbr title="required"/);
    });

    it("a label that wraps the input implicitly and shows a marker still fires (no for= needed)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label>
    Address <sup>*</sup>
    <input type="text" name="addr">
  </label>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/<sup>\*<\/sup>/);
    });

    it("a label that contains the literal word 'required' fires when the input has no required attribute", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="ssn">SSN (required)</label>
  <input id="ssn" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/word "required"/);
    });

    it("a JSX label with a <span className='text-danger'>*</span> marker fires when the paired input lacks required", () => {
      const jsx = `function ContactForm() {
  return (
    <form>
      <label htmlFor="email">Email <span className="text-danger">*</span></label>
      <input id="email" type="email" className="form-control" />
    </form>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "ContactForm.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/text-danger/);
      expect(violations[0]?.suggestion).toMatch(/aria-required/);
    });

    it("flags <select> and <textarea> the same way as <input>", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="country">Country <span>*</span></label>
  <select id="country"><option>US</option></select>
  <label for="bio">Bio <span>*</span></label>
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
  <label for="email">Email <span class="text-danger">*</span></label>
  <input id="email" type="email" required>
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the input sets aria-required='true'", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="email">Email <span class="text-danger">*</span></label>
  <input id="email" type="email" aria-required="true">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("the label has no required marker at all (plain label)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="nick">Nickname</label>
  <input id="nick" type="text">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });

    it("a JSX input with the `required` shorthand prop pairs with a marker-bearing label", () => {
      const jsx = `function Form() {
  return (
    <>
      <label htmlFor="email">Email <span className="text-danger">*</span></label>
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
      <label htmlFor="email">Email <span className="text-danger">*</span></label>
      <input id="email" type="email" aria-required={isRequired} />
    </>
  );
}`;
      const violations = runRule(rule, jsx, { filePath: "Form.tsx" });
      expect(violations).toHaveLength(0);
    });

    it("the labelled control is a non-labelable input type (submit, hidden, button)", () => {
      const html = `<!DOCTYPE html>
<html><body>
  <label for="go">Go <span>*</span></label>
  <input id="go" type="submit" value="Submit">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("does NOT fire on a bare `*` text node inside a label without an element wrapper (false-positive guard)", () => {
      // A bare asterisk in label text is too noisy a signal — it might
      // be a footnote marker, an annotation, or incidental punctuation.
      // We require either an element wrapper around `*` or the literal
      // word "required" — neither is present here.
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
  <label for="email">Email <span class="text-danger">*</span></label>
  <input id="email" type="email" aria-required="false">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(1);
    });

    it("a dangling for= reference does not produce a finding (no control to fire on)", () => {
      // The label has a marker but `for` points at a missing id. The
      // rule has no control to attach to; `forms/label-for-id-mismatch`
      // owns the dangling-reference complaint.
      const html = `<!DOCTYPE html>
<html><body>
  <label for="missing">Email <span class="text-danger">*</span></label>
  <input id="email" type="email">
</body></html>`;
      const violations = runRule(rule, html, { filePath: "page.html" });
      expect(violations).toHaveLength(0);
    });
  });
});
