/**
 * Rule: media/audio-controls-or-transcript-missing
 * Satisfies: wcag22:1.1.1, wcag21:1.1.1, section508:1.1.1, en301549:9.1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * > 1.1.1 Non-text Content: All non-text content that is presented to
 * > the user has a text alternative that serves the equivalent purpose,
 * > except for the situations listed below.
 *
 * Source: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * Flags `<audio>` elements that fail three deterministic predicates at
 * once:
 *   1. no `controls` attribute (no native UI exposing the audio),
 *   2. no `<track>` child (no caption / description track), AND
 *   3. no transcript-link signal in immediate siblings or the parent's
 *      siblings (`<a href="…">` whose href looks like a transcript file
 *      OR whose text content contains "transcript").
 *
 * The conjunctive predicate is the strongest static signal of total
 * inaccessibility — the audio element has zero text-alternative paths
 * the parser can observe. The companion rule `media/audio-video-no-controls`
 * covers the WCAG 1.4.2 / 2.1.1 angle (no keyboard-operable mechanism)
 * on the same element; this rule covers the WCAG 1.1.1 angle (no text
 * alternative for non-text content).
 *
 * Per the AI-first doctrine ("don't duplicate capability the agent
 * already has"), this rule does not try to detect transcripts in
 * sibling routes, JS-driven content insertion, or off-page links —
 * cross-file resolution belongs to the consuming agent. Sibling-anchor
 * detection stays in-file because the predicate is deterministic and
 * authors usually colocate transcript links next to the audio they
 * transcribe.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getJsxAttribute,
  hasHtmlAttribute,
  htmlTextContent,
  jsxTextContent,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

export const rule = defineRule({
  id: "media/audio-controls-or-transcript-missing",
  satisfies: ["wcag22:1.1.1", "wcag21:1.1.1", "section508:1.1.1", "en301549:9.1.1.1"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "<audio> elements with no controls, no <track>, and no neighboring transcript link have no text alternative — failing WCAG 1.1.1 (Non-text Content).",
    rationale:
      'Audio content is non-text content under WCAG 1.1.1: it must have a text alternative serving the equivalent purpose. The static-deterministic signal that no text alternative exists is the conjunction of three observable predicates: no `controls` attribute (no transcript surfaced via the player UI), no `<track>` child (no caption/description track inline), and no transcript anchor in the surrounding siblings (no `<a href="transcript.…">` link). When all three fail, the audio is inaccessible to anyone who cannot hear it. Adding any one of `controls`, a `<track>`, or a clearly-labeled transcript anchor next to the element resolves the static signal.',
    goodExample: `<audio src="podcast.mp3" controls></audio>\n<a href="podcast-transcript.html">Read the transcript</a>`,
    badExample: `<audio src="podcast.mp3"></audio>`,
    normativeQuote:
      "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose, except for the situations listed below. (1.1.1 Non-text Content)",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G158",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
      return;
    }
    if (ctx.language === "tsx" || ctx.language === "jsx") {
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

// File extensions that authors conventionally use for transcripts.
// These are deterministic surface signals — the agent verifies the
// link target is actually a transcript when it Reads the file.
const TRANSCRIPT_HREF_EXTENSIONS = [".txt", ".html", ".htm", ".pdf", ".md", ".vtt", ".srt"];

function looksLikeTranscriptHref(href: string): boolean {
  const lower = href.trim().toLowerCase();
  if (lower.length === 0) return false;
  // Strip query string and fragment before extension match.
  const path = lower.split(/[?#]/)[0] ?? lower;
  return TRANSCRIPT_HREF_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function looksLikeTranscriptText(text: string): boolean {
  return /transcript/i.test(text);
}

// HTML side. Build a parent-children index for `<audio>` elements so
// we can scan their siblings (and the parent's siblings as a second
// ring) for transcript anchors in O(N).
function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const audioToParents = indexHtmlAudioParents(doc);
  for (const [audio, ancestry] of audioToParents.entries()) {
    if (hasHtmlAttribute(audio, "controls")) continue;
    if (hasHtmlTrackChild(audio)) continue;
    if (htmlAncestryHasTranscriptAnchor(ancestry, audio)) continue;
    emitViolation(audio.loc.start, getHtmlAttributeValue(audio, "src"), emit);
  }
}

function getHtmlAttributeValue(element: HtmlElement, name: string): string | null {
  const lower = name.toLowerCase();
  for (const attr of element.attributes) {
    if (attr.name.toLowerCase() === lower) return attr.value;
  }
  return null;
}

function hasHtmlTrackChild(audio: HtmlElement): boolean {
  for (const child of audio.children) {
    if (child.kind === "HtmlElement" && child.tagName.toLowerCase() === "track") return true;
  }
  return false;
}

interface HtmlAncestry {
  // Children list of the audio's parent (immediate ring).
  readonly siblings: readonly HtmlNode[];
  // The audio's parent element (or null at document root). Used to
  // exclude the parent itself when scanning grandparent's children
  // for a wrapper-figure-style transcript anchor.
  readonly parent: HtmlElement | null;
  // Children list of the parent's parent (second ring) — transcripts
  // commonly sit next to a wrapper `<figure>` / `<div>`.
  readonly grandparentSiblings: readonly HtmlNode[];
}

function indexHtmlAudioParents(doc: HtmlDocument): Map<HtmlElement, HtmlAncestry> {
  const out = new Map<HtmlElement, HtmlAncestry>();
  visit(doc.children, null, doc.children);
  return out;

  function visit(
    children: readonly HtmlNode[],
    parent: HtmlElement | null,
    grandparentSiblings: readonly HtmlNode[],
  ): void {
    for (const child of children) {
      if (child.kind !== "HtmlElement") continue;
      if (child.tagName.toLowerCase() === "audio") {
        out.set(child, { siblings: children, parent, grandparentSiblings });
      }
      visit(child.children, child, children);
    }
  }
}

function htmlAncestryHasTranscriptAnchor(ancestry: HtmlAncestry, audio: HtmlElement): boolean {
  // Ring 1 (direct siblings of <audio>): search recursively into
  // nested elements so `<a><span>Transcript</span></a>` resolves.
  if (htmlSiblingsHaveTranscriptAnchor(ancestry.siblings, audio, true)) return true;
  // Ring 2 (the parent's direct siblings, e.g. a wrapper-figure
  // pattern): consider only direct `<a>` siblings — do NOT recurse
  // into their subtrees. Recursion at this depth risks false
  // negatives where a transcript link in an unrelated subtree
  // suppresses emission for a different audio.
  return htmlNodesContainDirectTranscriptAnchor(ancestry.grandparentSiblings, ancestry.parent);
}

function htmlSiblingsHaveTranscriptAnchor(
  nodes: readonly HtmlNode[],
  audio: HtmlElement,
  recurse: boolean,
): boolean {
  for (const node of nodes) {
    if (node === audio) continue;
    if (node.kind !== "HtmlElement") continue;
    if (recurse) {
      if (containsHtmlTranscriptAnchor(node)) return true;
    } else if (node.tagName.toLowerCase() === "a" && htmlAnchorIsTranscript(node)) {
      return true;
    }
  }
  return false;
}

function htmlNodesContainDirectTranscriptAnchor(
  nodes: readonly HtmlNode[],
  exclude: HtmlElement | null,
): boolean {
  for (const node of nodes) {
    if (node === exclude) continue;
    if (node.kind !== "HtmlElement") continue;
    if (node.tagName.toLowerCase() === "a" && htmlAnchorIsTranscript(node)) return true;
  }
  return false;
}

function containsHtmlTranscriptAnchor(element: HtmlElement): boolean {
  if (element.tagName.toLowerCase() === "a" && htmlAnchorIsTranscript(element)) return true;
  for (const child of element.children) {
    if (child.kind === "HtmlElement" && containsHtmlTranscriptAnchor(child)) return true;
  }
  return false;
}

function htmlAnchorIsTranscript(anchor: HtmlElement): boolean {
  const href = getHtmlAttributeValue(anchor, "href");
  const text = htmlTextContent(anchor);
  if (href !== null && looksLikeTranscriptHref(href)) return true;
  if (looksLikeTranscriptText(text)) return true;
  return false;
}

// JSX side. Mirrors the HTML algorithm — find `<audio>` elements,
// reject `controls={true}` / shorthand, reject `<track>` children,
// reject transcript-anchor siblings (and grandparent siblings).
function checkJsx(module: TsxModule, emit: Emit): void {
  const audioToParents = indexJsxAudioParents(module);
  for (const [audio, ancestry] of audioToParents.entries()) {
    if (hasTruthyJsxAttribute(audio, "controls")) continue;
    if (hasJsxTrackChild(audio)) continue;
    if (jsxAncestryHasTranscriptAnchor(ancestry, audio)) continue;
    emitViolation(audio.loc.start, getJsxAttributeString(audio, "src"), emit);
  }
}

function getJsxAttributeString(element: JsxElement, name: string): string | null {
  const attr = getJsxAttribute(element, name);
  if (attr === null) return null;
  const value = attr.value;
  if (value === null) return null;
  if (value.kind === "StringLiteral") return value.value;
  return null;
}

/**
 * Mirrors the truthy-attribute logic from `media/audio-video-no-controls`.
 * `controls`, `controls={true}`, `controls="controls"` all count as
 * truthy. `controls={false|null|undefined}` is falsy. Conservative:
 * any other expression value is treated as truthy (don't second-guess
 * the author).
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

function hasJsxTrackChild(audio: JsxElement): boolean {
  for (const child of audio.children) {
    if (child.kind === "JsxElement" && child.tagName === "track") return true;
  }
  return false;
}

interface JsxAncestry {
  readonly siblings: readonly JsxNode[];
  readonly parent: JsxElement | null;
  readonly grandparentSiblings: readonly JsxNode[];
}

function indexJsxAudioParents(module: TsxModule): Map<JsxElement, JsxAncestry> {
  const out = new Map<JsxElement, JsxAncestry>();
  // The TsxModule's `jsxElements` field is a flat list of every
  // top-level JSX element in the module — enough as a starting set
  // since we walk children to discover descendants. The first ring
  // (module-level siblings) is the same list for every audio at root.
  for (const root of module.jsxElements) {
    visit(
      root,
      module.jsxElements as readonly JsxNode[],
      null,
      module.jsxElements as readonly JsxNode[],
    );
  }
  return out;

  function visit(
    element: JsxElement,
    siblings: readonly JsxNode[],
    parent: JsxElement | null,
    grandparentSiblings: readonly JsxNode[],
  ): void {
    if (element.tagName === "audio") {
      out.set(element, { siblings, parent, grandparentSiblings });
    }
    for (const child of element.children) {
      if (child.kind !== "JsxElement") continue;
      visit(child, element.children, element, siblings);
    }
  }
}

function jsxAncestryHasTranscriptAnchor(ancestry: JsxAncestry, audio: JsxElement): boolean {
  if (jsxSiblingsHaveTranscriptAnchor(ancestry.siblings, audio, true)) return true;
  return jsxNodesContainDirectTranscriptAnchor(ancestry.grandparentSiblings, ancestry.parent);
}

function jsxSiblingsHaveTranscriptAnchor(
  nodes: readonly JsxNode[],
  audio: JsxElement,
  recurse: boolean,
): boolean {
  for (const node of nodes) {
    if (node === audio) continue;
    if (node.kind !== "JsxElement") continue;
    if (recurse) {
      if (containsJsxTranscriptAnchor(node)) return true;
    } else if (node.tagName === "a" && jsxAnchorIsTranscript(node)) {
      return true;
    }
  }
  return false;
}

function jsxNodesContainDirectTranscriptAnchor(
  nodes: readonly JsxNode[],
  exclude: JsxElement | null,
): boolean {
  for (const node of nodes) {
    if (node === exclude) continue;
    if (node.kind !== "JsxElement") continue;
    if (node.tagName === "a" && jsxAnchorIsTranscript(node)) return true;
  }
  return false;
}

function containsJsxTranscriptAnchor(element: JsxElement): boolean {
  if (element.tagName === "a" && jsxAnchorIsTranscript(element)) return true;
  for (const child of element.children) {
    if (child.kind === "JsxElement" && containsJsxTranscriptAnchor(child)) return true;
  }
  return false;
}

function jsxAnchorIsTranscript(anchor: JsxElement): boolean {
  const href = getJsxAttributeString(anchor, "href");
  const text = jsxTextContent(anchor);
  if (href !== null && looksLikeTranscriptHref(href)) return true;
  if (looksLikeTranscriptText(text)) return true;
  return false;
}

function emitViolation(
  loc: { line: number; column: number },
  src: string | null,
  emit: Emit,
): void {
  emit({
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: buildMessage(src),
    suggestion: buildSuggestion(src),
  });
}

function buildMessage(src: string | null): string {
  const subject = src === null ? "<audio> element" : `<audio src="${src}">`;
  return `${subject} has no \`controls\`, no \`<track>\`, and no neighboring transcript link — there is no text alternative for this non-text content (WCAG 1.1.1).`;
}

function buildSuggestion(src: string | null): string {
  const target = src === null ? "audio" : `audio at \`${src}\``;
  return `Provide a text alternative for the ${target}: add \`controls\` so the player surfaces a transcript-aware UI, embed a \`<track kind="captions" src="…">\` child for inline timed text, OR place a clearly-labeled transcript link next to the element (e.g. \`<a href="transcript.html">Read the transcript</a>\`). If the audio is purely decorative or supplemental and a text alternative already exists in the surrounding prose, suppress this finding at the source with \`<!-- ra11y-disable media/audio-controls-or-transcript-missing -->\` (HTML) / \`{/* ra11y-disable media/audio-controls-or-transcript-missing */}\` (JSX) once you have verified the in-prose alternative is equivalent.`;
}
