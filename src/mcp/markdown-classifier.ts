/**
 * Markdown / fragment-kind classification helpers used by
 * `analysis-coverage.ts` to decide:
 *
 *   - whether a file is Markdown source (extension only);
 *   - whether a fragment file is `markdown_residue` / `svg_standalone`
 *     / `html_partial`;
 *   - which AST-language label each scanned extension routed through
 *     for the `parseModeByExtension` disclosure (including the
 *     `markdown-html-residue` token that distinguishes ADR 0025
 *     Option B routing from native HTML).
 *
 * Extracted from `analysis-coverage.ts` so the parent module stays
 * under the `scripts/check-limits.ts` 500-effective-line cap as
 * markdown / template-substrate signals continue to accrete. Pure
 * refactor — every helper here was previously inline in
 * `analysis-coverage.ts` with byte-identical logic.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { FragmentFileEntry } from "./analysis-coverage-types.ts";

/**
 * Extensions whose AST-language tag differs from the extension name
 * in the cases where the extension is still considered "native" for
 * `parseModeByExtension` purposes. `.htm` source IS HTML; `.jsx`
 * source IS TSX-compatible JSX. Listed here so the
 * `parseModeByExtension` helper can collapse the alias to `"native"`
 * rather than echoing the AST language tag and forcing the agent to
 * recognize the equivalence itself.
 */
const NATIVE_EXT_LANG: Readonly<Record<string, string>> = { htm: "html", jsx: "tsx" };

/**
 * Token for `.md` / `.markdown` files routed through the HTML parser.
 * Distinct from the bare `"html"` AST-language tag: the source is
 * Markdown processed for HTML residue per ADR 0025, not native HTML.
 * Surfaced on `parseModeByExtension` so an agent reading the field
 * can tell native HTML routing apart from the markdown-residue
 * downgrade (the bare `"html"` value would silently conflate the two,
 * mis-cuing the agent into expecting heading-hierarchy / link-purpose
 * coverage that the residue projection intentionally omits).
 */
export const MARKDOWN_HTML_RESIDUE_MODE = "markdown-html-residue";

/**
 * True when `filePath` is a markdown source file (`.md`, `.markdown`,
 * or `.mkdn`). Kept in sync with the PARSEABLE_EXTENSIONS entry and
 * the parser dispatch in `src/mcp/session.ts`.
 */
export function isMarkdownFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mkdn");
}

/**
 * Categorizes a fragment file by extension. The detection is
 * extension-only on purpose — per AI-first consumer doctrine
 * "Heuristic-mislabeled meta sub-fields are dishonest," the
 * discriminator must be provable from the evidence the scanner has
 * (the file path), not a guess on path patterns or contents.
 *
 *   - `.svg` / `.svgz` → `"svg_standalone"`. Routed through
 *     `parseHtml` by `src/input/parsers/svg.ts` and naturally lacks
 *     `<html>` / `<body>`.
 *   - `.md` / `.markdown` → `"markdown_residue"`. Routed through
 *     the HTML parser per ADR 0025; the resulting AST is the literal-
 *     text residue, which never carries a `<html>` envelope.
 *   - everything else (`.html`, `.htm`, `.xhtml`, `.astro`, etc.) →
 *     `"html_partial"`. The catch-all bucket: the file parses as HTML
 *     but lacks the document envelope, indicating a partial / include
 *     intended for composition into a parent layout.
 */
export function classifyFragmentKind(filePath: string): FragmentFileEntry["kind"] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".svg") || lower.endsWith(".svgz")) return "svg_standalone";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown_residue";
  return "html_partial";
}

/**
 * Per-extension disclosure of which parser / AST-language each file
 * routed through. Mirrors `parseForExtension` in `src/mcp/session.ts`
 * and the EXTENSION_ALIASES table in `src/utils/path.ts`. Values are
 * one of:
 *   - `"native"` — extension name equals AST language (no alias to
 *     explain).
 *   - `"css"` / `"html"` / `"tsx"` — alias-routed extension whose
 *     source IS source of that AST language (`.scss → "css"`,
 *     `.less → "css"`, `.mdx → "tsx"`, `.astro → "html"`,
 *     `.erb → "html"`, `.js`/`.ts → "tsx"`).
 *   - `"markdown-html-residue"` — Markdown source (`.md`/`.markdown`)
 *     processed through the HTML parser as an HTML-residue projection
 *     per ADR 0025 Option B. Distinct from a bare `"html"` value
 *     because the source is NOT HTML: ATX/Setext headings, link text,
 *     and prose readability are stripped or out-of-scope; only
 *     embedded HTML (tables, iframes, admonition divs) and image
 *     alt-text reach rules. Agents cross-referencing
 *     `parseErrorFiles[].parser` (which still tags `"html"` for these
 *     files, since the AST language tag tracks the running parser)
 *     should treat `markdown-html-residue` as the disclosure axis
 *     orthogonal to AST language: same parser, narrower evidence.
 *     Native pairs (extension equals AST language): `.css`, `.html`,
 *     `.htm`, `.tsx`, `.jsx`. Values are deterministic tokens chosen
 *     so the agent can dispatch on equality without substring
 *     matching. Derived from the ParsedFile list (no re-dispatch):
 *     every file carries `ast.language` and the extension comes off
 *     the path. `parseForExtension` dispatches purely on suffix, so
 *     two files with the same extension always produce the same
 *     language — safe to stop at the first sighting. Sorted for
 *     deterministic wire output.
 */
export function parseModeByExtension(files: readonly ParsedFile[]): Record<string, string> {
  const seen = new Map<string, string>();
  for (const f of files) {
    const dot = f.filePath.lastIndexOf(".");
    const ext = dot === -1 ? "" : f.filePath.slice(dot).toLowerCase();
    if (ext.length === 0 || seen.has(ext)) continue;
    const lang = f.ast.language;
    const isNative = ext.slice(1) === lang || NATIVE_EXT_LANG[ext.slice(1)] === lang;
    if (isNative) {
      seen.set(ext, "native");
      continue;
    }
    // `.md` / `.markdown` route through the HTML parser per ADR 0025
    // Option B but the source is not HTML — emit a distinct token so
    // the disclosure label honestly distinguishes Markdown-residue
    // from native HTML routing instead of relying on the bare AST
    // language tag.
    if (lang === "html" && (ext === ".md" || ext === ".markdown")) {
      seen.set(ext, MARKDOWN_HTML_RESIDUE_MODE);
      continue;
    }
    seen.set(ext, lang);
  }
  return Object.fromEntries([...seen.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
