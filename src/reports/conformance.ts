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
import type {
  AttestationRecord,
  CriterionEvidence,
  EvidenceLedger,
  EvidenceSource,
  EvidenceStatus,
} from "../types/evidence.ts";
import type { Standard } from "../types/standard.ts";
import {
  type ConformanceSignature,
  type SignatureInput,
  signConformanceBundleAt,
} from "./conformance-signature.ts";

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
 */
export type ConformanceBlockerReason =
  | "no-evidence"
  | "failing"
  | "candidate-only"
  | "partially-attested";

export interface ConformanceBlocker {
  readonly criterionId: string;
  readonly title: string;
  readonly level: string;
  readonly status: EvidenceStatus;
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
   * File paths included in the scan — the manifest the claim stands on.
   * Paths are mirrored verbatim from the caller; the builder does not
   * normalize. Always populated; an empty array means nothing was
   * scanned.
   */
  readonly files: readonly string[];
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
  /** Per-status tallies across in-scope criteria. */
  readonly summary: {
    readonly pass: number;
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
   * Mirrored into `statement.scope.files`. Pass an empty array when no
   * files were scanned; downstream consumers can distinguish that case
   * from "field absent" (the field is always present on the scope).
   */
  readonly files?: readonly string[];
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
   * fingerprint) bundle and attaches it as `statement.signature`.
   * Omitted → no signature field is emitted. The statement is still
   * refused (no signature) when any blocker remains.
   */
  readonly signing?: {
    readonly commitHash: string;
    readonly attestations: readonly AttestationRecord[];
    readonly configFingerprint: {
      readonly standards: readonly string[];
      readonly level?: string;
    };
  };
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
  // `scope` (optional named profile from src/config/profiles.ts) narrows
  // the claim when present: filters the standard gate + overrides the
  // effective level. Absent → original `inputs.profile` drives scope
  // exactly as before.
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
  const ledgerByCriterion = new Map(inputs.ledger.entries.map((e) => [e.criterionId, e] as const));

  const blockers: ConformanceBlocker[] = [];
  const summary = { pass: 0, fail: 0, partial: 0, unknown: 0, na: 0 };
  for (const criterion of inScope) {
    const entry = ledgerByCriterion.get(criterion.id);
    const counts = countSources(entry?.sources ?? []);
    const status: EvidenceStatus = entry?.status ?? "unknown";
    tallySummary(summary, status);
    const reason = classifyBlocker(status, counts, entry);
    if (reason !== null) {
      blockers.push(
        buildBlocker(criterion, status, reason, counts, entry, inputs.rulesForCriterion),
      );
    }
  }

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
  };
}

/**
 * Assembles the statement's {@link ConformanceStatementScope} from the
 * builder inputs. `files` is always present (defaults to `[]`); the
 * commit hash and config snapshot are present-when-meaningful — empty
 * strings and empty objects map to field omission, not sentinel
 * values, per the AI-first consumer model's absent-vs-empty rule.
 */
function buildStatementScope(inputs: BuildConformanceStatementInputs): ConformanceStatementScope {
  const hasCommit = inputs.commitHash !== undefined && inputs.commitHash.length > 0;
  const hasSnapshot =
    inputs.configSnapshot !== undefined && Object.keys(inputs.configSnapshot).length > 0;
  return {
    files: inputs.files ?? [],
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
  };
}

interface SummaryTally {
  pass: number;
  fail: number;
  partial: number;
  unknown: number;
  na: number;
}

function tallySummary(summary: SummaryTally, status: EvidenceStatus): void {
  if (status === "pass") summary.pass += 1;
  else if (status === "fail") summary.fail += 1;
  else if (status === "partial") summary.partial += 1;
  else if (status === "n/a") summary.na += 1;
  else summary.unknown += 1;
}

function buildBlocker(
  criterion: Standard["criteria"][number],
  status: EvidenceStatus,
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
 * Markdown renderer for the conformance statement — the shape an
 * auditor or release process can drop into a release note or
 * compliance bundle. Emits the WCAG §5.3.1 required claim fields
 * (date, guidelines title/version/URI, conformance level, scope,
 * technologies relied upon) plus the ra11y-specific verdict and
 * blocker table. Sections whose array is empty are omitted (e.g.
 * `technologiesNotReliedUpon` is usually `[]`).
 */
export function renderConformanceMarkdown(statement: ConformanceStatement): string {
  const lines: string[] = [];
  const {
    profile,
    generatedAt,
    conformant,
    guidelinesTitle,
    guidelinesVersion,
    guidelinesUri,
    scope,
    technologiesReliedUpon,
    technologiesNotReliedUpon,
    criteriaInScope,
    summary,
    blockers,
  } = statement;
  lines.push(`# Conformance Statement — ${profile.standardId} ${profile.level}`);
  lines.push("");
  lines.push(`- Date: ${generatedAt}`);
  lines.push(`- Guidelines: ${guidelinesTitle} ${guidelinesVersion} (<${guidelinesUri}>)`);
  lines.push(`- Conformance level: ${profile.level}`);
  lines.push(`- Criteria in scope: ${criteriaInScope}`);
  lines.push(
    `- Status: **${conformant ? "CONFORMANT" : "NOT CONFORMANT"}** (pass=${summary.pass}, fail=${summary.fail}, partial=${summary.partial}, unknown=${summary.unknown}, n/a=${summary.na})`,
  );
  lines.push("");
  lines.push(`## Scope`);
  lines.push("");
  lines.push(`- Files scanned: ${scope.files.length}`);
  if (scope.commitHash !== undefined) {
    lines.push(`- Commit: \`${scope.commitHash}\``);
  }
  if (scope.configSnapshot !== undefined) {
    lines.push(`- Config snapshot:`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(scope.configSnapshot, null, 2));
    lines.push("```");
  }
  lines.push("");
  lines.push(`## Technologies relied upon`);
  lines.push("");
  if (technologiesReliedUpon.length === 0) {
    lines.push(`_None declared._`);
  } else {
    for (const t of technologiesReliedUpon) lines.push(`- ${t}`);
  }
  if (technologiesNotReliedUpon.length > 0) {
    lines.push("");
    lines.push(`## Technologies not relied upon`);
    lines.push("");
    for (const t of technologiesNotReliedUpon) lines.push(`- ${t}`);
  }
  lines.push("");
  if (conformant) {
    lines.push(
      `Every criterion in scope is backed by at least one non-candidate evidence source with a final status of pass or n/a.`,
    );
    return lines.join("\n");
  }
  lines.push(`## Blockers`);
  lines.push("");
  lines.push(`| Criterion | Title | Level | Status | Reason | Static | Attested | Candidate |`);
  lines.push(`|---|---|---|---|---|---:|---:|---:|`);
  for (const b of blockers) {
    lines.push(
      `| ${b.criterionId} | ${escapePipe(b.title)} | ${b.level} | ${b.status} | ${b.reason} | ${b.staticSources} | ${b.attestedSources} | ${b.candidateSources} |`,
    );
  }
  return lines.join("\n");
}

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

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}
