/**
 * Integration test for V1-ADDITIONAL-PATHS-SCOPE-RESTRICT — asserts
 * that `scan_project({ restrictToPaths: [...] })` intersects the
 * discovered file set with the supplied paths, surfaces the structured
 * `meta.restrictToPathsApplied` payload (paths + before/after counts),
 * and emits the `restrict_to_paths_no_matches` warning when the
 * intersection empties the set.
 *
 * End-to-end through the MCP server (stdio JSON-RPC) so the assertion
 * exercises the full pipeline — schema accepts the new param, handler
 * threads it through discovery, the assembler routes the meta + warning.
 *
 * Three scenarios:
 *
 *   1. Subdirectory restriction keeps files within the named directory
 *      and drops everything else (the canonical "scope a project scan
 *      to a subtree" use case the backlog item names).
 *
 *   2. Restriction that matches no discovered file emits the
 *      `restrict_to_paths_no_matches` warning so an agent doesn't
 *      mistake the empty result for a clean codebase (CLAUDE.md §1
 *      "Zero-output success is ambiguous failure").
 *
 *   3. Omitting the param leaves the discovered file set untouched
 *      AND keeps `meta.restrictToPathsApplied` absent (honest shape).
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

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

/**
 * Builds a tiny project tree with two siblings:
 *   - keep/page.html — the file the restriction will keep.
 *   - drop/page.html — the file the restriction will exclude.
 * Both files have findings (bare `<img>` without `alt`) so the
 * pre-restrict and post-restrict file counts are unambiguous.
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ra11y-restrict-"));
  mkdirSync(join(root, "keep"));
  mkdirSync(join(root, "drop"));
  writeFileSync(join(root, "keep", "page.html"), '<html><body><img src="/k.png"></body></html>\n');
  writeFileSync(join(root, "drop", "page.html"), '<html><body><img src="/d.png"></body></html>\n');
  return root;
}

describe("scan_project: V1-ADDITIONAL-PATHS-SCOPE-RESTRICT", () => {
  it("intersects the discovered file set with restrictToPaths and reports the before/after counts", async () => {
    const root = makeRoot();
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, restrictToPaths: ["keep"] }),
      ]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown>;
      expect(meta).toBeDefined();
      const restrict = meta.restrictToPathsApplied as
        | { paths: readonly string[]; filesBeforeRestrict: number; filesAfterRestrict: number }
        | undefined;
      expect(restrict).toBeDefined();
      expect(restrict?.paths).toEqual(["keep"]);
      expect(restrict?.filesBeforeRestrict).toBe(2);
      expect(restrict?.filesAfterRestrict).toBe(1);
      // Findings stay surfaced on the kept file; the dropped file is
      // not in `files[]`.
      const files = body.files as Array<{ path: string }>;
      expect(files.length).toBe(1);
      expect(files[0]?.path).toContain("keep/page.html");
      expect(files[0]?.path).not.toContain("drop/page.html");
      // Set of path-shape warnings stays empty when the restriction
      // kept ≥1 file.
      const warnings = (body.warnings as readonly string[] | undefined) ?? [];
      expect(warnings).not.toContain("restrict_to_paths_no_matches");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits restrict_to_paths_no_matches when the intersection empties the discovered set", async () => {
    const root = makeRoot();
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, restrictToPaths: ["nope"] }),
      ]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown>;
      const restrict = meta.restrictToPathsApplied as
        | { filesBeforeRestrict: number; filesAfterRestrict: number }
        | undefined;
      expect(restrict).toBeDefined();
      expect(restrict?.filesBeforeRestrict).toBe(2);
      expect(restrict?.filesAfterRestrict).toBe(0);
      const warnings = (body.warnings as readonly string[] | undefined) ?? [];
      expect(warnings).toContain("restrict_to_paths_no_matches");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits restrictToPathsApplied entirely when the param is not supplied", async () => {
    const root = makeRoot();
    try {
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown>;
      // Honest shape per CLAUDE.md §1 "Ambiguous field shapes are
      // dishonest" — no restriction → field absent, not `null` and
      // not a sentinel zero-count payload.
      expect(meta).not.toHaveProperty("restrictToPathsApplied");
      const warnings = (body.warnings as readonly string[] | undefined) ?? [];
      expect(warnings).not.toContain("restrict_to_paths_no_matches");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
