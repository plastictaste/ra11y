/**
 * Cross-channel invariant: a checklist item's `priority` must not
 * contradict the `confidence` framing its candidates ship.
 *
 * Per docs/kb/architecture/ai-first-consumer.md "Reason / priority /
 * fix-description must agree across all three channels", a candidate
 * whose finder reports `confidence: "low"` (heuristic match on narrow
 * evidence — text-regex, className convention, structural proxy per
 * the {@link ReviewConfidence} contract) cannot ride at `priority:
 * "high"` on an A/AA criterion. The confidence channel is the
 * parallel signal naming "static evidence is weak"; the priority
 * channel must agree.
 *
 * Without this gate, a heterogeneous corpus where most criteria are
 * A/AA reports uniform `priority: "high"` even when individual items
 * carry `confidence: "low"`, denying the agent the ranking signal
 * the priority field exists to provide. The downgrade is
 * all-or-nothing (mirrors the hedging / vendorContext /
 * predicateConceded gates): a single `"medium"` / `"high"` sibling
 * keeps the item at `"high"` so the agent doesn't miss the
 * actionable case among the low-signal siblings.
 *
 * Fixture: WCAG 1.3.3 (Level A) flagged by the
 * `review/sensory-characteristics` finder, which emits at
 * `confidence: "low"` (regex on visible text — the finder's
 * docstring notes it's "biased toward false positives" and is "a
 * prompt to verify, not evidence of a failure"). The un-downgraded
 * priority would be `"high"` on a Level A criterion; the
 * confidence-aware downgrade must drop it to `"medium"`.
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
  readonly confidence: "high" | "medium" | "low";
}

interface ChecklistItem {
  readonly criteria: readonly string[];
  readonly priority: "high" | "medium" | "low";
  readonly confidence: "high" | "medium" | "low";
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

describe("checklist priority must not contradict confidence on candidates", () => {
  it("downgrades wcag22:1.3.3 priority when every candidate ships confidence: low", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-low-confidence-priority-"));
    // Sensory-characteristics finder fires at `confidence: "low"` on
    // visible-text regex matches — "click the red button" carries an
    // explicit color identifier; "tap below to continue" pairs a
    // pointing verb with a locative. WCAG 1.3.3 is Level A, so the
    // un-downgraded priority would be "high"; the confidence-aware
    // downgrade must drop it to "medium" so the budget signal matches
    // the framing the finder already concedes.
    await writeFile(
      join(dir, "index.html"),
      `<html><body>
         <p>Click the red button to proceed.</p>
         <p>Tap the green button above to confirm.</p>
       </body></html>`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const item = checklist.items.find((i) => i.criteria[0] === "wcag22:1.3.3");
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.candidates.length).toBeGreaterThan(0);
    // Every candidate ships confidence: low.
    expect(item.candidates.every((c) => c.confidence === "low")).toBe(true);
    // Priority downgrade kicks in — the confidence channel concedes
    // weak evidence, the priority channel must agree.
    expect(item.priority).not.toBe("high");
    expect(["medium", "low"]).toContain(item.priority);
  });

  it("on a heterogeneous corpus, priority distribution is non-uniform across grounded items", async () => {
    // Q13 closure invariant: when multiple criteria are grounded with
    // categorically different evidence quality, the checklist's
    // `priority` field must actually rank them. Pre-fix: 10 items
    // shipped uniform `priority: "high"` even when their candidates
    // rode at `confidence: "low"`. Post-fix: items whose candidates
    // unanimously concede weak evidence (low confidence, hedging
    // reason, vendor context, predicate conceded) drop to "medium",
    // while items with grounded medium/high-confidence candidates stay
    // "high".
    //
    // Fixture mixes:
    //   - low-confidence sensory text (1.3.3) → expect medium
    //   - hedging multiple-ways on a single-page file (2.4.5) → expect medium
    //   - password input (3.3.8 password-inputs finder, medium
    //     confidence, no concessions) → expect high
    const dir = await mkdtemp(join(tmpdir(), "ra11y-heterogeneous-priority-"));
    await writeFile(
      join(dir, "index.html"),
      `<!doctype html>
<html lang="en">
<head><title>Login</title></head>
<body>
<main>
<p>Click the red button to proceed.</p>
<form>
<label for="u">Username</label>
<input type="text" id="u" name="user">
<label for="p">Password</label>
<input type="password" id="p" name="pw">
<button type="submit">Sign in</button>
</form>
<a href="#top">Top</a>
</main>
</body>
</html>
`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);

    // Walk grounded items (those with at least one candidate). Pre-fix
    // every grounded item carried priority: "high"; post-fix the
    // distribution must include at least one non-"high" item driven by
    // the candidate-evidence channels (low confidence / hedging /
    // vendor / predicate-conceded). The exact set depends on the
    // finders that fire on this fixture; the invariant is "ranking
    // signal exists," not a fixed set of criterion IDs.
    const grounded = checklist.items.filter((i) => i.candidates.length > 0);
    expect(grounded.length).toBeGreaterThan(1);
    const priorities = new Set(grounded.map((i) => i.priority));
    // Non-uniform distribution: more than one priority level appears
    // across grounded items. This is the load-bearing claim of the
    // priority channel.
    expect(priorities.size).toBeGreaterThan(1);
  });
});
