/**
 * jekyll-page-titled-liquid-strip — guards `document/page-titled`
 * against emitting a confident "empty <title>" error on Jekyll layouts
 * whose `<title>` body is a pure Liquid interpolation
 * (`<title>{{ page.title }}</title>`).
 *
 * The in-house HTML parser strips template-directive spans from text
 * nodes so rules consuming visible text operate on the rendered-text
 * shape. For pages/layouts whose entire `<title>` body is a directive,
 * the post-strip text is empty — but static analysis has no way to
 * know what the runtime value will be. The pre-fix behaviour emitted
 * the generic `MESSAGE_EMPTY` error at full confidence, which was a
 * false positive on every Jekyll site.
 *
 * The fix keeps the finding surfaced (surface-don't-suppress per
 * docs/kb/architecture/ai-first-consumer.md), but:
 *
 *   1. Downgrades severity from `error` to `warning` — honest
 *      reflection of the weaker evidence (the "empty" claim is only
 *      true of the stripped shape, not the rendered output).
 *   2. Swaps the message to "title is template-interpolated — verify
 *      the rendered output carries a non-empty title" so the agent
 *      reading the file sees the uncertainty in one read.
 *   3. Adds `couldBeWrongBecause: ["title_is_template_interpolated"]`
 *      as structured telemetry the agent can route on without parsing
 *      prose.
 *
 * Distinct from jekyll-partial-page-titled (Q4-PARTIAL-PAGE-TITLED):
 * that fixture guards partials missing `<body>` where `<title>` might
 * be injected from a parent layout. This fixture guards layouts whose
 * `<title>` IS present with a directive inside.
 *
 * What the fixture locks in:
 *   - Zero parse errors on the Jekyll layout.
 *   - The `document/page-titled` finding still fires (silent-miss guard).
 *   - The message carries the template-interpolation signal.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "document/page-titled on a Jekyll layout whose <title> body is a pure Liquid " +
    "interpolation surfaces as a weaker-confidence warning with the " +
    "title_is_template_interpolated signal, rather than a confident empty-title error.",
  origin: {
    notes:
      "Jekyll `_layouts/default.html` with `<title>{{ page.title }}</title>` parses with " +
      "an empty in-memory title-text (directive stripped). Pre-fix, page-titled fired a " +
      "confident empty-title error. Post-fix, the finding surfaces as a warning with the " +
      "title_is_template_interpolated couldBeWrongBecause code so the agent knows the " +
      "claim was made against the stripped shape and the rendered value requires " +
      "verification at the source.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Surface-don't-suppress: the finding must still fire so the agent
    // sees the layout at all. Silent skip would be indistinguishable
    // from "clean scan" in a zero-findings response.
    { kind: "violation-present", ruleId: "document/page-titled" },

    // The message must name the template-interpolation uncertainty so
    // the agent reading the finding routes to the source file without
    // a second round-trip.
    {
      kind: "violation-present",
      ruleId: "document/page-titled",
      reasonIncludes: "template-interpolated",
    },
  ],
};
