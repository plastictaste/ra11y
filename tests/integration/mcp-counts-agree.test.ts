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
    // The bare `actionableManualItems` scalar was dropped per the
    // same "Composite headline counts are dishonest" precedent on
    // `plan.totalFindings` / `plan.safeEditsAvailable` /
    // `plan.violations` / `plan.summary` / `plan.untargetedCriteria`.
    // Per-scan-kind tally is the honest replacement; consumers that
    // want the flat count sum the two lanes themselves.
    readonly actionableManualItemsBySource: {
      readonly source: number;
      readonly buildArtifact: number;
    };
    readonly untargetedCriteriaForProject: number;
  };
}
interface CoverageBody {
  // The legacy composite `criteriaManualReviewRequired` was deleted
  // (mirroring the precedent on `plan.totalFindings`). Coverage's
  // criteria-axis manual-review count now rides on the structured
  // `summary.actionable.criteria` path that mirrors
  // `checklist.summary.actionable.criteria`. The redundant top-level
  // twins (`actionableManualItems`, `criteriaUntestable`,
  // `automatedCriteriaPassRate`, `manualCandidateEmissionsTotal`,
  // `untargetedCriteriaForProject`, `scanned`) were dropped per
  // AI-first doctrine "Sibling fields naming the same concept must
  // use one shape" — agents read each value through exactly one
  // canonical access path (the nested `summary.*` slot or
  // `meta.scanned`). The bare-prompt array form rides under
  // `untargetedCriteriaList` only when `showUntargeted: true`.
  // The project-walk slice is explicit on the wire under
  // `summary.untargetedCriteriaForProject` — the per-file slice ships
  // under `untargetedCriteriaForFile` from `scan` / `scan_file`.
  readonly summary: {
    readonly actionable: { readonly criteria: number };
    readonly untargetedCriteriaForProject: number;
  };
  // Optional — present-when-meaningful: omitted when no manual
  // criteria carried grounded candidates on this corpus.
  readonly manualWithCandidates?: ReadonlyArray<unknown>;
}
interface ChecklistBody {
  readonly summary: {
    readonly actionable: {
      readonly criteria: number;
      readonly emissionsTotal: number;
      readonly emissionsAfterCollapse: number;
      readonly emissionsReturnedAfterClip: number;
    };
    readonly untargetedCriteriaForProject: number;
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
  // Sum the per-scan-kind `actionableManualItemsBySource` lanes to
  // recover the flat actionable total this cross-surface invariant
  // budgets against. The bare `plan.actionableManualItems` scalar was
  // dropped per the same "Composite headline counts are dishonest"
  // precedent that closed Q15-UNTARGETED — on a `scan_file` of
  // `dist/*.min.css` it read 1 while every contributing candidate sat
  // on the `buildArtifact` lane (Q15-MIN-CSS-ACTIONABLE-MANUAL-ITEMS-
  // INCLUDES-VENDOR-LANE). Consumers reading the per-lane sibling
  // continue to see the same flat-equality invariant by summing the
  // two lanes.
  const scanActionableFlat =
    scanBody.plan.actionableManualItemsBySource.source +
    scanBody.plan.actionableManualItemsBySource.buildArtifact;
  return {
    // Re-derive the cross-tool total from the split top-level fields
    // on every surface. The composite `manualReviewRequired` was
    // dropped from scan_project's plan, checklist's summary, AND
    // coverage (Q13) — the dishonest-headline pattern is the same on
    // every surface. The invariant is still "all surfaces agree on the
    // total", just computed from the honest parts everywhere.
    scan: scanActionableFlat + scanBody.plan.untargetedCriteriaForProject,
    coverage:
      coverageBody.summary.actionable.criteria + coverageBody.summary.untargetedCriteriaForProject,
    checklist:
      checklistBody.summary.actionable.criteria +
      checklistBody.summary.untargetedCriteriaForProject,
    scanActionable: scanActionableFlat,
    // Coverage exposes the criteria-axis manual-review count through
    // the structured `summary.actionable.criteria` path now (the
    // top-level `actionableManualItems` scalar twin was deleted —
    // it duplicated `manualWithCandidates.length`, the canonical
    // "Sibling fields naming the same concept must use one shape"
    // failure mode). The `manualWithCandidates.length` array form
    // would also work — both equal the same count on identical input.
    // The untargeted scalar likewise reads only through
    // `summary.untargetedCriteriaForProject` after the same closure
    // dropped the top-level twin.
    coverageActionable: coverageBody.summary.actionable.criteria,
    checklistActionable: checklistBody.summary.actionable.criteria,
    scanUntargeted: scanBody.plan.untargetedCriteriaForProject,
    coverageUntargeted: coverageBody.summary.untargetedCriteriaForProject,
    checklistUntargeted: checklistBody.summary.untargetedCriteriaForProject,
  };
}

/**
 * Builds a fixture that fires a rule (`color/meaning-by-color-only`)
 * which satisfies a metadata-manual criterion (`wcag22:1.4.1`,
 * `automatable: "manual"`). This is the canonical shape the
 * `untargetedCriteriaForProject` cross-surface invariant exists to guard:
 * pre-helper, `scan_project` counted such criteria as still-needing-
 * manual-review (because `collectManualCriteria` filtered only on
 * metadata, not on whether a rule had fired) while `coverage` and
 * `checklist` correctly routed them into the failing-automated lane.
 * The integration test below asserts all three surfaces report the
 * same `untargetedCriteriaForProject` count on this fixture — drift here means
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

  it("scan.plan.actionableManualItemsBySource (source+buildArtifact) agrees with checklist.summary.actionable.criteria and coverage.summary.actionable.criteria", async () => {
    // Without this, an agent reading a (formerly inflated) composite
    // manual-review headline (e.g., 21) would have to call checklist
    // just to learn that only a handful (e.g., 4) are grounded in
    // file:line candidates. Exposing the actionable count inline
    // saves the round trip.
    //
    // The same counter rides on `coverage` through the structured
    // `summary.actionable.criteria` path (mirrors checklist's path),
    // so an agent can compare without a translation table. The legacy
    // composite `criteriaManualReviewRequired` was deleted, and the
    // top-level `actionableManualItems` scalar twin on coverage was
    // dropped because it duplicated `manualWithCandidates.length`
    // ("Sibling fields naming the same concept must use one shape");
    // only the structured per-lane siblings and the
    // `manualWithCandidates` array carry the count now.
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

// The untargeted-criteria sub-counter must agree across project-rooted
// surfaces too, not just the totals. The pre-helper drift between
// `scan_project.plan.untargetedCriteriaForProject`,
// `coverage[].untargetedCriteriaForProject`, and
// `checklist.summary.untargetedCriteriaForProject` was off-by-N on
// every cwd that fired any metadata-manual criterion (e.g.
// `wcag22:1.4.1` via `color/meaning-by-color-only`) — `scan_project`
// kept the fired criterion in the manual queue because
// `collectManualCriteria` only filtered on metadata; `coverage` and
// `checklist` routed it into the failing lane via
// `buildCoverageReport`. Now all three surfaces share
// `tallyManualCriteria` / `tallyManualCriteriaFromCoverage` so the
// counts are derived once and the cross-surface agreement is mechanical.
describe("MCP invariant: untargetedCriteriaForProject agrees across surfaces", () => {
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
    // scan_project.plan.untargetedCriteriaForProject over-counted by 1
    // vs coverage/checklist on this shape because the manual-set
    // filter on scan_project's side didn't subtract fired criteria.
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
// untargetedCriteriaForProject sub-counter. The blocks below extend the invariant
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
  readonly summary: {
    readonly actionable: { readonly criteria: number; readonly emissionsTotal?: number };
    readonly untargetedCriteriaForProject: number;
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
  it("scan.plan.actionableManualItemsBySource (source+buildArtifact) === coverage.entries[0].manualWithCandidates.length", async () => {
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
    const scanActionable =
      scanBody.plan.actionableManualItemsBySource.source +
      scanBody.plan.actionableManualItemsBySource.buildArtifact;
    expect(scanActionable).toBe(manualWithCandidatesLen);
    expect(checklistBody.summary.actionable.criteria).toBe(manualWithCandidatesLen);
  });
});

// Cross-surface count invariant — candidate-axis sibling to the
// criteria-axis `manualWithCandidates.length` invariant above. The
// canonical drift shape: pre-rename, `coverage.summary.actionable
// .candidates` (raw per-emission count) and
// `checklist.summary.actionable.candidatesUncapped` (post-collapse
// inventory) shipped under sibling field names that read as the same
// concept ("uncapped pre-clip candidate count"), but disagreed by up
// to 187× on bulk corpora when checklist's cross-file collapse passes
// fired (canonical fancybox.pack.js cohort case). Closure: rename the
// raw count to `emissionsTotal` on both surfaces — computed via the
// shared `tallyManualCandidateEmissions` helper — so the cross-surface
// invariant pins ONE slice both surfaces compute identically. Checklist
// also surfaces `emissionsAfterCollapse` (post-fold) and
// `emissionsReturnedAfterClip` (post-pagination) under names that
// admit the asymmetry. Doctrine:
// `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
// invariant" + "Sibling fields naming the same concept must use one
// shape" — the candidate-vs-criteria split is named, not implied,
// AND each post-transform slice carries the transform stage in its
// name.
describe("MCP invariant: emissionsTotal agrees across coverage and checklist (raw pre-collapse count)", () => {
  it("coverage.summary.actionable.emissionsTotal === checklist.summary.actionable.emissionsTotal", async () => {
    // Media-present fixture seeds grounded candidates via the
    // `review/media-variants` finder fanning out wcag22:1.2.* criteria
    // — the fired-manual fixture used by the criteria-axis invariants
    // above only emits a violation, so its candidate-axis count is 0
    // and an equality assertion on the candidate-axis would pass
    // vacuously without exercising the new field.
    //
    // The previous top-level twin `coverage.manualCandidateEmissionsTotal`
    // was deleted per `docs/kb/architecture/ai-first-consumer.md`
    // "Sibling fields naming the same concept must use one shape" —
    // the canonical location is the nested `summary.actionable.emissionsTotal`,
    // which is the slot the cross-surface invariant pins.
    const dir = await makeMediaPresentFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const coverageEnvelope = body<FullCoverageEnvelope>(responses[1]);
    const checklistBody = body<ChecklistBody>(responses[2]);
    const coverageEmissionsSummary = coverageEnvelope.summary?.actionable?.emissionsTotal ?? 0;
    const checklistEmissionsTotal = checklistBody.summary.actionable.emissionsTotal;
    // Sanity floor — the media-present fixture must emit at least one
    // grounded candidate; a 0/0/0 result here would mean the finders
    // stopped firing and the assertion would pass vacuously.
    expect(coverageEmissionsSummary).toBeGreaterThan(0);
    expect(coverageEmissionsSummary).toBe(checklistEmissionsTotal);
    // Top-level twin must NOT appear — the cross-field-redundancy axis
    // closure landed.
    expect(coverageEnvelope as unknown as Record<string, unknown>).not.toHaveProperty(
      "manualCandidateEmissionsTotal",
    );
  });

  it("coverage.summary.actionable mirrors `manualWithCandidates.length` on the criteria axis", async () => {
    // The criteria-axis count rides through `summary.actionable.criteria`
    // and the `manualWithCandidates` array's length — both must agree.
    // The previous top-level twin `manualCandidateEmissionsTotal` was
    // deleted; the candidate-axis count rides only through
    // `summary.actionable.emissionsTotal`.
    const dir = await makeMediaPresentFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverageEnvelope = body<FullCoverageEnvelope>(responses[1]);
    expect(coverageEnvelope.summary?.actionable?.criteria).toBe(
      coverageEnvelope.manualWithCandidates?.length ?? 0,
    );
  });
});

// Sibling fields naming the same concept must use one shape:
// the coverage response must name each of the two manual-review-and-
// untestable concepts exactly once. Earlier the entry shipped the
// same concept four ways:
//
//   - `criteriaUntestable: 0` (scalar) alongside `untestableCriteria: []`
//     (array of same count)
//   - `actionableManualItems: N` (parallel scalar twin) alongside
//     `manualWithCandidates: [...N items]` (parallel array form)
//
// Per AI-first doctrine "Sibling fields naming the same concept must
// use one shape," the closure picks the array shape per concept and
// derives scalars from `array.length` at read time. Empty arrays
// drop entirely (present-when-meaningful — "absent on this corpus"
// is signaled by absence, not by an empty-array sentinel).
//
// This block pins:
//   1. Neither dropped scalar (`actionableManualItems`,
//      `criteriaUntestable`) appears on the coverage entry under any
//      input shape.
//   2. The array forms (`manualWithCandidates`, `untestableCriteria`)
//      are absent when the corpus has nothing to populate them with
//      (omit-empty conditional spread).
//   3. Future refactors that re-introduce a scalar twin lights up
//      here, not in the next field-test sweep.
describe("MCP invariant: coverage entry names each concept once", () => {
  it("never ships the dropped scalar twins (actionableManualItems, criteriaUntestable)", async () => {
    // Three distinct corpus shapes — empty (zero-file), media-free
    // (manual queue populated), and media-present (manual queue
    // populated AND grounded candidates) — exercise the full state
    // matrix the coverage response can land in. Pre-fix every shape
    // shipped both scalars; post-fix every shape ships neither.
    const fixtures = [
      { name: "empty", make: async () => mkdtemp(join(tmpdir(), "ra11y-cov-empty-")) },
      { name: "media-free", make: makeMediaFreeFixture },
      { name: "media-present", make: makeMediaPresentFixture },
      { name: "fired-manual", make: makeFiredManualCriterionFixture },
    ];
    for (const fixture of fixtures) {
      const dir = await fixture.make();
      const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
      const coverage = body<Record<string, unknown>>(responses[1]);
      // Both dropped scalars must be entirely absent — not 0, not
      // null, not undefined-via-presence; the field name itself must
      // not be in the response.
      expect(coverage).not.toHaveProperty("actionableManualItems");
      expect(coverage).not.toHaveProperty("criteriaUntestable");
    }
  });

  it("omits manualWithCandidates and untestableCriteria when empty (present-when-meaningful)", async () => {
    // The media-free fixture emits no grounded manual candidates and
    // no untestable criteria on this rule library, so both arrays
    // are "absent on this corpus." Omit-empty via conditional spread
    // — the field name is gone entirely, not shipped as `[]`. An
    // empty-array sentinel would be the dishonest shape the AI-first
    // doctrine warns against.
    const dir = await makeMediaFreeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body<Record<string, unknown>>(responses[1]);
    // When the corpus has nothing to populate either array, the
    // whole field must not ship.
    if (coverage["manualWithCandidates"] === undefined) {
      expect(coverage).not.toHaveProperty("manualWithCandidates");
    }
    if (coverage["untestableCriteria"] === undefined) {
      expect(coverage).not.toHaveProperty("untestableCriteria");
    }
    // Sanity floor — at least one of the two omit-empty paths
    // exercised. If a future rule library makes both arrays
    // routinely populated, this test relaxes; for now the
    // media-free fixture exercises the omit branch on at least one.
    const omittedAtLeastOne = !(
      "manualWithCandidates" in coverage && "untestableCriteria" in coverage
    );
    expect(omittedAtLeastOne).toBe(true);
  });

  it("ships manualWithCandidates as a populated array when grounded candidates exist", async () => {
    // The media-present fixture seeds grounded candidates via the
    // `review/media-variants` finder. With at least one candidate,
    // `manualWithCandidates` must ship populated — the omit-empty
    // rule applies only when the array would be empty.
    const dir = await makeMediaPresentFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body<{
      readonly manualWithCandidates?: ReadonlyArray<unknown>;
      readonly summary: { readonly actionable: { readonly criteria: number } };
    }>(responses[1]);
    expect(coverage.manualWithCandidates).toBeDefined();
    expect(Array.isArray(coverage.manualWithCandidates)).toBe(true);
    expect((coverage.manualWithCandidates ?? []).length).toBeGreaterThan(0);
    // The array length must equal the structured criteria-axis
    // count — the canonical access path for the scalar value.
    expect(coverage.summary.actionable.criteria).toBe((coverage.manualWithCandidates ?? []).length);
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
 * `checklist.summary` previously reported `actionable.criteria`,
 * `emissionsAfterCollapse`, and `untargetedCriteriaForProject` but not the parse-
 * error scalars `coverage` and `scan_project` lift onto their own
 * `analysisCoverage` blocks. An agent reading the checklist summary as
 * the headline (the surface read-order goes summary → items, per the
 * tool docstring) saw `partial_parse_files_present` /
 * `parse_errors_present` warnings firing without a parity counter on
 * the same surface — the cross-surface count invariant violation the
 * AI-first doctrine warns against. Closure: surface
 * `summary.parseErrorFileCount` / `summary.partialParseFileCount` on
 * `checklist`, present-when-meaningful, equal across all three tools
 * on identical cwd.
 */
interface ChecklistSummaryParseScalars {
  readonly summary: {
    readonly parseErrorFileCount?: number;
    readonly partialParseFileCount?: number;
  };
  readonly analysisCoverage?: {
    readonly parseErrorFileCount?: number;
    readonly partialParseFileCount?: number;
  };
}
interface ScanBodyParseScalars {
  readonly meta?: {
    readonly analysisCoverage?: {
      readonly parseErrorFileCount?: number;
      readonly partialParseFileCount?: number;
    };
  };
}
interface CoverageEnvelopeParseScalars {
  readonly analysisCoverage?: {
    readonly parseErrorFileCount?: number;
    readonly partialParseFileCount?: number;
  };
}

describe("MCP invariant: checklist.summary parse-error scalars agree across surfaces", () => {
  it("checklist.summary.parseErrorFileCount === coverage.analysisCoverage.parseErrorFileCount === scan_project.analysisCoverage.parseErrorFileCount", async () => {
    const dir = await makeParseErrorFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
      toolCall(3, "coverage", { cwd: dir, verboseMeta: true }),
      toolCall(4, "checklist", { cwd: dir, verboseMeta: true }),
    ]);
    const scanBody = body<ScanBodyParseScalars>(responses[1]);
    const coverageEnvelope = body<CoverageEnvelopeParseScalars>(responses[2]);
    const checklistEnvelope = body<ChecklistSummaryParseScalars>(responses[3]);

    const scanParse = scanBody.meta?.analysisCoverage?.parseErrorFileCount ?? 0;
    const coverageParse = coverageEnvelope.analysisCoverage?.parseErrorFileCount ?? 0;
    // Cross-surface count invariant: `summary.parseErrorFileCount`
    // is present-when-meaningful (omitted on a zero-error scan), so
    // the read defaults to 0 to keep the parity assertion symmetric
    // with the analysisCoverage block (which ships `0` when the scan
    // ran clean and the field altogether when entries exist).
    const checklistParse = checklistEnvelope.summary.parseErrorFileCount ?? 0;

    // Sanity floor — the fixture seeds a parse-error file so all three
    // surfaces must observe at least one. A 0/0/0 result would mean
    // the fixture stopped tripping the parser and the equality check
    // passes trivially without exercising the invariant.
    expect(scanParse).toBeGreaterThan(0);
    expect(scanParse).toBe(coverageParse);
    expect(scanParse).toBe(checklistParse);

    // Per-bucket parity also extends to the partial-parse axis. The
    // canonical fixture seeds a fully-failed parse (broken.tsx lands
    // in `parseErrorFiles`, count > 0), and the partial bucket may
    // legitimately be zero on this corpus. Either way, the three
    // surfaces must agree on whichever value applies.
    const scanPartial = scanBody.meta?.analysisCoverage?.partialParseFileCount ?? 0;
    const coveragePartial = coverageEnvelope.analysisCoverage?.partialParseFileCount ?? 0;
    const checklistPartial = checklistEnvelope.summary.partialParseFileCount ?? 0;
    expect(scanPartial).toBe(coveragePartial);
    expect(scanPartial).toBe(checklistPartial);

    // Sibling-shape parity: `checklist.summary` and the top-level
    // `analysisCoverage` block on the same response must agree on the
    // counts; the summary scalar reads as a headline, the
    // analysisCoverage scalar as the per-block detail, and any drift
    // between them within one response is itself a cross-surface
    // count failure.
    const checklistAcParse = checklistEnvelope.analysisCoverage?.parseErrorFileCount ?? 0;
    const checklistAcPartial = checklistEnvelope.analysisCoverage?.partialParseFileCount ?? 0;
    expect(checklistAcParse).toBe(checklistParse);
    expect(checklistAcPartial).toBe(checklistPartial);
  });

  it("omits summary.parseErrorFileCount on a clean fixture (present-when-meaningful)", async () => {
    const dir = await makeMediaFreeFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklistEnvelope = body<ChecklistSummaryParseScalars>(responses[1]);
    // A clean scan never failed any parse — the analysisCoverage block
    // ships `0` (always-populated when the scan ran), but the summary
    // scalars are omitted entirely so the headline doesn't carry the
    // noise of a zero counter that no warning fired against. This is
    // the present-when-meaningful contract per AI-first doctrine
    // "Ambiguous field shapes are dishonest."
    expect(checklistEnvelope.summary.parseErrorFileCount).toBeUndefined();
    expect(checklistEnvelope.summary.partialParseFileCount).toBeUndefined();
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

// Cross-surface count invariant — verify-token-with-warning-severity
// extension. The first describe blocks pin equality on grounded
// candidates and untargeted criteria; the existing
// `landmark-main-low-conf-actionable.test.ts` exercises an emit that
// already arrives at severity `info` (matches the verify-token gate
// directly). This block extends the invariant to verify-token emits
// that arrive at severity `warning` — `coupleSeverityToVerifyTokens`
// must run consistently across project-rooted surfaces so the count
// agrees. Pre-fix, `scan_project` / `bootstrap` ran the coupling in
// `scan-collect.ts` / `tools-helpers.ts`, but `coverage` / `checklist`
// consumed the raw `runScan` output through
// `runScanForCrossSurfaceParity` without the coupling — the
// warning-severity verify-token violation then (a) entered
// `failingCriteria` in `buildCoverageReport` (which only excludes
// `info`-severity findings) and (b) failed
// `collectVerifyTokenViolationCriteria`'s `info` severity gate,
// dropping the criterion from the actionable union on those two
// surfaces. Drift was 1 on a layout-partial fixture
// (scan_project: 23, bootstrap: 23, checklist: 22, coverage: 22 on
// the field-test corpus).
/**
 * Builds a fixture whose `<body>` clears `looksLikeFullPage` (branch B —
 * `<h1>` plus ≥5 element descendants) AND clears
 * `isHtmlLayoutOrPartial` via a `{{ content }}` composition directive,
 * with NO `<main>`. The `semantics/landmark-main` rule fires at
 * `severity: "warning"` with
 * `couldBeWrongBecause: ["partial_or_layout_file_requires_composed_check"]`.
 * `coupleSeverityToVerifyTokens` downgrades it to `info` once it reaches
 * the project-rooted assemblers — the cross-surface invariant requires
 * every project-rooted surface to see the post-coupling stream.
 */
async function makeLayoutPartialVerifyTokenFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-counts-layout-partial-"));
  await writeFile(
    join(dir, "page.html"),
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Layout</title></head>
<body>
<h1>Welcome</h1>
<p>Intro</p>
<p>Body text</p>
<p>More body text</p>
<p>Trailing content</p>
<div>{{ content }}</div>
</body>
</html>
`,
  );
  return dir;
}

describe("MCP invariant: warning-severity verify-token criterion contributes to actionable on every project-rooted surface", () => {
  it("scan_project / bootstrap / checklist / coverage all count the partial-or-layout verify-token criterion in actionable", async () => {
    const dir = await makeLayoutPartialVerifyTokenFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
      toolCall(5, "bootstrap", { cwd: dir }),
    ]);
    const scanBody = body<ScanBody>(responses[1]);
    const coverageEnvelope = body<FullCoverageEnvelope>(responses[2]);
    const checklistBody = body<ChecklistBody>(responses[3]);
    interface BootstrapBody {
      readonly scan?: {
        readonly actionableManualItemsBySource?: {
          readonly source: number;
          readonly buildArtifact: number;
        };
      };
    }
    const bootstrapBody = body<BootstrapBody>(responses[4]);
    const scanActionable =
      scanBody.plan.actionableManualItemsBySource.source +
      scanBody.plan.actionableManualItemsBySource.buildArtifact;
    const bootstrapActionable =
      (bootstrapBody.scan?.actionableManualItemsBySource?.source ?? 0) +
      (bootstrapBody.scan?.actionableManualItemsBySource?.buildArtifact ?? 0);
    // Sanity floor — the fixture must trip the layout-partial branch
    // and produce a verify-token finding that contributes to the
    // actionable count somewhere. A 0/0/0/0 result would mean the
    // rule's predicate stopped firing on this fixture shape and the
    // equality check below would pass vacuously.
    expect(scanActionable).toBeGreaterThan(0);
    // All four surfaces must agree on the same count. Pre-fix,
    // scan_project/bootstrap counted the verify-token criterion while
    // coverage/checklist missed it — the canonical
    // Cross-surface-count-invariant violation the helper closure was
    // written to prevent.
    expect(scanActionable).toBe(coverageEnvelope.summary.actionable.criteria);
    expect(scanActionable).toBe(checklistBody.summary.actionable.criteria);
    expect(scanActionable).toBe(bootstrapActionable);
  });
});

// Silence the unused warning on the helper used implicitly above.
void mkdir;
