/**
 * Cross-surface invariant for the `no_config_found` warning code.
 *
 * Doctrine (`docs/kb/architecture/ai-first-consumer.md`):
 *   - "Cross-surface count invariant" — a code emitted on one
 *     project-rooted tool that's predicate-eligible on the same input
 *     must be emitted on every other project-rooted tool that consumes
 *     the same corpus.
 *   - "Zero-output success is ambiguous failure" — `meta.configSource:
 *     null` shipping without a paired `warnings: ["no_config_found"]`
 *     code is the canonical ambiguous shape; the agent can't tell
 *     "tool ran but no config" from "tool never ran" without the code.
 *   - The paired `warningsDetails.no_config_found.searchedFrom: <cwd>`
 *     payload gives the agent one canonical answer to "where was the
 *     loader's search root?" regardless of which tool emitted it,
 *     closing the cross-surface inconsistency where some emitters
 *     surfaced the search root via `scanned.root` and others via
 *     `meta.cwd`.
 *
 * Predicate (re-stated from `src/mcp/config-search-marker.ts`):
 *   1. `configSource === null` (loader walk-up returned nothing).
 *   2. `filesScanned >= NO_CONFIG_FOUND_FILE_COUNT_THRESHOLD` (10).
 *   3. `sawProjectMarkerInWalk(cwd) === true` (a `package.json` lives
 *      somewhere along the walk-up the loader inspected).
 *
 * Surface coverage: every project-rooted tool that emits
 * `meta.configSource` ships the same warning shape — `scan_project`,
 * `coverage`, `checklist`, `list_suppressions`, `propose_baseline`,
 * `propose_config`, `scan_diff`, `vpat`. Single-file `scan_file` is
 * folded in because it also resolves a config from a project marker
 * walk-up.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
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

interface NoConfigEnvelope {
  readonly warnings?: readonly string[];
  readonly warningsDetails?: {
    readonly no_config_found?: { readonly searchedFrom: string };
  };
  readonly meta?: { readonly configSource?: string | null };
}

function noConfigEnvelope(raw: Record<string, unknown>): NoConfigEnvelope {
  return raw as NoConfigEnvelope;
}

/**
 * Builds a fixture that satisfies the predicate's three conjoined
 * conditions:
 *   - `package.json` at the root → `sawProjectMarkerInWalk` returns true.
 *   - 12 parseable HTML files → above the 10-file threshold.
 *   - No `ra11y.config.*` → loader walk returns null.
 *
 * The HTML files carry intentional violations so the scan finishes with
 * findings — the warnings channel is what we're checking, but a scan
 * with zero findings can hit cold-path branches that route the response
 * through the assembler differently.
 */
async function makeNoConfigFixture(): Promise<string> {
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-no-config-"));
  await writeFile(
    posixJoin(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0" }),
  );
  // Create 12 HTML files so files.length >= 10. Each file is shaped to
  // produce one `media/alt-text-missing` violation.
  for (let i = 0; i < 12; i++) {
    await writeFile(
      posixJoin(dir, `page-${i}.html`),
      `<html><body><img src="a.png"><p>page ${i}</p></body></html>`,
    );
  }
  return dir;
}

describe("no_config_found warning is consistent across every project-rooted tool", () => {
  it("scan_project, coverage, checklist all emit `no_config_found` with the same `searchedFrom` payload on the same cwd", async () => {
    const dir = await makeNoConfigFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const scanProj = noConfigEnvelope(body<Record<string, unknown>>(responses[1]));
    const coverage = noConfigEnvelope(body<Record<string, unknown>>(responses[2]));
    const checklist = noConfigEnvelope(body<Record<string, unknown>>(responses[3]));

    // All three see configSource: null because no ra11y.config.* lives
    // on the fixture or any ancestor we control. The fixture's tmpdir
    // path may carry a parent package.json on some CI systems; if the
    // loader actually resolves a config we abort with a helpful
    // message rather than silently passing the test on a vacuous shape.
    expect(scanProj.meta?.configSource ?? null).toBeNull();
    expect(coverage.meta?.configSource ?? null).toBeNull();
    expect(checklist.meta?.configSource ?? null).toBeNull();

    // Every surface fires `no_config_found`.
    expect(scanProj.warnings ?? []).toContain("no_config_found");
    expect(coverage.warnings ?? []).toContain("no_config_found");
    expect(checklist.warnings ?? []).toContain("no_config_found");

    // Every surface ships the same `searchedFrom: <cwd>` payload.
    expect(scanProj.warningsDetails?.no_config_found).toEqual({ searchedFrom: dir });
    expect(coverage.warningsDetails?.no_config_found).toEqual({ searchedFrom: dir });
    expect(checklist.warningsDetails?.no_config_found).toEqual({ searchedFrom: dir });
  });

  it("list_suppressions and propose_baseline and propose_config emit `no_config_found` with `searchedFrom: cwd`", async () => {
    const dir = await makeNoConfigFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "list_suppressions", { cwd: dir }),
      toolCall(3, "propose_baseline", { cwd: dir }),
      toolCall(4, "propose_config", { cwd: dir }),
    ]);
    const listSupp = noConfigEnvelope(body<Record<string, unknown>>(responses[1]));
    const proposeB = noConfigEnvelope(body<Record<string, unknown>>(responses[2]));
    const proposeC = noConfigEnvelope(body<Record<string, unknown>>(responses[3]));

    expect(listSupp.warnings ?? []).toContain("no_config_found");
    expect(proposeB.warnings ?? []).toContain("no_config_found");
    expect(proposeC.warnings ?? []).toContain("no_config_found");

    expect(listSupp.warningsDetails?.no_config_found).toEqual({ searchedFrom: dir });
    expect(proposeB.warningsDetails?.no_config_found).toEqual({ searchedFrom: dir });
    expect(proposeC.warningsDetails?.no_config_found).toEqual({ searchedFrom: dir });
  });

  it("scan_diff (baseline mode) emits `no_config_found` with `searchedFrom: cwd` when run against a config-less Node project", async () => {
    const dir = await makeNoConfigFixture();
    // Seed an empty baseline so scan_diff doesn't bail before reaching
    // the warning-emission site.
    const baselinePath = posixJoin(dir, ".ra11y-baseline.json");
    await writeFile(
      baselinePath,
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), violations: [] }),
    );
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_diff", { cwd: dir, baselinePath }),
    ]);
    const scanDiff = noConfigEnvelope(body<Record<string, unknown>>(responses[1]));
    expect(scanDiff.warnings ?? []).toContain("no_config_found");
    expect(scanDiff.warningsDetails?.no_config_found).toEqual({ searchedFrom: dir });
  });
});
