/**
 * Invariant: scan_project, coverage, and checklist must report the
 * same `manual review required` count for the same scan inputs.
 *
 * Drift between these surfaces was the dominant friction across ~30
 * unbiased agent reviews of the MCP server. The shared helper in
 * src/mcp/manual-applicability.ts is the canonical source; this test
 * confirms every consumer agrees, in both media-free and media-present
 * scenarios, so future refactors that introduce a new surface (or
 * forget to plumb the helper through) fail loudly.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  proc.stdin.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

const initMsg = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});
const toolCall = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

async function makeMediaFreeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-counts-mediafree-"));
  await writeFile(join(dir, "page.html"), "<html><body><p>hello</p></body></html>");
  return dir;
}

async function makeMediaPresentFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-counts-media-"));
  await writeFile(join(dir, "page.html"), `<html><body><video src="x.mp4"></video></body></html>`);
  return dir;
}

interface ScanBody {
  readonly plan: {
    readonly actionableManualItems: number;
    readonly untargetedCriteria: number;
  };
}
interface CoverageBody {
  // The legacy composite `criteriaManualReviewRequired` was deleted
  // (mirroring the precedent on `plan.totalFindings`). Coverage now
  // ships the same two top-level counters `scan_project.plan` and
  // `checklist.summary` already split into — `actionableManualItems`
  // (criteria with grounded candidates) and `untargetedCriteria`
  // (applicable manual-only with no candidate). Callers that want the
  // former composite total sum the two on read.
  readonly actionableManualItems: number;
  readonly untargetedCriteria: number;
}
interface ChecklistBody {
  readonly summary: {
    readonly actionable: {
      readonly criteria: number;
      readonly candidatesUncapped: number;
      readonly candidatesReturned: number;
    };
    readonly untargetedCriteria: number;
  };
  readonly totalCandidates?: number;
}

async function gatherCounts(cwd: string): Promise<{
  scan: number;
  coverage: number;
  checklist: number;
  scanActionable: number;
  coverageActionable: number;
  checklistActionable: number;
  scanUntargeted: number;
  coverageUntargeted: number;
  checklistUntargeted: number;
}> {
  const responses = await mcpSession([
    initMsg(1),
    toolCall(2, "scan_project", { cwd }),
    toolCall(3, "coverage", { cwd }),
    toolCall(4, "checklist", { cwd }),
  ]);
  const scanBody = body<ScanBody>(responses[1]);
  const coverageBody = body<CoverageBody>(responses[2]);
  const checklistBody = body<ChecklistBody>(responses[3]);
  return {
    // Re-derive the cross-tool total from the split top-level fields
    // on every surface. The composite `manualReviewRequired` was
    // dropped from scan_project's plan, checklist's summary, AND
    // coverage (Q13) — the dishonest-headline pattern is the same on
    // every surface. The invariant is still "all surfaces agree on the
    // total", just computed from the honest parts everywhere.
    scan: scanBody.plan.actionableManualItems + scanBody.plan.untargetedCriteria,
    coverage: coverageBody.actionableManualItems + coverageBody.untargetedCriteria,
    checklist: checklistBody.summary.actionable.criteria + checklistBody.summary.untargetedCriteria,
    scanActionable: scanBody.plan.actionableManualItems,
    coverageActionable: coverageBody.actionableManualItems,
    checklistActionable: checklistBody.summary.actionable.criteria,
    scanUntargeted: scanBody.plan.untargetedCriteria,
    coverageUntargeted: coverageBody.untargetedCriteria,
    checklistUntargeted: checklistBody.summary.untargetedCriteria,
  };
}

/**
 * Builds a fixture that fires a rule (`color/meaning-by-color-only`)
 * which satisfies a metadata-manual criterion (`wcag22:1.4.1`,
 * `automatable: "manual"`). This is the canonical shape the
 * `untargetedCriteria` cross-surface invariant exists to guard:
 * pre-helper, `scan_project` counted such criteria as still-needing-
 * manual-review (because `collectManualCriteria` filtered only on
 * metadata, not on whether a rule had fired) while `coverage` and
 * `checklist` correctly routed them into the failing-automated lane.
 * The integration test below asserts all three surfaces report the
 * same `untargetedCriteria` count on this fixture — drift here means
 * the helper has been bypassed somewhere.
 */
async function makeFiredManualCriterionFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-counts-fired-manual-"));
  // `btn-danger` is a status-color class; "Submit" carries no status
  // keyword to satisfy the prose-channel pass condition; no icon /
  // sr-only / aria-label / role. The rule fires, emits a violation
  // against `wcag22:1.4.1`, and the criterion drops out of the
  // manual-review queue on the helper-aware surfaces.
  await writeFile(
    join(dir, "page.html"),
    `<html><body><button class="btn-danger">Submit</button></body></html>`,
  );
  return dir;
}

describe("MCP invariant: manual-review count agrees across surfaces", () => {
  it("agrees on a media-free fixture (likelyIrrelevant > 0)", async () => {
    const dir = await makeMediaFreeFixture();
    const counts = await gatherCounts(dir);
    expect(counts.scan).toBe(counts.coverage);
    expect(counts.coverage).toBe(counts.checklist);
  });

  it("agrees on a media-present fixture (likelyIrrelevant = 0)", async () => {
    const dir = await makeMediaPresentFixture();
    const counts = await gatherCounts(dir);
    expect(counts.scan).toBe(counts.coverage);
    expect(counts.coverage).toBe(counts.checklist);
  });

  it("scan.plan.actionableManualItems agrees with checklist.summary.actionable.criteria and coverage.actionableManualItems", async () => {
    // Without this, an agent reading a (formerly inflated) composite
    // manual-review headline (e.g., 21) would have to call checklist
    // just to learn that only a handful (e.g., 4) are grounded in
    // file:line candidates. Exposing the actionable count inline
    // saves the round trip.
    //
    // The same counter also rides on `coverage` as
    // `actionableManualItems` — same name on every project-rooted
    // surface so the agent can compare without a translation table.
    // The legacy composite `criteriaManualReviewRequired` was deleted;
    // only the structured per-lane siblings carry the count now.
    const mediaFree = await gatherCounts(await makeMediaFreeFixture());
    expect(mediaFree.scanActionable).toBe(mediaFree.checklistActionable);
    expect(mediaFree.scanActionable).toBe(mediaFree.coverageActionable);
    expect(mediaFree.scanActionable).toBeLessThanOrEqual(mediaFree.scan);
  });

  it("the two fixtures produce different counts (proves likelyIrrelevant filtering applies)", async () => {
    const mediaFree = await gatherCounts(await makeMediaFreeFixture());
    const mediaPresent = await gatherCounts(await makeMediaPresentFixture());
    expect(mediaPresent.checklist).toBeGreaterThan(mediaFree.checklist);
  });
});

// Q8: the untargetedCriteria sub-counter must agree across surfaces too,
// not just the totals. The pre-helper drift between
// `scan_project.plan.untargetedCriteria`,
// `coverage[].untargetedCriteria`, and
// `checklist.summary.untargetedCriteria` was off-by-N on every cwd that
// fired any metadata-manual criterion (e.g. `wcag22:1.4.1` via
// `color/meaning-by-color-only`) — `scan_project` kept the fired
// criterion in the manual queue because `collectManualCriteria` only
// filtered on metadata; `coverage` and `checklist` routed it into the
// failing lane via `buildCoverageReport`. Now all three surfaces share
// `tallyManualCriteria` / `tallyManualCriteriaFromCoverage` so the
// counts are derived once and the cross-surface agreement is mechanical.
describe("MCP invariant: untargetedCriteria agrees across surfaces", () => {
  it("agrees on a media-free fixture (no fired manual criteria)", async () => {
    const counts = await gatherCounts(await makeMediaFreeFixture());
    expect(counts.scanUntargeted).toBe(counts.coverageUntargeted);
    expect(counts.coverageUntargeted).toBe(counts.checklistUntargeted);
  });

  it("agrees on a media-present fixture (likelyIrrelevant = 0)", async () => {
    const counts = await gatherCounts(await makeMediaPresentFixture());
    expect(counts.scanUntargeted).toBe(counts.coverageUntargeted);
    expect(counts.coverageUntargeted).toBe(counts.checklistUntargeted);
  });

  it("agrees on a fixture that fires a metadata-manual criterion", async () => {
    // The canonical drift case: a fired wcag22:1.4.1 violation. Pre-helper,
    // scan_project.plan.untargetedCriteria over-counted by 1 vs
    // coverage/checklist on this shape because the manual-set filter on
    // scan_project's side didn't subtract fired criteria.
    const counts = await gatherCounts(await makeFiredManualCriterionFixture());
    expect(counts.scanUntargeted).toBe(counts.coverageUntargeted);
    expect(counts.coverageUntargeted).toBe(counts.checklistUntargeted);
  });
});

// ADR 0024 stage 4: the scan-derivative
// tools (`checklist`, `coverage`, `conformance_statement`) now route
// their scan-confidence warnings through the same
// `buildDerivativeScanWarnings` seam the primary scan tools use. The
// invariant is that the structured codes fire consistently across the
// primary + derivative surfaces on the same input — drift here is the
// silent-miss failure mode ADR 0024 was written to close, where
// `scan_project` says "nothing was scanned" via `scanned_zero_files`
// but `checklist` reads as a clean manual queue over an empty
// codebase.
describe("MCP invariant: derivative tools emit the same scan-confidence warnings as the primary scan tools", () => {
  it("scanned_zero_files fires on all four surfaces for the same empty scan root", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ra11y-derivative-warnings-"));
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: empty }),
      toolCall(3, "coverage", { cwd: empty }),
      toolCall(4, "checklist", { cwd: empty }),
      toolCall(5, "conformance_statement", { cwd: empty, standard: "wcag22", level: "AA" }),
    ]);
    const shapes = responses
      .slice(1, 5)
      .map((r) => body<{ warnings?: readonly string[] }>(r).warnings ?? []);
    for (const warnings of shapes) {
      expect(warnings).toContain("scanned_zero_files");
    }
  });
});

// Cross-surface count invariant — second-pass coverage. The first
// describe blocks above pin equality on the manual-review tally and the
// untargetedCriteria sub-counter. The blocks below extend the invariant
// to the two remaining counters the field-test sweeps observed
// drifting on real corpora: `actionableManualItems` agreement with
// `coverage[].manualWithCandidates.length`, and `parseErrorFileCount`
// agreement between `scan_project` and `coverage` on the same cwd.
//
// Doctrine: every shared cross-tool counter must be derived from one
// shared helper, and an integration test must pin equality on
// identical cwd. See `docs/kb/architecture/ai-first-consumer.md`
// "Cross-surface count invariant."
/**
 * `coverage` returns the spread per-standard entry at the top level
 * when only one standard is enabled (single-entry response shape per
 * `tool-coverage.ts` `entries.length === 1` branch). Multi-standard
 * scans surface as a top-level array. Tests below use the default
 * single-standard path, so the envelope flattens `manualWithCandidates`
 * to the top level alongside `analysisCoverage`.
 */
interface FullCoverageEnvelope extends CoverageBody {
  readonly manualWithCandidates?: ReadonlyArray<unknown>;
  readonly manualCandidatesTotal?: number;
  readonly summary?: {
    readonly actionable?: { readonly criteria?: number; readonly candidates?: number };
  };
  readonly analysisCoverage?: { readonly parseErrorFileCount?: number };
}
interface ScanBodyExt extends ScanBody {
  readonly meta?: {
    readonly analysisCoverage?: { readonly parseErrorFileCount?: number };
  };
}

/**
 * Builds a fixture where one file errors at parse time so the
 * `parseErrorFiles` bucket has at least one path. The TSX parser
 * bails on `<div ` without a matching `</div>`, which is the
 * canonical "fully-failed parse" shape — no recoverable AST, the
 * file lands in `parseErrorFiles` (not `partialParseFiles`).
 *
 * The clean `page.html` sibling keeps `filesScanned > 0` so the
 * `scanned_zero_files` warning doesn't fire and the response carries
 * an `analysisCoverage` block to compare across tools.
 */
async function makeParseErrorFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-parse-error-"));
  await writeFile(join(dir, "page.html"), `<html><body><p>hello</p></body></html>`);
  await writeFile(join(dir, "broken.tsx"), `const x = function(){return <div without close;`);
  return dir;
}

describe("MCP invariant: actionable count matches coverage's manualWithCandidates list", () => {
  it("scan.plan.actionableManualItems === coverage.entries[0].manualWithCandidates.length", async () => {
    const dir = await makeFiredManualCriterionFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const scanBody = body<ScanBody>(responses[1]);
    const coverageEnvelope = body<FullCoverageEnvelope>(responses[2]);
    const checklistBody = body<ChecklistBody>(responses[3]);
    const manualWithCandidatesLen = coverageEnvelope.manualWithCandidates?.length ?? 0;
    expect(scanBody.plan.actionableManualItems).toBe(manualWithCandidatesLen);
    expect(checklistBody.summary.actionable.criteria).toBe(manualWithCandidatesLen);
  });
});

// Cross-surface count invariant — candidate-axis sibling to the
// criteria-axis `actionableManualItems` invariant above. Pre-fix,
// `checklist.summary.totalCandidates` was the only project-rooted
// counter that reported the candidate-level tally; an agent asking
// "how many manual-review items are there" had to read three numbers
// (`coverage.manualWithCandidates: N` criteria-axis,
// `checklist.summary.actionable.criteria: M` criteria-axis,
// `checklist.totalCandidates: K` candidate-axis) and disambiguate by
// reading field names carefully. `coverage.manualCandidatesTotal`
// closes the gap so coverage carries both axes — `actionableManualItems`
// (criteria) and `manualCandidatesTotal` (candidates) — and the
// candidate-axis number agrees across surfaces. Doctrine:
// `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
// invariant" + "Sibling fields naming the same concept must use one
// shape" — the candidate-vs-criteria split is named, not implied.
describe("MCP invariant: manualCandidatesTotal agrees with checklist's candidate-level tally", () => {
  it("coverage.manualCandidatesTotal === checklist.summary.actionable.candidatesUncapped === checklist.totalCandidates", async () => {
    // Media-present fixture seeds grounded candidates via the
    // `review/media-variants` finder fanning out wcag22:1.2.* criteria
    // — the fired-manual fixture used by the criteria-axis invariants
    // above only emits a violation, so its candidate-axis count is 0
    // and an equality assertion on the candidate-axis would pass
    // vacuously without exercising the new field.
    const dir = await makeMediaPresentFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const coverageEnvelope = body<FullCoverageEnvelope>(responses[1]);
    const checklistBody = body<ChecklistBody>(responses[2]);
    const coverageCandidatesTotal = coverageEnvelope.manualCandidatesTotal ?? 0;
    const checklistUncapped = checklistBody.summary.actionable.candidatesUncapped;
    const checklistTotal = checklistBody.totalCandidates ?? 0;
    // Sanity floor — the media-present fixture must emit at least one
    // grounded candidate; a 0/0/0 result here would mean the finders
    // stopped firing and the assertion would pass vacuously.
    expect(coverageCandidatesTotal).toBeGreaterThan(0);
    expect(coverageCandidatesTotal).toBe(checklistUncapped);
    expect(coverageCandidatesTotal).toBe(checklistTotal);
  });

  it("coverage.summary.actionable.candidates mirrors the same candidate-axis count", async () => {
    // The candidate-vs-criteria split is exposed twice on the coverage
    // envelope: once as the top-level `manualCandidatesTotal` scalar
    // (sibling to `actionableManualItems`), and once nested under
    // `summary.actionable.candidates` (sibling to
    // `summary.actionable.criteria`, mirroring `checklist.summary.actionable`).
    // Both must agree — they read the same underlying tally; a
    // disagreement would be the dishonest two-sibling-fields-naming-
    // the-same-concept shape the doctrine warns against.
    const dir = await makeMediaPresentFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverageEnvelope = body<FullCoverageEnvelope>(responses[1]);
    expect(coverageEnvelope.summary?.actionable?.candidates).toBe(
      coverageEnvelope.manualCandidatesTotal,
    );
    expect(coverageEnvelope.summary?.actionable?.criteria).toBe(
      coverageEnvelope.manualWithCandidates?.length ?? 0,
    );
  });
});

describe("MCP invariant: parseErrorFileCount agrees between scan_project and coverage", () => {
  it("emits identical parseErrorFileCount on identical cwd with parse failures", async () => {
    const dir = await makeParseErrorFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
      toolCall(3, "coverage", { cwd: dir, verboseMeta: true }),
    ]);
    const scanBody = body<ScanBodyExt>(responses[1]);
    const coverageEnvelope = body<FullCoverageEnvelope>(responses[2]);
    const scanCount = scanBody.meta?.analysisCoverage?.parseErrorFileCount ?? 0;
    const coverageCount = coverageEnvelope.analysisCoverage?.parseErrorFileCount ?? 0;
    // The fixture intentionally seeds a parse-error file (`broken.tsx`
    // with an unclosed `<div`); both surfaces must observe at least
    // one. A 0/0 result here would mean the fixture isn't tripping
    // the parser and the test passes trivially.
    expect(scanCount).toBeGreaterThan(0);
    expect(scanCount).toBe(coverageCount);
  });

  it("emits identical parseErrorFileCount on a clean fixture (zero on both sides)", async () => {
    const dir = await makeMediaFreeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
    ]);
    const scanBody = body<ScanBodyExt>(responses[1]);
    const coverageEnvelope = body<FullCoverageEnvelope>(responses[2]);
    const scanCount = scanBody.meta?.analysisCoverage?.parseErrorFileCount ?? 0;
    const coverageCount = coverageEnvelope.analysisCoverage?.parseErrorFileCount ?? 0;
    expect(scanCount).toBe(coverageCount);
  });
});

/**
 * Per-bucket cross-surface invariant. The total `parseErrorFileCount` +
 * `partialParseFileCount` may agree across surfaces while the bucket
 * assignment drifts — the field-test reported scan_project: 100/105 and
 * checklist+coverage: 92/113 with totals matching 205==205. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant" the agreement requirement extends to every sub-counter
 * an agent budgets against, not just the headline; an agent reading
 * `parseErrorFiles` (invisible-to-rules) on coverage and the same paths
 * appearing in `partialParseFiles` (live findings) on scan_project hits
 * the silent-miss failure mode the doctrine warns against.
 *
 * Drift root cause: `findingFilePaths` (the predicate that chooses the
 * bucket for an errored file) is derived from the scan's
 * `result.violations` ∪ `report.candidates`. `coverage` and `checklist`
 * previously called {@link runScan} without threading
 * `nativeWrapperElements` or `processes`, while `scan_project` did —
 * so the same cwd produced different `result.violations` across
 * surfaces, and the bucket assignment downstream silently disagreed.
 * Closure: shared {@link runScanForCrossSurfaceParity} helper threads
 * both inputs from `projectConfig` consistently across all three.
 */
interface ParseCoverageBucketsTopLevel {
  readonly analysisCoverage?: {
    readonly parseErrorFileCount?: number;
    readonly partialParseFileCount?: number;
    readonly parseErrorFiles?: readonly { readonly path: string }[];
    readonly partialParseFiles?: readonly { readonly path: string }[];
  };
}
interface ParseCoverageBucketsScanBody {
  readonly meta?: ParseCoverageBucketsTopLevel;
}

describe("MCP invariant: parse-coverage per-bucket assignment agrees across surfaces", () => {
  it("scan_project, coverage, and checklist agree on per-bucket counts and path membership", async () => {
    const dir = await makeParseErrorFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
      toolCall(3, "coverage", { cwd: dir, verboseMeta: true }),
      toolCall(4, "checklist", { cwd: dir, verboseMeta: true }),
    ]);
    const scanBody = body<ParseCoverageBucketsScanBody>(responses[1]);
    const coverageEnv = body<ParseCoverageBucketsTopLevel>(responses[2]);
    // checklist surfaces `analysisCoverage` at the top level (mirroring
    // coverage), not under `meta` — same shape coverage uses.
    const checklistEnv = body<ParseCoverageBucketsTopLevel>(responses[3]);

    const scanParseCount = scanBody.meta?.analysisCoverage?.parseErrorFileCount ?? 0;
    const scanPartialCount = scanBody.meta?.analysisCoverage?.partialParseFileCount ?? 0;
    const coverageParseCount = coverageEnv.analysisCoverage?.parseErrorFileCount ?? 0;
    const coveragePartialCount = coverageEnv.analysisCoverage?.partialParseFileCount ?? 0;
    const checklistParseCount = checklistEnv.analysisCoverage?.parseErrorFileCount ?? 0;
    const checklistPartialCount = checklistEnv.analysisCoverage?.partialParseFileCount ?? 0;

    // Per-bucket count equality (the field-test failure mode).
    expect(coverageParseCount).toBe(scanParseCount);
    expect(coveragePartialCount).toBe(scanPartialCount);
    expect(checklistParseCount).toBe(scanParseCount);
    expect(checklistPartialCount).toBe(scanPartialCount);

    // Sanity floor — the fixture seeds a parse-error file, so at least
    // one bucket on every surface is non-empty.
    expect(scanParseCount + scanPartialCount).toBeGreaterThan(0);

    // Per-bucket membership equality. The path-set comparison is what
    // catches a drift that sums cleanly but reshuffles entries — the
    // canonical 100/105 vs 92/113 failure shape (totals match, buckets
    // disagree by 8 paths). Inline lists are present-when-meaningful
    // under verboseMeta=true, so falling through to empty-set
    // comparisons here would silently pass on a regression that gutted
    // both lists. The sanity floor above guards against that.
    const scanParsePaths = new Set(
      (scanBody.meta?.analysisCoverage?.parseErrorFiles ?? []).map((e) => e.path),
    );
    const scanPartialPaths = new Set(
      (scanBody.meta?.analysisCoverage?.partialParseFiles ?? []).map((e) => e.path),
    );
    const coverageParsePaths = new Set(
      (coverageEnv.analysisCoverage?.parseErrorFiles ?? []).map((e) => e.path),
    );
    const coveragePartialPaths = new Set(
      (coverageEnv.analysisCoverage?.partialParseFiles ?? []).map((e) => e.path),
    );
    const checklistParsePaths = new Set(
      (checklistEnv.analysisCoverage?.parseErrorFiles ?? []).map((e) => e.path),
    );
    const checklistPartialPaths = new Set(
      (checklistEnv.analysisCoverage?.partialParseFiles ?? []).map((e) => e.path),
    );

    expect([...coverageParsePaths].sort()).toEqual([...scanParsePaths].sort());
    expect([...coveragePartialPaths].sort()).toEqual([...scanPartialPaths].sort());
    expect([...checklistParsePaths].sort()).toEqual([...scanParsePaths].sort());
    expect([...checklistPartialPaths].sort()).toEqual([...scanPartialPaths].sort());
  });
});

/**
 * Builds a fixture where a minified vendor file at a `.min.js` path
 * carries a comparison expression (`r.length<b.length`) that the TSX
 * parser reads as an unclosed `<r.length>` JSX element. The file would
 * historically appear in BOTH `meta.scannedBuildArtifacts.grouped` (or
 * `ungrouped`) AND `meta.analysisCoverage.parseErrorFiles[]` with
 * contradictory reasons ("definite-min-infix" vs "Unclosed JSX
 * element"). The clean `page.html` sibling keeps `filesScanned > 0`
 * so `analysisCoverage` actually rides on the response.
 *
 * Three identically-named-basename siblings nudge the build-artifact
 * grouper toward `grouped` over `ungrouped` for stability — the
 * invariant under test (no path appears in both lists) holds either
 * way, but assertion against `grouped` is the more common bulk-corpus
 * shape.
 */
async function makeBuildArtifactParseErrorFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-bld-art-parse-err-"));
  await writeFile(join(dir, "page.html"), `<html><body><p>hello</p></body></html>`);
  // Minified-shape JS: TSX parser reads `r.length<b.length` as a JSX
  // tag open and trips on the missing close. `.min.js` infix flips
  // the build-artifact classifier to `definite-min-infix`.
  const minified = `var r=function(b){return r.length<b.length?r:b};module.exports=r;`;
  await writeFile(join(dir, "jquery.min.js"), minified);
  await writeFile(join(dir, "lodash.min.js"), minified);
  await writeFile(join(dir, "modernizr.min.js"), minified);
  return dir;
}

interface BuildArtifactGroupShape {
  readonly basename: string;
}
interface BuildArtifactClassifiedShape {
  readonly path: string;
}
interface ScanBodyForArtifactInvariant {
  readonly meta?: {
    readonly scannedBuildArtifacts?: {
      readonly grouped?: readonly BuildArtifactGroupShape[];
      readonly classified?: readonly BuildArtifactClassifiedShape[];
    };
    readonly analysisCoverage?: {
      readonly parseErrorFiles?: readonly { readonly path: string }[];
      readonly partialParseFiles?: readonly { readonly path: string }[];
    };
  };
}

describe("MCP invariant: parseErrorFiles ∩ scannedBuildArtifacts is empty", () => {
  it("a minified vendor file is classified as build artifact only, never co-listed as parse error", async () => {
    const dir = await makeBuildArtifactParseErrorFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
    ]);
    const scanBody = body<ScanBodyForArtifactInvariant>(responses[1]);
    const classified = scanBody.meta?.scannedBuildArtifacts?.classified ?? [];
    const grouped = scanBody.meta?.scannedBuildArtifacts?.grouped ?? [];
    const buildArtifactPaths = new Set<string>(classified.map((e) => e.path));
    // Sanity: at least one of the seeded `.min.js` paths landed in the
    // build-artifact list (either `classified[]` directly or grouped
    // by basename — three same-basename peers don't always cluster,
    // but every one carries `.min.` in the basename and triggers the
    // `definite-min-infix` predicate). A 0/0 result here would mean
    // the classifier missed the fixture and the disjointness check
    // would pass vacuously.
    const sawArtifactSignal = buildArtifactPaths.size > 0 || grouped.length > 0;
    expect(sawArtifactSignal).toBe(true);
    const parseErrorPaths = new Set(
      (scanBody.meta?.analysisCoverage?.parseErrorFiles ?? []).map((e) => e.path),
    );
    const partialParsePaths = new Set(
      (scanBody.meta?.analysisCoverage?.partialParseFiles ?? []).map((e) => e.path),
    );
    // Every `.min.js` in the fixture must be absent from both
    // parse-error lists. The artifact classifier owns these paths;
    // co-listing them with a phantom `Unclosed JSX element` reason is
    // dishonest in the same way as a heuristic-mislabeled meta
    // sub-field.
    for (const basename of ["jquery.min.js", "lodash.min.js", "modernizr.min.js"]) {
      for (const errPath of parseErrorPaths) {
        expect(errPath.endsWith(basename)).toBe(false);
      }
      for (const errPath of partialParsePaths) {
        expect(errPath.endsWith(basename)).toBe(false);
      }
    }
    // Tighter form: the intersection of build-artifact paths (when the
    // classifier put them in `classified[]` rather than collapsing to
    // a group) and parse-error paths is empty.
    for (const p of buildArtifactPaths) {
      expect(parseErrorPaths.has(p)).toBe(false);
      expect(partialParsePaths.has(p)).toBe(false);
    }
  });
});

// Cross-surface count invariant — `meta.countsBySurface` doctrine pin
// at the wire shape. The unit-level guards in
// `tests/unit/mcp/response-assembler.test.ts` and
// `tests/unit/mcp/scan-assembly.test.ts` cover the assembler functions
// in isolation, but the field-report regressions that motivated the
// removal observed the field on real MCP responses — three disagreeing
// finding totals (`{plan, perRuleCoverage, filesSurface}`) within ONE
// response. This block re-asserts the absence at the wire level on the
// same project-rooted tools the doctrine names (scan_project,
// coverage, checklist), so a future refactor that pipes a new
// "convenience" headline back into the meta block fails here, not in
// the next field-test sweep. Doctrine: see
// `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
// invariant" — a field whose name implies cross-surface reconciliation
// must actually reconcile, not multiply.
async function makeMixedFindingFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-counts-by-surface-"));
  // Multiple files + multiple rule fires — historically the shape that
  // surfaced 3-way drift between the plan tally, the perRuleCoverage
  // sum, and the per-file findings rollup. Even if the current
  // assembler keeps them in lockstep, the test pins the absence of the
  // composite headline that previously framed the disagreement.
  await writeFile(
    join(dir, "page.html"),
    `<html><body>
      <button class="btn-danger">Submit</button>
      <img src="logo.png">
      <video src="x.mp4"></video>
    </body></html>`,
  );
  await writeFile(join(dir, "other.html"), `<html><body><img src="hero.png"></body></html>`);
  return dir;
}

interface MetaShape {
  readonly meta?: Record<string, unknown>;
}

describe("MCP invariant: meta.countsBySurface is absent on every project-rooted tool", () => {
  it("scan_project, coverage, and checklist all omit meta.countsBySurface on a mixed-finding fixture", async () => {
    const dir = await makeMixedFindingFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const scanBody = body<MetaShape>(responses[1]);
    const coverageBody = body<MetaShape>(responses[2]);
    const checklistBody = body<MetaShape>(responses[3]);
    // The composite field is the dishonest shape the doctrine names —
    // a 3- or 4-way internal spread of finding totals framed as
    // cross-surface reconciliation. Each response must answer "no" via
    // omission; an empty-object sentinel would be the same bug in
    // another shape.
    expect(scanBody.meta?.["countsBySurface"]).toBeUndefined();
    expect(coverageBody.meta?.["countsBySurface"]).toBeUndefined();
    expect(checklistBody.meta?.["countsBySurface"]).toBeUndefined();
  });

  it("scan_project still omits meta.countsBySurface under verboseMeta:true", async () => {
    // Verbose mode expands compact summaries into per-row payloads —
    // historically the regression surface where speculative
    // "cross-surface convenience" fields could be tucked alongside
    // expanded perRuleCoverage rows.
    const dir = await makeMixedFindingFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
    ]);
    const scanBody = body<MetaShape>(responses[1]);
    expect(scanBody.meta?.["countsBySurface"]).toBeUndefined();
  });
});

// Silence the unused warning on the helper used implicitly above.
void mkdir;
