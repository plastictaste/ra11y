/**
 * Integration test: findings emitted at lines past `parsedThroughLine`
 * on a partial-parse file must downgrade per-finding `confidence` to
 * `"low"` AND carry `couldBeWrongBecause: ["beyond_partial_parse_boundary"]`.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Parser-failure invalidates per-file confidence" — extended one
 *   level deeper. The per-rule layer downgrades because the file
 *   carries a parse error; this layer downgrades the per-finding slice
 *   that physically lives past the parser's reach. Closure picks
 *   downgrade-not-drop per "Surface, don't suppress."
 *
 * Pre-fix bug shape: `scan_file` on a partial-parsed HTML reports
 * `limitations[].reason: "partial_parse"`, `parsedThroughLine: N`,
 * but ships findings at lines well beyond N. Findings beyond
 * `parsedThroughLine` either should be impossible OR must downgrade.
 * The closure picks downgrade so the agent retains the lookup point
 * and gets the additive caveat to scope verification.
 *
 * Pinned invariants:
 *   - For every finding emitted on a file in
 *     `meta.analysisCoverage.partialParseFiles[]` whose `line >
 *     parsedThroughLine`, `confidence` must be `"low"` AND
 *     `couldBeWrongBecause` must include `beyond_partial_parse_boundary`.
 *   - Findings on the SAME file but at-or-below the boundary are NOT
 *     downgraded by this pass — they ride whatever confidence the rule
 *     emitted (the per-rule and partial_parse passes upstream may have
 *     attached `partial_parse`, but they should not have downgraded
 *     these specific lines past `low` via this enricher).
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../src/engine/scanner.ts";
import { assembleScanFamilyResponse } from "../../src/mcp/response-assembler.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { wcag22 } from "../../src/standards/wcag22/standard.ts";
import type { Ast, HtmlDocument, HtmlElement, HtmlNode, ParseError } from "../../src/types/ast.ts";

/**
 * Builds a synthetic HTML AST containing N `<img>` elements, each
 * placed at the given line numbers. The rule
 * `media/alt-text-missing` fires on any `<img>` that lacks an
 * accessible-name attribute, producing a finding whose `line` matches
 * the synthetic element's `loc.start.line`. Pairing this with a single
 * synthetic head error at the declared `parsedThroughLine` reproduces
 * the partial-parse-with-findings-past-boundary shape the regression
 * pins, without depending on a specific real-world HTML fixture that
 * accidentally drifts as parsers tighten their recovery behavior.
 */
function buildPartialParseHtmlFixture(
  filePath: string,
  parsedThroughLine: number,
  imgLines: readonly number[],
): ParsedFile {
  const children: HtmlNode[] = imgLines.map((line) => imgElement(line));
  const root: HtmlDocument = {
    kind: "HtmlDocument",
    children,
    range: { start: 0, end: 0 },
    loc: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: imgLines[imgLines.length - 1] ?? 1, column: 1, offset: 0 },
    },
  };
  const errors: readonly ParseError[] = [
    {
      message: "synthetic head error for partial-parse boundary fixture",
      position: { line: parsedThroughLine, column: 1, offset: 0 },
      recoverable: true,
    },
  ];
  const ast: Ast = { language: "html", root, errors };
  // The source text doesn't have to match the AST line numbers — the
  // rule reads `loc.start.line` from the AST node, not the source. A
  // multi-line filler keeps `parsedThroughLine` in a plausible range
  // for the agent reading the wire shape.
  const source = Array.from({ length: 500 }, (_, i) => `<!-- line ${i + 1} -->`).join("\n");
  return { filePath, source, ast };
}

function imgElement(line: number): HtmlElement {
  return {
    kind: "HtmlElement",
    tagName: "img",
    attributes: [],
    children: [],
    selfClosing: true,
    range: { start: 0, end: 0 },
    loc: {
      start: { line, column: 1, offset: 0 },
      end: { line, column: 20, offset: 0 },
    },
  } as HtmlElement;
}

describe("per-finding beyond_partial_parse_boundary propagation", () => {
  it("downgrades confidence and stamps the structured reason on findings whose line > parsedThroughLine", () => {
    // Match the canonical Q15 shape: parsedThroughLine: 221, with
    // findings at lines well past the boundary (263, 399, 405, 408,
    // 412) plus one finding at-or-below (line 200) the boundary so the
    // partition behavior is asserted within a single file.
    const path = "fixtures/partial.html";
    const aboveBoundary = [263, 399, 405, 408, 412];
    const atOrBelow = [200];
    const files = [
      buildPartialParseHtmlFixture(path, 221, [...atOrBelow, ...aboveBoundary]),
    ];

    const { result, perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    // Sanity: the synthetic <img>s must have produced
    // alt-text-missing findings or the assertion below is vacuous.
    const altMissing = result.violations.filter((v) => v.ruleId === "media/alt-text-missing");
    expect(altMissing.length).toBeGreaterThanOrEqual(aboveBoundary.length + atOrBelow.length);

    const response = assembleScanFamilyResponse({
      violations: result.violations,
      rawViolations: result.violations,
      parsedFiles: files,
      activeRules: BUILTIN_RULES,
      durationMs: result.durationMs,
      enabledStandards: result.enabledStandards,
      perRuleCoverage,
      reviewCandidates: [],
      wrappers: {
        wrappers: [],
        sessionOnly: [],
        bySource: {
          fromConfig: [],
          fromSession: [],
          fromAutoDetect: { confirmed: [], assumed: [] },
        },
        elements: {},
      },
      unusedWrappers: [],
      suppressions: [],
      verboseMeta: true,
      preset: undefined,
      actionableManual: 0,
      untargetedCriteria: 0,
      configSource: null,
      rootSource: "explicit",
    });

    const file = response.files.find((f) => f.path === path);
    expect(file).toBeDefined();
    const findings = file!.findings.filter((f) => f.ruleId === "media/alt-text-missing");

    // Findings past the boundary: every one carries the structured
    // reason AND drops to confidence:"low". This is the load-bearing
    // assertion — the regression that motivated the closure ships
    // these at confidence:"high" with no caveat.
    for (const line of aboveBoundary) {
      const f = findings.find((x) => x.line === line);
      expect(f, `finding at line ${line} should exist`).toBeDefined();
      expect(f!.confidence, `finding at line ${line} confidence`).toBe("low");
      expect(
        f!.couldBeWrongBecause ?? [],
        `finding at line ${line} couldBeWrongBecause`,
      ).toContain("beyond_partial_parse_boundary");
    }

    // Findings at-or-below the boundary do NOT carry the new code
    // (this enricher's predicate strictly partitions). They MAY carry
    // `partial_parse` from the companion file-scoped pass — that's the
    // companion invariant; the assertion here only pins the per-line
    // discriminator's negative side.
    for (const line of atOrBelow) {
      const f = findings.find((x) => x.line === line);
      expect(f, `finding at line ${line} should exist`).toBeDefined();
      expect(
        f!.couldBeWrongBecause ?? [],
        `finding at boundary line ${line} should NOT carry beyond_partial_parse_boundary`,
      ).not.toContain("beyond_partial_parse_boundary");
    }
  });

  it("does NOT attach the code on a clean file (no recorded parse error) regardless of line", () => {
    // Same shape minus the partial-parse error. A finding at a very
    // high line must NOT receive the `beyond_partial_parse_boundary`
    // tag — the per-line predicate is gated on the file's recorded
    // head-error line, not on absolute line magnitude.
    const path = "fixtures/clean.html";
    const root: HtmlDocument = {
      kind: "HtmlDocument",
      children: [imgElement(999)],
      range: { start: 0, end: 0 },
      loc: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 999, column: 1, offset: 0 },
      },
    };
    const cleanFile: ParsedFile = {
      filePath: path,
      source: "",
      ast: { language: "html", root, errors: [] },
    };

    const { result, perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [cleanFile],
    });

    const response = assembleScanFamilyResponse({
      violations: result.violations,
      rawViolations: result.violations,
      parsedFiles: [cleanFile],
      activeRules: BUILTIN_RULES,
      durationMs: result.durationMs,
      enabledStandards: result.enabledStandards,
      perRuleCoverage,
      reviewCandidates: [],
      wrappers: {
        wrappers: [],
        sessionOnly: [],
        bySource: {
          fromConfig: [],
          fromSession: [],
          fromAutoDetect: { confirmed: [], assumed: [] },
        },
        elements: {},
      },
      unusedWrappers: [],
      suppressions: [],
      verboseMeta: true,
      preset: undefined,
      actionableManual: 0,
      untargetedCriteria: 0,
      configSource: null,
      rootSource: "explicit",
    });

    const file = response.files.find((f) => f.path === path);
    expect(file).toBeDefined();
    const finding = file!.findings.find((f) => f.ruleId === "media/alt-text-missing");
    expect(finding).toBeDefined();
    expect(finding!.couldBeWrongBecause ?? []).not.toContain("beyond_partial_parse_boundary");
  });
});
