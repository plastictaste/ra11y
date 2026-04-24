/**
 * Unit tests for the `checklist` MCP tool's response-envelope shape.
 *
 * Narrowly scoped to V1-ZERO-SCAN-PASS-RATE-SENTINEL (zero-file scans
 * must omit the dishonest `automatedCriteriaPassRate` rather than emit
 * a misleading 0% or 100%). Paired with the analogous guard in
 * `tool-coverage.test.ts` — the two surfaces report the same shape and
 * must behave consistently per `ai-first-consumer.md` §"One tool call
 * should answer 'what next?'".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  return mkdtempSync(join(tmpdir(), "ra11y-checklist-"));
}

interface CoverageGloss {
  readonly standardId?: string;
  readonly automatedCriteriaPassRate?: number;
}

interface ChecklistEnvelope {
  readonly summary?: {
    readonly automatedCoverage?: CoverageGloss | ReadonlyArray<CoverageGloss>;
  };
  readonly warnings?: readonly string[];
}

function parseEnvelope(text: string): ChecklistEnvelope {
  return JSON.parse(text) as ChecklistEnvelope;
}

function asCoverageEntries(
  cov: CoverageGloss | ReadonlyArray<CoverageGloss> | undefined,
): ReadonlyArray<CoverageGloss> {
  if (cov === undefined) return [];
  if (Array.isArray(cov)) return cov as ReadonlyArray<CoverageGloss>;
  return [cov as CoverageGloss];
}

describe("checklist tool: zero-scan pass-rate sentinel", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("omits `automatedCriteriaPassRate` on a zero-file scan (V1-ZERO-SCAN-PASS-RATE-SENTINEL)", async () => {
    // Doctrine (ai-first-consumer.md §"Ambiguous field shapes are
    // dishonest"): on a zero-file scan the denominator collapses to a
    // non-meaningful population. Present-when-meaningful: omit the
    // pass rate entirely so an agent dashboard doesn't silently score
    // the call as clean conformance. The structured
    // `scanned_zero_files` warning on the envelope carries the honest
    // reason. Guards `checklist.summary.automatedCoverage` — ADR 0010's
    // one-field gloss — so it stays consistent with the `coverage`
    // tool's envelope-level guard.
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    expect(data.warnings ?? []).toContain("scanned_zero_files");
    const entries = asCoverageEntries(data.summary?.automatedCoverage);
    // Single-standard path returns an object; multi-standard returns an
    // array. Neither shape should carry a pass rate on a zero-file scan.
    // `standardId` stays populated so the shape of the attempted
    // evaluation is still visible to the agent.
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("automatedCriteriaPassRate");
      expect(typeof entry.standardId).toBe("string");
    }
  });

  it("preserves `automatedCriteriaPassRate` on a populated scan", async () => {
    // Counterpart: a scan with ≥1 parseable file still ships the rate
    // so the happy-path workflow-queue context (ADR 0010 one-field
    // gloss) keeps its headline number.
    writeFileSync(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    const entries = asCoverageEntries(data.summary?.automatedCoverage);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(typeof entry.automatedCriteriaPassRate).toBe("number");
    }
  });
});
