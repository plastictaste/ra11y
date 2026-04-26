/**
 * Rule: aria/role-from-class-only
 * Satisfies: wcag22:1.3.3, wcag21:1.3.3, wcag22:1.4.1, wcag21:1.4.1, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 * Related: https://www.w3.org/TR/WCAG22/#use-of-color, https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * > Instructions provided for understanding and operating content do not
 * > rely solely on sensory characteristics of components such as shape,
 * > color, size, visual location, orientation, or sound. (SC 1.3.3)
 *
 * > Color is not used as the only visual means of conveying information,
 * > indicating an action, prompting a response, or distinguishing a
 * > visual element. (SC 1.4.1)
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags admonition-styled elements whose severity is conveyed *only*
 * through a class name (and, by stylesheet, color) with no programmatic
 * role and no textual severity prefix. The canonical pattern:
 *
 *   <div class="note warning">Don't forget to run bundle install.</div>
 *
 * Sighted users see a coloured callout labelled by the CSS theme as a
 * warning; assistive-tech users hear the inner text with no severity
 * signal — the admonition kind is invisible. This is both a 1.4.1
 * (colour-only indicator) and 1.3.3 (sensory-only instruction) failure
 * plus a 4.1.2 gap because the role conveyed visually is not exposed
 * programmatically.
 *
 * A well-formed admonition resolves the gap one of three ways:
 *   1. Add a landmark role that expresses the severity —
 *      `role="alert"` / `role="status"` / `role="note"`.
 *   2. Start the visible text with a severity prefix — "Warning:",
 *      "Note:", "Tip:" — so the label is part of the accessible name.
 *   3. Nest the severity word in a child element whose text the rule
 *      finds (e.g. `<strong>Warning</strong> …`).
 *
 * Class-name trigger set (case-insensitive, whole-word match): `note`,
 * `warning`, `alert`, `tip`, `info`, `caution`, `danger`, `success`.
 * These are the admonition names used by Jekyll, Hugo, MkDocs,
 * Docusaurus, Astro Starlight, and Bootstrap-adjacent kits. A class
 * like `noteworthy` does not match because the regex is word-bounded.
 *
 * Heading-as-label refinement: when the wrapper's first element child is
 * a heading (`<h1>`-`<h6>`) AND the heading's textContent is itself a
 * severity word from the dictionary (e.g. `<h5>Tip</h5>`,
 * `<h3>Warning</h3>`), the heading carries the severity label both
 * structurally and semantically — assistive tech announces "heading
 * level N: Tip" which gives the user the severity word as the announced
 * label. The finding still surfaces, but at `info` severity with a
 * candidate-style reason ("first child heading carries the severity word
 * — verify the visual/AT mapping rather than adding role"), so the agent
 * can confirm by reading the file rather than budgeting against a
 * `warning` for a case the predicate is mostly satisfied. This narrows
 * the previous blanket heading-first-child skip — a heading whose text
 * is "Topic" or "Breaking change" provides structure but no severity
 * signal, so the original `warning` fire still applies.
 *
 * Out of scope:
 *   - Kramdown IAL ({: .note .warning}) — markdown input isn't parsed yet.
 *   - Status-colored inline text ("errors in red") — that's the broader
 *     color-sole-indicator check, not admonition-widget-specific.
 *   - Image-based severity icons — those are already covered by
 *     alt-text rules.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

/**
 * Admonition class names. Whole-word match, case-insensitive. `info` is
 * included despite its generic feel because the Jekyll/Bootstrap
 * convention (`alert-info`, `.info`) treats it as a severity tier.
 */
const ADMONITION_CLASSES: ReadonlySet<string> = new Set([
  "note",
  "warning",
  "alert",
  "tip",
  "info",
  "caution",
  "danger",
  "success",
]);

/**
 * Roles that carry a programmatic severity/importance signal and
 * therefore satisfy the "name the admonition" requirement. `alert` and
 * `status` are live regions; `note` is a landmark-ish container the
 * WAI-ARIA spec defines explicitly for asides.
 */
const SEVERITY_ROLES: ReadonlySet<string> = new Set(["alert", "alertdialog", "note", "status"]);

/**
 * Interactive/structural roles that mean "this is not a plain block" —
 * if the author has explicitly claimed one of these, the element is not
 * a naked admonition and we skip it to avoid false positives on (e.g.)
 * `<div class="alert" role="button">`.
 */
const SUPPRESSING_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "tab",
  "tabpanel",
  "dialog",
  "menu",
  "menuitem",
  "listbox",
  "option",
  "combobox",
  "switch",
  "checkbox",
  "radio",
  "textbox",
  "progressbar",
  "img",
  "presentation",
  "none",
]);

/**
 * Heading tag names (lowercased). When the first ELEMENT child of an
 * admonition wrapper is one of these AND the heading's textContent is a
 * severity word, the heading carries the severity label that AT
 * announces ("heading level N: Tip"). The role-from-class-only premise
 * (severity invisible without role-or-prefix) is then mostly satisfied
 * — we soft-fire at `info` rather than `warning` so the agent verifies
 * the visual/AT mapping rather than reflexively adding `role`. A
 * non-severity heading text ("Topic", "Breaking change") provides
 * structure but no severity signal, so the original `warning` still
 * applies.
 */
const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Severity-word dictionary used to test heading textContent. Mirrors the
 * `SEVERITY_LEADING_WORD` regex but as a set so we can match the heading
 * text after trimming/normalizing. Includes a few near-synonyms
 * (`important`, `notes`, `tips`) the prefix regex also accepts.
 */
const SEVERITY_HEADING_WORDS: ReadonlySet<string> = new Set([
  "note",
  "notes",
  "warning",
  "warnings",
  "alert",
  "alerts",
  "tip",
  "tips",
  "info",
  "caution",
  "danger",
  "important",
  "success",
]);

/** Case-insensitive severity prefix pattern — first non-whitespace token. */
const SEVERITY_PREFIX =
  /^\s*(note|notes?|warning|warnings?|alert|alerts?|tip|tips?|info|caution|danger|important|success)\b[:!\s]/iu;

/** Standalone severity word appearing as first token (e.g. `<strong>Warning</strong> ...`). */
const SEVERITY_LEADING_WORD =
  /^\s*(note|warning|alert|tip|info|caution|danger|important|success)\b/iu;

export const rule = defineRule({
  id: "aria/role-from-class-only",
  satisfies: [
    "wcag22:1.3.3",
    "wcag21:1.3.3",
    "wcag22:1.4.1",
    "wcag21:1.4.1",
    "wcag22:4.1.2",
    "wcag21:4.1.2",
  ],
  severity: "warning",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Admonition-styled elements (class=note/warning/alert/tip/info/…) must expose their severity through a role or textual prefix — class-plus-color alone is invisible to assistive tech.",
    rationale:
      'A block styled as a coloured "Warning" or "Note" callout communicates severity to sighted users through CSS, but the underlying markup (`<div class="warning">…</div>`) has no programmatic role and no textual label. Screen reader users hear the inner text with the severity stripped, so an instruction like "Don\'t forget to run bundle install" loses its "warning" framing. WCAG 1.4.1 prohibits colour as the sole indicator; 1.3.3 prohibits sensory-only instructions; 4.1.2 requires that role be programmatically exposed. Fix by adding role="alert" / "status" / "note" (live-region or landmark), or by prefixing the visible text with the severity word ("Warning: …") so it becomes part of the accessible name.',
    goodExample: `<div class="note warning" role="alert">
  <strong>Warning:</strong> Don't forget to run bundle install.
</div>`,
    badExample: `<div class="note warning">Don't forget to run bundle install.</div>`,
    normativeQuote:
      "Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#use-of-color",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G182",
      "https://www.w3.org/TR/wai-aria-1.2/#alert",
      "https://www.w3.org/TR/wai-aria-1.2/#note",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
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

type Loc = { readonly line: number; readonly column: number };

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const el of walkHtmlElements(doc)) {
    const classAttr = getHtmlAttribute(el, "class");
    if (classAttr === null) continue;
    const hits = admonitionHits(classAttr);
    if (hits.length === 0) continue;
    const role = getHtmlAttribute(el, "role");
    if (hasSatisfyingRole(role)) continue;
    if (hasSuppressingRole(role)) continue;
    const headingFirst = firstChildHeadingHtml(el);
    const headingSeverity = headingFirst === null ? null : severityFromHeadingText(headingFirst);
    const text = htmlTextContent(el);
    if (headingSeverity === null && hasSeveritySignalInText(text, hits)) continue;
    emit(buildViolation(el.tagName, el.loc.start, hits, role, text, headingSeverity));
  }
}

/**
 * Returns the first ELEMENT child of `el` if it is `<h1>`-`<h6>`, else
 * null. Whitespace text nodes, comments, and doctypes between the
 * wrapper open tag and the heading are ignored — they're formatting
 * artifacts, not structural children. A non-whitespace text node before
 * the heading defeats the pattern: the leading prose is what AT users
 * hear first, so the heading is no longer functioning as the announced
 * label.
 */
function firstChildHeadingHtml(el: HtmlElement): HtmlElement | null {
  for (const child of el.children) {
    if (child.kind === "HtmlComment" || child.kind === "HtmlDoctype") continue;
    if (child.kind === "HtmlText") {
      if (child.value.trim().length === 0) continue;
      return null;
    }
    // child.kind === "HtmlElement"
    if (HEADING_TAGS.has(child.tagName.toLowerCase())) return child;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const el of walkJsxElements(module)) {
    const candidate = prepareJsxCandidate(el);
    if (candidate === null) continue;
    emit(
      buildViolation(
        el.tagName,
        el.loc.start,
        candidate.hits,
        candidate.role,
        candidate.text,
        candidate.headingSeverity,
      ),
    );
  }
}

interface JsxCandidate {
  readonly hits: readonly string[];
  readonly role: string | null;
  readonly text: string;
  readonly headingSeverity: string | null;
}

/** Returns the fields needed to build a violation, or null if the element is not a naked admonition. */
function prepareJsxCandidate(el: JsxElement): JsxCandidate | null {
  if (isComponent(el.tagName)) return null;
  const classAttr = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (classAttr === null) return null;
  const hits = admonitionHits(classAttr);
  if (hits.length === 0) return null;
  const role = getJsxAttributeString(el, "role");
  if (hasSatisfyingRole(role)) return null;
  if (hasSuppressingRole(role)) return null;
  const headingFirst = firstChildHeadingJsx(el);
  const headingSeverity = headingFirst === null ? null : severityFromJsxHeadingText(headingFirst);
  const text = jsxTextContent(el);
  if (headingSeverity === null && hasSeveritySignalInText(text, hits)) return null;
  return { hits, role, text, headingSeverity };
}

/**
 * JSX analogue of {@link firstChildHeadingHtml}. Whitespace-only
 * `JsxText` nodes are ignored (JSX formatting artifact); a non-whitespace
 * `JsxText` or any `JsxExpression` child before the heading defeats the
 * pattern. Component children (PascalCase) are not considered headings —
 * we can't see what they render.
 */
function firstChildHeadingJsx(el: JsxElement): JsxElement | null {
  for (const child of el.children) {
    if (child.kind === "JsxText") {
      if (child.value.trim().length === 0) continue;
      return null;
    }
    if (child.kind === "JsxExpression") return null;
    // child.kind === "JsxElement"
    if (isComponent(child.tagName)) return null;
    if (HEADING_TAGS.has(child.tagName.toLowerCase())) return child;
    return null;
  }
  return null;
}

/**
 * Returns the lowercased severity word if the heading's textContent is
 * a single severity word from {@link SEVERITY_HEADING_WORDS}, else null.
 * Strips trailing punctuation (`Tip:`, `Warning!`) before matching so
 * the common author shorthand still resolves. Multi-word headings like
 * "Performance note" do NOT match — the heading is a topic label, not
 * a severity announcement.
 */
function severityFromHeadingText(heading: HtmlElement): string | null {
  return matchSeverityHeadingWord(htmlTextContent(heading));
}

function severityFromJsxHeadingText(heading: JsxElement): string | null {
  return matchSeverityHeadingWord(jsxTextContent(heading));
}

function matchSeverityHeadingWord(rawText: string): string | null {
  const trimmed = rawText.trim().replace(/[\s ]+/gu, " ");
  if (trimmed.length === 0) return null;
  // Strip a single trailing punctuation char (`Tip:`, `Warning!`, `Note.`)
  // before testing — authors commonly write the heading as a label.
  const stripped = trimmed.replace(/[:!.—–-]+$/u, "").trim();
  if (stripped.length === 0) return null;
  // Reject anything with internal whitespace — "Performance note" /
  // "Breaking change" are topic labels, not severity announcements.
  if (/\s/u.test(stripped)) return null;
  const lower = stripped.toLowerCase();
  return SEVERITY_HEADING_WORDS.has(lower) ? lower : null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Returns the admonition class tokens present in `classValue`, preserving
 * source order and original casing so the violation message can echo
 * what the author wrote. Duplicates are collapsed.
 */
function admonitionHits(classValue: string): readonly string[] {
  const tokens = classValue.split(/\s+/u).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (!ADMONITION_CLASSES.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(tok);
  }
  return out;
}

function hasSatisfyingRole(role: string | null): boolean {
  if (role === null) return false;
  const tokens = role.trim().split(/\s+/u);
  for (const t of tokens) if (SEVERITY_ROLES.has(t.toLowerCase())) return true;
  return false;
}

function hasSuppressingRole(role: string | null): boolean {
  if (role === null) return false;
  const tokens = role.trim().split(/\s+/u);
  for (const t of tokens) if (SUPPRESSING_ROLES.has(t.toLowerCase())) return true;
  return false;
}

/**
 * True if the visible text starts with a severity prefix ("Warning:", "Note —",
 * "Tip!") or leads with a bare severity word (as produced by
 * `<strong>Warning</strong> …`). `hits` is passed in so a block classed as
 * `warning` is still considered labeled when it begins with the word
 * "Note" — any recognised severity word counts, not just the matching one.
 */
function hasSeveritySignalInText(text: string, _hits: readonly string[]): boolean {
  if (text.length === 0) return false;
  if (SEVERITY_PREFIX.test(text)) return true;
  if (SEVERITY_LEADING_WORD.test(text)) return true;
  return false;
}

function isComponent(tagName: string): boolean {
  const first = tagName[0];
  return first !== undefined && first >= "A" && first <= "Z";
}

function buildViolation(
  tagName: string,
  loc: Loc,
  hits: readonly string[],
  role: string | null,
  text: string,
  headingSeverity: string | null,
): {
  severity: "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const hitList = hits.map((h) => `"${h}"`).join(", ");
  const primary = primaryHit(hits);
  const suggestedRole = suggestRole(primary);
  const suggestedPrefix = suggestPrefix(primary);
  if (headingSeverity !== null) {
    // Heading-as-label refinement: the wrapper's first child is a
    // heading whose text is itself a severity word. AT announces
    // "heading level N: <severity-word>", which gives the user the
    // severity label as the announced heading. The role/severity gap
    // is mostly closed; surface as a soft candidate at info severity
    // so the agent verifies the visual/AT mapping rather than
    // reflexively adding role.
    return {
      severity: "info",
      location: { filePath: "", line: loc.line, column: loc.column },
      message: `<${tagName}> uses admonition class ${hitList} and the first child heading reads "${headingSeverity}" — assistive tech announces "heading level N: ${headingSeverity}", which carries the severity label. Verify the visual/AT mapping rather than reflexively adding a role.`,
      suggestion: `The first child heading's text "${headingSeverity}" matches a severity-word dictionary, so the wrapper's accessible label is likely already announced via the heading. If the visual treatment matches the announced word, no change is needed. If you want belt-and-braces, add role="${suggestedRole}" so the live-region behaviour is also exposed.`,
    };
  }
  const textPreview = previewText(text);
  const rolePhrase = role === null ? "no role attribute" : `role="${role}" (no severity signal)`;
  const textPhrase =
    textPreview === null
      ? "no visible text"
      : `visible text "${textPreview}" carries no severity word`;
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `<${tagName}> uses admonition class ${hitList} but has ${rolePhrase} and the ${textPhrase} — assistive tech users receive the content with the severity signal stripped.`,
    suggestion: `Either add role="${suggestedRole}" so screen readers announce the severity, or begin the visible text with "${suggestedPrefix}" (e.g. "${suggestedPrefix} ${exampleBody(text)}") so the label is part of the accessible name. Styling alone is invisible to assistive tech.`,
  };
}

function primaryHit(hits: readonly string[]): string {
  // Prefer the most specific severity when multiple classes appear:
  // `alert` / `danger` / `warning` / `caution` / `success` / `tip` / `info` / `note`.
  const order = ["alert", "danger", "warning", "caution", "success", "tip", "info", "note"];
  for (const want of order) {
    for (const h of hits) if (h.toLowerCase() === want) return want;
  }
  const first = hits[0];
  return first === undefined ? "note" : first.toLowerCase();
}

function suggestRole(primary: string): string {
  if (primary === "alert" || primary === "danger" || primary === "warning") return "alert";
  if (primary === "success" || primary === "info") return "status";
  return "note";
}

function suggestPrefix(primary: string): string {
  const upper = primary.charAt(0).toUpperCase() + primary.slice(1);
  return `${upper}:`;
}

function previewText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}…`;
}

function exampleBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "…";
  const words = trimmed.split(/\s+/u).slice(0, 5).join(" ");
  return words.length > 40 ? `${words.slice(0, 37)}…` : words;
}
