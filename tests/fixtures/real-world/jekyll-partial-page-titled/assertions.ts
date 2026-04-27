/**
 * jekyll-partial-page-titled — guards `document/page-titled` against
 * emitting a confident "missing title" finding on Jekyll `_includes/`
 * head-partials whose `<title>` is rendered by a template directive
 * (`{% seo %}`, `{% include title.html %}`) rather than authored inline.
 *
 * The canonical shape is a fragment with `<html>` + `<head>` but no
 * `<body>` — the `<body>` lives in the parent layout that `{% include %}`s
 * this partial. Before this fix, the rule fired at full confidence
 * because it saw the stripped `<head>` as a "full document missing a
 * title element." The fix keeps the finding (surface-don't-suppress per
 * docs/kb/architecture/ai-first-consumer.md), but enriches it with:
 *
 *   1. `couldBeWrongBecause: ["title_may_be_template_injected"]` so an
 *      agent can route on the code without parsing prose.
 *   2. A message suffix naming the fragment shape so the agent reading
 *      the file sees the escape hatch in one read and can dismiss via
 *      `<!-- ra11y-disable document/page-titled -->` if the partial is
 *      deliberately head-only.
 *
 * What the fixture locks in:
 *   - Zero parse errors on the sanitized Jekyll head-partial.
 *   - The `document/page-titled` violation still fires (silent-miss
 *     regression guard — partial detection must NOT suppress).
 *   - The finding's message carries the template-injection signal.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "document/page-titled firing on a Jekyll head-partial (no <body> root) surfaces " +
    "with a template-injection signal on message + couldBeWrongBecause, rather than " +
    "being silently suppressed or emitted as a confident full-document finding.",
  origin: {
    notes:
      "Jekyll `_includes/head.html` (and equivalents in Hugo / Eleventy / Astro) " +
      "contains the <head> shell; the <title> is rendered by `{% seo %}` or similar. " +
      "Static analysis cannot observe the injected title, so the rule must surface " +
      "the uncertainty rather than silently suppress.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Surface-don't-suppress: the finding must still fire so the agent
    // sees the partial at all. Silent skip would be indistinguishable
    // from "clean scan" in a zero-findings response.
    { kind: "violation-present", ruleId: "document/page-titled" },

    // The message must name the escape hatch so an agent reading the
    // finding routes to the partial's parent layout (or adds the
    // deterministic source-level disable) without a second round-trip.
    {
      kind: "violation-present",
      ruleId: "document/page-titled",
      reasonIncludes: "template-injected",
    },
  ],
};
