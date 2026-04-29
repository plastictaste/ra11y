/**
 * Tests for the scanner's collectActiveCandidateCriterionIds helper.
 *
 * The helper builds the ReadonlySet that gates which finders are
 * allowed to fire. Originally it included only `automatable: "manual"`
 * criteria, which silently dropped finders citing partial-automatable
 * criteria — `reduced-motion-candidate` (wcag22:2.3.3, partial),
 * `carousel-pattern` (wcag22:2.2.2, partial), `headings-and-labels`
 * (wcag22:2.4.6, partial), and others — even though their direct unit
 * tests passed via `runFinder`. This pins the runScan-level activation
 * invariant: any finder whose cited criterion is `manual` OR `partial`
 * under an enabled standard must reach the candidate output.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../../src/engine/scanner.ts";
import { parseCss } from "../../../src/input/parsers/index.ts";
import { finder as reducedMotionFinder } from "../../../src/review/finders/reduced-motion-candidate.ts";
import { wcag21 } from "../../../src/standards/wcag21/standard.ts";
import { wcag22 } from "../../../src/standards/wcag22/standard.ts";

function cssFile(filePath: string, source: string): ParsedFile {
  const r = parseCss(source);
  return { filePath, source, ast: { language: "css", root: r.root, errors: r.errors } };
}

describe("scanner: partial-automatable finders activate via runScan", () => {
  it("emits a reduced-motion-candidate for wcag22:2.3.3 (partial-automatable) under wcag22", () => {
    // The canonical regression: reduced-motion-candidate cites
    // wcag22:2.3.3 (automatable: "partial"). Before the widening,
    // `collectManualCriterionIds` excluded partial criteria, so the
    // finder's `isFinderActive` check failed and zero candidates
    // surfaced from the production scanner — even though the direct
    // unit test under tests/unit/review/finders/reduced-motion-
    // candidate.test.ts passed. This pins the production-path
    // activation.
    const file = cssFile("/repo/clock.css", `.clock-hand { animation: grow 0.6s linear; }`);
    const { report } = runScan({
      standards: [wcag22, wcag21],
      rules: [],
      enabled: ["wcag22"],
      files: [file],
      finders: [reducedMotionFinder],
    });
    const candidates = report.candidates ?? [];
    const ids = candidates.map((c) => c.criterionId).sort();
    expect(ids).toContain("wcag22:2.3.3");
  });

  it("still surfaces the WCAG 2.1 mirror candidate when wcag21 is also enabled", () => {
    const file = cssFile("/repo/fade.css", `.fade { transition: opacity 0.3s ease-in; }`);
    const { report } = runScan({
      standards: [wcag22, wcag21],
      rules: [],
      enabled: ["wcag22", "wcag21"],
      files: [file],
      finders: [reducedMotionFinder],
    });
    const candidates = report.candidates ?? [];
    const ids = new Set(candidates.map((c) => c.criterionId));
    expect(ids.has("wcag22:2.3.3")).toBe(true);
    expect(ids.has("wcag21:2.3.3")).toBe(true);
  });
});
