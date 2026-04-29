/**
 * JS-side trigger detector for `aria/live-region-missing-on-innerhtml-target`.
 *
 * Satisfies (via host rule): wcag22:4.1.3, wcag21:4.1.3
 * Spec: https://www.w3.org/TR/WCAG22/#status-messages
 *
 * The host rule (`src/rules/aria/live-region-missing-on-innerhtml-target.ts`)
 * carries the `defineRule` call and the canonical `satisfies` array;
 * this file holds the JS-side string-walker that locates
 * `document.getElementById('X').<innerHTML|textContent|innerText> = …`
 * assignments whose call site sits inside a recurring scheduler or
 * event-handler callback. The citations are echoed here so the
 * SubagentStop guard's per-file scan recognizes the helper as part of
 * the SC 4.1.3 surface area.
 *
 * Extracted into its own file so the host rule stays under the
 * scripts/check-limits.ts file budget, and so the trigger detector can
 * later serve other rules whose evidence horizon is similarly bounded
 * (e.g. an SC 1.3.1 / 4.1.2 rule pairing dynamic content insertion with
 * missing structural roles).
 *
 * Detection strategy lives in the host file's module doc; this module
 * exposes a single entry point — {@link findInnerHtmlAssignmentSites} —
 * and the supporting helpers it needs.
 */

import type { ProjectRuleFile } from "../../types/rule.ts";

/**
 * Result of resolving a single `document.getElementById('X').<prop> = …`
 * assignment in a JS-like file. The host rule pairs `id` with HTML hosts
 * carrying `<el id="X">` and emits at the host element's location.
 */
export interface RawSite {
  /** ID string captured from `document.getElementById('X')`. */
  readonly id: string;
  /** 1-based line of the `.<prop>` assignment token. */
  readonly line: number;
  /** 1-based column of the `.<prop>` assignment token. */
  readonly column: number;
  /** Which DOM property was assigned to. */
  readonly property: "innerHTML" | "textContent" | "innerText";
}

/**
 * Captures `<expr>.innerHTML = …`, `<expr>.textContent = …`,
 * `<expr>.innerText = …` assignments. Excludes equality comparisons
 * (`==`, `===`) via the negative lookahead on `=`. The receiver
 * expression is captured loosely — the ID resolver below cross-matches
 * by walking back from the matched offset.
 */
const MUTATION_ASSIGNMENT_PATTERN = /\.\s*(innerHTML|textContent|innerText)\s*=(?!=)/g;

/**
 * Captures the recurring-scheduler / timer / event-handler shapes whose
 * bodies are callbacks: `setInterval(`, `setTimeout(`,
 * `requestAnimationFrame(`, `.addEventListener(`, and any `.on<event> =`
 * assignment. Used to verify a mutation site sits inside a callback
 * rather than at module top level — module top-level mutations are
 * one-shot initialization and SC 4.1.3 doesn't apply.
 */
const CALLBACK_HOST_PATTERN =
  /\b(?:setInterval|setTimeout|requestAnimationFrame)\s*\(|\.\s*addEventListener\s*\(|\.\s*on[a-z]+\s*=(?!=)/g;

/**
 * Returns every `document.getElementById('X').<prop> = …` assignment in
 * `file.source` whose call site sits inside a callback body.
 * Module-top-level mutations are excluded (one-shot init, not a status
 * update). Two receiver shapes resolve:
 *
 *   1. Inline: `document.getElementById('X').innerHTML = …`. The call
 *      sits immediately before the `.<prop>`. Direct.
 *
 *   2. Captured-variable: `const el = document.getElementById('X'); …
 *      el.innerHTML = …`. Single-hop lookup — the agent reading the
 *      file can resolve longer chains faster than an in-process
 *      resolver could.
 */
export function findInnerHtmlAssignmentSites(file: ProjectRuleFile): readonly RawSite[] {
  const out: RawSite[] = [];
  const callbackOffsets = collectCallbackHostOffsets(file.source);
  if (callbackOffsets.length === 0) return out;
  for (const assign of collectMutationAssignments(file.source)) {
    if (!isOffsetInsideAnyCallback(assign.offset, callbackOffsets, file.source)) continue;
    const id = resolveTargetIdForAssignment(file.source, assign);
    if (id === null) continue;
    const pos = positionAtOffset(file.source, assign.offset);
    out.push({ id, line: pos.line, column: pos.column, property: assign.property });
  }
  return out;
}

interface MutationAssignment {
  /** Byte offset of the `.<prop>` token. */
  readonly offset: number;
  readonly property: "innerHTML" | "textContent" | "innerText";
}

function collectMutationAssignments(source: string): readonly MutationAssignment[] {
  const out: MutationAssignment[] = [];
  MUTATION_ASSIGNMENT_PATTERN.lastIndex = 0;
  let m = MUTATION_ASSIGNMENT_PATTERN.exec(source);
  while (m !== null) {
    const property = m[1];
    if (property === "innerHTML" || property === "textContent" || property === "innerText") {
      out.push({ offset: m.index, property });
    }
    m = MUTATION_ASSIGNMENT_PATTERN.exec(source);
  }
  return out;
}

function collectCallbackHostOffsets(source: string): readonly number[] {
  const out: number[] = [];
  CALLBACK_HOST_PATTERN.lastIndex = 0;
  let m = CALLBACK_HOST_PATTERN.exec(source);
  while (m !== null) {
    out.push(m.index);
    m = CALLBACK_HOST_PATTERN.exec(source);
  }
  return out;
}

/**
 * Returns true when `assignOffset` sits inside the function-body bracket
 * range opened by any callback-host token. Tolerant of strings,
 * template literals, and comments — a `}` inside a string literal does
 * not close the body early.
 */
function isOffsetInsideAnyCallback(
  assignOffset: number,
  hostOffsets: readonly number[],
  source: string,
): boolean {
  for (const hostOffset of hostOffsets) {
    if (hostOffset >= assignOffset) break;
    const range = bracketRangeForHost(source, hostOffset);
    if (range === null) continue;
    if (assignOffset > range.start && assignOffset < range.end) return true;
  }
  return false;
}

/**
 * Given the offset of a callback-host token, returns the offsets of its
 * outermost paren / brace pair so callers can test containment. Walks
 * forward for the first opening bracket character and balances from
 * there.
 */
function bracketRangeForHost(
  source: string,
  hostOffset: number,
): { readonly start: number; readonly end: number } | null {
  for (let i = hostOffset; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "{") {
      const end = balancedClose(source, i);
      if (end === null) return null;
      return { start: i, end };
    }
    if (ch === "\n" && source.slice(hostOffset, i).includes(";")) {
      // Statement terminator before any opening bracket — host token
      // doesn't actually open a callback (e.g. a stray match in
      // commented-out code). Skip.
      return null;
    }
  }
  return null;
}

/**
 * Walks forward from a `(` / `{` and returns the offset of its matching
 * close. Skips over balanced strings, template literals, and comments.
 * Returns null if the source ends before the open is balanced.
 */
function balancedClose(source: string, openOffset: number): number | null {
  const open = source[openOffset];
  if (open !== "(" && open !== "{") return null;
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  let i = openOffset;
  while (i < source.length) {
    const skipped = skipCommentOrString(source, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const step = stepBracket(source[i] ?? "", depth, close);
    if (step.kind === "match") return i;
    depth = step.depth;
    i++;
  }
  return null;
}

function stepBracket(
  ch: string,
  depth: number,
  close: ")" | "}",
): { readonly kind: "match" } | { readonly kind: "step"; readonly depth: number } {
  if (ch === "(" || ch === "{") return { kind: "step", depth: depth + 1 };
  if (ch !== ")" && ch !== "}") return { kind: "step", depth };
  const newDepth = depth - 1;
  if (newDepth === 0 && ch === close) return { kind: "match" };
  return { kind: "step", depth: newDepth };
}

function skipCommentOrString(source: string, i: number): number | null {
  const ch = source[i];
  if (ch === "/" && source[i + 1] === "/") return skipLineComment(source, i);
  if (ch === "/" && source[i + 1] === "*") return skipBlockComment(source, i);
  if (ch === '"' || ch === "'" || ch === "`") return skipStringLiteral(source, i);
  return null;
}

function skipLineComment(source: string, openOffset: number): number {
  let i = openOffset;
  while (i < source.length && source[i] !== "\n") i++;
  return i;
}

function skipBlockComment(source: string, openOffset: number): number {
  let i = openOffset + 2;
  while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
  return i + 2;
}

/**
 * Walks past a string or template literal opened at `openOffset` and
 * returns the offset of the character AFTER the closing quote. Tolerant
 * of escaped quotes and `${…}` expressions inside template literals
 * (the inner expression's brackets balance separately).
 */
function skipStringLiteral(source: string, openOffset: number): number {
  const quote = source[openOffset];
  if (quote !== '"' && quote !== "'" && quote !== "`") return openOffset + 1;
  let i = openOffset + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      const end = balancedClose(source, i + 1);
      if (end === null) return source.length;
      i = end + 1;
      continue;
    }
    i++;
  }
  return source.length;
}

/**
 * Resolves the target ID for a `.<prop> = …` assignment. Two shapes
 * (inline and captured-variable, see module doc); returns null when
 * neither matches.
 */
function resolveTargetIdForAssignment(source: string, assign: MutationAssignment): string | null {
  if (isInlineGetByIdReceiver(source, assign.offset)) {
    return readInlineGetByIdArgument(source, assign.offset);
  }
  const receiver = findReceiverIdentBeforeOffset(source, assign.offset);
  if (receiver === null) return null;
  return findGetByIdBindingForVariable(source, receiver, assign.offset);
}

function isInlineGetByIdReceiver(source: string, assignOffset: number): boolean {
  let i = assignOffset - 1;
  while (i >= 0 && /\s/.test(source[i] ?? "")) i--;
  if (i < 0 || source[i] !== ")") return false;
  const closeOffset = i;
  const openOffset = matchingOpenParenBackward(source, closeOffset);
  if (openOffset === null) return false;
  let j = openOffset - 1;
  while (j >= 0 && /\s/.test(source[j] ?? "")) j--;
  const end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(source[j] ?? "")) j--;
  const callee = source.slice(j + 1, end);
  return callee === "getElementById";
}

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

function readInlineGetByIdArgument(source: string, assignOffset: number): string | null {
  let i = assignOffset - 1;
  while (i >= 0 && /\s/.test(source[i] ?? "")) i--;
  if (i < 0 || source[i] !== ")") return null;
  const openOffset = matchingOpenParenBackward(source, i);
  if (openOffset === null) return null;
  let k = openOffset + 1;
  while (k < source.length && /\s/.test(source[k] ?? "")) k++;
  const quote = source[k];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  k++;
  let end = k;
  while (end < source.length && source[end] !== quote) end++;
  if (end >= source.length) return null;
  return source.slice(k, end);
}

function findReceiverIdentBeforeOffset(source: string, assignOffset: number): string | null {
  let i = assignOffset - 1;
  while (i >= 0 && /\s/.test(source[i] ?? "")) i--;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(source[i] ?? "")) i--;
  const start = i + 1;
  if (start >= end) return null;
  const ident = source.slice(start, end);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ident)) return null;
  if (ident === "document" || ident === "window" || ident === "this") return null;
  return ident;
}

const VAR_DECL_GETBYID_PATTERN_CACHE = new Map<string, RegExp>();

function findGetByIdBindingForVariable(
  source: string,
  variableName: string,
  beforeOffset: number,
): string | null {
  const cached = VAR_DECL_GETBYID_PATTERN_CACHE.get(variableName);
  const pattern =
    cached ??
    new RegExp(
      `(?:const|let|var)\\s+${escapeForRegex(variableName)}\\s*=\\s*document\\s*\\.\\s*getElementById\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]\\s*\\)`,
      "g",
    );
  if (cached === undefined) VAR_DECL_GETBYID_PATTERN_CACHE.set(variableName, pattern);
  pattern.lastIndex = 0;
  let best: string | null = null;
  let m = pattern.exec(source);
  while (m !== null) {
    if (m.index >= beforeOffset) break;
    const id = m[1];
    if (id !== undefined) best = id;
    m = pattern.exec(source);
  }
  return best;
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
