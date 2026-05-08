/**
 * scss-line-comment-selector-leak — guards SCSS parser selector
 * faithfulness across `//` line-comment bodies that contain a
 * block-comment terminator sequence (`* /` written without the space
 * in real source).
 *
 * Origin: a real SCSS source where a line-comment body contained the
 * block-comment-terminator sequence followed by selector-shaped text
 * (commonly used in SCSS partials as JSDoc-ish prose referencing CSS
 * code). The parser preprocessed line comments into block-comment
 * form in place, leaving the embedded terminator inside the body
 * intact. The synthetic block comment closed at the embedded
 * terminator, exposing the rest of the body — and everything up to
 * the next `{` — to the downstream CSS parser as selector text. The
 * `color/state-class-color-only` rule then fired with a message
 * containing line-comment lead text concatenated with an unrelated
 * remote selector.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md — parser
 * correctness is non-negotiable. Selector text MUST be a faithful
 * slice of the source, never concatenated across comment boundaries.
 *
 * Closure: SCSS preprocessor strips `//` line comments to whitespace
 * before token streaming (instead of rewriting in place to a block
 * comment that can close prematurely on an embedded terminator).
 * Pinned by the unit-level "does not bleed `//` line-comment body"
 * test in `tests/unit/input/parsers/scss.test.ts` and by the
 * `violation-present-without` expectations below.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Guards SCSS parser selector text against bleed from `//` line-comment bodies " +
    "that contain a block-comment terminator. Each emerging selector must be a " +
    "faithful slice of the source — never concatenated with comment-body content " +
    "or unrelated downstream selectors.",
  origin: {
    notes:
      "Sanitized excerpt of a Bootstrap-style `_dropdown.scss` partial whose `//` " +
      "comment body contained a block-comment terminator followed by selector-" +
      "shaped text. The bug rewrote the line comment in place, leaving the " +
      "terminator inside the body and closing the synthetic block comment early " +
      "— the rest of the comment leaked into the next ruleset's selector context.",
  },
  expectations: [
    // The fixture must parse cleanly post-fix. A parse error would mask
    // selector contamination by aborting the rule walk.
    { kind: "zero-parse-errors" },

    // The `color/state-class-color-only` rule fires legitimately on
    // `.dropdown-item.active` (a state-marker selector with only color
    // declarations). Surfacing must continue (per AI-first doctrine —
    // surface, don't suppress); the regression is in the message content,
    // not in whether the rule fires.
    {
      kind: "violation-present",
      ruleId: "color/state-class-color-only",
      reasonIncludes: ".dropdown-item.active",
    },

    // Load-bearing invariant: no violation message may contain
    // comment-body fragments. A regression that re-introduces the
    // bleed will surface here even when the clean selector substring
    // still happens to appear inside the contaminated selector.
    {
      kind: "violation-present-without",
      ruleId: "color/state-class-color-only",
      reasonExcludes: "// For",
    },
    {
      kind: "violation-present-without",
      ruleId: "color/state-class-color-only",
      // Block-comment terminator sequence — encoded via concatenation
      // so the JSDoc above isn't terminated mid-sentence.
      reasonExcludes: `${"*"}/`,
    },
  ],
};
