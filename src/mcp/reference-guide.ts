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
 * Minimum number of times a given `(ruleId, description)` pair must
 * appear in a response before it becomes eligible for hoisting. At the
 * singleton threshold (1), indirecting through a lookup table is pure
 * overhead — no savings. At 2 or more, the hoist starts paying.
 */
const FIX_DESCRIPTION_HOIST_THRESHOLD = 2;

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
   * `(ruleId, description)` pair repeats ≥
   * {@link FIX_DESCRIPTION_HOIST_THRESHOLD} times in the response. When
   * present, findings whose description was hoisted carry
   * `fixDescriptionRef: { hash }` and omit `fix.description`; findings
   * whose description was unique in the response keep `fix.description`
   * inline.
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
 * First pass of the hoist: scan every finding, count
 * `(ruleId, description)` occurrences, and emit:
 *
 *   - `fixDescriptions` — nested `{ [ruleId]: { [hash]: description } }`
 *     for every pair that appeared ≥ {@link FIX_DESCRIPTION_HOIST_THRESHOLD}
 *     times.
 *   - `hoistedKeys` — the same pairs, encoded as composite keys so the
 *     second pass can branch in O(1).
 *
 * Pure function — no I/O, no side effects. Safe to call on the
 * post-`buildAgentFinding` `fileEntries` even though `AgentFinding`
 * objects are `readonly`: we don't mutate them here.
 *
 * `semantics/label-in-name` is the motivating case: it emits two
 * distinct verdicts (a 466-char and a 1970-char description) that each
 * repeat multiple times in a single scan. Keying by
 * `(ruleId, hash-of-desc)` keeps both; keying by ruleId alone would
 * drop one silently and replace every second-verdict finding with a
 * first-verdict pointer — a dishonest shape per
 * `docs/kb/architecture/ai-first-consumer.md`.
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
 * Walks the tally and keeps only `(ruleId, hash)` pairs that crossed
 * {@link FIX_DESCRIPTION_HOIST_THRESHOLD} — those become the hoisted
 * map + the set of composite keys the rewrite pass branches on.
 */
function buildHoistResult(byRule: Map<string, Map<string, TallyEntry>>): HoistResult {
  const fixDescriptions: Record<string, Record<string, string>> = {};
  const hoistedKeys = new Set<string>();
  for (const [ruleId, perRule] of byRule) {
    for (const [hash, entry] of perRule) {
      if (entry.count < FIX_DESCRIPTION_HOIST_THRESHOLD) continue;
      let bucket = fixDescriptions[ruleId];
      if (bucket === undefined) {
        bucket = {};
        fixDescriptions[ruleId] = bucket;
      }
      bucket[hash] = entry.description;
      hoistedKeys.add(compositeKey(ruleId, hash));
    }
  }
  return { fixDescriptions, hoistedKeys };
}

/**
 * Second pass: walk every finding and — for those whose description
 * was hoisted in the first pass — replace the inline `fix.description`
 * with `fixDescriptionRef: { hash }`. Findings whose description was
 * unique in the response (or whose description is absent entirely)
 * pass through unchanged.
 *
 * Returns a new file-entries array; does not mutate the input.
 */
export function applyFixDescriptionHoist<T extends AgentFinding>(
  fileEntries: readonly {
    readonly path: string;
    readonly findings: readonly T[];
  }[],
  hoistedKeys: ReadonlySet<string>,
): readonly { readonly path: string; readonly findings: readonly T[] }[] {
  if (hoistedKeys.size === 0) return fileEntries;
  return fileEntries.map((file) => ({
    path: file.path,
    findings: file.findings.map((finding) => rewriteFinding(finding, hoistedKeys)),
  }));
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
  readonly files: readonly { readonly path: string; readonly findings: readonly T[] }[];
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
  // field (safety, oldText, newText when present). Never emit BOTH the
  // pointer and the inline description — doctrine in
  // `docs/kb/architecture/ai-first-consumer.md` under "Ambiguous field
  // shapes are dishonest."
  const { description: _omitted, ...fixRest } = finding.fix;
  return {
    ...finding,
    fix: fixRest,
    fixDescriptionRef: { hash },
  };
}
