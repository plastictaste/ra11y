/**
 * Astro-island substrate detector co-located with the analysis-
 * coverage accumulator. Mirrors the sibling `analysis-coverage-erb.ts`
 * and `analysis-coverage-fragments.ts` extraction pattern so the parent
 * `analysis-coverage.ts` module stays under the {@link MAX_FILE_LINES}
 * budget as new template-substrate detectors accrete (PHP / ERB /
 * Astro / Liquid / etc.). The helper exposes a narrow structural-typed
 * write surface so the sub-module doesn't import the parent's full
 * `CoverageAccumulator` interface and create a back-edge cycle.
 *
 * The warning surface (`astro_islands_unrendered` in `./warnings.ts`)
 * is the AI-first scan-confidence telemetry an agent reads to decide
 * whether to spot-check the cited files for Astro-rendered output the
 * static scan can't see. An `.astro` file is two regions: an optional
 * component-script frontmatter fence (`---\n…\n---\n`) and an HTML
 * template that may interleave capitalized component tags
 * (`<Layout>`, `<Header>`, `<Icon>`) and JSX-style `{expr}` braces.
 * The {@link parseAstro} adapter blanks the frontmatter (so line
 * numbers stay aligned) and hands the residual template to
 * {@link parseHtml}; the HTML parser tolerates capitalized tags as
 * arbitrary elements but cannot resolve imported components or
 * evaluate expressions. Any aria/role/label attribute a component
 * would have rendered, or any visible text an expression would have
 * produced, is invisible to the static scan.
 *
 * Per AI-first doctrine "Routing skips that drop content are the
 * symmetric twin of suppression" the routing-decision is surfaced
 * honestly so the agent can route around it (read the cited files,
 * narrow `additionalPaths`, or dismiss with a source-level disable
 * pragma).
 */

import type { ParsedFile } from "../engine/scanner.ts";

/**
 * Matches the Astro component-script frontmatter fence opener at byte
 * 0: exactly three dashes followed by a newline (CR optional). A
 * `----` or longer is not a fence. Mirrors the predicate in
 * {@link import("../input/parsers/astro.ts").parseAstro}'s
 * `hasOpeningFence` helper so the detector and the parser agree on
 * what "Astro frontmatter" means.
 */
const ASTRO_FRONTMATTER_OPENER_RE = /^---(?:\r?\n)/;

/**
 * Matches a JSX-style `{expr}` expression brace anywhere in the
 * source. The Astro template region uses these for inline expressions
 * (`<h1>{title}</h1>`, `<a href={url}>`); the HTML parser passes
 * them through as literal characters because zero-dep evaluation is
 * out of reach. The detector reads the original source so braces
 * inside attribute values and text flow both contribute. Conservative
 * by design: a literal `{` that opens a CSS block inside an
 * `<style>` would also match, but Astro authors rarely embed a
 * standalone `<style>` slab without component context, so the false-
 * positive rate is acceptable for a scan-confidence label whose
 * payload reads "components/expressions not rendered."
 */
const ASTRO_EXPRESSION_BRACE_RE = /\{[^{}]/;

/**
 * Matches a capitalized HTML-style component tag opener
 * (`<Layout>`, `<Header>`, `<Icon prop=…>`). Astro authors compose
 * pages from imported components whose tags the HTML parser
 * tolerates as arbitrary elements but whose rendered output (slot
 * content, framework-injected aria) is invisible to the static
 * scan. Strict on the leading uppercase letter so lowercase
 * native elements (`<div>`, `<h1>`, `<button>`) don't trip the
 * predicate.
 */
const ASTRO_COMPONENT_TAG_RE = /<[A-Z][A-Za-z0-9]*(?:[\s/>]|$)/;

/**
 * Narrow structural view of the `CoverageAccumulator` fields the
 * detector writes. Declared locally so the sub-module doesn't reach
 * into the parent's full interface — TypeScript's structural typing
 * accepts a `CoverageAccumulator` value at the call site without a
 * cast.
 */
interface AstroAccumulatorWriter {
  astroIslandsUnrendered: boolean;
  readonly astroIslandsUnrenderedFiles: string[];
}

/**
 * True when the file is a `.astro` Astro component / page input
 * routed through {@link parseAstro} per the `.astro → .html` alias
 * in `EXTENSION_ALIASES` (`src/utils/path.ts`). Single-extension
 * test — Astro's own filename convention is bare `.astro`, no
 * compound forms like `.astro.html` exist in the wild.
 */
function isAstroFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".astro");
}

/**
 * Records a `.astro` file whose source carries Astro-specific
 * evidence — a frontmatter fence (`---\n…`), a JSX-style expression
 * brace (`{expr}`), or a capitalized component tag opener
 * (`<Layout>`) — onto the accumulator's `astroIslandsUnrendered`
 * boolean + per-file evidence list. Three-component OR predicate
 * (any one signal is enough) because each independently identifies
 * content the static scan cannot see at render time:
 *
 *   - Frontmatter fence: blanked by {@link parseAstro} so any
 *     server-side data (`const heading = await fetch(...)`) is
 *     invisible to the template region's static analysis.
 *   - Expression brace: passed through as literal text so any
 *     visible content / aria attribute the expression renders is
 *     missed.
 *   - Component tag: kept as opaque element so any slot content,
 *     rendered output, or framework-injected aria is invisible.
 *
 * No HTML-envelope second check (unlike `php_islands_stripped`'s
 * two-component predicate) — every `.astro` is by construction
 * routed through {@link parseAstro} which delegates to the HTML
 * parser, so there is no "backend-only" Astro analogue to a
 * backend-only PHP processor. The signal the downstream warning
 * carries is "the Astro adapter blanked the frontmatter and the
 * HTML parser left components/expressions unrendered; any visible
 * text / aria attribute those would have produced at render time
 * is invisible to the static scan."
 *
 * Defensive on bare `.astro` files that contain only static HTML
 * with no Astro-specific syntax: the predicate stays off so the
 * warning fires only when actual unrendered content is present.
 * In practice the false-negative rate is negligible — pure static
 * HTML in a `.astro` file would more conventionally live in
 * `.html`, and the detector's purpose is to flag the routing-
 * decision risk where it matters.
 */
export function recordAstroIslandStripped(file: ParsedFile, acc: AstroAccumulatorWriter): void {
  if (!isAstroFile(file.filePath)) return;
  if (!hasAstroEvidence(file.source)) return;
  acc.astroIslandsUnrendered = true;
  acc.astroIslandsUnrenderedFiles.push(file.filePath);
}

/**
 * True when the source carries any of the three Astro-specific
 * evidence signals: frontmatter fence opener, JSX-style expression
 * brace, or capitalized component tag opener. Pulled out of
 * {@link recordAstroIslandStripped} so the predicate is independently
 * testable and the call-site reads as a guard expression. The OR
 * ordering favors the cheapest test first (anchored prefix regex
 * over global scans) so the common no-evidence case short-circuits
 * fastest.
 */
function hasAstroEvidence(source: string): boolean {
  if (ASTRO_FRONTMATTER_OPENER_RE.test(source)) return true;
  if (ASTRO_COMPONENT_TAG_RE.test(source)) return true;
  if (ASTRO_EXPRESSION_BRACE_RE.test(source)) return true;
  return false;
}
