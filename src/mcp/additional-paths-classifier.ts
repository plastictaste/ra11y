/**
 * Per-path skip classifier for `scan_project`'s `additionalPaths`.
 *
 * `additionalPathsScanned.filesAdded: 0` alone hides WHY a given
 * caller-supplied path contributed nothing — it silently conflates
 * missing paths, unparseable extensions, config-excluded paths, and
 * the honest "directory exists but has no parseable files inside"
 * case. Classifier emits a structured `skipped` entry per-path for
 * every deterministic reason, including the fourth case:
 * `no-parseable-files` with `{ [ext]: count }` payload echoing the
 * observed extensions so the agent can distinguish "Ruby-only tree"
 * from "directory absent" from "path silently skipped."
 *
 * prior versions fell
 * through without a skip entry when the directory held only
 * non-parseable files, leaning on the response-level
 * `text_source_skipped` / `binary_assets_skipped` warnings. That was
 * dishonest — the
 * aggregated warning doesn't tell the caller which `additionalPaths`
 * entry was the one that contributed nothing, so `filesAdded: 0` on a
 * `{additionalPaths: ["rake/"]}` call on a Ruby-only directory read
 * as "silently skipped" to the agent. The per-path skip entry names
 * the condition the caller can act on.
 */

import type { Dirent } from "node:fs";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { compileGlobs } from "../utils/glob.ts";
import {
  extension,
  hasParseableExtension,
  PARSEABLE_EXTENSIONS,
  posixJoin,
  posixRelative,
  posixResolve,
} from "../utils/path.ts";

/** Per-path skip reason surfaced on `additionalPathsScanned.skipped`. */
export type AdditionalPathSkip =
  | {
      readonly path: string;
      readonly reason: "not-found" | "unsupported-extension" | "excluded-by-glob";
    }
  | {
      readonly path: string;
      readonly reason: "no-parseable-files";
      /**
       * Observed extension histogram from the directory's files. Keys
       * are lowercase extensions with a leading dot (e.g. `.rb`, `.py`,
       * `""` for extensionless files). Values are the count of files
       * with that extension observed in the bounded walk. Present only
       * when at least one file was seen; empty directories don't emit
       * this reason.
       */
      readonly extensions: Readonly<Record<string, number>>;
    };

/**
 * Soft cap on the number of files enumerated while counting extensions
 * for the `no-parseable-files` reason. An `additionalPaths` entry
 * pointing at a huge off-tree vendor dump shouldn't turn the classifier
 * into a full walk. The histogram is a signal about the dominant
 * extensions, not an exhaustive tally — stopping early still gives the
 * agent the answer it needs ("this tree is `.rb` plus a sprinkle of
 * `.yml`").
 */
const NO_PARSEABLE_FILES_WALK_CAP = 500;

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
    const skip = classifyOneAdditionalPath(entry, root, matcher);
    if (skip !== null) out.push(skip);
    // When null: the path either contributed files OR was redundant
    // with the base set (handled by `redundant_additional_paths`), OR
    // was an empty directory. None of those warrant a skip entry.
  }
  return out;
}

/**
 * Classifies a single caller-supplied entry and returns its skip
 * record (or null if the entry contributed / was empty / was
 * redundant). Extracted so the main function's cognitive complexity
 * stays under the lint cap; the per-entry logic reads top-to-bottom
 * as the checks fall through.
 */
function classifyOneAdditionalPath(
  entry: string,
  root: string,
  matcher: ReturnType<typeof compileGlobs>,
): AdditionalPathSkip | null {
  const abs = isAbsolute(entry) ? entry : posixResolve(root, entry);
  if (!existsSync(abs)) return { path: entry, reason: "not-found" };
  const { isFile, isDir } = safeStat(abs);
  if (isFile && !hasParseableExtension(abs)) {
    return { path: entry, reason: "unsupported-extension" };
  }
  const relPath = posixRelative(root, abs).replace(/\\/g, "/");
  if (relPath.length > 0 && matcher.matches(relPath)) {
    return { path: entry, reason: "excluded-by-glob" };
  }
  if (isDir) return classifyDirectoryForParseable(entry, abs);
  return null;
}

/**
 * Per-directory classification for the `no-parseable-files` reason.
 * Walks the directory (bounded by
 * {@link NO_PARSEABLE_FILES_WALK_CAP}) and emits a skip record when
 * at least one file was seen but none carried a parseable extension.
 */
function classifyDirectoryForParseable(entry: string, abs: string): AdditionalPathSkip | null {
  // directory exists
  // and isn't excluded — walk it (bounded) to count extensions. If
  // we observed ≥1 file and none were parseable, the path
  // contributed nothing to the scan and the caller deserves to know
  // which extensions dominated so they can decide whether to (a) fix
  // the path, (b) request parser coverage for that language, or
  // (c) drop the flag.
  const histogram = collectDirectoryExtensions(abs);
  const totalFiles = sumHistogram(histogram);
  const parseableFiles = sumParseable(histogram);
  if (totalFiles > 0 && parseableFiles === 0) {
    return { path: entry, reason: "no-parseable-files", extensions: histogram };
  }
  return null;
}

/** Wraps `statSync` so an EPERM/ETXTBSY race doesn't escape the classifier. */
function safeStat(abs: string): { readonly isFile: boolean; readonly isDir: boolean } {
  try {
    const st = statSync(abs);
    return { isFile: st.isFile(), isDir: st.isDirectory() };
  } catch {
    // existsSync passed but stat failed (permission race, etc.);
    // treat as non-file/non-dir — the caller's glob check still runs.
    return { isFile: false, isDir: false };
  }
}

/**
 * Recursively counts file extensions under `dir`, bounded by
 * {@link NO_PARSEABLE_FILES_WALK_CAP}. Honors the scanner's
 * `DEFAULT_IGNORED_DIRS` set in spirit by skipping dot-files and
 * dot-directories; we deliberately do NOT skip `node_modules` etc.
 * here because `additionalPaths` is the caller's escape hatch and
 * excluding those would re-introduce the silent-skip the classifier
 * exists to prevent.
 */
function collectDirectoryExtensions(dir: string): Readonly<Record<string, number>> {
  const histogram: Record<string, number> = {};
  const counter = { filesSeen: 0 };
  walkForExtensions(dir, histogram, counter);
  return histogram;
}

function walkForExtensions(
  dir: string,
  histogram: Record<string, number>,
  counter: { filesSeen: number },
): void {
  if (counter.filesSeen >= NO_PARSEABLE_FILES_WALK_CAP) return;
  // `readdirSync(..., { withFileTypes: true })` returns
  // `Dirent<string>[]` at runtime, but the TS overload resolution
  // picks the `Dirent<NonSharedBuffer>` shape without an explicit
  // annotation. Name the shape directly — same pattern as
  // `src/utils/fs.ts`.
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent<string>[];
  } catch {
    return;
  }
  for (const dirent of entries) {
    if (counter.filesSeen >= NO_PARSEABLE_FILES_WALK_CAP) return;
    if (dirent.name.startsWith(".")) continue;
    const full = posixJoin(dir, dirent.name);
    if (dirent.isDirectory()) {
      walkForExtensions(full, histogram, counter);
      continue;
    }
    if (!dirent.isFile()) continue;
    const ext = extension(dirent.name);
    histogram[ext] = (histogram[ext] ?? 0) + 1;
    counter.filesSeen += 1;
  }
}

function sumHistogram(histogram: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const count of Object.values(histogram)) total += count;
  return total;
}

function sumParseable(histogram: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [ext, count] of Object.entries(histogram)) {
    if (PARSEABLE_EXTENSIONS.has(ext)) total += count;
  }
  return total;
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
