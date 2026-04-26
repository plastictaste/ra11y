/**
 * Candidate finder: review/timing
 * Criteria: wcag22:2.2.1 (timing adjustable, A)
 *           wcag22:2.2.3 (no timing, AAA)
 *           wcag22:2.2.4 (interruptions, AAA)
 *           wcag22:2.2.5 (re-authenticating, AAA)
 *           wcag22:2.2.6 (timeouts, AAA)
 *
 * Spec:  https://www.w3.org/TR/WCAG22/#timing-adjustable
 *        https://www.w3.org/TR/WCAG22/#no-timing
 *        https://www.w3.org/TR/WCAG22/#interruptions
 *        https://www.w3.org/TR/WCAG22/#re-authenticating
 *        https://www.w3.org/TR/WCAG22/#timeouts
 *
 * Surfaces two concrete signals of time-dependent behavior the reviewer
 * must evaluate: HTML <meta http-equiv="refresh"> and JS calls to
 * setTimeout / setInterval. Per CLAUDE.md §1 we don't try to guess
 * whether the duration is long enough to need a user control, whether
 * the interval is "essential" under the WCAG exception, or whether a
 * setTimeout is a session timeout vs a cosmetic debounce — those are
 * judgments the reviewer makes from the surrounding code. We also
 * don't classify user-facing-ness by filename: `authManager` might
 * house a real session timeout, `useDebouncedCallback` might govern
 * user-perceived responsiveness. Filename regex hints risked confident
 * wrong output the agent couldn't tell to mistrust (CLAUDE.md §1,
 * "don't duplicate capability the agent already has"), so the reason
 * text names the common dismissal categories generically instead.
 *
 * Two reason-text enrichments operate on this principle:
 *
 *   - Duration-class hint: when the second argument is not a numeric
 *     literal (e.g. `self.options.interval`, `getDelay()`, `delay`),
 *     the reason names the kind of expression so the agent knows it
 *     must resolve a binding before deciding whether the duration is
 *     long enough to need a user control. Critical for vendor bundles
 *     where every duration is a member-access into a config object.
 *   - Vendor-bundle filename hint: when the cited file's basename
 *     matches a canonical vendor library bundle name (`bootstrap.js`,
 *     `jquery-1.10.2.js`, `popper.js`, etc.), the reason notes that
 *     the call site appears to be third-party library internals. The
 *     candidate stays in the primary list at medium confidence; the
 *     hint is additive context the agent uses to dismiss in one read.
 *     Per ai-first-consumer.md we explicitly do NOT silence on this
 *     signal — the dedicated content-level vendor-banner detector
 *     (V1-VENDOR-LIBRARY-BANNER-DETECTION) is not yet shipped and the
 *     filename match is a heuristic. Annotation, not suppression.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  truncateForEcho,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  JsxElement,
  SourcePosition,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import type { RuleContext } from "../../types/rule.ts";
import {
  callbackMutatesDom,
  evaluateFlashThreshold,
  type FlashEvidence,
  flashClause,
} from "./timing-dom-mutation.ts";
import { isMinifiedForEnrichment, minifiedLocatorClause } from "./timing-minified.ts";
import {
  durationClassClause,
  isVendorBundleBasename,
  vendorBundleClause,
} from "./timing-vendor.ts";

const CRITERION_IDS = [
  "wcag22:2.2.1",
  "wcag21:2.2.1",
  "wcag22:2.2.3",
  "wcag21:2.2.3",
  "wcag22:2.2.4",
  "wcag21:2.2.4",
  "wcag22:2.2.5",
  "wcag21:2.2.5",
  "wcag22:2.2.6",
  "wcag21:2.2.6",
] as const;

/**
 * Additional criterion IDs attached when a `setInterval` callback is
 * statically observed to mutate DOM state. A repeating DOM mutation is
 * the canonical shape of "auto-updating information" under 2.2.2
 * Pause, Stop, Hide — the agent needs to see 2.2.2 next to 2.2.1 on
 * the same site so both the "is the duration long enough to need a
 * user control?" (2.2.1) and "does this auto-advancing content have a
 * pause mechanism?" (2.2.2) questions get asked from the same finding.
 */
const PAUSE_STOP_HIDE_CRITERIA = ["wcag22:2.2.2", "wcag21:2.2.2"] as const;

/**
 * Additional criterion IDs attached when a `setInterval` callback
 * mutates a visual property AND the duration literal is below the
 * flash-rate threshold (see {@link evaluateFlashThreshold}). SC 2.3.1
 * Three Flashes or Below Threshold forbids content that flashes more
 * than three times per second; a repeating visual-property mutation
 * at that rate is the exact shape the criterion addresses. The
 * citation is additive — the finder never suppresses the candidate
 * on duration alone (see ai-first-consumer.md on numeric-threshold
 * heuristics). Candidates always surface via 2.2.1 / 2.2.2; 2.3.1
 * joins the criterion set only when the evidence supports it.
 */
const FLASH_THRESHOLD_CRITERIA = ["wcag22:2.3.1", "wcag21:2.3.1"] as const;

/** Source-text patterns for JS timing APIs. */
const SOURCE_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly label: string;
  readonly isInterval: boolean;
}[] = [
  {
    pattern: /\bsetInterval\s*\(/g,
    label: "setInterval() call",
    isInterval: true,
  },
  {
    pattern: /\bsetTimeout\s*\(/g,
    label: "setTimeout() call",
    isInterval: false,
  },
];

const META_REFRESH_REASON =
  '<meta http-equiv="refresh"> — page auto-refreshes or redirects; verify the user can pause, extend, or disable the refresh per WCAG 2.2.1';

const JS_REASON_PREFIX =
  " — verify the user can pause, extend, or disable any user-facing time limit this governs (not required for session-keepalive / debounce / animation)";

/**
 * Prepended to the reason text when a `setInterval` callback statically
 * mutates DOM state. The sentence names the missing pause UI generically
 * so the agent knows what to look for without a heuristic pretending the
 * UI is definitely absent — see ai-first-consumer.md on reason-text
 * enrichment over heuristic suppression.
 */
const PAUSE_STOP_HIDE_PREFIX =
  "This `setInterval` callback mutates DOM state and may be driving auto-advancing visual motion. WCAG 2.2.2 (Pause, Stop, Hide) requires a user-controllable pause/stop/hide mechanism for auto-updating content running longer than 5 seconds; verify such a control exists and is keyboard-accessible. ";

export const finder = defineCandidateFinder({
  id: "review/timing",
  criterionIds: [...CRITERION_IDS, ...PAUSE_STOP_HIDE_CRITERIA],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx", ".ts", ".js"] },
  docs: {
    description:
      'Finds <meta http-equiv="refresh"> and setTimeout/setInterval calls — signals of time-dependent behavior that require a user control under WCAG 2.2.x.',
    reviewPrompt:
      "For each location, determine what the timer governs. If it imposes a user-facing time limit (session timeout, auto-advancing carousel, form timeout, re-auth), verify the user can turn it off, adjust it, or extend it with 20 s warning. If it is essential (auctions, real-time events) or not user-facing (debounce, polling, animation frame scheduling), no action is needed.",
    references: [
      "https://www.w3.org/TR/WCAG22/#timing-adjustable",
      "https://www.w3.org/TR/WCAG22/#no-timing",
      "https://www.w3.org/TR/WCAG22/#interruptions",
      "https://www.w3.org/TR/WCAG22/#re-authenticating",
      "https://www.w3.org/TR/WCAG22/#timeouts",
    ],
  },
  find(ctx) {
    const out: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      for (const el of findMetaRefreshHtml(ctx.ast as HtmlDocument)) {
        emitAtLocation(el.loc.start, META_REFRESH_REASON, ctx.filePath, out);
      }
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      for (const el of findMetaRefreshJsx(ctx.ast as TsxModule)) {
        emitAtLocation(el.loc.start, META_REFRESH_REASON, ctx.filePath, out);
      }
    }
    findSourceCandidates(ctx, out);
    return out;
  },
});

function findMetaRefreshHtml(doc: HtmlDocument): readonly HtmlElement[] {
  const hits: HtmlElement[] = [];
  for (const el of findHtmlElementsByTag(doc, "meta")) {
    const attr = el.attributes.find((a) => a.name.toLowerCase() === "http-equiv");
    if (!attr || attr.value === null) continue;
    if (attr.value.toLowerCase().trim() === "refresh") hits.push(el);
  }
  return hits;
}

function findMetaRefreshJsx(module: TsxModule): readonly JsxElement[] {
  const hits: JsxElement[] = [];
  for (const el of findJsxElementsByTag(module, "meta")) {
    const attr = el.attributes.find((a) => a.name === "http-equiv" || a.name === "httpEquiv");
    if (!attr) continue;
    if (attr.value?.kind !== "StringLiteral") continue;
    if (attr.value.value.toLowerCase().trim() === "refresh") hits.push(el);
  }
  return hits;
}

function findSourceCandidates(ctx: RuleContext, out: ReviewCandidate[]): void {
  const seen = new Set<number>();
  for (const { pattern, label, isInterval } of SOURCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of ctx.source.matchAll(pattern)) {
      const offset = match.index ?? 0;
      if (seen.has(offset)) continue;
      seen.add(offset);
      emitJsCandidates(ctx, out, offset, match[0].length, label, isInterval);
    }
  }
}

/**
 * Emit one review candidate per equivalent criterion for a single
 * setTimeout/setInterval call site. Reason text is enriched additively
 * with the duration argument and the enclosing function name so the
 * agent has the dismissal signal inline — per AI-first consumer
 * doctrine, annotation instead of suppression.
 *
 * For `setInterval` calls whose callback statically mutates DOM state
 * (style/class/attribute/innerHTML/etc.), the reason is further
 * prepended with a Pause-Stop-Hide sentence and two additional
 * candidates are emitted under `wcag22:2.2.2` / `wcag21:2.2.2` so the
 * finding is also discoverable through a 2.2.2 criterion filter. The
 * DOM-mutation signal is probe-level — a false positive (e.g. a DOM
 * mutation that represents an *essential* animation, or one guarded
 * by a pause control the scanner can't see) still surfaces and the
 * agent dismisses by reading, per surface-don't-suppress doctrine.
 */
function emitJsCandidates(
  ctx: RuleContext,
  out: ReviewCandidate[],
  offset: number,
  matchLength: number,
  label: string,
  isInterval: boolean,
): void {
  const { line, column } = offsetToLineColumn(ctx.source, offset);
  const openParen = offset + matchLength - 1;
  const duration = extractDurationArg(ctx.source, openParen);
  const durationClassSuffix = duration ? durationClassClause(duration) : "";
  const durationClause = duration ? ` with duration \`${duration}\`${durationClassSuffix}` : "";
  const enclosing = describeEnclosingFunction(ctx.source, offset);
  const enclosingClause = enclosing ? ` in \`${enclosing}\`` : "";
  const coreReason = `${label}${durationClause}${enclosingClause}${JS_REASON_PREFIX}`;
  const pauseStopHide = isInterval && callbackMutatesDom(ctx.source, openParen);
  const flash = isInterval ? evaluateFlashThreshold(ctx.source, openParen, duration) : null;
  const minifiedClause = minifiedLocatorClause(ctx.filePath, ctx.source, offset);
  const vendorClause = vendorBundleClause(ctx.filePath);
  const reason = buildReason(coreReason, pauseStopHide, flash, minifiedClause, vendorClause);
  const criteriaForSite = buildCriteriaForSite(pauseStopHide, flash !== null);
  // Structured-evidence fields complementing the reason-text enrichment.
  // Per ai-first-consumer.md the agent should not have to parse free-form
  // text to read the dismissal evidence — surface the same signals as
  // typed booleans / tagged numbers so threshold-free triage stays cheap.
  // Both fields are present-when-meaningful (omitted when the predicate
  // doesn't fire / no duration to report).
  const vendorPathHint =
    isVendorBundleBasename(ctx.filePath) || isMinifiedForEnrichment(ctx.filePath, ctx.source);
  const durationLiteralMs = duration ? parseDurationLiteralMs(duration) : undefined;
  for (const criterionId of criteriaForSite) {
    // Confidence "medium": setTimeout/setInterval is concrete evidence
    // of a timer, but the reviewer's question — "does this govern a
    // user-facing time limit?" — depends on what the timer actually
    // does. Session-keepalive vs debounce vs animation are
    // indistinguishable from the call site alone. Per CLAUDE.md §1 we
    // don't gate on duration thresholds; the agent reading the
    // surrounding code is the only correct arbiter, so we surface at
    // medium and let the reason text carry the dismissal vocabulary.
    out.push({
      criterionId,
      location: { filePath: ctx.filePath, line, column },
      reason,
      confidence: "medium",
      ...(vendorPathHint ? { vendorPathHint: true } : {}),
      ...(durationLiteralMs === undefined ? {} : { durationLiteralMs }),
    });
  }
}

/**
 * Parse the duration argument echoed by {@link extractDurationArg}
 * into a millisecond count when the value is a numeric literal that
 * resolves cleanly, or `"non-literal"` when it is any other shape
 * (member access, identifier, call expression, computed expression,
 * unary, parenthesised, etc.).
 *
 * Mirrors the literal/non-literal split used by
 * {@link durationClassClause} so the structured field
 * `ReviewCandidate.durationLiteralMs` and the reason-text clause
 * agree on the same call site (a clause that says "member-access
 * reference" cannot ship next to a structured `durationLiteralMs:
 * 300` — the channels would silently disagree).
 *
 * Numeric literal forms accepted: integer, decimal, exponent, hex,
 * binary, octal, and BigInt (truncated to Number — the agent reading
 * the value still sees the cited verbatim string in the reason text
 * if precision matters), with optional `_` separators. BigInt's `n`
 * suffix is stripped before parsing. `+1000` / `-1000` /
 * parenthesised forms fall through to `"non-literal"` to match the
 * reason-text classifier's "expression" bucket.
 */
function parseDurationLiteralMs(duration: string): number | "non-literal" {
  const text = duration.trim();
  // Use the same literal-shape regex the reason-text classifier uses
  // (NUMERIC_LITERAL_PATTERN in timing-vendor.ts). Mirroring the
  // pattern locally avoids a circular import while keeping the two
  // channels in lockstep — see classifyDurationExpression.
  const literalMatch =
    /^(?:0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]+)?)n?$/.exec(text);
  if (!literalMatch) return "non-literal";
  // Strip BigInt suffix and `_` separators before Number parsing.
  const cleaned = text.replace(/n$/, "").replace(/_/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return "non-literal";
  return parsed;
}

/**
 * Assemble the final reason text from the enrichment layers. Order
 * matters:
 *
 *   1. Pause-Stop-Hide prefix (2.2.2) when it applies — this is the
 *      most general framing and sets context.
 *   2. The core reason (label + duration + duration-class + enclosing
 *      + JS suffix). Duration-class enrichment (member-access /
 *      identifier / call / expression) sits inside the core string
 *      so the per-duration test assertions stay co-located with the
 *      duration echo they describe.
 *   3. SC 2.3.1 clause suffixed when visual-flash evidence applies —
 *      "note: callback runs at ~N Hz…". Suffixed (not prefixed) so
 *      existing assertions on `coreReason`/`PAUSE_STOP_HIDE_PREFIX`
 *      keep passing.
 *   4. Minified-file locator clause suffixed when the file is
 *      minified (Q6-MINIFIED-FILE-SNIPPET-COLUMN-ENRICHMENT) — the
 *      cited `line:column` pointer alone is unhelpful on a single-
 *      line file, so this clause adds the byte-column offset and a
 *      ~80-char context window so the agent can locate the specific
 *      call-site among N same-line matches.
 *   5. Vendor-bundle filename clause suffixed when the cited file's
 *      basename matches a canonical vendor library bundle name
 *      (V1-FINDER-2.2.1-SETTIMEOUT-VENDOR-FILE-GATE). The clause
 *      surfaces the dismissal hint inline so the agent can choose to
 *      open the file or move on after one read; per ai-first-consumer
 *      doctrine the candidate is NEVER suppressed on this signal.
 */
function buildReason(
  coreReason: string,
  pauseStopHide: boolean,
  flash: FlashEvidence | null,
  minifiedClause: string,
  vendorClause: string,
): string {
  const prefix = pauseStopHide ? PAUSE_STOP_HIDE_PREFIX : "";
  const flashSuffix = flash ? ` ${flashClause(flash)}` : "";
  return `${prefix}${coreReason}${flashSuffix}${minifiedClause}${vendorClause}`;
}

/**
 * Assemble the criterion-ID set for a single call site. The base
 * CRITERION_IDS always apply; 2.2.2 is added when the callback
 * statically mutates the DOM; 2.3.1 is added when visual-property
 * mutation + sub-333ms literal duration both hold. The sets stack —
 * a carousel that mutates both a `.style.transform` AND runs at 30ms
 * cites 2.2.1 + 2.2.2 + 2.3.1 at the same file:line.
 */
function buildCriteriaForSite(pauseStopHide: boolean, flash: boolean): readonly string[] {
  const ids: string[] = [...CRITERION_IDS];
  if (pauseStopHide) ids.push(...PAUSE_STOP_HIDE_CRITERIA);
  if (flash) ids.push(...FLASH_THRESHOLD_CRITERIA);
  return ids;
}

/**
 * Scanner state for `extractDurationArg`. Kept in an object so the
 * per-character advance functions can share it without the outer loop
 * exploding in cognitive complexity.
 */
interface ArgScanState {
  i: number;
  depth: number;
  stringQuote: number; // 0 | 39 ' | 34 " | 96 `
  inLineComment: boolean;
  inBlockComment: boolean;
  readonly templateStack: number[];
}

/**
 * Extract the duration argument — second argument of a setTimeout /
 * setInterval call — verbatim, starting at the opening paren `openParen`.
 *
 * Scans forward, tracking nesting of parens/brackets/braces and the three
 * string kinds (`'…'`, `"…"`, `` `…` ``) plus line and block comments, so
 * that we skip over commas inside the callback argument (e.g. arrow body
 * `(a, b) => …`) and only count the top-level comma that separates the
 * call's arguments. The slice between that comma and the matching
 * close-paren is the duration expression as written — `300`, `delay`,
 * `this._config.delay`, etc. Passed through `truncateForEcho` so a
 * pathological computed-duration expression can't balloon the reason.
 *
 * Template-literal substitutions (`${…}`) are treated as balanced spans
 * that re-enter the regular scanning mode. This is sufficient for the
 * shapes that appear at real setTimeout/setInterval call sites — the
 * goal is to echo what the author typed, not to parse JS.
 */
function extractDurationArg(source: string, openParen: number): string | null {
  if (!isOpenParenAt(source, openParen)) return null;
  const state: ArgScanState = {
    i: openParen + 1,
    depth: 1,
    stringQuote: 0,
    inLineComment: false,
    inBlockComment: false,
    templateStack: [],
  };
  const firstCommaIdx = scanToFirstTopLevelComma(source, state);
  if (firstCommaIdx === null) return null;
  const argStart = firstCommaIdx + 1;
  const argEnd = scanToArgEnd(source, state);
  if (argEnd === null) return null;
  return sliceDuration(source, argStart, argEnd);
}

function isOpenParenAt(source: string, offset: number): boolean {
  return offset >= 0 && offset < source.length && source.charCodeAt(offset) === 40 /* ( */;
}

/**
 * Advance `state` until a top-level `,` separating call arguments is
 * seen. Returns the offset of that comma, or null if the call closes
 * (`)`) before any top-level comma — which means there's no duration
 * argument to extract.
 */
function scanToFirstTopLevelComma(source: string, state: ArgScanState): number | null {
  while (state.i < source.length) {
    if (advanceThroughNonCode(source, state)) continue;
    const c = source.charCodeAt(state.i);
    const preIdx = state.i;
    if (handleBracket(state, c)) {
      if (state.depth === 0) return null;
      continue;
    }
    if (c === 44 /* , */ && state.depth === 1) return preIdx;
    state.i++;
  }
  return null;
}

/**
 * Continue advancing from just past the first top-level comma, ending
 * at whichever comes first — the next top-level `,` (start of the third
 * argument) or the matching close-paren of the outer call. Returns the
 * offset of that terminator (exclusive upper bound for the duration
 * slice), or null if we run off the end without finding one.
 */
function scanToArgEnd(source: string, state: ArgScanState): number | null {
  state.i++;
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

/**
 * If `c` is an open or close bracket, apply its effect to `state.depth`
 * (and, for `}`, resume any template-literal scope) and advance past
 * it. Returns true when the character was a bracket, so the caller's
 * loop knows to continue without re-handling it.
 */
function handleBracket(state: ArgScanState, c: number): boolean {
  if (isOpenBracket(c)) {
    state.depth++;
    state.i++;
    return true;
  }
  if (isCloseBracket(c)) {
    handleCloseBracket(state, c);
    state.i++;
    return true;
  }
  return false;
}

/**
 * Advance past the current character when it is inside a comment or a
 * string literal. Returns true when the character was consumed as
 * non-code (caller should `continue`), false when the character is part
 * of regular code and the caller must handle it.
 */
function advanceThroughNonCode(source: string, state: ArgScanState): boolean {
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
  // Comment opens and string opens are non-code transitions we handle
  // here so the outer loop doesn't also need to branch on them.
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
  if (c === 39 || c === 34 || c === 96) {
    state.stringQuote = c;
    state.i++;
    return true;
  }
  return false;
}

function advanceInsideString(source: string, state: ArgScanState, c: number): void {
  if (c === 92 /* \ */) {
    state.i += 2;
    return;
  }
  if (
    state.stringQuote === 96 &&
    c === 36 /* $ */ &&
    source.charCodeAt(state.i + 1) === 123 /* { */
  ) {
    // `${` inside a template — re-enter regular scanning, remembering
    // to re-enter the template when we hit the matching `}`.
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

function handleCloseBracket(state: ArgScanState, c: number): void {
  state.depth--;
  if (c === 125 /* } */ && state.templateStack.length > 0 && state.depth > 0) {
    // Re-enter the template literal that opened this ${…}.
    const quote = state.templateStack.pop();
    if (quote !== undefined) state.stringQuote = quote;
  }
}

function isOpenBracket(c: number): boolean {
  return c === 40 /* ( */ || c === 91 /* [ */ || c === 123 /* { */;
}

function isCloseBracket(c: number): boolean {
  return c === 41 /* ) */ || c === 93 /* ] */ || c === 125 /* } */;
}

function sliceDuration(source: string, start: number, end: number): string | null {
  const raw = source.slice(start, end).trim();
  if (!raw) return null;
  // Collapse interior whitespace (including newlines) so the reason
  // string stays on one line when the duration was written across
  // multiple lines.
  const collapsed = raw.replace(/\s+/g, " ");
  return truncateForEcho(collapsed, 80);
}

/**
 * Text-level probe for the name of the function/method enclosing `offset`.
 *
 * Walks backward from `offset` tracking brace depth (ignoring braces
 * inside strings and comments). At the first unmatched `{` — the opener
 * of the enclosing block — inspects the preceding text for common
 * function-declaration shapes and returns the name followed by `()`
 * for use in a backticked reason clause.
 *
 * Recognised shapes (matched most-specific first):
 *   - `function foo(…) {`          → `foo()`
 *   - `foo(…) {`                   → `foo()` (method shorthand)
 *   - `foo: function (…) {`        → `foo()`
 *   - `foo = (…) => {`             → `foo()`
 *   - `foo = function (…) {`       → `foo()`
 *
 * Returns `null` when the enclosing block is not a function (e.g. the
 * call is at module scope), the function is anonymous/computed, or the
 * pattern isn't recognised. We never guess a name — honest omission is
 * the AI-first default (see ai-first-consumer.md on ambiguous-field
 * shapes).
 */
function describeEnclosingFunction(source: string, offset: number): string | null {
  // Walk backward tracking brace depth. Skip over strings & comments in
  // the coarsest way that works: we only look at `{` and `}` characters
  // that aren't immediately preceded by a backslash. Because this walks
  // backward, a precise string/comment scan is expensive; the approx is
  // adequate for reason-text enrichment (a missed match → no clause,
  // which is the honest default).
  let depth = 0;
  let i = offset - 1;
  while (i >= 0) {
    const c = source.charCodeAt(i);
    if (c === 125 /* } */) {
      depth++;
    } else if (c === 123 /* { */) {
      if (depth === 0) {
        return nameBeforeBrace(source, i);
      }
      depth--;
    }
    i--;
  }
  return null;
}

/**
 * Given the offset of an opening `{`, inspect the preceding source text
 * for a function-signature-like header and return the name (with `()`
 * suffix) when recognised.
 */
function nameBeforeBrace(source: string, braceOffset: number): string | null {
  const parenOpen = findParamListOpenParen(source, braceOffset);
  if (parenOpen === null) return null;
  const tail = source.slice(Math.max(0, parenOpen - 200), parenOpen);
  return matchFunctionHeader(tail);
}

/**
 * Walk backward from an opening `{` to the `(` that opens the preceding
 * parameter list. Returns the `(` offset, or null when the `{` is not
 * preceded by a syntactically-plausible parameter list.
 */
function findParamListOpenParen(source: string, braceOffset: number): number | null {
  let i = skipWsBackward(source, braceOffset - 1);
  // Arrow body: `…) => {` — skip past `=>`.
  if (i >= 1 && source.charCodeAt(i) === 62 /* > */ && source.charCodeAt(i - 1) === 61 /* = */) {
    i = skipWsBackward(source, i - 2);
  }
  // We now expect a `)` that closes the parameter list.
  if (i < 0 || source.charCodeAt(i) !== 41 /* ) */) return null;
  return matchOpenParenBackward(source, i - 1);
}

/**
 * From `startOffset`, walk backward through a parenthesised group and
 * return the offset of the `(` that matches the already-consumed `)`.
 */
function matchOpenParenBackward(source: string, startOffset: number): number | null {
  let depth = 1;
  let i = startOffset;
  while (i >= 0 && depth > 0) {
    const c = source.charCodeAt(i);
    if (c === 41) depth++;
    else if (c === 40) {
      depth--;
      if (depth === 0) return i;
    }
    i--;
  }
  return null;
}

function skipWsBackward(source: string, start: number): number {
  let i = start;
  while (i >= 0 && isWs(source.charCodeAt(i))) i--;
  return i;
}

// Reserved words that are NOT functions but whose grammar also produces
// a `<word>(…) {` shape (`if (…) { … }`, `for (…) { … }`, etc.). If the
// method-shorthand regex matches one of these the probe must return null
// rather than label a control-flow block as a function.
const CONTROL_FLOW_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "catch",
  "try",
  "finally",
  "with",
  "return",
  "throw",
  "typeof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "yield",
  "await",
  "case",
  "default",
  "break",
  "continue",
]);

const METHOD_MODIFIER_KEYWORDS: ReadonlySet<string> = new Set([
  "static",
  "async",
  "get",
  "set",
  "public",
  "private",
  "protected",
  "readonly",
]);

const FN_DECL_PATTERN =
  /(?:^|[\s;{}(),=?:&|!+\-*/%<>[\]])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*$/;
const METHOD_PATTERN =
  /(?:^|[\s;{},])(?:(?:static|async|get|set|public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*$/;
const ASSIGNED_PATTERN =
  /(?:^|[\s;{},(])([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\s*\*?\s*)?$/;

/**
 * Match one of the recognised function-header shapes in `tail` (the
 * source slice ending at the parameter-list `(`) and return the name
 * with a `()` suffix.
 */
function matchFunctionHeader(tail: string): string | null {
  // `function name(` or `function* name(` or `async function name(`
  const fnDecl = FN_DECL_PATTERN.exec(tail);
  if (fnDecl?.[1]) return `${fnDecl[1]}()`;
  const methodName = matchMethodShorthand(tail);
  if (methodName) return `${methodName}()`;
  // Assignment shapes: `name = (...) =>`, `name = function (...)`,
  // `name: function (...)`, `name: (...) =>`. The `function` keyword
  // version was already caught by fnDecl when named; here we catch the
  // binding name to the left of `=` or `:`.
  const assigned = ASSIGNED_PATTERN.exec(tail);
  if (assigned?.[1]) return `${assigned[1]}()`;
  return null;
}

/**
 * Detect a method-shorthand header (`foo(…) {` or `static foo(…) {`).
 * Rejects control-flow keywords and ordinary call expressions, which
 * also match the regex but are not function definitions.
 */
function matchMethodShorthand(tail: string): string | null {
  const match = METHOD_PATTERN.exec(tail);
  const name = match?.[1];
  if (!(match && name)) return null;
  if (CONTROL_FLOW_KEYWORDS.has(name)) return null;
  // Disambiguate against call expressions. A method definition is
  // preceded by `{`, `,`, `;`, start-of-input, or a modifier keyword —
  // NOT by an operator or another identifier.
  const identStart = match.index + match[0].indexOf(name);
  const beforeIdent = tail.slice(0, identStart).trimEnd();
  if (beforeIdent === "") return name;
  const lastChar = beforeIdent.slice(-1);
  if (lastChar === "{" || lastChar === "," || lastChar === ";") return name;
  const lastWord = /(\w+)$/.exec(beforeIdent)?.[1] ?? "";
  if (METHOD_MODIFIER_KEYWORDS.has(lastWord)) return name;
  return null;
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function emitAtLocation(
  pos: SourcePosition,
  reason: string,
  filePath: string,
  out: ReviewCandidate[],
): void {
  for (const criterionId of CRITERION_IDS) {
    // Confidence "high": `<meta http-equiv="refresh">` is a
    // deterministic, single-purpose signal — the page IS auto-
    // refreshing. The reviewer just confirms the user control.
    out.push({
      criterionId,
      location: { filePath, line: pos.line, column: pos.column },
      reason,
      confidence: "high",
    });
  }
}

function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  const cap = Math.min(offset, source.length);
  for (let i = 0; i < cap; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}
