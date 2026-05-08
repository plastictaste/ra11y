/**
 * Integration test for — asserts that
 * `scan_project` surfaces `meta.catalogHint` (topLevelSiblings +
 * exampleSiblings) and appends the per-subdir-scan nudge to
 * `meta.analysisCoverage.hints` when the scan root carries ≥ 5
 * top-level sibling site dirs (each with `index.html` + an asset
 * directory like `css/` or `images/`).
 *
 * End-to-end through the MCP server (stdio JSON-RPC) so the assertion
 * exercises the full response-assembly path — the catalog detector +
 * scan-project handler wiring + response assembler + MCP envelope. A
 * unit-level test would cover the detector in isolation; this test
 * guards the wiring, which is the regression surface an agent
 * actually sees.
 *
 * Three scenarios:
 *
 *   1. Catalog-shaped repo with parseable HTML in every sibling.
 *      Exercises the populated-files assembly branch — the agent
 *      sees both real findings and the routing hint in one response.
 *
 *   2. Catalog-shaped repo with no parseable content (just empty
 *      sibling dirs holding index.html + css/). Exercises the
 *      zero-parseable-files branch where silent-miss failure is most
 *      likely and the catalog hint is most valuable.
 *
 *   3. Single-site repo (no catalog shape). Confirms the field is
 *      absent on plain repos rather than `null` (CLAUDE.md §1
 *      "Ambiguous field shapes are dishonest").
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posixJoin } from "../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..");

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
 * Builds five sibling site dirs at `root`, each carrying `index.html`
 * plus a `css/` directory so the catalog detector's corroboration
 * predicate fires. Caller picks whether `index.html` is non-empty
 * (populated branch) or absent (the css-only-with-empty-html branch).
 */
function makeFiveSiblingSites(root: string, withParseableHtml: boolean): readonly string[] {
  const names = ["template-a", "template-b", "template-c", "template-d", "template-e"];
  for (const name of names) {
    const dir = posixJoin(root, name);
    mkdirSync(dir);
    mkdirSync(posixJoin(dir, "css"));
    writeFileSync(
      posixJoin(dir, "index.html"),
      withParseableHtml
        ? `<!DOCTYPE html><html lang="en"><head><title>${name}</title></head><body><main><h1>${name}</h1></main></body></html>\n`
        : "",
    );
  }
  return names;
}

describe("scan_project:", () => {
  it("surfaces catalogHint + analysisCoverage hint on a 5-sibling catalog with parseable content", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-catalog-populated-"));
    try {
      makeFiveSiblingSites(root, true);
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown>;
      expect(meta).toBeDefined();
      const hint = meta.catalogHint as Record<string, unknown> | undefined;
      expect(hint).toBeDefined();
      expect(hint?.topLevelSiblings).toBe(5);
      expect(hint?.exampleSiblings).toEqual(["template-a", "template-b", "template-c"]);
      const coverage = meta.analysisCoverage as Record<string, unknown> | undefined;
      expect(coverage).toBeDefined();
      const hints = coverage?.hints as
        | readonly { code: string; text: string; detail?: Record<string, unknown> }[]
        | undefined;
      expect(Array.isArray(hints)).toBe(true);
      const catalogHintEntry = hints?.find((h) => h.code === "catalog_shape_detected");
      expect(catalogHintEntry).toBeDefined();
      expect(catalogHintEntry?.text).toContain("catalog");
      expect(catalogHintEntry?.text).toContain('scan_project({ cwd: "<subdir>" })');
      expect(catalogHintEntry?.detail?.["topLevelSiblings"]).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces catalogHint on the zero-parseable-files branch", async () => {
    // Empty `index.html` files in each sibling — the detector still
    // qualifies them (existsSync passes) but discovery yields no
    // parseable AST content, exercising the zero-files response shape.
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-catalog-empty-"));
    try {
      makeFiveSiblingSites(root, false);
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown>;
      const hint = meta.catalogHint as Record<string, unknown> | undefined;
      expect(hint?.topLevelSiblings).toBe(5);
      const coverage = meta.analysisCoverage as Record<string, unknown> | undefined;
      const hints = coverage?.hints as
        | readonly { code: string; text: string; detail?: Record<string, unknown> }[]
        | undefined;
      expect(hints?.some((h) => h.code === "catalog_shape_detected")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits catalogHint entirely on a single-app repo", async () => {
    // Honest absence per CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest" — no catalog → field absent, not `null`.
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-catalog-none-"));
    try {
      writeFileSync(posixJoin(root, "package.json"), '{"name":"x","version":"0.0.0"}\n');
      writeFileSync(
        posixJoin(root, "index.html"),
        '<html><body><img src="/hero.png"></body></html>\n',
      );
      mkdirSync(posixJoin(root, "css"));
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown>;
      expect(meta.catalogHint).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
