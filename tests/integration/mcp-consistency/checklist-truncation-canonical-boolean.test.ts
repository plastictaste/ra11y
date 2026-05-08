/**
 * Truncation-reporter reconciliation invariant — within `checklist`:
 *   when the per-criterion cap clips at least one criterion, the
 *   response carries:
 *     - `truncated: true` (the canonical "this is partial" boolean)
 *     - `pageClipReason: "per_criterion_cap"` (the axis discriminator)
 *     - `warnings: [..., "results_truncated_use_nextcursor"]`
 *     - `warningsDetails.results_truncated_use_nextcursor.seeAlso` ===
 *       `"pageClipReason"` (the cross-link from the warning channel
 *       back to the canonical reporter).
 *
 * Pre-fix observation: `pageClipReason: "per_criterion_cap"` shipped
 * alongside `warnings: ["results_truncated_use_nextcursor"]` while
 * `truncated` was OMITTED from the response keys entirely — three
 * concurrent truncation signals, none of them the canonical boolean.
 * An agent reading top-down had no `truncated: <bool>` to predicate
 * "is this response partial" against, and the warning channel and
 * top-level `pageClipReason` enumerated the truncation event
 * independently with no cross-link, exactly the silent-miss failure
 * mode the AI-first doctrine "Truncation reporters must reconcile
 * across warnings" warns against.
 *
 * Closure path (a) from doctrine: one canonical reporter
 * (`truncated: true`) fires whenever ANY axis clipped (global limit OR
 * per-criterion cap), and the warning's `seeAlso` field cross-links
 * back to `pageClipReason` so an agent following the warning channel
 * finds the canonical axis discriminator without parsing the warning
 * name. `nextOffset` stays gated to the global-limit axis (the resume
 * token for the flat stream); `nextCursor` is the per-criterion-clip
 * resume token. Three signals, one canonical boolean, axis
 * discrimination on `pageClipReason`, cross-link via `seeAlso`.
 *
 * Doctrine reference: docs/kb/architecture/ai-first-consumer.md
 * "Truncation reporters must reconcile across warnings."
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

interface ChecklistResponse {
  readonly truncated?: true;
  readonly pageClipReason?: "end_of_results" | "per_criterion_cap";
  readonly perCriterionClipped?: true;
  readonly nextCursor?: { readonly afterCriterion: string; readonly afterCandidateIndex: number };
  readonly nextOffset?: number;
  readonly warnings?: readonly string[];
  readonly warningsDetails?: Record<string, unknown>;
}

/**
 * Builds a multi-file fixture rich enough to surface ≥2 candidates per
 * criterion on at least one criterion — required so a low
 * `maxCandidatesPerCriterion: 1` will trip the per-criterion cap. The
 * shape mirrors `makeMultiCandidateFixture` in the unit tests so the
 * integration test exercises the same fixture topology end-to-end.
 */
async function makeMultiCandidateFixture(fileCount: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-checklist-trunc-"));
  for (let i = 0; i < fileCount; i++) {
    await writeFile(
      join(dir, `page${i}.html`),
      `<!doctype html><html lang="en"><head><title>x</title></head><body><main><form><input type="password" name="p${i}"></form><img src="x${i}.png"><video src="v${i}.mp4"></video><audio src="a${i}.mp3"></audio></main></body></html>`,
    );
  }
  return dir;
}

describe("checklist truncation-reporter reconciliation", () => {
  // Doctrine reference: docs/kb/architecture/ai-first-consumer.md
  // "Truncation reporters must reconcile across warnings".
  // The per-criterion cap is the regime the backlog item flagged —
  // before closure, `pageClipReason: "per_criterion_cap"` shipped
  // alongside the warning code while `truncated` was omitted entirely.
  it("ships truncated:true + pageClipReason + warning + seeAlso when per-criterion cap clips", async () => {
    const dir = await makeMultiCandidateFixture(5);
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { cwd: dir, maxCandidatesPerCriterion: 1 }),
    ]);
    const response = body<ChecklistResponse>(responses[1]);
    // Canonical boolean fires whenever any axis clipped (per doctrine,
    // closure path (a): one canonical reporter rolls up all axes).
    expect(response.truncated).toBe(true);
    // Axis discriminator names the regime so callers branch on a
    // discriminator, not on response shape.
    expect(response.pageClipReason).toBe("per_criterion_cap");
    // Per-criterion clip flag still fires on its own axis (orthogonal
    // boolean kept for cross-surface readers familiar with the
    // pre-closure surface).
    expect(response.perCriterionClipped).toBe(true);
    // `nextCursor` is the resume token for the per-criterion axis.
    expect(response.nextCursor).toBeDefined();
    // `nextOffset` stays gated to the global-limit axis — it ships
    // only when the flat stream itself was clipped, not when the
    // per-criterion cap fired alone.
    expect(response.nextOffset).toBeUndefined();
    // Warning channel still fires the structured code so existing
    // consumers keep their signal.
    const warnings = response.warnings ?? [];
    expect(warnings).toContain("results_truncated_use_nextcursor");
    // Cross-link from the warning channel to the canonical reporter
    // closes the multi-channel-without-reference dishonesty.
    const detail = response.warningsDetails?.["results_truncated_use_nextcursor"] as
      | { readonly seeAlso?: string }
      | undefined;
    expect(detail).toBeDefined();
    expect(detail?.seeAlso).toBe("pageClipReason");
  });

  // Negative case: when nothing clipped, none of the four signals
  // fire. Pins the present-when-meaningful contract on the canonical
  // boolean (no `truncated: false` sentinel) so absence reads as
  // "this response is whole."
  it("omits truncated/pageClipReason/warning when nothing clipped", async () => {
    const dir = await makeMultiCandidateFixture(2);
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { cwd: dir })]);
    const response = body<ChecklistResponse>(responses[1]);
    expect(response.truncated).toBeUndefined();
    expect(response.pageClipReason).toBeUndefined();
    expect(response.perCriterionClipped).toBeUndefined();
    expect(response.nextCursor).toBeUndefined();
    expect(response.nextOffset).toBeUndefined();
    const warnings = response.warnings ?? [];
    expect(warnings).not.toContain("results_truncated_use_nextcursor");
    expect(response.warningsDetails?.["results_truncated_use_nextcursor"]).toBeUndefined();
  });
});
