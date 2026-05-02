/**
 * Cross-surface candidate-shape contract: the per-criterion shared-
 * reason hoist (`reviewCandidatePrompts: Record<criterionId, {
 * genericReason: string }>`) must surface on every review-candidate-
 * bearing tool with the same shape and semantics.
 *
 * Background — six `<audio>` elements emit candidates under
 * `wcag22:1.2.1` (and `wcag21:1.2.1`) with byte-identical reason text
 * "audio element -- verify transcript is provided". Pre-hoist the
 * agent saw 6 rows of identical prose × 2 criteria = 12 emissions of
 * the same reason. Per `docs/kb/architecture/ai-first-consumer.md`
 * "Sibling fields naming the same concept must use one shape" the
 * duplication is itself the failure mode. The hoist lifts the shared
 * form to a top-level prompts-style map agents read once.
 *
 * The contract this test pins:
 *   1. `scan_project.reviewCandidatePrompts` — present when scan_project
 *      ships review candidates (the no-violations / manual-only path)
 *      and the candidates' reasons converge per-criterion.
 *   2. `scan_file.reviewCandidatePrompts` — same shape, same name,
 *      computed from the same predicate.
 *   3. `checklist.reviewCandidatePrompts` — same shape.
 *   4. `review_candidates.prompts[criterionId].genericReason` — the
 *      existing top-level `prompts[criterionId]` extends with the
 *      verbatim shared reason alongside `text` (the WCAG review
 *      prompt) and `finderId`.
 *
 * Per-candidate `reason` stays populated unchanged on every surface;
 * the hoist is purely additive so the per-row addressability and the
 * cross-surface candidate-shape contract are preserved.
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

function bodyOf<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

interface PromptEntry {
  readonly genericReason: string;
}

interface ReviewPromptsBody {
  readonly reviewCandidatePrompts?: Record<string, PromptEntry>;
}

interface ReviewCandidatesBody {
  readonly prompts?: Record<
    string,
    { readonly text: string; readonly finderId: string; readonly genericReason?: string }
  >;
  readonly candidates: readonly {
    readonly criterionId: string;
    readonly criteria?: readonly string[];
    readonly reason: string;
  }[];
}

/**
 * A page with six `<audio>` elements that share byte-identical reason
 * text. The `review/media-alternatives` finder emits one candidate
 * per element under `wcag22:1.2.1` + `wcag21:1.2.1` (audio-only
 * scope; 1.2.3 / 1.2.5 do not apply per the synchronized-media
 * exemption). Reason text per emission:
 * "audio element -- verify transcript is provided".
 */
async function makeFixture(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-review-prompts-"));
  const file = join(dir, "sound-board.html");
  // The `<meta charset>` and `<html lang>` carry through the
  // `document/charset-first-1024-bytes` and `html/lang-attribute`
  // gates — without them the scan_project response carries
  // automated findings and the inline-review-candidates path
  // (the surface this test exercises) is suppressed by design
  // (the agent has file:line pointers from the findings already
  // and can call `checklist` for the manual half).
  await writeFile(
    file,
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sound Board</title></head>
<body>
<main>
<h1>Sound Board</h1>
<audio src="/snd/a.mp3" controls></audio>
<audio src="/snd/b.mp3" controls></audio>
<audio src="/snd/c.mp3" controls></audio>
<audio src="/snd/d.mp3" controls></audio>
<audio src="/snd/e.mp3" controls></audio>
<audio src="/snd/f.mp3" controls></audio>
</main>
</body>
</html>
`,
  );
  return { dir, file };
}

const SHARED_AUDIO_REASON = "audio element -- verify transcript is provided";

describe("reviewCandidatePrompts: cross-surface", () => {
  it("review_candidates.prompts[criterionId].genericReason surfaces the shared reason alongside .text", async () => {
    const { dir } = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "review_candidates", { paths: [dir], level: "AAA" }),
    ]);
    const body = bodyOf<ReviewCandidatesBody>(responses[1]);
    const prompts = body.prompts ?? {};
    // Both wcag22:1.2.1 and the wcag21:1.2.1 sibling must carry the
    // genericReason hoist — every emission for those criteria shared
    // the audio-element reason text.
    expect(prompts["wcag22:1.2.1"]).toBeDefined();
    expect(prompts["wcag22:1.2.1"]?.genericReason).toBe(SHARED_AUDIO_REASON);
    expect(prompts["wcag21:1.2.1"]).toBeDefined();
    expect(prompts["wcag21:1.2.1"]?.genericReason).toBe(SHARED_AUDIO_REASON);
    // The existing `text` (WCAG review prompt) channel stays
    // populated — the hoist is additive, not a replacement.
    expect(typeof prompts["wcag22:1.2.1"]?.text).toBe("string");
    expect(prompts["wcag22:1.2.1"]?.text.length ?? 0).toBeGreaterThan(0);
    // Per-candidate `reason` stays populated on every row — the
    // shape contract is preserved. Narrow to candidates whose
    // criteria carry wcag22:1.2.1 (the media-alternatives fan)
    // because media-variants also emits "audio element ..." reasons
    // for AAA criteria 1.2.8 / 1.2.9 / 1.4.7 with different prose.
    const audioRows = body.candidates.filter((c) => {
      const ids = c.criteria ?? [c.criterionId];
      return ids.includes("wcag22:1.2.1");
    });
    expect(audioRows.length).toBeGreaterThan(0);
    for (const row of audioRows) {
      expect(row.reason).toBe(SHARED_AUDIO_REASON);
    }
  });

  it("checklist.reviewCandidatePrompts emits the same hoist on the same input", async () => {
    const { dir } = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "checklist", { paths: [dir], level: "AAA" }),
    ]);
    const body = bodyOf<ReviewPromptsBody>(responses[1]);
    const prompts = body.reviewCandidatePrompts ?? {};
    // Checklist's prompts are restricted to the enabled standards'
    // manual criteria (`needsReview` items keyed off the standard
    // session enabled-set, default `wcag22`). The wcag21 sibling
    // emits per the finder's full criterionIds list but doesn't
    // ride through to the checklist surface as a separate item.
    expect(prompts["wcag22:1.2.1"]).toBeDefined();
    expect(prompts["wcag22:1.2.1"]?.genericReason).toBe(SHARED_AUDIO_REASON);
  });

  it("scan_file.reviewCandidatePrompts surfaces the hoist on the deduped per-position fold", async () => {
    const { file } = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { path: file, level: "AAA" }),
    ]);
    const body = bodyOf<ReviewPromptsBody>(responses[1]);
    const prompts = body.reviewCandidatePrompts ?? {};
    // scan_file's deduped shape folds wcag22:1.2.1 + wcag21:1.2.1
    // into one row with `criteria: [wcag21:1.2.1, wcag22:1.2.1]`. The
    // prompts map fans the hoist back per-criterion so every
    // criterion in the union resolves on the agent's single lookup.
    expect(prompts["wcag22:1.2.1"]).toBeDefined();
    expect(prompts["wcag22:1.2.1"]?.genericReason).toBe(SHARED_AUDIO_REASON);
    expect(prompts["wcag21:1.2.1"]).toBeDefined();
    expect(prompts["wcag21:1.2.1"]?.genericReason).toBe(SHARED_AUDIO_REASON);
  });

  it("scan_project.reviewCandidatePrompts surfaces the hoist when the manual-only path emits inline candidates", async () => {
    const { dir } = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, level: "AAA" }),
    ]);
    const body = bodyOf<ReviewPromptsBody>(responses[1]);
    const prompts = body.reviewCandidatePrompts ?? {};
    // When scan_project ships inline `reviewCandidates` it ships the
    // matching prompts map; when no automated findings exist on this
    // synthetic fixture (six audios with no other rule fires), the
    // inline-review-candidates path activates and the hoist surfaces.
    // The map is restricted to enabled-standard manual criteria
    // (default `wcag22` only) — wcag21 emits at the finder layer but
    // doesn't ride through to the inline surface as a separate slot.
    expect(prompts["wcag22:1.2.1"]).toBeDefined();
    expect(prompts["wcag22:1.2.1"]?.genericReason).toBe(SHARED_AUDIO_REASON);
  });
});
