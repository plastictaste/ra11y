/**
 * Candidate finder: review/toggle-button-pressed-missing
 * Criteria: wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * Surfaces `<button>` elements that look like a stateful toggle
 * (dark/light mode switcher, mute/unmute, follow/unfollow, expand/
 * collapse-of-its-own-state) yet carry no `aria-pressed`, no
 * `aria-checked`, and no `role="switch"`. The canonical real-world
 * shape is `<button class="toggle">Dark mode</button>` whose click
 * handler flips a class on `<html>` — sighted users see the toggle
 * cycle, but assistive tech announces only "Dark mode, button" with
 * no off/on state.
 *
 * Distinct from the disclosure axis (`aria-expanded`):
 *   - A disclosure button toggles visibility of a related region
 *     (menu, accordion, dropdown). Its state is "is the region
 *     showing?" and the right ARIA is `aria-expanded`.
 *   - A toggle button has persistent on/off state of its OWN value
 *     (dark mode on/off, mute on/off, follow/unfollow). The right
 *     ARIA is `aria-pressed` (or `role="switch"` + `aria-checked`).
 * The two patterns coexist in real codebases — this finder only
 * surfaces the toggle-state-without-pressed shape.
 *
 * Why a review candidate, not a hard rule:
 *
 *   - Static analysis cannot verify the click handler actually
 *     produces persistent on/off state — the button labeled "Toggle"
 *     might dispatch a one-shot action (toggleNotifications() that
 *     fires a transient toast) rather than flipping a stateful
 *     attribute. Per the AI-first doctrine "Heuristic emission is
 *     the symmetric twin of heuristic suppression," a deterministic
 *     emission on speculation about runtime composition would lie.
 *   - Cross-file handler resolution is lossy — the agent reading
 *     the cited file plus the imported handler module is the only
 *     correct arbiter.
 *
 * Predicate (conservative):
 *   - Element is `<button>`.
 *   - Either:
 *     (a) class attribute contains a token matching `/toggle|switch|mode/i`, OR
 *     (b) visible text matches one of a tight, named list of toggle
 *         labels (`"dark mode"`, `"light mode"`, `"toggle"`, `"switch"`,
 *         `"mute"`, `"unmute"`, `"follow"`, `"unfollow"`, etc.).
 *   - Element has no `aria-pressed`, no `aria-checked`, and no
 *     `role="switch"` (any of these declares the toggle pattern
 *     deliberately).
 *
 * The matched signal (class token vs visible text) is echoed in the
 * `reason` so the agent can triage in one read. Per AI-first doctrine
 * "Surface, don't suppress," the candidate frames the question rather
 * than asserts the violation.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  jsxTextContent,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:4.1.2", "wcag21:4.1.2"] as const;

/**
 * Class-token substrings that, when found inside any whitespace-
 * separated class token (case-insensitive), put the button in the
 * toggle-shape candidate set. Matches the substring INSIDE a token —
 * `class="theme-toggle"` matches via `toggle`, `class="mode-switcher"`
 * via `switch`, `class="dark-mode-button"` via `mode`.
 *
 * Conservative — we deliberately do NOT match `state`, `flag`, or
 * `pressed` (which can appear on non-toggle buttons; per AI-first
 * doctrine "Surface, don't suppress," the substring set is small and
 * curated rather than fuzz-matched). If a field report brings a
 * missing convention, extend this list; don't reach for a regex
 * widening exercise.
 */
const CLASS_TOKEN_SUBSTRINGS: readonly string[] = ["toggle", "switch", "mode"];

/**
 * Visible-text labels that, when matched as the button's exact
 * collapsed visible text (case-insensitive, trimmed), put the button
 * in the toggle-shape candidate set. Whole-string match — not a
 * substring — so a button reading `"Submit form"` matching no entry
 * does NOT fire even though `form` is not in the list.
 *
 * Conservative — chosen because each is a recognized stateful-toggle
 * label whose canonical interaction flips an on/off attribute. Per
 * AI-first doctrine "Surface, don't suppress," the list is small and
 * named; if a field report brings a missing convention (e.g. native
 * locales), extend this list rather than fuzz-match.
 *
 * Pairs of opposites (`"dark mode" / "light mode"`, `"mute" / "unmute"`,
 * `"follow" / "unfollow"`) are listed both ways so a button that
 * starts in either state is still flagged.
 */
const VISIBLE_TEXT_LABELS: ReadonlySet<string> = new Set([
  "toggle",
  "switch",
  "dark mode",
  "light mode",
  "night mode",
  "day mode",
  "mute",
  "unmute",
  "follow",
  "unfollow",
  "subscribe",
  "unsubscribe",
  "play",
  "pause",
]);

/** JSX tags treated as native `<button>` wrappers for cross-library coverage. */
const JSX_BUTTON_TAGS: ReadonlySet<string> = new Set(["button", "Button"]);

export const finder = defineCandidateFinder({
  id: "review/toggle-button-pressed-missing",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds <button> elements that look like a stateful toggle (class token containing toggle/switch/mode, or visible text matching a curated set of toggle labels) yet carry no aria-pressed, aria-checked, or role='switch'.",
    reviewPrompt:
      "Verify whether this button represents a persistent on/off state (dark mode, mute, follow). If yes, expose the state to assistive tech via aria-pressed='true|false' (toggle button pattern) or role='switch' + aria-checked='true|false' (switch pattern). If the button is actually a one-shot action (dispatches an event without persistent state) or a disclosure (toggles visibility of a related region — use aria-expanded), no change is needed.",
    references: [
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/ARIA/apg/patterns/button/examples/button/",
      "https://www.w3.org/WAI/ARIA/apg/patterns/switch/",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, ctx.wrappersForElement, candidates);
    }
    return candidates;
  },
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (const button of findHtmlElementsByTag(root, "button")) {
    if (hasTogglePatternOptInHtml(button)) continue;
    const match = matchToggleSignalHtml(button);
    if (!match) continue;
    pushCandidates(
      candidates,
      filePath,
      button.loc.start.line,
      button.loc.start.column,
      reason(match.kind, match.evidence),
    );
  }
}

interface SignalMatch {
  readonly kind: "class-token" | "visible-text";
  readonly evidence: string;
}

function matchToggleSignalHtml(button: HtmlElement): SignalMatch | null {
  const classMatch = matchClassTokenHtml(button);
  if (classMatch) return { kind: "class-token", evidence: classMatch };
  const textMatch = matchVisibleTextHtml(button);
  if (textMatch) return { kind: "visible-text", evidence: textMatch };
  return null;
}

function matchClassTokenHtml(button: HtmlElement): string | null {
  const classAttr = getHtmlAttribute(button, "class");
  if (!classAttr) return null;
  return matchClassTokens(classAttr);
}

function matchVisibleTextHtml(button: HtmlElement): string | null {
  const text = htmlTextContent(button);
  return matchVisibleTextLabel(text);
}

function hasTogglePatternOptInHtml(button: HtmlElement): boolean {
  if (hasHtmlAttribute(button, "aria-pressed")) return true;
  if (hasHtmlAttribute(button, "aria-checked")) return true;
  const role = getHtmlAttribute(button, "role");
  if (role !== null && role.trim().toLowerCase() === "switch") return true;
  return false;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function findJsxCandidates(
  module: TsxModule,
  filePath: string,
  wrappersForButton: ReadonlySet<string>,
  candidates: ReviewCandidate[],
): void {
  const wrappers = new Set<string>([...JSX_BUTTON_TAGS, ...wrappersForButton]);
  wrappers.delete("button");
  for (const button of findJsxElementsForTag(module, "button", wrappers)) {
    if (hasTogglePatternOptInJsx(button)) continue;
    const match = matchToggleSignalJsx(button);
    if (!match) continue;
    pushCandidates(
      candidates,
      filePath,
      button.loc.start.line,
      button.loc.start.column,
      reason(match.kind, match.evidence),
    );
  }
}

function matchToggleSignalJsx(button: JsxElement): SignalMatch | null {
  const classMatch = matchClassTokenJsx(button);
  if (classMatch) return { kind: "class-token", evidence: classMatch };
  const textMatch = matchVisibleTextJsx(button);
  if (textMatch) return { kind: "visible-text", evidence: textMatch };
  return null;
}

function matchClassTokenJsx(button: JsxElement): string | null {
  const classValue =
    getJsxAttributeString(button, "className") ?? getJsxAttributeString(button, "class");
  if (!classValue) return null;
  return matchClassTokens(classValue);
}

function matchVisibleTextJsx(button: JsxElement): string | null {
  const text = jsxTextContent(button);
  return matchVisibleTextLabel(text);
}

function hasTogglePatternOptInJsx(button: JsxElement): boolean {
  if (hasJsxAttribute(button, "aria-pressed")) return true;
  if (hasJsxAttribute(button, "aria-checked")) return true;
  const role = getJsxAttributeString(button, "role");
  if (role !== null && role.trim().toLowerCase() === "switch") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Returns the verbatim class token (lowercased) that matched a known
 * toggle substring, or null when no token matches. Substring match
 * inside a whitespace-separated token — `theme-toggle` matches via
 * `toggle`, `mode-switcher` via `switch`, `dark-mode-button` via `mode`.
 */
function matchClassTokens(classAttr: string): string | null {
  for (const tok of classAttr.split(/\s+/u)) {
    const lowered = tok.toLowerCase();
    if (!lowered) continue;
    for (const needle of CLASS_TOKEN_SUBSTRINGS) {
      if (lowered.includes(needle)) return lowered;
    }
  }
  return null;
}

/**
 * Returns the verbatim visible-text label (lowercased, trimmed,
 * whitespace-collapsed) when it whole-string-matches a known
 * toggle label, or null otherwise. Whole-string match — a button
 * reading "Submit form" or "Dark mode toggle" does NOT fire (the
 * latter is a noun phrase, not a toggle label per se).
 */
function matchVisibleTextLabel(text: string): string | null {
  const normalized = text.replace(/\s+/gu, " ").trim().toLowerCase();
  if (!normalized) return null;
  return VISIBLE_TEXT_LABELS.has(normalized) ? normalized : null;
}

function pushCandidates(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reasonText: string,
): void {
  for (const criterionId of CRITERION_IDS) {
    // Confidence "medium": the static signal is concrete (button tag
    // + class-token or visible-text match + no aria-pressed /
    // aria-checked / role=switch), but the criterion question turns
    // on the click handler's runtime behavior — does the handler
    // produce persistent on/off state, or a one-shot action? The
    // agent's one Read of the handler confirms; the finder points
    // honestly.
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason: reasonText,
      confidence: "medium",
    });
  }
}

function reason(kind: SignalMatch["kind"], evidence: string): string {
  const signal =
    kind === "class-token"
      ? `class token "${evidence}" suggests a stateful toggle`
      : `visible text "${evidence}" matches a toggle-pattern label`;
  return (
    `<button> — ${signal}, but no aria-pressed, aria-checked, or role="switch" is set. ` +
    `Verify whether the button represents a persistent on/off state (dark mode, mute, follow). ` +
    `If yes, add aria-pressed="true|false" (toggle button) or role="switch" + aria-checked="true|false" (switch pattern). ` +
    `If the button is actually a one-shot action or a disclosure (toggling visibility of a related region — use aria-expanded), no change is needed.`
  );
}
