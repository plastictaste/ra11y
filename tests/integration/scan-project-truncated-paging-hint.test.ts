/**
 * Pins the paging-hint overlay on `scan_project` responses that ship
 * `truncated: true` alongside a resumable `nextOffset`. Without the
 * overlay, an agent reading `nextStep` proceeds to single-finding
 * triage and silently never pages the rest of the inventory — a
 * silent-miss failure mode whose blast radius is N-K files' worth of
 * findings (where N is `totalFilesWithFindings` and K is the
 * returned page size).
 *
 * Two surfaces co-evolve and must both reflect the paging signal:
 *
 *   - `nextStep` prose — must lead with the paging recommendation
 *     ("Response truncated — N files-with-findings, K returned. Call
 *     `scan_project` with `offset: <n>` …") before naming the per-
 *     finding triage call. The prose-first ordering matches the
 *     "One tool call should answer 'what next?'" doctrine bullet.
 *   - `nextStepStructured` — replaces the prior triage call with
 *     `{tool: "scan_project", args: {offset: N, cwd: <caller-cwd>}}`
 *     so an agent that branches off the structured form gets the
 *     paging shape directly. The prior structured call (suggest_fix
 *     / explain_rule / etc.) moves into the
 *     `nextStepStructuredAlternatives` array — the doctrine "Don't
 *     drop the existing finding-triage suggestion; offer both" makes
 *     sure an agent that wants to triage first still has the
 *     structured shape next to the paging primary.
 *
 * The paginate-files unit test already pins the truncation contract
 * itself (`truncated: true`, `nextOffset: 2`, `totalFilesWithFindings:
 * 6`); this test pins the paging-hint overlay that rides alongside
 * those fields.
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
 * Builds a tempdir with N simple HTML files, each containing an
 * `<img>` without alt text so each file produces at least one
 * finding. Mirrors the paginate-files unit-test fixture so the two
 * surfaces co-evolve cleanly.
 */
function buildFixture(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), "ra11y-paging-hint-"));
  const src = join(root, "src");
  mkdirSync(src);
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(
      join(src, `page-${i}.html`),
      `<html><body><img src="/p${i}.png"></body></html>\n`,
    );
  }
  return root;
}

describe("scan_project truncated-paging-hint overlay", () => {
  it("prepends paging hint to nextStep prose when truncated + nextOffset", async () => {
    const root = buildFixture(6);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 2 }),
      ]);
      const body = bodyOf(responses[1]) as {
        files: unknown[];
        truncated?: boolean;
        nextOffset?: number;
        totalFilesWithFindings?: number;
        nextStep?: string;
      };
      // Pre-condition: the truncation contract still fires as the
      // paginate-files unit tests pinned it.
      expect(body.truncated).toBe(true);
      expect(body.nextOffset).toBe(2);
      expect(body.totalFilesWithFindings).toBe(6);
      expect(body.files.length).toBe(2);
      // Paging-hint overlay: prose names the truncation, the inventory
      // size, and the resumable offset BEFORE descending into the per-
      // finding triage tail. The exact prose template is internal to
      // the helper; the test pins the load-bearing tokens.
      const prose = body.nextStep ?? "";
      expect(prose).toContain("Response truncated");
      expect(prose).toContain("6 files-with-findings");
      expect(prose).toContain("2 returned");
      expect(prose).toContain("offset: 2");
      // Paging hint must precede the triage tail — the doctrine
      // "One tool call should answer 'what next?'" argues the load-
      // bearing recommendation comes first. We anchor by checking
      // that the paging tokens appear before any finding-triage tokens
      // (`suggest_fix` / `explain_rule`) the prior nextStep would have
      // led with. A response with no callable findings also lacks
      // those tokens, so the assertion only fires when both sides are
      // present — defensive narrowing for the all-clean-scan case.
      const pagingIdx = prose.indexOf("Response truncated");
      const triageIdx = Math.max(prose.indexOf("suggest_fix"), prose.indexOf("explain_rule"));
      if (triageIdx >= 0) {
        expect(pagingIdx).toBeLessThan(triageIdx);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nextStepStructured carries the paging shape with offset and cwd", async () => {
    const root = buildFixture(6);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 2 }),
      ]);
      const body = bodyOf(responses[1]) as {
        truncated?: boolean;
        nextOffset?: number;
        nextStepStructured?: { tool?: string; args?: Record<string, unknown> };
        nextStepStructuredAlternatives?: Array<{ tool?: string; args?: Record<string, unknown> }>;
      };
      expect(body.truncated).toBe(true);
      expect(body.nextOffset).toBe(2);
      // The primary structured next-call points at scan_project with
      // the resumable offset and the caller's cwd. Per the doctrine
      // "NextStep handoffs must terminate at a narrowing tool, never
      // form a cycle between transport-failing siblings," routing
      // back to scan_project with a NARROWER scope (the next page) is
      // the load-bearing recommendation.
      expect(body.nextStepStructured?.tool).toBe("scan_project");
      expect(body.nextStepStructured?.args?.offset).toBe(2);
      expect(body.nextStepStructured?.args?.cwd).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the prior triage call as a structured alternative", async () => {
    const root = buildFixture(6);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 2 }),
      ]);
      const body = bodyOf(responses[1]) as {
        truncated?: boolean;
        nextStepStructuredAlternatives?: Array<{
          tool?: string;
          args?: Record<string, unknown>;
        }>;
      };
      expect(body.truncated).toBe(true);
      // The prior `nextStepStructured` (per-finding triage —
      // `suggest_fix` for fixable violations, `explain_rule` for
      // manual cases) shifts into `nextStepStructuredAlternatives`
      // so an agent that wants to triage the top finding before
      // paging still has the structured shape. Doctrine "Don't drop
      // the existing finding-triage suggestion; offer both."
      expect(Array.isArray(body.nextStepStructuredAlternatives)).toBe(true);
      expect((body.nextStepStructuredAlternatives ?? []).length).toBeGreaterThanOrEqual(1);
      const alt = (body.nextStepStructuredAlternatives ?? [])[0];
      // Whatever the prior call was, it must NOT be a paging echo —
      // alternatives serve a different purpose than the primary.
      expect(alt?.tool).not.toBe("scan_project");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT add paging hint when last page (truncated:false, no nextOffset)", async () => {
    const root = buildFixture(5);
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 3, offset: 3 }),
      ]);
      const body = bodyOf(responses[1]) as {
        files: unknown[];
        truncated?: boolean;
        nextOffset?: number;
        nextStep?: string;
        nextStepStructured?: { tool?: string; args?: Record<string, unknown> };
        nextStepStructuredAlternatives?: unknown;
      };
      // Last-page contract from paginate-files.test.ts.
      expect(body.truncated).toBe(false);
      expect(body.nextOffset).toBeUndefined();
      // With no resumable offset, the overlay is a no-op — prose
      // doesn't carry the truncation token, and the alternatives
      // field is absent (present-when-meaningful per CLAUDE.md §1).
      expect(body.nextStep ?? "").not.toContain("Response truncated");
      expect(body.nextStepStructuredAlternatives).toBeUndefined();
      // The structured next-call is whatever the standard builder
      // produced for the last-page slice — it MUST NOT echo the
      // paging shape (an offset of 5 on a 5-file inventory would
      // page off the end). Defensive: if the standard nextStep is
      // scan_project (e.g. clean-scan branch routes to checklist
      // not scan_project), reject the paging-shape echo.
      if (body.nextStepStructured?.tool === "scan_project") {
        expect(body.nextStepStructured?.args?.offset).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
