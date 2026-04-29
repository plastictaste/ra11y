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
 * The finder fires on five classes of evidence:
 *   1. JSX event-handler attributes known to be path-based / multipoint
 *      (onPointerMove, onTouchMove, gesture*).
 *   2. addEventListener() calls for the same set of DOM event names, plus
 *      imports of well-known gesture libraries (hammer.js / hammerjs,
 *      use-gesture, @use-gesture/*, interactjs) which signal a project
 *      has wired gesture input even if the call sites are abstracted.
 *   3. Path-based library-author patterns the single-handler scan
 *      misses — co-occurring `touchstart`+`touchmove` or
 *      `pointerdown`+`pointermove` listeners in one file (classic
 *      swipe/drag implementations), plus file/class/function
 *      identifiers matching /swipe|pan|pinch|rotate/i.
 *   4. HTML inline event-handler attributes: `ontouchstart`, `ontouchmove`,
 *      and `onpointermove` on any element in an HTML / HTM file.
 *   5. Mouse-only listener patterns (`mousedown` / `mousemove` / `mouseup`
 *      via addEventListener, JSX `onMouseDown` / `onMouseMove` /
 *      `onMouseUp`, and HTML inline `onmousedown` / `onmousemove` /
 *      `onmouseup`) when no sibling touch / pointer listener is present
 *      in the same file. Surfaces SC 2.5.1 risk: drawing/drag/path
 *      handlers wired to mouse events alone do not work for touch users.
 *      Suppressed at file-level when a touch or pointer listener is
 *      present (the reviewer is already prompted by branch 1–4 in that
 *      case).
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { getHtmlAttribute, walkHtmlElements, walkJsxElements } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, TsxModule } from "../../types/ast.ts";
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
 * HTML inline event-handler attribute names that indicate path-based or
 * touch-specific interaction. These appear as literal attributes on HTML
 * elements: `<div ontouchstart="...">`. Note: `ontouchstart` is a
 * point-in-time event but its presence alongside `ontouchmove` is the
 * classic path-tracking pair; we surface all three so the reviewer can
 * confirm whether the handler drives a path-based gesture.
 */
const HTML_INLINE_GESTURE_ATTRS: ReadonlySet<string> = new Set([
  "ontouchstart",
  "ontouchmove",
  "onpointermove",
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
 * Import/require patterns for well-known pointer-event gesture libraries.
 * A library import is direct evidence of gesture input being wired in the
 * project even when call sites are abstracted behind component boundaries.
 * Curated short list — only libraries whose primary purpose is gesture
 * input; general-purpose interaction or animation libraries are not included.
 *
 * Covered:
 *   - `hammerjs` / `hammer.js` — most popular multi-touch library
 *   - `use-gesture` — older scoped package name (unscoped)
 *   - `@use-gesture/<package>` — current scoped packages (@use-gesture/react, etc.)
 *   - `interactjs` / `interact.js` — drag-drop and gesture library
 */
const GESTURE_LIBRARY_PATTERN =
  /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"`](hammer(?:js|\.js)?|use-gesture|@use-gesture\/[\w-]+|interact(?:js|\.js)?)['"`]/g;

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
 *).
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

/**
 * JSX event-handler attribute names for mouse-only events. These map
 * 1:1 to the `mousedown`/`mousemove`/`mouseup` DOM events. When wired
 * standalone — without a sibling `onTouchStart` / `onPointerDown` etc.
 * in the same file — they signal that touch and pen users will be
 * locked out of the interaction (the canonical SC 2.5.1 path-tracking
 * risk on drawing canvases and drag-handles).
 */
const MOUSE_ONLY_JSX_HANDLERS: ReadonlySet<string> = new Set([
  "onMouseDown",
  "onMouseMove",
  "onMouseUp",
]);

/**
 * HTML inline event-handler attribute names for mouse-only events.
 * Same shape and rationale as `MOUSE_ONLY_JSX_HANDLERS` but lower-case
 * for HTML attribute matching.
 */
const HTML_INLINE_MOUSE_ONLY_ATTRS: ReadonlySet<string> = new Set([
  "onmousedown",
  "onmousemove",
  "onmouseup",
]);

/**
 * addEventListener call for the mouse-event family. Captured separately
 * from the gesture-event `SOURCE_PATTERNS` because mouse events alone
 * are not gesture evidence — they only become an SC 2.5.1 risk when
 * NO sibling touch/pointer listener is present in the same file.
 * Sibling-silencing is done by `hasTouchOrPointerListenerOrAttr` below.
 */
const MOUSE_LISTENER_PATTERN = /addEventListener\s*\(\s*['"`](mousedown|mousemove|mouseup)['"`]/g;

/**
 * Source-text predicate: does this file contain any touch- or
 * pointer-event listener (`addEventListener` form)? Used to silence
 * mouse-only candidates when the author has already wired a fallback.
 *
 * Listener variants matched: touchstart / touchmove / touchend /
 * touchcancel / pointerdown / pointermove / pointerup / pointercancel /
 * pointerover / pointerout / pointerenter / pointerleave. The wider
 * pointer-event family is included because any one of them is evidence
 * that the author considered non-mouse input modalities — the reviewer
 * does not need a mouse-only candidate on top of the existing
 * branches 1–4 in that case.
 */
const TOUCH_OR_POINTER_LISTENER_PATTERN =
  /addEventListener\s*\(\s*['"`](touchstart|touchmove|touchend|touchcancel|pointerdown|pointermove|pointerup|pointercancel|pointerover|pointerout|pointerenter|pointerleave)['"`]/;

/**
 * JSX event-handler attribute names that count as a touch/pointer
 * fallback. A JSX file declaring `<canvas onMouseDown=... onTouchStart=...>`
 * has paired modalities and the mouse-only candidate is silenced.
 */
const TOUCH_OR_POINTER_JSX_HANDLERS: ReadonlySet<string> = new Set([
  "onTouchStart",
  "onTouchMove",
  "onTouchEnd",
  "onTouchCancel",
  "onPointerDown",
  "onPointerMove",
  "onPointerUp",
  "onPointerCancel",
  "onPointerOver",
  "onPointerOut",
  "onPointerEnter",
  "onPointerLeave",
]);

/**
 * HTML inline event-handler attribute names that count as a
 * touch/pointer fallback. Same family as the JSX set, lower-cased for
 * HTML attribute matching.
 */
const HTML_TOUCH_OR_POINTER_ATTRS: ReadonlySet<string> = new Set([
  "ontouchstart",
  "ontouchmove",
  "ontouchend",
  "ontouchcancel",
  "onpointerdown",
  "onpointermove",
  "onpointerup",
  "onpointercancel",
  "onpointerover",
  "onpointerout",
  "onpointerenter",
  "onpointerleave",
]);

const MOUSE_ONLY_REASON =
  " — pointer-event compatibility — verify a touch / pointer fallback exists (mouse-only listeners do not fire on touch or pen input)";

export const finder = defineCandidateFinder({
  id: "review/pointer-input",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".tsx", ".jsx", ".ts", ".js", ".html", ".htm"] },
  docs: {
    description:
      "Finds path-based/multipoint pointer and touch event handlers (onPointerMove, onTouchMove, gesture events), HTML inline gesture attributes (ontouchstart, ontouchmove, onpointermove), gesture library imports (hammer.js, use-gesture, @use-gesture/*, interactjs), co-occurring touchstart+touchmove / pointerdown+pointermove pairs that signal path tracking, file/class/function identifiers named like swipe/pan/pinch/rotate, and mouse-only listener patterns (mousedown/mousemove/mouseup) without a sibling touch / pointer fallback — signals of gesture-driven UI that must offer a single-pointer alternative (2.5.1) and support concurrent input modalities (2.5.6).",
    reviewPrompt:
      "At each handler, determine what the interaction does. If the user can only achieve the outcome through a path, swipe, pinch, or multi-finger gesture, verify a single-pointer alternative exists (2.5.1). If the handler restricts input to touch only — no equivalent mouse/keyboard path — verify that's intended, else add the alternative (2.5.6).",
    references: [
      "https://www.w3.org/TR/WCAG22/#pointer-gestures",
      "https://www.w3.org/TR/WCAG22/#concurrent-input-mechanisms",
    ],
  },
  find(ctx) {
    const out: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlInlineHandlers(ctx.ast as HtmlDocument, ctx.filePath, out);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxHandlers(ctx.ast as TsxModule, ctx.filePath, out);
    }
    findSourceHandlers(ctx, out);
    findLibraryImports(ctx, out);
    findPathBasedPairs(ctx, out);
    findNamePatternHits(ctx, out);
    findMouseOnlyHandlers(ctx, out);
    return out;
  },
});

// ---------------------------------------------------------------------------
// HTML branch: inline event-handler attributes
// ---------------------------------------------------------------------------

/**
 * Walks HTML elements looking for inline gesture event-handler attributes
 * (`ontouchstart`, `ontouchmove`, `onpointermove`). These are deterministic
 * evidence of the element having touch/pointer-path interaction wired.
 *
 * The attribute value is included in the reason text so the reviewer can
 * see the handler body (or handler name) without opening the file.
 */
function findHtmlInlineHandlers(
  root: HtmlDocument,
  filePath: string,
  out: ReviewCandidate[],
): void {
  for (const el of walkHtmlElements(root)) {
    for (const attrName of HTML_INLINE_GESTURE_ATTRS) {
      const attrValue = getHtmlAttribute(el, attrName);
      if (attrValue === null) continue;
      // Build a short representation: include a snippet of the handler
      // value if it fits, otherwise just the attribute name.
      const snippet = attrValue.length <= 60 ? `="${attrValue}"` : "";
      const reason = `<${el.tagName}> has \`${attrName}${snippet}\`${GESTURE_REASON}`;
      for (const criterionId of CRITERION_IDS) {
        out.push({
          criterionId,
          location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
          reason,
          confidence: "high",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// JS / TS / JSX branch: JSX event-handler attributes
// ---------------------------------------------------------------------------

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
 * Emits a review candidate for each import or require of a well-known
 * gesture library. Library imports are strong, direct evidence that the
 * file is consuming gesture input — even if the call sites are hidden
 * behind an abstraction layer or the library's own API surface.
 *
 * The library name is included in the reason text so the reviewer knows
 * which gesture library is in use without reading the file in full.
 */
function findLibraryImports(ctx: RuleContext, out: ReviewCandidate[]): void {
  GESTURE_LIBRARY_PATTERN.lastIndex = 0;
  for (const match of ctx.source.matchAll(GESTURE_LIBRARY_PATTERN)) {
    const offset = match.index ?? 0;
    const { line, column } = offsetToLineColumn(ctx.source, offset);
    const libraryName = match[1] ?? "";
    for (const criterionId of CRITERION_IDS) {
      // Confidence "high": an import/require of a gesture library is
      // deterministic evidence that gesture input is being used. The
      // agent must still verify whether the gesture the library performs
      // has a single-pointer alternative.
      out.push({
        criterionId,
        location: { filePath: ctx.filePath, line, column },
        reason: `imports gesture library \`${libraryName}\`${GESTURE_REASON}`,
        confidence: "high",
      });
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
 * ``.
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
 *     `hammerjs` / `hammer.js`, `use-gesture`, `@use-gesture/*`,
 *     `interactjs` / `interact.js`.
 *
 * These signals make the identifier-name branch informative: a file
 * that imports `@use-gesture/react` AND declares a `panHandler` is
 * almost certainly doing pan-gesture work; a file that merely has a
 * `const panels` variable and click handlers is not.
 */
const COMPANION_LISTENER_PATTERN =
  /addEventListener\s*\(\s*['"`](touchstart|touchmove|pointermove)['"`]/;
const COMPANION_LIBRARY_PATTERN =
  /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"`](hammer(?:js|\.js)?|use-gesture|@use-gesture\/[\w-]+|interact(?:js|\.js)?)['"`]/;

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

// ---------------------------------------------------------------------------
// Mouse-only branch: SC 2.5.1 pointer-event compatibility (Q9-FINDER)
// ---------------------------------------------------------------------------

/**
 * Detects mouse-only listener patterns and emits review candidates
 * when no sibling touch / pointer listener exists in the same file.
 *
 * SC 2.5.1 requires that path-based and multipoint gestures have a
 * single-pointer alternative. Drawing canvases, drag handles, and
 * pan/swipe handlers wired to `mousedown` / `mousemove` / `mouseup`
 * alone fail this for touch and pen users — the mouse events do not
 * fire on touch input on most platforms (modern browsers synthesize
 * `click` from `tap`, but `mousedown`/`move`/`up` are not reliably
 * dispatched).
 *
 * Confidence "medium": mouse listeners alone are common in click-and-
 * release UI that does not depend on path tracking (range sliders,
 * draggable scrollbars on desktop-only apps), so the agent must read
 * the file to confirm the predicate. Per the AI-first doctrine
 * "Surface, don't suppress" — we frame the question and let the agent
 * adjudicate.
 *
 * Sibling-silence rule: when the file already contains a touch or
 * pointer listener (addEventListener form, JSX handler attribute, or
 * HTML inline attribute), the mouse-only candidate is suppressed. The
 * existing branches 1–4 will already prompt the reviewer; emitting a
 * second candidate at the same file would duplicate the prompt without
 * adding signal.
 */
function findMouseOnlyHandlers(ctx: RuleContext, out: ReviewCandidate[]): void {
  if (hasTouchOrPointerSibling(ctx)) return;
  emitMouseListenerHits(ctx, out);
  if (ctx.language === "html") {
    emitHtmlInlineMouseHits(ctx.ast as HtmlDocument, ctx.filePath, out);
  } else if (ctx.language === "tsx" || ctx.language === "jsx") {
    emitJsxMouseHits(ctx.ast as TsxModule, ctx.filePath, out);
  }
}

/**
 * Returns true when the file contains any touch- or pointer-event
 * sibling — addEventListener call, JSX handler, or HTML inline
 * attribute. The sibling-silencing predicate is file-level (per the
 * dispatch guidance) — scope-level analysis would require call-graph
 * walking and the AI-first doctrine "Don't duplicate capability the
 * agent already has" prefers pointing to file:line and letting the
 * agent investigate the body.
 */
function hasTouchOrPointerSibling(ctx: RuleContext): boolean {
  if (TOUCH_OR_POINTER_LISTENER_PATTERN.test(ctx.source)) return true;
  if (ctx.language === "html") {
    if (htmlHasTouchOrPointerAttr(ctx.ast as HtmlDocument)) return true;
  } else if (ctx.language === "tsx" || ctx.language === "jsx") {
    if (jsxHasTouchOrPointerAttr(ctx.ast as TsxModule)) return true;
  }
  return false;
}

function htmlHasTouchOrPointerAttr(root: HtmlDocument): boolean {
  for (const el of walkHtmlElements(root)) {
    for (const attrName of HTML_TOUCH_OR_POINTER_ATTRS) {
      if (getHtmlAttribute(el, attrName) !== null) return true;
    }
  }
  return false;
}

function jsxHasTouchOrPointerAttr(module: TsxModule): boolean {
  for (const el of walkJsxElements(module)) {
    for (const attr of el.attributes) {
      if (TOUCH_OR_POINTER_JSX_HANDLERS.has(attr.name)) return true;
    }
  }
  return false;
}

function emitMouseListenerHits(ctx: RuleContext, out: ReviewCandidate[]): void {
  MOUSE_LISTENER_PATTERN.lastIndex = 0;
  for (const match of ctx.source.matchAll(MOUSE_LISTENER_PATTERN)) {
    const offset = match.index ?? 0;
    const eventName = match[1] ?? "";
    const { line, column } = offsetToLineColumn(ctx.source, offset);
    for (const criterionId of CRITERION_IDS) {
      out.push({
        criterionId,
        location: { filePath: ctx.filePath, line, column },
        reason: `addEventListener('${eventName}') with no sibling touch/pointer listener in this file${MOUSE_ONLY_REASON}`,
        confidence: "medium",
      });
    }
  }
}

function emitJsxMouseHits(module: TsxModule, filePath: string, out: ReviewCandidate[]): void {
  for (const el of walkJsxElements(module)) {
    for (const attr of el.attributes) {
      if (!MOUSE_ONLY_JSX_HANDLERS.has(attr.name)) continue;
      for (const criterionId of CRITERION_IDS) {
        out.push({
          criterionId,
          location: { filePath, line: attr.loc.start.line, column: attr.loc.start.column },
          reason: `<${el.tagName}> has ${attr.name} with no sibling touch/pointer handler in this file${MOUSE_ONLY_REASON}`,
          confidence: "medium",
        });
      }
    }
  }
}

function emitHtmlInlineMouseHits(
  root: HtmlDocument,
  filePath: string,
  out: ReviewCandidate[],
): void {
  for (const el of walkHtmlElements(root)) {
    for (const attrName of HTML_INLINE_MOUSE_ONLY_ATTRS) {
      const attrValue = getHtmlAttribute(el, attrName);
      if (attrValue === null) continue;
      const snippet = attrValue.length <= 60 ? `="${attrValue}"` : "";
      const reason = `<${el.tagName}> has \`${attrName}${snippet}\` with no sibling touch/pointer handler in this file${MOUSE_ONLY_REASON}`;
      for (const criterionId of CRITERION_IDS) {
        out.push({
          criterionId,
          location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
          reason,
          confidence: "medium",
        });
      }
    }
  }
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
