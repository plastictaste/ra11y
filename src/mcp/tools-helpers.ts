/**
 * Shared helpers for MCP tool handlers — param extraction, result
 * construction, scanner adapters, and finding formatting.
 *
 * Kept separate from tools.ts so the tool-definition file stays focused
 * on tool schemas and handler logic.
 */

import { isAbsolute, resolve } from "node:path";
import { readAttestations } from "../config/attestation-store.ts";
import { type ParsedFile, runScan } from "../engine/scanner.ts";
import {
  type DiscoveryDiagnostics,
  discoverExplicitPaths,
  discoverFilesWithDiagnostics,
} from "../input/discover.ts";
import {
  type AgentFinding,
  buildAgentFinding,
  countFixes,
  countFixesByClass,
} from "../output/agent-response/index.ts";
import type { Rule } from "../types/rule.ts";
import type { Standard } from "../types/standard.ts";
import type { Violation } from "../types/violation.ts";
import { detectApplicability, isLikelyIrrelevant } from "./manual-applicability.ts";
import { buildReferenceGuide } from "./reference-guide.ts";
import { buildRuleCoverageDerivative } from "./rule-coverage-derivative.ts";
import { applyRuleSettings } from "./rules-evaluated.ts";
import {
  buildScanMeta,
  buildScanPlan,
  sumFindingsAcrossFiles,
  sumFindingsEmitted,
  withCountsBySurface,
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
  | "edit-multiple-matches"
  | "edit-introduces-parse-errors"
  // meta-tool internal
  | "audit-sub-tool-unparseable"
  // audit meta-tool: one of the sub-handlers rejected instead of
  // returning an McpToolResult. Distinct from -unparseable so agents
  // can tell "handler threw" from "handler answered with garbage."
  | "audit-sub-tool-threw";

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
 * use this to surface the silent-miss case (V1-DETECT-SILENT-EXT)
 * where a mixed-language repo contributes hundreds of `.astro` /
 * `.scss` / `.vue` files that the scanner never looked at.
 */
export async function parseFilesWithDiagnostics(
  paths: readonly string[],
  session: McpSession,
  cwd?: string,
  options: { readonly includeStoryFiles?: boolean } = {},
): Promise<{
  readonly files: readonly ParsedFile[];
  readonly diagnostics: DiscoveryDiagnostics;
}> {
  const base = cwd ?? process.cwd();
  const absPaths = paths.map((p) => (isAbsolute(p) ? p : resolve(base, p)));
  const { files: discovered, diagnostics } = await discoverFilesWithDiagnostics(absPaths, {
    excludes: session.config.exclude,
    ...(options.includeStoryFiles === true ? { includeStoryFiles: true } : {}),
  });
  const parsed: ParsedFile[] = [];
  for (const filePath of discovered) {
    const result = await session.parseFile(filePath, cwd);
    if (result) parsed.push(result);
  }
  return { files: parsed, diagnostics };
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

/**
 * Extracts `{ [ruleId]: "error"|"warning"|"info"|"off" }` from the configure
 * tool's params. Keeps the configure handler pure over its Record input
 * while narrowing to the RuleSetting union.
 */
function readRuleSettings(
  params: Record<string, unknown>,
): Readonly<Record<string, "error" | "warning" | "info" | "off">> | undefined {
  const raw = (params as { rules?: unknown }).rules;
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, "error" | "warning" | "info" | "off"> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === "error" || value === "warning" || value === "info" || value === "off") {
      out[key] = value;
    }
  }
  return out;
}

/** Builds the opts object for McpSession.configure from the configure tool's params. */
export interface ConfigureOpts {
  standard?: string;
  level?: "A" | "AA" | "AAA";
  exclude?: readonly string[];
  rules?: Readonly<Record<string, "error" | "warning" | "info" | "off">>;
  nativeWrappers?: readonly string[];
  /**
   * Wrapper → native-element map. Mirrors
   * `LoadedConfig.nativeWrapperElements` on the file-loaded side so the
   * object form of `Config.nativeWrappers` can round-trip through MCP.
   */
  nativeWrapperElements?: Readonly<Record<string, string>>;
  /**
   * Absolute path of the project the wrappers apply to. Forwarded
   * verbatim to `McpSession.configure` so the session records it as
   * the wrapper anchor; later scans against a different root surface
   * the mismatch via `session_wrappers_configured_for_different_cwd`.
   */
  cwd?: string;
  allowWrite?: boolean;
}

/**
 * Reads the `nativeWrappers` param in either the flat array form
 * (`["Button", "Link"]`) or the flat object form
 * (`{ Button: "button", Link: "a" }`). Returns a split tuple so the
 * session `configure()` call receives each branch through its own
 * typed channel (names accumulate into `nativeWrappers`; the element
 * map populates `nativeWrapperElements`). The nested `NativeWrapperMap`
 * form accepted on the file-loader side is deliberately NOT parsed
 * here — nesting is compile-time ergonomics for authors editing a
 * config file, not a shape MCP callers need to emit. Agents with a
 * compound-component map flatten the dotted keys themselves, which
 * keeps the MCP schema flat and unambiguous.
 */
function readNativeWrappersParam(params: Record<string, unknown>): {
  readonly names?: readonly string[];
  readonly elements?: Readonly<Record<string, string>>;
} {
  const raw = params["nativeWrappers"];
  if (raw === undefined) return {};
  if (Array.isArray(raw)) {
    return { names: raw.filter((v): v is string => typeof v === "string") };
  }
  if (typeof raw === "object" && raw !== null) {
    const elements: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") elements[key] = value;
    }
    return { names: Object.keys(elements), elements };
  }
  return {};
}

/**
 * Discriminated result from `buildConfigureOpts`: either the validated
 * options (on success) or a {@link StructuredError} ready for
 * `errorResult` (on a type mismatch the caller can still fix from the
 * response alone). The security-load-bearing case today is
 * `allowWrite` — a string `"true"` or a number `1` used to silently
 * fall through to the typeof-boolean guard and leave the gate at its
 * prior value, so the caller saw `allowWrite:false` in the echoed
 * active config and had no way to distinguish "I was dropped" from
 * "the setting was already off". See AI-first doctrine: silent drops
 * are dishonest at the field level. Other string-typed params already
 * surface naturally (an unknown `level` falls through to the session's
 * current `AA`, which the handler re-echoes) — the discriminated shape
 * is here so future validation has a shared home.
 */
export type ConfigureOptsResult =
  | { readonly ok: true; readonly opts: ConfigureOpts }
  | { readonly ok: false; readonly error: StructuredError };

export function buildConfigureOpts(params: Record<string, unknown>): ConfigureOptsResult {
  const opts: ConfigureOpts = {};
  const standard = strParam(params, "standard");
  const level = strParam(params, "level") as "A" | "AA" | "AAA" | undefined;
  const exclude = strArrayParam(params, "exclude");
  const rules = readRuleSettings(params);
  const { names: nativeWrappers, elements: nativeWrapperElements } =
    readNativeWrappersParam(params);
  const cwd = strParam(params, "cwd");
  // `allowWrite` — surface a structured error when the caller sent the
  // key but with the wrong JSON type (e.g. `"true"` or `1`). Silently
  // dropping would return `active.allowWrite:false` as if the gate had
  // never been flipped, which is indistinguishable from "I never asked
  // to flip it" on the response side — the canonical ambiguous-success
  // failure mode the AI-first doctrine warns against. Absent key stays
  // absent (no coercion of missing-to-false).
  const hasAllowWrite = Object.hasOwn(params, "allowWrite");
  const allowWriteRaw = params["allowWrite"];
  if (hasAllowWrite && typeof allowWriteRaw !== "boolean") {
    return {
      ok: false,
      error: {
        code: "invalid-param",
        message:
          "`allowWrite` must be a boolean (`true` or `false`). Non-boolean values are rejected rather than silently dropped so the session's write gate reflects what the host asked for.",
        details: { param: "allowWrite", received: typeof allowWriteRaw },
        remediation:
          "Send `allowWrite: true` (JSON boolean) to unlock `apply_fix` / `suppress` / `attest`, or omit the field to leave the current setting untouched.",
      },
    };
  }
  if (standard !== undefined) opts.standard = standard;
  if (level !== undefined) opts.level = level;
  if (exclude !== undefined) opts.exclude = exclude;
  if (rules !== undefined) opts.rules = rules;
  if (nativeWrappers !== undefined) opts.nativeWrappers = nativeWrappers;
  if (nativeWrapperElements !== undefined) opts.nativeWrapperElements = nativeWrapperElements;
  if (cwd !== undefined) opts.cwd = cwd;
  if (typeof allowWriteRaw === "boolean") opts.allowWrite = allowWriteRaw;
  return { ok: true, opts };
}

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
 * which is a claim static analysis can't make. `plan.summary` and the
 * counts in `plan` convey the state without a load-bearing boolean.
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
   * `{ [ruleId]: { [hash]: description } }` map populated when the same
   * `(ruleId, fix.description)` pair appears on ≥2 findings in the
   * response, so the prose hoists once to the top level instead of
   * repeating per-finding. Hoisted findings carry
   * `fixDescriptionRef: { hash }` and omit `fix.description`; findings
   * with unique-in-response descriptions keep the inline text. Omitted
   * entirely when no duplicates cross the threshold (present-when-
   * meaningful per CLAUDE.md §1). See
   * V1-SIZE-RESPONSE-BUDGET-DENSITY and the
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
  // response-level `extensions_skipped_no_parser` warning fires. Omit
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
}> {
  const effective = ruleSettings ?? session.config.rules;
  const activeRules = applyRuleSettings(session.registry.rules, effective);
  const attestations = await loadDurableAttestations(cwd ?? process.cwd());
  const {
    wrappers,
    sessionOnly,
    bySource: wrapperProvenance,
    elements: wrapperElements,
  } = resolveWrapperSources(wrapperSources, session);
  const { result, report, perRuleCoverage } = runScan(
    buildRunScanOptions({
      activeRules,
      enabled,
      files,
      level: session.config.level,
      attestations,
      processes,
      wrapperElements,
      session,
    }),
  );
  const { violations: withoutWrapperNoise } = dropWrapperNoise(result.violations, wrappers);
  const unusedWrappers = await resolveUnusedWrappers(wrappers, files, cwd);
  const severityFiltered = filterBySeverity(withoutWrapperNoise, minSeverity);
  // Q6-CONTRAST-VENDOR-CSS-CROSS-FILE-DEDUPE: collapse identical findings
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
  const fileEntries = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, violations]) => ({
      path,
      findings: violations.map((v) => buildAgentFinding(v, { suppressPlacement: "omit" })),
    }));

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
  // Tally violations by their rule-level `fixClass` lane. Two consumers:
  //   1. `plan.fixesByClass` — structured per-lane tally the agent
  //      reads for honest per-lane budgeting.
  //   2. `plan.summary` parenthetical — prose breakdown by lane.
  // Distinct axis from the internal `editsWithInlineFixPath`: that
  // answers "does the Violation ship a ready-to-apply edit?"; this
  // answers "which remediation lane does the rule route into?". Per
  // CLAUDE.md §1 "Composite headline counts are dishonest," the two
  // axes stay separate — summing prose-only findings across
  // `guidance`, `runtime-only`, and `verify-in-source` under one
  // counter would be the dishonest shape this split replaces.
  const fixesByClass = countFixesByClass(violations);
  const fixClassCounts = {
    mechanical: fixesByClass.mechanical,
    guidance: fixesByClass.guidance,
    "runtime-only": fixesByClass.runtimeOnly,
    "verify-in-source": fixesByClass.verifyInSource,
  };

  const manualIds = collectManualCriteria(enabled, session, session.config.level, files);
  const manualCount = manualIds.size;
  // Actionable = manual criteria that a finder grounded in a concrete
  // file:line. Before the split, `plan.manualReviewRequired` summed
  // grounded candidates and bare-criterion prompts into a single
  // inflated headline (e.g. 21), forcing agents to budget against the
  // bigger number when only the actionable subset (e.g. 5) was real
  // work. Per CLAUDE.md §1 "Composite headline counts are dishonest,"
  // we ship two top-level counters so the budget lands honestly:
  //   - actionableManualItems: candidates with file:line
  //   - untargetedCriteria:    bare-criterion prompts (no grounding)
  const actionableManualIds = new Set<string>();
  for (const c of report.candidates ?? []) {
    if (manualIds.has(c.criterionId)) actionableManualIds.add(c.criterionId);
  }
  const actionableManual = actionableManualIds.size;
  const untargetedCriteria = manualCount - actionableManual;
  const suppressions = suppressionAudit(files);
  // Findings keep their `fix.description` inline here. The optional
  // V1-SIZE-RESPONSE-BUDGET-DENSITY hoist (see
  // `src/mcp/reference-guide.ts`'s `hoistFixDescriptions`) runs per-
  // tool at response-assembly time so it reflects the *final* findings
  // array — post-pagination for scan_project, post-hunk/baseline-filter
  // for scan_diff — rather than the scan-wide pre-filter shape. Doing
  // the hoist upstream here would force downstream filters to know how
  // to repair pointers when duplicates drop below the threshold, which
  // is more moving parts than it's worth.
  const referenceGuide = buildReferenceGuide(fileEntries);
  // Per-rule trust telemetry (Q2R2-RULE-COV). The underlying rows ride
  // in `meta.perRuleCoverage`; the top-level `ruleCoverage` derivative
  // splits the 0-findings rules into "trust the clean tally" vs "scan
  // didn't see any eligible sources" so agents branch on a two-bucket
  // headline rather than walking every row. `filtered` is the
  // post-severity, post-criterion-skip list the consumer actually sees
  // — matching the plan's split `violations` / `notes` counters so a
  // rule silenced by the session's minSeverity filter reads as "0
  // findings for this consumer" here too.
  const ruleCoverageDerivative = buildRuleCoverageDerivative(perRuleCoverage, filtered);
  const scanMeta = buildScanMeta({
    filesScanned: result.filesScanned,
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
    perRuleCoverage,
    // Derived from the post-filter violation set (same view the
    // consumer sees on `files`/`plan`). Threads into the parse-error
    // split so a file that emitted findings lands in
    // `partialParseFiles` rather than the invisible `parseErrorFiles`
    // bucket — otherwise a file like `modal.mdx` that produced 14
    // findings with live line numbers would also appear in
    // `parseErrorFiles`, reading to the agent as "invisible" and
    // the findings are silently ignored.
    findingFilePaths: new Set(filtered.map((v) => v.location.filePath)),
    ...(discoveryDiagnostics === undefined ? {} : { discoveryDiagnostics }),
  });
  // V1-META-COUNTS-BY-SURFACE-REGRESSION: every scan-family consumer
  // of `runScanAndFormat` (scan_project, scan_diff, plus downstream
  // CLI / derivative-report callers) must see the three-totals
  // tripwire, not just the `assembleScanFamilyResponse` path that
  // `scan` / `scan_file` flow through. The filters between
  // `perRuleCoverage` (scanner-raw) and the `plan`/`files` surface
  // (post wrapper-noise drop, severity, criterion-skip, vendor
  // dedupe) eat findings the per-rule rows still count; stamp the
  // triple here so the drift is always visible when present. The
  // `filesSurface` figure reflects `fileEntries` pre-pagination /
  // pre-token-density-trim — downstream response assemblers
  // (`assembleScanProjectResponse`, `scan_diff`'s hoist path,
  // `assembleScanFamilyResponse`'s own stamper) re-call
  // {@link withCountsBySurface} with the post-trim filesSurface when
  // truncation fires, so the final wire shape is always in sync with
  // what actually ships. Idempotent on meta when the three totals
  // agree (the helper spreads an empty record).
  const formatted: ScanFormatted = {
    plan: buildScanPlan({
      violations: violations.length,
      notes: notes.length,
      violationsWithoutAnyFix,
      actionableManual,
      untargetedCriteria,
      fixClassCounts,
      fixesByClass,
    }),
    files: fileEntries,
    meta: withCountsBySurface(scanMeta, {
      plan: violations.length + notes.length,
      perRuleCoverage: sumFindingsEmitted(perRuleCoverage),
      filesSurface: sumFindingsAcrossFiles(fileEntries),
    }),
    ...(referenceGuide === undefined ? {} : { referenceGuide }),
    ...(ruleCoverageDerivative === null ? {} : { ruleCoverage: ruleCoverageDerivative }),
  };

  return {
    formatted,
    durationMs: result.durationMs,
    filesScanned: result.filesScanned,
    reviewCandidates: report.candidates ?? [],
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

export function findRule(ruleId: string, session: McpSession): Rule | undefined {
  return session.registry.findRule(ruleId);
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
    if (list) {
      list.push(v);
    } else {
      map.set(v.location.filePath, [v]);
    }
  }
  return map;
}

export { buildPlanSummary, type PlanSummaryArgs } from "./plan-summary.ts";
