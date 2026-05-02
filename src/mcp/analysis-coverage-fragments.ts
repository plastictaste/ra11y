/**
 * fragment-files bucket assembler
 *
 * Extracted from `analysis-coverage.ts` so the parent module stays
 * under the {@link MAX_FILE_LINES} budget as the markdown-residue
 * promotion gate (Q13) accreted classification + evidence threading
 * onto this sub-block. Keeps the assembly-time use of the shared
 * markdown-classifier (`buildFragmentFileEntry`) co-located with the
 * meta-array cap so a future change to either path stays within one
 * file.
 *
 * The `CoverageBlock` mutation surface is expressed as a narrow
 * structural-typed parameter so this module doesn't import the full
 * coverage interface from the parent and create a back-edge cycle —
 * only the three fragment fields are written, and TypeScript's
 * structural typing accepts a `CoverageBlock` value at the call site
 * without an explicit type cast.
 */

import type { FragmentClassificationSignals } from "../engine/layout-partial.ts";
import type { FragmentFileEntry } from "./analysis-coverage-types.ts";
import { buildFragmentFileEntry, type LayoutCompositionEvidence } from "./markdown-classifier.ts";
import { capMetaArray, type MetaArrayTruncationSummary } from "./meta-array-cap.ts";

/**
 * Narrow structural view of the `CoverageBlock` fields this assembler
 * writes. Declared locally so the sub-module doesn't reach into the
 * parent's full interface.
 */
interface FragmentCoverageWriter {
  fragmentFileCount?: number;
  fragmentFiles?: readonly FragmentFileEntry[];
  fragmentFilesTruncated?: MetaArrayTruncationSummary;
}

/**
 * Populates the `fragmentFiles` / `fragmentFileCount` /
 * `fragmentFilesTruncated` sub-block. Returns `true` when the cap
 * actually trimmed the list so the caller can OR the signal into the
 * enclosing `metaArrayTruncated` flag.
 *
 * Fragment-file list is scan-confidence telemetry naming the HTML
 * files that parsed as fragments (no `<html>` root, no `<body>`).
 * Page-level rules — `navigation/skip-link`'s primary-nav path,
 * `semantics/landmark-main`, `semantics/section-accessible-name-
 * missing` — skip these files because the premise of those checks is
 * "this document IS the page," which a partial / include target is
 * not. Shipped at every verbosity (no `verboseMeta` gate): the count
 * alone is ambiguous ("which files?") and the path list is the
 * actionable signal — same reasoning as `parseErrorFiles` /
 * `partialParseFiles`. Count + list are always populated together;
 * sorted for deterministic wire output. Capped per the shared meta-
 * array budget because fragment-heavy static sites (Jekyll
 * `_includes/`, Astro `layouts/`) can produce hundreds of paths; the
 * count stays honest even when the list is head-sliced.
 */
export function assembleFragmentFilesBlock(
  fragmentFiles: readonly {
    readonly path: string;
    readonly signals: FragmentClassificationSignals;
  }[],
  coverage: FragmentCoverageWriter,
  evidence: LayoutCompositionEvidence,
): boolean {
  coverage.fragmentFileCount = fragmentFiles.length;
  const sorted = [...fragmentFiles].sort((a, b) => a.path.localeCompare(b.path));
  const entries: FragmentFileEntry[] = sorted.map(({ path, signals }) =>
    buildFragmentFileEntry(path, signals, evidence),
  );
  const capped = capMetaArray(entries);
  coverage.fragmentFiles = capped.values;
  if (capped.truncated === undefined) return false;
  coverage.fragmentFilesTruncated = capped.truncated;
  return true;
}
