/**
 * Integration test: `list_finders` cross-surface inventory contract.
 *
 * The doctrine line under test is the cross-surface count invariant
 * extended to the manual-review enumeration axis: every finder
 * surfaced via `review_candidates.prompts[*].finderId` MUST appear in
 * the `list_finders` enumeration. Drift would silently break agent
 * audit workflows that pre-budget against the inventory headline.
 *
 * Scope:
 *
 *   1. Round-trip `list_finders` over the MCP transport — a stdio call
 *      reaches the registered tool and the response decodes to the
 *      documented shape (finders[], matchedOf, meta, nextStep).
 *
 *   2. Cross-surface superset — call `review_candidates` on a fixture
 *      known to fire multiple finders (the consistent-navigation
 *      review fixture surfaces SC 3.2.3 candidates), collect every
 *      `finderId` from `prompts[*].finderId`, and assert the
 *      `list_finders` response enumerates each one. Any finder visible
 *      via the runtime surface that's missing from the registry surface
 *      indicates either a registration drift (finder not registered in
 *      `BUILTIN_CANDIDATE_FINDERS`) or a response-shape regression
 *      (`list_finders` accidentally filtered the entry out).
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const REVIEW_FIXTURE = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "review",
  "consistent-navigation",
  "bad",
);

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

describe("list_finders MCP transport round-trip", () => {
  it("returns the shape documented in the tool definition over stdio", async () => {
    const responses = await mcpSession([initMsg(1), toolCall(2, "list_finders", {})]);
    const body = bodyOf(responses[1]) as {
      finders: Array<{
        finderId: string;
        criterionIds: string[];
        scope: string;
        description: string;
        reviewPrompt: string;
        references: string[];
      }>;
      matchedOf: { total: number; matched: number };
      meta: {
        findersTotal: number;
        findersMatched: number;
        standardsLoaded: number;
        standards: string[];
      };
      nextStep: string;
      nextStepStructured: { tool: string; args: Record<string, unknown> };
    };

    expect(body.finders.length).toBeGreaterThan(0);
    expect(body.matchedOf.total).toBe(body.finders.length);
    expect(body.matchedOf.matched).toBe(body.finders.length);
    expect(body.meta.findersTotal).toBe(body.finders.length);
    expect(body.meta.standardsLoaded).toBeGreaterThan(0);
    expect(body.nextStepStructured.tool).toBe("review_candidates");

    // Every finder entry conforms to the documented shape.
    for (const f of body.finders) {
      expect(f.finderId.length).toBeGreaterThan(0);
      // Finder IDs are namespaced by category — `review/` for the
      // candidate-surfacing core, `suppression/` for the pragma-quality
      // finder. Both must carry a slash to stay grep-able.
      expect(f.finderId).toContain("/");
      expect(f.criterionIds.length).toBeGreaterThan(0);
      expect(f.scope === "node" || f.scope === "document").toBe(true);
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.reviewPrompt.length).toBeGreaterThan(0);
    }
  });
});

describe("list_finders cross-surface superset of review_candidates", () => {
  it("enumerates every finder visible via review_candidates.prompts[*].finderId", async () => {
    // Single-process MCP session: review_candidates first to harvest
    // the live `finderId` set, then list_finders to assert the
    // registry surface is a superset. Same connection so the two
    // surfaces resolve against the same registry / standards loadout.
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "review_candidates", { paths: [REVIEW_FIXTURE] }),
      toolCall(3, "list_finders", {}),
    ]);

    const reviewBody = bodyOf(responses[1]) as {
      candidateCount: number;
      prompts?: Record<string, { text: string; finderId: string }>;
    };
    const findersBody = bodyOf(responses[2]) as {
      finders: Array<{ finderId: string }>;
    };

    // Sanity: the fixture is the canonical multi-finder source so
    // `prompts` must be populated. If this fails the fixture has
    // drifted, not the cross-surface invariant.
    expect(reviewBody.prompts).toBeDefined();
    const promptFinderIds = new Set<string>();
    for (const entry of Object.values(reviewBody.prompts ?? {})) {
      expect(typeof entry.finderId).toBe("string");
      expect(entry.finderId.length).toBeGreaterThan(0);
      promptFinderIds.add(entry.finderId);
    }
    expect(promptFinderIds.size).toBeGreaterThan(0);

    const enumeratedFinderIds = new Set(findersBody.finders.map((f) => f.finderId));
    // Cross-surface superset: every finder visible via the runtime
    // prompts surface MUST be in the registry enumeration. Drift here
    // is the silent regression the test guards against.
    for (const finderId of promptFinderIds) {
      expect(
        enumeratedFinderIds.has(finderId),
        `finder ${finderId} surfaced via review_candidates.prompts but missing from list_finders`,
      ).toBe(true);
    }
  });
});
