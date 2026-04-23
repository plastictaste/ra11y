/**
 * Next-step builder for scan responses.
 *
 * Both `scan_project` and `scan_file` surface a `nextStep` string that
 * names the canonical next tool call for the agent — `suggest_fix` on a
 * concrete file:line when violations exist, `checklist` when the
 * automated half is clean but manual items remain, etc. Centralizing
 * the logic here keeps the two tools in exact lockstep (the whole
 * point of Track Q's parity fixes); a heuristic that diverges between
 * tools re-creates the shape-drift bug Track Q was opened to fix.
 *
 * The builder returns BOTH a prose `string` and a machine-readable
 * `structured` form `{ tool, args }` (P1-K). Agents that prefer
 * parse-free branching key off `structured`; weaker LLMs and human
 * log readers keep the prose. The two always describe the same call —
 * producing both from one pass guarantees they agree.
 *
 * When the prose degrades to a generic multi-option recommendation
 * (fallback branch, no concrete first finding to name), `structured`
 * is omitted per CLAUDE.md §1 "Ambiguous field shapes are dishonest"
 * — the caller conditional-spreads so the response shape carries
 * neither field rather than `nextStepStructured: null` or a fabricated
 * tool name.
 *
 * The builder consumes `ScanFormatted` (the shared shape produced by
 * `runScanAndFormat`) plus a small set of caller-scoped toggles:
 *
 *   - `iterativeTip`: scan_project appends the branch-iteration hint on
 *     full scans only; scan_file passes `""` because a file-level scan
 *     has no scope dimension.
 *   - `singleFilePath`: when set, the clean-scan and notes branches
 *     name the file directly instead of pointing at `scan_file <path>`.
 *     Callers that don't have a single-file anchor omit this.
 */

import type { ScanFormatted } from "./tools-helpers.ts";

export interface NextStepOptions {
  /**
   * Appended to every generated line. scan_project sets this to the
   * branch-iteration hint on full scans; scan_file leaves it empty.
   */
  readonly iterativeTip?: string;
  /**
   * When provided, scan_file-style framing is used: clean-scan and
   * notes branches read as "you just scanned `<path>`; next call is X"
   * rather than "open `scan_file <path>` on the first finding." Also
   * switches the violations branch from `suggest_fix <path>:<line>`
   * verbatim (already correct) to the same prose with a scan_file
   * verify-loop tail when no fix suggestion is available.
   */
  readonly singleFilePath?: string;
  /**
   * Q6-NEXTSTEP-AVOIDS-VENDOR-CSS. Set of `files[].path` values that
   * the classifier labelled as build artifacts (compiled CSS, minified
   * bundles, hashed-filename output) — the same path strings that
   * appear under `meta.scannedBuildArtifacts` on the response. When
   * the first callable finding sits on a path in this set AND a later
   * finding of the same `ruleId` exists on a path *outside* the set,
   * `buildNextStep` reroutes its structured target to the non-vendor
   * finding and prepends a reason-text note so the agent knows why
   * the first-listed vendor finding isn't the first-action target.
   *
   * Omit when the caller has no artifact classification available
   * (`scan_file` on a single file, tests, ad-hoc callers). When absent
   * or empty, behavior is identical to today — the first callable
   * finding wins regardless of path. Additive per the backlog item's
   * "when no rerouting applies, `nextStepStructured` behaves exactly
   * as today" constraint.
   */
  readonly vendorPaths?: ReadonlySet<string>;
}

/**
 * Machine-parseable next-call hint. `tool` is the canonical MCP tool
 * name (exactly what appears on `tools/list`); `args` uses the
 * canonical parameter names those tools accept — `file` not
 * `filePath` (per P2-R), `ruleId`, `line`. Never emit `args: {}` as a
 * sentinel for "missing args"; a tool that legitimately takes no
 * args (like `checklist` at its default paths) gets an empty object
 * honestly. Absence of a structured hint is signaled by omitting the
 * whole field at the response-assembly site, not by an empty value
 * here.
 */
export interface NextStepStructured {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/**
 * Output of {@link buildNextStep}. `prose` is always present — it's
 * the English hint the response has carried since v0.1.0. `structured`
 * is the machine form naming the same call; omitted when the prose
 * falls back to generic multi-option advice (no concrete first
 * finding), so consumers conditional-spread it rather than ship an
 * ambiguous sentinel.
 */
export interface NextStepResult {
  readonly prose: string;
  readonly structured?: NextStepStructured;
}

interface NextStepInputs {
  readonly violations: number;
  readonly fixable: number;
  readonly actionableManual: number;
  readonly notes: number;
  readonly first: FirstFinding | null;
  /**
   * Q6-NEXTSTEP-AVOIDS-VENDOR-CSS. When `first` has been rerouted from
   * a vendor-code finding to a non-vendor same-`ruleId` sibling, this
   * carries the rerouted-away vendor path so the violation branch can
   * prepend a reason-text note. `undefined` when no reroute happened
   * (either no vendor-path set was supplied, the first finding was
   * already in authored code, or no non-vendor same-family fallback
   * existed — the vendor target stays per the backlog item's "fall
   * back to vendor only when every violation is in vendor code" rule).
   */
  readonly reroutedFromVendorPath?: string;
  readonly iterativeTip: string;
  /**
   * Present-when-meaningful per CLAUDE.md §1 — omitted on the project-
   * wide scan branches that don't have a single-file anchor rather
   * than sentineled to `null`.
   */
  readonly singleFilePath?: string;
  /**
   * True when every violation-severity finding in `files` already
   * carries an inline `fixClass === "mechanical"` discriminator — i.e.
   * the rule emitted a mechanical primary rewrite with alternatives
   * and ambient snippet context at scan time. Under that condition,
   * re-nudging the agent to call `suggest_fix` is a redundant
   * round-trip (Q2R2-FIX-DEDUPE): the inline fix already has what
   * `suggest_fix` would return, so the violation branch drops the
   * `suggest_fix` tail from both `prose` and `structured`. Does NOT
   * fire when any violation's `fixClass` is `"guidance"`,
   * `"runtime-only"`, or `"verify-in-source"` — those still need the
   * round-trip. False when there are no violations at all (the flag
   * is irrelevant outside the violation branch).
   */
  readonly allViolationsMechanical: boolean;
}

interface FirstFinding {
  readonly path: string;
  readonly line: number;
  readonly ruleId: string;
}

/**
 * Builds the `nextStep` hint (prose + structured) for a scan
 * response. Branches on whether violations, notes, or neither are
 * present, then picks a concrete first call site from
 * `formatted.files` when applicable.
 *
 * Returns an object with:
 *   - `prose` — always present; the English recommendation agents
 *     and humans have been reading since v0.1.0.
 *   - `structured` — `{ tool, args }` form naming the same call.
 *     Omitted when the prose degrades to generic advice (no concrete
 *     first finding), so consumers conditional-spread it into the
 *     response rather than ship an ambiguous empty value.
 */
export function buildNextStep(
  formatted: ScanFormatted,
  options: NextStepOptions = {},
): NextStepResult {
  // Sum the `fixClass` lanes `suggest_fix` can produce something
  // useful for — `mechanical` (deterministic source transforms) and
  // `guidance` (prose rewrites the tool can route). `runtime-only`
  // and `verify-in-source` lanes are excluded because `suggest_fix`
  // can't action them, so they shouldn't pad the "with fix
  // suggestions" prose tail. Reads directly from `plan.fixesByClass`
  // so the semantics track the structured per-lane tally exposed to
  // agents — the former `safeEditsAvailable` composite was dropped
  // per Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT, and
  // `fixesByClass` is the honest per-lane source this predicate has
  // always read.
  const firstPick = pickFirstFinding(formatted.files, options.vendorPaths);
  const inputs: NextStepInputs = {
    violations: numFromPlan(formatted.plan, "violations"),
    fixable:
      fixesByClassLane(formatted.plan, "mechanical") + fixesByClassLane(formatted.plan, "guidance"),
    actionableManual: numFromPlan(formatted.plan, "actionableManualItems"),
    notes: numFromPlan(formatted.plan, "notes"),
    first: firstPick.finding,
    iterativeTip: options.iterativeTip ?? "",
    // Conditional-spread per CLAUDE.md §1 — omit entirely when the
    // caller has no single-file anchor rather than emit `null`.
    ...(options.singleFilePath ? { singleFilePath: options.singleFilePath } : {}),
    ...(firstPick.reroutedFromVendorPath === undefined
      ? {}
      : { reroutedFromVendorPath: firstPick.reroutedFromVendorPath }),
    allViolationsMechanical: allViolationsMechanical(formatted.files),
  };
  if (inputs.violations === 0 && inputs.notes === 0) return cleanScanNextStep(inputs);
  if (inputs.violations > 0 && inputs.first !== null)
    return violationNextStep(inputs, inputs.first);
  if (inputs.notes > 0 && inputs.first !== null) return notesNextStep(inputs, inputs.first);
  // Fallback: the scan reports violations/notes but we couldn't pull
  // a concrete (file, line, ruleId) triple to name. The prose still
  // gives multi-option advice; the structured form is omitted because
  // picking any one of `explain_rule` / `suggest_fix` / `scan_file`
  // here would be a guess. Honest shape (CLAUDE.md §1): the caller
  // conditional-spreads and neither field ships.
  return {
    prose: `Use \`explain_rule\` on unclear findings, \`suggest_fix\` for a concrete patch, and \`scan_file\` to verify each file after editing.${inputs.iterativeTip}`,
  };
}

function cleanScanNextStep(inputs: NextStepInputs): NextStepResult {
  if (inputs.actionableManual > 0) {
    const pl = inputs.actionableManual === 1 ? "on has" : "a have";
    return {
      prose: `Automated checks clean; ${inputs.actionableManual} manual-review criteri${pl} grounded candidates. Call \`checklist\` next, then run the \`ra11y/triage\` prompt (via \`prompts/get\`) to batch-process the candidates.${inputs.iterativeTip}`,
      structured: { tool: "checklist", args: {} },
    };
  }
  return {
    prose: `Automated checks clean. Call \`checklist\` for the manual-review half (criteria + grounded candidates).${inputs.iterativeTip} For a full end-to-end conformance audit, use the \`ra11y/audit\` prompt (via \`prompts/get\`).`,
    structured: { tool: "checklist", args: {} },
  };
}

function violationNextStep(inputs: NextStepInputs, first: FirstFinding): NextStepResult {
  const vPlural = inputs.violations === 1 ? "" : "s";
  // Q6-NEXTSTEP-AVOIDS-VENDOR-CSS: when the picker rerouted away from
  // a vendor-code finding to a non-vendor same-`ruleId` sibling,
  // prepend a reason-text note so the agent knows why the first-listed
  // vendor finding isn't the first-action target. The finding itself
  // remains in `files[]` (surface-don't-suppress); this only changes
  // which file the "start here" prose + structured hint name.
  const reroutePrefix =
    inputs.reroutedFromVendorPath === undefined
      ? ""
      : `note: highest-severity finding in this scan is in vendor code (\`${inputs.reroutedFromVendorPath}\`); next-step points at \`${first.path}\` where a same-family fix is applicable. `;
  if (inputs.fixable > 0) {
    const fPlural = inputs.fixable === 1 ? "" : "s";
    // Q2R2-FIX-DEDUPE: when EVERY violation already carries
    // `fixClass === "mechanical"`, the inline fix on each finding has
    // the same payload `suggest_fix` would return (primary +
    // alternatives + source context). Re-nudging the agent to call
    // `suggest_fix` costs ~600 tokens per finding on tight fix loops
    // for no new signal. Trim both the prose and the structured hint
    // consistently — the pair is load-bearing (P1-K), so a
    // one-sided trim would re-create the exact drift P1-K closed.
    // The verify-after-fix surface (Q2-VERIFYCMD) is a separate
    // emission and stays. Mixed lanes (any non-mechanical violation)
    // keep the `suggest_fix` nudge — it's still useful for guidance /
    // verify-in-source / runtime-only findings that need the round-
    // trip.
    if (inputs.allViolationsMechanical) {
      return {
        prose: `${reroutePrefix}${inputs.violations} violation${vPlural} (${inputs.fixable} with fix suggestion${fPlural}); every finding carries an inline mechanical fix — apply \`primary.edit\` directly from the finding. For the multi-finding fix workflow, use the \`ra11y/fix\` prompt (via \`prompts/get\`).${manualTail(inputs)}${inputs.iterativeTip}`,
      };
    }
    return {
      prose: `${reroutePrefix}${inputs.violations} violation${vPlural} (${inputs.fixable} with fix suggestion${fPlural}). Start with \`suggest_fix\` on ${first.path}:${first.line} (rule \`${first.ruleId}\`). For the multi-finding fix workflow, use the \`ra11y/fix\` prompt (via \`prompts/get\`).${manualTail(inputs)}${inputs.iterativeTip}`,
      structured: {
        tool: "suggest_fix",
        args: { ruleId: first.ruleId, file: first.path, line: first.line },
      },
    };
  }
  return {
    prose: `${reroutePrefix}${inputs.violations} violation${vPlural} with no machine-generated fix. Call \`explain_rule\` on \`${first.ruleId}\` and apply manually; verify with \`scan_file ${first.path}\` after editing.${inputs.iterativeTip}`,
    structured: { tool: "explain_rule", args: { ruleId: first.ruleId } },
  };
}

function notesNextStep(inputs: NextStepInputs, first: FirstFinding): NextStepResult {
  const nPlural = inputs.notes === 1 ? "" : "s";
  return {
    prose: `No errors/warnings, ${inputs.notes} info-level note${nPlural} (scanner flagged things it can't fully verify). Open \`scan_file ${first.path}\` or read the source to resolve.${manualTail(inputs)}${inputs.iterativeTip}`,
    structured: { tool: "scan_file", args: { path: first.path } },
  };
}

function manualTail(inputs: NextStepInputs): string {
  if (inputs.actionableManual <= 0) return "";
  const plural = inputs.actionableManual === 1 ? "" : "s";
  return ` Then \`checklist\` for the ${inputs.actionableManual} grounded manual-review item${plural}.`;
}

function numFromPlan(plan: Record<string, unknown>, key: string): number {
  const raw = plan[key];
  return typeof raw === "number" ? raw : 0;
}

/**
 * Reads one lane from `plan.fixesByClass`, defaulting to 0 when the
 * field shape doesn't match. Defensive — the plan is typed at the
 * call site but `nextStep` consumes a `Record<string, unknown>` so
 * the pair of scan tools can stay in exact lockstep without coupling
 * on the interface. `plan.fixesByClass` is conditional-spread on
 * clean scans (see `src/mcp/scan-assembly.ts`), so a missing parent
 * object is a valid "no violations" signal — we read it as lane-zero.
 */
function fixesByClassLane(
  plan: Record<string, unknown>,
  lane: "mechanical" | "guidance" | "runtimeOnly" | "verifyInSource",
): number {
  const raw = plan["fixesByClass"];
  if (!raw || typeof raw !== "object") return 0;
  const v = (raw as Record<string, unknown>)[lane];
  return typeof v === "number" ? v : 0;
}

/**
 * Result of {@link pickFirstFinding}. `finding` is the chosen
 * (file, line, ruleId) triple — or `null` when no callable finding
 * exists. `reroutedFromVendorPath` is set only when the scanner picked
 * a non-vendor finding in preference to an earlier vendor-code finding
 * of the same `ruleId` (Q6-NEXTSTEP-AVOIDS-VENDOR-CSS); downstream
 * branches use it to prepend a reason-text note naming the vendor
 * file the agent is being steered away from.
 */
interface FirstFindingPick {
  readonly finding: FirstFinding | null;
  readonly reroutedFromVendorPath?: string;
}

/**
 * Picks the first (file, line, ruleId) triple the `nextStep` hint
 * should name, with an optional vendor-code reroute. The default
 * answer is the first callable finding in `files[]` order — the
 * response-assembly sort already puts the highest-priority finding
 * first, so that's the one the agent should act on. The reroute
 * (Q6-NEXTSTEP-AVOIDS-VENDOR-CSS) kicks in when `vendorPaths` is
 * non-empty AND the first callable finding sits on a path in that
 * set: we scan forward for a same-`ruleId` finding on a non-vendor
 * path and hand THAT triple back instead, tagging the original
 * vendor path so the prose can surface the reason.
 *
 * Why match on `ruleId` rather than broader rule-family/criterion:
 * `ruleId` is the smallest, deterministic, AgentFinding-carried key
 * that identifies "same fix shape." A reroute to a same-`ruleId`
 * finding is a straight substitution — the agent does the same
 * mental move as before, just in authored code. Broader "same
 * criterion" fallbacks would couple next-step into the criteria
 * index and risk routing to a finding with a different fix workflow;
 * the backlog item explicitly notes the ruleId form as sufficient.
 *
 * When no non-vendor alternative exists (every finding of the
 * first's `ruleId` lives in vendor code), the vendor target stays
 * per the backlog's "fall back to vendor only when every violation
 * is in vendor code" rule — no reroute, no reason-note, shape
 * identical to today. When `vendorPaths` is absent or empty, the
 * whole vendor-aware path short-circuits and the behavior is exactly
 * the pre-change `firstCallableFinding` output.
 */
function pickFirstFinding(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
  vendorPaths: ReadonlySet<string> | undefined,
): FirstFindingPick {
  const firstRaw = firstCallableFinding(files);
  if (firstRaw === null) return { finding: null };
  // No vendor classification → keep the first pick verbatim. Matches
  // the pre-Q6 behavior for `scan` / `scan_file` callers that don't
  // plumb `scannedBuildArtifacts` through.
  if (vendorPaths === undefined || vendorPaths.size === 0) {
    return { finding: firstRaw };
  }
  if (!vendorPaths.has(firstRaw.path)) {
    return { finding: firstRaw };
  }
  // First finding is on a vendor path. Scan forward for a same-`ruleId`
  // finding on a non-vendor path.
  for (const file of files) {
    if (vendorPaths.has(file.path)) continue;
    for (const raw of file.findings) {
      const extracted = readFindingRuleIdAndLine(raw);
      if (extracted === null) continue;
      if (extracted.ruleId !== firstRaw.ruleId) continue;
      return {
        finding: { path: file.path, ...extracted },
        reroutedFromVendorPath: firstRaw.path,
      };
    }
  }
  // Every same-ruleId finding sits in vendor code. Per the backlog
  // item's "fall back to vendor only when every violation is in
  // vendor code" rule, keep the vendor target and emit no reroute
  // note — the vendor pick is the honest answer.
  return { finding: firstRaw };
}

/**
 * Pulls the first finding's (file, line, ruleId) from the sorted
 * `files` entries so the next-step hint can name a concrete call site.
 * Falls back to null when the response has no findings or the shape
 * doesn't expose the fields we want — the caller degrades to generic
 * text in that case.
 */
function firstCallableFinding(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
): FirstFinding | null {
  for (const file of files) {
    for (const raw of file.findings) {
      const extracted = readFindingRuleIdAndLine(raw);
      if (extracted !== null) return { path: file.path, ...extracted };
    }
  }
  return null;
}

function readFindingRuleIdAndLine(
  raw: unknown,
): { readonly ruleId: string; readonly line: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const ruleId = f["ruleId"];
  const line = f["line"];
  if (typeof ruleId !== "string" || typeof line !== "number") return null;
  return { ruleId, line };
}

/**
 * Predicate for the Q2R2-FIX-DEDUPE trim: returns true when every
 * violation-severity finding (`severity === "error"` or `"warning"` —
 * info-level notes are excluded because they flow through a different
 * nextStep branch and `fixClass` isn't meaningful for them) already
 * carries `fixClass === "mechanical"`. Under that condition the inline
 * fix on every finding already has what `suggest_fix` would return
 * (primary + alternatives + ambient source context), so the "now call
 * `suggest_fix`" handoff in `nextStep`/`nextStepStructured` is a
 * redundant round-trip.
 *
 * Returns false when:
 *   - there are no violation-severity findings at all (the flag is
 *     irrelevant outside the violation branch — callers that reach it
 *     shouldn't act on the value);
 *   - ANY violation has a non-mechanical `fixClass` (`"guidance"`,
 *     `"runtime-only"`, `"verify-in-source"`) — those still need the
 *     `suggest_fix` round-trip, so the mixed case keeps the nudge;
 *   - a violation is missing `fixClass` entirely (synthetic / legacy
 *     shapes) — fail-closed so we never silently drop the nudge on a
 *     finding whose lane we can't confirm.
 */
function allViolationsMechanical(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
): boolean {
  let sawViolation = false;
  for (const file of files) {
    for (const raw of file.findings) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as Record<string, unknown>;
      const severity = f["severity"];
      if (severity !== "error" && severity !== "warning") continue;
      sawViolation = true;
      if (f["fixClass"] !== "mechanical") return false;
    }
  }
  return sawViolation;
}
