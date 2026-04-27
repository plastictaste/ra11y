/**
 * Insert-an-attribute-into-an-open-tag helper, shared by rules in the
 * `semantics/` domain that emit `fixPaths.primary.edit` for icon-only
 * accessible-name fixes (`semantics/button-name`, future siblings).
 *
 * Mirrors the same scanner logic that ships privately inside
 * `src/rules/forms/autocomplete-missing.ts` and
 * `src/rules/document/lang-attribute.ts` — those rules keep their own
 * private copies for now (each pre-dates the shared extraction); a
 * future cleanup pass can migrate them onto this helper. The shared
 * extraction here is necessary because `semantics/button-name.ts`
 * crossed the 500-LOC budget when-
 * EDIT inlined the scanner locally
 * UNIFY (the dispatching item) is the consistency-axis that pulls it
 * out into a sibling module so the button-name file drops back under
 * the budget.
 *
 * Keeps the brace-aware (JSX) byte-walk private to this file —
 * callers parameterize over `dialect` and an expected tag name; they
 * never need to see the scanner state.
 */

/**
 * Slices an open tag from `source` (between `startOffset` and
 * `endOffset`, the host element's range) and produces a deterministic
 * `{oldText, newText}` pair that inserts ` <attrName>="<attrValue>"`
 * immediately before the tag-closing `>` (and before any trailing
 * whitespace or self-closing `/`).
 *
 * Returns null when the slice doesn't begin with the expected
 * `<tagName` open tag, or when an attribute quote / `{...}` expression
 * stays unclosed inside the slice. The caller falls through to
 * guidance instead of emitting a confidently-wrong edit — same
 * contract as the private scanner copies in
 * `src/rules/forms/autocomplete-missing.ts` and
 * `src/rules/document/lang-attribute.ts`.
 *
 * The `dialect` parameter routes brace-counting: JSX `{...expr}`
 * attribute values can contain `>` characters that don't terminate
 * the open tag, so the scanner must descend into `{...}` regions and
 * match braces before treating any subsequent `>` as the end-of-tag.
 */
export function buildAttributeInsertEdit(
  startOffset: number,
  endOffset: number,
  source: string,
  params: {
    readonly tagName: string;
    readonly attrName: string;
    readonly attrValue: string;
    readonly dialect: "html" | "jsx";
  },
): { readonly oldText: string; readonly newText: string } | null {
  const raw = source.slice(startOffset, endOffset);
  const afterTagName = scanExpectedTagName(raw, params.tagName);
  if (afterTagName === -1) return null;
  const gtIndex = scanOpenTagToGt(raw, afterTagName, params.dialect);
  if (gtIndex === -1) return null;
  const openTag = raw.slice(0, gtIndex + 1);
  let insertAt = gtIndex;
  if (raw.charCodeAt(insertAt - 1) === 0x2f /* / */) insertAt -= 1;
  while (insertAt > 0 && isAsciiWhitespaceCharCode(raw.charCodeAt(insertAt - 1))) {
    insertAt -= 1;
  }
  const before = raw.slice(0, insertAt);
  const afterToGt = raw.slice(insertAt, gtIndex + 1);
  return {
    oldText: openTag,
    newText: `${before} ${params.attrName}="${params.attrValue}"${afterToGt}`,
  };
}

/**
 * Returns the byte offset AFTER `<tagName` in `raw`, or -1 when `raw`
 * does not start with `<tagName` followed by an open-tag-separator
 * byte. Mirrors `scanHtmlTagName` in
 * `src/rules/document/lang-attribute.ts` but parameterized over the
 * tag name so callers can verify both `<button` and arbitrary
 * `role="button"` host tags (`<div role="button">`, `<a role="button">`).
 */
function scanExpectedTagName(raw: string, tagName: string): number {
  const minLen = 1 + tagName.length + 1;
  if (raw.length < minLen) return -1;
  if (raw.charCodeAt(0) !== 0x3c /* < */) return -1;
  for (let i = 0; i < tagName.length; i += 1) {
    if (raw.charCodeAt(1 + i) !== tagName.charCodeAt(i)) return -1;
  }
  const next = raw.charCodeAt(1 + tagName.length);
  // Open-tag separator: whitespace, `/`, or `>`. Any letter/digit
  // means the source's tag name continues past the expected one (e.g.
  // `<buttonGroup` vs the expected `button`), so this isn't the
  // element we think it is.
  if (
    next === 0x20 ||
    next === 0x09 ||
    next === 0x0a ||
    next === 0x0d ||
    next === 0x2f ||
    next === 0x3e
  ) {
    return 1 + tagName.length;
  }
  return -1;
}

/**
 * Walks `raw` from `startIndex` until the `>` that closes the open
 * tag, respecting single/double-quoted attribute values and (for the
 * JSX dialect) `{...}` expression nesting. Returns the byte offset of
 * the `>` or -1 if input runs out / a quote/brace stays unclosed.
 */
function scanOpenTagToGt(raw: string, startIndex: number, dialect: "html" | "jsx"): number {
  const state: OpenTagState = { inSingle: false, inDouble: false, braceDepth: 0 };
  for (let i = startIndex; i < raw.length; i += 1) {
    if (advanceOpenTagState(raw.charCodeAt(i), state, dialect) === "gt") return i;
  }
  return -1;
}

interface OpenTagState {
  inSingle: boolean;
  inDouble: boolean;
  braceDepth: number;
}

/**
 * Per-byte transition for {@link scanOpenTagToGt}. Mutates `state` in
 * place (toggling the active quote flag, updating brace depth) and
 * returns `"gt"` only when the byte is the open-tag-closing `>`
 * outside any quote or `{...}` expression — the caller short-circuits
 * the loop with the current index when it sees that signal. Quote-
 * and brace-mode handling are extracted into siblings so each branch
 * stays trivial under the cognitive-complexity ceiling.
 */
function advanceOpenTagState(
  ch: number,
  state: OpenTagState,
  dialect: "html" | "jsx",
): "gt" | "continue" {
  if (state.inSingle) {
    if (ch === 0x27) state.inSingle = false;
    return "continue";
  }
  if (state.inDouble) {
    if (ch === 0x22) state.inDouble = false;
    return "continue";
  }
  if (state.braceDepth > 0) {
    advanceBraceDepth(ch, state, dialect);
    return "continue";
  }
  return enterTopLevelByte(ch, state, dialect);
}

function advanceBraceDepth(ch: number, state: OpenTagState, dialect: "html" | "jsx"): void {
  if (dialect !== "jsx") return;
  if (ch === 0x7b) state.braceDepth += 1;
  else if (ch === 0x7d) state.braceDepth -= 1;
}

function enterTopLevelByte(
  ch: number,
  state: OpenTagState,
  dialect: "html" | "jsx",
): "gt" | "continue" {
  if (ch === 0x3e) return "gt";
  if (ch === 0x27) state.inSingle = true;
  else if (ch === 0x22) state.inDouble = true;
  else if (dialect === "jsx" && ch === 0x7b) state.braceDepth = 1;
  return "continue";
}

function isAsciiWhitespaceCharCode(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}
