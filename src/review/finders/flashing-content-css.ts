/**
 * CSS detection helpers for the review/flashing-content finder.
 *
 * Split out of flashing-content.ts to keep each module under the
 * 400-line review cap. The entry point is findCssCandidates; the rest
 * are animation-shorthand and @keyframes helpers the finder needs.
 * See the top-of-file docblock in flashing-content.ts for why the
 * ≤333ms threshold is an inclusion signal, not a suppression gate.
 */

import { walkCssAtRules, walkCssRules } from "../../engine/ast-helpers.ts";
import type { CssAtRule, CssRule, CssStylesheet } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const SHORT_CYCLE_MS = 333;

const FLASH_PROPERTIES: ReadonlySet<string> = new Set([
  "opacity",
  "transform",
  "background",
  "background-color",
  "color",
  "filter",
  "visibility",
]);

const ANIMATION_RESERVED: ReadonlySet<string> = new Set([
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "both",
  "none",
  "running",
  "paused",
  "infinite",
  "initial",
  "inherit",
  "unset",
  "revert",
]);

interface FlashInfo {
  /**
   * Line of the ruleset opener (the selector line) — the structural
   * anchor an agent reads first to understand which DOM context the
   * animation runs in. Not the declaration line; see the comment in
   * {@link extractShortCycleFlashInfo} for why.
   */
  readonly anchorLine: number;
  readonly anchorColumn: number;
  readonly reason: string;
}

/**
 * `iterationCount` is `"infinite"`, a positive integer count, or
 * `undefined` (unspecified — CSS default of 1). The reason-text builder
 * uses this to decide whether the cycles-per-second arithmetic is
 * meaningful: a one-shot animation cannot cycle at any frequency, so
 * quoting "~6.7Hz" for `animation: fade-in 0.15s` is mathematically
 * dishonest. See V1-MOTION-2.3.1-CYCLES-PER-SECOND-MATH and
 * tests/fixtures/real-world/jekyll-docsearch-scss-line-drift for the
 * field-report repro.
 */
type IterationCount = "infinite" | number | undefined;

interface ParsedAnimation {
  readonly durationMs: number;
  readonly name: string | undefined;
  readonly iterationCount: IterationCount;
}

interface KeyframesSummary {
  readonly mutatesFlashProperties: boolean;
  readonly observedProperties: readonly string[];
}

export type CssEmit = (line: number, column: number, reason: string) => void;

export function findCssCandidates(
  stylesheet: CssStylesheet,
  emit: CssEmit,
  _out: ReviewCandidate[],
): void {
  const guardedRules = collectReducedMotionGuardedRules(stylesheet);
  const keyframesIndex = indexKeyframes(stylesheet);

  for (const cssRule of walkCssRules(stylesheet)) {
    if (guardedRules.has(cssRule)) continue;
    const flashInfo = extractShortCycleFlashInfo(cssRule, keyframesIndex);
    if (!flashInfo) continue;
    emit(flashInfo.anchorLine, flashInfo.anchorColumn, flashInfo.reason);
  }
}

function extractShortCycleFlashInfo(
  cssRule: CssRule,
  keyframesIndex: ReadonlyMap<string, KeyframesSummary>,
): FlashInfo | undefined {
  // Scan every declaration once before deciding — `animation-iteration-count`
  // is frequently a sibling longhand of `animation-duration`, and missing
  // it because we returned early on the first duration sighting is the
  // V1-MOTION-2.3.1-CYCLES-PER-SECOND-MATH bug. Shorthand `animation:`
  // can also carry the count inline (e.g. `animation: spin 0.15s infinite`).
  let durationMs: number | undefined;
  let name: string | undefined;
  let iterationCount: IterationCount;
  for (const decl of cssRule.declarations) {
    const prop = decl.property.toLowerCase();
    const parsed = parseAnimationDeclaration(prop, decl.value);
    if (parsed) {
      // First duration wins — multiple `animation:` declarations would
      // be unusual; the cascade keeps the last one but we surface either.
      if (durationMs === undefined) durationMs = parsed.durationMs;
      if (name === undefined) name = parsed.name;
      if (iterationCount === undefined && parsed.iterationCount !== undefined) {
        iterationCount = parsed.iterationCount;
      }
      continue;
    }
    if (prop === "animation-iteration-count" && iterationCount === undefined) {
      iterationCount = parseIterationCount(decl.value);
    }
  }
  if (durationMs === undefined || durationMs > SHORT_CYCLE_MS) return undefined;
  const summary = name ? keyframesIndex.get(name) : undefined;
  if (summary && !summary.mutatesFlashProperties) return undefined;
  const reason = buildCssFlashReason(cssRule.selector, durationMs, name, iterationCount, summary);
  // Anchor on the ruleset opener (the selector line), not on the
  // `animation:` declaration line. A multi-line ruleset like
  // `:valid ~ .searchbox__reset { ...; animation: fade-in 0.3s ...; }`
  // carries its declaration ten-plus rows past the selector; pointing
  // at the declaration sends the agent reading from the wrong block
  // entirely when adjacent rulesets share leading tokens. The selector
  // is the structural anchor — it identifies which DOM context the
  // animation runs in. See tests/fixtures/real-world/
  // jekyll-docsearch-scss-line-drift for the regression guard.
  return {
    anchorLine: cssRule.loc.start.line,
    anchorColumn: cssRule.loc.start.column,
    reason,
  };
}

function parseAnimationDeclaration(property: string, value: string): ParsedAnimation | undefined {
  const cleaned = value.replace(/!important$/i, "").trim();
  if (property === "animation-duration") {
    const durationMs = parseFirstDurationMs(cleaned);
    return durationMs === undefined
      ? undefined
      : { durationMs, name: undefined, iterationCount: undefined };
  }
  if (property === "animation") {
    const durationMs = parseFirstDurationMs(cleaned);
    if (durationMs === undefined) return undefined;
    const name = extractAnimationName(cleaned);
    const iterationCount = extractIterationCountFromShorthand(cleaned);
    return { durationMs, name, iterationCount };
  }
  return undefined;
}

function parseIterationCount(value: string): IterationCount {
  const cleaned = value.replace(/!important$/i, "").trim().toLowerCase();
  if (cleaned === "infinite") return "infinite";
  // CSS spec accepts fractional counts (`2.5`) but anything ≥2 still
  // means the animation repeats, so the cycles-per-second math is
  // meaningful. Anything ≤1 (including the default unspecified) is a
  // one-shot from a flash-perception standpoint.
  const n = Number.parseFloat(cleaned);
  if (Number.isFinite(n) && n > 0) return n;
  return undefined;
}

function extractIterationCountFromShorthand(value: string): IterationCount {
  const withoutFns = value.replace(/\b(?:cubic-bezier|steps)\s*\([^)]*\)/gi, "");
  const tokens = withoutFns.split(/\s+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (lowered === "infinite") return "infinite";
    // Bare positive number (no s/ms suffix) in the shorthand position is
    // the iteration count. A duration token (`0.15s`, `200ms`) carries
    // its unit and is rejected here.
    if (/^\d+(?:\.\d+)?$/.test(token)) {
      const n = Number.parseFloat(token);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

function parseFirstDurationMs(value: string): number | undefined {
  const match = /(-?\d*\.?\d+)(ms|s)\b/i.exec(value);
  if (!match) return undefined;
  const n = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(n)) return undefined;
  const unit = (match[2] ?? "").toLowerCase();
  return unit === "s" ? n * 1000 : n;
}

function extractAnimationName(value: string): string | undefined {
  const withoutFns = value.replace(/\b(?:cubic-bezier|steps)\s*\([^)]*\)/gi, "");
  const tokens = withoutFns.split(/\s+/).filter((t) => t.length > 0);
  let candidate: string | undefined;
  for (const token of tokens) {
    if (/^(-?\d*\.?\d+)(ms|s)?$/i.test(token)) continue;
    const lowered = token.toLowerCase();
    if (ANIMATION_RESERVED.has(lowered)) continue;
    if (/^[a-z_][\w-]*$/i.test(token)) candidate = token;
  }
  return candidate;
}

function indexKeyframes(stylesheet: CssStylesheet): ReadonlyMap<string, KeyframesSummary> {
  const index = new Map<string, KeyframesSummary>();
  for (const atRule of walkCssAtRules(stylesheet)) {
    const name = atRule.name.toLowerCase();
    if (name !== "keyframes" && name !== "-webkit-keyframes") continue;
    const animationName = atRule.params.trim();
    if (!animationName) continue;
    index.set(animationName, summariseKeyframes(atRule));
  }
  return index;
}

function summariseKeyframes(atRule: CssAtRule): KeyframesSummary {
  const props = new Set<string>();
  for (const child of atRule.children) {
    if (child.kind !== "CssRule") continue;
    for (const decl of child.declarations) {
      props.add(decl.property.toLowerCase());
    }
  }
  let mutates = false;
  for (const p of props) {
    if (FLASH_PROPERTIES.has(p)) {
      mutates = true;
      break;
    }
  }
  return {
    mutatesFlashProperties: mutates,
    observedProperties: [...props].sort(),
  };
}

function buildCssFlashReason(
  selector: string,
  durationMs: number,
  name: string | undefined,
  iterationCount: IterationCount,
  summary: KeyframesSummary | undefined,
): string {
  const durationText = formatDuration(durationMs);
  const target = name ? `animation '${name}'` : "animation";
  const propsNote =
    summary && summary.observedProperties.length > 0
      ? ` mutating ${summary.observedProperties.join(", ")}`
      : "";
  if (isRepeating(iterationCount)) {
    // Cycles-per-second is well-defined only when the animation actually
    // repeats. `infinite` and integer counts ≥2 both qualify; the agent
    // verifies whether the count × duration crosses the >3-flashes/s
    // threshold from the surrounding code.
    const frequency = durationMs > 0 ? (1000 / durationMs).toFixed(1) : "∞";
    const countText = iterationCount === "infinite" ? "infinite" : `${iterationCount}×`;
    return `'${selector}' ${target}${propsNote} runs one cycle every ${durationText} (~${frequency} cycles/s, iteration-count: ${countText}) with no prefers-reduced-motion guard — verify the animation does not flash more than 3 times per second over an area larger than the WCAG 2.3.1 general-flash threshold`;
  }
  // One-shot: the cycles/s number would be mathematically dishonest
  // (a single 150ms entrance animation cannot cycle at 6.7Hz). Surface
  // the duration and prompt the agent to verify whether iteration-count
  // turns the animation into a repeating flash. Per the AI-first
  // consumer model: keep the candidate (don't suppress), enrich the
  // reason instead.
  return `'${selector}' ${target}${propsNote} runs a single ${durationText} animation with no prefers-reduced-motion guard — flashing only if iteration-count is set to 'infinite' or a value >3; verify the surrounding code does not turn this into a repeating flash`;
}

function isRepeating(iterationCount: IterationCount): boolean {
  if (iterationCount === undefined) return false;
  if (iterationCount === "infinite") return true;
  return iterationCount >= 2;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function collectReducedMotionGuardedRules(stylesheet: CssStylesheet): ReadonlySet<CssRule> {
  const guarded = new Set<CssRule>();
  for (const atRule of walkCssAtRules(stylesheet)) {
    if (!isReducedMotionQuery(atRule)) continue;
    for (const child of walkAtRuleChildren(atRule)) {
      guarded.add(child);
    }
  }
  return guarded;
}

function isReducedMotionQuery(atRule: CssAtRule): boolean {
  if (atRule.name.toLowerCase() !== "media") return false;
  return /prefers-reduced-motion/i.test(atRule.params);
}

function* walkAtRuleChildren(atRule: CssAtRule): Iterable<CssRule> {
  for (const child of atRule.children) {
    if (child.kind === "CssRule") {
      yield child;
    } else if (child.kind === "CssAtRule") {
      yield* walkAtRuleChildren(child);
    }
  }
}
