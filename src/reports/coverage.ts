/**
 * Coverage report — per-standard automation and pass/fail counts.
 *
 * Given a ScanResult and the loaded Standard objects, computes:
 *   - how many criteria each standard declares
 *   - how many of those are statically automatable (not "manual")
 *   - how many automatable criteria currently have zero violations
 *   - how many automatable criteria have at least one violation
 *
 * This is the foundation data for --coverage, --vpat, and
 * --certification. All three of those downstream reports pivot on
 * the same shape, so they share the same builder.
 *
 * Per-criterion detail hangs off {@link PerStandardCoverage.criteria}
 * so callers can surface attestation state without re-walking the
 * standard. Attestation integration lives in
 * {@link mergeAttestationIntoCoverage}: a fresh coverage report
 * omits `attested` everywhere; the merge helper folds durable
 * attestations in per the AI-first consumer model (surface, don't
 * suppress — agents read the attested state directly).
 */

import type { ConformanceProfile } from "../config/profiles.ts";
import type { AttestationRecord } from "../types/evidence.ts";
import type { Standard } from "../types/standard.ts";
import type { CoverageEntry, ScanResult } from "../types/violation.ts";
import {
  type AttestationStalenessProbe,
  createGitStalenessProbe,
  indexAttestationsByCriterion,
  pickMostRecentAttestation,
} from "./attestation-surface.ts";

/**
 * Per-criterion detail carried on a coverage entry. `static` is the
 * verdict the static scanner can defend by itself; `attested` — when
 * present — carries the most recent durable attestation's verdict and
 * staleness (stamp commit vs. HEAD scope intersection).
 *
 * Shape rules (AI-first consumer model):
 *   - `attested` is omitted when no attestation speaks to this
 *     criterion; never emit `null` or an empty object.
 *   - `stale` is omitted when the probe answered cleanly and the
 *     attestation is fresh, or when the probe couldn't answer at all
 *     (staleness indeterminate; we don't guess).
 */
export interface CoverageCriterion {
  readonly criterionId: string;
  /**
   * Static verdict the scanner can defend by itself.
   *   - `"pass"` — automatable, ran on eligible input, zero violations.
   *   - `"fail"` — at least one violation emitted for this criterion.
   *   - `"manual"` — metadata-manual criterion with no fired rule; the
   *     agent has to triage via the checklist tool.
   *   - `"untestable"` — automatable criterion whose satisfying rules
   *     declared extension eligibility but saw zero applicable input
   *     in this scan (e.g. `contrast/minimum` on a Tailwind project with
   *     no authored `.css` files). Paired with the new `untestable`
   *     counter on {@link PerStandardCoverage} so consumers can split
   *     "ran + clean" from "never had input to look at." Only emitted
   *     when the caller threads a `testableCriteria` set through
   *     {@link buildCoverageReport}'s options; absent-by-default keeps
   *     legacy callers on the original three-variant union.
   */
  readonly static: "pass" | "fail" | "manual" | "untestable";
  readonly attested?: {
    readonly verdict: "pass" | "fail" | "n/a" | "pending";
    readonly stale?: true;
  };
}

export interface PerStandardCoverage {
  readonly standardId: string;
  readonly standardName: string;
  readonly version: string;
  readonly total: number;
  /**
   * Per-level breakdown of the criteria captured by `total`. Keys are
   * present only for levels the standard actually defines (e.g. WCAG
   * uses `A` / `AA` / `AAA`; Section 508 has no level qualifier and
   * surfaces under `base`). The numeric values sum to `total` exactly —
   * the field anchors the otherwise-bare `total` count to its
   * conformance-level shape so an MCP consumer can verify that an
   * `AA` coverage scope didn't silently include `AAA` rows.
   *
   * Per `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
   * shapes are dishonest": a bare `total` without level context could be
   * over-counted or under-counted relative to the active conformance
   * profile, with the agent unable to tell which.
   */
  readonly criteriaByLevel: Readonly<Record<string, number>>;
  readonly automatable: number;
  readonly manual: number;
  readonly passing: number;
  readonly failing: number;
  /** Criterion IDs that have at least one violation. */
  readonly failingCriteria: readonly string[];
  /** Criterion IDs that are manual-only and need human review. */
  readonly manualCriteria: readonly string[];
  /**
   * Automatable criteria that had eligible input (ran) AND emitted zero
   * violations. Only populated when the caller threads a
   * `testableCriteria` set through {@link buildCoverageReport}'s
   * options; defaults to `passing` so legacy callers preserve the old
   * "all automatable non-failing criteria count as clean" semantics.
   *
   * Shape rule: `clean + withFindings === evaluated`. When
   * `testableCriteria` is supplied this holds exactly; when absent the
   * `evaluated` / `untestable` split collapses to `automatable / 0`.
   */
  readonly clean: number;
  /**
   * Automatable criteria with ≥1 emitted violation. Alias for
   * `failing` — kept as a sibling of the new evaluated/clean/untestable
   * counters so the four-field story (`evaluated = clean +
   * withFindings`, `automatable = evaluated + untestable`) reads as one
   * shape at a glance instead of forcing consumers to cross-reference
   * `failing` with the newer counters.
   */
  readonly withFindings: number;
  /**
   * Automatable criteria whose satisfying rules had extension eligibility
   * but saw zero applicable input in this scan. Zero when the caller
   * doesn't opt in (no `testableCriteria` threaded through), so the old
   * `automatable = passing + failing` invariant still holds on legacy
   * callers. When opt-in: `automatable = clean + withFindings + untestable`.
   */
  readonly untestable: number;
  /**
   * Count of automatable criteria that actually ran on eligible input
   * (`clean + withFindings`). Equivalent to `automatable - untestable`.
   * Agents should prefer this over `automatable` when reporting "how
   * many criteria did the scan actually evaluate?" — the gap between
   * the two is the canonical Tailwind-pre-build silent-miss shape.
   */
  readonly evaluated: number;
  /** Criterion IDs that fell into the `untestable` lane. Sorted. */
  readonly untestableCriteria: readonly string[];
  /**
   * 0–100 automated-pass rate. Denominator is `evaluated` — criteria
   * the scan actually ran with eligible input — so a Tailwind project
   * whose authored tree has zero `.css` files doesn't silently sink its
   * pass rate on rules that never had anything to look at. Falls back
   * to the legacy `passing / automatable` formula when the caller
   * doesn't thread `testableCriteria` through (backward compat).
   */
  readonly automatedPassRate: number;
  /**
   * Per-criterion detail — one entry per criterion in the standard
   * (after level filtering). Always populated; `attested` is omitted
   * on entries that carry no durable attestation. Callers that need
   * aggregate counts only can ignore this field.
   */
  readonly criteria: readonly CoverageCriterion[];
  /**
   * Count of manual-only criteria that have a non-stale `pass` or
   * `n/a` attestation. These are folded into the aggregate pass
   * numerator and the `coveredManualCriteria` list; `manual` itself
   * is left intact so consumers can still see the full manual surface.
   * Present only when a merge has happened; omitted on the untouched
   * base report.
   */
  readonly coveredManual?: number;
  /**
   * Criterion IDs for manual criteria covered by attestation — same
   * set that `coveredManual` counts. Sorted for determinism.
   */
  readonly coveredManualCriteria?: readonly string[];
}

/**
 * Builds a per-standard coverage report from scan results + loaded standards.
 *
 * The optional `profile` narrows the criterion scope to a named conformance
 * profile (see `src/config/profiles.ts`). When supplied:
 *   - Only standards whose ID is listed in `profile.standards` appear in the
 *     report (even if `result.enabledStandards` is wider — the caller asked
 *     for a profile-scoped view).
 *   - `profile.level`, when set, overrides the `level` argument. WCAG-like
 *     profiles (`wcag22-aa`) carry a level; level-less profiles (Section 508,
 *     EN 301 549) fall through to `level`.
 *
 * When `profile` is `undefined`, behavior is unchanged — every enabled
 * standard's criteria up to `level` appear in the output.
 */
export function buildCoverageReport(
  result: ScanResult,
  loadedStandards: readonly Standard[],
  level?: "A" | "AA" | "AAA",
  profile?: ConformanceProfile,
  options?: CoverageReportOptions,
): readonly PerStandardCoverage[] {
  const enabledSet = new Set(result.enabledStandards);
  const profileStandards = profile === undefined ? null : new Set(profile.standards);
  const effectiveLevel = profile?.level ?? level;
  const failingByStandard = indexFailingCriteria(result);
  const maxLevel = levelRank(effectiveLevel ?? "AAA");

  const out: PerStandardCoverage[] = [];
  for (const standard of loadedStandards) {
    if (!enabledSet.has(standard.id)) continue;
    if (profileStandards !== null && !profileStandards.has(standard.id)) continue;
    const filtered = filterByLevel(standard, maxLevel);
    out.push(buildOne(filtered, failingByStandard.get(standard.id) ?? new Set(), options));
  }
  return out;
}

/**
 * Optional extras for {@link buildCoverageReport}. Threading a
 * `testableCriteria` set in opts the builder into splitting the
 * automatable-pass counter into `clean` (ran + zero findings) vs.
 * `untestable` (rule declared extension eligibility but zero
 * applicable input) — the canonical Tailwind-pre-build shape.
 *
 * Backward compat: when `testableCriteria` is absent, the report's
 * `untestable` field is `0` and the pass-rate denominator stays on
 * `automatable` so legacy callers see identical numbers.
 */
export interface CoverageReportOptions {
  /**
   * Criterion IDs for which at least one satisfying rule had
   * `filesEligible > 0` on this scan. Callers typically derive this
   * from `perRuleCoverage` via the equivalence closure so a rule
   * satisfying `wcag22:1.4.3` also marks `section508:1194.22.c` /
   * `en301549:9.1.4.3` as testable. When absent, the builder skips
   * the untestable split entirely and the report's `evaluated` /
   * `clean` counters collapse to `automatable` / `passing`.
   */
  readonly testableCriteria?: ReadonlySet<string>;
}

const LEVEL_RANKS: Readonly<Record<string, number>> = { A: 1, AA: 2, AAA: 3, base: 1 };

function levelRank(level: string): number {
  return LEVEL_RANKS[level] ?? 3;
}

function filterByLevel(standard: Standard, maxLevel: number): Standard {
  const filtered = standard.criteria.filter((c) => levelRank(c.level) <= maxLevel);
  return { ...standard, criteria: filtered };
}

function buildOne(
  standard: Standard,
  failingSet: ReadonlySet<string>,
  options: CoverageReportOptions | undefined,
): PerStandardCoverage {
  let automatable = 0;
  let manual = 0;
  let passing = 0;
  let failing = 0;
  let untestable = 0;
  const failingCriteria: string[] = [];
  const manualCriteria: string[] = [];
  const untestableCriteria: string[] = [];
  const criteria: CoverageCriterion[] = [];
  // Per-level tally keyed by the criterion's declared level — anchors
  // `total` to the conformance-level shape so consumers can verify the
  // count agrees with the active profile (`A` / `AA` / `AAA` for WCAG;
  // `base` for level-less standards). Values sum to
  // `standard.criteria.length` exactly by construction (every criterion
  // contributes to exactly one bucket). See PerStandardCoverage.criteriaByLevel
  // doctrine note.
  const byLevel: Record<string, number> = {};
  // Opt-in split: absent testableCriteria collapses to "every
  // automatable non-failing criterion counts as clean" so legacy
  // callers see identical numbers. Present set drives the
  // Tailwind-pre-build fix where a rule with zero eligible input
  // routes into the `untestable` lane instead of silently buffing the
  // pass rate (the canonical Q-SHARED-PASS-RATE-COMPOSITE miss).
  const testableCriteria = options?.testableCriteria;
  const splitOn = testableCriteria !== undefined;

  for (const criterion of standard.criteria) {
    byLevel[criterion.level] = (byLevel[criterion.level] ?? 0) + 1;
    // A rule satisfying a metadata-"manual" criterion can still emit
    // automated violations (e.g. `color/meaning-by-color-only`
    // satisfies wcag22:1.4.1 "Use of Color" whose metadata flag is
    // `automatable: "manual"`). Honor the emitted violation: if
    // `failingSet.has(id)` the criterion counts as failing in the
    // automated lane regardless of the metadata flag. The contract —
    // `failingCriteria` = criteria with at least one emitted violation
    // — matches scan_project's per-finding criteria and the VPAT
    // report (which also treats violation-bearing manual criteria as
    // "Does Not Support"). This avoids cross-surface drift per CLAUDE.md
    // §1 "One tool call should answer 'what next?'": otherwise a scan
    // would surface 14 color/meaning findings against 1.4.1 while
    // coverage silently omits 1.4.1 from `failingAutomatedCriteria`.
    // Metadata-manual criteria with no fired rule stay in the manual
    // lane so the checklist only surfaces truly-untouched criteria —
    // avoids asking the agent to manually review something that
    // already failed an automated check.
    const fired = failingSet.has(criterion.id);
    if (criterion.automatable === "manual" && !fired) {
      manual += 1;
      manualCriteria.push(criterion.id);
      criteria.push({ criterionId: criterion.id, static: "manual" });
      continue;
    }
    automatable += 1;
    if (fired) {
      // A fired criterion implies some rule evaluated at least one
      // file, so `withFindings` is always testable by construction —
      // we never route a fail into the untestable lane.
      failing += 1;
      failingCriteria.push(criterion.id);
      criteria.push({ criterionId: criterion.id, static: "fail" });
      continue;
    }
    const testable = !splitOn || testableCriteria?.has(criterion.id) === true;
    if (testable) {
      passing += 1;
      criteria.push({ criterionId: criterion.id, static: "pass" });
    } else {
      untestable += 1;
      untestableCriteria.push(criterion.id);
      criteria.push({ criterionId: criterion.id, static: "untestable" });
    }
  }

  // Denominator is `evaluated` (clean + failing) when the caller
  // opted into the split, so rules with zero eligible input don't sink
  // the pass rate. Falls back to the legacy `passing / automatable`
  // formula when `testableCriteria` is absent so callers that haven't
  // threaded per-rule coverage through see unchanged numbers.
  const evaluated = passing + failing;
  const denominator = splitOn ? evaluated : automatable;
  const automatedPassRate = denominator > 0 ? Math.round((passing / denominator) * 100) : 0;

  return {
    standardId: standard.id,
    standardName: standard.name,
    version: standard.version,
    total: standard.criteria.length,
    criteriaByLevel: byLevel,
    automatable,
    manual,
    passing,
    failing,
    failingCriteria: failingCriteria.sort(),
    manualCriteria: manualCriteria.sort(),
    clean: passing,
    withFindings: failing,
    untestable,
    evaluated,
    untestableCriteria: untestableCriteria.sort(),
    automatedPassRate,
    criteria,
  };
}

/**
 * Indexes criteria that have real violations (error/warning severity).
 * Info-severity findings are notes for review, not failures — a criterion
 * with only info-level findings is "passing with notes", not a gap.
 */
function indexFailingCriteria(result: ScanResult): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const violation of result.violations) {
    if (violation.severity === "info") continue;
    for (const criterionId of violation.criteria) {
      const colonIndex = criterionId.indexOf(":");
      if (colonIndex < 0) continue;
      const standardId = criterionId.slice(0, colonIndex);
      let set = map.get(standardId);
      if (!set) {
        set = new Set();
        map.set(standardId, set);
      }
      set.add(criterionId);
    }
  }
  return map;
}

/** Adapter to the engine's simpler CoverageEntry shape. */
export function toEngineCoverageEntry(report: PerStandardCoverage): CoverageEntry {
  return {
    standardId: report.standardId,
    automated: report.automatable,
    total: report.total,
    passing: report.passing,
    failing: report.failing,
  };
}

/**
 * Folds durable attestations into an existing coverage report. For
 * each criterion the helper looks up every attestation that speaks
 * to it, picks the most-recent via
 * {@link pickMostRecentAttestation}, probes staleness through git
 * (when `cwd` is inside a repo), and decorates the matching
 * {@link CoverageCriterion} with `attested`.
 *
 * Aggregate pass-rate semantics (per doctrine): static verdict wins.
 *   - `static === "pass"` with any attestation → still counted as
 *     covered (attestation surfaces but doesn't override).
 *   - `static === "fail"` with a `pass` attestation → still fails;
 *     a real violation exists in the tree and the attestation is
 *     surfaced alongside it so the agent can triage. Fail attestations
 *     do not flip static-pass criteria to fail — the static scan is
 *     authoritative for the automated slice.
 *   - `static === "manual"` with a non-stale `pass` or `n/a`
 *     attestation → folded into the pass numerator. Stale
 *     attestations and `pending`/`fail` verdicts do NOT count as
 *     covered (the agent explicitly has not-yet-verdicted or has
 *     asserted failure).
 *
 * The original coverage array is not mutated; this is a pure
 * transformation. When the staleness probe cannot be built (cwd
 * outside a git repo, or omitted entirely) the merge still runs —
 * attestations still surface, but without `stale` annotations.
 *
 * @param coverage - Coverage entries produced by {@link buildCoverageReport}.
 * @param attestations - Durable records from the attestation store
 *   plus inline pragmas; order is not significant.
 * @param source - Either a `cwd` string (git-backed probe resolved
 *   from disk), or `{ cwd }` / `{ probe }` for callers that already
 *   own a resolved probe. Plain `undefined` disables staleness
 *   entirely — honest shape when the probe is unavailable.
 */
export function mergeAttestationIntoCoverage(
  coverage: readonly PerStandardCoverage[],
  attestations: readonly AttestationRecord[],
  source?: string | { readonly cwd?: string; readonly probe?: AttestationStalenessProbe },
): readonly PerStandardCoverage[] {
  if (coverage.length === 0) return coverage;
  const indexed = indexAttestationsByCriterion(attestations);
  const probe = resolveProbe(source);
  return coverage.map((entry) => mergeOne(entry, indexed, probe));
}

function resolveProbe(
  source:
    | string
    | { readonly cwd?: string; readonly probe?: AttestationStalenessProbe }
    | undefined,
): AttestationStalenessProbe | undefined {
  if (source === undefined) return undefined;
  if (typeof source === "string") return createGitStalenessProbe(source);
  if (source.probe !== undefined) return source.probe;
  if (source.cwd !== undefined) return createGitStalenessProbe(source.cwd);
  return undefined;
}

function mergeOne(
  entry: PerStandardCoverage,
  indexed: ReadonlyMap<string, readonly AttestationRecord[]>,
  probe: AttestationStalenessProbe | undefined,
): PerStandardCoverage {
  const coveredManualCriteria: string[] = [];
  const nextCriteria: CoverageCriterion[] = entry.criteria.map((c) => {
    const records = indexed.get(c.criterionId);
    if (records === undefined || records.length === 0) return c;
    const record = pickMostRecentAttestation(records);
    if (record === undefined) return c;
    const verdict: "pass" | "fail" | "n/a" | "pending" = record.verdict ?? "pending";
    const staleResult = probe === undefined ? null : probe.isStale(record);
    const attested: { verdict: typeof verdict; stale?: true } =
      staleResult === true ? { verdict, stale: true } : { verdict };
    if (c.static === "manual" && !attested.stale && (verdict === "pass" || verdict === "n/a")) {
      coveredManualCriteria.push(c.criterionId);
    }
    return { ...c, attested };
  });

  // Static verdict wins for the automatable-pass counters — manual
  // coverage via attestation is tracked separately so consumers can
  // see both numbers. `passing` / `failing` stay on static evidence;
  // `coveredManual` names the newly-certified-by-attestation slice.
  const coveredManual = coveredManualCriteria.length;
  if (coveredManual === 0) return { ...entry, criteria: nextCriteria };
  return {
    ...entry,
    criteria: nextCriteria,
    coveredManual,
    coveredManualCriteria: coveredManualCriteria.sort(),
  };
}
