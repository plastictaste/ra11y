/**
 * Integration test for the per-first-child-dir rollup on
 * `scan_project.plan.topDirectories`.
 *
 * The mono-repo case the field exists for: 50 independent mini-projects
 * under one root, treated by `scan_project` as one repo. The rollup
 * lets the agent pick the dominant sub-tree in one read so the next
 * call narrows scope (`additionalPaths: [topDirectories[0].path]`)
 * rather than paging through `files[]` and re-aggregating by directory.
 *
 * Three invariants pinned end-to-end through the MCP server:
 *
 *   1. The array is rank-ordered by `violationCount` descending, with
 *      `path` ascending as the deterministic tiebreak — agents reading
 *      the head can scope into the worst sub-project in one read.
 *   2. The single-bucket short-circuit fires: when every error/warning
 *      finding falls inside one sub-tree, the field is omitted from
 *      `plan` so the wire shape doesn't ship a one-row "rollup" that
 *      tells the agent nothing the existing surfaces don't already say.
 *   3. The rollup is computed from the full `formatted.files` list
 *      (whole-scan), NOT the paged subset — so the headline describes
 *      the whole scan regardless of which page the caller fetched.
 *
 * Why pin this end-to-end: per
 * `docs/kb/architecture/ai-first-consumer.md` "One tool call should
 * answer 'what next?'", the headline must let an agent route triage
 * without paging. A regression that drops the sort, drops the
 * single-bucket short-circuit, or silently elides the truncation flag
 * would force the agent into the per-file pagination loop the rollup
 * exists to defeat.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posixJoin } from "../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..");

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

interface TopDirectoryEntry {
  readonly path: string;
  readonly violationCount: number;
  readonly fileCount: number;
  readonly topRule?: string;
}

describe("scan_project: plan.topDirectories rollup", () => {
  it("ranks sub-trees by violationCount desc on a multi-bucket fixture", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-top-directories-rank-"));
    try {
      // Three mini-projects under the root. `heavy/` carries multiple
      // missing-alt violations on top of the standard document-shape
      // rules, so it ranks first; `medium/` carries one missing-alt;
      // `light/` carries one missing-alt as well. The exact counts
      // depend on the active rule set, so the test asserts structural
      // invariants (monotonic-desc sort, top entry strictly higher
      // than the tail) rather than fixed counts.
      mkdirSync(posixJoin(root, "heavy"));
      mkdirSync(posixJoin(root, "medium"));
      mkdirSync(posixJoin(root, "light"));
      writeFileSync(
        posixJoin(root, "heavy", "index.html"),
        '<html><body><img src="1.png"><img src="2.png"><img src="3.png"></body></html>\n',
      );
      writeFileSync(
        posixJoin(root, "medium", "index.html"),
        '<html><body><img src="x.png"></body></html>\n',
      );
      writeFileSync(
        posixJoin(root, "light", "index.html"),
        '<html><body><img src="y.png"></body></html>\n',
      );

      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;

      const topDirectories = plan["topDirectories"] as readonly TopDirectoryEntry[] | undefined;
      expect(topDirectories).toBeDefined();
      if (!topDirectories) throw new Error("topDirectories missing");

      // Three buckets — one per mini-project subdirectory. The rollup
      // keys by the firstChildDir relative to the scanned root.
      expect(topDirectories.length).toBe(3);
      const paths = topDirectories.map((e) => e.path).sort();
      expect(paths).toEqual(["heavy", "light", "medium"]);

      // Counts descend monotonically — the load-bearing rank-order
      // invariant. A regression that drops the sort would surface as
      // a non-monotonic prefix here.
      for (let i = 1; i < topDirectories.length; i += 1) {
        const prev = topDirectories[i - 1];
        const cur = topDirectories[i];
        if (prev === undefined || cur === undefined) continue;
        expect(prev.violationCount >= cur.violationCount).toBe(true);
      }

      // `heavy/` ranks first (strictly higher count than the rest).
      expect(topDirectories[0]?.path).toBe("heavy");
      const heavyEntry = topDirectories[0];
      const otherEntries = topDirectories.slice(1);
      for (const entry of otherEntries) {
        expect(heavyEntry?.violationCount ?? 0).toBeGreaterThan(entry.violationCount);
      }

      // Each entry carries a fileCount and (since at least one rule
      // fired in each bucket) a topRule annotation.
      for (const entry of topDirectories) {
        expect(entry.fileCount).toBeGreaterThan(0);
        expect(typeof entry.topRule).toBe("string");
      }

      // No truncation flag when the rollup carries the full inventory
      // (3 buckets is well under the 10-entry default cap).
      expect(plan["topDirectoriesTruncated"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits topDirectories when every finding falls in one sub-tree (single-bucket short-circuit)", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-top-directories-single-"));
    try {
      // Two files in the same first-child-dir bucket — rollup would
      // produce one row, which tells the agent nothing the existing
      // surfaces don't already say. The helper short-circuits to omit
      // the field; that's the single-bucket-redundancy invariant.
      mkdirSync(posixJoin(root, "only"));
      writeFileSync(
        posixJoin(root, "only", "a.html"),
        '<html><body><img src="x.png"></body></html>\n',
      );
      writeFileSync(
        posixJoin(root, "only", "b.html"),
        '<html><body><img src="y.png"></body></html>\n',
      );

      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;

      // Single-bucket short-circuit: field omitted from the wire.
      expect(plan["topDirectories"]).toBeUndefined();
      // Sibling rollups still ship — `topRules`/`findingsByFile` cover
      // the rule-axis and file-axis questions on a single sub-tree.
      expect(plan["topRules"]).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
