/**
 * Cross-surface count invariant — within `checklist`:
 *   `items.length === summary.actionable.criteria`
 *   OR (`truncated: true` AND a structured warning code names the elision).
 *
 * Pre-fix observation: a fixture surfacing partial-automatable criteria
 * (`wcag22:1.1.1` redundant-alt-text, `wcag22:2.4.3` focus-order, etc.)
 * via review finders left `summary.actionable.criteria: N` while
 * `items.length: M` shipped only the metadata-manual subset (M < N) with
 * no `truncated` flag. The headline counted partial criteria — per the
 * shared `tallyManualCriteriaFromCoverage` helper which by Q13 doctrine
 * counts every distinct criterion ID across shipped candidates regardless
 * of metadata-manual classification — but `bucketChecklistItems` only
 * iterated `coverage[].manualCriteria` (the metadata-manual + not-fired
 * subset), silently eliding partial-criterion items.
 *
 * Closure: `bucketChecklistItems` now also emits items for partial-
 * automatable criteria with shipped candidates so the displayed list
 * matches the counted headline. This test pins the agreement on a fixture
 * that surfaces both a metadata-manual criterion (`wcag22:3.3.8`) AND a
 * partial-automatable criterion (`wcag22:1.1.1` via redundant alt-text)
 * so a regression in either path widens the gap and trips the assertion.
 *
 * Doctrine reference: docs/kb/architecture/ai-first-consumer.md
 * "Cross-surface count invariant" + "One tool call should answer
 * 'what next?'"
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

interface ChecklistItem {
  readonly criterionId: string;
  readonly candidates: readonly unknown[];
}

interface ChecklistBody {
  readonly summary: {
    readonly actionable: {
      readonly criteria: number;
      readonly candidatesUncapped: number;
      readonly candidatesReturned: number;
    };
    readonly untargetedCriteria: number;
  };
  readonly items: readonly ChecklistItem[];
  readonly truncated?: true;
  readonly warnings?: readonly string[];
}

/**
 * Builds a fixture exercising both criterion classifications:
 *   - `wcag22:1.1.1` (partial-automatable) via `review/redundant-alt-text`
 *     — the `<img>` whose alt text echoes the adjacent `<span>` label.
 *   - `wcag22:3.3.8` (metadata-manual) via `review/password-inputs`
 *     — every `<input type="password">`.
 *
 * Pre-fix, `summary.actionable.criteria: 2` but `items.length: 1` (only
 * the manual 3.3.8 entry materialized; the partial 1.1.1 was elided).
 * After the fix items[] carries both, satisfying the invariant.
 */
async function makeMixedCriteriaFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-checklist-items-len-"));
  const page = join(dir, "form.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Form</title></head>
<body>
<main>
<p>
<img src="/icon.png" alt="settings">
<span>settings</span>
</p>
<form>
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

describe("checklist invariant: items.length agrees with summary.actionable.criteria", () => {
  it("items[] surfaces every criterion the headline counts (manual + partial-automatable) on a mixed fixture", async () => {
    const { dir } = await makeMixedCriteriaFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const checklistBody = body<ChecklistBody>(responses[1]);
    const itemsLen = checklistBody.items.length;
    const headline = checklistBody.summary.actionable.criteria;
    // Sanity: the fixture is shaped so both finders fire — without
    // candidates from at least two distinct criteria the parity test
    // would pass vacuously.
    expect(headline).toBeGreaterThanOrEqual(2);
    // The load-bearing invariant: either the displayed list matches the
    // counted headline, OR a `truncated: true` flag with a structured
    // warning code names the elision. Per AI-first doctrine
    // "Cross-surface count invariant" + "Truncated containers must
    // rename or sentinel."
    if (checklistBody.truncated === true) {
      const warnings = checklistBody.warnings ?? [];
      const namesElision = warnings.some(
        (w) =>
          w === "results_truncated_use_nextcursor" ||
          w === "response_meta_truncated" ||
          w === "response_dropped_files_oversize",
      );
      expect(namesElision).toBe(true);
      return;
    }
    expect(itemsLen).toBe(headline);
    // Cross-check: the partial-automatable criterion must materialize
    // as an item — pre-fix this was elided.
    const itemCriteria = new Set(checklistBody.items.map((i) => i.criterionId));
    expect(itemCriteria.has("wcag22:1.1.1")).toBe(true);
    expect(itemCriteria.has("wcag22:3.3.8")).toBe(true);
  });
});
