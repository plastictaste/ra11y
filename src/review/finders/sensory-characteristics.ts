/**
 * Candidate finder: review/sensory-characteristics
 * Criteria: wcag22:1.3.3, wcag21:1.3.3
 * Spec: https://www.w3.org/TR/WCAG22/#sensory-characteristics
 *
 * Finds text content that references sensory characteristics (shape,
 * color, size, visual location, orientation, or sound) as the only
 * way to identify or understand content. A human reviewer must verify
 * that a non-sensory alternative exists.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  mapValueOffsetToSourcePosition,
  stripTemplateDirectives,
} from "../../input/parsers/html-template-directives.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:1.3.3", "wcag21:1.3.3"] as const;

/**
 * Clear sensory-only phrases — color, shape, or side-based identification
 * that is effectively always a 1.3.3 concern in UI copy. A match here is
 * sufficient evidence on its own; no co-occurrence check needed.
 */
const STRONG_SENSORY_PATTERN =
  /\b(right side|left side|click the red|the green\b|the blue\b|the red\b|the round\b|the square\b|shaped like)\b/i;

/**
 * Locative words ("above", "below", "next to", …) are NOT sensory cues
 * on their own — they often describe document-order relations that
 * assistive technology conveys correctly ("Please correct errors in the
 * fields below", "see the section above"). The grammatical locative is
 * resolved by the AT user just as it is by a sighted user: by reading
 * the next/prior content. SC 1.3.3 targets *sensory* identifiers
 * (color, shape, size, visual location, orientation, sound) that AT
 * cannot convey.
 *
 * To distinguish "fields below" (document-order, fine) from "the green
 * button below" (visual position used as identifier, 1.3.3 concern),
 * require the locative to co-occur within ±10 tokens of either:
 *   (a) a visual signifier — color name, shape name, size adjective
 *   (b) a pointing verb — "see", "click", "tap", "select", "press",
 *       "look" — instructions that direct attention to a visual region
 *
 * Either co-occurrence is sufficient evidence to surface the candidate
 * for human/agent review. A bare locative without either signal is
 * dropped (the candidate itself was noise in its current shape — per
 * AI-first doctrine, this is candidate-level tightening, not reason-
 * text enrichment).
 */
const LOCATIVE_PATTERN =
  /\b(above|below|next to|adjacent to|to the right of|to the left of|following|preceding)\b/gi;

/**
 * Pointing verbs in the imperative — "see above", "click below". Several
 * of these are polysemous nouns ("the view above", "the look above"); a
 * preceding determiner (DETERMINERS) marks the noun reading and disables
 * the verb-cooccurrence credit on that token (handled in
 * locativeHasCooccurrence). Without that guard, "consider the view
 * above" — a benign noun-phrase — would falsely fire.
 */
const POINTING_VERBS: ReadonlySet<string> = new Set([
  "see",
  "click",
  "tap",
  "select",
  "press",
  "look",
  "view",
  "scroll",
]);

const DETERMINERS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
  "any",
  "some",
  "no",
]);

const VISUAL_SIGNIFIERS: ReadonlySet<string> = new Set([
  // colors
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "brown",
  "black",
  "white",
  "gray",
  "grey",
  // shapes
  "round",
  "square",
  "circular",
  "rectangular",
  "triangular",
  "oval",
  // size adjectives
  "large",
  "small",
  "big",
  "tiny",
  "huge",
  "little",
]);

/**
 * Common UI nouns whose presence next to a locative ("button above",
 * "form below") names the target by its kind. When a UI noun anchors
 * the reference, the position word is supplementary, not the sole
 * locator (SC 1.3.3 only prohibits sensory-only references when no
 * other identifier exists). The candidate still surfaces — only the
 * reason text is reframed.
 */
const UI_NOUNS: ReadonlySet<string> = new Set(
  // singular + plural variants of common UI element names
  "button buttons form forms menu menus panel panels link links section sections page pages screenshot screenshots table tables icon icons image images list lists field fields dialog dialogs sidebar header footer tab tabs checkbox checkboxes input inputs toolbar navigation nav card cards banner modal tooltip dropdown paragraph heading headings diagram chart graph map".split(
    " ",
  ),
);

/** Window for noun-anchor detection — adjacent or with a small word gap. */
const NOUN_ANCHOR_WINDOW_TOKENS = 2;

const COOCCURRENCE_WINDOW_TOKENS = 10;

const TOKEN_RE = /[A-Za-z]+/g;

interface Token {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function tokenize(text: string): readonly Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex iteration
  while ((m = TOKEN_RE.exec(text)) !== null) {
    tokens.push({ value: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function findAnchorIndex(tokens: readonly Token[], matchStart: number, matchEnd: number): number {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t && t.start >= matchStart && t.start < matchEnd) return i;
  }
  return -1;
}

/**
 * Polysemy guard: "the view above" is a noun phrase, not an
 * instruction. A preceding determiner ("the/a/this/...") marks the
 * verb-form as a noun and disables the cooccurrence credit on this
 * token.
 */
function isVerbCredit(tokens: readonly Token[], i: number): boolean {
  const t = tokens[i];
  if (!(t && POINTING_VERBS.has(t.value))) return false;
  const prev = i > 0 ? tokens[i - 1] : undefined;
  return !(prev && DETERMINERS.has(prev.value));
}

/**
 * True when the locative match at [matchStart, matchEnd) co-occurs with
 * a pointing verb or visual signifier within ±COOCCURRENCE_WINDOW_TOKENS
 * tokens (counted on the tokenized stream, not characters — so multi-
 * word locatives like "next to" stay anchored at the start token).
 */
function locativeHasCooccurrence(
  tokens: readonly Token[],
  matchStart: number,
  matchEnd: number,
): boolean {
  const anchor = findAnchorIndex(tokens, matchStart, matchEnd);
  if (anchor === -1) return false;
  const lo = Math.max(0, anchor - COOCCURRENCE_WINDOW_TOKENS);
  const hi = Math.min(tokens.length - 1, anchor + COOCCURRENCE_WINDOW_TOKENS);
  for (let i = lo; i <= hi; i++) {
    if (i === anchor) continue;
    const t = tokens[i];
    if (!t) continue;
    if (VISUAL_SIGNIFIERS.has(t.value)) return true;
    if (isVerbCredit(tokens, i)) return true;
  }
  return false;
}

/**
 * If a UI noun sits within ±NOUN_ANCHOR_WINDOW_TOKENS of the locative
 * match, return that noun. Returns the closest match — preferring a
 * noun that immediately precedes the locative ("button above",
 * "form below") since that is the canonical English noun-modifier
 * order that anchors the reference. Returns undefined when no UI
 * noun is in the window.
 *
 * The narrow window (vs the ±10 cooccurrence window above) is
 * deliberate: a noun three sentences away does not anchor the
 * reference; "button" must be local enough that AT users hear it as
 * naming the target.
 */
function findNounAnchor(
  tokens: readonly Token[],
  matchStart: number,
  matchEnd: number,
): string | undefined {
  const anchor = findAnchorIndex(tokens, matchStart, matchEnd);
  if (anchor === -1) return undefined;
  // Prefer the closest noun, preferring backward (preceding the locative).
  for (let dist = 1; dist <= NOUN_ANCHOR_WINDOW_TOKENS; dist++) {
    const before = tokens[anchor - dist];
    if (before && UI_NOUNS.has(before.value)) return before.value;
    const after = tokens[anchor + dist];
    if (after && UI_NOUNS.has(after.value)) return after.value;
  }
  return undefined;
}

/** Match descriptor: matched phrase + its byte offset in the searched text. */
interface MatchHit {
  readonly phrase: string;
  readonly offset: number;
  /**
   * UI noun within ±NOUN_ANCHOR_WINDOW_TOKENS of the matched locative,
   * if any. Present only for locative matches; STRONG_SENSORY_PATTERN
   * hits never carry a noun anchor (the phrase itself names the cue).
   */
  readonly nounAnchor?: string;
}

function matchLocativeWithCooccurrence(text: string): MatchHit | undefined {
  const tokens = tokenize(text);
  LOCATIVE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex iteration
  while ((m = LOCATIVE_PATTERN.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (locativeHasCooccurrence(tokens, start, end)) {
      const noun = findNounAnchor(tokens, start, end);
      return noun
        ? { phrase: m[0], offset: start, nounAnchor: noun }
        : { phrase: m[0], offset: start };
    }
  }
  return undefined;
}

function matchSensory(text: string): MatchHit | undefined {
  const strong = STRONG_SENSORY_PATTERN.exec(text);
  if (strong) return { phrase: strong[0], offset: strong.index };
  return matchLocativeWithCooccurrence(text);
}

// ---------------------------------------------------------------------------
// Callout-container detection
// ---------------------------------------------------------------------------

/**
 * CSS class tokens that identify a known prose-callout container:
 * documentation blocks like `<div class="note">`, `<aside class="tip">`,
 * Docusaurus `<div class="admonition">`, etc. Content inside these
 * containers typically describes the UI to a *developer*, not a user-
 * facing instruction. Per AI-first doctrine, candidates inside callout
 * containers are NOT suppressed — they remain in the primary list with
 * reason-text enrichment so the agent can dismiss in one read.
 */
const CALLOUT_CLASS_TOKENS: ReadonlySet<string> = new Set([
  "note",
  "tip",
  "warning",
  "caution",
  "callout",
  "admonition",
  "alert",
  "info",
  "important",
  "danger",
]);

/**
 * PascalCase JSX component names whose children are typically
 * developer-facing documentation prose rather than user-facing UI copy.
 */
const CALLOUT_JSX_TAG_NAMES: ReadonlySet<string> = new Set([
  "Note",
  "Tip",
  "Warning",
  "Caution",
  "Callout",
  "Admonition",
  "Alert",
  "Info",
  "Important",
  "Danger",
]);

/**
 * Returns a human-readable label for the HTML element if it matches a
 * known callout pattern (e.g. `div.note`, `aside.tip`, etc.), or
 * `undefined` when the element is not a callout container.
 *
 * Checks the `class` attribute token list against CALLOUT_CLASS_TOKENS.
 * Does NOT check descendant elements — only the element itself. Ancestors
 * are checked by the caller's ancestor-stack walk.
 */
function htmlCalloutLabel(el: HtmlElement): string | undefined {
  const classAttr = el.attributes.find((a) => a.name.toLowerCase() === "class");
  if (!classAttr?.value) return undefined;
  const tokens = classAttr.value.toLowerCase().split(/\s+/);
  for (const tok of tokens) {
    if (CALLOUT_CLASS_TOKENS.has(tok)) {
      return `<${el.tagName.toLowerCase()} class="${tok}">`;
    }
  }
  return undefined;
}

/**
 * Returns a human-readable label for the callout container if the JSX
 * element's tagName is a known documentation-callout component name, or if
 * the element has a `className` / `class` prop whose token list matches a
 * callout class token.
 */
function jsxCalloutLabel(el: JsxElement): string | undefined {
  // PascalCase component match (e.g. <Note>, <Callout>)
  if (CALLOUT_JSX_TAG_NAMES.has(el.tagName)) {
    return `<${el.tagName}>`;
  }
  // className / class prop token match (e.g. <div className="note tip">)
  const classAttr = el.attributes.find((a) => a.name === "className" || a.name === "class");
  if (!classAttr) return undefined;
  // Only string-literal values are checked — expression values like
  // {styles.note} cannot be evaluated statically without cross-file
  // resolution that the agent is better positioned to do.
  const attrVal = classAttr.value;
  if (!attrVal || attrVal.kind !== "StringLiteral") return undefined;
  const tokens = attrVal.value.toLowerCase().split(/\s+/);
  for (const tok of tokens) {
    if (CALLOUT_CLASS_TOKENS.has(tok)) return `<${el.tagName} className="${tok}">`;
  }
  return undefined;
}

/**
 * Checks the given ancestor stack (outermost to innermost) for any
 * HTML element that matches a callout container. Returns the label of the
 * first (outermost) match, or `undefined` when none match.
 */
function calloutLabelFromHtmlAncestors(ancestors: readonly HtmlElement[]): string | undefined {
  for (const ancestor of ancestors) {
    const label = htmlCalloutLabel(ancestor);
    if (label) return label;
  }
  return undefined;
}

/**
 * Checks the given JSX ancestor stack for any element that matches a
 * callout container. Returns the label of the first (outermost) match,
 * or `undefined` when none match.
 */
function calloutLabelFromJsxAncestors(ancestors: readonly JsxElement[]): string | undefined {
  for (const ancestor of ancestors) {
    const label = jsxCalloutLabel(ancestor);
    if (label) return label;
  }
  return undefined;
}

export const finder = defineCandidateFinder({
  id: "review/sensory-characteristics",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds text content referencing sensory characteristics (shape, color, position) that may be the sole means of conveying information.",
    reviewPrompt:
      "Verify that instructions do not rely solely on sensory characteristics like shape, color, size, visual location, orientation, or sound.",
    references: ["https://www.w3.org/TR/WCAG22/#sensory-characteristics"],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html")
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, ctx.source, candidates);
    else if (ctx.language === "tsx" || ctx.language === "jsx")
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, ctx.source, candidates);
    return candidates;
  },
});

/**
 * Pairing of a literal text node and its starting offset within the
 * concatenated body text — built once per element when scanning, used
 * to map a regex match index back to (text node, offset within node)
 * so we can cite the exact line of the matched phrase rather than the
 * opening tag of the enclosing element.
 *
 * `rangeStart` / `rangeEnd` are source-byte offsets so the position
 * mapper can slice the original raw text out of `ctx.source` and walk
 * it directly — necessary because `node.value` is post-`stripTemplate
 * Directives` (and post-entity-decode), so newlines that lived inside
 * a stripped multi-line `{% include … %}` span are missing from the
 * value. Without anchoring on the raw source, the line counter
 * undercounts the source line by N for every match that sits past a
 * stripped span (the regression captured by the `ssg-pagination-
 * sensory-line-drift` real-world fixture).
 */
interface TextSpan {
  readonly value: string;
  readonly concatStart: number;
  readonly start: { readonly line: number; readonly column: number };
  /** Source-byte offset where the underlying text node begins. */
  readonly rangeStart: number;
  /** Source-byte offset where the underlying text node ends (exclusive). */
  readonly rangeEnd: number;
}

function collectHtmlTextSpans(element: HtmlElement): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  let concatLen = 0;
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") {
      spans.push({
        value: node.value,
        concatStart: concatLen,
        start: node.loc.start,
        rangeStart: node.range.start,
        rangeEnd: node.range.end,
      });
      concatLen += node.value.length;
      return;
    }
    if (node.kind !== "HtmlElement") return;
    for (const c of node.children) visit(c);
  };
  for (const child of element.children) visit(child);
  return spans;
}

function collectJsxTextSpans(element: JsxElement): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  let concatLen = 0;
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") {
      spans.push({
        value: node.value,
        concatStart: concatLen,
        start: node.loc.start,
        rangeStart: node.range.start,
        rangeEnd: node.range.end,
      });
      concatLen += node.value.length;
      return;
    }
    if (node.kind !== "JsxElement") return;
    for (const c of node.children) visit(c);
  };
  for (const child of element.children) visit(child);
  return spans;
}

function concatSpans(spans: readonly TextSpan[]): string {
  let out = "";
  for (const s of spans) out += s.value;
  return out;
}

/**
 * Maps a byte offset in the concatenated body text back to a 1-based
 * (line, column) in the source. Walks the spans to locate the owning
 * text node, slices the original raw text out of `source`, and hands
 * that slice to `mapValueOffsetToSourcePosition` so newlines that
 * lived inside stripped template-directive spans (e.g. multi-line
 * `{% include …\n   … %}`) are counted into the line cursor — without
 * that, walking the post-strip `node.value` undercounts the source
 * line by N for every match that sits past a stripped span.
 *
 * Falls back to the element's own location when no span owns the
 * offset (shouldn't happen for matches found inside concatenated
 * text, but defensive).
 */
function precisePositionForOffset(
  spans: readonly TextSpan[],
  concatOffset: number,
  source: string,
  fallback: { readonly line: number; readonly column: number },
): { line: number; column: number } {
  for (const span of spans) {
    const localOffset = concatOffset - span.concatStart;
    if (localOffset < 0 || localOffset > span.value.length) continue;
    const rawText = source.slice(span.rangeStart, span.rangeEnd);
    return mapValueOffsetToSourcePosition(rawText, span.start.line, span.start.column, localOffset);
  }
  return { line: fallback.line, column: fallback.column };
}

/**
 * One or two sentences of context around the match — what the agent
 * needs to dismiss "Holy guacamole! ...fields below." in one read
 * without opening the file. We extend backward to the previous sentence
 * boundary (`. ! ?` followed by whitespace) and forward to the next,
 * capped at REASON_CONTEXT_BUDGET so the reason string stays compact.
 *
 * The window is over the concatenated body text (post-trim, post-
 * directive-strip) so it reads like the rendered prose the user sees,
 * not the raw element source.
 */
const REASON_CONTEXT_BUDGET = 200;
const SENTENCE_END_RE = /[.!?](?:\s|$)/g;

function sentenceWindow(text: string, matchStart: number, matchEnd: number): string {
  const before = text.slice(0, matchStart);
  const lastBoundary = lastSentenceBoundary(before);
  let windowStart = lastBoundary === -1 ? 0 : lastBoundary;
  // Skip leading whitespace after the boundary so the window starts at
  // the first letter of the sentence.
  while (windowStart < matchStart && /\s/.test(text[windowStart] ?? "")) windowStart += 1;

  const after = text.slice(matchEnd);
  const firstBoundary = firstSentenceBoundary(after);
  const windowEnd = firstBoundary === -1 ? text.length : matchEnd + firstBoundary + 1;

  let snippet = text.slice(windowStart, windowEnd).replace(/\s+/g, " ").trim();
  if (snippet.length > REASON_CONTEXT_BUDGET) {
    // Bias the elision toward keeping the matched phrase visible —
    // the matched phrase always sits between windowStart and windowEnd
    // by construction, so a centered budget keeps it in frame.
    snippet = `${snippet.slice(0, REASON_CONTEXT_BUDGET)}…`;
  }
  return snippet;
}

function lastSentenceBoundary(text: string): number {
  SENTENCE_END_RE.lastIndex = 0;
  let last = -1;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex iteration
  while ((m = SENTENCE_END_RE.exec(text)) !== null) {
    last = m.index + m[0].length;
  }
  return last;
}

function firstSentenceBoundary(text: string): number {
  SENTENCE_END_RE.lastIndex = 0;
  const m = SENTENCE_END_RE.exec(text);
  return m ? m.index : -1;
}

/**
 * Checks a single HTML element for a sensory match and emits a candidate
 * when one is found. Extracted from `walkHtmlWithAncestors` to keep the
 * walker's cognitive complexity within the Biome limit.
 *
 * `ancestors` is the element's ancestor chain (outermost first), used to
 * detect when the element is nested inside a callout container. The
 * element itself is also checked (handles the case where `el` IS the
 * callout container whose direct-text children triggered the match).
 */
function checkHtmlElement(
  el: HtmlElement,
  ancestors: readonly HtmlElement[],
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  const spans = collectHtmlTextSpans(el);
  if (spans.length === 0) return;
  const concat = concatSpans(spans);
  const hit = matchSensory(concat.trim());
  if (!hit) return;
  const hasDirectText = el.children.some(
    (c) => c.kind === "HtmlText" && matchSensory(c.value) !== undefined,
  );
  if (!hasDirectText) return;
  const concatOffset = concat.indexOf(hit.phrase);
  if (concatOffset === -1) return;
  const precise = precisePositionForOffset(spans, concatOffset, source, el.loc.start);
  // Prefer outermost callout ancestor; fall back to the element itself.
  const calloutLabel = calloutLabelFromHtmlAncestors(ancestors) ?? htmlCalloutLabel(el);
  emitSensoryCandidates(
    filePath,
    precise,
    concat,
    concatOffset,
    hit.phrase,
    candidates,
    calloutLabel,
    hit.nounAnchor,
  );
}

/**
 * Recursive HTML walk that tracks the ancestor stack so callout-container
 * detection can inspect parent elements. Preserves the line-mapping fix
 * from the `ssg-pagination-sensory-line-drift` fixture.
 */
function walkHtmlWithAncestors(
  node: HtmlDocument | HtmlElement,
  ancestors: readonly HtmlElement[],
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  for (const child of node.children) {
    if (child.kind !== "HtmlElement") continue;
    checkHtmlElement(child, ancestors, filePath, source, candidates);
    walkHtmlWithAncestors(child, [...ancestors, child], filePath, source, candidates);
  }
}

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  walkHtmlWithAncestors(root, [], filePath, source, candidates);
}

/**
 * Checks a single JSX element for a sensory match and emits a candidate
 * when one is found. Extracted from `walkJsxWithAncestors` to keep the
 * walker's cognitive complexity within the Biome limit.
 */
function checkJsxElement(
  el: JsxElement,
  ancestors: readonly JsxElement[],
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  const spans = collectJsxTextSpans(el);
  if (spans.length === 0) return;
  const concat = concatSpans(spans);
  const hit = matchSensory(concat.trim());
  if (!hit) return;
  const hasDirectText = el.children.some(
    (c) => c.kind === "JsxText" && matchSensory(c.value) !== undefined,
  );
  if (!hasDirectText) return;
  const concatOffset = concat.indexOf(hit.phrase);
  if (concatOffset === -1) return;
  const precise = precisePositionForOffset(spans, concatOffset, source, el.loc.start);
  const calloutLabel = calloutLabelFromJsxAncestors(ancestors) ?? jsxCalloutLabel(el);
  emitSensoryCandidates(
    filePath,
    precise,
    concat,
    concatOffset,
    hit.phrase,
    candidates,
    calloutLabel,
    hit.nounAnchor,
  );
}

/**
 * Recursive JSX walk that tracks the ancestor stack — mirrors
 * `walkHtmlWithAncestors` for JSX sources. Callout detection covers:
 *   - Known PascalCase component names (CALLOUT_JSX_TAG_NAMES)
 *   - Elements with a `className` / `class` prop containing a string
 *     literal whose token list overlaps CALLOUT_CLASS_TOKENS
 */
function walkJsxWithAncestors(
  root: TsxModule | JsxElement,
  ancestors: readonly JsxElement[],
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  const elements: readonly JsxElement[] =
    root.kind === "JsxElement"
      ? (root.children.filter((c) => c.kind === "JsxElement") as JsxElement[])
      : root.jsxElements;
  for (const el of elements) {
    checkJsxElement(el, ancestors, filePath, source, candidates);
    walkJsxWithAncestors(el, [...ancestors, el], filePath, source, candidates);
  }
}

function findJsxCandidates(
  root: TsxModule,
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  walkJsxWithAncestors(root, [], filePath, source, candidates);
}

function emitSensoryCandidates(
  filePath: string,
  loc: { line: number; column: number },
  bodyText: string,
  matchOffset: number,
  matchedPhrase: string,
  candidates: ReviewCandidate[],
  /**
   * When the matched text is inside a known prose-callout container,
   * this is a human-readable label like `<div class="note">` or
   * `<Note>`. Per AI-first doctrine, the candidate stays in the
   * primary list — no suppression. The reason text is enriched so
   * the agent can dismiss in one read without opening the file.
   */
  calloutLabel?: string,
  /**
   * UI noun (e.g. "button", "form") sitting within a small token
   * window of the matched locative — when present, the position word
   * is supplementary to a noun that names the target. The reason
   * text is reframed to ask whether AT users can locate the noun by
   * its name, rather than implying the position word is the sole
   * locator. Per AI-first "no heuristic suppression" doctrine, the
   * candidate stays in the primary list — only the framing changes.
   */
  nounAnchor?: string,
): void {
  // HtmlText is parser-stripped, but attribute values and JSX text are
  // not (see images-of-text.ts for the rationale) — strip defensively
  // so the echoed context reflects the rendered-text shape, not raw
  // Liquid/Jinja/ERB tokens that would read as noise to the agent.
  const renderedBody = stripTemplateDirectives(bodyText).value;
  // The strip can shift offsets if a directive sat before the match;
  // re-locate the matched phrase in the rendered text. If it's gone
  // (template directive contained the phrase), fall back to raw.
  const renderedOffset = renderedBody.indexOf(matchedPhrase);
  const contextSource = renderedOffset === -1 ? bodyText : renderedBody;
  const contextOffset = renderedOffset === -1 ? matchOffset : renderedOffset;
  const context = sentenceWindow(
    contextSource,
    contextOffset,
    contextOffset + matchedPhrase.length,
  );
  // Reason carries the matched phrase + 1-2 surrounding sentences so
  // the agent can dismiss benign prose ("Holy guacamole! ... fields
  // below.") without re-reading the file. Per AI-first doctrine, no
  // confidence downgrade by file extension — the reason text is the
  // lever; the agent triages on context.
  //
  // When the match is inside a callout container, append a note so
  // the agent knows this is likely developer-facing documentation
  // prose, not a user-facing UI instruction. The candidate stays in
  // the primary list (surface, don't suppress); the enriched reason
  // is the mechanism for a fast one-read dismiss.
  const calloutNote = calloutLabel
    ? ` -- inside a ${calloutLabel} callout block: likely developer-facing documentation, not a user-facing UI instruction; verify the rendered output uses non-sensory alternatives`
    : "";
  // When a UI noun anchors the locative, reframe the question: the
  // position is supplementary to a name, so the predicate the agent
  // verifies is "can a screen-reader user locate this noun by its
  // name," not "is the position the sole cue." Same priority — the
  // candidate still surfaces (no heuristic suppression), only the
  // framing changes. SC 1.3.3 may still bind if the noun is generic
  // and there are multiple instances on the page (e.g. "the button
  // below" with three unlabeled buttons), so the agent retains the
  // judgment call.
  const reason = nounAnchor
    ? `verify users who linearize content (screen readers) can locate "${nounAnchor}" by its name -- "${matchedPhrase}" is a layout cue, not a name -- in: "${context}"${calloutNote}`
    : `text references sensory characteristic "${matchedPhrase}" in: "${context}" -- verify a non-sensory alternative exists${calloutNote}`;
  const snippet = context.length > 0 ? context : renderedBody.slice(0, 120);
  for (const criterionId of CRITERION_IDS) {
    // Confidence "low": regex on visible text. "Click below" and
    // "the green button above" match even when the surrounding UI
    // does carry a non-sensory alternative (icon, heading, landmark).
    // The finder is a prompt to verify, not evidence of a failure.
    candidates.push({
      criterionId,
      location: { filePath, line: loc.line, column: loc.column },
      reason,
      snippet,
      confidence: "low",
    });
  }
}
