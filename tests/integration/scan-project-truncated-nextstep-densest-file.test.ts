/**
 * Pins the truncated/bulk-catalog `nextStep` reroute target: under
 * truncation conditions, `nextStepStructured` (or its alternative
 * carried via `nextStepStructuredAlternatives` when the paging-hint
 * overlay is in play) MUST route to the densest file for the dominant
 * rule — i.e. `topRules[0].topFile` — rather than the alphabetically-
 * first file containing that rule.
 *
 * Field-report repro (vanilla-stack catalog):
 *
 *   - dominant rule: `keyboard/handler-missing`
 *   - `topRules[0].topFile`: `drawing-app/script.js` (43 fires in the
 *     real corpus; condensed here)
 *   - alphabetical first containing the rule:
 *     `3d-boxes-background/script.js` (1 fire)
 *
 * Pre-fix: `firstNonVendorFindingMatchingCount` walked files in
 * iteration order (alphabetical) and returned the first one whose
 * ruleId hit the top count, landing on `3d-boxes-background/script.js`.
 *
 * Post-fix: `densestFileFindingForRule` picks the file with the most
 * occurrences of the dominant rule, landing on `drawing-app/script.js`.
 *
 * The integration test routes through the MCP server (stdio JSON-RPC)
 * so the assertion exercises the full response-assembly path:
 * scan-project handler + paginate-files + buildNextStep + paging-hint
 * overlay + envelope shape. A unit-level test in
 * `tests/unit/mcp/next-step.test.ts` covers the picker in isolation;
 * this test guards the wiring an agent actually sees.
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
 * Builds a synthetic vanilla-stack catalog with one dense file (many
 * fires of the same rule) and N siblings (one fire each), where the
 * dense file sorts AFTER the siblings alphabetically. The dominant
 * rule's `topFile` is the dense file; the alphabetically-first file
 * containing the rule is one of the siblings — exactly the field-
 * report regression shape.
 *
 * Each `<div>` carries `role="button"` + `onclick` but lacks a
 * keyboard handler so the `keyboard/handler-missing` rule fires.
 */
function buildCatalogWithDenseFile(root: string): {
  readonly denseSubdir: string;
  readonly siblingSubdirs: readonly string[];
} {
  // Sibling subdirs sort alphabetically before the dense one. Each
  // contains an `index.html` carrying ONE keyboard/handler-missing
  // finding (a `<div role="button" onclick>` element with no keyboard
  // affordance — the canonical fire shape for the rule).
  const siblings = ["3d-boxes-background", "another-app"];
  for (const name of siblings) {
    const dir = posixJoin(root, name);
    mkdirSync(dir);
    writeFileSync(
      posixJoin(dir, "index.html"),
      `<!DOCTYPE html><html lang="en"><head><title>${name}</title></head><body>
<div role="button" onclick="alert('hi')">Click me</div>
</body></html>\n`,
    );
  }
  // Dense subdir — sorts AFTER `3d-boxes-background` and
  // `another-app` alphabetically. Carries multiple
  // `keyboard/handler-missing` violations so its count dominates.
  const denseSubdir = "drawing-app";
  const denseDir = posixJoin(root, denseSubdir);
  mkdirSync(denseDir);
  const denseFindings = Array.from({ length: 5 }, (_, i) => i + 1)
    .map(
      (i) =>
        `<div role="button" onclick="alert('${i}')" id="btn-${i}">Tool ${i}</div>`,
    )
    .join("\n");
  writeFileSync(
    posixJoin(denseDir, "index.html"),
    `<!DOCTYPE html><html lang="en"><head><title>drawing</title></head><body>
${denseFindings}
</body></html>\n`,
  );
  return { denseSubdir, siblingSubdirs: siblings };
}

function pickStructuredEntries(body: Record<string, unknown>): {
  readonly primary?: { tool?: string; args?: Record<string, unknown> };
  readonly alternatives: readonly { tool?: string; args?: Record<string, unknown> }[];
} {
  const primary = body["nextStepStructured"] as
    | { tool?: string; args?: Record<string, unknown> }
    | undefined;
  const alternatives =
    (body["nextStepStructuredAlternatives"] as
      | { tool?: string; args?: Record<string, unknown> }[]
      | undefined) ?? [];
  return { ...(primary === undefined ? {} : { primary }), alternatives };
}

/**
 * Locates the per-finding triage call (`suggest_fix` / `explain_rule`)
 * across the primary `nextStepStructured` and the alternatives array.
 * On truncated responses with the paging-hint overlay in play, the
 * triage call moves into `nextStepStructuredAlternatives[0]`; on
 * smaller-scale truncation paths it stays as the primary. The
 * doctrine pin is on the triage call's target file, not on which slot
 * carries it.
 */
function findTriageCall(body: Record<string, unknown>):
  | { readonly tool: string; readonly args: Record<string, unknown> }
  | undefined {
  const { primary, alternatives } = pickStructuredEntries(body);
  const candidates = [primary, ...alternatives].filter(
    (c): c is { tool?: string; args?: Record<string, unknown> } => c !== undefined,
  );
  for (const c of candidates) {
    if (c.tool === "suggest_fix" || c.tool === "explain_rule") {
      if (c.args !== undefined) {
        return { tool: c.tool, args: c.args };
      }
    }
  }
  return undefined;
}

describe("scan_project truncated nextStep targets densest file for dominant rule", () => {
  it("routes triage call to topRules[0].topFile (densest), not the alphabetically-first file", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-q16-densest-"));
    try {
      const { denseSubdir, siblingSubdirs } = buildCatalogWithDenseFile(root);
      // `limit: 1` forces truncation regardless of file count, so the
      // truncated-response reroute lane fires on this small synthetic
      // fixture without having to materialize 1800+ files. The bug
      // doesn't depend on inventory size — it manifests any time the
      // truncated reroute walks files looking for the dominant rule.
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, limit: 1 }),
      ]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);

      // Sanity: response IS truncated so the reroute should engage.
      expect(body.truncated).toBe(true);

      // Sanity: topRules[0] names the dominant rule and its topFile is
      // the dense subdir's index.html — that's the file the triage
      // call must land on.
      const plan = body.plan as Record<string, unknown> | undefined;
      const topRules = plan?.topRules as
        | readonly { ruleId?: string; topFile?: string }[]
        | undefined;
      expect(Array.isArray(topRules)).toBe(true);
      expect(topRules?.length).toBeGreaterThan(0);
      const topRule = topRules?.[0];
      expect(topRule?.ruleId).toBeDefined();
      expect(topRule?.topFile).toBeDefined();
      expect(topRule?.topFile).toContain(denseSubdir);

      // The load-bearing pin: under truncation/bulk-catalog
      // conditions, the next-step recommendation must NAME the
      // densest file for the dominant rule (= `topRules[0].topFile`)
      // somewhere the agent will read it. Two surfaces share the
      // load: the structured `suggest_fix` call's `file` arg when a
      // mechanical/guidance fix exists, and the prose otherwise (the
      // `verify-in-source` lane structured-points at `explain_rule`,
      // which carries only `ruleId` — the densest file is named in
      // the prose as the verify target).
      //
      // The pre-fix bug was that the prose (and any `file`-carrying
      // structured call) named the alphabetically-first file
      // containing the dominant rule, NOT the densest file. The
      // doctrine pin: whichever channel names a file under truncation
      // must point at the dense file, never at the alphabetically-
      // first sibling.
      const triage = findTriageCall(body);
      expect(triage).toBeDefined();
      const triageFile = triage?.args?.["file"];
      const prose = (body["nextStep"] as string | undefined) ?? "";
      // The prose must name the densest file (topRules[0].topFile)
      // and must NOT route the agent at the alphabetically-first
      // sibling.
      const topFile = topRule?.topFile as string | undefined;
      expect(typeof topFile).toBe("string");
      expect(prose).toContain(topFile as string);
      // Whichever channel carries a file arg must equal topFile, not
      // the sibling. If no `file` arg is present (explain_rule), the
      // prose check above already pins the routing.
      if (typeof triageFile === "string") {
        expect(triageFile).toBe(topFile);
      }
      // The alphabetically-first sibling MUST NOT appear as the
      // routed verify target — checked via the verify-after-fix
      // tail prose ("verify with `scan_file <path>`") which echoes
      // whichever file the structured pick named.
      const alphabeticalFirstSibling = siblingSubdirs[0];
      // The reroute prose names `<sibling>` only as the rerouted-FROM
      // reason ("first-by-filename pick (`<sibling>`) is low-impact").
      // The verify-after target named in the same prose must be the
      // densest file. Anchor by checking `scan_file <path>` slice.
      const verifyAfterMatch = prose.match(/`scan_file ([^`]+)`/);
      if (verifyAfterMatch) {
        expect(verifyAfterMatch[1]).toBe(topFile);
        expect(verifyAfterMatch[1]?.includes(`${alphabeticalFirstSibling}/`)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
