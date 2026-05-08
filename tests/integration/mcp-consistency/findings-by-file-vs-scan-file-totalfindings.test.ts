/**
 * Cross-surface count invariant: scan_project's per-file rollup entry
 * for a given path must agree with `scan_file({path})`'s severity-aware
 * counts on the same path.
 *
 * The drift this test pins:
 *   - `scan_project.plan.findingsByFile[i].count` (renamed
 *     `errorWarningCount`) measures error+warning findings only —
 *     info-severity findings are excluded so the rank-ordered headline
 *     matches the `plan.fixesByClass` lanes that drive triage.
 *   - `scan_file({path: same path}).totalFindings` measures the full
 *     paging inventory — ALL severities, including info — because the
 *     `limit`/`offset` paging primitive operates on the raw findings
 *     array.
 *
 * Pre-rename, both fields shipped under the bare name `count` /
 * `totalFindings` with no slice-explicit suffix; on a corpus heavy with
 * info-severity emissions (MDX docs corpus producing ~5% info-severity
 * findings), `findingsByFile[i].count` reported 252 vs
 * `scan_file({path}).totalFindings` reporting 264 — the same field
 * conceptually, two different slices, no rename to flag the asymmetry.
 *
 * Closure per `docs/kb/architecture/ai-first-consumer.md`
 * "Sibling fields naming the same concept must use one shape" +
 * "Cross-surface count invariant": rename the per-file entry's `count`
 * to `errorWarningCount` so the slice is visible on the wire. The
 * scan_file inventory stays under `totalFindings` (paging-load-bearing)
 * and the agent can derive the matching error+warning slice via
 * `totalFindings - plan.infoSeverityFindings`.
 *
 * The invariant pinned end-to-end: for every path in
 * scan_project.plan.findingsByFile, `errorWarningCount ===
 * scan_file({path}).totalFindings - scan_file({path}).plan.infoSeverityFindings`.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posixJoin } from "../../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..", "..");

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

interface FindingsByFileEntry {
  readonly path: string;
  readonly errorWarningCount: number;
}

interface ScanProjectBody {
  readonly plan: {
    readonly findingsByFile?: readonly FindingsByFileEntry[];
  };
}

interface ScanFileBody {
  readonly totalFindings?: number;
  readonly plan: {
    readonly infoSeverityFindings: number;
  };
}

describe("Q16: scan_project.plan.findingsByFile[i].errorWarningCount vs scan_file totalFindings", () => {
  it("agrees on the error+warning slice for every per-file rollup entry", async () => {
    // Fixture: a corpus that emits BOTH error/warning AND info-severity
    // findings on at least one file, so the slice asymmetry is real.
    // `<input type="text">` with no associated label fires
    // `forms/labels-required` at error severity AND triggers
    // `forms/non-empty-label` and `forms/_label-adjacency` info-severity
    // notes. The mix ensures `plan.infoSeverityFindings > 0` while
    // `findingsByFile[i].errorWarningCount > 0`, exercising the slice
    // asymmetry the rename surfaces.
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-q16-findingsbyfile-"));
    try {
      // Two files with different finding densities so the per-file
      // rollup ranks them in a deterministic order.
      writeFileSync(
        posixJoin(root, "page.html"),
        [
          "<html><head><title>Demo</title></head><body>",
          "  <main>",
          // Three missing-label inputs — each emits at least one
          // error-severity violation and may emit info-severity notes.
          '    <input type="text" id="a">',
          '    <input type="text" id="b">',
          '    <input type="text" id="c">',
          // Missing alt — error-severity emission.
          '    <img src="x.png">',
          "  </main>",
          "</body></html>",
        ].join("\n"),
      );
      writeFileSync(
        posixJoin(root, "other.html"),
        [
          "<html><head><title>Demo 2</title></head><body>",
          "  <main>",
          '    <input type="text" id="x">',
          "  </main>",
          "</body></html>",
        ].join("\n"),
      );

      // 1) Project scan — read findingsByFile rollup.
      const projectResponses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root }),
      ]);
      const projectScan = projectResponses.find((r) => r.id === 2);
      expect(projectScan).toBeDefined();
      const projectBody = body<ScanProjectBody>(projectScan as JsonRpcResponse);
      const findingsByFile = projectBody.plan.findingsByFile;
      expect(findingsByFile).toBeDefined();
      if (!findingsByFile) throw new Error("findingsByFile missing");
      expect(findingsByFile.length).toBeGreaterThan(0);

      // 2) For each entry, scan_file and verify slice agreement. We do
      //    this in a fresh session per call so each tool call gets a
      //    clean MCP subprocess (the helper kills the prior process on
      //    each invocation).
      for (const entry of findingsByFile) {
        // Slice-explicit field name — the rename Q16 closes.
        expect(typeof entry.errorWarningCount).toBe("number");
        expect(entry.errorWarningCount).toBeGreaterThan(0);

        const fileResponses = await mcpSession([
          initMsg(1),
          toolCall(2, "scan_file", { path: entry.path }),
        ]);
        const fileScan = fileResponses.find((r) => r.id === 2);
        expect(fileScan).toBeDefined();
        const fileBody = body<ScanFileBody>(fileScan as JsonRpcResponse);

        // `totalFindings` is the full paging inventory (all severities).
        // The slice-aware identity:
        //   findingsByFile[i].errorWarningCount
        //     === scan_file({path}).totalFindings - plan.infoSeverityFindings
        const total = fileBody.totalFindings ?? 0;
        const info = fileBody.plan.infoSeverityFindings;
        expect(typeof total).toBe("number");
        expect(typeof info).toBe("number");
        const errorWarningSlice = total - info;
        expect(entry.errorWarningCount).toBe(errorWarningSlice);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
