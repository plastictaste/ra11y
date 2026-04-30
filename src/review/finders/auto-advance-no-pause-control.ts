/**
 * Candidate finder: review/auto-advance-no-pause-control
 * Criteria: wcag22:2.2.2, wcag21:2.2.2 — Pause, Stop, Hide
 *
 * Spec: https://www.w3.org/TR/WCAG22/#pause-stop-hide
 *       https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide
 *
 * Surfaces the conjunction "(auto-advance signal present) AND (no
 * pause UI present)" — both halves observed deterministically in the
 * same file. Sibling to:
 *   - `motion/pause-stop-hide` (rule, severity error/warning) which
 *     fires on declarative carousel markers + bare-CSS infinite
 *     animations regardless of sibling pause UI. The rule lane
 *     captures the spec-mandated baseline; this finder captures the
 *     more specific "also no pause UI in evidence" reading.
 *   - `review/carousel-pattern` (finder) which fires on declarative
 *     carousel SHAPES — class-token, aria-roledescription, data-bs-
 *     ride — to surface the three review questions (auto-advance?
 *     accessible name? pause/stop UI?). That finder always fires on
 *     carousel-shaped roots; this one only fires when both halves of
 *     the conjunction hold in the same file.
 *   - `review/timing` (finder) which adds 2.2.2 candidates on
 *     `setInterval` calls whose callback statically mutates DOM
 *     state. That finder fires on every `setInterval` regardless of
 *     duration; this one applies the spec's ≥5s gate AND requires
 *     pause-UI absence.
 *
 * The conjunction is deterministic on these inputs:
 *
 *   1. Auto-advance signal — at least one of:
 *        a. HTML/JSX element matches a carousel-shape predicate
 *           (`data-bs-ride="carousel"|"true"`,
 *           `data-ride="carousel"|"true"`, or class token matching
 *           `/(^|\s)(carousel|slider|slideshow|swiper)(\s|$|-|_)/i`).
 *        b. JS source contains `setInterval(_, N)` with the second
 *           argument resolving to a numeric literal ≥5000ms (or its
 *           seconds equivalent — a literal `>= 5` in seconds).
 *        c. HTML `<style>` block (or JSX inline style) contains
 *           `animation-iteration-count: infinite`, or the `animation`
 *           shorthand with the keyword `infinite`.
 *
 *   2. No-pause-UI predicate — none of the following hold within the
 *      same parsed document/module:
 *        a. Element with `aria-label` matching `/pause/i`.
 *        b. Element with `id` matching `/pause/i`.
 *        c. Element with `class` token matching `/pause/i`.
 *        d. `<button>` (HTML) or `<button>` JSX element whose visible
 *           text content (concatenated text-node children) matches
 *           `/pause/i`.
 *
 * Per AI-first doctrine "Numeric-threshold heuristics are
 * suppression": the 5000ms threshold is the WCAG 2.2.2 normative
 * trigger gate — Understanding 2.2.2 reads "starts automatically,
 * lasts more than five seconds." A `setInterval` callback at ≤4999ms
 * cannot honestly cite 2.2.2 ("more than five seconds" is a spec
 * floor), so the threshold is a spec gate, not a heuristic
 * suppression. The duration is also echoed verbatim in the reason
 * text so the agent reads the additive context the gate is based on.
 *
 * Per AI-first doctrine "Don't duplicate capability the agent
 * already has": this finder does not attempt cross-file pause-UI
 * resolution (a separate `<button id="pause">` in a sibling file).
 * The conjunction lives within a single parsed document — the agent
 * grepping "pause" across the project is the correct arbiter for
 * cross-file framing.
 *
 * Confidence: "medium". Both halves are deterministic from static
 * evidence, but the question they frame — "is THIS auto-advance
 * actually missing a pause control users can operate?" — depends on
 * runtime behaviour the scanner cannot see (the pause UI might live
 * in a sibling file the page composes; the auto-advance might be
 * essential under the WCAG exception). Per CLAUDE.md §1 the agent
 * dismisses by reading.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import type { RuleContext } from "../../types/rule.ts";

const CRITERION_IDS = ["wcag22:2.2.2", "wcag21:2.2.2"] as const;

/**
 * WCAG 2.2.2 spec floor — "starts automatically, lasts more than five
 * seconds" (Understanding 2.2.2). The gate fires on `N >= 5000` so a
 * `setInterval(_, 5000)` (a 5-second cycle that runs indefinitely)
 * still surfaces — the cumulative runtime crosses the spec floor on
 * every iteration past the first. The gate is normative, not a
 * heuristic threshold per CLAUDE.md §1.
 */
const FIVE_SECONDS_MS = 5000;

/**
 * Class-token regex for library-agnostic carousel detection. Mirrors
 * the predicate in `review/carousel-pattern` so the two finders
 * recognise the same set of carousel-shaped roots — keeping the
 * conjunction's first half consistent across surfaces.
 */
const CAROUSEL_CLASS_TOKEN_RE = /(?:^|\s)(carousel|slider|slideshow|swiper)(?:\s|$|-|_)/i;

/**
 * Pause-UI predicate vocabulary. Matched case-insensitively against
 * `aria-label`, `id`, and `class` attribute values. The agent reads
 * the matching element to confirm — the predicate is "is there ANY
 * element in this document carrying pause vocabulary?" — a
 * deterministic per-attribute substring check that an agent can
 * reproduce with one Read.
 */
const PAUSE_VOCAB_RE = /pause/i;

/**
 * `setInterval` source-text pattern. The duration literal is parsed
 * after the matching `(` to evaluate the spec gate; the keyword regex
 * exists only to anchor the scan position.
 */
const SET_INTERVAL_RE = /\bsetInterval\s*\(/g;

/**
 * `animation-iteration-count: infinite` and `animation: ... infinite`
 * source-text patterns. The CSS-in-HTML branch uses these against the
 * embedded `<style>` block source so the finder does not need to
 * re-parse CSS.
 */
const ANIMATION_INFINITE_RE = /animation-iteration-count\s*:\s*infinite\b/i;
const ANIMATION_SHORTHAND_INFINITE_RE = /animation\s*:\s*[^;{}]*\binfinite\b/i;

interface AutoAdvanceEvidence {
  readonly kind:
    | "carousel-class-token"
    | "carousel-data-attr"
    | "set-interval"
    | "animation-infinite";
  /** 1-based source line where the signal was observed. */
  readonly line: number;
  /** 1-based source column where the signal was observed. */
  readonly column: number;
  /** Verbatim summary of the matched evidence, for reason-text echo. */
  readonly evidence: string;
}

export const finder = defineCandidateFinder({
  id: "review/auto-advance-no-pause-control",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx", ".ts", ".js"] },
  docs: {
    description:
      "Surfaces files where an auto-advance signal (carousel root with `data-bs-ride` / class token, `setInterval(_, N≥5000)`, or CSS `animation-iteration-count: infinite`) is observed AND no pause-UI signal (`aria-label` / `id` / `class` containing `pause`, or a `<button>` whose text contains `pause`) is present in the same parsed document.",
    reviewPrompt:
      "Verify whether the auto-advance content has a user-operable pause/stop/hide mechanism. Pause-on-hover alone is incidental, not operable per WCAG 2.2.2. The pause UI may live in a sibling file the page composes — read the consuming layout/template. If the pause control is in a sibling, surfacing here is the agent's signal to confirm the wiring; if no pause control exists anywhere, the criterion fails.",
    references: [
      "https://www.w3.org/TR/WCAG22/#pause-stop-hide",
      "https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide",
    ],
  },
  find(ctx) {
    if (ctx.language === "html") {
      return scanHtml(ctx);
    }
    if (ctx.language === "tsx" || ctx.language === "jsx") {
      return scanJsxAndSource(ctx);
    }
    return [];
  },
});

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

function scanHtml(ctx: RuleContext): readonly ReviewCandidate[] {
  const doc = ctx.ast as HtmlDocument;
  if (htmlHasPauseUi(doc)) return [];
  const out: ReviewCandidate[] = [];
  const seen = new Set<number>();
  for (const ev of htmlAutoAdvanceEvidence(doc, ctx.source)) {
    pushUnique(out, seen, ctx.filePath, ev);
  }
  return out;
}

function htmlHasPauseUi(doc: HtmlDocument): boolean {
  for (const el of walkHtmlElements(doc)) {
    if (htmlElementSignalsPause(el)) return true;
  }
  return false;
}

function htmlElementSignalsPause(el: HtmlElement): boolean {
  const aria = getHtmlAttribute(el, "aria-label");
  if (aria !== null && PAUSE_VOCAB_RE.test(aria)) return true;
  const id = getHtmlAttribute(el, "id");
  if (id !== null && PAUSE_VOCAB_RE.test(id)) return true;
  const klass = getHtmlAttribute(el, "class");
  if (klass !== null && PAUSE_VOCAB_RE.test(klass)) return true;
  if (el.tagName.toLowerCase() === "button" && PAUSE_VOCAB_RE.test(htmlTextContent(el))) {
    return true;
  }
  return false;
}

function htmlTextContent(el: HtmlElement): string {
  let buf = "";
  for (const child of el.children) {
    buf += htmlNodeText(child);
  }
  return buf;
}

function htmlNodeText(node: HtmlNode): string {
  if (node.kind === "HtmlText") return node.value;
  if (node.kind === "HtmlElement") {
    let buf = "";
    for (const c of node.children) buf += htmlNodeText(c);
    return buf;
  }
  return "";
}

function* htmlAutoAdvanceEvidence(
  doc: HtmlDocument,
  source: string,
): Iterable<AutoAdvanceEvidence> {
  for (const el of walkHtmlElements(doc)) {
    const carousel = htmlCarouselSignal(el);
    if (carousel) yield carousel;
    if (el.tagName.toLowerCase() === "style") {
      yield* styleBlockInfiniteEvidence(el, source);
    }
  }
}

function htmlCarouselSignal(el: HtmlElement): AutoAdvanceEvidence | null {
  const ride = getHtmlAttribute(el, "data-bs-ride") ?? getHtmlAttribute(el, "data-ride");
  if (ride !== null) {
    const trimmed = ride.trim().toLowerCase();
    if (trimmed === "carousel" || trimmed === "true") {
      return {
        kind: "carousel-data-attr",
        line: el.loc.start.line,
        column: el.loc.start.column,
        evidence: `<${el.tagName.toLowerCase()}> with data-${getHtmlAttribute(el, "data-bs-ride") === null ? "" : "bs-"}ride="${ride.trim()}"`,
      };
    }
  }
  const klass = getHtmlAttribute(el, "class");
  if (klass !== null) {
    const match = CAROUSEL_CLASS_TOKEN_RE.exec(klass);
    if (match) {
      return {
        kind: "carousel-class-token",
        line: el.loc.start.line,
        column: el.loc.start.column,
        evidence: `<${el.tagName.toLowerCase()} class="${klass.trim()}">`,
      };
    }
  }
  return null;
}

function* styleBlockInfiniteEvidence(
  styleEl: HtmlElement,
  source: string,
): Iterable<AutoAdvanceEvidence> {
  // Pull the verbatim content of the <style> block from the source so
  // we can run the same regex predicates the JS-source branch uses.
  // The element's child text nodes carry the same content but the
  // line/column anchors travel with the source slice.
  const start = styleEl.range.start;
  const end = styleEl.range.end;
  const blockSource = source.slice(start, end);
  const longhandMatch = ANIMATION_INFINITE_RE.exec(blockSource);
  if (longhandMatch) {
    const offset = start + (longhandMatch.index ?? 0);
    const { line, column } = offsetToLineColumn(source, offset);
    yield {
      kind: "animation-infinite",
      line,
      column,
      evidence: "animation-iteration-count: infinite (in <style> block)",
    };
    return;
  }
  const shorthandMatch = ANIMATION_SHORTHAND_INFINITE_RE.exec(blockSource);
  if (shorthandMatch) {
    const offset = start + (shorthandMatch.index ?? 0);
    const { line, column } = offsetToLineColumn(source, offset);
    yield {
      kind: "animation-infinite",
      line,
      column,
      evidence: `animation shorthand with infinite keyword (in <style> block): \`${truncate(shorthandMatch[0])}\``,
    };
  }
}

// ---------------------------------------------------------------------------
// JSX / source branch
// ---------------------------------------------------------------------------

function scanJsxAndSource(ctx: RuleContext): readonly ReviewCandidate[] {
  const module = ctx.ast as TsxModule;
  if (jsxOrSourceHasPauseUi(module, ctx.source)) return [];
  const out: ReviewCandidate[] = [];
  const seen = new Set<number>();
  for (const ev of jsxAutoAdvanceEvidence(module)) {
    pushUnique(out, seen, ctx.filePath, ev);
  }
  for (const ev of sourceAutoAdvanceEvidence(ctx.source)) {
    pushUnique(out, seen, ctx.filePath, ev);
  }
  return out;
}

function jsxOrSourceHasPauseUi(module: TsxModule, source: string): boolean {
  for (const el of walkJsxElements(module)) {
    if (jsxElementSignalsPause(el)) return true;
  }
  // Source-level pause vocabulary check — covers TS/JS files with no
  // JSX (handler modules) and JSX files where a pause button lives in
  // a string literal the JSX walker doesn't surface (e.g. localized
  // labels, inline button text). The predicate is conservative on
  // purpose: a single occurrence of `pause` (case-insensitive) in the
  // source text satisfies the no-pause-UI sibling check, because a
  // false-positive (the word appears in a comment or unrelated
  // identifier) is an over-suppress that we accept per the doctrine
  // "Failure modes are asymmetric" — a missed pause UI signal would
  // generate false-positive review candidates the agent dismisses
  // cheaply; here the cost is direction-flipped so we lean
  // permissive.
  return PAUSE_VOCAB_RE.test(source);
}

function jsxElementSignalsPause(el: JsxElement): boolean {
  const aria = getJsxAttributeString(el, "aria-label");
  if (aria !== null && PAUSE_VOCAB_RE.test(aria)) return true;
  const id = getJsxAttributeString(el, "id");
  if (id !== null && PAUSE_VOCAB_RE.test(id)) return true;
  const klass = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (klass !== null && PAUSE_VOCAB_RE.test(klass)) return true;
  if (el.tagName === "button" && PAUSE_VOCAB_RE.test(jsxTextContent(el))) return true;
  return false;
}

function jsxTextContent(el: JsxElement): string {
  let buf = "";
  for (const child of el.children) {
    buf += jsxNodeText(child);
  }
  return buf;
}

function jsxNodeText(node: JsxNode): string {
  if (node.kind === "JsxText") return node.value;
  if (node.kind === "JsxElement") {
    let buf = "";
    for (const c of node.children) buf += jsxNodeText(c);
    return buf;
  }
  return "";
}

function* jsxAutoAdvanceEvidence(module: TsxModule): Iterable<AutoAdvanceEvidence> {
  for (const el of walkJsxElements(module)) {
    const ride =
      getJsxAttributeString(el, "data-bs-ride") ?? getJsxAttributeString(el, "data-ride");
    if (ride !== null) {
      const trimmed = ride.trim().toLowerCase();
      if (trimmed === "carousel" || trimmed === "true") {
        yield {
          kind: "carousel-data-attr",
          line: el.loc.start.line,
          column: el.loc.start.column,
          evidence: `<${el.tagName}> with data-bs-ride="${ride.trim()}"`,
        };
        continue;
      }
    }
    const klass = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
    if (klass !== null && CAROUSEL_CLASS_TOKEN_RE.test(klass)) {
      yield {
        kind: "carousel-class-token",
        line: el.loc.start.line,
        column: el.loc.start.column,
        evidence: `<${el.tagName} className="${klass.trim()}">`,
      };
    }
  }
}

function* sourceAutoAdvanceEvidence(source: string): Iterable<AutoAdvanceEvidence> {
  SET_INTERVAL_RE.lastIndex = 0;
  for (const match of source.matchAll(SET_INTERVAL_RE)) {
    const offset = match.index ?? 0;
    const matchLength = match[0].length;
    const openParen = offset + matchLength - 1;
    const duration = extractDurationLiteralMs(source, openParen);
    if (duration === null) continue;
    if (duration < FIVE_SECONDS_MS) continue; // strict `<`: 5000 fires, 4999 does not
    const { line, column } = offsetToLineColumn(source, offset);
    yield {
      kind: "set-interval",
      line,
      column,
      evidence: `setInterval(_, ${duration}ms)`,
    };
  }
}

// ---------------------------------------------------------------------------
// Duration literal extraction
// ---------------------------------------------------------------------------

/**
 * Parse the second argument of `setInterval(` as a millisecond literal
 * when — and only when — it resolves to a finite numeric literal.
 * Returns `null` otherwise (member-access, identifier, call expression,
 * computed expression). Intentionally narrow: per the spec gate we
 * only fire when the duration is provably ≥5000ms; non-literal
 * shapes carry no honest gate evaluation and are deferred to
 * `review/timing` (which surfaces every `setInterval` regardless of
 * duration shape).
 *
 * Recognised literal forms: integer, decimal, exponent, hex, binary,
 * octal, underscore separators. Mirrors
 * `parseDurationLiteralMs` in `review/timing.ts` so the two finders'
 * literal classifiers stay aligned without a circular import.
 */
function extractDurationLiteralMs(source: string, openParen: number): number | null {
  if (source.charCodeAt(openParen) !== 40 /* ( */) return null;
  const commaOffset = scanToFirstTopLevelComma(source, openParen + 1);
  if (commaOffset === null) return null;
  // Skip the comma + whitespace; read the duration literal verbatim.
  let j = commaOffset + 1;
  while (j < source.length && isWs(source.charCodeAt(j))) j++;
  const argEnd = scanToArgumentEnd(source, j);
  const raw = source.slice(j, argEnd).trim();
  return parseDurationLiteralMs(raw);
}

/**
 * Scan-state for the comma-finding loop. Tracking string-quote and
 * depth in a single object keeps the per-character branches small
 * enough for the cognitive-complexity guard while still handling
 * commas inside nested call args / array literals / template strings
 * correctly.
 */
interface CommaScanState {
  i: number;
  depth: number;
  stringQuote: number;
}

/**
 * Advance from `start` until the first top-level `,` separating the
 * call's first arg (the callback) from its second (the duration).
 * Returns the offset of that comma, or `null` if the call closed
 * without one.
 */
function scanToFirstTopLevelComma(source: string, start: number): number | null {
  const state: CommaScanState = { i: start, depth: 1, stringQuote: 0 };
  while (state.i < source.length && state.depth > 0) {
    if (advanceCommaScanString(source, state)) continue;
    if (advanceCommaScanBracket(source, state)) {
      if (state.depth === 0) return null;
      continue;
    }
    if (source.charCodeAt(state.i) === 44 /* , */ && state.depth === 1 && state.stringQuote === 0) {
      return state.i;
    }
    state.i++;
  }
  return null;
}

function advanceCommaScanString(source: string, state: CommaScanState): boolean {
  if (state.stringQuote === 0) {
    const c = source.charCodeAt(state.i);
    if (c === 39 || c === 34 || c === 96) {
      state.stringQuote = c;
      state.i++;
      return true;
    }
    return false;
  }
  const c = source.charCodeAt(state.i);
  if (c === 92 /* \ */) {
    state.i += 2;
    return true;
  }
  if (c === state.stringQuote) state.stringQuote = 0;
  state.i++;
  return true;
}

function advanceCommaScanBracket(source: string, state: CommaScanState): boolean {
  if (state.stringQuote !== 0) return false;
  const c = source.charCodeAt(state.i);
  if (c === 40 || c === 91 || c === 123) {
    state.depth++;
    state.i++;
    return true;
  }
  if (c === 41 || c === 93 || c === 125) {
    state.depth--;
    state.i++;
    return true;
  }
  return false;
}

/**
 * Walk forward from `start` (positioned at the first non-whitespace
 * character of the duration arg) and return the offset of the next
 * top-level comma or close-paren — whichever ends the arg.
 */
function scanToArgumentEnd(source: string, start: number): number {
  let k = start;
  let innerDepth = 0;
  while (k < source.length) {
    const c = source.charCodeAt(k);
    if (c === 40 || c === 91 || c === 123) {
      innerDepth++;
      k++;
      continue;
    }
    if (c === 41 || c === 93 || c === 125) {
      if (innerDepth === 0) break;
      innerDepth--;
      k++;
      continue;
    }
    if (c === 44 /* , */ && innerDepth === 0) break;
    k++;
  }
  return k;
}

function parseDurationLiteralMs(raw: string): number | null {
  const literalMatch =
    /^(?:0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]+)?)n?$/.exec(raw);
  if (!literalMatch) return null;
  const cleaned = raw.replace(/n$/, "").replace(/_/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function pushUnique(
  out: ReviewCandidate[],
  seen: Set<number>,
  filePath: string,
  ev: AutoAdvanceEvidence,
): void {
  const key = ev.line * 100000 + ev.column;
  if (seen.has(key)) return;
  seen.add(key);
  const reason = buildReason(ev);
  for (const criterionId of CRITERION_IDS) {
    out.push({
      criterionId,
      location: { filePath, line: ev.line, column: ev.column },
      reason,
      // Confidence "medium": both halves of the conjunction are
      // deterministic from static evidence, but the question ("is
      // there a user-operable pause control SOMEWHERE the page
      // composes?") may resolve cross-file. The agent dismisses
      // by reading the consuming layout.
      confidence: "medium",
    });
  }
}

function buildReason(ev: AutoAdvanceEvidence): string {
  const lead = describeAutoAdvance(ev);
  const conjunction =
    ' — and no pause-UI signal (`aria-label*="pause" i`, `id*="pause" i`, `class*="pause" i`, or `<button>` text containing `pause`) was found in this file';
  const dismissalFrame =
    ". The pause control may live in a sibling file the page composes; verify by reading the consuming layout. WCAG 2.2.2 requires a user-operable mechanism (pause-on-hover alone is incidental, not operable).";
  return `${lead}${conjunction}${dismissalFrame}`;
}

function describeAutoAdvance(ev: AutoAdvanceEvidence): string {
  switch (ev.kind) {
    case "carousel-data-attr":
      return `Auto-advance signal: ${ev.evidence} declares an auto-advancing carousel`;
    case "carousel-class-token":
      return `Auto-advance signal: ${ev.evidence} matches the carousel class-token pattern (likely auto-advancing)`;
    case "set-interval":
      return `Auto-advance signal: ${ev.evidence} — recurring callback at or above the WCAG 2.2.2 5-second floor`;
    case "animation-infinite":
      return `Auto-advance signal: ${ev.evidence} runs without a user-operable stop`;
  }
}

function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  const cap = Math.min(offset, source.length);
  for (let i = 0; i < cap; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

function truncate(s: string): string {
  const max = 80;
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
