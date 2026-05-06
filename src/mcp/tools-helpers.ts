/**
 * Shared helpers for MCP tool handlers — param extraction, result
 * construction, scanner adapters, and finding formatting.
 *
 * Kept separate from tools.ts so the tool-definition file stays focused
 * on tool schemas and handler logic.
 */

import { isAbsolute, resolve } from "node:path";
import { readAttestations } from "../config/attestation-store.ts";
import { type RuleAlias, resolveRuleId } from "../engine/rule-aliases.ts";
import { type ParsedFile, runScan } from "../engine/scanner.ts";
import {
  type DiscoveryDiagnostics,
  discoverExplicitPaths,
  discoverFilesWithDiagnostics,
} from "../input/discover.ts";
import {
  accumulateInlineHtml,
  type InlineHtmlPatternSample,
} from "../input/parsers/inline-html.ts";
// biome-ignore format: keep import on one line — file effective-line budget
import { accumulateCodeDemoPropMatches, type CodeDemoPropMatch } from "../input/parsers/mdx-example-extractor.ts";
import {
  type AgentFinding,
  buildAgentFinding,
  countFixes,
  countFixesByClass,
} from "../output/agent-response/index.ts";
import type { Rule } from "../types/rule.ts";
import type { Standard } from "../types/standard.ts";
import type { PerRuleCoverage, Violation } from "../types/violation.ts";
import type { SourceEntry } from "../utils/source-snippet.ts";
import { applyParseErrorAndCorpusRate } from "./corpus-parse-error-rate-adjustment.ts";
import { applyExtensionSubkindFromRoot } from "./extension-subkind.ts";
import { detectApplicability, isLikelyIrrelevant } from "./manual-applicability.ts";
import { tallyManualCriteria } from "./manual-criteria-tally.ts";
import {
  buildParsedThroughLineMap,
  enrichFindingsBeyondPartialParseBoundary,
} from "./per-finding-beyond-parse-boundary.ts";
import {
  buildPerRuleLimitationMap,
  buildSubstrateFiles,
  enrichFindingsWithPerRuleLimitations,
} from "./per-finding-confidence-parity.ts";
import { buildReferenceGuide } from "./reference-guide.ts";
import { buildRuleCoverageDerivative } from "./rule-coverage-derivative.ts";
import { applyRuleSettings } from "./rules-evaluated.ts";
import {
  applyFragmentInputAdjustment,
  applyScssUnresolvedVariablesAdjustment,
  buildScanMeta,
  buildScanPlan,
  detectFragmentFiles,
  detectScssUnresolvedVariableFiles,
  outputFilePathSet,
  partitionParseStateFiles,
} from "./scan-assembly.ts";
import type { McpSession } from "./session.ts";
import { suppressionAudit } from "./suppression-audit.ts";
import { collapseVendorCssFindings } from "./vendor-dedupe.ts";
import { nameMatchesAnyWrapper } from "./wrapper-matcher.ts";
import {
  buildRunScanOptions,
  type NativeWrapperSources,
  resolveUnusedWrappers,
  resolveWrapperSources,
} from "./wrappers-meta.ts";

export { buildAnalysisCoverage } from "./analysis-coverage.ts";
export type { NativeWrapperSources } from "./wrappers-meta.ts";

// ─── Tool metadata types ────────────────────────────────────────────────────

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, boolean>;
}

export interface McpToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/**
 * Stable, ra11y-scoped codes for structured error envelopes. Agents
 * branch on `code` — never on the English `message`. Kebab-case; short;
 * present-tense ("rule-not-found", not "rule was not found"). Add a new
 * value only when an existing code is a genuine semantic mismatch; if
 * you just want a different `message`, leave the code alone and change
 * the message.
 */
export type StructuredErrorCode =
  // shape / shape-level validation of tool params
  | "missing-required-param"
  | "invalid-param"
  // registry lookups
  | "rule-not-found"
  | "standard-not-found"
  | "criterion-not-found"
  // attest: a ruleId was provided that doesn't satisfy the given
  // criterionId. Distinct from rule-not-found — the rule may exist,
  // but it wouldn't contribute to this criterion's coverage so the
  // attestation is nonsensical. See ADR 0013.
  | "rule-not-under-criterion"
  | "mode-invalid"
  // scan/resource IO
  | "file-not-found"
  | "file-unsupported"
  | "file-read-failed"
  | "file-write-failed"
  | "path-escapes-cwd"
  // scan targets that don't exist on disk — distinct from zero-parseable-files,
  // which is a *successful* scan over an empty-but-real directory (handled via
  // the `warnings: ["scanned_zero_files"]` soft-signal path).
  | "cwd-not-found"
  | "scan-paths-not-found"
  // baseline lifecycle
  | "baseline-not-found"
  | "baseline-load-failed"
  // scan scope / git-aware narrowing
  | "no-staged-files"
  // scan_diff hunksOnly: git-shell preconditions for the hunk-
  // intersection comparison. Distinct from `no-staged-files` because
  // they describe different failures — not in a git repo at all, vs.
  // ref doesn't resolve — and the agent branches on them differently.
  | "not-a-git-repo"
  | "unknown-ref"
  // apply_fix safety gates
  | "allow-write-disabled"
  | "edit-shape-invalid"
  | "edit-no-match"
  // apply_fix: oldText didn't match AND the would-be target carries a
  // template-directive token (`{{…}}`, `{%…%}`, `<%=…%>`). Distinct from
  // edit-no-match because the diagnosis the agent should act on is
  // different — the upstream finding is plausibly a Liquid/Jinja/ERB
  // false positive, not a stale `oldText`. Looping back through
  // `suggest_fix` will keep returning `kind: "guidance"`. See
  // in `.claude/backlog.md`.
  | "target-contains-template-directive"
  | "edit-multiple-matches"
  | "edit-introduces-parse-errors"
  // meta-tool internal
  | "audit-sub-tool-unparseable"
  // audit meta-tool: one of the sub-handlers rejected instead of
  // returning an McpToolResult. Distinct from -unparseable so agents
  // can tell "handler threw" from "handler answered with garbage."
  | "audit-sub-tool-threw"
  // verdict_candidate: caller supplied `candidateId` to back-load a
  // candidate from a prior `checklist`/`review_candidates` call, but
  // the cross-tool persistence layer hasn't been wired yet — the id
  // shape is accepted for forward-compat (so callers can pin the
  // shortcut form before the lookup lands) but cannot be resolved.
  // Distinct from `invalid-param` because the param shape is honest;
  // the server simply can't service it on this build. Remediation:
  // pass the full hand-built `candidate` shape until the lookup
  // index ships.
  | "candidate-id-lookup-unavailable";

/** Structured-error envelope — emitted via `structuredContent` + `isError: true`. */
export interface StructuredError {
  readonly code: StructuredErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly remediation?: string;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  session: McpSession,
) => Promise<McpToolResult> | McpToolResult;

export interface McpTool {
  readonly def: McpToolDef;
  readonly handler: ToolHandler;
}

// ─── Param helpers (bracket access for index-signature safety) ──────────────

export function strParam(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

export function numParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" ? v : undefined;
}

export function strArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const v = params[key];
  return Array.isArray(v) ? (v as string[]) : undefined;
}

// Strict type-validating helpers (`requireBooleanParam`,
// `requireNumberParam`, `requireStringArrayParam`) live in
// `param-validators.ts` to keep this file under its 500-effective-line
// cap. Import them directly from that module.

// ─── Result builders ────────────────────────────────────────────────────────

export function textResult(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * Builds an MCP error result. Pass a `StructuredError` to populate
 * `structuredContent` with a machine-consumable shape the agent can
 * branch on by `code` — English `message` stays in `content[0].text`
 * and the legacy `{ error }` field remains so older consumers don't
 * break. The string overload is kept for one-off messages that have
 * no richer context; prefer the structured form for anything an agent
 * might need to discriminate. `isError: true` is always set.
 */
export function errorResult(error: StructuredError | string): McpToolResult {
  if (typeof error === "string") {
    return {
      content: [{ type: "text", text: JSON.stringify({ error }) }],
      isError: true,
    };
  }
  const { code, message, details, remediation } = error;
  // structuredContent: spec-facing machine shape. Agents branch on
  // `code`, read `details` for specifics, surface `remediation` when
  // present.
  const structuredContent: Record<string, unknown> = { code, message };
  if (details !== undefined) structuredContent["details"] = details;
  if (remediation !== undefined) structuredContent["remediation"] = remediation;
  // content[0].text: legacy + human-readable payload. Keeps the
  // top-level `error` string so existing tests + consumers that
  // grepped the text path still read something sensible, while
  // exposing the same structured fields alongside it for parity.
  const textPayload: Record<string, unknown> = { error: message, code };
  if (details !== undefined) textPayload["details"] = details;
  if (remediation !== undefined) textPayload["remediation"] = remediation;
  return {
    content: [{ type: "text", text: JSON.stringify(textPayload) }],
    structuredContent,
    isError: true,
  };
}

// ─── Session adapters ───────────────────────────────────────────────────────

export function resolveStandards(
  standardId: string | undefined,
  session: McpSession,
): readonly string[] {
  const id = standardId ?? session.config.standard;
  return id
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Returns the first unknown standard ID in `ids`, or null if every
 * entry resolves. Used by tools that want a structured error envelope
 * naming the bad ID rather than scanning with an empty enabled list
 * (which silently zeroes every criterion count). Resolution routes
 * through `session.registry` per ADR 0022 so plugin-registered
 * standards count as "known" too.
 */
export function firstUnknownStandard(ids: readonly string[], session: McpSession): string | null {
  return ids.find((id) => session.registry.findStandard(id) === undefined) ?? null;
}

export function resolveLevel(level: string | undefined, session: McpSession): "A" | "AA" | "AAA" {
  const v = level ?? session.config.level;
  if (v === "A" || v === "AAA") return v;
  return "AA";
}

/**
 * Resolves input paths, discovers files, and parses them. Relative paths
 * resolve against `cwd` if provided — the server's own cwd is fixed at
 * spawn time, which breaks when agents work in git worktrees.
 *
 * `options.includeStoryFiles` flips the Storybook-story unfilter in
 * `discoverFiles`. `scan_project` passes `true` when the project
 * config sets `preset: "storybook"`, so `*.stories.*` and
 * `stories/**` reach the scanner alongside the framework-aware
 * transparency applied downstream.
 */
export async function parseFiles(
  paths: readonly string[],
  session: McpSession,
  cwd?: string,
  options: { readonly includeStoryFiles?: boolean } = {},
): Promise<readonly ParsedFile[]> {
  const { files } = await parseFilesWithDiagnostics(paths, session, cwd, options);
  return files;
}

/**
 * Like {@link parseFiles} but also returns discovery diagnostics —
 * per-extension counts of files the walker cleared past dir-ignore +
 * user-excludes and then rejected purely on the parseable-extension
 * check. Scan-surface tools (scan, scan_project, scan_file, scan_diff)
 * use this to surface the silent-miss case
 * where a mixed-language repo contributes hundreds of `.astro` /
 * `.scss` / `.vue` files that the scanner never looked at.
 *
 * Side-channel scan-confidence telemetry on the result —
 * `jsInnerHtmlDeclinedCount` (count of dynamic `${…}` template
 * literals the extractor refused to parse) and
 * `jsInnerHtmlPatternSamples` (per-file `{ path, line, pattern }`
 * matches the detector found) — drives the
 * `js_innerhtml_template_literal_unparsed` warning code. Cross-
 * referenced post-scan against finding-bearing paths so the warning's
 * `fileSamples[]` payload only names files where the routed parser
 * produced zero findings — the routing-skip failure mode per the
 * AI-first doctrine "Routing skips that drop content are the
 * symmetric twin of suppression."
 *
 * `codeDemoPropMatches` (per-file list of
 * {@link CodeDemoPropMatch}) is the inverse-shape sibling of
 * `jsInnerHtmlPatternSamples`: the inline-HTML detector names files
 * the parser silently DROPPED (routing-skip failure mode); this map
 * names files the parser silently DESCENDED into (an MDX docs-
 * component prop's template-literal HTML body). Both are cross-
 * referenced at the warning-channel seam to drive distinct codes —
 * `js_innerhtml_template_literal_unparsed` for the drop case,
 * `jsx_code_demo_prop_parsed_as_live_dom` for the descent case. Per
 * AI-first doctrine "Surface, don't suppress": the MDX descent IS the
 * doctrine-correct behaviour (rules fire on the rendered substrate),
 * but the agent reading findings emitted on synthesized elements
 * needs the triage signal that the substrate is rhetorical-preview
 * markup rather than authored production source.
 */
export async function parseFilesWithDiagnostics(
  paths: readonly string[],
  session: McpSession,
  cwd?: string,
  options: { readonly includeStoryFiles?: boolean } = {},
): Promise<{
  readonly files: readonly ParsedFile[];
  readonly diagnostics: DiscoveryDiagnostics;
  readonly jsInnerHtmlDeclinedCount: number;
  readonly jsInnerHtmlPatternSamples: ReadonlyMap<string, readonly InlineHtmlPatternSample[]>;
  readonly codeDemoPropMatches: ReadonlyMap<string, readonly CodeDemoPropMatch[]>;
}> {
  const base = cwd ?? process.cwd();
  const absPaths = paths.map((p) => (isAbsolute(p) ? p : resolve(base, p)));
  const { files: discovered, diagnostics } = await discoverFilesWithDiagnostics(absPaths, {
    excludes: session.config.exclude,
    ...(options.includeStoryFiles === true ? { includeStoryFiles: true } : {}),
  });
  const parsed: ParsedFile[] = [];
  let jsInnerHtmlDeclinedCount = 0;
  // biome-ignore format: keep map declarations on one line — file effective-line budget
  const jsInnerHtmlPatternSamples = new Map<string, readonly InlineHtmlPatternSample[]>(), codeDemoPropMatches = new Map<string, readonly CodeDemoPropMatch[]>();
  for (const filePath of discovered) {
    const result = await session.parseFile(filePath, cwd);
    if (!result) continue;
    parsed.push(result);
    if (result.ast.language === "tsx")
      jsInnerHtmlDeclinedCount += accumulateInlineHtml(result, parsed, jsInnerHtmlPatternSamples);
    accumulateCodeDemoPropMatches(result, codeDemoPropMatches);
  }
  // biome-ignore format: keep return object on one line — file effective-line budget
  return { files: parsed, diagnostics, jsInnerHtmlDeclinedCount, jsInnerHtmlPatternSamples, codeDemoPropMatches };
}

/**
 * Opt-in parse pass that bypasses `.gitignore` and the default ignored
 * build dirs (`dist`, `build`, `out`, …). Used for `scan_project`'s
 * `additionalPaths` so post-compile artifacts (Tailwind/SCSS output,
 * statically-exported HTML) can be scanned on request.
 */
export async function parseExplicitPaths(
  paths: readonly string[],
  session: McpSession,
  cwd?: string,
): Promise<readonly ParsedFile[]> {
  const base = cwd ?? process.cwd();
  const absPaths = paths.map((p) => (isAbsolute(p) ? p : resolve(base, p)));
  const discovered = await discoverExplicitPaths(absPaths, { excludes: session.config.exclude });
  const parsed: ParsedFile[] = [];
  for (const filePath of discovered) {
    const result = await session.parseFile(filePath, cwd);
    if (result) parsed.push(result);
  }
  return parsed;
}

export type { ConfigureOpts, ConfigureOptsResult } from "./configure-opts.ts";
export { buildConfigureOpts } from "./configure-opts.ts";

/** Millisecond elapsed since a performance.now() timestamp, formatted. */
export function ms(since: number): string {
  return (performance.now() - since).toFixed(0);
}

/**
 * Counts criteria across the enabled standards that can't be evaluated by
 * static analysis. Shown in scan output so agents don't stop at green —
 * "0 automated findings AND N manual criteria" is the full picture.
 */
const LEVEL_ORDER: Readonly<Record<string, number>> = { A: 1, AA: 2, AAA: 3, base: 1 };

function isCountableManual(
  c: { readonly automatable: string; readonly level: string; readonly id: string },
  maxRank: number,
  seen: ReadonlySet<string>,
): boolean {
  if (c.automatable !== "manual") return false;
  if ((LEVEL_ORDER[c.level] ?? 3) > maxRank) return false;
  return !seen.has(c.id);
}

export function collectManualCriteria(
  enabledStandardIds: readonly string[],
  session: McpSession,
  maxLevel: "A" | "AA" | "AAA" = "AAA",
  files: readonly ParsedFile[] = [],
): ReadonlySet<string> {
  const enabled = new Set(enabledStandardIds);
  const maxRank = LEVEL_ORDER[maxLevel] ?? 3;
  const applicability = detectApplicability(files);
  const seen = new Set<string>();
  for (const std of session.registry.standards) {
    if (!enabled.has(std.id)) continue;
    for (const c of std.criteria) {
      if (!isCountableManual(c, maxRank, seen)) continue;
      if (isLikelyIrrelevant(c.id, applicability)) continue;
      seen.add(c.id);
    }
  }
  return seen;
}

// ─── Shared scan+format ─────────────────────────────────────────────────────

/**
 * Shape of the scan output used by both `scan` and `plan`.
 *
 * Intentionally does NOT carry a top-level "pass" boolean — every prior
 * variant ("pass", "automatedPass") read as "the app is accessible",
 * which is a claim static analysis can't make. The structured counts in
 * `plan` (`fixesByClass`, `notes`, `actionableManualItems`,
 * `untargetedCriteria`) convey the state without a load-bearing
 * boolean — and without a duplicate prose `summary` headline that
 * collapsed those siblings into a single composite (dropped per
 * `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest"; consumers read the structured siblings).
 */
export interface ScanFormatted {
  readonly plan: Record<string, unknown>;
  readonly files: readonly {
    readonly path: string;
    readonly findings: readonly AgentFinding[];
  }[];
  readonly meta: Record<string, unknown>;
  /**
   * Top-level prose map — findings reference by file extension rather than
   * inlining the same paragraph on every entry. Omitted when no findings
   * exist (so a clean scan ships neither the map nor the keys); populated
   * only with the extensions actually present in `files`.
   *
   * Keys are file extensions without the leading dot (`tsx`, `css`, etc.).
   * The `default` key covers extensions that don't have a language-specific
   * placement variant — today that's `.ts` / `.js` / anything else.
   *
   * `fixDescriptions` rides in the same block — a nested
   * `{ [ruleId]: { [hash]: description } }` map populated when a rule
   * has ≥2 findings carrying descriptions in the response, so the
   * prose hoists once to the top level instead of repeating per-
   * finding. Hoisted findings carry the nested
   * `fix.descriptionRef: { hash }` (NOT a sibling on the finding —
   *) and
   * omit `fix.description`; findings with unique-in-response
   * descriptions keep the inline text. Omitted entirely when no
   * duplicates cross the threshold (present-when-meaningful per
   * CLAUDE.md §1). See and the
   * `src/mcp/reference-guide.ts` implementation.
   */
  readonly referenceGuide?: import("./reference-guide.ts").ReferenceGuide;
  /**
   * Top-level split of rule IDs into "0 findings with high-confidence
   * coverage" vs "0 findings with low-confidence coverage" — derived
   * from `meta.perRuleCoverage`. Lets agents branch on "trust the clean
   * tally for this rule" vs "scan didn't see any eligible sources,
   * retry with `additionalPaths`" without walking the per-rule rows.
   *
   * Only populated when at least one rule produced 0 findings —
   * omitted entirely on already-flagged scans (CLAUDE.md §1 "Ambiguous
   * field shapes are dishonest"). See
   * `src/mcp/rule-coverage-derivative.ts`.
   */
  readonly ruleCoverage?: {
    readonly confidentlyClean: readonly string[];
    readonly lowConfidenceClean: readonly string[];
  };
}

/**
 * Reads durable attestations from `<cwd>/.ra11y/attestations.jsonl`
 * into the runScan inputs, returning [] when the file is missing or
 * malformed. Exported so every MCP tool that invokes `runScan`
 * directly (coverage, checklist, review_candidates) can call it
 * without re-implementing the soft-fail read.
 */
export async function loadDurableAttestations(
  cwd: string,
): Promise<readonly import("../types/evidence.ts").AttestationRecord[]> {
  try {
    return await readAttestations(cwd);
  } catch {
    return [];
  }
}

/**
 * Runs the scanner against the pre-parsed files and formats the result
 * into the agent-facing shape (plan, files, meta). Factored out so both
 * `scan` and `scan_project` share identical semantics.
 */

export async function runScanAndFormat(
  files: readonly ParsedFile[],
  session: McpSession,
  enabled: readonly string[],
  minSeverity: string | undefined,
  ruleSettings?: Readonly<Record<string, string>>,
  wrapperSources?: NativeWrapperSources,
  // Optional project root used to widen wrapper-usage detection into
  // excluded paths (stories, dev-tools, tests). Without it, wrappers
  // referenced only from those paths are wrongly reported unused.
  cwd?: string,
  // When true, analysisCoverage includes the actual file paths and
  // component names behind the counts, plus per-extension rule lists so
  // the agent can verify which rules ran on which languages. Gated
  // because these arrays can be large on noisy projects.
  verboseMeta = false,
  // Caller-supplied criterion IDs to exclude. Findings whose entire
  // `criteria` list is contained in this set are dropped; findings
  // that also satisfy an un-skipped criterion stay (the un-skipped
  // coverage is the honest reason to keep them). Empty / undefined
  // leaves the output unchanged. Not suppression by the tool — this
  // is the caller filtering its own result. The `skippedByCaller`
  // meta field surfaces the filter input verbatim.
  skipCriteria?: readonly string[],
  // Resolved `LoadedConfig.preset`. When `"storybook"`, story files
  // scan with framework-aware transparency (Storybook primitives
  // don't inflate the opaque-component count). Undefined = default
  // behavior, story files — if present — scan as plain TSX.
  preset?: import("../types/config.ts").ConfigPreset,
  // Declared process page-sets from `LoadedConfig.processes` (ADR
  // 0016). Threaded to project-scoped finders via
  // `ProjectCandidateContext.processes` so WCAG 3.2.3 / 3.2.4 run
  // against the full page set a scan has in hand. Omitted when the
  // user declared no processes; empty/absent = no process-level
  // evidence, finders emit nothing rather than guess.
  processes?: readonly import("../types/config.ts").Process[],
  // Discovery diagnostics from `parseFilesWithDiagnostics`. When
  // present with a non-empty `skippedByExtension` map, the counts are
  // surfaced in `meta.analysisCoverage.skippedByExtension` and the
  // response-level `text_source_skipped` / `binary_assets_skipped`
  // warnings fire. Omit
  // (or pass an empty map) on scan surfaces that don't run discovery
  // — the scan_file tool takes explicit paths and has no silent-miss
  // axis to report on.
  discoveryDiagnostics?: DiscoveryDiagnostics,
): Promise<{
  readonly formatted: ScanFormatted;
  readonly durationMs: number;
  readonly filesScanned: number;
  /**
   * Raw review candidates the finders produced, pre-dedup. Exposed so
   * `scan_file` can dedupe by (filePath, line, column, reason) before
   * surfacing them on the response — scan_project doesn't need them
   * individually (it rolls them up into the `actionableManualItems`
   * count) but a per-file tool does.
   */
  readonly reviewCandidates: readonly import("../types/review.ts").ReviewCandidate[];
  /**
   * deterministic-sorted list
   * of `.scss` files in this scan whose top-level `$variable: …`
   * declarations produced zero literal-color usages downstream after
   * the SCSS preprocessor's substitution pass. Empty array when no
   * files matched. Threaded to the response-level
   * `scss_unresolved_variables` warning at `tool-scan-project.ts` so
   * the meta downgrade and the top-level warning agree on the file
   * list — `applyScssUnresolvedVariablesAdjustment` has already
   * stamped `coverageConfidenceReason: "scss-unresolved-variables"`
   * on `meta.perRuleCoverage` rows whose extension gate matched.
   */
  readonly scssUnresolvedVariableFiles: readonly string[];
  /**
   * Adjusted `perRuleCoverage` rows — same view as
   * `meta.perRuleCoverage` after every parse-error / SCSS / fragment /
   * extension-subkind adjustment. Exposed so callers can run the
   * `coverage_confidence_uniformly_high_with_parse_errors` cross-check
   * without re-walking the adjustment chain.
   */
  readonly adjustedPerRuleCoverage: readonly PerRuleCoverage[];
}> {
  const effective = ruleSettings ?? session.config.rules;
  const activeRules = applyRuleSettings(session.registry.rules, effective);
  const attestations = await loadDurableAttestations(cwd ?? process.cwd());
  // biome-ignore format: keep destructure on one line — file effective-line budget
  const { wrappers, sessionOnly, bySource: wrapperProvenance, elements: wrapperElements } = resolveWrapperSources(wrapperSources, session);
  const { result, report, perRuleCoverage, filesWithAnyRuleEvaluated } = runScan(
    buildRunScanOptions({
      activeRules,
      enabled,
      files,
      level: session.config.level,
      attestations,
      processes,
      wrapperElements,
      session,
      ...(cwd === undefined ? {} : { scanRoot: cwd }),
    }),
  );
  const { violations: withoutWrapperNoise } = dropWrapperNoise(result.violations, wrappers);
  const unusedWrappers = await resolveUnusedWrappers(wrappers, files, cwd);
  const severityFiltered = filterBySeverity(withoutWrapperNoise, minSeverity);
  // collapse identical findings
  // that repeat across sibling files sharing a basename (canonical case:
  // `bootstrap.css` / `animate.css` copied into 100+ template
  // subdirectories of a website-template catalog) into one canonical
  // finding per (basename, ruleId, patternId ?? message) bucket, with a
  // `vendorOccurrences: [{ path, line }, …]` sibling list on the
  // canonical finding. Surface-don't-suppress: every collapsed copy is
  // fully enumerable via the occurrences list, so the headline drop is
  // honest (agent sees one canonical finding naming N paths instead of N
  // rows of the same bug). Runs BEFORE the criterion-skip filter so
  // skip-by-criterion semantics operate on the post-dedupe stream.
  const deduped = collapseVendorCssFindings(severityFiltered);
  const filtered = applyCriterionSkip(deduped, skipCriteria);
  const grouped = groupViolationsByFile(filtered);
  // thread per-file source
  // into `buildAgentFinding` so `fix.oldText` / `fix.newText` widen via
  // `widenToUniqueAnchor` — matching the shape `suggest_fix` emits on
  // `primary.edit`. Without this, a rule whose minimal mechanical edit
  // is a short literal that repeats across the file (e.g. the bare
  // 4-char `<label>` produced by `forms/label-adjacent-unassociated`
  // for each of N orphan-label findings) ships an `apply_fix`-clobber
  // hazard the agent can't see from the response shape alone. Sibling
  // language tag drives per-finding `snippet` auto-population (V1-
  // FINDINGS-SNIPPET-FIELD-OMITTED-ON-SCAN-SURFACES) so scan-family
  // findings ship the same ±3-line context window checklist candidates
  // already carry.
  const entriesByPath = new Map<string, SourceEntry>(
    files.map((f) => [f.filePath, { source: f.source, language: f.ast.language }]),
  );
  const fileEntries = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, violations]) => {
      const entry = entriesByPath.get(path);
      return {
        path,
        findings: violations.map((v) =>
          buildAgentFinding(v, {
            suppressPlacement: "omit",
            ...(entry === undefined ? {} : { source: entry.source, language: entry.language }),
          }),
        ),
      };
    });

  const violations = filtered.filter((v) => v.severity !== "info");
  const notes = filtered.filter((v) => v.severity === "info");
  // Honest counters for the plan headline, computed from the source
  // violations via the shared helpers in `build-plan.ts` — same recipe
  // the CLI agent formatter uses through `buildAgentPlan`.
  //   - `editsWithInlineFixPath`: violations that ship an inline
  //     `fixPaths.primary.edit` — apply-fix batch-apply work across
  //     the mechanical + verify-in-source lanes. Internal to the
  //     `violationsWithoutAnyFix` derivation; NOT surfaced on the
  //     plan after Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT —
  //     the former `safeEditsAvailable` composite disagreed with
  //     `fixesByClass.mechanical` by up to 18× on real responses, so
  //     it was dropped; the per-lane `fixesByClass` carries the
  //     honest signal, and agents sum
  //     `fixesByClass.mechanical + fixesByClass.verifyInSource` when
  //     they want the apply-now subset.
  //   - `proseOnlySuggestions`: violations with prose `suggestion` but
  //     no inline edit. Internal to the `violationsWithoutAnyFix`
  //     math; NOT exposed on the plan because it sums across four
  //     `fixClass` lanes and is therefore not honest on its own. Per-
  //     lane budgeting rides on `plan.fixesByClass` below.
  const { editsWithInlineFixPath, proseOnlySuggestions } = countFixes(violations);
  const violationsWithoutAnyFix = violations.length - editsWithInlineFixPath - proseOnlySuggestions;
  // Tally violations by their rule-level `fixClass` lane — surfaces as
  // the structured `plan.fixesByClass` per-lane sibling the agent
  // reads for honest per-lane budgeting. The former `plan.summary`
  // prose blurb (which embedded the same lane breakdown as a
  // parenthetical) was dropped per
  // `docs/kb/architecture/ai-first-consumer.md` "Composite headline
  // counts are dishonest"; the structured tally is now the single
  // surface.
  // Distinct axis from the internal `editsWithInlineFixPath`: that
  // answers "does the Violation ship a ready-to-apply edit?"; this
  // answers "which remediation lane does the rule route into?". Per
  // CLAUDE.md §1 "Composite headline counts are dishonest," the two
  // axes stay separate — summing prose-only findings across
  // `guidance`, `runtime-only`, and `verify-in-source` under one
  // counter would be the dishonest shape this split replaces.
  const fixesByClass = countFixesByClass(violations);

  // Plan-side split: grounded candidates (file:line) vs.
  // bare-criterion prompts. Routes through `tallyManualCriteria` so the
  // count agrees with `coverage[].untargetedCriteria` and
  // `checklist.summary.untargetedCriteria` on the same input — see
  // `docs/kb/architecture/ai-first-consumer.md` §"Cross-surface count
  // invariant" and `tests/integration/mcp-counts-agree.test.ts`. Per
  // CLAUDE.md §1 "Composite headline counts are dishonest" we ship two
  // top-level counters so the budget lands honestly:
  //   - actionableManualItems: candidates with file:line
  //   - untargetedCriteria:    bare-criterion prompts (no grounding)
  // The pre-helper recipe used `collectManualCriteria` which kept fired
  // metadata-manual criteria in the manual queue; coverage and checklist
  // route them into the failing lane, and the off-by-N drift was
  // exactly that asymmetry.
  const tally = tallyManualCriteria({
    standards: session.registry.standards,
    enabledStandards: enabled,
    level: session.config.level,
    scanResult: result,
    applicability: detectApplicability(files),
    candidates: report.candidates ?? [],
  });
  const actionableManual = tally.actionable;
  const untargetedCriteria = tally.untargeted;
  const suppressions = suppressionAudit(files);
  // Findings keep their `fix.description` inline here. The optional
  // hoist (see
  // `src/mcp/reference-guide.ts`'s `hoistFixDescriptions`) runs per-
  // tool at response-assembly time so it reflects the *final* findings
  // array — post-pagination for scan_project, post-hunk/baseline-filter
  // for scan_diff — rather than the scan-wide pre-filter shape. Doing
  // the hoist upstream here would force downstream filters to know how
  // to repair pointers when duplicates drop below the threshold, which
  // is more moving parts than it's worth.
  const referenceGuide = buildReferenceGuide(fileEntries);
  // route the per-rule
  // coverage rows through the parse-error adjustment once, then feed
  // the same adjusted view to both the meta block and the top-level
  // `ruleCoverage` derivative. Without this, a row downgraded to
  // `"low"` in `meta.perRuleCoverage` would still surface in
  // `ruleCoverage.confidentlyClean` (which branches on
  // `coverageConfidence === "high"`) — the canonical cross-surface
  // drift the AI-first doctrine warns against. The helper is a no-op
  // fast path when the scan has no parse-error / partial-parse files,
  // so the common case pays nothing.
  // Two distinct path sets — the doctrine difference is load-bearing.
  // `violationFilePaths` (rules-only) feeds {@link applyParseErrorAdjustment}:
  // a per-rule coverage row's confidence may only be downgraded by
  // evidence the same rule would have produced (review candidates come
  // from finders, not rules — including them here would unfoundedly
  // downgrade rule rows). `outputFilePaths` (rules ∪ finders) feeds the
  // `parseErrorFiles` vs `partialParseFiles` split in
  // {@link buildAnalysisCoverage}: that bucket is doctrine for "did
  // anything emerge from this file?", and a file with grounded review
  // candidates from a source-text finder must NOT land in the
  // `invisible-to-rules` bucket.
  //
  // Cross-surface invariant: both sets are derived from the raw
  // scanner output (`result.violations`, `report.candidates`) — NOT
  // the post-filter `filtered` view. The `coverage` and `checklist`
  // tools take the same raw view (they apply no severity / criterion-
  // skip / wrapper-noise filters before computing their parseError
  // split), so deriving the scan-confidence telemetry from the same
  // raw scanner output is the only way `analysisCoverage.parseErrorFileCount`
  // agrees across all three project-rooted surfaces on identical
  // input. The post-filter shape is what the consumer reads on
  // `files[]`/`plan`; the parser/finder honesty signal is upstream
  // of the consumer-facing filters.
  const violationFilePaths = new Set(result.violations.map((v) => v.location.filePath));
  const outputFilePaths = outputFilePathSet(result.violations, report.candidates ?? []);
  // detect token-only `.scss`
  // partials so the per-rule coverage downgrade and the response-level
  // `scss_unresolved_variables` warning agree on the same file list.
  const scssUnresolvedFiles = detectScssUnresolvedVariableFiles(files);
  // same chain order
  // as `response-assembler` so every project-rooted surface
  // (`scan_project`, `scan_file`, `coverage`, `checklist`) feeds the
  // same adjusted view to its meta + derivative consumers. Document-
  // shaped rules (`semantics/landmark-main`, `document/page-titled`,
  // `parsing/html-has-lang`, `semantics/empty-heading`,
  // `document/lang-attribute`, `semantics/heading-hierarchy`) downgrade
  // to `coverageConfidence: "medium"` with
  // `coverageConfidenceReason: "fragment-input-no-document-envelope"`
  // when at least one matching file parsed as a fragment (no
  // `<html>`/`<body>`).
  const fragmentFiles = detectFragmentFiles(files);
  // Disambiguate `eligible === 0` extension-gated rows by probing
  // whether the gated extensions exist anywhere under cwd. Two cases
  // route to different remediations: (a) `extension-absent` — the cwd
  // has no files of this extension at all (current text correct);
  // (b) `extension-present-but-out-of-scope` — files exist but were
  // pruned by `additionalPaths` / `exclude` / `.gitignore` / default
  // build-dir skips, in which case the agent should broaden scope
  // rather than narrow `additionalPaths` further.
  // Cascade mirrors {@link buildSharedPerRuleCoverageMeta}: parse-error
  // → corpus-rate (reads byFile[] from the previous pass) → scss-
  // unresolved → fragment-input → extension-subkind. This chain stays
  // here because the cwd-rooted walk is async.
  const adjustedPerRuleCoverage = await applyExtensionSubkindFromRoot(
    applyFragmentInputAdjustment(
      applyScssUnresolvedVariablesAdjustment(
        applyParseErrorAndCorpusRate(perRuleCoverage, files, activeRules, violationFilePaths),
        files,
        activeRules,
        new Set(scssUnresolvedFiles),
      ),
      files,
      activeRules,
      new Set(fragmentFiles),
    ),
    activeRules,
    cwd,
  );
  // Per-finding confidence parity with per-rule coverage limitations.
  // When a rule's adjusted `coverageConfidence !== "high"`, propagate
  // the structured reason code into every per-finding
  // `couldBeWrongBecause` for that rule so the per-rule and per-finding
  // layers don't ship contradictory attention-budget signals in the
  // same response. Doctrine source:
  // docs/kb/architecture/ai-first-consumer.md "Per-finding confidence
  // must reflect per-rule coverage limitations." Additive — per-finding
  // `confidence` stays whatever the rule emitted; the cross-file caveat
  // the agent needs to triage with rides on the `couldBeWrongBecause`
  // axis. No-op fast path when no rule is degraded.
  const perRuleLimitations = buildPerRuleLimitationMap(adjustedPerRuleCoverage);
  // File-scoped gate: substrate codes (`file_parse_error`,
  // `partial_parse`, `fragment_input_no_document_envelope`) attach
  // only to findings on files in the named substrate set, so per-rule
  // and per-finding layers stay honest about the same file. The
  // `fragment` set mirrors `analysisCoverage.fragmentFiles[]` (shared
  // classifier in `src/engine/layout-partial.ts`) so a finding on a
  // full `.html` document never inherits the fragment code.
  const fileEntriesAfterPerRule = enrichFindingsWithPerRuleLimitations(
    fileEntries,
    perRuleLimitations,
    buildSubstrateFiles(partitionParseStateFiles(files, violationFilePaths), fragmentFiles),
  );
  // Per-LINE granularity sibling of the per-rule pass above: when the
  // parser stamped a 1-based head-error line on a partial-parse file,
  // findings emitted at lines past the boundary live in source the
  // structured parser could not reach. Tag with
  // `beyond_partial_parse_boundary` and downgrade `confidence` to
  // `"low"`. Doctrine source: docs/kb/architecture/ai-first-consumer.md
  // "Parser-failure invalidates per-file confidence" — extended one
  // level deeper. Closure picks downgrade-not-drop per "Surface, don't
  // suppress."
  const enrichedFileEntries = enrichFindingsBeyondPartialParseBoundary(
    fileEntriesAfterPerRule,
    buildParsedThroughLineMap(files),
  );
  // Per-rule trust telemetry. The underlying rows ride
  // in `meta.perRuleCoverage`; the top-level `ruleCoverage` derivative
  // splits the 0-findings rules into "trust the clean tally" vs "scan
  // didn't see any eligible sources" so agents branch on a two-bucket
  // headline rather than walking every row. `filtered` is the
  // post-severity, post-criterion-skip list the consumer actually sees
  // — matching the plan's split `violations` / `notes` counters so a
  // rule silenced by the session's minSeverity filter reads as "0
  // findings for this consumer" here too.
  const ruleCoverageDerivative = buildRuleCoverageDerivative(adjustedPerRuleCoverage, filtered);
  const scanMeta = buildScanMeta({
    filesScanned: result.filesScanned,
    filesWithAnyRuleEvaluated,
    files,
    activeRules,
    durationMs: result.durationMs,
    enabledStandards: result.enabledStandards,
    wrappers,
    sessionOnly,
    unusedWrappers,
    wrapperProvenance,
    wrapperElements,
    verboseMeta,
    preset,
    suppressions,
    perRuleCoverage: adjustedPerRuleCoverage,
    // Derived from the post-filter violation set ∪ review-candidate
    // file paths (same view the consumer sees on `files`/`plan` plus
    // the grounded candidates that surface alongside). Threads into the
    // parse-error split so a file that emitted ANY output (rule
    // violation OR source-text finder candidate) lands in
    // `partialParseFiles` rather than the invisible `parseErrorFiles`
    // bucket — otherwise a file like `modal.mdx` that produced 14
    // findings with live line numbers OR a `livereload.js` whose only
    // surfaced output is `wcag22:2.2.1` setTimeout candidates from
    // `review/timing` would appear in `parseErrorFiles`, reading to the
    // agent as "invisible" and the live output silently ignored
    //.
    findingFilePaths: outputFilePaths,
    ...(discoveryDiagnostics === undefined ? {} : { discoveryDiagnostics }),
  });
  // The cross-surface count tripwire `meta.countsBySurface` was
  // dropped per `docs/kb/architecture/ai-first-consumer.md` "Composite
  // headline counts are dishonest": a 4-way internal spread of
  // disagreeing finding totals (`plan` vs `perRuleCoverage` vs
  // `filesSurface`, each itself a sum across categorically different
  // sub-buckets) was the worst-case shape. Consumers that need
  // cross-surface reconciliation read the structured siblings
  // directly (`plan.fixesByClass`, `meta.perRuleCoverage`, the
  // per-file `findings.length` rollup); the headline summary the
  // tripwire collapsed those into hid the disagreement rather than
  // surfaced it. Deletion is the durable answer (same precedent as
  // `plan.totalFindings` / `plan.safeEditsAvailable` /
  // `plan.violations` / `plan.summary`).
  // `perRuleCoverage` threaded into `buildScanPlan` so the plan can
  // append the structured `external_handler_resolution_unavailable`
  // code when any row carries the cross-file listener-resolution
  // reason. Adjusted rows fine: parse-error / scss / fragment
  // adjustments do not strip the cross-file reason code.
  // biome-ignore format: arg list kept on one line for the file budget
  const planArgs = { violations: violations.length, notes: notes.length, violationsWithoutAnyFix, actionableManual, untargetedCriteria, fixesByClass, perRuleCoverage: adjustedPerRuleCoverage };
  const formatted: ScanFormatted = {
    plan: buildScanPlan(planArgs),
    files: enrichedFileEntries,
    meta: scanMeta,
    ...(referenceGuide === undefined ? {} : { referenceGuide }),
    ...(ruleCoverageDerivative === null ? {} : { ruleCoverage: ruleCoverageDerivative }),
  };

  return {
    formatted,
    durationMs: result.durationMs,
    filesScanned: result.filesScanned,
    reviewCandidates: report.candidates ?? [],
    scssUnresolvedVariableFiles: scssUnresolvedFiles,
    adjustedPerRuleCoverage,
  };
}

/**
 * Re-exported for back-compat with existing imports that source
 * `applyRuleSettings` from `tools-helpers.ts`. New callers should import
 * from `./rules-evaluated.ts` directly — preferring {@link resolveActiveRules}
 * (the session + projectConfig SSOT) over hand-rolled
 * `applyRuleSettings(session.registry.rules, ...)` chains.
 */
export { applyRuleSettings };

// ─── Registry lookups ───────────────────────────────────────────────────────

/**
 * Rule lookup for MCP tools. Resolves the input through the rule-ID
 * alias table before consulting the
 * registry so explicit callers (e.g. `explain_rule`, `suggest_fix`,
 * `suppress`) accept the old ID of a renamed rule for the duration of
 * its alias window. The return shape is unchanged; tools that need to
 * surface the `deprecated_rule_id:<old>:<new>` warning call
 * {@link findRuleWithAlias} instead.
 */
export function findRule(ruleId: string, session: McpSession): Rule | undefined {
  const { resolved } = resolveRuleId(ruleId);
  return session.registry.findRule(resolved);
}

/**
 * Alias-aware companion to {@link findRule}. Returns the resolved rule
 * plus the alias record when the input was an old ID the table
 * rewrote. Callers surfaced on response envelopes (`explain_rule`,
 * `suggest_fix`, `suppress`) use this form so they can attach the
 * `deprecated_rule_id:<from>:<to>` warning when the rewrite fires.
 */
export function findRuleWithAlias(
  ruleId: string,
  session: McpSession,
): { readonly rule?: Rule; readonly deprecated?: RuleAlias } {
  const resolution = resolveRuleId(ruleId);
  const rule = session.registry.findRule(resolution.resolved);
  return {
    ...(rule === undefined ? {} : { rule }),
    ...(resolution.deprecated === undefined ? {} : { deprecated: resolution.deprecated }),
  };
}

export function findStandard(standardId: string, session: McpSession): Standard | undefined {
  return session.registry.findStandard(standardId);
}

/**
 * IDs of every rule registered on the session that satisfies the given
 * criterion, including equivalence closure across loaded standards. Used
 * by MCP tools that need to disclose or validate per-rule coverage claims
 * (see ADR 0013) — the `attest` tool fans a criterion-wide attestation
 * across this set, and validates that explicit `ruleIds` actually satisfy
 * the criterion.
 *
 * Does not apply session rule overrides; an `"off"` rule still satisfies
 * the criterion in principle, and the coverage fan-out reflects the rule
 * surface at check-time, not this call's config. Routes through
 * `session.registry.rulesForCriterion` (ADR 0022) so plugin-registered
 * rules count too.
 */
export function satisfyingRulesForCriterion(
  criterionId: string,
  session: McpSession,
): readonly string[] {
  return session.registry
    .rulesForCriterion(criterionId)
    .map((r) => r.id)
    .slice()
    .sort();
}

/**
 * Drops info-level keyboard/handler-missing findings whose target component
 * is in the allowlist. The rule's message starts with `<ComponentName>`, so
 * we pull the name from the message rather than adding a new Violation field.
 * If the message shape ever drifts, the list stops working — fail-safe: we
 * keep the finding rather than dropping a real bug.
 *
 * Also reports which wrappers actually matched something, so callers can
 * surface stale entries that no longer correspond to any component in the
 * codebase.
 */
export function dropWrapperNoise(
  violations: readonly Violation[],
  nativeWrappers: readonly string[],
): { readonly violations: readonly Violation[] } {
  if (nativeWrappers.length === 0) {
    return { violations };
  }
  const filtered = violations.filter((v) => {
    if (v.ruleId !== "keyboard/handler-missing") return true;
    if (v.severity !== "info") return true;
    const match = /^<([A-Z][A-Za-z0-9]*)>/.exec(v.message);
    const name = match?.[1];
    return !(name && nameMatchesAnyWrapper(name, nativeWrappers));
  });
  return { violations: filtered };
}

// ─── Severity filtering ─────────────────────────────────────────────────────

const SEVERITY_RANK: Readonly<Record<string, number>> = { error: 3, warning: 2, info: 1 };

export function filterBySeverity(
  violations: readonly Violation[],
  minSeverity: string | undefined,
): readonly Violation[] {
  const minRank = SEVERITY_RANK[minSeverity ?? "info"] ?? 1;
  if (minRank <= 1) return violations;
  return violations.filter((v) => (SEVERITY_RANK[v.severity] ?? 1) >= minRank);
}

/**
 * Caller-driven criterion filter. A violation is dropped when every
 * criterion in its `criteria` list appears in `skipCriteria`; otherwise
 * it stays — the un-skipped criteria are the honest reason to keep
 * showing the finding. `undefined` or empty skip list returns the
 * input unchanged. Not suppression by the tool — the caller is
 * filtering its own result.
 */
export function applyCriterionSkip(
  violations: readonly Violation[],
  skipCriteria: readonly string[] | undefined,
): readonly Violation[] {
  if (skipCriteria === undefined || skipCriteria.length === 0) return violations;
  const skip = new Set(skipCriteria);
  return violations.filter((v) => v.criteria.some((c) => !skip.has(c)));
}

// ─── Source context ─────────────────────────────────────────────────────────

export function buildSourceContext(source: string, line: number): string {
  const lines = source.split("\n");
  const contextRadius = 3;
  const start = Math.max(0, line - 1 - contextRadius);
  const end = Math.min(lines.length, line + contextRadius);
  return lines.slice(start, end).join("\n");
}

export { buildReferenceGuide };

export function groupViolationsByFile(violations: readonly Violation[]): Map<string, Violation[]> {
  const map = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = map.get(v.location.filePath);
    if (list) list.push(v);
    else map.set(v.location.filePath, [v]);
  }
  return map;
}
