/**
 * Unit tests for the `coverage` MCP tool's response envelope.
 *
 * Guards the scan-confidence telemetry that `scan_project` already
 * emits: the canonical silent-miss case for `coverage` is reporting
 * "N/M automatable passing" while discovery silently rejected hundreds
 * of source files at the parseable-extension check. An agent gating
 * "are we done?" on coverage alone without the `analysisCoverage` +
 * `warnings` block would read a green pass rate on a scan that never
 * looked at the majority of the repo (CLAUDE.md §1 "Zero-output
 * success is ambiguous failure," "Verbose meta is signal not clutter").
 *
 * The tests exercise the tool handler end-to-end against temp
 * directories so the walker actually runs and the scan_project parity
 * assertion compares the real composed envelopes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ScanProjectReviewCandidate } from "../../../src/mcp/scan-project-review-candidates.ts";
import { McpSession } from "../../../src/mcp/session.ts";
import { withTitles, withTitlesAndCandidates } from "../../../src/mcp/tool-coverage.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";
import { posixJoin } from "../../helpers/path.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function mkTmp(): string {
  return mkdtempSync(posixJoin(tmpdir(), "ra11y-coverage-"));
}

function write(path: string, content: string): void {
  mkdirSync(posixJoin(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

interface CoverageEnvelope {
  readonly standardId: string;
  readonly scanned?: {
    readonly mode: string;
    readonly root?: string;
    readonly paths?: readonly string[];
    readonly file?: string;
  };
  readonly analysisCoverage?: Record<string, unknown>;
  readonly warnings?: readonly string[];
  readonly warningsDetails?: {
    readonly text_source_skipped?: {
      readonly extensions: readonly string[];
      readonly perExtensionCounts?: Readonly<Record<string, number>>;
      readonly parserRoutableExtensions?: readonly string[];
      // Present-when-meaningful: omitted when `extensions: []`.
      readonly topExtension?: string;
      readonly topCount?: number;
      readonly totalSkipped: number;
    };
    readonly binary_assets_skipped?: {
      readonly extensions: readonly string[];
      readonly perExtensionCounts?: Readonly<Record<string, number>>;
      readonly topExtension?: string;
      readonly topCount?: number;
      readonly totalSkipped: number;
    };
    readonly scanned_zero_files?: Record<string, never>;
  };
  readonly automatedCriteriaPassRate?: number;
  readonly criteriaTotalForProfile?: number;
  readonly criteriaByLevel?: Record<string, number>;
  // Structured `summary` dict — mirrors `checklist.summary`'s shape
  // so `summary.actionable.criteria` resolves identically across both
  // tools. Pre-fix shipped as a prose string (the old shape forced an
  // agent reading `summary.actionableManualItems` on coverage to get
  // `undefined` while the same path on checklist returned the
  // populated count). The prose now rides as `summary.headline`.
  readonly summary?: {
    readonly actionable: { readonly criteria: number };
    readonly untargetedCriteriaForProject: number;
    readonly likelyIrrelevant: number;
    readonly automatedCoverage: {
      readonly standardId: string;
      readonly criteriaWithRulesAllClean: number;
      readonly criteriaWithoutEligibleInputs: number;
      readonly automatedCriteriaPassRate?: number;
    };
    readonly headline: string;
  };
}

function parseEnvelope(text: string): CoverageEnvelope {
  return JSON.parse(text) as CoverageEnvelope;
}

describe("coverage tool: analysisCoverage + warnings envelope", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces `text_source_skipped` when discovery rejects files on the parseable-extension check", async () => {
    // Mixed-language repo — one parseable TSX plus three extensions
    // the walker clears past dir-ignore + user-excludes and then drops
    // purely because PARSEABLE_EXTENSIONS doesn't cover them (`.svelte`,
    // `.vue`, `.py` are not in the parser set). Without the forwarding
    // pattern this fix lands, the coverage response reads as a clean
    // pass rate while the scanner never looked at the source files.
    write(posixJoin(dir, "page.tsx"), "export default function Page() { return <div />; }\n");
    write(posixJoin(dir, "Button.svelte"), "<button>Go</button>\n");
    write(posixJoin(dir, "app.vue"), "<template><div /></template>\n");
    write(posixJoin(dir, "manage.py"), "# noop\n");

    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0].text);
    expect(data.warnings).toContain("text_source_skipped");
    // Paired meta — the warning is a label pointing at this map, so
    // the count-per-extension must be readable in the same response.
    expect(data.analysisCoverage).toBeDefined();
    const skipped = data.analysisCoverage?.["skippedByExtension"] as
      | Record<string, number>
      | undefined;
    expect(skipped).toBeDefined();
    expect(skipped?.[".svelte"]).toBe(1);
    expect(skipped?.[".vue"]).toBe(1);
    expect(skipped?.[".py"]).toBe(1);

    // ADR 0023: the structured `warningsDetails` sibling carries the
    // dense summary so an agent branching on the bare-string warning
    // channel can answer "how bad" without descending into `meta`.
    // Set-membership invariant: the code appears in both surfaces.
    expect(data.warningsDetails?.text_source_skipped).toBeDefined();
    const summary = data.warningsDetails?.text_source_skipped;
    expect(summary?.totalSkipped).toBe(3);
    // Three-way count tie breaks alphabetically — .py then .svelte then .vue.
    expect(summary?.extensions).toEqual([".py", ".svelte", ".vue"]);
  });

  it("routes `.db` to `binary_assets_skipped` and surfaces the parser-routable substrate subset on `text_source_skipped`", async () => {
    // End-to-end pin for the discovery → warnings split: a corpus
    // mixing a SQLite database file (`.db` — binary by spec), a data
    // format the scanner never extracts HTML from (`.json`), and a
    // text-island substrate ra11y could route (`.vue`) must surface
    // each in its honest channel:
    //   - `.db` lands under `binary_assets_skipped` (per AI-first
    //     "Heuristic-mislabeled meta sub-fields are dishonest" — the
    //     binary classification is provable from the format spec).
    //   - `.vue` AND `.json` both surface under `text_source_skipped`
    //     (both are text), but only `.vue` lands in
    //     `parserRoutableExtensions` (its format spec defines an HTML
    //     surface; `.json` is data-only).
    write(posixJoin(dir, "page.tsx"), "export default function Page() { return <div />; }\n");
    write(posixJoin(dir, "Component.vue"), "<template><div /></template>\n");
    write(posixJoin(dir, "config.json"), '{"a":1}\n');
    // Any file content suffices; the discovery walker partitions
    // by extension, not by byte content.
    write(posixJoin(dir, "fixtures.db"), "binary-fixture-content");

    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0].text);

    // Both warning channels fire — text + binary partition by predicate.
    expect(data.warnings).toContain("text_source_skipped");
    expect(data.warnings).toContain("binary_assets_skipped");

    // `.db` MUST appear under binary, not text.
    const binSummary = data.warningsDetails?.binary_assets_skipped;
    expect(binSummary?.extensions).toContain(".db");
    const textSummary = data.warningsDetails?.text_source_skipped;
    expect(textSummary?.extensions).not.toContain(".db");

    // Both `.vue` and `.json` are text-source — both surface in
    // `extensions[]` so the agent reads the full skipped distribution.
    expect(textSummary?.extensions).toContain(".vue");
    expect(textSummary?.extensions).toContain(".json");

    // The actionable substrate subset names only `.vue` — `.json` has
    // no HTML / JSX surface by spec.
    expect(textSummary?.parserRoutableExtensions).toEqual([".vue"]);
  });

  it("on a clean all-parseable scan with no scan-confidence triggers, omits `warnings` entirely (no empty `[]`)", async () => {
    // Every file clears the parseable-extension check; none of the
    // scan-confidence warning conditions fire (non-zero filesScanned,
    // no template directives in a TSX-only tree, no Tailwind utility
    // pattern). Per `docs/kb/architecture/ai-first-consumer.md`
    // "Ambiguous field shapes are dishonest" the response must omit
    // `warnings` entirely on this path — `warnings: []` would force
    // the agent to disambiguate "no codes defined" from "this surface
    // didn't compute them." Pinning the absence here also guards the
    // dropped `deprecated_field_id_renamed_criterionId` code from
    // re-introduction: that code used to ride unconditionally on
    // every coverage response and forced this branch to ship a
    // single-element array.
    write(posixJoin(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    write(posixJoin(dir, "styles.css"), "main { color: black; }\n");

    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0].text);
    expect(data.warnings).toBeUndefined();
    expect(data.warningsDetails).toBeUndefined();
  });

  it("fires `scanned_zero_files` when the scan root contains no parseable files at all", async () => {
    // `coverage({ cwd: "/tmp/empty" })` must not read as a clean pass
    // rate — the honest signal is the warning, not the 0/N headline.
    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0].text);
    expect(data.warnings).toContain("scanned_zero_files");
  });

  it("omits `automatedCriteriaPassRate` on a zero-file scan", async () => {
    // Doctrine (ai-first-consumer.md §"Ambiguous field shapes are
    // dishonest"): on a zero-file scan there is no meaningful
    // denominator for an automated pass rate. The legacy formula
    // (`passing / automatable`) returns 100 and the split formula
    // returns 0 — neither is honest. Present-when-meaningful: omit
    // the field entirely and rely on `warnings: ["scanned_zero_files"]`
    // to carry the reason. Also guard the summary string so it doesn't
    // claim "(0%)" as a precise readout.
    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0].text);
    expect(data.warnings).toContain("scanned_zero_files");
    expect(data).not.toHaveProperty("automatedCriteriaPassRate");
    // structured `summary` dict — `headline` (the prose) drops the
    // `(N%)` tail on a zero-file scan since the percentage is
    // materially meaningless without a denominator. The
    // `automatedCoverage` sub-block also omits `automatedCriteriaPassRate`
    // under present-when-meaningful semantics so the two surfaces
    // agree.
    expect(typeof data.summary).toBe("object");
    expect(typeof data.summary?.headline).toBe("string");
    expect(data.summary?.headline).not.toMatch(/\(\d+%\)/);
    expect(data.summary?.automatedCoverage).not.toHaveProperty("automatedCriteriaPassRate");
    // Structural signal the agent can still read —
    // criteriaTotalForProfile stays populated so the shape of what
    // *would* have been evaluated is visible (clamps only the
    // dishonest scalar, not the per-criterion split).
    expect(typeof data.criteriaTotalForProfile).toBe("number");
  });

  it("preserves `automatedCriteriaPassRate` on a populated scan", async () => {
    // Counterpart guard: the zero-file omission must not regress the
    // normal happy path. A file-bearing scan still ships the rate so
    // an agent dashboard can trend it.
    write(posixJoin(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0].text);
    expect(typeof data.automatedCriteriaPassRate).toBe("number");
  });

  it("emits a `scanned` envelope matching scan_project's shape on the same cwd", async () => {
    // Cross-surface drift between two tools that both run a real scan
    // over the same cwd is dishonest (`ai-first-consumer.md` "One tool
    // call should answer 'what next?'"). An agent calling
    // `coverage({ cwd })` to verify "are we done?" must see the same
    // `scanned` pointer `scan_project({ cwd })` returns — otherwise
    // the agent has to fire a second `scan_project` call just to
    // confirm what `coverage` actually looked at.
    write(posixJoin(dir, "page.tsx"), "export default function Page() { return <main />; }\n");

    const session = new McpSession();
    const coverageResult = await findTool("coverage").handler({ cwd: dir }, session);
    const scanResult = await findTool("scan_project").handler({ cwd: dir }, session);

    expect(coverageResult.isError).toBeUndefined();
    expect(scanResult.isError).toBeUndefined();

    const coverage = parseEnvelope(coverageResult.content[0].text);
    const scan = JSON.parse(scanResult.content[0].text) as {
      readonly meta?: { readonly scanned?: { readonly mode: string; readonly root?: string } };
    };

    expect(coverage.scanned).toBeDefined();
    expect(coverage.scanned?.mode).toBe("project");
    // Top-level placement on `coverage` mirrors how `analysisCoverage`
    // already escapes the meta block on this tool — load-bearing
    // scan-confidence telemetry isn't gated by `metaMode`.
    expect(scan.meta?.scanned).toBeDefined();
    expect(coverage.scanned).toEqual(scan.meta?.scanned);
  });

  it("mirrors scan_project's analysisCoverage + warnings on the same cwd (cross-tool parity)", async () => {
    // Same-cwd invariant: an agent that calls scan_project, then
    // coverage to confirm "are we done?", must see consistent scan-
    // confidence telemetry on both surfaces. If coverage under-reported
    // skippedByExtension or dropped the warning, the follow-up
    // coverage call would green-light a scan scan_project had already
    // flagged as partial.
    write(posixJoin(dir, "page.tsx"), "export default function Page() { return <div />; }\n");
    write(posixJoin(dir, "Widget.svelte"), "<button>Go</button>\n");

    const session = new McpSession();
    const coverageResult = await findTool("coverage").handler({ cwd: dir }, session);
    const scanResult = await findTool("scan_project").handler({ cwd: dir }, session);

    expect(coverageResult.isError).toBeUndefined();
    expect(scanResult.isError).toBeUndefined();

    const coverage = parseEnvelope(coverageResult.content[0].text);
    const scan = JSON.parse(scanResult.content[0].text) as {
      readonly warnings?: readonly string[];
      readonly meta?: { readonly analysisCoverage?: Record<string, unknown> };
    };

    // Both surfaces must agree on the skipped-extension map.
    const coverageSkipped = coverage.analysisCoverage?.["skippedByExtension"];
    const scanSkipped = scan.meta?.analysisCoverage?.["skippedByExtension"];
    expect(coverageSkipped).toEqual(scanSkipped);

    // Both surfaces must agree on the `text_source_skipped`
    // label — an agent branching on the warning gets the same answer
    // regardless of which tool it called.
    const coverageFires = (coverage.warnings ?? []).includes("text_source_skipped");
    const scanFires = (scan.warnings ?? []).includes("text_source_skipped");
    expect(coverageFires).toBe(scanFires);
    expect(coverageFires).toBe(true);
  });

  it("Q9: scan_project surfaces parseErrorFileCount / partialParseFileCount / fragmentFileCount on a clean scan (always-populate, not ambiguous-absence)", async () => {
    // An agent reading `scan_project.meta.analysisCoverage` on a clean
    // codebase must see all three parse-coverage counters as scalar 0,
    // not absent fields. Per `docs/kb/architecture/ai-first-consumer.md`
    // "Ambiguous field shapes are dishonest": absence forces the agent
    // to disambiguate "telemetry collected, value 0" from "telemetry
    // never collected" — and the wrong guess silently propagates.
    // The same response shape ships from `coverage` so the cross-
    // surface count invariant holds (every project-rooted tool exposes
    // the counters uniformly).
    write(posixJoin(dir, "page.tsx"), "export default function Page() { return <div />; }\n");

    const session = new McpSession();
    const scanResult = await findTool("scan_project").handler({ cwd: dir }, session);
    const coverageResult = await findTool("coverage").handler({ cwd: dir }, session);

    expect(scanResult.isError).toBeUndefined();
    expect(coverageResult.isError).toBeUndefined();

    const scan = JSON.parse(scanResult.content[0].text) as {
      readonly meta?: { readonly analysisCoverage?: Record<string, unknown> };
    };
    const coverage = parseEnvelope(coverageResult.content[0].text);

    const scanCoverage = scan.meta?.analysisCoverage;
    expect(scanCoverage).toBeDefined();
    expect(scanCoverage?.["parseErrorFileCount"]).toBe(0);
    expect(scanCoverage?.["partialParseFileCount"]).toBe(0);
    expect(scanCoverage?.["fragmentFileCount"]).toBe(0);

    expect(coverage.analysisCoverage).toBeDefined();
    expect(coverage.analysisCoverage?.["parseErrorFileCount"]).toBe(0);
    expect(coverage.analysisCoverage?.["partialParseFileCount"]).toBe(0);
    expect(coverage.analysisCoverage?.["fragmentFileCount"]).toBe(0);

    // Cross-surface count invariant: identical input must produce
    // identical counters across the two project-rooted tools.
    expect(coverage.analysisCoverage?.["parseErrorFileCount"]).toBe(
      scanCoverage?.["parseErrorFileCount"] as number,
    );
    expect(coverage.analysisCoverage?.["partialParseFileCount"]).toBe(
      scanCoverage?.["partialParseFileCount"] as number,
    );
    expect(coverage.analysisCoverage?.["fragmentFileCount"]).toBe(
      scanCoverage?.["fragmentFileCount"] as number,
    );
  });

  it("does not leak internal scan-time-warning helper fields onto the coverage envelope", async () => {
    // Pre-fix, `tool-coverage.ts` spread the entire
    // `buildScanTimeWarnings` return at the top level of the response,
    // leaking three internal helper fields that NEVER belonged on the
    // wire: `buildArtifactEntries: []`, `buildArtifactsMetaField: {}`,
    // `scssUnresolvedVariableFiles: []`. On a typical scan all three
    // shipped as empty containers — three different sibling shapes
    // (array, object, array) for the same conceptual "absent on this
    // corpus" state, the canonical "Sibling fields naming the same
    // concept must use one shape" failure mode in
    // `docs/kb/architecture/ai-first-consumer.md`. The build-artifact
    // classification is now lifted onto `meta.scannedBuildArtifacts`
    // (matching `scan_project` / `scan_file`); the SCSS unresolved-
    // variables list rides on
    // `warningsDetails.scss_unresolved_variables.files[]` already; the
    // raw entries list is internal-only and never reaches the wire.
    write(posixJoin(dir, "page.tsx"), "export default function Page() { return <div />; }\n");

    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(data["buildArtifactEntries"]).toBeUndefined();
    expect(data["buildArtifactsMetaField"]).toBeUndefined();
    expect(data["scssUnresolvedVariableFiles"]).toBeUndefined();
  });
});

describe("coverage tool: criterion-title resolution", () => {
  // Per `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
  // shapes are dishonest", a criterion-ID lookup that doesn't resolve
  // must NOT ship `{ criterionId, title: "", level: "" }` (or the
  // candidates-bearing variant): the empty-string sentinel forces the
  // agent to disambiguate "criterion exists with no title" from
  // "criterion ID didn't match any loaded standard" and the silent-miss
  // failure mode is identical to the canonical empty-string sentinel
  // the doctrine names. Closure: omit the unresolved entry from the
  // returned array so the headline `length` stays honest (every entry
  // that ships is a resolved criterion); the cross-surface count
  // invariant pinning `coverage[].manualWithCandidates.length ===
  // checklist.summary.actionable.criteria` therefore can't silently
  // inflate when an unresolved ID slips through. Inputs are
  // registry-sourced under normal operation (`c.criteria`,
  // `c.untestableCriteria`, `c.failingCriteria`, etc. all walk the
  // loaded registry), so the filter is a no-op on real corpora — these
  // assertions defend the helper shape against a fabricated input.

  it("withTitles: omits unresolved IDs (no empty-string title/level placeholder)", () => {
    const session = new McpSession();
    const fabricatedUnresolved = "wcag22:99.99.99";
    const realResolved = "wcag22:1.1.1";
    const out = withTitles([fabricatedUnresolved, realResolved], session);
    // Only the resolved ID survives — the unresolved fabrication is
    // dropped, not surfaced as an empty-string placeholder.
    expect(out.length).toBe(1);
    expect(out[0]?.criterionId).toBe(realResolved);
    expect(out[0]?.title.length).toBeGreaterThan(0);
    expect(out[0]?.level.length).toBeGreaterThan(0);
    // Belt-and-braces: no entry in the returned array carries an
    // empty title or level under any circumstance.
    for (const entry of out) {
      expect(entry.title).not.toBe("");
      expect(entry.level).not.toBe("");
    }
  });

  it("withTitles: returns an empty array when every input is unresolved", () => {
    const session = new McpSession();
    const out = withTitles(["wcag22:99.99.99", "made-up:xx.yy.zz"], session);
    // Headline-honest: an array of unresolved fabrications collapses
    // to zero entries, not two empty-string rows.
    expect(out.length).toBe(0);
  });

  it("withTitlesAndCandidates: omits unresolved IDs while preserving the candidates payload for resolved entries", () => {
    const session = new McpSession();
    const realResolved = "wcag22:1.1.1";
    const fabricatedUnresolved = "wcag22:99.99.99";
    const fakeCandidate: ScanProjectReviewCandidate = {
      findingId: "test-finding",
      findingGroupId: "test-finding",
      file: "page.tsx",
      line: 1,
      column: 1,
      criteria: [realResolved],
      reason: "test",
      confidence: "medium",
    };
    const map = new Map<string, readonly ScanProjectReviewCandidate[]>([
      [realResolved, [fakeCandidate]],
      [fabricatedUnresolved, [fakeCandidate]],
    ]);
    const out = withTitlesAndCandidates([fabricatedUnresolved, realResolved], session, map);
    // Unresolved fabrication is dropped even when it has a candidates
    // payload — the candidates-axis count stays anchored to the
    // resolved-criteria axis (otherwise an unresolved-with-candidates
    // entry would inflate `manualWithCandidates.length` and break the
    // cross-surface count invariant pinning agreement with
    // `checklist.summary.actionable.criteria`).
    expect(out.length).toBe(1);
    expect(out[0]?.criterionId).toBe(realResolved);
    expect(out[0]?.title.length).toBeGreaterThan(0);
    expect(out[0]?.level.length).toBeGreaterThan(0);
    expect(out[0]?.candidates.length).toBe(1);
    for (const entry of out) {
      expect(entry.title).not.toBe("");
      expect(entry.level).not.toBe("");
    }
  });
});
