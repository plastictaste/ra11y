/**
 * Helpers for the `kind: "guidance"` response shape in `suggest_fix`.
 *
 * Q-SHARED-SUGGEST-FIX-GUIDANCE-PRIMARY: guidance responses nest
 * `approach` + `explanation` + `sourceContext` + `confidence` under
 * a ranked `primary` block to match the tool description's advertised
 * contract. `alternatives` is present-when-meaningful (CLAUDE.md §1
 * "Ambiguous field shapes are dishonest") and carries `{ approach,
 * explanation }` entries derived from the rule's structured
 * `FixPath[]`.
 *
 * Lives in its own file so `tool-suggest-fix-internals.ts` stays under
 * the 150-LOC MCP-handler budget; the guidance builder imports these
 * pure helpers directly.
 */

import type { FixPath } from "../types/violation.ts";

/**
 * Machine-parseable verify hint shared across every `suggest_fix`
 * outcome. Lives here (rather than in the main internals file) so both
 * `tool-suggest-fix-internals.ts` and `tool-suggest-fix-fixpaths.ts`
 * can reference it without creating a circular import between them.
 *
 * `tool` is always `"scan_file"` — the narrowest, most deterministic
 * verify surface (one file, one pass). `scan_project` is deliberately
 * NOT used here: broader scans dilute the honest signal ("did this
 * specific fix land?") with unrelated findings and cost the agent a
 * slower round-trip.
 *
 * `verifyRuleId` sits as a sibling of `args` (not inside it) because
 * `scan_file` has no `ruleId` parameter — encoding it in `args` would
 * emit an undeclared key against the tool's inputSchema. Agents that
 * want to post-filter the verify scan to only this rule can read it
 * here.
 */
export interface VerifyCommandStructured {
  readonly tool: "scan_file";
  readonly args: {
    readonly path: string;
  };
  readonly verifyRuleId: string;
}

/**
 * Common abbreviations whose periods must not be treated as sentence
 * terminators. Kept explicit and small — agent fix prose frequently
 * uses `e.g.` / `i.e.` mid-clause, and breaking on the inner period
 * truncated the `approach` label to e.g. `"Try a sibling — e"`. Each
 * entry is the abbreviation as it appears in prose, lower-cased; the
 * search matches case-insensitively. Add new entries here when a real
 * fix-suggestion explanation surfaces a regression.
 */
const SENTENCE_SPLIT_ABBREVIATIONS: readonly string[] = [
  "e.g.",
  "i.e.",
  "vs.",
  "etc.",
  "cf.",
  "viz.",
];

/**
 * Test whether one of the abbreviations in
 * `SENTENCE_SPLIT_ABBREVIATIONS`, anchored at `start`, covers index
 * `idx` and sits at a word boundary on its left edge.
 */
function abbreviationCoversIndex(text: string, start: number, idx: number, abbr: string): boolean {
  const end = start + abbr.length;
  if (end > text.length) return false;
  if (start > idx || end <= idx) return false;
  if (text.slice(start, end).toLowerCase() !== abbr) return false;
  if (start === 0) return true;
  return !/[A-Za-z]/.test(text[start - 1] as string);
}

/**
 * Test whether the period at `text[idx]` falls inside one of the
 * abbreviations in `SENTENCE_SPLIT_ABBREVIATIONS`. Inner periods (the
 * `.` after `e` in `e.g.`) and trailing periods (the `.` after `g`)
 * both count — both would otherwise be misread as sentence terminators.
 *
 * For each abbreviation, slide every possible start position whose
 * range covers `idx`; if the case-insensitive slice matches the
 * abbreviation and the character preceding the abbreviation is a word
 * boundary (or start-of-string), we treat the period as
 * abbreviation-internal.
 */
function isAbbreviationPeriod(text: string, idx: number): boolean {
  for (const abbr of SENTENCE_SPLIT_ABBREVIATIONS) {
    const minStart = Math.max(0, idx - (abbr.length - 1));
    for (let start = minStart; start <= idx; start++) {
      if (abbreviationCoversIndex(text, start, idx, abbr)) return true;
    }
  }
  return false;
}

/**
 * Locate the first sentence break in `text`. Two break kinds:
 *
 * - `terminator` — a `.`, `!`, or `?` that is NOT inside an
 *   abbreviation; the candidate sentence INCLUDES the terminator
 *   (the caller strips trailing punctuation later).
 * - `newline` — the search ends at a newline; the candidate sentence
 *   STOPS at the newline (the newline itself is excluded).
 *
 * Returns the slice end-index (exclusive) for the candidate sentence,
 * or `-1` when no break is found within the search horizon.
 */
function findFirstSentenceBreakEnd(text: string, maxLen: number): number {
  const limit = Math.min(text.length, maxLen);
  for (let i = 0; i < limit; i++) {
    const ch = text[i];
    if (ch === "\n") return i; // exclude the newline
    if (ch === "!" || ch === "?") return i + 1;
    if (ch !== ".") continue;
    if (isAbbreviationPeriod(text, i)) continue;
    return i + 1;
  }
  return -1;
}

/**
 * Walk backward from `cap` to the index just past the last whitespace
 * inside `text`. Used to align a char-cap to a word boundary so the
 * `approach` label never ends mid-word ("matches the id o…"). Returns
 * `cap` itself when no whitespace precedes it (single-word prose) so
 * the caller can treat the no-walk case explicitly.
 */
function walkBackToWordBoundary(text: string, cap: number): number {
  for (let i = cap - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n") return i;
  }
  return cap;
}

/**
 * Walk backward from `cap` to before any unclosed opening backtick.
 * Backticks are paired tokens (`` `<button>` ``); splitting the pair
 * leaves a stray opener in the `approach` label that reads as a typo.
 * Returns the index just before the opening backtick, or `cap` when
 * the parity at `cap` is even (no walk needed).
 */
function walkBackBeforeUnclosedBacktick(text: string, cap: number): number {
  let openIdx = -1;
  let inside = false;
  for (let i = 0; i < cap; i++) {
    if (text[i] !== "`") continue;
    if (inside) {
      inside = false;
    } else {
      openIdx = i;
      inside = true;
    }
  }
  return inside ? openIdx : cap;
}

/**
 * Cap the `approach` label below `MAX` chars, preferring a word
 * boundary and never splitting a backtick literal. Falls back to the
 * raw cap (no ellipsis) when both walk-backs leave too little
 * meaningful prefix — a long single-word token or a backtick literal
 * starting near position 0 — because a one-char `approach` reads as
 * "tool returned nothing" (the canonical "Ambiguous field shapes are
 * dishonest" failure mode).
 *
 * Special cases:
 * - If the word-boundary walk leaves < {@link MIN_MEANINGFUL_PREFIX}
 *   chars, take the raw cap and trim trailing whitespace; no ellipsis.
 *   The agent prefers a slightly-longer-than-cap prefix it can read to
 *   a word-boundary stub it cannot.
 * - If the backtick walk leaves < {@link MIN_MEANINGFUL_PREFIX} chars,
 *   take the raw cap (the agent can mentally close the backtick from
 *   context faster than it can act on a 1-char approach).
 */
const MIN_MEANINGFUL_PREFIX = 30;

function capAtWordBoundary(text: string, cap: number): string {
  // Word-boundary walk first.
  const wsIdx = walkBackToWordBoundary(text, cap);
  let cut = wsIdx === cap ? cap : wsIdx;
  if (cut < MIN_MEANINGFUL_PREFIX) cut = cap;
  // Backtick-pair walk on the chosen cut. If we land mid-pair, walk
  // before the opener; honor the same min-meaningful guard.
  const btIdx = walkBackBeforeUnclosedBacktick(text, cut);
  if (btIdx < cut) {
    cut = btIdx >= MIN_MEANINGFUL_PREFIX ? btIdx : cap;
  }
  const prefix = text.slice(0, cut).trimEnd();
  // Append ellipsis only when we actually shortened past the raw cap
  // (the prefix sits strictly inside the original prose). When `cut`
  // equals `cap`, the trailing trim may have removed a space — still
  // worth the ellipsis because content continues past the cap.
  return cut < text.length ? `${prefix}…` : prefix;
}

/**
 * Derive a terse `approach` label from prose when the rule did not
 * supply a structured `FixPath.label` — used by the no-fixPaths
 * guidance branch where all we have is `match.suggestion` or
 * `match.message`. The label caps at the first sentence or ~80 chars
 * so the agent can glance at it; the full prose lives in `explanation`
 * alongside.
 *
 * The terminator search skips periods inside common abbreviations
 * (`e.g.`, `i.e.`, `vs.`, `etc.`, `cf.`, `viz.`) — without that, fix
 * prose like `"Try a sibling — e.g. add aria-label."` truncated to
 * `"Try a sibling — e"`.
 *
 * The char-cap fallback walks backward to a whitespace word boundary
 * and never splits a backtick literal — without those guards, the
 * label ended mid-word ("matches the id o…") or as a single stray
 * backtick when prose like `` `?expr` ... `` had the splitter return
 * a 2-char candidate that the trailing-terminator strip reduced to one
 * char. Both shapes fail "Reason / priority / fix-description must
 * agree across all three channels" — `approach` is a fix-description
 * channel and must be readable as written.
 */
export function deriveApproachFromProse(prose: string): string {
  const trimmed = prose.trim();
  const SEARCH_HORIZON = 120;
  const APPROACH_CAP = 80;
  const breakEnd = findFirstSentenceBreakEnd(trimmed, SEARCH_HORIZON);
  const candidate = breakEnd >= 0 ? trimmed.slice(0, breakEnd) : trimmed;
  // Sentence-break path produced something usable: short-enough AND
  // meaningful (or the whole prose IS short). The MIN_MEANINGFUL_PREFIX
  // gate guards against the single-backtick / single-punct shape that
  // the trailing-terminator strip used to return when the splitter
  // landed at a `?`/`!`/`.` near position 0 (e.g. `` `?expr` ... `` →
  // candidate `` `?`` → strip → `` ` ``). When the candidate is too
  // short to be meaningful AND there's substantially more prose to
  // draw from, fall through to the char-cap-with-word-boundary path.
  if (candidate.length <= APPROACH_CAP) {
    const stripped = candidate.replace(/[.!?]$/, "");
    if (stripped.length >= MIN_MEANINGFUL_PREFIX || trimmed.length <= APPROACH_CAP) {
      return stripped;
    }
  }
  return capAtWordBoundary(trimmed, APPROACH_CAP - 3);
}

/**
 * Build the `alternatives` array for `kind: "guidance"` from the
 * rule's structured `FixPath[]`. Each entry carries an `approach`
 * (from the FixPath label) and an `explanation`. We reuse the
 * structured label as the explanation when no richer prose is
 * available — the label is the explanation at that grain — but keep
 * the two fields split because the advertised contract promises both.
 * Returns `undefined` when no alternatives exist; the caller conditional-
 * spreads the field to honor "present-when-meaningful."
 */
export function buildGuidanceAlternatives(
  paths: readonly FixPath[],
): ReadonlyArray<{ readonly approach: string; readonly explanation: string }> | undefined {
  if (paths.length === 0) return undefined;
  return paths.map((p) => ({
    approach: p.label,
    explanation: p.label,
  }));
}

/**
 * Build per-call enrichment alternatives for `kind: "guidance"`
 * responses whose rule supplied no structured `FixPath` alternatives.
 *
 * The tool description advertises `kind: "guidance"` returns "a ranked
 * `primary` fix and `alternatives`." Shipping `kind: "guidance"` with
 * NO `alternatives` array makes the slot a phantom — the promise
 * dishonest (CLAUDE.md §1 "Ambiguous field shapes are dishonest"). The
 * doctrinal closure is to populate the slot with deterministic, per-
 * call enrichments derived from data the request already carries
 * (filePath + line) — never heuristics about file content.
 *
 * One enrichment path today:
 *
 *   - Verify-by-reading prompt — names the file and line the agent
 *     should open to investigate the primary advice in source. Always
 *     available because both fields are part of the request. Survives
 *     the "Don't duplicate capability the agent already has" check
 *     because it's a *pointer* to the agent's own Read tool, not
 *     in-tool analysis.
 *
 * The earlier "Dismiss in source via suppression pragma" entry was
 * dropped: bolting a boilerplate pragma alternative onto every
 * `kind: "guidance"` response — regardless of whether the rule's
 * evidence model actually conceded the criterion may not apply on
 * this substrate — diluted the discriminator that was added to
 * resolve exactly this ambiguity. Per `docs/kb/architecture/ai-
 * first-consumer.md` "Suppress-recommended is a distinct discriminator
 * from guidance," the pragma path now belongs to
 * `kind: "suppress-recommended"` only — that lane already ships the
 * canonical pragma at top level (with `criterionId` sibling) via
 * {@link buildSuppressRecommendedOutcome}, so there is no duplication
 * to forward through the alternatives channel.
 *
 * Returns `undefined` only if no file path exists (never happens in
 * practice since the request requires it). In every realistic call,
 * the verify-by-reading prompt guarantees a single-entry array.
 */
export function buildPerCallEnrichmentAlternatives(
  filePath: string,
  line: number,
): ReadonlyArray<{ readonly approach: string; readonly explanation: string }> | undefined {
  // Verify-by-reading prompt — always available because filePath +
  // line are required suggest_fix params. The cheapest honest
  // fallback when the primary advice doesn't apply: naming the line
  // lets the agent jump straight there with its Read tool's
  // offset/limit pair rather than scanning the file.
  return [
    {
      approach: "Verify by reading the source",
      explanation: `Open ${filePath} at line ${line} and read the surrounding context to confirm whether the primary advice applies; the rule fires on static evidence the agent reading the whole file may overrule.`,
    },
  ];
}
