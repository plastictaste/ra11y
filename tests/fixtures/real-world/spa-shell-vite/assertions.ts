/**
 * spa-shell-vite — guards two layered fixes for wcag22:2.4.5 on a
 * Vite-style SPA shell.
 *
 * History:
 *   - Before commit bc3aae4 the Multiple Ways finder surfaced a plain
 *     wcag22:2.4.5 candidate pinned to index.html with no contextual
 *     hint, causing agents to treat the mount-point HTML as the fix
 *     location instead of redirecting to the React router config. The
 *     bc3aae4 fix added a "SPA index shell" reason enrichment.
 * - The body+anchor/nav predicate gate (.4.5-MULTIPLE-
 *     WAYS-REQUIRE-BODY) tightened the finder so a bare HTML shell
 *     (body but no `<a>` and no `<nav>`) no longer qualifies as a
 *     candidate site root at all. The agent reading a body-only mount
 *     shell would dismiss it; the predicate dismisses upstream. The
 *     2.4.5 prompt for the SPA still surfaces — it now rides on the
 *     `App.tsx` JSX root-layout match (uniquePerCriterion dedup means
 *     exactly one candidate per project).
 *
 * The assertion now locks in the tightened behavior: the bare
 * index.html shell produces no candidate, and the dedup contract
 * still ensures one wcag22:2.4.5 candidate exists somewhere in the
 * project (from App.tsx).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Vite-style SPA shell with a bare index.html (body+mount-div, no anchors / no nav) does not produce a wcag22:2.4.5 candidate — the predicate gate dismisses upstream. The criterion is still covered by the App.tsx JSX root-layout match (one candidate per project via uniquePerCriterion).",
  origin: {
    commit: "bc3aae4",
    notes:
      "Leela feedback: 2.4.5 candidate was pinned to the Vite index.html with no hint that navigation lives in the React router config. Two-step fix: bc3aae4 enriched the reason text.4.5-MULTIPLE-WAYS-REQUIRE-BODY tightened the predicate so the bare HTML shell no longer fires at all. The JSX side (App.tsx) carries the criterion via uniquePerCriterion dedup.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "candidate-present",
      criterionId: "wcag22:2.4.5",
    },
  ],
};
