/**
 * The `explain_standard` MCP tool. Parallels `explain_rule`: pass a
 * standard ID, get the full criterion list plus metadata an agent
 * can reason about without having to import the scanner's type
 * system.
 *
 * Rule-centric `list_rules` was already in place; this is the
 * standard-centric mirror agents asked for when drafting a VPAT or
 * comparing coverage across standards.
 */

import type { Criterion } from "../types/standard.ts";
import { errorResult, type McpTool, strParam, textResult } from "./tools-helpers.ts";

export const explainStandardTool: McpTool = {
  def: {
    name: "explain_standard",
    description:
      "Return metadata + criterion list for a loaded standard (wcag22, wcag21, section508, en301549). Use when drafting a VPAT, comparing coverage across standards, or picking which criteria to surface in a manual review.",
    inputSchema: {
      type: "object",
      properties: {
        standardId: {
          type: "string",
          description: "Standard identifier (e.g. wcag22, section508, en301549).",
        },
        level: {
          type: "string",
          enum: ["A", "AA", "AAA"],
          description: "Optional. Filter criteria to this level and below (AA returns A + AA).",
        },
      },
      required: ["standardId"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  handler(params, session) {
    const id = strParam(params, "standardId");
    if (!id) {
      return errorResult({
        code: "missing-required-param",
        message: "standardId must be a non-empty string.",
        details: { param: "standardId" },
      });
    }

    const standard = session.registry.findStandard(id);
    if (!standard) {
      const known = session.registry.standards.map((s) => s.id).join(", ");
      return errorResult({
        code: "standard-not-found",
        message: `Unknown standard '${id}'. Loaded: ${known}.`,
        details: { requested: id, loaded: session.registry.standards.map((s) => s.id) },
        remediation: "Pass `standardId` with one of the loaded IDs.",
      });
    }

    const level = strParam(params, "level");
    const criteria = level ? filterByLevel(standard.criteria, level) : standard.criteria;

    // Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": optional
    // fields are conditional-spread at the assembly site rather than
    // emitted as `null` / `[]` sentinels. `publisher` and `url` are
    // schema-required on `Standard` so the spread is effectively
    // unconditional — the form still documents the shape as
    // present-when-meaningful and removes the misleading `?? null`
    // fallback that suggested the value could be unknown.
    return textResult({
      id: standard.id,
      name: standard.name,
      version: standard.version,
      ...(standard.publisher ? { publisher: standard.publisher } : {}),
      ...(standard.url ? { url: standard.url } : {}),
      levels: standard.levels,
      ...(level ? { levelFilterApplied: level } : {}),
      criteriaCount: criteria.length,
      criteria: criteria.map((c) => ({
        id: c.id,
        title: c.title,
        level: c.level,
        automatable: c.automatable ?? "unknown",
        ...(c.url ? { url: c.url } : {}),
        ...(c.equivalentTo && c.equivalentTo.length > 0 ? { equivalentTo: c.equivalentTo } : {}),
      })),
    });
  },
};

function filterByLevel(criteria: readonly Criterion[], level: string): readonly Criterion[] {
  const rank: Record<string, number> = { A: 1, AA: 2, AAA: 3 };
  const ceiling = rank[level] ?? 3;
  return criteria.filter((c) => (rank[c.level] ?? 0) <= ceiling);
}
