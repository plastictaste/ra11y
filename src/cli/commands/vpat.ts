/**
 * `ra11y --vpat` — VPAT 2.5 Rev conformance report as Markdown.
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { createBuiltinRegistry, type Registry } from "../../engine/registry/registry.ts";
import { type ParsedFile, runScan } from "../../engine/scanner.ts";
import { discoverFiles } from "../../input/discover.ts";
import { parseHtml, parseTsx } from "../../input/parsers/index.ts";
import { detectApplicability } from "../../mcp/manual-applicability.ts";
import { buildVpatReport, renderVpatMarkdown } from "../../reports/index.ts";
import type { VpatProductMetadata } from "../../reports/vpat.ts";
import type { Ast } from "../../types/ast.ts";
import type { CliOptions } from "../args.ts";
import { ExitCode } from "../exit-codes.ts";
import type { ScanExit } from "./scan.ts";

export async function runVpat(
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

  const { result, report: scanReport } = runScan({
    standards: registry.standards,
    rules: registry.rules,
    enabled: options.standards,
    files: parsed,
    finders: registry.finders,
    level: options.level,
  });

  const applicability = detectApplicability(parsed);

  const report = buildVpatReport(result, registry.standards, {
    generatedAt: FIXED_TIMESTAMP,
    candidates: scanReport.candidates ?? [],
    applicability,
    product: productMetadataFromEnv(),
  });
  const markdown = renderVpatMarkdown(report);
  return { stdout: markdown, stderr: "", exitCode: ExitCode.OK };
}

// Used when the test environment sets this to keep snapshots stable.
const FIXED_TIMESTAMP = process.env.RA11Y_FIXED_TIMESTAMP ?? new Date().toISOString();

/**
 * Reads product-metadata inputs from environment variables. Keeps the
 * CLI flag surface unchanged while letting procurement-facing callers
 * (CI, release pipelines) supply real values without editing their
 * VPAT output by hand. Unset variables leave the builder's template
 * placeholders in place so the gap is visible to the VPAT reader.
 */
function productMetadataFromEnv(): Partial<VpatProductMetadata> {
  const env = process.env;
  const name = env["RA11Y_VPAT_PRODUCT_NAME"];
  const version = env["RA11Y_VPAT_PRODUCT_VERSION"];
  const email = env["RA11Y_VPAT_CONTACT_EMAIL"];
  const org = env["RA11Y_VPAT_CONTACT_ORGANIZATION"];
  const methods = env["RA11Y_VPAT_EVALUATION_METHODS"];
  const notes = env["RA11Y_VPAT_NOTES"];
  return {
    ...(name ? { productName: name } : {}),
    ...(version ? { productVersion: version } : {}),
    ...(email ? { contactEmail: email } : {}),
    ...(org ? { contactOrganization: org } : {}),
    ...(methods ? { evaluationMethods: methods } : {}),
    ...(notes ? { notesOnEvaluation: notes } : {}),
  };
}

function parseFor(filePath: string, source: string): Ast | null {
  if (filePath.endsWith(".html") || filePath.endsWith(".htm")) {
    const r = parseHtml(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".jsx") ||
    filePath.endsWith(".ts") ||
    filePath.endsWith(".js")
  ) {
    const r = parseTsx(source, { filePath });
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  return null;
}
