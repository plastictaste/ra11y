/**
 * Frontmatter-fence detection for HTML-family inputs.
 *
 * Extracted from `analysis-coverage.ts` so the parent module stays
 * under the `scripts/check-limits.ts` 500-effective-line cap as
 * markdown / template-substrate signals continue to accrete. The
 * predicate is structural — `^---\n…\n---\n` at file start — and
 * unrelated to the rest of `analysis-coverage.ts`'s opaque-component
 * / parse-error / hint logic, so a separate module clarifies ownership
 * without changing wire shape.
 *
 * The detector is consumed by:
 *   - `analysis-coverage.ts` to flip
 *     `accumulator.hasFrontmatterFence` on every parsed HTML-family
 *     file whose source opens with the fence; the resulting boolean
 *     reaches the wire as `meta.analysisCoverage.hasFrontmatterFence`
 *     and OR's into the `template_files_parsed_as_literal` warning.
 *   - any future surface that needs to know the file sits on a
 *     Jekyll / Hugo / Eleventy / Astro post header.
 */

/**
 * Matches a YAML frontmatter fence at the very start of a file:
 * `---\n` opener, any content (including empty), a closing `---` on
 * its own line, and optionally a trailing newline. Supports CRLF as
 * well as LF line endings so Windows-authored static sites classify
 * the same way as Unix-authored ones. The regex is anchored at
 * offset 0 (`^`) so a stray `---` horizontal rule partway through a
 * document does NOT trip the detector — only the top-of-file fence
 * that Jekyll / Hugo / Eleventy / Astro use as their post header.
 *
 * Not keyed by extension because the same substrate shape appears in
 * `.md`, `.markdown`, `.html`, and `.htm` across ecosystems (Jekyll
 * `test/source/properties.html` is the canonical repro). Files whose
 * content happens to start with three dashes followed by a newline
 * but no closing fence are NOT matched — the closing fence is what
 * distinguishes structured frontmatter from a document that opens
 * with a horizontal rule.
 */
const FRONTMATTER_FENCE_RE = /^---\r?\n[\s\S]*?\r?\n---\r?(?:\n|$)/;

/**
 * True when `source` opens with a YAML frontmatter fence (Jekyll /
 * Hugo / Eleventy / Astro post header). The opening `---` line, the
 * closing `---` line, and a trailing newline (or end of file) are all
 * required — files that merely begin with three dashes followed by a
 * newline but no closing fence return false.
 *
 * @param source - Raw file source text.
 * @returns `true` when the top-of-file frontmatter fence is present.
 */
export function hasFrontmatterFence(source: string): boolean {
  return FRONTMATTER_FENCE_RE.test(source);
}
