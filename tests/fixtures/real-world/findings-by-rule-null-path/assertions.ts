/**
 * findings-by-rule-null-path — guards that every finding emitted by the
 * `findings_by_rule` MCP tool carries a populated `path` field naming
 * the file the finding lives in.
 *
 * Field report (CSS-framework documentation corpus): `findings_by_rule`
 * shipped per-finding entries with `path: null` across multiple rule
 * probes (focus/outline-visible 7, aria/dropdown-toggle-triple-aria-
 * missing 142, semantics/duplicate-landmark-unlabeled 12,
 * navigation/href-empty-fragment 1284). `line` and `snippet` were
 * populated; only the file address was missing — leaving the agent
 * with line numbers but no file to read, no anchor for `suggest_fix`,
 * and no source-level pragma target. The tool was effectively
 * unusable for routing.
 *
 * Per AI-first doctrine "Per-finding identifiers must be addressable,
 * not collision-prone" (`docs/kb/architecture/ai-first-consumer.md`):
 * a per-finding shape must answer "where does this finding live?" in
 * one read. The shape must use `path` (matching `AgentFile.path` and
 * the rest of the codebase's per-finding addressing convention) so
 * agents reading findings across `scan_project`, `scan_file`,
 * `findings_by_rule`, and `get_finding` see one consistent field
 * name — per "Sibling fields naming the same concept must use one
 * shape."
 *
 * Fixture role: provides a sanitized HTML source with three anchor
 * findings on `navigation/href-empty-fragment`. The scan-time
 * assertion locks in that the source motivates the bug — the rule
 * fires on three lines so a `findings_by_rule` call has multiple
 * per-finding entries to walk. The `findings_by_rule` per-finding
 * shape invariant itself is asserted in
 * `tests/integration/findings-by-rule-per-finding-path.test.ts`,
 * which drives the live MCP tool against this fixture and asserts
 * `path` is populated, non-null, and resolves to the source file on
 * disk.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Three <a href='#'> anchors that all fire navigation/href-empty-fragment — used by the per-finding-path integration test to verify findings_by_rule emits a populated `path` field on every entry. The scan-time predicate locks in that the rule fires on multiple lines so the per-finding walk has more than one entry to inspect.",
  origin: {
    notes:
      "findings_by_rule emitted per-finding entries with path: null on a CSS-framework documentation corpus, leaving agents unable to route into suggest_fix or read the cited file. Fixture sanitizes the failure case down to three anchors so the per-finding-path integration test can drive the live tool and assert addressability.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    { kind: "violation-present", ruleId: "navigation/href-empty-fragment" },
  ],
};
