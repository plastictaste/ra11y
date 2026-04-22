/**
 * Static probe: does a `setInterval` callback statically evidence DOM
 * mutation?
 *
 * Companion to `review/timing` — isolated here so the finder file stays
 * under the 500-line limit and the probe can be tested / reasoned about
 * independently. A repeating DOM mutation under `setInterval` is the
 * canonical shape of "auto-updating information" under WCAG 2.2.2
 * (Pause, Stop, Hide). See `timing.ts` for how escalation feeds the
 * review candidate's reason text and criterion set.
 *
 * Per ai-first-consumer.md ("don't duplicate capability the agent
 * already has"), this probe is intentionally narrow: same-file,
 * single-hop identifier lookup, text regex. Cross-file tracing and
 * object-method resolution are the agent's job. The probe is
 * deterministic on the shapes it handles (inline callback body; named
 * function / arrow binding / `name = …` assignment in the same file)
 * so reason-text enrichment is honest where it fires.
 */

/**
 * Text-level patterns that indicate the callback mutates DOM state.
 * Tuned for the real-world carousel / auto-advancing-slider shape:
 * `el.style.prop =`, `el.className =`, `el.classList.add(...)`,
 * `el.setAttribute(...)`, `el.innerHTML =`, `el.src =`, etc. False
 * positives (e.g. DOM writes that don't drive visual motion) still
 * surface the candidate — per surface-don't-suppress, the agent
 * dismisses with one file Read and keeps its audit trail visible.
 */
const DOM_MUTATION_PATTERNS: readonly RegExp[] = [
  // Assignment: `<any>.style.<prop> = ...`
  /\.style\s*\.\s*[A-Za-z_$][\w$-]*\s*=(?!=)/,
  // Indexed style assignment: `<any>.style["prop"] = ...`
  /\.style\s*\[/,
  // `<any>.className = ...`, `<any>.innerHTML = ...`, `<any>.textContent = ...`,
  // `<any>.outerHTML = ...`, `<any>.src = ...`, `<any>.href = ...`,
  // `<any>.srcset = ...`, `<any>.value = ...`, `<any>.checked = ...`,
  // `<any>.disabled = ...`, `<any>.hidden = ...`
  /\.(?:className|innerHTML|outerHTML|textContent|src|href|srcset|value|checked|disabled|hidden)\s*=(?!=)/,
  // classList mutation methods
  /\.classList\s*\.\s*(?:add|remove|toggle|replace)\s*\(/,
  // setAttribute / removeAttribute / toggleAttribute
  /\.(?:setAttribute|removeAttribute|toggleAttribute)\s*\(/,
  // replaceChildren / appendChild / removeChild / replaceWith / insertBefore / insertAdjacentHTML / insertAdjacentElement
  /\.(?:replaceChildren|appendChild|removeChild|replaceWith|insertBefore|insertAdjacentHTML|insertAdjacentElement)\s*\(/,
];

/** Minimal state carried across the char-by-char scans below. */
interface ScanState {
  i: number;
  depth: number;
  stringQuote: number;
  inLineComment: boolean;
  inBlockComment: boolean;
  readonly templateStack: number[];
}

/**
 * Returns true if the callback argument of the `setInterval` call
 * whose `(` is at `openParen` statically evidences DOM mutation.
 *
 * Handles:
 *   - Inline callback — `setInterval(() => { el.style.left = '0'; }, 2000)`.
 *     The callback body text is tested against {@link DOM_MUTATION_PATTERNS}.
 *   - Identifier callback — `setInterval(run, 2000)`. Searches the
 *     source for a same-file `function run`, `const run = …`, or
 *     `run = …` binding and tests its body.
 *
 * A missed match is honest silence (no escalation) — we never guess.
 */
export function callbackMutatesDom(source: string, openParen: number): boolean {
  const callback = extractCallbackText(source, openParen);
  if (callback === null) return false;
  if (containsDomMutation(callback.text)) return true;
  if (callback.identifier === null) return false;
  const body = findFunctionBodyByName(source, callback.identifier, openParen);
  if (body === null) return false;
  return containsDomMutation(body);
}

function containsDomMutation(text: string): boolean {
  for (const pattern of DOM_MUTATION_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/** Extract the first-argument text of a setInterval call, and the bare identifier if it is one. */
function extractCallbackText(
  source: string,
  openParen: number,
): { text: string; identifier: string | null } | null {
  if (openParen < 0 || openParen >= source.length || source.charCodeAt(openParen) !== 40) {
    return null;
  }
  const state: ScanState = {
    i: openParen + 1,
    depth: 1,
    stringQuote: 0,
    inLineComment: false,
    inBlockComment: false,
    templateStack: [],
  };
  const end = scanToFirstTopLevelCommaOrClose(source, state);
  if (end === null) return null;
  const raw = source.slice(openParen + 1, end).trim();
  if (!raw) return { text: "", identifier: null };
  const identifier = /^[A-Za-z_$][\w$]*$/.test(raw) ? raw : null;
  return { text: raw, identifier };
}

/** Scan to the first top-level `,` or the matching close-paren, whichever comes first. */
function scanToFirstTopLevelCommaOrClose(source: string, state: ScanState): number | null {
  while (state.i < source.length) {
    if (advanceThroughNonCode(source, state)) continue;
    const c = source.charCodeAt(state.i);
    const preIdx = state.i;
    if (handleBracket(state, c)) {
      if (state.depth === 0) return preIdx;
      continue;
    }
    if (c === 44 /* , */ && state.depth === 1) return preIdx;
    state.i++;
  }
  return null;
}

/** Find the body `{ ... }` of a same-file function/binding named `name`. */
function findFunctionBodyByName(
  source: string,
  name: string,
  callSiteOffset: number,
): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$1");
  const headers: RegExp[] = [
    new RegExp(String.raw`\bfunction\s*\*?\s*${escaped}\s*\(`, "g"),
    new RegExp(String.raw`\basync\s+function\s*\*?\s*${escaped}\s*\(`, "g"),
    new RegExp(String.raw`\b(?:const|let|var)\s+${escaped}\s*=\s*(?:async\s+)?function\b`, "g"),
    new RegExp(String.raw`\b(?:const|let|var)\s+${escaped}\s*=\s*(?:async\s+)?\(`, "g"),
    new RegExp(String.raw`(?:^|[\s;{},])${escaped}\s*=\s*(?:async\s+)?function\b`, "g"),
    new RegExp(String.raw`(?:^|[\s;{},])${escaped}\s*=\s*(?:async\s+)?\(`, "g"),
  ];
  for (const header of headers) {
    header.lastIndex = 0;
    for (const match of source.matchAll(header)) {
      const start = match.index ?? 0;
      // Don't match the setInterval call site itself — the identifier
      // appears there too (e.g. `setInterval(run, 2000)`) and we want
      // the *definition*, not the call.
      if (Math.abs(start - callSiteOffset) < match[0].length + 2) continue;
      const braceOffset = findOpeningBraceAfter(source, start);
      if (braceOffset === null) continue;
      const body = sliceBalancedBraces(source, braceOffset);
      if (body !== null) return body;
    }
  }
  return null;
}

/** Find the first `{` at or after `start` that opens a function body. */
function findOpeningBraceAfter(source: string, start: number): number | null {
  const state: ScanState = {
    i: start,
    depth: 0,
    stringQuote: 0,
    inLineComment: false,
    inBlockComment: false,
    templateStack: [],
  };
  while (state.i < source.length) {
    if (advanceThroughNonCode(source, state)) continue;
    const c = source.charCodeAt(state.i);
    if (c === 123 /* { */ && state.depth === 0) return state.i;
    if (c === 40 /* ( */ || c === 91 /* [ */) state.depth++;
    else if (c === 41 /* ) */ || c === 93 /* ] */) state.depth--;
    else if (c === 59 /* ; */ && state.depth === 0) return null;
    state.i++;
  }
  return null;
}

/**
 * Given the offset of a `{`, return the balanced slice (braces
 * included) up to and including the matching `}`. Handles strings,
 * template literals, and comments — template-literal substitutions
 * (`` `…${…}…` ``) correctly re-enter template scanning when their
 * closing `}` is seen, so a body like `` el.style.t = `tx(${n}px)` ``
 * doesn't prematurely terminate the outer balance scan.
 */
function sliceBalancedBraces(source: string, braceOffset: number): string | null {
  const state: ScanState = {
    i: braceOffset + 1,
    depth: 1,
    stringQuote: 0,
    inLineComment: false,
    inBlockComment: false,
    templateStack: [],
  };
  while (state.i < source.length) {
    if (advanceThroughNonCode(source, state)) continue;
    const c = source.charCodeAt(state.i);
    const preIdx = state.i;
    if (handleBracket(state, c)) {
      if (state.depth === 0) return source.slice(braceOffset, preIdx + 1);
      continue;
    }
    state.i++;
  }
  return null;
}

/* -- low-level char scanner: strings / template literals / comments -- */

function advanceThroughNonCode(source: string, state: ScanState): boolean {
  const c = source.charCodeAt(state.i);
  if (state.inLineComment) {
    if (c === 10 /* \n */) state.inLineComment = false;
    state.i++;
    return true;
  }
  if (state.inBlockComment) {
    if (c === 42 /* * */ && source.charCodeAt(state.i + 1) === 47 /* / */) {
      state.inBlockComment = false;
      state.i += 2;
    } else {
      state.i++;
    }
    return true;
  }
  if (state.stringQuote !== 0) {
    advanceInsideString(source, state, c);
    return true;
  }
  if (c === 47 /* / */ && source.charCodeAt(state.i + 1) === 47) {
    state.inLineComment = true;
    state.i += 2;
    return true;
  }
  if (c === 47 && source.charCodeAt(state.i + 1) === 42 /* * */) {
    state.inBlockComment = true;
    state.i += 2;
    return true;
  }
  if (c === 39 /* ' */ || c === 34 /* " */ || c === 96 /* ` */) {
    state.stringQuote = c;
    state.i++;
    return true;
  }
  return false;
}

function advanceInsideString(source: string, state: ScanState, c: number): void {
  if (c === 92 /* \ */) {
    state.i += 2;
    return;
  }
  if (
    state.stringQuote === 96 &&
    c === 36 /* $ */ &&
    source.charCodeAt(state.i + 1) === 123 /* { */
  ) {
    state.templateStack.push(state.stringQuote);
    state.stringQuote = 0;
    state.depth++;
    state.i += 2;
    return;
  }
  if (c === state.stringQuote) {
    state.stringQuote = 0;
  }
  state.i++;
}

function handleBracket(state: ScanState, c: number): boolean {
  if (c === 40 /* ( */ || c === 91 /* [ */ || c === 123 /* { */) {
    state.depth++;
    state.i++;
    return true;
  }
  if (c === 41 /* ) */ || c === 93 /* ] */ || c === 125 /* } */) {
    state.depth--;
    if (c === 125 && state.templateStack.length > 0 && state.depth > 0) {
      const quote = state.templateStack.pop();
      if (quote !== undefined) state.stringQuote = quote;
    }
    state.i++;
    return true;
  }
  return false;
}
