#!/usr/bin/env bun
/**
 * Enforces the cross-platform-paths invariant: every externally
 * visible path string is POSIX (forward slash) regardless of host OS.
 * See `docs/kb/architecture/cross-platform-paths.md` for the full
 * doctrine.
 *
 * For `src/**\/*.ts` files in externally-shipping directories
 * (formatters, MCP handlers, report assemblers, public API, baseline
 * + scanner output assembly), this script flags any usage of
 * `node:path`'s `join` / `resolve` / `relative` / `dirname` — those
 * paths leak native separators on Windows. The fix is to import the
 * `posixJoin` / `posixResolve` / `posixRelative` / `posixDirname`
 * helpers from `src/utils/path.ts`.
 *
 * Files with a top-of-file `// path-normalization-allow: <reason>`
 * opt-out are skipped — used for provably-internal call sites whose
 * joined paths feed `statSync` / `readFileSync` only and never reach
 * an external surface.
 *
 * For `tests/**\/*.ts`, the script catches `expect(...).toBe(join(...))`
 * shapes within ~10 lines of each other — the canonical "build
 * expected path with native `path.join`, compare against POSIX
 * scanner output" regression that surfaced on the windows-shard
 * verify run before commit 4395f1cf.
 *
 * Allowlist entries are tagged `// MIGRATION: <area>` — each is a
 * file whose existing `node:path` usage hasn't been migrated yet. The
 * allowlist shrinks as the migration agent walks each entry.
 *
 * Exits 0 on no violations, 1 otherwise.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir ?? process.cwd(), "..");
const SRC_DIR = join(ROOT, "src");
const TESTS_DIR = join(ROOT, "tests");

/**
 * Directories whose `.ts` files ship paths to external consumers.
 * Match is prefix-based against the file's relative-to-ROOT path
 * (POSIX-shaped — these are repo-relative paths, not host paths).
 */
const EXTERNAL_DIR_PREFIXES: readonly string[] = [
  "src/output/",
  "src/mcp/",
  "src/reports/",
  "src/api/",
];

/**
 * Individual external-position files outside the prefix list.
 * Match is exact against the file's relative-to-ROOT path.
 */
const EXTERNAL_FILES: ReadonlySet<string> = new Set([
  "src/engine/baseline.ts",
  "src/engine/scanner.ts",
]);

/**
 * Migration allowlist: files whose existing `node:path` usage
 * hasn't been migrated to the POSIX helpers yet. Each entry is the
 * repo-relative path of a file that the script would otherwise flag.
 * The migration agent walks this list top-to-bottom, fixing each
 * entry then deleting it. When the lists are empty, the invariant
 * is fully ratcheted in.
 *
 * Each entry is tagged inline with the surface area it owns, so the
 * migration agent has a clear scope per file.
 */
const SRC_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // MIGRATION: scanner output assembly — to remove after src/ migration
  "src/engine/baseline.ts",
  // MIGRATION: MCP tool surface (catalog / SSG / ecosystem detection)
  // — to remove after src/ migration
  "src/mcp/additional-paths-classifier.ts",
  "src/mcp/baseline-status.ts",
  "src/mcp/build-provenance.ts",
  "src/mcp/catalog-detect.ts",
  "src/mcp/config-hint.ts",
  "src/mcp/config-search-marker.ts",
  "src/mcp/ecosystem-detect.ts",
  "src/mcp/extension-presence-probe.ts",
  "src/mcp/path-exists.ts",
  "src/mcp/propose-baseline-classify.ts",
  "src/mcp/resolve-inside-cwd.ts",
  "src/mcp/resources/index.ts",
  "src/mcp/scan-group-by.ts",
  "src/mcp/scanner-meta.ts",
  "src/mcp/session.ts",
  "src/mcp/ssg-detect.ts",
  "src/mcp/suggest-fix-inherited-hint.ts",
  "src/mcp/tool-apply-fix.ts",
  "src/mcp/tool-attest.ts",
  "src/mcp/tool-audit-rule-coverage-result.ts",
  "src/mcp/tool-baseline.ts",
  "src/mcp/tool-conformance-statement.ts",
  "src/mcp/tool-propose-config.ts",
  "src/mcp/tool-scan-diff.ts",
  "src/mcp/tool-scan-file.ts",
  "src/mcp/tool-scan-process.ts",
  "src/mcp/tool-scan-project.ts",
  "src/mcp/tool-suppress.ts",
  "src/mcp/tools-helpers.ts",
  "src/mcp/top-directories.ts",
]);

/**
 * Migration allowlist for tests. Same shape as SRC_ALLOWLIST: each
 * entry is a test file whose `expect(...)` calls compare against
 * native-`path.join`-built expected strings. Migration agent
 * replaces each with `posixJoin` from `tests/helpers/path.ts`.
 */
const TEST_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // MIGRATION: unit tests (CLI commands, config loader/processes,
  // input discover, MCP tool/protocol/extension/scan-* helpers,
  // review pointer-input) — to remove after tests/ migration
  "tests/unit/cli/commands/certification.test.ts",
  "tests/unit/cli/commands/checklist.test.ts",
  "tests/unit/cli/commands/coverage.test.ts",
  "tests/unit/cli/commands/doctor.test.ts",
  "tests/unit/cli/commands/init.test.ts",
  "tests/unit/cli/commands/vpat.test.ts",
  "tests/unit/config/loader.test.ts",
  "tests/unit/config/processes.test.ts",
  "tests/unit/input/discover.test.ts",
  "tests/unit/mcp/additional-paths-classifier.test.ts",
  "tests/unit/mcp/build-provenance.test.ts",
  "tests/unit/mcp/catalog-detect.test.ts",
  "tests/unit/mcp/config-search-marker.test.ts",
  "tests/unit/mcp/cwd-containment.test.ts",
  "tests/unit/mcp/ecosystem-detect.test.ts",
  "tests/unit/mcp/extension-presence-probe.test.ts",
  "tests/unit/mcp/parser-routing-xhtml-mkdn.test.ts",
  "tests/unit/mcp/rules-evaluated-ssot.test.ts",
  "tests/unit/mcp/scan-file-extension-filter.test.ts",
  "tests/unit/mcp/scan-limitations.test.ts",
  "tests/unit/mcp/ssg-detect.test.ts",
  "tests/unit/mcp/tool-apply-fix-edges.test.ts",
  "tests/unit/mcp/tool-apply-fix.test.ts",
  "tests/unit/mcp/tool-bootstrap.test.ts",
  "tests/unit/mcp/tool-checklist.test.ts",
  "tests/unit/mcp/tool-conformance-statement.test.ts",
  "tests/unit/mcp/tool-coverage.test.ts",
  "tests/unit/mcp/tool-list-suppressions.test.ts",
  "tests/unit/mcp/tool-propose-baseline-invariants.test.ts",
  "tests/unit/mcp/tool-propose-baseline.test.ts",
  "tests/unit/mcp/tool-propose-config.test.ts",
  "tests/unit/mcp/tool-scan-diff-hunks.test.ts",
  "tests/unit/mcp/tool-scan-diff.test.ts",
  "tests/unit/mcp/tool-suppress.test.ts",
  "tests/unit/mcp/tool-wrapper-introspect.test.ts",
  "tests/unit/mcp/tools.test.ts",
  "tests/unit/review/pointer-input.test.ts",
]);

/** Names from `node:path` whose return value is a path string. */
const NATIVE_PATH_FNS: readonly string[] = ["join", "resolve", "relative", "dirname"];

/** Marker comment that opts a file out of the check. */
const OPT_OUT_MARKER = "path-normalization-allow:";

interface SrcViolation {
  readonly file: string;
  readonly line: number;
  readonly fn: string;
  readonly text: string;
}

interface TestViolation {
  readonly file: string;
  readonly line: number;
  readonly fn: string;
  readonly text: string;
}

const srcViolations: SrcViolation[] = [];
const testViolations: TestViolation[] = [];

/**
 * Pre-compiled per-fn detector: matches `<fn>(` as a call when not
 * preceded by `.` (i.e. not a method call) and not preceded by a
 * word-or-`$` character (so `posixJoin(` doesn't trip on `join`).
 * Built once at module load — the patterns live for the whole scan.
 */
const FN_DETECTORS: ReadonlyMap<string, RegExp> = new Map(
  NATIVE_PATH_FNS.map((fn) => [fn, new RegExp(`(?:^|[^\\w$.])${fn}\\s*\\(`)]),
);

const IMPORT_LINE_RE = /from\s+["']node:path["']/;
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*)/;
const EXPECT_CALL_RE = /\bexpect\s*\(/;
const POSIX_WRAPPER_RE = /\bposix(?:Join|Resolve|Relative|Dirname)\s*\(/;
const TEST_WINDOW_LINES = 10;

walkSrc(SRC_DIR);
walkTests(TESTS_DIR);

const filteredSrcViolations = srcViolations.filter((v) => !SRC_ALLOWLIST.has(v.file));
const filteredTestViolations = testViolations.filter((v) => !TEST_ALLOWLIST.has(v.file));
const violationCount = filteredSrcViolations.length + filteredTestViolations.length;

if (violationCount === 0) {
  const allowSize = SRC_ALLOWLIST.size + TEST_ALLOWLIST.size;
  const suffix =
    allowSize > 0
      ? ` (${allowSize} file${allowSize === 1 ? "" : "s"} allowlisted pending migration)`
      : "";
  console.log(`✓ path normalization: every externally visible path uses posix helpers${suffix}`);
  process.exit(0);
}

console.error(
  "✗ path normalization violated — externally visible paths must use posix helpers from src/utils/path.ts:\n",
);
for (const v of filteredSrcViolations) {
  console.error(
    `  ${v.file}:${v.line}: external-position file uses path.${v.fn} — use posix${capitalize(v.fn)} from src/utils/path.ts`,
  );
  console.error(`    ${v.text}`);
}
for (const v of filteredTestViolations) {
  console.error(
    `  ${v.file}:${v.line}: expect-side path.${v.fn} — use posix${capitalize(v.fn)} from tests/helpers/path.ts`,
  );
  console.error(`    ${v.text}`);
}
console.error(
  `\n${violationCount} violation${violationCount === 1 ? "" : "s"}. See docs/kb/architecture/cross-platform-paths.md.`,
);
process.exit(1);

function walkSrc(dir: string): void {
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
      walkSrc(full);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      scanSrcFile(full);
    }
  }
}

function walkTests(dir: string): void {
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
      walkTests(full);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      scanTestFile(full);
    }
  }
}

function scanSrcFile(file: string): void {
  const rel = toRepoPosix(relative(ROOT, file));
  if (!isExternalPosition(rel)) return;
  const content = readFileSync(file, "utf8");
  // Header opt-out applies to the whole file. We look in the leading
  // 20 lines to give file-level docblocks room above the marker.
  const head = content.split("\n", 20).join("\n");
  if (head.includes(OPT_OUT_MARKER)) return;
  const importedNames = parseImportedPathNames(content);
  if (importedNames.size === 0) return;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    collectSrcLineViolations(rel, lines[i] ?? "", i, importedNames);
  }
}

function collectSrcLineViolations(
  rel: string,
  line: string,
  index: number,
  importedNames: ReadonlySet<string>,
): void {
  // Skip the import statement itself + comment-only lines so docblock
  // examples like `posixJoin("src", "app")` don't trip the check.
  if (IMPORT_LINE_RE.test(line)) return;
  if (COMMENT_LINE_RE.test(line)) return;
  for (const fn of NATIVE_PATH_FNS) {
    if (!importedNames.has(fn)) continue;
    if (!FN_DETECTORS.get(fn)?.test(line)) continue;
    srcViolations.push({
      file: rel,
      line: index + 1,
      fn,
      text: line.trim(),
    });
  }
}

function scanTestFile(file: string): void {
  const rel = toRepoPosix(relative(ROOT, file));
  // Skip the test helper itself + the path-utils test.
  if (rel === "tests/helpers/path.ts") return;
  if (rel === "tests/unit/utils/path.test.ts") return;
  const content = readFileSync(file, "utf8");
  const head = content.split("\n", 20).join("\n");
  if (head.includes(OPT_OUT_MARKER)) return;
  const importedNames = parseImportedPathNames(content);
  if (importedNames.size === 0) return;
  const lines = content.split("\n");
  // Track expect( occurrences and look ~10 lines forward for a
  // join(/resolve( call. The check is intentionally narrow: an
  // expect-side native path call that builds a string compared
  // against scanner output is the regression. expect( with a posix
  // wrapper on the same logical line is fine, so we exempt those.
  // Dedupe per (line, fn): two consecutive `expect(` calls would
  // otherwise overlap their windows and report the same call twice.
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!EXPECT_CALL_RE.test(line)) continue;
    collectTestWindowViolations(rel, lines, i, importedNames, seen);
  }
}

function collectTestWindowViolations(
  rel: string,
  lines: readonly string[],
  start: number,
  importedNames: ReadonlySet<string>,
  seen: Set<string>,
): void {
  const end = Math.min(lines.length, start + TEST_WINDOW_LINES);
  for (let j = start; j < end; j++) {
    collectTestProbeViolations(rel, lines[j] ?? "", j, importedNames, seen);
  }
}

function collectTestProbeViolations(
  rel: string,
  probe: string,
  index: number,
  importedNames: ReadonlySet<string>,
  seen: Set<string>,
): void {
  if (COMMENT_LINE_RE.test(probe)) return;
  if (POSIX_WRAPPER_RE.test(probe)) return;
  for (const fn of NATIVE_PATH_FNS) {
    if (!importedNames.has(fn)) continue;
    if (!FN_DETECTORS.get(fn)?.test(probe)) continue;
    const key = `${index + 1}:${fn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    testViolations.push({
      file: rel,
      line: index + 1,
      fn,
      text: probe.trim(),
    });
  }
}

/**
 * Parses the file's `from "node:path"` import statements and returns
 * the set of names actually imported (matching local aliases via
 * `as`). Used to scope the check to call sites that actually pulled
 * the native helper in — a file with no `node:path` import can use
 * `join` as a local identifier without tripping the regex.
 */
function parseImportedPathNames(content: string): Set<string> {
  const names = new Set<string>();
  const re = /import\s*\{([^}]*)\}\s*from\s+["']node:path["']/g;
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    const inside = m[1] ?? "";
    for (const segment of inside.split(",")) {
      addImportedName(names, segment.trim());
    }
    m = re.exec(content);
  }
  return names;
}

/**
 * Adds one comma-split import segment to the names set if it names a
 * native path fn (or aliases one via `as`). Extracted from
 * `parseImportedPathNames` to keep the latter under the cognitive
 * complexity ceiling.
 */
function addImportedName(names: Set<string>, segment: string): void {
  if (!segment) return;
  const aliasMatch = segment.match(/^(\w+)\s+as\s+(\w+)$/);
  if (aliasMatch) {
    const [, original, alias] = aliasMatch;
    if (original && NATIVE_PATH_FNS.includes(original) && alias) {
      names.add(alias);
    }
    return;
  }
  if (NATIVE_PATH_FNS.includes(segment)) {
    names.add(segment);
  }
}

function isExternalPosition(relPath: string): boolean {
  if (EXTERNAL_FILES.has(relPath)) return true;
  return EXTERNAL_DIR_PREFIXES.some((p) => relPath.startsWith(p));
}

function toRepoPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function capitalize(s: string): string {
  return s.length === 0 ? s : `${s[0]?.toUpperCase()}${s.slice(1)}`;
}
