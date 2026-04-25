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

interface StructuredErrorPayload {
  readonly code?: string;
  readonly message?: string;
  readonly details?: { readonly field?: string; readonly value?: number };
  readonly remediation?: string;
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

describe("checklist tool: input bound validation (V1-CHECKLIST-LIMIT-NEGATIVE-VALIDATION)", () => {
  // Doctrine (ai-first-consumer.md §"Ambiguous field shapes are
  // dishonest"): `limit: -1` was previously coerced to 1 by the silent
  // pagination clamp and returned a paginated-to-one-entry response.
  // The caller passed a clearly-invalid value and got success-shaped
  // output that masked the input bug. The fix rejects any value below
  // the documented floor of [1, 2000] (limit) / [1, 100]
  // (maxCandidatesPerCriterion) with the structured `invalid-param`
  // envelope so an agent can branch on `code` + `details.field` and
  // re-issue with a sane bound.
  let dir: string;

  beforeEach(() => {
    dir = mkTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects `limit: -1` with the structured invalid-param envelope", async () => {
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir, limit: -1 }, session);

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as StructuredErrorPayload | undefined;
    expect(structured?.code).toBe("invalid-param");
    expect(structured?.details?.field).toBe("limit");
    expect(structured?.details?.value).toBe(-1);
    expect(structured?.remediation).toContain("[1, 2000]");
  });

  it("rejects `limit: 0` (the boundary value, also below the documented floor)", async () => {
    // Zero is the sneakier failure: it reads as "no work" but the
    // pre-existing clamp coerced it to 1, so callers asking for an
    // empty page were getting one anyway. Same hard reject as -1.
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir, limit: 0 }, session);

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as StructuredErrorPayload | undefined;
    expect(structured?.code).toBe("invalid-param");
    expect(structured?.details?.field).toBe("limit");
  });

  it("rejects `maxCandidatesPerCriterion: -5` with the structured invalid-param envelope", async () => {
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir, maxCandidatesPerCriterion: -5 }, session);

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as StructuredErrorPayload | undefined;
    expect(structured?.code).toBe("invalid-param");
    expect(structured?.details?.field).toBe("maxCandidatesPerCriterion");
    expect(structured?.details?.value).toBe(-5);
    expect(structured?.remediation).toContain("[1, 100]");
  });

  it("accepts in-range values without erroring (limit=1, maxCandidatesPerCriterion=1 — the valid floor)", async () => {
    // Boundary inputs at the documented floor must still succeed —
    // the validator rejects strictly below the floor, not at it.
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler(
      { cwd: dir, limit: 1, maxCandidatesPerCriterion: 1 },
      session,
    );

    expect(result.isError).toBeUndefined();
  });

  it("preserves the silent upper-bound clamp on `limit` (over-2000 is not a hard reject)", async () => {
    // Per backlog scope: only the `< 1` rail flips from silent clamp to
    // hard reject. The over-2000 rail keeps the existing clamp
    // behavior; callers paginate via `nextOffset` instead. This guards
    // against the validator over-reaching into the upper bound.
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir, limit: 50000 }, session);

    expect(result.isError).toBeUndefined();
  });
});
