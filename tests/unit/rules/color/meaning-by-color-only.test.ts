import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/color/meaning-by-color-only.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule color/meaning-by-color-only", () => {
  describe("HTML: fires when", () => {
    it("a bare <span class='text-danger'> conveys the status with color only", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><p><span class="text-danger">Access denied</span></p></body></html>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("color/meaning-by-color-only");
      expect(violations[0]?.criteria).toContain("wcag22:1.4.1");
      expect(violations[0]?.message).toMatch(/text-danger/);
      expect(violations[0]?.message).toMatch(/danger/);
      expect(violations[0]?.suggestion).toMatch(/Danger:/);
    });

    it("a <div class='alert alert-success'> with prose text fires", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div class="alert alert-success">Your changes have been saved</div></body></html>`,
        { filePath: "alert.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/alert-success/);
    });

    it("a <button class='btn btn-warning'> with plain text fires", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><button class="btn btn-warning">Delete</button></body></html>`,
        { filePath: "button.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/btn-warning/);
    });

    it("a <span class='text-danger-emphasis'> (Bootstrap 5.3 emphasis variant) fires", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-danger-emphasis">Payment failed</span></body></html>`,
        { filePath: "emphasis.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toMatch(/danger/);
    });
  });

  describe("HTML: does not fire when", () => {
    it("the text-danger element has a prose 'Error:' prefix", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-danger">Error: invalid email address</span></body></html>`,
        { filePath: "prose-prefix.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("an icon sibling is inside the text-success element", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-success"><i class="bi bi-check-circle" aria-hidden="true"></i> Saved</span></body></html>`,
        { filePath: "with-icon.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("a visually-hidden label is inside the text-warning element", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-warning"><span class="visually-hidden">Warning:</span> Low battery</span></body></html>`,
        { filePath: "sr-only.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("the element is decorative theme tokens (text-primary, text-muted)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-primary">Brand accent</span><span class="text-muted">Secondary text</span><span class="text-body">Body copy</span></body></html>`,
        { filePath: "theme-tokens.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role='alert' is present on the text-danger element", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div class="text-danger" role="alert">Access denied</div></body></html>`,
        { filePath: "alert-role.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("aria-label supplies the status word", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-danger" aria-label="Error: Access denied">Access denied</span></body></html>`,
        { filePath: "aria-label.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("<span className='text-danger'>text</span> is bare", () => {
      const violations = runRule(
        rule,
        `export const X = () => <span className="text-danger">Access denied</span>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/className="text-danger"/);
    });

    it("<div className='alert alert-danger'>text</div> fires", () => {
      const violations = runRule(
        rule,
        `export const X = () => <div className="alert alert-danger">Upload failed</div>;`,
      );
      expect(violations).toHaveLength(1);
    });

    it("<button className='btn btn-outline-warning'>label</button> fires", () => {
      const violations = runRule(
        rule,
        `export const X = () => <button className="btn btn-outline-warning">Reset</button>;`,
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("an <Icon> PascalCase component is inside", () => {
      const violations = runRule(
        rule,
        `export const X = () => <span className="text-danger"><CheckIcon /> Saved</span>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("role='alert' is on the element", () => {
      const violations = runRule(
        rule,
        `export const X = () => <div className="text-danger" role="alert">Access denied</div>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("the text prose starts with 'Success:'", () => {
      const violations = runRule(
        rule,
        `export const X = () => <span className="text-success">Success: saved</span>;`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("empty text content does not fire (no visible text to be color-only about)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-danger"></span></body></html>`,
        { filePath: "empty.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("substring collision: text-dangerous does NOT match text-danger", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-dangerous-wrapping">Normal text</span></body></html>`,
        { filePath: "substring.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX aria-label={label} expression value is trusted (no fire)", () => {
      const violations = runRule(
        rule,
        `export const X = ({ label }: { label: string }) => <span className="text-danger" aria-label={label}>Access denied</span>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("text-info token + prose prefix 'Info:' passes", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-info">Info: settings saved</span></body></html>`,
        { filePath: "info-prefix.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("text-danger with aria-live='polite' passes (live region is a second channel)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-danger" aria-live="polite">Lost connection</span></body></html>`,
        { filePath: "live-region.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX fa-* icon class on child <i> satisfies the rule", () => {
      const violations = runRule(
        rule,
        `export const X = () => <span className="text-danger"><i className="fa fa-times"></i> Failed</span>;`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("text already carries status word (reason/suggestion refinement)", () => {
    // Real-world trigger: Bootstrap's own visual-test alert.html has
    // `<button class="btn btn-danger">Danger</button>`. The rule still
    // fires (color may be the *sole* meaning signal for colorblind
    // users), but the reason text and fix ranker adapt so the agent
    // doesn't act on advice that would produce "Danger: Danger".
    it("HTML: bare-word 'Danger' text still fires the rule", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><button class="btn btn-danger">Danger</button></body></html>`,
        { filePath: "alert.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("HTML: reason switches to the 'text already carries status word' enrichment", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><button class="btn btn-danger">Danger</button></body></html>`,
        { filePath: "alert.html" },
      );
      expect(violations[0]?.message).toMatch(/already carries a status word/);
      expect(violations[0]?.message).toMatch(/sole.*meaning signal/);
      // Must NOT claim "carries no status word" — that was the bug.
      expect(violations[0]?.message).not.toMatch(/carries no status word/);
    });

    it("HTML: reason text and severity agree — no concession that 'screen-reader users get the word'", () => {
      // Doctrine 2026-04-25 ("Reason text and severity must agree"):
      // when the rule still emits at `error` on a case where the
      // visible text carries the status word, the reason must not
      // concede the predicate. The old phrasing — "screen-reader users
      // reading prose get the word, but colorblind users may lose the
      // association" — granted the rule's own predicate (the meaning
      // is NOT color-only for SR users) while keeping severity at
      // `error`, training the agent to mistrust the rule. The
      // rewritten reason surfaces the *residual* concern: color may
      // still be the sole signal that frames the word as a *status*
      // (vs. ordinary prose) for users who cannot resolve the color
      // channel.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><button class="btn btn-danger">Danger</button></body></html>`,
        { filePath: "alert.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe("error");
      const msg = violations[0]?.message ?? "";
      // No concession that the predicate is satisfied for SR users.
      expect(msg).not.toMatch(/screen-reader users reading prose get the word/i);
      // No phrase suggesting the visible text is absent.
      expect(msg).not.toMatch(/no visible text/i);
      // Residual concern is framed honestly.
      expect(msg).toMatch(/color may still be the .?sole.? meaning signal/i);
      expect(msg).toMatch(/status (rather than|vs\.?) ordinary prose|framing.*status/i);
    });

    it("HTML: fix suggestion demotes 'prefix with status word' and warns against the tautology", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><button class="btn btn-danger">Danger</button></body></html>`,
        { filePath: "alert.html" },
      );
      const s = violations[0]?.suggestion ?? "";
      // The demoted option is explicitly called out as a tautology.
      expect(s).toMatch(/DO NOT prefix/);
      expect(s).toMatch(/tautology/);
      // The good paths (icon + sr-only, role=alert, aria-label) still appear.
      expect(s).toMatch(/visually-hidden/);
      expect(s).toMatch(/role="alert"/);
    });

    it("HTML: 'Upload failed' (status word mid-text) also triggers the enrichment", () => {
      // "failed" is in STATUS_PREFIX_WORDS; the prefix regex misses it
      // because the first word is "Upload", but the anywhere regex
      // catches it.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div class="alert alert-danger">Upload failed</div></body></html>`,
        { filePath: "upload.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/already carries a status word/);
    });

    it("HTML: 'Access denied' (no status word) keeps the original reason and 4-option suggestion", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-danger">Access denied</span></body></html>`,
        { filePath: "access.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/carries no status word/);
      // Original suggestion leads with "prefix the visible text".
      expect(violations[0]?.suggestion).toMatch(/prefix the visible text/);
      expect(violations[0]?.suggestion).not.toMatch(/tautology/);
    });

    it("JSX: <button className='btn btn-danger'>Danger</button> fires with the enriched reason", () => {
      const violations = runRule(
        rule,
        `export const X = () => <button className="btn btn-danger">Danger</button>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/already carries a status word/);
      expect(violations[0]?.suggestion).toMatch(/DO NOT prefix/);
    });

    it("JSX: mid-text status word ('Operation failed') triggers the enrichment", () => {
      const violations = runRule(
        rule,
        `export const X = () => <span className="text-danger">Operation failed</span>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/already carries a status word/);
    });

    it("substring 'warningly' does NOT count as a status word (whole-word match)", () => {
      // If we mis-coded the anywhere regex without \b, "warningly" would
      // match "warning". Whole-word matching prevents that.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-warning">Tread warningly</span></body></html>`,
        { filePath: "substring.html" },
      );
      expect(violations).toHaveLength(1);
      // "warningly" contains "warning" but not as a whole word, so the
      // original reason applies.
      expect(violations[0]?.message).toMatch(/carries no status word/);
    });
  });

  describe("rule metadata", () => {
    it("satisfies wcag22:1.4.1 and wcag21:1.4.1", () => {
      expect(rule.satisfies).toContain("wcag22:1.4.1");
      expect(rule.satisfies).toContain("wcag21:1.4.1");
    });

    it("has a normativeQuote citing WCAG 1.4.1 Use of Color", () => {
      expect(rule.docs.normativeQuote.toLowerCase()).toContain("color");
      expect(rule.docs.references[0]).toContain("use-of-color");
    });
  });
});
