/**
 * Canonical ra11y version.
 *
 * Single source of truth for every compliance artifact that identifies
 * the tool: SARIF `tool.driver.version`, VPAT `evaluator`, baseline
 * `ra11yVersion`, JSON formatter `ra11y.version`, terminal banner, CLI
 * `--version`, agent formatter, MCP `serverInfo.version`.
 *
 * Resolves `package.json.version` at module load. Works both from
 * source (`src/version.ts` → `../package.json`) and from the shipped
 * bundle (`dist/<entry>.js` → `../package.json`) — package.json sits
 * at the package root in both layouts.
 *
 * Node 22 compatible; no Bun-specific APIs, no runtime dependencies.
 */

import { readFileSync } from "node:fs";

function loadVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const raw = readFileSync(pkgUrl, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("ra11y: package.json is missing a version string");
  }
  return parsed.version;
}

export const VERSION: string = loadVersion();
