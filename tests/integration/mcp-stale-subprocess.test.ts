/**
 * Integration test for stale-MCP-subprocess detection across
 * dist-mode and source-mode subprocess topologies.
 *
 * Deterministic reproducer of the silent-miss failure that closes
 * when a mid-session `dist/cli.js` rebuild advances past the
 * running subprocess's baseline: the test spawns a real MCP
 * subprocess, rewrites the tracked file's mtime, and asserts the
 * `stale_mcp_subprocess` warning fires on the next tool call.
 *
 * Two scenarios are covered:
 *   1. Dist mode — subprocess launched via `node <copied-dist-bundle>`
 *      so `import.meta.url` and `process.argv[1]` both resolve to the
 *      copied bundle. Touching the bundle advances the mtime and the
 *      warning must fire. This is the shape Claude Desktop / npx
 *      users will hit after running `npm update @ra11y/core`.
 *   2. Source-like mode — subprocess launched via a wrapper script
 *      that dynamically imports the bundled cli. `process.argv[1]`
 *      (the wrapper) is structurally distinct from the bundled
 *      module's `import.meta.url`. Touching ONLY the wrapper
 *      advances `process.argv[1]`'s mtime while leaving the bundle
 *      untouched — the multi-path fix (track both `import.meta.url`
 *      and `process.argv[1]`) is what makes this fire.
 *
 * Determinism: the test does not depend on wall-clock time advancing —
 * `utimesSync` sets an explicit future mtime. Filesystem granularity
 * is dodged by setting mtime ≥ 5 seconds into the future.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const DIST_DIR = join(PROJECT_ROOT, "dist");
const DIST_BUNDLE = join(DIST_DIR, "cli.js");
const PACKAGE_JSON = join(PROJECT_ROOT, "package.json");

/**
 * Create an isolated copy of the dist tree inside a tmpdir that can
 * run standalone. The bundled `src/version.ts` resolves
 * `../package.json` relative to `import.meta.url`, so the copy must
 * include a sibling `package.json` in the parent of the dist
 * directory. Returns the absolute path to `dist/cli.js` inside the
 * isolated tree.
 */
function isolateDistTree(prefix: string): { root: string; bundlePath: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const distPath = join(root, "dist");
  mkdirSync(distPath, { recursive: true });
  cpSync(DIST_DIR, distPath, { recursive: true });
  copyFileSync(PACKAGE_JSON, join(root, "package.json"));
  return { root, bundlePath: join(distPath, "cli.js") };
}

type JsonRpcResponse = Record<string, unknown>;

function initMsg(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "stale-race-test", version: "1.0" },
    },
  };
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function bodyOf(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

/**
 * Spawn an MCP subprocess, run the scripted pre-touch / post-touch
 * sequence, and return the parsed JSON-RPC response bodies.
 *
 * Exchange shape: initialize + a pre-touch `list_rules` go into
 * stdin up-front, then we sleep long enough for the server startup
 * (which calls `recordSubprocessStart` against the pre-mutation
 * mtime) and the first two dispatches to complete. The caller's
 * `mutateBetweenCalls` runs during that window — it advances the
 * tracked file's mtime. Then a third `list_rules` is written and
 * stdin is closed.
 *
 * Because ra11y's read loop processes each line as it arrives, the
 * mutation lands between dispatches 2 and 3 — the stale-detection
 * probe on response 3 sees the advanced mtime. This gives a
 * deterministic reproducer without the half-duplex stdio pump that
 * Bun.spawn and Node child_process both make awkward to express.
 */
async function runMcpScenario(
  command: string,
  args: readonly string[],
  mutateBetweenCalls: () => void,
): Promise<readonly JsonRpcResponse[]> {
  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });

  const stdin = proc.stdin;
  const firstHalf = `${JSON.stringify(initMsg(1))}\n${JSON.stringify(toolCall(2, "list_rules", {}))}\n`;
  stdin.write(firstHalf);
  stdin.flush?.();

  // Wait long enough for the server startup (which calls
  // `recordSubprocessStart` against the PRE-mutation mtime) to
  // complete and for the server to dispatch and emit responses for
  // requests 1 and 2. 600ms is generous on modern hardware and
  // dodges the 1s filesystem-granularity corner case too.
  await Bun.sleep(600);

  mutateBetweenCalls();

  // Sleep a little more to guarantee the mutation's mtime is strictly
  // greater than any baseline the subprocess may still be recording
  // (belt-and-braces — the +5s stamp in the mutator already dwarfs
  // real-time drift).
  await Bun.sleep(50);

  stdin.write(`${JSON.stringify(toolCall(3, "list_rules", {}))}\n`);
  stdin.end();

  const text = await new Response(proc.stdout).text();
  const errText = await new Response(proc.stderr).text();
  await proc.exited;

  if (process.env["RA11Y_STALE_TEST_DEBUG"] === "1") {
    process.stderr.write(`[stale-test] stdout (${text.length} bytes):\n${text.slice(0, 400)}\n`);
    process.stderr.write(
      `[stale-test] stderr (${errText.length} bytes):\n${errText.slice(0, 400)}\n`,
    );
  }

  const lines = text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  const responses: JsonRpcResponse[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as JsonRpcResponse;
      if (parsed["id"] !== undefined) responses.push(parsed);
    } catch {
      // Ignore non-JSON noise.
    }
  }
  return responses;
}

describe("stale MCP subprocess — dist-bundle mtime advance", () => {
  let workDir: string;
  let bundleCopy: string;

  beforeAll(() => {
    if (!existsSync(DIST_BUNDLE)) {
      throw new Error(
        "dist/cli.js missing — this integration test requires the bundle. " +
          "Run `bun run build` before `bun test`.",
      );
    }
    const isolated = isolateDistTree("ra11y-stale-dist-");
    workDir = isolated.root;
    bundleCopy = isolated.bundlePath;
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("stale_mcp_subprocess fires on the first call after the bundle's mtime advances", async () => {
    const responses = await runMcpScenario("node", [bundleCopy, "--mcp"], () => {
      // Simulate the mid-session rebuild by advancing the bundle's
      // mtime. Use a 5-second jump to dodge any filesystem
      // granularity corners (HFS+ 1s, some ext4 configs 1s).
      const current = statSync(bundleCopy).mtimeMs;
      const future = new Date(current + 5_000);
      utimesSync(bundleCopy, future, future);
      const after = statSync(bundleCopy).mtimeMs;
      expect(after).toBeGreaterThan(current);
    });

    // Request 2 (list_rules BEFORE the mutation) must NOT carry the
    // stale warning — the baseline and the on-disk mtime agree.
    const preResp = responses.find((r) => r["id"] === 2);
    expect(preResp).toBeDefined();
    const preBody = bodyOf(preResp!);
    const preWarnings = Array.isArray(preBody["warnings"])
      ? (preBody["warnings"] as readonly unknown[])
      : [];
    expect(preWarnings).not.toContain("stale_mcp_subprocess");
    expect(preBody["staleSubprocessHint"]).toBeUndefined();

    // Request 3 (list_rules AFTER the mutation) MUST carry the
    // stale warning — this is the field-session regression the
    // fix closes. Without the stale-subprocess detection firing,
    // the response would read identical to the pre-mutation one
    // and an agent running a 90-minute session would never learn
    // the subprocess needs a restart.
    const postResp = responses.find((r) => r["id"] === 3);
    expect(postResp).toBeDefined();
    const postBody = bodyOf(postResp!);
    const postWarnings = Array.isArray(postBody["warnings"])
      ? (postBody["warnings"] as readonly string[])
      : [];
    expect(postWarnings).toContain("stale_mcp_subprocess");
    expect(postBody["staleSubprocessHint"]).toBe(
      "rebuild detected; reconnect the MCP to pick up parser and rule changes",
    );
  }, 60_000);
});

describe("stale MCP subprocess — entry-script is distinct from bundled module", () => {
  // Simulates source-mode: `process.argv[1]` (the wrapper script) is
  // a different file from the bundled module where `import.meta.url`
  // lives. The wrapper delegates to the bundled cli via dynamic
  // import so the bundled code's `import.meta.url` resolves to the
  // bundle file (dist/cli.js inside the isolated tree), but
  // `process.argv[1]` resolves to the wrapper.
  //
  // Touching ONLY the wrapper advances `process.argv[1]`'s mtime
  // while leaving the bundled module untouched — the multi-path
  // fix is what makes the warning fire on this topology. Without
  // tracking `process.argv[1]`, this scenario silently misses
  // (replicates the real source-mode dev workflow).
  let workDir: string;
  let wrapperPath: string;

  beforeAll(() => {
    if (!existsSync(DIST_BUNDLE)) {
      throw new Error(
        "dist/cli.js missing — this integration test requires the bundle. " +
          "Run `bun run build` before `bun test`.",
      );
    }
    const isolated = isolateDistTree("ra11y-stale-wrapper-");
    workDir = isolated.root;
    // Wrapper lives OUTSIDE the dist dir so its path is structurally
    // distinct from anything `import.meta.url` inside the bundle can
    // resolve to. Node sees `wrapper.mjs` as the entry script and
    // `dist/cli.js` as a dynamic import — exactly the `process.argv[1]`
    // vs. `import.meta.url` split the fix addresses.
    wrapperPath = join(workDir, "wrapper.mjs");
    writeFileSync(
      wrapperPath,
      `// Test wrapper — simulates a source-mode dev entry that
// delegates to the bundled CLI. Keeps process.argv[1] (this
// file) distinct from the bundle's import.meta.url.
import "./dist/cli.js";
`,
    );
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("stale_mcp_subprocess fires when only the entry wrapper's mtime advances", async () => {
    const responses = await runMcpScenario("node", [wrapperPath, "--mcp"], () => {
      // Touch ONLY the wrapper, not the bundled module. This is
      // the multi-path invariant: tracking `process.argv[1]` in
      // addition to `import.meta.url` is what makes this fire.
      // Before the fix, this mutation would be invisible to the
      // stale-detection and the warning would never surface.
      const current = statSync(wrapperPath).mtimeMs;
      const future = new Date(current + 5_000);
      utimesSync(wrapperPath, future, future);
    });

    const preResp = responses.find((r) => r["id"] === 2);
    expect(preResp).toBeDefined();
    const preBody = bodyOf(preResp!);
    const preWarnings = Array.isArray(preBody["warnings"])
      ? (preBody["warnings"] as readonly unknown[])
      : [];
    expect(preWarnings).not.toContain("stale_mcp_subprocess");

    const postResp = responses.find((r) => r["id"] === 3);
    expect(postResp).toBeDefined();
    const postBody = bodyOf(postResp!);
    const postWarnings = Array.isArray(postBody["warnings"])
      ? (postBody["warnings"] as readonly string[])
      : [];
    expect(postWarnings).toContain("stale_mcp_subprocess");
  }, 60_000);
});
