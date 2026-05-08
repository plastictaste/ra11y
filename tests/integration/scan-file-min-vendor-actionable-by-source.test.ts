/**
 * Q15-MIN-CSS — `scan_file` on a vendor `*.min.css` lane-splits the
 * `actionableManualItemsBySource` headline so the agent reads the
 * honest distribution of manual-review evidence across `source` /
 * `buildArtifact`.
 *
 * Pre-fix the plan headline shipped as a bare `actionableManualItems:
 * 1` while every contributing review-candidate / verify-token finding
 * sat on the `buildArtifact` lane (the file path was in the build-
 * artifact set the `.min.` infix predicate produces). Per
 * `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest" the bare scalar was dropped — its dishonest
 * shape on bulk-vendor scans was the same shape the per-lane
 * `fixesByClass` split was created to surface. The post-fix headline
 * ships as `{ source: N, buildArtifact: M }` so an agent reading the
 * scan output can immediately tell "all the manual-review evidence
 * is in vendor code; scope down" without paging into the candidate
 * list.
 *
 * Asserts:
 *
 *   1. `scan_file` on a `bootstrap.min.css` containing a Tailwind-
 *      escape-bracket selector that surfaces a manual-review
 *      candidate ships
 *      `plan.actionableManualItemsBySource.source === 0` AND
 *      `plan.actionableManualItemsBySource.buildArtifact >= 1`.
 *      Reads the per-lane shape end-to-end to pin the doctrine bullet.
 *   2. `scan_file` on the SAME content under a non-vendor filename
 *      (`page.html`) ships
 *      `plan.actionableManualItemsBySource.source >= 1` AND
 *      `plan.actionableManualItemsBySource.buildArtifact === 0`.
 *      Confirms the lane split keys off the build-artifact classifier
 *      output (path-shape predicate), not on a downgrade to severity
 *      or some other proxy.
 *   3. The bare `actionableManualItems` headline is absent from the
 *      plan on both shapes — the deletion-not-renaming precedent on
 *      `plan.totalFindings` / `plan.safeEditsAvailable` /
 *      `plan.violations` / `plan.summary` / `plan.untargetedCriteria`
 *      extends to the actionable manual axis.
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

interface ActionableManualBySource {
  readonly source: number;
  readonly buildArtifact: number;
}

interface ScanFileBody {
  readonly plan: {
    readonly actionableManualItemsBySource: ActionableManualBySource;
  } & Record<string, unknown>;
  readonly findings?: readonly { readonly criteria: readonly string[] }[];
  readonly reviewCandidates?: readonly { readonly criteria: readonly string[] }[];
}

function bodyOf<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

/**
 * Builds a `bundle.min.js` whose only authored input is a `setTimeout`
 * call with a numeric duration — `review/timing` surfaces a manual-
 * review candidate against `wcag22:2.2.1`. The `.min.` infix in the
 * basename is the canonical build-artifact classifier signal:
 * `collectBuildArtifacts` routes the file into the `buildArtifact`
 * lane via the `MIN_INFIX_RE` path predicate, and the assembler's
 * `withActionableManualItemsBySource` rewrite intersects the
 * actionable criterion's contributing path against that vendor-path
 * set so an agent reading `scan_file({ path: "bundle.min.js" })`
 * sees the lane distribution honestly rather than the bare
 * `actionableManualItems: 1` shape Q15-MIN-CSS surfaced.
 */
async function makeMinVendorFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-q15-min-vendor-"));
  const page = join(dir, "bundle.min.js");
  await writeFile(page, `setTimeout(function(){location.reload();},2000);\n`);
  return { dir, page };
}

/**
 * Same content, authored-source filename — pins that the lane split
 * keys off the build-artifact classifier (the `.min.` infix predicate)
 * rather than on a content-only downgrade.
 */
async function makeAuthoredSourceFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-q15-source-js-"));
  const page = join(dir, "site.js");
  await writeFile(page, `setTimeout(function(){location.reload();},2000);\n`);
  return { dir, page };
}

describe("Q15-MIN-CSS: scan_file plan.actionableManualItemsBySource splits by build-artifact lane", () => {
  it("on a `*.min.js` vendor fixture, every actionable criterion routes to the buildArtifact lane (source: 0, buildArtifact >= 1)", async () => {
    const { page } = await makeMinVendorFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const body = bodyOf<ScanFileBody>(responses[1]);
    const lane = body.plan.actionableManualItemsBySource;
    // Sanity: the per-scan-kind shape is present and well-formed.
    expect(typeof lane).toBe("object");
    expect(typeof lane.source).toBe("number");
    expect(typeof lane.buildArtifact).toBe("number");
    // Sanity: the fixture surfaced at least one actionable manual-review
    // criterion (review-candidate or verify-token finding). A 0/0 result
    // would mean the focus-outline finder missed the fixture and the
    // lane assertion would be vacuous — exactly the silent miss the
    // doctrine warns against.
    const flat = lane.source + lane.buildArtifact;
    expect(flat).toBeGreaterThan(0);
    // The load-bearing assertion: no actionable evidence sits on the
    // `source` lane, every contributor sits on `buildArtifact`. Pre-fix
    // the bare `actionableManualItems: 1` hid the lane distribution.
    expect(lane.source).toBe(0);
    expect(lane.buildArtifact).toBeGreaterThanOrEqual(1);
    // The bare `actionableManualItems` scalar must not ride next to the
    // per-scan-kind sibling — keeping a flat composite alongside the
    // honest split would re-create the dishonest-headline shape per
    // the deletion-not-renaming precedent.
    expect(body.plan).not.toHaveProperty("actionableManualItems");
  });

  it("on an authored-source `.js` fixture with identical content, every actionable criterion routes to the source lane (source >= 1, buildArtifact: 0)", async () => {
    const { page } = await makeAuthoredSourceFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const body = bodyOf<ScanFileBody>(responses[1]);
    const lane = body.plan.actionableManualItemsBySource;
    const flat = lane.source + lane.buildArtifact;
    expect(flat).toBeGreaterThan(0);
    // The complementary direction: identical content under a non-
    // vendor filename ships the same actionable count under the
    // `source` lane. Pins that the lane split keys on the path-shape
    // build-artifact classifier, not on a downgrade gated by a
    // different signal.
    expect(lane.source).toBeGreaterThanOrEqual(1);
    expect(lane.buildArtifact).toBe(0);
    expect(body.plan).not.toHaveProperty("actionableManualItems");
  });
});
