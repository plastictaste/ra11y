/**
 * Integration regression guard for.
 *
 * closed the original three-field
 * over-emission (`configSource: null` + `configSearchedFrom: <cwd>` +
 * `configNote: "No ra11y.config found …"`) by:
 *
 *   - dropping `configSearchedFrom` entirely from `scan` and `scan_project`
 *     (the value always equaled an input the agent already had —
 *     caller-supplied `cwd` for `scan`, the resolved `root` already
 *     emitted under `scanned.root` for `scan_project`),
 *   - keeping `configSearchedFrom` on `scan_file` ONLY when the
 *     loader's walk-up base was DERIVED (`dirname(absFilePath)`)
 *     rather than caller-supplied (the only case the agent can't read
 *     off the response otherwise), and
 *   - dropping `configNote` boilerplate everywhere — the
 *     `no_config_found` warning is the canonical "no config was loaded"
 *     signal.
 *
 * This file pins the present-when-meaningful contract on every MCP
 * scan-family handler so a future change adding back a `cwd`-echoing
 * `configSearchedFrom` (or a `configNote` boilerplate) on the wire
 * fails CI immediately, regardless of which tool surface introduced it.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md
 *   "Verbose meta is signal, not clutter — `configSearchedFrom` is
 *    present-when-meaningful — omitted when it would just echo the
 *    caller's `cwd` or a `scanned.root` already in the response."
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const BAD_ALT_DIR = join(PROJECT_ROOT, "tests", "fixtures", "bad", "alt-text-missing");
const BAD_ALT_FILE = join(BAD_ALT_DIR, "img-no-alt.html");

type JsonRpcResponse = Record<string, unknown>;

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });

  const payload = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  proc.stdin.write(payload);
  proc.stdin.end();

  const text = await new Response(proc.stdout).text();
  proc.kill();

  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JsonRpcResponse);
}

function initMsg(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-agent", version: "1.0" },
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

/** Reads `meta.configSearchedFrom` and `meta.configNote` off a scan-family response. */
function configContext(body: Record<string, unknown>): {
  configSearchedFrom: unknown;
  configNote: unknown;
} {
  const meta = (body.meta as Record<string, unknown> | undefined) ?? {};
  return {
    configSearchedFrom: meta["configSearchedFrom"],
    configNote: meta["configNote"],
  };
}

describe("meta.configSearchedFrom is present-when-meaningful", () => {
  it("scan_project does NOT emit `configSearchedFrom` echoing the caller's cwd", async () => {
    // The original triple-emission regression:
    //   { configSource: null, configSearchedFrom: <cwd>, configNote: "No ra11y.config found …" }
    // The Q6 closure drops `configSearchedFrom` entirely on `scan_project`
    // because its value always equaled the resolved `root` (already
    // emitted under `meta.scanned.root`). Field reports across four
    // 2026-04-22 repos showed the triple still emitting, so this test
    // pins the closure on the wire.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]);
    const { configSearchedFrom, configNote } = configContext(body);

    // The field must not echo the caller-supplied `cwd`.
    expect(configSearchedFrom).not.toBe(BAD_ALT_DIR);
    // The field must not echo `meta.scanned.root` either.
    const meta = body.meta as { scanned?: { root?: string } };
    if (meta.scanned?.root !== undefined) {
      expect(configSearchedFrom).not.toBe(meta.scanned.root);
    }
    // Strongest contract: under the Q6 closure, `scan_project` drops
    // the field entirely because the value would always echo `root`.
    expect(configSearchedFrom).toBeUndefined();
    // `configNote` boilerplate also dropped — the `no_config_found`
    // warning is the canonical signal.
    expect(configNote).toBeUndefined();
  });

  it("scan_project on a nonexistent cwd does not re-emit the triple either", async () => {
    // Hostile-input case — the original repro shape was a
    // misconfigured `cwd` triggering all three fields. Under the cwd-not-found envelope, the
    // nonexistent cwd hard-errors with `cwd-not-found`, so the body
    // has no meta at all; that's the honest shape and the regression
    // can't reappear here. Guard the structured-error path so a
    // future "soft-fail" change doesn't silently re-introduce the
    // triple on this branch.
    const bogus = join("/path/that/does/not/exist", "ra11y-config-context-regression");
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: bogus })]);
    const result = responses[1].result as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: { code?: string };
    };
    if (result.isError === true) {
      // Hard-error path — no meta on the wire, no triple to leak.
      expect(result.structuredContent?.code).toBe("cwd-not-found");
    } else {
      // Soft-fail path (future regression) — assert the triple stayed dropped.
      const body = bodyOf(responses[1]);
      const { configSearchedFrom, configNote } = configContext(body);
      expect(configSearchedFrom).toBeUndefined();
      expect(configNote).toBeUndefined();
    }
  });

  it("scan (directory mode) does NOT emit `configSearchedFrom` echoing the caller's cwd", async () => {
    // `scan` historically also had `configSearchedFrom: <cwd>` (a pure
    // echo of the input the agent supplied). Q6 drops it entirely.
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan", { paths: [BAD_ALT_DIR] })]);
    const body = bodyOf(responses[1]);
    const { configSearchedFrom, configNote } = configContext(body);
    expect(configSearchedFrom).toBeUndefined();
    expect(configNote).toBeUndefined();
  });

  it("scan_file does NOT emit `configSearchedFrom` when caller-supplied cwd matches the search base", async () => {
    // When the caller passes `cwd`, the loader walks up from that cwd
    // — `configSearchedFrom` would be a pure echo. The conditional
    // spread at src/mcp/tool-scan-file.ts:336 omits the field in that
    // case and keeps it only when the search base was DERIVED from
    // `dirname(absFilePath)`.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { filePath: BAD_ALT_FILE, cwd: BAD_ALT_DIR }),
    ]);
    const body = bodyOf(responses[1]);
    const { configSearchedFrom, configNote } = configContext(body);
    expect(configSearchedFrom).toBeUndefined();
    expect(configNote).toBeUndefined();
  });

  it("scan_file MAY emit `configSearchedFrom` when no cwd is supplied (derived search base is meaningful context)", async () => {
    // When `cwd` is omitted, the search base is `dirname(absFilePath)`
    // — that's signal the agent can't otherwise read off the response,
    // so the field is meaningful and present. We're not asserting that
    // it WILL be present (depends on whether the loader walks up to
    // find anything), only that IF present it does NOT echo any field
    // already on the response.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_file", { filePath: BAD_ALT_FILE }),
    ]);
    const body = bodyOf(responses[1]);
    const { configSearchedFrom, configNote } = configContext(body);
    // configNote stays dropped on every surface — the warning channel
    // carries the "no config" signal honestly.
    expect(configNote).toBeUndefined();
    if (typeof configSearchedFrom === "string") {
      // If present, it must NOT echo `meta.scanned.path` (the only
      // input-derived path on this surface). The check is strictly
      // about preventing a pure-echo regression — the value carrying
      // genuine derived-context survives.
      const meta = body.meta as { scanned?: { path?: string } };
      if (meta.scanned?.path !== undefined) {
        expect(configSearchedFrom).not.toBe(meta.scanned.path);
      }
    }
  });

  // Loads a real ra11y.config.ts on top of the MCP subprocess spawn —
  // the loader runs Bun's TypeScript pipeline and pushes this test
  // past bun:test's 5s default on slower machines / CI runners.
  it("scan_project with an explicit ra11y.config.ts loaded does not emit `configSearchedFrom` either", async () => {
    // Healthy-config path — even when `configSource` resolves
    // successfully (not null), the loader's search base is still
    // either the caller's cwd or the resolved root, both of which
    // already ride on the response. The field stays omitted.
    const dir = mkdtempSync(join(tmpdir(), "ra11y-config-context-loaded-"));
    try {
      writeFileSync(join(dir, "ra11y.config.ts"), "export default { nativeWrappers: [] };\n");
      writeFileSync(join(dir, "index.html"), '<html><body><img src="/x.png"></body></html>\n');
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: dir })]);
      const body = bodyOf(responses[1]);
      const { configSearchedFrom, configNote } = configContext(body);
      const meta = body.meta as { configSource?: string };
      // Sanity: the config did load (otherwise the test isn't
      // exercising the "loaded" branch).
      expect(typeof meta.configSource).toBe("string");
      // Even with config loaded, the redundant search-base field stays dropped.
      expect(configSearchedFrom).toBeUndefined();
      expect(configNote).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
