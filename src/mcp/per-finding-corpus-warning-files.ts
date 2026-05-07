/**
 * Per-finding propagation for corpus-level warning file lists.
 *
 * Generalized sibling of
 * {@link import("./per-finding-code-demo-prop-confidence.ts").enrichFindingsWithCodeDemoPropMatch}
 * (per-LOCATION axis, line-range gated) and
 * {@link import("./per-finding-build-artifact-confidence.ts").enrichFindingsWithBuildArtifactPath}
 * (per-FILE axis, narrow rule-ID gate). Where those each codify ONE
 * specific corpus signal into per-finding `couldBeWrongBecause`, this
 * helper takes a generic list of `(warningCode, files)` pairs and walks
 * per-file findings: when `finding.path` is in any pair's `files` set,
 * the helper appends the warning code to the finding's
 * `couldBeWrongBecause` array AND downgrades `confidence` one step
 * (high → medium, medium → low). This keeps the warning channel and
 * the per-finding channel in agreement on the corpus-level evidence
 * the response already surfaces.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Per-finding confidence must reflect per-rule coverage limitations."
 *   Extended one axis over: per-finding confidence + caveats must
 *   reflect any corpus-level warning whose evidence names the same
 *   file the finding fired on. Without the propagation, an agent
 *   reading `warnings: ["jsx_code_demo_prop_parsed_as_live_dom"]` and
 *   `warningsDetails.jsx_code_demo_prop_parsed_as_live_dom.files: [
 *   "docs/forms.mdx" ]` and a per-finding entry on `docs/forms.mdx` at
 *   `confidence: "medium"` with `couldBeWrongBecause: undefined`
 *   has to reconcile silently — the corpus channel says the file's
 *   substrate is structurally bounded; the per-finding channel
 *   contradicts it.
 *
 * Predicate strength: deterministic. The pairs are produced from the
 * same evidence the corpus warning emits off — the warning's predicate
 * gate at the call site fires when the file list is non-empty, so the
 * propagation here keys on the same gate. No heuristic guessing about
 * whether a given file matches; the file IS in the warning's file list
 * or it isn't.
 *
 * Confidence downgrade is honest because the file is named in a
 * warning the response also ships — the agent reading the warning will
 * already triage findings on the file with extra scrutiny; the
 * downgrade aligns the per-finding attention budget channel with the
 * warning channel. Per the AI-first doctrine bullet "Reason text and
 * severity must agree" extended to confidence: a confidence label that
 * disagrees with the corpus-level warning the same response carries is
 * the same shape as a `reason` that contradicts severity. We surface
 * the finding (no suppression — the rule may still be right; the
 * markup IS structurally what the rule names) but downgrade one step
 * so the agent's per-finding triage budget reflects the corpus signal.
 *
 * Co-existence with sibling per-finding helpers:
 *   - `enrichFindingsWithCodeDemoPropMatch` (per-LINE) runs first,
 *     attaching `template_literal_in_code_demo_prop` to findings
 *     whose line falls inside a recorded code-demo prop body. That
 *     code is the per-LOCATION evidence (the parser descended into
 *     the body at THIS finding's line); the corpus-warning code this
 *     helper appends is the per-FILE evidence (the file as a whole
 *     contains code-demo descents). Both can coexist on the same
 *     finding — the codes describe distinct evidence axes.
 *   - This helper does NOT change the per-LINE code's behavior; it
 *     adds the per-FILE code to findings the per-LINE pass left
 *     alone (e.g. findings outside the body but in the same `.mdx`
 *     file).
 */

import type { AgentFinding, Confidence } from "../output/agent-response/types.ts";
import type { FindingBucket } from "./per-finding-confidence-parity.ts";

/**
 * Per-file MDX code-demo prop matches the warnings module produces.
 * Re-declared here as a structural-only type so both the assembler-
 * internal call site and the `tool-scan-project` post-runScanAndFormat
 * call site can call {@link buildCorpusWarningFilesFromCodeDemoMatches}
 * without importing `WarningInputs` and creating an import cycle.
 *
 * Matches the shape the warnings module declares for
 * `WarningInputs.codeDemoPropMatches` — only the fields needed to
 * derive the file set (path keys + non-empty match list) are required.
 */
type CodeDemoPropMatchesMap = ReadonlyMap<
  string,
  readonly { readonly bodyStartLine: number }[]
>;

/**
 * One corpus-level warning's contribution to per-finding propagation.
 *
 * - `warningCode` — the snake_case warning identifier the agent reads
 *   on `warnings[]` and `warningsDetails`. Appended verbatim to per-
 *   finding `couldBeWrongBecause` so the agent can pivot from a
 *   per-finding caveat back to the corpus-level warning's payload.
 * - `files` — the file paths the warning's evidence model named. Any
 *   finding whose hosting file path is in this set gets the propagation.
 *   Pass an empty set or omit the entry entirely when the warning did
 *   not fire on this scan; the helper's no-op fast path stays cheap.
 */
export interface CorpusWarningFiles {
  readonly warningCode: string;
  readonly files: ReadonlySet<string>;
}

/**
 * Walks per-file findings and propagates each `CorpusWarningFiles`
 * entry's `warningCode` into the `couldBeWrongBecause` array of every
 * finding whose hosting path is in the entry's `files` set, AND
 * downgrades the finding's `confidence` one step on the trust axis
 * (`"high"` → `"medium"`, `"medium"` → `"low"`). Findings already at
 * `"low"` or carrying the special `"inherited"` marker (ADR 0012)
 * keep their existing label; the propagation only ever moves the
 * confidence axis toward less trust, never more.
 *
 * Returns the input array reference unchanged when every entry's
 * `files` set is empty (no-op fast path) — common case on authored
 * corpora that did not trigger any of the corpus warnings stays cheap.
 *
 * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": when a
 * finding already carries the propagated code, the array stays dedup-
 * stable across passes. Confidence is only re-stamped when the
 * downgrade actually changes the value (a finding already at-or-below
 * the downgrade target keeps its existing label).
 *
 * Returns a fresh top-level array when any finding was rewritten;
 * unchanged buckets ride the original reference. Same shape contract
 * as the sibling per-finding helpers so the response-assembler seam
 * can chain enrichment passes uniformly.
 */
export function enrichFindingsWithCorpusWarningFiles<T extends FindingBucket>(
  fileEntries: readonly T[],
  corpusWarnings: readonly CorpusWarningFiles[],
): readonly T[] {
  const activeWarnings = corpusWarnings.filter((w) => w.files.size > 0);
  if (activeWarnings.length === 0) return fileEntries;
  let mutatedAny = false;
  const out = fileEntries.map((file) => {
    const matchedCodes = collectMatchedWarningCodes(file.path, activeWarnings);
    if (matchedCodes.length === 0) return file;
    let bucketMutated = false;
    const findings = file.findings.map((finding) => {
      const next = applyCorpusWarningCodes(finding, matchedCodes);
      if (next !== finding) bucketMutated = true;
      return next;
    });
    if (!bucketMutated) return file;
    mutatedAny = true;
    return { ...file, findings };
  });
  return mutatedAny ? out : fileEntries;
}

/**
 * Collects the warning codes whose `files` set contains `path`. Linear
 * scan over the active-warnings list — bounded by the number of
 * corpus-level warnings the call site threads through (typically ≤4
 * even on bulk MDX/JSX corpora), so the cost stays acceptable per
 * file. Returns a fresh array (possibly empty) so callers can pattern-
 * match on `length === 0` for the no-op fast path.
 */
function collectMatchedWarningCodes(
  path: string,
  activeWarnings: readonly CorpusWarningFiles[],
): readonly string[] {
  const matched: string[] = [];
  for (const w of activeWarnings) {
    if (w.files.has(path)) matched.push(w.warningCode);
  }
  return matched;
}

/**
 * Applies the matched warning codes to a single finding. Returns the
 * input `finding` reference unchanged when no propagation actually
 * mutates the value (every code already present AND confidence already
 * at-or-below the target). Otherwise returns a fresh
 * {@link AgentFinding} with `couldBeWrongBecause` extended with the
 * missing codes and `confidence` stepped down one notch when the
 * downgrade applies.
 */
function applyCorpusWarningCodes(
  finding: AgentFinding,
  matchedCodes: readonly string[],
): AgentFinding {
  const existing = finding.couldBeWrongBecause;
  const codesToAppend = matchedCodes.filter((code) => existing?.includes(code) !== true);
  const downgraded = downgradeOneStep(finding.confidence);
  const confidenceNeedsDowngrade = downgraded !== finding.confidence;
  if (codesToAppend.length === 0 && !confidenceNeedsDowngrade) return finding;
  const nextCouldBeWrongBecause =
    codesToAppend.length === 0
      ? existing
      : existing === undefined || existing.length === 0
        ? codesToAppend
        : [...existing, ...codesToAppend];
  return {
    ...finding,
    ...(nextCouldBeWrongBecause === undefined
      ? {}
      : { couldBeWrongBecause: nextCouldBeWrongBecause }),
    ...(confidenceNeedsDowngrade ? { confidence: downgraded } : {}),
  };
}

/**
 * Steps a {@link Confidence} value one notch toward less trust:
 * `"high"` → `"medium"`, `"medium"` → `"low"`. `"low"` returns
 * unchanged (no `"none"` rung exists). `"inherited"` returns unchanged
 * — the wrapper-derived semantic per ADR 0012 is out of scope for
 * this propagation; the agent is supposed to pivot to the wrapper
 * definition's confidence, not to a corpus-warning-derived downgrade.
 */
function downgradeOneStep(c: Confidence): Confidence {
  if (c === "high") return "medium";
  if (c === "medium") return "low";
  return c;
}

/**
 * Builds the {@link CorpusWarningFiles} array from the corpus-level
 * warning inputs available at scan-family response assembly time.
 * Returns an empty array (no entries with non-empty file sets) when
 * none of the wired warnings fired on this scan; the propagation
 * helper's no-op fast path keeps the common case cheap.
 *
 * Currently sources one warning — `jsx_code_demo_prop_parsed_as_live_dom`,
 * keyed off the {@link CodeDemoPropMatchesMap} that the MDX adapter's
 * detector populates. Other warnings carrying file lists
 * (`dynamic_content_container_detected`,
 * `parser_bailed_on_non_jsx_in_tsx_route`,
 * `linked_stylesheet_local_unresolved`) can opt in by adding parameters
 * here and pushing additional entries. Each entry is independent;
 * the per-finding helper propagates them all in a single pass.
 *
 * Centralized in this file so both the assembler-internal call site
 * (`response-assembler.ts`) and the `tool-scan-project` post-
 * `runScanAndFormat` call site share one builder — keeps the wired
 * warnings list canonical and lets future warnings opt in from one
 * spot rather than two parallel call sites that drift.
 */
export function buildCorpusWarningFilesFromCodeDemoMatches(
  codeDemoPropMatches: CodeDemoPropMatchesMap | undefined,
): readonly CorpusWarningFiles[] {
  const out: CorpusWarningFiles[] = [];
  if (codeDemoPropMatches !== undefined && codeDemoPropMatches.size > 0) {
    const files = new Set<string>();
    for (const [path, matches] of codeDemoPropMatches) {
      if (matches.length > 0) files.add(path);
    }
    if (files.size > 0) {
      out.push({ warningCode: "jsx_code_demo_prop_parsed_as_live_dom", files });
    }
  }
  return out;
}
