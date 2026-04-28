/**
 * Pins the file-reach split surfaced on the scan-family `meta` block:
 *
 *   - `filesScanned` — the corpus the scan consumed as input
 *   - `filesWithAnyRuleEvaluated` — files where at least one per-file
 *     rule was evaluated (extension gate matched)
 *   - `filesWithZeroRuleEvaluation` — `filesScanned − filesWithAnyRuleEvaluated`
 *
 * The headline `filesScanned` overstates rule reach when extension
 * gates exclude scanned files (canonical case: a corpus carrying
 * file shapes whose extension is in no active rule's gate). Per
 * `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest": the headline stays; the new fields split the
 * kind, not replace it.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../src/engine/scanner.ts";
import { parseCss, parseHtml } from "../../src/input/parsers/index.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { wcag22 } from "../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../src/types/ast.ts";

function htmlFile(path: string, source: string): ParsedFile {
  const parsed = parseHtml(source);
  const ast: Ast = { language: "html", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

function cssFile(path: string, source: string): ParsedFile {
  const parsed = parseCss(source);
  const ast: Ast = { language: "css", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

/**
 * Builds a ParsedFile carrying an HTML AST under an arbitrary
 * filename extension. Used to drive the rule runner's per-file
 * eligibility check on a file whose extension is in no rule's gate
 * (and not in {@link import("../../src/utils/path.ts").EXTENSION_ALIASES})
 * so the test can assert the rule-unreachable bucket. The AST
 * itself is irrelevant — the gate fires before the rule body runs.
 */
function unreachableExtFile(path: string): ParsedFile {
  const source = `<!doctype html><html lang="en"><head><title>x</title></head><body><h1>Hi</h1></body></html>`;
  const parsed = parseHtml(source);
  const ast: Ast = { language: "html", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

describe("file-reach split (filesWithAnyRuleEvaluated / filesWithZeroRuleEvaluation)", () => {
  it("heterogeneous corpus splits filesScanned into rule-reachable and rule-unreachable", () => {
    // The unreachable file uses an extension absent from every active
    // rule's gate AND from `EXTENSION_ALIASES` (`.foo` is not in the
    // alias table). The `.html` and `.css` files match HTML-shape and
    // CSS-shape rules respectively.
    const files: readonly ParsedFile[] = [
      htmlFile(
        "site/index.html",
        `<!doctype html><html lang="en"><head><title>x</title></head><body><main><h1>Hi</h1></main></body></html>`,
      ),
      cssFile("styles/site.css", `body { color: #000; background: #fff; }`),
      unreachableExtFile("data/notes.foo"),
    ];
    const { result, filesWithAnyRuleEvaluated } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    expect(result.filesScanned).toBe(3);
    expect(filesWithAnyRuleEvaluated).toBe(2);
    // Derived complement: the agent reads "1 file the active rule
    // set could not address" without recomputing.
    const filesWithZeroRuleEvaluation = result.filesScanned - filesWithAnyRuleEvaluated;
    expect(filesWithZeroRuleEvaluation).toBe(1);
  });

  it("monolingual HTML-only corpus reports full rule reach (split == filesScanned)", () => {
    // Sanity: when every file's extension is in some rule's gate, the
    // split collapses to "full reach" and the agent reads
    // `filesWithZeroRuleEvaluation: 0` as confirmation that no
    // file-shape was a no-op for the active rule set.
    const files: readonly ParsedFile[] = [
      htmlFile(
        "a.html",
        `<!doctype html><html lang="en"><head><title>a</title></head><body><h1>a</h1></body></html>`,
      ),
      htmlFile(
        "b.html",
        `<!doctype html><html lang="en"><head><title>b</title></head><body><h1>b</h1></body></html>`,
      ),
    ];
    const { result, filesWithAnyRuleEvaluated } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    expect(result.filesScanned).toBe(2);
    expect(filesWithAnyRuleEvaluated).toBe(2);
    expect(result.filesScanned - filesWithAnyRuleEvaluated).toBe(0);
  });

  it("rule-unreachable-only corpus reports zero rule reach (the silent-miss shape the split surfaces)", () => {
    // The doctrine acute case: `filesScanned > 0` could read as "scan
    // had teeth," but `filesWithAnyRuleEvaluated: 0` honestly says
    // "every file in the corpus was a no-op for the active rule set."
    // Without the split, an agent reading only `filesScanned` would
    // budget against work the scan never did.
    const files: readonly ParsedFile[] = [
      unreachableExtFile("data/_a.foo"),
      unreachableExtFile("data/_b.foo"),
    ];
    const { result, filesWithAnyRuleEvaluated } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    expect(result.filesScanned).toBe(2);
    expect(filesWithAnyRuleEvaluated).toBe(0);
    expect(result.filesScanned - filesWithAnyRuleEvaluated).toBe(2);
  });
});
