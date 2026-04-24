/**
 * Candidate finder: review/flashing-content
 * Criteria: wcag22:2.3.1, wcag21:2.3.1 (Three Flashes or Below Threshold, A)
 * Spec: https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold
 *
 * 2.3.1 forbids content that flashes >3 times per second unless the
 * flash and red-flash areas are below physical thresholds. A static
 * scanner can't measure flash rate or area — it points the reviewer at
 * the concrete high-motion surfaces and lets them verify.
 *
 * Four signal classes: (1) `<video autoplay>` in HTML/JSX; (2)
 * requestAnimationFrame call sites in JS/TS, gated on textual evidence
 * that the file mutates a luminance-relevant surface (opacity, color,
 * filter, canvas paint) — bare rAF in vendor scroll/motion libraries
 * cannot physically flash and is excluded; reason notes both whether a
 * matchMedia prefers-reduced-motion check appears in the same file and
 * which luminance-mutating pattern triggered the fire; (3) CSS
 * animations whose full cycle is ≤333ms (>3Hz) mutating
 * opacity/transform/colour and NOT inside a
 * `@media (prefers-reduced-motion)` block; (4) legacy `<marquee>` /
 * `<blink>`. Per CLAUDE.md §1 and ai-first-consumer.md, the 333ms is
 * an INCLUSION threshold — everything at or below surfaces; the agent
 * decides from the observed duration quoted in the reason text.
 *
 * CSS helpers live in flashing-content-css.ts.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  hasHtmlAttribute,
} from "../../engine/ast-helpers.ts";
import type {
  CssStylesheet,
  HtmlDocument,
  HtmlElement,
  JsxElement,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import type { RuleContext } from "../../types/rule.ts";
import { findCssCandidates } from "./flashing-content-css.ts";

const CRITERION_IDS = ["wcag22:2.3.1", "wcag21:2.3.1"] as const;

const RAF_PATTERN = /\brequestAnimationFrame\s*\(/g;
const REDUCED_MOTION_MATCHMEDIA =
  /matchMedia\s*\(\s*['"`][^'"`]*prefers-reduced-motion[^'"`]*['"`]\s*\)/;

/**
 * Luminance-cycling evidence patterns: WCAG 2.3.1 only applies to flashing
 * that cycles colour / brightness above threshold. Bare `requestAnimationFrame`
 * loops in vendor scroll/motion libraries (wow.js, headroom.js, scrolltofixed)
 * touch `transform` / `top` / `translate` and cannot physically flash — firing
 * 2.3.1 on them is a silent false positive that crowds real candidates out.
 *
 * The probe requires textual evidence that the file mutates colour, opacity,
 * filter, or canvas paint in some form. This is deliberately permissive
 * (file-scoped, not scoped to the rAF callback body) so over-surfacing stays
 * the failure mode per AI-first doctrine: any luminance-touching code in the
 * same file keeps the candidate live and the agent verifies; zero evidence
 * anywhere in the file is strong signal the rAF is animating geometry, not
 * luminance.
 */
const LUMINANCE_EVIDENCE_PATTERNS: readonly RegExp[] = [
  /\.style\.backgroundColor\b/,
  /\.style\.background\b/,
  /\.style\.opacity\b/,
  /\.style\.filter\b/,
  /\.style\.color\b/,
  /\bbackgroundColor\s*:/, // React/JSX style objects, setAttribute builders
  /\bopacity\s*:/,
  /\bfilter\s*:\s*['"`]?(?:blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|saturate|sepia|opacity)/,
  /\bcolor\s*:\s*['"`]?(?:#|rgb|hsl|[a-z]{3,})/i, // avoid matching `color: undefined` etc
  /\.fillStyle\s*=/, // canvas 2D
  /\.strokeStyle\s*=/,
  /\.globalAlpha\s*=/,
  /\bputImageData\s*\(/, // canvas pixel writes
  /\bsetProperty\s*\(\s*['"`](?:background-color|background|opacity|filter|color)\b/,
];

const VIDEO_REASON =
  " — autoplay video may present flashing or rapidly changing content; verify no region flashes more than 3 times per second (or that flashing area stays below the WCAG 2.3.1 general-flash and red-flash thresholds)";

const MARQUEE_BLINK_REASON_PREFIX =
  "<$TAG> — legacy element that moves/blinks continuously with no user control";
const MARQUEE_BLINK_REASON_SUFFIX =
  "; verify the motion does not flash more than 3 times per second over a large area and that a mechanism to stop it exists";

const RAF_REASON_BASE =
  "requestAnimationFrame() call — animation loop paints every frame; verify any colour/opacity/luminance cycles stay below 3 flashes per second over the WCAG 2.3.1 flash-area thresholds";
const RAF_REDUCED_MOTION_NOTE =
  " (a matchMedia('prefers-reduced-motion: reduce') check appears in this file — confirm the animation loop actually honours it)";
const RAF_NO_REDUCED_MOTION_NOTE =
  " (no matchMedia('prefers-reduced-motion: reduce') check seen in this file)";
const RAF_EVIDENCE_NOTE_PREFIX = " (luminance-mutating pattern seen in this file: ";
const RAF_EVIDENCE_NOTE_SUFFIX = ")";

export const finder = defineCandidateFinder({
  id: "review/flashing-content",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx", ".ts", ".js", ".css"] },
  docs: {
    description:
      "Finds static signals of flashing or high-motion content: <video autoplay>, requestAnimationFrame loops, short-cycle CSS @keyframes mutating opacity/transform without a prefers-reduced-motion guard, and legacy <marquee>/<blink> tags.",
    reviewPrompt:
      "At each candidate, verify whether the content flashes more than three times per second over a region large enough to exceed the WCAG 2.3.1 general-flash or red-flash thresholds. Physical thresholds: general flash >3/s over >25% of 10° of the visual field; red flash >3/s with a saturated-red component. Static analysis cannot measure either — the reviewer reads the file and, if needed, loads the page.",
    references: [
      "https://www.w3.org/TR/WCAG22/#three-flashes-or-below-threshold",
      "https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html",
    ],
  },
  find(ctx) {
    const out: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, out);
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, out);
      findRafCandidates(ctx, out);
    } else if (ctx.language === "css") {
      findCssCandidates(
        ctx.ast as CssStylesheet,
        (line, column, reason) => {
          emitCandidates(out, ctx.filePath, line, column, reason, "medium");
        },
        out,
      );
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function findHtmlCandidates(doc: HtmlDocument, filePath: string, out: ReviewCandidate[]): void {
  for (const el of findHtmlElementsByTag(doc, "video")) {
    if (!hasHtmlAttribute(el, "autoplay")) continue;
    emitCandidates(
      out,
      filePath,
      el.loc.start.line,
      el.loc.start.column,
      `<video autoplay>${VIDEO_REASON}`,
      "medium",
    );
  }
  for (const tag of ["marquee", "blink"] as const) {
    for (const el of findHtmlElementsByTag(doc, tag)) {
      emitLegacyTag(out, filePath, el, tag);
    }
  }
}

function emitLegacyTag(
  out: ReviewCandidate[],
  filePath: string,
  el: HtmlElement,
  tag: string,
): void {
  const reason = `${MARQUEE_BLINK_REASON_PREFIX.replace("$TAG", tag)}${MARQUEE_BLINK_REASON_SUFFIX}`;
  emitCandidates(out, filePath, el.loc.start.line, el.loc.start.column, reason, "high");
}

// ---------------------------------------------------------------------------
// JSX / TS / JS
// ---------------------------------------------------------------------------

function findJsxCandidates(module: TsxModule, filePath: string, out: ReviewCandidate[]): void {
  for (const el of findJsxElementsByTag(module, "video")) {
    if (!hasTruthyAutoplay(el)) continue;
    emitCandidates(
      out,
      filePath,
      el.loc.start.line,
      el.loc.start.column,
      `<video autoplay>${VIDEO_REASON}`,
      "medium",
    );
  }
  for (const tag of ["marquee", "blink"] as const) {
    for (const el of findJsxElementsByTag(module, tag)) {
      emitJsxLegacyTag(out, filePath, el, tag);
    }
  }
}

function emitJsxLegacyTag(
  out: ReviewCandidate[],
  filePath: string,
  el: JsxElement,
  tag: string,
): void {
  const reason = `${MARQUEE_BLINK_REASON_PREFIX.replace("$TAG", tag)}${MARQUEE_BLINK_REASON_SUFFIX}`;
  emitCandidates(out, filePath, el.loc.start.line, el.loc.start.column, reason, "high");
}

function hasTruthyAutoplay(el: JsxElement): boolean {
  for (const attr of el.attributes) {
    if (attr.name !== "autoplay" && attr.name !== "autoPlay") continue;
    const value = attr.value;
    if (value === null) return true;
    if (value.kind === "StringLiteral") return true;
    const raw = value.raw.replace(/\s+/g, "");
    if (raw === "{false}" || raw === "{null}" || raw === "{undefined}") return false;
    return true;
  }
  return false;
}

function findRafCandidates(ctx: RuleContext, out: ReviewCandidate[]): void {
  RAF_PATTERN.lastIndex = 0;
  // Gate: bare rAF is not evidence of luminance cycling. WCAG 2.3.1 is about
  // colour/brightness cycling >3 flashes/s; vendor scroll/motion libraries
  // (wow.js, headroom.js, scrolltofixed) use rAF to batch transform/position
  // updates and cannot physically flash. Fire only when the file contains
  // textual evidence of mutating a luminance-relevant surface.
  const evidence = findLuminanceEvidence(ctx.source);
  if (evidence.length === 0) return;
  const hasReducedMotionCheck = REDUCED_MOTION_MATCHMEDIA.test(ctx.source);
  const motionNote = hasReducedMotionCheck ? RAF_REDUCED_MOTION_NOTE : RAF_NO_REDUCED_MOTION_NOTE;
  const evidenceNote = `${RAF_EVIDENCE_NOTE_PREFIX}${evidence.join(", ")}${RAF_EVIDENCE_NOTE_SUFFIX}`;
  const reason = `${RAF_REASON_BASE}${motionNote}${evidenceNote}`;
  const seen = new Set<number>();
  for (const match of ctx.source.matchAll(RAF_PATTERN)) {
    const offset = match.index ?? 0;
    if (seen.has(offset)) continue;
    seen.add(offset);
    const { line, column } = offsetToLineColumn(ctx.source, offset);
    emitCandidates(out, ctx.filePath, line, column, reason, "medium");
  }
}

/**
 * Scans the file source for any of the luminance-cycling evidence patterns
 * and returns the matched snippets (deduplicated, preserving first-hit order).
 * Returned tokens are quoted into the reason so the agent sees WHICH pattern
 * triggered the fire and can cross-reference without re-grepping.
 */
function findLuminanceEvidence(source: string): readonly string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const pattern of LUMINANCE_EVIDENCE_PATTERNS) {
    const m = source.match(pattern);
    if (!m) continue;
    const token = m[0].trim();
    if (seen.has(token)) continue;
    seen.add(token);
    hits.push(token);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Shared emission / source-offset helpers
// ---------------------------------------------------------------------------

function emitCandidates(
  out: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reason: string,
  confidence: "high" | "medium" | "low",
): void {
  for (const criterionId of CRITERION_IDS) {
    out.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      confidence,
    });
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
