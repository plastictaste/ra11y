/**
 * website-templates-catalog-shape — guards Q6-CATALOG-REPO-SIBLING-HINT
 * against regression. Sanitized echo of a real catalog repo (174
 * stand-alone HTML/CSS/JS site templates under one root) shrunk to
 * the smallest layout that still trips the catalog detector.
 *
 * The flat `scan_project` on the production repo treated the whole
 * tree as one repo, producing catalog-scale fallout: per-template
 * parse errors stacked up under `parseErrorFileCount`, the wrapper
 * detector hoovered up identifier noise across vendor JS bundles,
 * and a stray `_config.yml` at the root flipped framework detection.
 * Per-subdir scans recover signal cleanly. The fix surfaces a
 * `meta.catalogHint` field plus an `analysisCoverage.hints` entry
 * naming the second call shape so the agent's first read points at
 * the right next move.
 *
 * Invariants:
 *   1. `meta.catalogHint.topLevelSiblings` equals the number of
 *      qualifying sibling site dirs (5 here).
 *   2. `meta.catalogHint.exampleSiblings` carries an alphabetical
 *      prefix of the sibling names so the agent recognizes the
 *      catalog from three concrete identifiers.
 *   3. `analysisCoverage.hints` includes the per-subdir scan-call
 *      nudge so agents reading the bare-string hints channel get
 *      the same signal.
 *
 * Doctrine: "One tool call should answer 'what next?'" — the catalog
 * shape is a routing trigger, not a suppression lever. Findings on
 * the per-template files stay enumerable; the hint just gives the
 * agent the right second call to make. See
 * `docs/kb/architecture/ai-first-consumer.md`.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "scan_project on a 5-sibling website-templates-shaped tree surfaces meta.catalogHint " +
    "(topLevelSiblings + alphabetical exampleSiblings) and a per-subdir-scan nudge under " +
    "analysisCoverage.hints, so an agent reading the response routes follow-up scans per " +
    "template rather than re-scanning the flat tree.",
  origin: {
    notes:
      "Sanitized echo of /tmp/website-templates from the 2026-04-22 8-scan field test " +
      "(174 sibling site dirs each carrying index.html + css/ + js/). Five subdirs is the " +
      "minimum that trips the detector's CATALOG_MIN_SIBLINGS gate; the production repo " +
      "is much larger but the same shape.",
  },
  expectations: [
    {
      kind: "meta-field",
      path: ["catalogHint", "topLevelSiblings"],
      predicate: { equals: 5 },
    },
    {
      kind: "meta-field",
      path: ["catalogHint", "exampleSiblings"],
      // Alphabetical prefix capped at three — pinning the exact list
      // protects the stable-ordering invariant the agent relies on.
      predicate: { equals: ["agile-agency", "coffee-shop", "delite-music"] },
    },
    {
      kind: "meta-hint-includes",
      substring: "catalog",
    },
    {
      kind: "meta-hint-includes",
      substring: 'scan_project({ cwd: "<subdir>" })',
    },
  ],
};
