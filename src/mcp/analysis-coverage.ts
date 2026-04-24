/**
 * Honest telemetry about what static analysis couldn't reach. Not a
 * heuristic — each field counts or names a structural gap directly:
 *
 *   - `opaqueCustomComponents`: distinct PascalCase JSX tags we saw but
 *     don't look inside. Rules that need to verify an underlying
 *     element (e.g. "does this button have an accessible name?") can't
 *     see through custom components except via `nativeWrappers`.
 *   - `templateDirectivesFound`: template-engine syntax (Jinja, Liquid,
 *     Handlebars) we detected in scanned HTML. Cross-template `extends`
 *     / `include` relationships are not resolved — a fragment with
 *     "view above" may render inside a parent that changes the meaning.
 *   - `templateDirectiveHandling`: plain-English summary of *what* the
 *     scanner does with those directives, so agents don't have to guess
 *     whether a Jinja-laced file was partially analyzed or skipped.
 *   - `parseErrorFileCount`: files where the parser emitted errors AND
 *     the downstream rules produced zero findings on that file — the
 *     scanner effectively couldn't see the file. Agents should treat
 *     paths in this bucket as invisible: any a11y violation in them
 *     went unreported.
 *   - `partialParseFileCount`: files where the parser emitted errors
 *     but the recovered partial AST was enough for at least one rule
 *     to fire. Findings on these files are present in the response and
 *     carry live line numbers — they are NOT invisible — but below the
 *     parse-error point the AST is degraded and additional violations
 *     may have been missed. The split exists because a combined bucket
 *     (the historical `parseErrorFiles`) conflated "file invisible" with
 *     "file partially reported," and agents reading the combined shape
 *     would miss findings that did emerge on the listed paths.
 *   - `parseModeByExtension`: per-extension disclosure of which parser
 *     AST the scanner routed files through. Tells the agent why a
 *     `filesByExtension[".scss"] = 584` count participates in every
 *     `.css`-gated rule's `filesEvaluated` without appearing as a
 *     separate `.scss` lane (the SCSS adapter emits a CSS AST). Values
 *     are either `"native"` (extension name equals AST language — no
 *     alias to explain) or the AST-language tag an alias routes
 *     through (`"css"`, `"html"`, `"tsx"`). Present-when-meaningful.
 *   - `hints`: actionable suggestions derived from the above counts —
 *     e.g., "add these 8 design-system wrappers to nativeWrappers" when
 *     `opaqueCustomComponents` is high, or "post-compile CSS likely not
 *     in scan path" when CSS coverage is thin vs HTML/JSX. Each hint
 *     is a single sentence an agent can act on in one tool call.
 *
 * `parseErrorFiles` and `partialParseFiles` both ship `{ path, parser,
 * reason }` entries whenever their bucket has entries — the reason +
 * parser pair is the actionable signal an agent needs to investigate
 * ("html parser: Unexpected end of input while parsing tag" is a
 * different fix path than "css parser: Unterminated string literal"),
 * so gating the detail behind `verboseMeta` would leave the top-level
 * `parse_errors_present` / `parseErrorFileCount` signals as a silent-
 * failure shape (CLAUDE.md §1 "Zero-output success is ambiguous
 * failure" — the response-level analogue applies to partial-success
 * signals too). `opaqueCustomComponentNames` and `rulesByExtension`
 * still hide behind `verboseMeta` because they are bounded-but-large
 * inventories whose per-entry value is lower than the top-level count;
 * parse errors are high-signal per-entry and rarely exceed a handful
 * per scan. Fields are omitted when they'd be empty, so clean projects
 * stay terse.
 */

import { isHtmlFragment, walkJsxElements } from "../engine/ast-helpers.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { HtmlDocument } from "../types/ast.ts";
import type { ConfigPreset } from "../types/config.ts";
import type { Rule } from "../types/rule.ts";
import { extensionMatches, isStorybookStoryFile } from "../utils/path.ts";
import { buildCssThinHint, countByCategory } from "./analysis-coverage-hints.ts";
import { isBuildArtifact } from "./build-artifacts.ts";
import type { Hint } from "./hint-codes.ts";
import { capMetaArray, type MetaArrayTruncationSummary } from "./meta-array-cap.ts";
import { extractComponentIdentifier, isJsxBearingFile } from "./opaque-tag-filter.ts";

/**
 * Storybook primitives that should render transparent under
 * `preset: "storybook"`. Rendering them as opaque custom components
 * would inflate the opaque-component count for every story file and
 * bury the real findings on the UNDERLYING component the story wraps.
 * Matched as exact JSX tag names on a per-file basis — only story
 * files (see {@link isStorybookStoryFile}) get the exemption, so an
 * unrelated `<Story />` component in product code stays opaque.
 */
const STORYBOOK_TRANSPARENT_TAGS: ReadonlySet<string> = new Set([
  "Meta",
  "Story",
  "StoryFn",
  "StoryObj",
]);

interface OpaqueComponentUsage {
  callSites: number;
  /**
   * True once ANY call site of this component has an attribute that
   * signals DOM interactivity (onClick, onKeyDown, role, tabIndex,
   * href, to, onSubmit, ...) OR uses `{...spread}` props which static
   * analysis cannot introspect. Wrapper candidates — the components
   * users most want surfaced by `nativeWrappers` onboarding — have
   * this true somewhere. Framework primitives like react-router's
   * `<Route>` stay false and drop out of the top-N ranking.
   */
  interactive: boolean;
}

/**
 * A file whose parser emitted errors. The `reason` is the first parse
 * error's message — surfaced as-is so an agent can branch on the root
 * cause ("Unexpected token `<`" vs "Unterminated string literal") rather
 * than guessing from the file extension. The `parser` names which
 * in-house parser owned the failure (`html`, `css`, `tsx`, `jsx`, `ts`,
 * `js`) — distinguishable from the file extension because e.g. `.mdx`
 * routes through the MDX → TSX bridge and emits `tsx`-class diagnostics.
 * Classification into either `parseErrorFiles` (total-parse-failure,
 * file invisible to rules) or `partialParseFiles` (rules fired on the
 * recovered slice) is decided at emission time by checking whether the
 * file produced any findings.
 */
interface ParseErrorEntry {
  readonly path: string;
  readonly parser: string;
  readonly reason: string;
}

/**
 * Structured coverage block written onto `meta.analysisCoverage`. Every
 * field is optional and present-when-meaningful: a clean scan with no
 * gaps sheds most fields entirely. Declared as a single interface so
 * the outer `buildAnalysisCoverage` container and its sub-assemblers
 * (`assembleOpaqueComponentBlock`, `assembleParseErrorBlocks`,
 * `assembleFragmentFilesBlock`, `populateCoverageTail`) can accept
 * the same shape by reference instead of redeclaring overlapping
 * subsets — keeping the authoritative field set in one place.
 */
interface CoverageBlock {
  opaqueCustomComponents?: number;
  opaqueCustomComponentsTop?: readonly { readonly name: string; readonly callSites: number }[];
  opaqueCustomComponentNames?: readonly string[];
  opaqueCustomComponentsExcludedByAutoDetect?: number;
  templateDirectivesFound?: readonly string[];
  templateDirectiveHandling?: string;
  /**
   * V1-FRONTMATTER-AS-TEMPLATE-DIRECTIVE-TRIGGER: true when at least one
   * parsed HTML-family file (including markdown routed through the HTML
   * parser per ADR 0025) opened with a YAML frontmatter fence
   * (`^---\n…\n---\n`). Tracked alongside `templateDirectivesFound`
   * because the fence itself is a template substrate the HTML parser
   * sees as literal text — a Jekyll / Hugo / Eleventy / Astro post
   * header. The warnings layer ORs this into the
   * `template_files_parsed_as_literal` gate so files with frontmatter
   * but no `{{ }}` / `{% %}` / `<% %>` tokens still surface the
   * literal-parse signal. Present-when-meaningful: omitted when no
   * scanned file opened with a fence.
   */
  hasFrontmatterFence?: boolean;
  parseErrorFileCount?: number;
  parseErrorFiles?: readonly ParseErrorEntry[];
  parseErrorFilesTruncated?: MetaArrayTruncationSummary;
  partialParseFileCount?: number;
  partialParseFiles?: readonly ParseErrorEntry[];
  partialParseFilesTruncated?: MetaArrayTruncationSummary;
  rulesByExtension?: Readonly<Record<string, readonly string[]>>;
  parseModeByExtension?: Readonly<Record<string, string>>;
  /**
   * Structured hints, keyed by `code` so agents dispatch without
   * substring-matching English prose (V1-HINTS-STRUCTURED-CODE). Each
   * entry carries `{ code, text, detail? }` — `code` is the load-bearing
   * branching field, `text` is the human-readable mirror kept populated
   * for humans reading agent output verbatim, and `detail` is
   * present-when-meaningful per-code structured data. See
   * {@link Hint} and {@link HintCode} in `./hint-codes.ts`.
   */
  hints?: readonly Hint[];
  skippedByExtension?: Readonly<Record<string, number>>;
  fragmentFileCount?: number;
  fragmentFiles?: readonly string[];
  fragmentFilesTruncated?: MetaArrayTruncationSummary;
}

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

interface CoverageAccumulator {
  /**
   * Map of PascalCase tag name → call-site count + interactive flag.
   * Count drives the top-N ranking so the coverage output can surface
   * the hot-path wrappers without the agent flipping `verboseMeta` and
   * counting manually. The interactive flag filters the ranking to
   * components actually used in an interactive context — non-DOM
   * framework primitives (Route, Provider, Suspense, ErrorBoundary)
   * never appear with interactive attrs and so drop out structurally,
   * without a hardcoded carve-out list.
   */
  readonly opaqueComponents: Map<string, OpaqueComponentUsage>;
  readonly templateEngines: Set<string>;
  readonly parseErrorEntries: ParseErrorEntry[];
  /**
   * Paths of HTML files that parsed as fragments — no `<html>` root
   * and no `<body>` descendant. Populated via
   * {@link isHtmlFragment} for every `.html` / `.htm` file that
   * successfully parsed. Surfaced on the response as
   * `analysisCoverage.fragmentFiles` so agents see which files were
   * skipped for page-level rules (skip-link primary-nav gating,
   * landmark-main) — scan-confidence telemetry paralleling
   * `parseErrorFiles` / `partialParseFiles`.
   */
  readonly fragmentFiles: string[];
  /**
   * V1-FRONTMATTER-AS-TEMPLATE-DIRECTIVE-TRIGGER: flipped to true the
   * first time any parsed HTML-family file opens with a YAML
   * frontmatter fence. A single sighting is sufficient — the fence is
   * not per-file telemetry but a scan-level substrate signal ("at
   * least one file in this scan sits on a template layer the HTML
   * parser saw as literal text"), so the accumulator stays a boolean
   * rather than a path list.
   */
  hasFrontmatterFence: boolean;
}

/**
 * Attribute names that signal the surrounding element is used in an
 * interactive context. A single match on any call site flips the
 * component's `interactive` flag — so a component used mostly
 * declaratively but occasionally with `onClick` still surfaces as a
 * wrapper candidate. Over-includes on purpose: the goal is to keep real
 * wrappers ranked, not to perfectly classify. `{...spread}` props also
 * trip the flag because we cannot see what the spread expands to.
 */
const INTERACTIVE_ATTRS: ReadonlySet<string> = new Set([
  "onClick",
  "onKeyDown",
  "onKeyPress",
  "onKeyUp",
  "onMouseDown",
  "onMouseUp",
  "onPointerDown",
  "onPointerUp",
  "onTouchStart",
  "onTouchEnd",
  "onSubmit",
  "onChange",
  "onInput",
  "onFocus",
  "onBlur",
  "role",
  "tabIndex",
  "href",
  "to",
  "formAction",
  "aria-pressed",
  "aria-expanded",
  "aria-haspopup",
  "aria-checked",
  "aria-selected",
  "aria-disabled",
  "disabled",
]);

function elementIsInteractive(el: {
  readonly attributes: readonly { readonly name: string }[];
  readonly hasSpreadProps: boolean;
}): boolean {
  if (el.hasSpreadProps) return true;
  for (const attr of el.attributes) {
    if (INTERACTIVE_ATTRS.has(attr.name)) return true;
  }
  return false;
}

/**
 * Default cap on how many top-by-count opaque components we surface
 * inline. Five is enough to identify the design system's hot paths
 * without bloating the response. Under `verboseMeta: true` the cap is
 * removed and the full ranked list (with call-site counts) is
 * returned, because the agent triaging wrapper coverage needs every
 * candidate, not just the head.
 */
const OPAQUE_COMPONENT_TOP_N = 5;

/**
 * Threshold below which we inline the full `opaqueCustomComponentNames`
 * list (names only, no per-call-site detail) on every response, without
 * requiring `verboseMeta: true`. Above the threshold the names field is
 * omitted and the top-N ranking + count remain the only inline signal;
 * agents that want the full list flip `verboseMeta`. Per-component
 * call-site counts still require `verboseMeta` regardless of size so
 * response weight stays bounded on large codebases.
 *
 * The cutoff is a size-budget call: 50 PascalCase names averages ~500
 * bytes inline (ASCII, average 10 chars per name) — small enough to
 * fit in a default response without displacing other telemetry, large
 * enough to cover typical design-system inventories in a single round
 * trip. Above 50 the full list starts to dominate the response;
 * agents on monorepo-scale codebases should opt in explicitly.
 */
const OPAQUE_COMPONENT_INLINE_NAMES_MAX = 50;

export function buildAnalysisCoverage(
  files: readonly ParsedFile[],
  wrappers: readonly string[],
  activeRules: readonly Rule[],
  verbose: boolean,
  autoDetectConfirmedCount = 0,
  preset?: ConfigPreset,
  discoveryDiagnostics?: import("../input/discover.ts").DiscoveryDiagnostics,
  findingFilePaths?: ReadonlySet<string>,
): { analysisCoverage?: Record<string, unknown>; metaArrayTruncated?: boolean } {
  const acc: CoverageAccumulator = {
    opaqueComponents: new Map(),
    templateEngines: new Set(),
    parseErrorEntries: [],
    fragmentFiles: [],
    hasFrontmatterFence: false,
  };
  const wrapperSet = new Set(wrappers);
  for (const file of files) accumulateCoverageForFile(file, wrapperSet, acc, preset);

  const coverage: CoverageBlock = {};
  // Q-SHARED-META-ARRAY-BUDGET-CAP: OR across every cap in this
  // block. Propagated to the return record so `warningsField` can
  // emit `response_meta_truncated` honestly — "at least one meta
  // path-array was trimmed."
  let metaArrayTruncated = false;
  if (acc.opaqueComponents.size > 0) {
    assembleOpaqueComponentBlock(acc.opaqueComponents, verbose, coverage);
    // P1-ACCT: when autoDetectWrappers: true promotes N PascalCase
    // components to the scan-scoped wrapper list, those N are
    // subtracted from the opaque count — agents comparing scans
    // with-flag vs without-flag see a mysterious difference (43 vs 51
    // on the same codebase). Surfacing the subtraction count makes
    // the scan-scope of the flag visible in the same number field it
    // affects, so an agent can compute the flagless count itself:
    // `opaqueCustomComponents + opaqueCustomComponentsExcludedByAutoDetect`.
    if (autoDetectConfirmedCount > 0) {
      coverage.opaqueCustomComponentsExcludedByAutoDetect = autoDetectConfirmedCount;
    }
  }
  if (acc.templateEngines.size > 0) {
    coverage.templateDirectivesFound = [...acc.templateEngines].sort();
    coverage.templateDirectiveHandling = describeTemplateDirectiveHandling(acc.templateEngines);
  }
  if (acc.hasFrontmatterFence) {
    // V1-FRONTMATTER-AS-TEMPLATE-DIRECTIVE-TRIGGER: surface the
    // substrate signal alongside `templateDirectivesFound` so the
    // warnings layer can fire `template_files_parsed_as_literal`
    // on Jekyll / Hugo / Eleventy / Astro posts whose header is the
    // only template evidence. Present-when-meaningful — omitted when
    // no file in this scan opened with a fence.
    coverage.hasFrontmatterFence = true;
  }
  if (acc.parseErrorEntries.length > 0) {
    if (assembleParseErrorBlocks(acc.parseErrorEntries, findingFilePaths, coverage)) {
      metaArrayTruncated = true;
    }
  }
  if (acc.fragmentFiles.length > 0) {
    if (assembleFragmentFilesBlock(acc.fragmentFiles, coverage)) {
      metaArrayTruncated = true;
    }
  }
  populateCoverageTail(coverage, files, activeRules, acc, verbose, discoveryDiagnostics);
  if (Object.keys(coverage).length === 0) return {};
  return {
    analysisCoverage: coverage as Record<string, unknown>,
    ...(metaArrayTruncated ? { metaArrayTruncated: true } : {}),
  };
}

/**
 * Populates the non-cap tail of the coverage block — `rulesByExtension`
 * (verbose-only), `hints`, and `skippedByExtension`. Extracted from
 * {@link buildAnalysisCoverage} so the orchestrator stays under the
 * cognitive-complexity cap as cap-related branches accrete in the
 * early section.
 */
function populateCoverageTail(
  coverage: CoverageBlock,
  files: readonly ParsedFile[],
  activeRules: readonly Rule[],
  acc: CoverageAccumulator,
  verbose: boolean,
  discoveryDiagnostics: import("../input/discover.ts").DiscoveryDiagnostics | undefined,
): void {
  if (verbose) {
    const byExt = rulesByExtension(files, activeRules);
    if (Object.keys(byExt).length > 0) coverage.rulesByExtension = byExt;
  }
  // Per-extension parse-mode disclosure so the agent can reconcile
  // `filesByExtension` counts against per-rule `filesEvaluated`.
  // Extensions that alias into a foreign parser (`.scss` → css AST,
  // `.mdx` → tsx, `.astro`/`.md`/`.markdown` → html, `.js`/`.ts` → tsx)
  // show the AST-language label they route through; extensions whose
  // parser name matches the extension itself show `"native"`. Without
  // this, a scan reporting N `.scss` files in `filesByExtension` plus
  // `perRuleCoverage.filesEvaluated` totals that don't sum (a
  // real-world scan had `1637 ≠ 1053 + 584`) forces the agent to
  // guess whether `.scss` was parsed as CSS, as something else, or
  // skipped. Present-when-meaningful: omitted when no parseable files
  // were scanned.
  const parseMode = parseModeByExtension(files);
  if (Object.keys(parseMode).length > 0) coverage.parseModeByExtension = parseMode;
  const hints = buildHints(files, acc);
  if (hints.length > 0) coverage.hints = hints;
  // V1-DETECT-SILENT-EXT: surface per-extension counts for files the
  // walker considered but rejected purely on the parseable-extension
  // check. Present-when-meaningful: omitted when the map is empty or
  // the caller didn't run discovery (`scan_file` takes explicit paths).
  if (
    discoveryDiagnostics !== undefined &&
    Object.keys(discoveryDiagnostics.skippedByExtension).length > 0
  ) {
    coverage.skippedByExtension = discoveryDiagnostics.skippedByExtension;
  }
}

/**
 * Threshold for surfacing the nativeWrappers hint. Below this the
 * opaque count is usually one-off components rather than a design
 * system that warrants wiring into config.
 */
const OPAQUE_COMPONENT_HINT_MIN = 8;

/**
 * Minimum JSX-or-HTML count before we consider a low CSS-scan count
 * noteworthy. A truly-static site with one CSS file doesn't need a
 * warning; a React codebase with 200 TSX and 2 CSS files almost
 * certainly has post-compile Tailwind/CSS-in-JS that isn't being
 * scanned.
 */
const MARKUP_FILES_FOR_CSS_HINT_MIN = 30;

/** CSS-to-markup ratio below which the thin-CSS hint fires. */
const CSS_TO_MARKUP_THIN_RATIO = 0.05;

/**
 * Ranks opaque components by raw call-site count (desc), breaking ties
 * alphabetically so the output is deterministic across runs. Exposed
 * inline via `opaqueCustomComponentsTop` so an agent prioritizing which
 * wrappers to register doesn't need a second `verboseMeta: true` round
 * trip just to read counts.
 */
function rankOpaqueByCallSites(
  opaque: ReadonlyMap<string, OpaqueComponentUsage>,
): readonly { readonly name: string; readonly callSites: number }[] {
  return [...opaque.entries()]
    .filter(([, usage]) => usage.interactive)
    .sort(([aName, a], [bName, b]) => b.callSites - a.callSites || aName.localeCompare(bName))
    .map(([name, usage]) => ({ name, callSites: usage.callSites }));
}

/**
 * Maximum character length for a `partialParseFiles[].reason` string.
 * Real parser messages land well under 120 chars; the cap bites only on
 * pathological recovered input where the parser echoes back a long
 * source snippet. Bounded to keep the wire size predictable on
 * hostile-input fixtures without losing the head of the message, which
 * is where the actionable signal (error kind) always lives.
 */
const PARSE_ERROR_REASON_MAX = 200;

function truncateParseErrorReason(message: string): string {
  if (message.length <= PARSE_ERROR_REASON_MAX) return message;
  return `${message.slice(0, PARSE_ERROR_REASON_MAX - 1)}…`;
}

/**
 * Splits the accumulated parse-error entries into the two honest
 * buckets and assigns them to the coverage block.
 *
 * - `parseErrorFiles` (always an array of `{ path, parser, reason }`
 *   when non-empty): files whose parser emitted errors AND produced
 *   zero findings. These are invisible to rules; an agent reading the
 *   list treats them as "could contain a11y violations the scanner
 *   never saw." The bare `parse_errors_present` / `parseErrorFileCount`
 *   signals tell an agent a file didn't parse, but without the parser
 *   + reason the agent has no fix pivot — `parse_errors_present: true`
 *   alone is a silent-failure shape (CLAUDE.md §1 "Zero-output success
 *   is ambiguous failure" applies to partial-success signals). The
 *   entry list is the actionable detail; it ships at every verbosity.
 * - `partialParseFiles` (always an array of `{ path, parser, reason }`
 *   when non-empty): files whose parser emitted errors but for which
 *   at least one rule fired on the recovered slice. Findings on these
 *   paths are present in the response with live line numbers; the
 *   entry is a calibration warning, not a blanket "invisible" signal.
 *
 * Classification depends on `findingFilePaths`. When the caller passes
 * `undefined` (rare — e.g. a coverage surface that hasn't consumed
 * violations yet), every errored file routes into the historical
 * `parseErrorFiles` bucket so the absence of the signal never silently
 * demotes a file from "fully invisible" to "partially reported."
 *
 * Each bucket is emitted only when non-empty (present-when-meaningful).
 * The `parser` and `reason` strings on every entry are always
 * populated; conditional spreads at the field level are for whole-field
 * absence, not per-entry "did you mean empty or unknown" (see CLAUDE.md
 * §1 "Ambiguous field shapes are dishonest").
 */
function assembleParseErrorBlocks(
  entries: readonly ParseErrorEntry[],
  findingFilePaths: ReadonlySet<string> | undefined,
  coverage: CoverageBlock,
): boolean {
  const totalFailure: ParseErrorEntry[] = [];
  const partial: ParseErrorEntry[] = [];
  for (const entry of entries) {
    if (findingFilePaths?.has(entry.path)) {
      partial.push(entry);
    } else {
      totalFailure.push(entry);
    }
  }
  let truncated = false;
  if (totalFailure.length > 0) {
    // Count stays honest (full size) — only the list is capped.
    // Q-SHARED-META-ARRAY-BUDGET-CAP.
    coverage.parseErrorFileCount = totalFailure.length;
    const sorted = [...totalFailure].sort((a, b) => a.path.localeCompare(b.path));
    const capped = capMetaArray(sorted);
    coverage.parseErrorFiles = capped.values;
    if (capped.truncated !== undefined) {
      coverage.parseErrorFilesTruncated = capped.truncated;
      truncated = true;
    }
  }
  if (partial.length > 0) {
    coverage.partialParseFileCount = partial.length;
    // `partialParseFiles` always ships when non-empty (no verbose gate):
    // the per-entry `parser` + `reason` pair is the actionable signal
    // an agent needs to decide what to investigate, not a dumpable path
    // list. Sorted for deterministic wire output. Capped per
    // Q-SHARED-META-ARRAY-BUDGET-CAP — the count is the honest total.
    const sorted = [...partial].sort((a, b) => a.path.localeCompare(b.path));
    const capped = capMetaArray(sorted);
    coverage.partialParseFiles = capped.values;
    if (capped.truncated !== undefined) {
      coverage.partialParseFilesTruncated = capped.truncated;
      truncated = true;
    }
  }
  return truncated;
}

/**
 * Populates the `fragmentFiles` / `fragmentFileCount` /
 * `fragmentFilesTruncated` sub-block. Returns `true` when the cap
 * actually trimmed the list so the caller can OR the signal into
 * the enclosing `metaArrayTruncated` flag. Extracted from
 * {@link buildAnalysisCoverage} so the enclosing function stays
 * under the cognitive-complexity cap.
 *
 * Fragment-file list is scan-confidence telemetry naming the HTML
 * files that parsed as fragments (no `<html>` root, no `<body>`).
 * Page-level rules — `navigation/skip-link`'s primary-nav path,
 * `semantics/landmark-main`, `semantics/section-accessible-name-
 * missing` — skip these files because the premise of those checks
 * is "this document IS the page," which a partial / include target
 * is not. Shipped at every verbosity (no `verboseMeta` gate): the
 * count alone is ambiguous ("which files?") and the path list is
 * the actionable signal — same reasoning as `parseErrorFiles` /
 * `partialParseFiles`. Count + list are always populated together;
 * sorted for deterministic wire output. Capped per
 * Q-SHARED-META-ARRAY-BUDGET-CAP because fragment-heavy static
 * sites (Jekyll `_includes/`, Astro `layouts/`) can produce
 * hundreds of paths; the count stays honest even when the list is
 * head-sliced.
 */
function assembleFragmentFilesBlock(
  fragmentFiles: readonly string[],
  coverage: CoverageBlock,
): boolean {
  coverage.fragmentFileCount = fragmentFiles.length;
  const sorted = [...fragmentFiles].sort((a, b) => a.localeCompare(b));
  const capped = capMetaArray(sorted);
  coverage.fragmentFiles = capped.values;
  if (capped.truncated === undefined) return false;
  coverage.fragmentFilesTruncated = capped.truncated;
  return true;
}

/**
 * Populates the opaque-components sub-block of analysisCoverage: count,
 * ranked top list, and — when the inventory is small (P2-P) — the full
 * names array. Extracted from {@link buildAnalysisCoverage} so the
 * enclosing function stays under the cognitive-complexity cap.
 */
function assembleOpaqueComponentBlock(
  opaque: ReadonlyMap<string, OpaqueComponentUsage>,
  verbose: boolean,
  coverage: CoverageBlock,
): void {
  coverage.opaqueCustomComponents = opaque.size;
  const ranked = rankOpaqueByCallSites(opaque);
  // `rankOpaqueByCallSites` filters for interactive components only, so
  // the ranked list can be empty even when `opaque.size > 0` (all
  // components are non-interactive). An empty array on a response where
  // `opaqueCustomComponents` is non-zero and `opaqueCustomComponentNames`
  // lists 15 entries reads as a dishonest shape — callers cannot tell
  // "no interactive opaques" from "list not populated." Omit the field
  // in that case so it is present-when-meaningful (CLAUDE.md §1
  // "Ambiguous field shapes are dishonest").
  if (ranked.length > 0) {
    coverage.opaqueCustomComponentsTop = verbose ? ranked : ranked.slice(0, OPAQUE_COMPONENT_TOP_N);
  }
  // Names field: inlined on every response when the inventory is
  // small enough to fit (≤ OPAQUE_COMPONENT_INLINE_NAMES_MAX), so the
  // agent doesn't need a verboseMeta round-trip for small codebases
  // (P2-P). Above the threshold we only ship the names under
  // verboseMeta to keep default responses bounded; agents that want
  // the full list on a large codebase opt in explicitly. Omitted
  // entirely when neither condition applies — never shipped as a
  // partial or empty list (CLAUDE.md §1 "Ambiguous field shapes are
  // dishonest").
  if (verbose || opaque.size <= OPAQUE_COMPONENT_INLINE_NAMES_MAX) {
    coverage.opaqueCustomComponentNames = [...opaque.keys()].sort();
  }
}

function buildHints(files: readonly ParsedFile[], acc: CoverageAccumulator): readonly Hint[] {
  const hints: Hint[] = [];
  const opaqueCount = acc.opaqueComponents.size;
  if (opaqueCount >= OPAQUE_COMPONENT_HINT_MIN) {
    hints.push(buildOpaqueComponentsHint(opaqueCount, acc.opaqueComponents));
  }
  const counts = countByCategory(files);
  const markupFiles = counts.jsx + counts.html;
  if (
    markupFiles >= MARKUP_FILES_FOR_CSS_HINT_MIN &&
    counts.css <= Math.max(1, Math.floor(markupFiles * CSS_TO_MARKUP_THIN_RATIO))
  ) {
    hints.push(buildCssThinHint(files, counts.css, markupFiles));
  }
  // ADR 0025 Option B: `.md` / `.markdown` files are parsed as an
  // HTML-residue projection — the scanner reaches embedded HTML
  // (tables, iframes, admonition divs) and image alt-text synthesized
  // from `![alt](url)`, but link text, heading hierarchy, and prose
  // readability are intentionally out of scope. Surface the hint
  // whenever at least one `.md` or `.markdown` file participated in
  // the scan so the agent can calibrate coverage expectations.
  if (files.some((f) => isMarkdownFile(f.filePath))) {
    hints.push({
      code: "markdown_html_residue",
      text:
        "Markdown files parsed as HTML residue: embedded HTML, image alt-text, and " +
        "kramdown IAL are checked; link text and prose are not. ATX (`# …`) and " +
        "Setext headings are stripped before the residue reaches `parseHtml`, so " +
        "`semantics/heading-hierarchy` is skipped on `.md` / `.markdown` files to " +
        "avoid emits that contradict this coverage gap. For full coverage, build " +
        "the site and point `scan_project` at the rendered output (`_site/`, " +
        "`public/`, `dist/`) via `additionalPaths`.",
    });
  }
  return hints;
}

/**
 * Builds the `opaque_components_present` hint. Extracted so
 * {@link buildHints} stays flat — the examples-prose branch and the
 * structured-detail payload both key off the same opaque-components
 * map. `detail` carries the total count plus the top-3 interactive
 * candidates (name + callSites) so an agent triaging wrapper
 * registration reads the structured payload and skips parsing the
 * English examples list in `text`.
 */
function buildOpaqueComponentsHint(
  opaqueCount: number,
  opaque: ReadonlyMap<string, OpaqueComponentUsage>,
): Hint {
  // `rankOpaqueByCallSites` filters for interactive components; when
  // every opaque component is non-interactive the examples list is
  // empty and the literal "(top: )" parenthetical would render with
  // nothing after the colon. Omit the parenthetical entirely in that
  // case rather than ship broken prose.
  const topCandidates = rankOpaqueByCallSites(opaque).slice(0, 3);
  const examples = topCandidates.map((e) => `${e.name} (${e.callSites} call sites)`).join(", ");
  const opaqueLead =
    examples.length > 0
      ? `${opaqueCount} PascalCase components are opaque to the scanner (top: ${examples}).`
      : `${opaqueCount} PascalCase components are opaque to the scanner.`;
  const text =
    `${opaqueLead} ` +
    `Rules needing the underlying element (button-name, alt-text, link-purpose) skip these. ` +
    `Wire common wrappers via \`nativeWrappers\` in ra11y.config.ts — e.g. ` +
    `{ Button: "button", Link: "a", Image: "img" } — to unlock analysis. ` +
    `Call \`detect_native_wrappers\` for a suggested mapping based on this codebase.`;
  // Conditional-spread on `topCandidates` keeps the `detail` shape
  // honest: when every opaque sighting is non-interactive the list is
  // empty and we omit it rather than ship `topInteractive: []` (which
  // would read as a dishonest empty sentinel per CLAUDE.md §1). The
  // `opaqueCount` scalar is the invariant carrier either way.
  return {
    code: "opaque_components_present",
    text,
    detail: {
      opaqueCount,
      ...(topCandidates.length > 0 ? { topInteractive: topCandidates } : {}),
    },
  };
}

/**
 * True when `filePath` is a markdown source file (`.md` or
 * `.markdown`). Kept in sync with the PARSEABLE_EXTENSIONS entry and
 * the parser dispatch in `src/mcp/session.ts`.
 */
function isMarkdownFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".md") || filePath.toLowerCase().endsWith(".markdown");
}

/**
 * V1-TEMPLATE-CLASSIFIER-MARKDOWN-PROSE-FALSE-POSITIVE: elides the
 * contents of triple-backtick fenced code blocks and single-backtick
 * inline-code spans from a markdown source so downstream template-
 * directive detection doesn't fire on prose examples that QUOTE
 * template syntax (a Jekyll docs page showing `<%= Time.now %>` as
 * an ERB example, a release-note embedding `{% assign %}`).
 *
 * CommonMark fence semantics: opener is 3+ backticks after ≤3 spaces
 * of leading whitespace; closer is a matching fence (≥ opener length,
 * backticks only, optional trailing whitespace) on its own line.
 * Block body is elided to blank lines so line numbers stay stable for
 * any downstream positional analysis. Inline-code spans (single
 * backtick pairs on a line) are replaced with equivalent-length
 * whitespace so column positions stay roughly aligned. Unmatched
 * backticks are left alone — CommonMark treats those as literal, and
 * retaining them is safer than greedily swallowing template-looking
 * text past the end of a real span. HTML `<pre><code>` sections are
 * out of scope (require AST-level stripping, different concern).
 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})\s*$/;
const INLINE_CODE_RE = /`[^`\n]+`/g;

function stripMarkdownCodeRegions(source: string): string {
  const lines = source.split("\n");
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fenceLen === 0) {
      const open = FENCE_OPEN_RE.exec(line);
      if (open === null) lines[i] = line.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length));
      else fenceLen = open[1]?.length ?? 0;
      continue;
    }
    const close = FENCE_CLOSE_RE.exec(line);
    if (close !== null && (close[1]?.length ?? 0) >= fenceLen) fenceLen = 0;
    else lines[i] = "";
  }
  return lines.join("\n");
}

/**
 * Explains what the HTML parser does with the template directives we
 * detected. The parser treats `{% ... %}` and `{{ ... }}` as literal
 * text, so attribute values and text content containing directives are
 * parsed verbatim; rules evaluate against the template source, not the
 * rendered output. Calling this out explicitly replaces the silent
 * "templateDirectivesFound" signal, which told the agent *that* we saw
 * directives but not how we handled them.
 */
function describeTemplateDirectiveHandling(engines: ReadonlySet<string>): string {
  const list = [...engines].sort().join(", ");
  return (
    `${list} directives are parsed as literal HTML text — the rendered output is not ` +
    "reconstructed. Rules run against the template source, so attributes like " +
    '`class="{% if x %}foo{% endif %}"` are evaluated as the raw string containing ' +
    "the directive. Cross-template `extends`/`include` relationships are not resolved. " +
    "Verify findings in files flagged with directives by reading the rendered output " +
    "rather than the template."
  );
}

/**
 * For each file extension actually seen in this scan, lists the active
 * rule IDs that evaluated files with that extension. Mirrors the gate in
 * rule-runner.ts `applies()` exactly: routes through
 * {@link extensionMatches} so extension aliases (`.scss → .css`,
 * `.mdx → .tsx`/`.jsx`, `.astro → .html`, `.md`/`.markdown → .html`,
 * `.js → .jsx`, `.ts → .tsx`) expand into the declared gate the same way
 * they do at runtime. A rule with no `fileExtensions` constraint runs on
 * every extension; otherwise it runs on declared extensions plus any
 * alias-equivalent extension the parser adapters funnel in. Without this,
 * `rulesByExtension` disagreed with `perRuleCoverage` on alias-heavy
 * scans — a `.scss`-only scan listed only the rules literally declaring
 * `.scss` (typically zero), while `perRuleCoverage` correctly showed
 * every `.css`-targeted rule with `filesEvaluated: 1` (because the SCSS
 * adapter produces a CSS AST and `applies()` matches via alias). Two
 * surfaces naming "rules run on this extension" must agree
 * (Q3-RULES-BY-EXTENSION-UNDERCOUNT) — this is the agreement site.
 */
/**
 * Per-extension disclosure of which parser / AST-language each file
 * routed through. Mirrors `parseForExtension` in `src/mcp/session.ts`
 * and the EXTENSION_ALIASES table in `src/utils/path.ts`. Values are
 * either `"native"` (extension name equals AST language — no alias to
 * explain) or the AST-language tag an alias routes through
 * (`"css"`, `"html"`, `"tsx"`). Canonical mappings: `.scss → "css"`,
 * `.less → "css"`, `.mdx → "tsx"`, `.astro → "html"`,
 * `.md`/`.markdown → "html"`, `.erb → "html"`, `.js`/`.ts → "tsx"`.
 * Native pairs:
 * `.css`, `.html`, `.htm`, `.tsx`, `.jsx`. Values mirror the AST
 * `language` alphabet so cross-
 * referencing against `parseErrorFiles[].parser` is unambiguous.
 * Derived from the ParsedFile list (no re-dispatch): every file
 * carries `ast.language` and the extension comes off the path.
 * `parseForExtension` dispatches purely on suffix, so two files with
 * the same extension always produce the same language — safe to stop
 * at the first sighting. Sorted for deterministic wire output.
 */
const NATIVE_EXT_LANG: Readonly<Record<string, string>> = { htm: "html", jsx: "tsx" };

function parseModeByExtension(files: readonly ParsedFile[]): Record<string, string> {
  const seen = new Map<string, string>();
  for (const f of files) {
    const dot = f.filePath.lastIndexOf(".");
    const ext = dot === -1 ? "" : f.filePath.slice(dot).toLowerCase();
    if (ext.length === 0 || seen.has(ext)) continue;
    const lang = f.ast.language;
    const isNative = ext.slice(1) === lang || NATIVE_EXT_LANG[ext.slice(1)] === lang;
    seen.set(ext, isNative ? "native" : lang);
  }
  return Object.fromEntries([...seen.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function rulesByExtension(
  files: readonly ParsedFile[],
  activeRules: readonly Rule[],
): Record<string, readonly string[]> {
  const extsSeen = new Set<string>();
  for (const f of files) {
    const dot = f.filePath.lastIndexOf(".");
    if (dot !== -1) extsSeen.add(f.filePath.slice(dot).toLowerCase());
  }
  const out: Record<string, readonly string[]> = {};
  for (const ext of [...extsSeen].sort()) {
    const ids: string[] = [];
    for (const r of activeRules) {
      const declared = r.appliesTo?.fileExtensions;
      if (!declared || declared.length === 0) {
        ids.push(r.id);
        continue;
      }
      // `extensionMatches` is the same helper rule-runner.ts `applies()`
      // uses for per-file eligibility — routing through it is what keeps
      // `rulesByExtension` and `perRuleCoverage` in agreement on
      // alias-heavy scans. Literal equality silently dropped every
      // aliased extension (the historical bug).
      if (extensionMatches(ext, declared)) ids.push(r.id);
    }
    out[ext] = ids.sort();
  }
  return out;
}

/**
 * HTML-family branch of {@link accumulateCoverageForFile}. Extracted so
 * the enclosing function stays under the cognitive-complexity cap as
 * the template-substrate detectors accrete. Three independent signals
 * flow from a single source pass:
 *
 *   1. Template-directive family classification — markdown files route
 *      through the HTML parser per ADR 0025, but their prose routinely
 *      QUOTES template directives in fenced code blocks / inline-code
 *      spans; those regions are stripped before classification
 *      (V1-TEMPLATE-CLASSIFIER-MARKDOWN-PROSE-FALSE-POSITIVE).
 *   2. YAML frontmatter fence presence — a top-of-file `---\n…\n---\n`
 *      header is parser-level template substrate the HTML parser sees
 *      as literal text. Flagging presence lets the warnings layer fire
 *      `template_files_parsed_as_literal` on files whose only substrate
 *      is the header (V1-FRONTMATTER-AS-TEMPLATE-DIRECTIVE-TRIGGER).
 *   3. Fragment-vs-document classification — files without `<html>` or
 *      `<body>` are excluded from page-scope rules; the coverage block
 *      surfaces the list so the exclusion is honest.
 */
function accumulateHtmlCoverageForFile(file: ParsedFile, acc: CoverageAccumulator): void {
  const src = isMarkdownFile(file.filePath) ? stripMarkdownCodeRegions(file.source) : file.source;
  detectTemplateEngines(src, acc.templateEngines);
  acc.hasFrontmatterFence ||= FRONTMATTER_FENCE_RE.test(file.source);
  if (isHtmlFragment(file.ast.root as HtmlDocument)) acc.fragmentFiles.push(file.filePath);
}

function accumulateCoverageForFile(
  file: ParsedFile,
  wrapperSet: ReadonlySet<string>,
  acc: CoverageAccumulator,
  preset: ConfigPreset | undefined,
): void {
  if (file.ast.errors.length > 0) {
    // The first parse error drives the `reason` an agent sees when
    // classifying the entry. Subsequent errors often cascade from it
    // (one unclosed tag spawns a dozen "unexpected token" complaints),
    // so the head message is both the most actionable and the least
    // noisy signal. Message truncation keeps the wire size bounded on
    // pathological cases (e.g. a recovered HTML parser echoing back a
    // 10 KB line). The cap is generous — real parser messages are
    // ≤120 chars; this only bites on hostile input. `parser` comes
    // straight from the AST language tag so the agent sees which
    // in-house parser owned the failure (`html`, `css`, `tsx`, `jsx`,
    // `ts`, `js`) — distinct from the file extension because e.g.
    // `.mdx` routes through the MDX → TSX bridge and emits `tsx`-class
    // diagnostics under a `.mdx` path.
    acc.parseErrorEntries.push({
      path: file.filePath,
      parser: file.ast.language,
      reason: truncateParseErrorReason(file.ast.errors[0]?.message ?? ""),
    });
  }
  if (file.ast.language === "html") {
    accumulateHtmlCoverageForFile(file, acc);
    return;
  }
  if (file.ast.language === "css") return;
  // Plain `.ts` and `.js` cannot legally carry JSX syntax. The in-house
  // TSX parser still runs on them (one parser for the whole
  // JavaScript/TypeScript family) but any "JSX element" the parser
  // emits from those files is a false positive: ambiguous
  // angle-bracket sequences in minified or transpiled expression code
  // (`if(Math.abs(x)<B.length)`, `{l:J<0}`) sometimes defeat the
  // generic-vs-JSX classifier and materialize as phantom tags like
  // `Math.abs`, `J.length`, `B`. Those phantoms polluted
  // `opaqueCustomComponentNames` on real-world scans — skip extraction
  // for non-JSX-bearing extensions so the inventory reflects real
  // component sightings. See `opaque-tag-filter.ts`.
  if (!isJsxBearingFile(file.filePath)) return;
  // Belt-and-braces filter (Q6-OPAQUE-COMPONENTS-MINIFIED-JS-REGRESSION).
  // The extension filter above already excludes plain `.ts` / `.js`, but
  // the parser's JSX-mode recovery path still runs on `.tsx` / `.jsx`
  // sources that fail to parse cleanly — when that happens, fake tag
  // positions from degraded AST recovery slip through and pollute
  // `opaqueCustomComponentNames`. Two additional structural skips keep
  // the inventory honest regardless of how fake positions originate:
  //
  //   1. Files whose parser emitted errors. The AST is degraded and any
  //      JSX element materialized off the recovered slice is on weaker
  //      evidence than a clean parse — skip extraction so the parse-
  //      error paths can never contribute to the opaque inventory.
  //      This upholds the invariant that every name in
  //      `opaqueCustomComponentNames` traces back to a cleanly-parsed
  //      source file (see the per-extension filter above for the
  //      companion language-level guard). The `parseErrorFiles` /
  //      `partialParseFiles` sibling blocks on this same coverage object
  //      are how an agent triages the invisible / degraded paths; the
  //      opaque inventory staying clean is how it trusts the rest.
  //   2. Files classified as build artifacts. Minified bundles, hashed
  //      vendor output, and `dist/`-tree files can still reach
  //      `.tsx`/`.jsx` extensions (shipped bundles, pre-compiled
  //      component libraries). The `scannedBuildArtifacts` classifier
  //      runs deterministic checks — `.min.` infix, hashed filename,
  //      bundler-output directory, single-long-line minification — so
  //      skipping here is structural, not heuristic. A compiled bundle
  //      is not a source of authored component sightings.
  if (file.ast.errors.length > 0) return;
  if (isBuildArtifact(file.filePath, file.source)) return;
  // Per-file Storybook transparency: only story files get the
  // primitive exemption, so a stray `<Story />` in product code is
  // still counted as opaque. Computed once per file so the hot JSX
  // walk below stays a set lookup.
  const storyFile = preset === "storybook" && isStorybookStoryFile(file.filePath);
  for (const el of walkJsxElements(file.ast.root)) {
    const component = extractComponentIdentifier(el.tagName);
    if (component === null) continue;
    if (!isOpaqueCandidate(component, wrapperSet, storyFile)) continue;
    recordOpaqueSighting(acc.opaqueComponents, component, elementIsInteractive(el));
  }
}

/**
 * True when a component identifier should be counted toward the
 * opaque-component inventory. The caller is expected to have already
 * normalized the JSX tag text through
 * {@link extractComponentIdentifier} so `component` is a PascalCase
 * root identifier (plain or the root of a dotted member access) —
 * this predicate layers the wrapper-registration and Storybook-
 * primitive exemptions on top. Registered wrappers and, in story
 * files, Storybook primitives (`Meta`, `StoryObj`, `StoryFn`, `Story`)
 * drop out so they don't inflate the opaque count.
 */
function isOpaqueCandidate(
  component: string,
  wrapperSet: ReadonlySet<string>,
  storyFile: boolean,
): boolean {
  if (wrapperSet.has(component)) return false;
  if (storyFile && STORYBOOK_TRANSPARENT_TAGS.has(component)) return false;
  return true;
}

/**
 * Increments the call-site count for `tagName` in `opaque`, flipping
 * the `interactive` flag when any sighting carries an interactive
 * attribute. Extracted so {@link accumulateCoverageForFile} stays
 * flat — the map get/update branch is otherwise repeated noise.
 */
function recordOpaqueSighting(
  opaque: Map<string, OpaqueComponentUsage>,
  tagName: string,
  interactive: boolean,
): void {
  const existing = opaque.get(tagName);
  if (existing) {
    existing.callSites += 1;
    if (interactive) existing.interactive = true;
    return;
  }
  opaque.set(tagName, { callSites: 1, interactive });
}

/**
 * Per-file syntax-family classifier. Not trying to distinguish dialects
 * precisely — the signal "this file isn't plain HTML" plus the family is
 * what the agent needs to know cross-file reasoning is limited.
 *
 * Families (the labels are disjoint — one file gets at most one `{{...}}`
 * family, plus optionally the `<%...%>` family):
 *   - jinja-or-liquid: uses `{% ... %}` control blocks (Jinja / Liquid /
 *     Nunjucks). Whitespace-control variants `{%-` and `-%}` count.
 *     Also wins on Liquid-only evidence in `{{ ... }}` interpolation —
 *     specifically the `{{-` / `-}}` whitespace-stripping variant, which
 *     Handlebars and Mustache do not support. `{{ ... }}` interpolation
 *     (without whitespace control) in the same file is part of THIS
 *     family when any Liquid evidence is present, not a separate
 *     handlebars signal.
 *   - handlebars-or-mustache: uses `{{ ... }}` interpolation but no
 *     `{% ... %}` control blocks AND no `{{- -}}` whitespace-control
 *     variant — the plain `{{ }}`-only shape.
 *   - erb-or-ejs: uses `<% ... %>`. Independent of the `{{...}}` axis.
 *
 * The per-file scoping matters for `scan_project`: a prior implementation
 * accumulated labels across the whole scan via the shared `into` set, so
 * the first file with bare `{{ x }}` would stamp `handlebars-or-mustache`
 * and a later `{% extends %}` would stamp `jinja-or-liquid` — yielding
 * a mixed classification on projects that are pure Liquid. Classify
 * THIS file's source; the caller unions the per-file result into the
 * accumulator.
 *
 * A separate single-file variant (Q4-TEMPLATE-CLASSIFIER-LIQUID-AS-
 * MUSTACHE-SINGLE-FILE): a pure-Liquid layout that uses only
 * `{{- content -}}` / `{{- page.title -}}` whitespace-control
 * interpolation — no `{% %}` blocks — was mis-tagged handlebars-or-
 * mustache because the earlier classifier only treated `{% %}` blocks
 * as Liquid evidence. `{{-` and `-}}` are decisive Liquid signals:
 * Handlebars and Mustache don't support whitespace-stripping markers
 * in interpolation. Treating that form as equivalent to a control
 * block for classification purposes restores the honest family label
 * so downstream rules reach for the correct strip helpers.
 *
 * A second axis of the same misclassification (V1-TEMPLATE-CLASSIFIER-
 * LIQUID-PIPE-FILTER-EVIDENCE): Jekyll `_includes/top.html` and
 * similar SSG partials use Liquid filter pipes inside interpolation —
 * `{{ page.lang | default: "en" }}`, `{{ title | escape }}`,
 * `{{ items | first }}`. The pipe inside a `{{ ... }}` expression is
 * Liquid-exclusive syntax — Handlebars and Mustache use sub-expression
 * helper invocation (`{{helper foo}}`) rather than postfix pipes.
 * `{{ x | filter }}` (with a real filter pipe) is therefore decisive
 * Liquid evidence and outweighs any co-occurring bare `{{ plain }}`
 * tokens in the same file. Two non-Liquid look-alikes are excluded:
 * `||` (JS or-expression in a JSX attribute spread) and `|>` (pipeline
 * operator) — neither is a Liquid filter separator.
 */
function detectTemplateEngines(source: string, into: Set<string>): void {
  // `\{%-?\s*` accepts both the plain `{%` opener and Liquid/Jinja's
  // whitespace-control `{%-` variant. Jekyll `_includes/` partials
  // routinely open with `{%- include 'foo.html' -%}` — missing the
  // dash-prefixed form caused pure-Liquid partials to miss the
  // jinja-or-liquid tag and fall through to handlebars-or-mustache.
  const hasControlBlock =
    /\{%-?\s*(?:extends|include|block|if|for|set|assign|capture|unless|case|comment|raw|render|layout|tablerow|cycle)\b/.test(
      source,
    );
  // `{{- ... -}}` / `{{ ... -}}` / `{{- ... }}` whitespace-stripping
  // interpolation is Liquid-only. Handlebars and Mustache do not
  // recognize the leading/trailing `-` as a whitespace-control marker.
  // A Jekyll `_layouts/default.html` that uses only `{{- content -}}`
  // (no `{% %}` blocks) is decisively Liquid even though its other
  // interpolations are the shared `{{ ... }}` form. Checking either
  // `{{-` or `-}}` is enough — the whitespace-strip pair is always
  // parenthesized together by convention, but one side is sufficient
  // evidence for the classifier.
  const hasLiquidWhitespaceInterp = /\{\{-|-\}\}/.test(source);
  // V1-TEMPLATE-CLASSIFIER-LIQUID-PIPE-FILTER-EVIDENCE: a `|` inside
  // `{{ ... }}` that is NOT `||` (JS or) or `|>` (pipeline) is a
  // Liquid filter separator. Jekyll `docs/_includes/top.html` was
  // tagged handlebars-or-mustache because per-file majority-vote
  // didn't credit the pipe as Liquid-only evidence — `{{ page.lang |
  // default: "en" }}` is decisive Liquid syntax that no Handlebars or
  // Mustache template would carry.
  const hasLiquidFilterPipe = hasLiquidFilterPipeEvidence(source);
  const hasInterpolation = hasNonJsxInterpolation(source);
  if (hasControlBlock || hasLiquidWhitespaceInterp || hasLiquidFilterPipe) {
    into.add("jinja-or-liquid");
  } else if (hasInterpolation) {
    // `{{ }}`-only shape — handlebars/mustache's syntactic signature.
    // Note: a pure-interpolation Liquid file (no control tags, no
    // whitespace-strip variant) will also land here and be labeled
    // handlebars-or-mustache; that's the honest reading of the
    // evidence — `{{ x }}` alone is ambiguous between the families,
    // and the tag's combined name reflects the ambiguity rather than
    // guessing.
    into.add("handlebars-or-mustache");
  }
  if (/<%[=-]?[\s\S]*?%>/.test(source)) into.add("erb-or-ejs");
}

/**
 * True when `source` contains at least one `{{ ... }}` interpolation
 * whose prefix is NOT a known false-positive shape. Two shapes are
 * filtered out because they collapse to the same `{{ ... }}` shape
 * without being template evidence:
 *
 *   - `={{ ... }}` — JSX / Astro attribute-value object-literal spread
 *     (`overrides={{ body: bodyProps }}`). The outer `{` is the JSX
 *     expression boundary; the inner `{...}` is the object literal.
 *     A real Handlebars/Mustache interpolation is never prefixed by
 *     `=` — the attribute would be quoted (`title="{{ title }}"`).
 *     `.astro` files flow through `parseAstro` → HTML AST, so this
 *     source shape routinely reaches the classifier for Starlight /
 *     Astro docs projects.
 *   - `${{ ... }}` — GitHub Actions workflow expression syntax
 *     (`${{ github.event.pull_request.number }}`). The `$` prefix is
 *     decisive: Handlebars does not recognize `${{ ... }}`. While
 *     `.yml` files are not in PARSEABLE_EXTENSIONS, the shape can
 *     reach the classifier through embedded `.md` / `.html` fragments
 *     documenting workflow usage.
 *
 * Both filters are pre-match exclusions on the evidence corpus — they
 * do not drop real `{{ x }}` interpolations that coexist in the same
 * file. The classifier already unions per-file decisions into the
 * scan-level accumulator, so a mixed file with both Astro spreads
 * AND a real Handlebars interpolation still tags honestly.
 *
 * Doctrine (AI-first consumer model): this tightens a misclassified
 * label (wrong evidence → wrong family tag), not suppression of real
 * findings. `templateDirectivesFound` is scan-confidence telemetry an
 * agent uses to decide whether template directives are parsed as
 * literal — tagging a Starlight docs repo as "handlebars-or-mustache"
 * when no Handlebars is present misleads that decision. The shape-
 * honest fix is to exclude shapes that aren't template evidence.
 */
function hasNonJsxInterpolation(source: string): boolean {
  const pattern = /\{\{[^}]+\}\}/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined) continue;
    const prevChar = start > 0 ? source[start - 1] : "";
    // `={{...}}` → JSX attribute-spread (Astro / React / Solid).
    // `${{...}}` → GitHub Actions / template-literal expression.
    if (prevChar === "=" || prevChar === "$") continue;
    return true;
  }
  return false;
}

/**
 * V1-TEMPLATE-CLASSIFIER-LIQUID-PIPE-FILTER-EVIDENCE: true when any
 * `{{ … | … }}` interpolation in `source` carries a pipe that is a
 * Liquid filter separator rather than a JS look-alike operator.
 *
 * A pipe inside `{{ ... }}` is Liquid-exclusive syntax — Handlebars
 * and Mustache express transforms via sub-expression helper invocation
 * (`{{helper foo}}`), never a postfix `|`. One pipe is enough evidence
 * to force the file's classification to `jinja-or-liquid`, outweighing
 * any bare `{{ x }}` tokens that co-occur (per-file majority-vote
 * would otherwise mis-tag a layout that has one `{{ lang | default }}`
 * alongside several `{{ plain }}` spans — the canonical Jekyll
 * `_includes/top.html` shape).
 *
 * Two JS look-alikes are excluded because they collapse to the same
 * shape without being Liquid evidence:
 *
 *   - `||` → JS or-expression (`{{ a || b }}` — can appear inside a
 *     JSX attribute-spread object literal). Liquid does not use `||`.
 *   - `|>` → pipeline operator (Stage-2 proposal, Elixir-style).
 *     Liquid filters are `|` followed by an identifier, not `|>`.
 *
 * Same pre-match exclusions as {@link hasNonJsxInterpolation}:
 * `={{ … }}` (JSX attribute spread) and `${{ … }}` (GitHub Actions
 * workflow expression) are filtered from the evidence corpus before
 * pipe detection. A real Liquid filter interpolation is never
 * prefixed by `=` (the attribute would be quoted) or `$` (not a
 * Liquid shape).
 */
function hasLiquidFilterPipeEvidence(source: string): boolean {
  const pattern = /\{\{([^}]+)\}\}/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    if (start === undefined) continue;
    const prevChar = start > 0 ? source[start - 1] : "";
    if (prevChar === "=" || prevChar === "$") continue;
    const body = match[1] ?? "";
    if (containsLiquidFilterPipe(body)) return true;
  }
  return false;
}

/**
 * Scans the interior of a `{{ … }}` interpolation for a pipe that is
 * a Liquid filter separator. A bare `|` qualifies; `||` (JS or) and
 * `|>` (pipeline operator) do not. Bare `|` with no right-hand
 * identifier (trailing whitespace only) is not credited as evidence —
 * the Liquid shape is always `value | filterName` or
 * `value | filterName: arg`. Keeping the right-hand identifier
 * requirement avoids false positives on malformed templates whose
 * trailing `|` carries no filter at all.
 */
function containsLiquidFilterPipe(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) !== 0x7c) continue; // '|'
    const next = body[i + 1] ?? "";
    if (next === "|" || next === ">") {
      i += 1; // skip the second char of the pair, don't re-match '|' on next iter
      continue;
    }
    if (filterIdentifierFollows(body, i + 1)) return true;
  }
  return false;
}

/**
 * True when the first non-whitespace character at or after `start` in
 * `body` begins an ASCII identifier (Liquid filter names — `default`,
 * `escape`, `upcase`, plugin-authored). Extracted from
 * {@link containsLiquidFilterPipe} so the per-pipe scanner stays under
 * the cognitive-complexity cap while keeping the RHS shape requirement
 * explicit (the Liquid filter form is always `value | name[: arg]`,
 * never a trailing `|` with no identifier).
 */
function filterIdentifierFollows(body: string, start: number): boolean {
  let j = start;
  while (j < body.length && (body[j] === " " || body[j] === "\t")) j += 1;
  if (j >= body.length) return false;
  const rhs = body.charCodeAt(j);
  const isUpper = rhs >= 0x41 && rhs <= 0x5a;
  const isLower = rhs >= 0x61 && rhs <= 0x7a;
  const isUnderscore = rhs === 0x5f;
  return isUpper || isLower || isUnderscore;
}
