/**
 * Test helper: runs a rule end-to-end against a source string.
 *
 * Used by unit tests that want to exercise a rule's check() logic
 * without spinning up a full scan. Parses the source with the right
 * parser for the extension, builds a RuleContext, calls check(),
 * and returns the emitted violations (shaped like real ScanResult
 * violations with ruleId and criteria stamped in).
 */

import { describeNodeShape, findTargetNodeAtLocation } from "../../src/engine/ast-helpers.ts";
import { buildContext } from "../../src/engine/context-builder.ts";
import {
  parseAstro,
  parseCss,
  parseHtml,
  parseLess,
  parseMarkdown,
  parseMdx,
  parseScss,
  parseTsx,
} from "../../src/input/parsers/index.ts";
import type { Ast } from "../../src/types/ast.ts";
import type { EmittedViolation, Language, ProjectContext, Rule } from "../../src/types/rule.ts";
import type { Violation } from "../../src/types/violation.ts";
import { computeFindingGroupId, computeFindingId } from "../../src/utils/finding-id.ts";
import { computeGroupKey, UNKNOWN_SHAPE } from "../../src/utils/group-key.ts";

export interface RunRuleOptions {
  readonly filePath?: string;
  readonly enabledStandards?: readonly string[];
  /**
   * Wrapper component name → native element tag, mirroring
   * `LoadedConfig.nativeWrapperElements`. Rules opted in via
   * `wrapperTreatsAsElement` see the matching wrapper names on
   * `ctx.wrappersForElement` when this is set.
   */
  readonly nativeWrapperElements?: Readonly<Record<string, string>>;
}

export function runRule(
  rule: Rule,
  source: string,
  options: RunRuleOptions = {},
): readonly Violation[] {
  const filePath = options.filePath ?? guessFilePath(source);
  const ast = parseSource(filePath, source);
  const sink: EmittedViolation[] = [];
  const ctx = buildContext(
    {
      filePath,
      source,
      ast,
      enabledStandards: new Set(options.enabledStandards ?? ["wcag22", "wcag21"]),
      disableMap: new Map(),
      ...(options.nativeWrapperElements !== undefined && {
        nativeWrapperElements: options.nativeWrapperElements,
      }),
    },
    sink,
    rule.wrapperTreatsAsElement,
  );
  invokeLifecycle(rule, ctx, ast, filePath, source, sink);
  return sink.map((v) => shapeViolation(rule, v, filePath, source, ast));
}

/** Mirrors the engine's rule-runner lifecycle, plus a single-file afterProject pass. */
function invokeLifecycle(
  rule: Rule,
  ctx: ReturnType<typeof buildContext>,
  ast: Ast,
  filePath: string,
  source: string,
  sink: EmittedViolation[],
): void {
  const fileCtx = { ...ctx, nodes: ast.root };
  rule.beforeFile?.(fileCtx);
  collectReturn(rule.check?.(ctx), sink);
  collectReturn(rule.afterFile?.(fileCtx), sink);
  if (!rule.afterProject) return;
  const projectCtx: ProjectContext = {
    files: [
      {
        filePath,
        source,
        ast: ast.root,
        language: ast.language as Language,
        disableMap: new Map(),
      },
    ],
    enabledStandards: ctx.enabledStandards,
    nativeWrapperElements: {},
    emit: (v) => sink.push(v),
  };
  collectReturn(rule.afterProject(projectCtx), sink);
}

function collectReturn(
  maybe: readonly EmittedViolation[] | undefined,
  sink: EmittedViolation[],
): void {
  if (Array.isArray(maybe)) for (const v of maybe) sink.push(v);
}

function shapeViolation(
  rule: Rule,
  v: EmittedViolation,
  filePath: string,
  source: string,
  ast: Ast,
): Violation {
  const effectivePath = v.location.filePath || filePath;
  // Thread the sub-variant discriminator through so unit-test findingIds
  // match what `stampViolation` in the engine produces. Conditional
  // spread per exactOptionalPropertyTypes.
  const findingId = computeFindingId({
    ruleId: rule.id,
    filePath: effectivePath,
    line: v.location.line,
    column: v.location.column,
    ...(v.variantKey ? { variantKey: v.variantKey } : {}),
  });
  const findingGroupId = computeFindingGroupId({
    ruleId: rule.id,
    filePath: effectivePath,
    source,
    line: v.location.line,
    ...(v.variantKey ? { variantKey: v.variantKey } : {}),
  });
  const node = findTargetNodeAtLocation(ast.root, v.location.line, v.location.column);
  const shape = node ? describeNodeShape(node) : UNKNOWN_SHAPE;
  const groupKey = computeGroupKey({ ruleId: rule.id, shape });
  return {
    ruleId: rule.id,
    fixClass: rule.fixClass,
    criteria: [...rule.satisfies],
    // No standards registry in this test helper path — fall back to the
    // criterion ID for every title (matches `titlesForCriteria`'s
    // "unresolved → ID" contract without pulling the registry in here).
    criteriaTitles: [...rule.satisfies],
    severity: v.severity,
    // Project-scope emitters set filePath themselves; per-file paths fall through.
    location: { ...v.location, filePath: effectivePath },
    // Selector/declaration line split.
    // Mirrors the engine's `stampViolation` conditional spread so unit
    // tests see the same shape the engine ships.
    ...(typeof v.decline === "number" ? { decline: v.decline } : {}),
    message: v.message,
    findingId,
    findingGroupId,
    groupKey,
    ...(v.suggestion !== undefined && { suggestion: v.suggestion }),
    ...(v.fix !== undefined && { fix: v.fix }),
    ...(v.fixPaths !== undefined && { fixPaths: v.fixPaths }),
    ...(v.snippet !== undefined && { snippet: v.snippet }),
    ...(v.couldBeWrongBecause && v.couldBeWrongBecause.length > 0
      ? { couldBeWrongBecause: v.couldBeWrongBecause }
      : {}),
    // Mirror `stampViolation`'s per-finding `confidence` plumbing so
    // unit tests see the same shape the engine ships.
    ...(v.confidence !== undefined && { confidence: v.confidence }),
    // Mirror the engine's `stampViolation` conditional spread for the
    // in-file rule-emitted sibling rollup (-
    // COLLAPSE) so unit tests see the same shape the engine ships.
    ...(v.siblingInstances && v.siblingInstances.length > 0
      ? { siblingInstances: v.siblingInstances }
      : {}),
    // Mirror the engine's `stampViolation` conditional spread for the
    // structured discriminating evidence sub-shape — see Violation.evidence
    // for the surface contract. Unit tests assert on `evidence.kind` and
    // its variant fields (offendingChildTag, predicateBranch, …) so the
    // test helper must round-trip the field exactly the way the engine
    // does at scan time.
    ...(v.evidence !== undefined && { evidence: v.evidence }),
  };
}

function guessFilePath(source: string): string {
  // Heuristic: if it looks like JSX/TS, default to .tsx; otherwise .html.
  if (/=\s*</.test(source) || /\bconst\b|\blet\b|\bfunction\b/.test(source)) return "input.tsx";
  return "input.html";
}

function parseSource(filePath: string, source: string): Ast {
  if (
    filePath.endsWith(".html") ||
    filePath.endsWith(".htm") ||
    // `.xhtml` is XML-serialized HTML; the HTML tokenizer tolerates
    // the `<?xml ... ?>` prologue and self-closing tags so every
    // `.html`-scoped rule applies (see `src/utils/path.ts`).
    filePath.endsWith(".xhtml") ||
    // `.svg` routes through `parseHtml` via the `parseSvg` adapter in
    // production (see `src/input/parsers/svg.ts`). Unit tests that
    // point `filePath` at an `.svg` get the same HTML-AST shape.
    filePath.endsWith(".svg")
  ) {
    const result = parseHtml(source);
    return { language: "html", root: result.root, errors: result.errors };
  }
  if (
    filePath.endsWith(".md") ||
    filePath.endsWith(".markdown") ||
    // `.mkdn` is a common alternate Markdown extension (Vim, older
    // static-site generators); routes through the same `parseMarkdown`
    // adapter as `.md` / `.markdown`.
    filePath.endsWith(".mkdn")
  ) {
    // `.md` / `.markdown` route through `parseMarkdown` in production
    // (ADR 0025 Option B): markdown syntax is stripped, `![alt](url)`
    // is rewritten to `<img>`, and the residue feeds `parseHtml`.
    // Unit tests that point `filePath` at an `.md` file exercise the
    // same residue the HTML-family rules see at scan time.
    const result = parseMarkdown(source);
    return { language: "html", root: result.root, errors: result.errors };
  }
  if (filePath.endsWith(".mdx")) {
    // `.mdx` routes through `parseMdx` in production: TSX-frame parse
    // plus a docs-component code-prop pass that extracts `<Example
    // code={`…`}/>` template-literal HTML and synthesizes JSX elements
    // for it (see `mdx-example-extractor.ts`). Unit tests that point
    // `filePath` at an `.mdx` file exercise the same AST shape rules
    // see at scan time, including the `synthesized` origin marker on
    // elements derived from code-prop bodies.
    const result = parseMdx(source);
    return { language: "tsx", root: result.root, errors: result.errors };
  }
  if (filePath.endsWith(".astro")) {
    // `.astro` routes through `parseAstro` which strips the component
    // script frontmatter and feeds the template region to `parseHtml`,
    // producing `language: "html"`. Unit tests that point `filePath`
    // at an `.astro` file exercise the same AST shape HTML-family
    // rules see at scan time.
    const result = parseAstro(source);
    return { language: "html", root: result.root, errors: result.errors };
  }
  if (filePath.endsWith(".erb")) {
    // `.erb` (Ruby embedded-templates — Rails / Middleman / Jekyll)
    // routes straight to `parseHtml` in production: the HTML parser's
    // `stripTemplateDirectives` pass removes `<%= … %>` / `<% … %>` /
    // `<%# … %>` from text nodes so rules see the rendered-text shape.
    const result = parseHtml(source);
    return { language: "html", root: result.root, errors: result.errors };
  }
  if (filePath.endsWith(".css")) {
    const result = parseCss(source);
    return { language: "css", root: result.root, errors: result.errors };
  }
  if (filePath.endsWith(".scss")) {
    // SCSS source preprocesses to a CSS-shaped AST (`src/input/parsers/
    // scss.ts`); production scan/conformance commands route the same
    // way. Unit tests that point `filePath` at an `.scss` file exercise
    // the same AST shape the CSS-family rules see at scan time.
    const result = parseScss(source);
    return { language: "css", root: result.root, errors: result.errors };
  }
  if (filePath.endsWith(".less")) {
    // Same adapter pattern as `.scss` — the Less preprocessor emits a
    // CSS AST so downstream CSS rules consume it unchanged.
    const result = parseLess(source);
    return { language: "css", root: result.root, errors: result.errors };
  }
  const result = parseTsx(source);
  return { language: "tsx", root: result.root, errors: result.errors };
}
