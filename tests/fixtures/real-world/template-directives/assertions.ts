/**
 * template-directives — guards the explicit handling note that ships
 * alongside detected interpolation tokens.
 *
 * The handling field emits plain-English text explaining that the HTML
 * parser treats `{% ... %}`, `{{ ... }}`, and `<% ... %>` tokens as
 * literal text — the rendered output is not reconstructed and cross-
 * template `extends`/`include` relationships are not resolved.
 *
 * Two source files exercise distinct token shapes:
 *   - base.jinja.html: control-block tokens (`{% extends %}`,
 *     `{% block %}`, `{% if %}`, `{% for %}`) + bare double-brace
 *     interpolation. Surfaces `{%x%}` and `{{x}}` tokens.
 *   - partial.html: bare double-brace interpolation only (`{{ }}`).
 *     Surfaces the `{{x}}` token alone.
 *
 * The assertions lock in:
 *   1. Zero parse errors — the HTML parser must accept template-token
 *      syntax without producing a broken AST.
 *   2. The handling field is present under analysisCoverage.
 *   3. The phrase "parsed as literal" appears — if a future refactor
 *      changes the description to imply rendered analysis, this fails.
 *   4. The phrase "rendered output is not reconstructed" appears — the
 *      honest "we do NOT render" signal that agents use for confidence.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "HTML templates with control-block and double-brace interpolation tokens produce " +
    "meta.analysisCoverage.templateDirectiveHandling containing 'parsed as literal' " +
    "and 'rendered output is not reconstructed', with zero parse errors.",
  origin: {
    commit: "a554d27",
    notes:
      "feat(mcp): actionable hints and explicit template-directive handling. The handling " +
      "field replaces the silent token list with an explicit statement that interpolation " +
      "tokens are parsed as literal text.",
  },
  expectations: [
    // The HTML parser must not error on template-directive syntax. If the
    // parser emits errors on `{% %}` or `{{ }}`, rules run on a broken AST
    // and the coverage telemetry is unreliable.
    { kind: "zero-parse-errors" },

    // The handling field must be present whenever template engines are
    // detected. Absence means the a554d27 telemetry regressed.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "templateDirectiveHandling"],
      predicate: "present",
    },

    // "parsed as literal" is the load-bearing phrase — it tells the agent
    // the scanner did NOT attempt rendering or execution of directives.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "templateDirectiveHandling"],
      predicate: { contains: "parsed as literal" },
    },

    // "rendered output is not reconstructed" is the explicit honesty signal.
    // If this changes to something implying rendered analysis, this fails.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "templateDirectiveHandling"],
      predicate: { contains: "rendered output is not reconstructed" },
    },
  ],
};
