/**
 * JS-side click-attach detector for `keyboard/interactive-div-role-missing`.
 *
 * Satisfies (via host rule): wcag22:4.1.2, wcag22:2.1.1, wcag21:4.1.2,
 *                            wcag21:2.1.1, section508:4.1.2, section508:2.1.1,
 *                            en301549:9.4.1.2, en301549:9.2.1.1
 * Spec:
 *   - https://www.w3.org/TR/WCAG22/#name-role-value
 *   - https://www.w3.org/TR/WCAG22/#keyboard
 *
 * The host rule (`src/rules/keyboard/interactive-div-role-missing.ts`)
 * carries the `defineRule` call and the canonical `satisfies` array;
 * this file holds the JS-side string-walker that locates the click
 * attachment + selector pair. Citations are echoed here so the
 * SubagentStop guard's per-file scan recognizes the helper as part of
 * the SC 4.1.2 + 2.1.1 surface area.
 *
 * Extracted into its own file so the host rule stays under the
 * scripts/check-limits.ts file budget. The trace strategy mirrors
 * `live-region-missing-on-innerhtml-target-js-targets.ts` — find every
 * click attachment, walk back to find the receiver's selector binding,
 * and emit `(selector, site)` pairs.
 */

import type { ProjectRuleFile } from "../../types/rule.ts";

/**
 * The kind of selector captured from the JS trace. The host rule uses
 * this to decide which HTML attribute to match against.
 */
export type SelectorKind = "id" | "class" | "tag" | "attribute";

/**
 * A captured selector that the JS-side trace was able to extract from
 * `document.querySelector(...)` / `getElementById(...)` etc. The
 * `value` is the literal name (id value, class name, tag name,
 * attribute name) — already extracted from any leading `#` / `.` /
 * `[…]` punctuation.
 */
export interface CapturedSelector {
  readonly selector: string;
  readonly kind: SelectorKind;
  readonly value: string;
}

/** A single click-attachment site located in a JS file. */
export interface RawClickSite {
  readonly captured: CapturedSelector;
  readonly line: number;
  readonly column: number;
  readonly shape: "addEventListener" | "onclick";
}

/**
 * Matches `<expr>.addEventListener('click', …)`. Captures the receiver
 * identifier (when literal) so the host can resolve back to a selector
 * binding. The receiver may also be a chained call expression
 * (`document.querySelector(...).addEventListener(...)`); the inline
 * resolver below detects this case by walking back through a
 * balanced-paren close.
 */
const ADD_EVENT_LISTENER_CLICK = /\.\s*addEventListener\s*\(\s*["'`]click["'`]\s*,/g;

/**
 * Matches `<expr>.onclick = …`. Excludes equality comparisons (`==`,
 * `===`) via the negative lookahead. Same dual receiver shape as
 * addEventListener (inline chain or captured variable).
 */
const ONCLICK_ASSIGNMENT = /\.\s*onclick\s*=(?!=)/g;

/**
 * Returns every click-attach site in `file.source` whose receiver
 * resolves to a static selector.
 *
 * Two receiver shapes resolve:
 *
 *   1. Inline: `document.querySelector('.x').addEventListener('click', …)`.
 *      The call sits immediately before the `.addEventListener` /
 *      `.onclick`. The selector argument is read directly.
 *
 *   2. Captured-variable: `const el = document.querySelector('.x'); …
 *      el.addEventListener('click', …)`. Single-hop lookup back to the
 *      most recent `const`/`let`/`var <ident> = document.<method>(...)`.
 */
export function findClickAttachmentSites(file: ProjectRuleFile): readonly RawClickSite[] {
  const out: RawClickSite[] = [];
  const source = file.source;
  for (const attach of collectAttachOffsets(source)) {
    const captured = resolveSelectorForAttach(source, attach.offset);
    if (captured === null) continue;
    const pos = positionAtOffset(source, attach.offset);
    out.push({ captured, line: pos.line, column: pos.column, shape: attach.shape });
  }
  return out;
}

interface AttachToken {
  readonly offset: number;
  readonly shape: "addEventListener" | "onclick";
}

function collectAttachOffsets(source: string): readonly AttachToken[] {
  const out: AttachToken[] = [];
  ADD_EVENT_LISTENER_CLICK.lastIndex = 0;
  let m = ADD_EVENT_LISTENER_CLICK.exec(source);
  while (m !== null) {
    out.push({ offset: m.index, shape: "addEventListener" });
    m = ADD_EVENT_LISTENER_CLICK.exec(source);
  }
  ONCLICK_ASSIGNMENT.lastIndex = 0;
  let n = ONCLICK_ASSIGNMENT.exec(source);
  while (n !== null) {
    out.push({ offset: n.index, shape: "onclick" });
    n = ONCLICK_ASSIGNMENT.exec(source);
  }
  return out;
}

/**
 * Resolves the selector for a click-attach token at `attachOffset`.
 * The token is the literal `.addEventListener(...` or `.onclick`;
 * we look at what comes immediately before it (the `.` is at
 * `attachOffset`).
 */
function resolveSelectorForAttach(source: string, attachOffset: number): CapturedSelector | null {
  // Inline shape: `document.querySelector('.x').addEventListener(...)`
  const inlineSelector = readInlineQueryArgument(source, attachOffset);
  if (inlineSelector !== null) return classifySelector(inlineSelector.method, inlineSelector.arg);
  // Captured-variable shape: walk back to find the receiver identifier,
  // then look up its declarator.
  const receiver = findReceiverIdentBeforeOffset(source, attachOffset);
  if (receiver === null) return null;
  const binding = findQueryBindingForVariable(source, receiver, attachOffset);
  if (binding === null) return null;
  return classifySelector(binding.method, binding.arg);
}

interface QueryCall {
  readonly method: string;
  readonly arg: string;
}

/**
 * When the position immediately before `attachOffset` is a closing
 * paren `)`, walks back through the balanced expression to find a
 * `document.<method>('arg')` callee and returns it. Otherwise null.
 */
function readInlineQueryArgument(source: string, attachOffset: number): QueryCall | null {
  const closeOffset = findClosingParenBefore(source, attachOffset);
  if (closeOffset === null) return null;
  const openOffset = matchingOpenParenBackward(source, closeOffset);
  if (openOffset === null) return null;
  const callee = readDocumentMethodBefore(source, openOffset);
  if (callee === null) return null;
  const arg = readFirstStringArg(source, openOffset);
  if (arg === null) return null;
  return { method: callee, arg };
}

/**
 * Walks back from `attachOffset` over whitespace; returns the offset
 * of the immediately-preceding `)` if there is one, otherwise null.
 */
function findClosingParenBefore(source: string, attachOffset: number): number | null {
  let i = attachOffset - 1;
  while (i >= 0 && /\s/.test(source[i] ?? "")) i--;
  if (i < 0 || source[i] !== ")") return null;
  return i;
}

/**
 * Walks back from a `(` offset to read `document.<method>` and returns
 * the method name when both the receiver is `document` and the method
 * is a known query method. Otherwise null.
 */
function readDocumentMethodBefore(source: string, openParenOffset: number): string | null {
  const methodResult = readIdentifierBefore(source, openParenOffset - 1);
  if (!isQueryMethod(methodResult.value)) return null;
  const dotOffset = skipWhitespaceBackward(source, methodResult.startOffset - 1);
  if (dotOffset < 0 || source[dotOffset] !== ".") return null;
  const receiverResult = readIdentifierBefore(source, dotOffset - 1);
  if (receiverResult.value !== "document") return null;
  return methodResult.value;
}

interface IdentifierRead {
  /** The identifier text, possibly empty. */
  readonly value: string;
  /** The offset of the identifier's first character (or position past where the read started, for empties). */
  readonly startOffset: number;
}

/**
 * Walks backward from `endOffset` over whitespace, then over identifier
 * characters, and returns the parsed identifier plus the offset of its
 * first character. Returns an empty string when no identifier characters
 * are present (caller decides whether that is an error).
 */
function readIdentifierBefore(source: string, endOffset: number): IdentifierRead {
  let i = skipWhitespaceBackward(source, endOffset);
  const exclusiveEnd = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(source[i] ?? "")) i--;
  const startOffset = i + 1;
  return { value: source.slice(startOffset, exclusiveEnd), startOffset };
}

/** Walks back over whitespace from `from`; returns the offset of the first non-whitespace, or -1. */
function skipWhitespaceBackward(source: string, from: number): number {
  let i = from;
  while (i >= 0 && /\s/.test(source[i] ?? "")) i--;
  return i;
}

/**
 * Reads the first string-literal argument of a parenthesized call
 * starting at `openOffset` (the `(`). Returns the raw string contents
 * or null if the first argument isn't a literal.
 */
function readFirstStringArg(source: string, openOffset: number): string | null {
  let k = openOffset + 1;
  while (k < source.length && /\s/.test(source[k] ?? "")) k++;
  const quote = source[k];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  k++;
  let end = k;
  while (end < source.length && source[end] !== quote) {
    if (source[end] === "\\") end += 2;
    else end++;
  }
  if (end >= source.length) return null;
  return source.slice(k, end);
}

/** Match `(` for a `)` walking backward, skipping nested string literals. */
function matchingOpenParenBackward(source: string, closeOffset: number): number | null {
  let depth = 1;
  let i = closeOffset - 1;
  while (i >= 0) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteralBackward(source, i);
      continue;
    }
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) return i;
    }
    i--;
  }
  return null;
}

function skipStringLiteralBackward(source: string, closeOffset: number): number {
  const quote = source[closeOffset];
  if (quote !== '"' && quote !== "'" && quote !== "`") return closeOffset - 1;
  let i = closeOffset - 1;
  while (i >= 0) {
    if (source[i] === quote && source[i - 1] !== "\\") return i - 1;
    i--;
  }
  return -1;
}

/**
 * Walks back from `attachOffset` over whitespace to find a bare
 * identifier acting as the receiver of `.addEventListener` /
 * `.onclick`. Returns null when the previous token isn't an identifier
 * (e.g. `)` — handled by the inline path) or is a known global that
 * the host rule treats as a global delegator.
 */
function findReceiverIdentBeforeOffset(source: string, attachOffset: number): string | null {
  let i = attachOffset - 1;
  while (i >= 0 && /\s/.test(source[i] ?? "")) i--;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(source[i] ?? "")) i--;
  const start = i + 1;
  if (start >= end) return null;
  const ident = source.slice(start, end);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ident)) return null;
  // window/document/globalThis are global delegators — covered by other
  // rules and not in scope here.
  if (ident === "document" || ident === "window" || ident === "globalThis" || ident === "this") {
    return null;
  }
  return ident;
}

/**
 * Locates the most recent `(?:const|let|var) <variableName> =
 * document.<method>('<arg>')` declarator preceding `beforeOffset` and
 * returns the method + argument. Returns null when the variable's
 * binding isn't a `document` query call.
 */
function findQueryBindingForVariable(
  source: string,
  variableName: string,
  beforeOffset: number,
): QueryCall | null {
  const escaped = escapeForRegex(variableName);
  const pattern = new RegExp(
    `(?:const|let|var)\\s+${escaped}\\s*=\\s*document\\s*\\.\\s*` +
      `(querySelector|querySelectorAll|getElementById|getElementsByClassName|getElementsByTagName)` +
      `\\s*\\(\\s*["'\`]([^"'\`]*)["'\`]\\s*\\)`,
    "g",
  );
  pattern.lastIndex = 0;
  let best: QueryCall | null = null;
  let m = pattern.exec(source);
  while (m !== null) {
    if (m.index >= beforeOffset) break;
    const method = m[1];
    const arg = m[2];
    if (method !== undefined && arg !== undefined) {
      best = { method, arg };
    }
    m = pattern.exec(source);
  }
  return best;
}

const QUERY_METHODS: ReadonlySet<string> = new Set([
  "querySelector",
  "querySelectorAll",
  "getElementById",
  "getElementsByClassName",
  "getElementsByTagName",
]);

function isQueryMethod(name: string): boolean {
  return QUERY_METHODS.has(name);
}

/**
 * Tags that name a structural document root (`<html>`, `<body>`).
 * A click listener attached to one of these via
 * `document.querySelector("html")` / `getElementsByTagName("body")`
 * etc. is the documented vendor pattern for delegated outside-click
 * dismissal — not a missing-role bug. The document root is by-platform
 * focusable and cannot be converted to `<button>`; emitting on these
 * tags would produce a structurally invalid suggested fix and the
 * cross-file evidence chain is composition-speculative.
 *
 * Per docs/kb/architecture/ai-first-consumer.md "Heuristic emission is
 * the symmetric twin of heuristic suppression", the rule's selector-to-
 * element matching on a document-root selector is too speculative to
 * justify a deterministic finding — the listener target is the
 * platform's naturally-focusable root, and converting `<html>` /
 * `<body>` to `<button>` is structurally invalid.
 */
const DOCUMENT_ROOT_TAGS: ReadonlySet<string> = new Set(["html", "body"]);

/**
 * Translates a captured `(method, arg)` into a `CapturedSelector` the
 * host rule can match against HTML elements. Compound selectors
 * (descendant combinators, pseudo-classes, attribute-with-value) fall
 * through to null — the agent reading the file resolves these faster
 * than an in-process tokenizer would, and silently mis-resolving is
 * worse than emitting nothing.
 *
 * Tag selectors that name a document root (`html`, `body`) also fall
 * through to null — see `DOCUMENT_ROOT_TAGS` above.
 */
function classifySelector(method: string, arg: string): CapturedSelector | null {
  const trimmed = arg.trim();
  if (trimmed === "") return null;
  if (method === "getElementById") {
    return { selector: `#${trimmed}`, kind: "id", value: trimmed };
  }
  if (method === "getElementsByClassName") {
    // Only a single class name is supported (the spec allows multiple
    // space-separated names but compound matching needs all of them).
    if (/\s/.test(trimmed)) return null;
    return { selector: `.${trimmed}`, kind: "class", value: trimmed };
  }
  if (method === "getElementsByTagName") {
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(trimmed)) return null;
    return buildTagSelector(trimmed);
  }
  return classifyQuerySelectorArg(trimmed);
}

/**
 * Decode a `querySelector` / `querySelectorAll` argument into a
 * captured selector. Accepts simple single-token shapes only:
 * `#id`, `.class`, `tag`, `[attr]` (no value comparator). Compound
 * selectors fall through to null.
 */
function classifyQuerySelectorArg(trimmed: string): CapturedSelector | null {
  if (/^#[A-Za-z][\w-]*$/.test(trimmed)) {
    return { selector: trimmed, kind: "id", value: trimmed.slice(1) };
  }
  if (/^\.[A-Za-z][\w-]*$/.test(trimmed)) {
    return { selector: trimmed, kind: "class", value: trimmed.slice(1) };
  }
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(trimmed)) {
    return buildTagSelector(trimmed);
  }
  // Bracketed attribute selector with no value comparator (`[data-x]`
  // but NOT `[data-x="y"]`) — value-comparators require attribute-value
  // matching which the simple HTML walker doesn't support yet.
  const attrMatch = /^\[([A-Za-z][\w-]*)\]$/.exec(trimmed);
  if (attrMatch === null) return null;
  const name = attrMatch[1];
  if (name === undefined) return null;
  return { selector: trimmed, kind: "attribute", value: name };
}

/**
 * Build a tag-selector capture, returning null when the tag names a
 * document root (`html`, `body`) — see `DOCUMENT_ROOT_TAGS`.
 */
function buildTagSelector(tagName: string): CapturedSelector | null {
  if (DOCUMENT_ROOT_TAGS.has(tagName.toLowerCase())) return null;
  return { selector: tagName, kind: "tag", value: tagName };
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
