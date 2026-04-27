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
    readonly extensions_skipped_no_parser?: {
      readonly extensions: readonly string[];
      readonly topExtension: string;
      readonly topCount: number;
      readonly totalSkipped: number;
    };
    // warnings-details schema discipline: presence-only codes ship
    // the empty-object marker so every fired code has a key.
    readonly deprecated_field_id_renamed_criterionId?: Record<string, never>;
    readonly scanned_zero_files?: Record<string, never>;
  };
  readonly automatedCriteriaPassRate?: number;
  readonly criteriaTotal?: number;
  readonly summary?: string;
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

  it("surfaces `extensions_skipped_no_parser` when discovery rejects files on the parseable-extension check", async () => {
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
    expect(data.warnings).toContain("extensions_skipped_no_parser");
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
    expect(data.warningsDetails?.extensions_skipped_no_parser).toBeDefined();
    const summary = data.warningsDetails?.extensions_skipped_no_parser;
    expect(summary?.totalSkipped).toBe(3);
    // Three-way count tie breaks alphabetically — .py then .svelte then .vue.
    expect(summary?.extensions).toEqual([".py", ".svelte", ".vue"]);
  });

  it("ships the empty-object marker for the criterionId-deprecation code on `warningsDetails` (warnings-details schema discipline)", async () => {
    // Scan-side scenario: every file parseable, no template directives,
    // no Tailwind / storybook / build-artifact signal. None of the
    // scan-confidence warning codes fire — but
    // `deprecated_field_id_renamed_criterionId` always rides on
    // `coverage` while the legacy `id` alias on entry arrays still
    // ships (criterion-id field-name drift compatibility shim). Per
    // the warnings-details schema-discipline contract every fired
    // code MUST have a corresponding key in `warningsDetails` — for
    // this presence-only deprecation code, the empty-object marker
    // is the deterministic "no further detail by design" signal that
    // lets an agent reading the response distinguish "no payload
    // defined" from "this surface didn't compute it."
    write(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    write(join(dir, "styles.css"), "main { color: black; }\n");

    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0].text);
    expect(data.warnings).toEqual(["deprecated_field_id_renamed_criterionId"]);
    expect(data.warningsDetails).toBeDefined();
    expect(data.warningsDetails?.deprecated_field_id_renamed_criterionId).toEqual({});
    expect(Object.keys(data.warningsDetails ?? {}).sort()).toEqual([
      "deprecated_field_id_renamed_criterionId",
    ]);
  });

  it("emits the criterionId-deprecation code on a clean all-parseable scan (warnings carries only the deprecation code, never `[]`)", async () => {
    // Every file clears the parseable-extension check; none of the
    // scan-confidence warning conditions fire either (non-zero
    // filesScanned, no template directives in a TSX-only tree, no
    // Tailwind utility pattern). The deprecation code
    // `deprecated_field_id_renamed_criterionId` always rides on
    // `coverage` while the legacy `id` alias on the entry arrays still
    // ships. Per CLAUDE.md §1
    // "Ambiguous field shapes are dishonest," `warnings: []` is still
    // forbidden — the field must either be absent or non-empty.
    write(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    write(join(dir, "styles.css"), "main { color: black; }\n");

    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0].text);
    expect(data.warnings).toEqual(["deprecated_field_id_renamed_criterionId"]);
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
    expect(typeof data.summary).toBe("string");
    expect(data.summary).not.toMatch(/\(\d+%\)/);
    // Structural signal the agent can still read — criteriaTotal
    // stays populated so the shape of what *would* have been evaluated
    // is visible (clamps only the
    // dishonest scalar, not the per-criterion split).
    expect(typeof data.criteriaTotal).toBe("number");
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

    // Both surfaces must agree on the `extensions_skipped_no_parser`
    // label — an agent branching on the warning gets the same answer
    // regardless of which tool it called.
    const coverageFires = (coverage.warnings ?? []).includes("extensions_skipped_no_parser");
    const scanFires = (scan.warnings ?? []).includes("extensions_skipped_no_parser");
    expect(coverageFires).toBe(scanFires);
    expect(coverageFires).toBe(true);
  });
});
