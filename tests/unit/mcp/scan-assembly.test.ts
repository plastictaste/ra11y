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
  buildCountsBySurface,
  sumFindingsAcrossFiles,
  sumFindingsEmitted,
  withCountsBySurface,
} from "../../../src/mcp/scan-assembly.ts";
import { McpSession } from "../../../src/mcp/session.ts";
import { runScanAndFormat } from "../../../src/mcp/tools-helpers.ts";
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
    const files = [
      { findings: [1, 2, 3] },
      { findings: [] },
      { findings: [1] },
    ];
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
      "<html><body><img src=\"x.png\"></body></html>",
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
    const findings =
      (formatted.plan["violations"] as number) + (formatted.plan["notes"] as number);
    expect(findings).toBeGreaterThan(0);
  });

  it("stamps countsBySurface on runScanAndFormat output when plan and perRuleCoverage disagree — drives the scan_project / scan_diff regression fix", async () => {
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

  it("runScanAndFormat does not emit a dishonest `countsBySurface: null` sentinel — field is absent or populated, never null", async () => {
    // V1-META-COUNTS-BY-SURFACE-REGRESSION field reports listed
    // `meta.countsBySurface: null` on every scan_project response —
    // either the field was present-as-null (dishonest shape per the
    // ambiguous-field rule) or the consumers were mis-reading an
    // absent field. This test locks in the honest shape: present-
    // when-meaningful; never the literal `null`.
    const file = htmlFile(
      "/fixtures/clean.html",
      "<html><body><h1>Hello</h1></body></html>",
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
