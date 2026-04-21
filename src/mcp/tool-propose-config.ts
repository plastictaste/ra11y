/**
 * The `propose_config` MCP tool.
 *
 * Synthesizes a ready-to-commit `ra11y.config.ts` from deterministic
 * scan state — the confirmed native-wrapper candidates, the paths the
 * scanner already labeled as build artifacts, and the top-fired rule
 * IDs from the current scan. No LLM; a pure function over scan output
 * the agent could compute itself, centralized here so every agent
 * lands on the same config shape.
 *
 * Shape contract (AI-first doctrine, `docs/kb/architecture/ai-first-consumer.md`):
 *
 *   - `suggestedConfig: string` — the full `ra11y.config.ts` contents,
 *     including the `import { defineConfig }` line and trailing
 *     newline. The field is ALWAYS populated (a minimal
 *     `defineConfig({})` is still honest output when a scan is
 *     clean) — see the rationale below.
 *   - `meta` carries scan-confidence telemetry (the canonical
 *     `scanned` envelope — `{ mode: "project", root }` for this tool,
 *     `configSource`, `filesScanned`, `activeNativeWrappers`,
 *     `rulesEvaluated`, plus the counts of items folded into the
 *     proposal) so an agent can tell whether the proposal had teeth
 *     without a separate `scan_project` round-trip.
 *   - The proposal NEVER takes effect on its own. It's a string the
 *     agent pastes into `ra11y.config.ts`; no file is written. The
 *     `suppress` / `apply_fix` tools are the mutating surface; this
 *     one stays read-only.
 *
 * Doctrine invariants folded into the shape:
 *
 *   - Surface, don't suppress: the commented `rules` stub names the
 *     three most-fired rules with their default level so the author
 *     has a paste-ready place to TUNE (not auto-hide). The block is
 *     commented out so proposing it doesn't change scanner behavior
 *     — the agent chooses which, if any, to uncomment.
 *   - Composite headline counts are dishonest: three distinct meta
 *     counters (`wrappersIncluded`, `buildArtifactsIncluded`,
 *     `topRulesIncluded`) instead of one "itemsProposed" summary.
 *     Each names one kind of thing.
 *   - Ambiguous field shapes are dishonest: the `suggestedConfig`
 *     string always carries a syntactically-complete
 *     `defineConfig({...});` body, never an empty string. When the
 *     scan is clean, a one-liner with a comment explaining why
 *     ("No overrides needed — scan was clean.") IS the honest
 *     output; an empty string would read as "tool never ran."
 *   - No heuristic suppression: every entry in the proposal is
 *     deterministic from the scan. Wrappers come from the same
 *     detector `detect_native_wrappers` / `scan_project` share;
 *     excludes come from the `collectBuildArtifacts` labeller; top-3
 *     rules are raw per-rule tallies with ties broken by rule ID
 *     ascending.
 *   - Foreign-ecosystem detection: the project root is probed for
 *     canonical package-manifest markers (`Gemfile`, `pyproject.toml`,
 *     `go.mod`, `Cargo.toml`). When one resolves and `package.json`
 *     does NOT, the response carries a top-level
 *     `warnings: ["foreign_ecosystem_detected: <language>"]` code and
 *     the `nextStep` hint names an alternative `npx @ra11y/core scan`
 *     invocation the agent can offer in place of committing a Node
 *     config. Never suppresses the config — same "surface, don't
 *     suppress" reasoning as every other code-path in this tool.
 */

import { existsSync } from "node:fs";
import type { ParsedFile } from "../engine/scanner.ts";
import { runScan } from "../engine/scanner.ts";
import { gitRoot } from "../utils/git.ts";
import { collectBuildArtifacts } from "./build-artifacts.ts";
import { buildNativeWrappersBody } from "./config-snippet.ts";
import { classifyWrapperCandidates, collectWrapperCandidates } from "./detect-wrappers-core.ts";
import { detectForeignEcosystem, foreignEcosystemWarning } from "./ecosystem-detect.ts";
import { scannedProject } from "./scanned-envelope.ts";
import {
  applyRuleSettings,
  errorResult,
  type McpTool,
  parseFiles,
  resolveStandards,
  strParam,
  textResult,
} from "./tools-helpers.ts";

/** Indent width for the emitted config body. Matches project Biome style. */
const INDENT = "  ";

/** How many top-fired rules land in the commented stub. */
const TOP_RULES_COUNT = 3;

export const proposeConfigTool: McpTool = {
  def: {
    name: "propose_config",
    description:
      "Synthesize a ready-to-commit `ra11y.config.ts` from the current scan state. Populates `nativeWrappers` from confirmed auto-detected wrappers, `exclude` from paths the scanner labels as build artifacts, and a commented-out `rules` stub listing the three most-fired rules with their default severity so the author has a paste-ready place to tune. Deterministic — no LLM, no heuristics; every entry derives from the same primitives `scan_project` and `detect_native_wrappers` expose. Returns the config as a string; does NOT write to disk.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Project root. Defaults to the git root of the MCP server's spawn directory, then process.cwd().",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
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

    const projectConfig = await session.loadProjectConfig(root);
    const files = await parseFiles([root], session, root);
    const effective = session.effectiveRules(projectConfig);
    const activeRules = applyRuleSettings(session.registry.rules, effective);

    const confirmedWrappers = deriveConfirmedWrappers(files);
    const buildArtifacts = collectBuildArtifacts(files);
    const topRules = deriveTopRules(files, session);
    // Surface, don't suppress: foreign-ecosystem detection NEVER
    // withholds the config string — the agent may still want to add a
    // Node toolchain alongside their Ruby / Python / Go / Rust
    // project. The warning + nextStep hint carry the context so the
    // paste decision is informed. See
    // `docs/kb/architecture/ai-first-consumer.md` "Surface, don't
    // suppress."
    const foreignWarning = foreignEcosystemWarning(root);
    const foreignEcosystem = detectForeignEcosystem(root);

    const suggestedConfig = buildConfigString({
      wrappers: confirmedWrappers,
      excludes: buildArtifacts,
      topRules,
    });

    return textResult({
      suggestedConfig,
      meta: {
        scanned: scannedProject(root),
        configSource: projectConfig.sourcePath,
        filesScanned: files.length,
        rulesEvaluated: activeRules.length,
        // Three distinct counts instead of one composite — each names
        // one kind of thing folded into the proposal (CLAUDE.md §1
        // "Composite headline counts are dishonest"). An agent sizing
        // the proposal can see which pieces carried weight.
        wrappersIncluded: confirmedWrappers.length,
        buildArtifactsIncluded: buildArtifacts.length,
        topRulesIncluded: topRules.length,
      },
      nextStep: buildNextStep({
        wrappers: confirmedWrappers,
        excludes: buildArtifacts,
        topRules,
        configSource: projectConfig.sourcePath,
        foreignEcosystem,
      }),
      // Top-level warnings channel — conditional-spread so clean scans
      // in Node-toolchain repos omit the field entirely (CLAUDE.md §1
      // "Ambiguous field shapes are dishonest" — never emit
      // `warnings: []`). The code format
      // `foreign_ecosystem_detected: <language>` carries the ecosystem
      // tag inline so agents branching on bare `warnings[]` can
      // discriminate without a paired `warningsDetails` lookup.
      ...(foreignWarning === null ? {} : { warnings: [foreignWarning] }),
    });
  },
};

/**
 * Runs the wrapper detector + one-hop probe over the parsed file set
 * and returns only the `confirmed` names — components whose defining
 * file's JSX root is a native interactive element. This matches the
 * same allowlist `scan_project` uses when `autoDetectWrappers: true`,
 * so the proposed config produces identical behavior on the next
 * scan.
 *
 * `assumed` names are NOT included: per CLAUDE.md §1 "No heuristic
 * suppression," a name the probe couldn't confirm must not be
 * silently silenced. The agent can add it to the config manually
 * after reading the source — proposing it here would bake a guess
 * into committed config.
 */
function deriveConfirmedWrappers(files: readonly ParsedFile[]): readonly string[] {
  const candidates = collectWrapperCandidates(files);
  const names = candidates.map((c) => c.component);
  const { confirmed } = classifyWrapperCandidates(files, names);
  return confirmed;
}

interface TopRuleEntry {
  readonly ruleId: string;
  readonly severity: string;
  readonly count: number;
}

/**
 * Tallies findings per rule ID and returns the top-`TOP_RULES_COUNT`
 * rules by total count, with ties broken by rule ID ascending (the
 * stable tiebreak the spec asks for). Each entry carries the rule's
 * DEFAULT severity — the author's paste-ready place to override it
 * via the commented stub — not the effective severity after session
 * or project-config overrides.
 *
 * Runs the scanner directly rather than relying on an outer scan
 * result so this tool is self-contained — callers don't need to pipe
 * in findings they'd otherwise throw away. The scanner is pure over
 * the parsed files, so the duplicate pass adds scan-time latency but
 * no semantic drift.
 */
function deriveTopRules(
  files: readonly ParsedFile[],
  session: import("./session.ts").McpSession,
): readonly TopRuleEntry[] {
  if (files.length === 0) return [];
  const { result } = runScan({
    standards: session.registry.standards,
    rules: session.registry.rules,
    enabled: resolveStandards(undefined, session),
    files,
    level: session.config.level,
  });
  const counts = new Map<string, number>();
  for (const v of result.violations) {
    counts.set(v.ruleId, (counts.get(v.ruleId) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(([aId, aCount], [bId, bCount]) => {
    if (bCount !== aCount) return bCount - aCount;
    return aId.localeCompare(bId);
  });
  const out: TopRuleEntry[] = [];
  for (const [ruleId, count] of ranked.slice(0, TOP_RULES_COUNT)) {
    const rule = session.registry.findRule(ruleId);
    if (!rule) continue;
    out.push({ ruleId, severity: rule.severity, count });
  }
  return out;
}

/**
 * Composes the full `ra11y.config.ts` string. Four cases, each
 * deterministic from the inputs:
 *
 *   1. Empty scan (no wrappers, no artifacts, no findings) → one-line
 *      `defineConfig({})` with a comment explaining why.
 *   2. Wrappers only → `defineConfig({ nativeWrappers: ... })`.
 *   3. Wrappers + artifacts → above plus `exclude: [...]`.
 *   4. Wrappers + artifacts + findings → above plus a commented-out
 *      `rules: { ... }` block listing the top-3 rules with their
 *      default severity.
 *
 * Every case produces a syntactically-complete file — the output is
 * paste-ready with no post-processing, including the `defineConfig`
 * import and a trailing newline.
 */
function buildConfigString(args: {
  readonly wrappers: readonly string[];
  readonly excludes: readonly string[];
  readonly topRules: readonly TopRuleEntry[];
}): string {
  const { wrappers, excludes, topRules } = args;

  // Case 1: nothing to propose. The honest shape is a minimal
  // defineConfig({}) with a comment naming why — an empty string (or
  // a config file that omits the defineConfig wrapper) would read as
  // "tool never ran." Per §1 "Zero-output success is ambiguous
  // failure."
  if (wrappers.length === 0 && excludes.length === 0 && topRules.length === 0) {
    return [
      `import { defineConfig } from "@ra11y/core";`,
      "",
      "// No overrides needed — scan was clean.",
      "export default defineConfig({});",
      "",
    ].join("\n");
  }

  const bodyLines: string[] = [];

  // nativeWrappers: delegated to the shared body builder so the shape
  // matches `detect_native_wrappers`'s `suggestedConfigSnippet` (same
  // sort order, same indentation, same array-vs-object selection).
  const wrapperBody = buildNativeWrappersBody(wrappers.map((component) => ({ component })));
  for (const line of wrapperBody) {
    bodyLines.push(`${INDENT}${line}`);
  }

  // exclude: straight array of paths in scan-discovered order (same
  // order the `scannedBuildArtifacts` meta field surfaces).
  if (excludes.length > 0) {
    bodyLines.push(`${INDENT}exclude: [`);
    for (const path of excludes) {
      bodyLines.push(`${INDENT}${INDENT}${JSON.stringify(path)},`);
    }
    bodyLines.push(`${INDENT}],`);
  }

  // rules: commented out so the proposal doesn't change behavior on
  // paste. The author uncomments after deciding which (if any) to
  // tune. Per CLAUDE.md §1 "Surface, don't suppress" — we don't ship
  // an auto-downgrade; we ship a pointer.
  if (topRules.length > 0) {
    bodyLines.push("");
    bodyLines.push(`${INDENT}// Top-fired rules on this scan. Uncomment + adjust the severity`);
    bodyLines.push(`${INDENT}// ("error" | "warning" | "info" | "off") to tune or suppress.`);
    bodyLines.push(`${INDENT}// rules: {`);
    for (const entry of topRules) {
      bodyLines.push(
        `${INDENT}//   ${JSON.stringify(entry.ruleId)}: ${JSON.stringify(entry.severity)}, // ${entry.count} finding${entry.count === 1 ? "" : "s"}`,
      );
    }
    bodyLines.push(`${INDENT}// },`);
  }

  return [
    `import { defineConfig } from "@ra11y/core";`,
    "",
    "export default defineConfig({",
    ...bodyLines,
    "});",
    "",
  ].join("\n");
}

/**
 * Points the agent at the next productive call. Two cases:
 *   - Clean scan → acknowledge and route to `scan_project` if the
 *     agent wants to verify coverage with `verboseMeta: true`.
 *   - Non-empty proposal → name the three buckets in the proposal so
 *     the agent sees the shape of what it's about to paste.
 *
 * Mentions `configSource` so agents that ALREADY have a config at the
 * project root don't blindly overwrite it — they should diff the
 * proposal against the existing file first.
 *
 * When `foreignEcosystem` is set, the hint appends an alternative
 * invocation — `npx @ra11y/core scan` — that runs the scanner without
 * committing a TypeScript config into a non-Node repo. Surfaced as
 * additive context, not a redirect: the caller may still want to paste
 * the config, but the alternative lets them opt out of adding a Node
 * toolchain if their project doesn't already have one. See
 * `docs/kb/architecture/ai-first-consumer.md` "Surface, don't suppress."
 */
function buildNextStep(args: {
  readonly wrappers: readonly string[];
  readonly excludes: readonly string[];
  readonly topRules: readonly TopRuleEntry[];
  readonly configSource: string | null;
  readonly foreignEcosystem: string | null;
}): string {
  const { wrappers, excludes, topRules, configSource, foreignEcosystem } = args;
  const summary: string[] = [];
  if (wrappers.length > 0) {
    summary.push(`${wrappers.length} confirmed wrapper${wrappers.length === 1 ? "" : "s"}`);
  }
  if (excludes.length > 0) {
    summary.push(`${excludes.length} build-artifact path${excludes.length === 1 ? "" : "s"}`);
  }
  if (topRules.length > 0) {
    summary.push(
      `${topRules.length} top-fired rule${topRules.length === 1 ? "" : "s"} in a commented stub`,
    );
  }
  const existingNote =
    configSource === null
      ? ""
      : ` A ra11y.config already exists at ${configSource} — diff the proposal against it before replacing.`;
  // Foreign-ecosystem alternative: non-committing invocation so agents
  // onboarding a Rails / Django / Go / Cargo project have a one-shot
  // scan command that doesn't add a Node toolchain to the repo.
  const foreignNote =
    foreignEcosystem === null
      ? ""
      : ` This project has a ${foreignEcosystem} toolchain and no package.json — if the consumer would rather not commit a Node config, run \`npx @ra11y/core scan\` ad-hoc instead of pasting \`suggestedConfig\` into ra11y.config.ts.`;
  if (summary.length === 0) {
    return `Scan was clean — proposal is a minimal defineConfig({}) placeholder.${existingNote}${foreignNote}`;
  }
  return `Proposal includes ${summary.join(", ")}. Paste \`suggestedConfig\` into ra11y.config.ts at the project root.${existingNote}${foreignNote}`;
}
