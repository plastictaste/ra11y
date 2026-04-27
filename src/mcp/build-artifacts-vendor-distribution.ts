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
  | { readonly kind: "vendor-banner-version"; readonly value: string };

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
