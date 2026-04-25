/**
 * Unit tests for the `checklist` MCP tool's response-envelope shape.
 *
 * Two invariants are guarded here:
 *
 * 1. **Q7-CHECKLIST-PASS-RATE-COMPOSITE**: the lone scalar
 *    `automatedCriteriaPassRate` is gone — the field bundled "rule fired
 *    clean" with "rule never had eligible inputs" with "rule found
 *    violations" into one composite ratio (dishonest per
 *    `ai-first-consumer.md` §"Composite headline counts are dishonest").
 *    The surface now carries two non-overlapping counters
 *    (`criteriaWithRulesAllClean` + `criteriaWithoutEligibleInputs`); the
 *    agent reads both and never sums them into a rate.
 *
 * 2. **V1-ZERO-SCAN-PASS-RATE-SENTINEL** (legacy partner): zero-file
 *    scans still must not silently surface a misleading "100% clean"
 *    signal. The split counters are honest in their own right — on a
 *    zero-file scan `criteriaWithRulesAllClean: 0` and
 *    `criteriaWithoutEligibleInputs: <N>` (every automatable criterion
 *    routes to "no eligible inputs"); paired with the response-level
 *    `scanned_zero_files` warning the agent reads "no files reached the
 *    rules" without a phantom pass-rate.
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
  readonly criteriaWithRulesAllClean?: number;
  readonly criteriaWithoutEligibleInputs?: number;
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

describe("checklist tool: automated-coverage shape (Q7-CHECKLIST-PASS-RATE-COMPOSITE)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never emits the dishonest composite `automatedCriteriaPassRate` headline", async () => {
    // Doctrine (ai-first-consumer.md §"Composite headline counts are
    // dishonest"): the lone scalar conflated "rule fired clean" with
    // "rule never had eligible inputs" with "rule found violations" —
    // three categorically different sub-buckets summed into one ratio
    // an agent budgets against. The split below replaces the composite
    // with two non-overlapping counters; the dropped headline must not
    // resurface alongside them.
    writeFileSync(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    const entries = asCoverageEntries(data.summary?.automatedCoverage);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("automatedCriteriaPassRate");
    }
  });

  it("populates the two non-overlapping counters on a populated scan", async () => {
    // `criteriaWithRulesAllClean`: rules ran on eligible input and
    // emitted zero findings (maps to coverage report's `clean`).
    // `criteriaWithoutEligibleInputs`: rules declared extension
    // eligibility but the scan saw no applicable input — the canonical
    // Tailwind-pre-build / vendor-bundle shape (maps to coverage
    // report's `untestable`). Both are non-negative integers.
    writeFileSync(join(dir, "page.tsx"), "export default function Page() { return <main />; }\n");
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    const entries = asCoverageEntries(data.summary?.automatedCoverage);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(typeof entry.standardId).toBe("string");
      expect(typeof entry.criteriaWithRulesAllClean).toBe("number");
      expect(typeof entry.criteriaWithoutEligibleInputs).toBe("number");
      expect(entry.criteriaWithRulesAllClean).toBeGreaterThanOrEqual(0);
      expect(entry.criteriaWithoutEligibleInputs).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports zero clean / non-zero no-eligible-inputs on a zero-file scan (V1-ZERO-SCAN-PASS-RATE-SENTINEL)", async () => {
    // Zero files means no rule had eligible input: every automatable
    // criterion routes to `criteriaWithoutEligibleInputs` (untestable
    // lane), and `criteriaWithRulesAllClean` reads 0. The companion
    // `scanned_zero_files` warning at the envelope level still
    // communicates the honest cause. Together the agent reads
    // "no files reached the rules" without a phantom pass rate, and the
    // dropped composite scalar can never silently score the call as
    // clean conformance.
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    expect(data.warnings ?? []).toContain("scanned_zero_files");
    const entries = asCoverageEntries(data.summary?.automatedCoverage);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("automatedCriteriaPassRate");
      expect(entry.criteriaWithRulesAllClean).toBe(0);
      expect(entry.criteriaWithoutEligibleInputs).toBeGreaterThan(0);
    }
  });
});
