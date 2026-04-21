/**
 * `ra11y --list-standards` — prints every loaded standard with its
 * version, publisher, URL, and criterion counts broken down by level.
 */

import { createBuiltinRegistry, type Registry } from "../../engine/registry/registry.ts";
import type { Standard } from "../../types/standard.ts";
import { ExitCode } from "../exit-codes.ts";
import type { ScanExit } from "./scan.ts";

export function runListStandards(registry: Registry = createBuiltinRegistry()): ScanExit {
  const lines: string[] = [];
  lines.push("");
  lines.push("  Standards:");
  lines.push("");
  for (const std of registry.standards) {
    lines.push(`    ${std.id}  ${std.name} v${std.version}  (${std.publisher})`);
    lines.push(`      ${std.url}`);
    const counts = countByLevel(std);
    lines.push(`      criteria: ${std.criteria.length} total · ${renderCounts(counts)}`);
    lines.push("");
  }
  lines.push(
    `  ${registry.standards.length} standard${registry.standards.length === 1 ? "" : "s"} loaded.`,
  );
  lines.push("");
  return { stdout: lines.join("\n"), stderr: "", exitCode: ExitCode.OK };
}

function countByLevel(std: Standard): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of std.criteria) {
    counts[c.level] = (counts[c.level] ?? 0) + 1;
  }
  return counts;
}

function renderCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([level, count]) => `${count} ${level}`)
    .join(", ");
}
