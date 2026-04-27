/**
 * Vendor-distribution detection helpers, extracted from
 * `build-artifacts.ts` so the parent module stays under the file-line
 * cap. Pairs with the `definite-vendor-distribution` and
 * `likely-vendor-distribution` classifications: the helpers below
 * produce the paired {@link BuildArtifactSignal} when one of two
 * cross-file-set / source-text predicates fires, and `null` when
 * neither does.
 *
 * The module is self-contained — it imports only the
 * {@link BuildArtifactSignal} type from the parent — so there is no
 * cycle with `build-artifacts.ts`. The third predicate
 * (banner-with-version) stays in the parent file because it depends
 * on the parent's `detectVendorLibraryForFile` helper and the curated
 * `VENDOR_LIBRARY_BANNERS` table; pulling those across the boundary
 * would either force a cycle or duplicate the table.
 *
 * History: this module was extracted when the parent file crossed the
 * 500-line cap during the `definite-vendor-distribution` /
 * `likely-vendor-distribution` classification split. The split
 * addresses the field-report shape where readable vendor distributions
 * (jQuery 1.x source, prettify.js, livereload.js, wow.js shipped
 * alongside `wow.min.js`) were silently mislabeled as
 * `likely-minified-by-line-stats` because their bodies crossed the
 * line-stats threshold — routing the agent to skip findings on the
 * file the user can read while the actually-minified sibling got the
 * same label.
 */

/**
 * Local sub-shape of {@link BuildArtifactSignal} narrowed to the
 * variants this module emits. Defining the return type locally
 * (rather than importing the parent's union) keeps the import graph
 * acyclic — `build-artifacts.ts` imports the helpers below, but this
 * module imports nothing from the parent, so the cycle-detector and
 * runtime ESM init order both stay clean. The variant shape is a
 * structural subset of the parent's `BuildArtifactSignal` union, so
 * the helpers' return values flow into the parent's return slots
 * without a cast.
 */
type VendorDistributionSignal =
  | { readonly kind: "sourcemap-pointer-min"; readonly value: string }
  | { readonly kind: "vendor-banner-version"; readonly value: string }
  | { readonly kind: "vendor-copyright-banner"; readonly value: string };

/**
 * Matches `//#` / `//@` `sourceMappingURL=<path>` where the target
 * contains a `.min` segment before `.map`. Examples that match:
 *   //# sourceMappingURL=jquery.min.map
 *   //@ sourceMappingURL=app.min.js.map
 *   //# sourceMappingURL=../dist/bundle.min.css.map
 * Examples that do not match (covered by the sibling-map branch
 * elsewhere):
 *   //# sourceMappingURL=app.js.map        — bundler output, not minified
 *   //# sourceMappingURL=data:application/json;base64,...   — inline map
 */
const SOURCEMAP_POINTER_TO_MIN_RE = /\/\/[#@]\s*sourceMappingURL=\S*\.min(?:\.[\w-]+)*\.map\b/u;

/**
 * Local copy of the `.min.` infix matcher. Pulling the parent
 * module's `MIN_INFIX_RE` would create a cycle; the predicate is one
 * regex literal so duplicating it here keeps both files self-contained
 * while the parent file's copy continues to power
 * `definite-min-infix` classification at the per-file layer.
 */
const MIN_INFIX_RE = /\.min\./u;

/**
 * Returns the structured `sourcemap-pointer-min` signal when the
 * leading 4096 chars of `source` carry a `sourceMappingURL=…min….map`
 * pointer; `null` otherwise.
 *
 * The probe scans the leading 4096 chars only — sourcemap pointers
 * conventionally sit either at the very top of the file (right after
 * a banner) or as the trailing line; the 4KB head covers the canonical
 * top-of-file shape without paying a full-file scan. Files whose
 * pointer sits at the bottom of a multi-megabyte readable source are
 * not the field-report shape this targets and stay covered by other
 * predicates.
 *
 * Both `//#` and `//@` opener forms are accepted because both have
 * shipped historically (older Closure-compiler / SpiderMonkey emitted
 * `//@`; modern minifiers emit `//#`). The pointer target must contain
 * `.min` somewhere before the `.map` suffix so a pointer at a non-
 * minified `app.js.map` (canonical bundler output without
 * minification) does not over-match — that case is already covered by
 * the sibling-map branch in `collectBuildArtifacts`.
 */
export function detectSourcemapPointerToMin(source: string): VendorDistributionSignal | null {
  const probe = source.length > 4096 ? source.slice(0, 4096) : source;
  const match = probe.match(SOURCEMAP_POINTER_TO_MIN_RE);
  return match === null ? null : { kind: "sourcemap-pointer-min", value: match[0] };
}

/**
 * Wraps a banner-detection result (`{ library, version? }`) into the
 * `vendor-banner-version` signal carrying `library` (and `version`
 * when the banner exposes one) joined as `<library> v<version>` so
 * the agent can grep for the literal banner shape. The banner
 * detection itself stays in the parent module because it depends on
 * the curated `VENDOR_LIBRARY_BANNERS` table; this helper is the
 * one-liner that the per-file classifier in the parent calls after
 * resolving `detectVendorLibraryForFile`.
 */
export function formatVendorBannerSignal(banner: {
  readonly library: string;
  readonly version?: string;
}): VendorDistributionSignal {
  const value =
    banner.version === undefined ? banner.library : `${banner.library} v${banner.version}`;
  return { kind: "vendor-banner-version", value };
}

/**
 * Matches a `/*!` bang-comment opener anywhere in the leading slice of a
 * source. The bang-comment form is the publishing convention for
 * "preserve this comment through minification" — minifiers honor it,
 * authored sources rarely use it, and library build pipelines emit it
 * verbatim alongside the canonical banner header. Both `/*!` and
 * `/*\!` variants are covered by the literal sequence; the matcher is
 * non-anchored because a banner can sit at byte 0, after a UTF-8 BOM,
 * after an `'use strict';` declaration, or after a leading newline.
 */
const BANG_COMMENT_OPENER_RE = /\/\*!/u;

/**
 * Matches one of the canonical license / copyright tokens a banner
 * conventionally carries alongside the library identification:
 * `Copyright`, `License`, `Released under`, `MIT`, `Apache`, `GPL`,
 * `BSD`. Case-insensitive because banners ship under both
 * "Copyright" and "copyright" forms; the SPDX identifiers (`MIT` /
 * `Apache` / `GPL` / `BSD`) are word-bounded so a coincidental
 * substring inside a longer identifier (`commitMIT`, `apache-server`)
 * never over-fires. "Released under" is case-insensitive and tolerates
 * one or more whitespace characters between the two words so banner
 * variants spanning a soft wrap still match.
 */
const LICENSE_TOKEN_RE = /\b(?:Copyright|License|Released\s+under|MIT|Apache|GPL|BSD)\b/iu;

/**
 * Returns the structured `vendor-copyright-banner` signal when the
 * leading 1024 chars of `source` carry a `/*!` bang-comment opener
 * paired with one of the curated license / copyright tokens
 * (Copyright, License, Released under, MIT, Apache, GPL, BSD); `null`
 * otherwise.
 *
 * The combination — `/*!` opener + license/copyright token — is a
 * publishing convention used by library build pipelines to keep the
 * legal banner intact through minification. Hand-authored sources do
 * include copyright headers, but rarely under the bang-comment form
 * (`/*!`) which is specifically the "minifier-preserved" marker. The
 * verdict carries a `likely-` prefix at the classification layer
 * because authored files COULD adopt the convention, but in practice
 * the combination is strong evidence of distributed-bundle shape.
 *
 * The 1024-char probe window is wider than the curated banner table's
 * 512-char first-line probe because copyright banners commonly span
 * several lines (multi-line bang-comment shape: opener on line 1,
 * library identification on line 2, license URL on line 3) and the
 * license token can sit any of those lines. Bounding at 1024 keeps the
 * helper effectively O(1) regardless of file size.
 *
 * The signal `value` is the matched bang-comment opener trimmed to its
 * leading window so the agent can grep for the literal banner shape
 * without re-reading the source. The trim caps at 120 chars so the
 * meta payload stays bounded even when a banner runs long.
 *
 * Field-report shapes this targets: Bootstrap CSS / jQuery 1.x bundles
 * whose first line is a `/*! Bootstrap v3.3.7 (https://getbootstrap.com)
 * Copyright 2011-2017 ...` banner; jquery-scrolltofixed and similar
 * libraries not on the curated `VENDOR_LIBRARY_BANNERS` table that
 * still carry the banner-shape publishing convention. Without this
 * branch, those bundles fell through to the long-line probe and were
 * mislabeled as `likely-minified-by-line-stats`, routing the agent to
 * skip findings on the file the user can read while the actually-
 * minified sibling got the same label.
 */
export function detectVendorCopyrightBanner(source: string): VendorDistributionSignal | null {
  const probe = source.length > 1024 ? source.slice(0, 1024) : source;
  const bangMatch = probe.match(BANG_COMMENT_OPENER_RE);
  if (bangMatch === null) return null;
  if (!LICENSE_TOKEN_RE.test(probe)) return null;
  // Capture the matched bang-comment + the prose up to a newline or 120
  // chars, whichever comes first, so the agent reads enough of the
  // banner to confirm the verdict without re-opening the source.
  const start = bangMatch.index ?? 0;
  const tail = probe.slice(start);
  const newline = tail.indexOf("\n");
  const end = newline === -1 ? Math.min(tail.length, 120) : Math.min(newline, 120);
  return { kind: "vendor-copyright-banner", value: tail.slice(0, end) };
}

/**
 * Returns the matched sibling `.map` path (the deterministic evidence
 * for the `definite-sourcemap-paired` classification) or `null` when
 * the source has no paired map in the scanned set. A sourcemap itself
 * is never classified, so the probe short-circuits on `.map` input.
 * Co-located with `findSiblingMinFile` below because both are
 * sibling-set probes consumed by `collectBuildArtifacts` in the
 * parent — keeping them together avoids re-introducing a partial
 * extraction split.
 */
export function findSiblingSourcemap(
  filePath: string,
  pathsInSet: ReadonlySet<string>,
): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.endsWith(".map")) return null;
  const candidate = `${normalized}.map`;
  return pathsInSet.has(candidate) ? candidate : null;
}

/**
 * Returns the matched sibling `.min.<ext>` path (the deterministic
 * evidence for the `definite-vendor-distribution` classification when
 * driven by sibling-set membership) or `null` when the input file
 * already carries `.min.` in its basename (the file IS the minified
 * twin — `definite-min-infix` already labels it upstream of this
 * call) or when no `.min.<ext>` sibling lives in the scanned set.
 *
 * Pairing is by full directory + basename stem: `vendor/wow.js` pairs
 * with `vendor/wow.min.js` in the same directory, but a `wow.min.js`
 * in some unrelated tree never pairs across directories. The probe
 * inserts `.min` immediately before the original extension so files
 * with multiple dots (`foo.bar.js` → `foo.bar.min.js`) are handled
 * deterministically.
 */
export function findSiblingMinFile(
  filePath: string,
  pathsInSet: ReadonlySet<string>,
): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  // Already a minified file — its sibling is the readable source, not
  // the other way around. The `.min.` infix path-anchored predicate
  // already labels these via `definite-min-infix` upstream.
  if (MIN_INFIX_RE.test(basename)) return null;
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot === -1) return null;
  // Insert `.min` immediately before the trailing extension. For
  // `vendor/wow.js` (lastDot = 10), produces `vendor/wow.min.js`.
  const candidate = `${normalized.slice(0, lastDot)}.min${normalized.slice(lastDot)}`;
  return pathsInSet.has(candidate) ? candidate : null;
}
