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

/**
 * Narrower subset of DOM-mutation patterns that evidence a VISUAL-PROPERTY
 * mutation — the shape that can drive a flash/blink under WCAG 2.3.1
 * (Three Flashes or Below Threshold). The finder uses these alongside a
 * duration-below-333ms check (≈ >3Hz) to enrich the reason text with a
 * 2.3.1 citation; below-threshold duration is additive evidence only,
 * never a suppression gate — candidates always surface via 2.2.1/2.2.2
 * regardless of duration (see ai-first-consumer.md on numeric-threshold
 * heuristics).
 *
 * Two confidence tiers. Direct `.style.<visual-prop>` writes are high-
 * confidence — the code literally names the visual property. classList
 * changes whose class-name argument matches visual-effect vocabulary
 * (opacity, fade, blur, color, bg, background) are lower-confidence —
 * the author's class name is a hint, not a guarantee. The finder passes
 * the tier through so the reason text can annotate honestly.
 */
const DIRECT_VISUAL_STYLE_PATTERNS: readonly RegExp[] = [
  // `<any>.style.<visual-prop> = ...`
  /\.style\s*\.\s*(?:opacity|transform|filter|color|background|backgroundColor|backgroundImage|backgroundPosition|visibility)\s*=(?!=)/,
  // `<any>.style["visual-prop"] = ...` — index-access form
  /\.style\s*\[\s*["'`](?:opacity|transform|filter|color|background|background-color|background-image|background-position|visibility|backgroundColor|backgroundImage|backgroundPosition)["'`]\s*\]/,
];

/**
 * classList.(add|remove|toggle|replace) calls whose FIRST string
 * argument matches visual-effect vocabulary. This is intentionally
 * fuzzy: `"fade-in"`, `"opacity-0"`, `"bg-red"`, `"blur-md"`,
 * `"text-color-hot"` are real-world examples where the class name
 * encodes visual semantics the author meant to toggle on an interval.
 * The match is one-per-call — any argument to `.classList.add(…)` or
 * `.classList.toggle(…)` that contains one of these substrings counts.
 * Flagged as LOWER-confidence in the reason text (class names can
 * coincidentally contain these substrings without governing visuals;
 * the agent reads the surrounding code to confirm).
 */
const VISUAL_CLASSNAME_PATTERN =
  /\.classList\s*\.\s*(?:add|remove|toggle|replace)\s*\(\s*["'`][^"'`]*\b(?:opacity|fade|blur|color|bg|background)\b[^"'`]*["'`]/i;

/**
 * Static evidence tier returned by {@link callbackMutatesVisualProperty}.
 *
 * - `"direct-style"` — the callback writes to `.style.opacity`,
 *   `.style.transform`, `.style.filter`, `.style.color`, `.style.background`
 *   or similar. The code literally names the visual property; high-
 *   confidence signal that a visual property changes on each tick.
 * - `"classlist-fuzzy"` — the callback calls
 *   `classList.(add|remove|toggle)(…)` with a class-name argument
 *   containing one of {opacity, fade, blur, color, bg, background}.
 *   Lower-confidence — class names can contain these substrings
 *   coincidentally. The finder surfaces the 2.3.1 citation at this
 *   tier with an explicit "class-name heuristic" annotation so the
 *   agent knows to double-check.
 * - `null` — no visual-property mutation detected. No 2.3.1
 *   enrichment; any 2.2.1/2.2.2 citations stand on their own.
 */
type VisualMutationTier = "direct-style" | "classlist-fuzzy" | null;

/**
 * Duration (ms) below which a visual-property-mutating `setInterval`
 * crosses the WCAG 2.3.1 rate threshold (more than 3 flashes per
 * second). 1000 ms / 3 ≈ 333.3 ms — any interval at or below 333ms
 * causes the callback to run at or above 3Hz.
 *
 * Doctrinally: this is NOT a suppression threshold. The candidate
 * always surfaces via 2.2.1/2.2.2; the duration determines only
 * whether 2.3.1 is additionally cited. A duration above the threshold
 * simply means there's no *additional* 2.3.1 evidence — it does not
 * mean the candidate is withheld.
 */
const FLASH_THRESHOLD_MS = 333;

/**
 * Resolved flash-threshold evidence for a single `setInterval` call.
 * `null` (from {@link evaluateFlashThreshold}) means the 2.3.1
 * citation is not warranted — either the callback doesn't statically
 * mutate a visual property, or the duration is not a literal at or
 * below {@link FLASH_THRESHOLD_MS}.
 */
export interface FlashEvidence {
  readonly tier: NonNullable<VisualMutationTier>;
  readonly durationMs: number;
  readonly rateHz: number;
}

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
  return anyCallbackTextMatches(source, openParen, containsDomMutation);
}

/**
 * Returns the visual-mutation tier statically evidenced by the callback
 * of a `setInterval` call whose opening `(` is at `openParen`:
 *
 *   - `"direct-style"` — the callback writes a known visual CSS
 *     property via `.style.<prop>` or `.style["prop"]`.
 *   - `"classlist-fuzzy"` — the callback toggles/adds/removes a class
 *     whose name contains visual-effect vocabulary (opacity, fade,
 *     blur, color, bg, background). Lower-confidence — authors can
 *     pick class names that coincidentally match; the finder annotates
 *     the reason text accordingly.
 *   - `null` — no static evidence of a visual-property mutation.
 *
 * Companion signal to {@link callbackMutatesDom}; the two are stacked
 * in `timing.ts` so a DOM-mutating `setInterval` with a short duration
 * (≈ >3Hz) cites SC 2.3.1 alongside the 2.2.1/2.2.2 citations. The
 * duration threshold is applied in the finder, not here — the finder
 * decides whether to cite 2.3.1, and this probe decides whether the
 * evidence is visual at all.
 *
 * Per ai-first-consumer.md: honest silence on non-matching input is
 * the contract. We never guess a tier.
 */
function callbackMutatesVisualProperty(source: string, openParen: number): VisualMutationTier {
  let tier: VisualMutationTier = null;
  anyCallbackTextMatches(source, openParen, (text) => {
    if (containsDirectVisualStyle(text)) {
      tier = "direct-style";
      return true;
    }
    if (tier === null && containsVisualClassname(text)) {
      tier = "classlist-fuzzy";
      // Don't short-circuit — a later body (resolved identifier) may
      // upgrade to direct-style, which is strictly more informative.
      return false;
    }
    return false;
  });
  return tier;
}

/**
 * Walk the callback text (inline body and, for bare-identifier
 * callbacks, the resolved same-file function body) and apply `test` to
 * each. Returns true as soon as `test` returns true for any text; the
 * caller's closure can collect side-effects (e.g. the highest-confidence
 * tier seen) by returning false to continue scanning.
 */
function anyCallbackTextMatches(
  source: string,
  openParen: number,
  test: (text: string) => boolean,
): boolean {
  const callback = extractCallbackText(source, openParen);
  if (callback === null) return false;
  if (test(callback.text)) return true;
  if (callback.identifier === null) return false;
  const body = findFunctionBodyByName(source, callback.identifier, openParen);
  if (body === null) return false;
  return test(body);
}

function containsDomMutation(text: string): boolean {
  for (const pattern of DOM_MUTATION_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function containsDirectVisualStyle(text: string): boolean {
  for (const pattern of DIRECT_VISUAL_STYLE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function containsVisualClassname(text: string): boolean {
  return VISUAL_CLASSNAME_PATTERN.test(text);
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

/* -- WCAG 2.3.1 flash-rate evaluation ------------------------------------- */

/**
 * Decide whether the callback at `openParen` meets the SC 2.3.1
 * evidence bar: visual-property mutation AND literal duration at or
 * below {@link FLASH_THRESHOLD_MS}. Returns the tier + resolved
 * duration + flash rate or null when the evidence is insufficient.
 *
 * Used by `timing.ts` to decide whether to attach wcag22:2.3.1 +
 * wcag21:2.3.1 to a setInterval candidate. The citation is additive —
 * a null return here does NOT suppress the candidate; the candidate
 * still surfaces via 2.2.1 / 2.2.2. See ai-first-consumer.md on
 * numeric-threshold heuristics.
 */
export function evaluateFlashThreshold(
  source: string,
  openParen: number,
  rawDuration: string | null,
): FlashEvidence | null {
  const tier = callbackMutatesVisualProperty(source, openParen);
  if (tier === null) return null;
  const durationMs = resolveDurationLiteral(source, rawDuration);
  if (durationMs === null) return null;
  if (durationMs > FLASH_THRESHOLD_MS || durationMs <= 0) return null;
  return { tier, durationMs, rateHz: 1000 / durationMs };
}

/**
 * Build the SC 2.3.1 clause that gets appended to the timing
 * candidate's reason text. The rate is rounded to the nearest integer
 * for legibility ("~33Hz" vs "~33.333Hz"); the raw duration literal
 * is already echoed by the earlier `duration \`...\`` clause, so the
 * clause stays focused on the flash-rate framing.
 *
 * When the evidence tier is `classlist-fuzzy` (class name contains
 * visual vocabulary but no direct `.style` write), the clause
 * includes an explicit heuristic annotation so the agent knows the
 * visual-property inference is weaker than a direct style mutation.
 */
export function flashClause(flash: FlashEvidence): string {
  const rate = Math.round(flash.rateHz);
  const heuristicNote =
    flash.tier === "classlist-fuzzy"
      ? " (visual-property inference is from the classList argument's name — heuristic; verify the class actually governs a visual property)"
      : "";
  return `note: callback runs at ~${rate}Hz — if the visual effect is a flash/blink, verify against SC 2.3.1 (Three Flashes or Below Threshold: must not flash more than 3 times per second)${heuristicNote}.`;
}

/**
 * Resolve the duration expression to a numeric millisecond literal,
 * one hop at most. Accepts:
 *
 *   - numeric literal: `30`, `30_000`, `0.5`, `.5`
 *   - numeric-binding identifier: `setInterval(cb, DELAY)` where the
 *     same file contains `const DELAY = 30;` (or `let` / `var`).
 *
 * Returns null for non-literal expressions (`Math.random() * 1000`,
 * `config.interval`, `this._config.delay`) — the 2.3.1 citation is
 * withheld when the evidence is insufficient. The candidate still
 * surfaces via 2.2.1/2.2.2; this resolver only decides whether the
 * 2.3.1 clause attaches.
 */
function resolveDurationLiteral(source: string, rawDuration: string | null): number | null {
  if (rawDuration === null) return null;
  const direct = parseNumericLiteral(rawDuration);
  if (direct !== null) return direct;
  if (!/^[A-Za-z_$][\w$]*$/.test(rawDuration)) return null;
  return resolveSameFileNumericBinding(source, rawDuration);
}

/**
 * Parse a single JS numeric literal. Accepts underscore separators
 * (`30_000`) and leading-dot decimals (`.5`). Returns null for
 * anything else — member expressions, arithmetic, function calls, or
 * identifiers.
 */
function parseNumericLiteral(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d[\d_]*(\.\d[\d_]*)?$|^\.\d[\d_]*$/.test(trimmed)) return null;
  const normalized = trimmed.replace(/_/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Walk the source for a same-file binding `const|let|var <name> =
 * <numeric-literal>;` and return the literal value. Single hop only
 * (no chained re-bindings) — per the probe's narrow contract; the
 * agent reading the file does the rest.
 *
 * The pattern tolerates TypeScript annotations (`const N: number = 30`)
 * and the `as const` suffix (`const N = 30 as const`).
 */
function resolveSameFileNumericBinding(source: string, name: string): number | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$1");
  const pattern = new RegExp(
    String.raw`\b(?:const|let|var)\s+${escaped}\b(?:\s*:\s*[A-Za-z_$][\w$.<>\s,|&\[\]]*)?\s*=\s*([^;\n]+?)(?:\s+as\s+const)?\s*(?:;|$|\n)`,
    "m",
  );
  const match = pattern.exec(source);
  if (!match) return null;
  return parseNumericLiteral(match[1] ?? "");
}
