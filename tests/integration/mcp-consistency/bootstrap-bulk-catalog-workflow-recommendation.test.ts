/**
 * Pins the bulk-catalog → bootstrap.suggestedConfig workflow
 * recommendation end-to-end through the MCP server. When the
 * bulk-catalog detector (`src/mcp/bulk-catalog.ts`) classifies a corpus
 * as `small_demo_catalog` (≥30 sibling subdirs sharing the same per-dir
 * basename signature), `bootstrap.suggestedConfig` must include a
 * paste-safe TS comment block recommending the catalog-shape narrowing
 * workflow (`groupBy: "firstChildDir"` and example `restrictToPaths`)
 * alongside the existing severity-tuning stub.
 *
 * Per the AI-first doctrine "Bootstrap output must be paste-safe" —
 * extension: paste-safety covers workflow recommendations on detected
 * shapes. Without this append, the agent gets severity overrides on
 * the catalog and no scope guidance for the catalog shape that drives
 * the noise floor (one whole-tree scan with `byGroup` rollup, or
 * per-subdir narrowing with `restrictToPaths`).
 *
 * Three invariants pinned:
 *
 *   1. `bootstrap.suggestedConfig` carries the comment block naming
 *      the trigger AND `groupBy: "firstChildDir"` recommendation. The
 *      block lives AFTER `});` so the TS body stays valid.
 *
 *   2. `bootstrap.suggestedConfig` carries an example
 *      `restrictToPaths` line — populated with a concrete example
 *      sibling subdir from the detector's
 *      `siblingShape.exampleSiblings[]` rather than a placeholder.
 *
 *   3. `bootstrap.warningsDetails.bulk_catalog_detected` ships the
 *      same `trigger: "small_demo_catalog"` classification on the
 *      forwarded scan-leg payload — agents reading the warning + the
 *      recommendation see a consistent classification across the two
 *      surfaces (no drift).
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
 * Builds a corpus shaped as N parallel sibling subdirs, each carrying
 * `index.html` + `style.css` + `script.js`. Mirrors the canonical
 * `small_demo_catalog` shape the bulk-catalog detector pins.
 */
function buildSmallDemoCatalog(root: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const dir = `example-${String(i + 1).padStart(2, "0")}`;
    mkdirSync(join(root, dir));
    writeFileSync(
      join(root, dir, "index.html"),
      `<html><body><img src="hero-${i + 1}.png"></body></html>\n`,
    );
    writeFileSync(join(root, dir, "style.css"), `body { color: black; }\n`);
    writeFileSync(join(root, dir, "script.js"), `console.log("example ${i + 1}");\n`);
  }
}

describe("bootstrap: bulk-catalog → suggestedConfig workflow recommendation", () => {
  it("appends groupBy + restrictToPaths recommendation on small_demo_catalog corpus", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-bootstrap-bulk-catalog-"));
    try {
      buildSmallDemoCatalog(root, 30);
      const responses = await mcpSession([initMsg(1), toolCall(2, "bootstrap", { cwd: root })]);
      const bootstrapResp = responses.find((r) => r.id === 2);
      expect(bootstrapResp).toBeDefined();
      const body = bodyOf(bootstrapResp as JsonRpcResponse);

      // Invariant 3: the bulk-catalog warning rides through to bootstrap
      // (warningsDetails forwarded from the scan leg verbatim).
      const warningsDetails = body["warningsDetails"] as Record<string, unknown> | undefined;
      expect(warningsDetails).toBeDefined();
      const bulkCatalog = warningsDetails?.["bulk_catalog_detected"] as
        | { trigger: string; siblingShape?: { exampleSiblings?: readonly string[] } }
        | undefined;
      expect(bulkCatalog).toBeDefined();
      expect(bulkCatalog?.trigger).toBe("small_demo_catalog");

      const suggestedConfig = body["suggestedConfig"] as string | undefined;
      expect(typeof suggestedConfig).toBe("string");
      const config = suggestedConfig as string;

      // Invariant 1: workflow recommendation block appended; trigger
      // named; groupBy: "firstChildDir" recommended.
      expect(config).toContain("Bulk-catalog workflow recommendation");
      expect(config).toContain("trigger: small_demo_catalog");
      expect(config).toContain('groupBy: "firstChildDir"');

      // Invariant 2: restrictToPaths example populated with a concrete
      // sibling subdir from the detector's exampleSiblings.
      expect(config).toContain("restrictToPaths:");
      const firstExample = bulkCatalog?.siblingShape?.exampleSiblings?.[0];
      expect(typeof firstExample).toBe("string");
      expect(config).toContain(JSON.stringify(firstExample));

      // Paste-safety: the recommendation block lives AFTER `});` so the
      // defineConfig body stays the same syntactically-complete TS the
      // pre-existing tests pin. The recommendation comment lines start
      // AFTER the export-default line; assert the order so a future
      // refactor that accidentally injects the comment INSIDE the body
      // (which would fail TS parse) regresses loudly.
      const exportIdx = config.indexOf("export default defineConfig");
      const closeIdx = config.indexOf("});");
      const recommendationIdx = config.indexOf("Bulk-catalog workflow recommendation");
      expect(exportIdx).toBeGreaterThan(-1);
      expect(closeIdx).toBeGreaterThan(exportIdx);
      expect(recommendationIdx).toBeGreaterThan(closeIdx);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not append recommendation when bulk-catalog detector did not fire", async () => {
    // A small project with no bulk-catalog signature — neither the
    // vendor-heavy nor the small-demo trigger fires. The workflow
    // recommendation comment must NOT appear on `suggestedConfig`.
    const root = mkdtempSync(join(tmpdir(), "ra11y-bootstrap-no-catalog-"));
    try {
      writeFileSync(join(root, "index.html"), `<html><body><img src="hero.png"></body></html>\n`);
      const responses = await mcpSession([initMsg(1), toolCall(2, "bootstrap", { cwd: root })]);
      const bootstrapResp = responses.find((r) => r.id === 2);
      const body = bodyOf(bootstrapResp as JsonRpcResponse);

      const suggestedConfig = body["suggestedConfig"] as string | undefined;
      expect(typeof suggestedConfig).toBe("string");
      const config = suggestedConfig as string;
      expect(config).not.toContain("Bulk-catalog workflow recommendation");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
