/**
 * Cross-channel invariant: when a checklist candidate sits on a file that
 * BOTH carries `vendorPathHint: true` AND is classified by the scan-time
 * build-artifact pass (`scannedBuildArtifacts`), the per-item priority
 * must drop to `"low"` (not the existing vendor-context-only `"medium"`)
 * AND the per-candidate `couldBeWrongBecause` must stamp
 * `["minified_vendor_no_sourcemap"]`.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Reason / priority /
 * fix-description must agree across all three channels": at the limit
 * case where the cited evidence is a single-letter identifier inside a
 * minified bundle, the agent cannot honestly resolve the predicate
 * without a sourcemap; riding at `"medium"` priority overstates the
 * evidence quality. The two-component co-occurrence (vendor-path-shape
 * + build-artifact-confirmed-bytes) earns the budget drop and the
 * paired `couldBeWrongBecause` evidence stamp so the agent reads BOTH
 * channels from one entry — dismissal path becomes "verify the
 * concession the gate names" rather than guessing why budget dropped.
 *
 * Surface-don't-suppress: the candidate stays surfaced; only the
 * attention-budget signal moves and the evidence stamp lands.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

interface ChecklistCandidate {
  readonly reason: string;
  readonly vendorPathHint?: boolean;
  readonly couldBeWrongBecause?: readonly string[];
}

interface ChecklistItem {
  readonly criteria: readonly string[];
  readonly priority: "high" | "medium" | "low";
  readonly candidates: readonly ChecklistCandidate[];
}

interface ChecklistResponse {
  readonly items: readonly ChecklistItem[];
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

describe("checklist priority drops to 'low' on minified-vendor-no-sourcemap candidates", () => {
  it("ships priority 'low' and couldBeWrongBecause stamp on a minified vendor file with a single-letter setTimeout identifier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-min-vendor-no-sourcemap-"));
    // `lib.min.js` matches the minified-shape predicate via the `.min.`
    // infix in the basename — both the build-artifact classifier (in
    // `src/mcp/build-artifacts.ts` `detectMinInfix`) AND the timing
    // finder's `isMinifiedForEnrichment` predicate fire on the same
    // path, populating `vendorPathHint: true` on every emitted
    // candidate AND classifying the file under `scannedBuildArtifacts`
    // — the two-component gate's preconditions both hold.
    //
    // The single-letter identifier `_` as the setTimeout duration is
    // the canonical "cannot resolve without a sourcemap" predicate the
    // gate names: in the unminified source the identifier was a
    // descriptive name like `pollInterval`, but the minifier collapsed
    // it to `_`; an agent reading just this file cannot tell whether
    // the timer is a real session-keepalive (needs user control) or a
    // 5ms debounce. Per AI-first doctrine "Reason / priority /
    // fix-description must agree across all three channels," the
    // priority signal must concede the predicate-strength gap.
    await writeFile(join(dir, "lib.min.js"), `var _=5;setTimeout(function(){doStuff();},_);\n`);
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const item = checklist.items.find((i) => i.criteria[0] === "wcag22:2.2.1");
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.candidates.length).toBeGreaterThan(0);
    // First leg — vendorPathHint fires.
    expect(item.candidates.every((c) => c.vendorPathHint === true)).toBe(true);
    // Second leg — combined with the build-artifact classification, the
    // gate fires and the per-item priority drops all the way to "low"
    // (not the previous "medium" the vendor-context-only gate produced).
    expect(item.priority).toBe("low");
    // Paired evidence stamp lands on every candidate so the agent reads
    // BOTH the budget signal AND the predicate-strength concession.
    expect(
      item.candidates.every((c) => c.couldBeWrongBecause?.includes("minified_vendor_no_sourcemap")),
    ).toBe(true);
  });

  it("keeps priority 'high' and omits couldBeWrongBecause when at least one candidate is on hand-authored source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-mixed-min-vendor-"));
    // Mixed corpus: an authored `.js` with no minification AND a
    // minified vendor sibling. The all-or-nothing test mirrors the
    // existing vendor-context-priority gate — a single hand-authored
    // sibling on the same criterion keeps the item at "high" so the
    // agent doesn't miss the actionable case among the minified-vendor
    // siblings. couldBeWrongBecause stays omitted on the authored
    // candidate (the helper returns null for it).
    await writeFile(
      join(dir, "src.js"),
      `function bootstrap(){ setTimeout(function(){ tick(); }, 5000); }\n`,
    );
    await writeFile(join(dir, "lib.min.js"), `var _=5;setTimeout(function(){doStuff();},_);\n`);
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const item = checklist.items.find((i) => i.criteria[0] === "wcag22:2.2.1");
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.priority).toBe("high");
    // At least one candidate (the authored-source one) does NOT carry
    // the couldBeWrongBecause stamp — the helper returns null on
    // ordinary authored candidates, omitting the field per CLAUDE.md
    // §1 "Ambiguous field shapes are dishonest."
    expect(
      item.candidates.some(
        (c) =>
          c.couldBeWrongBecause === undefined ||
          !c.couldBeWrongBecause.includes("minified_vendor_no_sourcemap"),
      ),
    ).toBe(true);
  });
});
