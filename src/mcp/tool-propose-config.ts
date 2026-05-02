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
import { relative } from "node:path";
import type { ParsedFile } from "../engine/scanner.ts";
import { runScan } from "../engine/scanner.ts";
import { gitRoot } from "../utils/git.ts";
import { collectBuildArtifacts, isDefiniteBuildArtifactClassification } from "./build-artifacts.ts";
import { sawProjectMarkerInWalk, shouldEmitNoConfigFound } from "./config-search-marker.ts";
import { buildNativeWrappersBody } from "./config-snippet.ts";
import { classifyWrapperCandidates, collectWrapperCandidates } from "./detect-wrappers-core.ts";
import { detectForeignEcosystem, foreignEcosystemWarning } from "./ecosystem-detect.ts";
import { buildRulesEvaluated } from "./rules-evaluated.ts";
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

/**
 * Minimum number of build-artifact files that must share a top-level
 * directory under the scan root before the emitted `exclude` list
 * collapses them to a single `<dir>/**` glob. Below the threshold the
 * individual relative paths are emitted verbatim — a 2-file `dist/`
 * directory is still specific enough that an unglobbed pair is clearer
 * than a `dist/**` wildcard. The field-report that motivated this cap
 * (website-templates repo, 301 emitted excludes) was dominated by a
 * single `dist/` subtree; three-file collapse matches that pattern
 * without overreaching on repos where artifacts are truly scattered.
 */
const EXCLUDE_GLOB_COLLAPSE_THRESHOLD = 3;

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
    // Bootstrap-output-paste-safe doctrine
    // (`docs/kb/architecture/ai-first-consumer.md`): split the
    // classifier output by confidence grade. Only `definite-*` paths
    // (definite-min-infix, definite-sourcemap-paired,
    // definite-vendor-distribution) earn a slot in the live
    // `exclude: [...]` array — those predicates are provable from the
    // path or scan-set alone, so a glob-collapsed `<dir>/**` glob
    // built from them won't sweep authored source. `likely-*`
    // classifications are heuristics that, on prior field reports,
    // produced `exclude: ["js/**", "site/**"]` entries that covered
    // every authored-source tree in the project. They land in a
    // commented-out `// likely-build-paths` hint block instead, where
    // the agent can opt in per-path after reading the source.
    //
    // Per "Bootstrap output must be paste-safe": classification
    // predicates default to do-nothing (false-negative inclusion)
    // when evidence is ambiguous. `definite-*` is the only side that
    // is mechanically pasted into the user's repo; the heuristic side
    // requires explicit agent action.
    const allArtifacts = collectBuildArtifacts(files);
    const definiteArtifactPaths: string[] = [];
    const likelyArtifactPaths: string[] = [];
    for (const entry of allArtifacts) {
      if (isDefiniteBuildArtifactClassification(entry.classification)) {
        definiteArtifactPaths.push(entry.path);
      } else {
        likelyArtifactPaths.push(entry.path);
      }
    }
    // Single scan: derive top-fired rules AND the set of finding-
    // bearing paths in one pass so the exclude-emission gate below
    // can consult both. The shared scan replaces an earlier
    // `deriveTopRules` call that scanned the same parsed-file set
    // twice.
    const scanReport = scanForProposalSignals(files, session);
    const topRules = scanReport.topRules;
    // Bootstrap-output-paste-safe doctrine, second-axis gate
    // (`docs/kb/architecture/ai-first-consumer.md`): even a
    // `definite-*` path is not paste-safe to exclude when the
    // surrounding directory tree contains files with grounded
    // findings. Pasting `exclude: ["docs/**"]` on a corpus where
    // `docs/` is the only directory with content silences ~99% of
    // real signal — the canonical regression the gate prevents.
    // Predicate: a topdir collapse to `<dir>/**` is dropped if any
    // finding-bearing path falls under that topdir; an itemized
    // file entry is dropped if a finding fires on the same file.
    // Surface what was filtered via `excludesGatedByFindings` so
    // the agent has the additive context the doctrine bullet
    // calls for.
    const excludeGate = buildExcludeGate(scanReport.findingPaths, root);
    const { paths: buildArtifacts, gated: gatedExcludePaths } = normalizeExcludes(
      definiteArtifactPaths,
      root,
      excludeGate,
    );
    const likelyBuildPaths = normalizeLikelyHints(likelyArtifactPaths, root);
    // Surface, don't suppress: foreign-ecosystem detection NEVER
    // withholds the config string — the agent may still want to add a
    // Node toolchain alongside their Ruby / Python / Go / Rust
    // project. The warning + nextStep hint carry the context so the
    // paste decision is informed. See
    // `docs/kb/architecture/ai-first-consumer.md` "Surface, don't
    // suppress."
    const foreignWarning = foreignEcosystemWarning(root);
    const foreignEcosystem = detectForeignEcosystem(root);

    // Cross-surface count invariant
    // (`docs/kb/architecture/ai-first-consumer.md`): every project-rooted
    // tool that emits `meta.configSource` must surface the same
    // `no_config_found` + `searchedFrom` warning shape on the same
    // input. `propose_config` is the canonical onboarding tool — when
    // it runs against a Node project that lacks a config, the same
    // `no_config_found` signal scan_project surfaces must ride here so
    // the agent doesn't have to call back to discover the missing-
    // config state the proposal is being built against.
    const configSearchSawProjectMarker =
      projectConfig.sourcePath === null ? sawProjectMarkerInWalk(root) : false;
    const noConfigFires = shouldEmitNoConfigFound({
      configSource: projectConfig.sourcePath,
      filesScanned: files.length,
      configSearchSawProjectMarker,
    });

    const suggestedConfig = buildConfigString({
      wrappers: confirmedWrappers,
      excludes: buildArtifacts,
      likelyBuildPaths,
      topRules,
    });

    const warningCodes: string[] = [];
    const warningsDetails: Record<string, unknown> = {};
    if (foreignWarning !== null) {
      warningCodes.push(foreignWarning);
      warningsDetails[foreignWarning] = {};
    }
    if (noConfigFires) {
      warningCodes.push("no_config_found");
      warningsDetails["no_config_found"] = { searchedFrom: root };
    }

    return textResult({
      suggestedConfig,
      meta: {
        scanned: scannedProject(root),
        configSource: projectConfig.sourcePath,
        filesScanned: files.length,
        // Conditional-spread subfields (`withEligibleInputs`, `fired`)
        // omitted — propose_config runs its scan only to derive top-rule
        // frequencies in `deriveTopRules` and doesn't retain the
        // per-rule coverage array. Emitting the loaded count alone is
        // honest per CLAUDE.md §1 "Ambiguous field shapes are
        // dishonest"; the agent sees "rules the config on/off filter
        // kept" without the tool pretending to know eligibility.
        rulesEvaluated: buildRulesEvaluated({ loadedCount: activeRules.length }),
        // Distinct counts instead of one composite — each names
        // one kind of thing folded into the proposal (CLAUDE.md §1
        // "Composite headline counts are dishonest"). An agent sizing
        // the proposal can see which pieces carried weight.
        // `buildArtifactsIncluded` counts only `definite-*` paths
        // (those that landed in the live `exclude: [...]` array);
        // `likelyBuildPathsIncluded` counts `likely-*` heuristics
        // that landed in the commented-out hint block. Splitting the
        // axes is the headline-count discipline applied at the
        // bootstrap-output level: agents budget against the
        // paste-safe slice (`definite-*`) without confusing it with
        // the opt-in slice.
        wrappersIncluded: confirmedWrappers.length,
        buildArtifactsIncluded: buildArtifacts.length,
        likelyBuildPathsIncluded: likelyBuildPaths.length,
        topRulesIncluded: topRules.length,
        // `excludesGatedByFindings` surfaces the candidate exclude
        // entries the gate dropped because their directory tree
        // contained files with grounded findings — see the
        // `buildExcludeGate` rationale at the handler call site.
        // Conditional-spread: omitted when the gate dropped nothing,
        // per CLAUDE.md §1 "Ambiguous field shapes are dishonest"
        // (never emit `excludesGatedByFindings: []`).
        ...(gatedExcludePaths.length > 0 ? { excludesGatedByFindings: gatedExcludePaths } : {}),
      },
      nextStep: buildNextStep({
        wrappers: confirmedWrappers,
        excludes: buildArtifacts,
        likelyBuildPaths,
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
      // discriminate without descending into structured data — the
      // empty-object marker on `warningsDetails` keeps the
      // warnings-details schema-discipline membership invariant honest
      // (every fired code has a corresponding key on `warningsDetails`)
      // while signaling "no further detail by design." The
      // `no_config_found` code rides here too with its `searchedFrom`
      // payload so cross-surface emission stays consistent with the
      // scan-family tools.
      ...(warningCodes.length > 0 ? { warnings: warningCodes } : {}),
      ...(Object.keys(warningsDetails).length > 0 ? { warningsDetails } : {}),
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
/**
 * Converts build-artifact paths (absolute, as {@link ParsedFile.filePath}
 * emits them) into the repo-root-relative, glob-collapsed form the
 * emitted `exclude: [...]` entry must carry. Fixes the field-reported
 * correctness bug where `propose_config` and `bootstrap` emitted paths
 * like `/tmp/bootstrap/scss/_variables.scss` — absolute paths don't
 * match ra11y's gitignore-style exclude globs (so the paste-in config
 * silently does nothing), and leak the scan-host filesystem into a
 * committed artifact.
 *
 * Steps, in order:
 *   1. Relativize every path against `root`. POSIX-style separators
 *      regardless of host OS, so the emitted config reads the same on
 *      macOS and Linux CI (`node:path.relative` returns host separators;
 *      we normalize to `/`).
 *   2. Drop paths that escape the root (e.g. symlinked sources — rare
 *      but possible). An exclude pattern outside the project is
 *      meaningless; emitting it would leave the user confused.
 *   3. Group the relative paths by their top-level segment (first
 *      directory under root). Groups with at least
 *      {@link EXCLUDE_GLOB_COLLAPSE_THRESHOLD} entries collapse to a
 *      single `<dir>/**` glob — the canonical field-report case was a
 *      repo with 301 entries all under one `dist/` tree, where the
 *      single-glob form is strictly easier to review and edit than an
 *      itemized dump. Groups below the threshold stay itemized; a
 *      two-file `dist/` tree is still specific enough that an unglobbed
 *      pair is clearer than a wildcard.
 *   4. Files sitting directly under the root with no top-level
 *      directory (e.g. `root/compiled.css`) stay itemized — there is no
 *      parent to collapse against.
 *
 * Deterministic output: paths are sorted alphabetically, and collapsed
 * globs appear in the same order as their first-seen top-level segment.
 * Stable across runs even if the underlying scanner reorders its file
 * discovery.
 */
/**
 * Result of {@link normalizeExcludes}. `paths` is the gated, glob-
 * collapsed exclude list ready for the live `exclude: [...]` array;
 * `gated` is the relativized, sorted list of candidate paths the
 * finding-bearing-directory gate dropped (empty when nothing fired).
 * The gated list surfaces in `meta.excludesGatedByFindings` so the
 * agent has the additive context the doctrine bullet
 * "Bootstrap output must be paste-safe" calls for — paste decisions
 * default to do-nothing when evidence is ambiguous, but the dropped
 * candidates are not silenced.
 */
interface NormalizedExcludes {
  readonly paths: readonly string[];
  readonly gated: readonly string[];
}

function normalizeExcludes(
  paths: readonly string[],
  root: string,
  gate: ExcludeGate,
): NormalizedExcludes {
  const relativized = relativizeToRoot(paths, root);
  const { groups, rootLevelFiles } = partitionByTopDir(relativized);
  return collapseGroupsWithGate(groups, rootLevelFiles, gate);
}

/**
 * Predicate set the exclude generator consults before promoting a
 * candidate path into the live `exclude: [...]` array. Per the
 * "Bootstrap output must be paste-safe" doctrine bullet
 * (`docs/kb/architecture/ai-first-consumer.md`): a `definite-*`
 * build-artifact classification is path-anchored evidence the file
 * itself is generated, but a `<topdir>/**` glob built from a few
 * such files would silence every authored sibling under the same
 * topdir. The gate refuses to collapse to a glob whose tree contains
 * any finding-bearing path, and refuses to itemize a single file
 * that is itself a finding-bearing path. Both cases are silent
 * misses if surfaced as live excludes — pasting the suggested
 * config would cancel the very signal the agent just observed.
 *
 * Two-axis predicate:
 *
 *   - `topdirHasFinding(topdir)`: true if any finding fires on a
 *     file whose POSIX-relative path starts with `<topdir>/`. Used
 *     to refuse the `<topdir>/**` collapse — the canonical
 *     regression: `exclude: ["docs/**"]` swept the only directory
 *     with content because three `.min.` files lived under
 *     `docs/vendor/`.
 *   - `fileHasFinding(rel)`: true if a finding fires on this exact
 *     POSIX-relative path. Used to drop itemized exclude entries
 *     that name a finding-bearing file.
 *
 * Both predicates are pure boolean queries over the finding-paths
 * set built once at handler-call time (see
 * {@link buildExcludeGate}).
 */
interface ExcludeGate {
  topdirHasFinding(topdir: string): boolean;
  fileHasFinding(rel: string): boolean;
}

/**
 * Builds the {@link ExcludeGate} predicate from the set of finding-
 * bearing absolute paths the scanner observed on this run.
 * Relativizes against `root` and indexes both the per-file paths
 * and the per-topdir prefixes so the gate's predicates are O(1).
 *
 * The empty-scan case (no findings observed) returns a gate whose
 * predicates always return false — i.e. the gate is a no-op and the
 * `definite-*` paths flow through to the live `exclude` array
 * unchanged. This preserves backward-compatible behaviour for the
 * canonical onboarding case (a vendor-bundle-only repo with no
 * authored findings yet).
 */
function buildExcludeGate(findingPaths: ReadonlySet<string>, root: string): ExcludeGate {
  const fileSet = new Set<string>();
  const topdirSet = new Set<string>();
  for (const p of findingPaths) {
    const rel = relative(root, p).replace(/\\/g, "/");
    if (rel === "" || rel.startsWith("..")) continue;
    fileSet.add(rel);
    const slash = rel.indexOf("/");
    if (slash !== -1) topdirSet.add(rel.slice(0, slash));
  }
  return {
    topdirHasFinding(topdir: string): boolean {
      return topdirSet.has(topdir);
    },
    fileHasFinding(rel: string): boolean {
      return fileSet.has(rel);
    },
  };
}

/**
 * Sibling of {@link normalizeExcludes} for the heuristic
 * (`likely-*`) classifier output. Relativizes paths against the scan
 * root using the same POSIX-normalizing logic, but does NOT
 * glob-collapse. The doctrine bullet "Bootstrap output must be
 * paste-safe" calls out the canonical regression: a few heuristic
 * hits under `js/` collapsing to `js/**` and sweeping every authored
 * module in the project. Hints are emitted into a commented-out
 * block, so per-path itemization is the readable form for an agent
 * deciding which entries (if any) to opt into `exclude`. A
 * `<topdir>/**` glob would compress the evidence into a shape that
 * looks paste-ready and undoes the whole point of the commented
 * block.
 */
function normalizeLikelyHints(paths: readonly string[], root: string): readonly string[] {
  return relativizeToRoot(paths, root);
}

function relativizeToRoot(paths: readonly string[], root: string): readonly string[] {
  const out: string[] = [];
  for (const p of paths) {
    const rel = relative(root, p).replace(/\\/g, "/");
    // Skip paths outside the root (starts with `..`) and the root
    // itself (empty string from `relative`). Both would be nonsense as
    // exclude entries.
    if (rel === "" || rel.startsWith("..")) continue;
    out.push(rel);
  }
  out.sort();
  return out;
}

function partitionByTopDir(paths: readonly string[]): {
  readonly groups: ReadonlyMap<string, readonly string[]>;
  readonly rootLevelFiles: readonly string[];
} {
  const groups = new Map<string, string[]>();
  const rootLevelFiles: string[] = [];
  for (const rel of paths) {
    const slash = rel.indexOf("/");
    if (slash === -1) {
      rootLevelFiles.push(rel);
      continue;
    }
    const topDir = rel.slice(0, slash);
    const bucket = groups.get(topDir);
    if (bucket === undefined) groups.set(topDir, [rel]);
    else bucket.push(rel);
  }
  return { groups, rootLevelFiles };
}

/**
 * Per-topdir collapse + finding-bearing-directory gate. Two cases
 * per group:
 *
 *   1. Topdir has finding-bearing files → never collapse to
 *      `<topdir>/**`. The collapse would silence every authored
 *      sibling under the topdir (the `exclude: ["docs/**"]`
 *      regression). Members are also filtered: an itemized entry
 *      that names a finding-bearing file is dropped (a generated
 *      file the scanner found a real violation on is, by
 *      definition, not a "you can ignore this whole file" case).
 *      Surviving members ride into the live exclude list itemized.
 *   2. Topdir has no finding-bearing files → standard
 *      threshold-driven collapse to `<topdir>/**` when the count
 *      crosses {@link EXCLUDE_GLOB_COLLAPSE_THRESHOLD}.
 *
 * Root-level files (no topdir) are filtered the same way: a single
 * file at the repo root that fires a finding is dropped from the
 * exclude list. The entry would silence the file the agent should
 * be reading.
 *
 * `gated` accumulates the dropped paths in deterministic order
 * (alphabetical within group, group-discovery order across groups,
 * then root-level files) so the meta surface
 * `excludesGatedByFindings` reads stably across runs.
 */
function collapseGroupsWithGate(
  groups: ReadonlyMap<string, readonly string[]>,
  rootLevelFiles: readonly string[],
  gate: ExcludeGate,
): NormalizedExcludes {
  const out: string[] = [];
  const gated: string[] = [];
  for (const [topDir, members] of groups) {
    appendGroupExcludes(topDir, members, gate, out, gated);
  }
  for (const f of rootLevelFiles) {
    if (gate.fileHasFinding(f)) gated.push(f);
    else out.push(f);
  }
  return { paths: out, gated };
}

/**
 * Per-group helper for {@link collapseGroupsWithGate}. Splits the
 * gated-vs-ungated branch out so the parent stays under Biome's
 * cyclomatic-complexity ceiling. Mutates `out` and `gated` in place
 * — accumulator pattern matches the parent's two-array layout and
 * avoids per-group allocation churn.
 */
function appendGroupExcludes(
  topDir: string,
  members: readonly string[],
  gate: ExcludeGate,
  out: string[],
  gated: string[],
): void {
  if (!gate.topdirHasFinding(topDir)) {
    if (members.length >= EXCLUDE_GLOB_COLLAPSE_THRESHOLD) {
      out.push(`${topDir}/**`);
    } else {
      for (const m of members) out.push(m);
    }
    return;
  }
  // Topdir contains finding-bearing files. Refuse the
  // `<topdir>/**` collapse outright; itemize survivors and drop
  // members that themselves carry a finding. If the collapse
  // threshold WOULD have fired and the gate dropped it, record
  // the would-be glob in `gated` too — the agent reading
  // `meta.excludesGatedByFindings` should see both shapes the
  // gate refused (the `<topdir>/**` collapse and the per-file
  // entries that landed on findings).
  for (const m of members) {
    if (gate.fileHasFinding(m)) gated.push(m);
    else out.push(m);
  }
  if (members.length >= EXCLUDE_GLOB_COLLAPSE_THRESHOLD) {
    gated.push(`${topDir}/**`);
  }
}

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
 * Single scan over the parsed file set returning the two derived
 * signals the proposal needs: the top-`TOP_RULES_COUNT` rules by
 * total count (with ties broken by rule ID ascending — the stable
 * tiebreak the spec asks for) AND the set of absolute file paths
 * any finding fires on. Each top-rule entry carries the rule's
 * DEFAULT severity — the author's paste-ready place to override it
 * via the commented stub — not the effective severity after session
 * or project-config overrides.
 *
 * The finding-paths set feeds {@link buildExcludeGate}, which
 * refuses to promote a `definite-*` build-artifact path into the
 * live `exclude: [...]` array when its directory tree contains
 * any finding-bearing file. Per the "Bootstrap output must be
 * paste-safe" doctrine bullet
 * (`docs/kb/architecture/ai-first-consumer.md`), the gate prevents
 * the canonical regression where `exclude: ["docs/**"]` swept the
 * only directory with content because three minified files lived
 * under it.
 *
 * Runs the scanner directly rather than relying on an outer scan
 * result so this tool is self-contained — callers don't need to pipe
 * in findings they'd otherwise throw away. The scanner is pure over
 * the parsed files; folding both derivations into a single pass
 * replaces an earlier shape that scanned twice (once for top-rule
 * frequencies, once implicitly for the unused finding paths).
 */
interface ProposalScanReport {
  readonly topRules: readonly TopRuleEntry[];
  readonly findingPaths: ReadonlySet<string>;
}

function scanForProposalSignals(
  files: readonly ParsedFile[],
  session: import("./session.ts").McpSession,
): ProposalScanReport {
  if (files.length === 0) return { topRules: [], findingPaths: new Set() };
  const { result } = runScan({
    standards: session.registry.standards,
    rules: session.registry.rules,
    enabled: resolveStandards(undefined, session),
    files,
    level: session.config.level,
  });
  const counts = new Map<string, number>();
  const findingPaths = new Set<string>();
  for (const v of result.violations) {
    counts.set(v.ruleId, (counts.get(v.ruleId) ?? 0) + 1);
    findingPaths.add(v.location.filePath);
  }
  const ranked = [...counts.entries()].sort(([aId, aCount], [bId, bCount]) => {
    if (bCount !== aCount) return bCount - aCount;
    return aId.localeCompare(bId);
  });
  const topRules: TopRuleEntry[] = [];
  for (const [ruleId, count] of ranked.slice(0, TOP_RULES_COUNT)) {
    const rule = session.registry.findRule(ruleId);
    if (!rule) continue;
    topRules.push({ ruleId, severity: rule.severity, count });
  }
  return { topRules, findingPaths };
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
  readonly likelyBuildPaths: readonly string[];
  readonly topRules: readonly TopRuleEntry[];
}): string {
  const { wrappers, excludes, likelyBuildPaths, topRules } = args;

  // Case 1: nothing to propose AND no commented hints available. The
  // honest shape is a minimal defineConfig({}) with a comment naming
  // why — an empty string (or a config file that omits the
  // defineConfig wrapper) would read as "tool never ran." Per §1
  // "Zero-output success is ambiguous failure." Likely-build-path
  // hints alone don't disqualify the clean-scan branch by themselves;
  // they ride below the wrapper as advisory comments.
  if (
    wrappers.length === 0 &&
    excludes.length === 0 &&
    likelyBuildPaths.length === 0 &&
    topRules.length === 0
  ) {
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
  // order the `scannedBuildArtifacts` meta field surfaces). ONLY
  // `definite-*` build-artifact classifications populate this list —
  // see the splitter at the handler call site for the doctrine
  // rationale (`docs/kb/architecture/ai-first-consumer.md` "Bootstrap
  // output must be paste-safe").
  if (excludes.length > 0) {
    bodyLines.push(`${INDENT}exclude: [`);
    for (const path of excludes) {
      bodyLines.push(`${INDENT}${INDENT}${JSON.stringify(path)},`);
    }
    bodyLines.push(`${INDENT}],`);
  }

  // likely-build-paths: commented out so paste does NOT silently
  // exclude files. Heuristic classifications (`likely-*` —
  // bundler-dir, hashed-bundle, compiled-tailwind, vendor-distribution
  // by banner, minified-by-line-stats) land here, individually
  // itemized so the agent can read each path before opting any of
  // them into `exclude`. Paths are NOT collapsed to `<topdir>/**`
  // globs at this stage — the canonical regression was a heuristic
  // signal on a few files under `js/` collapsing to `js/**` and
  // sweeping every authored module in the project. Itemized hints
  // give the agent the raw evidence so it can decide per-path.
  if (likelyBuildPaths.length > 0) {
    bodyLines.push("");
    bodyLines.push(
      `${INDENT}// likely-build-paths: heuristic classifier flagged the paths below as`,
    );
    bodyLines.push(
      `${INDENT}// possibly-generated (bundler-dir / hashed / compiled-tailwind / vendor-banner /`,
    );
    bodyLines.push(
      `${INDENT}// long-line-stats). Read each before adding to \`exclude\` above — the`,
    );
    bodyLines.push(`${INDENT}// signals fire on authored content too (template literals, SVG path`);
    bodyLines.push(`${INDENT}// data, SCSS function bodies). NOT auto-applied; opt in per path.`);
    bodyLines.push(`${INDENT}// likelyBuildPaths: [`);
    for (const path of likelyBuildPaths) {
      bodyLines.push(`${INDENT}//   ${JSON.stringify(path)},`);
    }
    bodyLines.push(`${INDENT}// ],`);
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
  readonly likelyBuildPaths: readonly string[];
  readonly topRules: readonly TopRuleEntry[];
  readonly configSource: string | null;
  readonly foreignEcosystem: string | null;
}): string {
  const { wrappers, excludes, likelyBuildPaths, topRules, configSource, foreignEcosystem } = args;
  const summary: string[] = [];
  if (wrappers.length > 0) {
    summary.push(`${wrappers.length} confirmed wrapper${wrappers.length === 1 ? "" : "s"}`);
  }
  if (excludes.length > 0) {
    summary.push(`${excludes.length} build-artifact path${excludes.length === 1 ? "" : "s"}`);
  }
  if (likelyBuildPaths.length > 0) {
    summary.push(
      `${likelyBuildPaths.length} likely-build path${likelyBuildPaths.length === 1 ? "" : "s"} in a commented hint block`,
    );
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
