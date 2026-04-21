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
 *     covers it. Absence of a static finding on a runtime-dependent
 *     SC is not evidence of conformance.
 *   - "Does Not Support" — at least one `error` violation.
 *   - "Partially Supports" — only `warning` violations, or the
 *     criterion is classified "partial" in the standard metadata.
 *   - "Supports" — zero violations on an automatable criterion.
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

export interface VpatEntry {
  readonly criterionId: string;
  readonly localId: string;
  readonly title: string;
  readonly level: string;
  readonly conformance: Conformance;
  readonly remarks: string;
  readonly violationCount: number;
  readonly automated: boolean;
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

export interface VpatReport {
  readonly templateVersion: string;
  readonly generatedAt: string;
  readonly evaluator: string;
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
}

const EVALUATOR = `ra11y v${VERSION}`;

/** Template placeholder surfaced when the caller leaves a required field blank. */
const PLACEHOLDER_PRODUCT_NAME = "<Product Name>";
const PLACEHOLDER_PRODUCT_VERSION = "<Product Version>";

/**
 * Chapters documented on the rendered VPAT 2.5 Rev header. ra11y's
 * source-code scan is a Chapter 5 (software) evidence source; the
 * remaining chapters are listed with "See product documentation"
 * placeholders so the VPAT reader understands the scope boundary.
 * Kept as a module constant so both the builder and any future
 * renderer share a single source of truth.
 */
const CHAPTER_NOTES: ReadonlyArray<{ readonly heading: string; readonly note: string }> = [
  {
    heading: "Chapter 3: Functional Performance Criteria (FPC)",
    note: "Not evaluated by static source analysis. See product documentation for FPC statements.",
  },
  { heading: "Chapter 4: Hardware", note: "Not applicable — ra11y scans software sources only." },
  {
    heading: "Chapter 5: Software",
    note: "Evaluated by static source analysis. Per-criterion verdicts follow.",
  },
  {
    heading: "Chapter 6: Support Documentation and Services",
    note: "Not evaluated by static source analysis. See product documentation for conformance statements.",
  },
  {
    heading: "Chapter 7: Cognitive, Language, and Learning Disabilities",
    note: "Partially evaluated via Chapter 5 criteria; dedicated Chapter 7 claims require manual review.",
  },
];

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
  const attestedCriteria = indexAttestedCriteria(options.attestations ?? []);

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
        attestedCriteria,
      ),
    );
  }

  return {
    templateVersion,
    generatedAt,
    evaluator: EVALUATOR,
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
  attestedCriteria: ReadonlySet<string>,
): VpatStandardSection {
  const entries: VpatEntry[] = [];
  const summary = {
    supports: 0,
    partiallySupports: 0,
    doesNotSupport: 0,
    notApplicable: 0,
    notEvaluated: 0,
  };

  for (const criterion of standard.criteria) {
    const entry = buildEntry(
      criterion,
      violationsByCriterion.get(criterion.id) ?? [],
      candidatesByCriterion.get(criterion.id) ?? [],
      applicability,
      attestedCriteria,
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
  attestedCriteria: ReadonlySet<string>,
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
  if (RUNTIME_EVIDENCE_REQUIRED_CRITERIA.has(criterion.id) && !attestedCriteria.has(criterion.id)) {
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

  const remarks = buildAutomatedPassRemarks(criterion);
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

/** Auditor-facing remark for an automatable criterion that passed the static scan. */
function buildAutomatedPassRemarks(criterion: Criterion): string {
  if (criterion.automatable === "partial") {
    return `Partially Supports. ${criterion.localId} ${criterion.title} (Level ${criterion.level}): automated source-code checks passed. Manual review still required for aspects outside static-analysis scope.`;
  }
  return `Supports. ${criterion.localId} ${criterion.title} (Level ${criterion.level}): automated source-code checks passed with no findings.`;
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
 * Collects the set of criterion IDs that carry a fresh attestation with
 * a meaningful verdict — `"pass"`, `"fail"`, or `"n/a"`. `"pending"`
 * attestations (bare pragmas the author hasn't filled a reason on) do
 * NOT count as evidence; they surface in `list_attestations` as
 * actionable gaps, but they do not lift a runtime-dependent criterion
 * out of "Not Evaluated." Matches the `recordFromAttestedSource` verdict
 * filter in `src/reports/conformance.ts` so the two surfaces route on
 * the same signal.
 */
function indexAttestedCriteria(attestations: readonly AttestationRecord[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const a of attestations) {
    const verdict = a.verdict ?? "pass";
    if (verdict === "pass" || verdict === "fail" || verdict === "n/a") {
      out.add(a.criterionId);
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

/** Renders a VPAT report as a Markdown table ready to paste into a VPAT template. */
export function renderVpatMarkdown(report: VpatReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.templateVersion} Conformance Report`);
  lines.push("");
  lines.push("## Product");
  lines.push(`- **Name**: ${report.product.productName}`);
  lines.push(`- **Version**: ${report.product.productVersion}`);
  if (report.product.contactOrganization) {
    lines.push(`- **Organization**: ${report.product.contactOrganization}`);
  }
  if (report.product.contactEmail) {
    lines.push(`- **Contact**: ${report.product.contactEmail}`);
  }
  lines.push("");
  lines.push("## Evaluation");
  lines.push(`- **Evaluator**: ${report.evaluator}`);
  lines.push(`- **Generated**: ${report.generatedAt}`);
  if (report.product.evaluationMethods) {
    lines.push(`- **Methods**: ${report.product.evaluationMethods}`);
  }
  if (report.product.notesOnEvaluation) {
    lines.push(`- **Notes**: ${report.product.notesOnEvaluation}`);
  }
  lines.push("");
  lines.push("## Applicable Chapters");
  for (const chapter of CHAPTER_NOTES) {
    lines.push(`- **${chapter.heading}** — ${chapter.note}`);
  }
  lines.push("");

  for (const section of report.standards) {
    lines.push(`## ${section.standardName} ${section.version}`);
    lines.push("");
    lines.push(
      `Summary: **${section.summary.supports}** Supports · **${section.summary.partiallySupports}** Partially · **${section.summary.doesNotSupport}** Does Not Support · **${section.summary.notApplicable}** Not Applicable · **${section.summary.notEvaluated}** Not Evaluated`,
    );
    lines.push("");
    lines.push("| Criterion | Level | Conformance | Remarks |");
    lines.push("|-----------|-------|-------------|---------|");
    for (const entry of section.entries) {
      const title = entry.title.replace(/\|/g, "\\|");
      const remarks = entry.remarks.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(
        `| ${entry.localId} ${title} | ${entry.level} | ${entry.conformance} | ${remarks} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
