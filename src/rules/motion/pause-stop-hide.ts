/**
 * Rule: motion/pause-stop-hide
 * Satisfies: wcag22:2.2.2, wcag21:2.2.2
 * Spec: https://www.w3.org/TR/WCAG22/#pause-stop-hide
 *
 * > For moving, blinking, scrolling, or auto-updating information, all
 * > of the following are true: [a mechanism to pause, stop, or hide is
 * > available].
 *
 * Source: https://www.w3.org/TR/WCAG22/#pause-stop-hide
 *
 * This rule targets **auto-updating** motion — motion that starts
 * without user interaction (timers, autoplay attributes, bare
 * animation declarations). Motion that is gated by a user-interaction
 * pseudo-class (`:hover` / `:focus` / `:active` / `:focus-visible` /
 * `:focus-within`) is the domain of WCAG 2.3.3
 * "Animation from Interactions" — see the sibling rule
 * `motion/animation-from-interactions`.
 *
 * The rule checks five surfaces:
 *   1. HTML <marquee> — obsolete, always animated, no built-in pause.
 *   2. Standalone .css files — animation/transition properties without
 *      a prefers-reduced-motion guard, skipping rules whose selector
 *      is entirely user-interaction-gated.
 *   3. HTML <style> blocks — same walk, line numbers offset back into
 *      the HTML file.
 *   4. Inline style="animation: …" / style="transition-duration: …"
 *      attributes — a single element can't be meaningfully wrapped in
 *      a reduced-motion query, so a qualifying inline declaration is
 *      flagged. Inline styles aren't gated by a pseudo-class, so they
 *      always live in the 2.2.2 lane.
 *   5. Auto-playing carousel/slider markers — a static signal of
 *      auto-advancing content (typically a 5-second default cycle):
 *        - Bootstrap 5: `data-bs-ride="carousel"` / `="true"`.
 *        - Bootstrap 4 (legacy): `data-ride="carousel"` / `="true"`.
 *        - jQuery slider plugins that auto-init from a documented class
 *          on page load: `flexslider` (jQuery FlexSlider), `camera_wrap`
 *          (Camera slideshow), `sl-slider-wrapper` (Slicebox / sl-slider).
 *      These three classes are the plugins' published auto-init markers
 *      — the plugin's bundled JS scans the DOM for the class and starts
 *      a timer without requiring user interaction. Per the AI-first
 *      doctrine, we match only *documented* class shapes (not arbitrary
 *      `.slider`, `.carousel`) so the signal is provable from the code.
 *
 * Spec-mandated 5-second / repetition gate: WCAG 2.2.2 only mandates a
 * pause/stop/hide mechanism when motion "starts automatically, lasts
 * more than five seconds, and is presented in parallel with other
 * content" (Understanding 2.2.2, "Auto-updating information"). A CSS
 * animation or transition therefore qualifies under 2.2.2 only when at
 * least one of:
 *   - `animation-iteration-count: infinite` is set;
 *   - `animation-iteration-count` is a literal integer > 3 (the
 *     conformance threshold below which a finite repeat does not exceed
 *     five seconds of total runtime for a typical sub-second loop);
 *   - `animation-duration` exceeds 5s;
 *   - `transition-duration` exceeds 5s.
 * A one-shot `animation: hide 0.2s ease-out;` (default
 * iteration-count = 1) cannot exceed 5s of runtime and is spec-exempt;
 * a 0.15s transition is similarly out of scope. The 5s threshold is
 * normative in the spec — this is a spec gate, not a heuristic
 * suppression. Per the doctrinal "provable from the code 100% of the
 * time" test in `docs/kb/architecture/ai-first-consumer.md`, the
 * duration literal in CSS is the strongest evidence the scanner can
 * have: a `transition: color 0.15s ease` definitionally cannot
 * trigger 2.2.2, so routing it to 2.3.3 is correct criterion
 * assignment, not a heuristic dismissal. The duration +
 * iteration-count is encoded into the `message` text as additive
 * context so the agent can confirm.
 */

import { defineRule } from "../../api/plugin.ts";
import { findHtmlElementsByTag, walkHtmlElements } from "../../engine/ast-helpers.ts";
import type {
  CssDeclaration,
  CssRule,
  CssStylesheet,
  HtmlDocument,
  HtmlElement,
} from "../../types/ast.ts";
import { detectAutoplaySignal } from "./_carousel-signals.ts";
import {
  ANIMATION_PROPERTIES,
  anyPartHasUserInteractionPseudoClass,
  type Emit,
  forEachStyleBlock,
  getHtmlAttribute,
  isNearZeroDuration,
  isNoneValue,
  isUserInteractionGatedSelector,
  type PositionOffset,
  truncateForEcho,
  walkCandidateRules,
} from "./_shared.ts";

export const rule = defineRule({
  id: "motion/pause-stop-hide",
  satisfies: ["wcag22:2.2.2", "wcag21:2.2.2"],
  severity: "error",
  scope: "node",
  fixClass: "runtime-only",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".css"],
  },
  docs: {
    description:
      "Moving or auto-updating content must have a mechanism to pause, stop, or hide. Flags <marquee>, CSS animations without a prefers-reduced-motion guard (including inline <style> blocks), inline style= animation/transition declarations, and Bootstrap data-bs-ride='carousel' auto-advance markers. Skips user-interaction-gated animations (:hover / :focus / :active) — those are the domain of motion/animation-from-interactions (wcag22:2.3.3).",
    rationale:
      "People with attention deficits, vestibular disorders, or seizure conditions can be severely affected by motion they cannot control. A prefers-reduced-motion media query lets the browser honor the user's OS-level motion preference. Inline styles and Bootstrap carousel auto-advance attributes evade stylesheet-level guards, so they need individual scrutiny. Animations gated by user-interaction pseudo-classes run only when the user asks for them, and WCAG 2.3.3 (not 2.2.2) is the correct criterion for that trigger shape.",
    goodExample: `@media (prefers-reduced-motion: reduce) {\n  .spinner { animation: none; }\n}`,
    badExample: `<marquee>Breaking news</marquee>\n<div data-bs-ride="carousel">…</div>\n<div style="transition-duration: 2s"></div>\n\n.spinner { animation: spin 1s infinite; }`,
    normativeQuote:
      "For moving, blinking, scrolling, or auto-updating information, all of the following are true.",
    references: [
      "https://www.w3.org/TR/WCAG22/#pause-stop-hide",
      "https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      const emit: Emit = (v) => ctx.emit(v);
      const doc = ctx.ast as HtmlDocument;
      checkHtmlMarquee(doc, emit);
      forEachStyleBlock({ doc, emit, onStylesheet: checkCssStylesheet });
      checkHtmlInlineStyles(doc, emit);
      checkHtmlCarouselAutoplay(doc, emit);
    }
  },
  afterFile(ctx) {
    if (ctx.language !== "css") return;
    checkCssStylesheet(ctx.ast as CssStylesheet, (v) => ctx.emit(v), {
      lineOffset: 0,
      colOffset: 0,
    });
  },
});

function checkHtmlMarquee(doc: HtmlDocument, emit: Emit): void {
  for (const element of findHtmlElementsByTag(doc, "marquee")) {
    emit({
      severity: "error",
      location: {
        filePath: "",
        line: element.loc.start.line,
        column: element.loc.start.column,
      },
      message:
        "<marquee> is an obsolete element that creates moving text with no built-in pause mechanism — it violates WCAG 2.2.2.",
      suggestion:
        "Remove <marquee> and replace with static text, or use a CSS animation wrapped in a prefers-reduced-motion media query with a visible pause/stop button.",
    });
  }
}

/**
 * Flags inline style="…" attributes that set animation or transition
 * properties crossing the spec-mandated 5-second / repetition gate.
 * Inline styles can't be wrapped in a prefers-reduced-motion query, so
 * a qualifying declaration is always a violation. Inline styles are
 * element-level and never gated by a pseudo-class, so this always
 * routes to the 2.2.2 lane.
 *
 * The same threshold logic as the stylesheet path applies — short,
 * one-shot animations and sub-5s transitions are spec-exempt.
 */
function checkHtmlInlineStyles(doc: HtmlDocument, emit: Emit): void {
  for (const element of walkHtmlElements(doc)) {
    const style = getHtmlAttribute(element, "style");
    if (style === null || style.trim().length === 0) continue;
    const inlineDecls = parseInlineStyleDecls(style);
    if (inlineDecls.length === 0) continue;
    const triggering = inlineDecls.find((d) => ANIMATION_PROPERTIES.has(d.property));
    if (!triggering) continue;
    const profile = describeInlineProfile(inlineDecls, triggering);
    if (!profile.qualifies) continue;
    const echoTag = `<${element.tagName.toLowerCase()}>`;
    const echoValue = truncateForEcho(`${triggering.property}: ${triggering.value}`);
    emit({
      severity: "warning",
      location: {
        filePath: "",
        line: element.loc.start.line,
        column: element.loc.start.column,
      },
      message: `${echoTag} inline style sets '${echoValue}' (${profile.contextNote}) — inline declarations cannot be scoped to a prefers-reduced-motion media query, so users who prefer reduced motion cannot disable this motion.`,
      suggestion: `Move the ${triggering.property} declaration into a stylesheet rule wrapped in @media (prefers-reduced-motion: reduce) { … } with a reduced-motion alternative (animation: none or duration: 0.01ms), or remove the inline declaration if the motion is decorative.`,
    });
  }
}

interface InlineDecl {
  readonly property: string;
  readonly value: string;
}

function parseInlineStyleDecls(style: string): readonly InlineDecl[] {
  const out: InlineDecl[] = [];
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (property.length === 0 || value.length === 0) continue;
    out.push({ property, value });
  }
  return out;
}

/**
 * Inline-style analogue of `describeRuleProfile`. Treats the inline
 * style attribute as a synthetic CSS rule and applies the same
 * duration / iteration-count gate.
 */
function describeInlineProfile(
  decls: readonly InlineDecl[],
  triggering: InlineDecl,
): QualificationProfile {
  if (isNoneValue(triggering.value) || isNearZeroDuration(triggering.value)) {
    return { qualifies: false, contextNote: "value is none/near-zero" };
  }
  const isTransition =
    triggering.property === "transition" ||
    triggering.property === "transition-property" ||
    triggering.property === "transition-duration";
  if (isTransition) {
    const max = inlineMaxTransitionMs(decls);
    return {
      qualifies: max !== null && max > FIVE_SECONDS_MS,
      contextNote:
        max === null ? "transition-duration unparsed" : `transition-duration ~${formatMs(max)}`,
    };
  }
  const summary = inlineAnimationSummary(decls);
  return {
    qualifies: animationQualifies(summary),
    contextNote: animationContextNote(summary),
  };
}

function inlineAnimationSummary(decls: readonly InlineDecl[]): AnimationSummary {
  return summarizeAnimationDecls(decls);
}

function inlineMaxTransitionMs(decls: readonly InlineDecl[]): number | null {
  let max: number | null = null;
  for (const d of decls) {
    let candidates: readonly (number | null)[] = [];
    if (d.property === "transition-duration") {
      candidates = d.value.split(",").map((part) => parseDurationMs(part));
    } else if (d.property === "transition") {
      candidates = d.value.split(",").map((part) => firstDurationInTokenList(part));
    }
    for (const ms of candidates) {
      if (ms === null) continue;
      if (max === null || ms > max) max = ms;
    }
  }
  return max;
}

/**
 * Flags every element carrying a documented auto-play carousel/slider
 * marker. The matched shapes are:
 *   - Bootstrap 5: `data-bs-ride="carousel"` or `="true"`.
 *   - Bootstrap 4 (legacy, still common in older themes):
 *     `data-ride="carousel"` or `="true"`.
 *   - jQuery slider plugins that auto-initialize from a published
 *     class on page load: `flexslider` (jQuery FlexSlider),
 *     `camera_wrap` (Camera slideshow), `sl-slider-wrapper`
 *     (Slicebox / sl-slider).
 *
 * Pause-on-hover (Bootstrap's default) is an incidental pause, not a
 * user-operable mechanism under WCAG 2.2.2. The scanner cannot prove
 * from the marker alone that visible pause/prev/next controls are
 * present, so each occurrence is surfaced for verification. The reason
 * text names the matched signal so the agent can confirm without
 * guessing.
 */
function checkHtmlCarouselAutoplay(doc: HtmlDocument, emit: Emit): void {
  for (const element of walkHtmlElements(doc)) {
    emitCarouselFinding(element, emit);
  }
}

function emitCarouselFinding(element: HtmlElement, emit: Emit): void {
  const signal = detectAutoplaySignal(element);
  if (signal === null) return;
  const pause = getHtmlAttribute(element, "data-bs-pause");
  const pauseNote =
    pause === null
      ? "no data-bs-pause attribute present"
      : `data-bs-pause="${truncateForEcho(pause)}"`;
  const controlsNote = describeDescendantControls(element);
  const tag = element.tagName.toLowerCase();
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: element.loc.start.line,
      column: element.loc.start.column,
    },
    message: `<${tag}> matches ${signal.origin} (${signal.marker}) — auto-advances on page load (default cycle ${signal.defaultCycle}); WCAG 2.2.2 requires a user-operable pause/stop/hide mechanism; ${pauseNote}${controlsNote}.`,
    suggestion:
      "Verify that the carousel/slider ships visible prev/next and pause/play buttons (not just pause-on-hover, which is incidental), or remove the auto-init marker so the slider does not advance until the user activates it.",
  });
}

/**
 * Walks descendants of the carousel root looking for Bootstrap's
 * documented prev/next control classes (`carousel-control-prev` /
 * `carousel-control-next`). When at least one is present, append an
 * additive note to the reason text listing the line numbers — the
 * presence of these controls is a *signal* that a user-operable stop
 * mechanism may exist, but the scanner cannot prove the controls are
 * keyboard-focusable or that AT users can perceive their pause
 * semantics. Per AI-first doctrine: surface honest "please verify"
 * context rather than suppress the finding.
 *
 * Returns the empty string when no matching descendants are found, so
 * the call site can interpolate unconditionally.
 */
function describeDescendantControls(root: HtmlElement): string {
  const lines: number[] = [];
  for (const descendant of walkHtmlElements(root)) {
    if (hasCarouselControlClass(descendant)) {
      lines.push(descendant.loc.start.line);
    }
  }
  if (lines.length === 0) return "";
  const sortedUnique = [...new Set(lines)].sort((a, b) => a - b);
  return `; note: descendant controls \`.carousel-control-prev|next\` detected at lines ${sortedUnique.join(",")} — verify keyboard focus + announcement carry pause semantics before dismissing`;
}

function hasCarouselControlClass(el: HtmlElement): boolean {
  const klass = getHtmlAttribute(el, "class");
  if (klass === null) return false;
  for (const token of klass.split(/\s+/)) {
    if (token === "carousel-control-prev" || token === "carousel-control-next") return true;
  }
  return false;
}

/**
 * Applies the stylesheet prefers-reduced-motion guard check in the
 * 2.2.2 lane. Skips CSS rules whose selector is ENTIRELY
 * user-interaction-gated — those belong to 2.3.3 and are flagged by
 * the sibling `motion/animation-from-interactions` rule. A mixed
 * selector list (`.foo, .foo:hover`) still fires under 2.2.2 because
 * the bare `.foo` part animates without interaction.
 *
 * Also gates on the spec-mandated 5-second / repetition threshold (see
 * file header) — short, one-shot animations and sub-5s transitions are
 * not in scope for 2.2.2.
 */
function checkCssStylesheet(stylesheet: CssStylesheet, emit: Emit, offset: PositionOffset): void {
  for (const { rule: cssRule, decl } of walkCandidateRules(stylesheet)) {
    if (isUserInteractionGatedSelector(cssRule.selector)) continue;
    const profile = describeRuleProfile(cssRule, decl);
    if (!profile.qualifies) continue;
    const echoSelector = truncateForEcho(cssRule.selector);
    const mixedNote = anyPartHasUserInteractionPseudoClass(cssRule.selector)
      ? " (selector list mixes interaction-gated and always-on parts — the non-gated parts animate without user input)"
      : "";
    // Q7-MOTION-FINDING-SELECTOR-LINE: report the rule's selector start
    // line as `line` — the structural anchor — and surface the
    // declaration line as the `decline` sibling when the two differ.
    // The agent landing on the selector immediately sees what the rule
    // applies to (key for 2.2.2 vs 2.3.3 lane discrimination); the
    // `decline` pointer routes them to the offending token without a
    // re-scan. Single-line rules (`.x { animation: spin 1s infinite }`)
    // omit `decline` entirely per CLAUDE.md §1 "Ambiguous field shapes
    // are dishonest."
    const selectorLine = cssRule.loc.start.line + offset.lineOffset;
    const declarationLine = decl.loc.start.line + offset.lineOffset;
    emit({
      severity: "warning",
      location: {
        filePath: "",
        line: selectorLine,
        column:
          cssRule.loc.start.line === 1
            ? cssRule.loc.start.column + offset.colOffset
            : cssRule.loc.start.column,
      },
      ...(declarationLine === selectorLine ? {} : { decline: declarationLine }),
      message: `'${echoSelector}' uses ${decl.property} (${profile.contextNote}) without a prefers-reduced-motion media query guard${mixedNote} — users who prefer reduced motion cannot disable this animation.`,
      suggestion: `Wrap the animation in @media (prefers-reduced-motion: reduce) { ${echoSelector} { ${decl.property}: none; } } or move the entire rule inside a prefers-reduced-motion query.`,
    });
  }
}

// ---------------------------------------------------------------------------
// 5-second / repetition gate (WCAG 2.2.2 spec threshold)
// ---------------------------------------------------------------------------

const FIVE_SECONDS_MS = 5000;
const REPETITION_THRESHOLD = 3;

interface QualificationProfile {
  /** True when the declaration crosses the spec-mandated threshold. */
  readonly qualifies: boolean;
  /** Human-readable summary of the duration / iteration-count, used as
   * additive context in the emitted message — even when qualifying, the
   * agent benefits from seeing the parsed numbers. */
  readonly contextNote: string;
}

/**
 * Inspects every animation/transition declaration on the same CSS rule
 * to decide whether the rule meets the 2.2.2 spec gate. The rule passes
 * the gate if any of:
 *   - animation-iteration-count: infinite
 *   - animation-iteration-count: integer > 3
 *   - animation-duration > 5s (parsed from longhand or shorthand)
 *   - transition-duration > 5s (parsed from longhand or shorthand)
 *
 * The "trigger declaration" passed in (`decl`) is whichever the
 * `walkCandidateRules` helper hit first; we look at its sibling
 * declarations on the same rule to gather the full picture.
 */
function describeRuleProfile(cssRule: CssRule, decl: CssDeclaration): QualificationProfile {
  const property = decl.property.toLowerCase();
  const isTransition =
    property === "transition" ||
    property === "transition-property" ||
    property === "transition-duration";
  if (isTransition) {
    const durationMs = transitionDurationMs(cssRule);
    const note =
      durationMs === null
        ? "transition-duration unparsed"
        : `transition-duration ~${formatMs(durationMs)}`;
    return {
      qualifies: durationMs !== null && durationMs > FIVE_SECONDS_MS,
      contextNote: note,
    };
  }
  const summary = animationSummary(cssRule);
  return {
    qualifies: animationQualifies(summary),
    contextNote: animationContextNote(summary),
  };
}

interface AnimationSummary {
  readonly durationMs: number | null;
  readonly iterationCount: number | null;
  readonly hasInfinite: boolean;
}

function animationSummary(cssRule: CssRule): AnimationSummary {
  return summarizeAnimationDecls(
    cssRule.declarations.map((d) => ({ property: d.property.toLowerCase(), value: d.value })),
  );
}

/**
 * Shared kernel: walks a list of `{property, value}` pairs (from a CSS
 * rule's declarations or a parsed inline `style=` attribute) and folds
 * each animation-related declaration into a single `AnimationSummary`.
 * Pulled out of `animationSummary` and `inlineAnimationSummary` to keep
 * each below the cognitive-complexity ceiling — the actual fold logic
 * lives here, the two callers just pre-normalize their inputs.
 */
function summarizeAnimationDecls(
  decls: readonly { property: string; value: string }[],
): AnimationSummary {
  let durationMs: number | null = null;
  let iterationCount: number | null = null;
  let hasInfinite = false;
  for (const d of decls) {
    const update = readAnimationDecl(d.property, d.value);
    if (update.durationMs !== null) durationMs = update.durationMs;
    if (update.iterationCount !== null) iterationCount = update.iterationCount;
    if (update.hasInfinite) hasInfinite = true;
  }
  return { durationMs, iterationCount, hasInfinite };
}

function readAnimationDecl(property: string, value: string): AnimationSummary {
  if (property === "animation-iteration-count") {
    const parsed = parseIterationCount(value);
    if (parsed === "infinite") return { durationMs: null, iterationCount: null, hasInfinite: true };
    if (parsed !== null) return { durationMs: null, iterationCount: parsed, hasInfinite: false };
    return EMPTY_SUMMARY;
  }
  if (property === "animation-duration") {
    const ms = parseDurationMs(value);
    return { durationMs: ms, iterationCount: null, hasInfinite: false };
  }
  if (property === "animation") {
    const s = parseAnimationShorthand(value);
    return {
      durationMs: s.durationMs,
      iterationCount: s.iterationCount,
      hasInfinite: s.hasInfinite,
    };
  }
  return EMPTY_SUMMARY;
}

const EMPTY_SUMMARY: AnimationSummary = {
  durationMs: null,
  iterationCount: null,
  hasInfinite: false,
};

function animationQualifies(s: AnimationSummary): boolean {
  if (s.hasInfinite) return true;
  if (s.iterationCount !== null && s.iterationCount > REPETITION_THRESHOLD) return true;
  if (s.durationMs !== null && s.durationMs > FIVE_SECONDS_MS) return true;
  return false;
}

function animationContextNote(s: AnimationSummary): string {
  const parts: string[] = [];
  if (s.durationMs !== null) parts.push(`duration ~${formatMs(s.durationMs)}`);
  if (s.hasInfinite) parts.push("iteration-count infinite");
  else if (s.iterationCount !== null) parts.push(`iteration-count ${s.iterationCount}`);
  return parts.length === 0 ? "duration / iteration-count unparsed" : parts.join(", ");
}

/**
 * Returns the longest transition-duration on the rule. The
 * `transition` shorthand and the `transition-duration` longhand can
 * both list multiple durations; if any one of them exceeds 5s the rule
 * qualifies.
 */
function transitionDurationMs(cssRule: CssRule): number | null {
  let max: number | null = null;
  for (const d of cssRule.declarations) {
    const prop = d.property.toLowerCase();
    let candidates: readonly (number | null)[] = [];
    if (prop === "transition-duration") {
      candidates = d.value.split(",").map((part) => parseDurationMs(part));
    } else if (prop === "transition") {
      candidates = d.value.split(",").map((part) => firstDurationInTokenList(part));
    }
    for (const ms of candidates) {
      if (ms === null) continue;
      if (max === null || ms > max) max = ms;
    }
  }
  return max;
}

interface ShorthandParse {
  readonly durationMs: number | null;
  readonly iterationCount: number | null;
  readonly hasInfinite: boolean;
}

/**
 * Parses an `animation` shorthand value. Per CSS spec the first time
 * token is the duration and the second is the delay; the keyword
 * `infinite` or a bare number (with no unit) is the iteration-count.
 * Multi-animation lists (comma-separated) take the maximum duration so
 * the strictest case wins.
 */
function parseAnimationShorthand(value: string): ShorthandParse {
  let maxDuration: number | null = null;
  let iterationCount: number | null = null;
  let hasInfinite = false;
  for (const segment of value.split(",")) {
    const segParse = parseSingleAnimationShorthand(segment);
    if (segParse.durationMs !== null) {
      maxDuration =
        maxDuration === null ? segParse.durationMs : Math.max(maxDuration, segParse.durationMs);
    }
    if (segParse.hasInfinite) hasInfinite = true;
    if (segParse.iterationCount !== null) iterationCount = segParse.iterationCount;
  }
  return { durationMs: maxDuration, iterationCount, hasInfinite };
}

function parseSingleAnimationShorthand(segment: string): ShorthandParse {
  const tokens = tokenize(segment);
  let durationMs: number | null = null;
  let iterationCount: number | null = null;
  let hasInfinite = false;
  let timeTokensSeen = 0;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "infinite") {
      hasInfinite = true;
      continue;
    }
    const asTime = parseDurationMs(token);
    if (asTime !== null) {
      if (timeTokensSeen === 0) durationMs = asTime;
      timeTokensSeen += 1;
      continue;
    }
    const asNumber = parseBareNumber(token);
    if (asNumber !== null) {
      iterationCount = asNumber;
    }
  }
  return { durationMs, iterationCount, hasInfinite };
}

function firstDurationInTokenList(value: string): number | null {
  for (const token of tokenize(value)) {
    const ms = parseDurationMs(token);
    if (ms !== null) return ms;
  }
  return null;
}

function tokenize(value: string): readonly string[] {
  return value
    .replace(/!important\b/i, "")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function parseDurationMs(value: string): number | null {
  const clean = value.trim().toLowerCase();
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(clean);
  if (!match) return null;
  const n = Number.parseFloat(match[1] ?? "0");
  if (Number.isNaN(n)) return null;
  return match[2] === "ms" ? n : n * 1000;
}

function parseBareNumber(token: string): number | null {
  // CSS animation iteration-count is a <number>, not a <length> — it
  // has no unit. Accept positive integers and decimals; reject if it
  // carries any unit (which means it's a duration, length, etc.).
  if (!/^\d*\.?\d+$/.test(token)) return null;
  const n = Number.parseFloat(token);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

function parseIterationCount(value: string): number | "infinite" | null {
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/\s*!important\s*$/, "")
    .trim();
  if (clean === "infinite") return "infinite";
  return parseBareNumber(clean);
}

function formatMs(ms: number): string {
  if (ms >= 1000) {
    const s = ms / 1000;
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(2).replace(/\.?0+$/, "")}s`;
  }
  return `${ms}ms`;
}
