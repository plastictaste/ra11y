/**
 * Detection of compiled-CSS / bundler-output files among the set of
 * files a scan has already parsed.
 *
 * Surfaces as `meta.scannedBuildArtifacts: BuildArtifactsGrouped` on
 * `scan_project` responses — a *labelled* grouped view, not a
 * filter. Each row carries the `path` paired with a
 * confidence-graded {@link BuildArtifactClassification} so the
 * consuming agent can triage without re-reading every flagged file.
 * Findings on these files still appear in `files`; the meta entry
 * tells the agent "this finding sits on a generated file, and here
 * is *which predicate* the scanner matched on (with what
 * confidence)." The on-wire shape collapses ≥3-entry same-basename
 * clusters into `grouped[i]` rows with paste-ready `suggestedGlob`s;
 * sub-threshold per-file classifications and banner-detected
 * vendor-library identifications ride together under `classified[]`
 * with a {@link ClassificationKind} discriminator (`min-infix` |
 * `path-prefix` | `vendor-library-version-detected`) naming the
 * predicate family that fired. See
 * {@link groupBuildArtifactsByBasename}.
 *
 * History: the previous shape shipped a `reason: BuildArtifactReason`
 * token (`"minified"`, `"hashed-filename"`, `"dist-path"`,
 * `"contains-data-url-gradient"`, `"tailwind-compiled-escape"`,
 * `"sourcemap-sibling"`) that read to the agent as a deterministic
 * verdict. But four of those predicates (long-line corroboration,
 * hex-segment, build-dir segment, tailwind-escape selector) are
 * heuristics that fire on authored content with non-trivial frequency
 * — a single long `calc()` line, an `app.a1b2c3d4.js` test artifact,
 * an authored `dist/` source directory, or a hand-authored
 * `\:focus-visible:` rule. The deterministic-sounding label propagated
 * the lie into the agent's downstream triage (skip the file, suppress
 * findings, re-route fixes). Per
 * `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
 * meta sub-fields are dishonest," the field was renamed `reason` →
 * `classification` and the values were reshaped into a
 * confidence-graded enum: `definite-*` for the two predicates whose
 * verdict survives inspection of the path/scan-set alone (`.min.`
 * infix, paired `.map` sibling) and `likely-*` for the four whose
 * predicate is probabilistic. The agent reading
 * `classification: "likely-minified-by-line-stats"` budgets correctly;
 * reading `classification: "definite-min-infix"` knows the verdict is
 * path-anchored.
 *
 * Subsequent narrowing: the data-URL-image marker (`url(data:image/`
 * in CSS source) was retired entirely as `likely-vendored-data-url-css`
 * because hand-authored SCSS stylesheets routinely inline tiny
 * data-URL gradients and SVG mask icons (a 1350-line authored
 * `_icons.scss` is the canonical false-positive shape) — the
 * predicate failed the doctrine bar and the right answer was deletion,
 * not relabeling. The content-shape `likely-minified-by-line-stats`
 * predicate was additionally gated to skip `.svg` sources entirely:
 * single-line is the canonical SVG authoring shape, so the
 * median-line-length corroborator fires trivially on every authored
 * brand SVG. Files that genuinely are vendored bundles or build-pipeline
 * SVG output still classify on the path-anchored predicates that
 * survive the doctrine bar.
 *
 * Data-URL deduction on the long-line corroborator: a hand-authored
 * design-system stylesheet (icons / token / mask SCSS) inlining
 * several base64 `data:` URL payloads can hit the long-line ratio
 * (4/14 ≈ 28.6%) on authored content alone. Per the doctrine bar,
 * long lines whose >threshold reach is dominated by an inline
 * `data:` URL are deducted from the count-floor / ratio inputs and
 * replaced by their residual length in the median input — files
 * that legitimately are minified bundles inlining a few data-URL
 * assets still classify because the residual non-data-URL line
 * content is bundle-shape long. See {@link
 * longestDataUrlPayloadLength} in `build-artifacts-data-url.ts`.
 *
 * Classifications, in classifier evaluation order (first-match wins;
 * the comment block at {@link classifyBuildArtifactDetailed}
 * restates the order inline so future edits keep predicate ↔
 * classification aligned):
 *
 *   1. `definite-min-infix`. The basename carries a `.min.` infix —
 *      canonical pre-minified bundle marker (`bootstrap.min.css`,
 *      `jquery.min.js`). Path-anchored and falsifiable from the
 *      basename alone; survives the "provable from the code" bar.
 *   2. `likely-hashed-bundle`. An 8+ character lowercase-hex segment
 *      flanked by dots in the basename, as emitted by
 *      Webpack/Rollup/Vite/esbuild for content-addressed output
 *      (`app.a1b2c3d4.js`, `chunk.0123abcdef.css`). Strongly
 *      bundler-shaped, but a hand-authored test fixture or a git-
 *      sha-stamped artifact can collide; the `likely-` prefix names
 *      that residual uncertainty.
 *   3. `likely-bundler-output-dir`. The path includes a canonical
 *      bundler-output directory segment — `dist/`, `build/`,
 *      `_site/`, `node_modules/`, plus framework-specific output
 *      trees like `.next/`, `.svelte-kit/`, `.output/`, and
 *      `static/assets/`. A trailing `/` is required so a root-level
 *      file literally named `dist.ts` cannot confound the match.
 *      Authored projects do sometimes use these directory names for
 *      hand-authored source (a `dist/` of vendored deps), so the
 *      verdict is `likely-`, not `definite-`. `public/` is
 *      deliberately excluded — it's a static-assets convention
 *      (Astro/Vite/Next/Nuxt) where user-authored files live; see
 *      {@link BUILD_DIR_MARKERS} for the rationale.
 *   4. `likely-compiled-tailwind`. A `.css` / `.scss` source whose
 *      text contains an escape-bracket Tailwind utility selector
 *      (`\[400px\]`, `\:focus-visible:`, `\[--…]`). These are
 *      typically emitted by Tailwind's JIT compiler as the CSS-
 *      escaped form of utility class names like `w-[400px]`, but
 *      a hand-authored stylesheet can produce the same selector
 *      literally — the predicate is strong evidence, not a
 *      guarantee.
 *   5. `definite-sourcemap-paired`. A sibling `.map` file is in the
 *      scanned set with the matching basename. Pairing a `.js` /
 *      `.css` with its `.map` is unambiguous compiled-bundle
 *      evidence — agents don't pair sourcemaps with hand-authored
 *      sources. Path-anchored against the live scan set; survives
 *      the "provable from the code" bar. The `.map` file itself is
 *      *not* labelled here — agents don't author sourcemaps in-
 *      place and a manual-review prompt about one is noise.
 *   6. `definite-vendor-distribution`. Either (a) a sourcemap-pointer
 *      comment in the source names a `.min.<ext>.map` target, or (b)
 *      a sibling `.min.<ext>` file is in the scanned set with the
 *      matching directory + basename stem. Both predicates are
 *      deterministic — only build pipelines emit sourcemap pointers,
 *      and sibling-set membership is a scan-set fact. Names "this is
 *      a release artifact distributed alongside its minified twin"
 *      separately from "this file is itself minified bytes," because
 *      the readable jQuery source paired with `jquery.min.js` is
 *      generated-by-build but is NOT minified — labeling it
 *      `likely-minified-by-line-stats` because its body crosses the
 *      line-stats threshold mislabels the file the agent should be
 *      reading. The sibling-set predicate runs in
 *      {@link collectBuildArtifacts}; the sourcemap-pointer predicate
 *      runs per-file in {@link classifyBuildArtifactDetailed}.
 *   7. `likely-vendor-distribution`. Either (a) the source's first
 *      non-blank line matches a curated `VENDOR_LIBRARY_BANNERS`
 *      opener (Bootstrap, jQuery, Font Awesome, Modernizr,
 *      normalize.css, animate.css, Eric Meyer reset.css, fancyBox,
 *      jQuery UI) — the curated table is restricted to library-
 *      identifier banners with tokens unique enough that authored
 *      files do not coincidentally produce them, so a curated match
 *      stands alone — OR (b) the leading 1024 chars carry a `/*!`
 *      bang-comment opener paired with one of the curated license /
 *      copyright tokens (Copyright, License, Released under, MIT,
 *      Apache, GPL, BSD) AND the long-line minification corroborator
 *      from rule 8 also fires. The generic banner alone is not
 *      sufficient: hand-authored SCSS partials and design-system
 *      stylesheets routinely adopt the bang-comment + license
 *      publishing convention (an `_partial.scss` opening
 *      `slash-bang Author copyright 2024 | MIT slash`), and per
 *      `docs/kb/architecture/ai-first-consumer.md` "Heuristic-
 *      mislabeled meta sub-fields are dishonest" the verdict cannot
 *      rest on a banner-only signal — the agent reading the
 *      classification budgets the file as not-its-problem and
 *      silently misses authored source. Co-occurrence with the
 *      long-line corroborator distinguishes the canonical
 *      `jquery-scrolltofixed`-style readable bundle (banner +
 *      bundle-shape body) from the SCSS-partial false-positive
 *      shape (banner + short-line authored body). The `likely-`
 *      prefix names the residual uncertainty even when both fire.
 *   8. `likely-minified-by-line-stats`. The source text crosses the
 *      single-long-line probe (> {@link MINIFIED_LINE_THRESHOLD}
 *      chars on one line) AND a second-tier corroborator also
 *      fires: either the median line length itself exceeds the
 *      threshold OR the file carries ≥
 *      {@link MINIFIED_LONG_LINE_MIN_COUNT} long lines AND ≥25% of
 *      lines exceed the threshold, *after* deducting long lines
 *      whose >threshold reach is dominated by an inline `data:`
 *      URL payload. The standalone long-line probe used to be enough
 *      but mis-labeled authored files (Astro template literals, Google-
 *      Maps iframe URLs, SCSS type signatures, design-system base64
 *      icons) that cross 500 chars on exactly one authored line; the
 *      count-floor + ratio + median tightening + data-URL deduction
 *      together close those shapes. Even with these tightenings the
 *      predicate remains a heuristic over content shape — the
 *      `likely-` prefix names the residual uncertainty. Additionally
 *      gated to skip `.svg` sources entirely: single-line is the
 *      canonical SVG authoring shape, so the long-line probe is
 *      structurally inapplicable and would mis-label authored brand
 *      assets as minified bundles. SVGs caught by the path predicates
 *      above (1–3, 5) still classify; content-shape alone does not
 *      earn a label.
 *
 * What is NOT a classification (predicates retired): a CSS source
 * containing `url(data:image/...)` used to land as
 * `likely-vendored-data-url-css`. The predicate fired on every CSS
 * file with an inline image data-URL — but hand-authored SCSS
 * stylesheets routinely inline tiny SVG mask icons and base64-data
 * gradients in design-system token files (a 1350-line authored
 * `_icons.scss` is the canonical false-positive shape). A single
 * `data:image/` occurrence is not provable evidence the file is
 * vendored; the predicate failed the doctrine bar
 * (`docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
 * meta sub-fields are dishonest"). The classification was dropped
 * entirely — files that genuinely are vendored bundles still get
 * caught by the path predicates above (`.min.` infix,
 * hashed-filename, bundler-output dir, sibling `.map`).
 *
 * What is *not* a signal: the `_` filename prefix. That prefix is the
 * Sass partial convention for authored source (`_variables.scss`,
 * `_mixins.scss`) — mis-labeling an authored partial as artifact
 * misleads the agent's triage. Likewise, raw line count is not a
 * signal: Bootstrap's `_variables.scss` is ~2000 lines of hand-
 * authored `$var` declarations across many short lines. The
 * minified-by-line-stats detector requires a *single* line over the
 * threshold AND a second-tier corroborator so the same partial does
 * not get mislabelled.
 *
 * Single-classification output: each path is reported once, with the
 * first matching classification. Combining classifications would
 * defeat the doctrine's "label must survive inspection" bar — the
 * agent reading `classification: "definite-min-infix"` is verifying
 * one falsifiable claim, not sorting through a bag. The paired
 * {@link BuildArtifactSignal} carries the underlying evidence
 * (matched basename, hex segment, directory segment, longest line
 * length, sibling map path) so the agent can re-derive the verdict
 * without re-running our classifier.
 */

import { type ClassifiedArtifact, mergeClassifiedRows } from "./build-artifacts-classified.ts";
import { computeLineStats } from "./build-artifacts-line-stats.ts";
import { isAuthoredSvgFont, isSvgPath } from "./build-artifacts-svg-font.ts";
import type {
  BuildArtifactClassification,
  BuildArtifactClassificationResult,
  BuildArtifactSignal,
  DetectedVendorLibrary,
  ScannedBuildArtifact,
} from "./build-artifacts-types.ts";
import {
  detectSourcemapPointerToMin,
  detectVendorCopyrightBanner,
  findKnownVendorLibraryWithMinSibling,
  findSiblingMinFile,
  findSiblingSourcemap,
  formatVendorBannerSignal,
} from "./build-artifacts-vendor-distribution.ts";
import { capMetaArray, type MetaArrayTruncationSummary } from "./meta-array-cap.ts";

// Type definitions for the four shared classifier types
// (`BuildArtifactClassification`, `BuildArtifactSignal`,
// `ScannedBuildArtifact`, `BuildArtifactClassificationResult`,
// `DetectedVendorLibrary`) live in `./build-artifacts-types.ts`,
// extracted so both this module and the Q12 merger
// (`./build-artifacts-classified.ts`) can import them without
// triggering the cycle checker. Re-export here so downstream
// consumers reading "the build-artifact module" from
// `./build-artifacts.ts` get the full surface.
export type {
  BuildArtifactClassification,
  BuildArtifactClassificationResult,
  BuildArtifactSignal,
  DetectedVendorLibrary,
  ScannedBuildArtifact,
} from "./build-artifacts-types.ts";

/**
 * Returns true when `classification` is a `definite-*` variant —
 * the predicate's verdict is provable from the path or the live
 * scan set alone (e.g. `.min.` infix, paired `.map` sibling). Used
 * by callers that need to gate a downstream behavior on
 * "confidence-grade is deterministic" without coupling to the full
 * variant set; the per-variant `definite-` / `likely-` prefix is
 * the contract the doctrine bar guarantees.
 */
export function isDefiniteBuildArtifactClassification(
  classification: BuildArtifactClassification,
): boolean {
  return classification.startsWith("definite-");
}

/**
 * Matches the CSS-escaped-bracket and escaped-colon forms Tailwind
 * emits for utility classes. Examples of compiled output:
 *   .w-\[400px\]         → `\[400px\]` (or `\[400px]` on some emitters)
 *   .group\:focus-visible:before → `\:focus-visible:`
 *   .bg-\[--my-color\]   → `\[--`
 *
 * The bracket forms accept an optional `\` before the closing `]`
 * because different Tailwind/PostCSS pipelines emit either `\]` or a
 * bare `]`. A single occurrence of any alternative is sufficient;
 * these patterns do not appear in idiomatic hand-written CSS.
 */
const TAILWIND_ESCAPED_SELECTOR =
  /\\\[\d+px\\?\]|\\\[\d+rem\\?\]|\\\[\d+%\\?\]|\\:focus-visible:|\\\[--/u;

/**
 * Substring markers for canonical bundler-output directories. The
 * matcher tolerates each marker either bracketed by `/` inside the
 * path OR sitting at the start of a relative path (`dist/main.css`).
 * A bare filename like `dist.ts` at the repo root stays unmatched —
 * the probe requires a trailing `/` to confirm it's a directory
 * segment, not a filename prefix. `_site/` is Jekyll's default
 * output directory; `node_modules/` is the packaged-dependency tree
 * by definition.
 *
 * `public/` is deliberately NOT in this list. Astro / Vite / Next /
 * Nuxt all treat `public/` as a *static-assets* convention — the
 * directory holds user-authored files (favicons, brand marks, hero
 * images) copied as-is to the build root. An authored `hero.jpg` /
 * `brand-mark.svg` / `favicon.png` under `public/` would mis-classify
 * as `likely-bundler-output-dir` and silently land under
 * `scannedBuildArtifacts`, which downstream tools treat as
 * "not user-fixable." The framework-specific generated trees that
 * happen to nest a `public/` segment (Nuxt's `.output/public/`,
 * Hugo / Eleventy with a `_site/` rendered output) are still
 * classified via the framework markers themselves (`.output/`,
 * `_site/`) so the cases where `public/` sits under a generated
 * tree continue to fire. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
 * meta sub-fields are dishonest" — `public/ → bundler-output` was a
 * false predicate on the general case, so the marker is dropped.
 * The deterministic vendor signals (`.min.` infix, hashed filename,
 * sourcemap-sibling) still classify when applicable.
 */
const BUILD_DIR_MARKERS = [
  "dist/",
  "build/",
  "_site/",
  "node_modules/",
  ".next/",
  ".svelte-kit/",
  ".output/",
  "static/assets/",
] as const;

/**
 * Matches a `.min.` infix anywhere in the filename portion of a path.
 * Canonical on pre-minified bundles: `bootstrap.min.css`,
 * `jquery.min.js`, `vendor.min.js`. The probe only considers the
 * basename (everything after the final `/`) so a directory literally
 * named `min.css` in the middle of a path can't confound the match.
 */
const MIN_INFIX_RE = /\.min\./u;

/**
 * Single-line length above which the source text is treated as
 * minified output. Hand-authored stylesheets and scripts wrap lines
 * for readability; minified bundles emit one or a handful of long
 * lines. The threshold is deliberately conservative — even verbose
 * authored lines (a long Tailwind `@apply` or a long `data-attribute`
 * literal) rarely cross 500 characters in a single uninterrupted run.
 */
const MINIFIED_LINE_THRESHOLD = 500;

/**
 * Matches a content-hash segment in a filename: an 8+ character
 * lowercase-hex run flanked by dots. Examples:
 *   app.a1b2c3d4.js
 *   chunk.0123abcdef.css
 *   vendor.deadbeefcafebabe.mjs
 * The probe is anchored against the basename only and requires
 * surrounding dots on both sides — a bare hex-looking token in a
 * directory name never matches, and an 8-char hex sequence that is
 * the start or end of the filename (no flanking dots) does not match
 * either. Authored filenames like `README.md` or `index.html` do not
 * produce an 8+ hex run between dots.
 */
const HASHED_FILENAME_RE = /\.[a-f0-9]{8,}\./u;

/**
 * Pure per-file classifier: returns the matching
 * {@link BuildArtifactClassification} or `null` when no signal
 * fires.
 *
 * Evaluation order:
 *   1. `.min.` infix on the basename → `definite-min-infix`.
 *      Canonical on pre-minified bundles, path-anchored.
 *   2. Hashed-filename segment (8+ hex between dots) →
 *      `likely-hashed-bundle`.
 *   3. Bundler-output path ancestry → `likely-bundler-output-dir`.
 *   4. CSS-only: Tailwind escape-bracket selector →
 *      `likely-compiled-tailwind`.
 *   5. Single-line-over-threshold + second-tier corroboration →
 *      `likely-minified-by-line-stats`. The long-line probe alone
 *      is not enough: authored Astro/Starlight template-literal
 *      props, Google-Maps iframe URLs, SCSS type signatures, and
 *      MDX component prop bundles all cross the 500-char line cap
 *      once while the rest of the file reads short. At least one
 *      corroborator from {long-line ratio, median line length} must
 *      also fire (see {@link detectLongMinifiedLine}). Additionally
 *      gated to skip `.svg` sources entirely — single-line is the
 *      canonical SVG authoring shape, so the long-line probe is
 *      structurally inapplicable. The path-based signals above
 *      already handle the cases where the single-long-line probe
 *      lines up with a path marker; this final branch covers
 *      short-path bundles whose source text itself still suggests
 *      minification.
 *
 * The `definite-sourcemap-paired` classification is NOT checked here
 * because it requires the full scanned set — use
 * {@link collectBuildArtifacts} for that branch (a sibling `.map`
 * fills in as the corroborator for files whose source-text alone is
 * ambiguous). The path-based signals are intentionally extension-
 * agnostic: a file under `/dist/assets/` is a build artifact
 * regardless of whether it ends in `.css` or `.html`. The Tailwind-
 * escape probe is gated to `.css` / `.scss` (JSX sources can carry
 * those patterns as string literals, which are not compiled CSS).
 *
 * O(file size) — at most one linear pass on the source for the line-
 * statistics helper when the cheaper signals miss, plus a few O(1)
 * path probes.
 */
export function classifyBuildArtifact(
  filePath: string,
  source: string,
): BuildArtifactClassification | null {
  return classifyBuildArtifactDetailed(filePath, source)?.classification ?? null;
}

/**
 * Detailed sibling of {@link classifyBuildArtifact}: returns the
 * matching {@link BuildArtifactClassificationResult} (classification
 * + signal) or `null` when no signal fires.
 *
 * Evaluation order matches the boolean predicate exactly so the
 * returned `classification` is identical for any input — the only
 * difference is the paired {@link BuildArtifactSignal} that names
 * the predicate which fired. Each per-signal helper is a pure
 * function over its inputs so the agent reading `signal.kind` and
 * `signal.value` can re-derive the verdict without re-running our
 * classifier.
 *
 * Per +
 * the verdict is now
 * confidence-graded: predicates that survive the "provable from the
 * code" doctrine bar emit `definite-*` classifications; heuristic
 * predicates emit `likely-*` so the agent budgets per-file
 * investigation correctly.
 */
export function classifyBuildArtifactDetailed(
  filePath: string,
  source: string,
): BuildArtifactClassificationResult | null {
  // Sourcemap files are never classified as build artifacts in their
  // own right — agents don't author or hand-edit `.map` files, and
  // listing one under `scannedBuildArtifacts` would only add noise
  // alongside the paired source. The `definite-sourcemap-paired`
  // classification is attached to the *source* file in
  // `collectBuildArtifacts`; the map itself stays out.
  if (filePath.replace(/\\/g, "/").endsWith(".map")) return null;
  // Authored-SVG-font carve-out runs first so it pre-empts every
  // path/content predicate below. Rationale + predicate detail in
  // {@link build-artifacts-svg-font.ts}.
  if (isAuthoredSvgFont(filePath, source)) return null;
  const minSignal = detectMinInfix(filePath);
  if (minSignal !== null) {
    return { classification: "definite-min-infix", signal: minSignal };
  }
  const hashSignal = detectHashedFilename(filePath);
  if (hashSignal !== null) {
    return { classification: "likely-hashed-bundle", signal: hashSignal };
  }
  const distSignal = detectBuildDirMarker(filePath);
  if (distSignal !== null) {
    return { classification: "likely-bundler-output-dir", signal: distSignal };
  }
  if (isCssPath(filePath)) {
    const tailwindSignal = detectTailwindEscape(source);
    if (tailwindSignal !== null) {
      return { classification: "likely-compiled-tailwind", signal: tailwindSignal };
    }
  }
  // The standalone single-long-line probe was the root cause of 54
  // authored files mis-labeled on a Bootstrap docs scan and 101 on a
  // website-templates scan — one long line in an Astro template
  // literal, a Google Maps iframe URL, or an MDX prop bundle is not
  // minification evidence. Require a corroborating content signal so
  // the verdict stays defensible.
  //
  // SVG sources are skipped entirely: a hand-authored brand SVG is one
  // well-formed `<svg>` element on a single line — the median-line-length
  // corroborator fires trivially on every authored SVG (the whole content
  // IS the one line, so its median equals its length). The long-line
  // probe is structurally inapplicable to a one-line authoring norm; the
  // path predicates above (1–3) and the `definite-sourcemap-paired`
  // pairing in {@link collectBuildArtifacts} still classify SVGs whose
  // path or scan-set evidence proves the verdict.
  if (isSvgPath(filePath)) return null;
  // Vendor-distribution detection runs BEFORE the long-line probe so a
  // readable jQuery / prettify / livereload source whose body happens
  // to cross the line-stats threshold gets the honest verdict
  // (`vendor distribution` — the file IS vendor source, not minified
  // bytes) rather than the misleading `likely-minified-by-line-stats`
  // verdict. The minified sibling, when present in the scan set,
  // separately picks up `definite-min-infix` from rule 1.
  //
  // Two predicates earn `definite-vendor-distribution` because their
  // evidence survives the doctrine bar without inspecting the file:
  //   (a) a sourcemap-comment pointing at a `.min.<ext>.map` —
  //       authored hand-written sources do not carry sourcemap
  //       pointers; only build pipelines emit them. The pointer at a
  //       `.min` map specifically asserts "this file is paired to a
  //       minified version," which is the textbook vendor-distribution
  //       shape.
  //   The sibling-set predicate (sibling `.min.<ext>` in the scanned
  //   set) is checked separately in {@link collectBuildArtifacts}
  //   because it requires the cross-file scan set, mirroring the
  //   existing sibling-map handling for `definite-sourcemap-paired`.
  //
  // The banner-with-version predicate earns `likely-vendor-distribution`
  // (heuristic — a hand-authored file COULD include a vendor-style
  // banner comment, though in practice only build pipelines do, and
  // the `VENDOR_LIBRARY_BANNERS` table is curated specifically for
  // distributed-bundle openers). Defers to {@link
  // detectVendorLibraryForFile} so the banner table is the single
  // source of truth.
  const sourcemapPointerSignal = detectSourcemapPointerToMin(source);
  if (sourcemapPointerSignal !== null) {
    return { classification: "definite-vendor-distribution", signal: sourcemapPointerSignal };
  }
  // Banner-driven `likely-vendor-distribution`: the curated
  // `VENDOR_LIBRARY_BANNERS` table is restricted to library-specific
  // banner shapes unique enough that authored files do not
  // coincidentally produce them, so a curated match alone earns the
  // classification (more informative `vendor-banner-version` signal
  // carrying `<library> v<version>`).
  //
  // The generic `/*!` + license-token fallback is *not* sufficient on
  // its own. Hand-authored SCSS partials and design-system stylesheets
  // routinely adopt the bang-comment + license publishing convention
  // (`_partial.scss` opening `/*! Author copyright 2024 | MIT */`),
  // and labeling them `likely-vendor-distribution` is the canonical
  // false-positive shape this file's previous heuristic produced. Per
  // `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
  // meta sub-fields are dishonest," banner-only is too weak to drive
  // a vendor-distribution verdict — the agent reading the
  // classification budgets the file as not-its-problem and silently
  // misses authored source. Co-occurrence with a second signal (the
  // long-line minification corroborator below) earns the
  // classification; banner-only does not. Path / sourcemap / hashed-
  // name signals already short-circuit upstream of this branch, so
  // the long-line probe is the only co-occurrence path available
  // here. The original field-report shape this branch closed
  // (`jquery-scrolltofixed`-style readable bundles whose body crosses
  // the line-stats threshold) still classifies as
  // `likely-vendor-distribution` because the long-line corroborator
  // fires on its body; bundles whose body is short-line stay
  // unclassified, which is the honest verdict (banner alone cannot
  // distinguish them from a hand-authored partial that adopted the
  // banner publishing convention).
  const curatedBannerSignal = detectCuratedBannerSignal(filePath, source);
  if (curatedBannerSignal !== null) {
    return { classification: "likely-vendor-distribution", signal: curatedBannerSignal };
  }
  const genericBannerSignal = detectVendorCopyrightBanner(source);
  const longLineSignal = detectLongMinifiedLine(source);
  if (genericBannerSignal !== null && longLineSignal !== null) {
    // Banner + long-line co-occurrence: the banner is the more
    // informative slot label (names "vendor distribution" rather than
    // "minified bytes") and wins the signal slot; the long-line
    // evidence corroborated the banner verdict but stays implicit
    // (the agent reads the surrounding bytes to confirm).
    return { classification: "likely-vendor-distribution", signal: genericBannerSignal };
  }
  if (longLineSignal !== null) {
    return { classification: "likely-minified-by-line-stats", signal: longLineSignal };
  }
  return null;
}

function detectBuildDirMarker(filePath: string): BuildArtifactSignal | null {
  // Normalize backslashes so Windows-style paths ("C:\proj\dist\…")
  // are handled. The matcher accepts a marker either preceded by `/`
  // anywhere in the path OR sitting at the very start — that covers
  // the two canonical cases ("/proj/dist/x.css" and "dist/x.css")
  // without mislabeling a root-level file literally named "dist.ts".
  const normalized = filePath.replace(/\\/g, "/");
  for (const marker of BUILD_DIR_MARKERS) {
    if (normalized.startsWith(marker) || normalized.includes(`/${marker}`)) {
      return { kind: "build-dir-segment", value: marker };
    }
  }
  return null;
}

/**
 * Returns the curated `vendor-banner-version` signal when the file's
 * first non-blank line matches one of the library-specific banner
 * regexes in `VENDOR_LIBRARY_BANNERS`; `null` otherwise.
 *
 * The curated table is restricted to library-identifier banners with
 * tokens unique enough that authored files do not coincidentally
 * produce them (`Bootstrap v3.3.7`, `jQuery JavaScript Library v1.12.4`,
 * `modernizr 3.6.0`, `Font Awesome Free 5.15.4`, etc.). A curated match
 * is therefore strong enough to drive the `likely-vendor-distribution`
 * classification on its own. The caller (`classifyBuildArtifactDetailed`)
 * couples the generic `/*!` + license-token fallback
 * (`detectVendorCopyrightBanner`) with the long-line corroborator
 * separately because the generic publishing-convention banner fires on
 * authored SCSS partials adopting the convention and cannot stand
 * alone — see the call site for the doctrine bar.
 */
function detectCuratedBannerSignal(filePath: string, source: string): BuildArtifactSignal | null {
  const banner = detectVendorLibraryForFile(filePath, source);
  return banner === null ? null : formatVendorBannerSignal(banner);
}

function detectMinInfix(filePath: string): BuildArtifactSignal | null {
  const basename = basenameOf(filePath);
  return MIN_INFIX_RE.test(basename) ? { kind: "min-infix", value: basename } : null;
}

function detectHashedFilename(filePath: string): BuildArtifactSignal | null {
  const basename = basenameOf(filePath);
  const match = basename.match(HASHED_FILENAME_RE);
  if (match === null) return null;
  // Strip the flanking dots so `value` carries just the hex segment
  // the agent can grep for (the dots are part of the filename around
  // it). `match[0]` shape is `.<hex>.`; slice(1, -1) returns `<hex>`.
  return { kind: "hex-segment-in-basename", value: match[0].slice(1, -1) };
}

function detectTailwindEscape(source: string): BuildArtifactSignal | null {
  const match = source.match(TAILWIND_ESCAPED_SELECTOR);
  return match === null ? null : { kind: "tailwind-escape-selector", value: match[0] };
}

function basenameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function isCssPath(filePath: string): boolean {
  // Case-insensitive .css / .scss / .less suffix check. Avoids a
  // regex for what is a three-field string probe and keeps the hot-
  // path allocation-free. `.scss` and `.less` count here because our
  // SCSS / Less parsers emit the CSS AST shape; consumers of this
  // predicate (fingerprint / build-artifact heuristics) treat all
  // three identically.
  const lower = filePath.toLowerCase();
  return lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less");
}

/**
 * Ratio of long-line-to-total-line count that corroborates the
 * single-long-line probe. A single authored template-literal, iframe
 * URL, or MDX prop bundle can cross the character threshold once; a
 * minified bundle crosses on a quarter or more of its lines. The cap
 * is deliberately loose — minified bundles often run one or two very
 * long lines followed by a trailing short newline, so {@link
 * hasHighMedianLineLength} covers the pure-one-liner case and this
 * predicate covers the "several long lines among a few short" shape.
 */
const MINIFIED_LONG_LINE_RATIO = 0.25;

/**
 * Absolute floor on the long-line *count* before the ratio corroborator
 * is allowed to fire. Without this floor a 4-line authored file with
 * one >500-char line satisfies the ratio at exactly `1/4 = 0.25` —
 * the canonical small-file false-positive shape: vanilla-JS pages
 * concatenating SRI-hashed preload links into one `<head>` line,
 * landing pages inlining SVG `<path d="...">` commands on one line,
 * design-system token modules with one long `calc()` value, SCSS
 * partials with one long `@function` type signature. One long line
 * is the same evidence that already failed to corroborate on its
 * own at the {@link hasLongMinifiedLine} probe; the ratio
 * corroborator must carry independent weight, so it requires
 * *several* long lines (the canonical minified-CSS shape — one rule
 * per line with every line long).
 *
 * The pure-one-line minified-bundle case (canonical minified JS with
 * the whole bundle on a single unwrapped line) is still covered by
 * the median-line-length conjunct in
 * {@link hasLongMinifiedLineCorroborated}: a 1-of-1 long-line file
 * yields median = long, not median = short, so that branch fires
 * regardless of this count floor.
 *
 * Three is the smallest count that survives the observed false-
 * positive shapes — tiny authored files top out at one-or-two long
 * lines (one SVG path, one iframe URL, one calc(), plus at most one
 * prop-bundle wrapper on a sibling line); real bundle output runs
 * many more.
 */
const MINIFIED_LONG_LINE_MIN_COUNT = 3;

/**
 * Returns true when any single contiguous line in `source` exceeds
 * {@link MINIFIED_LINE_THRESHOLD} characters. The probe scans the
 * source linearly tracking inter-newline run length so the helper
 * stays O(N) and never allocates an array of split lines — important
 * because the predicate is the canonical fast-path for distinguishing
 * a hand-authored file from a minified bundle on every parsed file.
 *
 * The first run that exceeds the threshold short-circuits — the
 * earliest a long line shows up, the more confident the minified
 * verdict. For the negative case (authored source) the helper walks
 * the entire string but each step is a constant-time index advance,
 * so even a 500 KB authored CSS file is well under a millisecond.
 *
 * Exported for tests; production call sites should use
 * {@link hasLongMinifiedLineCorroborated} so the single-long-line
 * signal only labels when a second-tier predicate also fires.
 */
export function hasLongMinifiedLine(source: string): boolean {
  let runLength = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    // 10 = '\n', 13 = '\r' — reset the run on any line terminator so
    // both LF and CRLF source files are handled identically.
    if (ch === 10 || ch === 13) {
      runLength = 0;
      continue;
    }
    runLength++;
    if (runLength > MINIFIED_LINE_THRESHOLD) return true;
  }
  return false;
}

/**
 * Returns the structured `max-line-length-exceeds-threshold` signal
 * when both the single-long-line probe AND a second-tier
 * corroborator also fire; `null` otherwise. The two corroborators
 * catch different bundle shapes:
 *   (a) ≥{@link MINIFIED_LONG_LINE_MIN_COUNT} long lines AND ≥
 *       {@link MINIFIED_LONG_LINE_RATIO} of lines exceed
 *       {@link MINIFIED_LINE_THRESHOLD} ("many long lines" — canonical
 *       minified CSS with one rule per line but every line long), OR
 *   (b) the median line length itself exceeds the threshold ("one
 *       enormous line file" — canonical minified JS bundle with
 *       everything on a single unwrapped line).
 *
 * The returned signal carries the longest observed line length as
 * `value`, the {@link MINIFIED_LINE_THRESHOLD} as `threshold`, and a
 * `corroborator` discriminator (`median` or `ratio`) naming which
 * conjunct carried the verdict — the agent can re-verify either
 * branch by reading those three fields, no scanner re-run required
 *
 * The count floor on (a) is load-bearing: without it a 4-line
 * authored file with a single >500-char line satisfies the ratio at
 * exactly `1/4 = 0.25` even though one long line is exactly the
 * shape the upstream {@link hasLongMinifiedLine} probe fired on. The
 * ratio corroborator only carries independent weight when *several*
 * long lines exist; one long line in a tiny authored file is the
 * canonical false-positive shape and must not corroborate. See
 * {@link MINIFIED_LONG_LINE_MIN_COUNT} for the worked field-report
 * cases (vanilla-JS SRI preloads, inline SVG paths, design-system
 * `calc()` token modules, SCSS function signatures).
 *
 * Both branches consume a *data-URL-deducted* view of the line
 * distribution: long lines whose >threshold reach is dominated by an
 * inline `data:` URL payload (residual length after stripping the
 * payload drops below {@link MINIFIED_LINE_THRESHOLD}) are deducted
 * from the count-floor / ratio inputs and replaced by their residual
 * length in the median input. Those lines are authored content
 * (design-system base64 icons, mask-icon SVG data URIs,
 * `<img src="data:...">` landing-page images), not minified bytes —
 * counting them as evidence of minification is the canonical Q9
 * false-positive shape (a 14-line authored design-system SCSS with
 * 4 inline icon lines hits the 25% ratio on payload alone). Real
 * minified bundles are unaffected: their per-line residual after
 * stripping any inlined data-URL payload is still bundle-shape long,
 * so both corroborators continue to fire. See
 * {@link longestDataUrlPayloadLength} for the deduction predicate.
 *
 * The `.min.` infix, hashed filenames, bundler-output path ancestry,
 * and `.map` sibling signals are already deterministic standalone
 * labels upstream of this call (see {@link classifyBuildArtifact} and
 * {@link collectBuildArtifacts}); they do not need to participate
 * here because a file carrying any of them is already labeled
 * before the corroborated-long-line branch runs.
 */
function detectLongMinifiedLine(source: string): BuildArtifactSignal | null {
  if (!hasLongMinifiedLine(source)) return null;
  const stats = computeLineStats(source, MINIFIED_LINE_THRESHOLD);
  const { totalLines, longLineCount, medianLineLength, maxLineLength } = stats;
  if (totalLines === 0) return null;
  // Deduct long lines whose >threshold reach is dominated by an inline
  // `data:` URL payload. Those lines are authored content (CSS
  // background icons, HTML inline data-URIs, SVG mask gradients), not
  // minified bytes. The median branch already consumes the deducted
  // distribution via `effectiveLengths` inside `computeLineStats`; the
  // count-floor / ratio branches deduct here. After deduction, the
  // residual long lines must independently satisfy the corroborator
  // — a 1350-line authored design-system SCSS with a few inline icon
  // lines no longer mislabels (canonical Q9 false-positive shape).
  const residualLongLineCount = longLineCount - stats.dataUrlDominatedLongLineCount;
  if (medianLineLength > MINIFIED_LINE_THRESHOLD) {
    return {
      kind: "max-line-length-exceeds-threshold",
      value: maxLineLength,
      threshold: MINIFIED_LINE_THRESHOLD,
      corroborator: "median",
    };
  }
  if (residualLongLineCount < MINIFIED_LONG_LINE_MIN_COUNT) return null;
  if (residualLongLineCount / totalLines >= MINIFIED_LONG_LINE_RATIO) {
    return {
      kind: "max-line-length-exceeds-threshold",
      value: maxLineLength,
      threshold: MINIFIED_LINE_THRESHOLD,
      corroborator: "ratio",
    };
  }
  return null;
}

/**
 * Convenience predicate retained for callers that only care about the
 * boolean "is this a build artifact" answer (not the classification). Wraps
 * {@link classifyBuildArtifact} so the predicate logic stays in one
 * place.
 */
export function isBuildArtifact(filePath: string, source: string): boolean {
  return classifyBuildArtifact(filePath, source) !== null;
}

/**
 * Batch helper: classify each `(filePath, source)` pair and return
 * the subset that are build artifacts as
 * `{ path, classification, signal }` records. Caller-side iteration
 * is folded in so `tool-scan-project.ts` can call once. Output order
 * matches the input order — callers wanting deterministic output
 * sort upstream.
 *
 * Additionally handles the `definite-sourcemap-paired` classification:
 * if the scanned set contains `app.js.map`, the paired `app.js` is
 * labelled with `classification: "definite-sourcemap-paired"` even
 * when neither of the per-file signals would have matched. The
 * `.map` file itself is excluded from the returned set — agents
 * don't author sourcemaps in-place and don't need a manual-review
 * prompt about one. The pairing is by full path minus the trailing
 * `.map`, so a `.map` in one directory never pairs with a source in
 * another.
 *
 * When per-file classification AND sourcemap-sibling both fire on
 * the same file, the per-file classification wins (first-match in
 * declaration order — `definite-min-infix`, `likely-hashed-bundle`,
 * `likely-bundler-output-dir` etc. come before sibling-pairing in
 * the documented evaluation order).
 */
export function collectBuildArtifacts(
  files: readonly { readonly filePath: string; readonly source: string }[],
  auxiliaryPaths: readonly string[] = [],
): readonly ScannedBuildArtifact[] {
  const pathsInSet = new Set<string>();
  for (const file of files) {
    pathsInSet.add(file.filePath.replace(/\\/g, "/"));
  }
  // Auxiliary paths augment the sibling-set membership lookup
  // (`findSiblingMinFile` / `findSiblingSourcemap`) without introducing
  // synthetic classification rows — `scan_file` passes a directory
  // sibling list here so its single-file substrate sees the same
  // sibling-pair evidence `scan_project` would have on the same input,
  // closing the cross-surface lane drift per
  // `docs/kb/architecture/ai-first-consumer.md` "Per-tool lane and
  // warning-set classification must agree." The auxiliary entries are
  // never iterated for per-file classification — they only contribute
  // to `pathsInSet` membership — so the helper's output stays scoped
  // to the input `files[]`.
  for (const auxPath of auxiliaryPaths) {
    pathsInSet.add(auxPath.replace(/\\/g, "/"));
  }
  const out: ScannedBuildArtifact[] = [];
  for (const file of files) {
    const detail =
      classifyBuildArtifactDetailed(file.filePath, file.source) ??
      detectSiblingArtifact(file.filePath, pathsInSet);
    if (detail !== null) out.push({ path: file.filePath, ...detail });
  }
  return out;
}

/**
 * Three sibling-set predicates compete; all deterministic. Map-pair
 * wins on ties because it's narrower (one map per source) and signals
 * the bundler-pipeline triage explicitly. Exact-stem min-pair
 * (`bootstrap.css` ↔ `bootstrap.min.css`) labels the readable source
 * paired with its minified twin as a release artifact (not as
 * minified bytes — the twin separately picks up `definite-min-infix`
 * upstream of this branch). The known-vendor-library fallback closes
 * the gap when the bundled `.min.<ext>` companion's stem differs from
 * the basename (`bootstrap.css` alongside `bootstrap.bundle.min.js`
 * + `popper.min.js`): the basename gate restricts the predicate to
 * curated vendor library stems and the same-directory `.min.<ext>`
 * co-occurrence corroborates the verdict. All three predicates emit
 * `definite-vendor-distribution`; the paired signal kind names which
 * sibling-set evidence fired so an agent re-deriving the verdict
 * reads the right corroborator.
 */
function detectSiblingArtifact(
  filePath: string,
  pathsInSet: ReadonlySet<string>,
): BuildArtifactClassificationResult | null {
  const siblingMap = findSiblingSourcemap(filePath, pathsInSet);
  if (siblingMap !== null) {
    return {
      classification: "definite-sourcemap-paired",
      signal: { kind: "sibling-map-file", value: siblingMap },
    };
  }
  const siblingMin = findSiblingMinFile(filePath, pathsInSet);
  if (siblingMin !== null) {
    return {
      classification: "definite-vendor-distribution",
      signal: { kind: "sibling-min-file", value: siblingMin },
    };
  }
  const knownVendorSignal = findKnownVendorLibraryWithMinSibling(filePath, pathsInSet);
  if (knownVendorSignal !== null) {
    return {
      classification: "definite-vendor-distribution",
      signal: knownVendorSignal,
    };
  }
  return null;
}

/**
 * Minimum number of paths that share a basename before the grouping
 * helper collapses them into one `{ basename, count, pathHint,
 * suggestedGlob, classifications }` entry. Below the threshold the entries
 * land in `classified[]` so a single-file basename doesn't get
 * collapsed to an overreaching `**\/<name>` glob. Matches the
 * `EXCLUDE_GLOB_COLLAPSE_THRESHOLD` used by `tool-propose-config.ts`
 * for top-level directory collapsing — same doctrine (three-entry
 * field-report-observed floor) applied one axis over (basename rather
 * than top-dir).
 */
export const BASENAME_GROUP_THRESHOLD = 3;

/**
 * One group entry on `meta.scannedBuildArtifacts.grouped`. Surfaces
 * the N same-named artifacts (e.g. `bootstrap.css` at 45 sites) as a
 * single, inspect-once row rather than N individual paths. `basename`
 * is the filename portion; `count` is the number of same-basename
 * entries the group subsumes; `pathHint` is the longest directory
 * prefix shared by every member, so the agent sees "these all sit
 * under `vendor/bootstrap/5.x/`" without scanning the flat list —
 * present-when-meaningful: omitted entirely when group members share
 * no common directory prefix (the empty-string sentinel was dishonest
 * per the AI-first "ambiguous field shapes" rule, since `""` was
 * indistinguishable from "field elided to save bytes"); the agent
 * reads "field absent" as "no actionable directory prefix for this
 * group" and falls back to the repo-wide `suggestedGlob` already
 * computed; `classifications` is the deduped set of classifier
 * verdicts fired across the group (most groups carry a single
 * classification — a vendor bundle shipped via
 * `likely-bundler-output-dir` — but e.g. a `bootstrap.css` and
 * `bootstrap.min.css` mix would carry both
 * `likely-bundler-output-dir` and `definite-min-infix`);
 * `suggestedGlob` is inline-ready for `propose_config`'s
 * `exclude: [...]` entry — root-relative POSIX, covers every member
 * of the group (plus any future same-basename file that lands under
 * the same prefix).
 *
 * Zero information loss vs. the flat form: the `classified[]`
 * sibling field retains every sub-threshold entry as a
 * `{ path, classifications: [...] }` row carrying the original
 * `{ classification, signal }` evidence under each
 * `kind: "min-infix" | "path-prefix"` classification entry, and
 * `count` on a group equals the number of absorbed paths — the
 * agent can reconstruct the per-path view by reading the group +
 * the classified list together.
 */
export interface BuildArtifactGroup {
  readonly basename: string;
  readonly count: number;
  readonly pathHint?: string;
  readonly classifications: readonly BuildArtifactClassification[];
  readonly suggestedGlob: string;
}

// Q12 merge surface: types ({@link ClassificationKind},
// {@link ClassificationEntry}, {@link ClassifiedArtifact}) and
// merger helper ({@link mergeClassifiedRows}) live in
// `./build-artifacts-classified.ts`. Re-export the types here so
// downstream consumers reading "the build-artifact module" from
// `./build-artifacts.ts` get the full shape from one import site.
export type {
  ClassificationEntry,
  ClassificationKind,
  ClassifiedArtifact,
} from "./build-artifacts-classified.ts";

/**
 * Grouped shape emitted on `meta.scannedBuildArtifacts`, replacing
 * the previous flat `ScannedBuildArtifact[]` array. Per doctrine
 * ("verbose meta is signal, not clutter"), the grouped form is a
 * strict information superset of the flat list: every same-basename
 * cluster of ≥ {@link BASENAME_GROUP_THRESHOLD} paths collapses to
 * one `{ basename, count, pathHint, suggestedGlob, classifications }` row
 * so a scan with 301 artifact paths across one `dist/bootstrap/`
 * tree surfaces as ~5 actionable group rows plus any
 * unclustered residue under `classified`.
 *
 * Q12: the previous parallel `ungrouped[]` (build-artifact classifier
 * residue) and `vendorLibraries[]` (banner detector) surfaces were
 * merged into a single `classified[]` keyed on path, with the
 * predicate family lifted onto each entry as
 * {@link ClassificationKind}. Two parallel "vendor classification"
 * surfaces was the canonical "Cross-surface count invariant" violation
 * the doctrine warns against — agents reading
 * `meta.scannedBuildArtifacts` had to union the two lists themselves
 * to triage a path.
 *
 * Deterministic ordering:
 *   - `grouped` sorted by `count` descending, ties broken by
 *     `basename` alphabetical — the agent sees the densest basename
 *     first, and same-count groups appear in a stable order across
 *     runs.
 *   - `classified` sorted by `path` alphabetical — stable across
 *     runs even if the underlying scanner reorders discovery.
 */
export interface BuildArtifactsGrouped {
  readonly grouped: readonly BuildArtifactGroup[];
  readonly classified: readonly ClassifiedArtifact[];
  /**
   * Q-SHARED-META-ARRAY-BUDGET-CAP: present only when `classified`
   * was trimmed to its head slice ({@link META_ARRAY_CAP} entries).
   * `shown` always equals the cap; `total` is the pre-cap length so
   * the agent can reconstruct the gap. Grouped entries are already
   * compact (one row per ≥3-entry basename cluster), so only the
   * `classified` tail grows linearly with input and needs capping.
   */
  readonly classifiedTruncated?: MetaArrayTruncationSummary;
}

/**
 * Collapses a flat {@link ScannedBuildArtifact} list (plus an
 * optional banner-detected {@link DetectedVendorLibrary} list) into
 * the grouped-by-basename shape surfaced on
 * `meta.scannedBuildArtifacts`. Groups form only when ≥
 * {@link BASENAME_GROUP_THRESHOLD} paths share a basename — below
 * that, the entries land in `classified[]` so a lone `bootstrap.css`
 * doesn't collapse to an overreaching `**\/bootstrap.css` glob.
 *
 * Q12: the previous output shape exposed `ungrouped[]` (per-file
 * build-artifact residue) and `vendorLibraries[]` (banner
 * identifications) as parallel surfaces, leaving the agent to union
 * the two when triaging a path. The merged shape lifts the
 * predicate family onto each entry as
 * {@link ClassificationKind} (`min-infix` | `path-prefix` |
 * `vendor-library-version-detected`) so a path that qualifies under
 * multiple predicates rides as one row carrying multiple
 * `classifications[]` entries.
 *
 * Every `pathHint` and `suggestedGlob` is root-relative POSIX so the
 * agent can paste them verbatim into a `propose_config` exclude
 * entry — matches the precedent set by `tool-propose-config.ts` and
 * the `Q-SHARED-PROPOSE-CONFIG-RELATIVE-PATHS` relativization pass.
 * `classified[]` entries carry the same root-relative POSIX `path`
 * form so every surface of the output agrees on path shape.
 *
 * Input ordering does not affect output: `grouped` sorts by count
 * desc then basename asc, `classified` sorts by path asc. Emptiness
 * is honest — `grouped` and `classified` can both be empty on a
 * clean scan, and the caller conditional-spreads the whole
 * `scannedBuildArtifacts` meta field on total emptiness so
 * downstream consumers see "no field" rather than
 * `{ grouped: [], classified: [] }`.
 */
export function groupBuildArtifactsByBasename(
  entries: readonly ScannedBuildArtifact[],
  root: string,
  vendorLibraries: readonly DetectedVendorLibrary[] = [],
): BuildArtifactsGrouped {
  if (entries.length === 0 && vendorLibraries.length === 0) {
    return { grouped: [], classified: [] };
  }
  const buckets = bucketByBasename(entries, root);
  const { grouped, ungroupedRaw } = partitionBuckets(buckets);
  // Deterministic sort: grouped by count desc then basename asc.
  // Stable across runs even when the scanner re-orders discovery.
  grouped.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.basename.localeCompare(b.basename);
  });
  const classifiedFull = mergeClassifiedRows(ungroupedRaw, vendorLibraries, root);
  // Q-SHARED-META-ARRAY-BUDGET-CAP: `classified` is the linear-with-
  // input tail — a website-templates scan observed 148KB of these
  // entries under the prior `ungrouped` field name. `grouped` rows
  // are already compact (one per ≥3-entry basename cluster), so
  // only the tail needs capping. Count-level signal is preserved via
  // the caller's `present` bit plus the `classifiedTruncated:
  // { shown, total }` sibling below.
  const capped = capMetaArray(classifiedFull);
  const base: {
    grouped: readonly BuildArtifactGroup[];
    classified: readonly ClassifiedArtifact[];
  } = {
    grouped,
    classified: capped.values,
  };
  return capped.truncated === undefined ? base : { ...base, classifiedTruncated: capped.truncated };
}

// Q12 merge helpers (`mergeClassifiedRows`,
// `buildArtifactClassificationEntry`, `classificationKindFor`) and
// their helper-internal `relativizeToPosixForMerge` live in
// `./build-artifacts-classified.ts`. Extracted to keep this file
// inside the per-file effective-line cap.

/**
 * Relativize every entry against the scan root and bucket by
 * basename. Paths that escape the root (startsWith `..`) or equal
 * it exactly are dropped — an exclude pattern outside the project
 * is meaningless. Extracted from {@link groupBuildArtifactsByBasename}
 * so the orchestrator stays under the cognitive-complexity cap.
 */
function bucketByBasename(
  entries: readonly ScannedBuildArtifact[],
  root: string,
): Map<string, ScannedBuildArtifact[]> {
  const rootPosix = root.replace(/\\/g, "/");
  const buckets = new Map<string, ScannedBuildArtifact[]>();
  for (const e of entries) {
    const rel = relativizeToPosix(e.path, rootPosix);
    if (rel === null) continue;
    const relativized: ScannedBuildArtifact = {
      path: rel,
      classification: e.classification,
      signal: e.signal,
    };
    const base = basenameOf(rel);
    const bucket = buckets.get(base);
    if (bucket === undefined) buckets.set(base, [relativized]);
    else bucket.push(relativized);
  }
  return buckets;
}

/**
 * Walk the basename buckets and split each into a grouped row (≥
 * {@link BASENAME_GROUP_THRESHOLD} members) or the ungrouped
 * residue. Pure over its input; extracted from
 * {@link groupBuildArtifactsByBasename} to keep the orchestrator
 * under the cognitive-complexity cap.
 */
function partitionBuckets(buckets: ReadonlyMap<string, readonly ScannedBuildArtifact[]>): {
  grouped: BuildArtifactGroup[];
  ungroupedRaw: ScannedBuildArtifact[];
} {
  const grouped: BuildArtifactGroup[] = [];
  const ungroupedRaw: ScannedBuildArtifact[] = [];
  for (const [basename, members] of buckets) {
    if (members.length >= BASENAME_GROUP_THRESHOLD) {
      const pathHint = longestCommonDirPrefix(members.map((m) => m.path));
      const classifications = dedupeClassificationsSorted(members.map((m) => m.classification));
      // pathHint is present-when-meaningful per AI-first "ambiguous
      // field shapes" doctrine: when group members share no common
      // directory prefix the helper returns "", which previously
      // shipped on every entry as a meaningless empty string.
      // Conditional-spread it away so the agent reading "field
      // absent" knows there is no actionable directory prefix to
      // paste, rather than re-disambiguating "did we elide this to
      // save bytes?". The repo-wide `suggestedGlob` (`**/<basename>`)
      // already covers the no-prefix case.
      grouped.push({
        basename,
        count: members.length,
        ...(pathHint ? { pathHint } : {}),
        classifications,
        suggestedGlob: buildSuggestedGlob(pathHint, basename),
      });
    } else {
      for (const m of members) ungroupedRaw.push(m);
    }
  }
  return { grouped, ungroupedRaw };
}

/**
 * POSIX-relativize `filePath` against `rootPosix`. Returns `null`
 * when the path equals the root (would yield an empty exclude
 * entry), escapes the root (`..`-prefixed after relativization), or
 * is an absolute host path that doesn't share the root prefix (a
 * symlinked source outside the scan root — meaningless as an
 * exclude entry). All three cases would emit broken glob
 * suggestions; the caller drops them silently rather than
 * surfacing a pattern the agent can't act on.
 *
 * Accepts absolute host paths with `\` separators and `/`-prefixed
 * POSIX paths interchangeably — all input is normalized to POSIX up
 * front. Already-relative input (no leading `/`, no drive letter)
 * passes through unchanged so tests or callers that feed pre-
 * relativized paths see the expected behavior.
 */
function relativizeToPosix(filePath: string, rootPosix: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  // Strip trailing slash from root for prefix comparison.
  const rootTrimmed = rootPosix.endsWith("/") ? rootPosix.slice(0, -1) : rootPosix;
  if (normalized === rootTrimmed) return null;
  if (normalized.startsWith(`${rootTrimmed}/`)) {
    const rel = normalized.slice(rootTrimmed.length + 1);
    if (rel === "" || rel.startsWith("../")) return null;
    return rel;
  }
  // Absolute path outside the scan root — drop it. The probe is
  // "starts with `/`" (POSIX-absolute) or "starts with drive letter"
  // (Windows-absolute after normalization); either way, the path
  // couldn't be relativized meaningfully against the scan root.
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return null;
  // Relative input (no absolute-path prefix) — accept verbatim,
  // rejecting anything that escapes via `..`.
  if (normalized.startsWith("../")) return null;
  return normalized;
}

/**
 * Longest shared directory prefix across `paths`, POSIX form, with
 * a trailing slash so the suggested-glob builder can append
 * `**\/<basename>` without an extra separator. Returns an empty
 * string when the paths share no directory (e.g. two same-basename
 * files at different top-level dirs) — the suggested glob degrades
 * to `**\/<basename>`, which is still agent-actionable even if
 * broader than ideal.
 *
 * Byte-level prefix match at directory-segment boundaries: never
 * partial-matches a filename (`"vendor/bo"` shared between
 * `vendor/bootstrap/x.css` and `vendor/bose/x.css` yields `"vendor/"`,
 * not `"vendor/bo"`). Operates on pre-relativized input so the
 * output is always repo-root-relative.
 */
function longestCommonDirPrefix(paths: readonly string[]): string {
  const first = paths[0];
  if (first === undefined) return "";
  if (paths.length === 1) {
    const slash = first.lastIndexOf("/");
    return slash === -1 ? "" : `${first.slice(0, slash)}/`;
  }
  // Compute longest common prefix at the character level, then
  // trim back to the last `/` so the result ends on a directory
  // boundary.
  let prefix = first;
  for (let i = 1; i < paths.length; i++) {
    const p = paths[i];
    if (p === undefined) continue;
    let j = 0;
    const end = Math.min(prefix.length, p.length);
    while (j < end && prefix.charCodeAt(j) === p.charCodeAt(j)) j++;
    prefix = prefix.slice(0, j);
    if (prefix === "") break;
  }
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash === -1 ? "" : `${prefix.slice(0, lastSlash + 1)}`;
}

/**
 * Builds the `**\/<basename>` glob the agent can paste into
 * `propose_config`'s `exclude:`. When the members share a
 * directory prefix, the glob anchors there so it doesn't
 * over-capture identically-named files in unrelated subtrees; when
 * they don't, the prefix is empty and the glob is repo-wide by
 * basename — still a legal exclude, just broader.
 */
function buildSuggestedGlob(pathHint: string, basename: string): string {
  return `${pathHint}**/${basename}`;
}

/**
 * Dedup a list of {@link BuildArtifactClassification} values and sort
 * alphabetically so the `classifications` field on a group is
 * deterministic across runs. Most groups carry a single
 * classification; mixed-classification groups exist (e.g. a
 * `bootstrap.css` under `dist/` + a `bootstrap.min.css` next to it
 * yields both `likely-bundler-output-dir` and `definite-min-infix`),
 * and the agent reads the array to know which falsifiable claim
 * covers each subset and at what confidence grade.
 */
function dedupeClassificationsSorted(
  classifications: readonly BuildArtifactClassification[],
): readonly BuildArtifactClassification[] {
  const seen = new Set<BuildArtifactClassification>();
  for (const c of classifications) seen.add(c);
  return [...seen].sort();
}

/**
 * per-file vendor-library identification
 * derived from first-line banner-comment matching against a curated list of
 * well-known libraries. Surfaces as the additive
 * `meta.scannedBuildArtifacts.classified[]` rows whose
 * `classifications[]` carries a `kind: "vendor-library-version-detected"`
 * entry, so an agent reading "43 contrast findings on
 * `bootstrap.min.css`" can tell the file is a known vendor
 * distribution and route triage to a `propose_config` exclude
 * rather than attempting per-finding fixes.
 *
 * Doctrine bar — "labeled buckets are only honest when provable from the code"
 * (see `docs/kb/architecture/ai-first-consumer.md`). The banner-comment
 * regex either matches the first non-whitespace line of the file or it does
 * not — a deterministic property of the source text. No path heuristics
 * (e.g. "if the file is in `/vendor/`"), no filename heuristics (e.g. "if
 * the basename starts with `bootstrap`"). Path-based matching is suppression
 * in disguise; the only honest signal here is the literal banner the
 * library's build pipeline emits at the top of every distributed bundle.
 *
 * The library set is intentionally small and conservative: every entry is a
 * library whose distribution bundle ships with a stable, documented banner
 * format that has not changed across major versions. Adding a new library
 * here requires (a) confirming the official build pipeline emits the banner
 * verbatim, (b) confirming the banner is unique enough that a hand-authored
 * file cannot accidentally include the same prefix, (c) extracting the
 * version capture group only when the banner format makes the version
 * trivially recoverable (a digit-dot-digit pattern in a documented slot).
 *
 * `version` is omitted (not `null`, not `""`) when the banner doesn't carry
 * a parseable version string — per the present-when-meaningful rule. The
 * agent reading a `DetectedVendorLibrary` without a `version` knows the
 * library was identified but the version was not in the banner; it does
 * not have to disambiguate "unknown" from "version 0".
 *
 * The structural type lives in `./build-artifacts-types.ts` (extracted
 * to break the cycle with the merger module); we re-export it from
 * this file's top-level type re-export.
 */

/**
 * One curated banner-comment pattern for {@link detectVendorLibraries}.
 * `library` is the canonical short identifier the agent reads as the
 * `library` field of {@link DetectedVendorLibrary}; `pattern` matches
 * against the file's first non-whitespace line. When the pattern's
 * first capture group is set, the captured text becomes the
 * `version` field; otherwise `version` is omitted entirely (the
 * banner did not carry a recoverable version slot).
 *
 * Each entry is anchored to the start of the line (`^`) so a coincidental
 * substring further down a long banner cannot trigger the match. Patterns
 * use the `u` flag for Unicode safety.
 */
interface VendorLibraryBanner {
  readonly library: string;
  readonly pattern: RegExp;
}

/**
 * Curated vendor-library banner table. Each pattern matches the first
 * non-whitespace line of the file's source — typically the canonical
 * `/*!` banner comment a library's build pipeline emits at the top of
 * every distributed bundle.
 *
 * Library inclusion criteria (see {@link DetectedVendorLibrary}):
 *
 *   - Banner is documented in the library's official build output and
 *     stable across major versions.
 *   - Banner contains a token unique enough that a hand-authored file
 *     could not coincidentally produce it as the first line. Generic
 *     marketing strings ("Copyright (c)") are not enough; library
 *     names paired with version markers or canonical URLs are.
 *   - Version capture (the optional first group) reads a `digit-dot-
 *     digit` slot the build pipeline always populates verbatim. When
 *     the banner doesn't carry a stable version slot, the entry omits
 *     the capture group and `version` stays absent on the wire.
 *
 * The table is intentionally short. Adding a new library here means
 * verifying the banner against at least one published distribution
 * artifact; vague matches grow the silent-mislabel surface area.
 */
const VENDOR_LIBRARY_BANNERS: readonly VendorLibraryBanner[] = [
  // Bootstrap: `/*! Bootstrap v5.3.0 (https://getbootstrap.com/) ...`
  // or older `/*!\n * Bootstrap v3.3.7 ...` (the multi-line form is
  // handled by trimming the leading `*` after the banner-line probe
  // matches `Bootstrap v<ver>`).
  {
    library: "bootstrap",
    pattern: /^\/\*!\s*\**\s*Bootstrap\s+v(\d+\.\d+\.\d+)/iu,
  },
  // jQuery: `/*! jQuery v3.6.0 | (c) OpenJS Foundation ... */`
  // The `v` prefix is canonical; older 1.x / 2.x bundles also emit it.
  {
    library: "jquery",
    pattern: /^\/\*!\s*jQuery\s+(?:JavaScript\s+Library\s+)?v?(\d+\.\d+\.\d+)/u,
  },
  // jQuery UI: `/*! jQuery UI - v1.12.1 - 2016-09-14 ... */`
  // Anchor on the literal "jQuery UI" sequence (case-sensitive — the
  // library's emitter never lowercases) and the `- v<ver>` slot.
  {
    library: "jquery-ui",
    pattern: /^\/\*!\s*jQuery\s+UI\s+-\s+v(\d+\.\d+\.\d+)/u,
  },
  // Font Awesome: `/*! Font Awesome Free 6.4.0 by @fontawesome ...`
  // or `/*! Font Awesome Pro 6.4.0 ...`. The `Free`/`Pro` token is
  // optional in the regex so both editions match; case-insensitive
  // because some pre-6.0 builds shipped `Font awesome`.
  {
    library: "font-awesome",
    pattern: /^\/\*!\s*Font\s+Awesome(?:\s+(?:Free|Pro))?\s+(\d+\.\d+\.\d+)/iu,
  },
  // Animate.css: `@license animate.css - http://daneden.me/animate ...`
  // or modern `Animate.css - https://animate.style/`. The version is
  // not in the canonical banner — the field omits it, and the agent
  // reads "library: animate.css" without a version.
  {
    library: "animate.css",
    pattern: /^\/\*!?\s*(?:@license\s+)?[Aa]nimate\.css\b/u,
  },
  // Modernizr: `/*! modernizr 3.6.0 (Custom Build) ...` — the build
  // tool emits the version inline before the build descriptor.
  {
    library: "modernizr",
    pattern: /^\/\*!\s*modernizr\s+(\d+\.\d+\.\d+)/iu,
  },
  // Normalize.css: `/*! normalize.css v8.0.1 | MIT License | github.com/necolas/normalize.css */`
  {
    library: "normalize.css",
    pattern: /^\/\*!\s*normalize\.css\s+v(\d+\.\d+\.\d+)/iu,
  },
  // Eric Meyer reset.css: `/* http://meyerweb.com/eric/tools/css/reset/`
  // No version is carried in the banner; the URL is the unique token.
  {
    library: "reset.css",
    pattern: /^\/\*\s*http:\/\/meyerweb\.com\/eric\/tools\/css\/reset/iu,
  },
  // fancyBox: `// fancyBox v3.5.7\n// http://fancyapps.com/fancybox/`
  // (script form) or `/*! fancyBox v3.5.7 ...` (banner form). Match
  // both opener variants.
  {
    library: "fancybox",
    pattern: /^(?:\/\*!?|\/\/)\s*fancy[Bb]ox\s+v(\d+\.\d+\.\d+)/u,
  },
];

/**
 * Returns the vendor-library identification for a single file's source
 * when its first non-whitespace line matches one of the curated
 * {@link VENDOR_LIBRARY_BANNERS}; `null` otherwise.
 *
 * "First non-whitespace line" is the leading line after any blank
 * lines and after stripping leading whitespace from the first non-
 * blank line. This handles the two canonical banner shapes:
 *
 *   - Single-line bang-comment openers — the entire banner sits on
 *     one line and closes before the first newline. Bootstrap 5,
 *     jQuery, Font Awesome, normalize.css, and fancyBox all emit
 *     this form.
 *   - Multi-line bang-comment openers — the bang-comment opens on
 *     line one, the version-bearing prose lives on line two, and
 *     the close-comment terminator sits on a later line. The
 *     leading line is the first non-blank line; the version-bearing
 *     follow-up line is reached only when a banner pattern's regex
 *     spans the newline. To keep the patterns single-line and the
 *     probe deterministic, the regexes that need version capture
 *     anchor on a single-line shape; multi-line banners that don't
 *     carry the version on the opener line surface as
 *     `library` without a `version`. A future pattern that needs to
 *     reach into a follow-up line should expand this helper to scan
 *     the first ≤4 banner lines instead of just the leading one.
 *
 * O(L) where L is the length of the first non-whitespace line — bounded
 * by the line-length probe and the regex test. Per-file cost is
 * trivial vs. parsing.
 */
function detectVendorLibraryForFile(
  filePath: string,
  source: string,
): DetectedVendorLibrary | null {
  const firstLine = firstNonBlankLine(source);
  if (firstLine === null) return null;
  for (const banner of VENDOR_LIBRARY_BANNERS) {
    const match = banner.pattern.exec(firstLine);
    if (match === null) continue;
    const version = match[1];
    return {
      path: filePath,
      library: banner.library,
      ...(version === undefined ? {} : { version }),
    };
  }
  return null;
}

/**
 * Reads the first non-blank line of `source` (leading whitespace
 * trimmed) so the banner regexes can anchor with `^\/\*!` without
 * worrying about leading newlines or BOMs. Returns `null` on a file
 * that contains only whitespace — there's no banner to match.
 *
 * Walks at most the first ~512 chars of the source: the probe is
 * looking for a comment-banner opener, which by convention sits at
 * the very top of distributed bundles. Bounding the walk keeps the
 * helper O(1) regardless of file size.
 */
function firstNonBlankLine(source: string): string | null {
  const probe = source.length > 512 ? source.slice(0, 512) : source;
  let start = 0;
  while (start < probe.length) {
    const ch = probe.charCodeAt(start);
    // Skip whitespace (space, tab) and line terminators (LF, CR) and
    // BOM (0xFEFF, which appears as the first char on UTF-8-with-BOM
    // files).
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0xfeff) {
      start += 1;
      continue;
    }
    break;
  }
  if (start >= probe.length) return null;
  let end = start;
  while (end < probe.length) {
    const ch = probe.charCodeAt(end);
    if (ch === 0x0a || ch === 0x0d) break;
    end += 1;
  }
  return probe.slice(start, end);
}

/**
 * Batch helper: classify each `(filePath, source)` pair against the
 * curated {@link VENDOR_LIBRARY_BANNERS} table and return the subset
 * of files whose first non-whitespace line matched as
 * {@link DetectedVendorLibrary} records.
 *
 * Pairs with {@link collectBuildArtifacts}: vendor-library detection
 * is *orthogonal* to build-artifact classification. A file matching a
 * banner is almost always also a build artifact (the bundle was
 * minified or shipped under `dist/`), but the two predicates are
 * independent — the agent can read the existing `signal` / `classification`
 * to confirm "this is generated bytes" AND the new `library` to
 * answer "which library is it." Adding a vendor-library label does
 * NOT alter the existing classifier verdict.
 *
 * Output is sorted by `path` ascending so output is deterministic
 * across runs (matches the convention used by `classified` in
 * {@link groupBuildArtifactsByBasename}). Returns an empty array (not
 * `null`, not `[null]`) when no banners match — the caller spreads on
 * `length > 0` per the present-when-meaningful rule.
 */
export function detectVendorLibraries(
  files: readonly { readonly filePath: string; readonly source: string }[],
): readonly DetectedVendorLibrary[] {
  const out: DetectedVendorLibrary[] = [];
  for (const file of files) {
    const detected = detectVendorLibraryForFile(file.filePath, file.source);
    if (detected !== null) out.push(detected);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
