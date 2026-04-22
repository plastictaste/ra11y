#!/usr/bin/env bun
/**
 * Enforces AI-first consumer doctrine on MCP response assembly — the
 * rules that {@link check-response-nullability.ts} can't catch because
 * the failure mode is structural rather than per-field-sentinel.
 *
 * Two high-signal patterns are checked here. Both are canonical
 * tripwires from `docs/kb/architecture/ai-first-consumer.md` and
 * `.claude/rules/mcp-response-shapes.md`; both are AST-detectable with
 * the primitives `check-response-nullability.ts` already uses.
 *
 * ## Pattern A — ambiguous `newText: ""` alongside `kind: "edit"`
 *
 * An object literal that carries `kind: "edit"` AND a literal
 * `newText: ""` simultaneously is the canonical "ambiguous field shapes
 * are dishonest" case from the doctrine. The structural lane says "here
 * is a mechanical edit"; the empty-string `newText` says "but there is
 * nothing to write" — a downstream consumer cannot tell whether the
 * tool computed an empty replacement (legitimate delete) or failed to
 * populate the field (structural bug). The honest shapes are either
 * - `kind: "guidance"` when no mechanical edit is available, OR
 * - an explicit delete sentinel the schema documents, OR
 * - omit `newText` entirely and let the caller distinguish via
 *   presence.
 *
 * Empty `newText` under `kind: "edit"` is the failure mode spelled out
 * in `ai-first-consumer.md` by name.
 *
 * ## Pattern B — `plan: { … totalFindings … }` composite counter
 *
 * `plan.totalFindings` was explicitly removed from the scan-family plan
 * block (see `src/mcp/scan-assembly.ts` header comment + ADR 0024) for
 * being a composite headline counter that summed severity-distinct
 * lanes (`violations` + `notes`) under one name — the doctrine's
 * "Composite headline counts are dishonest" rule. Re-introducing a
 * `totalFindings` field inside a `plan:` object literal that flows
 * through `textResult(...)` or `errorResult(...)` is a regression on
 * that lock. The legitimate split is `violations` + `notes` as
 * separate top-level plan fields.
 *
 * Note: `meta.totalFindings` is legitimate in `scan_process` (ADR
 * 0016 — it's a process-level aggregate, not a scan-family plan
 * counter). This check is scoped to `plan:` object literals only, so
 * the process-level case is out of scope by construction. JSON-Schema
 * `properties.totalFindings` in tool `inputSchema` definitions is also
 * unaffected because the schema literal is not emitted through
 * `textResult(...)` / `errorResult(...)`.
 *
 * ## Scope
 *
 * This check walks the AI-first consumer-model paths enumerated in
 * `.claude/rules/mcp-response-shapes.md`:
 *   - `src/mcp/**`
 *   - `src/output/agent-response/**`
 *   - `src/reports/**`
 *   - `src/review/**`
 *
 * The core analyzer (`findResponseAssemblyViolations`) is exported so
 * unit tests can feed synthetic sources through it directly. The CLI
 * entrypoint at the bottom walks the scoped directories and exits 0 on
 * success, 1 on violation.
 *
 * ## Allowlist
 *
 * Structured tuples `{ file, pattern, reason }`. Each entry must carry
 * a doc-comment at the source site explaining why the pattern is
 * load-bearing. The initial allowlist is deliberately tiny — the two
 * patterns above are expensive-to-trip doctrine violations, not
 * common-case carve-outs. Growing the allowlist is itself a signal the
 * reviewer should interrogate.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/** Which of the two patterns a violation represents. */
export type ResponseAssemblyPattern = "newText-empty-with-edit-kind" | "plan-total-findings";

/**
 * Structured allowlist entry. `file` is the repo-relative path; `pattern`
 * is the {@link ResponseAssemblyPattern} constant; `reason` is the
 * human-readable rationale the reviewer reads when touching the
 * allowlist.
 */
export interface AllowlistEntry {
  readonly file: string;
  readonly pattern: ResponseAssemblyPattern;
  readonly reason: string;
}

export const ALLOWLIST: readonly AllowlistEntry[] = [
  // Initial allowlist is empty — the two patterns above are
  // unambiguous doctrine violations, not common carve-outs. When adding
  // an entry, include a doc-comment at the source site explaining the
  // semantic reason the pattern is load-bearing.
];

export interface ResponseAssemblyViolation {
  readonly file: string;
  readonly line: number;
  readonly pattern: ResponseAssemblyPattern;
  readonly snippet: string;
}

/**
 * Parses a single TypeScript source string and returns every response-
 * assembly doctrine violation. `relFile` is the repo-relative path used
 * for matching against ALLOWLIST and for the returned `file` field.
 * `allowlist` is injectable for tests; defaults to the module-level
 * ALLOWLIST.
 */
export function findResponseAssemblyViolations(
  source: string,
  relFile: string,
  allowlist: readonly AllowlistEntry[] = ALLOWLIST,
): ResponseAssemblyViolation[] {
  const sf = ts.createSourceFile(
    relFile,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const out: ResponseAssemblyViolation[] = [];
  visit(sf, relFile, sf, allowlist, out);
  return out;
}

function visit(
  node: ts.Node,
  relFile: string,
  source: ts.SourceFile,
  allowlist: readonly AllowlistEntry[],
  out: ResponseAssemblyViolation[],
): void {
  if (ts.isObjectLiteralExpression(node)) {
    const a = analyzeNewTextEditPattern(node, relFile, source, allowlist);
    if (a) out.push(a);
    const b = analyzePlanTotalFindingsPattern(node, relFile, source, allowlist);
    if (b) out.push(b);
  }
  ts.forEachChild(node, (child) => visit(child, relFile, source, allowlist, out));
}

// ─── Pattern A: newText: "" with kind: "edit" ──────────────────────────────

/**
 * Flags an object literal that carries BOTH `kind: "edit"` (string
 * literal) AND `newText: ""` (empty string literal). The pair is a
 * canonical ambiguous-field-shape failure: the structural lane commits
 * to a mechanical edit while the payload is empty.
 *
 * Only fires when BOTH properties are present as literals — a dynamic
 * `newText: computeText()` or `kind: maybeKind` does not trip, because
 * the check can't reason about runtime values without a type-checker
 * (and the nullability linter already covers `?? ""` fallbacks).
 */
function analyzeNewTextEditPattern(
  node: ts.ObjectLiteralExpression,
  relFile: string,
  source: ts.SourceFile,
  allowlist: readonly AllowlistEntry[],
): ResponseAssemblyViolation | null {
  let hasEditKind = false;
  let emptyNewTextProp: ts.PropertyAssignment | null = null;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = getPropertyName(prop.name);
    if (!name) continue;
    if (name === "kind" && isStringLiteralWithValue(prop.initializer, "edit")) {
      hasEditKind = true;
    }
    if (name === "newText" && isStringLiteralWithValue(prop.initializer, "")) {
      emptyNewTextProp = prop;
    }
  }
  if (!(hasEditKind && emptyNewTextProp)) return null;
  if (!isInsideResponseBuilder(node)) return null;
  if (isAllowlisted(relFile, "newText-empty-with-edit-kind", allowlist)) return null;

  const { line } = ts.getLineAndCharacterOfPosition(source, emptyNewTextProp.getStart(source));
  const snippet = source.text
    .slice(node.getStart(source), node.getEnd())
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return {
    file: relFile,
    line: line + 1,
    pattern: "newText-empty-with-edit-kind",
    snippet,
  };
}

// ─── Pattern B: plan: { … totalFindings … } ───────────────────────────────

/**
 * Flags a property assignment `plan: { … totalFindings … }` where the
 * `plan` initializer is an object literal AND the object literal
 * contains a `totalFindings` property. `totalFindings` was removed
 * from the scan-family plan by ADR 0024 / V1-RESPONSE-ASSEMBLER — it
 * summed severity-distinct lanes under one name, the doctrine's
 * "Composite headline counts are dishonest" case. Legitimate shape:
 * `plan.violations` + `plan.notes` as separate counters.
 *
 * Scoped to `plan:` object literals inside a `textResult(...)` or
 * `errorResult(...)` call so JSON-Schema `properties` definitions
 * (which also declare a `totalFindings` shape for input schemas) are
 * out of scope by construction — those never flow through a response
 * builder.
 */
function analyzePlanTotalFindingsPattern(
  node: ts.ObjectLiteralExpression,
  relFile: string,
  source: ts.SourceFile,
  allowlist: readonly AllowlistEntry[],
): ResponseAssemblyViolation | null {
  // `node` must itself be a `plan: { ... }` initializer — walk up to
  // the parent PropertyAssignment and check the name.
  const parent = node.parent;
  if (!(parent && ts.isPropertyAssignment(parent))) return null;
  if (parent.initializer !== node) return null;
  if (getPropertyName(parent.name) !== "plan") return null;

  let totalFindingsProp: ts.PropertyAssignment | null = null;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = getPropertyName(prop.name);
    if (name === "totalFindings") {
      totalFindingsProp = prop;
      break;
    }
  }
  if (!totalFindingsProp) return null;
  if (!isInsideResponseBuilder(parent)) return null;
  if (isAllowlisted(relFile, "plan-total-findings", allowlist)) return null;

  const { line } = ts.getLineAndCharacterOfPosition(source, totalFindingsProp.getStart(source));
  const snippet = source.text
    .slice(parent.getStart(source), node.getEnd())
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return {
    file: relFile,
    line: line + 1,
    pattern: "plan-total-findings",
    snippet,
  };
}

// ─── Shared helpers ────────────────────────────────────────────────────────

function getPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

function isStringLiteralWithValue(node: ts.Expression, expected: string): boolean {
  if (ts.isStringLiteral(node)) return node.text === expected;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text === expected;
  return false;
}

/**
 * True when an ancestor CallExpression is `textResult(...)` or
 * `errorResult(...)` — the two canonical response-builder entrypoints
 * in `tools-helpers.ts`. Mirrors the ascent used by
 * `check-response-nullability.ts` so both checks answer the same
 * "does this literal ship to an agent?" question.
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
  pattern: ResponseAssemblyPattern,
  allowlist: readonly AllowlistEntry[],
): boolean {
  return allowlist.some((e) => e.file === file && e.pattern === pattern);
}

// ─── CLI entrypoint ─────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir ?? process.cwd(), "..");
const SCAN_DIRS: readonly string[] = [
  join(ROOT, "src", "mcp"),
  join(ROOT, "src", "output", "agent-response"),
  join(ROOT, "src", "reports"),
  join(ROOT, "src", "review"),
];

// Only execute the filesystem walk + exit when invoked directly as the
// entrypoint. Importing the module (e.g. from tests) does not side-effect.
if (import.meta.main) {
  let filesScanned = 0;
  const violations: ResponseAssemblyViolation[] = [];
  for (const dir of SCAN_DIRS) {
    const r = walk(dir);
    filesScanned += r.filesScanned;
    for (const v of r.violations) violations.push(v);
  }
  if (violations.length > 0) {
    console.error(`✗ MCP response-assembly doctrine violations (${violations.length}):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.pattern}]`);
      console.error(`    ${v.snippet}`);
    }
    console.error(
      "\nPattern notes:\n" +
        "  newText-empty-with-edit-kind:\n" +
        '    An object literal with `kind: "edit"` and `newText: ""` is an ambiguous\n' +
        '    field shape. Use `kind: "guidance"` when there is no mechanical edit, or\n' +
        "    omit `newText` entirely so presence-vs-absence carries the signal.\n" +
        "  plan-total-findings:\n" +
        "    `plan.totalFindings` is the composite headline counter ADR 0024 removed — it\n" +
        "    sums severity-distinct lanes under one name. Split into `plan.violations` +\n" +
        "    `plan.notes` (see src/mcp/scan-assembly.ts).\n",
    );
    console.error(
      "See docs/kb/architecture/ai-first-consumer.md and .claude/rules/mcp-response-shapes.md for the full doctrine.",
    );
    console.error(
      "\nIf the pattern is legitimate in your call site, add a structured entry to ALLOWLIST in scripts/check-response-assembly.ts with a doc-comment at the site explaining why.",
    );
    process.exit(1);
  }
  console.log(
    `✓ MCP response assembly: doctrine clean (${filesScanned} file${filesScanned === 1 ? "" : "s"} scanned${ALLOWLIST.length > 0 ? `, ${ALLOWLIST.length} allowlisted` : ""})`,
  );
  process.exit(0);
}

function walk(dir: string): {
  readonly violations: readonly ResponseAssemblyViolation[];
  readonly filesScanned: number;
} {
  const violations: ResponseAssemblyViolation[] = [];
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
        const found = findResponseAssemblyViolations(content, relFile);
        for (const v of found) violations.push(v);
      }
    }
  }
}
