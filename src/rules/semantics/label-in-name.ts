/**
 * Rule: semantics/label-in-name
 * Satisfies: wcag22:2.5.3, wcag21:2.5.3
 * Spec: https://www.w3.org/TR/WCAG22/#label-in-name
 *
 * > For user interface components with labels that include text or
 * > images of text, the name contains the text that is presented
 * > visually.
 *
 * Source: https://www.w3.org/TR/WCAG22/#label-in-name
 *
 * Flags elements where aria-label does not contain the visible text
 * content as a case-insensitive substring. Only fires when both the
 * visible text and aria-label are non-empty string literals (skips
 * expressions to avoid false positives).
 *
 * Example violation: <button aria-label="Submit form">Send</button>
 * "Send" is not a substring of "Submit form".
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  truncateForEcho,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { FixPath, FixPaths } from "../../types/violation.ts";

/** Interactive elements whose visible label must be contained in their accessible name. */
const HTML_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "summary",
]);

export const rule = defineRule({
  id: "semantics/label-in-name",
  satisfies: ["wcag22:2.5.3", "wcag21:2.5.3"],
  severity: "error",
  scope: "node",
  fixClass: "guidance",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "When an interactive element has both visible text and an aria-label, the aria-label must contain the visible text as a substring.",
    rationale:
      "Voice-control users activate controls by speaking their visible label. If the accessible name (aria-label) doesn't contain that visible text, the voice command fails — the user sees 'Send' but the system only recognizes 'Submit form'.",
    goodExample: `<button aria-label="Send message">Send</button>`,
    badExample: `<button aria-label="Submit form">Send</button>`,
    normativeQuote:
      "For user interface components with labels that include text or images of text, the name contains the text that is presented visually.",
    references: [
      "https://www.w3.org/TR/WCAG22/#label-in-name",
      "https://www.w3.org/WAI/WCAG22/Understanding/label-in-name",
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

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  fixPaths: FixPaths;
}) => void;

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const element of walkHtmlElements(doc)) {
    if (!isInteractiveHtml(element)) continue;
    const ariaLabelRaw = getHtmlAttribute(element, "aria-label");
    if (ariaLabelRaw === null || ariaLabelRaw.trim().length === 0) continue;
    // Strip template directives defensively on both sides before compare
    // and echo. The parser strips `{{ … }}` / `{% … %}` from HtmlText
    // nodes, but (a) attribute values are never stripped at parse time,
    // so `aria-label="{{ page.title }}"` would otherwise reach the
    // compare with raw Liquid, and (b) the parser's text-node path
    // breaks on `<` — a Liquid tag like `{% if foo < 5 %}` leaks raw
    // tokens into the HtmlText value. Both failure modes produce
    // false-positive violations that quote raw directives as "visible
    // text" (Q4-LABEL-IN-NAME-LIQUID-STRIP-MISSING).
    const visibleText = collapseWhitespace(stripDirectives(visibleTextHtml(element)));
    const normalizedAria = collapseWhitespace(stripDirectives(ariaLabelRaw));
    if (visibleText.length === 0) continue;
    if (normalizedAria.length === 0) continue;
    if (containsSubstring(normalizedAria, visibleText)) continue;
    emitViolation(element.tagName, visibleText, normalizedAria, element.loc.start, emit);
  }
}

/** Runs `stripTemplateDirectives` and returns the stripped string. */
function stripDirectives(text: string): string {
  return stripTemplateDirectives(text).value;
}

/** Text content excluding aria-hidden subtrees — the text a sighted user sees. */
function visibleTextHtml(element: HtmlElement): string {
  const chunks: string[] = [];
  // <select>'s accessible name per HTML AAM / WCAG 2.5.3 is aria-label /
  // aria-labelledby / <label for> — its <option> descendants are the
  // widget's VALUE set, not its visible label. Skip option text so
  // patterns like Bootstrap's floating-label <select> with placeholder
  // options don't falsely fail Label-in-Name.
  const hostIsSelect = element.tagName.toLowerCase() === "select";
  for (const child of element.children) visitHtmlVisible(child, chunks, hostIsSelect);
  return chunks.join("").trim();
}

function visitHtmlVisible(
  node: HtmlElement["children"][number],
  chunks: string[],
  hostIsSelect: boolean,
): void {
  if (node.kind === "HtmlText") {
    chunks.push(node.value);
    return;
  }
  if (node.kind !== "HtmlElement") return;
  if (getHtmlAttribute(node, "aria-hidden") === "true") return;
  if (hostIsSelect && node.tagName.toLowerCase() === "option") return;
  for (const child of node.children) visitHtmlVisible(child, chunks, hostIsSelect);
}

function isInteractiveHtml(element: HtmlElement): boolean {
  return HTML_INTERACTIVE_TAGS.has(element.tagName.toLowerCase());
}

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const element of walkJsxElements(module)) {
    if (!isInteractiveJsx(element)) continue;
    // Only check string-literal aria-label — skip expressions
    const ariaAttr = getJsxAttribute(element, "aria-label");
    if (!ariaAttr?.value || ariaAttr.value.kind !== "StringLiteral") continue;
    // JSX authors rarely mix Liquid/ERB with JSX, but the strip is cheap
    // and forward-compatible with template-in-TSX shapes (Astro `<script>
    // is:inline>`, Remix `<Scripts>`-adjacent prose); it also matches the
    // HTML path so the rule's compare semantics stay uniform.
    const ariaLabel = collapseWhitespace(stripDirectives(ariaAttr.value.value));
    if (ariaLabel.length === 0) continue;
    const visibleText = collapseWhitespace(stripDirectives(visibleTextJsx(element)));
    if (visibleText.length === 0) continue;
    if (containsSubstring(ariaLabel, visibleText)) continue;
    emitViolation(element.tagName, visibleText, ariaLabel, element.loc.start, emit);
  }
}

/** Text content excluding aria-hidden subtrees in JSX. */
function visibleTextJsx(element: JsxElement): string {
  const chunks: string[] = [];
  // See visibleTextHtml — <option> descendants of a <select> are the
  // widget's value set, not its visible label.
  const hostIsSelect = element.tagName.toLowerCase() === "select";
  for (const child of element.children) visitJsxVisible(child, chunks, hostIsSelect);
  return chunks.join("").trim();
}

function visitJsxVisible(
  node: JsxElement["children"][number],
  chunks: string[],
  hostIsSelect: boolean,
): void {
  if (node.kind === "JsxText") {
    chunks.push(node.value);
    return;
  }
  if (node.kind !== "JsxElement") return;
  if (getJsxAttributeString(node, "aria-hidden") === "true") return;
  if (hostIsSelect && node.tagName.toLowerCase() === "option") return;
  for (const child of node.children) visitJsxVisible(child, chunks, hostIsSelect);
}

function isInteractiveJsx(element: JsxElement): boolean {
  return HTML_INTERACTIVE_TAGS.has(element.tagName.toLowerCase());
}

function containsSubstring(name: string, visibleText: string): boolean {
  return name.toLowerCase().includes(visibleText.toLowerCase());
}

/**
 * Collapses all whitespace runs (including newlines and tabs from JSX
 * source indentation) to a single space and trims. This matches what a
 * browser renders for inline-text content — a user sees one space
 * between adjacent `<span>`s, regardless of how many newlines separated
 * them in source. Skipping this step made the substring check fail on
 * correctly-authored code that happened to split visible text across
 * lines.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Heuristic to rank the three resolution paths. The primary is what
 * the fix-verify loop should try first; alternatives are listed in
 * decreasing likelihood. Picking a ranking from cheap structural
 * signals (presence of icon chars, aria-label-that-extends-visible-
 * text, etc.) beats handing the agent three equal options — that
 * forced it to re-read the source to disambiguate.
 */
function rankFixPaths(
  visibleText: string,
  ariaLabel: string,
): { primary: string; alternatives: readonly string[] } {
  // Cap before interpolating into agent-visible prose so a 1.5 KB
  // lorem-ipsum label can't multiply into a multi-KB suggestion echo.
  // The full visibleText still feeds the heuristic ranking below.
  const echoVisible = truncateForEcho(visibleText);
  const pathWiden = `widen aria-label to contain the visible text as a contiguous substring, e.g. aria-label="${echoVisible} — additional context"`;
  const pathRephrase = `rephrase aria-label so the visible text "${echoVisible}" appears verbatim (contiguous), not with other words inserted between its tokens — e.g. aria-label="${echoVisible}: <rest of context>"`;
  const pathIconHidden = `if the visible text contains a decorative icon or symbol (arrows, glyphs, emoji), wrap the icon in a span and mark it \`aria-hidden="true"\` so it is not part of the visible label`;
  const pathRemove =
    "remove aria-label entirely and let the visible text serve as the accessible name directly";

  if (containsIconLikeChar(visibleText)) {
    return { primary: pathIconHidden, alternatives: [pathWiden, pathRemove] };
  }
  if (isInterleavedExpansion(ariaLabel, visibleText)) {
    // All visible-text word tokens are present in aria-label, in order,
    // but with extra words inserted between them. This is almost always
    // an authored-expanded label, not a mismatched one — the fix is to
    // make the substring contiguous, not to pick a different resolution.
    return { primary: pathRephrase, alternatives: [pathWiden, pathRemove] };
  }
  if (ariaLabelIsExtendedVisibleText(ariaLabel, visibleText)) {
    // aria-label is a superset-adjacent phrase — removing it loses
    // context, widening is natural. Remove is a weak last resort.
    return { primary: pathWiden, alternatives: [pathRemove, pathIconHidden] };
  }
  return { primary: pathWiden, alternatives: [pathIconHidden, pathRemove] };
}

/**
 * Detects characters commonly used as decorative icons (arrows, box-
 * drawing, dingbats, emoji, geometric symbols). When visible text
 * contains one of these, the icon-hidden path is usually the right fix.
 */
function containsIconLikeChar(text: string): boolean {
  // \u2190-\u21FF arrows; \u25A0-\u25FF geometric; \u2600-\u27BF dingbats;
  // \u2B00-\u2BFF misc symbols and arrows; emoji via \p{Extended_Pictographic}.
  return (
    /[\u2190-\u21FF\u25A0-\u25FF\u2600-\u27BF\u2B00-\u2BFF]/.test(text) ||
    /\p{Extended_Pictographic}/u.test(text)
  );
}

function ariaLabelIsExtendedVisibleText(ariaLabel: string, visibleText: string): boolean {
  const a = ariaLabel.toLowerCase();
  const v = visibleText.toLowerCase();
  if (a.length <= v.length) return false;
  // Shares a meaningful prefix or suffix word with the visible text.
  const firstWord = v.split(/\s+/)[0] ?? "";
  return firstWord.length > 2 && a.includes(firstWord);
}

/**
 * True when every word token of the visible text appears in aria-label
 * in the same order, but with at least one extra token inserted
 * between them — i.e. the author expanded the visible text rather
 * than replacing it. Example: visible="Start the Assessment",
 * aria-label="Start the 8-question Perception Gap Assessment".
 *
 * This is a common authoring pattern: the designer wrote a longer,
 * more descriptive accessible name that still *sounds* like the button
 * text. WCAG 2.5.3 requires a contiguous substring, so the fix is to
 * rephrase, not to pick a different resolution.
 */
function isInterleavedExpansion(ariaLabel: string, visibleText: string): boolean {
  const visibleWords = visibleText.toLowerCase().split(/\s+/).filter(Boolean);
  const ariaWords = ariaLabel.toLowerCase().split(/\s+/).filter(Boolean);
  if (visibleWords.length < 2) return false;
  if (ariaWords.length <= visibleWords.length) return false;
  let cursor = 0;
  for (const word of visibleWords) {
    const found = ariaWords.indexOf(word, cursor);
    if (found === -1) return false;
    cursor = found + 1;
  }
  return true;
}

/**
 * Returns visible-text words that appear in aria-label with a
 * different case ("Assessment" visible vs "assessment" in the label).
 * WCAG 2.5.3 allows case-insensitive matching, but case divergence can
 * matter for some AT pronunciation engines and for voice-control users
 * who speak proper nouns expecting capitalization. Surfacing the delta
 * lets the agent decide whether this context cares; does not affect
 * detection.
 */
function findCaseMismatchedWords(ariaLabel: string, visibleText: string): readonly string[] {
  const ariaWordsLower = new Set(ariaLabel.split(/\s+/).map((w) => w.toLowerCase()));
  const ariaWordsExact = new Set(ariaLabel.split(/\s+/));
  const out: string[] = [];
  for (const visibleWord of visibleText.split(/\s+/)) {
    if (visibleWord.length === 0) continue;
    if (ariaWordsExact.has(visibleWord)) continue;
    if (ariaWordsLower.has(visibleWord.toLowerCase())) out.push(visibleWord);
  }
  return out;
}

function emitViolation(
  tagName: string,
  visibleText: string,
  ariaLabel: string,
  loc: { line: number; column: number },
  emit: Emit,
): void {
  const ranked = rankFixPaths(visibleText, ariaLabel);
  const interleaved = isInterleavedExpansion(ariaLabel, visibleText);
  const caseMismatches = findCaseMismatchedWords(ariaLabel, visibleText);
  // Cap before interpolating user-authored strings into agent-visible
  // message / suggestion text. synthesizeEditCandidate below keeps the
  // un-truncated values — its oldText is a literal-source locator and
  // a truncated aria-label="..." would not match the file.
  const echoVisible = truncateForEcho(visibleText);
  const echoAria = truncateForEcho(ariaLabel);
  const expansionNote = interleaved
    ? `Looks like an expanded label — every word of "${echoVisible}" appears in aria-label in order, but with extra words inserted between them. WCAG 2.5.3 requires a contiguous substring, so the fix is to rephrase, not to replace. `
    : "";
  const caseNote =
    caseMismatches.length > 0
      ? `Also note case mismatch on ${caseMismatches.map((w) => `"${w}"`).join(", ")} — WCAG 2.5.3 matches case-insensitively, but some AT pronunciation engines and voice-control users preserve case; prefer the visible capitalization. `
      : "";
  const suggestion =
    `${expansionNote}${caseNote}Primary fix: ${ranked.primary}. ` +
    `Alternatives (less likely): (a) ${ranked.alternatives[0]}; (b) ${ranked.alternatives[1]}.`;
  // Synthesize an `editCandidate` only on the "non-contiguous tokens"
  // diagnosis (interleaved expansion). In that case we have enough
  // signal to propose a concrete rewrite — a verbatim visible-text
  // prefix plus the remaining aria-label words. For other diagnoses
  // (visible text absent from aria-label, different words entirely) a
  // synthesized rewrite would be a guess, so we omit the field. Per
  // CLAUDE.md §1 "Ambiguous field shapes are dishonest" — omitted, not
  // emitted as an empty pair.
  const editCandidate = interleaved ? synthesizeEditCandidate(visibleText, ariaLabel) : undefined;
  const primaryPath: FixPath = {
    label: ranked.primary,
    ...(editCandidate ? { editCandidate } : {}),
  };
  const fixPaths: FixPaths = {
    primary: primaryPath,
    alternatives: ranked.alternatives.map((label) => ({ label })),
  };
  emit({
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `<${tagName}> has visible text "${echoVisible}" that is not contained in aria-label "${echoAria}" — voice-control users cannot activate this control by speaking its visible label.`,
    suggestion,
    fixPaths,
  });
}

/**
 * Build a candidate aria-label rewrite for the interleaved-expansion
 * case. Shape:
 *
 *   `aria-label="<visible text verbatim>: <remaining aria-label words>"`
 *
 * Where "remaining aria-label words" is the aria-label token stream
 * with any token that also appears in the visible text (case-
 * insensitive, preserving original aria-label casing) removed, keeping
 * the original order. The visible text is inserted verbatim so the
 * voice-control substring match is guaranteed; the colon + space is a
 * neutral separator that reads naturally in screen-reader output.
 *
 * Returned as an `{ oldText, newText }` pair on the `aria-label="..."`
 * attribute span — compatible with the suggest_fix payload builder,
 * which can optionally widen `primary.edit` via `widenToUniqueAnchor`
 * but leaves `primary.editCandidate` untouched (candidates are not
 * promised to be applicable verbatim).
 */
function synthesizeEditCandidate(
  visibleText: string,
  ariaLabel: string,
): { oldText: string; newText: string } | undefined {
  const visibleWordsLower = new Set(
    visibleText
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase()),
  );
  const remaining = ariaLabel
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !visibleWordsLower.has(w.toLowerCase()));
  // If every aria-label word overlapped the visible text (no remaining
  // context), a rephrase to "visible:" with nothing after it would be
  // nonsense — fall back to "visible" alone.
  const rewrittenValue =
    remaining.length > 0 ? `${visibleText}: ${remaining.join(" ")}` : visibleText;
  return {
    oldText: `aria-label="${ariaLabel}"`,
    newText: `aria-label="${rewrittenValue}"`,
  };
}
