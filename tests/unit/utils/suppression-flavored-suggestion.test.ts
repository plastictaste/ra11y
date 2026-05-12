/**
 * Unit tests for the `isSuppressionFlavoredSuggestion` predicate.
 *
 * Doctrine — `docs/kb/architecture/ai-first-consumer.md`
 * "Suppress-recommended is a distinct discriminator from guidance":
 * the predicate must require BOTH (a) the prose names the pragma
 * token AND (b) the primary sentence does NOT lead with a positive-
 * edit verb. The second leg is the tightening — rules whose
 * primary advice IS a concrete edit but whose suggestion ALSO names
 * `ra11y-disable` as a trailing fallback must stay on the rule's
 * declared lane, not silently misroute to the suppress-recommended
 * lane.
 *
 * These cases keep the predicate honest at the string level
 * independent of any rule's emission shape — when a rule's prose
 * evolves, only the predicate's call sites need to behave the same
 * way (the predicate's invariants stay pinned here).
 */

import { describe, expect, it } from "bun:test";

import { isSuppressionFlavoredSuggestion } from "../../../src/utils/suppression-flavored-suggestion.ts";

describe("isSuppressionFlavoredSuggestion — necessary tokens", () => {
  it("returns false when the prose contains no pragma token", () => {
    expect(isSuppressionFlavoredSuggestion('Add alt="" to the decorative <img>.')).toBe(false);
  });

  it("returns false on undefined", () => {
    expect(isSuppressionFlavoredSuggestion(undefined)).toBe(false);
  });

  it("returns false on the empty string", () => {
    expect(isSuppressionFlavoredSuggestion("")).toBe(false);
  });
});

describe("isSuppressionFlavoredSuggestion — positive-edit verb guard", () => {
  // Mirrors the `aria/dropdown-toggle-triple-aria-missing` regression:
  // primary advice is "Add aria-haspopup…" with a trailing pragma
  // fallback. The predicate must NOT classify this as suppression-
  // flavored — the primary remediation is a real attribute edit.
  it("returns false when primary sentence leads with 'Add' (positive-edit verb) even with trailing pragma", () => {
    const suggestion =
      'Add aria-haspopup="menu" and aria-controls="<menu-id>" to the <button>. ' +
      "If this control is not actually a dropdown trigger, suppress with a source-level pragma " +
      "(e.g. <!-- ra11y-disable aria/dropdown-toggle-triple-aria-missing -->).";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(false);
  });

  // Mirrors the `semantics/heading-hierarchy` `reportMissingH1OnFullPage`
  // emit — primary advice "Insert an <h1>…" with a trailing pragma.
  // Must stay on the rule's declared lane.
  it("returns false when primary sentence leads with 'Insert' even with trailing pragma", () => {
    const suggestion =
      "Insert an <h1> at the top of <body> that names the page. " +
      "If this page is rendered inside a parent layout that supplies the title, " +
      "suppress with <!-- ra11y-disable wcag22:1.3.1 -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(false);
  });

  it("returns false when primary sentence leads with 'Drop' even with trailing pragma", () => {
    const suggestion =
      "Drop the redundant role. " +
      "If this control is not the host element, suppress with <!-- ra11y-disable aria/redundant-role -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(false);
  });

  it("returns false when primary sentence leads with 'Set' even with trailing pragma", () => {
    const suggestion =
      "Set min-width: 44px and min-height: 44px on the target. " +
      "If the control is inline within prose, suppress with <!-- ra11y-disable pointer/target-size -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(false);
  });

  it("returns false when primary sentence leads with 'Replace' even with trailing pragma", () => {
    const suggestion =
      "Replace `outline: none` with a custom focus indicator. " +
      "If using Tailwind's focus-visible utilities, suppress with <!-- ra11y-disable focus/outline-visible -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(false);
  });

  it("returns false when primary sentence leads with 'Provide' even with trailing pragma", () => {
    const suggestion =
      "Provide a text alternative for the audio element. " +
      "If the audio is purely decorative, suppress with <!-- ra11y-disable media/audio-controls-or-transcript-missing -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(false);
  });

  it("returns false when primary sentence leads with 'Either' (branching edit) even with trailing pragma", () => {
    const suggestion =
      "Either set min-width: 44px or add padding to reach a 44×44 target. " +
      "If inline, suppress with <!-- ra11y-disable pointer/target-size -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(false);
  });

  it("matches positive-edit verbs case-insensitively", () => {
    const suggestion =
      "ADD aria-haspopup='menu' to the button. If not a dropdown, suppress with <!-- ra11y-disable -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(false);
  });

  it("does NOT match positive-edit verbs as prefixes of longer words", () => {
    // "Address" / "Adding" / "Adds" should not match "add".
    // "Setting" / "Sets" should not match "set".
    // "Changes" should not match "change".
    // Primary sentence has no positive-edit verb leading → predicate
    // routes to suppress-recommended (token present, no positive lead).
    const suggestion =
      "Address the missing aria-label by reading the spec. " +
      "Verify the page outline then suppress with <!-- ra11y-disable wcag22:1.3.1 -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(true);
  });
});

describe("isSuppressionFlavoredSuggestion — true suppression-flavored shapes", () => {
  // The canonical conceded-N/A case from `semantics/heading-hierarchy`
  // `reportMissingH1`: primary sentence is descriptive ("A document
  // without an <h1> loses…"), no positive-edit verb, trails with the
  // pragma reference.
  it("returns true when primary sentence is descriptive and prose names ra11y-disable", () => {
    const suggestion =
      "A document without an <h1> loses the single top-of-document landmark AT relies on; " +
      "verify the page has a designated main heading via <h1> or role=\"heading\" aria-level=\"1\". " +
      "If this page is a fragment or layout intentionally rendered inside a parent with its own <h1>, " +
      "suppress with <!-- ra11y-disable wcag22:1.3.1 -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(true);
  });

  it("returns true on a 'verify-first' primary sentence + pragma reference", () => {
    const suggestion =
      "Verify the page outline matches the rendered output. " +
      "If the composed layout supplies the heading, suppress with <!-- ra11y-disable wcag22:1.3.1 -->.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(true);
  });

  it("returns true on 'If this is X…' primary clause + pragma", () => {
    const suggestion =
      "If this is a layout wrapper or template partial, the <main> may be authored in the included file. " +
      "Use a <!-- ra11y-disable semantics/landmark-main --> pragma if the composition is deliberate.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(true);
  });

  it("returns true when the prose uses 'suppress with' instead of 'ra11y-disable'", () => {
    // The token "suppress with" alone also fires the pragma-token leg
    // (rules sometimes phrase the fallback without inlining the
    // pragma form literally). Combined with no positive-edit verb in
    // the primary sentence, the predicate still partitions.
    const suggestion =
      "A document without a heading hierarchy loses navigation landmarks; " +
      "consult the parent layout. If composed externally, suppress with a source-level pragma.";
    expect(isSuppressionFlavoredSuggestion(suggestion)).toBe(true);
  });
});
