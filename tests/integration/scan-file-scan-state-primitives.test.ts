/**
 * Q16: scan_file always populates the scan-state scalar primitives
 * (`totalFindings`, `truncated`, `findingsArrayDropped`) with
 * deterministic non-null values on every response — clean inventory,
 * paged, slim envelope. Per
 * `docs/kb/architecture/ai-first-consumer.md`
 * "Ambiguous field shapes are dishonest": a field that ships
 * `undefined` on a clean scan and a populated number on a truncated
 * scan forces the agent to disambiguate "no findings" from "field
 * unavailable" — the silent failure mode is the same as `null`-as-
 * unknown / empty-string-as-empty.
 *
 * Three primitives the closure pins, all read off the wire:
 *
 *   - `totalFindings: number`     — `0` on a clean inventory,
 *                                   `<count>` when paged or slim.
 *   - `truncated: boolean`        — `false` on a clean inventory,
 *                                   `true` when paged or slim.
 *   - `findingsArrayDropped: bool`— `false` whenever `findings[]`
 *                                   is on the wire, `true` only when
 *                                   the slim guard dropped it.
 *
 * The test exercises a clean fixture under two shapes:
 *   1. zero findings (a known-good HTML fixture);
 *   2. a non-empty inventory under the default page cap.
 *
 * Both must ship the primitives as primitives — never `undefined`,
 * never `null`. Paging and slim-envelope shapes are pinned by their
 * own tests (`scan-file-fix-descriptions-paged.test.ts`); this test
 * is purely the under-cap shape contract.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { posixJoin } from "../helpers/path.ts";

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

function body(resp: JsonRpcResponse): Record<string, unknown> {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("scan_file scan-state primitives are always non-null", () => {
  // Clean fixture: every variant in tests/fixtures/good/ is an
  // intentional zero-findings input the rule suite was built to be
  // silent on. Picking a representative file keeps the test stable
  // across rule additions; the doctrine is shape-only, not finding-
  // count-dependent.
  const cleanFixture = posixJoin(
    PROJECT_ROOT,
    "tests/fixtures/good/aria-labelledby-target-exists/labelledby-resolves.html",
  );

  it("ships `totalFindings: number` on a clean scan (never undefined / null)", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: cleanFixture }),
    ]);
    const b = body(responses[1]);
    // Doctrine: present-with-zero is the honest "ran-and-was-clean"
    // shape; an absent field reads back as `undefined` / `null` and
    // collides with the "tool never ran" interpretation.
    expect(typeof b["totalFindings"]).toBe("number");
    expect(b["totalFindings"]).not.toBeNull();
  });

  it("ships `truncated: false` (boolean) on a clean scan (never undefined / null)", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: cleanFixture }),
    ]);
    const b = body(responses[1]);
    expect(typeof b["truncated"]).toBe("boolean");
    expect(b["truncated"]).toBe(false);
  });

  it("ships `findingsArrayDropped: false` (boolean) on a clean scan (never undefined / null)", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: cleanFixture }),
    ]);
    const b = body(responses[1]);
    expect(typeof b["findingsArrayDropped"]).toBe("boolean");
    expect(b["findingsArrayDropped"]).toBe(false);
  });

  it("ships `totalFindings === findings.length` on a non-truncated response", async () => {
    // A fixture that produces at least one finding so the test
    // exercises the non-zero branch — `bad/` fixtures are authored to
    // surface specific rule emissions. `findings.length` should equal
    // `totalFindings` whenever the response is not truncated.
    const dirtyFixture = posixJoin(
      PROJECT_ROOT,
      "tests/fixtures/bad/alt-text-missing/img-no-alt.html",
    );
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: dirtyFixture }),
    ]);
    const b = body(responses[1]);
    const findings = b["findings"];
    expect(Array.isArray(findings)).toBe(true);
    const arr = findings as readonly unknown[];
    // The under-cap path: `truncated: false`, `totalFindings`
    // matches the inventory length exactly.
    expect(b["truncated"]).toBe(false);
    expect(b["findingsArrayDropped"]).toBe(false);
    expect(b["totalFindings"]).toBe(arr.length);
  });
});
