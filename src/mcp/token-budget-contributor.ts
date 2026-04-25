/**
 * Top-contributor analysis for the
 * `response_token_budget_truncated` warning's structured payload.
 *
 * The token-density cap (see `token-budget.ts`) trims trailing file
 * entries until the response fits under the ~25k-token MCP host
 * ceiling. The bare `requestedLimit` / `effectiveLimit` numbers tell
 * the caller "we trimmed N files" but not WHY the response was so
 * dense — was one finding's `fix.description` paragraph 4 KB long?
 * Did a single rule's `criteria[]` array carry 80 IDs? Was a
 * `vendorOccurrences[]` list 200 entries deep? Without that context
 * the agent can't decide between "retry with a narrower scope" vs.
 * "switch surfaces" vs. "suppress this one rule's description hoist."
 *
 * This helper walks the pre-trim files list, JSON-serializes each
 * finding, and identifies:
 *
 *   - the single largest-byte finding (when there's an unambiguous
 *     winner — ties are reported as "no clear winner" by omitting
 *     all three contributor fields per the AI-first consumer
 *     "ambiguous field shapes are dishonest" rule);
 *   - which top-level field on that finding contributed the most
 *     bytes to its serialized payload (`fix_description`,
 *     `criteria`, `snippet`, `vendor_occurrences`, `message`, or
 *     `other` — also deterministic, ties → `other`).
 *
 * Both outputs are derived by exact byte count, not by heuristic
 * threshold (no "fires when description > 1000 chars" — that would be
 * the numeric-threshold suppression anti-pattern). The contributor
 * label is provable from the code: stringify each candidate field,
 * pick the max.
 */

/**
 * Coarse buckets the dominant finding's byte budget can fall into.
 * Names are stable wire vocabulary the agent branches on:
 *
 * - `fix_description` — the finding's `fix.description` prose
 *   (or `fix.newText`, when `description` is absent) dominates.
 *   Remediation: the rule is producing a long fix paragraph; an
 *   agent that already understands the fix can re-call the surface
 *   without the `fix.description` hoist (no current toggle, but
 *   future paths exist) or narrow scope.
 * - `criteria` — the finding's `criteria[]` (and `criteriaTitles[]`)
 *   array dominates. A rule satisfying many criteria across loaded
 *   standards (WCAG 2.2 + 2.1 + Section 508 + EN 301 549) inflates
 *   here.
 * - `snippet` — the finding's `snippet` source-text excerpt
 *   dominates. Wide source lines or HTML attribute soup land here.
 * - `vendor_occurrences` — the finding's `vendorOccurrences[]` list
 *   dominates. Vendor-deduped rules (canonical bootstrap.css, etc.)
 *   collapse N copies to one finding with an N-entry occurrences
 *   list; a 200-entry list is the canonical mode here.
 * - `message` — the finding's `message` prose dominates. Rare —
 *   most rule messages are one line.
 * - `other` — no single field crosses 50% of the finding's serialized
 *   bytes, OR a tie at the top. The agent should not treat this as a
 *   diagnostic; it's the explicit "we couldn't pick" sentinel.
 */
export type TokenBudgetContributorKind =
  | "fix_description"
  | "criteria"
  | "snippet"
  | "vendor_occurrences"
  | "message"
  | "other";

/**
 * Result from {@link analyzeTopContributor}. All three fields are
 * present-when-meaningful — the helper returns `{}` when no single
 * finding wins by byte count (ties at the top, no findings at all,
 * etc.). Callers conditional-spread; never emit empty/zero sentinels.
 */
export interface TopContributorAnalysis {
  /** Rule ID of the single largest-byte finding. */
  readonly topContributorRule?: string;
  /** Serialized byte count of that finding (charset is UTF-16 length). */
  readonly topContributorByteCount?: number;
  /**
   * Coarse classification of which top-level field on the winning
   * finding consumed the most bytes. See
   * {@link TokenBudgetContributorKind}.
   */
  readonly dominantContributor?: TokenBudgetContributorKind;
}

/** Minimal finding shape this helper needs — a duck-type over `AgentFinding`. */
interface ContributorFinding {
  readonly ruleId?: unknown;
  readonly message?: unknown;
  readonly snippet?: unknown;
  readonly criteria?: unknown;
  readonly criteriaTitles?: unknown;
  readonly fix?: unknown;
  readonly vendorOccurrences?: unknown;
}

/** Minimal file shape — `{ findings: ContributorFinding[] }`. */
interface ContributorFile {
  readonly findings?: readonly ContributorFinding[];
}

/**
 * Walks the pre-trim files array, finds the single finding with the
 * largest serialized byte count, and classifies which of its
 * sub-fields consumed the most bytes. Returns an empty object when
 * the result would be ambiguous (ties at the top, no findings).
 *
 * Deterministic: no thresholds, no fuzzy matching. Field-level
 * dominance is decided by exact stringified-byte comparison; the
 * dominant bucket is the field whose serialized contribution exceeds
 * 50% of the finding's total bytes (otherwise `"other"`).
 */
export function analyzeTopContributor(
  files: readonly ContributorFile[],
): TopContributorAnalysis {
  let topBytes = -1;
  let topFinding: ContributorFinding | undefined;
  let topIsTied = false;
  for (const file of files) {
    const findings = file.findings ?? [];
    for (const finding of findings) {
      const bytes = JSON.stringify(finding).length;
      if (bytes > topBytes) {
        topBytes = bytes;
        topFinding = finding;
        topIsTied = false;
      } else if (bytes === topBytes) {
        // Tie at the top — record it; if the tie persists at the end
        // we omit the contributor fields entirely (ambiguous field
        // shapes are dishonest).
        topIsTied = true;
      }
    }
  }
  if (topFinding === undefined || topIsTied) return {};
  const ruleId = typeof topFinding.ruleId === "string" ? topFinding.ruleId : undefined;
  if (ruleId === undefined) return {};
  return {
    topContributorRule: ruleId,
    topContributorByteCount: topBytes,
    dominantContributor: classifyDominantContributor(topFinding, topBytes),
  };
}

/**
 * Picks the bucket whose serialized contribution exceeds 50% of the
 * finding's total bytes. Ties (or no field crossing the threshold)
 * collapse to `"other"` — the explicit "we couldn't pick" sentinel
 * keeps the wire shape unambiguous (the consumer never has to
 * guess whether a missing label means "no winner" or "unsupported
 * field combo").
 */
function classifyDominantContributor(
  finding: ContributorFinding,
  totalBytes: number,
): TokenBudgetContributorKind {
  if (totalBytes <= 0) return "other";
  const candidates: { readonly kind: TokenBudgetContributorKind; readonly bytes: number }[] = [
    { kind: "fix_description", bytes: fixBytes(finding.fix) },
    { kind: "criteria", bytes: criteriaBytes(finding.criteria, finding.criteriaTitles) },
    { kind: "snippet", bytes: lengthOf(finding.snippet) },
    { kind: "vendor_occurrences", bytes: lengthOf(finding.vendorOccurrences) },
    { kind: "message", bytes: lengthOf(finding.message) },
  ];
  // Sort descending so the biggest is first; tie-break on a stable
  // ordering of the kind enum (insertion order above) so the choice
  // stays deterministic across runs even when two fields are exactly
  // equal — we still demote to `"other"` below if the leader doesn't
  // cross the 50% threshold, so the deterministic tie-break is only
  // for the threshold check itself.
  candidates.sort((a, b) => b.bytes - a.bytes);
  const leader = candidates[0];
  if (leader === undefined) return "other";
  // Threshold = leader strictly more than half of the finding's bytes.
  // The 50% bar is a structural majority test, not a tunable
  // suppression knob — it's the line between "one field ate the budget"
  // and "no single field dominates," and the consumer reads `"other"`
  // as the latter. Without it, a finding where fix/criteria/snippet
  // each took ~33% would mislabel as `fix_description` purely on insert
  // order.
  if (leader.bytes * 2 <= totalBytes) return "other";
  return leader.kind;
}

function fixBytes(fix: unknown): number {
  if (fix === null || typeof fix !== "object") return 0;
  return JSON.stringify(fix).length;
}

function criteriaBytes(criteria: unknown, criteriaTitles: unknown): number {
  return lengthOf(criteria) + lengthOf(criteriaTitles);
}

function lengthOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return JSON.stringify(value).length;
}
