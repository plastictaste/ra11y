/**
 * Unit tests for the `checklist` MCP tool's response-envelope shape.
 *
 * Two invariants are guarded here:
 *
 * 1. ****: the lone scalar
 *    `automatedCriteriaPassRate` is gone — the field bundled "rule fired
 *    clean" with "rule never had eligible inputs" with "rule found
 *    violations" into one composite ratio (dishonest per
 *    `ai-first-consumer.md` §"Composite headline counts are dishonest").
 *    The surface now carries two non-overlapping counters
 *    (`criteriaWithRulesAllClean` + `criteriaWithoutEligibleInputs`); the
 *    agent reads both and never sums them into a rate.
 *
 * 2. **** (legacy partner): zero-file
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
    readonly actionable?: {
      readonly criteria?: number;
      readonly candidatesUncapped?: number;
      readonly candidatesReturned?: number;
    };
    readonly untargetedCriteria?: number;
  };
  readonly items?: ReadonlyArray<{
    readonly criterionId?: string;
    readonly candidates?: ReadonlyArray<unknown>;
  }>;
  readonly totalCandidates?: number;
  readonly perCriterionClipped?: true;
  readonly truncated?: true;
  readonly nextStep?: string;
  readonly nextStepStructured?: {
    readonly tool?: string;
    readonly args?: Record<string, unknown>;
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

describe("checklist tool: automated-coverage shape", () => {
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

  it("reports zero clean / non-zero no-eligible-inputs on a zero-file scan", async () => {
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

describe("checklist tool: input bound validation", () => {
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

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const BAD_ALT_DIR = join(PROJECT_ROOT, "tests", "fixtures", "bad", "alt-text-missing");

describe("checklist tool: summary.actionable structured headline shape", () => {
  // Doctrine reference: docs/kb/architecture/ai-first-consumer.md
  // §"Composite headline counts are dishonest". The prior
  // `summary.actionable: number` reads as "N things to verify" but
  // counts criteria with candidates — a clipped page with a single
  // criterion carrying 30 elided candidates would read "actionable: 1"
  // and silently mislead the agent's work budget. The split shape ships
  // three honest counts so the agent reads the inventory in three axes.
  it("always emits the structured `{ criteria, candidatesUncapped, candidatesReturned }` shape (not a number)", async () => {
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ paths: [BAD_ALT_DIR] }, session);

    expect(result.isError).toBeUndefined();
    const data = parseEnvelope(result.content[0]?.text ?? "{}");
    const actionable = data.summary?.actionable;
    expect(actionable).toBeDefined();
    expect(typeof actionable?.criteria).toBe("number");
    expect(typeof actionable?.candidatesUncapped).toBe("number");
    expect(typeof actionable?.candidatesReturned).toBe("number");
    expect(actionable?.criteria).toBeGreaterThanOrEqual(0);
    expect(actionable?.candidatesUncapped).toBeGreaterThanOrEqual(0);
    expect(actionable?.candidatesReturned).toBeGreaterThanOrEqual(0);
    // candidatesReturned cannot exceed the uncapped inventory — the
    // page is a slice of it, never wider.
    expect(actionable?.candidatesReturned ?? 0).toBeLessThanOrEqual(
      actionable?.candidatesUncapped ?? 0,
    );
    // Reject the legacy bare-number shape outright. A loose
    // `typeof === "object"` would let an asymmetric "sometimes a number,
    // sometimes a struct" regression through; pin the always-split
    // contract so a future drive-by collapse to the bare counter on the
    // unclipped path lights up.
    expect(typeof actionable).toBe("object");
  });

  it("emits the structured shape on a zero-actionable scan (not as a bare 0)", async () => {
    // Zero-actionable case: empty fixture directory yields zero
    // actionable criteria. The shape must stay structured (not collapse
    // to a number) so consumers always read the same three keys —
    // asymmetric shape would force callers to branch on type, which
    // the always-split discipline exists to avoid.
    const tool = findTool("checklist");
    const session = new McpSession();
    const empty = mkTmp();
    try {
      const result = await tool.handler({ cwd: empty }, session);
      expect(result.isError).toBeUndefined();
      const data = parseEnvelope(result.content[0]?.text ?? "{}");
      const actionable = data.summary?.actionable;
      expect(actionable).toBeDefined();
      expect(typeof actionable?.criteria).toBe("number");
      expect(typeof actionable?.candidatesUncapped).toBe("number");
      expect(typeof actionable?.candidatesReturned).toBe("number");
      expect(actionable?.criteria).toBe(0);
      expect(actionable?.candidatesUncapped).toBe(0);
      expect(actionable?.candidatesReturned).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("candidatesUncapped reports the pre-clip inventory when perCriterionClipped fires", async () => {
    // Per-criterion clip: synthesize a fixture with multiple candidates
    // per criterion (multiple `<input type="password">` files all fire
    // 3.3.8) and tighten `maxCandidatesPerCriterion: 1` so the
    // criterion clips. The summary's `candidatesUncapped` must report
    // the pre-clip count (matching the response-level
    // `totalCandidates`), while `candidatesReturned` reports the
    // post-clip count actually shipped — the headline reads "1 criterion
    // with N elided candidates" rather than the dishonest read of just
    // "1 thing to verify."
    const fixture = makeMultiCandidateFixture(5);
    try {
      const tool = findTool("checklist");
      const session = new McpSession();
      const result = await tool.handler({ cwd: fixture, maxCandidatesPerCriterion: 1 }, session);
      expect(result.isError).toBeUndefined();
      const data = parseEnvelope(result.content[0]?.text ?? "{}");
      const actionable = data.summary?.actionable;
      expect(actionable).toBeDefined();
      // The fixture is built so per-criterion clip fires — guard
      // against a regression where the synthetic fixture stops
      // producing >1 candidate per criterion.
      expect(data.perCriterionClipped).toBe(true);
      expect(actionable?.candidatesUncapped).toBe(data.totalCandidates ?? 0);
      expect(actionable?.candidatesReturned ?? 0).toBeLessThan(actionable?.candidatesUncapped ?? 0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

/**
 * Builds a synthetic fixture with N HTML files each carrying an
 * `<input type="password">` and adjacent media so multiple manual-review
 * finders fire (`review/password-inputs` for 3.3.8, plus media+image
 * candidates). Used by the near-limit-threshold tests below — the
 * inventory size is N × ~6 candidates, predictable enough to set
 * `limit` deterministically around the 0.8 threshold without depending
 * on a permanent fixture's exact rule fan-out.
 */
function makeMultiCandidateFixture(fileCount: number): string {
  const dir = mkTmp();
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(
      join(dir, `page${i}.html`),
      `<!doctype html><html lang="en"><head><title>x</title></head><body><main><form><input type="password" name="p${i}"></form><img src="x${i}.png"><video src="v${i}.mp4"></video><audio src="a${i}.mp3"></audio></main></body></html>`,
    );
  }
  return dir;
}

describe("checklist tool: nextStep paginate-recommendation when totalCandidates > limit*0.8", () => {
  // Doctrine reference: docs/kb/architecture/ai-first-consumer.md
  // §"One tool call should answer 'what next?'". When a response is
  // already pushing the limit ceiling, the structured nextStep should
  // ship paginate args (the same shape the truncated branch ships)
  // rather than the generic iterate-items[]/scan_project prose. The
  // 0.8 threshold is the near-cap signal — the agent's next call almost
  // always wants explicit paginate args.
  it("emits structured paginate args when totalCandidates > limit*0.8 even without truncation", async () => {
    // Build a fixture with enough actionable candidates to set a tight
    // `limit` that satisfies both: (a) `limit >= totalCandidates` so the
    // truncated branch does NOT fire; (b) `totalCandidates > limit*0.8`
    // so the new branch DOES. Picking `limit = totalCandidates + 1`
    // satisfies (a); the inequality `totalCandidates > 0.8*(totalCandidates+1)`
    // simplifies to `totalCandidates > 4`, so any fixture producing ≥5
    // candidates works.
    const fixture = makeMultiCandidateFixture(5);
    try {
      const tool = findTool("checklist");
      const session = new McpSession();
      const probe = await tool.handler({ cwd: fixture }, session);
      const probeData = parseEnvelope(probe.content[0]?.text ?? "{}");
      const totalCandidates = probeData.totalCandidates ?? 0;
      if (totalCandidates < 5) {
        throw new Error(
          `fixture regression — expected synthetic fixture to produce >= 5 actionable candidates, got ${totalCandidates}`,
        );
      }
      const tightLimit = totalCandidates + 1;
      const result = await tool.handler({ cwd: fixture, limit: tightLimit }, session);
      expect(result.isError).toBeUndefined();
      const data = parseEnvelope(result.content[0]?.text ?? "{}");
      // Branch fires only when not truncated (limit >= total). Confirm
      // the precondition holds before asserting the branch behavior.
      expect(data.truncated).toBeUndefined();
      // The ratio guard: totalCandidates must be > tightLimit*0.8 for
      // this branch to fire. Sanity-check the arithmetic before reading
      // the structured next step.
      expect(totalCandidates).toBeGreaterThan(tightLimit * 0.8);
      expect(data.nextStepStructured?.tool).toBe("checklist");
      const args = data.nextStepStructured?.args ?? {};
      expect(typeof args["offset"]).toBe("number");
      expect(typeof args["limit"]).toBe("number");
      // Prose mentions pagination/capacity, not the generic
      // "iterate items[]" prose the well-under branch ships.
      expect(data.nextStep).toMatch(/limit|offset|capacity/i);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("falls back to scan_project structured when totalCandidates is well under limit*0.8", async () => {
    // Default limit=200; a small fixture's totalCandidates (~tens) is
    // far under 160 (= 0.8*200), so the >0.8 branch must NOT fire. The
    // structured nextStep stays at scan_project { cwd } per the
    // iterate-items[] branch.
    const fixture = makeMultiCandidateFixture(2);
    try {
      const tool = findTool("checklist");
      const session = new McpSession();
      const result = await tool.handler({ cwd: fixture }, session);
      expect(result.isError).toBeUndefined();
      const data = parseEnvelope(result.content[0]?.text ?? "{}");
      const totalCandidates = data.totalCandidates ?? 0;
      // Default limit is 200; precondition requires totalCandidates <
      // 160 for the iterate branch to be the honest read.
      if (totalCandidates >= 160) {
        throw new Error(
          `fixture regression — expected synthetic fixture to produce < 160 candidates for the iterate branch test, got ${totalCandidates}`,
        );
      }
      expect(data.truncated).toBeUndefined();
      expect(data.nextStepStructured?.tool).toBe("scan_project");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
