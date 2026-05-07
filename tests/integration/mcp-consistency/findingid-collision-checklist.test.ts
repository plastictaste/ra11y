/**
 * findingid-collision-checklist — pins the per-finding addressability
 * invariant for review candidates whose criterion union is identical
 * across two finders firing at the same byte position with distinct
 * `reason` text.
 *
 * Field report: `checklist.items[*].candidates[*].findingId` shipped 7
 * duplicate ids on a vanilla-stack catalog. Same `(rule, file, line,
 * column)` but two distinct `reason` strings — calling
 * `suggest_fix(findingId)` on a colliding id resolves ambiguously, and
 * suppressing on the id silences a sibling reason the agent never read.
 *
 * Per AI-first doctrine "Per-finding identifiers must be addressable,
 * not collision-prone" (`docs/kb/architecture/ai-first-consumer.md`):
 * every `findingId` in a single response must be unique, and the
 * per-call surface must address one emission per id.
 *
 * Closure: include the reason in the `findingId` hash so each emission
 * gets a unique id even when the per-position criteria union is
 * identical across two finders firing at the same byte.
 *
 * Source corpus lives under
 * `tests/fixtures/real-world/findingid-collision-checklist/source/`.
 * Two `<img>` elements (one inside `<a>`, one inside `<button>`)
 * trigger BOTH `review/alt-duplicates-sibling-text` AND
 * `review/redundant-alt-text` at the same byte position. Each finder
 * declares `criterionIds: ["wcag22:1.1.1", "wcag21:1.1.1"]` →
 * identical criteria unions per `(filePath, line, column, reason)`
 * group, but distinct `reason` strings. Pre-fix, both candidates
 * computed `findingId = hash(["wcag21:1.1.1","wcag22:1.1.1"], file,
 * line, column)` → identical id. Post-fix, the reason is folded into
 * the hash so the two emissions ship distinct ids.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURE_DIR = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "real-world",
  "findingid-collision-checklist",
  "source",
);
const FIXTURE_PAGE = join(FIXTURE_DIR, "index.html");

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

interface ChecklistBody {
  readonly items: ReadonlyArray<{
    readonly criteria: readonly string[];
    readonly candidates: ReadonlyArray<{
      readonly findingId: string;
      readonly path: string;
      readonly line: number;
      readonly reason: string;
    }>;
  }>;
}

interface ScanFileBody {
  readonly reviewCandidates?: ReadonlyArray<{
    readonly findingId: string;
    readonly criteria: readonly string[];
    readonly line: number;
    readonly column: number;
    readonly reason: string;
  }>;
}

function describeCollisions(
  entries: ReadonlyArray<{
    readonly findingId: string;
    readonly path?: string;
    readonly line: number;
    readonly reason: string;
  }>,
): string {
  const byId = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byId.get(e.findingId);
    if (list === undefined) byId.set(e.findingId, [e]);
    // biome-ignore lint/suspicious/noExplicitAny: building a transient diagnostic list
    else (list as any).push(e);
  }
  const lines: string[] = [];
  for (const [id, members] of byId) {
    if (members.length < 2) continue;
    const trail = members
      .map(
        (m) =>
          `${m.path ?? "?"}:${m.line} reason="${m.reason.slice(0, 40).replace(/\n/gu, " ")}…"`,
      )
      .join(" | ");
    lines.push(`  - findingId=${id} → ${members.length} entries: ${trail}`);
  }
  return lines.join("\n");
}

describe("MCP invariant: every checklist candidate findingId is unique within a response", () => {
  it("two finders firing at same byte position with distinct reasons get distinct findingIds on checklist", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: FIXTURE_DIR })]);
    const checklistBody = body<ChecklistBody>(responses[1]);

    // Flatten every checklist candidate the response shipped.
    const flat = checklistBody.items.flatMap((it) =>
      it.candidates.map((c) => ({
        findingId: c.findingId,
        path: c.path,
        line: c.line,
        reason: c.reason,
      })),
    );

    // The corpus must produce ≥2 candidates at the same byte position
    // (alt-duplicates-sibling-text + redundant-alt-text on each <img>)
    // — otherwise the test is vacuously passing without exercising
    // the bug.
    const positionGroups = new Map<string, number>();
    for (const c of flat) {
      const k = `${c.path}\x00${c.line}`;
      positionGroups.set(k, (positionGroups.get(k) ?? 0) + 1);
    }
    const collidingPositions = [...positionGroups.values()].filter((n) => n >= 2);
    expect(collidingPositions.length).toBeGreaterThan(0);

    // Per AI-first doctrine "Per-finding identifiers must be
    // addressable, not collision-prone": every findingId in a single
    // response is unique. A duplicate id here means two distinct
    // emissions claim the same address — `suggest_fix(findingId)`
    // would resolve ambiguously, and suppress would silence a sibling
    // reason the agent never read.
    const ids = flat.map((c) => c.findingId);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw new Error(
        `Expected every checklist candidate's findingId to be unique within the response, ` +
          `got ${ids.length} entries collapsing to ${unique.size} ids. Colliding trails:\n` +
          describeCollisions(flat),
      );
    }
  });

  it("two finders firing at same byte position with distinct reasons get distinct findingIds on scan_file", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: FIXTURE_PAGE })]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const candidates = scanFileBody.reviewCandidates ?? [];

    // Same per-position pre-condition as the checklist test — both
    // surfaces must observe ≥2 candidates at the same byte for the
    // uniqueness invariant to be meaningful.
    const positionGroups = new Map<string, number>();
    for (const c of candidates) {
      const k = `${c.line}\x00${c.column}`;
      positionGroups.set(k, (positionGroups.get(k) ?? 0) + 1);
    }
    const collidingPositions = [...positionGroups.values()].filter((n) => n >= 2);
    expect(collidingPositions.length).toBeGreaterThan(0);

    const ids = candidates.map((c) => c.findingId);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw new Error(
        `Expected every scan_file reviewCandidates findingId to be unique within the response, ` +
          `got ${ids.length} entries collapsing to ${unique.size} ids. Colliding trails:\n` +
          describeCollisions(
            candidates.map((c) => ({
              findingId: c.findingId,
              line: c.line,
              reason: c.reason,
            })),
          ),
      );
    }
  });
});
