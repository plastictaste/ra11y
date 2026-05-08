/**
 * Post-scan dedupe + stamping for file-fingerprint deduplication.
 *
 * Companion to `src/input/file-fingerprint.ts`: that helper runs the
 * fingerprint pre-pass on parsed sources and returns a
 * `Map<canonicalPath, duplicatePaths[]>`; this helper consumes the
 * map after the scanner has emitted findings on every parsed file,
 * drops findings emitted from non-canonical duplicate paths, and
 * stamps `vendorOccurrences` on the canonical's findings so every
 * dropped path stays enumerable on the wire.
 *
 * Surface-don't-suppress per AI-first doctrine — the dedupe is
 * lossless: every duplicate path appears in the canonical finding's
 * `vendorOccurrences` list. Agents that want per-copy granularity
 * iterate the list; agents that want the pattern read the canonical
 * finding once.
 *
 * Distinct from `src/mcp/vendor-dedupe.ts`'s
 * `collapseVendorCssFindings`:
 *
 *   - That helper keys on `(basename, ruleId, patternId ?? message)`
 *     — useful when files share a basename but have small content
 *     drift (theme variants of bootstrap.css with different color
 *     tokens).
 *   - This helper keys on byte-identity (SHA-1) — useful when files
 *     are literally byte-identical regardless of basename (e.g. the
 *     same vendor drop with different filenames in different theme
 *     directories).
 *
 * The two passes are complementary; the fingerprint pass runs FIRST
 * so the basename-keyed pass downstream sees the already-stamped
 * stream and either composes (when basename match adds further
 * occurrences across non-byte-identical siblings) or no-ops (when
 * the same fingerprint group already covers them).
 */

import type { ParsedFile } from "../engine/scanner.ts";
import { fingerprintEligibleDuplicates } from "../input/file-fingerprint.ts";
import type { Violation } from "../types/violation.ts";

/**
 * Computes the fingerprint duplicate map from already-parsed files.
 * Re-uses the parser-loaded `source` strings so no additional I/O
 * fires — the parsed-file pipeline owns the bytes; this helper just
 * groups them. Returns an empty map when no duplicates exist (the
 * common case on authored-source corpora). Sits in this module so
 * the production parser-pipeline call site (`tools-helpers.ts`'s
 * `parseFilesWithDiagnostics`) stays under the file-line budget.
 */
export async function fingerprintParsedFiles(
  parsed: readonly ParsedFile[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const src = new Map(parsed.map((f) => [f.filePath, f.source]));
  const { duplicatesByCanonical } = await fingerprintEligibleDuplicates(
    parsed.map((f) => f.filePath),
    async (filePath) => src.get(filePath),
  );
  return duplicatesByCanonical;
}

/**
 * Drops findings whose `location.filePath` is in any duplicate-group
 * non-canonical position, and stamps `vendorOccurrences` on findings
 * emitted from canonical paths so every dropped path stays
 * enumerable on the wire.
 *
 * Each canonical's `vendorOccurrences` list carries the canonical's
 * own `(filePath, line)` as the first entry, followed by one entry
 * per duplicate path (the canonical's line is reused — the
 * fingerprint guarantees the duplicate has identical bytes at the
 * same line).
 *
 * Preserves any pre-existing `vendorOccurrences` the violation
 * already carried by appending the new duplicate-path entries; on
 * collision (a duplicate path that already appeared in the existing
 * occurrences), the existing entry wins so the line numbers from the
 * earlier dedupe pass aren't overwritten with a guessed value.
 *
 * Pure function — never mutates input. Returns the same array
 * reference when no stamping is needed (the duplicates map is
 * empty), so the common case stays allocation-free.
 */
export function stampFingerprintOccurrences(
  violations: readonly Violation[],
  duplicatesByCanonical: ReadonlyMap<string, readonly string[]>,
): readonly Violation[] {
  if (duplicatesByCanonical.size === 0) return violations;
  const canonicalByDuplicate = invertDuplicateMap(duplicatesByCanonical);
  let touched = false;
  const out: Violation[] = [];
  for (const v of violations) {
    const decision = decideFingerprintAction(v, duplicatesByCanonical, canonicalByDuplicate);
    if (decision === "drop") {
      touched = true;
      continue;
    }
    if (decision === "stamp") {
      touched = true;
      out.push(stampOne(v, duplicatesByCanonical.get(v.location.filePath) ?? []));
      continue;
    }
    out.push(v);
  }
  return touched ? out : violations;
}

/**
 * Inverse index for the canonical-by-duplicate lookup. Every duplicate
 * path maps to its canonical so `decideFingerprintAction` can answer
 * "is this finding from a non-canonical duplicate path?" in O(1).
 */
function invertDuplicateMap(
  duplicatesByCanonical: ReadonlyMap<string, readonly string[]>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [canonical, duplicates] of duplicatesByCanonical) {
    for (const dup of duplicates) out.set(dup, canonical);
  }
  return out;
}

/**
 * Three-way decision per violation: `drop` when emitted from a
 * non-canonical duplicate, `stamp` when emitted from a canonical with
 * duplicates, `pass` when the path has no fingerprint duplicates at
 * all (the common case for authored code).
 */
function decideFingerprintAction(
  v: Violation,
  duplicatesByCanonical: ReadonlyMap<string, readonly string[]>,
  canonicalByDuplicate: ReadonlyMap<string, string>,
): "drop" | "stamp" | "pass" {
  if (canonicalByDuplicate.has(v.location.filePath)) return "drop";
  const duplicates = duplicatesByCanonical.get(v.location.filePath);
  return duplicates === undefined || duplicates.length === 0 ? "pass" : "stamp";
}

/**
 * Stamps `vendorOccurrences` on a single canonical-derived violation.
 * Pre-existing entries are preserved verbatim; new duplicate paths
 * append with the canonical's line (the fingerprint guarantees byte-
 * identity, so the offending source span sits at the same line in
 * every duplicate copy). Skips paths already in the existing list so
 * earlier dedupe-pass line numbers aren't overwritten.
 */
function stampOne(v: Violation, duplicates: readonly string[]): Violation {
  const existing = v.vendorOccurrences ?? [];
  const seen = new Set<string>(existing.map((o) => o.path));
  seen.add(v.location.filePath);
  const occurrences: { readonly path: string; readonly line: number }[] =
    existing.length === 0 ? [{ path: v.location.filePath, line: v.location.line }] : [...existing];
  for (const dupPath of duplicates) {
    if (seen.has(dupPath)) continue;
    seen.add(dupPath);
    occurrences.push({ path: dupPath, line: v.location.line });
  }
  return { ...v, vendorOccurrences: occurrences };
}
