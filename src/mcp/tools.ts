/**
 * MCP tool definitions — name, description, inputSchema, handler.
 *
 * `MCP_TOOLS` (exported below) is the canonical inventory consumed by
 * `tools/list`. Tools whose handlers fit in one file live here; larger
 * tools live in their own `tool-*.ts` module and are imported into the
 * `MCP_TOOLS` array.
 *
 * Every handler is a pure function over the scanner's output + session
 * state. No MCP-specific logic leaks into `src/engine/`.
 */

import { RULE_ALIASES, resolveRuleId } from "../engine/rule-aliases.ts";
import { buildListRulesNextStep } from "./list-rules-next-step.ts";
import { resolveActiveRules } from "./rules-evaluated.ts";
import type { McpSession } from "./session.ts";
import { applyFixTool } from "./tool-apply-fix.ts";
import { attestTool } from "./tool-attest.ts";
import { auditTool } from "./tool-audit.ts";
import { baselineTool } from "./tool-baseline.ts";
import { bootstrapTool } from "./tool-bootstrap.ts";
import { checklistTool } from "./tool-checklist.ts";
import { conformanceStatementTool } from "./tool-conformance-statement.ts";
import { coverageTool } from "./tool-coverage.ts";
import { detectNativeWrappersTool } from "./tool-detect-wrappers.ts";
import { draftVpatNarrativeTool } from "./tool-draft-vpat-narrative.ts";
import { explainStandardTool } from "./tool-explain-standard.ts";
import { listAttestationsTool } from "./tool-list-attestations.ts";
import { listSuppressionsTool } from "./tool-list-suppressions.ts";
import { proposeBaselineTool } from "./tool-propose-baseline.ts";
import { proposeConfigTool } from "./tool-propose-config.ts";
import { reviewCandidatesTool } from "./tool-review-candidates.ts";
import { scanTool } from "./tool-scan.ts";
import { scanDiffTool } from "./tool-scan-diff.ts";
import { scanFileTool } from "./tool-scan-file.ts";
import { scanProcessTool } from "./tool-scan-process.ts";
import { scanProjectTool } from "./tool-scan-project.ts";
import { suggestFixTool } from "./tool-suggest-fix.ts";
import { suppressTool } from "./tool-suppress.ts";
import { verdictCandidateTool } from "./tool-verdict-candidate.ts";
import { vpatTool } from "./tool-vpat.ts";
import { wrapperIntrospectTool } from "./tool-wrapper-introspect.ts";
import {
  buildConfigureOpts,
  errorResult,
  findRule,
  type McpTool,
  strParam,
  textResult,
} from "./tools-helpers.ts";

export type { McpTool, McpToolDef, McpToolResult } from "./tools-helpers.ts";

// ─── Tool: explain_rule ─────────────────────────────────────────────────────

/**
 * Expand a rule's declared `satisfies` list across every loaded standard via
 * the criteria registry's reciprocal `equivalentTo` index (CLAUDE.md §6, the
 * same index the scanner uses when a finding's per-criterion array crosses
 * standards). Direct declarations come first in their original source order;
 * equivalent criteria follow, grouped by loaded-standard order so the shape
 * stays deterministic across calls. Keeps parity with `scan_file` findings —
 * a rule declared as `["wcag22:1.1.1", "wcag21:1.1.1"]` must surface its
 * `section508:` and `en301549:` equivalents here for agents auditing those
 * frameworks without cross-reading rule metadata against the standards
 * registry.
 */
function expandSatisfies(declared: readonly string[], session: McpSession): readonly string[] {
  const declaredSet = new Set(declared);
  const expanded = new Set<string>();
  for (const critId of declared) {
    for (const equivalent of session.registry.criteria.equivalenceClosure(critId)) {
      if (!declaredSet.has(equivalent)) expanded.add(equivalent);
    }
  }
  // Group added equivalents by loaded-standard order so, e.g., section508
  // entries land before en301549 entries regardless of the reciprocal
  // traversal order.
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

const explainRuleTool: McpTool = {
  def: {
    name: "explain_rule",
    description:
      "Get full details for a rule — description, rationale, normative WCAG quote, good/bad examples, and spec references. Use when a finding needs context. `satisfies` is the full cross-standard set (declared criteria first, then equivalents from every loaded standard via the `equivalentTo` reciprocal index) so agents auditing Section 508 or EN 301 549 can see rule coverage without cross-reading the standards registry.",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: "Rule ID (e.g. contrast/minimum)." },
      },
      required: ["ruleId"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  handler(params, session) {
    const ruleId = strParam(params, "ruleId");
    if (!ruleId) {
      return errorResult({
        code: "missing-required-param",
        message: "ruleId is required.",
        details: { param: "ruleId" },
      });
    }
    const rule = findRule(ruleId, session);
    if (!rule) {
      return errorResult({
        code: "rule-not-found",
        message: `Rule '${ruleId}' not found. Use list_rules to see available rules.`,
        details: { requested: ruleId },
        remediation: "Call `list_rules` to discover valid rule IDs.",
      });
    }

    return textResult({
      id: rule.id,
      severity: rule.severity,
      satisfies: expandSatisfies(rule.satisfies, session),
      description: rule.docs.description,
      rationale: rule.docs.rationale,
      ...(rule.docs.normativeQuote ? { normativeQuote: rule.docs.normativeQuote } : {}),
      goodExample: rule.docs.goodExample,
      badExample: rule.docs.badExample,
      references: [...rule.docs.references],
      // Present-when-meaningful: rules that haven't declared their FP/limit
      // patterns omit these fields rather than emit `[]`. An agent reading
      // "no `knownFalsePositives` declared" treats it as "the rule author
      // hasn't audited" — distinct from `[]` which would read "audited and
      // none known". This affordance lets rule authors progressively
      // populate the fields without forcing every existing rule to declare
      // an empty array. Doctrine: `explain_rule` lying about behavior
      // mis-calibrates the agent's dismissal logic; surfacing declared FPs
      // / limits up front lets the agent triage faster
      // (`docs/kb/architecture/ai-first-consumer.md` "Surface, don't
      // suppress" + the heuristic-mislabeling cluster).
      ...(rule.docs.knownFalsePositives !== undefined
        ? { knownFalsePositives: [...rule.docs.knownFalsePositives] }
        : {}),
      ...(rule.docs.knownLimitations !== undefined
        ? { knownLimitations: [...rule.docs.knownLimitations] }
        : {}),
    });
  },
};

// ─── Tool: list_rules ───────────────────────────────────────────────────────

const listRulesTool: McpTool = {
  def: {
    name: "list_rules",
    description:
      "List all available accessibility rules with their ID, severity, and what criteria they satisfy. Call once to understand what ra11y checks. Each rule's `satisfies` is the full cross-standard set — declared criteria first, then equivalents from every loaded standard via the `equivalentTo` reciprocal index — so adjacent same-family rules report the same shape regardless of how many standards their authors hand-listed.",
    inputSchema: {
      type: "object",
      properties: {
        standard: {
          type: "string",
          description: "Filter to rules that satisfy criteria in this standard.",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  handler(params, session) {
    const total = session.registry.rules.length;
    let rules = session.registry.rules;

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
            "Pass `standard` with one of the loaded IDs, or omit to list rules from every loaded standard.",
        });
      }
      // V1-LIST-RULES-SATISFIES-INCONSISTENT-ACROSS-FAMILY: filter on
      // the equivalentTo-resolved set, not the rule's hand-curated
      // `satisfies` array. Same-family rules currently declare
      // different shapes (`semantics/table-caption-missing` lists all
      // 4 standards, `semantics/table-headers` lists only 2) and a
      // raw-prefix filter on `section508` would drop `table-headers`
      // even though it satisfies `section508:1.3.1` via the
      // reciprocal equivalentTo index. Expanding the declared set
      // through `equivalenceClosure` collapses the inconsistency at
      // display time without forcing every rule author to re-declare
      // the same cross-standard fan-out (CLAUDE.md §6: thin standards
      // get coverage for free via equivalence).
      const prefix = `${standardFilter}:`;
      rules = rules.filter((r) =>
        expandSatisfies(r.satisfies, session).some((s) => s.startsWith(prefix)),
      );
    }

    // V1-INFRA-RULE-ID-ALIAS-TABLE: surface active rule-ID aliases as
    // additional entries with `deprecated: true` + `replacedBy` so
    // agents enumerating the catalog see both the old and new IDs
    // without a separate `explain_rule` call. Each alias points at its
    // `to` target's metadata (description, severity, satisfies) so the
    // old entry stays navigable — the user may already have
    // `keyboard/handler-missing` in their pragmas and needs to know it
    // still works. The standard filter and the displayed `satisfies`
    // both resolve through `expandSatisfies` so deprecated aliases
    // share the same equivalentTo-resolved shape as their canonical
    // targets.
    const aliasEntries = RULE_ALIASES.flatMap((alias) => {
      const target = session.registry.findRule(alias.to);
      if (target === undefined) return [];
      const resolved = expandSatisfies(target.satisfies, session);
      if (standardFilter && !resolved.some((s) => s.startsWith(`${standardFilter}:`))) {
        return [];
      }
      return [
        {
          id: alias.from,
          description: target.docs.description,
          severity: target.severity,
          satisfies: [...resolved],
          deprecated: true as const,
          replacedBy: alias.to,
          deprecatedSince: alias.deprecatedSince,
          removeIn: alias.removeIn,
        },
      ];
    });
    const ruleEntries = rules.map((r) => ({
      id: r.id,
      description: r.docs.description,
      severity: r.severity,
      satisfies: [...expandSatisfies(r.satisfies, session)],
    }));

    // Envelope parity with the other onboarding tools (propose_config,
    // propose_baseline, list_suppressions, detect_native_wrappers):
    // `meta` carries deterministic scan-confidence telemetry, `nextStep`
    // prose + `nextStepStructured` route the agent to the canonical
    // follow-up call. No metaMode / meta-cache here: list_rules is a
    // pure enumeration of the built-in registry — no scan, no cwd, no
    // config load — so there's no delta to collapse across repeat
    // calls. The counts + standards list are the honest signal the
    // agent uses to cross-check that the filter resolved as expected
    // (CLAUDE.md §1 "Verbose meta is signal, not clutter"). `matchedOf`
    // counts canonical rules only — aliases are deprecated pointers,
    // not independent evaluation targets; conflating them would inflate
    // the rule-count headline the agent budgets against (CLAUDE.md §1
    // "Composite headline counts are dishonest").
    const meta: Record<string, unknown> = {
      rulesTotal: total,
      rulesMatched: rules.length,
      standardsLoaded: session.registry.standards.length,
      standards: session.registry.standards.map((s) => s.id),
    };
    const nextStep = buildListRulesNextStep(standardFilter, rules.length);
    return textResult({
      // Echo the applied filter only when non-empty (present-when-meaningful);
      // always emit matchedOf so callers can tell a no-op filter (matched === total)
      // apart from a filter that actually narrowed the list.
      ...(standardFilter ? { filter: { standard: standardFilter } } : {}),
      matchedOf: { total, matched: rules.length },
      rules: ruleEntries,
      // Deprecated aliases live in a separate labeled bucket: they aren't
      // independent evaluation targets, and inflating `rules.length` with
      // them would force `rules.length !== matchedOf.matched` and turn the
      // per-bucket signal into a composite. Present-when-meaningful: omit
      // when no aliases survived the standard filter.
      ...(aliasEntries.length > 0 ? { deprecatedAliases: aliasEntries } : {}),
      meta,
      nextStep: nextStep.prose,
      nextStepStructured: nextStep.structured,
    });
  },
};

// ─── Tool: sessionConfigure ─────────────────────────────────────────────────

const sessionConfigureTool: McpTool = {
  def: {
    name: "sessionConfigure",
    description:
      'Set EPHEMERAL session-scoped defaults — standard, level, excludes, per-rule severity, native-wrapper components — so subsequent tool calls on this MCP connection don\'t repeat these parameters. State lives in the session only; nothing is written to disk, and a fresh connection starts clean.\n\nFor durable, committed configuration, drop a `ra11y.config.ts` at the project root:\n\n  export default {\n    nativeWrappers: ["Button", "ActionButton"],\n    rules: { "media/alt-text-missing": "warning" },\n    exclude: ["packages/legacy/**"],\n  };\n\nThe scan response surfaces `meta.configSource` (path of the loaded file, or null). If `configSource` is null, make sure you pass `cwd` so the loader walks up from your project root, not the MCP server\'s spawn directory; the `no_config_found` warning fires on the response when the walk hit a real Node project root without a `ra11y.config.*`.\n\nPass `cwd` alongside `nativeWrappers` to anchor the wrappers to a specific project root. Session state is connection-wide, so a later `scan_project` / `list_suppressions` call against a different `cwd` will still see the wrappers — but the response will carry a `session_wrappers_configured_for_different_cwd` warning so an agent that switches targets knows the configured wrappers may not match the new codebase.',
    inputSchema: {
      type: "object",
      properties: {
        standard: { type: "string", description: "Default standard ID (e.g. wcag22)." },
        level: { type: "string", enum: ["A", "AA", "AAA"], description: "Default level." },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "Glob patterns to exclude from scanning.",
        },
        rules: {
          type: "object",
          description:
            "Per-rule severity overrides. Values: 'error', 'warning', 'info', or 'off'. Example: {\"keyboard/handler-missing\": \"off\"}.",
          additionalProperties: { type: "string", enum: ["error", "warning", "info", "off"] },
        },
        nativeWrappers: {
          oneOf: [
            {
              type: "array",
              items: { type: "string" },
            },
            {
              type: "object",
              additionalProperties: { type: "string" },
            },
          ],
          description:
            'PascalCase components you\'ve verified wrap a native interactive element (<button>, <a>, etc.). Two accepted shapes:\n\n  • Flat names array — `["Button", "ActionButton", "IconButton"]`. Info-level keyboard/handler-missing notes on these components are suppressed; wrapper-opt-in rules (`media/alt-text-missing`, `navigation/link-descriptive-text`, `forms/labels-required`) do NOT pick them up because the native element target is unknown.\n  • Object map — `{ Button: "button", ActionButton: "button", RouterLink: "a", Avatar: "img" }`. In addition to suppression, wrapper-opt-in rules treat these components as the mapped native element and fire/pass accordingly. Surfaces on the response as `activeNativeWrapperElements`.\n\nAdditive across calls: per-key merge on the object form (later entries refine prior ones for the same wrapper); union on the array form.',
        },
        cwd: {
          type: "string",
          description:
            "Absolute path of the project the wrappers apply to. Recorded as the session's wrapper anchor on the first call that registers wrappers. Later scans against a different resolved root emit `session_wrappers_configured_for_different_cwd` in `warnings` so cross-cwd state is visible to the agent. Defaults to the MCP server's spawn directory when omitted — pass this explicitly alongside `nativeWrappers` to scope honestly.",
        },
        allowWrite: {
          type: "boolean",
          description:
            "Opt-in gate for tools that mutate user source (`apply_fix`). Defaults to false: no ra11y MCP tool will write to disk until the host flips this to true. Flip it back to false to re-gate after a batch of fixes. Read-only tools ignore this flag.",
        },
      },
    },
    annotations: { idempotentHint: true },
  },
  handler(params, session) {
    const parsed = buildConfigureOpts(params);
    if (!parsed.ok) return errorResult(parsed.error);
    const config = session.configure(parsed.opts);
    // Resolve `ruleCount` through the same SSOT every scan-family tool
    // uses for `meta.rulesEvaluated.loaded` so the two cross-surface
    // counters can't drift. Before V1-SESSION-RULECOUNT-VS-SCAN-
    // RULESLOADED, this filtered the registry by "rule satisfies a
    // criterion under the configured standard," which excluded rules
    // like `parsing/invalid-id-shape` (cites `wcag21:4.1.1` only —
    // WCAG 2.2 dropped SC 4.1.1) and produced an off-by-one against
    // `scan_project.meta.rulesEvaluated.loaded` on the same session.
    // Per `docs/kb/architecture/ai-first-consumer.md` ("cross-surface
    // counts that name the same concept must agree"), both counters
    // now resolve through `resolveActiveRules`. The standard/level
    // filter is applied later inside `runScan`; `ruleCount` is the
    // registry ceiling, matching `loaded`'s contract in
    // `rules-evaluated.ts`.
    const ruleCount = resolveActiveRules(session).length;

    // V1-SESSION-CONFIGURE-ECHO-STATE: echo the merged session state so
    // a caller can verify what landed. Before this, the response only
    // reported standard/level/ruleCount/allowWrite — a wrong rule ID in
    // the input was a silent no-op (the typo never appeared in any
    // surface so the agent could not discover it). Optional fields are
    // present-when-meaningful per AI-first doctrine; empty maps/arrays
    // are conditional-spread off the response.
    // Aliases resolve to their canonical ID before the registry
    // lookup so a deprecated-but-still-supported ID (e.g.
    // `navigation/href-placeholder` → `navigation/href-javascript-scheme`)
    // is not falsely flagged as unknown. The dedicated
    // `deprecated_rule_id:<old>:<new>` warning surface for aliased IDs
    // fires from the scan-family tools at apply-time; the unknown
    // check here is only the silent-no-op guard the backlog item
    // names.
    const knownRuleIds = new Set(session.registry.rules.map((r) => r.id));
    const unknownRuleIds = Object.keys(config.rules)
      .filter((id) => !knownRuleIds.has(resolveRuleId(id).resolved))
      .sort();
    const warnings: string[] = [];
    const warningsDetails: Record<string, unknown> = {};
    if (unknownRuleIds.length > 0) {
      // Surface-don't-suppress: a rule ID that doesn't match any
      // registry entry was almost certainly a typo or a stale
      // post-rename ID without an alias. Without this code, the
      // setting silently does nothing — the agent has no signal to
      // re-issue with a corrected ID.
      warnings.push("unknown_rule_ids");
      warningsDetails["unknown_rule_ids"] = { ruleIds: unknownRuleIds };
    }
    if (config.allowWrite) {
      // The `apply_fix` write gate is open. Surface it as an additive
      // signal on every configure response so the agent can branch on
      // the gate state without inferring it from a separate field
      // read. Defaults to false; a host has explicitly opted in (now
      // or on a previous call this connection).
      warnings.push("session_allow_write_enabled");
    }
    return textResult({
      active: {
        standard: config.standard,
        level: config.level,
        ruleCount,
        allowWrite: config.allowWrite,
        ...(config.exclude.length > 0 ? { exclude: [...config.exclude] } : {}),
        ...(Object.keys(config.rules).length > 0 ? { rules: { ...config.rules } } : {}),
        ...(config.nativeWrappers.length > 0 ? { nativeWrappers: [...config.nativeWrappers] } : {}),
        ...(Object.keys(config.nativeWrapperElements).length > 0
          ? { nativeWrapperElements: { ...config.nativeWrapperElements } }
          : {}),
        ...(config.nativeWrappersConfiguredCwd === undefined
          ? {}
          : { cwd: config.nativeWrappersConfiguredCwd }),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(Object.keys(warningsDetails).length > 0 ? { warningsDetails } : {}),
    });
  },
};

// ─── Export ─────────────────────────────────────────────────────────────────

export const MCP_TOOLS: readonly McpTool[] = [
  scanTool,
  scanProjectTool,
  scanFileTool,
  scanDiffTool,
  scanProcessTool,
  detectNativeWrappersTool,
  wrapperIntrospectTool,
  explainRuleTool,
  explainStandardTool,
  suggestFixTool,
  applyFixTool,
  coverageTool,
  checklistTool,
  conformanceStatementTool,
  reviewCandidatesTool,
  verdictCandidateTool,
  draftVpatNarrativeTool,
  auditTool,
  baselineTool,
  bootstrapTool,
  listRulesTool,
  listSuppressionsTool,
  suppressTool,
  attestTool,
  listAttestationsTool,
  vpatTool,
  proposeConfigTool,
  proposeBaselineTool,
  sessionConfigureTool,
];
