import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/aria-invalid-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/aria-invalid-missing", () => {
  describe("fires a violation when", () => {
    it("HTML input carries .is-invalid but no aria-invalid", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="email" class="form-control is-invalid" value="foo">
          <div class="invalid-feedback">Please enter a valid email.</div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/aria-invalid-missing");
      // Context-aware: echo the tag descriptor with type and class
      expect(violations[0]?.message).toContain('<input type="email"');
      expect(violations[0]?.message).toContain("is-invalid");
      // Context-aware suggestion: names the specific attribute to add
      expect(violations[0]?.suggestion).toContain('aria-invalid="true"');
      // Also nudges toward pairing aria-describedby with invalid-feedback
      expect(violations[0]?.suggestion).toContain("aria-describedby");
    });

    it("HTML textarea carries .is-invalid but no aria-invalid", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <textarea class="form-control is-invalid" name="note"></textarea>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<textarea");
    });

    it('HTML select declares aria-invalid="false" while .is-invalid paints the error (contradiction)', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <select class="form-control is-invalid" aria-invalid="false" name="country">
            <option>Pick one</option>
          </select>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(1);
      // Contradiction messaging names both sides
      expect(violations[0]?.message).toContain("is-invalid");
      expect(violations[0]?.message).toContain('aria-invalid="false"');
      // Suggestion explains either flip the attribute or remove the class
      expect(violations[0]?.suggestion).toMatch(/Change `aria-invalid`|remove `\.is-invalid`/);
    });

    it("JSX input uses .is-invalid in className without aria-invalid", () => {
      const violations = runRule(
        rule,
        `export default function Page() {
          return <input type="text" className="form-control is-invalid" />;
        }`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain('aria-invalid="true"');
    });
  });

  describe("does not fire when", () => {
    it('HTML input sets aria-invalid="true" alongside .is-invalid', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="email" class="form-control is-invalid" aria-invalid="true" aria-describedby="email-error">
          <div id="email-error" class="invalid-feedback">Please enter a valid email.</div>
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML input has no .is-invalid class at all", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" class="form-control" value="Alex">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('HTML input uses aria-invalid="grammar" — a valid true-ish subtype', () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" class="form-control is-invalid" aria-invalid="grammar">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX input uses aria-invalid={hasError} (expression) — trusted at runtime", () => {
      // Same tradeoff as labels-required makes with aria-label={t('slider')}:
      // the developer is computing the value; we do not second-guess.
      const violations = runRule(
        rule,
        `export default function Page({ hasError }: { hasError: boolean }) {
          return <input type="email" className="form-control is-invalid" aria-invalid={hasError} />;
        }`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it('input type="hidden" with .is-invalid is not flagged (no user-entered value)', () => {
      // Hidden inputs don't carry a validity story a screen reader would
      // narrate. Match the exclusion list in forms/labels-required.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="hidden" class="is-invalid" name="token" value="abc">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("substring match is not enough — .was-invalidated must not trigger on is-invalid", () => {
      // Whole-token match only. If a future utility class happens to
      // contain "is-invalid" as a substring, we should not fire.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><form>
          <input type="text" class="form-control was-invalidated-previously">
        </form></body></html>`,
        { filePath: "input.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it('JSX input with .is-invalid and aria-invalid="false" contradiction is flagged', () => {
      const violations = runRule(
        rule,
        `export default function Page() {
          return <input type="email" className="form-control is-invalid" aria-invalid="false" />;
        }`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('aria-invalid="false"');
    });
  });
});
