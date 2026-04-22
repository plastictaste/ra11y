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

import { walkJsxElements } from "../engine/ast-helpers.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { ConfigPreset } from "../types/config.ts";
import type { Rule } from "../types/rule.ts";
import { isStorybookStoryFile } from "../utils/path.ts";

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
): { analysisCoverage?: Record<string, unknown> } {
  const acc: CoverageAccumulator = {
    opaqueComponents: new Map(),
    templateEngines: new Set(),
    parseErrorEntries: [],
  };
  const wrapperSet = new Set(wrappers);
  for (const file of files) accumulateCoverageForFile(file, wrapperSet, acc, preset);

  const coverage: {
    opaqueCustomComponents?: number;
    opaqueCustomComponentsTop?: readonly { readonly name: string; readonly callSites: number }[];
    opaqueCustomComponentNames?: readonly string[];
    opaqueCustomComponentsExcludedByAutoDetect?: number;
    templateDirectivesFound?: readonly string[];
    templateDirectiveHandling?: string;
    parseErrorFileCount?: number;
    parseErrorFiles?: readonly {
      readonly path: string;
      readonly parser: string;
      readonly reason: string;
    }[];
    partialParseFileCount?: number;
    partialParseFiles?: readonly {
      readonly path: string;
      readonly parser: string;
      readonly reason: string;
    }[];
    rulesByExtension?: Readonly<Record<string, readonly string[]>>;
    hints?: readonly string[];
    skippedByExtension?: Readonly<Record<string, number>>;
  } = {};
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
  if (acc.parseErrorEntries.length > 0) {
    assembleParseErrorBlocks(acc.parseErrorEntries, findingFilePaths, coverage);
  }
  if (verbose) {
    const byExt = rulesByExtension(files, activeRules);
    if (Object.keys(byExt).length > 0) coverage.rulesByExtension = byExt;
  }
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
  return Object.keys(coverage).length > 0 ? { analysisCoverage: coverage } : {};
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
  coverage: {
    parseErrorFileCount?: number;
    parseErrorFiles?: readonly {
      readonly path: string;
      readonly parser: string;
      readonly reason: string;
    }[];
    partialParseFileCount?: number;
    partialParseFiles?: readonly {
      readonly path: string;
      readonly parser: string;
      readonly reason: string;
    }[];
  },
): void {
  const totalFailure: ParseErrorEntry[] = [];
  const partial: ParseErrorEntry[] = [];
  for (const entry of entries) {
    if (findingFilePaths?.has(entry.path)) {
      partial.push(entry);
    } else {
      totalFailure.push(entry);
    }
  }
  if (totalFailure.length > 0) {
    coverage.parseErrorFileCount = totalFailure.length;
    coverage.parseErrorFiles = [...totalFailure].sort((a, b) => a.path.localeCompare(b.path));
  }
  if (partial.length > 0) {
    coverage.partialParseFileCount = partial.length;
    // `partialParseFiles` always ships when non-empty (no verbose gate):
    // the per-entry `parser` + `reason` pair is the actionable signal
    // an agent needs to decide what to investigate, not a dumpable path
    // list. Sorted for deterministic wire output.
    coverage.partialParseFiles = [...partial].sort((a, b) => a.path.localeCompare(b.path));
  }
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
  coverage: {
    opaqueCustomComponents?: number;
    opaqueCustomComponentsTop?: readonly { readonly name: string; readonly callSites: number }[];
    opaqueCustomComponentNames?: readonly string[];
  },
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

function buildHints(files: readonly ParsedFile[], acc: CoverageAccumulator): readonly string[] {
  const hints: string[] = [];
  const opaqueCount = acc.opaqueComponents.size;
  if (opaqueCount >= OPAQUE_COMPONENT_HINT_MIN) {
    // `rankOpaqueByCallSites` filters for interactive components; when
    // every opaque component is non-interactive the examples string is
    // empty and the literal "(top: )" parenthetical would render with
    // nothing after the colon. Omit the parenthetical entirely in that
    // case rather than ship broken prose.
    const examples = rankOpaqueByCallSites(acc.opaqueComponents)
      .slice(0, 3)
      .map((e) => `${e.name} (${e.callSites} call sites)`)
      .join(", ");
    const opaqueLead =
      examples.length > 0
        ? `${opaqueCount} PascalCase components are opaque to the scanner (top: ${examples}).`
        : `${opaqueCount} PascalCase components are opaque to the scanner.`;
    hints.push(
      `${opaqueLead} ` +
        `Rules needing the underlying element (button-name, alt-text, link-purpose) skip these. ` +
        `Wire common wrappers via \`nativeWrappers\` in ra11y.config.ts — e.g. ` +
        `{ Button: "button", Link: "a", Image: "img" } — to unlock analysis. ` +
        `Call \`detect_native_wrappers\` for a suggested mapping based on this codebase.`,
    );
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
    hints.push(
      "Markdown files parsed as HTML residue: embedded HTML, image alt-text, and " +
        "kramdown IAL are checked; link text, heading hierarchy, and prose are not. " +
        "For full coverage, build the site and point `scan_project` at the rendered " +
        "output (`_site/`, `public/`, `dist/`) via `additionalPaths`.",
    );
  }
  return hints;
}

/**
 * True when `filePath` is a markdown source file (`.md` or
 * `.markdown`). Kept in sync with the PARSEABLE_EXTENSIONS entry and
 * the parser dispatch in `src/mcp/session.ts`.
 */
function isMarkdownFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/**
 * Builds the thin-CSS-coverage hint, strengthened with a Tailwind-
 * specific follow-up when Tailwind usage is detected. On a Tailwind
 * codebase the only realistic way to get contrast/focus-visible
 * coverage is to run the build and point scan_project at the emitted
 * CSS — naming the exact `additionalPaths` argument saves the agent
 * a discovery round trip.
 */
function buildCssThinHint(files: readonly ParsedFile[], css: number, markup: number): string {
  const base =
    `Only ${css} CSS file(s) scanned vs ${markup} JSX/HTML file(s). ` +
    "Post-compile output (Tailwind, CSS-in-JS, SCSS) isn't parsed — color-contrast " +
    "and focus-visible coverage may be undercounted.";
  if (hasTailwindSignal(files)) {
    return (
      `${base} Tailwind usage detected: run the build, then re-run scan_project with ` +
      '`additionalPaths: ["dist/assets"]` (or wherever your bundler emits CSS) to ' +
      "include the generated stylesheet. `additionalPaths` bypasses `.gitignore` and " +
      "the default build-dir skips for the paths you list."
    );
  }
  return `${base} Build the site and point \`scan\` at the emitted .css, or scan the Tailwind source config alongside JSX.`;
}

/**
 * Cheap Tailwind detector: a `class`/`className` attribute anywhere in
 * the scanned JSX whose value contains two or more tokens with the
 * `prefix-value` shape characteristic of Tailwind utilities. We
 * deliberately don't parse tailwind.config.*; that would require
 * filesystem access and version-specific config support for zero
 * marginal signal. Two utility-shaped tokens together is both sparse
 * enough to avoid false positives on class names like "site-header
 * active" and common enough to catch any real Tailwind project on the
 * first JSX file we look at.
 */
function hasTailwindSignal(files: readonly ParsedFile[]): boolean {
  for (const f of files) {
    if (f.ast.language !== "tsx" && f.ast.language !== "jsx") continue;
    if (fileHasTailwindClass(f.ast.root as import("../types/ast.ts").TsxModule)) return true;
  }
  return false;
}

function fileHasTailwindClass(root: import("../types/ast.ts").TsxModule): boolean {
  for (const el of walkJsxElements(root)) {
    for (const attr of el.attributes) {
      if (attr.name !== "className" && attr.name !== "class") continue;
      if (attr.value?.kind !== "StringLiteral") continue;
      if (looksLikeTailwindClassString(attr.value.value)) return true;
    }
  }
  return false;
}

/**
 * Two tokens of shape `<letters>-<letters-or-digits>` (e.g. `bg-red-500
 * text-center`, `md:hover:text-white flex`) are a strong Tailwind
 * signal. Variants with `:` (`md:`, `hover:`, `dark:`) count. Arbitrary
 * values in `[...]` also count when attached to a utility prefix.
 */
function looksLikeTailwindClassString(classString: string): boolean {
  const tokens = classString.trim().split(/\s+/);
  let matches = 0;
  for (const token of tokens) {
    if (TAILWIND_TOKEN_RE.test(token)) {
      matches += 1;
      if (matches >= 2) return true;
    }
  }
  return false;
}

const TAILWIND_TOKEN_RE = /^(?:[a-z]+:)*-?[a-z]+(?:-[a-z0-9/.%]+)+(?:\[[^\]]*\])?$/i;

interface ParsedFileCounts {
  readonly jsx: number;
  readonly html: number;
  readonly css: number;
}

function countByCategory(files: readonly ParsedFile[]): ParsedFileCounts {
  let jsx = 0;
  let html = 0;
  let css = 0;
  for (const f of files) {
    if (f.ast.language === "tsx" || f.ast.language === "jsx") jsx += 1;
    else if (f.ast.language === "html") html += 1;
    else if (f.ast.language === "css") css += 1;
  }
  return { jsx, html, css };
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
 * rule-runner.ts `applies()` — a rule with no `fileExtensions` constraint
 * runs on every extension; otherwise only on declared ones.
 */
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
      if (declared.some((d) => d.toLowerCase() === ext)) ids.push(r.id);
    }
    out[ext] = ids.sort();
  }
  return out;
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
    detectTemplateEngines(file.source, acc.templateEngines);
    return;
  }
  if (file.ast.language === "css") return;
  // Per-file Storybook transparency: only story files get the
  // primitive exemption, so a stray `<Story />` in product code is
  // still counted as opaque. Computed once per file so the hot JSX
  // walk below stays a set lookup.
  const storyFile = preset === "storybook" && isStorybookStoryFile(file.filePath);
  for (const el of walkJsxElements(file.ast.root)) {
    if (!isOpaqueCandidate(el.tagName, wrapperSet, storyFile)) continue;
    recordOpaqueSighting(acc.opaqueComponents, el.tagName, elementIsInteractive(el));
  }
}

/**
 * True when a JSX tag should be counted toward the opaque-component
 * inventory. Filters: PascalCase only, not already a registered
 * wrapper, and — when `preset: "storybook"` has tagged this file as a
 * story — not one of the Storybook primitives (`Meta`, `StoryObj`,
 * `StoryFn`, `Story`). Extracted so the per-file loop stays under the
 * cognitive-complexity cap while keeping the transparency decision on
 * one line.
 */
function isOpaqueCandidate(
  tagName: string,
  wrapperSet: ReadonlySet<string>,
  storyFile: boolean,
): boolean {
  if (!/^[A-Z]/.test(tagName)) return false;
  if (wrapperSet.has(tagName)) return false;
  if (storyFile && STORYBOOK_TRANSPARENT_TAGS.has(tagName)) return false;
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
  const hasInterpolation = /\{\{[^}]+\}\}/.test(source);
  if (hasControlBlock || hasLiquidWhitespaceInterp) {
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
