/**
 * Shared types for the build-artifact classifier and the Q12
 * `classified[]` merger. Extracted into its own module to break the
 * import cycle that would otherwise exist between
 * {@link build-artifacts} (the classifier) and
 * {@link build-artifacts-classified} (the merger that lifts both
 * predicate families onto the unified `classified[]` surface).
 *
 * The classifier produces {@link ScannedBuildArtifact} records and
 * {@link DetectedVendorLibrary} records; the merger consumes both.
 * Keeping the shared types here means both modules import down,
 * never sideways.
 */

/**
 * Confidence-graded classification emitted on
 * {@link ScannedBuildArtifact.classification}. The `definite-*`
 * prefix is reserved for predicates whose verdict is provable from
 * the path or the live scan set alone (`.min.` infix in the
 * basename, paired `.map` sibling); `likely-*` covers the heuristic
 * predicates (corroborated long-line probe, hex-segment basename,
 * build-dir segment, tailwind escape selector) that fire on
 * authored content with non-trivial frequency. The agent reading
 * `classification` budgets per the prefix — `definite-*` means
 * "skip per-file investigation, route to vendor exclude," `likely-*`
 * means "investigate to confirm before routing." See the file-level
 * comment block in {@link build-artifacts} for the per-variant
 * predicate.
 */
export type BuildArtifactClassification =
  | "definite-min-infix"
  | "definite-sourcemap-paired"
  | "definite-vendor-distribution"
  | "likely-minified-by-line-stats"
  | "likely-hashed-bundle"
  | "likely-bundler-output-dir"
  | "likely-compiled-tailwind"
  | "likely-vendor-distribution";

/**
 * Per-entry deterministic explanation of *which* predicate fired
 * for a {@link BuildArtifactClassification}. Each variant's
 * documentation lives next to the predicate that emits it inside
 * {@link build-artifacts}.
 */
export type BuildArtifactSignal =
  | { readonly kind: "min-infix"; readonly value: string }
  | { readonly kind: "hex-segment-in-basename"; readonly value: string }
  | { readonly kind: "build-dir-segment"; readonly value: string }
  | { readonly kind: "tailwind-escape-selector"; readonly value: string }
  | {
      readonly kind: "max-line-length-exceeds-threshold";
      readonly value: number;
      readonly threshold: number;
      readonly corroborator: "median" | "ratio";
    }
  | { readonly kind: "sibling-map-file"; readonly value: string }
  | { readonly kind: "sibling-min-file"; readonly value: string }
  | { readonly kind: "sourcemap-pointer-min"; readonly value: string }
  | { readonly kind: "vendor-banner-version"; readonly value: string }
  | { readonly kind: "vendor-copyright-banner"; readonly value: string };

/**
 * One classified artifact entry produced by `collectBuildArtifacts`
 * inside {@link build-artifacts}. Carries the path, the matching
 * {@link BuildArtifactClassification} verdict, and the deterministic
 * {@link BuildArtifactSignal} that fired.
 */
export interface ScannedBuildArtifact {
  readonly path: string;
  readonly classification: BuildArtifactClassification;
  readonly signal: BuildArtifactSignal;
}

/**
 * Detailed per-file classification result returned by
 * `classifyBuildArtifactDetailed` inside {@link build-artifacts}:
 * pairs the {@link BuildArtifactClassification} verdict with the
 * deterministic {@link BuildArtifactSignal} that fired.
 */
export interface BuildArtifactClassificationResult {
  readonly classification: BuildArtifactClassification;
  readonly signal: BuildArtifactSignal;
}

/**
 * per-file vendor-library identification derived from first-line
 * banner-comment matching against a curated list of well-known
 * libraries. Surfaces inside the merged
 * `meta.scannedBuildArtifacts.classified[].classifications[]` rows
 * carrying `kind: "vendor-library-version-detected"`.
 *
 * `version` is omitted (not `null`, not `""`) when the banner doesn't
 * carry a parseable version string — per the present-when-meaningful
 * rule. The agent reading a `DetectedVendorLibrary` without a
 * `version` knows the library was identified but the version was not
 * in the banner; it does not have to disambiguate "unknown" from
 * "version 0".
 */
export interface DetectedVendorLibrary {
  readonly path: string;
  readonly library: string;
  readonly version?: string;
}
