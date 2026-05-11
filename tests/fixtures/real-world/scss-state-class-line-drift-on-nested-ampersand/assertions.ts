/**
 * scss-state-class-line-drift-on-nested-ampersand — guards positional
 * honesty of the `color/state-class-color-only` rule on multi-block
 * SCSS sources where the matched state-class selector sits inside a
 * deep nested-`&.active` form, many lines below an unrelated earlier
 * nested ruleset.
 *
 * Bug shape: a vendor-heavy CSS-framework SCSS source produced a
 * `color/state-class-color-only` finding whose reported `line` field
 * pointed at an earlier `.foo[data-popper]` ruleset rather than at
 * the actual `&.active, &:active` selector inside `.widget-item`
 * dozens of lines below. The drift was reproducibly the
 * page-distance between two siblings sharing leading tokens — the
 * sibling-`@include` blocks above the state ruleset shifted the
 * AST's ruleset-walk index off by N lines, where N matched the
 * span of the earlier nested blocks. `suggest_fix(ruleId, file, line)`
 * called on the reported line resolved to the wrong selector, and
 * `findingId` (which encodes line) was non-addressable across
 * sibling state-class selectors in the same file.
 *
 * Closure paths from doctrine ("Per-finding identifiers must be
 * addressable, not collision-prone"): the rule emits at
 * `cssRule.loc.start.line`, so the fix lives in the SCSS parser
 * (or the `walkCssRules` traversal) — whatever is producing the
 * `loc` for `&.active, &:active` rules nested under a sibling
 * block must report the actual source line of the `&.active,`
 * token, not an inherited or accumulated parent location.
 *
 * Fixture is RED (`todo: true`) until the line-drift fix lands in
 * the parser / walker. The `candidate-at-line` predicate is the
 * load-bearing assertion; the `candidate-present` predicate is a
 * sanity check that the rule fires at all on this shape.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "color/state-class-color-only must report the line of the `&.active, &:active` " +
    "selector inside `.widget-item`, not an earlier nested ruleset's line. The drift " +
    "between reported line and actual selector line breaks finding addressability — " +
    "suggest_fix and source-level disable pragmas resolve to the wrong block.",
  origin: {
    notes:
      "Multi-corpus AI-first sweep on a vendor-heavy CSS-framework SCSS source " +
      "observed `color/state-class-color-only` reporting its emit at a line that " +
      "was many rows above the actual `&.active, &:active` selector — verified by " +
      "grepping the file at the reported and actual line numbers. The synthetic " +
      "SCSS in this fixture mirrors the same multi-block + sibling-`@include` " +
      "structure that produced the drift on the real corpus.",
  },
  toolInput: {
    verboseMeta: true,
  },
  expectations: [
    // Source must parse cleanly; a parse error would mask the line-drift
    // signal and turn the assertion into a false-pass.
    { kind: "zero-parse-errors" },

    // Sanity: the rule fires at all on the `.widget-item { &.active }`
    // selector. If the rule's predicate stops matching this shape, the
    // line-drift assertion would silently pass vacuously — pin the
    // emission first so a regression that drops the finding is caught.
    {
      kind: "violation-present",
      ruleId: "color/state-class-color-only",
      inFile: "_widget-list.scss",
    },

    // Load-bearing: the cited line for the `&.active, &:active`
    // ruleset inside `.widget-item` must match its source position
    // (line 82 — the `&.active,` selector token). Drift between the
    // reported line and the source line breaks finding addressability:
    // `suggest_fix(ruleId, file, line)` resolves to the wrong selector,
    // and `findingId` (which encodes line) is non-addressable across
    // sibling state-class selectors in the same file. Per the
    // AI-first doctrine "Per-finding identifiers must be addressable,
    // not collision-prone."
    {
      kind: "violation-at-line",
      ruleId: "color/state-class-color-only",
      path: "_widget-list.scss",
      line: 82,
    },
  ],
};
