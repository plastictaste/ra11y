/**
 * Candidate finder: review/cross-file-click-handler-on-non-interactive
 * Criteria: wcag22:2.1.1, wcag21:2.1.1 (Keyboard, A)
 *           wcag22:4.1.2, wcag21:4.1.2 (Name, Role, Value, A)
 * Spec: https://www.w3.org/TR/WCAG22/#keyboard
 *       https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * Surfaces the dominant vanilla-JS keyboard-operability failure: a
 * standalone `.js`/`.ts` file attaches a click handler at runtime via
 * `el.addEventListener('click', …)` (or `el.onclick = …`) to a target
 * variable bound from `document.querySelector` / `getElementById` /
 * `getElementsByClassName`, AND the selector resolves *cross-file* to
 * a plain `<div>` / `<span>` / `<li>` / `<img>` (or other non-interactive
 * tag) in a sibling HTML document with no `role`, no `tabindex`, and no
 * `onkeydown`/`onkeyup`. Mouse users can click it; keyboard users can't
 * reach it, and assistive tech reads the element as static content
 * because no widget role is present (4.1.2). The resolved element is
 * the deterministic evidence the existing same-file rule
 * `keyboard/handler-missing` (which deliberately stays same-file per
 * its doctrine note) doesn't have.
 *
 * Where this finder fits relative to `keyboard/handler-missing`:
 *   - The rule fires `error`-severity at the JS attach site whenever a
 *     `addEventListener('click', …)` has no sibling keyboard listener
 *     in the same JS file and isn't bound from
 *     `document.createElement('button'|...)`. It does NOT cross into
 *     the HTML document — that is deliberately the agent's job in the
 *     general case (per the AI-first doctrine note in
 *     handler-missing-external-js.ts).
 *   - This finder adds a *higher-confidence review-candidate framing*
 *     for the deterministic subset: when the selector resolves to a
 *     non-interactive HTML element, the static evidence is concrete
 *     ("the receiver IS a <div>"), and the agent reading the candidate
 *     can confirm in one Read of the cited HTML line. The rule's
 *     emission is unchanged; this is additive.
 *
 * Doctrine alignment (`docs/kb/architecture/ai-first-consumer.md`):
 *   - Static-deterministic when the selector lands on exactly one
 *     non-interactive element with none of the keyboard-pathway
 *     attributes — emit `confidence: "high"`.
 *   - When the selector lands on multiple HTML elements with the same
 *     tag/attribute shape (e.g. a `.foo` class on three `<div>`s, none
 *     keyboard-wired), emit one candidate per HTML occurrence with the
 *     same confidence — the JS line is shared evidence, but each HTML
 *     site is a distinct keyboard-unreachable target. The agent reads
 *     and dismisses per occurrence.
 *   - When the selector cannot be statically resolved at all (no
 *     matching HTML element across the project, target was not bound
 *     from a `document.querySelector`-family call), emit nothing — the
 *     rule already covers the broader case at `error` severity, and
 *     surfacing a low-confidence duplicate would just inflate the
 *     review queue without adding evidence the rule didn't already
 *     present.
 *   - The `reason` text names the JS shape, the resolved HTML tag, and
 *     the sibling file the resolution targeted, so the agent can
 *     dismiss in one read when the HTML is actually a `<button>` the
 *     scanner missed (e.g. inside a server-rendered template the parser
 *     declined). No heuristic suppression — the agent is the arbiter.
 *
 * Cross-file scope: bounded to selectors resolved from
 * `document.querySelector('#id'|'.cls'|'tag')` / `.getElementById('id')`
 * / `.getElementsByClassName('cls')`. Multi-component selectors
 * (`.a > .b`), pseudo-class selectors (`:hover`, `:nth-child`), and
 * descendant combinators are deliberately not resolved — the static
 * predicate stays narrow so the high-confidence label is honest. The
 * rule's same-file emission still covers the broader case.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { getHtmlAttribute, hasHtmlAttribute, walkHtmlElements } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import type { ProjectFile, ReviewCandidate } from "../../types/review.ts";
import {
  collectJsIgnoredRanges,
  isOffsetInJsIgnoredRange,
  type JsIgnoredRange,
  regexHasExecutableMatch,
} from "../../utils/js-source-ranges.ts";

const CRITERION_IDS = ["wcag22:2.1.1", "wcag21:2.1.1", "wcag22:4.1.2", "wcag21:4.1.2"] as const;

/**
 * HTML tags that are natively interactive — these never trigger the
 * finder even if the JS attaches a click. Mirrors the host rule's set
 * (a/button/input/select/textarea/summary). Comparison is
 * case-insensitive; tag names in HTML are ASCII-case-insensitive.
 */
const NATIVELY_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);

/** Matches `target.addEventListener('click', …)` and captures the target identifier. */
const ADD_EVENT_LISTENER_CLICK =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*addEventListener\s*\(\s*["'`]click["'`]\s*,/g;

/**
 * Matches `<IDENT>.onclick = …` assignments. Excludes JSX-attribute
 * shape `onClick={…}` (no leading dot) and equality comparisons via
 * the `=` negative lookahead.
 */
const ONCLICK_ASSIGNMENT = /\b([A-Za-z_$][\w$]*)\s*\.\s*onclick\s*=(?!=)/g;

interface SelectorResolution {
  readonly kind: "id" | "class" | "tag";
  readonly value: string;
  /** The verbatim shape used in the JS — for reason text. */
  readonly callShape: string;
}

interface ClickAttachSite {
  readonly filePath: string;
  readonly source: string;
  readonly target: string;
  readonly offset: number;
  readonly shape: "addEventListener" | "onclick";
}

interface HtmlMatch {
  readonly filePath: string;
  readonly element: HtmlElement;
}

export const finder = defineCandidateFinder({
  id: "review/cross-file-click-handler-on-non-interactive",
  criterionIds: [...CRITERION_IDS],
  scope: "document",
  appliesTo: { fileExtensions: [".html", ".htm", ".ts", ".js", ".tsx", ".jsx"] },
  docs: {
    description:
      "Surfaces JS files that attach a runtime click handler (addEventListener('click',…) or .onclick=…) to a target whose selector resolves cross-file to a non-interactive HTML element (<div>, <span>, <li>, <img>) with no role, tabindex, or onkeydown/onkeyup — the dominant keyboard-operability failure in vanilla-JS codebases.",
    reviewPrompt:
      'Verify the resolved HTML element is reachable and activatable by keyboard users. Two fixes: (a) change the HTML element to a native interactive control (`<button type="button">` for actions, `<a href>` for navigation) — buttons fire click on Enter/Space and are focusable by default, no JS change needed; or (b) keep the element and add `tabindex="0"` plus a sibling `keydown`/`keyup` listener handling Enter and Space that invokes the same handler. Confirm the resolved element is the only one matching the selector — the candidate names the matched file/line so you can read once and dismiss when the JS targets a different occurrence than the scanner resolved.',
    references: [
      "https://www.w3.org/TR/WCAG22/#keyboard",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G202",
    ],
  },
  afterProject(ctx) {
    const htmlFiles = ctx.files.filter((f) => f.ast.language === "html");
    if (htmlFiles.length === 0) return [];
    const out: ReviewCandidate[] = [];
    for (const file of ctx.files) {
      if (!isJsLikeFile(file)) continue;
      collectCandidatesForJsFile(file, htmlFiles, out);
    }
    return out;
  },
});

function isJsLikeFile(file: ProjectFile): boolean {
  // Scanner tags TSX/JSX/TS/JS files via language; other values
  // (html/css) drop straight out.
  const lang = file.ast.language;
  return lang === "tsx" || lang === "jsx" || lang === "ts" || lang === "js";
}

function collectCandidatesForJsFile(
  jsFile: ProjectFile,
  htmlFiles: readonly ProjectFile[],
  out: ReviewCandidate[],
): void {
  const ignoredRanges = collectJsIgnoredRanges(jsFile.source);
  const sites = collectClickAttachments(jsFile, ignoredRanges);
  for (const site of sites) {
    if (hasSiblingKeyboardListener(site.source, site.target, ignoredRanges)) continue;
    if (
      wasBoundFromNativeInteractiveCreateElement(
        site.source,
        site.target,
        site.offset,
        ignoredRanges,
      )
    ) {
      continue;
    }
    const resolution = resolveSelectorForVariable(
      site.source,
      site.target,
      site.offset,
      ignoredRanges,
    );
    if (resolution === null) continue;
    const matches = findHtmlMatches(htmlFiles, resolution);
    if (matches.length === 0) continue;
    for (const match of matches) {
      if (!isCandidateMatch(match.element)) continue;
      pushCandidate(site, resolution, match, out);
    }
  }
}

/**
 * Scans the JS source for click attachments. Skips global delegators
 * (`window`/`document`/`globalThis`) — those are application-wide
 * shortcuts handled by SC 2.1.4 and would never resolve via
 * `document.querySelector` to a single element anyway.
 */
function collectClickAttachments(
  jsFile: ProjectFile,
  ignoredRanges: readonly JsIgnoredRange[],
): readonly ClickAttachSite[] {
  const out: ClickAttachSite[] = [];
  const source = jsFile.source;
  ADD_EVENT_LISTENER_CLICK.lastIndex = 0;
  let m = ADD_EVENT_LISTENER_CLICK.exec(source);
  while (m !== null) {
    const target = m[1];
    if (
      target !== undefined &&
      !isLikelyGlobalWindow(target) &&
      !isOffsetInJsIgnoredRange(ignoredRanges, m.index)
    ) {
      out.push({
        filePath: jsFile.filePath,
        source,
        target,
        offset: m.index,
        shape: "addEventListener",
      });
    }
    m = ADD_EVENT_LISTENER_CLICK.exec(source);
  }
  ONCLICK_ASSIGNMENT.lastIndex = 0;
  let n = ONCLICK_ASSIGNMENT.exec(source);
  while (n !== null) {
    const target = n[1];
    if (
      target !== undefined &&
      !isLikelyGlobalWindow(target) &&
      !isOffsetInJsIgnoredRange(ignoredRanges, n.index)
    ) {
      out.push({
        filePath: jsFile.filePath,
        source,
        target,
        offset: n.index,
        shape: "onclick",
      });
    }
    n = ONCLICK_ASSIGNMENT.exec(source);
  }
  return out;
}

function isLikelyGlobalWindow(target: string): boolean {
  return target === "window" || target === "document" || target === "globalThis";
}

function hasSiblingKeyboardListener(
  source: string,
  target: string,
  ignoredRanges: readonly JsIgnoredRange[],
): boolean {
  const escaped = escapeForRegex(target);
  const listenerPattern = new RegExp(
    `\\b${escaped}\\s*\\.\\s*addEventListener\\s*\\(\\s*["'\`](?:keydown|keyup|keypress)["'\`]`,
    "g",
  );
  if (regexHasExecutableMatch(listenerPattern, source, ignoredRanges)) return true;
  const assignPattern = new RegExp(
    `\\b${escaped}\\s*\\.\\s*(?:onkeydown|onkeyup|onkeypress)\\s*=(?!=)`,
    "g",
  );
  return regexHasExecutableMatch(assignPattern, source, ignoredRanges);
}

/**
 * Same-file `document.createElement('button'|'a'|...)` suppression —
 * mirrors the rule's gate. When the JS authored the receiver as a
 * native interactive element, the selector resolution is moot.
 */
const NATIVE_INTERACTIVE_CREATE_ELEMENT_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);

function wasBoundFromNativeInteractiveCreateElement(
  source: string,
  target: string,
  beforeOffset: number,
  ignoredRanges: readonly JsIgnoredRange[],
): boolean {
  const escaped = escapeForRegex(target);
  const declPattern = new RegExp(
    `(?:const|let|var)\\s+${escaped}\\s*=\\s*document\\s*\\.\\s*createElement` +
      `\\s*\\(\\s*["'\`]([^"'\`]*)["'\`]`,
    "g",
  );
  let match = declPattern.exec(source);
  while (match !== null) {
    if (match.index >= beforeOffset) break;
    if (isOffsetInJsIgnoredRange(ignoredRanges, match.index)) {
      match = declPattern.exec(source);
      continue;
    }
    const tag = match[1];
    if (tag !== undefined && NATIVE_INTERACTIVE_CREATE_ELEMENT_TAGS.has(tag.toLowerCase())) {
      return true;
    }
    match = declPattern.exec(source);
  }
  return false;
}

/**
 * Walks backward from the click-attach site to the nearest declarator
 * binding `target` from `document.querySelector('…')` /
 * `.getElementById('…')` / `.getElementsByClassName('…')`. Returns the
 * resolved selector kind and value, or null when no narrow declarator
 * is in scope.
 *
 * Only single-token CSS selectors are supported here:
 *   - `#id` → kind: "id"
 *   - `.cls` → kind: "class"
 *   - `tag` → kind: "tag"
 *
 * Multi-token selectors (`.a > .b`, `div.foo[data-x]`, pseudo-class
 * selectors) are deliberately not parsed — the static predicate stays
 * narrow so the resulting confidence label is honest. The rule's
 * same-file emission still covers those cases at error severity.
 */
function resolveSelectorForVariable(
  source: string,
  target: string,
  beforeOffset: number,
  ignoredRanges: readonly JsIgnoredRange[],
): SelectorResolution | null {
  const escaped = escapeForRegex(target);
  const declPattern = new RegExp(
    `(?:const|let|var)\\s+${escaped}\\s*=\\s*document\\s*\\.\\s*` +
      `(querySelector|getElementById|getElementsByClassName|getElementsByTagName)` +
      `\\s*\\(\\s*["'\`]([^"'\`]*)["'\`]`,
    "g",
  );
  let best: SelectorResolution | null = null;
  let m = declPattern.exec(source);
  while (m !== null) {
    if (m.index >= beforeOffset) break;
    if (isOffsetInJsIgnoredRange(ignoredRanges, m.index)) {
      m = declPattern.exec(source);
      continue;
    }
    const method = m[1];
    const argument = m[2];
    if (method === undefined || argument === undefined) {
      m = declPattern.exec(source);
      continue;
    }
    const resolved = parseSelectorForMethod(method, argument);
    if (resolved !== null) {
      best = resolved;
    }
    m = declPattern.exec(source);
  }
  return best;
}

function parseSelectorForMethod(method: string, argument: string): SelectorResolution | null {
  const trimmed = argument.trim();
  if (trimmed.length === 0) return null;
  const callShape = `document.${method}('${trimmed}')`;
  if (method === "getElementById") {
    return { kind: "id", value: trimmed, callShape };
  }
  if (method === "getElementsByClassName") {
    // Spec: space-separated list of class names. Resolve only the
    // single-token form so the cross-file match stays unambiguous; the
    // multi-class form falls through to the rule's broader same-file
    // emission.
    if (/\s/.test(trimmed)) return null;
    return { kind: "class", value: trimmed, callShape };
  }
  if (method === "getElementsByTagName") {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(trimmed)) return null;
    return { kind: "tag", value: trimmed.toLowerCase(), callShape };
  }
  // querySelector — accept the three single-token CSS shapes.
  if (/^#[A-Za-z_][\w-]*$/.test(trimmed)) {
    return { kind: "id", value: trimmed.slice(1), callShape };
  }
  if (/^\.[A-Za-z_][\w-]*$/.test(trimmed)) {
    return { kind: "class", value: trimmed.slice(1), callShape };
  }
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(trimmed)) {
    return { kind: "tag", value: trimmed.toLowerCase(), callShape };
  }
  return null;
}

/**
 * Walks every HTML file looking for elements that match `resolution`.
 * For id and tag selectors, returns every matching element across all
 * files (id is supposed to be unique but authors break that often
 * enough that the agent should see all occurrences); for class
 * selectors, returns every element carrying the class token.
 */
function findHtmlMatches(
  htmlFiles: readonly ProjectFile[],
  resolution: SelectorResolution,
): readonly HtmlMatch[] {
  const out: HtmlMatch[] = [];
  for (const file of htmlFiles) {
    const root = file.ast.root as HtmlDocument;
    for (const el of walkHtmlElements(root)) {
      if (matchesSelector(el, resolution)) {
        out.push({ filePath: file.filePath, element: el });
      }
    }
  }
  return out;
}

function matchesSelector(el: HtmlElement, resolution: SelectorResolution): boolean {
  if (resolution.kind === "id") {
    return getHtmlAttribute(el, "id") === resolution.value;
  }
  if (resolution.kind === "tag") {
    return el.tagName.toLowerCase() === resolution.value;
  }
  // class — split the class attribute on whitespace and check token
  // membership. HTML class tokens are space-separated.
  const classAttr = getHtmlAttribute(el, "class");
  if (classAttr === null) return false;
  for (const token of classAttr.split(/\s+/)) {
    if (token === resolution.value) return true;
  }
  return false;
}

/**
 * Returns true when the resolved HTML element is the deterministic
 * non-interactive shape this finder targets: not a native interactive
 * tag, no `role`, no `tabindex`, no inline `onkeydown`/`onkeyup`. Any
 * one of these signals means the author has done *something* about
 * keyboard operability — in which case the agent's read of the file
 * is the better arbiter than a static guess about whether the
 * something was sufficient. (The host rule's HTML walk takes the same
 * stance.)
 */
function isCandidateMatch(el: HtmlElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (NATIVELY_INTERACTIVE_TAGS.has(tag)) return false;
  if (hasHtmlAttribute(el, "role")) return false;
  if (hasHtmlAttribute(el, "tabindex")) return false;
  if (hasHtmlAttribute(el, "onkeydown") || hasHtmlAttribute(el, "onkeyup")) return false;
  return true;
}

function pushCandidate(
  site: ClickAttachSite,
  resolution: SelectorResolution,
  match: HtmlMatch,
  out: ReviewCandidate[],
): void {
  const pos = positionAtOffset(site.source, site.offset);
  const tag = match.element.tagName.toLowerCase();
  const shapeLabel =
    site.shape === "addEventListener"
      ? `${site.target}.addEventListener('click', …)`
      : `${site.target}.onclick = …`;
  const reason =
    `${shapeLabel} attaches a click handler to a target resolved from ` +
    `\`${resolution.callShape}\` — the selector matches a <${tag}> at ` +
    `${match.filePath}:${match.element.loc.start.line} with no role, no tabindex, ` +
    "and no keyboard handler. Verify whether keyboard users can reach and " +
    "activate this element; the simplest fix is usually to change the " +
    `<${tag}> to <button type="button"> or <a href> in the HTML.`;
  for (const criterionId of CRITERION_IDS) {
    out.push({
      criterionId,
      // The candidate is anchored at the JS attach site — that is the
      // line the agent would edit if the fix is "add a sibling keydown
      // listener," and the resolved HTML site is named in the reason
      // text so the agent can navigate there in one read for the
      // alternative "change the tag" fix. Locating at the JS line also
      // matches where the host rule's `error` emission lives, so an
      // agent reading the two surfaces in parallel sees the same
      // line.
      location: { filePath: site.filePath, line: pos.line, column: pos.column },
      reason,
      // The resolution is deterministic when we got here: same-token
      // selector, exactly one (or more) matching HTML elements, none
      // are natively interactive and none carry `role`/`tabindex`/
      // keyboard-handler attributes. The agent's verification step is
      // a single Read at the cited HTML line — high confidence is the
      // honest label.
      confidence: "high",
    });
  }
}

function escapeForRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface JsPosition {
  readonly line: number;
  readonly column: number;
}

function positionAtOffset(source: string, offset: number): JsPosition {
  let line = 1;
  let column = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
