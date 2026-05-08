/**
 * `list_finders` — enumerate the manual-review candidate finders.
 *
 * Pairs with `list_rules` on the discovery surface: `list_rules` covers
 * the deterministic / mechanical half of ra11y's static analysis, while
 * `list_finders` covers the manual-review half — every `CandidateFinder`
 * registered under `src/review/finders/`. Until this tool existed, the
 * finder surface was discoverable only by accident: an agent reading
 * `review_candidates.prompts[*].finderId` saw whichever finders had
 * fired on the scanned input and had no way to learn about ones that
 * didn't fire (no candidate emitted on this corpus, criterion not
 * touched). For agents auditing the scanner's manual-review coverage
 * area before a sweep, `list_finders` is the canonical inventory call.
 *
 * Doctrine notes (per `docs/kb/architecture/ai-first-consumer.md`):
 *
 *   - **One enumeration concept per response.** Every finder is a
 *     manual-review surface; there is no "auto" / "manual" sub-bucket
 *     to split on (rules cover the auto half, finders cover the manual
 *     half — the split lives at the tool level, not inside this
 *     response). A `kind` discriminator inside the entry would be a
 *     labeled bucket on a single conceptual lane and the doctrine
 *     `Labeled buckets are suppression too` cuts against it.
 *
 *   - **Verbose meta is signal.** Mirrors `list_rules.meta` — `findersTotal`,
 *     `findersMatched`, `standardsLoaded`, `standards`. Same scan-confidence
 *     telemetry the agent uses to cross-check the enumeration resolved
 *     against the expected registry.
 *
 *   - **Standard filter via equivalence closure.** A finder declared
 *     against `wcag22:2.4.5` also satisfies `section508:2.4.5` and
 *     `en301549:9.2.4.5` once the standards' `equivalentTo` reciprocal
 *     index closes; matches `list_rules`'s standard-filter resolver so
 *     adjacent same-family enumerations stay consistent.
 *
 *   - **Cross-surface count invariant.** Every finder visible via
 *     `review_candidates.prompts[*].finderId` MUST appear in this
 *     enumeration. Pinned by an integration test: scan a fixture that
 *     fires multiple finders, collect the `finderId` set from
 *     `review_candidates`, and assert `list_finders` returns a superset.
 *     Drift would silently break agent audit workflows that pre-budget
 *     against the inventory headline.
 */

import type { McpSession } from "./session.ts";
import { errorResult, type McpTool, strParam, textResult } from "./tools-helpers.ts";

interface ListFindersNextStep {
  readonly prose: string;
  readonly structured: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
  };
}

function buildNextStep(standardFilter: string | undefined, matched: number): ListFindersNextStep {
  const plural = matched === 1 ? "" : "s";
  if (standardFilter !== undefined) {
    return {
      prose: `${matched} finder${plural} surface candidates against criteria in \`${standardFilter}\`. Call \`review_candidates\` (or \`scan_project\` to see candidates alongside rule findings) to evaluate them against your code.`,
      structured: { tool: "review_candidates", args: { standard: standardFilter } },
    };
  }
  return {
    prose: `${matched} finder${plural} loaded across every built-in standard. Call \`review_candidates\` to evaluate them against your code, or \`scan_project\` to see manual-review candidates alongside rule findings. Pass \`standard\` to narrow this list to a single framework.`,
    structured: { tool: "review_candidates", args: {} },
  };
}

/**
 * Expands a finder's declared `criterionIds` through the criteria
 * registry's reciprocal `equivalentTo` index — same pattern
 * `list_rules.expandSatisfies` uses so the standard filter resolves
 * consistently across both discovery surfaces. Direct declarations
 * come first; equivalents follow grouped by loaded-standard order.
 */
function expandCriteria(declared: readonly string[], session: McpSession): readonly string[] {
  const declaredSet = new Set(declared);
  const expanded = new Set<string>();
  for (const cid of declared) {
    for (const equivalent of session.registry.criteria.equivalenceClosure(cid)) {
      if (!declaredSet.has(equivalent)) expanded.add(equivalent);
    }
  }
  const byStandard: string[] = [];
  for (const standard of session.registry.standards) {
    const prefix = `${standard.id}:`;
    const group: string[] = [];
    for (const id of expanded) {
      if (id.startsWith(prefix)) group.push(id);
    }
    group.sort();
    byStandard.push(...group);
  }
  return [...declared, ...byStandard];
}

export const listFindersTool: McpTool = {
  def: {
    name: "list_finders",
    description:
      "List all manual-review candidate finders — the structural counterpart to `list_rules` for the manual-review half of ra11y's coverage. Each entry carries `finderId` (the same ID surfaced as `review_candidates.prompts[*].finderId`), the WCAG criteria it surfaces candidates for (cross-standard via `equivalentTo`), the finder's `scope` (`node` runs per-AST-node, `document` runs once per file with the parsed AST), a one-line description, the `reviewPrompt` text the human reviewer answers, and spec references. Filter with `standard` to narrow to a single framework. Use this tool to audit the manual-review surface area before a sweep — finders are otherwise discoverable only by accident through whichever ones fire on a given scan.",
    inputSchema: {
      type: "object",
      properties: {
        standard: {
          type: "string",
          description: "Filter to finders that surface candidates for criteria in this standard.",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  handler(params, session) {
    const total = session.registry.finders.length;
    let finders = session.registry.finders;

    const standardFilter = strParam(params, "standard");
    if (standardFilter) {
      if (!session.registry.standards.some((s) => s.id === standardFilter)) {
        const known = session.registry.standards.map((s) => s.id).join(", ");
        return errorResult({
          code: "standard-not-found",
          message: `Unknown standard '${standardFilter}'. Loaded: ${known}.`,
          details: {
            requested: standardFilter,
            loaded: session.registry.standards.map((s) => s.id),
          },
          remediation:
            "Pass `standard` with one of the loaded IDs, or omit to list finders from every loaded standard.",
        });
      }
      const prefix = `${standardFilter}:`;
      finders = finders.filter((f) =>
        expandCriteria(f.criterionIds, session).some((c) => c.startsWith(prefix)),
      );
    }

    const finderEntries = finders.map((f) => ({
      finderId: f.id,
      criterionIds: [...expandCriteria(f.criterionIds, session)],
      scope: f.scope,
      description: f.docs.description,
      reviewPrompt: f.docs.reviewPrompt,
      references: [...f.docs.references],
    }));

    const meta: Record<string, unknown> = {
      findersTotal: total,
      findersMatched: finders.length,
      standardsLoaded: session.registry.standards.length,
      standards: session.registry.standards.map((s) => s.id),
    };
    const nextStep = buildNextStep(standardFilter, finders.length);
    return textResult({
      ...(standardFilter ? { filter: { standard: standardFilter } } : {}),
      matchedOf: { total, matched: finders.length },
      finders: finderEntries,
      meta,
      nextStep: nextStep.prose,
      nextStepStructured: nextStep.structured,
    });
  },
};
