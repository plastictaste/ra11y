/**
 * Cross-surface invariant: `coverage({ verboseMeta: true })` and
 * `scan_file({ verboseMeta: true })` emit the same per-rule-coverage row
 * set on the same fixture.
 *
 * Pre-fix bug (Q10-COVERAGE-PERRULECOVERAGE-EMPTY-VS-SCAN-FILE-FULL): the
 * `coverage` tool's `verboseMeta: true` description promised
 * `meta.perRuleCoverage[]` rows would expand from the compact summary
 * into the full per-row payload, but the handler never threaded the rows
 * into the meta block. `scan_file` on the same input shipped ~95 rows;
 * `coverage` shipped zero. An agent reading per-rule coverage as
 * scan-confidence telemetry got contradictory mental models from two
 * surfaces designed to agree.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant," the same scan basis (parsed files + active rules) must
 * produce the same row set on every project-rooted MCP tool consuming
 * it. The closure: a shared per-rule-coverage assembly helper
 * (`src/mcp/per-rule-coverage-shared.ts`) consumed by both surfaces, and
 * this test pinning row-count + ruleId-set parity.
 *
 * Single-file scope (one HTML file) so the row counts are deterministic
 * and the assertion stays robust as the rule registry grows. The
 * project-scope variant of this invariant is covered by the existing
 * `mcp-meta-block-parity.test.ts`; this test specifically targets the
 * `coverage` ↔ `scan_file` axis the bug surfaced on.
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

interface PerRuleCoverageRow {
  readonly ruleId: string;
}

interface CoverageBody {
  readonly meta?: { readonly perRuleCoverage?: readonly PerRuleCoverageRow[] };
}

interface ScanFileBody {
  readonly meta?: { readonly perRuleCoverage?: readonly PerRuleCoverageRow[] };
}

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-perrule-parity-"));
  await writeFile(
    join(dir, "page.html"),
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head><title>Page</title></head>",
      "<body>",
      "<main>",
      "<h1>Heading</h1>",
      "<p>Paragraph text.</p>",
      '<a href="#section">Read more</a>',
      "</main>",
      "</body>",
      "</html>",
    ].join("\n"),
  );
  return dir;
}

describe("coverage ↔ scan_file: meta.perRuleCoverage row set agrees on identical input", () => {
  it("verboseMeta=true ships the same per-rule-coverage rows on both tools for one HTML file", async () => {
    const dir = await makeFixture();
    const filePath = join(dir, "page.html");

    const responses = await mcpSession([
      initMsg(1),
      // Coverage rooted at the fixture dir, narrowed to the single
      // HTML file via `paths`. Pre-fix this returned an empty
      // `meta.perRuleCoverage[]`; post-fix it returns the same row set
      // `scan_file` ships.
      toolCall(2, "coverage", {
        cwd: dir,
        paths: [filePath],
        standard: "wcag22",
        level: "AA",
        verboseMeta: true,
      }),
      // scan_file on the same file with the same verbosity. The
      // single-file extension filter applies after the cascade so the
      // row sets agree on this fixture (HTML-only, no .css / .js
      // gating mismatch).
      toolCall(3, "scan_file", {
        path: filePath,
        cwd: dir,
        standard: "wcag22",
        level: "AA",
        verboseMeta: true,
      }),
    ]);

    const coverage = body<CoverageBody>(responses[1]);
    const scanFile = body<ScanFileBody>(responses[2]);

    const coverageRows = coverage.meta?.perRuleCoverage ?? [];
    const scanFileRows = scanFile.meta?.perRuleCoverage ?? [];

    // The pin: both surfaces emit a non-empty array — pre-fix
    // `coverage` returned `[]` while `scan_file` shipped ~95 rows; the
    // shared helper makes both surfaces emit at least the same set of
    // applicable rules for this HTML fixture.
    expect(coverageRows.length).toBeGreaterThan(0);
    expect(scanFileRows.length).toBeGreaterThan(0);

    // Row-count parity. Both surfaces should produce exactly the same
    // count after the shared cascade — same parsed files, same active
    // rules, same adjustment chain.
    expect(coverageRows.length).toBe(scanFileRows.length);

    // RuleId-set parity. Sets are computed off the row arrays so order
    // differences (cap-prioritization within each band) don't fail the
    // assertion; the *set* of rules each surface saw must agree.
    const coverageRuleIds = new Set(coverageRows.map((r) => r.ruleId));
    const scanFileRuleIds = new Set(scanFileRows.map((r) => r.ruleId));
    expect(coverageRuleIds.size).toBe(scanFileRuleIds.size);
    for (const id of coverageRuleIds) expect(scanFileRuleIds.has(id)).toBe(true);
    for (const id of scanFileRuleIds) expect(coverageRuleIds.has(id)).toBe(true);
  });
});
