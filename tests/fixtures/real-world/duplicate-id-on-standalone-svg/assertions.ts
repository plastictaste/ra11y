/**
 * duplicate-id-on-standalone-svg — guards the doctrine "Parser-failure
 * invalidates per-file confidence" (extended to fragment classifications)
 * against regression on standalone `.svg` substrate emitting `parsing/
 * duplicate-id` at the wrong attention-budget level.
 *
 * Bug shape: a tutorial / lesson corpus shipped 37 emissions of
 * `parsing/duplicate-id` at `severity: error` / `confidence: high` on
 * standalone `.svg` files (canonical case: WhackAMole-style sprite
 * sheets — `dirt.svg`, `mole.svg`). Standalone SVG files commonly
 * reuse path / gradient / symbol ids across separate `<symbol>` /
 * `<defs>` / `<g>` trees as the SVG-native reuse pattern: each tree is
 * a structurally independent reuse target for `<use href="#x">`. The
 * static scanner can't tell which `<use>` resolves to which tree, so
 * the duplicate-id predicate's evidence model is bounded on this
 * substrate. Emitting at `severity: error` / `confidence: high`
 * inflates the agent's attention budget against findings that are
 * structurally unverifiable from one file.
 *
 * Closure path chosen: three layers must agree (per the AI-first
 * consumer doctrine "Parser-failure invalidates per-file confidence"
 * extension to fragment classifications and "Per-finding confidence
 * must reflect per-rule coverage limitations").
 *
 *  1. Rule emit-site (`src/rules/parsing/duplicate-id.ts`): when
 *     `ctx.filePath` ends with `.svg`, downgrade to `severity: info`,
 *     `confidence: low`, and ship the structured
 *     `fragment_input_no_document_envelope` token on
 *     `couldBeWrongBecause` so the per-finding shape concedes the
 *     SVG-native pattern. Suggestion text mentions `<symbol>` /
 *     `<defs>` / `<g>` reuse and points at the source-level
 *     `<!-- ra11y-disable parsing/duplicate-id -->` pragma for the
 *     intentional-reuse path.
 *  2. Per-rule coverage (`FRAGMENT_DOWNGRADE_RULE_IDS` in
 *     `src/mcp/scan-assembly.ts`): listing the rule there downgrades
 *     `perRuleCoverage[].coverageConfidence` to `medium` with
 *     `coverageConfidenceReason: "fragment-input-no-document-envelope"`
 *     when at least one of the rule's eligible files is in
 *     `analysisCoverage.fragmentFiles[]` (a standalone SVG is always
 *     a fragment because it lacks `<html>`/`<body>` envelopes).
 *  3. Per-finding propagation
 *     (`enrichFindingsWithPerRuleLimitations` in
 *     `src/mcp/per-finding-confidence-parity.ts`): the existing
 *     pipeline propagates the `fragment_input_no_document_envelope`
 *     code only to findings whose file is in the fragment set,
 *     keeping clean-file findings on the same rule unannotated.
 *
 * What the fixture locks in:
 *   - The rule still fires on this file (silent-miss regression guard
 *     — the doctrine surfaces, never suppresses).
 *   - The post-enrichment AgentFinding ships at `severity: info`,
 *     `confidence: low`, and carries `fragment_input_no_document_envelope`
 *     on `couldBeWrongBecause` so the agent can route on the structured
 *     code without parsing prose.
 *   - The per-rule `coverageConfidence` is `medium` with the structured
 *     fragment-input reason, matching the per-finding signal so
 *     per-rule and per-finding layers don't ship contradictory
 *     attention-budget signals on the same response.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "parsing/duplicate-id on a standalone .svg sprite sheet must surface (not be silently " +
    "suppressed) but downgrade to severity:info / confidence:low with the structured " +
    "`fragment_input_no_document_envelope` token on couldBeWrongBecause so the agent's " +
    "attention-budget signal matches the SVG-native reuse pattern across <symbol>/<defs>/<g> " +
    "trees. Per-rule coverageConfidence must agree at `medium` with the matching fragment-input " +
    "reason so per-rule and per-finding layers don't ship contradictory signals.",
  origin: {
    notes:
      "Sanitized from a tutorial / lesson corpus shipping a WhackAMole-style sprite-sheet " +
      "asset (canonical files dirt.svg, mole.svg). Standalone SVGs from icon libraries, " +
      "Figma exports, and game-asset spritesheets routinely reuse `id` values across " +
      "separate `<symbol>` / `<defs>` / `<g>` trees because each tree is an independent " +
      'reuse target for `<use href="#x">`. Pre-fix the rule emitted at `severity: error` / ' +
      "`confidence: high` on every duplicate, inflating the agent's attention budget against " +
      "findings that are structurally unverifiable from one file.",
  },
  toolInput: {
    verboseMeta: true,
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Surface-don't-suppress: the rule must still fire so the agent
    // sees the duplicate. Silent skip on standalone SVG would be
    // indistinguishable from "clean scan" and would silence real
    // referential collisions when only one `<use>` referenced the id.
    { kind: "violation-present", ruleId: "parsing/duplicate-id" },

    // Per-finding shape: post-enrichment severity must be `info`,
    // confidence must be `low`, and the structured
    // `fragment_input_no_document_envelope` token must ride on
    // `couldBeWrongBecause` so the agent's attention-budget signal
    // matches the SVG-native reuse pattern.
    {
      kind: "finding-shape",
      ruleId: "parsing/duplicate-id",
      inFile: "sprite.svg",
      severity: "info",
      confidence: "low",
      couldBeWrongBecauseIncludes: "fragment_input_no_document_envelope",
    },

    // Per-rule coverage must agree: the per-rule label downgrades to
    // `medium` with the same fragment-input reason so the agent reading
    // `meta.perRuleCoverage` sees a consistent signal with the
    // per-finding shape. The `applyFragmentInputAdjustment` adjuster in
    // `src/mcp/scan-assembly.ts` stamps the row when `parsing/
    // duplicate-id` is in `FRAGMENT_DOWNGRADE_RULE_IDS` AND at least
    // one of its eligible files is in `analysisCoverage.fragmentFiles[]`.
    {
      kind: "per-rule-coverage-confidence",
      ruleId: "parsing/duplicate-id",
      expected: "medium",
      reasonIncludes: "fragment-input-no-document-envelope",
    },
  ],
};
