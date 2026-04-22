/**
 * Candidate finder: review/carousel-pattern
 * Criteria: wcag22:2.2.2, wcag21:2.2.2 — Pause, Stop, Hide
 *
 * Spec: https://www.w3.org/TR/WCAG22/#pause-stop-hide
 *       https://www.w3.org/WAI/ARIA/apg/patterns/carousel/
 *
 * Surfaces declarative carousel patterns for reviewer inspection. A
 * carousel that auto-advances without a user-operable pause/stop control
 * fails WCAG 2.2.2; a carousel that manual-advances needs user-facing
 * controls but not a motion timer. The finder emits a candidate whenever
 * the markup declares "this is a carousel" via one of three surfaces the
 * static scanner can see deterministically — whether it actually
 * auto-advances, and whether pause UI is present, is context the agent
 * reading the file decides.
 *
 * Detection (intentionally loose — finder, not rule):
 *   1. `data-bs-ride="carousel"` — Bootstrap's explicit auto-advance
 *      marker. Pairs with the motion/pause-stop-hide rule, which fires
 *      on the same attribute; the finder surfaces the pattern under
 *      2.2.2 review with the broader question set (accessible name,
 *      explicit pause UI) the rule does not encode.
 *   2. `role="region"` + `aria-roledescription="carousel"` — the
 *      WAI-ARIA authoring-practices carousel pattern. The role+
 *      roledescription combination requires an accessible name (per ARIA
 *      spec), and carousels in that pattern usually have auto-advance
 *      behaviour driven by JS the scanner cannot see.
 *   3. Class-token carousel signal — an element with a class matching
 *      /(^|\s)(carousel|slider|slideshow|swiper)(\s|$|-|_)/i. Library-
 *      agnostic shape: matches Bootstrap's `.carousel`, Swiper's `.swiper`,
 *      Slick/Glide/Flickity's `.slider` / `.slideshow` roots, and
 *      hyphen/underscore-suffixed variants (`carousel-inner`, `swiper_slide`).
 *
 * Companion to the motion/pause-stop-hide rule
 *
 *   The rule fires deterministically on `data-bs-ride="carousel"` and on
 *   CSS animation without a prefers-reduced-motion guard. This finder
 *   targets the DECLARATIVE pattern (role, classname, data-attr) and
 *   raises the three review questions (auto-advance? accessible name?
 *   pause/stop UI?) so the reviewer can evaluate the carousel
 *   holistically — not just whether it was animated.
 *
 * False-positive surface (intentional, agent-resolvable in one read)
 *
 *   - Static content-slider components (`data-bs-ride="false"`, manual
 *     advance only) will still match on the class token. Per AI-first
 *     doctrine we do not filter; the reviewer dismisses after a single
 *     read of the surrounding markup.
 *   - Design-system component roots with a `Carousel` / `Slider` class
 *     that are wrappers for non-rotating UI (accordions mislabelled,
 *     legacy CSS remnants). Dismissal is one file-read away.
 *   - `role="region"` + `aria-roledescription="carousel"` on a
 *     conceptually-correct carousel with full controls and no
 *     auto-advance is still a candidate — the reviewer confirms the
 *     controls exist and moves on.
 *
 * Confidence: "medium". The shape predicates are deterministic (attribute
 * presence, class-token regex), but the three review questions require
 * the agent to see surrounding markup / JS the scanner does not resolve.
 * The reason text enumerates the questions so dismissal stays explicit.
 *
 * Per CLAUDE.md §1 / docs/kb/architecture/ai-first-consumer.md: we do
 * not silence candidates by classname convention, do not down-rank the
 * `data-bs-ride` case because the rule already covers it, and do not
 * try to resolve JS auto-advance settings statically. The scanner points;
 * the agent investigates.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasJsxAttribute,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:2.2.2", "wcag21:2.2.2"] as const;

/**
 * Class-token regex for library-agnostic carousel detection. Matches
 * the bare token and hyphen/underscore-suffixed variants so
 * `carousel-inner`, `slick-slider`, `swiper_container` all count while
 * arbitrary substrings (`carouselesque`, `scarouseled`) do not. The
 * leading `(^|\s)` and trailing `(\s|$|-|_)` are the bounds.
 */
const CLASS_TOKEN_RE = /(?:^|\s)(carousel|slider|slideshow|swiper)(?:\s|$|-|_)/i;

type PatternSignal =
  | { readonly kind: "data-bs-ride"; readonly value: string }
  | { readonly kind: "aria-roledescription"; readonly hasName: boolean }
  | { readonly kind: "class-token"; readonly token: string; readonly className: string };

export const finder = defineCandidateFinder({
  id: "review/carousel-pattern",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      'Finds declarative carousel patterns — `data-bs-ride="carousel"`, `role="region"` + `aria-roledescription="carousel"`, or class tokens matching /carousel|slider|slideshow|swiper/. Surfaces review questions about auto-advance, accessible name, and pause/stop UI under WCAG 2.2.2.',
    reviewPrompt:
      "At each candidate, answer three questions by reading the surrounding markup/JS: (1) does the carousel auto-advance (look for `data-bs-interval`, Swiper/Slick `autoplay`, a `setInterval` in the component's script)? (2) does the carousel root carry an accessible name (`aria-label` or `aria-labelledby` — required by `aria-roledescription` per WAI-ARIA)? (3) can users pause, stop, or hide the auto-advance (visible play/pause button, not just pause-on-hover)? If auto-advance is present without user-operable controls, WCAG 2.2.2 fails.",
    references: [
      "https://www.w3.org/TR/WCAG22/#pause-stop-hide",
      "https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide",
      "https://www.w3.org/WAI/ARIA/apg/patterns/carousel/",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      scanHtml(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      scanJsx(ctx.ast as TsxModule, ctx.filePath, candidates);
    }
    return candidates;
  },
});

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

function scanHtml(root: HtmlDocument, filePath: string, candidates: ReviewCandidate[]): void {
  const seenLines = new Set<number>();
  for (const el of walkHtmlElements(root)) {
    const signal = detectHtmlSignal(el);
    if (!signal) continue;
    // Dedup per-line: a single element can match multiple signals
    // (e.g. `<div class="carousel" data-bs-ride="carousel">`). Prefer
    // the most specific signal — the first we detect per element — and
    // emit one candidate. The seenLines Set prevents adjacent nested
    // carousel roots (`.carousel` wrapping `.carousel-inner`) on the
    // same line from double-firing.
    const line = el.loc.start.line;
    const column = el.loc.start.column;
    const key = line * 10000 + column;
    if (seenLines.has(key)) continue;
    seenLines.add(key);
    pushCandidate(candidates, filePath, line, column, buildReason(el.tagName, signal));
  }
}

function detectHtmlSignal(el: HtmlElement): PatternSignal | null {
  // Precedence: data-bs-ride (most specific, auto-advance declared) >
  // aria-roledescription (WAI-ARIA pattern) > class-token (library shape).
  const ride = getHtmlAttribute(el, "data-bs-ride");
  if (ride !== null) {
    const trimmed = ride.trim().toLowerCase();
    if (trimmed === "carousel" || trimmed === "true") {
      return { kind: "data-bs-ride", value: ride.trim() };
    }
  }
  const role = getHtmlAttribute(el, "role")?.trim().toLowerCase() ?? null;
  const roleDesc = getHtmlAttribute(el, "aria-roledescription")?.trim().toLowerCase() ?? null;
  if (role === "region" && roleDesc === "carousel") {
    const hasLabel =
      getHtmlAttribute(el, "aria-label") !== null ||
      getHtmlAttribute(el, "aria-labelledby") !== null;
    return { kind: "aria-roledescription", hasName: hasLabel };
  }
  const className = getHtmlAttribute(el, "class");
  if (className !== null) {
    const match = CLASS_TOKEN_RE.exec(className);
    if (match) {
      return { kind: "class-token", token: match[1] ?? "carousel", className: className.trim() };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

function scanJsx(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  const seenKeys = new Set<number>();
  for (const el of walkJsxElements(root)) {
    const signal = detectJsxSignal(el);
    if (!signal) continue;
    const line = el.loc.start.line;
    const column = el.loc.start.column;
    const key = line * 10000 + column;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    pushCandidate(candidates, filePath, line, column, buildReason(el.tagName, signal));
  }
}

function detectJsxSignal(el: JsxElement): PatternSignal | null {
  const ride = getJsxAttributeString(el, "data-bs-ride");
  if (ride !== null) {
    const trimmed = ride.trim().toLowerCase();
    if (trimmed === "carousel" || trimmed === "true") {
      return { kind: "data-bs-ride", value: ride.trim() };
    }
  }
  const role = getJsxAttributeString(el, "role")?.trim().toLowerCase() ?? null;
  const roleDesc = getJsxAttributeString(el, "aria-roledescription")?.trim().toLowerCase() ?? null;
  if (role === "region" && roleDesc === "carousel") {
    // JSX label presence: accept either a string literal or an
    // expression binding (`aria-label={labelId}`). `hasJsxAttribute`
    // returns true whenever the attribute is present; the scanner
    // cannot resolve the expression value, but presence is enough to
    // answer the "is there an accessible-name attribute at all" half
    // of the review question. When false, the reason text flags the
    // aria-roledescription-without-name case explicitly.
    const hasLabel = hasJsxAttribute(el, "aria-label") || hasJsxAttribute(el, "aria-labelledby");
    return { kind: "aria-roledescription", hasName: hasLabel };
  }
  const className = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (className !== null) {
    const match = CLASS_TOKEN_RE.exec(className);
    if (match) {
      return { kind: "class-token", token: match[1] ?? "carousel", className: className.trim() };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function buildReason(tagName: string, signal: PatternSignal): string {
  // Reason text owns the dismissal frame. Every variant names (a) the
  // signal we matched, (b) the three review questions, (c) the fail
  // condition (auto-advance without controls). The aria-roledescription
  // variant additionally flags the name-required half of the pattern
  // when the attribute is missing — that is a deterministic signal we
  // can cite without heuristic inference.
  const tag = tagName.toLowerCase();
  const openQuestions = [
    "does it auto-advance (check `data-bs-interval`, `autoplay`, or a `setInterval` in the component's script)",
    "does the root have an accessible name (`aria-label` / `aria-labelledby`)",
    "can users pause, stop, or hide the auto-advance (visible play/pause button — pause-on-hover alone is not operable)",
  ];
  const questions = openQuestions.map((q, i) => `${i + 1}. ${q}?`).join(" ");
  if (signal.kind === "data-bs-ride") {
    return `<${tag}> carries \`data-bs-ride="${signal.value}"\` (Bootstrap carousel auto-advance marker) — verify the three review questions: ${questions} If auto-advance runs without operable controls, WCAG 2.2.2 fails.`;
  }
  if (signal.kind === "aria-roledescription") {
    const namePhrase = signal.hasName
      ? ""
      : " The root is missing `aria-label` / `aria-labelledby` — `aria-roledescription` requires an accessible name per ARIA (4.1.2 concern as well).";
    return `<${tag}> declares the WAI-ARIA carousel pattern (\`role="region"\` + \`aria-roledescription="carousel"\`).${namePhrase} Verify the three review questions: ${questions}`;
  }
  return `<${tag} class="${signal.className}"> matches the carousel class-token pattern (\`${signal.token}\`). Verify the three review questions: ${questions} If this element is not a rotating carousel (e.g. a misnamed static container), dismiss after one read.`;
}

function pushCandidate(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reason: string,
): void {
  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      // Confidence "medium": the shape predicates are deterministic
      // (attribute / class-token match) but the question the finder
      // surfaces — does auto-advance run without operable controls —
      // depends on JS behaviour and surrounding markup the scanner
      // cannot see. The reason text carries the dismissal vocabulary.
      confidence: "medium",
    });
  }
}
