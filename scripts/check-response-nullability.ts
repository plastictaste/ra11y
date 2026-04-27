#!/usr/bin/env bun
/**
 * Enforces AI-first consumer doctrine on MCP response shapes: optional
 * fields must be present-when-meaningful, not sentinel-empty.
 *
 * A response-builder object literal (an argument to `textResult(...)` or
 * `errorResult(...)`, or an object nested inside one) must not contain
 * properties of the form:
 *
 *   field: <expr> ?? null
 *   field: <expr> ?? []
 *   field: <expr> ?? ""
 *   field: <expr> ?? 0
 *
 * These sentinels force the agent to disambiguate "field unavailable"
 * from "field genuinely empty" — the ambiguity is silent and the
 * downstream mistake is irreversible (CLAUDE.md §1, "Ambiguous field
 * shapes are dishonest"). The correct pattern is conditional-spread at
 * the assembly site:
 *
 *   ...(value ? { field: value } : {})
 *
 * This check walks `src/mcp/**` via the TypeScript compiler API,
 * identifies object-literal properties with `??` fallbacks to those four
 * sentinels, and ascends the AST looking for an enclosing `textResult(`
 * or `errorResult(` call. When found, the property is flagged unless it
 * appears in ALLOWLIST below.
 *
 * Allowlist entries are structured tuples of { file, property, reason }.
 * Adding a new entry must come with a doc-comment above the site
 * explaining the semantic reason the null/sentinel is load-bearing
 * (e.g. `null` is emitted, not omitted — the attempt is meaningful).
 * The canonical pre-existing exception is
 * `detect-wrappers-core.ts::definitionFile`.
 *
 * Input-param normalization (`const x = strParam(params, "x") ?? ""`)
 * does not flow through a response-destined object literal — the check
 * never sees it because the ancestor walk stops at the nearest
 * `textResult(`/`errorResult(` call, and local-variable `??` fallbacks
 * don't intersect that path. No explicit carve-out is needed for them.
 *
 * The core `findResponseSentinelViolations` function is exported so the
 * unit test suite can feed synthetic sources through it without touching
 * the filesystem. The CLI entrypoint at the bottom walks `src/mcp/**` and
 * exits 0 on success, 1 on violation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Structured allowlist. Each entry names a file (relative to repo root),
 * a property name, and a human-readable reason. The check matches by
 * file + property; that pair is unique in practice and unambiguous.
 *
 * Updating this list is part of the signal — reviewers should ask "why
 * does this field legitimately emit a null/empty sentinel?" before
 * approving. The doctrine is present-when-meaningful; a carve-out must
 * carry its own justification.
 */
export interface AllowlistEntry {
  readonly file: string;
  readonly property: string;
  readonly reason: string;
}

export const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    file: "src/mcp/detect-wrappers-core.ts",
    property: "definitionFile",
    reason:
      "`null` is emitted, not omitted — the scanner attempted to locate the definition and deliberately communicates 'searched, not found'. Omitting would collapse 'unknown' and 'deliberately-absent' into the same shape.",
  },
];

export interface ResponseSentinelViolation {
  readonly file: string;
  readonly line: number;
  readonly property: string;
  readonly fallback: string;
  readonly snippet: string;
}

/**
 * Parses a single TypeScript source string and returns every response-
 * destined object-literal property that falls back to a null/empty
 * sentinel via `??`. `relFile` is the repo-relative path used for
 * matching against ALLOWLIST and for the returned `file` field.
 * `allowlist` is injectable for tests; defaults to the module-level
 * ALLOWLIST.
 */
export function findResponseSentinelViolations(
  source: string,
  relFile: string,
  allowlist: readonly AllowlistEntry[] = ALLOWLIST,
): ResponseSentinelViolation[] {
  const sf = ts.createSourceFile(
    relFile,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const out: ResponseSentinelViolation[] = [];
  visit(sf, relFile, sf, allowlist, out);
  return out;
}

function visit(
  node: ts.Node,
  relFile: string,
  source: ts.SourceFile,
  allowlist: readonly AllowlistEntry[],
  out: ResponseSentinelViolation[],
): void {
  if (ts.isPropertyAssignment(node)) {
    const prop = analyzeProperty(node, relFile, source, allowlist);
    if (prop) out.push(prop);
  }
  ts.forEachChild(node, (child) => visit(child, relFile, source, allowlist, out));
}

/**
 * Returns a violation when:
 *   - the property initializer is `expr ?? <sentinel>`
 *   - the property name is a plain identifier or string
 *   - an enclosing call expression is `textResult(...)` or `errorResult(...)`
 *   - the file + property pair is not allowlisted
 * Returns null otherwise.
 */
function analyzeProperty(
  node: ts.PropertyAssignment,
  relFile: string,
  source: ts.SourceFile,
  allowlist: readonly AllowlistEntry[],
): ResponseSentinelViolation | null {
  const init = node.initializer;
  if (!ts.isBinaryExpression(init)) return null;
  if (init.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return null;

  const fallback = classifySentinel(init.right);
  if (!fallback) return null;

  const propertyName = getPropertyName(node.name);
  if (!propertyName) return null;

  if (!isInsideResponseBuilder(node)) return null;

  if (isAllowlisted(relFile, propertyName, allowlist)) return null;

  const { line } = ts.getLineAndCharacterOfPosition(source, node.getStart(source));
  const snippet = source.text.slice(node.getStart(source), init.getEnd()).replace(/\s+/g, " ");

  return {
    file: relFile,
    line: line + 1,
    property: propertyName,
    fallback,
    snippet,
  };
}

/**
 * Returns the textual form of a null/empty sentinel literal, or null
 * when the right-hand side is some other expression (`?? someOther`,
 * `?? DEFAULT_CONST`, `?? 0n`). Only the four canonical sentinels count
 * as dishonest — other fallbacks are legitimate defaulting.
 */
function classifySentinel(node: ts.Expression): string | null {
  if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isArrayLiteralExpression(node) && node.elements.length === 0) return "[]";
  if (ts.isStringLiteral(node) && node.text === "") return '""';
  if (ts.isNoSubstitutionTemplateLiteral(node) && node.text === "") return "``";
  if (ts.isNumericLiteral(node) && node.text === "0") return "0";
  return null;
}

function getPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * True when an ancestor CallExpression is `textResult(...)` or
 * `errorResult(...)` — the two canonical response-builder entrypoints
 * in tools-helpers.ts. The ancestor walk is unbounded within the file;
 * it stops at either a match (flag) or the file root (pass).
 *
 * This also catches nested object literals inside `errorResult({
 * details: { ... } })` — nested shapes ship to the agent the same way
 * the envelope does, so the doctrine applies identically.
 */
function isInsideResponseBuilder(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === "textResult" || callee.text === "errorResult") {
          return true;
        }
      }
    }
    current = current.parent;
  }
  return false;
}

function isAllowlisted(
  file: string,
  property: string,
  allowlist: readonly AllowlistEntry[],
): boolean {
  return allowlist.some((e) => e.file === file && e.property === property);
}

// ─── CLI entrypoint ─────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir ?? process.cwd(), "..");
const SRC_MCP_DIR = join(ROOT, "src", "mcp");

// Only execute the filesystem walk + exit when invoked directly as the
// entrypoint. Importing the module (e.g. from tests) does not side-effect.
if (import.meta.main) {
  const { violations, filesScanned } = walk(SRC_MCP_DIR);
  if (violations.length > 0) {
    console.error(`\u2717 MCP response-shape sentinel violations (${violations.length}):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.property}: ... ?? ${v.fallback}`);
      console.error(`    ${v.snippet}`);
    }
    console.error(
      "\nFix: conditional-spread at the assembly site — `...(x ? { prop: x } : {})` — so absent fields are omitted, not sentineled.",
    );
    console.error(
      'See docs/kb/architecture/ai-first-consumer.md ("Ambiguous field shapes are dishonest").',
    );
    console.error(
      "\nIf the sentinel is legitimate (the null/empty is meaningful, not a fallback), add a structured entry to ALLOWLIST in scripts/check-response-nullability.ts with a doc-comment at the site explaining why.",
    );
    process.exit(1);
  }
  console.log(
    `\u2713 MCP response shapes: no sentinel fallbacks (${filesScanned} file${filesScanned === 1 ? "" : "s"} scanned${ALLOWLIST.length > 0 ? `, ${ALLOWLIST.length} allowlisted` : ""})`,
  );
  process.exit(0);
}

function walk(dir: string): {
  readonly violations: readonly ResponseSentinelViolation[];
  readonly filesScanned: number;
} {
  const violations: ResponseSentinelViolation[] = [];
  let filesScanned = 0;
  walkInner(dir);
  return { violations, filesScanned };

  function walkInner(d: string): void {
    let entries: readonly string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walkInner(full);
      } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        filesScanned += 1;
        const content = readFileSync(full, "utf8");
        const relFile = relative(ROOT, full);
        const found = findResponseSentinelViolations(content, relFile);
        for (const v of found) violations.push(v);
      }
    }
  }
}
