/**
 * Markdown renderer for the conformance statement. Extracted from
 * `conformance.ts` so that file stays under the 500-effective-line
 * budget — the renderer is a pure one-way mapping from the typed
 * statement to a claim-shaped markdown document and carries no
 * business logic beyond pipe-escaping and present-when-meaningful
 * section omission.
 */

import type {
  ConformanceBlocker,
  ConformanceStatement,
  ConformanceStatementScope,
} from "./conformance.ts";

/**
 * Markdown renderer for the conformance statement — the shape an
 * auditor or release process can drop into a release note or
 * compliance bundle. Emits the WCAG §5.3.1 required claim fields
 * (date, guidelines title/version/URI, conformance level, scope,
 * technologies relied upon) plus the ra11y-specific verdict and
 * blocker table. Sections whose array is empty are omitted (e.g.
 * `technologiesNotReliedUpon` is usually `[]`). The `## Limitations`
 * section is emitted only when `statement.limitations` is non-empty —
 * matching the response-level present-when-meaningful rule.
 */
export function renderConformanceMarkdown(statement: ConformanceStatement): string {
  const lines: string[] = [];
  lines.push(...renderMarkdownHeader(statement));
  lines.push(...renderMarkdownScope(statement.scope));
  lines.push(
    ...renderMarkdownTechnologies(
      statement.technologiesReliedUpon,
      statement.technologiesNotReliedUpon,
    ),
  );
  lines.push("");
  // `## Evidence sources` groups the attested sources by the four
  // provenance classifier values (runtime_tool / manual_review /
  // human_study / declaration). An auditor reading the claim sees at
  // a glance what mix of evidence the verdict rests on — a section
  // dominated by `declaration` stands on weaker ground than one
  // dominated by `runtime_tool` + `human_study`, even when the verdict
  // is the same. Present-when-meaningful: omitted when the builder
  // received no `signing.attestations` input.
  lines.push(...renderMarkdownAttestationSummary(statement.attestationSummary));
  // `## Limitations` is present-when-meaningful: omitted when no
  // runtime-evidence-required criterion surfaced. It sits before the
  // blocker table so a reader scanning the claim sees the honesty
  // caveat before the per-criterion breakdown — the criterion's blocker
  // row carries `reason: "runtime-evidence-required"` + `status:
  // "undetermined"` for structured routing.
  lines.push(...renderMarkdownLimitations(statement.limitations));
  if (statement.conformant) {
    lines.push(
      `Every criterion in scope is backed by at least one non-candidate evidence source with a final status of pass or n/a.`,
    );
    return lines.join("\n");
  }
  lines.push(...renderMarkdownBlockerTable(statement.blockers));
  return lines.join("\n");
}

/** Header: title + claim metadata + pass/fail tally one-liner. */
function renderMarkdownHeader(statement: ConformanceStatement): readonly string[] {
  const {
    profile,
    generatedAt,
    conformant,
    guidelinesTitle,
    guidelinesVersion,
    guidelinesUri,
    criteriaInScope,
    summary,
  } = statement;
  return [
    `# Conformance Statement — ${profile.standardId} ${profile.level}`,
    "",
    `- Date: ${generatedAt}`,
    `- Guidelines: ${guidelinesTitle} ${guidelinesVersion} (<${guidelinesUri}>)`,
    `- Conformance level: ${profile.level}`,
    `- Criteria in scope: ${criteriaInScope}`,
    `- Status: **${conformant ? "CONFORMANT" : "NOT CONFORMANT"}** (pass=${summary.pass}, untested=${summary.untested}, fail=${summary.fail}, partial=${summary.partial}, unknown=${summary.unknown}, n/a=${summary.na})`,
    "",
  ];
}

/**
 * `## Scope` — root, file count, optional commit hash, optional config
 * snapshot.: when the scan
 * partitioned files into evaluated + build-artifact-flagged, the
 * skipped count surfaces alongside `Files scanned` so a procurement
 * reviewer reading the markdown sees the post-skip count is the
 * load-bearing one — composite headline counts are dishonest at the
 * procurement-surface layer just as much as on JSON tool responses.
 */
function renderMarkdownScope(scope: ConformanceStatementScope): readonly string[] {
  const lines: string[] = [
    "## Scope",
    "",
    `- Root: \`${scope.root}\``,
    `- Files scanned: ${scope.filesCount}`,
  ];
  if (scope.skippedFilesCount !== undefined && scope.skippedFilesCount > 0) {
    lines.push(`- Files skipped (build artifacts): ${scope.skippedFilesCount}`);
  }
  if (scope.commitHash !== undefined) lines.push(`- Commit: \`${scope.commitHash}\``);
  if (scope.configSnapshot !== undefined) {
    lines.push(
      `- Config snapshot:`,
      "",
      "```json",
      JSON.stringify(scope.configSnapshot, null, 2),
      "```",
    );
  }
  return lines;
}

/** `## Technologies relied upon` + optional `## Technologies not relied upon`. */
function renderMarkdownTechnologies(
  reliedUpon: readonly string[],
  notReliedUpon: readonly string[],
): readonly string[] {
  const lines: string[] = ["", "## Technologies relied upon", ""];
  if (reliedUpon.length === 0) lines.push(`_None declared._`);
  else for (const t of reliedUpon) lines.push(`- ${t}`);
  if (notReliedUpon.length > 0) {
    lines.push("", "## Technologies not relied upon", "");
    for (const t of notReliedUpon) lines.push(`- ${t}`);
  }
  return lines;
}

/**
 * `## Evidence sources` — per-evidenceSource attestation tally.
 * Present-when-the-builder-received-attestations; omitted otherwise so
 * an empty or absent list doesn't read as "no attestations" when the
 * reality is "builder wasn't given the list" (see the
 * absent-vs-empty rule).
 */
function renderMarkdownAttestationSummary(
  summary: ConformanceStatement["attestationSummary"],
): readonly string[] {
  if (summary === undefined) return [];
  const lines: string[] = [
    "## Evidence sources",
    "",
    `- Attestations in ledger: ${summary.totalCount}`,
  ];
  for (const [source, count] of Object.entries(summary.bySource)) {
    if (count === undefined || count === 0) continue;
    lines.push(`- ${source}: ${count}`);
  }
  lines.push("");
  return lines;
}

/** `## Limitations` — present-when-non-empty, per the absent-vs-empty rule. */
function renderMarkdownLimitations(limitations: readonly string[] | undefined): readonly string[] {
  if (limitations === undefined || limitations.length === 0) return [];
  const lines: string[] = ["## Limitations", ""];
  for (const entry of limitations) lines.push(`- ${entry}`);
  lines.push("");
  return lines;
}

/** `## Blockers` — pipe-escaped markdown table; called only on not-conformant. */
function renderMarkdownBlockerTable(blockers: readonly ConformanceBlocker[]): readonly string[] {
  const lines: string[] = [
    "## Blockers",
    "",
    "| Criterion | Title | Level | Status | Reason | Static | Attested | Candidate |",
    "|---|---|---|---|---|---:|---:|---:|",
  ];
  for (const b of blockers) {
    lines.push(
      `| ${b.criterionId} | ${escapePipe(b.title)} | ${b.level} | ${b.status} | ${b.reason} | ${b.staticSources} | ${b.attestedSources} | ${b.candidateSources} |`,
    );
  }
  return lines;
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}
