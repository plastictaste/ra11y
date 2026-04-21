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
  readonly analysisCoverage?: Record<string, unknown>;
  readonly warnings?: readonly string[];
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
  });

  it("omits `warnings` on a clean all-parseable scan (never `warnings: []`)", async () => {
    // Every file clears the parseable-extension check; none of the
    // other warning conditions fire either (non-zero filesScanned,
    // no template directives in a TSX-only tree, no Tailwind utility
    // pattern). The response must carry no `warnings` field at all —
    // per CLAUDE.md §1 "Ambiguous field shapes are dishonest," an
    // empty array would force the agent to disambiguate "clean scan"
    // from "warnings machinery disabled."
    write(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    write(join(dir, "styles.css"), "main { color: black; }\n");

    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0].text);
    expect(data.warnings).toBeUndefined();
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
