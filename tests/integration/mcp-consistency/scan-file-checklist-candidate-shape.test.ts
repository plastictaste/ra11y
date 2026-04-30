/**
 * Cross-surface candidate-shape invariant: the same conceptual review
 * candidate must ship `priority` and `confidence` from the same shared
 * resolver on `scan_file.reviewCandidates[]` and
 * `checklist.items[].candidates[]` (per-item priority on checklist).
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Per-tool review-
 * candidate shape must agree across surfaces": an agent calling
 * `scan_file` first and `checklist` second cannot read different
 * priority / confidence values for the same evidence — the silent-
 * miss failure mode is identical to the cross-surface count invariant
 * but on the per-candidate field-shape axis.
 *
 * Pre-closure, scan_file shipped neither field on its deduped shape
 * (`DedupedReviewCandidate` had no `priority` / `confidence`
 * properties), so an agent reading the scan_file surface saw the
 * fields as missing while the checklist surface populated them with
 * grounded values. Closure threaded the shared
 * `resolvePriorityForCandidate` + `highestCandidateConfidence`
 * helpers through the dedup path so both surfaces compute from the
 * same logic.
 *
 * The fixture: a `<input type="password">` inside a `<form>` triggers
 * the `review/password-inputs` finder for `wcag22:3.3.8` (level AA,
 * confidence "medium"). On the candidate's evidence (no hedging
 * reason text, no `vendorContext`, no `predicateConceded`), the
 * shared resolver returns `priority: "high"` (AA → high base, no
 * downgrade) and `confidence: "medium"` (passed through from the
 * finder).
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

interface ScanFileBody {
  readonly reviewCandidates?: ReadonlyArray<{
    readonly criteria: readonly string[];
    readonly line: number;
    readonly priority?: string;
    readonly confidence?: string;
  }>;
}

interface ChecklistBody {
  readonly items: ReadonlyArray<{
    readonly criterionId: string;
    readonly priority: string;
    readonly confidence: string;
    readonly candidates: ReadonlyArray<{
      readonly path: string;
      readonly line: number;
      readonly confidence: string;
    }>;
  }>;
}

async function makePasswordFormFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-candidate-shape-"));
  const page = join(dir, "login.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Login</title></head>
<body>
<main>
<form>
<label for="u">Username</label>
<input type="text" id="u" name="user">
<label for="p">Password</label>
<input type="password" id="p" name="pw">
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`,
  );
  return { dir, page };
}

describe("MCP invariant: scan_file and checklist agree on candidate priority / confidence", () => {
  it("scan_file.reviewCandidates[] populates priority and confidence with the same values checklist surfaces on the same conceptual candidate", async () => {
    const { dir, page } = await makePasswordFormFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: page }),
      toolCall(3, "checklist", { cwd: dir }),
    ]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    const checklistBody = body<ChecklistBody>(responses[2]);

    const scanCandidates = scanFileBody.reviewCandidates ?? [];
    // The 3.3.8 candidate from `review/password-inputs` is the
    // canonical ground truth for the cross-surface comparison.
    const scanEntry = scanCandidates.find((c) => c.criteria.includes("wcag22:3.3.8"));
    expect(scanEntry).toBeDefined();
    if (scanEntry === undefined) return;

    // Per AI-first doctrine "Ambiguous field shapes are dishonest" /
    // "Per-tool review-candidate shape must agree across surfaces":
    // priority and confidence MUST be present on scan_file's deduped
    // candidate shape — neither absent nor null.
    expect(scanEntry.priority).toBeDefined();
    expect(scanEntry.confidence).toBeDefined();

    const checklistItem = checklistBody.items.find((i) => i.criterionId === "wcag22:3.3.8");
    expect(checklistItem).toBeDefined();
    if (checklistItem === undefined) return;
    // The candidate-level priority on scan_file equals the per-item
    // priority on checklist for the same conceptual candidate. Both
    // resolve from the shared `resolvePriorityForCandidate` helper
    // over identical evidence (level "AA", no hedging, no
    // vendorContext, no predicateConceded).
    expect(scanEntry.priority).toBe(checklistItem.priority);
    // Per-candidate confidence agrees across surfaces. The scan_file
    // entry takes the highest across the deduped union; on this
    // fixture the union is a single password-input candidate, so the
    // value is the finder's `confidence: "medium"`.
    const checklistCandidate = checklistItem.candidates[0];
    expect(checklistCandidate).toBeDefined();
    if (checklistCandidate === undefined) return;
    expect(scanEntry.confidence).toBe(checklistCandidate.confidence);
  });
});
