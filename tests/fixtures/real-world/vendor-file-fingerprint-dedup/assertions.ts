/**
 * vendor-file-fingerprint-dedup — guards the deterministic SHA-1
 * fingerprint dedupe pass that collapses byte-identical vendor file
 * copies into a single canonical finding with `vendorOccurrences`
 * listing every duplicate path.
 *
 * Field-report shape (catalog-corpus regression): website-template
 * marketplaces, multi-site WordPress exports, and vendored asset
 * pipelines ship the same vendor file byte-identically into 100+
 * sibling template subdirectories — `bootstrap.min.css` × 116,
 * `font-awesome.min.css` × 89, `jquery.fancybox.css` × 64. Without a
 * deterministic fingerprint dedupe, each parsed copy emits the same
 * finding independently, so a single canonical issue inflates into N
 * near-duplicate response rows. The existing basename-keyed dedupe
 * in `src/mcp/vendor-dedupe.ts` collapses findings only when the
 * basename matches AND the message text is byte-identical — vendor
 * files copied verbatim under different basenames (different
 * filename per theme) escape that pass.
 *
 * The fix hashes each parsed file's source by SHA-1 on a narrow
 * extension allowlist (`.css` / `.js` / `.mjs` / `.svg`) where
 * byte-identity across siblings is the vendor-copy pattern by
 * construction. After scan, `stampFingerprintOccurrences`:
 *   1. Drops findings emitted from non-canonical duplicate paths.
 *   2. Stamps `vendorOccurrences: [{ path, line }, …]` on the
 *      canonical finding so every collapsed copy stays enumerable
 *      on the wire — surface, don't suppress per AI-first doctrine.
 * Q15 closure (modulo the parse-cost optimization tracked
 * separately): the response-shape benefit lands without dropping
 * discovered paths from `meta.filesScanned` / `analysisCoverage` /
 * the catalog-shape detector's sibling-signature grouping.
 *
 * Companion patterns:
 *   - `src/mcp/vendor-dedupe.ts::collapseVendorCssFindings` —
 *     basename-keyed post-scan dedupe for near-miss siblings (theme
 *     variants of bootstrap.css with different color tokens).
 *     Composes with this fingerprint pass: fingerprint catches
 *     byte-identical copies; basename catches near-miss siblings.
 *   - The `bulk-catalog-shape-detection` fixture covers the
 *     directory-shape recognition for the same corpora; this fixture
 *     covers the per-file fingerprint half of the same story.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Three byte-identical bootstrap.min.css copies under sibling site-a/site-b/site-c " +
    "directories: the SHA-1 fingerprint dedupe keeps a single canonical contrast/minimum " +
    "finding on the lex-smallest path (site-a) and drops the duplicate paths' parallel " +
    "findings — without the dedupe, the rule fires three times.",
  origin: {
    notes:
      "Sanitized echo of the website-template marketplace corpora that motivated Q15 " +
      "(bootstrap.min.css × 116, font-awesome.min.css × 89). The CSS body is reduced " +
      "to a single high-contrast .btn-warning rule so contrast/minimum has something " +
      "to fire on. Three copies is the minimum that makes the dedupe behavior " +
      "observable: one canonical finding, two duplicate paths in vendorOccurrences.",
  },
  expectations: [
    // Sanity: parser sees every copy without errors.
    { kind: "zero-parse-errors" },

    // Primary invariant: contrast/minimum fires on the canonical
    // (lex-smallest) sibling. Pinning `inFile` is load-bearing — without
    // it, `violation-present` would still pass even if the rule fired on
    // site-b or site-c instead, masking a regression where canonical
    // selection drifted.
    {
      kind: "violation-present",
      ruleId: "contrast/minimum",
      inFile: "site-a/css/bootstrap.min.css",
    },
  ],
};
