/**
 * Integration test: `get_finding` round-trips a `findingId` captured
 * from a prior scan back to the canonical violation / review-candidate
 * shape so an agent can chain into `suggest_fix(ruleId, file, line)`
 * without re-walking the scan response.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md "Per-finding
 * identifiers must be addressable, not collision-prone" — the id the
 * tool returns must resolve to one and only one emission, and the
 * resolved shape must be sufficient for the downstream chain.
 *
 * Strategy: spawn the MCP subprocess, call `scan_project` to obtain a
 * real `findingId`, then call `get_finding({findingId})` and assert:
 *   1. The tool returns `found: true` with `kind: "violation"`.
 *   2. The `finding.findingId` matches what we passed in.
 *   3. The returned `nextStepStructured.tool === "suggest_fix"` carries
 *      the `ruleId`/`file`/`line` triple the agent needs.
 *
 * Plus a miss test for an obviously bogus id (must return
 * `found: false` with a structured `reason` discriminator).
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const BAD_ALT_DIR = join(PROJECT_ROOT, "tests", "fixtures", "bad", "alt-text-missing");

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

interface ScanProjectFinding {
  readonly findingId: string;
  readonly ruleId: string;
  readonly line: number;
}
interface ScanProjectFile {
  readonly path: string;
  readonly findings: readonly ScanProjectFinding[];
}

describe("get_finding round-trips a findingId from a prior scan", () => {
  it("resolves a violation id back to its canonical (ruleId, file, line) triple", async () => {
    // Step 1: scan the bad-alt fixture and capture a real findingId
    // off `files[].findings[]`. We don't hard-code an id because the
    // hash is deterministic per (ruleId, relativeFilePath, line, column)
    // — the lookup should round-trip whatever the scan produced.
    const scanResponses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: BAD_ALT_DIR }),
    ]);
    const scanBody = bodyOf(scanResponses[1]) as { files: readonly ScanProjectFile[] };
    expect(scanBody.files.length).toBeGreaterThan(0);
    const firstFile = scanBody.files[0];
    expect(firstFile.findings.length).toBeGreaterThan(0);
    const captured = firstFile.findings[0];
    expect(typeof captured.findingId).toBe("string");
    expect(captured.findingId.length).toBeGreaterThan(0);

    // Step 2: hand the id to `get_finding` and assert the round-trip
    // resolves to the same emission with a chain hint into
    // `suggest_fix(ruleId, file, line)`.
    const lookupResponses = await mcpSession([
      initMsg(1),
      toolCall(2, "get_finding", {
        findingId: captured.findingId,
        cwd: BAD_ALT_DIR,
      }),
    ]);
    const lookupBody = bodyOf(lookupResponses[1]) as {
      found: boolean;
      kind?: string;
      finding?: { findingId: string; ruleId: string; line: number; file: string };
      nextStepStructured?: {
        tool: string;
        args: { ruleId: string; file: string; line: number };
      };
    };
    expect(lookupBody.found).toBe(true);
    expect(lookupBody.kind).toBe("violation");
    expect(lookupBody.finding?.findingId).toBe(captured.findingId);
    expect(lookupBody.finding?.ruleId).toBe(captured.ruleId);
    expect(lookupBody.finding?.line).toBe(captured.line);
    expect(lookupBody.nextStepStructured?.tool).toBe("suggest_fix");
    expect(lookupBody.nextStepStructured?.args.ruleId).toBe(captured.ruleId);
    expect(lookupBody.nextStepStructured?.args.line).toBe(captured.line);
  });

  it("returns found: false with a structured reason when the id matches no emission", async () => {
    // 12 hex chars matches the `findingId` shape but is plausibly
    // not derivable from any (ruleId, file, line) on the fixture
    // tree, so the lookup must miss honestly.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "get_finding", {
        findingId: "deadbeefcafe",
        cwd: BAD_ALT_DIR,
      }),
    ]);
    const body = bodyOf(responses[1]) as {
      found: boolean;
      reason?: string;
      filesScanned?: number;
    };
    expect(body.found).toBe(false);
    expect(body.reason).toBe("finding_id_not_found");
    expect(typeof body.filesScanned).toBe("number");
    expect(body.filesScanned).toBeGreaterThan(0);
  });

  it("errors with cwd-not-found when cwd doesn't exist on disk", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "get_finding", {
        findingId: "deadbeefcafe",
        cwd: "/nonexistent-path-ra11y-test",
      }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: { code?: string };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("cwd-not-found");
  });

  it("errors with missing-required-param when findingId is omitted", async () => {
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "get_finding", { cwd: BAD_ALT_DIR }),
    ]);
    const result = responses[1].result as {
      isError?: boolean;
      structuredContent?: { code?: string };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("missing-required-param");
  });
});
