/**
 * Internals for the `apply_fix` MCP tool — kept separate from
 * `tool-apply-fix.ts` so each file stays under the reviewable-size cap
 * and the main tool file reads as "what this tool does" without
 * drowning in path-validation and delta-diffing helpers.
 *
 * Public from this module: the preflight validator (`preflightValidate`),
 * the post-edit scanner (`runSingleFileScan`), the violation/candidate
 * delta (`computeDelta`), the parse-error envelope builder, the slice
 * formatter, and the `nextStep` string builder.
 *
 * The preflight collapses six guard branches (allowWrite → file →
 * cwd-escape → edit shape → extension → search-hit count) into one
 * discriminated union so the handler can early-return via a single
 * `if ("error" in preflight)` check. Each envelope wording is exact
 * because the integration tests grep for it.
 */

import { fingerprintOf } from "../engine/baseline.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import { runScan } from "../engine/scanner.ts";
import {
  parseAstro,
  parseCss,
  parseHtml,
  parseLess,
  parseMarkdown,
  parseMdx,
  parseScss,
  parseSvg,
  parseTsx,
} from "../input/parsers/index.ts";
import { buildAgentFinding } from "../output/agent-response/index.ts";
import type { Ast, ParseError } from "../types/ast.ts";
import type { ReviewCandidate } from "../types/review.ts";
import type { Rule } from "../types/rule.ts";
import type { Violation } from "../types/violation.ts";
import { resolveInsideCwd } from "./resolve-inside-cwd.ts";
import type { McpSession } from "./session.ts";
import { errorResult, type McpToolResult, strParam } from "./tools-helpers.ts";

export interface ResolvedEdit {
  readonly oldText: string;
  readonly newText: string;
}

export type Ext =
  | "tsx"
  | "html"
  | "css"
  | "scss"
  | "less"
  | "mdx"
  | "astro"
  | "markdown"
  | "svg"
  | "erb";

export interface SingleFileScan {
  readonly violations: readonly Violation[];
  readonly candidates: readonly ReviewCandidate[];
  /**
   * Per-rule coverage for the scan. Surfaced so `apply_fix` can
   * assemble an honest `rulesEvaluated: { loaded, withEligibleInputs,
   * fired }` meta field on the response from the post-edit scan state
   * (Q4-RULES-EVALUATED-COMPOSITE).
   */
  readonly perRuleCoverage: readonly import("../types/violation.ts").PerRuleCoverage[];
}

export interface FixDelta {
  readonly resolvedViolations: readonly Violation[];
  readonly newViolations: readonly Violation[];
  readonly resolvedCandidates: readonly ReviewCandidate[];
  readonly newCandidates: readonly ReviewCandidate[];
}

export interface PreflightOk {
  readonly resolved: string;
  readonly cwd: string;
  readonly edit: ResolvedEdit;
  readonly ext: Ext;
  readonly original: ParsedFile;
  readonly dryRun: boolean;
}

export type PreflightResult = PreflightOk | { readonly error: McpToolResult };

export async function preflightValidate(
  params: Record<string, unknown>,
  session: McpSession,
): Promise<PreflightResult> {
  if (!session.config.allowWrite) {
    return {
      error: errorResult({
        code: "allow-write-disabled",
        message:
          "apply_fix is disabled: session `allowWrite` flag is false. Call `sessionConfigure` with `{ allowWrite: true }` to enable write access for this session, then retry. The flag is per-session and off by default so no ra11y tool mutates source without explicit host opt-in.",
        remediation: "Call `sessionConfigure` with `{ allowWrite: true }`, then retry apply_fix.",
      }),
    };
  }
  const filePathParam = strParam(params, "file");
  if (!filePathParam || filePathParam.length === 0) {
    return {
      error: errorResult({
        code: "missing-required-param",
        message: "file is required and must be a non-empty string.",
        details: { param: "file" },
      }),
    };
  }
  const cwd = strParam(params, "cwd") ?? process.cwd();
  const resolved = await resolveInsideCwd(filePathParam, cwd);
  if (resolved === null) {
    return {
      error: errorResult({
        code: "path-escapes-cwd",
        message: `file '${filePathParam}' escapes cwd '${cwd}'. Every writable path must resolve inside the scan root.`,
        details: { file: filePathParam, cwd },
      }),
    };
  }
  const edit = readEdit(params);
  if (edit === null) {
    return {
      error: errorResult({
        code: "edit-shape-invalid",
        message:
          'edit must be an object with string `oldText` and string `newText` — the shape suggest_fix emits on `kind: "edit"`.',
        remediation: 'Pass `primary.edit` from a `suggest_fix` result whose `kind` is "edit".',
      }),
    };
  }
  const dryRun = params["dryRun"] !== false;
  const ext = extensionOf(resolved);
  if (ext === null) {
    return {
      error: errorResult({
        code: "file-unsupported",
        message: `Unsupported file extension for ${resolved}. apply_fix handles .tsx/.ts/.jsx/.js, .html/.htm, and .css only.`,
        details: { filePath: resolved },
      }),
    };
  }
  const original = await readOriginal(session, resolved, cwd);
  if ("error" in original) return original;
  const matchCount = countOccurrences(original.parsed.source, edit.oldText);
  if (matchCount === 0) {
    return { error: noMatchEnvelope(resolved, original.parsed.source, edit.oldText) };
  }
  if (matchCount > 1) {
    return {
      error: errorResult({
        code: "edit-multiple-matches",
        message: `Edit's oldText matches ${matchCount} locations in ${resolved}. apply_fix requires a unique match so the edit can't silently misapply. Widen oldText with surrounding context from suggest_fix's sourceContext and retry.`,
        details: { filePath: resolved, matchCount },
        remediation:
          "Widen `oldText` with disambiguating context from `suggest_fix.sourceContext` so exactly one match remains.",
      }),
    };
  }
  return { resolved, cwd, edit, ext, original: original.parsed, dryRun };
}

async function readOriginal(
  session: McpSession,
  resolved: string,
  cwd: string,
): Promise<{ readonly parsed: ParsedFile } | { readonly error: McpToolResult }> {
  try {
    const parsed = await session.parseFile(resolved, cwd);
    if (!parsed) {
      return {
        error: errorResult({
          code: "file-unsupported",
          message: `Unsupported or unreadable file: ${resolved}`,
          details: { filePath: resolved },
        }),
      };
    }
    return { parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: errorResult({
        code: "file-read-failed",
        message: `Failed to read ${resolved}: ${message}`,
        details: { filePath: resolved, cause: message },
      }),
    };
  }
}

/**
 * Runs the scanner against a single pre-parsed file. Apply_fix scans
 * both the original (from the session cache) and the in-memory
 * post-edit file through this helper so both slices come from an
 * identical rule/finder/level configuration — the delta can be
 * trusted to reflect the edit, not a config drift between passes.
 */
export function runSingleFileScan(
  file: ParsedFile,
  rules: readonly Rule[],
  enabled: readonly string[],
  level: "A" | "AA" | "AAA",
  session: McpSession,
): SingleFileScan {
  const { result, report, perRuleCoverage } = runScan({
    standards: session.registry.standards,
    rules,
    enabled,
    files: [file],
    finders: session.registry.finders,
    level,
  });
  return {
    violations: result.violations,
    candidates: report.candidates ?? [],
    perRuleCoverage,
  };
}

export function computeDelta(before: SingleFileScan, after: SingleFileScan): FixDelta {
  const beforeHashes = new Set(before.violations.map(fingerprintViolation));
  const afterHashes = new Set(after.violations.map(fingerprintViolation));
  const resolvedViolations = before.violations.filter(
    (v) => !afterHashes.has(fingerprintViolation(v)),
  );
  const newViolations = after.violations.filter((v) => !beforeHashes.has(fingerprintViolation(v)));
  const beforeCandHashes = new Set(before.candidates.map(fingerprintCandidate));
  const afterCandHashes = new Set(after.candidates.map(fingerprintCandidate));
  const resolvedCandidates = before.candidates.filter(
    (c) => !afterCandHashes.has(fingerprintCandidate(c)),
  );
  const newCandidates = after.candidates.filter(
    (c) => !beforeCandHashes.has(fingerprintCandidate(c)),
  );
  return { resolvedViolations, newViolations, resolvedCandidates, newCandidates };
}

function fingerprintViolation(v: Violation): string {
  return fingerprintOf(v.ruleId, v.location.filePath, v.message);
}

function fingerprintCandidate(c: ReviewCandidate): string {
  return `${c.criterionId}::${c.location.filePath}::${c.reason}`;
}

export function formatSlice(scan: SingleFileScan, source?: string): Record<string, unknown> {
  // V1-FIX-OLDTEXT-AMBIGUITY-LABEL-ADJACENT: forward the slice's source
  // so per-finding `fix.oldText` widens via `widenToUniqueAnchor` —
  // matching the cross-tool shape `suggest_fix` ships on
  // `primary.edit`. Optional so legacy callers without source in scope
  // keep the bare rule-emitted edit.
  return {
    violations: scan.violations.map((v) =>
      buildAgentFinding(v, {
        suppressPlacement: "omit",
        ...(source === undefined ? {} : { source }),
      }),
    ),
    candidates: scan.candidates.map(formatCandidate),
  };
}

export function formatCandidate(c: ReviewCandidate): Record<string, unknown> {
  return {
    criterionId: c.criterionId,
    line: c.location.line,
    column: c.location.column,
    reason: c.reason,
    ...(c.snippet ? { snippet: c.snippet } : {}),
  };
}

export function parseErrorEnvelope(
  resolved: string,
  errors: readonly ParseError[],
  originalErrorCount: number,
): McpToolResult {
  const firstNew = errors[originalErrorCount] ?? errors[0];
  const msg = firstNew?.message ?? "(no message)";
  const line = firstNew?.position.line ?? 0;
  const column = firstNew?.position.column ?? 0;
  return errorResult({
    code: "edit-introduces-parse-errors",
    message: `Edit would introduce parse errors into ${resolved} — file not written. First new error: "${msg}" at line ${line}, column ${column}.`,
    details: {
      filePath: resolved,
      firstNewError: { message: msg, line, column },
      originalErrorCount,
      newErrorCount: errors.length,
    },
    remediation: "Revise the edit so the post-edit source parses cleanly, then retry.",
  });
}

function readEdit(params: Record<string, unknown>): ResolvedEdit | null {
  const raw = params["edit"];
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const oldText = obj["oldText"];
  const newText = obj["newText"];
  if (typeof oldText !== "string" || typeof newText !== "string") return null;
  if (oldText.length === 0) return null;
  return { oldText, newText };
}

function countOccurrences(source: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = source.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = source.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Matches any template-directive opener or closer on a single line.
 * Mirrors `TEMPLATE_DIRECTIVE_LINE_RE` in `warnings.ts` — kept inline
 * so the apply_fix path stays decoupled from the warnings module's
 * larger surface and so a future tightening on either side requires
 * an explicit cross-edit. Both regexes are pure over their input;
 * adding a token (e.g. Razor `@{ … }`) is a two-spot, deterministic
 * change.
 */
const TEMPLATE_DIRECTIVE_TOKEN_RE = /(?:\{%-?|-?%\}|\{\{-?|-?\}\}|<%[=-]?|%>)/g;

export interface TemplateDirectiveDiagnosis {
  readonly source: "oldText" | "matchedFragment";
  readonly tokens: readonly string[];
  readonly line?: number;
}

/**
 * Diagnostic for V1-APPLY-FIX-LIQUID-FP-DIAGNOSIS — when `oldText`
 * doesn't match the source, decide whether the would-be edit target
 * sits in template-directive territory so the handler can route the
 * agent to "verify and suppress" instead of looping back through
 * `suggest_fix`/`apply_fix` on a false positive.
 *
 * Two deterministic signals (each "provable from the code", per the
 * AI-first consumer doctrine on labeled buckets):
 *
 *   1. `oldText` itself contains a template-directive token. The
 *      agent's `suggest_fix` payload literally targeted a template
 *      expression — a guaranteed FP class.
 *   2. `oldText` doesn't contain a directive, but a long-enough
 *      contiguous fragment of it appears in source on a line that
 *      does. Anchored at ≥8 non-whitespace chars to suppress fragment
 *      collisions on common tokens like `class=` or `<div>`.
 *
 * Returns `null` when neither signal fires — the caller falls back to
 * the generic `edit-no-match` envelope. Tokens returned are the exact
 * substrings that matched, deduped + sorted, so the agent can branch
 * on which template flavor (Liquid `{{`, ERB `<%=`, …) is in play.
 */
export function diagnoseTemplateDirectiveTarget(
  source: string,
  oldText: string,
): TemplateDirectiveDiagnosis | null {
  const tokensInOldText = collectDirectiveTokens(oldText);
  if (tokensInOldText.length > 0) {
    return { source: "oldText", tokens: tokensInOldText };
  }
  const fragmentHit = findLongestFragmentOnDirectiveLine(source, oldText);
  if (fragmentHit === null) return null;
  return {
    source: "matchedFragment",
    tokens: fragmentHit.tokens,
    line: fragmentHit.line,
  };
}

/**
 * Builds the structured-error envelope for the no-match branch of
 * `apply_fix`. Splits out from `preflightValidate` so the preflight's
 * nesting depth stays inside the limits-guard budget; the diagnostic
 * + envelope choice fan-out lives here.
 */
function noMatchEnvelope(resolved: string, source: string, oldText: string): McpToolResult {
  const directiveDiagnosis = diagnoseTemplateDirectiveTarget(source, oldText);
  if (directiveDiagnosis === null) {
    return errorResult({
      code: "edit-no-match",
      message: `Edit's oldText was not found in ${resolved}. The file may have changed since suggest_fix was called, or oldText has whitespace/quoting that doesn't match. Re-run suggest_fix and retry.`,
      details: { filePath: resolved, matchCount: 0 },
      remediation: "Re-run `suggest_fix` against the current source and retry with its new edit.",
    });
  }
  const tokens = directiveDiagnosis.tokens.join(", ");
  const lineDetail =
    directiveDiagnosis.line === undefined ? {} : { directiveLine: directiveDiagnosis.line };
  return errorResult({
    code: "target-contains-template-directive",
    message: `Edit's oldText was not found in ${resolved}, and the would-be target carries a template-directive token (${tokens}). The cited finding may be a false positive on a template expression whose rendered value is only knowable at render time.`,
    details: {
      filePath: resolved,
      matchCount: 0,
      directiveTokens: directiveDiagnosis.tokens,
      directiveSource: directiveDiagnosis.source,
      ...lineDetail,
    },
    remediation:
      "Verify the rendered output — the cited finding may be a false positive on a template expression. If the expression is trusted, suppress at source with `<!-- ra11y-disable <rule-id> -->` (HTML/Liquid/ERB) or `{/* ra11y-disable <rule-id> */}` (TSX). Do NOT loop back through `suggest_fix`/`apply_fix`; the rule cannot statically resolve the rendered text.",
  });
}

function collectDirectiveTokens(text: string): string[] {
  const matches = text.match(TEMPLATE_DIRECTIVE_TOKEN_RE);
  if (matches === null) return [];
  return [...new Set(matches)].sort();
}

/**
 * Walks `oldText` looking for a contiguous fragment of length ≥
 * `FRAGMENT_MIN_LEN` that appears in `source` on a line carrying a
 * template directive. The length floor keeps spurious matches on tiny
 * tokens (`<div>`, `class=`) from triggering the diagnosis. Returns
 * the directive tokens on the first such line, plus the 1-based line
 * number, or `null` if no fragment qualifies.
 *
 * Strategy: try long whitespace-bounded tokens first (most
 * distinctive); fall back to sliding-window substrings of the whole
 * `oldText` so a partial overlap with a templated line still anchors
 * — agents reliably ship `oldText` with mid-string templated regions
 * replaced by a literal placeholder (the FP that motivates this
 * diagnosis), and the surrounding bytes still anchor.
 */
function findLongestFragmentOnDirectiveLine(
  source: string,
  oldText: string,
): { readonly tokens: readonly string[]; readonly line: number } | null {
  for (const fragment of candidateFragments(oldText)) {
    const idx = source.indexOf(fragment);
    if (idx === -1) continue;
    const line = lineOfOffset(source, idx);
    const lineText = sliceLine(source, line);
    const tokens = collectDirectiveTokens(lineText);
    if (tokens.length > 0) {
      return { tokens, line };
    }
  }
  return null;
}

const FRAGMENT_MIN_LEN = 8;

/**
 * Yields candidate anchor fragments from `oldText` to probe against
 * `source`. Yields whitespace-split tokens of length ≥ FRAGMENT_MIN_LEN
 * in length-desc order, then sliding windows of length
 * FRAGMENT_MIN_LEN walking the leading + trailing edges of oldText.
 * Edge windows let the diagnosis fire when the agent's `oldText` has a
 * literal placeholder where the source carries a template expression
 * — the bytes flanking the placeholder still appear in source.
 */
function* candidateFragments(oldText: string): Generator<string> {
  const tokens = oldText.split(/\s+/).filter((t) => t.length >= FRAGMENT_MIN_LEN);
  tokens.sort((a, b) => b.length - a.length);
  for (const t of tokens) yield t;
  if (oldText.length < FRAGMENT_MIN_LEN) return;
  // Sliding windows along the full string. Step 1 keeps it cheap on
  // typical oldText sizes (≤ a few hundred chars in practice — agents
  // get this from suggest_fix's anchor-widened edit shape).
  const seen = new Set<string>(tokens);
  for (let i = 0; i + FRAGMENT_MIN_LEN <= oldText.length; i += 1) {
    const w = oldText.slice(i, i + FRAGMENT_MIN_LEN);
    if (/\s/.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    yield w;
  }
}

function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 0x0a) line += 1;
  }
  return line;
}

function sliceLine(source: string, line: number): string {
  const lines = source.split("\n");
  return lines[line - 1] ?? "";
}

function extensionOf(filePath: string): Ext | null {
  const lower = filePath.toLowerCase();
  if (
    lower.endsWith(".tsx") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".js")
  ) {
    return "tsx";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss")) return "scss";
  if (lower.endsWith(".less")) return "less";
  if (lower.endsWith(".mdx")) return "mdx";
  if (lower.endsWith(".astro")) return "astro";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".svg")) return "svg";
  if (lower.endsWith(".erb")) return "erb";
  return null;
}

export function parseFor(ext: Ext, source: string): Ast {
  if (ext === "html") {
    const r = parseHtml(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (ext === "css") {
    const r = parseCss(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (ext === "scss") {
    const r = parseScss(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (ext === "less") {
    const r = parseLess(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (ext === "mdx") {
    const r = parseMdx(source);
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  if (ext === "astro") {
    const r = parseAstro(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (ext === "markdown") {
    const r = parseMarkdown(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (ext === "svg") {
    const r = parseSvg(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (ext === "erb") {
    // ERB files route through parseHtml — the HTML parser's
    // stripTemplateDirectives pass strips `<%= … %>` / `<% … %>` /
    // `<%# … %>` from text nodes.
    const r = parseHtml(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  const r = parseTsx(source);
  return { language: "tsx", root: r.root, errors: r.errors };
}

export function resolveLevelParam(
  level: string | undefined,
  sessionLevel: "A" | "AA" | "AAA",
): "A" | "AA" | "AAA" {
  if (level === "A" || level === "AA" || level === "AAA") return level;
  return sessionLevel;
}

/**
 * Splice `edit.newText` into `source` while keeping the source file's
 * native line ending intact. `suggest_fix` and most agents emit
 * LF-only `newText`; if the source is CRLF (common on Windows-
 * authored or git-autocrlf'd repos), an unconditional splice would
 * mix endings — `\r\n` outside the edit window, `\n` inside — and
 * write a silently-corrupted file.
 *
 * The probe inspects the FIRST line break in `source`: if it's `\r\n`
 * the file is treated as CRLF and any bare `\n` in `newText` is
 * rewritten to `\r\n` before the splice. `oldText` is used verbatim —
 * `preflightValidate` already verified it matches the source exactly
 * once, so renormalizing it here could break that contract.
 *
 * Source files with no line breaks at all fall through as LF —
 * there's no signal to do otherwise, and line-internal edits are a
 * no-op for the rewriter anyway.
 *
 * Used by `apply_fix` to keep on-disk byte-content honest when an
 * agent's `newText` arrives LF-normalized but the file is CRLF
 * (V1-SOURCECONTEXT-LINE-ENDING-NORMALIZE).
 */
export function spliceWithNativeLineEndings(
  source: string,
  edit: ResolvedEdit,
  ext: Ext,
): { readonly newSource: string; readonly newAst: Ast } {
  const normalizedNewText = isCrlfSource(source) ? rewriteBareLfToCrlf(edit.newText) : edit.newText;
  const newSource = source.replace(edit.oldText, normalizedNewText);
  const newAst = parseFor(ext, newSource);
  return { newSource, newAst };
}

function isCrlfSource(source: string): boolean {
  const firstLf = source.indexOf("\n");
  return firstLf > 0 && source.charCodeAt(firstLf - 1) === 0x0d;
}

function rewriteBareLfToCrlf(text: string): string {
  // Rewrite bare LF (not preceded by CR) to CRLF. A CRLF in `text`
  // stays as-is; only the LF half of an existing CRLF would be
  // touched, but its preceding CR keeps it out of the bare-LF set.
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0a && (i === 0 || text.charCodeAt(i - 1) !== 0x0d)) {
      out += "\r\n";
    } else {
      out += text[i];
    }
  }
  return out;
}

export function buildNextStep(args: {
  applied: boolean;
  dryRun: boolean;
  delta: FixDelta;
  resolved: string;
}): string {
  const { applied, dryRun, delta, resolved } = args;
  const { resolvedViolations, newViolations, newCandidates } = delta;
  if (newViolations.length > 0) return regressionNextStep(newViolations, applied, resolved);
  if (newCandidates.length > 0 && resolvedViolations.length === 0) {
    return candidateOnlyNextStep(applied, newCandidates.length);
  }
  if (resolvedViolations.length === 0) return noDeltaNextStep(applied, dryRun, resolved);
  return resolvedNextStep(resolvedViolations, dryRun, resolved);
}

function regressionNextStep(
  newViolations: readonly Violation[],
  applied: boolean,
  resolved: string,
): string {
  const first = newViolations[0];
  const where = first ? `${first.location.filePath}:${first.location.line}` : resolved;
  const rule = first ? first.ruleId : "unknown";
  const suffix = applied ? "" : " (dry run)";
  const noun = newViolations.length === 1 ? "" : "s";
  return `Fix applied${suffix} but introduced ${newViolations.length} new violation${noun} in ${resolved} — review ${where} (rule \`${rule}\`) before committing.`;
}

function candidateOnlyNextStep(applied: boolean, newCount: number): string {
  const suffix = applied ? " applied" : " (dry run)";
  const noun = newCount === 1 ? "" : "s";
  return `Fix${suffix} but no automated findings resolved; ${newCount} new manual-review candidate${noun} surfaced. Call \`checklist\` to triage before committing.`;
}

function noDeltaNextStep(applied: boolean, dryRun: boolean, resolved: string): string {
  if (applied) {
    return `Edit written to ${resolved} but no violation delta against a fresh scan. Either the edit didn't match a rule-level finding, or suggest_fix's target was already resolved. Re-run \`scan_file\` to confirm.`;
  }
  if (dryRun) {
    return `Dry run of edit against ${resolved} produced no violation delta. Either the edit doesn't resolve a rule-level finding, or the target was already resolved. Flip \`dryRun: false\` only if the intent is confirmed.`;
  }
  return `No violation delta against a fresh scan of ${resolved}.`;
}

function resolvedNextStep(
  resolvedViolations: readonly Violation[],
  dryRun: boolean,
  resolved: string,
): string {
  const rulesList = resolvedViolations
    .slice(0, 3)
    .map((v) => `\`${v.ruleId}\``)
    .join(", ");
  const more = resolvedViolations.length > 3 ? `, +${resolvedViolations.length - 3} more` : "";
  const noun = resolvedViolations.length === 1 ? "" : "s";
  if (dryRun) {
    return `Dry run — ${resolvedViolations.length} violation${noun} would resolve (${rulesList}${more}). Re-call with \`dryRun: false\` to write.`;
  }
  return `Edit written to ${resolved} — ${resolvedViolations.length} violation${noun} resolved (${rulesList}${more}). Commit the change or re-run \`scan\` to double-check.`;
}
