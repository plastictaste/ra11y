/**
 * parse-error bucket assembler
 * extracted from `analysis-coverage.ts` so the parent module stays
 * under the {@link MAX_FILE_LINES} budget. Keeps the inline-vs-rollup
 * wire-shape gate (default verbose=false: rollup at count > threshold;
 * verbose=true: full uncapped path list) co-located with the rollup
 * helper and the threshold constants — moving one requires touching
 * the others.
 *
 * The `CoverageBlock` mutation surface is expressed as a narrow
 * structural-typed parameter so this module doesn't import the full
 * coverage interface from the parent and create a back-edge cycle —
 * only the four parse-error fields and two count scalars are written,
 * and TypeScript's structural typing accepts a `CoverageBlock` value
 * at the call site without an explicit type cast.
 */

import type { ParseErrorEntry } from "./analysis-coverage-types.ts";

/**
 * Bucket-size threshold above which the default (non-verbose) shape of
 * `parseErrorFiles` and `partialParseFiles` switches from "full inline
 * list" to "rollup": `{ parseErrorFileCount, parseErrorTopReasons }`.
 * The full path list remains opt-in via the `verboseMeta: true` input
 * flag. Picked at 20 by working backward from the canonical wire-size
 * budget: at the observed ~250 chars per
 * `{ path, parserAttempted, naturalParser?, reason }` entry,
 * 20 entries cost ~5KB inline — small enough to ride alongside
 * the rest of the coverage block at default verbosity, large enough
 * that small / mid codebases (the long tail of scans) still see the
 * full per-entry detail without flipping `verboseMeta`. The rollup
 * form fires only on the bulk-template / static-site scans where the
 * path list was previously the single largest contributor to coverage-
 * response weight (501 entries × ~250 chars = ~125KB on the canonical
 * website-templates corpus). Doctrine: surface, don't suppress — the
 * count scalar and the top-reasons rollup BOTH stay populated so the
 * agent never loses sight of the total or the dominant failure mode.
 */
export const PARSE_ERROR_INLINE_THRESHOLD = 20;

/**
 * Number of distinct reason strings to surface in the rollup form.
 * Five matches the doctrinal "top-N rollup" shape used elsewhere
 * across the AI-first response surface; agents triaging "what kind of
 * parse failure dominates this scan?" rarely need more than the top
 * handful, and the per-reason `count` scalars stay full (no cap on
 * individual reason counts) so the dominant failure mode is always
 * visible. The count scalar (`parseErrorFileCount`) is the
 * authoritative total — agents can reconstruct the long-tail residue
 * as `parseErrorFileCount - sum(parseErrorTopReasons[].count)`.
 */
export const PARSE_ERROR_TOP_REASONS_N = 5;

/**
 * Narrow structural-typed view of the coverage record this module
 * mutates — only the eight fields the parse-error assembler writes.
 * The parent's `CoverageBlock` interface is structurally compatible
 * (every field below is declared optional on `CoverageBlock`), so
 * call sites pass the full coverage block without a cast.
 */
export interface ParseErrorCoverageView {
  parseErrorFileCount?: number;
  parseErrorFiles?: readonly ParseErrorEntry[];
  parseErrorTopReasons?: readonly { readonly reason: string; readonly count: number }[];
  /**
   * per-parser count map for the
   * `parseErrorFiles` bucket — keyed by the in-house parser name
   * (`tsx`, `html`, `css`, `jsx`, `ts`, `js`) and valued by the count
   * of errored files that parser owns. Lets the warnings layer surface
   * `parseErrorsByParser: { tsx: 538, css: 12, html: 2 }` on the
   * `parse_errors_present` payload so an agent can answer "is every
   * .js file failing under tsx?" without paging through a
   * threshold-rolled inventory. Includes only parsers that actually
   * contributed errored entries (no zero-valued keys) so the shape
   * stays compact on small scans. Sorted by parser key for
   * deterministic wire output across runs.
   */
  parseErrorsByParser?: Readonly<Record<string, number>>;
  partialParseFileCount?: number;
  partialParseFiles?: readonly ParseErrorEntry[];
  partialParseTopReasons?: readonly { readonly reason: string; readonly count: number }[];
  /** mirror for `partialParseFiles`. */
  partialParseByParser?: Readonly<Record<string, number>>;
}

/**
 * Aggregates a parse-error bucket into the `{ reason, count }` rollup
 * the default (non-verbose) shape ships when the inline path list
 * exceeds {@link PARSE_ERROR_INLINE_THRESHOLD}. Sort order: count
 * desc, then alphabetical by reason for deterministic wire output
 * across runs. Top-N slice runs after the sort so the head of the
 * rollup is the dominant failure mode.
 *
 * Distinct reasons are derived from the per-entry `reason` strings
 * exactly as they ship inline — no normalization. Two entries with
 * different per-line column suffixes (`Unexpected token '<' at 1:5`
 * vs `Unexpected token '<' at 7:12`) are categorically different
 * reason strings even when the agent might consider them the same
 * underlying failure; the alternative (regex-stripping the position
 * tail) would be a heuristic and silently fold real differences. The
 * agent reading the rollup decides whether to re-aggregate further
 * after `verboseMeta: true` returns the full list.
 */
function rollupTopReasons(
  entries: readonly ParseErrorEntry[],
): readonly { readonly reason: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  // Entries with no `reason` (parser recorded a position but no message
  // string) skip the rollup — bucketing them under `undefined` or `""`
  // would re-introduce the ambiguous-empty-string shape the per-entry
  // omission was added to avoid.
  for (const entry of entries) {
    if (entry.reason === undefined) continue;
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([aReason, aCount], [bReason, bCount]) =>
      bCount === aCount ? aReason.localeCompare(bReason) : bCount - aCount,
    )
    .slice(0, PARSE_ERROR_TOP_REASONS_N)
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * Splits the accumulated parse-error entries into the two honest
 * buckets and assigns them to the coverage block.
 *
 * - `parseErrorFiles` (array of `{ path, parserAttempted,
 *   naturalParser?, reason }`): files whose parser emitted errors AND
 *   produced zero findings. These are invisible to rules; an agent
 *   reading the list treats them as "could contain a11y violations
 *   the scanner never saw."
 * - `partialParseFiles` (array of `{ path, parserAttempted,
 *   naturalParser?, reason }`): files whose parser emitted errors but
 *   for which at least one rule fired on the recovered slice. Findings
 *   on these paths are present in the response with live line numbers;
 *   the entry is a calibration warning, not a blanket "invisible"
 *   signal.
 *
 * Default-mode (verbose=false) wire shape:
 * - count ≤ {@link PARSE_ERROR_INLINE_THRESHOLD}: inline the full
 *   `parseErrorFiles` / `partialParseFiles` array.
 * - count > threshold: omit the path-list array, surface the
 *   `parseErrorTopReasons` / `partialParseTopReasons` rollup
 *   (top-{@link PARSE_ERROR_TOP_REASONS_N} distinct reasons by
 *   frequency, full counts).
 *
 * Verbose-mode (verbose=true) wire shape: full uncapped
 * `parseErrorFiles` / `partialParseFiles` at every count, no rollup.
 *
 * Classification depends on `findingFilePaths`. When the caller passes
 * `undefined`, every errored file routes into the historical
 * `parseErrorFiles` bucket so the absence of the signal never silently
 * demotes a file from "fully invisible" to "partially reported."
 */
export function assembleParseErrorBlocks(
  entries: readonly ParseErrorEntry[],
  findingFilePaths: ReadonlySet<string> | undefined,
  coverage: ParseErrorCoverageView,
  verbose: boolean,
): void {
  const totalFailure: ParseErrorEntry[] = [];
  const partial: ParseErrorEntry[] = [];
  for (const entry of entries) {
    if (findingFilePaths?.has(entry.path)) {
      partial.push(entry);
    } else {
      totalFailure.push(entry);
    }
  }
  if (totalFailure.length > 0) {
    coverage.parseErrorFileCount = totalFailure.length;
    coverage.parseErrorsByParser = countByParser(totalFailure);
    assignParseErrorList(
      totalFailure,
      verbose,
      coverage,
      "parseErrorFiles",
      "parseErrorTopReasons",
    );
  }
  if (partial.length > 0) {
    coverage.partialParseFileCount = partial.length;
    coverage.partialParseByParser = countByParser(partial);
    assignParseErrorList(partial, verbose, coverage, "partialParseFiles", "partialParseTopReasons");
  }
}

/**
 * aggregates a parse-error bucket
 * into a `{ [parser]: count }` map keyed by the in-house parser name
 * each entry's `parser` tag carries. Pure over its input; sorted by
 * parser key for deterministic wire output across runs.
 */
function countByParser(entries: readonly ParseErrorEntry[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.parserAttempted, (counts.get(entry.parserAttempted) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([aParser], [bParser]) => aParser.localeCompare(bParser)),
  );
}

/**
 * Picks the inline-vs-rollup wire shape for one parse-error bucket
 * and writes the result onto the shared coverage block. DRYing the
 * branch keeps the two lanes from drifting — `parseErrorFiles`
 * bypassing verbose while `partialParseFiles` honored it would
 * re-introduce the asymmetry
 * one level down.
 */
function assignParseErrorList(
  entries: readonly ParseErrorEntry[],
  verbose: boolean,
  coverage: ParseErrorCoverageView,
  listKey: "parseErrorFiles" | "partialParseFiles",
  rollupKey: "parseErrorTopReasons" | "partialParseTopReasons",
): void {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  if (verbose || sorted.length <= PARSE_ERROR_INLINE_THRESHOLD) {
    coverage[listKey] = sorted;
    return;
  }
  coverage[rollupKey] = rollupTopReasons(sorted);
}
