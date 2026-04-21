#!/usr/bin/env bun
/**
 * Enforces the registry layer boundary: only `src/engine/registry/**`
 * may import `BUILTIN_RULES`, `BUILTIN_STANDARDS`, or
 * `BUILTIN_CANDIDATE_FINDERS` from their respective barrels.
 *
 * Rationale. CLAUDE.md §3.8 — "engine never imports from rules/standards;
 * they consume them through registries" — is the architectural invariant
 * this script guards. The three `BUILTIN_*` constants are the internal
 * source the registry composes; once a consumer outside the registry
 * reaches past it directly, rule/standard/finder loading bypasses the
 * Registry aggregate (ADR 0022) and every future plugin-loader or
 * filter hook becomes a "sometimes applied" seam. Keeping the imports
 * scoped to `src/engine/registry/**` means the registry is the only
 * layer that ever binds rules/standards into a running scanner.
 *
 * Allowlist. Imports of the three constants are permitted under:
 *   - `src/engine/registry/**` — the aggregate legitimately composes them
 *   - `tests/**` — harness fixtures and unit tests consume them directly
 *
 * The three barrels that *declare* the constants (`src/rules/index.ts`,
 * `src/standards/index.ts`, `src/review/index.ts`) are inherently OK —
 * they `export const BUILTIN_…` rather than `import` it, so the
 * import-statement regex below never matches there.
 *
 * Exits 0 on success, 1 on violation. Prints the offending file, line,
 * and import text so the remediation is obvious: route the access
 * through the Registry aggregate instead of reaching around it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir ?? process.cwd(), "..");
const SRC_DIR = join(ROOT, "src");

const BANNED_NAMES = ["BUILTIN_RULES", "BUILTIN_STANDARDS", "BUILTIN_CANDIDATE_FINDERS"] as const;

/**
 * Match an ES `import` statement that pulls any of the banned names
 * out of a named-import clause. `[\s\S]*?` spans multi-line imports;
 * the leading `\bimport\b` keeps comments / strings containing the
 * names from tripping the check. Re-exports (`export { … } from …`)
 * that surface the name from a non-allowlisted path are equivalently
 * a layer-boundary breach, so the second regex catches those too.
 */
const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\b[\s\S]*?\{[\s\S]*?\b(?:BUILTIN_RULES|BUILTIN_STANDARDS|BUILTIN_CANDIDATE_FINDERS)\b[\s\S]*?\}[\s\S]*?from\b/,
  /\bexport\b[\s\S]*?\{[\s\S]*?\b(?:BUILTIN_RULES|BUILTIN_STANDARDS|BUILTIN_CANDIDATE_FINDERS)\b[\s\S]*?\}[\s\S]*?from\b/,
];

/**
 * Allowlist predicate on paths relative to ROOT. Returns true when the
 * file is permitted to import one of the `BUILTIN_*` constants.
 */
function isAllowlisted(rel: string): boolean {
  return rel.startsWith("src/engine/registry/");
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly text: string;
}

const violations: Violation[] = [];

walk(SRC_DIR);

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
      scan(full);
    }
  }
}

function scan(file: string): void {
  const rel = relative(ROOT, file);
  if (isAllowlisted(rel)) return;

  const content = readFileSync(file, "utf8");

  // Fast bail: the file doesn't reference any of the banned names at all.
  if (!BANNED_NAMES.some((n) => content.includes(n))) return;

  // Walk lines so we report useful locations. Import statements may span
  // multiple lines; we glue consecutive lines into logical statements
  // terminated by `;` or a newline that follows a closing `}` + `from`.
  const lines = content.split("\n");
  let buffer = "";
  let bufferStart = 0;
  let inImport = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!inImport && (trimmed.startsWith("import") || trimmed.startsWith("export"))) {
      buffer = line;
      bufferStart = i + 1;
      inImport = true;
    } else if (inImport) {
      buffer += `\n${line}`;
    }
    if (inImport && (line.includes(";") || /}\s*from\s+["']/.test(line))) {
      checkStatement(buffer, bufferStart, rel);
      buffer = "";
      inImport = false;
    }
  }
  // Trailing buffer with no terminator — still check.
  if (buffer) checkStatement(buffer, bufferStart, rel);
}

function checkStatement(statement: string, startLine: number, rel: string): void {
  for (const pattern of IMPORT_PATTERNS) {
    if (!pattern.test(statement)) continue;
    for (const name of BANNED_NAMES) {
      if (new RegExp(`\\b${name}\\b`).test(statement)) {
        violations.push({
          file: rel,
          line: startLine,
          name,
          text: statement.trim().split("\n").join(" "),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    "✗ registry layer boundary violated — only src/engine/registry/** may import BUILTIN_* constants:\n",
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [imports ${v.name}]`);
    console.error(`    ${v.text}`);
  }
  console.error(
    "\nThe Registry aggregate (src/engine/registry/registry.ts) is the single seam that binds",
  );
  console.error(
    "rules/standards/finders into a scanner. Route this access through the Registry instead —",
  );
  console.error("see CLAUDE.md §3.8 and docs/adr/0022-registry-aggregate.md for the invariant.");
  process.exit(1);
}

console.log("✓ builtins scope: registry layer boundary intact");
process.exit(0);
