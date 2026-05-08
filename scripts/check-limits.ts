#!/usr/bin/env bun
/**
 * Enforces file-size, function-size, and nesting-depth budgets across
 * src/. Complexity is already enforced by Biome's
 * noExcessiveCognitiveComplexity rule, so we don't duplicate that here.
 *
 * Budgets are chosen to match CLAUDE.md §3's "small, auditable, no magic"
 * principle:
 *
 *   - file lines      ≤  500   (excluding blank lines and comment-only lines)
 *   - function lines  ≤  120   (same counting rules)
 *   - nesting depth   ≤    5   (braces deep, excluding the function body's own brace)
 *
 * Function extraction is a light regex walk — we don't parse TypeScript.
 * It's good enough to catch "this function is too big" without
 * pulling in a real parser. Anything more rigorous belongs in a
 * linter rule, not a CI guard.
 *
 * Exits 0 on success, 1 on violation with file:line diagnostics.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir ?? process.cwd(), "..");
const SRC_DIR = join(ROOT, "src");

const MAX_FILE_LINES = 500;
const MAX_FUNCTION_LINES = 120;
const MAX_NESTING_DEPTH = 5;

/**
 * Tighter per-file budgets scoped to a path pattern. Each entry
 * overrides the default `MAX_FILE_LINES` for files whose relative
 * path matches `pattern`.
 *
 * `src/mcp/tool-*.ts` gets a 150-line budget because — after the
 * ADR 0024 response-assembler migration — handler work that belongs
 * in the assembler should live in the assembler. A handler still
 * exceeding the budget is a signal to extract, not to loosen. The
 * `// ra11y-limits-exempt: <reason>` pragma (see below) is the
 * escape hatch for files that legitimately outgrow the budget
 * during a staged migration; the reason is grep-able so exemption
 * decay stays visible.
 */
interface ScopedBudget {
  readonly pattern: RegExp;
  readonly maxFileLines: number;
  readonly label: string;
}
const SCOPED_FILE_BUDGETS: readonly ScopedBudget[] = [
  {
    pattern: /^src\/mcp\/tool-[^/]+\.ts$/,
    maxFileLines: 150,
    label: "MCP handler",
  },
];

/**
 * Files exempted from the file-line budget. These are pure-data
 * modules where splitting would fragment a single canonical table.
 * Function-line and nesting budgets still apply — this only waives
 * the whole-file count.
 */
const DATA_FILE_EXEMPTIONS: readonly RegExp[] = [
  /src\/standards\/[^/]+\/criteria\.ts$/,
  /src\/standards\/wcag-shared\/rows\.ts$/,
];

/**
 * Per-file escape hatch for scoped budgets. A file declares one
 * by placing a line shaped `// ra11y-limits-exempt: <reason>` in
 * its first 20 lines (i.e. the top-of-file docblock area). The
 * reason is required and non-empty — a bare pragma without a
 * reason is treated as missing.
 *
 * Rationale: grep-able exemptions make it trivial to audit which
 * files are still outside the budget and why. Exemptions are
 * expected to decay as migrations land.
 */
const LIMITS_EXEMPT_RE = /\/\/\s*ra11y-limits-exempt\s*:\s*(\S.*?)\s*$/;
const LIMITS_EXEMPT_HEADER_LINES = 20;

/**
 * Transitional allowlist for scoped file budgets, paired with the
 * in-source pragma above. Each entry is an (path, reason) pair — the
 * reason is not enforced programmatically but MUST be kept current
 * (stripped when the file shrinks under-budget; updated when its
 * rationale changes).
 *
 * Intent: this list shrinks monotonically as ADR 0024's shared
 * response-assembler migrations land. Every commit that brings a file
 * under the scoped budget deletes the corresponding entry here. A
 * new file exceeding a scoped budget chooses between (a) extracting
 * work into the assembler/helpers (preferred) or (b) carrying the
 * in-source pragma; this script-level allowlist is reserved for
 * files that currently over-run the budget for reasons tied to the
 * staged migration itself.
 */
interface HandlerBudgetExemption {
  readonly path: string;
  readonly reason: string;
}
const HANDLER_BUDGET_EXEMPTIONS: readonly HandlerBudgetExemption[] = [
  // Scan-family handlers — migrate through assembleScanFamilyResponse.
  // Extract call-sites shrink once the shared assembler owns
  // plan/meta/warnings emission.
  {
    path: "src/mcp/tool-scan.ts",
    reason: "scan-family handler, pending extraction into shared response assembler",
  },
  {
    path: "src/mcp/tool-scan-file.ts",
    reason: "scan-family handler, pending extraction into shared response assembler",
  },
  {
    path: "src/mcp/tool-scan-project.ts",
    reason: "scan-family handler, pending extraction into shared response assembler",
  },
  {
    path: "src/mcp/tool-scan-process.ts",
    reason: "per-page ScanResult[] shape (ADR 0016) stays outside assembler by design",
  },
  {
    path: "src/mcp/tool-scan-diff.ts",
    reason: "scan-family handler, pending extraction into shared response assembler",
  },
  {
    path: "src/mcp/tool-checklist.ts",
    reason: "scan-family derivative, pending extraction",
  },
  {
    path: "src/mcp/tool-coverage.ts",
    reason: "scan-family derivative, pending extraction",
  },
  {
    path: "src/mcp/tool-conformance-statement.ts",
    reason: "scan-family derivative, pending extraction",
  },
  {
    path: "src/mcp/tool-review-candidates.ts",
    reason: "scan-family derivative, pending extraction",
  },
  // Fix-family handlers — shape call blocked on the fix-family response
  // shape decision (baseline.check/apply_fix/suggest_fix have bespoke
  // meta shapes that can't be forced through the scan-family assembler).
  {
    path: "src/mcp/tool-apply-fix-internals.ts",
    reason: "fix-family internals, pending decision",
  },
  {
    path: "src/mcp/tool-baseline.ts",
    reason: "fix-family handler, pending decision",
  },
  // Non-scan-family handlers that host synthesis, sampling, or
  // enumeration logic not covered by any assembler. These are candidates
  // for per-tool extract-and-shrink work scheduled after the ADR 0024
  // migrations converge.
  {
    path: "src/mcp/tool-attest.ts",
    reason: "evidence-ledger write + field-coercion logic; candidate for later extract-and-shrink",
  },
  {
    path: "src/mcp/tool-audit.ts",
    reason: "meta-tool composing three handlers; candidate for later extract-and-shrink",
  },
  {
    path: "src/mcp/tool-bootstrap.ts",
    reason:
      "meta-tool composing four onboarding primitives; candidate for later extract-and-shrink",
  },
  {
    path: "src/mcp/tool-draft-vpat-narrative.ts",
    reason: "host-sampling narrative drafting; candidate for later extract-and-shrink",
  },
  {
    path: "src/mcp/tool-list-suppressions.ts",
    reason: "pragma enumeration across scanned tree; candidate for later extract-and-shrink",
  },
  {
    path: "src/mcp/tool-propose-config.ts",
    reason: "config synthesis from scan state; candidate for later extract-and-shrink",
  },
  {
    path: "src/mcp/tool-suppress.ts",
    reason: "pragma-insertion across comment shapes; candidate for later extract-and-shrink",
  },
  {
    path: "src/mcp/tool-verdict-candidate.ts",
    reason: "host-sampling verdict dispatch; candidate for later extract-and-shrink",
  },
  {
    path: "src/mcp/tool-vpat.ts",
    reason: "VPAT 2.5 Rev report assembly; candidate for later extract-and-shrink",
  },
  {
    path: "src/mcp/tool-wrapper-introspect.ts",
    reason: "AST probe per-candidate (ADR 0012); candidate for later extract-and-shrink",
  },
];
const HANDLER_BUDGET_EXEMPTION_PATHS: ReadonlySet<string> = new Set(
  HANDLER_BUDGET_EXEMPTIONS.map((e) => e.path),
);

const violations: string[] = [];

walk(SRC_DIR);
checkAllowlistIntegrity();

if (violations.length > 0) {
  console.error("✗ limits guard violated:\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    `\nFix: split the file/function, or flatten the nesting. Budgets (file ${MAX_FILE_LINES}, fn ${MAX_FUNCTION_LINES}, nest ${MAX_NESTING_DEPTH}) protect readability.`,
  );
  process.exit(1);
}

console.log("✓ limits: all files pass file/function/nesting budgets");
process.exit(0);

// ---------------------------------------------------------------------------

function walk(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      check(full);
    }
  }
}

/**
 * Flags any HANDLER_BUDGET_EXEMPTIONS entry whose path doesn't exist
 * on disk. Keeps the allowlist from silently rotting as files get
 * renamed or deleted.
 */
function checkAllowlistIntegrity(): void {
  for (const entry of HANDLER_BUDGET_EXEMPTIONS) {
    const abs = join(ROOT, entry.path);
    try {
      statSync(abs);
    } catch {
      violations.push(
        `HANDLER_BUDGET_EXEMPTIONS references missing file: ${entry.path}. Remove its entry from scripts/check-limits.ts.`,
      );
    }
  }
}

function check(file: string): void {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const effective = countEffectiveLines(lines);
  // Normalize to POSIX so the scoped-budget regex patterns and the
  // allowlist set match on a stable shape across OSes — `path.relative`
  // emits backslashes on Windows.
  const rel = relative(ROOT, file).split(/[\\/]/).join("/");

  const scoped = SCOPED_FILE_BUDGETS.find((b) => b.pattern.test(rel));
  const fileExempt = hasLimitsExemptPragma(lines);
  const allowlistExempt = HANDLER_BUDGET_EXEMPTION_PATHS.has(rel);
  if (scoped && !fileExempt && !allowlistExempt && effective > scoped.maxFileLines) {
    violations.push(
      `${rel}: ${scoped.label} has ${effective} effective lines (max ${scoped.maxFileLines}). Either extract work into the assembler/helpers or add a top-of-file '// ra11y-limits-exempt: <reason>' pragma.`,
    );
  }
  // If a file has dropped back under the scoped budget, its allowlist
  // entry is stale debt; nudge the next editor to strip it.
  if (scoped && allowlistExempt && effective <= scoped.maxFileLines) {
    violations.push(
      `${rel}: ${scoped.label} is now at ${effective} effective lines (≤ ${scoped.maxFileLines}); remove its entry from HANDLER_BUDGET_EXEMPTIONS in scripts/check-limits.ts.`,
    );
  }

  const exemptFile = DATA_FILE_EXEMPTIONS.some((re) => re.test(rel));
  if (!(exemptFile || fileExempt || scoped) && effective > MAX_FILE_LINES) {
    violations.push(`${rel}: file has ${effective} effective lines (max ${MAX_FILE_LINES})`);
  }

  for (const fn of extractFunctions(lines)) {
    const fnEffective = countEffectiveLines(lines.slice(fn.startLine - 1, fn.endLine));
    if (fnEffective > MAX_FUNCTION_LINES) {
      violations.push(
        `${rel}:${fn.startLine}: function '${fn.name}' has ${fnEffective} effective lines (max ${MAX_FUNCTION_LINES})`,
      );
    }
    if (fn.maxDepth > MAX_NESTING_DEPTH) {
      violations.push(
        `${rel}:${fn.startLine}: function '${fn.name}' nests ${fn.maxDepth} levels deep (max ${MAX_NESTING_DEPTH})`,
      );
    }
  }
}

/**
 * Returns true when the file declares a `// ra11y-limits-exempt: <reason>`
 * pragma in its first `LIMITS_EXEMPT_HEADER_LINES` lines. A pragma without
 * a non-empty reason is ignored — the reason is what makes exemption
 * audit-able later.
 */
function hasLimitsExemptPragma(lines: readonly string[]): boolean {
  const horizon = Math.min(lines.length, LIMITS_EXEMPT_HEADER_LINES);
  for (let i = 0; i < horizon; i += 1) {
    const match = LIMITS_EXEMPT_RE.exec(lines[i] ?? "");
    if (match?.[1] && match[1].length > 0) return true;
  }
  return false;
}

/** Counts non-blank, non-comment-only lines. */
function countEffectiveLines(lines: readonly string[]): number {
  const state = { inBlockComment: false };
  let count = 0;
  for (const raw of lines) {
    if (isCodeLine(raw.trim(), state)) count += 1;
  }
  return count;
}

function isCodeLine(line: string, state: { inBlockComment: boolean }): boolean {
  if (state.inBlockComment) {
    if (line.includes("*/")) state.inBlockComment = false;
    return false;
  }
  if (line.length === 0) return false;
  if (line.startsWith("//")) return false;
  if (line.startsWith("*")) return false;
  if (line.startsWith("/*")) {
    if (!line.includes("*/")) state.inBlockComment = true;
    return false;
  }
  return true;
}

interface FunctionSpan {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly maxDepth: number;
}

/**
 * Extracts top-level function-like spans. Recognizes:
 *   - `function name(...) { ... }`
 *   - `export function name(...) { ... }`
 *   - `function* name(...) { ... }`
 *   - methods inside classes (`  foo(args) { ... }`)
 *
 * Arrow-function const declarations aren't tracked — they rarely
 * exceed the budget in practice, and extracting them reliably
 * needs a real parser.
 */
function extractFunctions(lines: readonly string[]): readonly FunctionSpan[] {
  const out: FunctionSpan[] = [];
  const fnRe =
    /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:<[^>]*>)?\s*\(/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = fnRe.exec(line);
    if (!match) continue;
    const name = match[1] ?? "<anonymous>";
    const span = scanBody(lines, i);
    if (span) {
      out.push({ name, startLine: i + 1, endLine: span.endLine, maxDepth: span.maxDepth });
    }
  }
  return out;
}

interface StripState {
  str: string | null;
  block: boolean;
}

/**
 * Given a line index that introduced a function, scans forward through
 * the body tracking brace depth. Strings and comments are stripped per
 * line via `stripLineCode` so the scan itself is a trivial brace
 * counter. Returns the end line (the line with the matching close
 * brace) and the max depth reached relative to the function body.
 */
function scanBody(
  lines: readonly string[],
  startIdx: number,
): { readonly endLine: number; readonly maxDepth: number } | null {
  const state: StripState = { str: null, block: false };
  const counter: BraceCounter = { depth: 0, maxDepth: 0, started: false };
  for (let i = startIdx; i < lines.length; i += 1) {
    const clean = stripLineCode(lines[i] ?? "", state);
    if (applyBraces(clean, counter)) return { endLine: i + 1, maxDepth: counter.maxDepth };
  }
  return null;
}

interface BraceCounter {
  depth: number;
  maxDepth: number;
  started: boolean;
}

/** Updates the brace counter for a stripped line; returns true when the body closes. */
function applyBraces(clean: string, counter: BraceCounter): boolean {
  for (const c of clean) {
    if (c === "{") {
      counter.depth += 1;
      counter.started = true;
      if (counter.depth - 1 > counter.maxDepth) counter.maxDepth = counter.depth - 1;
      continue;
    }
    if (c === "}") {
      counter.depth -= 1;
      if (counter.started && counter.depth === 0) return true;
    }
  }
  return false;
}

/**
 * Returns the given line with strings, line comments, and block
 * comments stripped away. Updates `state` so multi-line strings and
 * multi-line block comments carry across calls.
 */
function stripLineCode(line: string, state: StripState): string {
  let out = "";
  let j = 0;
  while (j < line.length) {
    if (state.block) {
      j = skipBlockComment(line, j, state);
      continue;
    }
    if (state.str !== null) {
      j = skipString(line, j, state);
      continue;
    }
    const next = advanceCode(line, j, state);
    if (next.stop) break;
    if (next.keep !== null) out += next.keep;
    j = next.next;
  }
  return out;
}

interface CodeStep {
  readonly next: number;
  readonly keep: string | null;
  readonly stop: boolean;
}

/** Walks one character of non-string, non-block-comment code. */
function advanceCode(line: string, j: number, state: StripState): CodeStep {
  const c = line[j] ?? "";
  const next = line[j + 1] ?? "";
  if (c === "/" && next === "/") return { next: line.length, keep: null, stop: true };
  if (c === "/" && next === "*") {
    state.block = true;
    return { next: j + 2, keep: null, stop: false };
  }
  if (c === '"' || c === "'" || c === "`") {
    state.str = c;
    return { next: j + 1, keep: null, stop: false };
  }
  return { next: j + 1, keep: c, stop: false };
}

function skipBlockComment(line: string, start: number, state: StripState): number {
  const end = line.indexOf("*/", start);
  if (end === -1) return line.length;
  state.block = false;
  return end + 2;
}

function skipString(line: string, start: number, state: StripState): number {
  const quote = state.str;
  let j = start;
  while (j < line.length) {
    const c = line[j] ?? "";
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) {
      state.str = null;
      return j + 1;
    }
    j += 1;
  }
  return j;
}
