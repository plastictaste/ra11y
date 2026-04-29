/**
 * Unit tests for the scan-assembly layer (`src/mcp/scan-assembly.ts`).
 *
 * The former `meta.countsBySurface` cross-surface tripwire — a 4-way
 * internal spread of disagreeing finding totals — was dropped per
 * `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest." A field whose name implied cross-surface
 * reconciliation but whose contents were three competing summaries of
 * the same response read like an additional contested headline rather
 * than the disagreement tripwire it claimed to be. Consumers that want
 * to reconcile read the structured siblings directly
 * (`plan.fixesByClass`, `meta.perRuleCoverage`, the per-file
 * `findings.length` rollup); the headline-summary collapse hid the
 * disagreement rather than surfaced it.
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import { parseHtml } from "../../../src/input/parsers/html.ts";
import { parseScss } from "../../../src/input/parsers/scss.ts";
import {
  applyExtensionPresentSubkindAdjustment,
  collectExtensionsForSubkindProbe,
} from "../../../src/mcp/extension-subkind.ts";
import {
  applyParseErrorAdjustment,
  applyScssUnresolvedVariablesAdjustment,
  buildScanMeta,
  computeTopRules,
  detectLinkedStylesheetsNotResolvedForContrast,
  detectScssUnresolvedVariableFiles,
  isPerRuleCoverageUniformlyHigh,
  PER_RULE_COVERAGE_CAP,
  splitViolationsByScanKind,
  sumFindingsAcrossFiles,
  sumFindingsEmitted,
  withTopRules,
  withViolationsByScanKind,
} from "../../../src/mcp/scan-assembly.ts";
import { McpSession } from "../../../src/mcp/session.ts";
import { runScanAndFormat } from "../../../src/mcp/tools-helpers.ts";
import type { Rule } from "../../../src/types/rule.ts";
import type { PerRuleCoverage } from "../../../src/types/violation.ts";

function htmlFile(path: string, source: string): ParsedFile {
  const parsed = parseHtml(source);
  return {
    filePath: path,
    source,
    ast: { language: "html", root: parsed.root, errors: parsed.errors },
  };
}

describe("sumFindingsEmitted + sumFindingsAcrossFiles reductions", () => {
  it("sumFindingsEmitted sums `findingsEmitted` across per-rule-coverage rows", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "alt-text/missing",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 3,
        fired: true,
        coverageConfidence: "high",
      },
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 2,
        fired: true,
        coverageConfidence: "high",
      },
    ];
    expect(sumFindingsEmitted(rows)).toBe(5);
  });

  it("sumFindingsAcrossFiles sums `findings.length` across file buckets", () => {
    const files = [{ findings: [1, 2, 3] }, { findings: [] }, { findings: [1] }];
    expect(sumFindingsAcrossFiles(files)).toBe(4);
  });
});

describe("isPerRuleCoverageUniformlyHigh", () => {
  it("returns true when every row is high confidence with no byFile overrides", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "alt-text/missing",
        filesEvaluated: 5,
        filesEligible: 5,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 3,
        filesEligible: 3,
        findingsEmitted: 1,
        fired: true,
        coverageConfidence: "high",
      },
    ];
    expect(isPerRuleCoverageUniformlyHigh(rows)).toBe(true);
  });

  it("returns false when at least one row is medium or low confidence", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "alt-text/missing",
        filesEvaluated: 5,
        filesEligible: 5,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
      },
    ];
    expect(isPerRuleCoverageUniformlyHigh(rows)).toBe(false);
  });

  it("returns false when a row has non-empty byFile entries (per-file degradation)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "alt-text/missing",
        filesEvaluated: 5,
        filesEligible: 5,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
        byFile: [{ path: "/fixtures/broken.html", confidence: "low", reason: "file-parse-error" }],
      },
    ];
    expect(isPerRuleCoverageUniformlyHigh(rows)).toBe(false);
  });

  it("returns true on an empty rows array (vacuous case — caller pairs with parse-error count gate)", () => {
    expect(isPerRuleCoverageUniformlyHigh([])).toBe(true);
  });
});

describe("runScanAndFormat — meta block + per-rule coverage shape", () => {
  it("emits a formatted.meta block on a single-finding HTML scan and does not surface a countsBySurface composite", async () => {
    // `<img>` without `alt` fires `media/alt-text-missing` — a WCAG
    // 1.1.1 violation with a deterministic per-file count. The former
    // `meta.countsBySurface` tripwire was dropped per the doctrine in
    // the file docblock above; this test pins the absence so a future
    // re-introduction needs explicit doctrine review.
    const file = htmlFile(
      "/fixtures/missing-alt.html",
      '<html><body><img src="x.png"></body></html>',
    );
    const session = new McpSession();
    const { formatted } = await runScanAndFormat(
      [file],
      session,
      ["wcag22"],
      undefined,
      session.config.rules,
      undefined,
      undefined,
    );
    // Every scan-family response carries a meta block (shape contract).
    expect(formatted.meta).toBeDefined();
    // Doctrine pin: the dishonest cross-surface composite is absent
    // regardless of whether totals agree or disagree on this scan.
    expect(formatted.meta["countsBySurface"]).toBeUndefined();
    // Smoke-check the scan actually produced findings.
    const lanes = formatted.plan["fixesByClass"] as Record<string, number> | undefined;
    const errorWarning =
      (lanes?.["mechanical"] ?? 0) +
      (lanes?.["guidance"] ?? 0) +
      (lanes?.["runtimeOnly"] ?? 0) +
      (lanes?.["verifyInSource"] ?? 0);
    const findings = errorWarning + ((formatted.plan["notes"] as number | undefined) ?? 0);
    expect(findings).toBeGreaterThan(0);
  });

  it("ships per-file degradation entries on per-rule rows when the only scanned file failed to parse", async () => {
    // a file that failed
    // to parse used to surface as a `coverageConfidence: "high"` row
    // for HTML-targeted rules — the canonical silent-miss "rule never
    // saw the file" disguised as "rule ran clean." Per Q9, the
    // per-file degradation rides on `byFile` (one entry per file the
    // rule's gate matched and that landed in parse-error /
    // partial-parse). When the rule has no clean evidence to fold
    // from (single-file scan whose only file is degraded), the
    // aggregate also drops to "low" with the corresponding reason.
    //
    // Whether the file lands in `parseErrorFiles` (no findings → file
    // invisible to all rules) or `partialParseFiles` (recovered slice
    // produced findings) depends on what fires on this synthetic
    // input — both branches are valid here; the per-branch shapes are
    // pinned by the unit tests on `applyParseErrorAdjustment` below.
    // The integration assertion is "at least one row carried the
    // per-file degradation signal," which is the load-bearing
    // invariant the silent-miss reopens if the wiring regresses.
    const parsed = parseHtml("<html><body><h1>Title</h1></body></html>");
    const erroredFile: ParsedFile = {
      filePath: "/fixtures/broken.html",
      source: "<html><body><h1>Title</h1></body></html>",
      ast: {
        language: "html",
        root: parsed.root,
        errors: [
          {
            message: "synthetic parse failure",
            position: { line: 1, column: 1, offset: 0 },
            recoverable: false,
          },
        ],
      },
    };
    const session = new McpSession();
    const { formatted } = await runScanAndFormat(
      [erroredFile],
      session,
      ["wcag22"],
      undefined,
      session.config.rules,
      undefined,
      undefined,
      // verboseMeta: true — this assertion inspects per-row byFile
      // values, which only ride inline under verbose mode.
      true,
    );
    const perRuleCoverage = formatted.meta["perRuleCoverage"] as readonly PerRuleCoverage[];
    expect(perRuleCoverage).toBeDefined();
    // At least one HTML-targeted rule must carry a byFile entry
    // naming the broken file with a structured reason.
    const rowsWithByFile = perRuleCoverage.filter(
      (r) => r.byFile !== undefined && r.byFile.length > 0,
    );
    expect(rowsWithByFile.length).toBeGreaterThan(0);
    for (const row of rowsWithByFile) {
      const entries = row.byFile!.filter((e) => e.path === "/fixtures/broken.html");
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.confidence).toBe("low");
        expect(entry.reason === "file-parse-error" || entry.reason === "partial-parse").toBe(true);
      }
    }
    // Cross-surface consistency: rules whose AGGREGATE dropped to low
    // (no clean evidence to fold from — happens for rules whose
    // gate matched the file but emitted no findings, so it landed in
    // parse-error rather than partial-parse) must appear in
    // `ruleCoverage.lowConfidenceClean`. Rules whose aggregate stays
    // high (file in partial-parse, the recovered AST counted as
    // clean evidence) appear in `confidentlyClean` — the per-file
    // caveat lives only on `byFile`, matching Q9 doctrine.
    const aggregateDowngraded = perRuleCoverage.filter(
      (r) => r.coverageConfidenceReason !== undefined && r.coverageConfidence === "low",
    );
    const ruleCoverage = formatted["ruleCoverage"] as
      | { confidentlyClean: readonly string[]; lowConfidenceClean: readonly string[] }
      | undefined;
    if (ruleCoverage !== undefined) {
      for (const row of aggregateDowngraded) {
        if (row.findingsEmitted === 0) {
          expect(ruleCoverage.lowConfidenceClean).toContain(row.ruleId);
          expect(ruleCoverage.confidentlyClean).not.toContain(row.ruleId);
        }
      }
    }
  });

  it("ships byFile entries naming the partial-parse path on per-rule rows when an errored file still produced findings", async () => {
    // partial-parse
    // branch (Q9 update). A file with parse-errors that still emits
    // findings (the recovered AST was rich enough for at least one
    // rule to fire) routes into `partialParseFiles`. Per Q9 doctrine,
    // the per-rule per-file degradation rides on `byFile`; the
    // aggregate `coverageConfidence` only drops when the rule has no
    // clean evidence to fold from. Here the partial-parse file
    // contributes to `filesEvaluated` (rule ran on recovered AST), so
    // cleanEvaluated ≥ MIN and aggregate stays "high" — but `byFile`
    // names the bounded file so the agent reads the per-file caveat.
    //
    // Use a file with a missing `alt` attribute so `media/alt-text-
    // missing` fires reliably; force `ast.errors` non-empty so the
    // post-processing classifies it as partial-parse.
    const source = '<html><body><img src="x.png"></body></html>';
    const parsed = parseHtml(source);
    const erroredFile: ParsedFile = {
      filePath: "/fixtures/partial.html",
      source,
      ast: {
        language: "html",
        root: parsed.root,
        errors: [
          {
            message: "synthetic recoverable error",
            position: { line: 1, column: 1, offset: 0 },
            recoverable: true,
          },
        ],
      },
    };
    const session = new McpSession();
    const { formatted } = await runScanAndFormat(
      [erroredFile],
      session,
      ["wcag22"],
      undefined,
      session.config.rules,
      undefined,
      undefined,
      // verboseMeta: true — assertions read per-row coverageConfidenceReason
      // values which only ride inline under verbose mode
      //.
      true,
    );
    const perRuleCoverage = formatted.meta["perRuleCoverage"] as readonly PerRuleCoverage[];
    // Rules with byFile entries naming the partial-parse path —
    // these are HTML-targeted rules whose gate matched.
    const rowsWithByFile = perRuleCoverage.filter(
      (r) => r.byFile !== undefined && r.byFile.length > 0,
    );
    expect(rowsWithByFile.length).toBeGreaterThan(0);
    for (const row of rowsWithByFile) {
      // byFile names the partial-parse file with the substrate reason.
      expect(row.byFile).toBeDefined();
      const partialEntries = row.byFile!.filter((e) => e.reason === "partial-parse");
      expect(partialEntries.length).toBeGreaterThan(0);
      for (const entry of partialEntries) {
        expect(entry.path).toBe("/fixtures/partial.html");
        expect(entry.confidence).toBe("low");
      }
    }
  });
});

describe("buildScanMeta — perRuleCoverage head-slice under verboseMeta", () => {
  // The in-place sentinel doctrine ("Truncated containers must rename
  // or sentinel, not retain") for `meta.perRuleCoverage[]`. Under
  // `verboseMeta: true`, the array can carry one row per active rule —
  // on a registry that exceeds {@link META_ARRAY_CAP}, the wire-size
  // budget the cap regime exists to bound is breached. The fragment
  // builder head-slices to {@link META_ARRAY_CAP} entries and stamps a
  // sibling `perRuleCoverageTruncated: { shown, total }` summary on
  // `meta` so an agent reading the response can distinguish "rule set
  // is small" from "the array was clipped." The dotted path
  // "perRuleCoverage" rides on the response-level warning's
  // `warningsDetails.response_meta_truncated.fields[]` payload via the
  // membership table in `meta-array-cap.ts`.
  it("head-slices perRuleCoverage[] when row count exceeds PER_RULE_COVERAGE_CAP and stamps the sibling summary", () => {
    // Synthesize one rule per row with a non-extension-gated
    // (project-scoped) shape so `partitionPerRuleCoverage` doesn't
    // collapse them into the `rulesNotEvaluatedDueToInputType` bucket
    // (which only fires for extension-gated rows with zero eligible
    // files). filesEvaluated > 0 keeps every row in `retained`.
    const overflow = PER_RULE_COVERAGE_CAP + 25;
    const rules = Array.from({ length: overflow }, (_, i) => ({
      id: `synthetic/rule-${String(i).padStart(3, "0")}`,
      satisfies: [],
      severity: "warning" as const,
      scope: "project" as const,
      fixClass: "guidance" as const,
      docs: { title: "synthetic", rationale: "", goodExample: "", badExample: "" },
    })) as unknown as readonly Rule[];
    const rows: readonly PerRuleCoverage[] = rules.map((r) => ({
      ruleId: r.id,
      filesEvaluated: 1,
      filesEligible: 1,
      findingsEmitted: 0,
      fired: false,
      coverageConfidence: "high" as const,
    }));
    const meta = buildScanMeta({
      filesScanned: 1,
      files: [htmlFile("/dummy.html", "<html><body></body></html>")],
      activeRules: rules,
      durationMs: 0,
      enabledStandards: ["wcag22"],
      wrappers: [],
      sessionOnly: [],
      unusedWrappers: [],
      wrapperProvenance: {
        fromConfig: [],
        fromSession: [],
        fromAutoDetect: { confirmed: [], assumed: [] },
      },
      wrapperElements: {},
      verboseMeta: true,
      preset: undefined,
      suppressions: [],
      perRuleCoverage: rows,
    });
    const perRuleCoverage = meta["perRuleCoverage"] as readonly PerRuleCoverage[] | undefined;
    expect(perRuleCoverage).toBeDefined();
    expect(perRuleCoverage?.length).toBe(PER_RULE_COVERAGE_CAP);
    // Sibling summary names what was clipped — the in-place sentinel.
    expect(meta["perRuleCoverageTruncated"]).toEqual({
      shown: PER_RULE_COVERAGE_CAP,
      total: overflow,
    });
  });

  it("places confidence-degraded rows ahead of high-confidence rows when the cap fires (priority preserves the rows an agent acts on)", () => {
    // Mix of low + high confidence rows synthesized so the cap fires.
    // The head-slice must keep the low-confidence row even when the
    // input order placed it after a sea of high-confidence rows.
    const overflow = PER_RULE_COVERAGE_CAP + 5;
    const rules = Array.from({ length: overflow }, (_, i) => ({
      id: `synthetic/rule-${String(i).padStart(3, "0")}`,
      satisfies: [],
      severity: "warning" as const,
      scope: "project" as const,
      fixClass: "guidance" as const,
      docs: { title: "synthetic", rationale: "", goodExample: "", badExample: "" },
    })) as unknown as readonly Rule[];
    const rows: PerRuleCoverage[] = rules.map((r, i) => ({
      ruleId: r.id,
      filesEvaluated: 1,
      filesEligible: 1,
      findingsEmitted: 0,
      fired: false,
      // Last 3 rows are low-confidence; everything earlier is high.
      // Without prioritization the head-slice would drop them.
      coverageConfidence: i >= overflow - 3 ? "low" : "high",
    }));
    const meta = buildScanMeta({
      filesScanned: 1,
      files: [htmlFile("/dummy.html", "<html><body></body></html>")],
      activeRules: rules,
      durationMs: 0,
      enabledStandards: ["wcag22"],
      wrappers: [],
      sessionOnly: [],
      unusedWrappers: [],
      wrapperProvenance: {
        fromConfig: [],
        fromSession: [],
        fromAutoDetect: { confirmed: [], assumed: [] },
      },
      wrapperElements: {},
      verboseMeta: true,
      preset: undefined,
      suppressions: [],
      perRuleCoverage: rows,
    });
    const surfaced = meta["perRuleCoverage"] as readonly PerRuleCoverage[];
    expect(surfaced.length).toBe(PER_RULE_COVERAGE_CAP);
    // The 3 low-confidence rows survived even though they were the
    // last entries in input order — prioritization kept them ahead of
    // the high-confidence tail.
    const lowRowIds = new Set(
      rows.filter((r) => r.coverageConfidence === "low").map((r) => r.ruleId),
    );
    const surfacedLowRows = surfaced.filter((r) => lowRowIds.has(r.ruleId));
    expect(surfacedLowRows.length).toBe(3);
  });

  it("does not stamp perRuleCoverageTruncated when row count fits under the cap", () => {
    const fit = 5;
    const rules = Array.from({ length: fit }, (_, i) => ({
      id: `synthetic/rule-${i}`,
      satisfies: [],
      severity: "warning" as const,
      scope: "project" as const,
      fixClass: "guidance" as const,
      docs: { title: "synthetic", rationale: "", goodExample: "", badExample: "" },
    })) as unknown as readonly Rule[];
    const rows: readonly PerRuleCoverage[] = rules.map((r) => ({
      ruleId: r.id,
      filesEvaluated: 1,
      filesEligible: 1,
      findingsEmitted: 0,
      fired: false,
      coverageConfidence: "high" as const,
    }));
    const meta = buildScanMeta({
      filesScanned: 1,
      files: [htmlFile("/dummy.html", "<html><body></body></html>")],
      activeRules: rules,
      durationMs: 0,
      enabledStandards: ["wcag22"],
      wrappers: [],
      sessionOnly: [],
      unusedWrappers: [],
      wrapperProvenance: {
        fromConfig: [],
        fromSession: [],
        fromAutoDetect: { confirmed: [], assumed: [] },
      },
      wrapperElements: {},
      verboseMeta: true,
      preset: undefined,
      suppressions: [],
      perRuleCoverage: rows,
    });
    expect((meta["perRuleCoverage"] as readonly PerRuleCoverage[]).length).toBe(fit);
    expect(meta["perRuleCoverageTruncated"]).toBeUndefined();
  });
});

describe("applyParseErrorAdjustment — unit-level coverage of the post-processor", () => {
  // Synthetic rule literals — the helper only reads `id` and
  // `appliesTo.fileExtensions`, so the rest of the Rule shape can
  // stay minimal.
  const htmlRule = {
    id: "html/example",
    satisfies: [],
    severity: "warning",
    scope: "node",
    fixClass: "guidance",
    appliesTo: { fileExtensions: [".html", ".htm"] },
    docs: { title: "html/example", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;
  const cssRule = {
    id: "css/example",
    satisfies: [],
    severity: "warning",
    scope: "node",
    fixClass: "guidance",
    appliesTo: { fileExtensions: [".css"] },
    docs: { title: "css/example", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;
  const projectRule = {
    id: "project/example",
    satisfies: [],
    severity: "warning",
    scope: "project",
    fixClass: "guidance",
    docs: { title: "project/example", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;

  function syntheticHtml(path: string, errored: boolean): ParsedFile {
    const parsed = parseHtml("<html><body><h1>x</h1></body></html>");
    return {
      filePath: path,
      source: "<html><body><h1>x</h1></body></html>",
      ast: {
        language: "html",
        root: parsed.root,
        errors: errored
          ? [
              {
                message: "synthetic",
                position: { line: 1, column: 1, offset: 0 },
                recoverable: false,
              },
            ]
          : [],
      },
    };
  }

  it("returns the input array unchanged when no files have parse errors (no-op fast path)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 2,
        filesEligible: 2,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/a.html", false), syntheticHtml("/b.html", false)];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    // Object identity stable on the no-op path — common-case is cheap.
    expect(out).toBe(rows);
  });

  it("keeps aggregate at 'high' when at least one cleanly-parsed file survives, and ships the parse-error file under byFile (Q9 per-file-not-corpus-wide invariant)", () => {
    // Q9 doctrine: a single parse-error file in a corpus must NOT
    // blanket-degrade the aggregate. With 1 clean file + 1 broken, the
    // rule still has the floor's worth of clean evidence, so aggregate
    // `coverageConfidence` stays `"high"` and the per-file degradation
    // rides on `byFile` for the broken file alone.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 2,
        filesEligible: 2,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/clean.html", false), syntheticHtml("/broken.html", true)];
    // No findings on either file → broken.html lands in parse-error bucket.
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    expect(out).toHaveLength(1);
    const [row] = out;
    expect(row?.ruleId).toBe("html/example");
    // Parse-error file subtracted from `filesEvaluated`.
    expect(row?.filesEvaluated).toBe(1);
    // `filesEligible` is intentionally unchanged — the gate did match;
    // the gap is at evaluation, not eligibility.
    expect(row?.filesEligible).toBe(2);
    // Aggregate stays high — clean evidence dominates the corpus.
    expect(row?.coverageConfidence).toBe("high");
    expect(row?.coverageConfidenceReason).toBeUndefined();
    // Per-file degradation rides under `byFile` for the broken file
    // alone — the agent reads which one of the rule's eligible files
    // had its evidence horizon bounded.
    expect(row?.byFile).toEqual([
      { path: "/broken.html", confidence: "low", reason: "file-parse-error" },
    ]);
  });

  it("drops aggregate to 'low' when the only evaluated file failed to parse (no clean evidence to fold from)", () => {
    // Single-file scan where the only eligible file is the parse-error
    // file — `cleanEvaluated` is 0, below the MIN floor, so aggregate
    // honestly drops to `"low"` with the file-parse-error reason. This
    // is the pre-Q9 behavior on the fully-degraded edge case; Q9 only
    // changes the scope of degradation, not the strength when there is
    // no clean evidence to hold the aggregate up.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/broken.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    const [row] = out;
    expect(row?.coverageConfidence).toBe("low");
    expect(row?.coverageConfidenceReason).toBe("file-parse-error");
    expect(row?.filesEvaluated).toBe(0);
    expect(row?.byFile).toEqual([
      { path: "/broken.html", confidence: "low", reason: "file-parse-error" },
    ]);
  });

  it("keeps aggregate 'high' on partial-parse files when clean siblings exist; per-file caveat rides on byFile", () => {
    // Partial-parse files DO contribute to `filesEvaluated` (the rule
    // ran on the recovered AST and emitted findings). With at least
    // one clean file alongside, the aggregate stays high; the
    // partial-parse caveat rides on `byFile` for the affected file.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 2,
        filesEligible: 2,
        findingsEmitted: 3,
        fired: true,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/clean.html", false), syntheticHtml("/partial.html", true)];
    // The errored file produced findings → routes into partial-parse.
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set(["/partial.html"]));
    const [row] = out;
    expect(row?.coverageConfidence).toBe("high");
    expect(row?.coverageConfidenceReason).toBeUndefined();
    // Evaluated count holds — the rule DID run on the recovered AST.
    expect(row?.filesEvaluated).toBe(2);
    expect(row?.byFile).toEqual([
      { path: "/partial.html", confidence: "low", reason: "partial-parse" },
    ]);
  });

  it("keeps aggregate 'high' for a single partial-parse file because the recovered AST counts as clean evidence (rule fired)", () => {
    // Partial-parse files contribute to `filesEvaluated` (the rule
    // ran on the recovered AST and emitted findings). The aggregate
    // fold treats the recovered slice as clean evidence for the
    // corpus-level scalar — only the per-file confidence is bounded,
    // and that bound rides on `byFile`. This is the per-file-not-
    // corpus-wide invariant: a single partial-parse file is the per-
    // file caveat the agent reads from `byFile`, not a corpus-level
    // signal.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 1,
        fired: true,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/partial.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set(["/partial.html"]));
    const [row] = out;
    expect(row?.coverageConfidence).toBe("high");
    expect(row?.byFile).toEqual([
      { path: "/partial.html", confidence: "low", reason: "partial-parse" },
    ]);
  });

  it("ignores parse-error files that don't match the rule's extension gate", () => {
    // A `.html` parse error must not downgrade a CSS-targeted rule's
    // row — the gate is the load-bearing eligibility predicate.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/example",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/broken.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [cssRule], new Set());
    const [row] = out;
    expect(row?.coverageConfidence).toBe("high");
    expect(row?.coverageConfidenceReason).toBeUndefined();
    expect(row?.filesEvaluated).toBe(1);
  });

  it("project-scoped rules pick up byFile entries for parse-error files (clean siblings hold aggregate at high)", () => {
    // Project-scoped rules walk every parsed file in one shot — a
    // parse-error file is invisible to them too. With one clean
    // sibling, the aggregate stays high; the parse-error file rides
    // on `byFile` so the agent reads which file the project-scoped
    // rule could not see.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "project/example",
        filesEvaluated: 2,
        filesEligible: 2,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/clean.html", false), syntheticHtml("/broken.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [projectRule], new Set());
    const [row] = out;
    expect(row?.coverageConfidence).toBe("high");
    expect(row?.coverageConfidenceReason).toBeUndefined();
    expect(row?.filesEvaluated).toBe(1);
    expect(row?.byFile).toEqual([
      { path: "/broken.html", confidence: "low", reason: "file-parse-error" },
    ]);
  });

  it("preserves additive telemetry fields (concentration, classPatternConcentration) across the rewrite", () => {
    // The adjustment must not strip optional fields the engine
    // stamped on the row — `concentration` / `classPatternConcentration`
    // are zero-information-loss telemetry and survive the rewrite,
    // even when only `byFile` is added (aggregate stays high under
    // Q9's per-file-not-corpus-wide invariant).
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 5,
        filesEligible: 5,
        findingsEmitted: 12,
        fired: true,
        coverageConfidence: "high",
        concentration: { file: "/dense.html", count: 12 },
      },
    ];
    const files = [syntheticHtml("/dense.html", false), syntheticHtml("/broken.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    const [row] = out;
    expect(row?.concentration).toEqual({ file: "/dense.html", count: 12 });
    // 4 clean files survive — aggregate stays high; per-file caveat
    // rides on byFile.
    expect(row?.coverageConfidence).toBe("high");
    expect(row?.byFile).toEqual([
      { path: "/broken.html", confidence: "low", reason: "file-parse-error" },
    ]);
  });

  it("floors filesEvaluated at 0 when parse-error matches exceed the original count", () => {
    // Defensive: if the engine's tracker disagrees with the post-
    // processor's match counter for any reason, the wire shape must
    // never expose a negative number.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/a.html", true), syntheticHtml("/b.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    const [row] = out;
    expect(row?.filesEvaluated).toBe(0);
  });

  it("ships byFile entries for both parse-error and partial-parse files when both match a rule's gate (clean siblings hold aggregate)", () => {
    // Both parse-error and partial-parse files matched the rule's
    // gate alongside one clean file. The aggregate stays at "high"
    // because cleanEvaluated == 2 ≥ MIN floor (filesEvaluated 3 -
    // parseErrorMatches 1 = 2). Per-file detail rides on `byFile` —
    // one entry per degraded file, each with its own structured
    // reason. file-parse-error and partial-parse coexist on the same
    // row's byFile list so an agent reading the per-file picture sees
    // exactly which files contributed which substrate signal.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 3,
        filesEligible: 3,
        findingsEmitted: 1,
        fired: true,
        coverageConfidence: "high",
      },
    ];
    const files = [
      syntheticHtml("/clean.html", false),
      syntheticHtml("/parse-error.html", true), // no findings → parse-error
      syntheticHtml("/partial.html", true), // findings → partial-parse
    ];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set(["/partial.html"]));
    const [row] = out;
    expect(row?.coverageConfidence).toBe("high");
    expect(row?.coverageConfidenceReason).toBeUndefined();
    // Subtracts only the parse-error file (1), not the partial-parse one.
    expect(row?.filesEvaluated).toBe(2);
    expect(row?.byFile).toEqual([
      { path: "/parse-error.html", confidence: "low", reason: "file-parse-error" },
      { path: "/partial.html", confidence: "low", reason: "partial-parse" },
    ]);
  });

  it("when aggregate drops to 'low' (no clean evidence), file-parse-error wins over partial-parse in the aggregate reason", () => {
    // Edge: every evaluated file is degraded (1 parse-error + 1
    // partial-parse, no clean). cleanEvaluated == filesEvaluated 2
    // - parseErrorMatches 1 = 1 ≥ MIN floor → aggregate STAYS high.
    // To exercise the "no-clean-evidence aggregate drop" branch we
    // need a row whose only file is parse-error (cleanEvaluated 0 <
    // MIN). The byFile list still rides for traceability.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/parse-error.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    const [row] = out;
    expect(row?.coverageConfidence).toBe("low");
    expect(row?.coverageConfidenceReason).toBe("file-parse-error");
    expect(row?.byFile).toEqual([
      { path: "/parse-error.html", confidence: "low", reason: "file-parse-error" },
    ]);
  });
});

describe("runScanAndFormat — meta block does not carry a countsBySurface composite", () => {
  it("the dropped cross-surface tripwire stays absent on a clean scan — doctrine pin against re-introduction", async () => {
    // The 4-way disagreement spread the field used to ship was the
    // dishonest shape doctrine names — see the file docblock above.
    // This test pins the absence so a future re-introduction needs
    // explicit doctrine review (ambiguous-field + composite-headline
    // together).
    const file = htmlFile("/fixtures/clean.html", "<html><body><h1>Hello</h1></body></html>");
    const session = new McpSession();
    const { formatted } = await runScanAndFormat(
      [file],
      session,
      ["wcag22"],
      undefined,
      session.config.rules,
      undefined,
      undefined,
    );
    expect(formatted.meta["countsBySurface"]).toBeUndefined();
  });
});

//
//
// Token-only SCSS partials (`_variables.scss`, theme tokens, Font
// Awesome SCSS files) parse to zero CSS rules — and a `contrast/minimum`
// row that reads `findingsEmitted: 0, coverageConfidence: "high"` is the
// canonical zero-output-success-is-ambiguous-failure shape on this
// substrate. The detector + adjuster live in scan-assembly so the meta
// downgrade and the response-level `scss_unresolved_variables` warning
// agree on the file list.
describe("detectScssUnresolvedVariableFiles", () => {
  function scssFile(path: string, source: string): ParsedFile {
    const parsed = parseScss(source);
    return {
      filePath: path,
      source,
      ast: { language: "css", root: parsed.root, errors: [...parsed.errors] },
    };
  }

  it("identifies a token-only `_variables.scss` partial whose substitution produced no rules", () => {
    const file = scssFile("theme/_variables.scss", "$primary: #0d6efd;\n$secondary: #6c757d;\n");
    expect(detectScssUnresolvedVariableFiles([file])).toEqual(["theme/_variables.scss"]);
  });

  it("does NOT flag an SCSS file whose declarations resolved to literal hex colors", () => {
    // `$primary: #0d6efd;` is a literal — the substitution pass inlines
    // it and the resulting CSS carries `color: #0d6efd;`.
    const file = scssFile("theme.scss", "$primary: #0d6efd;\n.btn { color: $primary; }\n");
    expect(detectScssUnresolvedVariableFiles([file])).toEqual([]);
  });

  it("does NOT flag a plain SCSS file with no `$variable:` declarations (signal is variables + zero usages)", () => {
    const file = scssFile("plain.scss", ".btn { color: red; }\n");
    expect(detectScssUnresolvedVariableFiles([file])).toEqual([]);
  });

  it("flags SCSS files that use `var(--token)` references because CSS custom properties are outside the SCSS substitution layer", () => {
    // SCSS variable declared but file uses CSS custom property
    // references for color — neither substitution nor cascade sees a
    // literal, so the static scanner has no contrast evidence.
    const file = scssFile("tokens.scss", "$brand: var(--brand);\n.btn { color: var(--brand); }\n");
    expect(detectScssUnresolvedVariableFiles([file])).toEqual(["tokens.scss"]);
  });

  it("returns paths in deterministic sorted order across the scan", () => {
    const a = scssFile("z/_z.scss", "$a: 4;\n");
    const b = scssFile("a/_a.scss", "$b: 4;\n");
    expect(detectScssUnresolvedVariableFiles([a, b])).toEqual(["a/_a.scss", "z/_z.scss"]);
  });

  it("ignores non-.scss files (CSS / HTML / TSX) regardless of source content", () => {
    function htmlFileLocal(path: string, source: string): ParsedFile {
      const parsed = parseHtml(source);
      return {
        filePath: path,
        source,
        ast: { language: "html", root: parsed.root, errors: parsed.errors },
      };
    }
    const html = htmlFileLocal("/a.html", "<html><body>$primary:</body></html>");
    expect(detectScssUnresolvedVariableFiles([html])).toEqual([]);
  });
});

describe("detectLinkedStylesheetsNotResolvedForContrast", () => {
  it('returns the unresolved-link tally when an HTML page declares `<link rel="stylesheet">`', () => {
    const html = htmlFile(
      "/proj/page.html",
      `<!DOCTYPE html><html lang="en"><head><link rel="stylesheet" href="css/bootstrap.min.css"></head><body><p>hi</p></body></html>`,
    );
    const result = detectLinkedStylesheetsNotResolvedForContrast([html]);
    expect(result.count).toBe(1);
    expect(result.htmlFiles).toEqual(["/proj/page.html"]);
    expect(result.topUnresolvedHrefs).toEqual(["css/bootstrap.min.css"]);
  });

  it("returns empty tally when no HTML file declared a stylesheet link", () => {
    const html = htmlFile(
      "/proj/page.html",
      `<!DOCTYPE html><html lang="en"><body><p>hi</p></body></html>`,
    );
    const result = detectLinkedStylesheetsNotResolvedForContrast([html]);
    expect(result.count).toBe(0);
    expect(result.htmlFiles).toEqual([]);
    expect(result.topUnresolvedHrefs).toEqual([]);
  });

  it('ignores `rel="alternate stylesheet"` and preload-shaped variants (different resolution paths)', () => {
    const html = htmlFile(
      "/proj/page.html",
      `<!DOCTYPE html><html lang="en"><head><link rel="alternate stylesheet" href="alt.css"><link rel="preload" as="style" href="hot.css"></head><body><p>hi</p></body></html>`,
    );
    expect(detectLinkedStylesheetsNotResolvedForContrast([html]).count).toBe(0);
  });

  it("ignores fragment HTML (no `<html>`/`<body>`) — partials don't establish a link-resolution context", () => {
    const html = htmlFile(
      "/proj/_partials/header.html",
      `<link rel="stylesheet" href="bootstrap.min.css"><nav>hi</nav>`,
    );
    expect(detectLinkedStylesheetsNotResolvedForContrast([html]).count).toBe(0);
  });

  it("ignores `<link>` elements without a non-empty href", () => {
    const html = htmlFile(
      "/proj/page.html",
      `<!DOCTYPE html><html lang="en"><head><link rel="stylesheet"><link rel="stylesheet" href=""></head><body><p>hi</p></body></html>`,
    );
    expect(detectLinkedStylesheetsNotResolvedForContrast([html]).count).toBe(0);
  });

  it("de-duplicates hrefs across pages and returns sorted-ascending lists deterministically", () => {
    const a = htmlFile(
      "/proj/page-z.html",
      `<!DOCTYPE html><html lang="en"><head><link rel="stylesheet" href="css/theme.css"></head><body><p>hi</p></body></html>`,
    );
    const b = htmlFile(
      "/proj/page-a.html",
      `<!DOCTYPE html><html lang="en"><head><link rel="stylesheet" href="css/bootstrap.min.css"><link rel="stylesheet" href="css/theme.css"></head><body><p>hi</p></body></html>`,
    );
    const result = detectLinkedStylesheetsNotResolvedForContrast([a, b]);
    expect(result.count).toBe(3);
    expect(result.htmlFiles).toEqual(["/proj/page-a.html", "/proj/page-z.html"]);
    expect(result.topUnresolvedHrefs).toEqual(["css/bootstrap.min.css", "css/theme.css"]);
  });

  it("ignores non-HTML files (SCSS / TSX) regardless of source content", () => {
    const source = `.btn { color: red; }\n`;
    const parsed = parseScss(source);
    const scss: ParsedFile = {
      filePath: "/proj/style.scss",
      source,
      ast: { language: "css", root: parsed.root, errors: [...parsed.errors] },
    };
    expect(detectLinkedStylesheetsNotResolvedForContrast([scss]).count).toBe(0);
  });
});

describe("applyScssUnresolvedVariablesAdjustment", () => {
  const contrastRule = {
    id: "contrast/minimum",
    satisfies: [],
    severity: "error",
    scope: "project",
    fixClass: "guidance",
    appliesTo: { fileExtensions: [".css", ".html", ".htm", ".scss", ".less"] },
    docs: { title: "contrast", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;
  const tsxRule = {
    id: "alt-text/missing",
    satisfies: [],
    severity: "error",
    scope: "node",
    fixClass: "guidance",
    appliesTo: { fileExtensions: [".tsx", ".jsx"] },
    docs: { title: "alt", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;

  function scssFile(path: string): ParsedFile {
    const source = "$primary: #fff;\n";
    const parsed = parseScss(source);
    return {
      filePath: path,
      source,
      ast: { language: "css", root: parsed.root, errors: [...parsed.errors] },
    };
  }

  it("returns the input array unchanged when no SCSS files matched (no-op fast path)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const out = applyScssUnresolvedVariablesAdjustment(rows, [], [contrastRule], new Set());
    expect(out).toBe(rows);
  });

  it("downgrades a `contrast/minimum` row to medium with structured reason when at least one eligible .scss file is unresolved", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const files = [scssFile("/_variables.scss")];
    const out = applyScssUnresolvedVariablesAdjustment(
      rows,
      files,
      [contrastRule],
      new Set(["/_variables.scss"]),
    );
    const [row] = out;
    expect(row?.coverageConfidence).toBe("medium");
    expect(row?.coverageConfidenceReason).toBe("scss-unresolved-variables");
    expect(row?.reason).toContain("scss variables unresolved");
  });

  it("does NOT downgrade rules whose extension gate doesn't include .scss (alt-text rule untouched)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "alt-text/missing",
        filesEvaluated: 5,
        filesEligible: 5,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const files = [scssFile("/_variables.scss")];
    const out = applyScssUnresolvedVariablesAdjustment(
      rows,
      files,
      [tsxRule],
      new Set(["/_variables.scss"]),
    );
    expect(out[0]?.coverageConfidence).toBe("high");
    expect(out[0]?.coverageConfidenceReason).toBeUndefined();
  });

  it("preserves an existing `low` confidence stamped by parse-error adjustment (parse-error precedence)", () => {
    // The parse-error pass already marked this row low; SCSS adjuster
    // must not weaken or rewrite that stronger downgrade.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 0,
        filesEligible: 1,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
        coverageConfidenceReason: "file-parse-error",
      },
    ];
    const files = [scssFile("/_variables.scss")];
    const out = applyScssUnresolvedVariablesAdjustment(
      rows,
      files,
      [contrastRule],
      new Set(["/_variables.scss"]),
    );
    expect(out[0]?.coverageConfidence).toBe("low");
    expect(out[0]?.coverageConfidenceReason).toBe("file-parse-error");
  });

  it("preserves an existing `reason` on the row when the SCSS downgrade fires (reason carries the rule's pre-existing prose)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
        reason: "previous prose from another axis",
      },
    ];
    const files = [scssFile("/_variables.scss")];
    const out = applyScssUnresolvedVariablesAdjustment(
      rows,
      files,
      [contrastRule],
      new Set(["/_variables.scss"]),
    );
    expect(out[0]?.reason).toBe("previous prose from another axis");
    expect(out[0]?.coverageConfidence).toBe("medium");
  });
});

describe("splitViolationsByScanKind", () => {
  // Doctrine: the per-kind tally is the load-bearing surface for
  // triage telemetry — an agent reading the response can tell at a
  // glance how many error/warning findings sit in vendor /
  // build-artifact files (often un-editable; the productive triage
  // is `propose_config` exclude or source-level disable). The split
  // is deterministic from the build-artifact classifier path set,
  // not a heuristic. Note: per the flat
  // `plan.violations` headline was deleted, but the per-kind sibling
  // remains valid because each lane (`source`, `buildArtifact`)
  // names exactly one kind of thing — it is itself an honest split,
  // not a composite.
  function f(severity: string) {
    return { severity };
  }
  const E = f("error");
  const W = f("warning");
  const I = f("info");

  it("routes error/warning findings by exact path membership in the vendor set", () => {
    const files = [
      { path: "src/page.tsx", findings: [E, W] },
      { path: "vendor/bootstrap.min.css", findings: [E, E, E, W, W] },
      { path: "src/components/button.tsx", findings: [E] },
    ];
    const vendorPaths = new Set(["vendor/bootstrap.min.css"]);
    expect(splitViolationsByScanKind(files, vendorPaths)).toEqual({
      source: 3,
      buildArtifact: 5,
    });
  });

  it("excludes info-severity notes from both lanes — mirrors the error+warning axis", () => {
    // The per-kind sibling splits the error+warning axis (the same
    // axis `plan.fixesByClass` tallies), not a different one —
    // otherwise the two lanes wouldn't sum to the structured
    // per-lane tally the agent reads alongside it. `plan.notes`
    // (severity-info) tracks a different axis and stays out of the
    // per-kind split. Pre-Q7 this test referenced the flat
    // `plan.violations` headline; that field is gone but the
    // semantic invariant (axis alignment) is unchanged.
    const files = [
      { path: "src/page.tsx", findings: [E, I, W] }, // 2 violations, 1 note
      { path: "vendor/lib.min.js", findings: [I, I, E] }, // 1 violation, 2 notes
    ];
    expect(splitViolationsByScanKind(files, new Set(["vendor/lib.min.js"]))).toEqual({
      source: 2,
      buildArtifact: 1,
    });
  });

  it("routes every violation into `source` when the vendor path set is empty", () => {
    // The classifier produced no build artifacts — every file is
    // authored source. The lane stays honest at zero, never
    // misclassifying.
    const files = [
      { path: "src/page.tsx", findings: [E, E, W] },
      { path: "src/styles.css", findings: [E] },
    ];
    expect(splitViolationsByScanKind(files, new Set())).toEqual({
      source: 4,
      buildArtifact: 0,
    });
  });

  it("returns zero-zero on empty file input", () => {
    // A clean scan with no findings carries no per-file buckets to
    // route — both lanes settle at zero. Caller upstream
    // (`withViolationsByScanKind`) drops the field on the wire when
    // no artifacts were classified, so this output is internal
    // (consistency with the helper's contract).
    expect(splitViolationsByScanKind([], new Set())).toEqual({ source: 0, buildArtifact: 0 });
    expect(splitViolationsByScanKind([], new Set(["x"]))).toEqual({
      source: 0,
      buildArtifact: 0,
    });
  });

  it("counts a file with zero violations as zero on its lane (no off-by-one)", () => {
    // Defensive: `formatted.files` should never carry empty buckets in
    // production (the assembler trims them) but the helper must be
    // honest if they slip through. A file with only info-severity
    // notes on an artifact path also stays at zero on the
    // buildArtifact lane.
    const files = [
      { path: "vendor/lib.min.js", findings: [] },
      { path: "vendor/notes-only.min.css", findings: [I, I] },
      { path: "src/app.tsx", findings: [E, W] },
    ];
    expect(
      splitViolationsByScanKind(files, new Set(["vendor/lib.min.js", "vendor/notes-only.min.css"])),
    ).toEqual({
      source: 2,
      buildArtifact: 0,
    });
  });
});

describe("withViolationsByScanKind — plan-stamping helper", () => {
  function f(severity: string) {
    return { severity };
  }
  const E = f("error");
  const W = f("warning");

  it("stamps `plan.violationsByScanKind` when the vendor path set is non-empty", () => {
    // Plan fixture uses the post-Q7 shape (notes + fixesByClass) —
    // the helper is pure-spread so any input fields would pass
    // through, but matching the production shape keeps the test
    // honest about what the wire surface looks like in 2026-04+.
    const plan = {
      notes: 0,
      fixesByClass: { mechanical: 5, guidance: 0, runtimeOnly: 0, verifyInSource: 3 },
    } satisfies Record<string, unknown>;
    const files = [
      { path: "src/page.tsx", findings: [E, E, W] },
      { path: "vendor/bootstrap.min.css", findings: [E, E, E, W, W] },
    ];
    const out = withViolationsByScanKind(plan, files, new Set(["vendor/bootstrap.min.css"]));
    expect(out["violationsByScanKind"]).toEqual({ source: 3, buildArtifact: 5 });
    // Existing fields preserved — additive enrichment only.
    expect(out["notes"]).toBe(0);
    expect(out["fixesByClass"]).toEqual({
      mechanical: 5,
      guidance: 0,
      runtimeOnly: 0,
      verifyInSource: 3,
    });
  });

  it("returns the input plan by identity (no shallow copy) when no artifacts were classified", () => {
    // Common-case fast path: the no-artifacts scan pays nothing for
    // the helper; the conditional-spread doctrine keeps the field off
    // the wire entirely.
    const plan = {
      notes: 1,
      fixesByClass: { mechanical: 4, guidance: 0, runtimeOnly: 0, verifyInSource: 0 },
    } satisfies Record<string, unknown>;
    const out = withViolationsByScanKind(plan, [{ path: "x", findings: [E] }], new Set());
    expect(out).toBe(plan);
    expect(out["violationsByScanKind"]).toBeUndefined();
  });

  it("preserves the input plan's other fields verbatim — additive only", () => {
    const plan = {
      notes: 0,
      fixesByClass: { mechanical: 1, guidance: 1 },
      summary: "x",
    } satisfies Record<string, unknown>;
    const files = [{ path: "vendor/a.min.css", findings: [E, W] }];
    const out = withViolationsByScanKind(plan, files, new Set(["vendor/a.min.css"]));
    expect(out["notes"]).toBe(0);
    expect(out["fixesByClass"]).toEqual({ mechanical: 1, guidance: 1 });
    expect(out["summary"]).toBe("x");
    expect(out["violationsByScanKind"]).toEqual({ source: 0, buildArtifact: 2 });
  });

  it("emits the field even when the buildArtifact lane is zero, as long as artifacts were classified", () => {
    // The presence of `vendorPaths` is the trigger — if the classifier
    // labelled at least one file in the scan, the agent benefits from
    // the per-lane signal even when this particular response has no
    // findings on those files. Honest shape: the agent reads
    // "0 buildArtifact, 5 source" and trusts the split, vs. an absent
    // field that conflates "no artifacts in the scan" with "no
    // findings on artifacts."
    const plan = {
      notes: 0,
      fixesByClass: { mechanical: 3, guidance: 0, runtimeOnly: 0, verifyInSource: 2 },
    } satisfies Record<string, unknown>;
    const files = [{ path: "src/app.tsx", findings: [E, E, E, W, W] }];
    const out = withViolationsByScanKind(plan, files, new Set(["vendor/bootstrap.min.css"]));
    expect(out["violationsByScanKind"]).toEqual({ source: 5, buildArtifact: 0 });
  });
});

describe("computeTopRules — cross-file rule-frequency rollup", () => {
  // Doctrine: bulk-scan repros (≈1800-file catalogs) made the agent
  // page through every file just to learn which rules dominated. The
  // pieces (`findingsEmitted` per rule, densest file per rule) already
  // exist on `meta.perRuleCoverage`; this rollup exposes the same
  // information at the headline so triage can route in one read.
  const E = (ruleId: string) => ({ ruleId, severity: "error" });
  const W = (ruleId: string) => ({ ruleId, severity: "warning" });
  const I = (ruleId: string) => ({ ruleId, severity: "info" });

  it("ranks rules by total count descending, then ruleId ascending for ties", () => {
    const out = computeTopRules([
      { path: "src/a.tsx", findings: [E("alt-text/missing"), E("alt-text/missing")] },
      { path: "src/b.tsx", findings: [E("contrast/minimum"), E("alt-text/missing")] },
      { path: "src/c.tsx", findings: [W("zzz/last"), W("aaa/first")] },
    ]);
    expect(out.map((r) => r.ruleId)).toEqual([
      "alt-text/missing",
      "aaa/first",
      "contrast/minimum",
      "zzz/last",
    ]);
    expect(out[0]).toMatchObject({ ruleId: "alt-text/missing", count: 3 });
  });

  it("annotates each rule with `topFile` — the densest single file the rule fired on", () => {
    const out = computeTopRules([
      { path: "vendor/bootstrap.css", findings: [E("contrast/minimum"), E("contrast/minimum")] },
      { path: "src/page.tsx", findings: [E("contrast/minimum")] },
    ]);
    expect(out[0]).toEqual({
      ruleId: "contrast/minimum",
      count: 3,
      topFile: "vendor/bootstrap.css",
    });
  });

  it("excludes info-severity findings from both the count and the topFile selection", () => {
    // The rollup describes the same error+warning surface
    // `plan.fixesByClass` tallies; info-severity rules (e.g. wrappers/inferred)
    // would crowd the top of the list with non-actionable context.
    const out = computeTopRules([
      { path: "src/a.tsx", findings: [I("wrappers/inferred"), I("wrappers/inferred")] },
      { path: "src/b.tsx", findings: [E("contrast/minimum")] },
    ]);
    expect(out).toEqual([{ ruleId: "contrast/minimum", count: 1, topFile: "src/b.tsx" }]);
  });

  it("truncates to the limit (default 10) on ranked output", () => {
    // Build 12 distinct rules each emitting one finding so the sort
    // surfaces them all, then confirm the cap. Names start with
    // matching prefix so the alphabetical tiebreak is exercised.
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `src/${i}.tsx`,
      findings: [E(`rule/${String(i).padStart(2, "0")}`)],
    }));
    expect(computeTopRules(files).length).toBe(10);
    expect(computeTopRules(files, 5).length).toBe(5);
  });

  it("returns all rules when fewer than the limit fired (no zero-count padding)", () => {
    // No padding with zero-count rows — that would be a noise-not-
    // signal shape per "Ambiguous field shapes are dishonest."
    const out = computeTopRules([{ path: "src/a.tsx", findings: [E("rule/one"), W("rule/two")] }]);
    expect(out.length).toBe(2);
  });

  it("returns an empty array on a clean scan — caller conditional-spreads the field off the wire", () => {
    expect(computeTopRules([])).toEqual([]);
    expect(computeTopRules([{ path: "src/x.tsx", findings: [] }])).toEqual([]);
    // Info-only scan — same axis as withViolationsByScanKind's
    // severity filter; `plan.notes` carries that surface separately.
    expect(computeTopRules([{ path: "src/x.tsx", findings: [I("wrappers/inferred")] }])).toEqual(
      [],
    );
  });
});

describe("withTopRules — plan-stamping helper", () => {
  const E = (ruleId: string) => ({ ruleId, severity: "error" });
  const W = (ruleId: string) => ({ ruleId, severity: "warning" });

  it("stamps `plan.topRules` when at least one error/warning rule fired", () => {
    const plan = {
      notes: 0,
      fixesByClass: { mechanical: 3, guidance: 0, runtimeOnly: 0, verifyInSource: 0 },
    } satisfies Record<string, unknown>;
    const out = withTopRules(plan, [
      { path: "src/a.tsx", findings: [E("contrast/minimum"), W("alt-text/missing")] },
    ]);
    expect(out["topRules"]).toEqual([
      { ruleId: "alt-text/missing", count: 1, topFile: "src/a.tsx" },
      { ruleId: "contrast/minimum", count: 1, topFile: "src/a.tsx" },
    ]);
    // Existing plan fields preserved — additive enrichment only.
    expect(out["notes"]).toBe(0);
    expect(out["fixesByClass"]).toEqual({
      mechanical: 3,
      guidance: 0,
      runtimeOnly: 0,
      verifyInSource: 0,
    });
  });

  it("returns the input plan by identity (no shallow copy) when no rules fired — common no-violations path", () => {
    // Conditional-spread on emptiness keeps `topRules` off the wire on
    // clean scans; `[]` would force the agent to read a field whose
    // only signal is "nothing here."
    const plan = {
      notes: 0,
      summary: "No accessibility violations found.",
    } satisfies Record<string, unknown>;
    const out = withTopRules(plan, [{ path: "src/a.tsx", findings: [] }]);
    expect(out).toBe(plan);
    expect(out["topRules"]).toBeUndefined();
  });

  it("respects an explicit limit when the caller overrides the default", () => {
    const plan = {} satisfies Record<string, unknown>;
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `src/${i}.tsx`,
      findings: [E(`rule/${String(i).padStart(2, "0")}`)],
    }));
    const out = withTopRules(plan, files, 3);
    expect((out["topRules"] as readonly { ruleId: string }[]).length).toBe(3);
  });
});

describe("collectExtensionsForSubkindProbe", () => {
  const cssRule = {
    id: "css/example",
    satisfies: [],
    severity: "warning",
    scope: "node",
    fixClass: "guidance",
    appliesTo: { fileExtensions: [".css"] },
    docs: { title: "css/example", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;
  const htmlRule = {
    id: "html/example",
    satisfies: [],
    severity: "warning",
    scope: "node",
    fixClass: "guidance",
    appliesTo: { fileExtensions: [".HTML", ".HTM"] },
    docs: { title: "html/example", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;
  const projectRule = {
    id: "project/example",
    satisfies: [],
    severity: "warning",
    scope: "project",
    fixClass: "guidance",
    docs: { title: "project/example", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;

  it("collects gated extensions only from `eligible === 0`, low-confidence rows", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/example",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
      },
      {
        ruleId: "html/example",
        filesEvaluated: 4,
        filesEligible: 4,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const out = collectExtensionsForSubkindProbe(rows, [cssRule, htmlRule]);
    expect(out.has(".css")).toBe(true);
    expect(out.has(".html")).toBe(false);
  });

  it("lowercases extensions for cache-key stability", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
      },
    ];
    const out = collectExtensionsForSubkindProbe(rows, [htmlRule]);
    expect(out.has(".html")).toBe(true);
    expect(out.has(".HTML")).toBe(false);
  });

  it("skips project-scoped rules (no `appliesTo.fileExtensions`)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "project/example",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
      },
    ];
    const out = collectExtensionsForSubkindProbe(rows, [projectRule]);
    expect(out.size).toBe(0);
  });

  it("skips rows that already carry a `subkind` (idempotent re-runs)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/example",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
        subkind: "extension-absent",
      },
    ];
    const out = collectExtensionsForSubkindProbe(rows, [cssRule]);
    expect(out.size).toBe(0);
  });
});

describe("applyExtensionPresentSubkindAdjustment", () => {
  const cssRule = {
    id: "css/example",
    satisfies: [],
    severity: "warning",
    scope: "node",
    fixClass: "guidance",
    appliesTo: { fileExtensions: [".css"] },
    docs: { title: "css/example", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;
  const scssAliasRule = {
    id: "css/scss-aliased",
    satisfies: [],
    severity: "warning",
    scope: "node",
    fixClass: "guidance",
    // SCSS files alias-match the `.css` gate via `extensionMatches`.
    appliesTo: { fileExtensions: [".css"] },
    docs: { title: "css/scss-aliased", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;

  it("returns the input array unchanged when the probe result is undefined (caller skipped probe)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/example",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
        reason: "no files matching .css were scanned",
        remediation: "add CSS source files to the scan path",
      },
    ];
    const out = applyExtensionPresentSubkindAdjustment(rows, [cssRule], undefined);
    expect(out).toBe(rows);
  });

  it("stamps `extension-absent` when the probe found no matching extensions at the cwd", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/example",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
        reason: "no files matching .css were scanned",
        remediation: "add CSS source files to the scan path",
      },
    ];
    const out = applyExtensionPresentSubkindAdjustment(rows, [cssRule], new Set());
    expect(out[0]?.subkind).toBe("extension-absent");
    // Existing remediation untouched on the absent branch — it
    // correctly names the absent-extension fix.
    expect(out[0]?.remediation).toBe("add CSS source files to the scan path");
  });

  it("stamps `extension-present-but-out-of-scope` and rewrites remediation when the probe found a matching extension", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/example",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
        reason: "no files matching .css were scanned",
        remediation: "add CSS source files to the scan path",
      },
    ];
    const out = applyExtensionPresentSubkindAdjustment(rows, [cssRule], new Set([".css"]));
    expect(out[0]?.subkind).toBe("extension-present-but-out-of-scope");
    // Remediation rewrites — the original "add additionalPaths for
    // compiled output" steers agents toward the WRONG fix when source
    // files were excluded by `additionalPaths` / `exclude` already.
    expect(out[0]?.remediation).toContain("pruned");
    expect(out[0]?.remediation).toContain("broader scope");
  });

  it("honors the alias table — `.scss` present at root credits a `.css`-gated rule", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/scss-aliased",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
        reason: "no files matching .css were scanned",
        remediation: "add CSS source files to the scan path",
      },
    ];
    const out = applyExtensionPresentSubkindAdjustment(rows, [scssAliasRule], new Set([".scss"]));
    expect(out[0]?.subkind).toBe("extension-present-but-out-of-scope");
  });

  it("leaves rows with `eligible > 0` unchanged (subkind is for the no-eligible-files case only)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/example",
        filesEvaluated: 5,
        filesEligible: 5,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const out = applyExtensionPresentSubkindAdjustment(rows, [cssRule], new Set([".css"]));
    expect(out[0]?.subkind).toBeUndefined();
  });

  it("leaves rows that already carry a `subkind` unchanged (idempotent)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/example",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "low",
        subkind: "extension-absent",
      },
    ];
    const out = applyExtensionPresentSubkindAdjustment(rows, [cssRule], new Set([".css"]));
    expect(out[0]?.subkind).toBe("extension-absent");
  });

  it("returns the input array unchanged when no row qualifies (object identity stable)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "css/example",
        filesEvaluated: 5,
        filesEligible: 5,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const out = applyExtensionPresentSubkindAdjustment(rows, [cssRule], new Set([".css"]));
    expect(out).toBe(rows);
  });
});
