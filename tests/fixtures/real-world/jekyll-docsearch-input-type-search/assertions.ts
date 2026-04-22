/**
 * jekyll-docsearch-input-type-search — guards `forms/autocomplete-missing`
 * against misfiring on site-search `<input>` controls.
 *
 * WCAG SC 1.3.5 Identify Input Purpose enumerates 53 semantic purposes
 * (the autocomplete-attribute token list). "search" is NOT one of them —
 * free-form query inputs are out of scope for the criterion entirely.
 * Flagging a site-search box as needing an autocomplete token is
 * spec-incorrect, not a heuristic choice: there is no valid token the
 * fix would add.
 *
 * Field report origin: Jekyll `docs/_includes/header.html` shipped a
 * docsearch `<input type="search" aria-label="Search">` where the
 * surrounding form context made `id="docsearch-input"` tokenize against
 * the id-heuristic map; the rule fired with a `autocomplete="email"`
 * suggestion because `search-user-email` id would match the `email`
 * needle and the type="search" escape in matchPurpose let search-typed
 * inputs fall through to the name/id branch. The fix scopes the rule
 * OUT when ANY of these search signals is present:
 *
 *   (a) `type="search"`
 *   (b) `role="searchbox"`
 *   (c) `name | id | aria-label` tokenizes to include `search`,
 *       `query`, or a standalone `q`
 *
 * This is spec-correctness, not heuristic suppression: the criterion
 * does not apply, so no candidate is owed. Per
 * docs/kb/architecture/ai-first-consumer.md, "Surface, don't suppress"
 * applies when the criterion DOES apply and evidence is thin; here the
 * criterion does not apply at all.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "forms/autocomplete-missing does not fire on site-search inputs — type=\"search\", " +
    "role=\"searchbox\", or name/id/aria-label matching search tokens — because WCAG " +
    "1.3.5 Input Purposes does not enumerate \"search\" as a purpose.",
  origin: {
    notes:
      "Jekyll docs/_includes/header.html ships `<input type=\"search\" aria-label=\"Search\">` " +
      "for docsearch. The rule was firing on similar patterns where a name/id heuristic " +
      "matched (e.g. `id=\"search-user-email\"` triggering the email needle) because the " +
      "matchPurpose carve-out `type !== \"search\"` let search-typed inputs fall through " +
      "to the name/id branch. The autocomplete-token set has no entry for search; flagging " +
      "is spec-incorrect, not a noise-reduction tradeoff.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Primary invariant: none of the search-shaped inputs should surface a
    // forms/autocomplete-missing finding. The fixture carries four variants
    // (type=search + name=q, name=searchQuery, id=search-input,
    // role=searchbox + name=q) so any future regression on a single guard
    // still trips the assertion.
    { kind: "no-violation", ruleId: "forms/autocomplete-missing" },
  ],
};
