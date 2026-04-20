#!/usr/bin/env bun
/**
 * Generates docs/kb/rules/<slug>.md — one page per built-in rule —
 * from the metadata on each Rule object.
 *
 * Slug format: `<domain>__<name>` (slashes replaced with double
 * underscore so the filename is flat). This matches check-kb-drift.
 *
 * Never hand-edit the generated `<slug>.md` pages; they get overwritten
 * on every run. Hand-authored maintainer docs that live alongside
 * (e.g. `fix-suggestion-audit.md`, `coverage.md`) are preserved — the
 * unlink step only removes files this script would have produced.
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BUILTIN_RULES } from "../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../src/standards/index.ts";

const ROOT = join(import.meta.dir ?? process.cwd(), "..");
const OUT_DIR = join(ROOT, "docs", "kb", "rules");
const STANDARDS_DIR = join(ROOT, "docs", "kb", "standards");

/**
 * Hand-authored maintainer docs (by slug, no `.md`) that live under
 * `docs/kb/rules/` and `docs/kb/standards/` but are NOT produced by
 * this script. These must survive regeneration. Keep in sync with
 * `knownRuleExtras` / `knownExtras` in `check-kb-drift.ts` — both
 * enumerate the same exception set from opposite directions (drift
 * check ignores them when comparing, generator skips unlinking them).
 *
 * Exported so the test can prove the allowlist covers the specific
 * files the bug reports called out.
 */
export const HAND_AUTHORED_KB_SLUGS: ReadonlySet<string> = new Set([
  "fix-suggestion-audit", // docs/kb/rules/fix-suggestion-audit.md
  "coverage", // docs/kb/standards/coverage.md (owned by generate-coverage-matrix.ts)
]);

/**
 * Decides which filenames in a generator-owned directory should be
 * unlinked before regenerating. Removes `.md` files whose slug is not
 * in the `expected` set (stale generator output) but preserves:
 *   - `index.md` / `README.md` (directory-wide conventions)
 *   - any slug present in `HAND_AUTHORED_KB_SLUGS` (hand-authored
 *     maintainer docs; owned by a different generator or by no
 *     generator at all)
 *
 * Pure function — exported for unit testing.
 *
 * @param present - filenames currently on disk in the target directory
 * @param expected - slugs (without `.md`) this run is about to write
 * @returns the filenames that should be unlinked before writing
 */
export function chooseFilesToUnlink(
  present: readonly string[],
  expected: readonly string[],
): readonly string[] {
  const expectedSet = new Set(expected);
  const result: string[] = [];
  for (const name of present) {
    if (!name.endsWith(".md")) continue;
    if (name === "index.md" || name === "README.md") continue;
    const slug = name.slice(0, -3);
    if (expectedSet.has(slug)) continue; // will be overwritten anyway
    if (HAND_AUTHORED_KB_SLUGS.has(slug)) continue; // hand-authored — preserve
    result.push(name);
  }
  return result;
}

if (import.meta.main) {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(STANDARDS_DIR, { recursive: true });

  const expectedStandardSlugs = BUILTIN_STANDARDS.map((s) => s.id);
  for (const name of chooseFilesToUnlink(safeReaddir(STANDARDS_DIR), expectedStandardSlugs)) {
    unlinkSync(join(STANDARDS_DIR, name));
  }

  for (const standard of BUILTIN_STANDARDS) {
    writeFileSync(join(STANDARDS_DIR, `${standard.id}.md`), renderStandardPage(standard));
  }

  const expectedRuleSlugs = BUILTIN_RULES.map((r) => r.id.replace(/\//g, "__"));
  for (const name of chooseFilesToUnlink(safeReaddir(OUT_DIR), expectedRuleSlugs)) {
    unlinkSync(join(OUT_DIR, name));
  }

  let written = 0;
  for (const rule of BUILTIN_RULES) {
    const slug = rule.id.replace(/\//g, "__");
    writeFileSync(join(OUT_DIR, `${slug}.md`), renderPage(rule));
    written += 1;
  }

  console.log(`✓ generated ${written} rule KB pages → ${OUT_DIR}`);
}

function renderPage(rule: (typeof BUILTIN_RULES)[number]): string {
  const docs = rule.docs ?? {};
  const references = docs.references ?? [];

  return [
    "---",
    `title: "${rule.id}"`,
    `severity: "${rule.severity}"`,
    `scope: "${rule.scope}"`,
    `satisfies: [${rule.satisfies.map((s) => `"${s}"`).join(", ")}]`,
    "---",
    "",
    `# \`${rule.id}\``,
    "",
    `- **Severity:** ${rule.severity}`,
    `- **Scope:** ${rule.scope}`,
    `- **Satisfies:** ${rule.satisfies.map((s) => `\`${s}\``).join(", ")}`,
    rule.appliesTo?.fileExtensions
      ? `- **Applies to:** ${rule.appliesTo.fileExtensions.join(", ")}`
      : "",
    "",
    "## What it checks",
    "",
    (docs.description ?? "_No description provided._").trim(),
    "",
    "## Why it matters",
    "",
    (docs.rationale ?? "_No rationale provided._").trim(),
    "",
    "## Normative quote",
    "",
    docs.normativeQuote ? `> ${docs.normativeQuote}` : "_(not quoted)_",
    "",
    "## Good example",
    "",
    docs.goodExample ? codeBlock(docs.goodExample) : "_(none)_",
    "",
    "## Bad example",
    "",
    docs.badExample ? codeBlock(docs.badExample) : "_(none)_",
    "",
    "## References",
    "",
    references.length > 0 ? references.map((r) => `- <${r}>`).join("\n") : "_(none)_",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .concat("\n");
}

function codeBlock(src: string): string {
  const fence = "```";
  return `${fence}tsx\n${src.trim()}\n${fence}`;
}

function renderStandardPage(s: (typeof BUILTIN_STANDARDS)[number]): string {
  const levels = (s.levels ?? []).join(", ");
  const count = s.criteria.length;
  const byLevel = new Map<string, number>();
  for (const c of s.criteria) byLevel.set(c.level, (byLevel.get(c.level) ?? 0) + 1);
  const breakdown = [...byLevel.entries()]
    .sort()
    .map(([l, n]) => `${l}: ${n}`)
    .join(" · ");

  return [
    "---",
    `title: "${s.name}"`,
    `id: "${s.id}"`,
    `version: "${s.version}"`,
    "---",
    "",
    `# ${s.name}`,
    "",
    `- **ID:** \`${s.id}\``,
    `- **Version:** ${s.version}`,
    `- **Publisher:** ${s.publisher ?? "unspecified"}`,
    `- **Levels:** ${levels}`,
    `- **Criteria:** ${count} (${breakdown})`,
    s.url ? `- **Spec:** <${s.url}>` : "",
    "",
    "## Criteria",
    "",
    s.criteria.map((c) => `- \`${c.id}\` · ${c.level} · ${c.title}`).join("\n"),
    "",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .concat("\n");
}

function safeReaddir(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
