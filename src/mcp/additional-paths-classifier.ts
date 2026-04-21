/**
 * Per-path skip classifier for `scan_project`'s `additionalPaths`.
 *
 * `additionalPathsScanned.filesAdded: 0` alone hides WHY a given
 * caller-supplied path contributed nothing — it silently conflates
 * missing paths, unparseable extensions, config-excluded paths, and
 * the honest "directory exists but has no parseable files inside"
 * case. Classifier emits a structured `skipped` entry per-path for
 * the first three (deterministic) reasons; the fourth falls through
 * without an entry, because the response-level
 * `extensions_skipped_no_parser` warning already carries that signal.
 *
 * Judgment pin: for a directory entry that exists AND isn't matched
 * by an exclude pattern, we deliberately do NOT emit a skip entry
 * even when `filesAdded` is 0 for it — adding a
 * `no-parseable-files-inside-directory` enum would duplicate signal
 * the response-level warning already carries.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { compileGlobs } from "../utils/glob.ts";
import { hasParseableExtension } from "../utils/path.ts";

/** Per-path skip reason surfaced on `additionalPathsScanned.skipped`. */
export interface AdditionalPathSkip {
  readonly path: string;
  readonly reason: "not-found" | "unsupported-extension" | "excluded-by-glob";
}

/**
 * Classifies each `additionalPaths` entry into a skip reason so the
 * caller can distinguish "the path contributed" from "the path was
 * dropped for reason X."
 *
 * Preserves input ordering so the output array reads in the same
 * order the caller supplied `additionalPaths` — skipping the entries
 * that weren't classified as skipped, preserving the relative order
 * of those that were.
 */
export function classifyAdditionalPathSkips(
  additionalPaths: readonly string[],
  root: string,
  excludes: readonly string[],
): readonly AdditionalPathSkip[] {
  const matcher = compileGlobs(excludes);
  const out: AdditionalPathSkip[] = [];
  for (const entry of additionalPaths) {
    const abs = isAbsolute(entry) ? entry : resolve(root, entry);
    if (!existsSync(abs)) {
      out.push({ path: entry, reason: "not-found" });
      continue;
    }
    let isFile = false;
    try {
      isFile = statSync(abs).isFile();
    } catch {
      // existsSync passed but stat failed (permission race, etc.);
      // treat as non-file and fall through to the glob check.
    }
    if (isFile && !hasParseableExtension(abs)) {
      out.push({ path: entry, reason: "unsupported-extension" });
      continue;
    }
    const relPath = relative(root, abs).replace(/\\/g, "/");
    if (relPath.length > 0 && matcher.matches(relPath)) {
      out.push({ path: entry, reason: "excluded-by-glob" });
    }
    // The path exists, is either a parseable-extension file or a
    // directory, and isn't excluded. Either it contributed files OR
    // (directory case) it exists and held no parseable files inside.
    // The latter is deliberately NOT emitted as a skip entry —
    // response-level `extensions_skipped_no_parser` already covers it.
  }
  return out;
}

/**
 * Builds the full `additionalPathsScanned` meta field for a
 * scan_project response. Returns a conditional-spread object so the
 * handler can mix it into `meta` unconditionally — omitted entirely
 * when the caller passed no `additionalPaths`, or populated with
 * `paths` / `filesAdded` / optional `skipped` / `note` otherwise.
 */
export function additionalPathsScannedField(args: {
  readonly additionalPaths: readonly string[];
  readonly filesAdded: number;
  readonly root: string;
  readonly excludes: readonly string[];
}): {
  readonly additionalPathsScanned?: {
    readonly paths: readonly string[];
    readonly filesAdded: number;
    readonly skipped?: readonly AdditionalPathSkip[];
    readonly note: string;
  };
} {
  const { additionalPaths, filesAdded, root, excludes } = args;
  if (additionalPaths.length === 0) return {};
  const skipped = classifyAdditionalPathSkips(additionalPaths, root, excludes);
  return {
    additionalPathsScanned: {
      paths: additionalPaths,
      filesAdded,
      ...(skipped.length > 0 ? { skipped } : {}),
      note: "These paths bypassed `.gitignore` and the default build-dir skips. User `exclude` patterns still applied.",
    },
  };
}
