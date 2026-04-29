/**
 * `ra11y --checklist` — generates a Markdown checklist of every
 * criterion that needs manual review, grouped by standard. Prints
 * to stdout; pipe into a file or a reviewer tool.
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { createBuiltinRegistry, type Registry } from "../../engine/registry/registry.ts";
import { type ParsedFile, runScan } from "../../engine/scanner.ts";
import { discoverFiles } from "../../input/discover.ts";
import {
  buildChecklist,
  buildCoverageReport,
  renderChecklistMarkdown,
} from "../../reports/index.ts";
import type { CliOptions } from "../args.ts";
import { ExitCode } from "../exit-codes.ts";
import { parseFor } from "../parse-for.ts";
import type { ScanExit } from "./scan.ts";

export async function runChecklist(
  options: CliOptions,
  registry: Registry = createBuiltinRegistry(),
): Promise<ScanExit> {
  const cwd = process.cwd();
  const roots = options.positionals.length > 0 ? options.positionals : [cwd];
  const discovered = await discoverFiles(roots, { excludes: options.exclude });

  const parsed: ParsedFile[] = [];
  for (const filePath of discovered) {
    const source = await readFile(filePath, "utf8");
    const ast = parseFor(filePath, source);
    if (!ast) continue;
    parsed.push({ filePath: relative(cwd, filePath), source, ast });
  }

  const { result, report } = runScan({
    standards: registry.standards,
    rules: registry.rules,
    enabled: options.standards,
    files: parsed,
    finders: registry.finders,
    level: options.level,
  });

  // Format violations using the user's chosen format (default: markdown).
  const { BUILTIN_FORMATTERS } = await import("../../output/formatters/index.ts");
  const formatter = BUILTIN_FORMATTERS[options.format];
  const violationsOutput = formatter.format(result, report);

  // Build and render the manual review checklist with candidate locations.
  const coverage = buildCoverageReport(result, registry.standards, options.level);
  const checklist = buildChecklist(coverage, registry.standards, report.candidates ?? []);
  const markdown = renderChecklistMarkdown(checklist);

  // Combine: violations report first, then the manual checklist.
  const combined = `${violationsOutput}\n\n---\n\n${markdown}`;
  return { stdout: combined, stderr: "", exitCode: ExitCode.OK };
}
