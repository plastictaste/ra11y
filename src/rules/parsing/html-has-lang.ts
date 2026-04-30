/**
 * Rule: parsing/html-has-lang
 * Satisfies: wcag22:3.1.2, wcag21:3.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#language-of-parts
 *
 * > The human language of each passage or phrase in the content can be
 * > programmatically determined except for proper names, technical terms,
 * > words of indeterminate language, and words or phrases that have become
 * > part of the vernacular of the immediately surrounding text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#language-of-parts
 *
 * This rule is complementary to `document/lang-attribute` (3.1.1 Language
 * of Page). That rule flags a missing/empty lang at the document root;
 * this one flags any element whose lang attribute *is* present but is
 * empty or syntactically invalid BCP 47. Wrong language metadata is as
 * harmful as missing — a screen reader that trusts `lang="english"` will
 * fall back to the default voice and mispronounce everything.
 *
 * BCP 47 (RFC 5646) is intentionally flexible; this rule enforces the
 * common subset most humans write by hand: a 2- or 3-letter primary
 * language subtag optionally followed by dash-separated subtags of 1-8
 * alphanumerics each. That matches everything in the IANA registry a
 * typical author would use (en, en-US, zh-Hans, es-419, de-CH-1901,
 * sr-Latn-RS) without trying to mirror the registry itself.
 *
 * The rule also flags the *underspecified* BCP 47 codes — `zxx` (no
 * linguistic content), `und` (undetermined), `mul` (multiple), and
 * `mis` (uncoded) — when the bearing element actually contains visible
 * prose. These codes are syntactically valid but semantically assert
 * "no single language applies"; declaring them on a page that has UI
 * copy contradicts the content and causes screen readers to skip
 * pronunciation or fall back to the default voice on text the user
 * will actually hear. The motivating real-world case was a Bootstrap
 * floating-label demo whose `<html lang="zxx">` shipped alongside an
 * English UI. The check is binary: any visible body text triggers it,
 * with the character count surfaced in the reason for agent triage.
 *
 * Document-scoped. Runs on .html/.htm files only; JSX support can be
 * added later once jsx ast-helpers surface attribute walks as cleanly.
 *
 * Framework-convention hosts are skipped: `<style lang="scss">` and
 * `<script lang="ts">` (Vue SFC, Astro, Svelte) overload `lang` as a
 * preprocessor tag, and `<Component lang="...">` (PascalCase) is a
 * custom prop. BCP 47 is not the contract on those tags. Sibling rule
 * `document/lang-on-parts` applies the identical gate.
 */

import { defineRule } from "../../api/plugin.ts";
import { truncateForEcho, walkHtmlElements } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";

/**
 * Basic BCP 47 syntax:
 *   - primary subtag: 2 or 3 letters (ISO 639-1/2/3)
 *   - zero or more extension subtags, each 1-8 alphanumerics, dash-separated
 * Case-insensitive. Does not validate against the IANA registry.
 */
const BCP47_BASIC = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;

/**
 * BCP 47 / ISO 639-2 codes that explicitly disclaim a language:
 *   - `zxx`: no linguistic content; not applicable
 *   - `und`: undetermined
 *   - `mul`: multiple languages (no single primary)
 *   - `mis`: uncoded languages (no ISO code exists)
 *
 * Each is a syntactically valid BCP 47 primary subtag (3 letters, passes
 * `BCP47_BASIC`), but each asserts that the element has no single
 * identifiable language. When the bearing element nonetheless contains
 * substantial visible prose, the declaration contradicts the content —
 * a screen reader trusting `lang="zxx"` will skip pronunciation entirely
 * or fall back to the default voice on text the user will actually hear.
 *
 * Reference: https://www.loc.gov/standards/iso639-2/php/code_list.php
 */
const UNDERSPECIFIED_LANG_CODES = new Set(["zxx", "und", "mul", "mis"]);

/**
 * Tags whose text content is not surfaced as prose to the user — script
 * source, stylesheet declarations, off-screen `<template>` content, head
 * metadata, and `<noscript>` fallbacks. The visible-text collector for
 * the underspecified-lang check skips these subtrees so a page with
 * `<script>console.log("hi")</script>` and no body text does not trip
 * the contradiction check on `lang="zxx"`. (The doctype + html
 * scaffolding contributes no text either way.)
 */
const NON_VISIBLE_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "head"]);

/**
 * Tags whose `lang` attribute is a build-tool preprocessor language tag
 * rather than a BCP 47 natural-language tag. In Vue SFCs, Astro, Svelte,
 * and similar component-file dialects, `<style lang="scss">` and
 * `<script lang="ts">` declare the source dialect of the embedded block
 * — `lang="scss"` / `lang="ts"` / `lang="postcss"` are not BCP 47 tags
 * and were never intended to be. WCAG 3.1.1 / 3.1.2 govern natural
 * language declarations on content-bearing elements; the spec contract
 * does not extend to the build-tool overload of the attribute.
 *
 * Reference: https://vuejs.org/api/sfc-spec.html (Pre-Processors),
 * https://docs.astro.build/en/core-concepts/astro-components/#styles--css.
 */
const FRAMEWORK_PREPROCESSOR_HOSTS = new Set(["script", "style"]);

/**
 * PascalCase tag pattern: first character ASCII A-Z. JSX (and a number
 * of HTML-shaped component-file dialects) treat capitalized tag names
 * as user components; their `lang` attribute is a custom prop, not the
 * HTML `lang` attribute. Lowercase HTML tag names (`html`, `span`,
 * `p`, `div`, `section`) and hyphenated custom-element names
 * (`my-widget`) are unaffected.
 */
const PASCAL_CASE_RE = /^[A-Z]/;

export const rule = defineRule({
  id: "parsing/html-has-lang",
  satisfies: ["wcag22:3.1.1", "wcag21:3.1.1", "wcag22:3.1.2", "wcag21:3.1.2"],
  severity: "error",
  scope: "document",
  // Picking a correct BCP 47 tag for the cited element requires
  // reading the visible text to know what language it is in — the
  // scanner has no signal for "is this English, French, Spanish,
  // or mistyped". Even on the empty-lang branch, the safe default
  // (`lang="en"`) is wrong for non-English content. Per AI-first
  // doctrine "Per-call shape must agree with per-class plan
  // tally," `verify-in-source` keeps the plan tally honest.
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "Every element that declares a lang attribute must use a syntactically valid, non-empty BCP 47 language tag — and underspecified codes (zxx, und, mul, mis) must not appear on elements that contain visible prose.",
    rationale:
      'Screen readers switch pronunciation dictionaries based on lang. An empty or malformed value (lang="", lang="english", lang="en_US") is treated as unknown — the assistive technology falls back to the default voice and mispronounces the content, which is indistinguishable from no lang attribute at all. Underspecified codes like zxx ("no linguistic content") are syntactically valid but semantically wrong on a page with real UI copy: the screen reader trusts the declaration and either skips pronunciation or falls back to the default voice on text the user will actually hear.',
    goodExample: `<html lang="en-US"><body><p lang="fr">Bonjour</p></body></html>`,
    badExample: `<html lang="zxx"><body><p>Email address</p><button>Sign in</button></body></html>`,
    normativeQuote:
      "The human language of each passage or phrase in the content can be programmatically determined except for proper names, technical terms, words of indeterminate language, and words or phrases that have become part of the vernacular of the immediately surrounding text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#language-of-parts",
      "https://www.w3.org/WAI/WCAG22/Techniques/html/H58",
      "https://www.rfc-editor.org/rfc/rfc5646",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    for (const element of walkHtmlElements(doc)) {
      const problem = classifyLang(element);
      if (!problem) continue;
      ctx.emit({
        severity: "error",
        location: {
          filePath: "",
          line: element.loc.start.line,
          column: element.loc.start.column,
        },
        message: problem.message,
        suggestion: problem.suggestion,
      });
    }
  },
});

interface LangProblem {
  readonly message: string;
  readonly suggestion: string;
}

function classifyLang(element: HtmlElement): LangProblem | null {
  // Framework-convention hosts overload `lang` as a build-tool
  // preprocessor tag (Vue SFC `<style lang="scss">`, Astro
  // `<script lang="ts">`) or a custom component prop
  // (`<Component lang="...">`); BCP 47 is not the spec contract here.
  // See FRAMEWORK_PREPROCESSOR_HOSTS / PASCAL_CASE_RE for the closure
  // rationale.
  if (FRAMEWORK_PREPROCESSOR_HOSTS.has(element.tagName.toLowerCase())) return null;
  if (PASCAL_CASE_RE.test(element.tagName)) return null;
  const raw = findLangAttribute(element);
  if (raw === null) return null;
  const trimmed = raw.trim();
  // Template-directive-bearing values (`lang="{{ site.lang }}"`,
  // `lang="{% if x %}en{% else %}fr{% endif %}"`) are opaque to
  // static analysis — the scanner cannot know whether the rendered
  // output is a valid BCP 47 tag. Surfacing a confident "invalid"
  // violation against the literal source would be dishonest; the
  // agent reading the rendered output is the correct arbiter. The
  // canonical Jekyll scaffold (`<html lang="{{ site.lang | default:
  // "en-US" }}">`) is the motivating case.
  if (trimmed.includes("{{") || trimmed.includes("{%")) return null;
  const tag = `<${element.tagName}>`;
  if (trimmed.length === 0) {
    return {
      message: `${tag} has an empty lang attribute — screen readers treat this as no language at all and fall back to the default voice.`,
      suggestion: `Set lang to a valid BCP 47 tag that matches this element's content, e.g. lang="en" or lang="en-US". If the ${tag} shouldn't declare a language, remove the attribute entirely so the parent element's lang takes effect.`,
    };
  }
  if (!BCP47_BASIC.test(trimmed)) {
    // `raw` is a user-authored attribute value — valid tags are short
    // by spec, but malformed values can be arbitrary pasted text.
    return {
      message: `${tag} has lang="${truncateForEcho(raw)}" which is not a valid BCP 47 language tag — screen readers will ignore it and fall back to the default voice.`,
      suggestion: buildInvalidSuggestion(raw, trimmed, element.tagName),
    };
  }
  // The tag passes BCP 47 syntax, but the underspecified codes (zxx,
  // und, mul, mis) only make sense on elements without visible prose.
  // A page that ships real UI copy under `lang="zxx"` is contradictory
  // — agent doctrine: surface the count and let the consumer decide.
  const primarySubtag = trimmed.split("-", 1)[0]?.toLowerCase() ?? "";
  if (UNDERSPECIFIED_LANG_CODES.has(primarySubtag)) {
    const visibleChars = collectVisibleTextLength(element);
    if (visibleChars > 0) {
      return {
        message: `${tag} declares lang="${truncateForEcho(raw)}" (${describeUnderspecifiedCode(primarySubtag)}) but the element contains ${visibleChars} character(s) of visible text — screen readers will trust the declaration and either skip pronunciation or fall back to the default voice on text the user will actually hear.`,
        suggestion: `Replace lang="${truncateForEcho(raw)}" on ${tag} with the BCP 47 tag for the language the visible text is actually written in (e.g. lang="en" or lang="en-US"). Reserve lang="zxx" for elements that genuinely contain no linguistic content (pure decorative imagery, code blocks, or symbol-only UI).`,
      };
    }
  }
  return null;
}

/**
 * Concatenated visible-text length under `element`, with non-visible
 * subtrees (`<script>`, `<style>`, `<noscript>`, `<template>`,
 * `<head>`) excluded. Returns the trimmed-character count rather than
 * the string itself — callers only need the magnitude for the reason
 * text and avoiding the allocation matters on large documents.
 *
 * Template-directive-bearing text (`{{ … }}`, `{% … %}` survivors) is
 * intentionally counted: the rendered output is the user-visible
 * surface, and a Liquid `{{ message }}` interpolation on a `lang="zxx"`
 * page is exactly the contradiction worth flagging.
 */
function collectVisibleTextLength(element: HtmlElement): number {
  let total = 0;
  const visit = (node: HtmlElement): void => {
    if (NON_VISIBLE_TEXT_TAGS.has(node.tagName.toLowerCase())) return;
    for (const child of node.children) {
      if (child.kind === "HtmlText") total += child.value.trim().length;
      else if (child.kind === "HtmlElement") visit(child);
    }
  };
  visit(element);
  return total;
}

function describeUnderspecifiedCode(code: string): string {
  switch (code) {
    case "zxx":
      return "no linguistic content";
    case "und":
      return "undetermined language";
    case "mul":
      return "multiple languages";
    case "mis":
      return "uncoded language";
    default:
      return "underspecified language";
  }
}

function findLangAttribute(element: HtmlElement): string | null {
  // We walk the raw attribute list (not getHtmlAttribute) because we
  // need to distinguish "attribute absent" from "attribute empty" —
  // getHtmlAttribute returns "" in both the lang="" and the boolean
  // lang cases, and we want to flag both.
  for (const attr of element.attributes) {
    if (attr.name.toLowerCase() === "lang") return attr.value;
  }
  return null;
}

function buildInvalidSuggestion(raw: string, trimmed: string, tagName: string): string {
  const tag = `<${tagName}>`;
  if (raw !== trimmed) {
    return `Remove the surrounding whitespace and use a valid BCP 47 tag on ${tag}, e.g. lang="en" or lang="en-US".`;
  }
  // Cap user-authored echoes; `dashed`/`guess` are derived from the
  // same `raw` (or a controlled vocabulary) so capping `raw` first
  // keeps both echoes bounded.
  const echoRaw = truncateForEcho(raw);
  if (trimmed.includes("_")) {
    const dashed = truncateForEcho(trimmed.replace(/_/g, "-"));
    return `BCP 47 separates subtags with dashes, not underscores. Change lang="${echoRaw}" to lang="${dashed}".`;
  }
  const guess = guessBcp47(trimmed);
  if (guess) {
    return `Use the BCP 47 code for this language on ${tag}, e.g. lang="${guess}". Full-word names like "${echoRaw}" are not valid — the primary subtag must be a 2- or 3-letter ISO 639 code.`;
  }
  return `Replace lang="${echoRaw}" on ${tag} with a valid BCP 47 tag: a 2- or 3-letter primary language subtag (optionally followed by dash-separated region/script subtags), e.g. lang="en" or lang="en-US".`;
}

function guessBcp47(value: string): string | null {
  const lowered = value.toLowerCase();
  const known: Record<string, string> = {
    english: "en",
    french: "fr",
    spanish: "es",
    german: "de",
    italian: "it",
    portuguese: "pt",
    japanese: "ja",
    chinese: "zh",
    korean: "ko",
    russian: "ru",
    arabic: "ar",
    dutch: "nl",
    swedish: "sv",
    norwegian: "no",
    danish: "da",
    finnish: "fi",
    polish: "pl",
    turkish: "tr",
    hebrew: "he",
    hindi: "hi",
  };
  return known[lowered] ?? null;
}
