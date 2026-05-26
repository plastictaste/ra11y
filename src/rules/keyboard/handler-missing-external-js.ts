/**
 * External-JS handler grammar for `keyboard/handler-missing`.
 *
 * Satisfies (via host rule): wcag22:2.1.1, wcag21:2.1.1,
 *                            wcag22:4.1.2, wcag21:4.1.2
 * Spec:
 *   - https://www.w3.org/TR/WCAG22/#keyboard
 *   - https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * Vanilla-JS apps attach click handlers in a standalone `.js`/`.ts` file
 * via `el.addEventListener('click', fn)` or `el.onclick = fn` after
 * grabbing the element with `document.querySelector` /
 * `document.getElementById` / `document.getElementsByClassName`. When
 * the same variable isn't also wired up to a keyboard event
 * (`keydown` / `keyup` / `keypress`, or an `.onkeydown` / `.onkeyup`
 * assignment) anywhere in the same source file, the target is
 * keyboard-unreachable for the same reason — the SC 2.1.1 failure this
 * rule targets.
 *
 * Implementation note: the v0.0.x TSX parser only exposes JSX elements,
 * not arbitrary JS expression bodies, so this branch scans `source`
 * directly. The detector is deliberately same-file: cross-file
 * identifier resolution is strictly the agent's job (see the doctrine
 * at docs/kb/architecture/ai-first-consumer.md — "The tool's job is to
 * point — file, line, pattern; the agent's job is to investigate").
 *
 * Two same-file backward-resolution paths are in scope, both keyed off
 * the click-attach target's `document.createElement(...)` declarator:
 *
 *   - **Native-interactive suppression**: when the bound tag is one of
 *     `button` / `a` / `input` / `select` / `textarea` / `summary`, the
 *     receiver IS a native interactive element (focusable and
 *     Enter/Space-activatable by construction) — no finding.
 *
 *   - **Non-interactive evidence promotion** (Q9 dynamic-creation
 *     extension): when the bound tag is a non-interactive element such
 *     as `div` / `span` / `li` / `section`, the receiver's kind is
 *     provable from the same file with no cross-file lookup. The rule
 *     still emits, but the host short-circuits the cross-file
 *     downgrade — `severity: "error"` and `confidence: "high"` (no
 *     stamp) become honest because no HTML resolution is needed. This
 *     surfaces the dynamic-creation case (e.g. `insect = createElement
 *     ('div'); insect.addEventListener('click', ...)`) at the same
 *     attention budget as a static `<div onClick>`. Satisfies SC 4.1.2
 *     too: a `<div>` created at runtime with a click handler and no
 *     `role`/`tabindex` is unreachable for keyboard users (2.1.1) AND
 *     has no programmatically determinable role (4.1.2).
 *
 * Extracted into its own file so the host rule stays under the
 * scripts/check-limits.ts file budget.
 */

import {
  collectJsIgnoredRanges,
  isOffsetInJsIgnoredRange,
  type JsIgnoredRange,
  regexHasExecutableMatch,
} from "../../utils/js-source-ranges.ts";

export interface JsFinding {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly suggestion: string;
  /**
   * When the click-attach target was bound from `document.createElement
   * ('<non-interactive-tag>')` in the same file, this carries the bound
   * tag verbatim (lowercased). The host rule uses its presence to
   * short-circuit the unconditional cross-file confidence/severity
   * downgrade: the receiver's kind is provable from this file alone, so
   * the per-finding label can honestly stay at `severity: "error"` /
   * `confidence: "high"` — no HTML grep is needed.
   *
   * Absent (`undefined`) for findings whose target wasn't bound by an
   * in-file `createElement` declarator (function parameters, imported
   * refs, querySelector returns, …) — those keep the cross-file
   * downgrade because the receiver's kind genuinely cannot be confirmed
   * without the HTML.
   */
  readonly inFileResolvedTag?: string;
}

/** Matches `target.addEventListener('click', …)` and captures the target identifier. */
const ADD_EVENT_LISTENER_CLICK =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*addEventListener\s*\(\s*["'`]click["'`]\s*,/g;

/**
 * Matches `<IDENT>.onclick = …` assignments. Excludes JSX-attribute
 * shape `onClick={…}` (no leading dot) and property-access reads
 * (`const fn = el.onclick`). The `=` must be a real assignment (not
 * `==` or `===`), so the negative lookahead handles the
 * equality-comparison case.
 */
const ONCLICK_ASSIGNMENT = /\b([A-Za-z_$][\w$]*)\s*\.\s*onclick\s*=(?!=)/g;

/**
 * Native interactive tag names accepted by `document.createElement`
 * that produce focusable, keyboard-activatable elements without any
 * additional wiring: `a`, `button`, `input`, `select`, `textarea`,
 * `summary`. Mirrors the host rule's HTML-walk natively-interactive
 * set; kept here as a private constant to avoid coupling the
 * external-JS grammar to the JSX/HTML walks.
 *
 * Comparison is case-insensitive: `createElement('BUTTON')` and
 * `createElement('Button')` both produce the same element type per
 * the HTML spec (tag names are ASCII-case-insensitive).
 */
const NATIVE_INTERACTIVE_CREATE_ELEMENT_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);

/**
 * Returns external-JS click-without-keyboard findings for a source file.
 *
 * Exported for unit-test visibility — production rule calls via `afterFile`.
 */
export function findExternalJsHandlerMissing(source: string): readonly JsFinding[] {
  const out: JsFinding[] = [];
  const ignoredRanges = collectJsIgnoredRanges(source);
  for (const site of collectClickAttachments(source, ignoredRanges)) {
    if (hasSiblingKeyboardListener(source, site.target, ignoredRanges)) continue;
    // Same-file backward resolution: when the target variable was bound
    // from `document.createElement('button'|'a'|'input'|...)`, the
    // receiver IS a native interactive element — buttons/anchors/inputs
    // are focusable and Enter/Space activate them natively, so the
    // missing keyboard sibling is not a finding. The lookup is bounded
    // to declarators preceding the click-attach site in the same file;
    // cross-file resolution stays off-table per the doctrine note above.
    const createdTag = findCreateElementBoundTag(source, site.target, site.offset, ignoredRanges);
    if (createdTag !== null && NATIVE_INTERACTIVE_CREATE_ELEMENT_TAGS.has(createdTag)) continue;
    const selector = resolveSelectorForVariable(source, site.target, site.offset, ignoredRanges);
    // Q9 dynamic-creation extension: when the bound tag is a
    // non-interactive native element (`div`, `span`, `li`, `section`,
    // …), the receiver's kind is provable from this file with no
    // cross-file lookup. Thread the tag onto the finding so the host
    // rule can short-circuit the cross-file downgrade. Native-
    // interactive tags were already filtered above; a non-null
    // `createdTag` here is by construction non-interactive.
    out.push(buildFinding(site, selector, source, createdTag));
  }
  return out;
}

interface ClickSite {
  readonly target: string;
  readonly offset: number;
  readonly shape: "addEventListener" | "onclick";
}

function collectClickAttachments(
  source: string,
  ignoredRanges: readonly JsIgnoredRange[],
): readonly ClickSite[] {
  const sites: ClickSite[] = [];
  ADD_EVENT_LISTENER_CLICK.lastIndex = 0;
  let m = ADD_EVENT_LISTENER_CLICK.exec(source);
  while (m !== null) {
    const target = m[1];
    if (
      target !== undefined &&
      !isLikelyGlobalWindow(target) &&
      !isOffsetInJsIgnoredRange(ignoredRanges, m.index)
    ) {
      sites.push({ target, offset: m.index, shape: "addEventListener" });
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
      sites.push({ target, offset: n.index, shape: "onclick" });
    }
    n = ONCLICK_ASSIGNMENT.exec(source);
  }
  return sites;
}

/**
 * `window.addEventListener('click', …)` / `document.onclick = …` are
 * global delegators, not per-element handlers — the SC 2.1.4 /
 * `keyboard/character-shortcuts` rule covers global keyboard shortcut
 * concerns on window/document. Skip them here to avoid duplicate
 * findings with a different framing.
 */
function isLikelyGlobalWindow(target: string): boolean {
  return target === "window" || target === "document" || target === "globalThis";
}

/**
 * Returns true when the same variable is wired to any of
 * `keydown` / `keyup` / `keypress` via `addEventListener`, OR has a
 * `.onkeydown` / `.onkeyup` / `.onkeypress` assignment anywhere in
 * the file. The file-scope search is correct because vanilla JS
 * authors typically attach all handlers on a selected element in the
 * same initialization block.
 */
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
 * Walks backward from the click-attach site to the nearest
 * `const/let/var <target> = document.(querySelector|getElementById|
 * getElementsByClassName|getElementsByTagName)('…')` declarator and
 * returns its argument verbatim. Returns null when no declarator can
 * be located in the file — the cite stays honest ("the target
 * variable is …") rather than inventing a selector.
 *
 * Cross-file resolution is deliberately out of scope: the agent
 * reading the file can grep the selector faster than an in-process
 * resolver could, and a silent wrong cross-file guess is worse than
 * pointing honestly. See the doctrine note at the top of this file.
 */
function resolveSelectorForVariable(
  source: string,
  target: string,
  beforeOffset: number,
  ignoredRanges: readonly JsIgnoredRange[],
): { readonly method: string; readonly argument: string } | null {
  const escaped = escapeForRegex(target);
  // Examples matched:
  //   const btn = document.querySelector('#save')
  //   let btn = document.getElementById("save")
  //   var btn = document . querySelector ( `#save` )
  const declPattern = new RegExp(
    `(?:const|let|var)\\s+${escaped}\\s*=\\s*document\\s*\\.\\s*` +
      `(querySelector|getElementById|getElementsByClassName|getElementsByTagName)` +
      `\\s*\\(\\s*["'\`]([^"'\`]*)["'\`]`,
    "g",
  );
  let best: { method: string; argument: string } | null = null;
  let m = declPattern.exec(source);
  while (m !== null) {
    if (m.index >= beforeOffset) break;
    if (isOffsetInJsIgnoredRange(ignoredRanges, m.index)) {
      m = declPattern.exec(source);
      continue;
    }
    const method = m[1];
    const argument = m[2];
    if (method !== undefined && argument !== undefined) {
      best = { method, argument };
    }
    m = declPattern.exec(source);
  }
  return best;
}

/**
 * Returns the tag name (lowercased) the target variable was bound to via
 * `document.createElement('<tag>')` in a `const`/`let`/`var` declarator
 * preceding the click-attach site, or `null` when no such declarator is
 * present in the file before the site.
 *
 * Same-file scope only. Cross-file resolution (the variable comes in
 * as a function parameter or import) stays off-table — the agent
 * reading the file can grep the binding faster than an in-process
 * resolver could, and a silent wrong cross-file guess is worse than
 * pointing honestly. See the doctrine note at the top of this file.
 *
 * Two callers consume the result:
 *   - native-interactive suppression: when the tag is in
 *     {@link NATIVE_INTERACTIVE_CREATE_ELEMENT_TAGS}, no finding fires
 *     (button/a/input/select/textarea/summary are focusable +
 *     Enter/Space-activatable by construction).
 *   - non-interactive evidence promotion: when the tag is anything
 *     else (`div` / `span` / `li` / `section` / …), the host rule
 *     uses the bound tag to keep the per-finding `severity: "error"`
 *     and `confidence: "high"` honest — the receiver's kind is
 *     provable from the same file, no HTML grep needed.
 */
function findCreateElementBoundTag(
  source: string,
  target: string,
  beforeOffset: number,
  ignoredRanges: readonly JsIgnoredRange[],
): string | null {
  const escaped = escapeForRegex(target);
  // Examples matched:
  //   const btn = document.createElement('button')
  //   let a = document.createElement("a")
  //   var input = document . createElement ( `input` )
  const declPattern = new RegExp(
    `(?:const|let|var)\\s+${escaped}\\s*=\\s*document\\s*\\.\\s*createElement` +
      `\\s*\\(\\s*["'\`]([^"'\`]*)["'\`]`,
    "g",
  );
  let best: string | null = null;
  let match = declPattern.exec(source);
  while (match !== null) {
    if (match.index >= beforeOffset) break;
    if (isOffsetInJsIgnoredRange(ignoredRanges, match.index)) {
      match = declPattern.exec(source);
      continue;
    }
    const tag = match[1];
    if (tag !== undefined) {
      best = tag.toLowerCase();
    }
    match = declPattern.exec(source);
  }
  return best;
}

function escapeForRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the parenthesized "evidence" clause threaded into the finding's
 * message. CreateElement evidence wins when present (highest-strength
 * in-file proof of the receiver's kind); the selector resolution is the
 * fallback for cross-file-bounded cases; otherwise no clause.
 */
function buildEvidenceClause(
  selector: { readonly method: string; readonly argument: string } | null,
  createdTag: string | null,
): string {
  if (createdTag !== null) {
    return ` (target was created via \`document.createElement('${createdTag}')\` in this file — a non-interactive element with no role/tabindex)`;
  }
  if (selector !== null) {
    return ` (resolved from \`document.${selector.method}('${selector.argument}')\`)`;
  }
  return "";
}

function buildFinding(
  site: ClickSite,
  selector: { readonly method: string; readonly argument: string } | null,
  source: string,
  createdTag: string | null,
): JsFinding {
  const pos = positionAtOffset(source, site.offset);
  const shapeLabel =
    site.shape === "addEventListener"
      ? `${site.target}.addEventListener('click', …)`
      : `${site.target}.onclick = …`;
  // When the target was bound from `document.createElement('<tag>')` in
  // this file, that's the highest-strength evidence the message can
  // carry — the agent doesn't need to grep the HTML to find out what
  // the receiver is. Drop the selector clause in that case so the
  // message reads cleanly with the createElement clause.
  const evidenceClause = buildEvidenceClause(selector, createdTag);
  const message = `Click handler attached via ${shapeLabel}${evidenceClause} with no sibling keyboard listener on \`${site.target}\` in this file — keyboard users can't activate the target.`;
  const suggestion = buildExternalJsSuggestion(site, selector, createdTag);
  return {
    line: pos.line,
    column: pos.column,
    message,
    suggestion,
    ...(createdTag === null ? {} : { inFileResolvedTag: createdTag }),
  };
}

function buildExternalJsSuggestion(
  site: ClickSite,
  selector: { readonly method: string; readonly argument: string } | null,
  createdTag: string | null,
): string {
  const target = site.target;
  // CreateElement-confirmed branch: the receiver's kind is in-file
  // evidence. Drop the "Cross-file check: grep" hedge — there's nothing
  // to grep for. Steer the agent toward the correct create-shape
  // (`document.createElement('button')`) which fixes both the keyboard
  // failure (2.1.1) and the missing-role failure (4.1.2) at once.
  if (createdTag !== null) {
    return (
      `The receiver is a \`<${createdTag}>\` created at runtime — keyboard users can't reach or activate it. ` +
      `The simplest fix is to construct a \`<button>\` instead: change \`document.createElement('${createdTag}')\` to \`document.createElement('button')\` and set \`type = 'button'\` (and any class names you needed for styling on the result). ` +
      `If the visual must stay a \`<${createdTag}>\`, set \`role = 'button'\`, \`tabIndex = 0\`, an accessible name (\`textContent\` or \`aria-label\`), AND attach a sibling keyboard listener — ` +
      `\`${target}.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); /* invoke the click handler */ } });\` — so Enter and Space activate the same handler.`
    );
  }
  const targetHint = selector
    ? `the element returned by \`document.${selector.method}('${selector.argument}')\``
    : `\`${target}\``;
  return (
    `Attach a keyboard handler on the same target so Enter and Space activate it — ` +
    `e.g. \`${target}.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); /* invoke the click handler */ } });\`. ` +
    `Better: if ${targetHint} is a \`<div>\` / \`<span>\`, change the HTML to \`<button type="button">\` — buttons are natively focusable and fire click on Enter/Space, no JS needed. ` +
    `Cross-file check: grep the selector in your HTML to confirm the target isn't already a \`<button>\` or \`<a href>\`.`
  );
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
