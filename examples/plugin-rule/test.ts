#!/usr/bin/env bun
/**
 * Smoke test for the example rule plugin.
 *
 * Two assertions in increasing realism:
 *   1. The rule loads under the public `defineRule` API and exposes
 *      the expected id / satisfies / docs shape.
 *   2. Composing the rule through `createRegistry({ rules: [rule] })`
 *      and running the `scan` MCP tool against a tiny bad fixture
 *      actually emits a violation with `ruleId ===
 *      "example/no-title-only-label"`. This is the plugin-seam
 *      end-to-end contract the `examples/plugin-rule/README.md`
 *      walkthrough promises — a user rule composed via the seam
 *      reaches `scan_project` without any internal ra11y edit.
 *
 * CI runs this via `bun scripts/verify-plugin-examples.ts` (or
 * equivalent); it can also be invoked directly: `bun test.ts`.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { createRegistry } from "../../src/engine/registry/registry.ts";
import { McpSession } from "../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../src/mcp/tools.ts";
import rule from "./rule.ts";

// ─── Shape smoke ────────────────────────────────────────────────────────────

if (rule.id !== "example/no-title-only-label") {
  console.error(`✗ unexpected id: ${rule.id}`);
  process.exit(1);
}
if (!rule.satisfies.includes("wcag22:4.1.2")) {
  console.error("✗ missing WCAG 4.1.2 in satisfies");
  process.exit(1);
}
if (!rule.docs?.description) {
  console.error("✗ docs.description missing");
  process.exit(1);
}
console.log("✓ example rule plugin loaded with expected shape");

// ─── End-to-end plugin-seam smoke ───────────────────────────────────────────

const scanTool = MCP_TOOLS.find((t) => t.def.name === "scan");
if (scanTool === undefined) {
  console.error("✗ scan tool missing from MCP_TOOLS — plugin seam has nothing to thread");
  process.exit(1);
}

const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-plugin-example-"));
const badFile = joinPath(dir, "bad.html");
await writeFile(
  badFile,
  `<!doctype html><html lang="en"><head><title>t</title></head><body><button title="Close"></button></body></html>`,
);

const registry = createRegistry({ rules: [rule] });
const session = new McpSession(registry);

const result = await scanTool.handler({ paths: [badFile] }, session);
const textPayload = result.content[0]?.text;
if (typeof textPayload !== "string") {
  console.error("✗ scan tool returned no text payload");
  process.exit(1);
}

const parsed = JSON.parse(textPayload) as {
  files?: Array<{ findings?: Array<{ ruleId?: string }> }>;
};
const pluginHits = (parsed.files ?? [])
  .flatMap((f) => f.findings ?? [])
  .filter((v) => v.ruleId === "example/no-title-only-label");

if (pluginHits.length === 0) {
  console.error(
    "✗ scan with plugin registry did not emit any example/no-title-only-label violations",
  );
  console.error(textPayload);
  process.exit(1);
}
console.log(
  `✓ example rule fired via Registry seam (${pluginHits.length} violation${pluginHits.length === 1 ? "" : "s"})`,
);
