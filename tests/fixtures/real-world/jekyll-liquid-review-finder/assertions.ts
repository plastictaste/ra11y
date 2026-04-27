/**
 * jekyll-liquid-review-finder — guards review-candidate finders from
 * quoting raw Liquid/Jinja/ERB template directive tokens in their
 * emitted reason text.
 *
 * Background: the earlier fix (docs: "Q4-LIQUID-TEXT-LITERAL" +
 * "Q4-LABEL-IN-NAME-LIQUID-STRIP-MISSING") stripped template
 * directives in the rule-side text-node and attribute-harvesting paths
 * under `src/rules/**`. The review candidate finders under
 * `src/review/finders/**` were never audited — so an `<img>` with
 * `alt="{{ entry.name }}"` inside a Jekyll template still produced a
 * `review/images-of-text` candidate whose reason literally read
 *
 *   short alt text "{{ entry.name }}" is repeated in surrounding text
 *
 * quoting the Liquid expression at the agent. An agent reading that
 * reason learns nothing about the actual content the image
 * represents; it just gets confused about whether `{{ entry.name }}`
 * is the rendered text or a template token. The stripped form
 * ("" — empty after directive removal) at least teaches the agent
 * "this is entirely template-driven, read the file to decide."
 *
 * What the fixture locks in:
 *   - Zero parse errors.
 *   - review/images-of-text still fires on the 1.4.5 criterion
 *     (Surface, don't suppress — even when the alt is entirely a
 *     template expression, the surrounding-text or
 *     class-filename signal may carry the match).
 *   - No candidate's reason contains the raw `{{ entry.name }}`
 *     token (or bare `{{`, `{%`, or `<%` openers) — proving the
 *     finder-side strip is wired.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Review candidate finders strip Liquid/Jinja/ERB template directives from " +
    "harvested visible text before echoing it into the candidate's reason, so " +
    "an agent reading the reason sees the rendered-text shape instead of a " +
    "raw template expression like `{{ entry.name }}`.",
  origin: {
    notes:
      "Pairs with the closed Q4-LIQUID-TEXT-LITERAL (rule-side text nodes) " +
      "and Q4-LABEL-IN-NAME-LIQUID-STRIP-MISSING (rule-side attribute " +
      "harvesting under src/rules/semantics/** + src/rules/navigation/**). " +
      "Finder-side harvesting under src/review/finders/** was never audited " +
      "— this fixture locks the finder-side strip so the bug can't silently " +
      "return as agents grow new review finders.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // The finder still fires — surface, don't suppress. The <img>
    // carries a logo-shaped src AND the alt/sibling match via the
    // surrounding-text path (after stripping, "entry name" appears
    // both in the alt and in the trailing <span>).
    { kind: "candidate-present", criterionId: "wcag22:1.4.5" },

    // The candidate's reason must NOT echo the raw Liquid token. If
    // the finder-side strip regresses, the reason would read "short
    // alt text \"{{ entry.name }}\" is repeated in surrounding text"
    // and this assertion fails.
    {
      kind: "candidate-present-without",
      criterionId: "wcag22:1.4.5",
      reasonExcludes: "{{ entry.name }}",
    },
    {
      kind: "candidate-present-without",
      criterionId: "wcag22:1.4.5",
      reasonExcludes: "{{",
    },
  ],
};
