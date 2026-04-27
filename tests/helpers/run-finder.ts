/**
 * Test helper: runs a candidate finder against a source string.
 *
 * Structurally parallel to run-rule.ts but returns ReviewCandidate[]
 * instead of Violation[].
 */

import { buildContext } from "../../src/engine/context-builder.ts";
import { parseCss, parseHtml, parseMarkdown, parseTsx } from "../../src/input/parsers/index.ts";
import type { Ast } from "../../src/types/ast.ts";
import type {
  CandidateFinder,
  ProjectCandidateContext,
  ReviewCandidate,
} from "../../src/types/review.ts";
import type { EmittedViolation } from "../../src/types/rule.ts";

export interface RunFinderOptions {
  readonly filePath?: string;
  readonly enabledStandards?: readonly string[];
}

export function runFinder(
  finder: CandidateFinder,
  source: string,
  options: RunFinderOptions = {},
): readonly ReviewCandidate[] {
  const filePath = options.filePath ?? guessFilePath(source);
  const ast = parseSource(filePath, source);
  const sink: EmittedViolation[] = [];
  const enabledStandards = new Set(options.enabledStandards ?? ["wcag22", "wcag21"]);
  const ctx = buildContext(
    {
      filePath,
      source,
      ast,
      enabledStandards,
      disableMap: new Map(),
    },
    sink,
  );

  if (finder.find) {
    return finder.find(ctx) ?? [];
  }
  if (finder.afterFile) {
    const fileCtx = { ...ctx, nodes: ast.root };
    return finder.afterFile(fileCtx) ?? [];
  }
  if (finder.afterProject) {
    // Single-file ProjectCandidateContext — mirrors run-rule.ts's
    // afterProject pass so unit tests for cross-file finders can
    // exercise the project-scope hook without spinning up runScan.
    const projectCtx: ProjectCandidateContext = {
      files: [
        {
          filePath,
          source,
          ast,
          disableMap: new Map(),
        },
      ],
      enabledStandards,
    };
    return finder.afterProject(projectCtx) ?? [];
  }
  return [];
}

function guessFilePath(source: string): string {
  if (/=\s*</.test(source) || /\bconst\b|\blet\b|\bfunction\b/.test(source)) return "input.tsx";
  return "input.html";
}

function parseSource(filePath: string, source: string): Ast {
  if (filePath.endsWith(".html") || filePath.endsWith(".htm")) {
    const result = parseHtml(source);
    return { language: "html", root: result.root, errors: result.errors };
  }
  if (filePath.endsWith(".md") || filePath.endsWith(".markdown")) {
    // `.md` / `.markdown` route through `parseMarkdown` in production
    // (ADR 0025 Option B): markdown syntax is stripped, `![alt](url)`
    // is rewritten to `<img>`, and the residue feeds `parseHtml`.
    // Unit tests that point `filePath` at an `.md` file exercise the
    // same residue the HTML-family finders see at scan time.
    const result = parseMarkdown(source);
    return { language: "html", root: result.root, errors: result.errors };
  }
  if (filePath.endsWith(".css")) {
    const result = parseCss(source);
    return { language: "css", root: result.root, errors: result.errors };
  }
  const result = parseTsx(source);
  return { language: "tsx", root: result.root, errors: result.errors };
}
