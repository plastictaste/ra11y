/**
 * Per-file scan-degradation telemetry. When the parser emitted errors
 * on a file, the surrounding rules ran on a degraded AST (recovered
 * slice) or didn't see the file at all. `fired: 0` + `limitations:
 * [...]` reads as "scan ran but output is degraded," not "scan ran
 * clean." Without this top-level signal the agent must cross-read
 * `meta.analysisCoverage.parseErrorFiles` / `partialParseFiles` to
 * learn the DOM was truncated — a silent-failure shape per CLAUDE.md §1
 * "Zero-output success is ambiguous failure."
 *
 * Two honest reasons:
 *
 *   - `parse_error`   — parser failed; zero findings emitted on this
 *                       file. Treat as invisible to rules.
 *   - `partial_parse` — parser emitted errors but at least one rule
 *                       fired on the recovered slice. Findings are
 *                       present with live line numbers, but additional
 *                       violations below the error point may have been
 *                       missed.
 *
 * Pairs with Q4-PARSE-ERROR-DETAIL (closed): the `detail` field echoes
 * the first parse-error message, so the agent sees the root cause
 * ("Unexpected token `<`" vs. "Unterminated string literal") without
 * having to pick up the separate `analysisCoverage.parseErrorFiles`
 * bucket.
 *
 * `parser` names which in-house parser owned the failure (`html`,
 * `css`, `tsx`, `jsx`, `ts`, `js`). Distinct from the file extension
 * because alias routes (`.mdx → tsx`, `.astro → html`, `.scss → css`)
 * route a file through a foreign parser whose diagnostics the agent
 * would otherwise have to cross-reference against the parser registry.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { FileLimitation } from "../output/agent-response/types.ts";

export type { FileLimitation };

/**
 * Character cap on the `detail` string. Real parser messages land well
 * under 120 chars; the cap bites on pathological recovered input where
 * the parser echoes back a long source snippet. Same budget as
 * `analysisCoverage.parseErrorFiles[].reason` (see
 * `analysis-coverage.ts` PARSE_ERROR_REASON_MAX) so the two surfaces
 * stay in lockstep.
 */
const LIMITATION_DETAIL_MAX = 200;

function truncateDetail(message: string): string {
  if (message.length <= LIMITATION_DETAIL_MAX) return message;
  return `${message.slice(0, LIMITATION_DETAIL_MAX - 1)}…`;
}

/**
 * Derives a {@link FileLimitation} for a parsed file, or `null` when
 * the parse was clean. `fileHasFindings` drives the split between
 * `parse_error` (no findings emitted on this file — invisible to
 * rules) and `partial_parse` (errored + at least one rule still
 * fired on the recovered slice).
 *
 * Present-when-meaningful at the field level: callers conditional-
 * spread the result on the outer response so clean scans omit the
 * `limitations` field entirely (never ship `[]`).
 */
export function buildFileLimitation(
  file: ParsedFile,
  fileHasFindings: boolean,
): FileLimitation | null {
  if (file.ast.errors.length === 0) return null;
  const firstMessage = file.ast.errors[0]?.message ?? "";
  const detail = firstMessage.length > 0 ? truncateDetail(firstMessage) : undefined;
  return {
    reason: fileHasFindings ? "partial_parse" : "parse_error",
    file: file.filePath,
    parser: file.ast.language,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Batches {@link buildFileLimitation} across a set of parsed files and
 * their finding-bearing paths, returning only the entries with errors.
 * Sorted by file path for deterministic wire output.
 *
 * `findingFilePaths` drives the per-file classification. A file absent
 * from the set lands in `parse_error`; a file present lands in
 * `partial_parse`.
 */
export function buildFileLimitations(
  files: readonly ParsedFile[],
  findingFilePaths: ReadonlySet<string>,
): readonly FileLimitation[] {
  const out: FileLimitation[] = [];
  for (const f of files) {
    const limitation = buildFileLimitation(f, findingFilePaths.has(f.filePath));
    if (limitation !== null) out.push(limitation);
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}
