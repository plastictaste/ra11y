/**
 * Tests for `deriveApproachFromProse` — the sentence-splitter behind
 * the `kind: "guidance"` `primary.approach` label. The historical bug:
 * fix prose containing common abbreviations (`e.g.`, `i.e.`, `vs.`,
 * `etc.`, `cf.`, `viz.`) truncated mid-clause because the splitter
 * read the abbreviation's inner period as a sentence terminator.
 */

import { describe, expect, it } from "bun:test";

import { deriveApproachFromProse } from "../../../src/mcp/suggest-fix-guidance-shape.ts";

describe("deriveApproachFromProse — abbreviation handling", () => {
  it("does not break on the inner period of e.g.", () => {
    const out = deriveApproachFromProse("Try a sibling — e.g. add aria-label to the icon.");
    // Must not be `Try a sibling — e` (the bug).
    expect(out).not.toBe("Try a sibling — e");
    expect(out.startsWith("Try a sibling — e.g")).toBe(true);
  });

  it("does not break on i.e. mid-clause", () => {
    const out = deriveApproachFromProse(
      'Set the role explicitly — i.e. role="button" — when needed.',
    );
    expect(out).not.toBe("Set the role explicitly — i");
    expect(out.includes("i.e")).toBe(true);
  });

  it("does not break on vs.", () => {
    const out = deriveApproachFromProse("Use semantic html vs. ARIA hacks");
    expect(out).toBe("Use semantic html vs. ARIA hacks");
  });

  it("does not break on etc.", () => {
    const out = deriveApproachFromProse("Add headings, labels, etc. to the form");
    expect(out).toBe("Add headings, labels, etc. to the form");
  });

  it("does not break on cf.", () => {
    const out = deriveApproachFromProse("Prefer button cf. div with onClick");
    expect(out).toBe("Prefer button cf. div with onClick");
  });

  it("does not break on viz.", () => {
    const out = deriveApproachFromProse("Use ARIA states viz. aria-expanded");
    expect(out).toBe("Use ARIA states viz. aria-expanded");
  });

  it("treats abbreviations case-insensitively", () => {
    const out = deriveApproachFromProse("Choose I.E. the canonical landmark element");
    expect(out).not.toBe("Choose I");
    expect(out.includes("I.E")).toBe(true);
  });

  it("still terminates on a real sentence-ending period", () => {
    const out = deriveApproachFromProse(
      "Add aria-label to the button. The icon child needs aria-hidden.",
    );
    expect(out).toBe("Add aria-label to the button");
  });

  it("still terminates on `?`", () => {
    const out = deriveApproachFromProse("Is this a button? Add role.");
    expect(out).toBe("Is this a button");
  });

  it("still terminates on `!`", () => {
    const out = deriveApproachFromProse("Always label form fields! It is required.");
    expect(out).toBe("Always label form fields");
  });

  it("still terminates on a newline", () => {
    const out = deriveApproachFromProse(
      "Set the lang attribute on html\nThe lang must be valid BCP-47",
    );
    expect(out).toBe("Set the lang attribute on html");
  });

  it("does not match abbreviation when preceded by a letter", () => {
    // "scIENCE." should not be confused for an "i.e." substring.
    const out = deriveApproachFromProse("In scIENCE.geography we discuss this");
    // The period after scIENCE should still terminate (no boundary to abbr).
    expect(out).toBe("In scIENCE");
  });

  it("returns the whole prose when no terminator is found", () => {
    const out = deriveApproachFromProse("A short label without periods");
    expect(out).toBe("A short label without periods");
  });

  it("returns the full first sentence when it exceeds 80 chars (no trailing ellipsis)", () => {
    // Prior behavior capped at 80 chars and appended `…`. That made
    // the field indistinguishable from authored ellipses (e.g. rule
    // prose like `aria-label="…"` placeholders) — see doctrine
    // "Ambiguous field shapes are dishonest." Closure: drop the cap;
    // the full prose lives in `primary.explanation` alongside.
    const long =
      "This is a deliberately long single-sentence explanation that goes on past eighty characters total without a terminating period inside the threshold";
    const out = deriveApproachFromProse(long);
    expect(out).toBe(long);
    expect(out.endsWith("…")).toBe(false);
  });

  it("strips a trailing terminator when the candidate fits", () => {
    const out = deriveApproachFromProse("Short sentence.");
    expect(out).toBe("Short sentence");
  });
});

describe("deriveApproachFromProse — no trailing-ellipsis truncation", () => {
  // Doctrine: trailing `…` without a sentinel is dishonest because
  // authored ellipses appear in rule prose (e.g. `aria-label="…"`
  // placeholders) and the agent cannot distinguish authored content
  // from clipping. The function must NEVER append `…` to the shipped
  // label — when the first sentence is too long, return it verbatim;
  // `primary.explanation` carries the full prose alongside either way.

  it("never appends an ellipsis suffix on long no-terminator prose", () => {
    // Canonical regression input — used to truncate at 80 chars with
    // a trailing `…`. The new contract: return the full prose as-is.
    // Uses the `…` glyph (single char, authored placeholder) so the
    // sentence-splitter sees no terminator within the horizon.
    const long =
      'Add aria-controls="<panel-id>" to <button>, where <panel-id> matches the id on the matching <… role="tabpanel" id="<panel-id>">';
    const out = deriveApproachFromProse(long);
    // The result preserves the authored `…` mid-string but must NOT
    // append a clipping `…` of its own.
    expect(out.includes("matches the id on the matching <…")).toBe(true);
    expect(out).toBe(long);
    // The input does not end in `…`; the function must not add one.
    expect(out.endsWith("…")).toBe(false);
  });

  it("never appends an ellipsis suffix on long single-token prose", () => {
    // Single-token prose with no whitespace to walk back to. The old
    // implementation appended `…`. New contract: return it verbatim.
    const prose = "a".repeat(150);
    const out = deriveApproachFromProse(prose);
    expect(out.endsWith("…")).toBe(false);
    expect(out).toBe(prose);
  });

  it("preserves authored ellipses inside prose but never adds a trailing one", () => {
    // Authored ellipsis is a placeholder for content the author wants
    // the reader to substitute (e.g. `aria-label="…"`). The function
    // must not add another `…` on top, which would be indistinguishable
    // from clipping.
    const prose = 'Set aria-label="…" on the <button> element';
    const out = deriveApproachFromProse(prose);
    expect(out).toBe(prose);
    // Authored ellipsis is preserved mid-string.
    expect(out.includes('aria-label="…"')).toBe(true);
    // No appended trailing ellipsis.
    expect(out.endsWith("…")).toBe(false);
  });

  it("does not return a single backtick when the splitter lands on early punctuation", () => {
    // Canonical regression: prose like `?expr` ... had the splitter
    // return a 2-char candidate (`?), the trailing-terminator strip
    // reduced it to one char (`). Falls back to the full prose now
    // rather than emitting the degenerate single-char slice.
    const prose =
      "`?expression evaluates to true` is the substring the rule fires on; widen the test predicate to cover both branches and make the assertion explicit.";
    const out = deriveApproachFromProse(prose);
    expect(out).not.toBe("`");
    expect(out.length).toBeGreaterThan(1);
    expect(out.endsWith("…")).toBe(false);
  });

  it("returns even backtick parity on long backtick-bearing prose", () => {
    // The label must not leave a stray opening backtick. With no
    // truncation in play, the full prose preserves the pair.
    const prose =
      "Promote this element to the canonical landmark via the `<button>` element so assistive tech announces it correctly across every supported screen reader and keyboard mode.";
    const out = deriveApproachFromProse(prose);
    const tickCount = (out.match(/`/g) ?? []).length;
    expect(tickCount % 2).toBe(0);
    expect(out.endsWith("…")).toBe(false);
  });

  it("invariant: no input produces a result that ends in a trailing ellipsis suffix", () => {
    // The load-bearing assertion the doctrine pins. Sweep a range of
    // inputs that previously hit the `…`-appending paths and confirm
    // none of them ship a trailing ellipsis. Authored ellipses inside
    // the prose are unaffected; the invariant is on the suffix only.
    const inputs: readonly string[] = [
      "Short.",
      "Add aria-label to the link",
      `${"word ".repeat(20)}continues past the cap without a terminator`,
      "a".repeat(120),
      'Set aria-label="…" on the <a> element to provide an accessible name for screen readers',
      "Add an accessible name to the link: set aria-label, or add a visible text child to the anchor",
      "Use semantic html vs. ARIA hacks etc. for the canonical pattern",
    ];
    for (const input of inputs) {
      const out = deriveApproachFromProse(input);
      // The invariant: result NEVER ends in a clipping ellipsis. If a
      // future implementation reintroduces clipping, it must rename the
      // field (e.g. `approachHeadline`) and pair with a `truncated`
      // sentinel; emitting `…` on the wire without that pairing fails
      // "Ambiguous field shapes are dishonest."
      expect(out.endsWith("…")).toBe(false);
    }
  });
});
