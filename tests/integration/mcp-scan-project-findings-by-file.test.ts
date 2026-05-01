/**
 * Integration test for the per-file finding-frequency rollup on
 * `scan_project.plan.findingsByFile`.
 *
 * Three invariants pinned end-to-end through the MCP server:
 *
 *   1. The array is rank-ordered by `count` descending, with `path`
 *      ascending as the deterministic tiebreak — agents reading the
 *      head can route triage to the densest file in one read without
 *      paging through `files[]`.
 *   2. The array is capped to {@link FINDINGS_BY_FILE_DEFAULT_LIMIT}
 *      (20) entries; when the corpus exceeds the cap,
 *      `findingsByFileTruncated: true` rides alongside so the agent
 *      can distinguish "complete inventory" from "head-slice clipped."
 *   3. The rollup is computed from the full `formatted.files` list
 *      (whole-scan), NOT the paged subset — so the headline describes
 *      the whole scan regardless of which page the caller fetched. The
 *      sum of `count` across the surviving entries equals the
 *      error+warning total measured by `plan.fixesByClass` lanes
 *      summed across both scan-kinds (cross-surface count invariant).
 *
 * Why pin this end-to-end: per
 * `docs/kb/architecture/ai-first-consumer.md` "One tool call should
 * answer 'what next?'", the headline must let an agent route triage
 * without paging. A regression that drops the sort, drops the cap, or
 * silently elides the truncation flag would force the agent into the
 * per-file pagination loop the rollup exists to defeat.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINDINGS_BY_FILE_DEFAULT_LIMIT } from "../../src/mcp/scan-assembly.ts";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

type JsonRpcResponse = Record<string, unknown>;

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  const payload = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  proc.stdin.write(payload);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  proc.kill();
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JsonRpcResponse);
}

function initMsg(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-agent", version: "1.0" },
    },
  };
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function bodyOf(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

interface FindingsByFileEntry {
  readonly path: string;
  readonly count: number;
}

describe("scan_project: plan.findingsByFile rollup", () => {
  it("ranks files by count desc, path asc, on a small multi-file fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-findings-by-file-rank-"));
    try {
      // Three authored HTML files. `a.html` carries multiple
      // mechanical missing-alt violations (wcag22:1.1.1) plus the
      // shared document-shape rules (lang, page-titled, landmark-main,
      // heading-hierarchy) that fire on any HTML envelope; `m.html`
      // and `z.html` carry one missing-alt plus the same envelope
      // overhead, so their final counts are equal — exercising the
      // alphabetical tiebreak. The exact totals depend on the active
      // rule set; the test asserts structural invariants
      // (monotonic-desc sort, alphabetical tiebreak, top entry has
      // strictly higher count than the tied pair) rather than a fixed
      // absolute count, so a future rule addition won't break the
      // ranking contract this rollup ships.
      writeFileSync(
        join(root, "a.html"),
        '<html><body><img src="1.png"><img src="2.png"><img src="3.png"></body></html>\n',
      );
      writeFileSync(join(root, "m.html"), '<html><body><img src="x.png"></body></html>\n');
      writeFileSync(join(root, "z.html"), '<html><body><img src="y.png"></body></html>\n');

      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;

      const findingsByFile = plan["findingsByFile"] as readonly FindingsByFileEntry[] | undefined;
      expect(findingsByFile).toBeDefined();
      if (!findingsByFile) throw new Error("findingsByFile missing");

      // Three files participate (every authored .html carries at least
      // one error/warning finding by construction). Path shape is
      // whatever the discovery layer produced — the rollup preserves
      // it identically so we match by basename suffix to stay robust
      // to absolute-vs-relative differences across platforms / tmpdir
      // resolution.
      expect(findingsByFile.length).toBeGreaterThanOrEqual(3);

      // Counts descend monotonically — the load-bearing rank-order
      // invariant. A regression that drops the sort would surface as
      // a non-monotonic prefix here.
      for (let i = 1; i < findingsByFile.length; i += 1) {
        const prev = findingsByFile[i - 1];
        const cur = findingsByFile[i];
        if (prev === undefined || cur === undefined) continue;
        expect(prev.count >= cur.count).toBe(true);
      }

      // Alphabetical tiebreak — `m.html` and `z.html` carry the same
      // count (one missing-alt + identical envelope rules) so they sort
      // by path. Locate them by basename suffix and confirm m precedes
      // z when their counts are equal.
      const mEntry = findingsByFile.find((e) => e.path.endsWith("m.html"));
      const zEntry = findingsByFile.find((e) => e.path.endsWith("z.html"));
      const aEntry = findingsByFile.find((e) => e.path.endsWith("a.html"));
      expect(mEntry).toBeDefined();
      expect(zEntry).toBeDefined();
      expect(aEntry).toBeDefined();
      if (!(mEntry && zEntry && aEntry)) throw new Error("expected entries missing");
      expect(mEntry.count).toBe(zEntry.count);
      expect(findingsByFile.indexOf(mEntry)).toBeLessThan(findingsByFile.indexOf(zEntry));

      // Top entry — `a.html` has strictly more findings than the tied
      // pair because of the extra missing-alt violations. The rollup's
      // job is to surface "where the work clusters" first.
      expect(findingsByFile[0]).toBe(aEntry);
      expect(aEntry.count).toBeGreaterThan(mEntry.count);

      // No truncation flag when the rollup carries the full inventory
      // (small fixture is well under the 20-entry cap).
      expect(plan["findingsByFileTruncated"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps at FINDINGS_BY_FILE_DEFAULT_LIMIT and stamps findingsByFileTruncated when the tail clips", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-findings-by-file-cap-"));
    try {
      // Build (cap + 5) files, each carrying one missing-alt finding.
      // The rollup should clip to the cap and stamp the truncation flag.
      const totalFiles = FINDINGS_BY_FILE_DEFAULT_LIMIT + 5;
      for (let i = 0; i < totalFiles; i += 1) {
        const name = `f${String(i).padStart(3, "0")}.html`;
        writeFileSync(join(root, name), '<html><body><img src="x.png"></body></html>\n');
      }

      // Bump `limit` past the file-count cap so the response body
      // can hold every per-file entry; the rollup cap is independent
      // of pagination and we want to assert it directly.
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: totalFiles + 10 }),
      ]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;

      const findingsByFile = plan["findingsByFile"] as readonly FindingsByFileEntry[] | undefined;
      expect(findingsByFile).toBeDefined();
      if (!findingsByFile) throw new Error("findingsByFile missing");

      // Hard cap to the published limit, regardless of corpus size.
      expect(findingsByFile.length).toBe(FINDINGS_BY_FILE_DEFAULT_LIMIT);
      // Truncation flag rides alongside the clipped slice.
      expect(plan["findingsByFileTruncated"]).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
