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

  it("trims and ellipsis-truncates when the first sentence exceeds 80 chars", () => {
    const long =
      "This is a deliberately long single-sentence explanation that goes on past eighty characters total without a terminating period inside the threshold";
    const out = deriveApproachFromProse(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("strips a trailing terminator when the candidate fits", () => {
    const out = deriveApproachFromProse("Short sentence.");
    expect(out).toBe("Short sentence");
  });
});
