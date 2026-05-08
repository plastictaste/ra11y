/**
 * warningsdetails-empty-payload — guards the structural invariant
 * that warning codes shipping `warningsDetails.<code>: {}` payloads
 * graduate to a payload-bearing shape per the AI-first doctrine
 * "Empty `warningsDetails.<code>: {}` is dishonest."
 *
 * Field-report shape (multi-corpus regression): four codes were
 * shipping empty `{}` payloads — `partial_parse_files_present` (on
 * `scan_project` / `bootstrap` / `coverage`),
 * `baseline_dry_run` (on `bootstrap`), `build_artifact_only_scan_detected`
 * (on `scan_file` against a vendor stylesheet), and
 * `foreign_ecosystem_detected: <value>` (on `propose_config` —
 * additionally a colon-suffixed dynamic-value-in-warning-code key
 * violation). Sibling codes like `parse_errors_present` populated
 * full payloads in the same response, so the bug was structural:
 * the dispatch table omitted summarizers for the four codes and
 * `fallThroughDetailEntry` stamped the empty-object marker by
 * default.
 *
 * Closure (this fixture's anchor file): the partial-parse case.
 * The HTML page below contributes a clean `images/alt-required`
 * finding before the parser bails on a malformed tail, landing in
 * `analysisCoverage.partialParseFiles[]`. That populates the
 * partial-parse counter the new
 * `warningsDetails.partial_parse_files_present` payload reads off.
 *
 * The structural invariant — that EVERY entry in
 * `warningsDetails` is non-empty, never the bare `{}` marker for
 * payload-bearing codes — is pinned by the companion integration
 * test `tests/integration/mcp-warnings-details-non-empty.test.ts`
 * (added alongside this fixture). The fixture's job is to give the
 * harness a deterministic substrate where the partial-parse code
 * fires; the integration test checks the wire shape on
 * `scan_project` / `bootstrap` / `propose_config` against the same
 * substrate.
 *
 * Companion fixtures:
 *   - `livereload-mixed-signal-parse-error` — guards the
 *     parseErrorFiles vs partialParseFiles classification predicate
 *     itself; this fixture rides on top of that classifier to ship
 *     the partial-parse signal into the warnings channel.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A single HTML page that emits a clean images/alt-required finding " +
    "before the parser bails on a malformed tail. The AST recovers, the " +
    "finding surfaces, and the file lands in `partialParseFiles[]`. " +
    "Anchors the partial_parse_files_present payload graduation tested " +
    "structurally on the wire.",
  origin: {
    notes:
      "Sanitized echo of the multi-corpus warningsdetails-empty-payload " +
      "regression. The malformed-tail shape (an unclosed <a> nested in " +
      "an unclosed <span> nested in an unclosed <div>) is the simplest " +
      "construction that triggers the HTML parser's recovery path while " +
      "leaving the earlier <img> intact.",
  },
  expectations: [
    // Primary invariant: the alt-text rule fires on the well-formed
    // <img> early in the file, BEFORE the parser bails on the tail.
    // Pinning this catches a regression where the recovery path
    // silently drops earlier findings.
    {
      kind: "violation-present",
      ruleId: "media/alt-text-missing",
      inFile: "page.html",
    },
    // The malformed tail forces the HTML parser into recovery mode —
    // the file lands in `partialParseFiles[]`, the count increments,
    // and the `partial_parse_files_present` predicate fires off
    // `analysisCoverage.partialParseFileCount > 0` at the wire layer.
    // Anchored via meta so the fixture harness sees the
    // partial-parse classification deterministically.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "partialParseFileCount"],
      predicate: { equals: 1 },
    },
  ],
};
