/**
 * Top-level prose map extracted out of per-finding fields.
 *
 * Every `suppressPlacement` paragraph used to ride on every violation in
 * the response. For large scans that duplicated the same ~300-char prose
 * N times — pure waste for an agent consumer that only needs to read
 * each variant once. The map below is keyed by file extension and
 * populated only with extensions actually observed in the response, so
 * a TSX-only scan doesn't ship the CSS placement paragraph.
 *
 * The same logic now covers `fix.description` prose — rules like
 * `semantics/label-in-name` (1970 chars), `forms/autocomplete-missing`
 * (~150 chars x 31 findings) emit the same paragraph verbatim on every
 * finding. V1-SIZE-RESPONSE-BUDGET-DENSITY option (b): hoist those into
 * `referenceGuide.fixDescriptions[ruleId][hash]` and replace the inline
 * `fix.description` with `fixDescriptionRef: { hash }`. Keyed by a
 * stable 12-hex-char SHA-256 so a rule that legitimately emits two
 * distinct descriptions (label-in-name does: 466-char and 1970-char
 * verdicts) keeps both in the map — picking only one would be a silent
 * miss. Singletons (unique-in-response) stay inline.
 *
 * Shape matches the `referenceGuide` field on `ScanFormatted`. Kept in
 * its own module so `tools-helpers.ts` can stay under the 500-line file
 * budget and the language mapping is easy to find when adding a new
 * file type (e.g. `.mdx`).
 */

import { createHash } from "node:crypto";
import type { AgentFinding } from "../output/agent-response/types.ts";

const PLACEMENT_TSX =
  "Place on the line immediately above the opening JSX tag of the flagged element — not inside attributes, and not between adjacent JSX siblings without a wrapping expression. The `{/* … */}` wrapper is valid as a JSX expression or at module scope.";
const PLACEMENT_CSS =
  "Place on the line immediately above the CSS rule whose declarations are flagged.";
const PLACEMENT_HTML =
  "Place on the line immediately above the opening tag of the flagged element.";
const PLACEMENT_DEFAULT = "Place on the line immediately above the flagged statement.";

/**
 * Minimum number of findings WITH A DESCRIPTION that a rule must have in
 * a response before that rule's entire description set becomes eligible
 * for hoisting.
 *
 * Originally keyed per `(ruleId, hash)` — a specific hash had to repeat
 * twice to hoist. That produced V1-FIX-DESCRIPTION-PRESENCE-INCONSISTENCY:
 * within one ruleId, two findings with description-A (same hash) would
 * hoist + strip inline; a sibling finding with description-B (singleton
 * hash) would stay inline. The agent saw two shapes for the same rule in
 * one response and had to re-learn the join convention per finding.
 *
 * The threshold now counts findings-with-description PER RULE, not per
 * `(ruleId, hash)` bucket. A rule with ≥2 findings carrying descriptions
 * hoists ALL of them — each distinct description still earns its own
 * hash entry in `fixDescriptions[ruleId]`, but every finding under that
 * rule is guaranteed to ship as `fix: {safety} + fixDescriptionRef`
 * rather than inline. A rule with exactly one finding carrying a
 * description leaves it inline (singleton indirection is pure overhead).
 *
 * Result: for any given ruleId in a response, every finding uses the
 * same shape. The agent learns the join once per rule, not once per
 * finding.
 */
const FIX_DESCRIPTION_PER_RULE_HOIST_THRESHOLD = 2;

/**
 * Length of the truncated SHA-256 digest used to key the fixDescriptions
 * map. Matches the 48-bit token `findingId` uses — see
 * `src/utils/finding-id.ts` — so the same recognizable format shows up
 * across the response.
 */
const FIX_DESCRIPTION_HASH_LENGTH = 12;

/**
 * Looks up the placement prose for an extension. Keyed without a leading
 * dot and lowercased — the caller normalizes before passing.
 */
export function suppressPlacementForExt(ext: string): string {
  if (ext === "tsx" || ext === "jsx") return PLACEMENT_TSX;
  if (ext === "css") return PLACEMENT_CSS;
  if (ext === "html" || ext === "htm") return PLACEMENT_HTML;
  return PLACEMENT_DEFAULT;
}

/**
 * Nested map of `ruleId → hash → description`. Nested rather than flat
 * so agents retrieving a description walk `fixDescriptions[ruleId][hash]`
 * — short hashes collide cheaply across ruleIds, and namespacing by
 * ruleId keeps the name-agreement discipline local to each rule.
 */
export type FixDescriptions = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface ReferenceGuide {
  readonly suppressPlacement: Readonly<Record<string, string>>;
  /**
   * Present-when-meaningful (CLAUDE.md §1): omitted entirely when no
   * rule in the response has ≥
   * {@link FIX_DESCRIPTION_PER_RULE_HOIST_THRESHOLD} findings carrying a
   * description. When present, EVERY finding under a hoisted rule carries
   * `fixDescriptionRef: { hash }` and omits `fix.description` — the shape
   * is deterministic per-rule so the agent learns the join convention
   * once per rule instead of once per finding (V1-FIX-DESCRIPTION-
   * PRESENCE-INCONSISTENCY). Findings under rules whose total description
   * count is 1 keep the inline `fix.description`.
   */
  readonly fixDescriptions?: FixDescriptions;
}

/**
 * Computes the 12-hex-char truncated SHA-256 of a fix-description
 * string. Exported so callers and tests can reconstruct the hash from
 * the description text.
 */
export function hashFixDescription(description: string): string {
  return createHash("sha256")
    .update(description)
    .digest("hex")
    .slice(0, FIX_DESCRIPTION_HASH_LENGTH);
}

/**
 * Builds `referenceGuide.suppressPlacement` from the extensions present
 * in a scan's file entries. Returns `undefined` when no files carry
 * findings so the caller conditional-spreads the whole block away
 * (honest shape per CLAUDE.md §1 — no `{}` sentinel).
 *
 * `fixDescriptions` is an optional pre-computed map (from
 * {@link hoistFixDescriptions}); when supplied and non-empty, it rides
 * alongside `suppressPlacement` under the same referenceGuide object.
 */
export function buildReferenceGuide(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
  fixDescriptions?: FixDescriptions,
): ReferenceGuide | undefined {
  const exts = new Set<string>();
  for (const f of files) {
    if (f.findings.length === 0) continue;
    const dot = f.path.lastIndexOf(".");
    if (dot === -1) {
      exts.add("default");
      continue;
    }
    const raw = f.path.slice(dot + 1).toLowerCase();
    if (raw === "tsx" || raw === "jsx" || raw === "css" || raw === "html" || raw === "htm") {
      exts.add(raw);
    } else {
      exts.add("default");
    }
  }
  if (exts.size === 0) return undefined;
  const suppressPlacement: Record<string, string> = {};
  for (const ext of [...exts].sort()) {
    suppressPlacement[ext] = suppressPlacementForExt(ext);
  }
  const hasFixDescriptions =
    fixDescriptions !== undefined && Object.keys(fixDescriptions).length > 0;
  return {
    suppressPlacement,
    ...(hasFixDescriptions ? { fixDescriptions } : {}),
  };
}

/**
 * Conditional-spread the top-level `referenceGuide` field — omitted when
 * no findings exist. Lets scan-tool handlers spread unconditionally
 * and keeps their cognitive complexity inside the lint budget.
 */
export function referenceGuideField(formatted: { readonly referenceGuide?: ReferenceGuide }): {
  readonly referenceGuide?: ReferenceGuide;
} {
  if (formatted.referenceGuide === undefined) return {};
  return { referenceGuide: formatted.referenceGuide };
}

/**
 * Describes a rewrite of a single {@link AgentFinding} to drop its
 * inline `fix.description` in favor of a `fixDescriptionRef` pointer.
 * Rewrites are applied in {@link applyFixDescriptionHoist} — the split
 * lets the hoister stay a pure function over file entries while the
 * rewrite walk happens inside the runScan pipeline.
 */
interface HoistResult {
  readonly fixDescriptions: FixDescriptions;
  /**
   * Set of `(ruleId, hash)` composite keys — `${ruleId}\0${hash}` —
   * for descriptions that crossed the hoist threshold. Used by
   * {@link applyFixDescriptionHoist} to decide whether each finding's
   * description goes to the lookup table or stays inline.
   */
  readonly hoistedKeys: ReadonlySet<string>;
}

function compositeKey(ruleId: string, hash: string): string {
  return `${ruleId}\u0000${hash}`;
}

/**
 * First pass of the hoist: scan every finding, count descriptions PER
 * RULE, and emit:
 *
 *   - `fixDescriptions` — nested `{ [ruleId]: { [hash]: description } }`
 *     for every rule whose total count of findings-with-description met
 *     {@link FIX_DESCRIPTION_PER_RULE_HOIST_THRESHOLD}. Every distinct
 *     description under that rule is preserved as its own hash entry.
 *   - `hoistedKeys` — the flat `(ruleId, hash)` set, encoded as composite
 *     keys, so the rewrite pass can branch in O(1) per finding.
 *
 * Per-rule aggregation (not per-`(ruleId, hash)`) is the fix for
 * V1-FIX-DESCRIPTION-PRESENCE-INCONSISTENCY: under the old counting, a
 * rule with two findings carrying DIFFERENT descriptions had two
 * singleton-hash buckets and nothing hoisted, so both stayed inline;
 * but a rule with two findings carrying the SAME description hoisted.
 * Add a third finding with yet another distinct description and the
 * response shipped one ruleId with MIXED shapes — some findings inline,
 * some carrying refs. The agent had to disambiguate per-finding. Now
 * the decision is made once per rule from the rule's total
 * finding-with-description count, so every finding under a hoisted rule
 * has the same shape.
 *
 * Pure function — no I/O, no side effects. Safe to call on the
 * post-`buildAgentFinding` `fileEntries` even though `AgentFinding`
 * objects are `readonly`: we don't mutate them here.
 *
 * `semantics/label-in-name` is the motivating multi-verdict case: it
 * emits two distinct verdicts (a 466-char and a 1970-char description)
 * across its findings. Hashing each description keeps both in the
 * response-level map; per-rule aggregation then guarantees every
 * finding under that ruleId uses the hoisted shape regardless of which
 * verdict applies.
 */
export function hoistFixDescriptions(
  fileEntries: readonly {
    readonly path: string;
    readonly findings: readonly AgentFinding[];
  }[],
): HoistResult {
  const byRule = tallyDescriptions(fileEntries);
  return buildHoistResult(byRule);
}

interface TallyEntry {
  readonly description: string;
  count: number;
}

/**
 * Counts `(ruleId, hash)` pairs across every finding in the response.
 * Findings with no description, or with an empty string, contribute
 * nothing to the tally.
 */
function tallyDescriptions(
  fileEntries: readonly {
    readonly path: string;
    readonly findings: readonly AgentFinding[];
  }[],
): Map<string, Map<string, TallyEntry>> {
  const byRule = new Map<string, Map<string, TallyEntry>>();
  for (const file of fileEntries) {
    for (const f of file.findings) {
      tallyOne(byRule, f);
    }
  }
  return byRule;
}

function tallyOne(byRule: Map<string, Map<string, TallyEntry>>, f: AgentFinding): void {
  const description = f.fix?.description;
  if (description === undefined || description.length === 0) return;
  const hash = hashFixDescription(description);
  let perRule = byRule.get(f.ruleId);
  if (perRule === undefined) {
    perRule = new Map<string, TallyEntry>();
    byRule.set(f.ruleId, perRule);
  }
  const existing = perRule.get(hash);
  if (existing === undefined) {
    perRule.set(hash, { description, count: 1 });
    return;
  }
  existing.count += 1;
}

/**
 * Walks the tally and — for every rule whose SUM of finding-with-
 * description counts meets {@link FIX_DESCRIPTION_PER_RULE_HOIST_THRESHOLD}
 * — hoists EVERY distinct description under that rule. Each distinct
 * description still earns its own hash entry (so two verdicts under
 * `semantics/label-in-name` both survive per the module header), but
 * the threshold test is against the per-rule total, not per-hash.
 *
 * A rule that has exactly one finding carrying a description leaves
 * that description inline — singleton indirection is pure overhead.
 */
function buildHoistResult(byRule: Map<string, Map<string, TallyEntry>>): HoistResult {
  const fixDescriptions: Record<string, Record<string, string>> = {};
  const hoistedKeys = new Set<string>();
  for (const [ruleId, perRule] of byRule) {
    let perRuleTotal = 0;
    for (const entry of perRule.values()) perRuleTotal += entry.count;
    if (perRuleTotal < FIX_DESCRIPTION_PER_RULE_HOIST_THRESHOLD) continue;
    const bucket: Record<string, string> = {};
    fixDescriptions[ruleId] = bucket;
    for (const [hash, entry] of perRule) {
      bucket[hash] = entry.description;
      hoistedKeys.add(compositeKey(ruleId, hash));
    }
  }
  return { fixDescriptions, hoistedKeys };
}

/**
 * Per-file group-level hoist entry. Surfaces on the file bucket as
 * `groupFixDescriptionRefs` when ≥2 findings in the same `groupKey`
 * share the same post-hoist `fixDescriptionRef.hash`.
 */
export interface GroupFixDescriptionRef {
  readonly groupKey: string;
  readonly hash: string;
}

/**
 * Minimum number of findings in one (groupKey, hash) cohort that
 * triggers the per-file group-level hoist. At the singleton (1), the
 * ref stays inline on the finding — no savings. At 2+, every additional
 * sibling would re-inline the same 12-hex-char pointer, so lifting it
 * to the group level pays. Same threshold as the response-wide
 * description hoist ({@link FIX_DESCRIPTION_PER_RULE_HOIST_THRESHOLD}) —
 * a single finding doesn't earn indirection at either level.
 */
const GROUP_FIX_DESC_REF_HOIST_THRESHOLD = 2;

/**
 * Second pass: walk every finding and — for those whose description
 * was hoisted in the first pass — replace the inline `fix.description`
 * with `fixDescriptionRef: { hash }`. Findings whose description was
 * unique in the response (or whose description is absent entirely)
 * pass through unchanged.
 *
 * Then — Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-DEDUPE — walk each
 * file's findings and collapse any `(groupKey, hash)` cohort of ≥2
 * findings into a single file-level `groupFixDescriptionRefs` entry,
 * stripping `fixDescriptionRef` from each sibling finding in that
 * cohort. Findings with no `groupKey` pair, or whose cohort is a
 * singleton within the file, pass through with their inline
 * `fixDescriptionRef` unchanged.
 *
 * Returns a new file-entries array; does not mutate the input. Returned
 * entries may carry an optional `groupFixDescriptionRefs: readonly
 * GroupFixDescriptionRef[]` — present-when-meaningful (omitted entirely
 * when no group in that file crossed
 * {@link GROUP_FIX_DESC_REF_HOIST_THRESHOLD}).
 */
export function applyFixDescriptionHoist<T extends AgentFinding>(
  fileEntries: readonly {
    readonly path: string;
    readonly findings: readonly T[];
  }[],
  hoistedKeys: ReadonlySet<string>,
): readonly {
  readonly path: string;
  readonly findings: readonly T[];
  readonly groupFixDescriptionRefs?: readonly GroupFixDescriptionRef[];
}[] {
  if (hoistedKeys.size === 0) return fileEntries;
  return fileEntries.map((file) => {
    const rewrittenFindings = file.findings.map((finding) => rewriteFinding(finding, hoistedKeys));
    return liftGroupFixDescriptionRefs(file.path, rewrittenFindings);
  });
}

/**
 * Third pass, per-file: tally `(groupKey, hash)` cohorts across the
 * already-rewritten findings. For any cohort that meets
 * {@link GROUP_FIX_DESC_REF_HOIST_THRESHOLD}, strip `fixDescriptionRef`
 * from each sibling and emit a single file-level entry pointing at the
 * shared hash. Cohorts that don't cross the threshold pass through
 * unchanged so a group of 1 keeps its inline pointer.
 *
 * Pure function — no mutation of the input findings. The per-finding
 * `groupKey` stays inline so the agent can walk back from any sibling
 * to the lifted entry.
 */
function liftGroupFixDescriptionRefs<T extends AgentFinding>(
  path: string,
  findings: readonly T[],
): {
  readonly path: string;
  readonly findings: readonly T[];
  readonly groupFixDescriptionRefs?: readonly GroupFixDescriptionRef[];
} {
  const cohorts = tallyGroupRefCohorts(findings);
  const liftedCohorts = new Set<string>();
  const groupRefs: GroupFixDescriptionRef[] = [];
  for (const [key, entry] of cohorts) {
    if (entry.count < GROUP_FIX_DESC_REF_HOIST_THRESHOLD) continue;
    liftedCohorts.add(key);
    groupRefs.push({ groupKey: entry.groupKey, hash: entry.hash });
  }
  if (liftedCohorts.size === 0) return { path, findings };
  const rewritten = findings.map((f) => stripRefIfLifted(f, liftedCohorts));
  // Deterministic order — groupKey ascending so two equivalent scans
  // produce byte-identical output (matches the rest of the assembler's
  // sort-on-emit discipline; see `groupByFile` in response-assembler.ts).
  groupRefs.sort((a, b) => (a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0));
  return { path, findings: rewritten, groupFixDescriptionRefs: groupRefs };
}

interface GroupRefTally {
  readonly groupKey: string;
  readonly hash: string;
  count: number;
}

/**
 * Counts (groupKey, hash) cohorts across the POST-rewrite findings in
 * one file. Only findings that actually carry a `fixDescriptionRef`
 * contribute — a finding that kept its inline description (singleton
 * across the response) has no ref to lift.
 */
function tallyGroupRefCohorts<T extends AgentFinding>(
  findings: readonly T[],
): Map<string, GroupRefTally> {
  const cohorts = new Map<string, GroupRefTally>();
  for (const f of findings) {
    const hash = f.fixDescriptionRef?.hash;
    if (hash === undefined) continue;
    const { groupKey } = f;
    if (groupKey === undefined || groupKey.length === 0) continue;
    const key = compositeKey(groupKey, hash);
    const existing = cohorts.get(key);
    if (existing === undefined) {
      cohorts.set(key, { groupKey, hash, count: 1 });
      continue;
    }
    existing.count += 1;
  }
  return cohorts;
}

/**
 * Drops `fixDescriptionRef` from a finding whose (groupKey, hash)
 * cohort was lifted to the file-level. Never emits both per-finding
 * and group-level refs for the same cohort — doctrine in
 * `docs/kb/architecture/ai-first-consumer.md` under "Ambiguous field
 * shapes are dishonest."
 */
function stripRefIfLifted<T extends AgentFinding>(
  finding: T,
  liftedCohorts: ReadonlySet<string>,
): T {
  const hash = finding.fixDescriptionRef?.hash;
  if (hash === undefined) return finding;
  const { groupKey } = finding;
  if (groupKey === undefined || groupKey.length === 0) return finding;
  if (!liftedCohorts.has(compositeKey(groupKey, hash))) return finding;
  const { fixDescriptionRef: _omitted, ...rest } = finding;
  return rest as T;
}

/**
 * One-call hoist: counts `(ruleId, hash)` duplicates across the given
 * file entries, rewrites hoisted findings to carry
 * `fixDescriptionRef` pointers, and returns both the rewritten entries
 * and a `referenceGuide` object that merges the pre-existing
 * suppressPlacement (from {@link buildReferenceGuide}) with the new
 * `fixDescriptions` map.
 *
 * Designed for response-assembly sites: each scan tool (`scan`,
 * `scan_file`, `scan_project`, `scan_diff`) calls this after its final
 * findings array is assembled — post-pagination for `scan_project`,
 * post-baseline/hunk filter for `scan_diff` — so the hoist reflects
 * exactly what ships in the response. Running it upstream in
 * `runScanAndFormat` would force downstream filters to know how to
 * repair pointers when duplicates drop below the threshold.
 *
 * Returns `referenceGuide: undefined` when the source guide is
 * undefined (no findings at all); returns the unchanged source guide
 * when no duplicates crossed the threshold (no hoist needed).
 */
export function hoistAndBuildReferenceGuide<T extends AgentFinding>(
  fileEntries: readonly {
    readonly path: string;
    readonly findings: readonly T[];
  }[],
  sourceGuide: ReferenceGuide | undefined,
): {
  readonly files: readonly {
    readonly path: string;
    readonly findings: readonly T[];
    readonly groupFixDescriptionRefs?: readonly GroupFixDescriptionRef[];
  }[];
  readonly referenceGuide: ReferenceGuide | undefined;
} {
  const { fixDescriptions, hoistedKeys } = hoistFixDescriptions(fileEntries);
  const rewritten = applyFixDescriptionHoist(fileEntries, hoistedKeys);
  if (sourceGuide === undefined) {
    return { files: rewritten, referenceGuide: undefined };
  }
  const hasFixDescriptions = Object.keys(fixDescriptions).length > 0;
  if (!hasFixDescriptions) {
    return { files: rewritten, referenceGuide: sourceGuide };
  }
  return {
    files: rewritten,
    referenceGuide: { ...sourceGuide, fixDescriptions },
  };
}

function rewriteFinding<T extends AgentFinding>(finding: T, hoistedKeys: ReadonlySet<string>): T {
  if (finding.fix === undefined) return finding;
  const { description } = finding.fix;
  if (description === undefined || description.length === 0) return finding;
  const hash = hashFixDescription(description);
  if (!hoistedKeys.has(compositeKey(finding.ruleId, hash))) return finding;
  // Strip `description` from the emitted AgentFix; keep every other
  // field (oldText, newText when present). Never emit BOTH the pointer
  // and the inline description — doctrine in
  // `docs/kb/architecture/ai-first-consumer.md` under "Ambiguous field
  // shapes are dishonest."
  //
  // Post V1-FIX-SAFETY-CONSTANT-FIELD: if the stripped fix has no
  // sibling payload (guidance-only case — no oldText/newText), drop
  // the entire `fix` object. `fixDescriptionRef` now carries the
  // prose pointer; an empty `fix: {}` alongside it is ambiguous
  // dead-weight per the same doctrine rule.
  const { description: _omitted, ...fixRest } = finding.fix;
  const fixHasPayload = Object.keys(fixRest).length > 0;
  if (fixHasPayload) {
    return {
      ...finding,
      fix: fixRest,
      fixDescriptionRef: { hash },
    };
  }
  const { fix: _droppedFix, ...findingRest } = finding;
  return {
    ...(findingRest as T),
    fixDescriptionRef: { hash },
  };
}
