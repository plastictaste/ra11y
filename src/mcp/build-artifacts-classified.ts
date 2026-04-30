/**
 * Q12 merge surface for `meta.scannedBuildArtifacts.classified[]`.
 *
 * The build-artifact classifier in `./build-artifacts.ts` produces
 * two predicate families that historically rode on parallel meta
 * sub-fields:
 *
 *   - per-file artifact classifications ({@link ScannedBuildArtifact}),
 *     surfaced as `meta.scannedBuildArtifacts.ungrouped[]` (sub-
 *     threshold residue) — eight `BuildArtifactClassification` values
 *     covering basename infixes, path-prefix matches, sibling-set
 *     evidence, and content-shape minification.
 *   - banner-detected vendor-library identifications
 *     ({@link DetectedVendorLibrary}), surfaced as
 *     `meta.scannedBuildArtifacts.vendorLibraries[]` — banner-anchored
 *     library + version pairs from the curated table in
 *     `./build-artifacts.ts`.
 *
 * Per AI-first doctrine ("Composite headline counts are dishonest" /
 * "Cross-surface count invariant" / "Sibling fields naming the same
 * concept must use one shape"), two parallel "vendor classification"
 * surfaces forced an agent reading `meta.scannedBuildArtifacts` to
 * union the lists itself before triaging a path. Q12 lifts both
 * predicates onto a single `classified[]` keyed on path, with the
 * predicate family carried as a {@link ClassificationKind}
 * discriminator on each {@link ClassificationEntry}. A path firing
 * both predicates rides as one row carrying multiple entries; we
 * never collapse to the strongest one (per "If a single artifact
 * qualifies under multiple predicates, list multiple signals").
 *
 * Extracted into its own file so {@link build-artifacts} stays inside
 * the per-file effective-line cap. The merger reads
 * {@link ScannedBuildArtifact} and {@link DetectedVendorLibrary} —
 * neither is an internal type to the merger, so importing them keeps
 * the boundary clean.
 */

import type {
  BuildArtifactClassification,
  BuildArtifactSignal,
  DetectedVendorLibrary,
  ScannedBuildArtifact,
} from "./build-artifacts-types.ts";

/**
 * Discriminator family for {@link ClassificationEntry}, naming which
 * classifier branch fired:
 *
 *   - `min-infix` — the file's basename or content text crosses one
 *     of the "this is minified bytes" predicates
 *     (`definite-min-infix` literal `.min.` infix,
 *     `likely-minified-by-line-stats` content-shape).
 *   - `path-prefix` — the file qualifies on a path-anchored or
 *     sibling-set predicate that does NOT name "this is minified
 *     bytes" itself (`likely-bundler-output-dir`,
 *     `likely-hashed-bundle`, `likely-compiled-tailwind`,
 *     `definite-sourcemap-paired`, `definite-vendor-distribution`,
 *     `likely-vendor-distribution`). The family name is "path-anchored
 *     evidence" rather than per-predicate so the agent can budget by
 *     scope without having to enumerate the eight per-predicate
 *     classifications. The paired `classification` field on the entry
 *     still names the specific predicate that fired so auditability is
 *     preserved per "Heuristic-mislabeled meta sub-fields are
 *     dishonest."
 *   - `vendor-library-version-detected` — the file's first non-blank
 *     line matched a curated banner. Carries the `library` short
 *     identifier and (when the banner exposes one) `version`.
 */
export type ClassificationKind = "min-infix" | "path-prefix" | "vendor-library-version-detected";

/**
 * One classification observation for a path under
 * `meta.scannedBuildArtifacts.classified[]`. A path may carry
 * multiple entries when several predicates fire — per doctrine
 * "If a single artifact qualifies under multiple predicates, list
 * multiple signals — do NOT collapse to the strongest one."
 *
 * Discriminated by {@link ClassificationKind}. The build-artifact
 * variants (`min-infix`, `path-prefix`) carry the underlying
 * {@link BuildArtifactClassification} + {@link BuildArtifactSignal}
 * pair so the agent can verify the falsifiable claim. The
 * `vendor-library-version-detected` variant carries `library` and
 * (when present) `version` from the curated banner table.
 */
export type ClassificationEntry =
  | {
      readonly kind: "min-infix";
      readonly classification: "definite-min-infix" | "likely-minified-by-line-stats";
      readonly signal: BuildArtifactSignal;
    }
  | {
      readonly kind: "path-prefix";
      readonly classification: Exclude<
        BuildArtifactClassification,
        "definite-min-infix" | "likely-minified-by-line-stats"
      >;
      readonly signal: BuildArtifactSignal;
    }
  | {
      readonly kind: "vendor-library-version-detected";
      readonly library: string;
      readonly version?: string;
    };

/**
 * One classified-path row. A union of the previous `ungrouped[]`
 * (per-file build-artifact classifications under the group
 * threshold) and `vendorLibraries[]` (banner-detected library
 * identifications), keyed on `path` so both predicates' evidence for
 * the same file ride together rather than across two parallel
 * surfaces.
 *
 * `classifications` always carries ≥1 entry — a row exists only when
 * at least one predicate fired. When two or more predicates fire on
 * the same file (e.g. a Bootstrap distribution flagged by both
 * `path-prefix` via `dist/` AND `vendor-library-version-detected`
 * via the `/*! Bootstrap` banner), every fired entry rides; we never
 * collapse to the strongest one.
 */
export interface ClassifiedArtifact {
  readonly path: string;
  readonly classifications: readonly ClassificationEntry[];
}

/**
 * Maps a {@link BuildArtifactClassification} to the
 * {@link ClassificationKind} family it belongs to. Used by
 * {@link mergeClassifiedRows} to lift the predicate family onto each
 * {@link ClassificationEntry} when assembling the merged
 * `classified[]` surface.
 *
 * `definite-min-infix` and `likely-minified-by-line-stats` are the
 * two "this file IS minified bytes" predicates; everything else is a
 * path-anchored / sibling-set / banner-content predicate that lands
 * under `path-prefix` (a deliberately broad family — the paired
 * per-entry `classification` field still names the specific predicate
 * that fired so the agent can verify the falsifiable claim per
 * AI-first doctrine "Heuristic-mislabeled meta sub-fields are
 * dishonest").
 */
function classificationKindFor(
  classification: BuildArtifactClassification,
): "min-infix" | "path-prefix" {
  if (
    classification === "definite-min-infix" ||
    classification === "likely-minified-by-line-stats"
  ) {
    return "min-infix";
  }
  return "path-prefix";
}

/**
 * Lifts a build-artifact residue {@link ScannedBuildArtifact} into
 * the merged-shape {@link ClassificationEntry}. The classification
 * narrowing follows {@link classificationKindFor} — the union
 * variants on {@link ClassificationEntry} use the same partition
 * (min-infix variants vs. everything else), so the cast is exact.
 */
function buildArtifactClassificationEntry(entry: ScannedBuildArtifact): ClassificationEntry {
  const kind = classificationKindFor(entry.classification);
  if (kind === "min-infix") {
    return {
      kind: "min-infix",
      classification: entry.classification as
        | "definite-min-infix"
        | "likely-minified-by-line-stats",
      signal: entry.signal,
    };
  }
  return {
    kind: "path-prefix",
    classification: entry.classification as Exclude<
      BuildArtifactClassification,
      "definite-min-infix" | "likely-minified-by-line-stats"
    >,
    signal: entry.signal,
  };
}

/**
 * POSIX-relativize `filePath` against `rootPosix`. Mirrors the helper
 * inside {@link build-artifacts}'s grouper so the merge keys agree on
 * path shape; returns `null` when the path equals the root, escapes
 * via `..`, or is an absolute host path that doesn't share the root
 * prefix. Vendor libraries with paths the relativizer rejects are
 * dropped — they're meaningless as a classified entry the same way
 * escaped paths are dropped from the grouped buckets.
 */
function relativizeToPosixForMerge(filePath: string, rootPosix: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const rootTrimmed = rootPosix.endsWith("/") ? rootPosix.slice(0, -1) : rootPosix;
  if (normalized === rootTrimmed) return null;
  if (normalized.startsWith(`${rootTrimmed}/`)) {
    const rel = normalized.slice(rootTrimmed.length + 1);
    if (rel === "" || rel.startsWith("../")) return null;
    return rel;
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return null;
  if (normalized.startsWith("../")) return null;
  return normalized;
}

/**
 * Builds the merged `classified[]` rows. Joins the per-file
 * build-artifact residue (the post-grouping `ungrouped` set) with the
 * banner-detected vendor-library list, keyed on root-relative POSIX
 * path. A path that fires multiple predicates collects multiple
 * {@link ClassificationEntry} entries; predicate evidence is never
 * collapsed.
 *
 * The vendor-library list is relativized against `root` via
 * {@link relativizeToPosixForMerge} so the merge key matches the form
 * the build-artifact residue uses (already relativized inside
 * `build-artifacts.ts`'s `bucketByBasename`). Vendor libraries whose
 * path escapes the scan root are dropped.
 *
 * Output is sorted by `path` ascending, with the per-row
 * `classifications` ordered as: build-artifact entries (in the order
 * their `BuildArtifactSignal` produced them), then any
 * `vendor-library-version-detected` entries. Stable across runs.
 */
export function mergeClassifiedRows(
  buildArtifactResidue: readonly ScannedBuildArtifact[],
  vendorLibraries: readonly DetectedVendorLibrary[],
  root: string,
): readonly ClassifiedArtifact[] {
  const rootPosix = root.replace(/\\/g, "/");
  const byPath = new Map<string, ClassificationEntry[]>();
  for (const entry of buildArtifactResidue) {
    const list = byPath.get(entry.path);
    const next = buildArtifactClassificationEntry(entry);
    if (list === undefined) byPath.set(entry.path, [next]);
    else list.push(next);
  }
  for (const lib of vendorLibraries) {
    const rel = relativizeToPosixForMerge(lib.path, rootPosix);
    if (rel === null) continue;
    const entry: ClassificationEntry =
      lib.version === undefined
        ? { kind: "vendor-library-version-detected", library: lib.library }
        : { kind: "vendor-library-version-detected", library: lib.library, version: lib.version };
    const list = byPath.get(rel);
    if (list === undefined) byPath.set(rel, [entry]);
    else list.push(entry);
  }
  const out: ClassifiedArtifact[] = [];
  for (const [path, classifications] of byPath) {
    out.push({ path, classifications });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
