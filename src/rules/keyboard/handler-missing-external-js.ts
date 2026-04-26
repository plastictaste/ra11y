/**
 * External-JS handler grammar for `keyboard/handler-missing`.
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
 * One same-file suppression IS in scope: when the click-attach target
 * was bound from `document.createElement('button'|'a'|'input'|'select'
 * |'textarea'|'summary')`, the receiver IS a native interactive
 * element — focusable and Enter/Space-activatable by construction —
 * and the missing keyboard sibling is not a finding. The createElement
 * tag is provable from the code in the same file, so the suppression
 * is deterministic, not heuristic.
 *
 * Extracted into its own file so the host rule stays under the
 * scripts/check-limits.ts file budget.
 */

export interface JsFinding {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly suggestion: string;
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
  for (const site of collectClickAttachments(source)) {
    if (hasSiblingKeyboardListener(source, site.target)) continue;
    // Same-file backward resolution: when the target variable was bound
    // from `document.createElement('button'|'a'|'input'|...)`, the
    // receiver IS a native interactive element — buttons/anchors/inputs
    // are focusable and Enter/Space activate them natively, so the
    // missing keyboard sibling is not a finding. The lookup is bounded
    // to declarators preceding the click-attach site in the same file;
    // cross-file resolution stays off-table per the doctrine note above.
    if (wasBoundFromNativeInteractiveCreateElement(source, site.target, site.offset)) continue;
    const selector = resolveSelectorForVariable(source, site.target, site.offset);
    out.push(buildFinding(site, selector, source));
  }
  return out;
}

interface ClickSite {
  readonly target: string;
  readonly offset: number;
  readonly shape: "addEventListener" | "onclick";
}

function collectClickAttachments(source: string): readonly ClickSite[] {
  const sites: ClickSite[] = [];
  ADD_EVENT_LISTENER_CLICK.lastIndex = 0;
  let m = ADD_EVENT_LISTENER_CLICK.exec(source);
  while (m !== null) {
    const target = m[1];
    if (target !== undefined && !isLikelyGlobalWindow(target)) {
      sites.push({ target, offset: m.index, shape: "addEventListener" });
    }
    m = ADD_EVENT_LISTENER_CLICK.exec(source);
  }
  ONCLICK_ASSIGNMENT.lastIndex = 0;
  let n = ONCLICK_ASSIGNMENT.exec(source);
  while (n !== null) {
    const target = n[1];
    if (target !== undefined && !isLikelyGlobalWindow(target)) {
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
function hasSiblingKeyboardListener(source: string, target: string): boolean {
  const escaped = escapeForRegex(target);
  const listenerPattern = new RegExp(
    `\\b${escaped}\\s*\\.\\s*addEventListener\\s*\\(\\s*["'\`](?:keydown|keyup|keypress)["'\`]`,
  );
  if (listenerPattern.test(source)) return true;
  const assignPattern = new RegExp(
    `\\b${escaped}\\s*\\.\\s*(?:onkeydown|onkeyup|onkeypress)\\s*=(?!=)`,
  );
  return assignPattern.test(source);
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
 * Returns true when the target variable was bound from
 * `document.createElement('<native-interactive>')` in a `const`/`let`/
 * `var` declarator preceding the click-attach site.
 *
 * Same-file scope only. Cross-file resolution (the variable comes in
 * as a function parameter or import) stays off-table — the agent
 * reading the file can grep the binding faster than an in-process
 * resolver could, and a silent wrong cross-file guess is worse than
 * pointing honestly. See the doctrine note at the top of this file.
 */
function wasBoundFromNativeInteractiveCreateElement(
  source: string,
  target: string,
  beforeOffset: number,
): boolean {
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
  let match = declPattern.exec(source);
  while (match !== null) {
    if (match.index >= beforeOffset) break;
    const tag = match[1];
    if (tag !== undefined && NATIVE_INTERACTIVE_CREATE_ELEMENT_TAGS.has(tag.toLowerCase())) {
      return true;
    }
    match = declPattern.exec(source);
  }
  return false;
}

function escapeForRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFinding(
  site: ClickSite,
  selector: { readonly method: string; readonly argument: string } | null,
  source: string,
): JsFinding {
  const pos = positionAtOffset(source, site.offset);
  const shapeLabel =
    site.shape === "addEventListener"
      ? `${site.target}.addEventListener('click', …)`
      : `${site.target}.onclick = …`;
  const selectorClause = selector
    ? ` (resolved from \`document.${selector.method}('${selector.argument}')\`)`
    : "";
  const message = `Click handler attached via ${shapeLabel}${selectorClause} with no sibling keyboard listener on \`${site.target}\` in this file — keyboard users can't activate the target.`;
  const suggestion = buildExternalJsSuggestion(site, selector);
  return { line: pos.line, column: pos.column, message, suggestion };
}

function buildExternalJsSuggestion(
  site: ClickSite,
  selector: { readonly method: string; readonly argument: string } | null,
): string {
  const target = site.target;
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
