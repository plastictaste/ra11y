/**
 * Manual review checklist generator.
 *
 * Every criterion marked `automatable: "manual"` appears here as a
 * checkbox entry that a human auditor fills in during a compliance
 * review. The output is Markdown — copy-paste into a tracker, check
 * items off as reviewers complete them, feed back into
 * --certification for the readiness score.
 *
 * Grouped by standard, then by WCAG principle (for WCAG modules).
 * Non-WCAG standards are flat.
 */

import type { ReviewCandidate } from "../types/review.ts";
import type { Standard } from "../types/standard.ts";
import type { PerStandardCoverage } from "./coverage.ts";

export interface ChecklistSection {
  readonly standardId: string;
  readonly standardName: string;
  readonly items: readonly ChecklistItem[];
}

export interface ChecklistItem {
  readonly id: string;
  readonly localId: string;
  readonly title: string;
  readonly level: string;
  readonly url: string;
  readonly guidance: string;
  readonly candidates: readonly ReviewCandidate[];
}

export interface ChecklistReport {
  readonly sections: readonly ChecklistSection[];
  readonly totalItems: number;
}

export function buildChecklist(
  coverage: readonly PerStandardCoverage[],
  standards: readonly Standard[],
  candidates: readonly ReviewCandidate[] = [],
): ChecklistReport {
  const candidatesByCriterion = groupCandidatesByCriterion(candidates);
  const standardById = new Map(standards.map((s) => [s.id, s]));
  const sections: ChecklistSection[] = [];
  let total = 0;

  for (const entry of coverage) {
    const standard = standardById.get(entry.standardId);
    if (!standard) continue;

    const items: ChecklistItem[] = [];
    for (const criterionId of entry.manualCriteria) {
      const criterion = standard.criteria.find((c) => c.id === criterionId);
      if (!criterion) continue;
      items.push({
        id: criterion.id,
        localId: criterion.localId,
        title: criterion.title,
        level: criterion.level,
        url: criterion.url,
        guidance: criterion.description,
        candidates: candidatesByCriterion.get(criterion.id) ?? [],
      });
    }

    if (items.length > 0) {
      sections.push({
        standardId: entry.standardId,
        standardName: entry.standardName,
        items: items.sort((a, b) => compareLocalIds(a.localId, b.localId)),
      });
      total += items.length;
    }
  }

  return { sections, totalItems: total };
}

export function renderChecklistMarkdown(report: ChecklistReport): string {
  const lines: string[] = [];
  lines.push("# Manual review checklist");
  lines.push("");
  lines.push(
    "These accessibility criteria cannot be statically checked. A human reviewer must audit each item and check it off. Fill in notes inline and commit this file alongside your VPAT.",
  );
  lines.push("");
  lines.push(`**${report.totalItems} criteria need manual review.**`);
  lines.push("");

  for (const section of report.sections) {
    lines.push(`## ${section.standardName}`);
    lines.push("");
    for (const item of section.items) {
      lines.push(`- [ ] **${item.localId}** ${item.title} · Level ${item.level}`);
      lines.push(`  - ${item.guidance}`);
      lines.push(`  - Spec: ${item.url}`);
      if (item.candidates.length > 0) {
        lines.push(`  - **Review locations** (${item.candidates.length} found):`);
        for (const c of item.candidates) {
          lines.push(`    - \`${c.location.filePath}:${c.location.line}\` — ${c.reason}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function groupCandidatesByCriterion(
  candidates: readonly ReviewCandidate[],
): ReadonlyMap<string, readonly ReviewCandidate[]> {
  const map = new Map<string, ReviewCandidate[]>();
  for (const candidate of candidates) {
    let group = map.get(candidate.criterionId);
    if (!group) {
      group = [];
      map.set(candidate.criterionId, group);
    }
    group.push(candidate);
  }
  return map;
}

function compareLocalIds(a: string, b: string): number {
  const ap = a.split(".").map(Number);
  const bp = b.split(".").map(Number);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const av = ap[i] ?? 0;
    const bv = bp[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
