/**
 * Cross-surface invariant: a bare `<audio>` element fires multiple
 * candidate finders (`review/media-alternatives` for wcag22:1.2.1 +
 * `review/media-variants` for wcag22:1.2.8 / 1.2.9 / 1.4.7) at the
 * same `(file, line, column)`. Each finder writes per-criterion-pair
 * reason text — distinct across the four criteria, because each
 * criterion frames a different verification question (transcript vs.
 * AAA full text alternative vs. live audio-only equivalent vs.
 * background audio level).
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` extension to
 * "Composite headline counts are dishonest" — composite *reason text*
 * is dishonest at the per-finding level too. A single review candidate
 * shipping a `" | "`-joined reason concatenated across N distinct
 * criteria forces the agent to dismiss the union: there is no
 * addressable per-criterion shape, the reason carries one criterion's
 * concern braided with three others, and a `findingId` hashed over the
 * union cannot be suppressed for one criterion alone.
 *
 * Closure: per-finder/per-criterion candidates ship as separate
 * entries on `scan_file.reviewCandidates[]`. Each entry's `criterionId`
 * names one criterion, `criteria` carries that criterion's within-
 * finder cross-standard set (e.g. `[wcag21:1.2.1, wcag22:1.2.1]`),
 * `reason` carries that criterion's framing alone (no `" | "` from a
 * cross-finder fold), and `findingId` is unique per entry so per-
 * criterion suppression / verdict has a stable address.
 *
 * The fixture is a sanitized podcast-player page — a single bare
 * `<audio>` element at a known line — so the four expected criteria
 * fire at the same byte position.
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

interface ScanFileCandidate {
  readonly findingId: string;
  readonly criteria: readonly string[];
  readonly line: number;
  readonly reason: string;
}

interface ScanFileBody {
  readonly reviewCandidates?: readonly ScanFileCandidate[];
}

async function makeBareAudioFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-audio-per-criterion-"));
  const page = join(dir, "podcast.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Podcast</title></head>
<body>
<main>
<h1>Latest Episode</h1>
<audio src="/episodes/ep-42.mp3" controls></audio>
<p>Trailing copy.</p>
</main>
</body>
</html>
`,
  );
  return { dir, page };
}

// The four AA/AAA criteria a bare `<audio>` element fans out to, all at
// the same byte position — the trigger this test pins. (1.2.1 from
// review/media-alternatives; 1.2.8 / 1.2.9 / 1.4.7 from
// review/media-variants. AAA + level-AAA filters are off by default
// so all four reach the response.)
const EXPECTED_CRITERIA: readonly string[] = [
  "wcag22:1.2.1",
  "wcag22:1.2.8",
  "wcag22:1.2.9",
  "wcag22:1.4.7",
];

describe("MCP invariant: bare <audio> ships per-criterion review candidates (no joined-reason composite)", () => {
  it("scan_file.reviewCandidates surfaces one entry per criterion at the audio line, each with its own framing reason", async () => {
    const { page } = await makeBareAudioFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const candidates = scanFile.reviewCandidates ?? [];

    // Each of the four AA/AAA criteria must show up on its own entry,
    // with that criterion's `criterionId` addressable in `criteria[]`.
    for (const id of EXPECTED_CRITERIA) {
      const entry = candidates.find((c) => c.criteria.includes(id));
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      // The entry's `criteria` is the within-finder cross-standard
      // set — for the audio finders that's `[wcag21:<id>, wcag22:<id>]`
      // — and must NOT include the other three criteria's IDs (no
      // cross-finder positional fold).
      const others = EXPECTED_CRITERIA.filter((other) => other !== id);
      for (const otherId of others) {
        expect(entry.criteria).not.toContain(otherId);
      }
    }
  });

  it('no review candidate ships a `" | "`-joined reason on the bare audio fixture', async () => {
    const { page } = await makeBareAudioFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const candidates = scanFile.reviewCandidates ?? [];

    // The composite-reason regression is detectable by the join token
    // landing in any candidate's reason string. Per AI-first doctrine
    // composite reason text across distinct criteria forces the agent
    // to dismiss a union it cannot address per-criterion.
    for (const c of candidates) {
      expect(c.reason).not.toContain(" | ");
    }
  });

  it("each per-criterion entry at the audio line carries a distinct findingId so per-criterion suppression / verdict has a stable address", async () => {
    const { page } = await makeBareAudioFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);
    const candidates = scanFile.reviewCandidates ?? [];

    // Per AI-first doctrine "Per-finding identifiers must be
    // addressable, not collision-prone": every findingId in a single
    // response must be unique to one emission. Pre-fix, four
    // criteria's worth of evidence collapsed to one entry whose
    // findingId addressed the union — suppress one criterion and the
    // sibling three silenced too.
    const audioEntries = candidates.filter((c) =>
      EXPECTED_CRITERIA.some((id) => c.criteria.includes(id)),
    );
    const ids = audioEntries.map((c) => c.findingId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
