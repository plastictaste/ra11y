/**
 * Scope-shape primitives for the conformance statement — the file
 * manifest, build-artifact-skipped manifest, scan root, and per-claim
 * commit/config anchors. Extracted from `conformance.ts` so that file
 * stays under the 500-effective-line budget after the
 * V1-CONFORMANCE-SCOPE-FILES-MINIFIED-LEAK split surfaced
 * `skippedFiles` / `skippedFilesCount` as siblings of `files` /
 * `filesCount`. The renderer module (`conformance-markdown.ts`)
 * imports `ConformanceStatementScope` from here transitively via
 * `conformance.ts`'s re-export, so callers' import paths don't change.
 */

/**
 * One entry on {@link ConformanceStatementScope.skippedFiles}: a file
 * the scanner parsed but excluded from the conformance claim because
 * the build-artifact classifier flagged it (minified bundle, hashed
 * vendor file, sourcemap-paired bundle, …). `path` mirrors the
 * scanner's path verbatim — same shape the rest of the scope manifest
 * uses, so a caller can join against the build-artifacts meta field
 * directly. `reason` carries the build-artifact classifier verdict
 * (e.g. `"definite-min-infix"`, `"likely-bundler-output-dir"`) so the
 * agent can route triage to a `propose_config` exclude or dismiss the
 * skip with one read. The `definite-` / `likely-` prefix matches the
 * confidence-grade contract carried elsewhere on the response.
 */
export interface SkippedConformanceFile {
  readonly path: string;
  readonly reason: string;
}

/**
 * Scope of the conformance claim in a static-scanner context — a file
 * set (not a URL set, since ra11y inspects source trees rather than
 * deployed pages). ADR 0017 reserves space here for the commit anchor,
 * config snapshot, and process definitions; the commit/config fields
 * are optional and follow the AI-first consumer model's
 * present-when-meaningful rule. The signing flow
 * (V1-CERT-STATEMENT-SIGN) is the call site that wires the commit
 * hash through.
 */
export interface ConformanceStatementScope {
  /**
   * Count of files actually included in the conformance claim — the
   * load-bearing manifest size the verdict stands on. Always present
   * (including `0` when nothing was scanned) so a reader can
   * distinguish "not truncated" from "field absent", and so the count
   * stays honest even when {@link files} is capped or elided for
   * response-size reasons.
   *
   * V1-CONFORMANCE-SCOPE-FILES-MINIFIED-LEAK: this counter reflects
   * EVALUATED files only — files the build-artifact classifier flagged
   * (minified bundles, hashed vendors, sourcemap-paired output) are
   * excluded from the claim and surface separately on
   * {@link skippedFiles} / {@link skippedFilesCount}. A procurement
   * reviewer reading "files in scope" no longer conflates the
   * evaluated set with the parsed set.
   */
  readonly filesCount: number;
  /**
   * Scan root — typically the caller's `cwd`. Always present so a
   * statement bundle dropped into release notes names the subtree the
   * claim covers without cross-referencing the original tool call.
   */
  readonly root: string;
  /**
   * File paths actually included in the conformance claim. Paths are
   * mirrored verbatim from the caller; the builder does not normalize.
   * Present-when-meaningful: the tool layer elides this array when it
   * would exceed its configured cap. When absent, rely on
   * {@link filesCount} for size.
   */
  readonly files?: readonly string[];
  /**
   * Files the scanner parsed but the build-artifact classifier flagged
   * (minified bundles, hashed vendor files, sourcemap-paired output).
   * Each entry carries the classifier verdict as `reason`. Present-
   * when-meaningful: omitted entirely when no file was skipped, and
   * elided alongside {@link files} when the tool layer triggers the
   * `scope_files_truncated_count_exceeded` warning ({@link
   * skippedFilesCount} stays present to name the real count).
   */
  readonly skippedFiles?: readonly SkippedConformanceFile[];
  /**
   * Count of files excluded from the claim because of build-artifact
   * classification. Present whenever it would be non-zero; omitted
   * (alongside {@link skippedFiles}) when no file was skipped.
   *
   * V1-CONFORMANCE-SCOPE-FILES-MINIFIED-LEAK: split from
   * {@link filesCount} so a top-level "what did this claim cover?"
   * count never sums evaluated + skipped. Composite headline counts
   * are dishonest at the procurement-surface layer too.
   */
  readonly skippedFilesCount?: number;
  /**
   * Git commit hash at scan time. Omitted when the caller did not
   * supply one. Never emitted as an empty string.
   */
  readonly commitHash?: string;
  /**
   * Snapshot of the `ra11y.config.ts` fields active during the scan.
   * Omitted when the caller did not supply one; never `{}`.
   */
  readonly configSnapshot?: Record<string, unknown>;
}

/**
 * Inputs the builder consumes to emit one
 * {@link ConformanceStatementScope}. Mirrors the scope-related slice of
 * the public {@link import("./conformance.ts").BuildConformanceStatementInputs}
 * — the conformance builder forwards exactly these fields verbatim into
 * {@link buildStatementScope}.
 */
export interface ConformanceScopeInputs {
  readonly filesCount?: number;
  readonly files?: readonly string[];
  readonly skippedFiles?: readonly SkippedConformanceFile[];
  readonly skippedFilesCount?: number;
  readonly root?: string;
  readonly commitHash?: string;
  readonly configSnapshot?: Record<string, unknown>;
}

/**
 * Assembles the statement's {@link ConformanceStatementScope} from the
 * builder inputs. `filesCount` is always present (load-bearing: agents
 * reading a truncated response still need the real count); `files` is
 * present-when-meaningful (elided by the tool layer when it would blow
 * the response budget). Commit hash and config snapshot are
 * present-when-meaningful — empty strings and empty objects map to
 * field omission, not sentinel values.
 *
 * V1-CONFORMANCE-SCOPE-FILES-MINIFIED-LEAK: `skippedFiles` /
 * `skippedFilesCount` are paired present-when-meaningful — both
 * omitted when zero files were skipped, both populated when at least
 * one build-artifact-flagged file was excluded from the claim.
 */
export function buildStatementScope(inputs: ConformanceScopeInputs): ConformanceStatementScope {
  const hasCommit = inputs.commitHash !== undefined && inputs.commitHash.length > 0;
  const hasSnapshot = Object.keys(inputs.configSnapshot ?? {}).length > 0;
  const skippedFilesCount =
    inputs.skippedFilesCount ??
    (inputs.skippedFiles === undefined ? 0 : inputs.skippedFiles.length);
  const skippedFilesNonEmpty = inputs.skippedFiles !== undefined && inputs.skippedFiles.length > 0;
  return {
    filesCount: inputs.filesCount ?? inputs.files?.length ?? 0,
    root: inputs.root ?? ".",
    ...(inputs.files !== undefined && { files: inputs.files }),
    ...(skippedFilesNonEmpty && { skippedFiles: inputs.skippedFiles }),
    ...(skippedFilesCount > 0 && { skippedFilesCount }),
    ...(hasCommit && { commitHash: inputs.commitHash }),
    ...(hasSnapshot && { configSnapshot: inputs.configSnapshot }),
  };
}
