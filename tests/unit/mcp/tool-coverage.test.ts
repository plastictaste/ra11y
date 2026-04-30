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
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "ra11y-coverage-"));
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
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
      readonly topExtension: string;
      readonly topCount: number;
      readonly totalSkipped: number;
    };
    readonly binary_assets_skipped?: {
      readonly extensions: readonly string[];
      readonly topExtension: string;
      readonly topCount: number;
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
    readonly untargetedCriteria: number;
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
    write(join(dir, "page.tsx"), "export default function Page() { return <div />; }\n");
    write(join(dir, "Button.svelte"), "<button>Go</button>\n");
    write(join(dir, "app.vue"), "<template><div /></template>\n");
    write(join(dir, "manage.py"), "# noop\n");

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
    write(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    write(join(dir, "styles.css"), "main { color: black; }\n");

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
    expect(data.summary?.automatedCoverage).not.toHaveProperty(
      "automatedCriteriaPassRate",
    );
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
    write(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
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
    write(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");

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
    write(join(dir, "page.tsx"), "export default function Page() { return <div />; }\n");
    write(join(dir, "Widget.svelte"), "<button>Go</button>\n");

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
    write(join(dir, "page.tsx"), "export default function Page() { return <div />; }\n");

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
});
