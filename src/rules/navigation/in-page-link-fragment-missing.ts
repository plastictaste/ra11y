/**
 * Rule: navigation/in-page-link-fragment-missing
 * Satisfies: wcag22:2.4.1, wcag21:2.4.1
 * Spec: https://www.w3.org/TR/WCAG22/#bypass-blocks
 *
 * > A mechanism is available to bypass blocks of content that are
 * > repeated on multiple Web pages.
 *
 * Source: https://www.w3.org/TR/WCAG22/#bypass-blocks
 *
 * Flags `<a href="#some-id">` where `#some-id` is a non-empty fragment
 * but no element in the same document carries `id="some-id"` (and no
 * legacy `<a name="some-id">` either). A dangling in-page link
 * announces as navigation but lands nowhere — the browser scrolls to
 * top and focus is not advanced, breaking skip-link / table-of-contents
 * / "back to top" affordances that 2.4.1 (Bypass Blocks) and the
 * surrounding navigable-block guidance assume work.
 *
 * Out of scope (silent):
 *
 *   - `href="#"` — bare placeholder; covered by
 *     `navigation/href-empty-fragment`.
 *   - `href="#top"` — universal browser convention for top-of-page;
 *     scrolls to document top regardless of whether an `id="top"`
 *     element exists. Spec'd by HTML
 *     (https://html.spec.whatwg.org/multipage/browsing-the-web.html#scroll-to-the-fragment-identifier).
 *   - Cross-document links (`/path#id`, `https://…#id`) — id resolution
 *     would require fetching another file at scan time; out of static
 *     analysis scope.
 *   - Fragment files (`_includes/`, `_partials/`, `partials/`,
 *     `components/`, files with `---` front-matter, files with no
 *     `<html>`/`<body>`/`<head>`) — the target id may be supplied by
 *     the composing parent layout, OR by another fragment composed
 *     into the same rendered page. The predicate "no element with
 *     this id exists in the rendered DOM" is structurally
 *     unverifiable from a single fragment file, so the rule omits
 *     emission entirely on fragment-classified input. Per the AI-first
 *     consumer doctrine bullet "Heuristic emission is the symmetric
 *     twin of heuristic suppression" — emitting on speculation about
 *     composition (even at `info` severity with a `couldBeWrongBecause`
 *     hedge) leaks heuristic uncertainty into a slot the agent reads
 *     as "the scanner saw evidence of this." The honest shape is
 *     omission; the rule's `coverageConfidence` is downgraded to
 *     `medium` with reason `fragment-input-no-document-envelope` via
 *     the `FRAGMENT_DOWNGRADE_RULE_IDS` set in
 *     `src/mcp/scan-assembly.ts` so the agent sees scan-confidence
 *     telemetry for the unevaluated branch rather than a silent zero.
 *   - JSX expression-form `href={url}` — opaque at static time, per the
 *     AI-first consumer doctrine surface only deterministic evidence.
 *
 * Implementation notes:
 *
 *   1. The rule is document-scoped (`afterFile`). Both the link and
 *      the target id must live in the same file for the check to be
 *      meaningful — cross-file id resolution is not in scope.
 *
 *   2. HTML id lookup is compared **case-sensitively**. The HTML spec
 *      defines ids as ASCII case-sensitive
 *      (https://html.spec.whatwg.org/multipage/dom.html#the-id-attribute);
 *      browsers in standards mode follow that. Quirks-mode legacy
 *      behavior is intentionally not honored — authored content should
 *      be portable across modes.
 *
 *   3. Legacy `<a name="X">` anchors satisfy `href="#X"` per HTML
 *      browser behavior (the name maps to the same fragment-resolution
 *      table as id). Including `name` on the lookup avoids false
 *      positives on older content (HTML4 / XHTML 1.0 idioms). Restricted
 *      to `<a>` elements (the only element that ever supported `name`
 *      as a fragment target) — `<form name="…">`, `<iframe name="…">`,
 *      etc. are submission / target-window names, not fragment anchors.
 *
 *   4. `href="#"` and `href=""` are claimed by
 *      `navigation/href-empty-fragment`. We exit before classification
 *      so the two surfaces don't double-report.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import { isFragmentFile } from "../../engine/layout-partial.ts";
import type { HtmlDocument, TsxModule } from "../../types/ast.ts";
import { isDomOriginExtension } from "../../utils/path.ts";

export const rule = defineRule({
  id: "navigation/in-page-link-fragment-missing",
  satisfies: ["wcag22:2.4.1", "wcag21:2.4.1"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Flags <a href="#some-id"> whose fragment id has no matching element in the same document — the link announces as in-page navigation but lands nowhere. The bare `#`, the universal `#top` convention, cross-document links (`/path#id`), and JSX expression-form href={…} are intentionally out of scope.',
    rationale:
      "An anchor with a fragment href promises the user that activating it will navigate to (and focus) a named region of the same page. When the named region does not exist, the browser silently scrolls to the document top and leaves focus at the link — the user hears 'link', activates it, and either nothing visible happens or focus order breaks. This is the failure mode 2.4.1 (Bypass Blocks) and the surrounding navigable-block criteria assume cannot occur: skip links, table-of-contents anchors, and 'back to top' / 'jump to section' affordances all depend on the fragment resolving. The check is deterministic over the parsed document — id collection is one pass over every element, the lookup is case-sensitive per the HTML spec — so a dangling reference is structural, not a heuristic guess.\n\nLegacy `<a name='X'>` anchors satisfy `href='#X'` per browser fragment-resolution behavior; the lookup includes both `id` and `<a name>` so HTML4 / XHTML 1.0 idioms don't produce false positives. Fragment files (front-matter, fragment-convention paths, no document envelope) are omitted from emission entirely because the target id may be supplied by the composing parent layout or a sibling fragment — the predicate 'no element with this id exists in the rendered DOM' is structurally unverifiable from one fragment file. Per the AI-first consumer doctrine bullet 'Heuristic emission is the symmetric twin of heuristic suppression', emitting on speculation about composition (even at `info` with a hedge code) leaks heuristic uncertainty into a slot the agent reads as 'the scanner saw evidence of this.' Scan-confidence is preserved via the `FRAGMENT_DOWNGRADE_RULE_IDS` set in `src/mcp/scan-assembly.ts`, which downgrades `perRuleCoverage[].coverageConfidence` to `medium` with reason `fragment-input-no-document-envelope` for fragment-classified files in the scan.",
    goodExample: `<a href="#main">Skip to main content</a>\n<main id="main"><h1>Page</h1></main>`,
    badExample: `<a href="#main-contnet">Skip to main content</a>\n<main id="main-content"><h1>Page</h1></main>`,
    normativeQuote:
      "A mechanism is available to bypass blocks of content that are repeated on multiple Web pages.",
    references: [
      "https://www.w3.org/TR/WCAG22/#bypass-blocks",
      "https://html.spec.whatwg.org/multipage/browsing-the-web.html#scroll-to-the-fragment-identifier",
      "https://html.spec.whatwg.org/multipage/dom.html#the-id-attribute",
    ],
    knownLimitations: [
      "single-file scope: cross-document fragment links (/path#id, https://…#id) are not validated because the target file's id table is not loaded at scan time",
      "JSX expression-form href={url} is opaque at static analysis — only string-literal href values are checked",
    ],
  },
  afterFile(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, ctx.source, ctx.filePath, (v) => ctx.emit(v));
      return;
    }
    if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      // Belt-and-braces DOM-origin gate (mirrors navigation/href-empty-fragment):
      // an `<a href="#x">` substring inside a packed plugin or minified `.js`
      // bundle is not a real anchor — the surrounding code may be a string-
      // template factory or a build-time interpolation. Only act on JSX nodes
      // parsed out of `.tsx` / `.jsx` (and the JSX-bearing `.mdx` / `.astro`
      // aliases).
      if (!isDomOriginExtension(ctx.filePath)) return;
      checkJsx(ctx.ast as TsxModule, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

/**
 * Classifies an href value into the fragment we should resolve, or `null`
 * when the rule should not fire on this href.
 *
 * Returns `null` for:
 *
 *   - empty / null / whitespace-only (`""`, `"   "`) — covered by
 *     `navigation/href-empty-fragment`.
 *   - bare `"#"` — covered by `navigation/href-empty-fragment`.
 *   - `"#top"` (case-insensitive) — universal browser convention for
 *     top-of-page; HTML spec defines this as a special-cased target
 *     irrespective of any `id="top"` element.
 *   - any href that is not a same-document fragment (`/foo#bar`,
 *     `https://…#bar`, `mailto:`, `javascript:`, …) — out of scope.
 *
 * Returns the fragment id (without the leading `#`) when the href is a
 * same-document fragment we should validate.
 */
function classifyFragmentHref(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "#") return null;
  if (trimmed[0] !== "#") return null;
  const fragment = trimmed.slice(1);
  if (fragment.length === 0) return null;
  // Universal browser convention: `#top` always scrolls to document top
  // even without an `id="top"` element. Spec'd by the HTML "scroll to
  // the fragment identifier" algorithm.
  if (fragment.toLowerCase() === "top") return null;
  // Template-directive escape hatch: `href="#{{ section.slug }}"`,
  // `href="#{% if cond %}foo{% endif %}"`, ERB `<%= … %>`, Handlebars
  // `{{ }}`, or any mix thereof. The runtime fragment value is
  // computed by the template engine; the static scanner cannot know
  // the rendered id, and the literal token (`{{ section.slug }}`)
  // never lands as a real DOM fragment. Skipping is honest — the
  // alternative would be the rule echoing raw template tokens at the
  // agent as "the missing id," which is the failure mode covered by
  // tests/integration/liquid-raw-directive-no-quote.test.ts.
  if (containsTemplateDirective(fragment)) return null;
  return fragment;
}

/**
 * True when the string contains any template-engine directive token —
 * Liquid / Jinja / Handlebars (`{{`, `}}`, `{%`, `%}`) or ERB
 * (`<%`, `%>`). Match is substring-anywhere because a templated
 * fragment can take many shapes (`#{{slug}}`, `#chapter-{{ n }}`,
 * `#{%- raw -%}foo{%- endraw -%}`) and the only honest classification
 * is "this is computed at render time, the static scanner can't
 * resolve it."
 */
function containsTemplateDirective(s: string): boolean {
  return (
    s.includes("{{") ||
    s.includes("}}") ||
    s.includes("{%") ||
    s.includes("%}") ||
    s.includes("<%") ||
    s.includes("%>")
  );
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, source: string, filePath: string, emit: Emit): void {
  const anchors = findHtmlElementsByTag(doc, "a");
  if (anchors.length === 0) return;
  // Fragment-classified files: omit emission entirely. The predicate
  // ("no element with this id exists in the rendered DOM") is
  // structurally unverifiable from a single fragment — the target id
  // may be supplied by the composing parent layout or a sibling
  // fragment composed into the same rendered page. Per the AI-first
  // consumer doctrine bullet "Heuristic emission is the symmetric
  // twin of heuristic suppression", emitting at any severity (even
  // `info` with a `couldBeWrongBecause` hedge) leaks heuristic
  // uncertainty into a slot the agent reads as "the scanner saw
  // evidence of this." Scan-confidence is preserved via the
  // `FRAGMENT_DOWNGRADE_RULE_IDS` set in `src/mcp/scan-assembly.ts`,
  // which downgrades this rule's `perRuleCoverage` row to `medium`
  // with reason `fragment-input-no-document-envelope` so the absence
  // of findings on fragment-classified files is visible as
  // scan-confidence telemetry rather than a silent zero.
  if (isFragmentFile(doc, source, filePath)) return;
  // One pass to collect every fragment-resolvable target. Includes both
  // `id` (modern) and `<a name="…">` (legacy) so HTML4 / XHTML 1.0
  // idioms don't produce false positives.
  const targets = collectHtmlFragmentTargets(doc);
  for (const anchor of anchors) {
    const hrefValue = getHtmlAttribute(anchor, "href");
    const id = classifyFragmentHref(hrefValue);
    if (id === null) continue;
    if (targets.has(id)) continue;
    emit(buildViolation(anchor.loc.start, id, targets));
  }
}

function collectHtmlFragmentTargets(doc: HtmlDocument): Set<string> {
  const targets = new Set<string>();
  for (const el of walkHtmlElements(doc)) {
    const id = getHtmlAttribute(el, "id");
    if (id !== null && id.length > 0) targets.add(id);
    // `<a name="…">` is the legacy fragment-target form. Restricted to
    // `<a>` elements — `<form name>`, `<iframe name>`, etc. are
    // submission / target-window names, not fragment anchors.
    if (el.tagName.toLowerCase() === "a") {
      const name = getHtmlAttribute(el, "name");
      if (name !== null && name.length > 0) targets.add(name);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  const anchors = findJsxElementsByTag(module, "a");
  if (anchors.length === 0) return;
  const targets = collectJsxFragmentTargets(module);
  // No JSX-side fragment-file detection — the layout-partial helper is
  // HTML-AST-shaped. JSX components are typically composed at runtime
  // via React's render tree; "fragment vs full page" is not a
  // statically-knowable property of a `.tsx` file. The HTML branch's
  // omit-on-fragment behavior has no JSX analogue because the static
  // signal is absent; per "surface, don't suppress" we keep emitting
  // on JSX where the evidence exists in-file.
  for (const anchor of anchors) {
    const hrefValue = getJsxAttributeString(anchor, "href");
    if (hrefValue === null) continue;
    const id = classifyFragmentHref(hrefValue);
    if (id === null) continue;
    if (targets.has(id)) continue;
    emit(buildViolation(anchor.loc.start, id, targets));
  }
}

function collectJsxFragmentTargets(module: TsxModule): Set<string> {
  const targets = new Set<string>();
  for (const el of walkJsxElements(module)) {
    const id = getJsxAttributeString(el, "id");
    if (id !== null && id.length > 0) targets.add(id);
    if (el.tagName === "a") {
      const name = getJsxAttributeString(el, "name");
      if (name !== null && name.length > 0) targets.add(name);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function buildViolation(
  loc: { line: number; column: number },
  id: string,
  targets: ReadonlySet<string>,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const nearest = findNearestId(id, targets);
  const message = `anchor links to fragment \`#${id}\` but no element with that id exists in this document. Verify the id is added or correct the href.`;
  const suggestion = nearest
    ? `Did you mean \`href="#${nearest}"\`? Either change the link to \`href="#${nearest}"\` or add \`id="${id}"\` to the element this link should target.`
    : `Add \`id="${id}"\` to the element this link should target, or change the href to a fragment that matches an existing id in this document.`;
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message,
    suggestion,
  };
}

/**
 * Returns the existing id whose string is closest to `target` by
 * Levenshtein distance, provided the distance is ≤2 (typical typo
 * range). Returns null if no id is within distance. Borrows the same
 * recipe as `forms/label-for-id-mismatch`.
 */
function findNearestId(target: string, ids: ReadonlySet<string>): string | null {
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const d = levenshtein(target, id);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  const MAX_TYPO_DISTANCE = 2;
  return bestDist <= MAX_TYPO_DISTANCE ? best : null;
}

/** Standard Levenshtein edit distance. O(n*m) space and time. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n] ?? 0;
}
