/**
 * The `propose_baseline` MCP tool.
 *
 * Reads current scan findings and emits a *proposed* baseline — one
 * entry per violation, each tagged with a machine-readable `reason`
 * code that groups entries an agent can triage by category. The tool
 * is strictly read-only: it never writes `.ra11y-baseline.json`. The
 * agent reviews the proposal, decides which categories to
 * grandfather, then calls the mutating `baseline` tool (mode: "create")
 * to actually persist.
 *
 * Shape contract (AI-first doctrine, `docs/kb/architecture/ai-first-consumer.md`):
 *
 *   - `proposed: Array<{filePath, ruleId, findingGroupId, reason, rationaleKey}>`
 *     — one entry per current cross-run-stable group, deterministic.
 *     Each entry reuses the line-drift-resilient `findingGroupId` so
 *     an agent can cross-reference against `scan_project` output, and
 *     so the entry persisted to `.ra11y-baseline.json` matches on
 *     subsequent runs even after surrounding code drift. (Per-emission
 *     addressability — what `suggest_fix` resolves against — lives on
 *     `findingId`, which is NOT the baseline key.) The per-entry
 *     `rationaleKey` is a short SHA-256 truncation pointing into the
 *     top-level `rationales` map (below).
 *   - `rationales: { [rationaleKey]: string }` — hoisted prose keyed by
 *     12-hex truncated SHA-256. Identical rationales across entries
 *     (the common `unclassified` case, where every entry would ship the
 *     same 128-char string) collapse to one key; the response shrinks
 *     from "one inline rationale per entry" to "one entry in `rationales`
 *     per distinct rationale." Matches the hoist pattern used by
 *     `referenceGuide.fixDescriptions[ruleId][hash]` so agents
 * recognize the short-hex-token format (-
 *     RATIONALE-DEDUP).
 *   - `counts: { wrapperUndetected, thirdPartyHtml, legacyRoute,
 *     designSystemInternal, unclassified }` — FIVE distinct headline
 *     counters, one per reason code. Per CLAUDE.md §1 "Composite
 *     headline counts are dishonest," we never sum them into a single
 *     `itemsProposed` number; the agent sizes per category.
 *   - `meta` carries the standard scan-confidence telemetry
 *     (`scanned.root`, `configSource`, `rulesEvaluated`, `filesScanned`)
 *     so the agent can cross-check against `scan_project` without a
 *     second round-trip.
 *   - `nextStep` prose + `nextStepStructured: { tool: "baseline", args:
 *     { mode: "create" } }` routes the agent to the mutating call that
 *     actually writes the file.
 *
 * Reason-code heuristics, each deterministic from the scan:
 *
 *   - `wrapper-undetected` — the finding fires on a PascalCase
 *     component whose name appears in the auto-detect `assumed` list
 *     (the one-hop AST probe considered the candidate but could not
 *     confirm a native interactive root). These are the findings most
 *     likely to be design-system false-positives the agent should
 *     verify by reading the component source.
 *   - `third-party-html` — the finding's file path contains
 *     `/node_modules/`, `/vendor/`, or `/.yarn/`, or the basename
 *     matches `*.min.{html,js,css}`. Canonical "not our code"
 *     locations; safe to grandfather without reading.
 *   - `legacy-route` — the finding's file path (relative to
 *     `scanned.root`) matches a caller-supplied `legacyRoutes` glob.
 *     NOT auto-classified — per CLAUDE.md §1 "No heuristic
 *     suppression," we never guess which routes are legacy from
 *     filename patterns; the caller declares them explicitly.
 *   - `design-system-internal` — the finding's file path matches a
 *     caller-supplied `designSystemPaths` glob. Same explicit-only
 *     contract as `legacy-route`.
 *   - `unclassified` — the default when no heuristic matches. This is
 *     the correct majority case: the agent reads the finding and
 *     decides whether to grandfather.
 *
 * Precedence (first match wins): legacy-route → design-system-internal
 * → third-party-html → wrapper-undetected → unclassified. User-declared
 * classifications beat path heuristics; deterministic path signals
 * beat component-name heuristics; fall through to unclassified.
 *
 * Doctrine invariants folded into the shape:
 *
 *   - Surface, don't suppress: every violation shows up in `proposed`,
 *     tagged with the reason code the agent uses to triage. No bucket
 *     is "suggested to skip"; no finding is dropped by the tool.
 *   - Composite headline counts are dishonest: five separate counters
 *     instead of one "itemsProposed" summary. Agents batch per
 *     category.
 *   - No heuristic suppression: `legacy-route` and
 *     `design-system-internal` require explicit input. We do NOT
 *     guess what's legacy by reading filenames — the caller is the
 *     authority.
 *   - Read-only: this tool never writes. The mutating surface is
 *     `baseline` (mode: "create").
 */

import { existsSync } from "node:fs";
import { runScan } from "../engine/scanner.ts";
import { gitRoot } from "../utils/git.ts";
import { compileGlobs } from "../utils/glob.ts";
import { sawProjectMarkerInWalk, shouldEmitNoConfigFound } from "./config-search-marker.ts";
import { classifyWrapperCandidates, collectWrapperCandidates } from "./detect-wrappers-core.ts";
import { requireStringArrayParam } from "./param-validators.ts";
import {
  buildProposedEntries,
  buildProposedNextStep,
  hoistRationales,
  tallyReasons,
} from "./propose-baseline-classify.ts";
import { buildRulesEvaluated } from "./rules-evaluated.ts";
import { scannedProject } from "./scanned-envelope.ts";
import {
  applyRuleSettings,
  errorResult,
  type McpTool,
  parseFiles,
  resolveStandards,
  type StructuredError,
  strArrayParam,
  strParam,
  textResult,
} from "./tools-helpers.ts";

export type { BaselineReason } from "./propose-baseline-classify.ts";

export const proposeBaselineTool: McpTool = {
  def: {
    name: "propose_baseline",
    description:
      'Read-only: propose a structured baseline from the current scan state without writing anything to disk. Each would-be baseline entry carries a machine-readable `reason` code (`wrapper-undetected` / `third-party-html` / `legacy-route` / `design-system-internal` / `unclassified`) plus a `rationaleKey` pointer into the response-level `rationales: { [key]: string }` map — identical rationale prose across entries collapses to one shared entry, so a 242-finding scan ships one `unclassified` rationale once rather than 242 times. Five distinct headline counters (one per reason) — never summed into a single "itemsProposed" number. Deterministic; no LLM; identical findings in, identical proposal out.\n\nUse `legacyRoutes` / `designSystemPaths` to tag findings in paths you (the agent) already know are legacy / design-system internals — glob patterns are matched against paths relative to `scanned.root`. Heuristic reason codes (`third-party-html`, `wrapper-undetected`) fire automatically from the scan state; per "no heuristic suppression" we deliberately do NOT guess which routes are legacy from filename alone.',
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Project root. Defaults to the git root of the MCP server's spawn directory, then process.cwd(). Controls discovery of ra11y.config.ts and the relative-path basis used for `legacyRoutes` / `designSystemPaths` glob matching.",
        },
        legacyRoutes: {
          type: "array",
          items: { type: "string" },
          description:
            'Glob patterns (gitignore-style, `**` supported) naming file paths the caller has already identified as legacy routes — findings on matching files get `reason: "legacy-route"` so the agent can batch-grandfather them. Paths are matched relative to `scanned.root`. Example: `["src/legacy/**", "app/old/**/*.html"]`. NOT auto-classified — per AI-first doctrine the caller is the authority on which routes are legacy.',
        },
        designSystemPaths: {
          type: "array",
          items: { type: "string" },
          description:
            'Glob patterns (gitignore-style, `**` supported) naming file paths the caller has already identified as design-system internals — findings on matching files get `reason: "design-system-internal"` so the agent can batch-grandfather them. Paths are matched relative to `scanned.root`. Example: `["packages/ui/src/**"]`. NOT auto-classified — per AI-first doctrine the caller is the authority on which paths are design-system internals.',
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    // Up-front type validation: a wrong-type
    // `legacyRoutes: "packages/legacy/**"` (single string) used to
    // silently degrade to no-classification, indistinguishable from "I
    // passed an empty array."
    const paramTypeError = validateProposeBaselineParamTypes(params);
    if (paramTypeError !== undefined) return errorResult(paramTypeError);
    const explicitCwd = strParam(params, "cwd");
    if (explicitCwd !== undefined && !existsSync(explicitCwd)) {
      return errorResult({
        code: "cwd-not-found",
        message: `Requested cwd does not exist on disk: ${explicitCwd}`,
        details: { cwd: explicitCwd },
        remediation:
          "Pass `cwd` as a path to an existing directory. Relative paths resolve against the MCP server's spawn directory.",
      });
    }
    const spawnCwd = process.cwd();
    const root = explicitCwd ?? gitRoot(spawnCwd) ?? spawnCwd;

    const legacyRoutes = strArrayParam(params, "legacyRoutes") ?? [];
    const designSystemPaths = strArrayParam(params, "designSystemPaths") ?? [];
    const legacyMatcher = compileGlobs(legacyRoutes);
    const designMatcher = compileGlobs(designSystemPaths);

    const projectConfig = await session.loadProjectConfig(root);
    const files = await parseFiles([root], session, root);
    const effective = session.effectiveRules(projectConfig);
    const activeRules = applyRuleSettings(session.registry.rules, effective);
    const standards = resolveStandards(undefined, session);

    // Run the wrapper probe over the parsed file set to derive the
    // `assumed` names — components the one-hop AST probe considered
    // but could NOT confirm as native-element wrappers. These are the
    // candidates an agent should verify by reading the defining
    // source; a finding on a call site of an assumed name gets the
    // `wrapper-undetected` reason code so the agent can batch-review
    // them first.
    const candidates = collectWrapperCandidates(files);
    const { assumed } = classifyWrapperCandidates(
      files,
      candidates.map((c) => c.component),
    );
    const assumedSet = new Set(assumed);

    const { result, perRuleCoverage } = runScan({
      standards: session.registry.standards,
      rules: activeRules,
      enabled: standards,
      files,
      level: session.config.level,
    });

    const rawProposed = buildProposedEntries({
      violations: result.violations,
      root,
      assumedWrappers: assumedSet,
      legacyMatcher,
      designMatcher,
    });

    // Dedupe by `findingGroupId` — first-seen wins, order preserved.
    // The `findingGroupId` is the cross-run-stable token baselines key
    // on (line-drift resilient); multiple `Violation` objects sharing
    // one group id represent the same baseline-level decision, not
    // separate ones. Emitting duplicates inflates `counts.unclassified`
    // and would persist dup entries to `.ra11y-baseline.json` if
    // `baseline mode:"create"` ran against this proposal. (Note: per-
    // emission `findingId` is now distinct for every emission per the
    // addressability invariant — using it for dedup here would defeat
    // the purpose; `findingGroupId` is the right axis.)
    const seen = new Set<string>();
    const dedupedRaw = rawProposed.filter((e) => {
      if (seen.has(e.findingGroupId)) return false;
      seen.add(e.findingGroupId);
      return true;
    });

    // Hoist per-entry `rationale` prose into a top-level `rationales`
    // map keyed by short SHA-256 — identical rationales across entries
    // (the common `unclassified` case: every entry shares the same
    // 128-char prose) collapse to one key. See `hoistRationales` header
    // for the rationale behind the shape.
    const { entries: proposed, rationales } = hoistRationales(dedupedRaw);
    const counts = tallyReasons(proposed);

    // Cross-surface count invariant
    // (`docs/kb/architecture/ai-first-consumer.md`): every project-rooted
    // tool that emits `meta.configSource` must surface the same
    // `no_config_found` + `searchedFrom` warning shape on the same
    // input. `propose_baseline` runs a real scan against the project
    // and the agent reads its meta to gate "is the proposal trustworthy
    // on this corpus?" — a missing config warning here forces the
    // agent into a second `scan_project` call to discover the same
    // bit. Mirror the gate.
    const configSearchSawProjectMarker =
      projectConfig.sourcePath === null ? sawProjectMarkerInWalk(root) : false;
    const noConfigFires = shouldEmitNoConfigFound({
      configSource: projectConfig.sourcePath,
      filesScanned: files.length,
      configSearchSawProjectMarker,
    });
    const warnings = noConfigFires ? (["no_config_found"] as const) : [];
    const warningsDetails = noConfigFires ? { no_config_found: { searchedFrom: root } } : undefined;

    return textResult({
      proposed,
      rationales,
      counts,
      meta: {
        scanned: scannedProject(root),
        configSource: projectConfig.sourcePath,
        filesScanned: files.length,
        rulesEvaluated: buildRulesEvaluated({
          loadedCount: activeRules.length,
          perRuleCoverage,
        }),
        standards: [...result.enabledStandards].sort(),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(warningsDetails === undefined ? {} : { warningsDetails }),
      nextStep: buildProposedNextStep(proposed.length, counts),
      nextStepStructured: { tool: "baseline", args: { mode: "create" } },
    });
  },
};

/**
 * Up-front type validation for the `propose_baseline` handler. Closes
 * the silent-drop class for `legacyRoutes` / `designSystemPaths` —
 * wrong-type inputs (single string instead of array) used to silently
 * degrade to no-classification, indistinguishable from "I passed an
 * empty array."
 */
function validateProposeBaselineParamTypes(
  params: Record<string, unknown>,
): StructuredError | undefined {
  const legacyRoutes = requireStringArrayParam(params, "legacyRoutes");
  if (!legacyRoutes.ok) return legacyRoutes.error;
  const designSystemPaths = requireStringArrayParam(params, "designSystemPaths");
  if (!designSystemPaths.ok) return designSystemPaths.error;
  return undefined;
}
