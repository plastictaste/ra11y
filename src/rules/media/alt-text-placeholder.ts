/**
 * Rule: media/alt-text-placeholder
 * Satisfies: wcag22:1.1.1, wcag21:1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * > All non-text content that is presented to the user has a text
 * > alternative that serves the equivalent purpose, except for the
 * > situations listed below: controls, input, time-based media,
 * > tests, sensory, CAPTCHA, decoration/formatting/invisible.
 *
 * Source: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * `media/alt-text-missing` catches `<img>` with no `alt` and `<img>`
 * with a whitespace-only `alt` value. This rule catches a narrower
 * band: `<img>` that HAS a non-empty `alt` attribute whose content
 * is generic placeholder boilerplate which defeats the purpose of a
 * text alternative — screen-reader users hear the literal words
 * "image," "screenshot," or "TODO" instead of a description of what
 * the image conveys. The boilerplate strings are the things humans
 * type when they know `alt` is required but don't know what to write
 * or are copying a scaffold.
 *
 * Spec hook: WCAG 2 Understanding 1.1.1 is explicit that the text
 * alternative must "serve the equivalent purpose" — boilerplate alt
 * that restates the medium ("image") or the authoring intent
 * ("TODO") carries no equivalent information and therefore fails.
 *
 * Placeholder categories (matched against the whole normalized alt,
 * case-insensitive):
 *
 *   1. Medium words — "image", "picture", "photo", "pic", "img",
 *      "screenshot", "graphic", "icon".
 *   2. Authoring placeholders — "placeholder", "todo", "fixme",
 *      "fix me", "change me".
 *   3. Meta words — "alt", "alt text", "description", "describe this".
 *   4. Single-word repetition — e.g. `alt="image image"` or
 *      `alt="todo todo todo"`.
 *
 * Matching is whole-alt-only. `alt="Aerial image of Paris"` passes
 * because the medium word is embedded in a real description; only
 * `alt="image"` on its own triggers. This keeps the rule honest —
 * we have no way to decide that a longer string is merely padded
 * boilerplate, and the agent can read the surrounding file to make
 * that call.
 *
 * Surfaces covered: `<img>` and `<input type="image">` in HTML and
 * JSX, plus JSX wrappers declared via `nativeWrappers: { Wrap: "img" }`
 * (the same opt-in used by `media/alt-text-missing`). SVG `<image>`
 * and `role="img"` elements use `aria-label` / child `<title>`
 * instead of `alt`; they are out of scope here — their
 * accessible-name channel doesn't carry an `alt` attribute to check.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "media/alt-text-placeholder",
  satisfies: ["wcag22:1.1.1", "wcag21:1.1.1"],
  severity: "warning",
  scope: "node",
  fixClass: "mechanical",
  wrapperTreatsAsElement: "img",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Flags <img> / <input type="image"> whose alt value is generic boilerplate ("image", "screenshot", "TODO", "placeholder") that carries no information about what the image conveys.',
    rationale:
      'WCAG 1.1.1 requires a text alternative that "serves the equivalent purpose." Boilerplate alt text — restating the medium ("image", "screenshot"), authoring markers ("TODO", "placeholder"), or meta words ("description") — conveys no information about the content, so the requirement is not met. Screen-reader users are announced the filler word verbatim and learn nothing about the image.',
    goodExample: `<img src="chart.png" alt="Quarterly revenue growth 2024-2026: $1.2M to $3.8M." />`,
    badExample: `<img src="chart.png" alt="image" />`,
    normativeQuote:
      "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose.",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html",
      "https://www.w3.org/WAI/tutorials/images/",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, ctx.wrappersForElement, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

// ---------------------------------------------------------------------------
// Placeholder classification
// ---------------------------------------------------------------------------

/**
 * Generic medium-words — saying an image is an "image" adds no
 * information. `screenshot` and `graphic` live here too because the
 * same logic applies: the medium is already implied by the element.
 */
const MEDIUM_WORDS: ReadonlySet<string> = new Set([
  "image",
  "picture",
  "photo",
  "pic",
  "img",
  "screenshot",
  "graphic",
  "icon",
]);

/** Authoring placeholders — fingerprints of scaffold or copy-paste boilerplate. */
const AUTHORING_WORDS: ReadonlySet<string> = new Set([
  "placeholder",
  "todo",
  "fixme",
  "fix me",
  "change me",
]);

/**
 * Meta words — the author typed the name of the attribute or the
 * concept of "a description" instead of writing one. Same failure
 * mode: no information about the image.
 */
const META_WORDS: ReadonlySet<string> = new Set([
  "alt",
  "alt text",
  "description",
  "describe this",
]);

type PlaceholderKind = "medium" | "authoring" | "meta" | "repetition";

interface PlaceholderMatch {
  readonly kind: PlaceholderKind;
  /** The normalized (trimmed, collapsed-whitespace) alt value. */
  readonly normalized: string;
}

/**
 * Returns the matched placeholder kind when `alt` is whole-match
 * boilerplate, or null when the alt carries real content. Callers
 * must have already ensured the alt attribute is present and
 * non-whitespace — the `media/alt-text-missing` rule owns the
 * empty / absent cases.
 */
function classifyAlt(alt: string): PlaceholderMatch | null {
  const collapsed = alt.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  const lower = collapsed.toLowerCase();
  if (MEDIUM_WORDS.has(lower)) return { kind: "medium", normalized: collapsed };
  if (AUTHORING_WORDS.has(lower)) return { kind: "authoring", normalized: collapsed };
  if (META_WORDS.has(lower)) return { kind: "meta", normalized: collapsed };
  // Repetition: collapsed into tokens, every token identical, and
  // more than one token present. Catches `image image`,
  // `todo todo todo`, `pic pic`.
  const tokens = lower.split(" ");
  if (tokens.length >= 2) {
    const first = tokens[0];
    if (first !== undefined && first.length > 0 && tokens.every((t) => t === first)) {
      return { kind: "repetition", normalized: collapsed };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const seen = new Set<HtmlElement>();
  for (const element of findHtmlElementsByTag(doc, "img")) {
    checkHtmlCandidate(element, seen, emit);
  }
  for (const input of findHtmlElementsByTag(doc, "input")) {
    const type = getHtmlAttribute(input, "type");
    if (type?.toLowerCase() !== "image") continue;
    checkHtmlCandidate(input, seen, emit);
  }
}

function checkHtmlCandidate(element: HtmlElement, seen: Set<HtmlElement>, emit: Emit): void {
  if (seen.has(element)) return;
  seen.add(element);
  const alt = getHtmlAttribute(element, "alt");
  if (alt === null) return;
  const match = classifyAlt(alt);
  if (!match) return;
  emitHtml(element, match, emit);
}

function emitHtml(element: HtmlElement, match: PlaceholderMatch, emit: Emit): void {
  const tag = element.tagName.toLowerCase();
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: element.loc.start.line,
      column: element.loc.start.column,
    },
    message: buildMessage(tag, match),
    suggestion: buildSuggestion(tag, match),
  });
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, wrappersForImg: ReadonlySet<string>, emit: Emit): void {
  const seen = new Set<JsxElement>();
  for (const element of findJsxElementsForTag(module, "img", wrappersForImg)) {
    checkJsxCandidate(element, seen, emit);
  }
  for (const input of findJsxElementsByTag(module, "input")) {
    const type = getJsxAttributeString(input, "type");
    if (type?.toLowerCase() !== "image") continue;
    checkJsxCandidate(input, seen, emit);
  }
}

function checkJsxCandidate(element: JsxElement, seen: Set<JsxElement>, emit: Emit): void {
  if (seen.has(element)) return;
  seen.add(element);
  const alt = getJsxAttributeString(element, "alt");
  if (alt === null) return;
  const match = classifyAlt(alt);
  if (!match) return;
  emitJsx(element, match, emit);
}

function emitJsx(element: JsxElement, match: PlaceholderMatch, emit: Emit): void {
  // `element.tagName` is as-authored (`img`, `Image`, `NextImage`);
  // lowercasing keeps messages consistent with the HTML path where
  // the parser lowercases for us.
  const tag = element.tagName;
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: element.loc.start.line,
      column: element.loc.start.column,
    },
    message: buildMessage(tag, match),
    suggestion: buildSuggestion(tag, match),
  });
}

// ---------------------------------------------------------------------------
// Message / suggestion builders
// ---------------------------------------------------------------------------

function buildMessage(tag: string, match: PlaceholderMatch): string {
  const reason =
    match.kind === "medium"
      ? "restates the medium instead of describing the content"
      : match.kind === "authoring"
        ? "is an authoring placeholder, not a description"
        : match.kind === "meta"
          ? "names the attribute instead of describing the content"
          : "repeats a single word instead of describing the content";
  return `<${tag}> has alt="${match.normalized}" which ${reason}; screen readers announce this boilerplate verbatim and users learn nothing about the image.`;
}

function buildSuggestion(tag: string, match: PlaceholderMatch): string {
  const hint =
    match.kind === "authoring"
      ? `Replace the placeholder alt="${match.normalized}" with a description of what the image conveys in this context.`
      : `Replace alt="${match.normalized}" with a description of what the image communicates — not the fact that it is an image.`;
  return `${hint} If the image is purely decorative and the surrounding text already carries the same information, set alt="" so assistive tech skips it. If the <${tag}> is inside a link or button, the alt should describe the destination or action, not the picture.`;
}
