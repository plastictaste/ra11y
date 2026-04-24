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
import { walkHtmlElements, walkJsxElements } from "../../engine/ast-helpers.ts";
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
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

/** Match descriptor: matched phrase + its byte offset in the searched text. */
interface MatchHit {
  readonly phrase: string;
  readonly offset: number;
}

function matchLocativeWithCooccurrence(text: string): MatchHit | undefined {
  const tokens = tokenize(text);
  LOCATIVE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex iteration
  while ((m = LOCATIVE_PATTERN.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (locativeHasCooccurrence(tokens, start, end)) return { phrase: m[0], offset: start };
  }
  return undefined;
}

function matchSensory(text: string): MatchHit | undefined {
  const strong = STRONG_SENSORY_PATTERN.exec(text);
  if (strong) return { phrase: strong[0], offset: strong.index };
  return matchLocativeWithCooccurrence(text);
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
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    else if (ctx.language === "tsx" || ctx.language === "jsx")
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, candidates);
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
 * Without this mapping, a match on line N of a multi-line element body
 * is reported at the parent element's `loc.start.line` (the off-by-N
 * citation real-world fixture surfaced as `modal.mdx:78` pointing at
 * line 73's opening tag).
 */
interface TextSpan {
  readonly value: string;
  readonly concatStart: number;
  readonly start: { readonly line: number; readonly column: number };
}

function collectHtmlTextSpans(element: HtmlElement): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  let concatLen = 0;
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") {
      spans.push({ value: node.value, concatStart: concatLen, start: node.loc.start });
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
      spans.push({ value: node.value, concatStart: concatLen, start: node.loc.start });
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
 * text node, then advances line/col through `node.value.slice(0, dx)`
 * counting newlines. Falls back to the element's own location when no
 * span owns the offset (shouldn't happen for matches found inside
 * concatenated text, but defensive).
 */
function precisePositionForOffset(
  spans: readonly TextSpan[],
  concatOffset: number,
  fallback: { readonly line: number; readonly column: number },
): { line: number; column: number } {
  for (const span of spans) {
    const localOffset = concatOffset - span.concatStart;
    if (localOffset < 0 || localOffset > span.value.length) continue;
    let line = span.start.line;
    let column = span.start.column;
    for (let i = 0; i < localOffset; i++) {
      if (span.value.charCodeAt(i) === 0x0a) {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    return { line, column };
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

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (const el of walkHtmlElements(root)) {
    const spans = collectHtmlTextSpans(el);
    if (spans.length === 0) continue;
    const concat = concatSpans(spans);
    const trimmed = concat.trim();
    const hit = trimmed ? matchSensory(trimmed) : undefined;
    if (!hit) continue;
    const hasDirectText = el.children.some(
      (c) => c.kind === "HtmlText" && matchSensory(c.value) !== undefined,
    );
    if (!hasDirectText) continue;
    // Re-locate the match in the un-trimmed concat so offsets line up
    // with span concatStart values.
    const concatOffset = concat.indexOf(hit.phrase);
    if (concatOffset === -1) continue;
    const precise = precisePositionForOffset(spans, concatOffset, el.loc.start);
    emitSensoryCandidates(filePath, precise, concat, concatOffset, hit.phrase, candidates);
  }
}

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const el of walkJsxElements(root)) {
    const spans = collectJsxTextSpans(el);
    if (spans.length === 0) continue;
    const concat = concatSpans(spans);
    const trimmed = concat.trim();
    const hit = trimmed ? matchSensory(trimmed) : undefined;
    if (!hit) continue;
    const hasDirectText = el.children.some(
      (c) => c.kind === "JsxText" && matchSensory(c.value) !== undefined,
    );
    if (!hasDirectText) continue;
    const concatOffset = concat.indexOf(hit.phrase);
    if (concatOffset === -1) continue;
    const precise = precisePositionForOffset(spans, concatOffset, el.loc.start);
    emitSensoryCandidates(filePath, precise, concat, concatOffset, hit.phrase, candidates);
  }
}

function emitSensoryCandidates(
  filePath: string,
  loc: { line: number; column: number },
  bodyText: string,
  matchOffset: number,
  matchedPhrase: string,
  candidates: ReviewCandidate[],
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
  const reason = `text references sensory characteristic "${matchedPhrase}" in: "${context}" -- verify a non-sensory alternative exists`;
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
