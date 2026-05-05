/**
 * `coverage.manualWithCandidates[]` per-entry candidate-shape invariant.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Per-tool review-
 * candidate shape must agree across surfaces": review candidates for the
 * same conceptual criterion ship across `scan_file.reviewCandidates[]`,
 * `checklist.items[].candidates[]`, and the `coverage.manualWithCandidates[]`
 * array — and the per-entry shape must agree. Pre-closure, `coverage`
 * shipped `{criterionId, title, level}` only and stripped the
 * `candidates[]` array entirely; an agent calling `coverage` first saw
 * the criterion count but no per-candidate evidence, then had to call
 * `checklist` to recover information `coverage` already discarded. The
 * silent-miss failure mode is the canonical one the doctrine names
 * under "cross-surface drift forces wasted round trips."
 *
 * Closure: `coverage.manualWithCandidates[]` now embeds a
 * `candidates: ScanProjectReviewCandidate[]` array per entry — same
 * shape `scan_project.reviewCandidates[]` ships, with stable
 * `findingId` matching the id `checklist.items[].candidates[]` ships
 * for the same conceptual candidate. Agents derive the per-criterion
 * candidate count via `entry.candidates.length` (no scalar twin per
 * "Sibling fields naming the same concept must use one shape").
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
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

interface CoverageCandidate {
  readonly findingId: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly criteria: readonly string[];
  readonly reason: string;
}

interface CoverageManualWithCandidatesEntry {
  readonly criterionId: string;
  readonly title: string;
  readonly level: string;
  readonly candidates: readonly CoverageCandidate[];
}

interface CoverageBody {
  readonly standardId: string;
  readonly manualWithCandidates?: readonly CoverageManualWithCandidatesEntry[];
}

interface ChecklistCandidate {
  readonly findingId: string;
  readonly path: string;
  readonly line: number;
  readonly criteria: readonly string[];
}

interface ChecklistItem {
  readonly criteria: readonly string[];
  readonly candidates: readonly ChecklistCandidate[];
}

interface ChecklistBody {
  readonly items: readonly ChecklistItem[];
}

/**
 * Fixture with a `<video>` element — the no-captions / no-audio-description
 * candidate finders ground manual candidates against
 * `wcag22:1.2.1`, `wcag22:1.2.2`, `wcag22:1.2.3`, etc. so coverage's
 * `manualWithCandidates[]` and checklist's `items[]` both populate.
 */
async function makeMediaFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-coverage-manual-candidates-"));
  await writeFile(
    join(dir, "page.html"),
    `<!DOCTYPE html><html lang="en"><head><title>Watch</title></head><body><main>
  <video src="x.mp4" controls></video>
</main></body></html>`,
  );
  return dir;
}

describe("coverage.manualWithCandidates[] per-entry candidate-shape contract", () => {
  it("ships `candidates: ScanProjectReviewCandidate[]` on every entry", async () => {
    const dir = await makeMediaFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body<CoverageBody>(responses[1]);

    // The fixture has a `<video>` element so the manual-review pile
    // should be non-empty. Treat the absent field as a fixture
    // regression rather than a vacuously-passing test.
    expect(coverage.manualWithCandidates).toBeDefined();
    const entries = coverage.manualWithCandidates ?? [];
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      // Per-entry shape: criterionId/title/level + candidates[]. The
      // `candidates` array is the canonical per-criterion grounded
      // evidence; agents derive the candidate count via `.length`.
      expect(typeof entry.criterionId).toBe("string");
      expect(typeof entry.title).toBe("string");
      expect(typeof entry.level).toBe("string");
      expect(Array.isArray(entry.candidates)).toBe(true);

      // Empty `candidates: []` would be the dishonest sentinel-empty-
      // list shape per "Sibling fields naming the same concept must
      // use one shape" — coverage filters `withCandidates` to criteria
      // that have ≥1 candidate before populating the entry, so every
      // surfaced entry MUST carry ≥1 candidate.
      expect(entry.candidates.length).toBeGreaterThan(0);

      // Per-candidate shape: same fields scan_project.reviewCandidates[]
      // ships, so an agent reading either surface gets the same row
      // shape. `findingId` is the cross-surface address.
      for (const c of entry.candidates) {
        expect(typeof c.findingId).toBe("string");
        expect(c.findingId.length).toBeGreaterThan(0);
        expect(typeof c.file).toBe("string");
        expect(typeof c.line).toBe("number");
        expect(typeof c.column).toBe("number");
        expect(Array.isArray(c.criteria)).toBe(true);
        // Every candidate appearing under criterion X must list X among
        // its `criteria[]` — same invariant scan_file/scan_project use.
        expect(c.criteria).toContain(entry.criterionId);
        expect(typeof c.reason).toBe("string");
      }
    }
  });

  it("findingId on coverage agrees with the id checklist ships for the same conceptual candidate", async () => {
    // Cross-surface invariant per
    // `docs/kb/architecture/ai-first-consumer.md` "Per-finding
    // identifiers must be addressable, not collision-prone" + "Per-tool
    // review-candidate shape must agree across surfaces": the same
    // conceptual candidate produces ONE `findingId` across coverage,
    // checklist, scan_project, and scan_file. Pinned here for the
    // coverage ↔ checklist axis specifically (the new surface added
    // by the `manualWithCandidates[].candidates[]` embedding).
    const dir = await makeMediaFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const coverage = body<CoverageBody>(responses[1]);
    const checklist = body<ChecklistBody>(responses[2]);

    // Index checklist's candidate ids per criterion so we can compare
    // per-criterion sets (every criterion in coverage's
    // manualWithCandidates must have a corresponding checklist item
    // covering at least the same finding ids).
    const checklistIdsByCriterion = new Map<string, Set<string>>();
    for (const item of checklist.items) {
      for (const criterionId of item.criteria) {
        let bucket = checklistIdsByCriterion.get(criterionId);
        if (bucket === undefined) {
          bucket = new Set();
          checklistIdsByCriterion.set(criterionId, bucket);
        }
        for (const c of item.candidates) bucket.add(c.findingId);
      }
    }

    const coverageEntries = coverage.manualWithCandidates ?? [];
    expect(coverageEntries.length).toBeGreaterThan(0);

    for (const entry of coverageEntries) {
      const checklistIds = checklistIdsByCriterion.get(entry.criterionId);
      // `withCandidates` upstream of the entry build is sourced from
      // the same `report.candidates` checklist consumes, so every
      // criterion grounded in coverage MUST have a checklist item
      // for the same id.
      expect(checklistIds).toBeDefined();
      const ids = checklistIds ?? new Set<string>();
      for (const c of entry.candidates) {
        expect(ids.has(c.findingId)).toBe(true);
      }
    }
  });

  it("entry candidate count agrees with checklist's per-criterion candidate count on identical cwd", async () => {
    // Cross-surface count invariant (warning-channel extension): the
    // same conceptual counter computed off coverage's
    // `manualWithCandidates[].candidates.length` must agree with the
    // count checklist surfaces under `items[].candidates.length` for
    // the matching criterion. Drift here is the silent-miss case where
    // coverage's headline differs from checklist's per-item evidence
    // and an agent reading coverage first budgets against the wrong
    // tally.
    const dir = await makeMediaFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const coverage = body<CoverageBody>(responses[1]);
    const checklist = body<ChecklistBody>(responses[2]);

    // Count distinct `findingId`s per criterion on the checklist side
    // — checklist's `items[]` walks per-criterion so the count is
    // direct.
    const checklistCountByCriterion = new Map<string, number>();
    for (const item of checklist.items) {
      for (const criterionId of item.criteria) {
        const distinct = new Set(item.candidates.map((c) => c.findingId));
        checklistCountByCriterion.set(
          criterionId,
          (checklistCountByCriterion.get(criterionId) ?? 0) + distinct.size,
        );
      }
    }

    for (const entry of coverage.manualWithCandidates ?? []) {
      const distinctIds = new Set(entry.candidates.map((c) => c.findingId));
      const checklistCount = checklistCountByCriterion.get(entry.criterionId) ?? 0;
      // The two surfaces compute over the same `report.candidates`
      // stream — distinct id counts per criterion must match.
      expect(distinctIds.size).toBe(checklistCount);
    }
  });
});
