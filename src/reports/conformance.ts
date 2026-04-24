/**
 * Conformance statement — the "can this codebase claim conformance?"
 * gate built on top of the evidence ledger.
 *
 * Given an {@link EvidenceLedger} and a {@link ConformanceProfile} (a
 * standard + level scope), the report inspects every criterion inside
 * the profile and either:
 *
 *   - Emits a statement with `conformant: true` when every in-scope
 *     criterion carries at least one non-`candidate` evidence source
 *     and its status is `"pass"` or `"n/a"`.
 *   - Refuses to emit (`conformant: false`) and lists every blocker —
 *     criteria that are still `"unknown"`, `"fail"`, or only backed by
 *     candidate sources. Each blocker names the criterion, its
 *     current status, and the reason it's blocking so the agent can
 *     route to `attest` / `suggest_fix` / `checklist` without a
 *     second round trip.
 *
 * The report is pure — same ledger + profile in, same statement out.
 * No disk IO, no randomness; the caller is responsible for surfacing
 * the statement (print, commit, ship to auditor).
 *
 * See docs/adr/0011-evidence-as-first-class-primitive.md for the
 * broader evidence model this report sits on top of.
 */

import type { ConformanceProfile as ConfigConformanceProfile } from "../config/profiles.ts";
import type { Process } from "../types/config.ts";
import {
  ATTESTATION_EVIDENCE_SOURCES,
  type AttestationEvidenceSource,
  type AttestationRecord,
  type CriterionEvidence,
  type EvidenceLedger,
  type EvidenceSource,
  type EvidenceStatus,
} from "../types/evidence.ts";
import type { Standard } from "../types/standard.ts";
import type { AttestationStalenessProbe } from "./attestation-surface.ts";
import {
  type ConfigFingerprint,
  type ConformanceSignature,
  type FileManifestEntry,
  type SignatureInput,
  signConformanceBundleAt,
} from "./conformance-signature.ts";
import { RUNTIME_EVIDENCE_REQUIRED_CRITERIA } from "./runtime-evidence-criteria.ts";

/**
 * Local WCAG criterion IDs that can only be evaluated across a declared
 * set of pages — 2.4.5 "Multiple ways", 3.2.3 "Consistent navigation",
 * 3.2.4 "Consistent identification" (ADR 0016). When a conformance
 * profile puts any of these in scope without a `processes` config, the
 * builder emits a `missing-process-config` blocker: the criterion
 * cannot be evaluated from per-page static analysis alone.
 */
const PROCESS_LEVEL_CRITERIA: ReadonlySet<string> = new Set([
  "wcag22:2.4.5",
  "wcag22:3.2.3",
  "wcag22:3.2.4",
  "wcag21:2.4.5",
  "wcag21:3.2.3",
  "wcag21:3.2.4",
]);

/**
 * Defines the scope of a conformance claim. For WCAG, `level` narrows
 * to A / AA / AAA; for standards that don't have levels (Section 508,
 * some plugins), pass `"base"` to mean "every criterion."
 */
export interface ConformanceProfile {
  readonly standardId: string;
  readonly level: "A" | "AA" | "AAA" | "base";
}

/**
 * Why a specific criterion is blocking the conformance claim. Agents
 * route on `reason`:
 *   - `"no-evidence"` → call `attest` with a reason, or run manual
 *     review (`checklist`).
 *   - `"failing"` → call `suggest_fix` to resolve the violations.
 *   - `"candidate-only"` → the manual-review finder surfaced a
 *     location but no one has attested. Call `attest` or dismiss
 *     after reading.
 *   - `"partially-attested"` → some rules under this criterion have
 *     been attested but the union of attested `ruleIds` does not cover
 *     every satisfying rule. Call `attest` with the missing `ruleIds`
 *     (see ADR 0013).
 *   - `"runtime-evidence-required"` → the criterion's normative
 *     requirement is about runtime behavior (keyboard traversal, focus
 *     visibility, rendered contrast, heading adequacy, …) that static
 *     source analysis fundamentally cannot observe. The absence of a
 *     static finding is not evidence of conformance; call `attest`
 *     with the verdict of a runtime harness or manual review. These
 *     criteria also appear in `statement.limitations[]`.
 */
export type ConformanceBlockerReason =
  | "no-evidence"
  | "failing"
  | "candidate-only"
  | "partially-attested"
  | "stale-attestation"
  | "missing-process-config"
  | "runtime-evidence-required";

/**
 * Claim-level status for one criterion on a {@link ConformanceBlocker}.
 *
 * Widens the ledger's {@link EvidenceStatus} with `"undetermined"` — a
 * blocker-only value for criteria whose static layer structurally cannot
 * prove pass (keyboard, focus-visible, rendered contrast, …) and that
 * have no runtime-sourced attestation closing the gap. The ledger itself
 * still emits `"pass"` for these entries (absence-of-failure on an
 * automatable criterion); the conformance statement re-classifies them
 * because a claim reader asks a stricter question than the ledger
 * answers: "can we honestly say this passes?" rather than "did anything
 * fail?". See `RUNTIME_EVIDENCE_REQUIRED_CRITERIA`.
 */
export type ConformanceCriterionStatus = EvidenceStatus | "undetermined";

export interface ConformanceBlocker {
  readonly criterionId: string;
  readonly title: string;
  readonly level: string;
  readonly status: ConformanceCriterionStatus;
  readonly reason: ConformanceBlockerReason;
  /**
   * Count of attested sources that backed this criterion. Zero when
   * the criterion is blocked by `no-evidence` or `candidate-only`.
   * Non-zero `attested` count with a `failing` status means at least
   * one attested-fail source overrode a would-be pass.
   */
  readonly attestedSources: number;
  /**
   * Count of static violations against this criterion. Non-zero
   * counts are the primary signal for `reason: "failing"`.
   */
  readonly staticSources: number;
  /** Count of candidate pointers surfaced by review finders. */
  readonly candidateSources: number;
  /**
   * Present when `reason === "partially-attested"`: the rule IDs under
   * this criterion that have not yet been attested. The agent can pass
   * these directly to `attest({ criterionId, ruleIds })` to close the
   * coverage gap. Omitted for other blocker reasons.
   */
  readonly missingRuleIds?: readonly string[];
  /**
   * Present when `reason === "stale-attestation"`: the `attestedAt`
   * timestamp of the attestation that became stale against the current
   * tree. Agents use this to cite which attestation needs refreshing
   * without having to re-enumerate the ledger. Omitted for other
   * blocker reasons.
   */
  readonly staleAttestedAt?: string;
}

/**
 * Scope of the conformance claim in a static-scanner context — a file
 * set (not a URL set, since ra11y inspects source trees rather than
 * deployed pages). ADR 0017 reserves space here for the commit anchor,
 * config snapshot, and process definitions; the commit/config fields
 * are optional and follow the AI-first consumer model's
 * present-when-meaningful rule. The signing flow
 * (V1-CERT-STATEMENT-SIGN) is the call site that wires the commit
 * hash through.
 */
export interface ConformanceStatementScope {
  /**
   * Total count of files included in the scan — the load-bearing
   * manifest size the claim stands on. Always present (including `0`
   * when nothing was scanned) so a reader can distinguish "not
   * truncated" from "field absent", and so the count stays honest even
   * when {@link files} is capped or elided for response-size reasons.
   */
  readonly filesCount: number;
  /**
   * File paths included in the scan. Paths are mirrored verbatim from
   * the caller; the builder does not normalize. Present-when-meaningful:
   * the tool layer elides this array when it would exceed its configured
   * cap (emitting the `scope_files_truncated_count_exceeded` warning in
   * its stead). Callers wanting the full list flip `verboseScope: true`
   * on the MCP tool. When absent, rely on {@link filesCount} for size.
   */
  readonly files?: readonly string[];
  /**
   * Git commit hash at scan time. Omitted when the caller did not
   * supply one (e.g., scan outside a git repo, or the signing flow is
   * not yet wired). Never emitted as an empty string.
   */
  readonly commitHash?: string;
  /**
   * Snapshot of the `ra11y.config.ts` fields active during the scan —
   * `standard`, `level`, `exclude`, `nativeWrappers`, etc. Reproduces
   * the scan conditions from the statement alone. Omitted when the
   * caller did not supply one; never `{}`.
   */
  readonly configSnapshot?: Record<string, unknown>;
}

export interface ConformanceStatement {
  readonly profile: ConformanceProfile;
  readonly generatedAt: string;
  readonly conformant: boolean;
  /**
   * Human-readable title of the guidelines being claimed against
   * (WCAG §5.3.1(2)). Mirrored from `Standard.name`; always populated
   * so the required claim field never reads as absent.
   */
  readonly guidelinesTitle: string;
  /**
   * Version string of the guidelines — e.g. "2.2", "2.1". Mirrored from
   * `Standard.version` so the claim pins the exact spec edition the
   * statement was generated against.
   */
  readonly guidelinesVersion: string;
  /**
   * Canonical URI of the guidelines document, per WCAG §5.3.1(2).
   * Mirrored from `Standard.url`; e.g. "https://www.w3.org/TR/WCAG22/".
   */
  readonly guidelinesUri: string;
  /**
   * File manifest + (when the caller supplied them) commit/config
   * anchors that pin the claim. See {@link ConformanceStatementScope}.
   */
  readonly scope: ConformanceStatementScope;
  /**
   * Web content technologies the claim relies upon (WCAG §5.3.1(5)).
   * Caller-supplied; defaults to
   * {@link DEFAULT_TECHNOLOGIES_RELIED_UPON} when omitted. A future
   * track will derive this from the scanned file set in the evidence
   * ledger (ADR 0017); until then the default covers typical web
   * projects and the override is the supported path. Always populated.
   */
  readonly technologiesReliedUpon: readonly string[];
  /**
   * Technologies explicitly not relied upon. Empty array by default —
   * the common case where no technology is deliberately excluded.
   * Always populated for schema stability.
   */
  readonly technologiesNotReliedUpon: readonly string[];
  /**
   * Criteria the profile asked about. `criteriaInScope` is the
   * denominator of the claim; `blockers.length` is the gap. When
   * `conformant === true`, `blockers` is empty.
   */
  readonly criteriaInScope: number;
  readonly blockers: readonly ConformanceBlocker[];
  /**
   * Per-status tallies across in-scope criteria.
   *
   * `pass` counts only criteria whose ledger-derived status is
   * `"pass"` AND stand on at least one non-candidate evidence source
   * (static / attested / sampled) — i.e. a rule actually ran and
   * emitted zero findings, or an attestation covers the criterion.
   * `untested` counts criteria whose ledger status defaulted to
   * `"pass"` with zero sources of any kind — the "automatable with
   * no rule on eligible inputs" case the ledger cannot distinguish
   * from a real pass on its own. These appear in `blockers[]` with
   * `reason: "no-evidence"`; the split in `summary` matches the
   * procurement-grade doctrine "Composite headline counts are
   * dishonest" — `pass` is a load-bearing claim and must never sum
   * in criteria whose only signal was the ledger's zero-violations
   * default.
   */
  readonly summary: {
    readonly pass: number;
    readonly untested: number;
    readonly fail: number;
    readonly partial: number;
    readonly unknown: number;
    readonly na: number;
  };
  /**
   * Tamper-evident signature over the inputs the claim stands on —
   * commit hash, attestation ledger, in-scope criterion set, and
   * config fingerprint. Present only when the statement is conformant
   * and the caller supplied the signing inputs. Omitted on refusal
   * so the field is not a false assurance over a partial claim.
   */
  readonly signature?: ConformanceSignature;
  /**
   * Response-level warnings — structured codes the agent acts on. Only
   * populated when the builder degraded gracefully rather than emitting
   * a hard blocker: `"stale_probe_unavailable"` when the git staleness
   * probe couldn't answer (non-repo, git missing, shallow clone). The
   * field is omitted when empty per the AI-first consumer model.
   */
  readonly warnings?: readonly string[];
  /**
   * Criterion-level limitations on the claim — one entry per in-scope
   * criterion whose only signal was absence-of-findings against a
   * runtime-dependent requirement (keyboard, focus-visible, rendered
   * contrast, heading adequacy, …). Each entry is a structured string
   * shaped `"<criterionId>: <title> — runtime evidence required; no
   * static finding in scope, no attestation supplied"`. Consumers that
   * read `status === "pass"` unconditionally must now also inspect
   * `limitations[]` — the claim reader's test for honesty is whether
   * the static scanner had the axis to answer the question, not just
   * whether nothing tripped.
   *
   * Present only when non-empty, per the AI-first consumer model's
   * absent-vs-empty rule; the corresponding blockers also appear in
   * `blockers[]` with `reason: "runtime-evidence-required"` and
   * `status: "undetermined"` so the typed routing signal lives alongside
   * the prose. See `RUNTIME_EVIDENCE_REQUIRED_CRITERIA` for the
   * spec-derived enumeration backing this list.
   */
  readonly limitations?: readonly string[];
  /**
   * Per-evidence-source tally across the attestations the claim stood
   * on. `bySource` keys the four classifier values; only present keys
   * are populated. A reader scanning the claim sees at a glance what
   * mix of evidence — runtime-tool runs, manual review, human study,
   * self-declaration — the verdict rests on, which is the axis a
   * procurement auditor or VPAT reader cares about.
   *
   * Present only when the caller supplied the `signing.attestations`
   * input (the builder's only view of the full ledger); omitted
   * otherwise per the absent-vs-empty rule. Ordering: `bySource` keys
   * appear in the canonical order declared by
   * {@link ATTESTATION_EVIDENCE_SOURCES}.
   */
  readonly attestationSummary?: {
    readonly totalCount: number;
    readonly bySource: Readonly<Partial<Record<AttestationEvidenceSource, number>>>;
  };
}

/**
 * Safe default for web projects when the caller does not declare the
 * technologies the claim relies upon. Derivation from the scanned file
 * set is deferred to a later track (ADR 0017 open question); until
 * then, the default matches what a typical React/HTML/CSS project
 * would declare and keeps the required field populated.
 */
export const DEFAULT_TECHNOLOGIES_RELIED_UPON: readonly string[] = [
  "HTML",
  "CSS",
  "ECMAScript",
  "WAI-ARIA",
];

export interface BuildConformanceStatementInputs {
  readonly ledger: EvidenceLedger;
  readonly profile: ConformanceProfile;
  readonly standards: readonly Standard[];
  /**
   * Scanned file manifest — the set of paths the claim stands on.
   * Mirrored verbatim into `statement.scope.files`; the tool layer is
   * responsible for capping the array (and raising a truncation
   * warning) before passing it to the builder. When `undefined`, the
   * statement's `scope.files` is omitted; `scope.filesCount` is taken
   * from {@link filesCount} in that case.
   */
  readonly files?: readonly string[];
  /**
   * Total count of files in scope — mirrored verbatim into
   * `statement.scope.filesCount` when supplied. Required when {@link files}
   * is absent (tool-level truncation path) so the statement still names
   * the real count. When both are supplied and disagree, the caller wins
   * ({@link filesCount} is source of truth); the builder does not
   * reconcile.
   */
  readonly filesCount?: number;
  /**
   * Web content technologies the claim relies upon (WCAG §5.3.1(5)).
   * When omitted, {@link DEFAULT_TECHNOLOGIES_RELIED_UPON} is used so
   * the required field always has a defensible value.
   */
  readonly technologiesReliedUpon?: readonly string[];
  /**
   * Technologies explicitly not relied upon. Defaults to `[]`.
   */
  readonly technologiesNotReliedUpon?: readonly string[];
  /**
   * Commit hash at scan time. Forwarded verbatim into
   * `statement.scope.commitHash`. Omitted from the output when absent
   * or empty (no `""` sentinel).
   */
  readonly commitHash?: string;
  /**
   * Snapshot of `ra11y.config.ts` fields active during the scan.
   * Forwarded into `statement.scope.configSnapshot`. Omitted from the
   * output when absent or empty.
   */
  readonly configSnapshot?: Record<string, unknown>;
  /**
   * Optional named conformance profile (see `src/config/profiles.ts`)
   * whose `standards` + `level?` tuple narrows the claim's scope:
   *
   *   - The in-scope criterion filter keeps only criteria whose
   *     `standardId` appears in `scope.standards`.
   *   - When `scope.level` is set, the output statement's
   *     `profile.level` is overridden to match, and criteria above that
   *     level are excluded from scope (and blockers). Level-less
   *     profiles (Section 508, EN 301 549) fall through to the
   *     caller-supplied `profile.level`.
   *
   * When omitted, behavior is unchanged — the claim runs against the
   * full `profile.standardId` + `profile.level` scope the caller
   * supplied. Additive by construction; no profile = no filter.
   */
  readonly scope?: ConfigConformanceProfile;
  /**
   * Returns the rule IDs that satisfy the given criterion (via the
   * satisfying-rules index on the scanner's registries). Used by this
   * builder only to populate `missingRuleIds` on `partially-attested`
   * blockers so agents can call `attest` with an actionable ruleIds
   * list. When omitted, `missingRuleIds` is not populated — today's
   * callers that don't have a rules registry still get a correct
   * statement, just without the drill-down hint. See ADR 0013.
   */
  readonly rulesForCriterion?: (criterionId: string) => readonly string[];
  /**
   * Signing inputs for the tamper-evident signature stamped on a
   * conformant statement. When present and the claim is conformant,
   * the builder computes a SHA-256 over the canonicalized
   * (commit hash, attestation ledger, in-scope criterion set, config
   * fingerprint, optional file manifest, optional tool version) bundle
   * and attaches it as `statement.signature`. Omitted → no signature
   * field is emitted. The statement is still refused (no signature)
   * when any blocker remains.
   *
   * `fileManifest` and `toolVersion` are optional — callers that only
   * need the minimal (commit + attestations + criteria + config) scope
   * can leave them unset. The MCP tool passes both so the signature
   * catches both content drift on scanned files and ra11y version
   * changes. See {@link SignatureInput} for the canonicalization rules.
   */
  readonly signing?: {
    readonly commitHash: string;
    readonly attestations: readonly AttestationRecord[];
    readonly configFingerprint: ConfigFingerprint;
    readonly fileManifest?: readonly FileManifestEntry[];
    readonly toolVersion?: string;
  };
  /**
   * Optional git-backed staleness probe. When provided, the builder
   * checks every attested-pass (or n/a) source against the probe: an
   * attestation recorded at commit A against a file changed at commit B
   * flips the criterion to a `stale-attestation` blocker rather than
   * silently riding the pass through. When omitted (non-repo, caller
   * opted out), attestations are trusted as-is — matching the previous
   * behavior. When the probe returns `null` (indeterminate — stamp
   * couldn't resolve, git failed), the builder emits a
   * `stale_probe_unavailable` warning rather than guessing.
   */
  readonly stalenessProbe?: AttestationStalenessProbe;
  /**
   * Declared processes (page sets) from the loaded config — per
   * ADR 0016. When empty/undefined and the profile puts process-level
   * criteria (2.4.5 / 3.2.3 / 3.2.4) in scope, the builder refuses to
   * emit a conformance statement for those criteria: static per-page
   * analysis cannot evaluate "the nav order is the same across the
   * ordered page set" without an explicit page set. Each such criterion
   * surfaces as a `missing-process-config` blocker citing the criterion
   * ID. When at least one process is present, the check is satisfied —
   * deeper process-level evaluation (consistency across the ordered
   * page set) lives in `scan_process` and is expected to flow through
   * as `static`/`attested` evidence against those criteria.
   */
  readonly processes?: readonly Process[];
}

/**
 * Builds a {@link ConformanceStatement}. Refuses to emit
 * `conformant: true` unless every criterion in scope has at least
 * one non-`candidate` evidence source with a final status of `pass`
 * or `n/a`.
 */
export function buildConformanceStatement(
  inputs: BuildConformanceStatementInputs,
): ConformanceStatement {
  const { standard, inScope, effectiveLevel } = resolveScope(inputs);
  const { blockers, summary, warnings } = evaluateCriteria(inputs, inScope);

  const conformant = blockers.length === 0;
  const signature =
    conformant && inputs.signing !== undefined
      ? signConformanceBundleAt(
          buildSignatureInput(inputs.signing, inScope),
          inputs.ledger.meta.generatedAt,
        )
      : undefined;
  const effectiveProfile: ConformanceProfile = { ...inputs.profile, level: effectiveLevel };
  const scope = buildStatementScope(inputs);
  const limitations = buildLimitations(blockers);
  const attestationSummary = buildAttestationSummary(inputs.signing?.attestations);
  return {
    profile: effectiveProfile,
    generatedAt: inputs.ledger.meta.generatedAt,
    conformant,
    guidelinesTitle: standard.name,
    guidelinesVersion: standard.version,
    guidelinesUri: standard.url,
    scope,
    technologiesReliedUpon: inputs.technologiesReliedUpon ?? DEFAULT_TECHNOLOGIES_RELIED_UPON,
    technologiesNotReliedUpon: inputs.technologiesNotReliedUpon ?? [],
    criteriaInScope: inScope.length,
    blockers,
    summary,
    ...(signature !== undefined && { signature }),
    ...(warnings.size > 0 && { warnings: [...warnings].sort() }),
    ...(limitations.length > 0 && { limitations }),
    ...(attestationSummary !== undefined && { attestationSummary }),
  };
}

/**
 * Tallies attestations by `evidenceSource`. Returns `undefined` when
 * the caller didn't supply the `signing.attestations` list (the
 * builder's only view of the full ledger), or when the list is empty
 * — present-when-meaningful per the AI-first consumer model.
 *
 * Records whose `criterionId` isn't in scope for the statement still
 * tally: the summary reflects the ledger the claim was signed over,
 * not a filtered view — that matches the signature's scope and keeps
 * the numbers consistent when a reader cross-checks against
 * `list_attestations`.
 */
function buildAttestationSummary(
  attestations: readonly AttestationRecord[] | undefined,
): ConformanceStatement["attestationSummary"] {
  if (attestations === undefined || attestations.length === 0) return undefined;
  const counts = new Map<AttestationEvidenceSource, number>();
  for (const a of attestations) {
    counts.set(a.evidenceSource, (counts.get(a.evidenceSource) ?? 0) + 1);
  }
  const bySource: Partial<Record<AttestationEvidenceSource, number>> = {};
  for (const key of ATTESTATION_EVIDENCE_SOURCES) {
    const count = counts.get(key);
    if (count !== undefined && count > 0) bySource[key] = count;
  }
  return { totalCount: attestations.length, bySource };
}

/**
 * Assembles the response-level `limitations[]` string list from the
 * `runtime-evidence-required` blockers. Each entry is a one-line prose
 * record citing criterion + title + the reason the claim is incomplete
 * against that axis — shaped so a reader who never consumes `blockers[]`
 * can still see "we can't honestly say X passes." Present-when-meaningful:
 * the caller conditional-spreads this into the response so an empty list
 * is omitted rather than emitted as `limitations: []`.
 */
function buildLimitations(blockers: readonly ConformanceBlocker[]): readonly string[] {
  const entries: string[] = [];
  for (const b of blockers) {
    if (b.reason !== "runtime-evidence-required") continue;
    entries.push(
      `${b.criterionId}: ${b.title} — runtime evidence required; no static finding in scope, no attestation supplied.`,
    );
  }
  return entries;
}

/**
 * Resolves the in-scope criterion set and effective level. `scope`
 * (optional named profile from src/config/profiles.ts) narrows the
 * claim when present: filters the standard gate + overrides the
 * effective level. Absent → original `inputs.profile` drives scope
 * exactly as before. Throws when the caller's standardId doesn't
 * resolve to a loaded standard — that's a configuration error the
 * caller must surface.
 */
function resolveScope(inputs: BuildConformanceStatementInputs): {
  readonly standard: Standard;
  readonly inScope: readonly Standard["criteria"][number][];
  readonly effectiveLevel: ConformanceProfile["level"];
} {
  const standard = inputs.standards.find((s) => s.id === inputs.profile.standardId);
  if (!standard) {
    throw new Error(
      `ra11y: conformance profile references standard '${inputs.profile.standardId}' which is not loaded.`,
    );
  }
  const scopeStandards = inputs.scope === undefined ? null : new Set(inputs.scope.standards);
  const inScopeStandard = scopeStandards === null || scopeStandards.has(inputs.profile.standardId);
  const effectiveLevel: ConformanceProfile["level"] = inputs.scope?.level ?? inputs.profile.level;
  const inScope = inScopeStandard
    ? standard.criteria.filter((c) => isInLevel(c.level, effectiveLevel))
    : [];
  return { standard, inScope, effectiveLevel };
}

/**
 * Walks the in-scope criterion set, tallies the summary, and produces
 * the blocker list + any response-level warnings. Split from
 * {@link buildConformanceStatement} to keep the builder itself under
 * the project's cognitive-complexity budget — the loop body interleaves
 * per-criterion classification + shared-state mutation which compounds
 * the outer function's score.
 */
function evaluateCriteria(
  inputs: BuildConformanceStatementInputs,
  inScope: readonly Standard["criteria"][number][],
): {
  readonly blockers: readonly ConformanceBlocker[];
  readonly summary: SummaryTally;
  readonly warnings: ReadonlySet<string>;
} {
  const ledgerByCriterion = new Map(inputs.ledger.entries.map((e) => [e.criterionId, e] as const));
  const blockers: ConformanceBlocker[] = [];
  const warnings = new Set<string>();
  const summary: SummaryTally = { pass: 0, untested: 0, fail: 0, partial: 0, unknown: 0, na: 0 };
  const hasProcessConfig = (inputs.processes?.length ?? 0) > 0;
  for (const criterion of inScope) {
    const entry = ledgerByCriterion.get(criterion.id);
    const counts = countSources(entry?.sources ?? []);
    const status: EvidenceStatus = entry?.status ?? "unknown";
    tallySummary(summary, status, counts);
    const blocker = classifyOneCriterion({
      criterion,
      entry,
      counts,
      status,
      hasProcessConfig,
      stalenessProbe: inputs.stalenessProbe,
      rulesForCriterion: inputs.rulesForCriterion,
      warnings,
    });
    if (blocker !== null) blockers.push(blocker);
  }
  return { blockers, summary, warnings };
}

/**
 * Classifies one in-scope criterion against the blocker taxonomy.
 * Returns the blocker to append (or `null` when the criterion passes
 * cleanly). Side effect: may add `stale_probe_unavailable` to
 * {@link ClassifyCriterionArgs.warnings} when the probe answered
 * indeterminately on an otherwise-clean attested pass.
 *
 * Split out of {@link buildConformanceStatement} to keep the builder
 * under the project's cognitive-complexity budget — the loop body
 * previously interleaved three classification layers (process-config
 * gate → standard blocker classifier → staleness probe) with
 * shared-state mutation, pushing the function over the limit.
 */
interface ClassifyCriterionArgs {
  readonly criterion: Standard["criteria"][number];
  readonly entry: CriterionEvidence | undefined;
  readonly counts: SourceCounts;
  readonly status: EvidenceStatus;
  readonly hasProcessConfig: boolean;
  readonly stalenessProbe: AttestationStalenessProbe | undefined;
  readonly rulesForCriterion: ((criterionId: string) => readonly string[]) | undefined;
  readonly warnings: Set<string>;
}

function classifyOneCriterion(args: ClassifyCriterionArgs): ConformanceBlocker | null {
  const { criterion, entry, counts, status, hasProcessConfig, stalenessProbe, warnings } = args;
  // Process-level criteria (ADR 0016) require a `processes` config.
  // Without one, static per-page analysis cannot answer 2.4.5 / 3.2.3
  // / 3.2.4, and riding whatever pass-by-default the ledger produced
  // would be a dishonest claim. This check fires *before* the other
  // blocker classifications so an agent sees the structural gap rather
  // than a downstream "no-evidence" that hides the real cause.
  if (!hasProcessConfig && PROCESS_LEVEL_CRITERIA.has(criterion.id)) {
    return buildBlocker(
      criterion,
      status,
      "missing-process-config",
      counts,
      entry,
      args.rulesForCriterion,
    );
  }
  // Runtime-evidence-required criteria — the normative requirement is
  // about runtime behavior (keyboard reachability, focus visibility,
  // rendered contrast, …) that static analysis fundamentally cannot
  // observe in the passing direction. When the ledger has zero
  // fail-yielding sources AND no attested/sampled source closes the
  // gap, the former behavior collapsed "no evidence" into
  // `status: "pass", reason: "no-evidence"` — which read to an agent
  // as "checked clean" despite the static layer never having had the
  // axis to answer. Re-classify as `status: "undetermined"` with
  // `reason: "runtime-evidence-required"` so the honesty invariant
  // holds and the criterion surfaces in `statement.limitations[]`.
  if (
    RUNTIME_EVIDENCE_REQUIRED_CRITERIA.has(criterion.id) &&
    isUndeterminedRuntimeCriterion(status, counts)
  ) {
    return buildRuntimeEvidenceBlocker(criterion, counts);
  }
  const reason = classifyBlocker(status, counts, entry);
  if (reason !== null) {
    return buildBlocker(criterion, status, reason, counts, entry, args.rulesForCriterion);
  }
  // Pass/n/a with non-candidate evidence fell through `classifyBlocker`
  // as "no blocker." Before accepting that, check the staleness probe
  // against any attested source: an attestation recorded at commit A
  // against a file changed at commit B is not honest evidence the
  // current tree still satisfies the criterion. Probe === undefined
  // means the caller opted out (non-repo tests, CLI with no git) —
  // behave exactly as before. Probe returning `null` means the probe
  // itself failed — emit a `stale_probe_unavailable` warning rather
  // than guessing either direction.
  const stale = evaluateStaleness(entry, stalenessProbe);
  if (stale.outcome === "stale") {
    return buildStaleBlocker(criterion, status, counts, stale.attestedAt);
  }
  if (stale.outcome === "indeterminate") {
    warnings.add("stale_probe_unavailable");
  }
  return null;
}

/**
 * Result of the staleness check for one criterion's attested sources.
 *
 * - `"clean"` — probe ran and no attested source flagged stale, or the
 *   criterion had no attested sources to check. No blocker, no warning.
 * - `"indeterminate"` — at least one attested source probed `null`
 *   (stamp didn't resolve, git call failed). Caller adds a
 *   `stale_probe_unavailable` warning and lets the pass through; the
 *   builder does not fabricate staleness.
 * - `"stale"` — probe returned `true` for at least one attested-pass /
 *   attested-n/a source. Caller emits a `stale-attestation` blocker
 *   with the earliest stale `attestedAt` as citation.
 */
type StalenessOutcome =
  | { readonly outcome: "clean" }
  | { readonly outcome: "indeterminate" }
  | { readonly outcome: "stale"; readonly attestedAt: string };

/**
 * Rebuilds an {@link AttestationRecord} from one `attested`
 * {@link EvidenceSource} so the staleness probe (which was designed
 * against records, not sources) can be called without requiring the
 * builder's caller to hand the original record list through. Optional
 * fields are conditional-spread per the AI-first consumer model.
 */
function recordFromAttestedSource(
  criterionId: string,
  source: Extract<EvidenceSource, { kind: "attested" }>,
): AttestationRecord {
  return {
    criterionId,
    by: source.by,
    reason: source.reason,
    attestedAt: source.attestedAt,
    evidenceSource: source.evidenceSource,
    ...(source.toolName !== undefined && { toolName: source.toolName }),
    ...(source.runUrl !== undefined && { runUrl: source.runUrl }),
    ...(source.observedAt !== undefined && { observedAt: source.observedAt }),
    ...(source.ruleIds !== undefined && { ruleIds: source.ruleIds }),
    ...(source.scope !== undefined && { scope: source.scope }),
    ...(source.location !== undefined && { location: source.location }),
    ...(source.verdict !== undefined && { verdict: source.verdict }),
  };
}

/**
 * Probes every attested-pass / attested-n/a source on the entry and
 * collapses the per-source answers into one outcome for the criterion.
 *
 * `"stale"` wins over `"indeterminate"`: a definitive stale answer on
 * any source is enough to block, regardless of whether another source
 * probed cleanly-or-indeterminately. `"indeterminate"` only surfaces
 * when every attested source that could have been stale was answered
 * `null`.
 */
function evaluateStaleness(
  entry: CriterionEvidence | undefined,
  probe: AttestationStalenessProbe | undefined,
): StalenessOutcome {
  if (probe === undefined || entry === undefined) return { outcome: "clean" };
  let sawIndeterminate = false;
  let earliestStale: string | null = null;
  for (const source of entry.sources) {
    const result = probeAttestedSource(entry.criterionId, source, probe);
    if (result.kind === "skip") continue;
    if (result.kind === "indeterminate") {
      sawIndeterminate = true;
      continue;
    }
    if (result.kind === "stale" && (earliestStale === null || result.attestedAt < earliestStale)) {
      earliestStale = result.attestedAt;
    }
  }
  if (earliestStale !== null) return { outcome: "stale", attestedAt: earliestStale };
  if (sawIndeterminate) return { outcome: "indeterminate" };
  return { outcome: "clean" };
}

/**
 * Per-source branch of {@link evaluateStaleness}: given one
 * {@link EvidenceSource}, returns whether the source is irrelevant to
 * staleness ({@link ProbeResult.kind} = `"skip"`, for non-`attested`
 * and non-pass/n-a verdicts), answered indeterminately, or definitively
 * stale. Extracting this branch drops the outer loop's complexity
 * under the project's cognitive-complexity budget without changing
 * behavior — the three source-level signals still collapse identically
 * at the caller.
 */
type ProbeResult =
  | { readonly kind: "skip" }
  | { readonly kind: "clean" }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "stale"; readonly attestedAt: string };

function probeAttestedSource(
  criterionId: string,
  source: EvidenceSource,
  probe: AttestationStalenessProbe,
): ProbeResult {
  if (source.kind !== "attested") return { kind: "skip" };
  const verdict = source.verdict ?? "pass";
  if (verdict !== "pass" && verdict !== "n/a") return { kind: "skip" };
  const result = probe.isStale(recordFromAttestedSource(criterionId, source));
  if (result === null) return { kind: "indeterminate" };
  if (result === true) return { kind: "stale", attestedAt: source.attestedAt };
  return { kind: "clean" };
}

/**
 * Variant of {@link buildBlocker} that carries the stale attestation's
 * timestamp into `staleAttestedAt`. Agents read this field to cite
 * which attestation needs refreshing without having to re-enumerate
 * the ledger.
 */
function buildStaleBlocker(
  criterion: Standard["criteria"][number],
  status: EvidenceStatus,
  counts: SourceCounts,
  attestedAt: string,
): ConformanceBlocker {
  return {
    criterionId: criterion.id,
    title: criterion.title,
    level: criterion.level,
    status,
    reason: "stale-attestation",
    attestedSources: counts.attested,
    staticSources: counts.static,
    candidateSources: counts.candidate,
    staleAttestedAt: attestedAt,
  };
}

/**
 * Assembles the statement's {@link ConformanceStatementScope} from the
 * builder inputs. `filesCount` is always present (load-bearing: agents
 * reading a truncated response still need the real count); `files` is
 * present-when-meaningful (elided by the tool layer when it would blow
 * the response budget, per the `scope_files_truncated_count_exceeded`
 * warning). Commit hash and config snapshot are present-when-meaningful —
 * empty strings and empty objects map to field omission, not sentinel
 * values, per the AI-first consumer model's absent-vs-empty rule.
 */
function buildStatementScope(inputs: BuildConformanceStatementInputs): ConformanceStatementScope {
  const hasCommit = inputs.commitHash !== undefined && inputs.commitHash.length > 0;
  const hasSnapshot =
    inputs.configSnapshot !== undefined && Object.keys(inputs.configSnapshot).length > 0;
  const filesCount = inputs.filesCount ?? inputs.files?.length ?? 0;
  return {
    filesCount,
    ...(inputs.files !== undefined && { files: inputs.files }),
    ...(hasCommit && { commitHash: inputs.commitHash }),
    ...(hasSnapshot && { configSnapshot: inputs.configSnapshot }),
  };
}

/**
 * Packs the caller-supplied signing inputs together with the derived
 * in-scope criterion ID list into the {@link SignatureInput} the
 * signing module canonicalizes. The builder owns the in-scope list
 * (it already walked the profile to compute blockers), so the caller
 * only supplies the pieces the builder can't infer.
 */
function buildSignatureInput(
  signing: NonNullable<BuildConformanceStatementInputs["signing"]>,
  inScope: readonly Standard["criteria"][number][],
): SignatureInput {
  return {
    commitHash: signing.commitHash,
    attestations: signing.attestations,
    inScopeCriterionIds: inScope.map((c) => c.id),
    configFingerprint: signing.configFingerprint,
    ...(signing.fileManifest === undefined ? {} : { fileManifest: signing.fileManifest }),
    ...(signing.toolVersion === undefined ? {} : { toolVersion: signing.toolVersion }),
  };
}

interface SummaryTally {
  pass: number;
  untested: number;
  fail: number;
  partial: number;
  unknown: number;
  na: number;
}

/**
 * Tallies one criterion into the statement summary. Splits the ledger's
 * `"pass"` status into two buckets so procurement readers don't conflate
 * evidence-supported passes with the ledger's automatable-zero-violations
 * default. A "pass" criterion with zero non-candidate sources (static /
 * attested / sampled) counts as `untested`, not `pass` — these are the
 * `no-evidence` blockers, and the field report's canonical case was
 * "15 of 18 pass criteria had zero emitted findings," i.e. absence
 * interpreted as proof. Keeping them under `summary.pass` would reinstate
 * that silent-miss failure mode.
 */
function tallySummary(summary: SummaryTally, status: EvidenceStatus, counts: SourceCounts): void {
  if (status === "pass") {
    const hasEvidence = counts.static > 0 || counts.attested > 0 || counts.sampled > 0;
    if (hasEvidence) summary.pass += 1;
    else summary.untested += 1;
  } else if (status === "fail") summary.fail += 1;
  else if (status === "partial") summary.partial += 1;
  else if (status === "n/a") summary.na += 1;
  else summary.unknown += 1;
}

function buildBlocker(
  criterion: Standard["criteria"][number],
  status: ConformanceCriterionStatus,
  reason: ConformanceBlockerReason,
  counts: SourceCounts,
  entry: CriterionEvidence | undefined,
  rulesForCriterion: ((criterionId: string) => readonly string[]) | undefined,
): ConformanceBlocker {
  const missingRuleIds =
    reason === "partially-attested" && rulesForCriterion !== undefined
      ? computeMissingRuleIds(rulesForCriterion(criterion.id), entry?.sources ?? [])
      : undefined;
  return {
    criterionId: criterion.id,
    title: criterion.title,
    level: criterion.level,
    status,
    reason,
    attestedSources: counts.attested,
    staticSources: counts.static,
    candidateSources: counts.candidate,
    ...(missingRuleIds !== undefined && { missingRuleIds }),
  };
}

/**
 * True when a runtime-evidence-required criterion reached the builder
 * with no honest-pass signal: no static failure (status would be
 * "fail"), no attested/sampled pass, no partial-coverage (status would
 * be "partial"). The ledger's `deriveStatus` promotes this case to
 * `"pass"` (absence-of-failure on an automatable criterion), but a
 * claim reader's threshold is stricter — the static layer never had the
 * axis to prove pass, so the honest verdict is `"undetermined"`.
 *
 * The guard is conservative: if any attested/sampled source exists, the
 * standard classifier (via `classifyBlocker`) takes over — a
 * runtime-harness attestation flips the criterion to a clean pass, a
 * fail-verdict attestation flips it to `"failing"`.
 */
function isUndeterminedRuntimeCriterion(status: EvidenceStatus, counts: SourceCounts): boolean {
  if (status !== "pass") return false;
  return counts.static === 0 && counts.attested === 0 && counts.sampled === 0;
}

/**
 * Variant of {@link buildBlocker} that stamps `status: "undetermined"`
 * on a runtime-evidence-required criterion. The blocker's counts are
 * zero by construction (the classifier only reaches this branch on the
 * absence-of-evidence case), but we still pass them through so the
 * shape stays consistent with other blocker types for downstream
 * consumers that tally per-kind source counts.
 */
function buildRuntimeEvidenceBlocker(
  criterion: Standard["criteria"][number],
  counts: SourceCounts,
): ConformanceBlocker {
  return {
    criterionId: criterion.id,
    title: criterion.title,
    level: criterion.level,
    status: "undetermined",
    reason: "runtime-evidence-required",
    attestedSources: counts.attested,
    staticSources: counts.static,
    candidateSources: counts.candidate,
  };
}

export { renderConformanceMarkdown } from "./conformance-markdown.ts";

function isInLevel(criterionLevel: string, target: "A" | "AA" | "AAA" | "base"): boolean {
  if (target === "base") return true;
  if (criterionLevel === "A") return true;
  if (criterionLevel === "AA") return target === "AA" || target === "AAA";
  if (criterionLevel === "AAA") return target === "AAA";
  return false;
}

interface SourceCounts {
  readonly static: number;
  readonly attested: number;
  readonly candidate: number;
  readonly sampled: number;
}

function countSources(sources: readonly EvidenceSource[]): SourceCounts {
  let s = 0;
  let a = 0;
  let c = 0;
  let sp = 0;
  for (const src of sources) {
    if (src.kind === "static") s += 1;
    else if (src.kind === "attested") a += 1;
    else if (src.kind === "candidate") c += 1;
    else if (src.kind === "sampled") sp += 1;
  }
  return { static: s, attested: a, candidate: c, sampled: sp };
}

function computeMissingRuleIds(
  satisfyingRules: readonly string[],
  sources: readonly EvidenceSource[],
): readonly string[] {
  const covered = new Set<string>();
  let isUniversal = false;
  for (const s of sources) {
    if (s.kind !== "attested") continue;
    const verdict = s.verdict ?? "pass";
    if (verdict !== "pass") continue;
    if (s.ruleIds === undefined) {
      isUniversal = true;
      break;
    }
    for (const r of s.ruleIds) covered.add(r);
  }
  if (isUniversal) return [];
  return satisfyingRules.filter((r) => !covered.has(r));
}

function classifyBlocker(
  status: EvidenceStatus,
  counts: SourceCounts,
  entry: CriterionEvidence | undefined,
): ConformanceBlockerReason | null {
  if (status === "fail") return "failing";
  if (status === "partial") return "partially-attested";
  if (status === "pass" || status === "n/a") {
    // Pass/n/a are only honest when they stand on a non-candidate
    // source. Without one, the "pass" is the automatable-with-no-
    // sources default from the ledger — no evidence was actually
    // collected. Promote to blocker.
    if (counts.static === 0 && counts.attested === 0 && counts.sampled === 0) {
      return "no-evidence";
    }
    return null;
  }
  if (entry && counts.candidate > 0) return "candidate-only";
  return "no-evidence";
}
