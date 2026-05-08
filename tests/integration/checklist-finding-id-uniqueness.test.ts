/**
 * Cross-surface invariant: every `findingId` in a single checklist
 * response is unique.
 *
 * The canonical regression: a single finder declaring multiple
 * criterion IDs (e.g. `review/media-alternatives` declaring
 * `wcag22:1.2.1` + `wcag22:1.2.3` + `wcag22:1.2.5`) emits one
 * candidate per criterion at the same `(file, line, column, reason)`.
 * On `checklist`, the per-criterion items each ship a candidate at
 * that location — pre-closure they all hashed the cross-criterion
 * union into a SHARED `findingId`, so the response contained N
 * candidate rows but only 1 unique id at that position. An agent
 * dispatching `suggest_fix(findingId)` resolved ambiguously, and an
 * agent suppressing on the id silenced sibling rows it never read.
 *
 * Per AI-first doctrine
 * (`docs/kb/architecture/ai-first-consumer.md` "Per-finding
 * identifiers must be addressable, not collision-prone"): every
 * `findingId` in a single response must be unique. Cross-surface
 * group identity (the candidate at the same conceptual position
 * across `scan_file`, `scan_project.reviewCandidates`, and
 * `checklist`) moves to a sibling `findingGroupId` field — same
 * value on every surface that ships the conceptual candidate.
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

interface ChecklistCandidate {
  readonly findingId: string;
  readonly findingGroupId?: string;
  readonly path: string;
  readonly line: number;
}

interface ChecklistBody {
  readonly items: ReadonlyArray<{
    readonly criteria: readonly string[];
    readonly candidates: readonly ChecklistCandidate[];
  }>;
}

async function makeVideoPageFixture(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-checklist-finding-id-"));
  // A `<video>` element triggers `review/media-alternatives` to emit
  // one candidate per criterion across `wcag22:1.2.1`, `wcag22:1.2.3`,
  // `wcag22:1.2.5` (plus the wcag21 mirrors) — six candidates at the
  // same `(file, line, column, reason)` tuple. Pre-closure all six
  // checklist per-item candidates hashed the cross-criterion union into
  // a single shared `findingId`; the test below pins that they now
  // address distinct ids per (criterion, position).
  await writeFile(
    join(dir, "page.html"),
    `<!doctype html>
<html lang="en">
<head><title>Lessons</title></head>
<body>
<main>
<h1>Lessons</h1>
<video src="lesson.mp4" controls></video>
</main>
</body>
</html>
`,
  );
  return { dir };
}

describe("checklist findingId — per-emission uniqueness invariant", () => {
  it("a single finder declaring multiple criterion IDs ships distinct findingIds across per-item candidates", async () => {
    const { dir } = await makeVideoPageFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklistBody = body<ChecklistBody>(responses[1]);

    // Collect every per-item candidate findingId across the entire
    // checklist response. The 1.2.1 / 1.2.3 / 1.2.5 items each surface
    // a candidate at the same `(file, line, column, reason)` for the
    // `<video>` element — six rows pre-closure, all sharing one id.
    const ids: string[] = [];
    for (const item of checklistBody.items) {
      for (const c of item.candidates) {
        ids.push(c.findingId);
      }
    }
    expect(ids.length).toBeGreaterThan(0);
    // Per AI-first doctrine: every `findingId` in a single response
    // must be unique. Pre-closure six candidates collapsed to one id;
    // post-closure each per-(criterion, position) row carries its own
    // address.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("findingGroupId stays shared across per-item candidates so an agent can dedup-walk the conceptual group", async () => {
    const { dir } = await makeVideoPageFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklistBody = body<ChecklistBody>(responses[1]);

    // The 1.2.1 / 1.2.3 / 1.2.5 items each carry a candidate at the
    // same conceptual position. Their `findingId`s must be distinct
    // (per the previous test) but their `findingGroupId`s must agree —
    // so an agent walking the cross-item group reads one stable token
    // identifying the conceptual emission, separate from the per-row
    // unique address.
    const a = checklistBody.items.find((i) => i.criteria[0] === "wcag22:1.2.1");
    const b = checklistBody.items.find((i) => i.criteria[0] === "wcag22:1.2.3");
    const c = checklistBody.items.find((i) => i.criteria[0] === "wcag22:1.2.5");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    if (a === undefined || b === undefined || c === undefined) return;
    const aGid = a.candidates[0]?.findingGroupId;
    const bGid = b.candidates[0]?.findingGroupId;
    const cGid = c.candidates[0]?.findingGroupId;
    expect(aGid).toBeDefined();
    expect(bGid).toBeDefined();
    expect(cGid).toBeDefined();
    expect(aGid).toBe(bGid);
    expect(bGid).toBe(cGid);
  });
});
