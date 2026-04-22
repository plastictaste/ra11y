import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/label-in-name.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/label-in-name", () => {
  describe("HTML: fires when", () => {
    it("aria-label does not contain visible text", () => {
      const v = runRule(rule, `<button aria-label="Submit form">Send</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("Send");
      expect(v[0]?.message).toContain("Submit form");
    });

    it("link aria-label does not contain visible text", () => {
      const v = runRule(rule, `<a href="/home" aria-label="Navigate">Home</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("visible text is a different word entirely", () => {
      const v = runRule(rule, `<button aria-label="Close dialog">Cancel</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("aria-label contains visible text as substring", () => {
      const v = runRule(rule, `<button aria-label="Send message">Send</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("aria-label exactly matches visible text", () => {
      const v = runRule(rule, `<button aria-label="Save">Save</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("no aria-label present", () => {
      const v = runRule(rule, `<button>Click me</button>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("empty aria-label", () => {
      const v = runRule(rule, `<button aria-label="">Submit</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("no visible text (icon-only button)", () => {
      const v = runRule(rule, `<button aria-label="Close"><svg></svg></button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("non-interactive element is ignored", () => {
      const v = runRule(rule, `<div aria-label="Something">Different</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    // WCAG 2.5.3 / HTML AAM: a <select>'s accessible name is its
    // aria-label / aria-labelledby / associated <label for>, and
    // <option> descendants are the widget's VALUE set — not part of
    // its visible label. Harvesting option text would falsely fail
    // canonical patterns like Bootstrap's floating-label select.
    it("<select> ignores <option> descendant text (options are value set, not label)", () => {
      const v = runRule(
        rule,
        `<select aria-label="Floating label select example"><option selected>Open this select menu</option><option>One</option><option>Two</option><option>Three</option></select>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("aria-label does not contain visible text", () => {
      const v = runRule(rule, `const X = <button aria-label="Submit form">Send</button>;`);
      expect(v).toHaveLength(1);
    });

    it("link text is not in aria-label", () => {
      const v = runRule(rule, `const X = <a aria-label="Navigate here">Home</a>;`);
      expect(v).toHaveLength(1);
    });
  });

  describe("JSX: does NOT fire when", () => {
    it("aria-label contains visible text", () => {
      const v = runRule(rule, `const X = <button aria-label="Send email">Send</button>;`);
      expect(v).toHaveLength(0);
    });

    it("aria-label is an expression (skipped)", () => {
      const v = runRule(rule, `const X = <button aria-label={label}>Send</button>;`);
      expect(v).toHaveLength(0);
    });

    it("no visible text", () => {
      const v = runRule(rule, `const X = <button aria-label="Close" />;`);
      expect(v).toHaveLength(0);
    });

    it("<select> ignores <option> descendant text", () => {
      const v = runRule(
        rule,
        `const X = <select aria-label="Country"><option>Alpha</option><option>Beta</option></select>;`,
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("case-insensitive match passes", () => {
      const v = runRule(rule, `<button aria-label="send message">Send</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("case-insensitive mismatch still fails", () => {
      const v = runRule(rule, `<button aria-label="CLOSE">Cancel</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("suggestion includes the visible text", () => {
      const v = runRule(rule, `<button aria-label="Submit">Send</button>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain("Send");
    });
  });

  describe("whitespace normalization", () => {
    it("visible text split across lines by JSX indentation still matches aria-label", () => {
      const v = runRule(
        rule,
        `const X = <button aria-label="Save changes">\n  Save\n  changes\n</button>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("reports whitespace-normalized visible text in the message", () => {
      const v = runRule(
        rule,
        `const X = <a aria-label="Go home">\n            Home\n            Page\n          </a>;`,
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("Home Page");
      expect(v[0]?.message).not.toContain("\n");
    });

    it("suggestion mentions aria-hidden as a resolution path", () => {
      const v = runRule(rule, `<button aria-label="Submit">Send</button>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain("aria-hidden");
    });
  });

  it("cites wcag22:2.5.3 and wcag21:2.5.3", () => {
    expect(rule.satisfies).toContain("wcag22:2.5.3");
    expect(rule.satisfies).toContain("wcag21:2.5.3");
  });

  describe("template directives are stripped before compare and echo", () => {
    // Q4-LABEL-IN-NAME-LIQUID-STRIP-MISSING: attribute values are never
    // stripped at parse time, and the parser's text-node path breaks on
    // `<` — a Liquid tag like `{% if foo < 5 %}` leaks raw tokens into
    // the HtmlText. Neither failure mode should produce a finding whose
    // message or suggestion quotes raw `{%` / `{{` at the agent.
    it("aria-label containing only Liquid variable resolves to empty and skips", () => {
      const v = runRule(rule, `<a aria-label="{{ page.title }}" href="#">Home</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("Liquid tag containing '<' does not leak raw {% into echoed message", () => {
      const v = runRule(
        rule,
        `<button aria-label="Test">{% if foo < 5 %}small{% endif %}</button>`,
        { filePath: "jekyll.html" },
      );
      expect(v).toHaveLength(1);
      const msg = v[0]?.message ?? "";
      const sugg = v[0]?.suggestion ?? "";
      expect(msg).not.toContain("{%");
      expect(msg).not.toContain("{{");
      expect(sugg).not.toContain("{%");
      expect(sugg).not.toContain("{{");
      expect(msg).toContain("small");
    });

    it("aria-label with Liquid variable plus literal context is stripped for compare", () => {
      // aria-label="Search {{ query }}" renders to "Search <value>" —
      // after strip it's "Search". Visible text "Search" matches, so no
      // violation.
      const v = runRule(rule, `<button aria-label="Search {{ query }}">Search</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("ranked fix paths (deterministic fix-verify)", () => {
    it("leads with widen-aria-label by default", () => {
      const v = runRule(rule, `<button aria-label="Close dialog">Cancel</button>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toMatch(/^Primary fix: widen aria-label/);
      expect(v[0]?.suggestion).toContain("Alternatives (less likely)");
    });

    it("promotes mark-icon-hidden when visible text has an arrow glyph", () => {
      const v = runRule(rule, `<button aria-label="Next slide">→ Continue</button>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toMatch(
        /^Primary fix: if the visible text contains a decorative icon/,
      );
    });

    it("promotes mark-icon-hidden when visible text has an emoji", () => {
      const v = runRule(rule, `<button aria-label="Submit form">Send 📤</button>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toMatch(
        /^Primary fix: if the visible text contains a decorative icon/,
      );
    });

    it("always lists exactly 2 alternatives so the agent can pipe them in order", () => {
      const v = runRule(rule, `<button aria-label="Submit form">Send</button>`, {
        filePath: "index.html",
      });
      const matches = v[0]?.suggestion?.match(/\([ab]\) /g);
      expect(matches).toHaveLength(2);
    });

    it("acknowledges interleaved expansion when all visible-text words appear in aria-label in order with extras between", () => {
      // Real-world case: aria-label is an authored expansion of the visible
      // text — "Start the 8-question Perception Gap Assessment" contains
      // every word of "Start the Assessment" in order, with extras inserted.
      const v = runRule(
        rule,
        `<button aria-label="Start the 8-question Perception Gap Assessment">Start the Assessment</button>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("expanded label");
      expect(v[0]?.suggestion).toMatch(/Primary fix: rephrase aria-label/);
    });

    it("surfaces case mismatches on visible-text words (Assessment vs assessment)", () => {
      // Additive reason-text enrichment: detection is case-insensitive
      // per WCAG 2.5.3, but case divergence can matter for AT
      // pronunciation and voice-control. Surface the delta; the agent
      // decides whether this context cares.
      const v = runRule(
        rule,
        `<button aria-label="Start the 8-question Perception Gap assessment">Start the Assessment</button>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("case mismatch");
      expect(v[0]?.suggestion).toContain('"Assessment"');
    });
  });

  describe("editCandidate synthesis (non-contiguous tokens)", () => {
    // P1-L (Track Q, 2026-04-17 agent-consumer eval): when the
    // diagnosis is "visible tokens present in aria-label but non-
    // contiguous", the rule has enough signal to synthesize a concrete
    // rewrite — verbatim visible-text prefix + `": "` + remaining
    // aria-label words. Surfaced as a *candidate* (kind stays
    // "guidance"); agent decides whether to apply.
    it("populates primary.editCandidate for the non-contiguous tokens case", () => {
      const v = runRule(
        rule,
        `<button aria-label="Start the 8-question Perception Gap Assessment">Start the Assessment</button>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      const candidate = v[0]?.fixPaths?.primary.editCandidate;
      expect(candidate).toBeDefined();
      expect(candidate?.oldText).toBe(
        'aria-label="Start the 8-question Perception Gap Assessment"',
      );
      // Visible text verbatim as prefix; remaining aria-label words
      // ("8-question Perception Gap") in original order after `: `.
      // "Assessment" is dropped because it already appears in the
      // visible text (case-insensitive dedupe).
      expect(candidate?.newText).toBe(
        'aria-label="Start the Assessment: 8-question Perception Gap"',
      );
    });

    it("synthesizes for a two-word interleaved expansion", () => {
      // Visible "Save changes" tokens both appear in aria-label in
      // order, but with "your" inserted between them — classic
      // interleaved expansion, non-contiguous substring. Synthesis
      // rule: visible text verbatim + ": " + remaining aria-label
      // words ("your") after dropping words that overlap the visible
      // text.
      const v = runRule(rule, `<button aria-label="Save your changes now">Save changes</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const candidate = v[0]?.fixPaths?.primary.editCandidate;
      expect(candidate).toBeDefined();
      expect(candidate?.oldText).toBe('aria-label="Save your changes now"');
      expect(candidate?.newText).toBe('aria-label="Save changes: your now"');
    });

    it("omits editCandidate when the diagnosis is not non-contiguous tokens", () => {
      // Visible text "Cancel" is absent from aria-label "Close dialog"
      // entirely — not an interleaved expansion. The rule cannot
      // synthesize a sensible rewrite, so `editCandidate` is omitted
      // (not emitted as `""`). Per CLAUDE.md §1 "Ambiguous field
      // shapes are dishonest".
      const v = runRule(rule, `<button aria-label="Close dialog">Cancel</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.fixPaths?.primary.editCandidate).toBeUndefined();
      // Also assert the field is truly absent rather than set to an
      // empty pair — the test above proves `.editCandidate` reads as
      // undefined; this asserts the key is not present on the object
      // at all, matching the conditional-spread emit.
      expect(Object.hasOwn(v[0]?.fixPaths?.primary ?? {}, "editCandidate")).toBe(false);
    });

    it("kind stays guidance — no mechanical edit on editCandidate", () => {
      // The rule does not populate `edit` (mechanical), only
      // `editCandidate` (softer). The suggest_fix payload builder
      // treats this as `kind: "guidance"`.
      const v = runRule(
        rule,
        `<button aria-label="Start the 8-question Perception Gap Assessment">Start the Assessment</button>`,
        { filePath: "index.html" },
      );
      expect(v[0]?.fixPaths?.primary.edit).toBeUndefined();
      expect(v[0]?.fixPaths?.primary.editCandidate).toBeDefined();
    });
  });

  describe("user-authored echo is size-capped", () => {
    // Regression invariant for V1-SIZE-LABEL-ECHO-CAP: Bootstrap's
    // floating-label.html had a 1.5 KB lorem-ipsum label that got
    // echoed verbatim twice per finding, inflating a single-file scan
    // response by tens of KB. The rule now caps user-authored visible
    // text and aria-label echoes before interpolating them into the
    // agent-visible `message` / `suggestion` strings. Unit coverage
    // for the helper itself lives in
    // tests/unit/engine/truncate-for-echo.test.ts — this test asserts
    // the rule actually calls through to the cap, without rehearsing
    // the mechanics.
    it("does not echo the full visible text verbatim when it exceeds the 200-char cap", () => {
      const longVisible = `The ${"quick ".repeat(60)}fox`; // ~400 chars.
      const v = runRule(rule, `<button aria-label="Submit form">${longVisible}</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      const message = v[0]?.message ?? "";
      const suggestion = v[0]?.suggestion ?? "";
      // The full string is longer than the cap, so neither field
      // should contain the closing "fox" from the far end — that
      // proves a truncation happened rather than asserting a specific
      // slice offset.
      expect(longVisible.length).toBeGreaterThan(200);
      expect(message).not.toContain(`${longVisible}`);
      expect(suggestion).not.toContain(`${longVisible}`);
      // And the ellipsis sentinel shows up where the truncation landed.
      expect(message).toContain("\u2026");
    });

    it("does not echo the full aria-label verbatim when it exceeds the cap", () => {
      const longAria = `Please ${"review ".repeat(60)}the form`; // ~430 chars.
      const v = runRule(rule, `<button aria-label="${longAria}">Send</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(longAria.length).toBeGreaterThan(200);
      expect(v[0]?.message ?? "").not.toContain(longAria);
      expect(v[0]?.suggestion ?? "").not.toContain(longAria);
    });
  });
});
