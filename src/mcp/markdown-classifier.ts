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

import {
  type FragmentClassificationSignals,
  type FragmentRoleSignals,
  looksLikeHtmlIncludePartialPath,
} from "../engine/layout-partial.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { FragmentFileEntry } from "./analysis-coverage-types.ts";

/**
 * Static-site-generator config filenames the scanner recognizes as
 * positive evidence of an SSG-managed layout system in the scanned
 * tree. When ANY scanned file's basename matches an entry here, every
 * `.md` / `.markdown` fragment in the same scan is promoted from
 * `markdown_unclassified` to `markdown_residue` because the SSG is
 * the parent layout the scanner can't see in one pass.
 *
 * Restricted to filenames whose extension is in
 * {@link import("../utils/path.ts").PARSEABLE_EXTENSIONS} so they
 * actually appear in the scanner's `files` collection — Jekyll's
 * `_config.yml` is intentionally absent because `.yml` is not parsed
 * (the scanner cannot deterministically observe it; surfacing such a
 * file as evidence would be heuristic-mislabel risk per AI-first
 * doctrine "Heuristic-mislabeled meta sub-fields are dishonest"). The
 * list grows additively when a new SSG ships a config in a parseable
 * extension; entries are sorted lexically so the wire-side evidence
 * tokens stay deterministic across runs.
 */
const SSG_CONFIG_FILENAMES: ReadonlySet<string> = new Set([
  ".eleventy.js",
  ".eleventy.ts",
  "astro.config.js",
  "astro.config.ts",
  "docusaurus.config.js",
  "docusaurus.config.ts",
  "eleventy.config.js",
  "eleventy.config.ts",
  "gatsby-config.js",
  "gatsby-config.ts",
  "gridsome.config.js",
  "next.config.js",
  "next.config.ts",
  "nuxt.config.js",
  "nuxt.config.ts",
  "remix.config.js",
  "svelte.config.js",
  "vuepress.config.js",
  "vuepress.config.ts",
]);

/**
 * Aggregated layout-composition evidence observed across the entire
 * scanned `files` collection. Threaded into
 * {@link classifyFragmentKind} so a `.md` / `.markdown` fragment can
 * be promoted to `markdown_residue` (with `ssgEvidence` populated)
 * only when at least one positive signal exists somewhere in the
 * scan — never on the negative-default of all three structural
 * signals being absent (per AI-first consumer doctrine
 * "Heuristic-mislabeled meta sub-fields are dishonest").
 */
export interface LayoutCompositionEvidence {
  /**
   * Base filenames of recognized SSG configs observed in the scanned
   * `files` collection (`gatsby-config.js`, `astro.config.ts`, etc.).
   * Sorted ascending for deterministic wire output. Empty when no
   * SSG config was observed.
   */
  readonly ssgConfigFilenames: readonly string[];
  /**
   * True when at least one non-markdown file in the scan was
   * observed with `hasLayoutDirective: true` — a sibling layout
   * directive ({@link import("../engine/layout-partial.ts").classifyFragment}'s
   * `hasLayoutDirective` predicate) is in-scope evidence that an SSG
   * layout system is being exercised even when no recognized config
   * filename was detected.
   */
  readonly hasSiblingLayoutDirective: boolean;
  /**
   * True when at least one non-markdown file in the scan lives in a
   * layouts directory ({@link import("../engine/layout-partial.ts").classifyFragment}'s
   * `inLayoutsDir` predicate). Same role as
   * `hasSiblingLayoutDirective`: in-scope evidence of a layout
   * system the scanner can't traverse to.
   */
  readonly hasSiblingInLayoutsDir: boolean;
}

/**
 * True when `filePath`'s basename is in
 * {@link SSG_CONFIG_FILENAMES}. Pure path inspection — no source
 * read — so cheap to call during the file walk.
 */
export function isSsgConfigFile(filePath: string): boolean {
  return SSG_CONFIG_FILENAMES.has(basename(filePath));
}

function basename(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

/**
 * Mutable per-scan accumulator collecting layout-composition
 * evidence from the file walk. Owned by `analysis-coverage.ts` for
 * the duration of one `buildAnalysisCoverage` call; consumed via
 * `freeze()` to produce the immutable {@link LayoutCompositionEvidence}
 * threaded into {@link classifyFragmentKind}. Encapsulated here so
 * both the SSG-config detection AND the sibling-signal predicates
 * stay co-located with the classifier they feed — extracting the
 * evidence shape from the parent module keeps `analysis-coverage.ts`
 * under the limits cap.
 */
export class LayoutEvidenceAccumulator {
  readonly #ssgConfigFilenames: Set<string> = new Set();
  #hasSiblingLayoutDirective = false;
  #hasSiblingInLayoutsDir = false;

  /**
   * Record any in-scope evidence the file contributes. The walker
   * calls this once per scanned file. Markdown files are filtered
   * upstream at the sibling-signal call site so they don't
   * contribute to their own promotion evidence (the evidence
   * predicate is "some OTHER scanned file declares a layout system
   * this `.md` could be composed by").
   */
  recordSsgConfigCandidate(filePath: string): void {
    if (isSsgConfigFile(filePath)) this.#ssgConfigFilenames.add(basename(filePath));
  }

  /**
   * Aggregate the structural signals from one fragment-classified
   * file. Markdown files are filtered out — they don't contribute to
   * their own promotion (a `.md` with positive signals never reaches
   * `fragmentFiles` anyway; this guard preserves "evidence comes
   * from elsewhere" semantics on single-file callers).
   */
  recordSiblingSignals(filePath: string, signals: FragmentClassificationSignals): void {
    if (isMarkdownFile(filePath)) return;
    if (signals.hasLayoutDirective) this.#hasSiblingLayoutDirective = true;
    if (signals.inLayoutsDir) this.#hasSiblingInLayoutsDir = true;
  }

  /** Snapshot the accumulator into the immutable wire shape. */
  freeze(): LayoutCompositionEvidence {
    return {
      ssgConfigFilenames: [...this.#ssgConfigFilenames].sort(),
      hasSiblingLayoutDirective: this.#hasSiblingLayoutDirective,
      hasSiblingInLayoutsDir: this.#hasSiblingInLayoutsDir,
    };
  }
}

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
 * Token for `.md` / `.markdown` / `.mkdn` files routed through the
 * HTML parser. Distinct from the bare `"html"` AST-language tag: the
 * source is Markdown processed for HTML residue per ADR 0025, not
 * native HTML. Surfaced on `parseModeByExtension` so an agent reading
 * the field can tell native HTML routing apart from the markdown-
 * residue downgrade (the bare `"html"` value would silently conflate
 * the two, mis-cuing the agent into expecting heading-hierarchy /
 * link-purpose coverage that the residue projection intentionally
 * omits).
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
 * True when `filePath` is an HTML / HTML-routed extension whose role
 * signals are meaningful for the `composition_shell` / `leaf_partial`
 * discriminator. Markdown (`.md` / `.markdown`) and SVG (`.svg` /
 * `.svgz`) discriminate by extension at `classifyFragmentKind` so the
 * AST role walk would be wasted work — and surfacing role signals on
 * those entries would mislead an agent into reading them as load-
 * bearing for the discriminator. Mirrors the extension-driven branch
 * arms in {@link classifyFragmentKind}.
 */
export function isFragmentRoleEligibleExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return false;
  if (lower.endsWith(".svg") || lower.endsWith(".svgz")) return false;
  return true;
}

/**
 * Categorizes a fragment file. The discriminator is provable from the
 * file extension AND deterministic in-scope layout-composition
 * evidence — per AI-first consumer doctrine "Heuristic-mislabeled
 * meta sub-fields are dishonest," the kind cannot be a guess on path
 * patterns or contents.
 *
 *   - `.svg` / `.svgz` → `"svg_standalone"`. Routed through
 *     `parseHtml` by `src/input/parsers/svg.ts` and naturally lacks
 *     `<html>` / `<body>`.
 *   - `.md` / `.markdown` with positive layout evidence in scope
 *     (`evidence.ssgConfigFilenames` non-empty,
 *     `hasSiblingLayoutDirective`, or `hasSiblingInLayoutsDir`) →
 *     `"markdown_residue"`. The markdown body is composed by an SSG-
 *     supplied parent layout the static scanner can't see in one
 *     pass — the missing `<html>` envelope reflects that composition
 *     model, not an authored partial.
 *   - `.md` / `.markdown` with NO positive layout evidence in scope
 *     → `"markdown_unclassified"`. The honest discriminator when the
 *     scanner can't tell whether the file is README-style standalone
 *     prose or a content page composed by an unseen SSG layout.
 *   - HTML file at a recognized SSG include / partial path
 *     (`_includes/<name>.html`, `partials/<name>.html`,
 *     `_partials/<name>.html`, `templates/_<name>.html`) AND with
 *     fragment-shape evidence (the caller already established the
 *     file IS a fragment via {@link import("../engine/layout-partial.ts").classifyFragment},
 *     i.e. `signals.hasHtmlOpener: false`) → `"layout_include_partial"`.
 *     Two-signal AND keeps the promotion honest: path-pattern alone
 *     could false-positive on a renderable page that happens to live
 *     under one of the listed dirs, and fragment-shape alone could
 *     false-positive on a top-level snippet fixture. Per AI-first
 *     consumer doctrine "Routing skips that drop content are the
 *     symmetric twin of suppression," files that earn this kind also
 *     bypass the `parseErrorFiles[]` bucket — surfacing both
 *     classifications on the same file would mislead the agent.
 *   - everything else (`.html`, `.htm`, `.xhtml`, `.astro`, etc.) →
 *     `"html_partial"`. The catch-all bucket: the file parses as HTML
 *     but lacks the document envelope, indicating a partial / include
 *     intended for composition into a parent layout (under a non-
 *     conventional dir, a snippet fixture, or a README-embedded
 *     island).
 *
 * Returns the discriminating kind plus the deterministic evidence
 * tokens that supported a `markdown_residue` promotion (`ssgEvidence`
 * is empty for every other kind, and absent on
 * `markdown_unclassified` because the kind itself signals "no
 * evidence").
 */
export function classifyFragmentKind(
  filePath: string,
  evidence?: LayoutCompositionEvidence,
  signals?: FragmentClassificationSignals,
  roleSignals?: FragmentRoleSignals,
): { kind: FragmentFileEntry["kind"]; ssgEvidence?: readonly string[] } {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".svg") || lower.endsWith(".svgz")) return { kind: "svg_standalone" };
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    const ssgEvidence = collectSsgEvidenceTokens(evidence);
    if (ssgEvidence.length > 0) return { kind: "markdown_residue", ssgEvidence };
    return { kind: "markdown_unclassified" };
  }
  // Composition-shell / leaf-partial promotions: AST-evidence-driven
  // discriminators that further specify HTML fragments where the
  // scanner has structural evidence about the partial's role in the
  // assembled document. Both run BEFORE `layout_include_partial` so a
  // fragment that's BOTH an SSG include AND has unambiguous role
  // evidence earns the role-specific kind (the AST evidence is more
  // specific about what document-shape rules should do — a Jekyll
  // `_includes/header.html` containing a top-level `<header>` is
  // composition-shell first, include-partial second; the AI-first
  // doctrine "Heuristic-mislabeled meta sub-fields are dishonest"
  // requires the discriminator name the most specific evidence the
  // scanner has).
  //
  // composition_shell: top-level landmark element present in the AST.
  // The path-token evidence (`pathSuggestsCompositionShell`) is
  // surfaced as additive context but NEVER the load-bearing
  // predicate — a fragment named `header.html` with no `<header>` in
  // the AST does not earn the kind, because the path-pattern alone
  // is heuristic.
  //
  // leaf_partial: zero landmark elements anywhere in the AST AND
  // every element is an inline tag from the curated set. The
  // path-token evidence (`pathSuggestsLeafPartial`) is similarly
  // additive context only.
  if (roleSignals !== undefined) {
    if (roleSignals.topLevelLandmarkTags.length > 0) {
      return { kind: "composition_shell" };
    }
    if (roleSignals.hasOnlyInlineContent) {
      return { kind: "leaf_partial" };
    }
  }
  // Two-signal AND for the layout_include_partial promotion: the file
  // path matches an SSG include / partial convention AND the caller
  // (`buildFragmentFileEntry`) is already inside the fragment branch,
  // which means `classifyFragment` stamped `hasHtmlOpener: false`. The
  // explicit `signals.hasHtmlOpener === false` check guards callers
  // that pass `signals: undefined` (defensive — the only in-tree
  // caller threads the real signals).
  if (
    signals !== undefined &&
    !signals.hasHtmlOpener &&
    looksLikeHtmlIncludePartialPath(filePath)
  ) {
    return { kind: "layout_include_partial" };
  }
  return { kind: "html_partial" };
}

/**
 * Convenience wrapper assembling a complete {@link FragmentFileEntry}
 * from a path + classification signals + per-scan evidence. Single
 * call site (`assembleFragmentFilesBlock` in `analysis-coverage.ts`)
 * but extracted here so the conditional-spread on the optional
 * `ssgEvidence` field stays co-located with its producer (the
 * "present-when-meaningful" rule for optional fields per AI-first
 * consumer doctrine).
 */
export function buildFragmentFileEntry(
  path: string,
  fragmentClassificationSignals: FragmentClassificationSignals,
  evidence: LayoutCompositionEvidence,
  roleSignals?: FragmentRoleSignals,
): FragmentFileEntry {
  const classification = classifyFragmentKind(
    path,
    evidence,
    fragmentClassificationSignals,
    roleSignals,
  );
  // `fragmentRoleSignals` is present-when-meaningful per AI-first
  // consumer doctrine: surface only on HTML-fragment kinds where role
  // detection actually ran. Markdown / SVG entries discard the role
  // evidence because the discriminator is extension-driven and the
  // AST evidence isn't part of the predicate.
  const isHtmlFragmentKind =
    classification.kind === "html_partial" ||
    classification.kind === "composition_shell" ||
    classification.kind === "leaf_partial" ||
    classification.kind === "layout_include_partial";
  return {
    path,
    kind: classification.kind,
    fragmentClassificationSignals,
    ...(roleSignals !== undefined && isHtmlFragmentKind
      ? { fragmentRoleSignals: roleSignals }
      : {}),
    ...(classification.ssgEvidence === undefined
      ? {}
      : { ssgEvidence: classification.ssgEvidence }),
  };
}

/**
 * Builds the `ssgEvidence` token list from aggregated
 * {@link LayoutCompositionEvidence}. Tokens are deterministic and
 * sorted so the wire output is stable across runs:
 *
 *   - `ssg_config:<basename>` for each recognized SSG config observed
 *     in the scanned `files` collection (one entry per filename, e.g.
 *     `ssg_config:gatsby-config.js`).
 *   - `sibling_layout_directive` when at least one non-markdown file
 *     in the scan carried `hasLayoutDirective: true` per the shared
 *     `classifyFragment` predicate.
 *   - `sibling_in_layouts_dir` when at least one non-markdown file
 *     lives under a recognized layouts directory segment.
 *
 * Returns the empty array when no evidence is supplied or when every
 * field on the evidence is empty / false.
 */
function collectSsgEvidenceTokens(evidence?: LayoutCompositionEvidence): string[] {
  if (evidence === undefined) return [];
  const tokens: string[] = [];
  for (const filename of evidence.ssgConfigFilenames) tokens.push(`ssg_config:${filename}`);
  if (evidence.hasSiblingLayoutDirective) tokens.push("sibling_layout_directive");
  if (evidence.hasSiblingInLayoutsDir) tokens.push("sibling_in_layouts_dir");
  return tokens.sort();
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
 *   - `"markdown-html-residue"` — Markdown source (`.md`/`.markdown`/`.mkdn`)
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
    // `.md` / `.markdown` / `.mkdn` route through the HTML parser per
    // ADR 0025 Option B but the source is not HTML — emit a distinct
    // token so the disclosure label honestly distinguishes Markdown-
    // residue from native HTML routing instead of relying on the
    // bare AST language tag. `.mkdn` is a common alternate Markdown
    // extension (Vim, older static-site generators); the parser
    // dispatch in `src/mcp/session.ts` already routes it through
    // `parseMarkdown`, so the disclosure label must mirror.
    if (lang === "html" && (ext === ".md" || ext === ".markdown" || ext === ".mkdn")) {
      seen.set(ext, MARKDOWN_HTML_RESIDUE_MODE);
      continue;
    }
    seen.set(ext, lang);
  }
  return Object.fromEntries([...seen.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
