/**
 * VPAT 2.5 Rev (Voluntary Product Accessibility Template) report builder.
 *
 * Targets the ITI VPAT 2.5 Rev template for WCAG 2.2. When the enabled
 * standard set includes EN 301 549 this expands to "VPAT 2.5 Rev INT"
 * in the header. Given a ScanResult + loaded standards, produces a
 * structured VpatReport that VPAT-format templates consume. ra11y is
 * not a legal document producer — we emit the data; users paste it
 * into their VPAT template of choice (HTML, PDF, Word, Markdown).
 *
 * Conformance decision logic per criterion:
 *   - "Not Applicable" — element-presence detection proves the feature
 *     the criterion governs is absent from the scanned sources (e.g.
 *     wcag22:1.2.1 when no `<audio>` / `<video>` elements exist).
 *   - "Not Evaluated" — no rule satisfies this criterion (manual-only),
 *     OR the criterion fundamentally requires runtime evidence
 *     (keyboard traversal, focus visibility, rendered contrast — see
 *     `RUNTIME_EVIDENCE_REQUIRED_CRITERIA`) AND no fresh attestation
 *     covers it, OR the criterion is `automatable: "partial"` with
 *     zero findings AND no attestation backing the manual axis.
 *     Absence of a static finding is not evidence of conformance.
 *   - "Does Not Support" — at least one `error` violation.
 *   - "Partially Supports" — only `warning` violations, or the criterion
 *     is classified "partial" in the standard metadata AND a fresh
 *     attestation (manual review / runtime harness) backs the manual
 *     axis the static layer cannot prove.
 *   - "Supports" — zero violations on a fully automatable criterion
 *     whose satisfying rule actually ran on eligible inputs.
 */

import type { Applicability } from "../mcp/manual-applicability.ts";
import { irrelevanceReason, isLikelyIrrelevant } from "../mcp/manual-applicability.ts";
import type { AttestationRecord } from "../types/evidence.ts";
import type { ReviewCandidate } from "../types/review.ts";
import type { Criterion, Standard } from "../types/standard.ts";
import type { ScanResult, Violation } from "../types/violation.ts";
import { VERSION } from "../version.ts";
import { RUNTIME_EVIDENCE_REQUIRED_CRITERIA } from "./runtime-evidence-criteria.ts";

export type Conformance =
  | "Supports"
  | "Partially Supports"
  | "Does Not Support"
  | "Not Applicable"
  | "Not Evaluated";

/**
 * Diagnostic "why is this entry in its current bucket" signal, emitted
 * only when the procurement-facing `conformance` enum alone would be
 * ambiguous between categorically different situations. Split at the
 * entry level so the VPAT reader can tell honest evidence-backed passes
 * from ledger-default passes, and in-scope "Not Applicable" (feature
 * absent) from out-of-scope "Not Applicable" (level > scanLevel).
 *
 * Present-when-meaningful per the AI-first consumer model — a clean
 * `Supports` entry on an automatable criterion with an evaluated rule
 * omits the field entirely; only the ambiguous shapes surface it.
 *
 * - `"out-of-scope"` — criterion level exceeds the scan's conformance
 *   level. Pairs with `conformance: "Not Applicable"` and a remark
 *   citing the scan level. Distinct from the media-absent "Not
 *   Applicable" case, which omits `evidenceStatus` because the
 *   applicability remark is already unambiguous.
 * - `"untested"` — criterion is automatable (metadata) but no rule
 *   satisfying it ran on eligible inputs in this scan. Pairs with
 *   `conformance: "Not Evaluated"` — "the tool never looked," not "the
 *   tool looked and found nothing." The canonical field-report case:
 *   jekyll docs with 15 of 18 `Supports` criteria being no-evidence
 *   defaults.
 */
export type VpatEntryEvidenceStatus = "out-of-scope" | "untested";

export interface VpatEntry {
  readonly criterionId: string;
  readonly localId: string;
  readonly title: string;
  readonly level: string;
  readonly conformance: Conformance;
  readonly remarks: string;
  readonly violationCount: number;
  readonly automated: boolean;
  /**
   * Diagnostic signal disambiguating categorically different situations
   * that map to the same {@link Conformance} bucket. Present only when
   * the conformance alone would be misleading — see
   * {@link VpatEntryEvidenceStatus}. Omitted per the AI-first consumer
   * model's present-when-meaningful rule.
   */
  readonly evidenceStatus?: VpatEntryEvidenceStatus;
}

export interface VpatStandardSection {
  readonly standardId: string;
  readonly standardName: string;
  readonly version: string;
  readonly entries: readonly VpatEntry[];
  readonly summary: {
    readonly supports: number;
    readonly partiallySupports: number;
    readonly doesNotSupport: number;
    readonly notApplicable: number;
    readonly notEvaluated: number;
    /**
     * Subset of `notApplicable`: criteria above the scan's conformance
     * level that render as "Not Applicable — out of scope." Split out so
     * procurement readers don't conflate "feature absent from sources"
     * with "evaluation scope didn't cover this level." Omitted from
     * summary when `scanLevel` isn't supplied (backward compat).
     */
    readonly outOfScope: number;
    /**
     * Subset of `notEvaluated`: automatable criteria whose rules never
     * ran on eligible inputs in this scan. Paired with the entry-level
     * `evidenceStatus: "untested"` flag. Omitted from summary when
     * `firedCriteria` isn't supplied (backward compat) — the existing
     * behavior of folding these into `supports` is preserved unless the
     * caller opts into the honest split.
     */
    readonly untested: number;
  };
}

/**
 * Product + evaluator metadata filled into the VPAT 2.5 Rev header
 * block. These are procurement-facing fields the VPAT reader uses to
 * identify the product under evaluation and the party who produced the
 * evaluation. `productName` and `productVersion` are required because a
 * VPAT without them is not a usable procurement artifact; the other
 * fields are optional and omitted from the rendered header when blank.
 */
export interface VpatProductMetadata {
  readonly productName: string;
  readonly productVersion: string;
  readonly contactEmail?: string;
  readonly contactOrganization?: string;
  readonly evaluationMethods?: string;
  readonly notesOnEvaluation?: string;
}

/**
 * Evaluator metadata. Historically a plain identifier string; now a
 * small record so procurement readers see the scan's conformance level
 * at a glance instead of having to cross-reference summary counts to
 * infer whether AAA criteria were ever in scope. `name` is always
 * populated; `scanLevel` is present-when-supplied (omitted from the
 * legacy code path that still calls through the three-arg overload).
 */
export interface VpatEvaluator {
  readonly name: string;
  /**
   * WCAG conformance level the scan ran at. Threaded through from the
   * MCP tool's resolved `level` / session config, and surfaced here so
   * a VPAT reader doesn't have to infer the scope boundary from the
   * summary. Pairs with the per-entry out-of-scope rendering: criteria
   * whose level exceeds this value emit
   * `conformance: "Not Applicable"` + `evidenceStatus: "out-of-scope"`
   * with a remark citing `scanLevel`. Omitted on the legacy builder
   * path — no regression for callers that haven't opted in.
   */
  readonly scanLevel?: "A" | "AA" | "AAA";
}

export interface VpatReport {
  readonly templateVersion: string;
  readonly generatedAt: string;
  readonly evaluator: VpatEvaluator;
  readonly product: VpatProductMetadata;
  readonly standards: readonly VpatStandardSection[];
}

export interface VpatBuildOptions {
  readonly generatedAt?: string;
  readonly candidates?: readonly ReviewCandidate[];
  readonly applicability?: Applicability;
  readonly product?: Partial<VpatProductMetadata>;
  /**
   * Durable + pragma attestations supplied at scan time. When a
   * criterion listed in `RUNTIME_EVIDENCE_REQUIRED_CRITERIA` is
   * evaluated (zero violations), the builder checks this list for an
   * attestation whose `verdict` is `"pass"`, `"fail"`, or `"n/a"` —
   * i.e. a runtime harness or manual review has actually spoken to
   * the criterion. Presence flows through to the normal automated
   * verdict; absence routes to `"Not Evaluated"` with a runtime-
   * dependency remark. Omitted → behaves as if no attestations were
   * supplied (runtime-only SCs route to `"Not Evaluated"`).
   */
  readonly attestations?: readonly AttestationRecord[];
  /**
   * WCAG conformance level the scan executed at. When supplied, every
   * criterion whose own level is strictly above this value renders as
   * `conformance: "Not Applicable"` with
   * `evidenceStatus: "out-of-scope"` and a remark citing `scanLevel` —
   * instead of the previous silent "Not Evaluated" that mixed
   * out-of-scope criteria into the same bucket as un-evaluated manual
   * ones. Forwarded to `VpatReport.evaluator.scanLevel` so procurement
   * readers see the scope in the header too.
   *
   * Omitted → criteria are rendered without a level-based scope filter
   * (backward compat with callers that don't yet thread the scan's
   * level through).
   */
  readonly scanLevel?: "A" | "AA" | "AAA";
  /**
   * Criterion IDs for which at least one satisfying rule actually ran
   * on eligible files in this scan — the scan's evidence set. An
   * automatable criterion with zero emitted violations is only honestly
   * "Supports" when it appears in this set; otherwise the scanner
   * never exercised the axis and the entry routes to
   * `conformance: "Not Evaluated"` + `evidenceStatus: "untested"` with
   * a remark naming the gap.
   *
   * The builder does NOT infer this set from the scan result — derivation
   * requires rule→criterion mapping (including equivalence closure) that
   * lives on the engine's registries. The MCP `vpat` tool assembles the
   * set from `perRuleCoverage` + rule `satisfies` before calling in.
   *
   * Omitted → every automatable zero-violation criterion renders as
   * `Supports` (legacy behavior). Opt-in so existing tests and CLI
   * callers that haven't wired the derivation keep working.
   */
  readonly firedCriteria?: ReadonlySet<string>;
}

const EVALUATOR = `ra11y v${VERSION}`;

/** Template placeholder surfaced when the caller leaves a required field blank. */
const PLACEHOLDER_PRODUCT_NAME = "<Product Name>";
const PLACEHOLDER_PRODUCT_VERSION = "<Product Version>";

/**
 * Build a VPAT report from a ScanResult.
 *
 * New callers should pass a single options bag. The legacy three-arg
 * form (generatedAt, candidates) is kept for backward compatibility
 * with existing tests; it forwards into the options bag unchanged.
 */
export function buildVpatReport(
  result: ScanResult,
  loadedStandards: readonly Standard[],
  options?: VpatBuildOptions,
): VpatReport;
export function buildVpatReport(
  result: ScanResult,
  loadedStandards: readonly Standard[],
  generatedAt: string,
  candidates?: readonly ReviewCandidate[],
): VpatReport;
export function buildVpatReport(
  result: ScanResult,
  loadedStandards: readonly Standard[],
  optionsOrGeneratedAt?: VpatBuildOptions | string,
  legacyCandidates?: readonly ReviewCandidate[],
): VpatReport {
  const options = normalizeOptions(optionsOrGeneratedAt, legacyCandidates);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const candidates = options.candidates ?? [];
  const applicability = options.applicability;
  const product = resolveProductMetadata(options.product);
  const attestedByCriterion = indexAttestedByCriterion(options.attestations ?? []);

  const enabledSet = new Set(result.enabledStandards);
  const templateVersion = resolveTemplateVersion(enabledSet);

  const violationsByCriterion = indexViolationsByCriterion(result.violations);
  const candidatesByCriterion = indexCandidatesByCriterion(candidates);

  const standardSections: VpatStandardSection[] = [];
  for (const standard of loadedStandards) {
    if (!enabledSet.has(standard.id)) continue;
    standardSections.push(
      buildSection(
        standard,
        violationsByCriterion,
        candidatesByCriterion,
        applicability,
        attestedByCriterion,
        options.scanLevel,
        options.firedCriteria,
      ),
    );
  }

  const evaluator: VpatEvaluator = {
    name: EVALUATOR,
    ...(options.scanLevel !== undefined && { scanLevel: options.scanLevel }),
  };

  return {
    templateVersion,
    generatedAt,
    evaluator,
    product,
    standards: standardSections,
  };
}

function normalizeOptions(
  optionsOrGeneratedAt?: VpatBuildOptions | string,
  legacyCandidates?: readonly ReviewCandidate[],
): VpatBuildOptions {
  if (typeof optionsOrGeneratedAt === "string") {
    return {
      generatedAt: optionsOrGeneratedAt,
      ...(legacyCandidates ? { candidates: legacyCandidates } : {}),
    };
  }
  return optionsOrGeneratedAt ?? {};
}

function resolveProductMetadata(override?: Partial<VpatProductMetadata>): VpatProductMetadata {
  const src = override ?? {};
  return {
    productName:
      src.productName && src.productName.length > 0 ? src.productName : PLACEHOLDER_PRODUCT_NAME,
    productVersion:
      src.productVersion && src.productVersion.length > 0
        ? src.productVersion
        : PLACEHOLDER_PRODUCT_VERSION,
    ...(src.contactEmail ? { contactEmail: src.contactEmail } : {}),
    ...(src.contactOrganization ? { contactOrganization: src.contactOrganization } : {}),
    ...(src.evaluationMethods ? { evaluationMethods: src.evaluationMethods } : {}),
    ...(src.notesOnEvaluation ? { notesOnEvaluation: src.notesOnEvaluation } : {}),
  };
}

/**
 * VPAT 2.5 Rev has distinct variants by the standards framework under
 * evaluation. "INT" is the international edition, selected whenever
 * EN 301 549 is in scope; otherwise the WCAG/Section-508 edition is
 * used. "WCAG Edition" vs "508 Edition" share the same header in
 * practice, so we only disambiguate for EN 301 549.
 */
function resolveTemplateVersion(enabled: ReadonlySet<string>): string {
  if (enabled.has("en301549")) return "VPAT 2.5 Rev INT";
  return "VPAT 2.5 Rev";
}

function buildSection(
  standard: Standard,
  violationsByCriterion: ReadonlyMap<string, readonly Violation[]>,
  candidatesByCriterion: ReadonlyMap<string, readonly ReviewCandidate[]>,
  applicability: Applicability | undefined,
  attestedByCriterion: ReadonlyMap<string, AttestationRecord>,
  scanLevel: "A" | "AA" | "AAA" | undefined,
  firedCriteria: ReadonlySet<string> | undefined,
): VpatStandardSection {
  const entries: VpatEntry[] = [];
  const summary = {
    supports: 0,
    partiallySupports: 0,
    doesNotSupport: 0,
    notApplicable: 0,
    notEvaluated: 0,
    outOfScope: 0,
    untested: 0,
  };

  for (const criterion of standard.criteria) {
    const entry = buildEntry(
      criterion,
      violationsByCriterion.get(criterion.id) ?? [],
      candidatesByCriterion.get(criterion.id) ?? [],
      applicability,
      attestedByCriterion,
      scanLevel,
      firedCriteria,
    );
    entries.push(entry);
    switch (entry.conformance) {
      case "Supports":
        summary.supports += 1;
        break;
      case "Partially Supports":
        summary.partiallySupports += 1;
        break;
      case "Does Not Support":
        summary.doesNotSupport += 1;
        break;
      case "Not Applicable":
        summary.notApplicable += 1;
        break;
      case "Not Evaluated":
        summary.notEvaluated += 1;
        break;
    }
    // Honest split of the composite buckets above. A "Not Applicable"
    // row marked out-of-scope by scanLevel is categorically different
    // from one marked absent-feature by `detectApplicability`; a "Not
    // Evaluated" row marked untested (automatable, no rule ran) is
    // categorically different from one marked runtime-evidence-required
    // or manual. Consumers reading the headline counts as "work to do"
    // vs "can't evaluate with this tool" need the split — doctrine:
    // "Composite headline counts are dishonest."
    if (entry.evidenceStatus === "out-of-scope") summary.outOfScope += 1;
    if (entry.evidenceStatus === "untested") summary.untested += 1;
  }

  return {
    standardId: standard.id,
    standardName: standard.name,
    version: standard.version,
    entries,
    summary,
  };
}

function buildEntry(
  criterion: Criterion,
  violations: readonly Violation[],
  candidates: readonly ReviewCandidate[],
  applicability: Applicability | undefined,
  attestedByCriterion: ReadonlyMap<string, AttestationRecord>,
  scanLevel: "A" | "AA" | "AAA" | undefined,
  firedCriteria: ReadonlySet<string> | undefined,
): VpatEntry {
  // Demonstrated failures always win — even for criteria classified
  // "manual" in metadata, because a rule can still satisfy a slice of a
  // manual criterion (e.g., document/meta-refresh satisfies wcag22:2.2.1).
  // A VPAT that hides known non-support behind "Not Evaluated" is worse
  // than one that surfaces it. This also applies to runtime-evidence-
  // required criteria: a proven static failure (e.g. `contrast/minimum`
  // finding a 3:1 pair) is honest negative evidence even though the
  // rendered composite would need runtime to fully evaluate — the
  // conservative default is "proven failure > absent evaluation."
  if (violations.length > 0) {
    const hasError = violations.some((v) => v.severity === "error");
    const conformance: Conformance = hasError ? "Does Not Support" : "Partially Supports";
    return {
      criterionId: criterion.id,
      localId: criterion.localId,
      title: criterion.title,
      level: criterion.level,
      conformance,
      remarks: buildViolationRemarks(criterion, violations, conformance),
      violationCount: violations.length,
      automated: criterion.automatable !== "manual",
    };
  }

  // Out-of-scope override. When the scan declared a conformance level
  // (e.g. `scan_project` at default AA) but the criterion's own level
  // is strictly above it (e.g. a AAA SC on an AA scan), render the row
  // as "Not Applicable" with an explicit scope citation. The previous
  // shape collapsed this into "Not Evaluated" alongside un-evaluated
  // manual criteria and runtime-evidence-required SCs — three
  // categorically different kinds of "we didn't check" under one
  // headline count. A procurement reader can tell from the remark +
  // `evidenceStatus: "out-of-scope"` that AAA criteria weren't in
  // scope, distinct from "we couldn't evaluate keyboard traversal
  // statically." Fires before applicability / runtime / manual checks
  // because out-of-scope is the strongest "don't ask this question"
  // signal — none of the other overrides should even run.
  if (scanLevel !== undefined && isAboveScanLevel(criterion.level, scanLevel)) {
    return {
      criterionId: criterion.id,
      localId: criterion.localId,
      title: criterion.title,
      level: criterion.level,
      conformance: "Not Applicable",
      remarks: buildOutOfScopeRemarks(criterion, scanLevel),
      violationCount: 0,
      automated: criterion.automatable !== "manual",
      evidenceStatus: "out-of-scope",
    };
  }

  // Element-presence override (docs/certification/vpat-mapping.md:49-61).
  // If the scan proves the feature governed by this criterion is absent
  // from every parsed file, emit "Not Applicable" with the deterministic
  // reason rather than "Not Evaluated."
  if (applicability && isLikelyIrrelevant(criterion.id, applicability)) {
    const reason = irrelevanceReason(criterion.id, applicability) ?? "Feature not present.";
    return {
      criterionId: criterion.id,
      localId: criterion.localId,
      title: criterion.title,
      level: criterion.level,
      conformance: "Not Applicable",
      remarks: `Not applicable: ${reason}`,
      violationCount: 0,
      automated: criterion.automatable !== "manual",
    };
  }

  const attestation = attestedByCriterion.get(criterion.id);

  // Runtime-evidence-required override. Criteria that fundamentally
  // need runtime observation — keyboard traversal, focus visibility,
  // rendered contrast, heading adequacy, pointer interaction,
  // authentication flow (see `RUNTIME_EVIDENCE_REQUIRED_CRITERIA`) — route to
  // "Not Evaluated" on a clean static scan when no attestation
  // supplies the missing runtime evidence. A procurement reader seeing
  // "Partially Supports" on 2.1.1 Keyboard from a bootstrap scan would
  // take it as "some aspects evaluated, some pass" when the honest
  // framing is "the static layer cannot answer this question."
  // Spec-derived allowlist, not a heuristic — every entry cites its
  // normative basis in `runtime-evidence-criteria.ts`.
  if (RUNTIME_EVIDENCE_REQUIRED_CRITERIA.has(criterion.id) && attestation === undefined) {
    return {
      criterionId: criterion.id,
      localId: criterion.localId,
      title: criterion.title,
      level: criterion.level,
      conformance: "Not Evaluated",
      remarks: buildRuntimeEvidenceRemarks(criterion),
      violationCount: 0,
      automated: criterion.automatable !== "manual",
    };
  }

  const automated = criterion.automatable !== "manual";

  if (!automated) {
    return {
      criterionId: criterion.id,
      localId: criterion.localId,
      title: criterion.title,
      level: criterion.level,
      conformance: "Not Evaluated",
      remarks: buildManualRemarks(criterion, candidates),
      violationCount: 0,
      automated: false,
    };
  }

  // Untested override. The criterion is automatable in metadata, but
  // `firedCriteria` tells us no satisfying rule actually ran on
  // eligible inputs in this scan — e.g. `contrast/minimum` on a
  // Tailwind project with zero authored `.css` files. The ledger's
  // default for "automatable with no violations" is to call it a pass;
  // VPAT used to stamp `Supports` on it, which is the canonical field
  // report ("15 of 18 pass criteria had no emitted findings — absence
  // interpreted as proof"). When the caller opts in by supplying
  // `firedCriteria`, route these to "Not Evaluated" with
  // `evidenceStatus: "untested"` and a remark naming the gap so the
  // split between "rule ran and found nothing" and "rule never ran"
  // is visible in the procurement artifact. Opt-in for backward compat
  // with callers that don't yet thread the evidence set through.
  //
  // A fresh attestation on the criterion counts as independent evidence
  // — a runtime harness / manual review / human study has spoken to the
  // criterion even though no static rule fired. Skip the untested
  // override in that case so the attested-pass routes through the
  // normal `buildAutomatedPassRemarks` path with its evidence citation.
  const unattestedEntry = buildUnattestedEntry(criterion, attestation, firedCriteria);
  if (unattestedEntry) return unattestedEntry;

  const remarks = buildAutomatedPassRemarks(criterion, attestation);
  return {
    criterionId: criterion.id,
    localId: criterion.localId,
    title: criterion.title,
    level: criterion.level,
    conformance: criterion.automatable === "partial" ? "Partially Supports" : "Supports",
    remarks,
    violationCount: 0,
    automated: true,
  };
}

/**
 * Auditor-facing remark for a criterion with at least one violation.
 * Cites the SC title + number, names the failing rules, and restates
 * the verdict in procurement vocabulary. No references to ra11y's
 * terminal output, JSON report, or any other internal tooling — the
 * VPAT reader may not have ra11y installed.
 */
function buildViolationRemarks(
  criterion: Criterion,
  violations: readonly Violation[],
  conformance: Conformance,
): string {
  const ruleSet = new Set(violations.map((v) => v.ruleId));
  const ruleList = [...ruleSet].sort().join(", ");
  const countWord = violations.length === 1 ? "finding" : "findings";
  const verdict = conformance === "Does Not Support" ? "Does Not Support" : "Partially Supports";
  return `${verdict}. ${criterion.localId} ${criterion.title} (Level ${criterion.level}): ${violations.length} ${countWord} from rule(s): ${ruleList}.`;
}

/**
 * Auditor-facing remark for an automatable criterion that passed the
 * static scan. When an attestation also backs the criterion, the
 * remark names the provenance axis (`runtime_tool` / `manual_review`
 * / `human_study` / `declaration`) plus `toolName` if supplied — an
 * auditor reading the VPAT sees at a glance that an axe-core run or
 * manual-review pass backed the verdict, not just the static scanner.
 */
function buildAutomatedPassRemarks(
  criterion: Criterion,
  attestation: AttestationRecord | undefined,
): string {
  const base =
    criterion.automatable === "partial"
      ? `Partially Supports. ${criterion.localId} ${criterion.title} (Level ${criterion.level}): automated source-code checks passed. Manual review still required for aspects outside static-analysis scope.`
      : `Supports. ${criterion.localId} ${criterion.title} (Level ${criterion.level}): automated source-code checks passed with no findings.`;
  if (attestation === undefined) return base;
  return `${base} ${buildAttestationCitation(attestation)}`;
}

/**
 * Appends a short evidence citation to a remark: `Evidence:
 * runtime_tool (axe-core 4.8.2)`. Named fields surface verbatim so the
 * auditor can cross-reference the attestation against their CI /
 * review log. Omits the parenthetical when no `toolName` is present.
 */
function buildAttestationCitation(attestation: AttestationRecord): string {
  const parts: string[] = [];
  if (attestation.toolName !== undefined) parts.push(attestation.toolName);
  if (attestation.runUrl !== undefined) parts.push(attestation.runUrl);
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `Evidence: ${attestation.evidenceSource}${suffix}.`;
}

/**
 * Auditor-facing remark for a runtime-evidence-required criterion with
 * no attestation supplied. Names the SC, states the runtime-dependency
 * framing explicitly, and points the caller at the attestation flow so
 * the gap is actionable rather than decorative. The VPAT reader sees
 * "Not Evaluated" as "we did not evaluate this" (honest) rather than
 * "Partially Supports" as "we partially evaluated this" (the previous
 * dishonest collapse). See `docs/kb/architecture/ai-first-consumer.md`
 * (surface-don't-suppress rule).
 */
function buildRuntimeEvidenceRemarks(criterion: Criterion): string {
  return `Not Evaluated. ${criterion.localId} ${criterion.title} (Level ${criterion.level}): runtime-dependent criterion. Static source analysis cannot prove conformance; no attestation supplied. Evaluate via a runtime harness (keyboard/focus/contrast testing, as applicable) and record the verdict with the \`attest\` tool.`;
}

/**
 * Auditor-facing remark for a criterion whose level exceeds the scan's
 * declared `scanLevel`. Names the gap explicitly ("AAA criterion on an
 * AA scan") so a procurement reader doesn't conflate "out of scope"
 * with "evaluated and found clean" or with the media-absent "Not
 * Applicable" case. Paired with the entry-level
 * `evidenceStatus: "out-of-scope"` structured signal — an agent can
 * route on either surface.
 */
function buildOutOfScopeRemarks(criterion: Criterion, scanLevel: "A" | "AA" | "AAA"): string {
  return `Not Applicable — out of scope. ${criterion.localId} ${criterion.title} is a Level ${criterion.level} criterion; this VPAT was produced at scanLevel ${scanLevel}. Re-run the scan with a higher level to evaluate.`;
}

/**
 * Auditor-facing remark for an automatable criterion whose satisfying
 * rules never ran on eligible inputs in this scan — e.g.
 * `contrast/minimum` on a Tailwind project with zero authored `.css`
 * files. The previous shape (`Supports`) summed these under the honest
 * pass bucket, which is the canonical "absence interpreted as proof"
 * failure mode the field report flagged. Routes to "Not Evaluated"
 * with an explicit "no rule satisfying this criterion ran" reason so
 * the procurement reader sees the scope gap rather than a silent pass.
 */
function buildUntestedRemarks(criterion: Criterion): string {
  return `Not Evaluated. ${criterion.localId} ${criterion.title} (Level ${criterion.level}): no rule satisfying this criterion ran on eligible inputs in this scan. Absence of findings is not evidence of conformance; extend the scan to files the rules target (CSS for contrast, HTML/TSX for structural rules) and re-run.`;
}

/**
 * Routes criteria with no positive evidence to "Not Evaluated" before
 * the default pass-by-absence logic runs. Two paths:
 *   1. `automatable: "partial"` + no attestation — partial automation
 *      cannot prove conformance for the manual / judgement-bound half;
 *      "Partially Supports" with zero evidence is dishonest.
 *   2. Rule satisfying the criterion never fired AND no attestation —
 *      "Supports" on absence of findings is the canonical pass-by-omission
 *      bug.
 * The partial-unattested branch fires before the never-fired branch
 * because the partial framing is more specific.
 */
function buildUnattestedEntry(
  criterion: Criterion,
  attestation: AttestationRecord | undefined,
  firedCriteria: ReadonlySet<string> | undefined,
): VpatEntry | undefined {
  if (attestation !== undefined) return undefined;
  if (criterion.automatable === "partial") {
    return {
      criterionId: criterion.id,
      localId: criterion.localId,
      title: criterion.title,
      level: criterion.level,
      conformance: "Not Evaluated",
      remarks: buildPartialUnattestedRemarks(criterion),
      violationCount: 0,
      automated: true,
    };
  }
  if (firedCriteria !== undefined && !firedCriteria.has(criterion.id)) {
    return {
      criterionId: criterion.id,
      localId: criterion.localId,
      title: criterion.title,
      level: criterion.level,
      conformance: "Not Evaluated",
      remarks: buildUntestedRemarks(criterion),
      violationCount: 0,
      automated: true,
      evidenceStatus: "untested",
    };
  }
  return undefined;
}

/**
 * Auditor-facing remark for an `automatable: "partial"` criterion that
 * had a satisfying rule run with zero findings AND no attestation. The
 * automated half found nothing wrong, but the manual / judgement-bound
 * half is unverified — claiming "Partially Supports" without that
 * evidence reads to a procurement officer as "we tested and some parts
 * work" when the honest framing is "we couldn't fully evaluate this."
 * Routes to "Not Evaluated" with an explicit framing of which half is
 * un-evaluated and pointers to `attest` for closing the gap.
 */
function buildPartialUnattestedRemarks(criterion: Criterion): string {
  return `Not Evaluated. ${criterion.localId} ${criterion.title} (Level ${criterion.level}): partial-automation criterion. Static source-code checks ran with no findings, but the manual / judgement-bound half of this criterion was not evaluated. Absence of findings is not evidence of conformance; record a verdict via the \`attest\` tool (manual review, runtime harness, or human study) to close the gap.`;
}

const LEVEL_RANK: Readonly<Record<"A" | "AA" | "AAA", number>> = { A: 1, AA: 2, AAA: 3 };

/**
 * True when a criterion's level is strictly above the scan's declared
 * conformance level — meaning the scanner's rule-filter would never
 * have fired any AAA-only rule for this criterion, so claiming any
 * verdict other than "out of scope" would be dishonest. `base` is
 * always in scope (Section 508 has no A/AA/AAA axis). Unknown levels
 * fall through as in-scope so a future standard with a novel taxonomy
 * isn't silently dropped.
 */
function isAboveScanLevel(criterionLevel: string, scanLevel: "A" | "AA" | "AAA"): boolean {
  if (criterionLevel === "base") return false;
  const critRank = LEVEL_RANK[criterionLevel as "A" | "AA" | "AAA"];
  if (critRank === undefined) return false;
  return critRank > LEVEL_RANK[scanLevel];
}

/**
 * Auditor-facing remark for a manual criterion. If finders have
 * surfaced candidate locations, point the reviewer at them with a
 * count and top-level file/line so the VPAT carries real evidence
 * instead of boilerplate. Kept intentionally factual — no pass/fail
 * language, since a candidate is "go look here," not a violation.
 */
function buildManualRemarks(criterion: Criterion, candidates: readonly ReviewCandidate[]): string {
  const header = `Not Evaluated. ${criterion.localId} ${criterion.title} (Level ${criterion.level}): requires manual review — this criterion cannot be fully determined by static source analysis.`;
  if (candidates.length === 0) return header;

  const locations = new Set<string>();
  for (const c of candidates) locations.add(`${c.location.filePath}:${c.location.line}`);
  const preview: string[] = [];
  const MAX_PREVIEW = 3;
  for (const loc of locations) {
    if (preview.length >= MAX_PREVIEW) break;
    preview.push(loc);
  }
  const total = locations.size;
  const extra = total > preview.length ? ` (+${total - preview.length} more)` : "";
  return `${header} ${total} candidate location(s) surfaced for reviewer attention: ${preview.join(
    ", ",
  )}${extra}.`;
}

/**
 * Indexes attestations by criterion ID, keeping the record with a
 * meaningful verdict (`"pass"` / `"fail"` / `"n/a"`). `"pending"`
 * attestations (bare pragmas the author hasn't filled a reason on) do
 * NOT count as evidence; they surface in `list_attestations` as
 * actionable gaps, but they do not lift a runtime-dependent criterion
 * out of "Not Evaluated."
 *
 * When multiple attestations speak to one criterion, prefer the most
 * recent by `attestedAt`. The evidence-source citation lands on the
 * VPAT remarks cell, so a single "most recent" record is the useful
 * one — older attestations show up in `list_attestations` if an
 * auditor wants the full audit trail.
 */
function indexAttestedByCriterion(
  attestations: readonly AttestationRecord[],
): ReadonlyMap<string, AttestationRecord> {
  const out = new Map<string, AttestationRecord>();
  for (const a of attestations) {
    const verdict = a.verdict ?? "pass";
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "n/a") continue;
    const existing = out.get(a.criterionId);
    if (existing === undefined || a.attestedAt > existing.attestedAt) {
      out.set(a.criterionId, a);
    }
  }
  return out;
}

function indexCandidatesByCriterion(
  candidates: readonly ReviewCandidate[],
): Map<string, ReviewCandidate[]> {
  const map = new Map<string, ReviewCandidate[]>();
  for (const c of candidates) {
    let list = map.get(c.criterionId);
    if (!list) {
      list = [];
      map.set(c.criterionId, list);
    }
    list.push(c);
  }
  return map;
}

function indexViolationsByCriterion(violations: readonly Violation[]): Map<string, Violation[]> {
  const map = new Map<string, Violation[]>();
  for (const v of violations) {
    for (const criterionId of v.criteria) {
      let list = map.get(criterionId);
      if (!list) {
        list = [];
        map.set(criterionId, list);
      }
      list.push(v);
    }
  }
  return map;
}

export { renderVpatMarkdown } from "./vpat-markdown.ts";
