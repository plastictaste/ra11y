/**
 * Candidate finder: review/pointer-input
 * Criteria: wcag22:2.5.1 (pointer gestures, A)
 *           wcag22:2.5.6 (concurrent input mechanisms, AAA)
 *
 * Spec:  https://www.w3.org/TR/WCAG22/#pointer-gestures
 *        https://www.w3.org/TR/WCAG22/#concurrent-input-mechanisms
 *
 * Surfaces uses of path-based / multipoint pointer and touch event
 * handlers. Both criteria are reviewer questions, not mechanical checks:
 * 2.5.1 asks whether gesture-driven behavior also works with a single
 * click / tap, and 2.5.6 asks whether the interface silently restricts
 * input to one modality when multiple are available. Neither can be
 * decided from a handler name alone — the reviewer reads what the
 * handler does.
 *
 * Per CLAUDE.md §1 we surface; we don't guess whether a `onPointerMove`
 * is the path stroke of a signature pad (gesture-required — likely
 * real 2.5.1 issue) or a hover-tooltip trigger (no gesture — fine).
 *
 * The finder fires on three classes of evidence:
 *   1. JSX event-handler attributes known to be path-based / multipoint
 *      (onPointerMove, onTouchMove, gesture*).
 *   2. addEventListener() calls for the same set of DOM event names.
 *   3. Path-based library-author patterns the single-handler scan
 *      misses — co-occurring `touchstart`+`touchmove` or
 *      `pointerdown`+`pointermove` listeners in one file (classic
 *      swipe/drag implementations), plus file/class/function
 *      identifiers matching /swipe|pan|pinch|rotate/i.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { walkJsxElements } from "../../engine/ast-helpers.ts";
import type { TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import type { RuleContext } from "../../types/rule.ts";

const CRITERION_IDS = ["wcag22:2.5.1", "wcag21:2.5.1", "wcag22:2.5.6", "wcag21:2.5.6"] as const;

/**
 * JSX event-handler attribute names that indicate path-based,
 * multipoint, or touch-only interaction. Point-in-time handlers like
 * onClick / onPointerDown are NOT listed — they work with any pointer.
 */
const GESTURE_HANDLERS: ReadonlySet<string> = new Set([
  "onPointerMove",
  "onTouchMove",
  "onGestureStart",
  "onGestureChange",
  "onGestureEnd",
  "onTouchStart",
  "onTouchEnd",
  "onTouchCancel",
]);

/**
 * Source-text patterns for DOM-event listener registration from non-JSX
 * TS/JS code (addEventListener calls, Web API event names used as
 * property handlers). Complements the JSX walk.
 */
const SOURCE_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  {
    pattern:
      /addEventListener\s*\(\s*['"`](pointermove|touchmove|gesturestart|gesturechange|gestureend|touchstart|touchend|touchcancel)['"`]/g,
    label: "addEventListener('$1')",
  },
];

/**
 * addEventListener call for one of the "start/down" point-in-time
 * events. These are NOT gesture events on their own (a single tap fires
 * `touchstart`), so we don't report them directly — but their
 * co-occurrence with a `touchmove` / `pointermove` handler in the same
 * file is strong evidence of path tracking (the classic swipe/drag
 * implementation: record on start, update on move).
 */
const PATH_START_PATTERN = /addEventListener\s*\(\s*['"`](touchstart|pointerdown)['"`]/g;

/**
 * addEventListener call for the "move" handler that pairs with a
 * `start`/`down` event to form a path-based gesture. When we see a
 * start/down in the same file, we upgrade the move candidate's reason
 * to name the path pattern instead of the standalone move handler.
 */
const PATH_MOVE_PATTERN = /addEventListener\s*\(\s*['"`](touchmove|pointermove)['"`]/g;

/**
 * Identifier-name tokens that signal gesture-driven interaction when
 * they appear as a file basename, class name, function name, or
 * top-level binding name. Word-boundary anchored on both sides — the
 * match ends at a word boundary or at a camelCase uppercase split so
 * the token can't bleed into unrelated identifiers like `panels`,
 * `panelSlide`, `span`, `planet`, or `expanded` (the prior left-only
 * boundary was the substring-match bug, see backlog
 * Q5-POINTER-GESTURES-SUBSTRING-FALSE-POSITIVE).
 */
const NAME_TOKENS = ["swipe", "pan", "pinch", "rotate"] as const;
type NameToken = (typeof NAME_TOKENS)[number];

/**
 * Matches any of the gesture tokens at a word boundary on the left
 * AND a word boundary on the right — where the right boundary is
 * either the end of a word (`\b`), a non-letter character, or the
 * start of a camelCase split (uppercase letter after a lowercase
 * continuation). The inner alternation enumerates the verb variants
 * we recognize per token:
 *
 *   - swipe / swiped / swipes / swiper / swipers / swiping
 *   - pan / panned / panning / panner / panners / panGesture
 *   - pinch / pinched / pinches / pincher / pinchers / pinching
 *   - rotate / rotated / rotates / rotation / rotating / rotator / rotators
 *
 * Allowing the lookahead `[A-Z]` handles camelCase identifiers:
 * `SwipeHandler`, `PinchZoom`, `panHandler`, `rotateView` all match
 * because `swipe`/`pinch`/`pan`/`rotate` end at the uppercase split.
 *
 * What does NOT match (the regression the fix restores):
 *   `panels`, `panelSlide`, `span`, `planet`, `expanded`, `plan`,
 *   `spandex`, `canopy`.
 */
const NAME_TOKEN_PATTERN =
  /\b(?:([Ss]wipe)(?:d|rs|r|s|ing)?|([Pp]an)(?:ned|ning|ners|ner|Gesture)?|([Pp]inch)(?:ed|es|ers|er|ing)?|([Rr]otat)(?:ed|es|ors|or|ion|ing|e))(?=[A-Z]|[^A-Za-z]|$)/;

/**
 * Map a successful `NAME_TOKEN_PATTERN` match back to the bare-token
 * name (`swipe` / `pan` / `pinch` / `rotate`). Each alternative in
 * `NAME_TOKEN_PATTERN` has its own capture group at indices 1..4; only
 * one is populated per match. Returns `null` if none is populated
 * (should never happen for a successful match).
 */
function tokenFromMatch(match: RegExpMatchArray): NameToken | null {
  if (match[1]) return "swipe";
  if (match[2]) return "pan";
  if (match[3]) return "pinch";
  // `rotate` captures just the `[Rr]otat` stem — map it back to the
  // canonical token name.
  if (match[4]) return "rotate";
  return null;
}

/**
 * Pattern to locate identifier declarations in source. Captures the
 * declared identifier for class, function, const/let/var bindings. Not
 * a full parser — skips lines whose first non-whitespace char starts a
 * line comment (`//`) or is inside a block-comment continuation (`*`)
 * to cheaply avoid hits in JSDoc / commented-out code. String literals
 * can't contain `class Foo` at a keyword position so we don't strip
 * those.
 */
const IDENTIFIER_DECL_PATTERN =
  /(?:^|[^A-Za-z0-9_$])(class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;

const GESTURE_REASON =
  " — verify the interaction also works with a single-point input (click/tap) and that the interface does not restrict the user to a single input mechanism";

export const finder = defineCandidateFinder({
  id: "review/pointer-input",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".tsx", ".jsx", ".ts", ".js"] },
  docs: {
    description:
      "Finds path-based/multipoint pointer and touch event handlers (onPointerMove, onTouchMove, gesture events), co-occurring touchstart+touchmove / pointerdown+pointermove pairs that signal path tracking, and file/class/function identifiers named like swipe/pan/pinch/rotate — signals of gesture-driven UI that must offer a single-pointer alternative (2.5.1) and support concurrent input modalities (2.5.6).",
    reviewPrompt:
      "At each handler, determine what the interaction does. If the user can only achieve the outcome through a path, swipe, pinch, or multi-finger gesture, verify a single-pointer alternative exists (2.5.1). If the handler restricts input to touch only — no equivalent mouse/keyboard path — verify that's intended, else add the alternative (2.5.6).",
    references: [
      "https://www.w3.org/TR/WCAG22/#pointer-gestures",
      "https://www.w3.org/TR/WCAG22/#concurrent-input-mechanisms",
    ],
  },
  find(ctx) {
    const out: ReviewCandidate[] = [];
    if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxHandlers(ctx.ast as TsxModule, ctx.filePath, out);
    }
    findSourceHandlers(ctx, out);
    findPathBasedPairs(ctx, out);
    findNamePatternHits(ctx, out);
    return out;
  },
});

function findJsxHandlers(module: TsxModule, filePath: string, out: ReviewCandidate[]): void {
  for (const el of walkJsxElements(module)) {
    for (const attr of el.attributes) {
      if (!GESTURE_HANDLERS.has(attr.name)) continue;
      for (const criterionId of CRITERION_IDS) {
        // Confidence "high": the path-based / multipoint handler
        // attribute set (onPointerMove, onTouchMove, gesture*) is a
        // closed list — a JSX element carrying one of these names IS
        // using gesture-style input. Point-in-time handlers (onClick,
        // onPointerDown) are not in the set.
        out.push({
          criterionId,
          location: { filePath, line: attr.loc.start.line, column: attr.loc.start.column },
          reason: `<${el.tagName}> has ${attr.name}${GESTURE_REASON}`,
          confidence: "high",
        });
      }
    }
  }
}

function findSourceHandlers(ctx: RuleContext, out: ReviewCandidate[]): void {
  const seen = new Set<number>();
  for (const { pattern, label } of SOURCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of ctx.source.matchAll(pattern)) {
      const offset = match.index ?? 0;
      if (seen.has(offset)) continue;
      seen.add(offset);
      const { line, column } = offsetToLineColumn(ctx.source, offset);
      const token = match[1] ?? "";
      const rendered = label.replace("$1", token);
      for (const criterionId of CRITERION_IDS) {
        // Confidence "high": addEventListener with one of the closed
        // gesture-event strings (pointermove, touchmove, gesture*) —
        // the string literal is unambiguous evidence of wiring.
        out.push({
          criterionId,
          location: { filePath: ctx.filePath, line, column },
          reason: `${rendered}${GESTURE_REASON}`,
          confidence: "high",
        });
      }
    }
  }
}

/**
 * Extension (a): co-occurrence of `touchstart`+`touchmove` or
 * `pointerdown`+`pointermove` in one file. The individual start/down
 * handlers are point-in-time (a tap fires `touchstart` too), so they
 * are not flagged standalone; but their presence alongside a `move`
 * listener is a textbook signal of path-based tracking — the move
 * handler records points into a path and the start handler anchors
 * the gesture. We emit the candidate at the *move* call site (stable
 * anchor reusing the existing offset) and upgrade the reason text to
 * name the pair; we then suppress the standalone "addEventListener('touchmove')"
 * candidate at the same offset so a single source event yields a
 * single candidate per criterion.
 */
function findPathBasedPairs(ctx: RuleContext, out: ReviewCandidate[]): void {
  const starts = collectMatches(ctx.source, PATH_START_PATTERN);
  if (starts.size === 0) return;
  const moves = collectMatches(ctx.source, PATH_MOVE_PATTERN);
  if (moves.size === 0) return;

  const pairs: Array<{ start: string; move: string }> = [];
  if (starts.has("touchstart") && moves.has("touchmove")) {
    pairs.push({ start: "touchstart", move: "touchmove" });
  }
  if (starts.has("pointerdown") && moves.has("pointermove")) {
    pairs.push({ start: "pointerdown", move: "pointermove" });
  }
  if (pairs.length === 0) return;

  for (const pair of pairs) {
    const moveOffsets = moves.get(pair.move);
    if (!moveOffsets || moveOffsets.length === 0) continue;
    // biome-ignore lint/style/noNonNullAssertion: length > 0 guard above ensures index 0 exists
    const anchorOffset = moveOffsets[0]!;
    const { line, column } = offsetToLineColumn(ctx.source, anchorOffset);
    // Dedupe: remove any standalone addEventListener candidate already
    // emitted at the same (filePath, line, column). The path-based
    // reason subsumes the standalone one.
    removeCandidatesAt(out, ctx.filePath, line, column);
    for (const criterionId of CRITERION_IDS) {
      // Confidence "high": the co-occurrence of a start/down listener
      // and its paired move listener in one file is a deterministic
      // static signal — the pair IS the path-tracking pattern. The
      // reviewer still decides whether the path is essential to the
      // interaction; the scanner only claims the pattern is present.
      out.push({
        criterionId,
        location: { filePath: ctx.filePath, line, column },
        reason:
          `path-based gesture detected — \`${pair.start}\` + \`${pair.move}\` listeners co-occur in this file, indicating path tracking` +
          GESTURE_REASON,
        confidence: "high",
      });
    }
  }
}

/**
 * Extension (b): file basename and identifier-name heuristics. A file
 * called `swipe.js`, a `class PinchZoom`, a `function rotate()`, a
 * `const panHandler = …` — any of these names are conventional signs
 * of gesture-driven code even when the handler names alone look
 * innocuous (the project may wire its own event abstractions). We
 * emit one candidate per named identifier, plus one for a matching
 * file basename anchored at line 1.
 *
 * Gated on a same-file companion signal (see `hasCompanionSignal`):
 * identifier / basename evidence alone is too weak — `rotate` can
 * mean "rotate a 3D model with the keyboard," `pan` can mean "pan a
 * camera with arrow keys," `pinch` can be a CSS-animation utility.
 * When a touch/pointer path-tracking listener or a pointer-event
 * library import is present in the same file, the combined evidence
 * is strong enough to surface a candidate; otherwise we drop it
 * (the handler-level and path-pair branches above still fire on the
 * listeners themselves, so real gesture code is never silent).
 *
 * This is a *detection* refinement, not suppression: the signal of
 * an identifier-substring match with no companion evidence was never
 * strong enough to act on — it was firing on things like
 * `const panels = document.querySelectorAll(".panel")` where `pan`
 * is a coincidental substring. See backlog entry
 * `Q5-POINTER-GESTURES-SUBSTRING-FALSE-POSITIVE`.
 */
function findNamePatternHits(ctx: RuleContext, out: ReviewCandidate[]): void {
  if (!hasCompanionSignal(ctx.source)) return;
  const seen = new Set<string>();
  emitBasenameHit(ctx, out, seen);
  emitIdentifierHits(ctx, out, seen);
}

function emitBasenameHit(ctx: RuleContext, out: ReviewCandidate[], seen: Set<string>): void {
  const basename = extractBasename(ctx.filePath);
  const basenameMatch = basename.match(NAME_TOKEN_PATTERN);
  if (!basenameMatch) return;
  const token = tokenFromMatch(basenameMatch);
  if (!token) return;
  const key = `basename:${basename}`;
  if (seen.has(key)) return;
  seen.add(key);
  for (const criterionId of CRITERION_IDS) {
    // Confidence "medium": a filename containing a gesture token
    // is conventional evidence but not dispositive — `pan.ts`
    // could be a camera-pan utility, or text-panning, or an
    // animation helper that takes any pointer input. The reviewer
    // opens the file and decides.
    out.push({
      criterionId,
      location: { filePath: ctx.filePath, line: 1, column: 1 },
      reason: `file basename \`${basename}\` suggests a ${token} gesture interaction${GESTURE_REASON}`,
      confidence: "medium",
    });
  }
}

function emitIdentifierHits(ctx: RuleContext, out: ReviewCandidate[], seen: Set<string>): void {
  for (const hit of collectIdentifierHits(ctx.source)) {
    const tokenMatch = hit.identifier.match(NAME_TOKEN_PATTERN);
    if (!tokenMatch) continue;
    const token = tokenFromMatch(tokenMatch);
    if (!token) continue;
    const { line, column } = offsetToLineColumn(ctx.source, hit.offset);
    const key = `ident:${line}:${column}:${hit.identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const criterionId of CRITERION_IDS) {
      // Confidence "medium": identifier-name evidence is strong but
      // not dispositive — `panHandler` could mean camera-pan, text
      // pan, or audio-pan. The reviewer confirms by reading the body.
      out.push({
        criterionId,
        location: { filePath: ctx.filePath, line, column },
        reason:
          `name \`${hit.identifier}\` (${hit.kind}) suggests a ${token} gesture interaction` +
          GESTURE_REASON,
        confidence: "medium",
      });
    }
  }
}

/**
 * Source-text patterns that indicate the file contains direct
 * evidence of path-tracking / multipoint pointer input, beyond mere
 * identifier naming:
 *
 *   - An `addEventListener` call for `touchstart` / `touchmove` /
 *     `pointermove` (or `touchend` / `pointerdown` paired with them,
 *     which the path-pair branch already surfaces directly).
 *   - An import of a well-known pointer-event library:
 *     `hammerjs` / `hammer.js`, `use-gesture`, `@use-gesture/*`.
 *
 * These signals make the identifier-name branch informative: a file
 * that imports `@use-gesture/react` AND declares a `panHandler` is
 * almost certainly doing pan-gesture work; a file that merely has a
 * `const panels` variable and click handlers is not.
 */
const COMPANION_LISTENER_PATTERN =
  /addEventListener\s*\(\s*['"`](touchstart|touchmove|pointermove)['"`]/;
const COMPANION_LIBRARY_PATTERN =
  /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"`](hammer(?:js|\.js)?|use-gesture|@use-gesture\/[\w-]+)['"`]/;

function hasCompanionSignal(source: string): boolean {
  if (COMPANION_LISTENER_PATTERN.test(source)) return true;
  if (COMPANION_LIBRARY_PATTERN.test(source)) return true;
  return false;
}

interface IdentifierHit {
  readonly kind: "class" | "function" | "const" | "let" | "var";
  readonly identifier: string;
  readonly offset: number;
}

function collectIdentifierHits(source: string): IdentifierHit[] {
  const out: IdentifierHit[] = [];
  IDENTIFIER_DECL_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(IDENTIFIER_DECL_PATTERN)) {
    const matchOffset = match.index ?? 0;
    // biome-ignore lint/style/noNonNullAssertion: matchAll pattern guarantees groups 0-2 exist
    const whole = match[0]!;
    // biome-ignore lint/style/noNonNullAssertion: matchAll pattern guarantees groups 0-2 exist
    const keyword = match[1]!;
    // biome-ignore lint/style/noNonNullAssertion: matchAll pattern guarantees groups 0-2 exist
    const identifier = match[2]!;
    // Locate the keyword inside the matched text (accounts for the
    // optional leading non-word char the pattern captures).
    const keywordRelative = whole.indexOf(keyword);
    const keywordOffset = matchOffset + keywordRelative;
    if (isInsideCommentOrString(source, keywordOffset)) continue;
    // Locate the identifier after the keyword; `indexOf` on the whole
    // match returns the first occurrence, which is what we want.
    const identRelative = whole.indexOf(identifier, keywordRelative + keyword.length);
    const identOffset = identRelative >= 0 ? matchOffset + identRelative : keywordOffset;
    out.push({
      kind: keyword as IdentifierHit["kind"],
      identifier,
      offset: identOffset,
    });
  }
  return out;
}

/**
 * Cheap line-level check: does the line containing `offset` start
 * (after leading whitespace) with `//` or `*` — the two cases that
 * would put our keyword inside a comment. Block-comment continuation
 * lines conventionally start with `*` (JSDoc style). This misses
 * uncommon cases (a `class` keyword on the same line as a trailing
 * line comment above doesn't put `class` in a comment; our check is
 * only for whole-line comments). Agents confirm by reading anyway.
 */
function isInsideCommentOrString(source: string, offset: number): boolean {
  // Walk backward to the line start.
  let lineStart = offset;
  while (lineStart > 0 && source.charCodeAt(lineStart - 1) !== 10) {
    lineStart -= 1;
  }
  // Skip leading whitespace.
  let i = lineStart;
  while (i < source.length) {
    const c = source.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i += 1;
  }
  if (i >= offset) return false;
  const first = source.charCodeAt(i);
  // `//` line comment
  if (first === 47 && source.charCodeAt(i + 1) === 47) return true;
  // `*` block-comment continuation (JSDoc-style)
  if (first === 42) return true;
  return false;
}

function collectMatches(source: string, pattern: RegExp): Map<string, number[]> {
  const out = new Map<string, number[]>();
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    const token = match[1] ?? "";
    const offset = match.index ?? 0;
    const list = out.get(token);
    if (list) list.push(offset);
    else out.set(token, [offset]);
  }
  return out;
}

function removeCandidatesAt(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
): void {
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    // biome-ignore lint/style/noNonNullAssertion: loop index is always within bounds
    const c = candidates[i]!;
    if (
      c.location.filePath === filePath &&
      c.location.line === line &&
      c.location.column === column
    ) {
      candidates.splice(i, 1);
    }
  }
}

function extractBasename(filePath: string): string {
  // Strip directory.
  const slashIdx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const tail = slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath;
  // Strip extension.
  const dotIdx = tail.lastIndexOf(".");
  return dotIdx > 0 ? tail.slice(0, dotIdx) : tail;
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
