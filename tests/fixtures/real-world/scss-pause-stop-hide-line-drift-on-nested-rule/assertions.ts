/**
 * scss-pause-stop-hide-line-drift-on-nested-rule — guards positional
 * honesty of the `motion/pause-stop-hide` rule on the multi-block
 * sibling preamble SCSS shape that previously drifted CSS-rule-emit
 * lines for other rules. The shared SCSS flatten / `walkCssRules`
 * traversal was where the bug lived; once the parser's line-counter
 * pass began preserving source positions in synthesized selector
 * envelopes, every rule emitting at `cssRule.loc.start.line` (not
 * just `color/state-class-color-only`) recovered honest lines on this
 * shape.
 *
 * Bug shape mirror: a Bootstrap-style `_placeholders.scss` source
 * contained ~80 lines of sibling rulesets and nested-`&` blocks
 * above a `.placeholder-glow { .placeholder { animation: ... } }`
 * block. The flattened output for `.placeholder-glow .placeholder`
 * landed at whatever line the previous sibling block ended at —
 * tens of lines off from the actual nested-selector position in the
 * source. `motion/pause-stop-hide` then reported the animation at
 * the wrong line, breaking the per-finding addressability contract
 * (`findingId` hashes location; `suggest_fix(ruleId, file, line)`
 * resolves by line; source-level disable pragmas anchor by line).
 *
 * Closure: the SCSS flatten phase now pads `out` with `\n` chars
 * until `outLine` matches the source line of the selector that
 * produced this rule, at every selector-emit site (synthesized
 * `parent { … }` envelope in `flushDecls`, at-rule header path in
 * `handleNestedBlock`). This fixture pins the property so a future
 * parser refactor cannot silently drift the cited line for
 * non-state-class rules on the same shape.
 *
 * Doctrine reference: "Per-finding identifiers must be addressable,
 * not collision-prone" (`docs/kb/architecture/ai-first-consumer.md`).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "motion/pause-stop-hide must report the line of the nested `.placeholder` " +
    "selector inside `.placeholder-glow`, not an earlier sibling ruleset's " +
    "line. Multi-corpus observation found CSS-rule-emit line drift was not " +
    "specific to one rule — the shared SCSS flatten / walkCssRules traversal " +
    "produced the drift, so any rule emitting at `cssRule.loc.start.line` " +
    "would mis-cite on this shape.",
  origin: {
    notes:
      "Multi-corpus AI-first sweep observed `motion/pause-stop-hide` " +
      "reporting `.placeholder-glow .placeholder` at the line of an earlier " +
      "sibling block, with the actual selector dozens of lines below. The " +
      "synthetic SCSS in this fixture mirrors the Bootstrap-style " +
      "`_placeholders.scss` shape (multi-block sibling preamble plus a " +
      "nested-`&` block before the placeholder-glow block) that triggered " +
      "the same drift class observed on `color/state-class-color-only`.",
  },
  expectations: [
    // Source must parse cleanly; a parse error would mask the line-drift
    // signal and turn the assertion into a false-pass.
    { kind: "zero-parse-errors" },

    // Sanity: the rule fires at all on the nested `.placeholder-glow
    // .placeholder` selector. If the rule's predicate stops matching this
    // shape, the line-drift assertion would silently pass vacuously — pin
    // the emission first so a regression that drops the finding is caught.
    {
      kind: "violation-present",
      ruleId: "motion/pause-stop-hide",
      inFile: "_placeholders.scss",
    },

    // Load-bearing: the cited line for `.placeholder-glow .placeholder`
    // must match its source position (line 94 — the inner `.placeholder`
    // selector token). Drift between the reported line and the source
    // line breaks finding addressability: `suggest_fix(ruleId, file,
    // line)` resolves to the wrong selector, and `findingId` (which
    // encodes line) is non-addressable across CSS-rule-emit rules in the
    // same file. Per the AI-first doctrine "Per-finding identifiers must
    // be addressable, not collision-prone."
    {
      kind: "violation-at-line",
      ruleId: "motion/pause-stop-hide",
      path: "_placeholders.scss",
      line: 94,
    },

    // Companion: the sibling `.placeholder-wave` selector at line 81
    // must also land at its source line. Two rule emissions in the same
    // file must each address a distinct, honest source line — pinning
    // both rules out collision on `findingId` between the two
    // animation-emitting rules in the same file.
    {
      kind: "violation-at-line",
      ruleId: "motion/pause-stop-hide",
      path: "_placeholders.scss",
      line: 81,
    },
  ],
};
