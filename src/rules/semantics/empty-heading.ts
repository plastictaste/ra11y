/**
 * Rule: semantics/empty-heading
 * Satisfies: wcag22:2.4.6, wcag21:2.4.6
 * Spec: https://www.w3.org/TR/WCAG22/#headings-and-labels
 *
 * > Headings and labels describe topic or purpose.
 *
 * Source: https://www.w3.org/TR/WCAG22/#headings-and-labels
 *
 * Flags <h1>-<h6> elements that are empty, contain only whitespace,
 * or contain only non-text children (e.g., an <svg> or <img> without
 * alt text). An empty heading is invisible to screen-reader navigation
 * shortcuts and degrades the heading outline.
 *
 * Complements semantics/heading-hierarchy (which checks order, not content).
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import {
  htmlSubtreeRenderedTextIsOnlyTemplateDirective,
  TEMPLATE_DIRECTIVE_INTERPOLATION_UNRESOLVED,
} from "../../input/parsers/html-template-directives.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const rule = defineRule({
  id: "semantics/empty-heading",
  satisfies: ["wcag22:2.4.6", "wcag21:2.4.6"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Heading elements (<h1>-<h6>) must have text content. Empty or whitespace-only headings are invisible to assistive technology.",
    rationale:
      "Screen-reader users navigate pages by jumping between headings. An empty heading appears in the heading outline as a blank entry, providing no context and disrupting navigation flow.",
    goodExample: `<h2>Contact Information</h2>`,
    badExample: `<h2></h2>\n<h2>   </h2>\n<h2><svg aria-hidden="true"></svg></h2>`,
    normativeQuote: "Headings and labels describe topic or purpose.",
    references: [
      "https://www.w3.org/TR/WCAG22/#headings-and-labels",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G130",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, ctx.source, (v) => ctx.emit(v));
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, (v) => ctx.emit(v));
    }
  },
});

/**
 * Stable `couldBeWrongBecause` code emitted when an empty heading's
 * id/class is referenced by sibling JS that performs a DOM-text
 * mutation (`.innerHTML =`, `.textContent =`, `.innerText =`,
 * `.insertAdjacentHTML(…)`, `.insertAdjacentText(…)`) — the canonical
 * skeleton-loader / SPA-loading shape where the heading is intentionally
 * empty at first paint and filled at runtime. The agent reads the
 * cited file once, confirms the runtime population path, and dismisses
 * with a `<!-- ra11y-disable semantics/empty-heading -->` pragma when
 * the binding is trusted to always produce non-empty text.
 *
 * Companion to the V1 live-region runtime-mutation finder (4.1.3 axis):
 * that finder asks "is the mutation announced to AT?"; this code asks
 * "is the heading's emptiness a render-time blip rather than a
 * structural defect?". Same evidence shape, different criterion.
 */
export const RUNTIME_INNERHTML_POPULATION = "runtime_innerhtml_population";

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause?: readonly string[];
}) => void;

/**
 * A heading observed in document order. `text` is the trimmed text
 * content (empty string for the offending headings the rule flags).
 * `level` is parsed from the tag so the fix builder can compare
 * level deltas without re-parsing.
 */
interface HeadingEntry {
  readonly tagName: string;
  readonly level: number;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

function checkHtml(doc: HtmlDocument, source: string, emit: Emit): void {
  const headings = collectHtmlHeadings(doc);
  // Pre-compute once per document: does the source contain any
  // DOM-text-mutation pattern (.innerHTML =, .textContent =, etc.)?
  // The per-heading branch only needs to confirm an id/class reference
  // when this gate has fired, so the regex cost is paid once even when
  // a document has many empty headings.
  const hasMutationSite = sourceContainsDomTextMutation(source);
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (heading === undefined) continue;
    const el = findHtmlHeadingAt(doc, heading);
    if (el === null) continue;
    if (hasAccessibleContentHtml(el)) continue;
    // Conceded-uncertainty branch: when the heading's subtree visible-
    // text contribution came exclusively from stripped Liquid/Jinja/ERB
    // template directives — directly (`<h1>{{ page.title }}</h1>`) or
    // through a wrapping element (`<h2><a>{{ post.title }}</a></h2>`,
    // the canonical Jekyll post-list shape) — the static scanner has
    // no runtime evidence the heading is empty. Per AI-first consumer
    // doctrine ("Reason text and severity must agree" + "Heuristic
    // emission is the symmetric twin of heuristic suppression"),
    // surface but at `warning` (not `error`) with a structured
    // `couldBeWrongBecause` code and reason text framing the rendered-
    // output question. Mixed-content shapes (`<h1>{{ x }} literal</h1>`)
    // bypass this branch — the literal text already cleared
    // `hasAccessibleContentHtml`.
    if (htmlSubtreeRenderedTextIsOnlyTemplateDirective(el)) {
      emitTemplateDirectiveViolation(heading, emit);
      continue;
    }
    // Conceded-uncertainty branch: when sibling JS in the same file
    // performs a DOM-text mutation (`.innerHTML = …`, `.textContent
    // = …`, `.insertAdjacentHTML(…)`, etc.) AND references this
    // heading by `id` or `class` (via `getElementById`,
    // `querySelector`, or bare-id global access), the heading is
    // most likely a skeleton-loader / SPA placeholder filled at
    // runtime. Static analysis can't observe the runtime population
    // path; per AI-first doctrine "Reason text and severity must
    // agree" the rule surfaces at `warning` with a structured
    // `couldBeWrongBecause: ["runtime_innerhtml_population"]` code
    // and reason text framing the runtime-fill question. The
    // sibling-JS shape gates this branch deterministically — the
    // mutation pattern + id/class reference are both literally
    // present in the file's source, so the predicate is provable
    // (not heuristic). The agent reads the cited file, confirms the
    // wiring, and dismisses with `<!-- ra11y-disable -->` when
    // appropriate.
    if (hasMutationSite && htmlElementReferencedByRuntimeMutation(el, source)) {
      emitRuntimePopulationViolation(heading, el, emit);
      continue;
    }
    // Past the conceded-uncertainty branches: every remaining
    // would-be-empty heading either has no template directive at all,
    // no sibling-JS runtime population, or has one alongside literal
    // visible text (in which case `hasAccessibleContentHtml` already
    // passed and we never got here). The plainly-empty path emits at
    // `error` with the context-aware fix; concession-text reason
    // suffixes are intentionally NOT layered on top of `error` here —
    // per AI-first doctrine "Reason text and severity must agree,"
    // conceded-uncertainty framing belongs only on the `warning`
    // branches above.
    const preceding = findPrecedingNonEmpty(headings, i);
    emitViolation(heading, preceding, emit);
  }
}

/**
 * Walks the HTML document once in document order and records every
 * heading's tag, level, location, and trimmed text. The entries feed
 * the fix builder so the suggestion can reference the section the
 * empty heading appears under — the rule's detection logic is
 * unchanged.
 */
function collectHtmlHeadings(doc: HtmlDocument): readonly HeadingEntry[] {
  const out: HeadingEntry[] = [];
  for (const el of walkHtmlElements(doc)) {
    const lowered = el.tagName.toLowerCase();
    if (!HEADING_TAGS.has(lowered)) continue;
    const level = Number.parseInt(lowered.slice(1), 10);
    if (!Number.isFinite(level)) continue;
    out.push({
      tagName: lowered,
      level,
      line: el.loc.start.line,
      column: el.loc.start.column,
      text: htmlTextContent(el),
    });
  }
  return out;
}

function findHtmlHeadingAt(doc: HtmlDocument, entry: HeadingEntry): HtmlElement | null {
  for (const el of walkHtmlElements(doc)) {
    if (
      el.tagName.toLowerCase() === entry.tagName &&
      el.loc.start.line === entry.line &&
      el.loc.start.column === entry.column
    ) {
      return el;
    }
  }
  return null;
}

function hasAccessibleContentHtml(element: HtmlElement): boolean {
  // Direct text content
  if (htmlTextContent(element).length > 0) return true;
  // aria-label provides an accessible name
  const ariaLabel = getHtmlAttribute(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  // aria-labelledby references an external label
  if (hasHtmlAttribute(element, "aria-labelledby")) return true;
  // Check for child <img> with alt text
  if (hasChildImageWithAltHtml(element)) return true;
  return false;
}

function hasChildImageWithAltHtml(element: HtmlElement): boolean {
  for (const child of element.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() === "img") {
      const alt = getHtmlAttribute(child, "alt");
      if (alt !== null && alt.trim().length > 0) return true;
    }
    // Recurse into nested elements
    if (hasChildImageWithAltHtml(child)) return true;
  }
  return false;
}

function checkJsx(module: TsxModule, emit: Emit): void {
  const headings = collectJsxHeadings(module);
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (heading === undefined) continue;
    const el = findJsxHeadingAt(module, heading);
    if (el === null) continue;
    if (hasAccessibleContentJsx(el)) continue;
    if (el.hasSpreadProps) {
      emitPrimitiveViolation(heading.tagName, heading.line, heading.column, emit);
      continue;
    }
    const preceding = findPrecedingNonEmpty(headings, i);
    // JSX branch: expression-child guard in `hasAccessibleContentJsx`
    // already exempts `<h1>{label}</h1>`, so the JSX path never needs
    // a template-stripped enrichment — runtime expressions never
    // reach this emission.
    emitViolation(heading, preceding, emit);
  }
}

function collectJsxHeadings(module: TsxModule): readonly HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  for (const el of walkJsxElements(module)) {
    if (!HEADING_TAGS.has(el.tagName)) continue;
    const level = Number.parseInt(el.tagName.slice(1), 10);
    if (!Number.isFinite(level)) continue;
    entries.push({
      tagName: el.tagName,
      level,
      line: el.loc.start.line,
      column: el.loc.start.column,
      text: jsxTextContent(el),
    });
  }
  // Sort by source position so "preceding heading" is computed in
  // document order (walkJsxElements yields outer-first / children
  // after, which isn't document order for nested JSX).
  entries.sort((a, b) => a.line - b.line || a.column - b.column);
  return entries;
}

function findJsxHeadingAt(module: TsxModule, entry: HeadingEntry): JsxElement | null {
  for (const el of walkJsxElements(module)) {
    if (
      el.tagName === entry.tagName &&
      el.loc.start.line === entry.line &&
      el.loc.start.column === entry.column
    ) {
      return el;
    }
  }
  return null;
}

function hasAccessibleContentJsx(element: JsxElement): boolean {
  // Direct text content
  if (jsxTextContent(element).length > 0) return true;
  // aria-label provides an accessible name
  const ariaLabel = getJsxAttributeString(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  // aria-labelledby references an external label
  if (hasJsxAttribute(element, "aria-labelledby")) return true;
  // Runtime expression children — assume developer is computing content
  if (hasExpressionChild(element)) return true;
  // Check for child <img> with alt text
  if (hasChildImageWithAltJsx(element)) return true;
  return false;
}

function hasExpressionChild(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind === "JsxExpression") return true;
  }
  return false;
}

function hasChildImageWithAltJsx(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName === "img") {
      const alt = getJsxAttributeString(child, "alt");
      if (alt !== null && alt.trim().length > 0) return true;
    }
    // PascalCase components might render accessible content
    if (/^[A-Z]/.test(child.tagName)) return true;
    if (hasChildImageWithAltJsx(child)) return true;
  }
  return false;
}

/**
 * Walks backwards from index `i` and returns the nearest preceding
 * heading that actually carries text. Anchors the fix text in the
 * document's surrounding outline — "Empty <h3> follows <h2>Contact
 * Information</h2>" rather than the generic "Add descriptive text"
 * that the previous builder emitted. Returns `null` when no such
 * heading exists (empty heading at the top of the document).
 */
function findPrecedingNonEmpty(headings: readonly HeadingEntry[], i: number): HeadingEntry | null {
  for (let j = i - 1; j >= 0; j--) {
    const prev = headings[j];
    if (prev !== undefined && prev.text.length > 0) return prev;
  }
  return null;
}

function emitViolation(entry: HeadingEntry, preceding: HeadingEntry | null, emit: Emit): void {
  emit({
    severity: "error",
    location: { filePath: "", line: entry.line, column: entry.column },
    message: `<${entry.tagName}> is empty — it appears in the heading outline but describes no topic or purpose.`,
    suggestion: buildEmptyHeadingSuggestion(entry, preceding),
  });
}

/**
 * Conceded-uncertainty emit: heading content is interpolated by a
 * stripped Liquid/Jinja/ERB template directive (`{{ page.title }}`,
 * `<%= post.title %>`, `{% include … %}`). Static analysis cannot see
 * the rendered output, so the rule surfaces but at `warning` (not
 * `error`) with a structured `couldBeWrongBecause` code naming the
 * conceded-uncertainty axis. Per the AI-first consumer doctrine the
 * agent reads the warning + framing in one pass and decides whether
 * the binding can resolve to empty at runtime.
 */
function emitTemplateDirectiveViolation(entry: HeadingEntry, emit: Emit): void {
  const tag = `<${entry.tagName}>`;
  emit({
    severity: "warning",
    location: { filePath: "", line: entry.line, column: entry.column },
    message:
      `${tag} content is interpolated (template directive); ` +
      "verify rendered output is non-empty — static analysis stripped a " +
      "Liquid/Jinja/ERB expression so the heading's accessible name is " +
      "knowable only at render time. SC 2.4.6 requires headings describe " +
      "topic or purpose; an expression resolving to empty would silently " +
      "violate the criterion.",
    suggestion:
      `Confirm the template binding cannot resolve to empty (e.g. \`${tag}{{ page.title | default: "Untitled" }}</${entry.tagName}>\` ` +
      "or a fallback in the layout). If the binding is trusted to always " +
      "produce non-empty text, suppress at source with " +
      "`<!-- ra11y-disable semantics/empty-heading -->` to make the " +
      "dismissal durable across re-runs.",
    couldBeWrongBecause: [TEMPLATE_DIRECTIVE_INTERPOLATION_UNRESOLVED],
  });
}

/**
 * Conceded-uncertainty emit: heading is referenced by sibling JS that
 * performs a DOM-text mutation, so the empty-at-parse-time state may be
 * a render-time blip rather than a structural defect. Same shape as
 * {@link emitTemplateDirectiveViolation} on a different evidence axis —
 * surfaces at `warning` (not `error`) with the structured
 * {@link RUNTIME_INNERHTML_POPULATION} code so the agent can dismiss in
 * one read after confirming the runtime-fill path.
 */
function emitRuntimePopulationViolation(
  entry: HeadingEntry,
  element: HtmlElement,
  emit: Emit,
): void {
  const tag = `<${entry.tagName}>`;
  const ref = describeRuntimeReference(element);
  emit({
    severity: "warning",
    location: { filePath: "", line: entry.line, column: entry.column },
    message:
      `${tag} is empty at parse time but ${ref} is referenced by sibling JS that ` +
      "performs a DOM-text mutation (.innerHTML / .textContent / " +
      ".innerText / .insertAdjacentHTML). This looks like a skeleton-" +
      "loader or SPA placeholder filled at runtime; the heading's " +
      "accessible name is knowable only after the runtime mutation runs. " +
      "SC 2.4.6 requires headings describe topic or purpose; a mutation " +
      "that doesn't run, or runs to an empty string, would silently " +
      "violate the criterion.",
    suggestion:
      `Confirm the runtime-fill path always assigns non-empty text to ${ref} before AT can announce ${tag} ` +
      "(or supply a fallback `aria-label` so the heading carries an " +
      "accessible name even before the mutation runs). If the wiring is " +
      "trusted, suppress at source with `<!-- ra11y-disable " +
      "semantics/empty-heading -->` to make the dismissal durable across " +
      "re-runs.",
    couldBeWrongBecause: [RUNTIME_INNERHTML_POPULATION],
  });
}

/**
 * Picks the most informative selector to echo in the runtime-population
 * reason text — `id` first (canonical `getElementById` target), then
 * the first class token. Falls back to the bare tag when neither is
 * present (the gate predicate already required a referenced selector,
 * so this fallback is defensive only).
 */
function describeRuntimeReference(element: HtmlElement): string {
  const id = getHtmlAttribute(element, "id");
  if (id !== null && id.trim().length > 0) return `id="${id.trim()}"`;
  const cls = getHtmlAttribute(element, "class");
  if (cls !== null) {
    const first = cls.trim().split(/\s+/)[0];
    if (first !== undefined && first.length > 0) return `class=".${first}"`;
  }
  return `<${element.tagName.toLowerCase()}>`;
}

/**
 * Document-level gate: returns true when `source` contains any
 * DOM-text-mutation pattern that could populate visible text at runtime.
 * Mirrors the pattern set the V1 live-region runtime-mutation finder
 * uses (`.innerHTML =`, `.textContent =`, `.innerText =`,
 * `.insertAdjacentHTML(`, `.insertAdjacentText(`) so the two surfaces
 * agree on what counts as evidence of runtime DOM-text writing.
 *
 * Also recognizes the same patterns nested in template-literal HTML
 * islands (`<script>` body, `{onclick: "header.innerHTML = …"}`),
 * since the regex is shape-only and operates on raw source.
 */
function sourceContainsDomTextMutation(source: string): boolean {
  return DOM_TEXT_MUTATION_RE.test(source);
}

const DOM_TEXT_MUTATION_RE =
  /\.(?:innerHTML|outerHTML|textContent|innerText)\s*(?:=(?!=)|\+=)|\.insertAdjacent(?:HTML|Text)\s*\(/;

/**
 * Per-heading gate: returns true when at least one of the heading's
 * `id` or `class` tokens is referenced in `source` via a shape that
 * sibling JS uses to grab the element — `getElementById("X")`,
 * `querySelector("#X")`, `querySelector(".X")`, `querySelectorAll`, or
 * a bare-id property access (`X.innerHTML`, the legacy global-id
 * pattern). The check is intentionally not asserting that the
 * mutation site is wired to *this* element — that's the agent's job
 * with one Read; the predicate's job is to point at evidence the
 * heading is the kind of element runtime-population code reaches for.
 *
 * Conservative: an empty `id="X"` or `class=""` produces no tokens, so
 * the predicate fails closed and the rule falls through to the
 * plainly-empty `error` branch. The id/class string is also escaped
 * for regex literal use so values like `header[0]` don't smuggle a
 * character class into the pattern.
 */
function htmlElementReferencedByRuntimeMutation(element: HtmlElement, source: string): boolean {
  const tokens = collectIdAndClassTokens(element);
  if (tokens.length === 0) return false;
  for (const raw of tokens) {
    if (sourceReferencesToken(source, raw)) return true;
  }
  return false;
}

/**
 * Collects every id-or-class token on an element, trimming whitespace
 * and dropping empty entries. The empty-token guard matters because
 * `<h1 id="">` and `<h2 class="">` both produce one-element splits
 * whose only entry is the empty string — those would silently match
 * any source via the regex.
 */
function collectIdAndClassTokens(element: HtmlElement): readonly string[] {
  const tokens: string[] = [];
  const id = getHtmlAttribute(element, "id");
  if (id !== null) {
    const trimmed = id.trim();
    if (trimmed.length > 0) tokens.push(trimmed);
  }
  const cls = getHtmlAttribute(element, "class");
  if (cls !== null) {
    for (const token of cls.trim().split(/\s+/)) {
      if (token.length > 0) tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Returns true when `source` contains any of the three sibling-JS
 * lookup shapes that target this token: explicit `getElementById`,
 * `querySelector(All)?` with a `#id` / `.class` fragment, or a bare-id
 * global access. The bare-id branch is gated on an identifier-shaped
 * regex so class names that aren't valid JS idents don't silently
 * match the global-access pattern.
 */
function sourceReferencesToken(source: string, raw: string): boolean {
  const escaped = escapeRegex(raw);
  if (new RegExp(`getElementById\\s*\\(\\s*["'\`]${escaped}["'\`]`).test(source)) return true;
  if (new RegExp(`querySelector(?:All)?\\s*\\(\\s*["'\`][^"'\`]*[#.]${escaped}\\b`).test(source)) {
    return true;
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(raw)) return false;
  return new RegExp(
    `\\b${escaped}\\s*\\.\\s*(?:innerHTML|outerHTML|textContent|innerText|insertAdjacent(?:HTML|Text))\\b`,
  ).test(source);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Four-branch ladder that inlines the document's actual surrounding
 * heading outline into the fix text:
 *
 * 1. Preceding heading one level higher (`<h2>` before `<h3>`) —
 *    canonical "continue the hierarchy" case. Names the parent
 *    heading's text so the agent can pick a sibling title.
 * 2. Preceding heading at the same level — sibling branch. Suggests
 *    the next section's title or removal.
 * 3. Preceding heading at any other level (lower, or a skip) —
 *    flags the hierarchy irregularity alongside the fill/remove
 *    choice so the agent knows to check `semantics/heading-hierarchy`.
 * 4. No preceding heading — top-of-document fallback. Names the
 *    screen-reader navigation gap an empty heading creates and
 *    retains the styled-`<p>`/`<div>` alternative.
 *
 * The final clause of every branch retains the "or remove the
 * heading" option so the spec-anchored remediation (add content or
 * stop being a heading) is always one of the two paths.
 */
function buildEmptyHeadingSuggestion(entry: HeadingEntry, preceding: HeadingEntry | null): string {
  const tag = `<${entry.tagName}>`;
  if (preceding === null) {
    return `Empty ${tag} at start of document — fill with the page's primary section title or remove the heading; screen readers announce heading levels, so an empty heading creates a navigation gap. If the heading is used for visual styling only, replace it with a styled <p> or <div>.`;
  }
  const prevTag = `<${preceding.tagName}>`;
  const prevText = truncate(preceding.text, 80);
  const prevSnippet = `${prevTag}${prevText}</${preceding.tagName}>`;
  if (preceding.level === entry.level - 1) {
    return `Empty ${tag} follows ${prevSnippet} at line ${preceding.line} — fill with a subsection title that continues the "${prevText}" hierarchy, or remove the heading if no section follows.`;
  }
  if (preceding.level === entry.level) {
    return `Empty ${tag} follows a sibling ${prevSnippet} at line ${preceding.line} — fill with the next section's title, or remove if this heading was left empty by mistake.`;
  }
  return `Empty ${tag} — heading hierarchy appears broken (previous heading was ${prevSnippet} at line ${preceding.line}, level h${preceding.level} before this h${entry.level}). Fill with a title that fits the outline or remove the heading; check semantics/heading-hierarchy for the level sequence.`;
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

function emitPrimitiveViolation(tagName: string, line: number, column: number, emit: Emit): void {
  emit({
    severity: "info",
    location: { filePath: "", line, column },
    message: `<${tagName}> has no visible children but receives {...spread} props — this looks like a component primitive (MDX override, styled heading). Whether the heading is empty at render time depends on what the caller passes. Verify at usage sites.`,
    suggestion: `If the component is only ever called with children, this is fine — add \`{/* ra11y-disable semantics/empty-heading */}\` at the top of the file to silence this info note. Otherwise ensure every call site passes text content.`,
  });
}
