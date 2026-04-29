/**
 * Integration invariant:
 * `warningsDetails.scanned_build_artifacts_present` ships the
 * inline top-N `{path, reason}` head-slice at default verbosity on a
 * corpus carrying more than {@link SCANNED_BUILD_ARTIFACTS_TOP_CAP}
 * build-artifact-classified files. The agent uses the inline top-N to
 * dismiss vendor-and-vendor-only scans in one read; the long-tail
 * entries (count > 10) still ride on `meta.scannedBuildArtifacts`
 * (grouped + ungrouped envelope under the existing
 * {@link import("../../src/mcp/meta-array-cap.ts").META_ARRAY_CAP}
 * regime).
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Verbose meta
 * is signal, not clutter" + "Truncated containers must rename or
 * sentinel, not retain" — the warnings payload MUST carry enough
 * triage evidence at default verbosity for the agent to act on the
 * `scanned_build_artifacts_present` code without descending into
 * `meta.scannedBuildArtifacts`. Without the top-N field, an agent
 * branching on the bare `count: 17 + topPath: "..."` could not tell
 * a one-pass dismissal regime ("all entries are vendor distributions")
 * from a mixed regime ("some are real source files mistakenly
 * labeled") in a single read.
 *
 * Pinned invariants on a corpus with > 10 build artifacts:
 *   - `top` has length exactly {@link SCANNED_BUILD_ARTIFACTS_TOP_CAP}.
 *   - `count >= top.length` (count is the full grouped + ungrouped
 *     tally; top is a head-slice of it).
 *   - Each `top[i].reason` is the per-entry classifier verdict —
 *     a {@link BuildArtifactClassification} value lifted verbatim,
 *     never a synthesized token.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCANNED_BUILD_ARTIFACTS_TOP_CAP } from "../../src/mcp/warnings.ts";

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

/**
 * Fixture seeding > {@link SCANNED_BUILD_ARTIFACTS_TOP_CAP} build
 * artifacts so the head-slice cap is observable on the wire. Twelve
 * `.min.css` files (`definite-min-infix` classification, basename
 * `<n>.min.css`) plus an HTML page so the project also has a real
 * input. The basenames stay distinct so the basename-grouping
 * threshold ({@link BASENAME_GROUP_THRESHOLD} = 3) does not collapse
 * them into one row — this keeps every entry visible in the
 * `entries[]` array the warnings-channel head-slice samples from.
 */
async function makeBuildArtifactsCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-int-build-artifacts-top-"));
  await writeFile(
    join(dir, "page.html"),
    `<!DOCTYPE html><html lang="en"><body><main><p>hi</p></main></body></html>`,
  );
  // 12 distinct `.min.css` files — each picks up `definite-min-infix`
  // verdicts deterministically. Distinct basenames keep them all
  // ungrouped so the entries array stays at length 12.
  for (let i = 0; i < 12; i++) {
    await writeFile(
      join(dir, `vendor-${i}.min.css`),
      `.a${i}{color:#fff}.b${i}{color:#000}.c${i}{color:red}.d${i}{color:blue}.e${i}{color:#aaa}\n`,
    );
  }
  return dir;
}

interface ScanProjectResponse {
  readonly warnings?: readonly string[];
  readonly warningsDetails?: {
    readonly scanned_build_artifacts_present?: {
      readonly count?: number;
      readonly topPath?: string;
      readonly top?: readonly { readonly path: string; readonly reason: string }[];
    };
  };
}

const KNOWN_REASONS = new Set([
  "definite-min-infix",
  "definite-sourcemap-paired",
  "definite-vendor-distribution",
  "likely-minified-by-line-stats",
  "likely-hashed-bundle",
  "likely-bundler-output-dir",
  "likely-compiled-tailwind",
  "likely-vendor-distribution",
]);

describe("scanned_build_artifacts_present.top — inline head-slice at default verbosity", () => {
  it("ships up to SCANNED_BUILD_ARTIFACTS_TOP_CAP `{path, reason}` records on a corpus with > 10 build artifacts", async () => {
    const dir = await makeBuildArtifactsCorpus();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const sp = body<ScanProjectResponse>(responses[1]);
    const cv = body<ScanProjectResponse>(responses[2]);
    const cl = body<ScanProjectResponse>(responses[3]);

    for (const [label, resp] of [
      ["scan_project", sp],
      ["coverage", cv],
      ["checklist", cl],
    ] as const) {
      // Sanity: the canonical scan-time code fires on the fixture
      // across every project-rooted tool — the cross-surface count
      // invariant the existing scan-time-warnings parity test pins.
      expect(resp.warnings ?? []).toContain("scanned_build_artifacts_present");
      const payload = resp.warningsDetails?.scanned_build_artifacts_present;
      expect(payload, `${label} payload`).toBeDefined();

      // Headline `count` is the full grouped + ungrouped tally (12 here);
      // `top` is the head-slice capped at SCANNED_BUILD_ARTIFACTS_TOP_CAP.
      const count = payload?.count ?? 0;
      const top = payload?.top ?? [];
      expect(count, `${label} count`).toBeGreaterThanOrEqual(SCANNED_BUILD_ARTIFACTS_TOP_CAP);
      expect(top.length, `${label} top length`).toBe(SCANNED_BUILD_ARTIFACTS_TOP_CAP);
      expect(count, `${label} count >= top.length`).toBeGreaterThanOrEqual(top.length);

      // Honesty bar: every `reason` is a real `BuildArtifactClassification`
      // verdict the classifier emits — no synthesized tokens. The fixture
      // is shaped so every entry resolves to `definite-min-infix`, but the
      // membership check stays inclusive in case a future sibling probe
      // (sourcemap-paired, vendor-distribution) co-fires.
      for (const entry of top) {
        expect(typeof entry.path).toBe("string");
        expect(entry.path.length).toBeGreaterThan(0);
        expect(KNOWN_REASONS.has(entry.reason), `${label} reason ${entry.reason}`).toBe(true);
      }
    }
  });
});
