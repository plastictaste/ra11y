/**
 * Cross-channel invariant on `scan_file.reviewCandidates[]`: when a
 * deduped review candidate ships `vendorPathHint: true` AND
 * `couldBeWrongBecause: ["minified_vendor_no_sourcemap"]`, its
 * `priority` channel must drop to `"low"` to agree with the
 * predicate-strength concession the same candidate already carries.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Reason / priority /
 * fix-description must agree across all three channels": the priority
 * channel cannot ride at `"high"` on a candidate whose own evidence
 * concedes the predicate cannot be resolved without a sourcemap. The
 * three channels (priority, reason, couldBeWrongBecause) are parallel
 * attention-budget signals and must agree at the per-candidate granularity.
 *
 * Pre-closure, an agent calling `scan_file` on a `*.min.js` saw
 * setTimeout / innerHTML candidates ride at `priority: "high"` despite
 * carrying both `vendorPathHint: true` AND
 * `couldBeWrongBecause: ["minified_vendor_no_sourcemap"]` — three
 * channels claiming three different things on identical evidence. The
 * shared `resolvePriorityForCandidate` resolver (in
 * `src/mcp/review-candidate-priority.ts`) drops priority to `"low"` on
 * the same conjunction the `couldBeWrongBecause` stamp fires on; this
 * test pins the cross-channel agreement at the scan_file surface.
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

interface DedupedCandidate {
  readonly priority: "high" | "medium" | "low";
  readonly vendorPathHint?: boolean;
  readonly couldBeWrongBecause?: readonly string[];
  readonly criteria: readonly string[];
}

interface ScanFileResponse {
  readonly reviewCandidates?: readonly DedupedCandidate[];
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

describe("scan_file.reviewCandidates priority drops to 'low' on minified-vendor-no-sourcemap candidates", () => {
  it("ships priority 'low' on every candidate carrying vendorPathHint AND couldBeWrongBecause: ['minified_vendor_no_sourcemap']", async () => {
    // `lib.min.js` matches the minified-shape predicate via the `.min.`
    // infix in the basename — both the build-artifact classifier (in
    // `src/mcp/build-artifacts.ts` `detectMinInfix`) AND the timing
    // finder's `isMinifiedForEnrichment` predicate fire on the same
    // path, populating `vendorPathHint: true` on every emitted candidate
    // AND classifying the file under `scannedBuildArtifacts` — the
    // two-component gate's preconditions both hold.
    //
    // The single-letter identifier `_` as the setTimeout duration is
    // the canonical "cannot resolve without a sourcemap" predicate the
    // gate names; the minifier collapsed a descriptive `pollInterval`
    // to `_`, and an agent reading just this file cannot tell whether
    // the timer is a real session-keepalive (needs user control) or a
    // 5ms debounce. Per AI-first doctrine "Reason / priority /
    // fix-description must agree across all three channels," the
    // priority signal must concede the predicate-strength gap.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-min-vendor-priority-"));
    const filePath = join(dir, "lib.min.js");
    // Multiple setTimeout / setInterval / innerHTML calls within one
    // minified bundle — the canonical scan_file shape the field report
    // observed (15+ review candidates on a single `*.min.js`). All
    // emissions live on the same long line so every one carries
    // `vendorPathHint: true` (via timing-minified's
    // `isMinifiedForEnrichment` predicate) AND fires the build-artifact
    // classifier (via the `.min.` basename infix). The priority
    // resolver's two-component gate must drop EVERY emission to
    // `"low"`, not just the first one.
    await writeFile(
      filePath,
      `var _=5,$=10,a=20;setTimeout(function(){f();},_);setTimeout(function(){g();},$);setInterval(function(){h();},a);document.body.innerHTML='<div>'+x+'</div>';setTimeout(function(){q();},100);\n`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: filePath })]);
    const scanFile = body<ScanFileResponse>(responses[1] as JsonRpcResponse);
    const candidates = scanFile.reviewCandidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);

    // Find every candidate that carries BOTH gate axes — these are the
    // entries the closure governs. The conjunctive predicate matches
    // the doctrine line: either signal alone is insufficient (a hand-
    // readable vendor `jquery-1.10.2.js` rides at `"medium"` via the
    // vendorContext gate; only the co-occurrence earns `"low"`).
    const gated = candidates.filter(
      (c) =>
        c.vendorPathHint === true &&
        c.couldBeWrongBecause !== undefined &&
        c.couldBeWrongBecause.includes("minified_vendor_no_sourcemap"),
    );
    expect(gated.length).toBeGreaterThan(0);

    // Per AI-first doctrine "Reason / priority / fix-description must
    // agree across all three channels": every gated candidate's
    // priority channel must drop to "low" so the three channels
    // (priority, vendorPathHint, couldBeWrongBecause) name the same
    // predicate-strength concession. A `priority: "high"` row on this
    // evidence is the dishonest shape the closure forbids.
    for (const c of gated) {
      expect(c.priority).toBe("low");
    }
  });

  it("keeps priority unchanged on candidates carrying neither signal (negative control)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-authored-priority-"));
    const filePath = join(dir, "src.js");
    // Hand-authored source: no `.min.` infix, lines under the
    // minified-shape threshold, so the timing finder leaves
    // `vendorPathHint` omitted AND the build-artifact classifier
    // does NOT classify the file. Per the conjunctive predicate
    // (both axes required), `couldBeWrongBecause` stays omitted
    // and priority stays at the level-derived base — A/AA → "high".
    // This pins that the closure fires ONLY on the co-occurrence
    // and never on a single signal alone.
    await writeFile(
      filePath,
      `function bootstrap() {\n  setTimeout(function () {\n    tick();\n  }, 5000);\n}\n`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: filePath })]);
    const scanFile = body<ScanFileResponse>(responses[1] as JsonRpcResponse);
    const candidates = scanFile.reviewCandidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    // No candidate should carry the gate's evidence stamp on this
    // authored source (the materializer only stamps when both
    // axes fire).
    for (const c of candidates) {
      const hasStamp =
        c.couldBeWrongBecause !== undefined &&
        c.couldBeWrongBecause.includes("minified_vendor_no_sourcemap");
      expect(hasStamp).toBe(false);
    }
    // At least one candidate rides at the existing base priority —
    // pre-closure scan_file shipped these at `"high"` on A/AA
    // criteria. The negative control proves the closure is
    // conjunctive: priority changes only when BOTH axes co-occur.
    const setTimeoutCandidate = candidates.find((c) => c.criteria.includes("wcag22:2.2.1"));
    expect(setTimeoutCandidate).toBeDefined();
    if (setTimeoutCandidate === undefined) return;
    expect(setTimeoutCandidate.priority).toBe("high");
  });
});
