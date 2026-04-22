/**
 * Integration test for Q4-SSG-BUILD-HINT — asserts that `scan_project`
 * surfaces `meta.detectedFramework` and appends the SSG hint to
 * `meta.analysisCoverage.hints` when a canonical static-site-generator
 * config is present at the scan root.
 *
 * End-to-end through the MCP server (stdio JSON-RPC) so the assertion
 * exercises the full response-assembly path — the SSG detector +
 * scan-project handler wiring + response assembler + MCP envelope. A
 * unit-level test would cover the detector in isolation; this test
 * guards the wiring, which is the regression surface an agent actually
 * sees.
 *
 * Two scenarios:
 *
 *   1. Empty SSG repo (no parseable files, just a `_config.yml`).
 *      Confirms the hint reaches the agent on the zero-parseable-files
 *      branch — exactly the case where silent-miss failure is most
 *      likely because the scanner had nothing to do.
 *
 *   2. SSG repo with a small rendered output directory already on
 *      disk. Confirms the hint still fires when the scan has live
 *      parseable content (the normal assembly branch), so an agent
 *      that already built the site gets the telemetry consistently.
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

describe("scan_project: Q4-SSG-BUILD-HINT", () => {
  it("surfaces detectedFramework + analysisCoverage hint on an empty Jekyll repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-ssg-jekyll-empty-"));
    try {
      // Jekyll config at the repo root but no parseable content.
      // This is the zero-parseable-files branch — canonically the
      // state of a Jekyll source tree before `bundle exec jekyll
      // build` runs, and exactly when the agent most needs the hint.
      // `_layouts/` corroborates the Jekyll classification so the
      // detector resolves to a confident `jekyll` (a bare `_config.yml`
      // would resolve to null per the corroboration contract — see
      // tests/unit/mcp/ssg-detect.test.ts).
      writeFileSync(join(root, "_config.yml"), "title: My site\nmarkdown: kramdown\n");
      mkdirSync(join(root, "_layouts"));
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown>;
      expect(meta).toBeDefined();
      const detected = meta.detectedFramework as Record<string, unknown> | undefined;
      expect(detected).toEqual({
        name: "jekyll",
        buildOutput: "_site/",
        buildCommand: "bundle exec jekyll build",
      });
      const coverage = meta.analysisCoverage as Record<string, unknown> | undefined;
      expect(coverage).toBeDefined();
      const hints = coverage?.hints as readonly string[] | undefined;
      expect(Array.isArray(hints)).toBe(true);
      expect(hints?.some((h) => h.includes("jekyll"))).toBe(true);
      expect(hints?.some((h) => h.includes('additionalPaths: ["_site"]'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces detectedFramework on a Hugo repo that also has parseable content", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-ssg-hugo-content-"));
    try {
      // Modern Hugo config + a small rendered HTML page so the scan
      // exercises the non-empty assembly branch (`formatted.meta`
      // carries real `analysisCoverage`/`filesByExtension` data).
      writeFileSync(join(root, "hugo.toml"), 'baseURL = "https://example.org/"\n');
      mkdirSync(join(root, "public"));
      writeFileSync(
        join(root, "public", "index.html"),
        '<html><body><img src="/hero.png"></body></html>\n',
      );
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, additionalPaths: ["public"] }),
      ]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown>;
      const detected = meta.detectedFramework as Record<string, unknown> | undefined;
      expect(detected).toEqual({ name: "hugo", buildOutput: "public/", buildCommand: "hugo" });
      const coverage = meta.analysisCoverage as Record<string, unknown> | undefined;
      const hints = coverage?.hints as readonly string[] | undefined;
      expect(hints?.some((h) => h.includes("hugo"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits detectedFramework entirely on a plain Node repo", async () => {
    // Clean honest shape per CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest" — no SSG marker → field absent, not `null`.
    const root = mkdtempSync(join(tmpdir(), "ra11y-ssg-none-"));
    try {
      writeFileSync(join(root, "package.json"), '{"name":"x","version":"0.0.0"}\n');
      writeFileSync(join(root, "index.html"), '<html><body><img src="/hero.png"></body></html>\n');
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      const meta = body.meta as Record<string, unknown>;
      expect(meta.detectedFramework).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
