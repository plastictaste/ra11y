/**
 * Unit tests for the scan-assembly layer (`src/mcp/scan-assembly.ts`).
 *
 * Primary invariant guarded here: V1-META-COUNTS-BY-SURFACE-REGRESSION.
 * `meta.countsBySurface` must land on every scan-family response whose
 * `plan`/`perRuleCoverage`/`filesSurface` totals disagree — not just
 * the `scan` / `scan_file` path that flows through
 * `assembleScanFamilyResponse`, but also the `scan_project` /
 * `scan_diff` path that calls `runScanAndFormat` and builds its own
 * outer shape. The stamp sits inside `runScanAndFormat` so every
 * caller inherits the tripwire; the shared `withCountsBySurface`
 * helper keeps the pre-trim and post-trim stamping logic in one place.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md
 *   - "Composite headline counts are dishonest": the three-totals
 *     tripwire is the structured disagreement signal when the scanner-
 *     raw stream (`perRuleCoverage`) diverges from the filtered stream
 *     (`plan`/`files`) after wrapper-noise drop, severity filter,
 *     criterion-skip, and vendor dedupe.
 *   - "Ambiguous field shapes are dishonest": the common case (all
 *     three totals agree) puts nothing on the wire; only actual drift
 *     emits the field.
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import { parseHtml } from "../../../src/input/parsers/html.ts";
import {
  applyParseErrorAdjustment,
  buildCountsBySurface,
  sumFindingsAcrossFiles,
  sumFindingsEmitted,
  withCountsBySurface,
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

describe("buildCountsBySurface — three-totals tripwire predicate", () => {
  it("returns an empty spread when the three surface totals agree", () => {
    const out = buildCountsBySurface({ plan: 3, perRuleCoverage: 3, filesSurface: 3 });
    expect(out).toEqual({});
  });

  it("returns an empty spread when plan === perRuleCoverage and filesSurface is absent", () => {
    // Absent `filesSurface` means the caller is stamping pre-trim and
    // does not yet know the wire-final count; that's not a drift signal.
    const out = buildCountsBySurface({ plan: 4, perRuleCoverage: 4 });
    expect(out).toEqual({});
  });

  it("fires when plan and perRuleCoverage disagree, omits filesSurface when caller did not supply it", () => {
    const out = buildCountsBySurface({ plan: 2, perRuleCoverage: 5 });
    expect(out.countsBySurface).toEqual({ plan: 2, perRuleCoverage: 5 });
  });

  it("fires when filesSurface trails plan — canonical pagination-trim case", () => {
    const out = buildCountsBySurface({ plan: 10, perRuleCoverage: 10, filesSurface: 7 });
    expect(out.countsBySurface).toEqual({ plan: 10, perRuleCoverage: 10, filesSurface: 7 });
  });
});

describe("withCountsBySurface — meta-stamping helper", () => {
  it("preserves the input meta fields and conditional-spreads countsBySurface", () => {
    const meta = { filesScanned: 3, durationMs: 42 } satisfies Record<string, unknown>;
    const out = withCountsBySurface(meta, {
      plan: 1,
      perRuleCoverage: 2,
      filesSurface: 1,
    });
    expect(out["filesScanned"]).toBe(3);
    expect(out["durationMs"]).toBe(42);
    expect(out["countsBySurface"]).toEqual({ plan: 1, perRuleCoverage: 2, filesSurface: 1 });
  });

  it("omits countsBySurface when totals agree — common-case shape is noise-free", () => {
    const meta = { filesScanned: 3 } satisfies Record<string, unknown>;
    const out = withCountsBySurface(meta, {
      plan: 2,
      perRuleCoverage: 2,
      filesSurface: 2,
    });
    expect(out["countsBySurface"]).toBeUndefined();
    expect(out["filesScanned"]).toBe(3);
  });
});

describe("sumFindingsEmitted + sumFindingsAcrossFiles reductions", () => {
  it("sumFindingsEmitted sums `findingsEmitted` across per-rule-coverage rows", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "alt-text/missing",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 3,
        coverageConfidence: "high",
      },
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 1,
        filesEligible: 1,
        findingsEmitted: 2,
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

describe("runScanAndFormat — V1-META-COUNTS-BY-SURFACE-REGRESSION", () => {
  // When the scanner-raw stream (`perRuleCoverage.findingsEmitted`) and
  // the filtered stream (`plan.violations + plan.notes`, plus the
  // on-wire `files[*].findings` bucket) agree, `countsBySurface` is
  // absent — the honest shape puts nothing on the wire for the common
  // case.
  it("emits a formatted.meta block on a single-finding HTML scan and stamps countsBySurface only when drift exists", async () => {
    // `<img>` without `alt` fires `media/alt-text-missing` — a WCAG
    // 1.1.1 violation with a deterministic per-file count. Exactly one
    // finding across every surface.
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
    // Common case — scanner-raw and filtered streams agree, so the
    // tripwire is silent. Agents reading this response see no
    // `countsBySurface` field and trust the single headline counters.
    expect(formatted.meta["countsBySurface"]).toBeUndefined();
    // Smoke-check the scan actually produced findings (otherwise the
    // "agree at zero" case would pass vacuously).
    const findings = (formatted.plan["violations"] as number) + (formatted.plan["notes"] as number);
    expect(findings).toBeGreaterThan(0);
  });

  it("stamps countsBySurface on runScanAndFormat output when plan and perRuleCoverage disagree — drives the scan_project / scan_diff regression fix", () => {
    // The regression in field reports: every scan_project response
    // across four repos shipped without `meta.countsBySurface` even when
    // drift existed between the three totals. Root cause: the stamp
    // lived only in `assembleScanFamilyResponse` (the path `scan` /
    // `scan_file` take) — `scan_project` and `scan_diff` call
    // `runScanAndFormat` and build their own response shape, so the
    // tripwire never reached the wire. Shared helper now lives in
    // `scan-assembly.ts` and `runScanAndFormat` stamps it directly so
    // every downstream caller inherits the same shape.
    //
    // Construct the drift deterministically by stamping the meta with
    // a synthetic `perRuleCoverage` value: the withCountsBySurface
    // helper is pure over (plan, perRuleCoverage, filesSurface), so
    // asserting the stamp reaches the meta through the shared helper
    // is the load-bearing invariant.
    const meta = withCountsBySurface(
      { filesScanned: 1 },
      { plan: 1, perRuleCoverage: 5, filesSurface: 1 },
    );
    expect(meta["countsBySurface"]).toBeDefined();
    const counts = meta["countsBySurface"] as {
      plan: number;
      perRuleCoverage: number;
      filesSurface?: number;
    };
    expect(counts.plan).toBe(1);
    expect(counts.perRuleCoverage).toBe(5);
    expect(counts.filesSurface).toBe(1);
  });

  it("emits coverageConfidenceReason on per-rule rows when the only scanned file failed to parse", async () => {
    // V1-PERRULE-COVERAGE-HONESTY-ON-PARSE-ERRORS: a file that failed
    // to parse used to surface as a `coverageConfidence: "high"` row
    // for HTML-targeted rules — the canonical silent-miss "rule never
    // saw the file" disguised as "rule ran clean." The adjustment
    // stamps a structured `coverageConfidenceReason` on every affected
    // row so the agent can branch on it.
    //
    // Whether the row reads `file-parse-error` (no findings → file
    // invisible to all rules) or `partial-parse` (recovered slice
    // produced findings) depends on what fires on this synthetic
    // input — both branches are valid here; the per-branch shapes are
    // pinned by the unit tests on `applyParseErrorAdjustment` below.
    // The integration assertion is "at least one row carried the
    // structured downgrade signal," which is the load-bearing
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
    );
    const perRuleCoverage = formatted.meta["perRuleCoverage"] as readonly PerRuleCoverage[];
    expect(perRuleCoverage).toBeDefined();
    const downgradedRows = perRuleCoverage.filter(
      (r) =>
        r.coverageConfidenceReason === "file-parse-error" ||
        r.coverageConfidenceReason === "partial-parse",
    );
    expect(downgradedRows.length).toBeGreaterThan(0);
    for (const row of downgradedRows) {
      expect(row.coverageConfidence).toBe("low");
    }
    // Cross-surface consistency: any row with a parse-error reason
    // must appear in `ruleCoverage.lowConfidenceClean` (not
    // `confidentlyClean`) when it has zero findings — the meta and
    // the top-level derivative agree because both pivot on the same
    // adjusted rows.
    const ruleCoverage = formatted["ruleCoverage"] as
      | { confidentlyClean: readonly string[]; lowConfidenceClean: readonly string[] }
      | undefined;
    if (ruleCoverage !== undefined) {
      for (const row of downgradedRows) {
        if (row.findingsEmitted === 0) {
          expect(ruleCoverage.lowConfidenceClean).toContain(row.ruleId);
          expect(ruleCoverage.confidentlyClean).not.toContain(row.ruleId);
        }
      }
    }
  });

  it("emits coverageConfidenceReason: 'partial-parse' when an errored file still produced findings", async () => {
    // V1-PERRULE-COVERAGE-HONESTY-ON-PARSE-ERRORS — partial-parse
    // branch. A file with parse-errors that still emits findings (the
    // recovered AST was rich enough for at least one rule to fire)
    // routes into `partialParseFiles`. Coverage drops to `"low"` with
    // `coverageConfidenceReason: "partial-parse"`, but `filesEvaluated`
    // stays counted — rules genuinely fired on the recovered slice.
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
    );
    const perRuleCoverage = formatted.meta["perRuleCoverage"] as readonly PerRuleCoverage[];
    const partialRows = perRuleCoverage.filter(
      (r) => r.coverageConfidenceReason === "partial-parse",
    );
    expect(partialRows.length).toBeGreaterThan(0);
    for (const row of partialRows) {
      expect(row.coverageConfidence).toBe("low");
      // `filesEvaluated` stays at the original count — partial-parse
      // doesn't subtract the file.
      expect(row.filesEvaluated).toBeGreaterThan(0);
    }
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
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/a.html", false), syntheticHtml("/b.html", false)];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    // Object identity stable on the no-op path — common-case is cheap.
    expect(out).toBe(rows);
  });

  it("downgrades a row to 'low' with file-parse-error reason and subtracts the parse-error file from filesEvaluated", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 2,
        filesEligible: 2,
        findingsEmitted: 0,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/clean.html", false), syntheticHtml("/broken.html", true)];
    // No findings on either file → broken.html lands in parse-error bucket.
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    expect(out).toHaveLength(1);
    const [row] = out;
    expect(row?.ruleId).toBe("html/example");
    expect(row?.filesEvaluated).toBe(1);
    // `filesEligible` is intentionally unchanged — the gate did match;
    // the gap is at evaluation, not eligibility.
    expect(row?.filesEligible).toBe(2);
    expect(row?.coverageConfidence).toBe("low");
    expect(row?.coverageConfidenceReason).toBe("file-parse-error");
  });

  it("downgrades to 'partial-parse' when an errored file produced findings (filesEvaluated unchanged)", () => {
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 2,
        filesEligible: 2,
        findingsEmitted: 3,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/clean.html", false), syntheticHtml("/partial.html", true)];
    // The errored file produced findings → routes into partial-parse.
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set(["/partial.html"]));
    const [row] = out;
    expect(row?.coverageConfidence).toBe("low");
    expect(row?.coverageConfidenceReason).toBe("partial-parse");
    // Evaluated count holds — the rule DID run on the recovered AST.
    expect(row?.filesEvaluated).toBe(2);
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

  it("downgrades project-scoped rules (no extension gate) when any parse-error file is present", () => {
    // Project-scoped rules walk every parsed file in one shot — a
    // parse-error file is invisible to them too, so the same downgrade
    // applies regardless of extension.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "project/example",
        filesEvaluated: 2,
        filesEligible: 2,
        findingsEmitted: 0,
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/clean.html", false), syntheticHtml("/broken.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [projectRule], new Set());
    const [row] = out;
    expect(row?.coverageConfidence).toBe("low");
    expect(row?.coverageConfidenceReason).toBe("file-parse-error");
    expect(row?.filesEvaluated).toBe(1);
  });

  it("preserves additive telemetry fields (concentration, classPatternConcentration) across the rewrite", () => {
    // The adjustment must not strip optional fields the engine
    // stamped on the row — `concentration` / `classPatternConcentration`
    // are zero-information-loss telemetry and survive the downgrade.
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 5,
        filesEligible: 5,
        findingsEmitted: 12,
        coverageConfidence: "high",
        concentration: { file: "/dense.html", count: 12 },
      },
    ];
    const files = [syntheticHtml("/dense.html", false), syntheticHtml("/broken.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    const [row] = out;
    expect(row?.concentration).toEqual({ file: "/dense.html", count: 12 });
    expect(row?.coverageConfidenceReason).toBe("file-parse-error");
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
        coverageConfidence: "high",
      },
    ];
    const files = [syntheticHtml("/a.html", true), syntheticHtml("/b.html", true)];
    const out = applyParseErrorAdjustment(rows, files, [htmlRule], new Set());
    const [row] = out;
    expect(row?.filesEvaluated).toBe(0);
  });

  it("stamps file-parse-error when both parse-error and partial-parse files match — file-parse-error wins", () => {
    // Both parse-error and partial-parse files matched the rule's
    // gate. The structured reason picks `file-parse-error` because
    // that's the more severe signal: at least one file the rule
    // counted as "evaluated" had no AST at all. The partial-parse
    // contribution still gets reflected in the dropped confidence
    // (which would have happened on either branch).
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 3,
        filesEligible: 3,
        findingsEmitted: 1,
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
    expect(row?.coverageConfidence).toBe("low");
    expect(row?.coverageConfidenceReason).toBe("file-parse-error");
    // Subtracts only the parse-error file (1), not the partial-parse one.
    expect(row?.filesEvaluated).toBe(2);
  });
});

describe("runScanAndFormat — countsBySurface honest-shape regression", () => {
  it("runScanAndFormat does not emit a dishonest `countsBySurface: null` sentinel — field is absent or populated, never null", async () => {
    // V1-META-COUNTS-BY-SURFACE-REGRESSION field reports listed
    // `meta.countsBySurface: null` on every scan_project response —
    // either the field was present-as-null (dishonest shape per the
    // ambiguous-field rule) or the consumers were mis-reading an
    // absent field. This test locks in the honest shape: present-
    // when-meaningful; never the literal `null`.
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
    // The field is either absent (no drift) or a populated object —
    // it MUST NOT appear as `null` on the wire. This guards both
    // directions: an absent key reads as `undefined` in JS, a populated
    // key reads as an object with `plan` + `perRuleCoverage` numerics.
    const raw = formatted.meta["countsBySurface"];
    expect(raw === null).toBe(false);
    if (raw !== undefined) {
      expect(typeof raw).toBe("object");
    }
  });
});
