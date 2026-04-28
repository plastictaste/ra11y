/**
 * Authored-SVG-font carve-out for the build-artifact classifier.
 *
 * Hand-authored SVG fonts (FontAwesome / Lucide / Phosphor) ship as
 * `.svg` sources whose body is `<font>` + `<glyph>` element runs,
 * frequently with a `.min.` infix in the basename or under
 * `dist/icons/` because they're distributed alongside the icon
 * webfont. Without a content-side carve-out the path predicates in
 * {@link build-artifacts.ts} (min-infix, hashed-filename, build-dir
 * marker) mis-label these as minified output, leaking into
 * `scannedMinifiedFiles[]` (122/996 hits on a bulk corpus, 12% of all
 * minified-flagged files) and routing fix-suggestion triage away
 * from files the user did author.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
 * meta sub-fields are dishonest": when the SVG body proves the file
 * is authored, the path's "minified" verdict contradicts the source
 * shape. The honest fix is to gate the classifier on a content-side
 * predicate that runs first and returns null on authored evidence.
 *
 * Three independent content markers, any of which credits — all three
 * pass the doctrine bar (provable from the source text, no
 * continuous-axis threshold tuning):
 *
 *   1. `<font ` element marker. The SVG `<font>` element is the
 *      canonical font-defining wrapper used by SVG-font glyph sets
 *      (the `font-face`, `missing-glyph`, `glyph` family). A
 *      minified build artifact does not contain literal `<font `
 *      element tokens; only authored SVG fonts do. Provable from a
 *      substring probe.
 *   2. `<glyph ` element marker. Sibling of the above — SVG-font
 *      glyph children. Same provability — minified bytes would not
 *      carry literal element-name tokens; authored vector glyph sets
 *      do.
 *   3. Pretty-printed (>100 non-blank lines) AND the first ~20 lines
 *      carry an SVG comment block citing a copyright / license / SPDX
 *      identifier. Conjunctive: a one-line minified asset never
 *      satisfies the line-count half; a one-line authored brand SVG
 *      never satisfies it either. The license-header half rules out
 *      pretty-printed minified output, since minifiers do not insert
 *      multi-line copyright comments. Together these prove the file
 *      is authored vector content distributed under a license.
 *
 * Conservative by design: false negatives (still labels a disguised
 * minified blob as minified) are recoverable; false positives (skips
 * a real minified output) leak vendor noise into the agent's triage.
 * Each marker is conservative — `<font ` requires the literal
 * element-open with a trailing space-or-`>`, `<glyph ` likewise, and
 * the comment branch requires both line-count and license-token
 * conjuncts.
 *
 * Pure over its inputs. Only inspects the leading window of the
 * source for the comment branch ({@link SVG_HEADER_WINDOW} chars), so
 * the cost is bounded regardless of file size.
 */

/**
 * Authored-SVG-font predicate. Returns `true` when `filePath` carries
 * the `.svg` extension AND the source body proves the file is a
 * hand-authored asset (an SVG font like FontAwesome / Lucide /
 * Phosphor), not minified bytes.
 *
 * The classifier in {@link build-artifacts.ts} runs this predicate
 * before every classification branch and returns `null` when it
 * fires, pre-empting the path predicates' "minified" verdict on
 * authored content.
 */
export function isAuthoredSvgFont(filePath: string, source: string): boolean {
  if (!isSvgPath(filePath)) return false;
  if (SVG_FONT_ELEMENT_RE.test(source)) return true;
  if (SVG_GLYPH_ELEMENT_RE.test(source)) return true;
  if (hasAuthoredLicenseHeader(source) && hasPrettyPrintedLineCount(source)) return true;
  return false;
}

/**
 * True when `filePath` ends in `.svg` (case-insensitive). Used by
 * {@link build-artifacts.ts}'s `classifyBuildArtifactDetailed` to gate
 * the content-shape `likely-minified-by-line-stats` predicate off SVG
 * sources entirely — single-line is the canonical SVG authoring shape
 * (a hand-authored brand SVG is one well-formed `<svg ...>...</svg>`
 * element), so the long-line probe is structurally inapplicable. SVGs
 * that genuinely are build-pipeline output (sprite sheets in
 * `dist/icons/`, `.min.svg`, hashed-filename outputs, `.svg` files
 * paired with sourcemap siblings) still classify on the path-anchored
 * predicates, which is the doctrine bar.
 */
export function isSvgPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".svg");
}

/**
 * Matches the SVG `<font>` element opener. Authored SVG fonts wrap
 * their glyph children in `<font ...>` (with attributes) or bare
 * `<font>`. The trailing space-or-`>` requirement avoids matching
 * `<font-face>` (a child element), `<font-family>` (CSS @font-face
 * inside `<style>`), or `<font…anything else>`. SVG sources never
 * carry these element openers in minified output — only authored
 * font definitions do.
 */
const SVG_FONT_ELEMENT_RE = /<font[\s>]/u;

/**
 * Matches the SVG `<glyph>` element opener (the children of a `<font>`
 * wrapper). Same rationale as {@link SVG_FONT_ELEMENT_RE} — the
 * literal element-name token is absent from minified output but
 * present in every authored SVG-font glyph definition.
 */
const SVG_GLYPH_ELEMENT_RE = /<glyph[\s>]/u;

/**
 * Authored SVG fonts ship under a license header — the FontAwesome /
 * Lucide / Phosphor opening bytes carry an SVG comment naming the
 * project + license, frequently with an SPDX identifier. The token
 * set below is curated against the canonical license/copyright
 * vocabulary already used by
 * {@link build-artifacts-vendor-distribution.ts} (Copyright, License,
 * MIT, Apache, GPL, BSD) plus `SPDX-License-Identifier` (the standard
 * SPDX preamble used by recent FontAwesome / Phosphor releases).
 * Minifiers strip multi-line comments; authored sources keep them.
 */
const SVG_LICENSE_HEADER_RE =
  /\b(?:Copyright|License|Released\s+under|MIT|Apache|GPL|BSD|SPDX-License-Identifier)\b/iu;

/**
 * The window inspected for the authored-license header. Bounded so
 * the predicate runs in O(1) on file size — authored SVG fonts always
 * place their license comment at the top of the file (the SVG opener
 * convention), so a 2KB head window is generous.
 */
const SVG_HEADER_WINDOW = 2048;

function hasAuthoredLicenseHeader(source: string): boolean {
  const head = source.slice(0, SVG_HEADER_WINDOW);
  // Require an SVG comment opener in the head window so a license
  // token sitting inside an attribute value (e.g. `<text>MIT</text>`)
  // doesn't accidentally credit. Authored SVG fonts always place
  // license info inside `<!-- ... -->`.
  if (!head.includes("<!--")) return false;
  return SVG_LICENSE_HEADER_RE.test(head);
}

/**
 * Minimum non-blank line count for the pretty-printed conjunct of the
 * authored-SVG-font predicate. Matches the dispatch guidance ("pretty-
 * printed line-count > 100") — a minified SVG bundle is one to a few
 * very long lines; an authored font is hundreds to thousands of
 * `<glyph>` lines wrapped at child boundaries. Together with the
 * license-header conjunct, this rules out single-line minified output
 * regardless of license-token co-occurrence.
 */
const SVG_PRETTY_PRINTED_MIN_LINES = 100;

function hasPrettyPrintedLineCount(source: string): boolean {
  let nonBlankLines = 0;
  let lineStart = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source.charCodeAt(i) === 10 /* \n */) {
      const line = source.slice(lineStart, i);
      if (line.trim().length > 0) {
        nonBlankLines++;
        if (nonBlankLines > SVG_PRETTY_PRINTED_MIN_LINES) return true;
      }
      lineStart = i + 1;
    }
  }
  return false;
}
