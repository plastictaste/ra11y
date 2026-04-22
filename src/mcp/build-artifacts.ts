/**
 * Deterministic detection of compiled-CSS / bundler-output files among
 * the set of files a scan has already parsed.
 *
 * Surfaces as `meta.scannedBuildArtifacts: ScannedBuildArtifact[]` on
 * `scan_project` responses — a *labelled* list, not a filter. Each
 * entry pairs the `path` with a `reason` string drawn from a closed
 * set, so the consuming agent can triage without re-reading every
 * flagged file. Findings on these files still appear in `files`; the
 * meta entry tells the agent "this finding sits on a generated file,
 * and here is *why* the scanner classified it so."
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
 *      `jquery.min.js`) or the source text contains a single
 *      uninterrupted line of more than {@link MINIFIED_LINE_THRESHOLD}
 *      characters. Both forms only appear on machine-emitted output;
 *      hand-authored source wraps lines.
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

/** Closed set of classification reasons emitted on `ScannedBuildArtifact.reason`. */
export type BuildArtifactReason =
  | "minified"
  | "sourcemap-sibling"
  | "hashed-filename"
  | "dist-path"
  | "contains-data-url-gradient"
  | "tailwind-compiled-escape";

/**
 * One classified artifact entry surfaced on
 * `meta.scannedBuildArtifacts`. The agent reads `reason` to triage
 * whether the file is worth investigating without opening it. The
 * paired `path` is the same path the rest of the response uses
 * (relative-to-scanned-root), so a caller can join against the
 * `files[]` bucket directly.
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
 * BuildArtifactReason} or `null` when no signal fires. Evaluation is
 * first-match wins in the order documented at the module docblock
 * — `minified` first because it is the most specific (a `.min.`
 * infix or a 500-char single line is unambiguous output), then path-
 * based signals, then content-based CSS signals.
 *
 * The `sourcemap-sibling` reason is NOT checked here because it
 * requires the full scanned set — use {@link collectBuildArtifacts}
 * for that branch. The path-based signals are intentionally
 * extension-agnostic: a file under `/dist/assets/` is a build
 * artifact regardless of whether it ends in `.css` or `.html`. The
 * Tailwind-escape and data-URL probes are gated to `.css` / `.scss`
 * (JSX sources can carry those patterns as string literals, which
 * are not compiled CSS).
 *
 * O(file size) — one regex pass on the source when the file is CSS,
 * plus a few O(1) path probes.
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
  if (hasLongMinifiedLine(source)) return "minified";
  if (matchesHashedFilename(filePath)) return "hashed-filename";
  if (matchesBuildDirMarker(filePath)) return "dist-path";
  if (!isCssPath(filePath)) return null;
  if (source.includes(DATA_URL_IMAGE_MARKER)) return "contains-data-url-gradient";
  if (TAILWIND_ESCAPED_SELECTOR.test(source)) return "tailwind-compiled-escape";
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
  // Case-insensitive .css / .scss suffix check. Avoids a regex for what
  // is a two-field string probe and keeps the hot-path
  // allocation-free. `.scss` counts here because our SCSS parser emits
  // the CSS AST shape; consumers of this predicate (fingerprint /
  // build-artifact heuristics) treat the two identically.
  const lower = filePath.toLowerCase();
  return lower.endsWith(".css") || lower.endsWith(".scss");
}

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
 */
function hasLongMinifiedLine(source: string): boolean {
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
