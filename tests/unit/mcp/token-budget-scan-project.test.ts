/**
 * Integration test for the ADR 0021 amendment (2026-04-20) token-
 * density secondary budget wired into scan_project. Spawns the MCP
 * server, calls scan_project with a small `limit` but a very tight
 * `budgetChars`-equivalent fixture profile, and asserts:
 *
 *   - The response stays honest when already under the default budget
 *     (no density warning, no inflated pagination).
 *   - When density would push the response past a low artificial
 *     ceiling — simulated by requesting a larger `limit` on a
 *     many-file fixture — `truncated: true` + `nextOffset` fire and
 *     the `response_token_budget_truncated` warning code surfaces.
 *
 * Keeping the assertion narrow: we don't compare byte counts to a
 * fixed threshold (byte-per-file varies with compiler/rule churn).
 * Instead we verify the *contract*: pagination stays resumable and the
 * warning names the density cap as the cause.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

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
 * Builds a tempdir with N label-dense HTML files so each file
 * produces multiple label-related findings. The fix.description
 * hoist already dedupes identical descriptions; this fixture uses
 * enough per-file bytes that a high `limit` forces the density cap
 * to engage while still leaving room for at least one file under the
 * default budget.
 */
function buildDenseFixture(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), "ra11y-tokenbudget-"));
  const src = join(root, "src");
  mkdirSync(src);
  // Label-heavy form with multiple unlabeled inputs + img w/o alt
  // per file. Each file hits multiple rules with multi-line fix
  // descriptions, packing the response quickly.
  const formBlock = Array.from({ length: 10 }, (_, i) => `  <input type="text" name="f${i}">`).join(
    "\n",
  );
  const body = `<html><body>\n  <img src="/p.png">\n  <form>\n${formBlock}\n  </form>\n</body></html>\n`;
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(join(src, `page-${i}.html`), body);
  }
  return root;
}

describe("scan_project token-density budget (ADR 0021 amendment)", () => {
  it("passes through unchanged when the response fits under the default budget", async () => {
    // Small fixture, small limit → response well under ~88 KB. The
    // file-count cap is the only guard; density warning must NOT
    // fire. Honest shape per the ADR amendment.
    const root = buildDenseFixture(3);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 25 }),
      ]);
      const body = bodyOf(responses[1]) as {
        warnings?: readonly string[];
      };
      const warnings = body.warnings ?? [];
      expect(warnings).not.toContain("response_token_budget_truncated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("engages density truncation + warning when per-file density pushes past the budget", async () => {
    // 50 label-dense HTML files × 10 inputs per file × one unlabeled
    // `<img>` emits ~100 findings per file with multiple long fix-
    // description paragraphs. With `limit: 50` the file-count cap
    // doesn't fire (50 ≤ 50) — the density cap is the sole guard.
    // The 88000-char default forces the tail to drop so the response
    // fits under the ~25k-token MCP ceiling.
    const root = buildDenseFixture(50);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 50 }),
      ]);
      const body = bodyOf(responses[1]) as {
        files: unknown[];
        truncated?: boolean;
        nextOffset?: number;
        totalFilesWithFindings?: number;
        warnings?: readonly string[];
      };
      const warnings = body.warnings ?? [];
      expect(warnings).toContain("response_token_budget_truncated");
      expect(body.truncated).toBe(true);
      expect(typeof body.nextOffset).toBe("number");
      expect(body.nextOffset).toBeGreaterThanOrEqual(1);
      expect(body.files.length).toBeLessThan(50);
      expect(body.files.length).toBeGreaterThanOrEqual(1);
      expect(body.totalFilesWithFindings).toBe(50);
      // nextOffset resumes at offset + keptFileCount so the next
      // page picks up the dropped tail.
      expect(body.nextOffset).toBe(body.files.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
