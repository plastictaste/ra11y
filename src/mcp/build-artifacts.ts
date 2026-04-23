/**
 * Deterministic detection of compiled-CSS / bundler-output files among
 * the set of files a scan has already parsed.
 *
 * Surfaces as `meta.scannedBuildArtifacts: BuildArtifactsGrouped` on
 * `scan_project` responses — a *labelled* grouped view, not a
 * filter. Each entry pairs the `path` with a `reason` string drawn
 * from a closed set, so the consuming agent can triage without
 * re-reading every flagged file. Findings on these files still
 * appear in `files`; the meta entry tells the agent "this finding
 * sits on a generated file, and here is *why* the scanner
 * classified it so." The on-wire shape collapses ≥3-entry same-
 * basename clusters into `grouped[i]` rows with paste-ready
 * `suggestedGlob`s; sub-threshold entries stay in `ungrouped` with
 * their `{ path, reason }` records intact. See {@link
 * groupBuildArtifactsByBasename}.
 *
 * Per CLAUDE.md §1 "Labeled buckets are suppression too," a label
 * earns its place only when it is *provable from the code* rather
 * than heuristic. Each reason below clears that bar — the predicate
 * that produced it is a deterministic property of the path or source
 * text, not a guess.
 *
 * Reasons, in classifier evaluation order (first-match wins; the
 * comment block at {@link classifyBuildArtifact} restates the order
 * inline so future edits keep predicate ↔ reason aligned):
 *
 *   1. `minified`. Either the basename carries a `.min.` infix
 *      (canonical pre-minified bundle marker — `bootstrap.min.css`,
 *      `jquery.min.js`) OR the source text crosses the single-long-
 *      line probe (> {@link MINIFIED_LINE_THRESHOLD} chars on one
 *      line) AND a second-tier corroborator also fires: either ≥25%
 *      of lines exceed the threshold or the median line length itself
 *      exceeds it. The standalone long-line probe used to be enough
 *      but mis-labeled authored files (Astro `<Example code={`…`}/>`
 *      template literals, Google-Maps iframe URLs, SCSS type-signature
 *      function bodies) that happen to cross 500 chars on exactly one
 *      authored line — the single signal is too weak to be provable
 *      from file shape alone. A real minified bundle reads as
 *      either several long lines among few (ratio) or one enormous
 *      line (median); one long line among fifty short is not
 *      minification evidence.
 *   2. `sourcemap-sibling`. A sibling `.map` file is in the scanned
 *      set with the matching basename. Pairing a `.js` / `.css` with
 *      its `.map` is the signature of a compiled bundle. The `.map`
 *      file itself is *not* labelled here — agents don't author
 *      sourcemaps in-place and a manual-review prompt about one is
 *      noise.
 *   3. `hashed-filename`. An 8+ character lowercase-hex segment
 *      flanked by dots in the basename, as emitted by
 *      Webpack/Rollup/Vite/esbuild for content-addressed output
 *      (`app.a1b2c3d4.js`, `chunk.0123abcdef.css`). Hand-authored
 *      filenames do not take this shape.
 *   4. `dist-path`. The path includes a canonical bundler-output
 *      directory segment — `dist/`, `build/`, `_site/`, `public/`,
 *      `node_modules/`, plus framework-specific output trees like
 *      `.next/`, `.svelte-kit/`, `.output/`, and `static/assets/`.
 *      A trailing `/` is required so a root-level file literally
 *      named `dist.ts` cannot confound the match.
 *   5. `contains-data-url-gradient`. A `.css` / `.scss` source whose
 *      text contains `url(data:image/` — vendored bundles frequently
 *      inline SVG/PNG gradient backgrounds via base64 data URLs;
 *      hand-authored stylesheets reach for external image references
 *      or CSS gradients instead. CSS-only because JSX strings can
 *      legitimately mention `data:image/` as an asset URL builder.
 *   6. `tailwind-compiled-escape`. A `.css` / `.scss` source whose
 *      text contains an escape-bracket Tailwind utility selector
 *      (`\[400px\]`, `\:focus-visible:`, `\[--…]`). These are emitted
 *      by Tailwind's JIT compiler as the CSS-escaped form of utility
 *      class names like `w-[400px]` — a single occurrence proves the
 *      file came from the build pipeline.
 *
 * What is *not* a signal: the `_` filename prefix. That prefix is the
 * Sass partial convention for authored source (`_variables.scss`,
 * `_mixins.scss`) — mis-labeling an authored partial as artifact
 * misleads the agent's triage. Likewise, raw line count is not a
 * signal: Bootstrap's `_variables.scss` is ~2000 lines of hand-
 * authored `$var` declarations across many short lines. The minified
 * detector requires a *single* line over the threshold so the same
 * partial does not get mislabelled.
 *
 * Single-reason output: each path is reported once, with the first
 * matching reason. Combining reasons would defeat the doctrine's
 * "label must survive inspection" bar — the agent reading
 * `reason: "minified"` is verifying one falsifiable claim, not
 * sorting through a bag.
 */

import { capMetaArray, type MetaArrayTruncationSummary } from "./meta-array-cap.ts";

/** Closed set of classification reasons emitted on `ScannedBuildArtifact.reason`. */
export type BuildArtifactReason =
  | "minified"
  | "sourcemap-sibling"
  | "hashed-filename"
  | "dist-path"
  | "contains-data-url-gradient"
  | "tailwind-compiled-escape";

/**
 * One classified artifact entry. On `scan_project`, these records
 * ride inside the grouped envelope —
 * `meta.scannedBuildArtifacts.ungrouped[]` — for any sub-threshold
 * basenames that didn't form a group of ≥
 * {@link BASENAME_GROUP_THRESHOLD}. The agent reads `reason` to
 * triage whether the file is worth investigating without opening
 * it. The paired `path` is the same path the rest of the response
 * uses (root-relative POSIX after the grouper's relativization),
 * so a caller can join against the `files[]` bucket directly.
 */
export interface ScannedBuildArtifact {
  readonly path: string;
  readonly reason: BuildArtifactReason;
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
 * Marker substring for the `contains-data-url-gradient` reason.
 * Hand-authored CSS rarely inlines raw image bytes via base64 data
 * URLs; vendored bundles (Bootstrap, Font Awesome, Tailwind plugins
 * with image presets) routinely do. The probe is intentionally
 * narrow — `data:image/` rather than `data:` alone — so a CSS file
 * that inlines a tiny SVG mask icon via `data:image/svg+xml,...` is
 * caught while a non-image data URL (e.g. an `@font-face`
 * `url(data:application/font-woff2;…)` block, which is normal hand-
 * authored shape) does not trigger.
 */
const DATA_URL_IMAGE_MARKER = "url(data:image/";

/**
 * Substring markers for canonical bundler-output directories. The
 * matcher tolerates each marker either bracketed by `/` inside the
 * path OR sitting at the start of a relative path (`dist/main.css`).
 * A bare filename like `dist.ts` at the repo root stays unmatched —
 * the probe requires a trailing `/` to confirm it's a directory
 * segment, not a filename prefix. `_site/` is Jekyll's default
 * output directory; `public/` is a generated-output directory for
 * several frameworks (Hugo, Gatsby, Nuxt's `.output/public/`, Vite's
 * `public/` when used as a build target); `node_modules/` is the
 * packaged-dependency tree by definition.
 */
const BUILD_DIR_MARKERS = [
  "dist/",
  "build/",
  "_site/",
  "public/",
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
 * Pure per-file classifier: returns the matching {@link
 * BuildArtifactReason} or `null` when no signal fires.
 *
 * Evaluation order:
 *   1. `.min.` infix on the basename → `minified`. Canonical on pre-
 *      minified bundles, unambiguous.
 *   2. Hashed-filename segment (8+ hex between dots) → `hashed-filename`.
 *   3. Bundler-output path ancestry → `dist-path`.
 *   4. CSS-only: `data:image/` inline → `contains-data-url-gradient`.
 *   5. CSS-only: Tailwind escape-bracket selector →
 *      `tailwind-compiled-escape`.
 *   6. Single-line-over-threshold + second-tier corroboration →
 *      `minified`. The long-line probe alone is not enough: authored
 *      Astro/Starlight template-literal props, Google-Maps iframe URLs,
 *      SCSS type signatures, and MDX component prop bundles all cross
 *      the 500-char line cap once while the rest of the file reads
 *      short. At least one corroborator from {long-line ratio, median
 *      line length} must also fire for the bundle verdict (see
 *      {@link hasLongMinifiedLineCorroborated}). The path-based signals
 *      above (`.min.`, hashed, dist-path) already handle the cases
 *      where the single-long-line probe lines up with a deterministic
 *      filesystem marker; this final branch covers short-path bundles
 *      whose source text itself still proves minification.
 *
 * The `sourcemap-sibling` reason is NOT checked here because it
 * requires the full scanned set — use {@link collectBuildArtifacts}
 * for that branch (a sibling `.map` fills in as the corroborator for
 * files whose source-text alone is ambiguous). The path-based signals
 * are intentionally extension-agnostic: a file under `/dist/assets/`
 * is a build artifact regardless of whether it ends in `.css` or
 * `.html`. The Tailwind-escape and data-URL probes are gated to
 * `.css` / `.scss` (JSX sources can carry those patterns as string
 * literals, which are not compiled CSS).
 *
 * O(file size) — at most one linear pass on the source for the line-
 * statistics helper when the cheaper signals miss, plus a few O(1)
 * path probes.
 */
export function classifyBuildArtifact(
  filePath: string,
  source: string,
): BuildArtifactReason | null {
  // Sourcemap files are never classified as build artifacts in their
  // own right — agents don't author or hand-edit `.map` files, and
  // listing one under `scannedBuildArtifacts` would only add noise
  // alongside the paired source. The `sourcemap-sibling` reason is
  // attached to the *source* file in `collectBuildArtifacts`; the
  // map itself stays out.
  if (filePath.replace(/\\/g, "/").endsWith(".map")) return null;
  if (matchesMinInfix(filePath)) return "minified";
  if (matchesHashedFilename(filePath)) return "hashed-filename";
  if (matchesBuildDirMarker(filePath)) return "dist-path";
  if (isCssPath(filePath)) {
    if (source.includes(DATA_URL_IMAGE_MARKER)) return "contains-data-url-gradient";
    if (TAILWIND_ESCAPED_SELECTOR.test(source)) return "tailwind-compiled-escape";
  }
  // Q3-BUILD-ARTIFACT-SINGLE-LONG-LINE-SECOND-PROBE: the standalone
  // single-long-line probe was the root cause of 54 authored files
  // mis-labeled on a Bootstrap docs scan and 101 on a website-
  // templates scan — one long line in an Astro template literal, a
  // Google Maps iframe URL, or an MDX prop bundle is not minification
  // evidence. Require a corroborating content signal so the verdict
  // stays provable from file shape.
  if (hasLongMinifiedLineCorroborated(source)) return "minified";
  return null;
}

function matchesBuildDirMarker(filePath: string): boolean {
  // Normalize backslashes so Windows-style paths ("C:\proj\dist\…")
  // are handled. The matcher accepts a marker either preceded by `/`
  // anywhere in the path OR sitting at the very start — that covers
  // the two canonical cases ("/proj/dist/x.css" and "dist/x.css")
  // without mislabeling a root-level file literally named "dist.ts".
  const normalized = filePath.replace(/\\/g, "/");
  for (const marker of BUILD_DIR_MARKERS) {
    if (normalized.startsWith(marker) || normalized.includes(`/${marker}`)) return true;
  }
  return false;
}

function matchesMinInfix(filePath: string): boolean {
  const basename = basenameOf(filePath);
  return MIN_INFIX_RE.test(basename);
}

function matchesHashedFilename(filePath: string): boolean {
  const basename = basenameOf(filePath);
  return HASHED_FILENAME_RE.test(basename);
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
 * One contiguous line-statistics scan returning both corroboration
 * predicates in a single pass: the count of long lines (over
 * {@link MINIFIED_LINE_THRESHOLD}), the total line count, and the
 * median line length. Splitting into two separate loops would double
 * the hot-path work on every parsed file; folding them here keeps the
 * helper O(N) with one pass (median is computed on a single
 * line-length array allocated only when we actually need the stats,
 * i.e. only once the single-long-line probe already fired).
 *
 * Line semantics match {@link hasLongMinifiedLine}: a trailing line
 * without a terminator counts as one line; CRLF / LF are treated
 * identically. Empty input returns zeroed stats (total = 0, median =
 * 0, longLines = 0) — the caller must treat a zero-line file as "no
 * corroboration" to avoid a degenerate median.
 */
function computeLineStats(source: string): {
  readonly totalLines: number;
  readonly longLineCount: number;
  readonly medianLineLength: number;
} {
  if (source.length === 0) {
    return { totalLines: 0, longLineCount: 0, medianLineLength: 0 };
  }
  const lengths = collectLineLengths(source);
  let longLineCount = 0;
  for (const l of lengths) {
    if (l > MINIFIED_LINE_THRESHOLD) longLineCount += 1;
  }
  return {
    totalLines: lengths.length,
    longLineCount,
    medianLineLength: medianOfUnsortedLengths(lengths),
  };
}

/**
 * Walks `source` once and returns one entry per line with its
 * character length. CRLF sequences fold to a single line break so
 * Windows-authored or Windows-checked-out files report the same line
 * count as POSIX ones. A trailing line without a terminator still
 * counts as one line. The helper allocates exactly the returned
 * array — no intermediate splits.
 */
function collectLineLengths(source: string): readonly number[] {
  const lengths: number[] = [];
  let runLength = 0;
  let lastWasCR = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 10 || ch === 13) {
      // CRLF collapses to one line break: the `\r` records the line,
      // and the following `\n` sees `lastWasCR === true` so it skips
      // recording a zero-length line.
      if (ch === 10 && lastWasCR) {
        lastWasCR = false;
        continue;
      }
      lengths.push(runLength);
      runLength = 0;
      lastWasCR = ch === 13;
      continue;
    }
    runLength++;
    lastWasCR = false;
  }
  // Flush the final line (unterminated file).
  lengths.push(runLength);
  return lengths;
}

/**
 * Median of `lengths` by sorting a COPY (the caller owns the scratch
 * array, we don't mutate it). Empty input → 0; even lengths average
 * the middle two (floored — medians of integer line lengths stay
 * integer for easy comparison against the threshold).
 */
function medianOfUnsortedLengths(lengths: readonly number[]): number {
  if (lengths.length === 0) return 0;
  const sorted = [...lengths].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.floor(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/**
 * Returns true when the single-long-line probe fires AND at least one
 * second-tier corroborator also fires:
 *   (a) ≥{@link MINIFIED_LONG_LINE_RATIO} of lines exceed
 *       {@link MINIFIED_LINE_THRESHOLD}, OR
 *   (b) the median line length itself exceeds the threshold.
 *
 * The two corroborators catch different bundle shapes: (a) covers
 * "many long lines" (canonical minified CSS with one rule per line
 * but every line long), while (b) covers "one enormous line file"
 * (canonical minified JS bundle with everything on a single unwrapped
 * line).
 *
 * The `.min.` infix, hashed filenames, bundler-output path ancestry,
 * and `.map` sibling signals are already deterministic standalone
 * labels upstream of this call (see {@link classifyBuildArtifact} and
 * {@link collectBuildArtifacts}); they do not need to participate
 * here because a file carrying any of them is already labeled
 * before the corroborated-long-line branch runs.
 */
function hasLongMinifiedLineCorroborated(source: string): boolean {
  if (!hasLongMinifiedLine(source)) return false;
  const { totalLines, longLineCount, medianLineLength } = computeLineStats(source);
  if (totalLines === 0) return false;
  if (medianLineLength > MINIFIED_LINE_THRESHOLD) return true;
  return longLineCount / totalLines >= MINIFIED_LONG_LINE_RATIO;
}

/**
 * Convenience predicate retained for callers that only care about the
 * boolean "is this a build artifact" answer (not the reason). Wraps
 * {@link classifyBuildArtifact} so the predicate logic stays in one
 * place.
 */
export function isBuildArtifact(filePath: string, source: string): boolean {
  return classifyBuildArtifact(filePath, source) !== null;
}

/**
 * Batch helper: classify each `(filePath, source)` pair and return
 * the subset that are build artifacts as `{ path, reason }` records.
 * Caller-side iteration is folded in so `tool-scan-project.ts` can
 * call once. Output order matches the input order — callers wanting
 * deterministic output sort upstream.
 *
 * Additionally handles the `sourcemap-sibling` signal: if the
 * scanned set contains `app.js.map`, the paired `app.js` is labelled
 * with reason `"sourcemap-sibling"` even when neither of the per-
 * file signals would have matched. The `.map` file itself is
 * excluded from the returned set — agents don't author sourcemaps
 * in-place and don't need a manual-review prompt about one. The
 * pairing is by full path minus the trailing `.map`, so a `.map` in
 * one directory never pairs with a source in another.
 *
 * When per-file classification AND sourcemap-sibling both fire on
 * the same file, the per-file reason wins (first-match in
 * declaration order — `minified`, `hashed-filename`, `dist-path`
 * come before sibling-pairing in the documented evaluation order).
 */
export function collectBuildArtifacts(
  files: readonly { readonly filePath: string; readonly source: string }[],
): readonly ScannedBuildArtifact[] {
  const pathsInSet = new Set<string>();
  for (const file of files) {
    pathsInSet.add(file.filePath.replace(/\\/g, "/"));
  }
  const out: ScannedBuildArtifact[] = [];
  for (const file of files) {
    const reason = classifyBuildArtifact(file.filePath, file.source);
    if (reason !== null) {
      out.push({ path: file.filePath, reason });
      continue;
    }
    if (hasSiblingSourcemap(file.filePath, pathsInSet)) {
      out.push({ path: file.filePath, reason: "sourcemap-sibling" });
    }
  }
  return out;
}

function hasSiblingSourcemap(filePath: string, pathsInSet: ReadonlySet<string>): boolean {
  // A sourcemap itself is never a build artifact from ra11y's
  // perspective — we don't scan map contents for a11y signal, and
  // labelling one would only add noise. The sibling probe is only
  // meaningful for the *source* file, so short-circuit when the
  // input is the `.map`.
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.endsWith(".map")) return false;
  return pathsInSet.has(`${normalized}.map`);
}

/**
 * Minimum number of paths that share a basename before the grouping
 * helper collapses them into one `{ basename, count, pathHint,
 * suggestedGlob, reasons }` entry. Below the threshold the entries
 * stay in the `ungrouped` array so a single-file basename doesn't get
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
 * under `vendor/bootstrap/5.x/`" without scanning the flat list;
 * `reasons` is the deduped set of classifier reasons fired across the
 * group (most groups carry a single reason — a vendor bundle shipped
 * via `dist-path` — but e.g. a `bootstrap.css` and `bootstrap.min.css`
 * mix would carry both `dist-path` and `minified`); `suggestedGlob`
 * is inline-ready for `propose_config`'s `exclude: [...]` entry —
 * root-relative POSIX, covers every member of the group (plus any
 * future same-basename file that lands under the same prefix).
 *
 * Zero information loss vs. the flat form: the ungrouped sibling
 * field retains every sub-threshold entry as `{ path, reason }`
 * records, and `count` on a group equals the number of absorbed
 * paths — the agent can reconstruct the per-path view by reading
 * the group + the ungrouped list together.
 */
export interface BuildArtifactGroup {
  readonly basename: string;
  readonly count: number;
  readonly pathHint: string;
  readonly reasons: readonly BuildArtifactReason[];
  readonly suggestedGlob: string;
}

/**
 * Grouped shape emitted on `meta.scannedBuildArtifacts`, replacing
 * the previous flat `ScannedBuildArtifact[]` array. Per doctrine
 * ("verbose meta is signal, not clutter"), the grouped form is a
 * strict information superset of the flat list: every same-basename
 * cluster of ≥ {@link BASENAME_GROUP_THRESHOLD} paths collapses to
 * one `{ basename, count, pathHint, suggestedGlob, reasons }` row
 * so a scan with 301 artifact paths across one `dist/bootstrap/`
 * tree surfaces as ~5 actionable group rows plus any
 * unclustered residue under `ungrouped`.
 *
 * Deterministic ordering:
 *   - `grouped` sorted by `count` descending, ties broken by
 *     `basename` alphabetical — the agent sees the densest basename
 *     first, and same-count groups appear in a stable order across
 *     runs.
 *   - `ungrouped` sorted by `path` alphabetical — stable across
 *     runs even if the underlying scanner reorders discovery.
 */
export interface BuildArtifactsGrouped {
  readonly grouped: readonly BuildArtifactGroup[];
  readonly ungrouped: readonly ScannedBuildArtifact[];
  /**
   * Q-SHARED-META-ARRAY-BUDGET-CAP: present only when `ungrouped`
   * was trimmed to its head slice ({@link META_ARRAY_CAP} entries).
   * `shown` always equals the cap; `total` is the pre-cap length so
   * the agent can reconstruct the gap. Grouped entries are already
   * compact (one row per ≥3-entry basename cluster), so only the
   * `ungrouped` tail grows linearly with input and needs capping.
   */
  readonly ungroupedTruncated?: MetaArrayTruncationSummary;
}

/**
 * Collapses a flat {@link ScannedBuildArtifact} list into the
 * grouped-by-basename shape surfaced on
 * `meta.scannedBuildArtifacts`. Groups form only when ≥
 * {@link BASENAME_GROUP_THRESHOLD} paths share a basename — below
 * that, the entries stay in `ungrouped` so a lone `bootstrap.css`
 * doesn't collapse to an overreaching `**\/bootstrap.css` glob.
 *
 * Every `pathHint` and `suggestedGlob` is root-relative POSIX so the
 * agent can paste them verbatim into a `propose_config` exclude
 * entry — matches the precedent set by `tool-propose-config.ts` and
 * the `Q-SHARED-PROPOSE-CONFIG-RELATIVE-PATHS` relativization pass.
 * `ungrouped` entries carry the same root-relative POSIX `path` form
 * so the two halves of the output agree on path shape.
 *
 * Input ordering does not affect output: `grouped` sorts by count
 * desc then basename asc, `ungrouped` sorts by path asc. Emptiness
 * is honest — `grouped` and `ungrouped` can both be empty on a clean
 * scan, and the caller (`tool-scan-project.ts`) conditional-spreads
 * the whole `scannedBuildArtifacts` meta field on total emptiness so
 * downstream consumers see "no field" rather than
 * `{ grouped: [], ungrouped: [] }`.
 */
export function groupBuildArtifactsByBasename(
  entries: readonly ScannedBuildArtifact[],
  root: string,
): BuildArtifactsGrouped {
  if (entries.length === 0) {
    return { grouped: [], ungrouped: [] };
  }
  const buckets = bucketByBasename(entries, root);
  const { grouped, ungroupedRaw } = partitionBuckets(buckets);
  // Deterministic sort: grouped by count desc then basename asc;
  // ungrouped by path asc. Stable across runs even when the scanner
  // re-orders its discovery pass.
  grouped.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.basename.localeCompare(b.basename);
  });
  const ungroupedSorted = [...ungroupedRaw].sort((a, b) => a.path.localeCompare(b.path));
  // Q-SHARED-META-ARRAY-BUDGET-CAP: `ungrouped` is the linear-with-
  // input tail — a website-templates scan observed 148KB of these
  // entries. `grouped` rows are already compact (one per ≥3-entry
  // basename cluster), so only the tail needs capping. Count-level
  // signal is preserved via the caller's `present` bit plus the
  // `ungroupedTruncated: { shown, total }` sibling below.
  const capped = capMetaArray(ungroupedSorted);
  const base: {
    grouped: readonly BuildArtifactGroup[];
    ungrouped: readonly ScannedBuildArtifact[];
  } = {
    grouped,
    ungrouped: capped.values,
  };
  return capped.truncated === undefined ? base : { ...base, ungroupedTruncated: capped.truncated };
}

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
    const relativized: ScannedBuildArtifact = { path: rel, reason: e.reason };
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
      const reasons = dedupeReasonsSorted(members.map((m) => m.reason));
      grouped.push({
        basename,
        count: members.length,
        pathHint,
        reasons,
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
 * Dedup a list of {@link BuildArtifactReason} values and sort
 * alphabetically so the `reasons` field on a group is deterministic
 * across runs. Most groups carry a single reason; mixed-reason
 * groups exist (e.g. a `bootstrap.css` under `dist/` + a
 * `bootstrap.min.css` next to it), and the agent reads the array to
 * know which falsifiable claim covers each subset.
 */
function dedupeReasonsSorted(
  reasons: readonly BuildArtifactReason[],
): readonly BuildArtifactReason[] {
  const seen = new Set<BuildArtifactReason>();
  for (const r of reasons) seen.add(r);
  return [...seen].sort();
}
