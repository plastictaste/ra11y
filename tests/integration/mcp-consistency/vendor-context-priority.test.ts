/**
 * Cross-channel invariant: a checklist item's `priority` must not
 * contradict the `vendorContext` framing its candidates ship.
 *
 * Per docs/kb/architecture/ai-first-consumer.md "Reason / priority /
 * fix-description must agree across all three channels", a candidate
 * whose cited file matches a vendor-path-shape predicate (canonical
 * vendor-bundle basename, `.min.` infix, single-line minified shape)
 * carries a `vendorContext: { signal }` payload naming which path-
 * shape predicate fired. The framing concedes the dismissal direction
 * is "override the failing concern in your own code rather than edit
 * this file" (documented on the `suggest_fix` surface's separate
 * `VendorContext` shape) — which is fundamentally different work
 * from a candidate pointing at hand-authored source.
 *
 * The agent budgets against priority; when every grounded candidate
 * sits on a vendor / build-output file, the priority signal must
 * match — drop to `medium` so the framing matches "please verify
 * via override" rather than "edit this in the next minute."
 *
 * Two real shapes exercised here:
 *   1. `setTimeout` calls in a vendor-bundle file (`jquery-1.10.2.js`).
 *      The timing finder's `isVendorBundleBasename` predicate fires;
 *      every grounded candidate carries `vendorContext`.
 *   2. `setTimeout` calls in a `.min.js` file. The timing finder's
 *      `isMinifiedForEnrichment` predicate fires; same outcome — every
 *      grounded candidate carries `vendorContext`.
 *
 * In both cases 2.2.1 is Level A, so the un-downgraded priority would
 * be `"high"`; the vendor-context-aware downgrade must drop it to
 * `"medium"`.
 *
 * Surface-don't-suppress: candidates stay surfaced. The agent reads
 * the dismissal direction once and decides.
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

interface VendorContextPayload {
  readonly signal: { readonly kind: string };
}

interface ChecklistCandidate {
  readonly reason: string;
  readonly vendorContext?: VendorContextPayload;
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

describe("checklist priority must not contradict vendorContext on candidates", () => {
  it("downgrades wcag22:2.2.1 priority when every candidate sits in a vendor-bundle file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-vendor-2-2-1-"));
    // Canonical vendor-bundle basename — `isVendorBundleBasename`
    // fires; every emitted setTimeout candidate carries
    // `vendorContext: { signal: { kind: "vendor-bundle-basename" } }`.
    // 2.2.1 is Level A, so the un-downgraded priority would be "high";
    // the vendor-context downgrade must drop it to "medium".
    await writeFile(
      join(dir, "jquery-1.10.2.js"),
      `function tick(){ setTimeout(function(){ tick(); }, 2000); }\n`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const item = checklist.items.find((i) => i.criteria[0] === "wcag22:2.2.1");
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.candidates.length).toBeGreaterThan(0);
    // Every grounded candidate carries the vendorContext payload.
    expect(item.candidates.every((c) => c.vendorContext !== undefined)).toBe(true);
    expect(
      item.candidates.every((c) => c.vendorContext?.signal.kind === "vendor-bundle-basename"),
    ).toBe(true);
    // Priority downgrade kicks in.
    expect(item.priority).not.toBe("high");
    expect(["medium", "low"]).toContain(item.priority);
  });

  it("downgrades wcag22:2.2.1 priority when every candidate sits in a `.min.js` file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-vendor-min-2-2-1-"));
    // Filename matches the minified-shape predicate via the `.min.`
    // infix even on short content — `isMinifiedForEnrichment`
    // returns true on basename match alone. The signal kind names
    // the predicate that fired (mirrors detectVendorContext
    // preference order — vendor-bundle-basename wins when both
    // match; here only the minified-shape predicate applies).
    await writeFile(
      join(dir, "respond.min.js"),
      `var p=2000;setTimeout(function(){doStuff();},p);\n`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const item = checklist.items.find((i) => i.criteria[0] === "wcag22:2.2.1");
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.candidates.length).toBeGreaterThan(0);
    expect(item.candidates.every((c) => c.vendorContext !== undefined)).toBe(true);
    expect(item.priority).not.toBe("high");
    expect(["medium", "low"]).toContain(item.priority);
  });

  it("keeps wcag22:2.2.1 priority high when at least one candidate is on authored source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-mixed-2-2-1-"));
    // Two files: one authored, one vendor. The all-or-nothing
    // downgrade test mirrors hedging-aware priority — a single
    // hand-authored sibling on the same criterion keeps the item at
    // "high" so the agent doesn't miss the actionable case among
    // the vendor-pathed siblings.
    await writeFile(
      join(dir, "src.js"),
      `function bootstrap(){ setTimeout(function(){ tick(); }, 5000); }\n`,
    );
    await writeFile(
      join(dir, "jquery-1.10.2.js"),
      `function tick(){ setTimeout(function(){ tick(); }, 2000); }\n`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const item = checklist.items.find((i) => i.criteria[0] === "wcag22:2.2.1");
    expect(item).toBeDefined();
    if (!item) return;
    // At least one candidate (the authored-source one) lacks vendorContext.
    expect(item.candidates.some((c) => c.vendorContext === undefined)).toBe(true);
    // Priority stays high — the actionable authored case is what the
    // agent should budget against.
    expect(item.priority).toBe("high");
  });
});
