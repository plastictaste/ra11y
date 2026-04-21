/**
 * Deterministic detection of compiled-CSS / bundler-output files among
 * the set of files a scan has already parsed.
 *
 * Surfaces as `meta.scannedBuildArtifacts: string[]` on `scan_project`
 * responses — a *label*, not a filter. Findings on these files still
 * appear in `files`; the meta entry tells the consuming agent "this
 * finding sits on a generated file; investigate before editing
 * source." Per CLAUDE.md §1 "Labeled buckets are suppression too," a
 * label earns its place only when it is *provable from the code*
 * rather than heuristic. Each signal below clears that bar:
 *
 *   1. `.min.` infix (e.g. `bootstrap.min.css`, `jquery.min.js`).
 *      Canonical marker for a pre-minified distribution bundle. The
 *      infix only appears on generated output by convention; authored
 *      source never carries it.
 *   2. Hashed-filename pattern (e.g. `app.a1b2c3d4.js`,
 *      `chunk.0123abcd.css`). An 8+ character lowercase-hex segment
 *      flanked by dots is emitted by Webpack/Rollup/Vite/esbuild for
 *      content-addressed output. Hand-authored filenames do not take
 *      this shape.
 *   3. Bundler-output path ancestry (`dist/`, `build/`, `_site/`,
 *      `public/`, `node_modules/`, plus framework-specific output
 *      trees like `.next/`, `.svelte-kit/`, `.output/`, and
 *      `static/assets/`). These are canonical generated locations.
 *   4. Sibling sourcemap — the file has a sibling `.map` in the
 *      scanned set with matching basename. A `.map` file paired with
 *      its source is the signature of a compiled bundle; hand-written
 *      source never ships one.
 *   5. Escape-bracket Tailwind utility selectors on `.css` files
 *      (`\[400px\]`, `\:focus-visible:`, `\[--…]`). Hand-written CSS
 *      does not contain these — they are emitted by Tailwind's JIT
 *      compiler as the CSS-escaped form of utility class names like
 *      `w-[400px]`. One match is proof the file came from the build.
 *
 * What is *not* a signal: the `_` filename prefix. That prefix is the
 * Sass partial convention for authored source (`_variables.scss`,
 * `_mixins.scss`) — mis-labeling an authored partial as artifact
 * misleads the agent's triage. Likewise, raw line count is not a
 * signal: Bootstrap's `_variables.scss` is ~2000 lines of hand-
 * authored `$var` declarations, and any threshold-based probe would
 * flag it. Both routes fail the provable-from-code bar the label
 * commits to.
 *
 * Any single matching signal labels the file. The intent is not to
 * cross-check signals — the label is additive information and over-
 * labeling an obvious artifact is the cheap failure mode (agents
 * dismiss in one read). Under-labeling is the expensive one: a
 * generated file slips through as hand-written, the agent edits it,
 * and the edit is overwritten on the next build.
 */

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
 * Pure per-file detector: given a file path and its source text,
 * returns true when any of the path- or content-based signals fires.
 * O(file size) — one regex pass on the source when the file is
 * `.css`, plus a few O(1) path probes.
 *
 * The sibling-sourcemap signal is NOT checked here because it
 * depends on the full scanned set — use `collectBuildArtifacts` for
 * that branch. Path-based signals are intentionally extension-
 * agnostic: a file under `/dist/assets/` is a build artifact
 * regardless of whether it ends in `.css` or `.html`. The Tailwind
 * escape-selector probe is gated to `.css` / `.scss` (JSX sources
 * can contain those patterns as string literals, which are not
 * compiled CSS).
 */
export function isBuildArtifact(filePath: string, source: string): boolean {
  if (matchesBuildDirMarker(filePath)) return true;
  if (matchesMinInfix(filePath)) return true;
  if (matchesHashedFilename(filePath)) return true;
  if (!isCssPath(filePath)) return false;
  if (TAILWIND_ESCAPED_SELECTOR.test(source)) return true;
  return false;
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
 * Batch helper: classify each `(filePath, source)` pair and return
 * the subset that are build artifacts. Caller-side iteration is
 * folded in so `tool-scan-project.ts` can call once. Sort order
 * matches the input order — callers wanting deterministic output
 * sort upstream.
 *
 * Additionally handles the sibling-sourcemap signal: if the scanned
 * set contains `app.js.map`, the paired `app.js` is labeled even when
 * neither of the per-file signals would have matched. The `.map`
 * file itself is excluded from the returned set — agents don't
 * author sourcemaps in-place and don't need a manual-review prompt
 * about one. The match is by full path minus the trailing `.map`, so
 * a `.map` in one directory never pairs with a source in another.
 */
export function collectBuildArtifacts(
  files: readonly { readonly filePath: string; readonly source: string }[],
): readonly string[] {
  const pathsInSet = new Set<string>();
  for (const file of files) {
    pathsInSet.add(file.filePath.replace(/\\/g, "/"));
  }
  const out: string[] = [];
  for (const file of files) {
    if (isBuildArtifact(file.filePath, file.source)) {
      out.push(file.filePath);
      continue;
    }
    if (hasSiblingSourcemap(file.filePath, pathsInSet)) {
      out.push(file.filePath);
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
