/**
 * Cross-channel invariant: a checklist item's `priority` must not
 * contradict the `predicateConceded` framing its candidates ship.
 *
 * Per docs/kb/architecture/ai-first-consumer.md "Reason / priority /
 * fix-description must agree across all three channels", a candidate
 * whose own static evidence (alt text, class, src filename) names the
 * WCAG 1.4.5 logotype exemption carries a `predicateConceded:
 * { evidence: "alt=\"Acme logo\"" }` payload. The framing concedes
 * the predicate the criterion checks may already be satisfied by
 * spec exemption — the candidate is still surfaced (per AI-first
 * doctrine "Surface, don't suppress") so the agent can verify the
 * dismissal in one read, but the priority signal must agree with the
 * framing.
 *
 * 1.4.5 is Level AA, so the un-downgraded priority would be "high";
 * the predicate-conceded-aware downgrade must drop it to "medium".
 *
 * The AAA "no exception" variant (1.4.9) does NOT carry the logotype
 * exemption, so the same image evidence ships with no
 * predicateConceded and the AAA item priority does not downgrade on
 * this signal.
 *
 * Earlier revisions of `predicateConceded` shipped a discriminated
 * `signal: { kind: "logotype-pattern" }` token alongside the
 * evidence. The token was removed per "Heuristic-mislabeled meta
 * sub-fields are dishonest" — the deterministic-sounding kind label
 * decided the carve-out from a single attribute token; the verbatim
 * evidence now surfaces in the candidate's `reason` text and on
 * `predicateConceded.evidence` only.
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

interface PredicateConcededPayload {
  readonly evidence: string;
}

interface ChecklistCandidate {
  readonly reason: string;
  readonly predicateConceded?: PredicateConcededPayload;
}

interface ChecklistItem {
  readonly criterionId: string;
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

describe("checklist priority must not contradict predicateConceded on candidates", () => {
  it("downgrades wcag22:1.4.5 priority when every candidate ships a predicateConceded payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-predicate-conceded-1-4-5-"));
    // Two img elements whose evidence concedes the WCAG 1.4.5 logotype
    // exemption — alt text contains "logo" / "brand". The candidate
    // still surfaces; the predicateConceded payload lets the priority
    // surface drop to "medium" so the budget signal matches the
    // framing.
    await writeFile(
      join(dir, "index.html"),
      `<html><body>
         <a href="/"><img src="/header.png" alt="Acme logo"></a>
         <a href="/about"><img src="/about-banner.png" alt="Acme brand"></a>
       </body></html>`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const item = checklist.items.find((i) => i.criterionId === "wcag22:1.4.5");
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.candidates.length).toBeGreaterThan(0);
    expect(item.candidates.every((c) => c.predicateConceded !== undefined)).toBe(true);
    // Verbatim evidence is surfaced both in the structured payload and
    // in the candidate's `reason` text — the agent reads the reason
    // and decides; no deterministic `signal.kind` discriminator
    // pre-decides the carve-out shape.
    expect(item.candidates.every((c) => (c.predicateConceded?.evidence ?? "").length > 0)).toBe(
      true,
    );
    expect(
      item.candidates.every((c) =>
        c.reason.includes("verify whether this is the textual logotype exempt under SC 1.4.5"),
      ),
    ).toBe(true);
    // Priority downgrade kicks in.
    expect(item.priority).not.toBe("high");
    expect(["medium", "low"]).toContain(item.priority);
  });

  it("does NOT propagate predicateConceded to the AAA 1.4.9 variant — logos still apply at AAA", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-predicate-conceded-1-4-9-"));
    // Same evidence as above — but the AAA "no exception" variant
    // does not exempt logos, so the priority-honesty signal must not
    // ship on that criterion. The agent reading the AAA item sees no
    // predicateConceded and budgets against the higher priority that
    // a non-conceded predicate deserves.
    await writeFile(
      join(dir, "index.html"),
      `<html><body>
         <a href="/"><img src="/header.png" alt="Acme logo"></a>
       </body></html>`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const aaa = checklist.items.find((i) => i.criterionId === "wcag22:1.4.9");
    if (aaa) {
      expect(aaa.candidates.every((c) => c.predicateConceded === undefined)).toBe(true);
    }
  });
});
