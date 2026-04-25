/**
 * JSON formatter — machine-readable output.
 *
 * Emits a single JSON object with result + report. Deterministic:
 * JSON.stringify with a fixed 2-space indent and an explicit key order
 * (via an object shape, not a replacer — stable under repeated runs).
 */

import { defineFormatter } from "../../api/plugin.ts";
import type { ReportData, ScanResult } from "../../types/violation.ts";
import { VERSION } from "../../version.ts";

export const jsonFormatter = defineFormatter({
  id: "json",
  format(result: ScanResult, report: ReportData): string {
    const payload = {
      ra11y: {
        version: VERSION,
      },
      result: {
        enabledStandards: result.enabledStandards,
        filesScanned: result.filesScanned,
        durationMs: Math.round(result.durationMs),
        violations: result.violations.map((v) => ({
          findingId: v.findingId,
          // Stable group identity — see docs/adr/0008-violation-group-key.md.
          groupKey: v.groupKey,
          ruleId: v.ruleId,
          criteria: v.criteria,
          // Aligned index-for-index with `criteria`. Omitted when the
          // engine did not stamp titles (e.g. synthetic rule-crash
          // records with `criteria: []`).
          ...(v.criteriaTitles !== undefined && { criteriaTitles: v.criteriaTitles }),
          severity: v.severity,
          location: v.location,
          // Selector/declaration line split for selector-scoped CSS
          // findings (Q7-MOTION-FINDING-SELECTOR-LINE). `location.line`
          // is the structural anchor (selector start); `decline` is the
          // sibling pointer at the offending declaration line. Omitted
          // when selector and declaration share a line, per CLAUDE.md
          // §1 "Ambiguous field shapes are dishonest."
          ...(typeof v.decline === "number" && { decline: v.decline }),
          message: v.message,
          ...(v.suggestion !== undefined && { suggestion: v.suggestion }),
          ...(v.snippet !== undefined && { snippet: v.snippet }),
          // Scanner-level confidence — canonically `"inherited"` on
          // Q2R2-INHERITED findings synthesized from a wrapper
          // definition. Omit when unset so primary findings don't
          // carry a misleading default string.
          ...(v.confidence !== undefined && { confidence: v.confidence }),
          // Source-of-truth pointer for synthesized findings (wrapper
          // call sites inheriting from the definition). Omit on
          // primary findings per CLAUDE.md §1 "Ambiguous field shapes
          // are dishonest." See ADR 0012.
          ...(v.sourceOfFinding !== undefined && { sourceOfFinding: v.sourceOfFinding }),
          // Named reason codes for known escape hatches. Informational
          // only — consumers investigate; we never auto-suppress. Omit
          // when empty per docs/adr/0009-violation-could-be-wrong-
          // because.md and CLAUDE.md §1.
          ...(v.couldBeWrongBecause && v.couldBeWrongBecause.length > 0
            ? { couldBeWrongBecause: [...v.couldBeWrongBecause] }
            : {}),
          // In-file rule-emitted sibling rollup (Q7-DUPLICATE-INPUT-
          // SIBLING-COLLAPSE). One canonical finding standing in for N
          // visually-grouped sibling controls; the list enumerates
          // every sibling's `(line, id?)` so JSON consumers can
          // iterate. Conditional spread per CLAUDE.md §1 "Ambiguous
          // field shapes are dishonest."
          ...(v.siblingInstances !== undefined && v.siblingInstances.length > 0
            ? { siblingInstances: [...v.siblingInstances] }
            : {}),
        })),
      },
      report: {
        coverage: report.coverage,
        manualReviewNeeded: report.manualReviewNeeded,
      },
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  },
});
