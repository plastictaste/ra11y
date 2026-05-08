/**
 * Cross-surface invariant: when `media/audio-controls-or-transcript-missing`
 * fires on a bare `<audio>` element, the per-element review-candidate
 * dedup pass elides any review candidate whose `(file, line, criterion)`
 * is already covered by the rule's `satisfies` set. Pre-closure, the
 * Q14 dedup mechanism (added by `filterCandidatesCoveredByFindings` in
 * `src/mcp/review-candidate-dedup.ts`) was demonstrated only on
 * `aria/expanded-on-disclosure` against a `wcag22:4.1.2` candidate; this
 * test pins that the same predicate works for media-element rules so
 * the agent never reads two channels narrating the same element under
 * the same WCAG criterion.
 *
 * Strict per-criterion gate, by design. The Q14 closure dedups only
 * when the candidate's `criterionId` intersects the finding's
 * `criteria` array (sourced from the rule's `satisfies` field per the
 * three-layer model). Cross-criterion candidates — `wcag22:1.2.1`
 * (audio-only prerecorded), `wcag22:1.2.8` (AAA media alternative),
 * `wcag22:1.2.9` (AAA live audio-only), `wcag22:1.4.7` (AAA background
 * audio level) — surface alongside the rule's `wcag22:1.1.1` finding
 * because they ask different (manual) questions about the SAME element.
 * Per `docs/kb/architecture/ai-first-consumer.md` "Surface, don't
 * suppress" the doctrine-correct answer is honest dual-signal when the
 * criteria differ; the inverse ("Surface, don't suppress" inverse) is
 * dedup ONLY when a deterministic rule emission already carries the
 * same criterion's WCAG attribution.
 *
 * The fixture: a bare `<audio>` element with no `controls`, no
 * `<track>` child, and no transcript anchor — the rule's deterministic
 * predicate. The rule satisfies `wcag22:1.1.1` + equivalents; the
 * `review/media-alternatives` and `review/media-variants` finders emit
 * candidates for `wcag22:1.2.1` / `wcag22:1.2.8` / `wcag22:1.2.9` /
 * `wcag22:1.4.7` at the same location. The test asserts:
 *
 *   1. The rule emits ≥1 finding for `media/audio-controls-or-transcript-missing`.
 *   2. No review candidate at the same `(file, line)` claims a criterion
 *      in the rule's `satisfies` set (the dedup invariant — even though
 *      no finder emits 1.1.1 candidates for `<audio>` today, the
 *      mechanism's predicate is the durable contract).
 *   3. Cross-criterion candidates (1.2.x / 1.4.7) DO surface — they
 *      carry honest different-criterion signal that the rule does not
 *      cover.
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

interface ScanFileFinding {
  readonly findingId: string;
  readonly ruleId: string;
  readonly line: number;
  readonly criteria: readonly string[];
}

interface ScanFileCandidate {
  readonly criteria: readonly string[];
  readonly line: number;
}

interface ScanFileBody {
  readonly findings: readonly ScanFileFinding[];
  readonly reviewCandidates?: readonly ScanFileCandidate[];
}

// The rule's `satisfies` set per src/rules/media/audio-controls-or-transcript-missing.ts,
// narrowed to the criteria visible on the default-loaded standards (wcag22).
// The shipped finding's `criteria` array is filtered to only criteria the
// engine's loaded standards declare — the dedup predicate operates on the
// post-filter set, so this test mirrors that. Section 508 / EN 301 549 IDs
// are present in the rule's `satisfies` and contribute to multi-standard
// runs, but on a default scan_file call only the wcag22:1.1.1 row reaches
// the response — that's what the dedup predicate sees.
const RULE_SATISFIES: readonly string[] = ["wcag22:1.1.1"];

async function makeBareAudioFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-audio-no-double-flag-"));
  const page = join(dir, "podcast.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Podcast</title></head>
<body>
<main>
<h1>Latest Episode</h1>
<audio src="/episodes/ep-42.mp3"></audio>
<p>Trailing copy.</p>
</main>
</body>
</html>
`,
  );
  return { dir, page };
}

describe("MCP invariant: <audio> rule emission elides same-criterion review candidates", () => {
  it("rule fires at <audio>'s line AND no review candidate at the same line claims a criterion the rule satisfies", async () => {
    const { page } = await makeBareAudioFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);

    // Leg 1: the rule fires deterministically. The fixture's `<audio>`
    // has no `controls`, no `<track>`, no transcript anchor — the
    // strongest static signal of total inaccessibility under WCAG 1.1.1.
    const audioFinding = scanFile.findings.find(
      (f) => f.ruleId === "media/audio-controls-or-transcript-missing",
    );
    expect(audioFinding).toBeDefined();
    if (audioFinding === undefined) return;

    // The finding's `criteria` array must mirror the rule's `satisfies`
    // set (the dedup predicate's upstream input). If they ever drift,
    // the per-element dedup loses its source-of-truth and same-line
    // 1.1.1 candidates would silently re-surface alongside the rule
    // emission.
    for (const id of RULE_SATISFIES) {
      expect(audioFinding.criteria).toContain(id);
    }

    // Leg 2: the per-element dedup invariant — every candidate at the
    // SAME `(file, line)` as the rule emission must NOT claim any
    // criterion in the rule's `satisfies` set. Today no finder emits
    // 1.1.1 candidates for `<audio>` (1.1.1 finders target `<img>`),
    // so the assertion is trivially true on this fixture; the test is
    // a guard rail against a future finder being added that does emit
    // a 1.1.1 candidate at the same location — which would re-introduce
    // the double-flag the Q14 dedup mechanism closes.
    const sameLine = (scanFile.reviewCandidates ?? []).filter((c) => c.line === audioFinding.line);
    for (const c of sameLine) {
      for (const id of c.criteria) {
        expect(RULE_SATISFIES).not.toContain(id);
      }
    }
  });

  it("cross-criterion review candidates at the same line DO surface — honest dual-signal when criteria differ", async () => {
    // The strict per-criterion gate is the doctrine-correct shape per
    // "Surface, don't suppress" — when the rule's emission carries the
    // 1.1.1 attribution and the candidates carry 1.2.x / 1.4.7
    // attributions, both are honest. Pre-Q14 the agent saw two channels
    // narrating the same element under the same criterion (the
    // suppression-inverse the Q14 dedup closes). Post-Q14 cross-
    // criterion candidates remain, because they ask different (manual)
    // questions: is this prerecorded? live? AAA target? background
    // audio level? Static analysis cannot answer any of those.
    const { page } = await makeBareAudioFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFile = bodyOf<ScanFileBody>(responses[1]);

    const audioFinding = scanFile.findings.find(
      (f) => f.ruleId === "media/audio-controls-or-transcript-missing",
    );
    expect(audioFinding).toBeDefined();
    if (audioFinding === undefined) return;

    // The 1.2.1 candidate from `review/media-alternatives` MUST surface
    // at the audio's line. The criterion is not in the rule's
    // `satisfies` set, so the dedup predicate does not fire — the agent
    // gets a prompt to verify the prerecorded-audio transcript path.
    const sameLine = (scanFile.reviewCandidates ?? []).filter((c) => c.line === audioFinding.line);
    const has121 = sameLine.some((c) => c.criteria.includes("wcag22:1.2.1"));
    expect(has121).toBe(true);

    // Cross-surface signature for the cross-criterion dual-signal:
    // the rule's 1.1.1 finding and the 1.2.1 candidate share `(file,
    // line)` but differ in criterion membership. The agent reads both
    // honestly — the rule names the deterministic 1.1.1 fail, the
    // candidate frames the 1.2.1 verification question.
    const ruleCriteria = new Set(audioFinding.criteria);
    const candidateCriteria = new Set(sameLine.flatMap((c) => c.criteria));
    let intersected = false;
    for (const id of candidateCriteria) {
      if (ruleCriteria.has(id)) {
        intersected = true;
        break;
      }
    }
    expect(intersected).toBe(false);
  });
});
