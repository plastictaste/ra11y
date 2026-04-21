import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/error-message-not-associated.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/error-message-not-associated", () => {
  describe("fires a violation when", () => {
    it("HTML .invalid-feedback sibling with no aria-describedby on the input", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <div>
            <input type="email" class="form-control is-invalid">
            <div class="invalid-feedback" id="email-error">Please enter a valid email.</div>
          </div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/error-message-not-associated");
      // Context-aware message names both the error element and the sibling control
      expect(violations[0]?.message).toContain('<div class="invalid-feedback">');
      expect(violations[0]?.message).toContain('<input type="email">');
      // Context-aware suggestion names the existing error id so the author can wire it up
      expect(violations[0]?.suggestion).toContain('aria-describedby="email-error"');
    });

    it('HTML [role="alert"] sibling of a textarea with no aria-describedby', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <fieldset>
            <textarea name="note"></textarea>
            <p role="alert" id="note-error">Note is required.</p>
          </fieldset>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('[role="alert"]');
      expect(violations[0]?.message).toContain("<textarea>");
      expect(violations[0]?.suggestion).toContain('aria-describedby="note-error"');
    });

    it("HTML input has aria-describedby but it points at a different id", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <div>
            <input type="text" class="form-control" aria-describedby="email-help">
            <small id="email-help">We never share your email.</small>
            <div class="invalid-feedback" id="email-error">Enter a valid email.</div>
          </div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      // Contradiction-style message quotes the existing (wrong) attribute
      expect(violations[0]?.message).toContain('aria-describedby="email-help"');
      // Suggestion teaches the space-separated list form so the author appends, not replaces
      expect(violations[0]?.suggestion).toContain('aria-describedby="email-help email-error"');
    });

    it("JSX .invalid-feedback with no aria-describedby fires only on the broken pair", () => {
      const violations = runRule(
        rule,
        `export default function Form() {
          return (
            <form>
              <div>
                <input type="email" className="form-control is-invalid" aria-describedby="email-error" />
                <div className="invalid-feedback" id="email-error">Please enter a valid email.</div>
              </div>
              <div>
                <input type="text" className="form-control is-invalid" />
                <div className="invalid-feedback" id="name-error">Name is required.</div>
              </div>
            </form>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(1);
      // Fires on the name-error pair, not the email-error pair
      expect(violations[0]?.suggestion).toContain('aria-describedby="name-error"');
    });

    it("HTML error element with no id at all emits an id-authorship suggestion", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <div>
            <input type="email" class="form-control is-invalid">
            <div class="invalid-feedback">Please enter a valid email.</div>
          </div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      // The suggestion must instruct the author to ADD an id (not guess one)
      expect(violations[0]?.suggestion).toMatch(/Add an id/);
      expect(violations[0]?.suggestion).toContain("aria-describedby");
    });
  });

  describe("does not fire when", () => {
    it("HTML input's aria-describedby correctly references the error element's id", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <div>
            <input type="email" class="form-control is-invalid" aria-describedby="email-error">
            <div class="invalid-feedback" id="email-error">Please enter a valid email.</div>
          </div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input's aria-describedby carries multiple tokens including the error id", () => {
      // aria-describedby accepts a space-separated id list — this is the
      // canonical pattern for help-text + error-text pairs.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <div>
            <input type="email" class="form-control is-invalid" aria-describedby="email-help email-error">
            <small id="email-help">We never share your email.</small>
            <div class="invalid-feedback" id="email-error">Please enter a valid email.</div>
          </div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX aria-describedby is an expression value — we trust the author computes the id at render time", () => {
      const violations = runRule(
        rule,
        `export default function Field({ errorId }: { errorId: string }) {
          return (
            <div>
              <input type="email" className="form-control is-invalid" aria-describedby={errorId} />
              <div className="invalid-feedback" id="email-error">Please enter a valid email.</div>
            </div>
          );
        }`,
        { filePath: "input.tsx" },
      );
      expect(violations).toHaveLength(0);
    });

    it(".invalid-feedback with no sibling form control does not fire", () => {
      // A standalone error-message element is a different pattern (live
      // region / toast banner) covered by other rules. Field-level error
      // association is specifically about control ↔ message pairs.
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <div>
            <div class="invalid-feedback" id="global-error">Something went wrong.</div>
          </div>
        </body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('[role="alert"] not adjacent to any input does not fire', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body>
          <section>
            <h2>Status</h2>
            <p role="alert" id="status-banner">Your session will expire soon.</p>
          </section>
        </body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it(".error-message (generic convention) fires the same way as .invalid-feedback", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <div>
            <input type="text" class="form-control">
            <span class="error-message" id="name-error">Name is required.</span>
          </div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(".error-message element");
    });

    it("multiple fields in one form: only the broken pair fires", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <div>
            <input type="email" aria-describedby="email-error">
            <div class="invalid-feedback" id="email-error">Bad email.</div>
          </div>
          <div>
            <input type="tel">
            <div class="invalid-feedback" id="phone-error">Bad phone.</div>
          </div>
          <div>
            <input type="text" aria-describedby="name-error">
            <div class="invalid-feedback" id="name-error">Bad name.</div>
          </div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      // Only the phone-error pair is broken
      expect(violations[0]?.suggestion).toContain('aria-describedby="phone-error"');
    });

    it('[role="alert"] matches case-insensitively (ROLE="Alert")', () => {
      // ARIA role values are ASCII case-insensitive per the spec.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <div>
            <input type="text">
            <p role="Alert" id="err">Bad input.</p>
          </div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('[role="alert"]');
    });
  });
});
