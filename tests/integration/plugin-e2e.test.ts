/**
 * Integration test: plugin-registry end-to-end path.
 *
 * ADR 0022 stage 7 pins the user-authored-rule seam: a caller
 * builds a {@link Registry} via `createRegistry({ rules, … })`,
 * threads it into an {@link McpSession}, and every tool that reads
 * `session.registry` — `list_rules`, `scan`, `scan_project`,
 * `checklist` — sees the plugin rule alongside the shipped built-ins.
 *
 * This file exercises that path in-process (no subprocess spawn —
 * the registry-override seam is a constructor param, not an env
 * var, and reaching through `ra11y --mcp` would require an
 * ambient-plugin loader we don't have and shouldn't invent to test
 * this seam). The shape mirrors `tests/integration/conformance-e2e.test.ts`:
 * call the tool handler directly with a session that the test
 * constructed, parse the JSON payload, assert the contract.
 *
 * Invariants locked in here:
 *   1. `list_rules` exposes the plugin rule alongside built-ins and
 *      counts it in `matchedOf.total`.
 *   2. `scan_project` on a fixture that triggers the plugin rule
 *      emits a violation with `ruleId === "example/no-title-only-label"`
 *      and attaches the plugin's `satisfies` criteria.
 *   3. Omitting the registry override reverts to the built-ins-only
 *      surface — the plugin rule must NOT appear, confirming the
 *      override is the seam (not a global mutation).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import examplePluginRule from "../../examples/plugin-rule/rule.ts";
import { createRegistry } from "../../src/engine/registry/registry.ts";
import { McpSession } from "../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../src/mcp/tools.ts";

const PLUGIN_RULE_ID = "example/no-title-only-label";

interface ListRulesPayload {
  readonly matchedOf: { readonly total: number; readonly matched: number };
  readonly rules: ReadonlyArray<{
    readonly id: string;
    readonly severity: string;
    readonly satisfies: readonly string[];
  }>;
}

interface ScanFinding {
  readonly ruleId: string;
  readonly criteria: readonly string[];
  readonly severity: string;
}

interface ScanPayload {
  // `totalFindings` was removed from the MCP `scan_project` plan shape
  // (see `src/mcp/scan-assembly.ts`) and from the agent-formatter
  // `AgentPlan` (see `src/output/agent-response/types.ts`) per
  // CLAUDE.md §1 "Composite headline counts are dishonest" — the plan
  // exposes split `violations` (severity error/warning) and `notes`
  // (severity info) counters instead.
  readonly plan: { readonly violations: number; readonly notes: number };
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly findings: readonly ScanFinding[];
  }>;
}

function pluginSession(): McpSession {
  return new McpSession(createRegistry({ rules: [examplePluginRule] }));
}

function builtinsOnlySession(): McpSession {
  return new McpSession();
}

function toolByName(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (tool === undefined) {
    throw new Error(`MCP_TOOLS missing expected tool '${name}'`);
  }
  return tool;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  session: McpSession,
): Promise<string> {
  const tool = toolByName(name);
  const result = await tool.handler(args, session);
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`${name} returned no text payload`);
  }
  return text;
}

let scratch: string | undefined;
let badFixture: string;

beforeAll(async () => {
  scratch = await mkdtemp(joinPath(tmpdir(), "ra11y-plugin-e2e-"));
  badFixture = joinPath(scratch, "bad.html");
  // A button whose only accessible name is the `title` attribute —
  // the exact pattern the plugin rule flags. No nested text, no
  // aria-label, no aria-labelledby.
  await writeFile(
    badFixture,
    `<!doctype html><html lang="en"><head><title>t</title></head><body><button title="Close"></button></body></html>`,
  );
});

afterAll(async () => {
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
  }
});

describe("plugin registry seam — list_rules", () => {
  it("exposes the plugin rule alongside built-ins when the session carries the override", async () => {
    const payload = JSON.parse(
      await callTool("list_rules", {}, pluginSession()),
    ) as ListRulesPayload;
    const ids = payload.rules.map((r) => r.id);
    expect(ids).toContain(PLUGIN_RULE_ID);
    // Built-in anchor: if the plugin replaced (vs extended) the
    // registry, this would disappear.
    expect(ids).toContain("media/alt-text-missing");
    // The plugin's declared criteria survive the list surface —
    // agents filtering `list_rules({ standard: "wcag22" })` rely on
    // the satisfies array to route.
    const plugin = payload.rules.find((r) => r.id === PLUGIN_RULE_ID);
    expect(plugin?.satisfies).toContain("wcag22:4.1.2");
    expect(plugin?.satisfies).toContain("wcag22:1.1.1");
  });

  it("omits the plugin rule when the session uses the default built-ins-only registry", async () => {
    const payload = JSON.parse(
      await callTool("list_rules", {}, builtinsOnlySession()),
    ) as ListRulesPayload;
    const ids = payload.rules.map((r) => r.id);
    expect(ids).not.toContain(PLUGIN_RULE_ID);
    // Confirms the override is the seam, not a global mutation — a
    // second session constructed without it stays on built-ins.
    expect(ids).toContain("media/alt-text-missing");
  });
});

describe("plugin registry seam — scan_project", () => {
  it("emits a violation from the plugin rule when scanning a triggering fixture", async () => {
    const payload = JSON.parse(
      await callTool("scan_project", { cwd: scratch }, pluginSession()),
    ) as ScanPayload;

    const pluginHits = payload.files
      .flatMap((f) => f.findings)
      .filter((v) => v.ruleId === PLUGIN_RULE_ID);

    expect(pluginHits.length).toBeGreaterThan(0);
    // Criteria are stamped by the engine from the rule's `satisfies`
    // array; if they go missing, downstream surfaces (`checklist`,
    // `coverage`, the certification scorecard) would silently drop
    // the plugin rule from their per-criterion tallies.
    expect(pluginHits[0]?.criteria).toContain("wcag22:4.1.2");
    expect(pluginHits[0]?.severity).toBe("warning");
  });

  it("does not emit the plugin rule when scanning with the built-ins-only registry", async () => {
    const payload = JSON.parse(
      await callTool("scan_project", { cwd: scratch }, builtinsOnlySession()),
    ) as ScanPayload;

    const pluginHits = payload.files
      .flatMap((f) => f.findings)
      .filter((v) => v.ruleId === PLUGIN_RULE_ID);

    expect(pluginHits.length).toBe(0);
  });
});
