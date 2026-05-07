/**
 * Deterministic file-fingerprint pre-pass.
 *
 * Catalog corpora (website-template marketplaces, multi-site WordPress
 * exports, vendored asset pipelines) ship the same vendor file
 * byte-identically into 100+ sibling template subdirectories — one
 * `bootstrap.min.css` per template directory, one
 * `font-awesome.min.css` per theme, etc. Without a deterministic
 * fingerprint pre-pass:
 *
 *   - The parser pays the cost of parsing every byte-identical copy
 *     (a 200KB minified CSS bundle parsed 116 times is the canonical
 *     bulk-catalog regression).
 *   - Each parsed copy emits the same findings independently — so a
 *     single canonical issue inflates into N near-duplicate response
 *     rows. The existing basename-keyed dedupe in
 *     `src/mcp/vendor-dedupe.ts` collapses findings post-scan, but only
 *     after every copy has been parsed; this helper closes the
 *     parse-cost half of the same story.
 *
 * The fingerprint helper is pure: it takes a list of file paths plus a
 * byte-source (a synchronous reader the caller wires once), groups
 * eligible-extension paths by SHA-1 of their full contents, and returns
 * the canonical-only path list plus a `Map<canonicalPath,
 * readonly duplicatePaths[]>` describing the groups that collapsed. The
 * caller skips parsing duplicates and stamps `vendorOccurrences` on
 * canonical-derived findings using the duplicate map.
 *
 * Eligibility — the extension allowlist is deliberately narrow:
 *
 *   - `.css` — vendor stylesheet drops (bootstrap, animate, font-awesome,
 *     fancybox, flexslider, etc.). Most authored CSS is unique per file;
 *     byte-identical CSS across sibling directories is the vendor-copy
 *     pattern by construction.
 *   - `.js` / `.mjs` — vendor JS bundles dropped byte-identically into
 *     sibling templates. Authored JS varies even when filenames repeat
 *     (every project has its own `index.js`), so byte-identity is the
 *     load-bearing signal — extension alone would over-collapse.
 *   - `.svg` — bundled icon-set assets (font-awesome, feather-icons)
 *     copied verbatim across sibling theme directories.
 *
 * Per AI-first doctrine "Surface, don't suppress" — the dedupe is
 * lossless: every duplicate path surfaces in the
 * `vendorOccurrences` list on the canonical finding so an agent can
 * iterate every copy at a glance.
 */

import { createHash } from "node:crypto";
import { extension } from "../utils/path.ts";

/**
 * Extensions on which the file-fingerprint pre-pass runs. The set is
 * narrow by design: byte-identity across sibling files is the vendor-
 * copy pattern by construction on these extensions, where the alternate
 * "two authored copies happen to be byte-identical" hypothesis is
 * vanishingly rare. Lower-cased so a `.CSS` from a Windows-authored
 * repo classifies the same way; matches the lower-cased output of
 * {@link extension}. Exported for tests so the fixture suite pins the
 * eligibility surface to a worked example.
 */
export const FINGERPRINT_ELIGIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".css",
  ".js",
  ".mjs",
  ".svg",
]);

/**
 * Threshold: a hash bucket collapses only when it spans ≥ this many
 * distinct file paths. Set at 2 so the dedupe fires as soon as a
 * genuine cross-file duplicate exists — a single-file bucket is an
 * independent finding, not a vendor-copy pattern. Exported so tests can
 * pin the constant against an explicit worked example.
 */
export const FINGERPRINT_DEDUPE_MIN_DISTINCT_PATHS = 2;

/**
 * Result of the fingerprint pre-pass. `canonicalFiles` is the input
 * file list with byte-duplicates dropped (canonical paths kept,
 * duplicates removed). `duplicatesByCanonical` is the map an agent
 * downstream consults: keyed by canonical path, valued by the
 * lex-sorted list of every other file with the same hash. Paths NOT
 * present as keys had no duplicates (the common case for authored
 * code) and need no special handling. The map is empty when no
 * fingerprint duplicates were found — callers branch on `.size === 0`.
 */
export interface FingerprintResult {
  readonly canonicalFiles: readonly string[];
  readonly duplicatesByCanonical: ReadonlyMap<string, readonly string[]>;
}

/**
 * True when `filePath`'s extension is in
 * {@link FINGERPRINT_ELIGIBLE_EXTENSIONS}. Centralized so the predicate
 * stays in one place — the discovery walker, the parse-time skip, and
 * the post-scan stamp all share one eligibility surface.
 */
export function isFingerprintEligibleExtension(filePath: string): boolean {
  return FINGERPRINT_ELIGIBLE_EXTENSIONS.has(extension(filePath));
}

/**
 * Computes the SHA-1 of `bytes` as a hex string. Exported so tests can
 * pin the hash function against a known-good fixture without depending
 * on the helper's internal layout. SHA-1 is sufficient here because
 * the hash is used purely for byte-equality grouping (not for any
 * security predicate); a collision would just suppress a duplicate
 * finding that the agent could still recover via direct file read.
 */
export function fingerprintBytes(bytes: string | Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/**
 * Groups eligible-extension files by their SHA-1 fingerprint and
 * returns the canonical-only file list plus the duplicate-by-canonical
 * map. Files with non-eligible extensions pass through unchanged in
 * `canonicalFiles` (they are never grouped or hashed); only the
 * eligible subset is fingerprinted.
 *
 * The reader callback is invoked once per eligible path and is
 * expected to return that file's bytes (string or Buffer is
 * acceptable — both feed `crypto.createHash` directly). When the
 * reader throws or returns null/undefined, the path is treated as a
 * read failure: it stays in `canonicalFiles` (no skip) and is never
 * grouped (the safe default — better to parse a file twice than to
 * silently drop one whose contents we couldn't verify).
 *
 * Pure over its inputs (no I/O) — the I/O happens inside the
 * caller-supplied reader, so the helper can be unit-tested with an
 * in-memory map and integration-tested through the discovery wire.
 */
export async function fingerprintEligibleDuplicates(
  filePaths: readonly string[],
  read: (path: string) => Promise<string | Buffer | null | undefined>,
): Promise<FingerprintResult> {
  const groups = await groupByFingerprint(filePaths, read);
  return assembleFingerprintResult(groups);
}

/** Internal: per-pass classification of an input path list. */
interface FingerprintGroups {
  readonly ineligible: readonly string[];
  readonly unhashable: readonly string[];
  readonly eligibleByHash: ReadonlyMap<string, readonly string[]>;
}

/**
 * Bucket pass: classify each input path as ineligible (extension not
 * in the allowlist), unhashable (reader threw / returned null), or
 * eligible-and-grouped (by SHA-1 of bytes). Pure over the reader's
 * I/O semantics — the reader is the only side-effectful seam.
 */
async function groupByFingerprint(
  filePaths: readonly string[],
  read: (path: string) => Promise<string | Buffer | null | undefined>,
): Promise<FingerprintGroups> {
  const ineligible: string[] = [];
  const eligibleByHash = new Map<string, string[]>();
  const unhashable: string[] = [];
  for (const filePath of filePaths) {
    if (!isFingerprintEligibleExtension(filePath)) {
      ineligible.push(filePath);
      continue;
    }
    const bytes = await tryRead(read, filePath);
    if (bytes === null || bytes === undefined) {
      unhashable.push(filePath);
      continue;
    }
    const hash = fingerprintBytes(bytes);
    const bucket = eligibleByHash.get(hash);
    if (bucket === undefined) eligibleByHash.set(hash, [filePath]);
    else bucket.push(filePath);
  }
  return { ineligible, unhashable, eligibleByHash };
}

/** Reader wrapper that swallows exceptions so the caller's loop stays linear. */
async function tryRead(
  read: (path: string) => Promise<string | Buffer | null | undefined>,
  filePath: string,
): Promise<string | Buffer | null | undefined> {
  try {
    return await read(filePath);
  } catch {
    return null;
  }
}

/**
 * Assembly pass: walk the eligible-by-hash groups, split singletons
 * (canonical-only, no duplicates) from collapsed groups (canonical +
 * lex-sorted duplicates), and merge with the ineligible / unhashable
 * pass-through lists into the final result. Canonical list is sorted
 * lex-ascending so the wire shape is deterministic across runs.
 */
function assembleFingerprintResult(groups: FingerprintGroups): FingerprintResult {
  const canonical: string[] = [...groups.ineligible, ...groups.unhashable];
  const duplicatesByCanonical = new Map<string, readonly string[]>();
  for (const bucket of groups.eligibleByHash.values()) {
    if (bucket.length < FINGERPRINT_DEDUPE_MIN_DISTINCT_PATHS) {
      canonical.push(bucket[0] as string);
      continue;
    }
    const sorted = [...bucket].sort();
    const [head, ...rest] = sorted;
    if (head === undefined) continue;
    canonical.push(head);
    duplicatesByCanonical.set(head, rest);
  }
  canonical.sort();
  return { canonicalFiles: canonical, duplicatesByCanonical };
}
