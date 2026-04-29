/**
 * `ra11y --certification` — readiness scorecard as Markdown.
 *
 * Reads `.ra11y-manual.json` from cwd if present to factor manual
 * reviews into the score; otherwise treats manual criteria as
 * pending.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createBuiltinRegistry, type Registry } from "../../engine/registry/registry.ts";
import { type ParsedFile, runScan } from "../../engine/scanner.ts";
import { discoverFiles } from "../../input/discover.ts";
import type { ManualReview } from "../../reports/certification.ts";
import {
  buildCertificationScorecard,
  buildCoverageReport,
  renderCertificationMarkdown,
} from "../../reports/index.ts";
import type { CliOptions } from "../args.ts";
import { ExitCode } from "../exit-codes.ts";
import { parseFor } from "../parse-for.ts";
import type { ScanExit } from "./scan.ts";

export async function runCertification(
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

  const { result } = runScan({
    standards: registry.standards,
    rules: registry.rules,
    enabled: options.standards,
    files: parsed,
    level: options.level,
  });

  const manual = await loadManualReview(cwd);
  const coverage = buildCoverageReport(result, registry.standards);
  const scores = buildCertificationScorecard(coverage, registry.standards, manual, options.level);
  return { stdout: renderCertificationMarkdown(scores), stderr: "", exitCode: ExitCode.OK };
}

async function loadManualReview(cwd: string): Promise<ManualReview> {
  const manualPath = join(cwd, ".ra11y-manual.json");
  if (!existsSync(manualPath)) return {};
  try {
    const raw = await readFile(manualPath, "utf8");
    return JSON.parse(raw) as ManualReview;
  } catch {
    return {};
  }
}
