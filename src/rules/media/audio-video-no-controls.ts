/**
 * Rule: media/audio-video-no-controls
 * Satisfies: wcag22:1.4.2, wcag22:2.1.1, wcag21:1.4.2, wcag21:2.1.1, section508:1.4.2, section508:2.1.1, en301549:9.1.4.2, en301549:9.2.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#audio-control
 *       https://www.w3.org/TR/WCAG22/#keyboard
 *
 * > 1.4.2 Audio Control: If any audio on a Web page plays automatically
 * > for more than 3 seconds, either a mechanism is available to pause
 * > or stop the audio, or a mechanism is available to control audio
 * > volume independently from the overall system volume level.
 *
 * > 2.1.1 Keyboard: All functionality of the content is operable
 * > through a keyboard interface without requiring specific timings
 * > for individual keystrokes.
 *
 * Source: https://www.w3.org/TR/WCAG22/#audio-control
 *
 * Flags `<audio>` and `<video>` elements that have no `controls`
 * attribute. Without `controls`, the native media UI is suppressed —
 * users have no built-in way to play, pause, mute, or adjust volume
 * via keyboard. The element is also unfocusable (no keyboard tab
 * stop), so 2.1.1 fails as well.
 *
 * Per the AI-first doctrine ("don't duplicate capability the agent
 * already has"), this rule does not try to detect JS-driven custom
 * controls in sibling scripts — that requires cross-file resolution
 * the consuming agent can do better with one Read. The `reason` text
 * frames the question: if the page provides custom controls,
 * suppress with a source-level pragma. The spec notes a `controls`
 * fallback is good practice anyway (degrades when the script fails).
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getJsxAttribute,
  hasHtmlAttribute,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "media/audio-video-no-controls",
  satisfies: [
    "wcag22:1.4.2",
    "wcag22:2.1.1",
    "wcag21:1.4.2",
    "wcag21:2.1.1",
    "section508:1.4.2",
    "section508:2.1.1",
    "en301549:9.1.4.2",
    "en301549:9.2.1.1",
  ],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "<audio> and <video> elements should expose user controls — without `controls`, there is no keyboard-operable mechanism to pause, mute, or adjust volume.",
    rationale:
      "An `<audio>` or `<video>` element without the `controls` attribute renders no built-in UI. The element is not focusable, so keyboard users cannot interact with it (WCAG 2.1.1), and any audio it plays cannot be stopped by the user (WCAG 1.4.2). Custom JS controls are valid alternatives, but they must wire up keyboard handling themselves and degrade when scripts fail. Adding `controls` as a fallback alongside custom UI is the safest pattern.",
    goodExample: `<video controls src="demo.mp4"></video>`,
    badExample: `<video src="demo.mp4"></video>`,
    normativeQuote:
      "If any audio on a Web page plays automatically for more than 3 seconds, either a mechanism is available to pause or stop the audio, or a mechanism is available to control audio volume independently from the overall system volume level. (1.4.2) — All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes. (2.1.1)",
    references: [
      "https://www.w3.org/TR/WCAG22/#audio-control",
      "https://www.w3.org/TR/WCAG22/#keyboard",
      "https://www.w3.org/WAI/WCAG22/Understanding/audio-control.html",
      "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
      return;
    }
    if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const tagName of ["audio", "video"] as const) {
    for (const element of findHtmlElementsByTag(doc, tagName)) {
      if (hasHtmlAttribute(element, "controls")) continue;
      emitViolation(tagName, element.loc.start, emit);
    }
  }
}

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const tagName of ["audio", "video"] as const) {
    for (const element of findJsxElementsByTag(module, tagName)) {
      if (hasTruthyJsxAttribute(element, "controls")) continue;
      emitViolation(tagName, element.loc.start, emit);
    }
  }
}

/**
 * True if the JSX element has the attribute and the value is not an
 * explicit `{false}` / `{null}` / `{undefined}` expression.
 *
 * Mirrors the pattern from `media/autoplay-sound`:
 *   - `<video controls />`            → value: null (shorthand truthy)
 *   - `<video controls="controls" />` → StringLiteral (truthy)
 *   - `<video controls={true} />`     → Expression "{true}" (truthy)
 *   - `<video controls={false} />`    → Expression "{false}" (falsy)
 *   - `<video controls={showUi} />`   → Expression (conservative: truthy)
 */
function hasTruthyJsxAttribute(element: JsxElement, name: string): boolean {
  const attr = getJsxAttribute(element, name);
  if (attr === null) return false;
  const value = attr.value;
  if (value === null) return true;
  if (value.kind === "StringLiteral") return true;
  const raw = value.raw.replace(/\s+/g, "");
  if (raw === "{false}" || raw === "{null}" || raw === "{undefined}") return false;
  return true;
}

function emitViolation(
  tagName: "audio" | "video",
  loc: { line: number; column: number },
  emit: Emit,
): void {
  emit({
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: buildMessage(tagName),
    suggestion: buildSuggestion(tagName),
  });
}

function buildMessage(tagName: "audio" | "video"): string {
  return `<${tagName}> element has no \`controls\` attribute — keyboard users cannot pause, mute, or adjust volume, and the element is not focusable.`;
}

function buildSuggestion(tagName: "audio" | "video"): string {
  return `Add the \`controls\` attribute (\`<${tagName} controls>\`) so the browser renders the native keyboard-operable media UI. If a custom JS-driven control bar is wired up to this element, keep \`controls\` as a fallback for when the script fails — or suppress this finding at the source with \`<!-- ra11y-disable media/audio-video-no-controls -->\` (HTML) / \`{/* ra11y-disable media/audio-video-no-controls */}\` (JSX) once you have verified the custom controls expose play/pause and volume to the keyboard.`;
}
