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
        `<!doctype html><html><body><span class="text-danger-emphasis">Access denied</span></body></html>`,
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
        `export const X = () => <div className="alert alert-danger">Upload rejected</div>;`,
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

    it("ancestor role='alert' satisfies the second-channel requirement on a colored child", () => {
      // Canonical Bootstrap shape: an alert region containing a colored
      // button. The parent's role="alert" carries the announcement; the
      // inner btn-danger is not the sole cue. Without the ancestor walk
      // the rule would emit at error on `Take this action`, contradicting
      // its own evidence.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div role="alert" class="alert alert-danger"><button class="btn btn-danger">Take this action</button></div></body></html>`,
        { filePath: "alert-with-nested-button.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("ancestor role='status' satisfies the second-channel requirement on a colored grandchild", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div role="status"><p><span class="text-success">Search</span></p></div></body></html>`,
        { filePath: "status-with-grandchild.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("ancestor aria-live='polite' satisfies the second-channel requirement on a colored child", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div aria-live="polite"><span class="text-warning">Search</span></div></body></html>`,
        { filePath: "ancestor-live-region.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("ancestor aria-live='off' does NOT satisfy (off means the region is not announced)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div aria-live="off"><span class="text-danger">Search</span></div></body></html>`,
        { filePath: "ancestor-live-off.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("JSX: ancestor role='alert' satisfies the second-channel requirement on a colored child", () => {
      const violations = runRule(
        rule,
        `export const X = () => <div role="alert" className="alert alert-danger"><button className="btn btn-danger">Take this action</button></div>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX: ancestor role='status' on a wrapping div satisfies the rule on a nested colored span", () => {
      const violations = runRule(
        rule,
        `export const X = () => <div role="status"><p><span className="text-success">Search</span></p></div>;`,
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

  describe("text already carries a status word (does not fire — prose is the second channel)", () => {
    // Doctrine: "Reason text and severity must agree". The earlier
    // closure rephrased the reason while still emitting; the durable
    // closure suppresses emission entirely on this branch — the text-
    // content whole-word match is deterministic evidence that color is
    // NOT the sole channel (the prose itself names the status).
    // Canonical real-world trigger: Bootstrap's own visual-test alert
    // page has `<button class="btn btn-danger">Danger</button>`.

    it("HTML: bare-word 'Danger' text passes (the prose IS the status word)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><button class="btn btn-danger">Danger</button></body></html>`,
        { filePath: "alert.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML: 'Upload failed' (status word mid-text) passes", () => {
      // "failed" is in the status-word list; the anywhere regex matches
      // it as a whole word, so the prose-channel pass condition fires.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><div class="alert alert-danger">Upload failed</div></body></html>`,
        { filePath: "upload.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("HTML: 'Access denied' (no status word) STILL fires — color is the sole channel", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-danger">Access denied</span></body></html>`,
        { filePath: "access.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/carries no status word/);
      // Suggestion leads with "prefix the visible text" — the text
      // genuinely lacks a status word, so prefixing is non-tautological.
      expect(violations[0]?.suggestion).toMatch(/prefix the visible text/);
    });

    it("JSX: <button className='btn btn-danger'>Danger</button> passes", () => {
      const violations = runRule(
        rule,
        `export const X = () => <button className="btn btn-danger">Danger</button>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("JSX: 'Operation failed' (mid-text status word) passes", () => {
      const violations = runRule(
        rule,
        `export const X = () => <span className="text-danger">Operation failed</span>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("substring 'warningly' does NOT count as a status word (whole-word gate)", () => {
      // If the anywhere regex omitted \b, "warningly" would match
      // "warning" and the rule would mistakenly pass. The whole-word
      // gate keeps the rule firing on text that lacks a real status
      // keyword — color remains the sole channel.
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-warning">Tread warningly</span></body></html>`,
        { filePath: "substring.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/carries no status word/);
    });

    it("'successor' substring does NOT pass the rule (whole-word gate)", () => {
      const violations = runRule(
        rule,
        `<!doctype html><html><body><span class="text-success">Choose a successor</span></body></html>`,
        { filePath: "successor.html" },
      );
      expect(violations).toHaveLength(1);
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
