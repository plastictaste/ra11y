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
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
import type { HtmlDocument, TsxModule } from "../../types/ast.ts";
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

function matchLocativeWithCooccurrence(text: string): string | undefined {
  const tokens = tokenize(text);
  LOCATIVE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex iteration
  while ((m = LOCATIVE_PATTERN.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (locativeHasCooccurrence(tokens, start, end)) return m[0];
  }
  return undefined;
}

function matchSensory(text: string): string | undefined {
  return STRONG_SENSORY_PATTERN.exec(text)?.[0] ?? matchLocativeWithCooccurrence(text);
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

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (const el of walkHtmlElements(root)) {
    const text = htmlTextContent(el);
    const matched = text ? matchSensory(text) : undefined;
    if (!matched) continue;
    const hasDirectText = el.children.some(
      (c) => c.kind === "HtmlText" && matchSensory(c.value) !== undefined,
    );
    if (!hasDirectText) continue;
    emitSensoryCandidates(filePath, el.loc.start, text as string, matched, candidates);
  }
}

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const el of walkJsxElements(root)) {
    const text = jsxTextContent(el);
    const matched = text ? matchSensory(text) : undefined;
    if (!matched) continue;
    const hasDirectText = el.children.some(
      (c) => c.kind === "JsxText" && matchSensory(c.value) !== undefined,
    );
    if (!hasDirectText) continue;
    emitSensoryCandidates(filePath, el.loc.start, text as string, matched, candidates);
  }
}

function emitSensoryCandidates(
  filePath: string,
  loc: { line: number; column: number },
  text: string,
  matchedPhrase: string,
  candidates: ReviewCandidate[],
): void {
  const reason = `text references sensory characteristic "${matchedPhrase}" -- verify a non-sensory alternative exists`;
  // HtmlText is parser-stripped, but attribute values and JSX text are
  // not (see images-of-text.ts for the rationale) — strip defensively
  // so the echoed `snippet` reflects the rendered-text shape, not raw
  // Liquid/Jinja/ERB tokens that would read as noise to the agent.
  const strippedSnippet = stripTemplateDirectives(text).value.slice(0, 120);
  for (const criterionId of CRITERION_IDS) {
    // Confidence "low": regex on visible text. "Click below" and
    // "the green button above" match even when the surrounding UI
    // does carry a non-sensory alternative (icon, heading, landmark).
    // The finder is a prompt to verify, not evidence of a failure.
    candidates.push({
      criterionId,
      location: { filePath, line: loc.line, column: loc.column },
      reason,
      snippet: strippedSnippet,
      confidence: "low",
    });
  }
}
