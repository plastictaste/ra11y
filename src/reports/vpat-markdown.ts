/**
 * Markdown renderer for the VPAT report. Extracted from `vpat.ts` so
 * that file stays under the 500-effective-line budget — the renderer
 * is a pure one-way mapping from the structured VPAT report to the
 * markdown table form a VPAT template consumes and carries no
 * business logic beyond pipe-escaping and present-when-meaningful
 * section omission.
 */

import type { VpatReport } from "./vpat.ts";

/**
 * Chapters documented on the rendered VPAT 2.5 Rev header. ra11y's
 * source-code scan is a Chapter 5 (software) evidence source; the
 * remaining chapters are listed with "See product documentation"
 * placeholders so the VPAT reader understands the scope boundary.
 * Kept as a module constant so the renderer carries its own source of
 * truth — the builder does not emit these into the typed report.
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

/** Renders a VPAT report as a Markdown table ready to paste into a VPAT template. */
export function renderVpatMarkdown(report: VpatReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.templateVersion} Conformance Report`);
  lines.push("");
  lines.push(...renderProduct(report));
  lines.push("");
  lines.push(...renderEvaluation(report));
  lines.push("");
  lines.push(...renderChapters());
  lines.push("");
  for (const section of report.standards) {
    lines.push(...renderSection(section));
  }
  return lines.join("\n");
}

function renderProduct(report: VpatReport): readonly string[] {
  const lines: string[] = ["## Product"];
  lines.push(`- **Name**: ${report.product.productName}`);
  lines.push(`- **Version**: ${report.product.productVersion}`);
  if (report.product.contactOrganization) {
    lines.push(`- **Organization**: ${report.product.contactOrganization}`);
  }
  if (report.product.contactEmail) {
    lines.push(`- **Contact**: ${report.product.contactEmail}`);
  }
  return lines;
}

function renderEvaluation(report: VpatReport): readonly string[] {
  const lines: string[] = ["## Evaluation"];
  lines.push(`- **Evaluator**: ${report.evaluator.name}`);
  if (report.evaluator.scanLevel !== undefined) {
    lines.push(`- **Scan Level**: ${report.evaluator.scanLevel}`);
  }
  lines.push(`- **Generated**: ${report.generatedAt}`);
  if (report.product.evaluationMethods) {
    lines.push(`- **Methods**: ${report.product.evaluationMethods}`);
  }
  if (report.product.notesOnEvaluation) {
    lines.push(`- **Notes**: ${report.product.notesOnEvaluation}`);
  }
  return lines;
}

function renderChapters(): readonly string[] {
  const lines: string[] = ["## Applicable Chapters"];
  for (const chapter of CHAPTER_NOTES) {
    lines.push(`- **${chapter.heading}** — ${chapter.note}`);
  }
  return lines;
}

function renderSection(section: VpatReport["standards"][number]): readonly string[] {
  const lines: string[] = [];
  lines.push(`## ${section.standardName} ${section.version}`);
  lines.push("");
  // Split-bucket suffixes are present-when-meaningful: only render
  // "of which X out of scope / Y untested" when the scanner actually
  // produced those categorizations (legacy callers not passing
  // scanLevel / firedCriteria see `0` there and the suffix is elided).
  const splits: string[] = [];
  if (section.summary.outOfScope > 0) {
    splits.push(`${section.summary.outOfScope} out-of-scope`);
  }
  if (section.summary.untested > 0) {
    splits.push(`${section.summary.untested} untested`);
  }
  const splitSuffix = splits.length > 0 ? ` (of which ${splits.join(", ")})` : "";
  lines.push(
    `Summary: **${section.summary.supports}** Supports · **${section.summary.partiallySupports}** Partially · **${section.summary.doesNotSupport}** Does Not Support · **${section.summary.notApplicable}** Not Applicable · **${section.summary.notEvaluated}** Not Evaluated${splitSuffix}`,
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
  return lines;
}
