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
 * Minimum-meaningful prefix below which a sentence-split candidate is
 * treated as a degenerate slice (e.g. a single backtick from prose
 * like `` `?expr` ... `` where the splitter landed on `?` at index 1
 * and the trailing-terminator strip reduced the result to `` ` ``).
 * Threshold is intentionally small — short legitimate sentences like
 * `"In scIENCE"` or `"Short sentence"` must pass through; only the
 * single-punct / single-backtick / 2-char garbage slice falls through
 * to the full-prose fallback.
 */
const MIN_MEANINGFUL_PREFIX = 3;

/**
 * Derive a terse `approach` label from prose when the rule did not
 * supply a structured `FixPath.label` — used by the no-fixPaths
 * guidance branch where all we have is `match.suggestion` or
 * `match.message`. Returns the first sentence when one terminates
 * within the search horizon; otherwise returns the full trimmed prose
 * untruncated.
 *
 * Trailing-ellipsis truncation was removed: shipped fields must not
 * end in `…` without a sentinel because authored ellipses appear in
 * rule prose (e.g. `aria-label="…"` placeholders), and a trailing
 * ellipsis from clipping is indistinguishable from authored content.
 * That is the "Ambiguous field shapes are dishonest" failure mode —
 * the agent cannot tell clipping from authored prose. Since the
 * `primary.explanation` sibling already carries the full prose,
 * `approach` shipping a (potentially redundant) untruncated copy is
 * the honest closure; the agent reads `explanation` for full context
 * either way.
 *
 * The terminator search skips periods inside common abbreviations
 * (`e.g.`, `i.e.`, `vs.`, `etc.`, `cf.`, `viz.`) — without that, fix
 * prose like `"Try a sibling — e.g. add aria-label."` truncated to
 * `"Try a sibling — e"`.
 *
 * Returns the full prose when the splitter would produce a degenerate
 * slice (< {@link MIN_MEANINGFUL_PREFIX} chars), guarding against the
 * single-backtick / single-punct shape that the old trailing-terminator
 * strip used to return.
 */
export function deriveApproachFromProse(prose: string): string {
  const trimmed = prose.trim();
  const SEARCH_HORIZON = 120;
  const breakEnd = findFirstSentenceBreakEnd(trimmed, SEARCH_HORIZON);
  if (breakEnd < 0) return trimmed;
  const candidate = trimmed.slice(0, breakEnd);
  const stripped = candidate.replace(/[.!?]$/, "");
  if (stripped.length < MIN_MEANINGFUL_PREFIX && trimmed.length > stripped.length) {
    return trimmed;
  }
  return stripped;
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
