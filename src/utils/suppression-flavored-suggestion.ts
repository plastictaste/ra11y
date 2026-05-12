/**
 * Predicate naming the per-emission "suppression-flavored guidance"
 * shape that drives the `kind: "suppress-recommended"` suggest_fix
 * discriminator and the `plan.fixesByClass.suppressRecommended` lane.
 *
 * Why a util module: both `src/output/agent-response/build-plan.ts`
 * (which assembles the plan tally) and `src/mcp/...` (which assembles
 * the per-call suggest_fix payload) need the predicate. The MCP layer
 * already imports from `output/agent-response`, so co-locating the
 * predicate under `src/mcp/` would create a cycle. `src/utils/` is the
 * neutral home for pure string predicates with no parser or engine
 * dependency.
 *
 * Detection rationale lives at the call site — see
 * `src/mcp/suggest-fix-suppress-recommended.ts` for the doctrine.
 * Kept conservative: a suggestion is suppression-flavored only when
 * (a) its prose names the source-level disable pragma AND (b) its
 * primary sentence does NOT lead with a positive-edit verb. The
 * second leg matters because most rules name `ra11y-disable` as a
 * trailing fallback after a real edit suggestion ("Add aria-haspopup…
 * If this control is not actually a dropdown trigger, suppress
 * with <!-- ra11y-disable … -->"); under the loose predicate those
 * suggestions misrouted to `kind: "suppress-recommended"` while the
 * primary advice was a concrete attribute edit. See
 * `docs/kb/architecture/ai-first-consumer.md` "Suppress-recommended
 * is a distinct discriminator from guidance" for the doctrine.
 */

/**
 * Tokens that, when present in a suggestion's prose, indicate the
 * rule mentions the source-level disable pragma. Necessary but no
 * longer sufficient — see {@link isSuppressionFlavoredSuggestion} for
 * the full predicate. Any addition here must clear the bar "the token
 * never appears in legitimate `kind: "guidance"` prose where the agent
 * should pursue a real fix" — same correctness bar as
 * `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
 * meta sub-fields are dishonest" applies.
 */
const SUPPRESSION_TOKENS: readonly string[] = ["ra11y-disable", "suppress with"];

/**
 * Imperative verbs that, when leading the suggestion's first sentence,
 * signal the rule is advancing a real positive edit — an attribute to
 * add, an element to insert, a role to drop, a value to set, code to
 * change. When present, the suggestion is NOT suppression-flavored even
 * if it also names a `ra11y-disable` fallback later in the prose; the
 * primary advice is the edit, and the pragma reference is a "if this
 * detection is wrong" escape hatch.
 *
 * Kept tight: every verb here appears at the START of an imperative
 * sentence in a real rule's `buildSuggestion` and offers a concrete
 * code change. Verbs like `verify`, `check`, `consider`, `audit` are
 * deliberately NOT in this list — they advance investigation, not a
 * positive edit, so a suggestion leading with them PLUS a pragma
 * fallback IS honestly suppression-flavored (the rule conceded its
 * evidence model can't honor a deterministic edit).
 *
 * Matched case-insensitively against the first sentence's leading
 * word. Adding a verb here must clear the bar: "every real rule
 * suggestion leading with this verb advances a concrete attribute /
 * element / value edit the agent can apply or compose into source."
 */
const POSITIVE_EDIT_LEADING_VERBS: readonly string[] = [
  "add",
  "change",
  "drop",
  "either", // "Either set min-width: 44px or…" — leads a real-edit branch
  "insert",
  "move",
  "promote",
  "provide",
  "rename",
  "replace",
  "set",
  "use",
  "wrap",
];

/**
 * Walk forward from index 0 to the end of the first sentence — first
 * `.`, `!`, `?`, `;`, or `\n` whichever comes first — and return the
 * slice. Trailing terminator is included so the caller can match the
 * raw prose; the leading-verb test below tolerates either form.
 *
 * Sentence-break heuristic is intentionally cruder than the one in
 * `src/mcp/suggest-fix-guidance-shape.ts` `findFirstSentenceBreakEnd`
 * because we only need to peek at the leading verb — we do NOT need
 * abbreviation-aware splitting (no real rule's first imperative
 * sentence starts with `e.g.`).
 */
function firstSentenceSlice(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === ";" || ch === "\n") {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * Test whether the first sentence of `suggestion` leads with one of
 * the positive-edit verbs in {@link POSITIVE_EDIT_LEADING_VERBS}.
 *
 * The match is anchored at the first non-whitespace word so a
 * suggestion that opens with a descriptive clause ("A document
 * without an <h1> loses…") returns false even when later words in
 * the same sentence include "add" or "set".
 *
 * Matched case-insensitively; the verb's right boundary must be a
 * non-letter character (whitespace, end-of-string) so prefixes like
 * `"address"`, `"setting"`, `"changes"` don't match `"add"`, `"set"`,
 * or `"change"`.
 */
function firstSentenceLeadsWithEditVerb(suggestion: string): boolean {
  const sentence = firstSentenceSlice(suggestion).trimStart();
  const lower = sentence.toLowerCase();
  for (const verb of POSITIVE_EDIT_LEADING_VERBS) {
    if (!lower.startsWith(verb)) continue;
    // Word-boundary on the right: end-of-string or non-letter.
    const tail = lower.charCodeAt(verb.length);
    // Letter check: a–z is 97–122.
    if (Number.isNaN(tail) || tail < 97 || tail > 122) return true;
  }
  return false;
}

/**
 * Test whether a suggestion's prose is suppression-flavored — i.e. the
 * primary remediation it advances is "investigate, then add a pragma
 * if intentional," not "apply this fix." Returns `false` when
 * `suggestion` is undefined or empty — absence of prose can't be
 * suppression-flavored.
 *
 * Predicate: the prose names the pragma token AND its first sentence
 * does NOT lead with a positive-edit verb. The second leg is the
 * tightening that landed when feedback observed
 * `aria/dropdown-toggle-triple-aria-missing` returning
 * `kind: "suppress-recommended"` while its primary advice was
 * `'Add aria-haspopup="menu" and aria-controls=…'` — a real attribute
 * edit. Under the new predicate that suggestion stays in
 * `kind: "guidance"` (or its declared lane); only suggestions whose
 * primary sentence is "verify…" / "A document without…" / "If this is
 * X…" reach the suppress-recommended lane.
 *
 * @param suggestion - The violation's prose suggestion text, or
 *   undefined when the rule emitted no suggestion.
 * @returns `true` when the prose names a suppression token AND the
 *   first sentence has no positive-edit verb leading.
 *
 * @example
 * isSuppressionFlavoredSuggestion('A document without an <h1> loses the single top-of-document landmark AT relies on; verify the page has a designated main heading… If this page is a fragment or layout intentionally rendered inside a parent with its own <h1>, suppress with <!-- ra11y-disable wcag22:1.3.1 -->.')
 * // => true
 *
 * @example
 * isSuppressionFlavoredSuggestion('Add aria-haspopup="menu" and aria-controls="<menu-id>" to the <button>… If this control is not actually a dropdown trigger, suppress with <!-- ra11y-disable aria/dropdown-toggle-triple-aria-missing -->.')
 * // => false (primary sentence leads with positive-edit verb "Add")
 *
 * @example
 * isSuppressionFlavoredSuggestion('Add alt="" to the decorative <img>.')
 * // => false (no pragma token)
 *
 * @example
 * isSuppressionFlavoredSuggestion(undefined)
 * // => false
 */
export function isSuppressionFlavoredSuggestion(suggestion: string | undefined): boolean {
  if (suggestion === undefined || suggestion.length === 0) return false;
  let hasToken = false;
  for (const token of SUPPRESSION_TOKENS) {
    if (suggestion.includes(token)) {
      hasToken = true;
      break;
    }
  }
  if (!hasToken) return false;
  return !firstSentenceLeadsWithEditVerb(suggestion);
}
