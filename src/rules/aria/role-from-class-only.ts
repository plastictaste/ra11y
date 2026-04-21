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
import type { HtmlDocument, TsxModule } from "../../types/ast.ts";

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
    const text = htmlTextContent(el);
    if (hasSeveritySignalInText(text, hits)) continue;
    emit(buildViolation(el.tagName, el.loc.start, hits, role, text));
  }
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const el of walkJsxElements(module)) {
    const candidate = prepareJsxCandidate(el);
    if (candidate === null) continue;
    emit(buildViolation(el.tagName, el.loc.start, candidate.hits, candidate.role, candidate.text));
  }
}

interface JsxCandidate {
  readonly hits: readonly string[];
  readonly role: string | null;
  readonly text: string;
}

/** Returns the fields needed to build a violation, or null if the element is not a naked admonition. */
function prepareJsxCandidate(el: import("../../types/ast.ts").JsxElement): JsxCandidate | null {
  if (isComponent(el.tagName)) return null;
  const classAttr = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (classAttr === null) return null;
  const hits = admonitionHits(classAttr);
  if (hits.length === 0) return null;
  const role = getJsxAttributeString(el, "role");
  if (hasSatisfyingRole(role)) return null;
  if (hasSuppressingRole(role)) return null;
  const text = jsxTextContent(el);
  if (hasSeveritySignalInText(text, hits)) return null;
  return { hits, role, text };
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
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const hitList = hits.map((h) => `"${h}"`).join(", ");
  const primary = primaryHit(hits);
  const suggestedRole = suggestRole(primary);
  const suggestedPrefix = suggestPrefix(primary);
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
