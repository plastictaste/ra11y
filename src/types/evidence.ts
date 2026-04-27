/**
 * Types for the Evidence primitive — per-criterion aggregation of every
 * input that speaks to conformance for that criterion.
 *
 * An {@link EvidenceLedger} is a derived view over one scan plus, in
 * later phases, externally-supplied inputs (attestations, runtime
 * results, sampling verdicts). A rule produces `Violation`s; a finder
 * produces `ReviewCandidate`s; both become {@link EvidenceSource}s on
 * the ledger.
 *
 * The ledger is the substrate a conformance statement refuses or
 * emits from — in contrast to `Violation[]` alone, which cannot
 * distinguish "checked and clean" from "not checked."
 *
 * See docs/adr/0011-evidence-as-first-class-primitive.md.
 *
 * The current implementation ships the full shape but only `static`
 * and `candidate` sources have producers. `attested` / `runtime` /
 * `sampled` slots exist so later work adds producers without changing
 * the public type.
 */

import type { ReviewConfidence } from "./review.ts";
import type { Automatability } from "./standard.ts";
import type { Location } from "./violation.ts";

/**
 * Derived verdict for a criterion. Applied per-criterion in strict
 * precedence; the derivation is a pure function over
 * {@link CriterionEvidence.sources}.
 *
 * - `"fail"` — at least one `static` source (a violation was emitted).
 *   Later phases promote `runtime.outcome === "fail"` and
 *   `sampled.verdict === "fail"` to this bucket too.
 * - `"pass"` — the criterion is automatable (not `"manual"`) and
 *   carries no `"fail"`-yielding source. The current implementation
 *   bases this on the absence of `static` sources alone; later iterations
 *   may additionally require positive runtime/attested evidence before
 *   promoting.
 * - `"partial"` — the criterion has at least one `attested: "pass"`
 *   source but the union of attested `ruleIds` does not cover every
 *   rule that satisfies this criterion. Some slice was verified;
 *   others were not. See ADR 0013.
 * - `"unknown"` — the criterion is manual-only, or the ledger has
 *   no source that speaks to it. Candidate sources do not move a
 *   criterion out of `"unknown"` — they point reviewers at locations
 *   to inspect, they don't assert anything.
 * - `"n/a"` — the criterion does not apply (e.g., media-only criteria
 *   in a text-only app, declared via an attestation). Reserved for
 *   future producers; no current producer emits this.
 */
export type EvidenceStatus = "pass" | "fail" | "partial" | "unknown" | "n/a";

/**
 * One input contributing to a criterion's verdict. Discriminated by
 * {@link EvidenceSource.kind} so consumers narrow via the discriminant
 * rather than optional-field archaeology.
 *
 * Current producers:
 *   - `static` — one per violation, for each criterion in
 *     {@link Violation.criteria} (equivalence fan-out is already
 *     applied upstream by the standard filter).
 *   - `candidate` — one per review candidate, keyed by
 *     `candidate.criterionId`.
 *
 * Future producers have no implementation yet but their shapes are
 * locked in so future code never has to migrate the discriminant.
 *
 * A note on runtime evidence: there is deliberately no `"runtime"`
 * source kind. Runtime evidence rides through `attested` — the agent
 * calls `attest` with the provenance encoded in `by` and `reason`,
 * so the evidence ledger does not need to model external-tool schemas.
 * `sampled` is kept as its own kind because ra11y itself owns the
 * sampling-tool contract.
 */
export type EvidenceSource =
  | {
      readonly kind: "static";
      /** Stable identity of the underlying violation; look up via `ScanResult.violations`. */
      readonly findingId: string;
    }
  | {
      readonly kind: "candidate";
      readonly location: Location;
      readonly reason: string;
      readonly confidence: ReviewConfidence;
      /** ID of the finder that emitted the candidate, when known. */
      readonly finderId?: string;
    }
  | {
      readonly kind: "attested";
      /** Who attested (author identifier, bot ID, commit author, runtime-tool-plus-CI, …). */
      readonly by: string;
      /** Human-readable reason the author asserts the criterion is satisfied. */
      readonly reason: string;
      /** ISO-8601 timestamp the attestation was recorded. */
      readonly attestedAt: string;
      /**
       * Provenance classifier. Tells consumers of the ledger where the
       * evidence this attestation encodes actually came from — a runtime
       * tool's output read and interpreted in CI, a human (or agent)
       * inspection pass, a formal accessibility study with users, or an
       * author's declaration without external evidence. Required on
       * every record {@link EvidenceSource | a producer emits}. Legacy
       * entries missing the field coerce to `"declaration"` on read;
       * the write path rejects attestations that omit it. See
       * {@link AttestationRecord.evidenceSource}.
       */
      readonly evidenceSource: AttestationEvidenceSource;
      /**
       * Optional tool identifier when `evidenceSource === "runtime_tool"`
       * — a free-form label naming whatever runtime harness produced
       * the verdict (e.g. `"<vendor> <version>"`). Surfaces
       * verbatim in downstream reports so VPAT / conformance-markdown
       * readers see which harness produced the verdict. Omitted when
       * not supplied (present-when-meaningful).
       */
      readonly toolName?: string;
      /**
       * Optional URL pointing at the run record (CI log, tool dashboard)
       * that backs the attestation. Omitted when not supplied.
       */
      readonly runUrl?: string;
      /**
       * Optional ISO-8601 timestamp for when the observation was
       * originally made — distinct from `attestedAt` (when the record
       * was written to the ledger). Lets the agent record "CI ran at
       * 2026-04-17T00:00:00Z, the attestation is being written a day
       * later."
       */
      readonly observedAt?: string;
      /**
       * Rule IDs this attestation covers. Omitted means "every rule that
       * satisfies the criterion" (criterion-wide claim); present with one
       * or more IDs means the attestation only speaks to those specific
       * rules. Used by the coverage check in {@link EvidenceStatus} —
       * see ADR 0013.
       */
      readonly ruleIds?: readonly string[];
      /** Attestation scope — defaults to `"project"` when omitted. */
      readonly scope?: "project" | "file" | "line";
      /** Location the attestation pins to, when `scope !== "project"`. */
      readonly location?: Location;
      /**
       * Verdict the attestation asserts; defaults to `"pass"` when
       * omitted. `"pending"` is reserved for bare source-pragmas whose
       * author punted the reason slot — the attestation exists in the
       * ledger so agents see the unasserted claim via
       * `list_attestations`, but it contributes neither pass nor fail
       * evidence to status derivation.
       */
      readonly verdict?: "pass" | "fail" | "n/a" | "pending";
    }
  | {
      readonly kind: "sampled";
      readonly verdict: "pass" | "fail" | "n/a";
      readonly reasoning: string;
      /** Identifier of the sampling tool / prompt that produced the verdict. */
      readonly samplerId: string;
      /** ISO-8601 timestamp the verdict was produced. */
      readonly sampledAt: string;
    };

/**
 * One criterion's full evidence pile plus its derived verdict.
 *
 * `status` is computed from `sources`; the builder is a pure function
 * and every source that contributed is listed. `sources` is sorted for
 * determinism — see the builder for the ordering rule.
 */
export interface CriterionEvidence {
  readonly criterionId: string;
  readonly standardId: string;
  readonly automatable: Automatability;
  readonly status: EvidenceStatus;
  readonly sources: readonly EvidenceSource[];
}

/**
 * A durable attestation record — either inline (emitted by a pragma
 * with a `reason=` text) or project-level (written to
 * `.ra11y/attestations.jsonl` by the `attest` MCP tool). Both feed the
 * same `attested` {@link EvidenceSource} kind on the ledger.
 *
 * A bare pragma (no `reason=` text) still produces a record — one
 * per concrete token per bare pragma — but stamped
 * `verdict: "pending"` with a sentinel reason. The pending entry
 * surfaces in `list_attestations` so agents see the unasserted claim
 * as an actionable gap ("fill in the reason") rather than silence;
 * it contributes neither pass nor fail evidence to the ledger's
 * status derivation. The existing `ra11y:suppression-no-reason`
 * review candidate remains the complementary source-level signal.
 *
 * Validation is lenient: records whose `criterionId` is not present in
 * any enabled standard are skipped silently by the ledger builder —
 * mirroring the `equivalentTo` "silently skip missing" pattern so
 * standards can be toggled without throwing on stored attestations
 * about disabled criteria.
 */
export interface AttestationRecord {
  /** Criterion this attestation speaks to (`<standardId>:<localId>`). */
  readonly criterionId: string;
  /**
   * Rule IDs this attestation claims coverage for. Omitted means the
   * attestation is criterion-wide — it fans out to every rule that
   * satisfies the criterion. Present with one or more IDs means the
   * attestation only speaks to those specific rules, which feeds the
   * partial-coverage check in the ledger's status derivation.
   *
   * See ADR 0013.
   */
  readonly ruleIds?: readonly string[];
  /** Who attested — author, bot, runtime-tool-plus-CI, etc. */
  readonly by: string;
  /** Human-readable rationale. */
  readonly reason: string;
  /**
   * Provenance classifier distinguishing *where the evidence came from*
   * from *what the reason text claims*. Required on every record a
   * producer emits. Four values:
   *
   *   - `"runtime_tool"` — output from a runtime accessibility scanner
   *     read and interpreted by the agent in CI. Pairs with optional
   *     `toolName` / `runUrl` / `observedAt` so auditors can trace the
   *     run.
   *   - `"manual_review"` — a human or agent's inspection pass over the
   *     source or rendered product, including inline `ra11y-disable`
   *     pragmas with a reason (pragmas are an author's manual judgment).
   *   - `"human_study"` — a formal accessibility study with human
   *     subjects (usability testing with assistive-tech users). Higher
   *     confidence than `manual_review` because it involves real user
   *     testimony, not just a reviewer's intuition.
   *   - `"declaration"` — an author's self-declaration without external
   *     evidence (project-level "no `<audio>` in this app", policy
   *     claims). Also the back-compat default for ledger entries that
   *     predate this field.
   *
   * The distinction matters because a VPAT / conformance statement reader
   * asks "how was this verified?" not just "was it verified?" — a
   * runtime-tool pass for focus-visible stands on different ground than
   * an unverified declaration that focus is fine.
   */
  readonly evidenceSource: AttestationEvidenceSource;
  /**
   * Tool identifier when `evidenceSource === "runtime_tool"`. A
   * free-form label (typically `"<vendor> <version>"`) naming whatever
   * runtime harness produced the verdict. Surfaces verbatim in
   * downstream reports so auditors see
   * which harness produced the result. Omitted when not supplied or
   * when `evidenceSource !== "runtime_tool"`.
   */
  readonly toolName?: string;
  /**
   * URL pointing at the run record the attestation cites — CI log, a
   * tool dashboard, a published audit. Omitted when not supplied.
   */
  readonly runUrl?: string;
  /**
   * ISO-8601 timestamp of the original observation (distinct from
   * {@link attestedAt}, which is when the attestation was written to
   * the ledger). Omitted when the two are the same or when no separate
   * observation time exists.
   */
  readonly observedAt?: string;
  /** ISO-8601 timestamp the attestation was recorded. */
  readonly attestedAt: string;
  /** Attestation scope; defaults to `"project"` when omitted. */
  readonly scope?: "project" | "file" | "line";
  /** Location the attestation pins to, when `scope !== "project"`. */
  readonly location?: Location;
  /**
   * Verdict the attestation asserts; defaults to `"pass"` when
   * omitted. `"pending"` is reserved for bare source-pragma records —
   * the author punted the reason slot, so the attestation sits in the
   * ledger as an unasserted claim that agents can surface via
   * `list_attestations` without it counting as pass or fail evidence.
   */
  readonly verdict?: "pass" | "fail" | "n/a" | "pending";
}

/**
 * Provenance classifier for an {@link AttestationRecord}. Each value
 * answers "where did the evidence come from?" in a way the signer and
 * the reader agree on.
 */
export type AttestationEvidenceSource =
  | "runtime_tool"
  | "manual_review"
  | "human_study"
  | "declaration";

/** Runtime set of valid {@link AttestationEvidenceSource} values. */
export const ATTESTATION_EVIDENCE_SOURCES: readonly AttestationEvidenceSource[] = [
  "runtime_tool",
  "manual_review",
  "human_study",
  "declaration",
] as const;

/**
 * Default applied to stored records that predate the `evidenceSource`
 * field. Reads (but not writes) coerce absent values to this default
 * so old ledgers keep loading. Choosing `"declaration"` is the most
 * honest fallback — a record whose provenance was never captured
 * reads as "self-declared," matching the weakest-confidence tier.
 */
export const LEGACY_ATTESTATION_EVIDENCE_SOURCE: AttestationEvidenceSource = "declaration";

/**
 * A per-scan aggregate of every criterion in every enabled standard.
 *
 * `entries` is sorted by `criterionId` for determinism; consumers that
 * need fast random access can build their own Map.
 */
export interface EvidenceLedger {
  readonly entries: readonly CriterionEvidence[];
  readonly meta: {
    /** ISO-8601 timestamp the ledger was produced. */
    readonly generatedAt: string;
    /** Standards enabled for this ledger, sorted by id. */
    readonly enabledStandards: readonly string[];
  };
}
