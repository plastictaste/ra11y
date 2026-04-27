/**
 * Next-step builder for scan responses.
 *
 * Both `scan_project` and `scan_file` surface a `nextStep` string that
 * names the canonical next tool call for the agent — `suggest_fix` on a
 * concrete file:line when violations exist, `checklist` when the
 * automated half is clean but manual items remain, etc. Centralizing
 * the logic here keeps the two tools in exact lockstep; a heuristic
 * that diverges between tools re-creates the cross-surface drift
 * agents pay for in extra round trips.
 *
 * The builder returns BOTH a prose `string` and a machine-readable
 * `structured` form `{ tool, args }`. Agents that prefer
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
  /**.
   * Set of `files[].path` values that
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
  /**
   * True when the response will ship `truncated: true` — either the
   * caller's pagination clipped trailing entries (`paginateFiles`
   * `hasMore`) or the density-cap secondary budget will drop entries
   * inside the assembler. Per the AI-first doctrine "NextStep
   * prioritization on truncated/bulk responses must avoid first-by-
   * filename routing," the alphabetically-first finding is a poor
   * default when the response can't carry the whole inventory: visual-
   * regression fixtures, scaffold dirs (`_template/index.html`), and
   * vendor stylesheets routinely sort earliest. When `truncated` is
   * true AND the alphabetical first pick isn't already the highest-
   * firing non-vendor rule's first finding, the picker reroutes to
   * that target instead — same logic the all-vendor lane uses for the
   * "every callable finding is vendor" case, generalized to "the
   * agent will be paging this corpus and the first action should land
   * on the rule with the broadest authored impact."
   *
   * Behavior when `truncated` is absent/false is unchanged — the first
   * callable finding wins regardless of inventory size, matching the
   * pre-change shape `scan` / `scan_file` / small-scan callers depend
   * on. Additive: when no reroute applies (alphabetical first IS the
   * highest-firing non-vendor target, or no findings exist), the
   * structured hint is identical to today.
   */
  readonly truncated?: boolean;
}

/**
 * Machine-parseable next-call hint. `tool` is the canonical MCP tool
 * name (exactly what appears on `tools/list`); `args` uses the
 * canonical parameter names those tools accept — `file` not
 * `filePath`, `ruleId`, `line`. Never emit `args: {}` as a
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
  /**.
   * When `first` has been rerouted from
   * a vendor-code finding to a non-vendor sibling (same-`ruleId`
   * preferred; falling back to the highest-firing rule's first
   * non-vendor finding), this carries the rerouted-away vendor path so
   * the violation branch can prepend a reason-text note. `undefined`
   * when no reroute happened (no vendor-path set, first finding
   * already in authored code, or every finding sits in vendor — see
   * `allFindingsVendor` for the all-vendor signal).
   */
  readonly reroutedFromVendorPath?: string;
  /**
   * True when the first callable finding sits on a vendor path AND no
   * non-vendor finding exists across the paged response. Triggers the
   * scope-down branch in {@link buildNextStep}: the structured hint
   * points at `scan_project` itself with prose recommending
   * `additionalPaths` / `cwd` narrowing rather than naming a vendor
   * target the agent can't edit. Per the AI-first doctrine "NextStep
   * prioritization on truncated/bulk responses must avoid
   * first-by-filename routing," routing the agent to a vendor
   * stylesheet wastes the suggest_fix round-trip. Falsy when not
   * applicable.
   */
  readonly allFindingsVendor?: boolean;
  /**
   * Set when {@link pickFirstFinding} fell back from "same-ruleId
   * non-vendor" to "highest-firing non-vendor rule's first finding"
   * because no same-ruleId non-vendor sibling existed. The violation
   * branch widens its reason-text note from "same-family fix is
   * applicable" to "highest-firing non-vendor rule on this scan" so
   * the agent knows the reroute crossed rule families. `undefined`
   * when the same-ruleId reroute succeeded or no reroute happened.
   */
  readonly dominantRuleReroute?: boolean;
  /**
   * Set when {@link pickFirstFinding} took the truncation lane and
   * rerouted away from an authored alphabetical-first pick (i.e. the
   * rerouted-from path was NOT vendor — the corpus is paged and the
   * first-by-filename default would have surfaced a low-impact target
   * like a visual-regression fixture or scaffold dir). The reason-text
   * prefix uses a paged-corpus framing instead of the vendor framing
   * so the agent reads the correct cause for the substitution.
   * `undefined` when the reroute was vendor-driven OR no reroute
   * happened.
   */
  readonly truncatedAlphabeticalReroute?: boolean;
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
   * round-trip: the inline fix already has what
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
  const firstPick = pickFirstFinding(formatted.files, options.vendorPaths, options.truncated);
  // the flat `plan.violations` headline
  // was deleted because it summed across the four `fixesByClass` lanes
  // under one number. The branching predicate ("are there any
  // violations to point at?") still wants the aggregate count, so we
  // sum the per-lane tally locally — the structured `fixesByClass`
  // sibling is the honest source the wire surface points at, and a
  // local sum keeps the branching honest without re-introducing a
  // wire-level composite.
  const violationsCount = sumFixesByClass(formatted.plan);
  const inputs: NextStepInputs = {
    violations: violationsCount,
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
    ...(firstPick.allFindingsVendor === true ? { allFindingsVendor: true } : {}),
    ...(firstPick.dominantRuleReroute === true ? { dominantRuleReroute: true } : {}),
    ...(firstPick.truncatedAlphabeticalReroute === true
      ? { truncatedAlphabeticalReroute: true }
      : {}),
    allViolationsMechanical: allViolationsMechanical(formatted.files),
  };
  if (inputs.violations === 0 && inputs.notes === 0) return cleanScanNextStep(inputs);
  // when the first callable finding
  // sits on a vendor path AND no non-vendor finding exists anywhere on
  // the paged response, naming the vendor target wastes a `suggest_fix`
  // round-trip — the agent can't edit a file in `scannedBuildArtifacts`.
  // Per the AI-first doctrine "NextStep prioritization on truncated/bulk
  // responses must avoid first-by-filename routing," route to a
  // scope-down structured suggestion (`scan_project` with prose naming
  // `additionalPaths` / `cwd`) so the agent narrows scope and finds
  // authored work on the next call.
  if (inputs.violations > 0 && inputs.allFindingsVendor === true) {
    return scopeDownNextStep(inputs, inputs.first);
  }
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
  // when the picker rerouted away from
  // a vendor-code finding to a non-vendor sibling, prepend a reason-text
  // note so the agent knows why the first-listed vendor finding isn't
  // the first-action target. Two reroute flavors share this prefix:
  //   - same-ruleId reroute: "same-family fix is applicable" (the
  //     authored target shares the rule family, so the fix workflow is
  //     identical);
  //   - dominant-rule reroute (fallback when no same-ruleId non-vendor
  //     existed): "highest-firing non-vendor rule on this scan" — the
  //     authored target lives under a different rule family than the
  //     vendor pick, but has the most non-vendor occurrences, so the
  //     agent's first action lands on the rule with the broadest
  //     authored impact. The finding itself remains in `files[]`
  //     (surface-don't-suppress); this only changes which file the
  //     "start here" prose + structured hint name.
  const reroutePrefix = buildReroutePrefix(inputs, first);
  if (inputs.fixable > 0) {
    const fPlural = inputs.fixable === 1 ? "" : "s";
    // when EVERY violation already carries
    // `fixClass === "mechanical"`, the inline fix on each finding has
    // the same payload `suggest_fix` would return (primary +
    // alternatives + source context). Re-nudging the agent to call
    // `suggest_fix` costs ~600 tokens per finding on tight fix loops
    // for no new signal. Trim both the prose and the structured hint
    // consistently — the pair is load-bearing, so a one-sided trim
    // would re-create the cross-surface drift the paired emission closes.
    // The verify-after-fix surface is a separate
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

/**
 * Builds the reason-text prefix that precedes the violation-branch
 * prose when the picker rerouted away from the alphabetical first
 * pick. Three reroute flavors share this surface:
 *   - same-ruleId vendor reroute (default): the alphabetical first
 *     finding sat on a vendor path; the picker found a same-`ruleId`
 *     finding on an authored path. Prose: "same-family fix is
 *     applicable."
 *   - dominant-rule vendor fallback: no same-ruleId non-vendor sibling
 *     existed for the vendor first pick, so the picker chose the
 *     highest-firing non-vendor rule's first finding instead. Prose
 *     names the rule-family change so the agent doesn't assume a
 *     same-family substitution.
 *   - truncated-alphabetical reroute: the response is paged AND the
 *     alphabetical first pick was non-vendor (visual-regression
 *     fixture, scaffold dir, etc.) but not the highest-firing non-
 *     vendor rule's first finding. The picker reroutes to the
 *     dominant target so the agent's first action lands on the rule
 *     with broadest authored impact. Prose names the paged-corpus
 *     framing so the agent reads the correct cause for the
 *     substitution (the prior framings would name the rerouted-from
 *     path as "vendor code" when it's authored-but-low-impact).
 *
 * Returns an empty string when no reroute happened (clean first pick
 * on a non-vendor path, the vendor-aware code path was disabled by
 * an empty `vendorPaths`, AND the truncation lane didn't fire).
 */
function buildReroutePrefix(inputs: NextStepInputs, first: FirstFinding): string {
  if (inputs.reroutedFromVendorPath === undefined) return "";
  if (inputs.truncatedAlphabeticalReroute === true) {
    return `note: response is truncated; first-by-filename pick (\`${inputs.reroutedFromVendorPath}\`) is low-impact for a paged corpus, so next-step points at \`${first.path}\` (rule \`${first.ruleId}\`) — the highest-firing non-vendor rule on this scan. `;
  }
  if (inputs.dominantRuleReroute === true) {
    return `note: highest-severity finding in this scan is in vendor code (\`${inputs.reroutedFromVendorPath}\`); no same-family non-vendor alternative exists, so next-step points at \`${first.path}\` (rule \`${first.ruleId}\`) — the highest-firing non-vendor rule on this scan. `;
  }
  return `note: highest-severity finding in this scan is in vendor code (\`${inputs.reroutedFromVendorPath}\`); next-step points at \`${first.path}\` where a same-family fix is applicable. `;
}

/**
 * Builds the scope-down `nextStep` for the all-vendor branch: every
 * callable finding sits in vendor code (`scannedBuildArtifacts`), so
 * naming any specific finding as `suggest_fix` target wastes the
 * round-trip — the agent can't edit a vendor stylesheet or compiled
 * bundle. The structured hint points at `scan_project` itself with an
 * empty `args` object; the prose names `additionalPaths` and `cwd` as
 * the narrowing knobs (mirrors the slim-envelope nextStep shape so the
 * agent encounters one consistent recovery vocabulary across the bulk-
 * corpus failure modes).
 *
 * `first` is the vendor pick the picker would have surfaced; we name
 * its path in the prose so the agent sees what was rerouted away from
 * (the all-vendor signal is the load-bearing fact — the specific path
 * just makes the corpus shape concrete). The structured hint's `args`
 * is empty because the scanner can't guess which subdirectory the
 * agent's authored code lives in; that's a human decision the agent
 * makes from its read of the codebase.
 */
function scopeDownNextStep(inputs: NextStepInputs, first: FirstFinding | null): NextStepResult {
  const vPlural = inputs.violations === 1 ? "" : "s";
  const vendorPathHint = first === null ? "" : ` (e.g. \`${first.path}\`)`;
  return {
    prose: `${inputs.violations} violation${vPlural}; every finding sits in vendor code${vendorPathHint} the agent can't edit. Re-call \`scan_project\` with a narrower scope: pass \`additionalPaths\` to target a specific authored subtree, or a tighter \`cwd\` so the response carries authored findings.${manualTail(inputs)}${inputs.iterativeTip}`,
    structured: { tool: "scan_project", args: {} },
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
 * Sums the four `plan.fixesByClass` lanes into a flat error+warning
 * count — replaces the wire-level `plan.violations` headline that was
 * deleted per. Used only as an internal
 * branching predicate ("any violations to point at?") inside this
 * builder; the wire surface stays per-lane. Defensive: a missing or
 * malformed `fixesByClass` parent yields zero, matching the
 * "clean scan" semantics the caller expects.
 */
function sumFixesByClass(plan: Record<string, unknown>): number {
  return (
    fixesByClassLane(plan, "mechanical") +
    fixesByClassLane(plan, "guidance") +
    fixesByClassLane(plan, "runtimeOnly") +
    fixesByClassLane(plan, "verifyInSource")
  );
}

/**
 * Result of {@link pickFirstFinding}. `finding` is the chosen
 * (file, line, ruleId) triple — or `null` when no callable finding
 * exists. `reroutedFromVendorPath` is set when the picker chose a
 * non-vendor finding in preference to an earlier vendor-code first
 * pick (either same-`ruleId` or dominant-rule fallback);
 * `dominantRuleReroute` discriminates the two flavors so downstream
 * prose can name the rule-family change. `allFindingsVendor` fires
 * when every callable finding sits on a vendor path — the violation
 * branch routes to a scope-down structured suggestion instead of
 * naming any specific vendor target. `truncatedAlphabeticalReroute`
 * fires when the response is truncated AND the alphabetical first
 * pick was rerouted to the highest-firing non-vendor target — the
 * rerouted-from path was authored, not vendor, so the prose prefix
 * names a paged-corpus framing rather than the vendor framing.
 */
interface FirstFindingPick {
  readonly finding: FirstFinding | null;
  readonly reroutedFromVendorPath?: string;
  readonly dominantRuleReroute?: boolean;
  readonly allFindingsVendor?: boolean;
  readonly truncatedAlphabeticalReroute?: boolean;
}

/**
 * Picks the first (file, line, ruleId) triple the `nextStep` hint
 * should name, with optional vendor-code and truncation reroutes. The
 * default answer is the first callable finding in `files[]` order —
 * the response-assembly sort already puts the highest-priority
 * finding first, so that's the one the agent should act on. The
 * reroute kicks in when `vendorPaths` is non-empty AND the first
 * callable finding sits on a path in that set; the picker then walks
 * two fallback lanes:
 *
 *   1. Same-`ruleId` non-vendor sibling (default). Keeps the agent's
 *      fix workflow identical — same rule family means same primary
 *      edit shape. Returns `{ finding, reroutedFromVendorPath }`.
 *   2. Highest-firing non-vendor rule's first finding (when no
 *      same-`ruleId` non-vendor exists). Crosses rule families to
 *      land on the rule with the broadest authored impact. Returns
 *      `{ finding, reroutedFromVendorPath, dominantRuleReroute: true }`
 *      so the prose widens its reason-note from "same-family fix" to
 *      name the rule-family change.
 *   3. All-vendor signal. When NEITHER fallback finds a non-vendor
 *      target — every finding on the paged response sits in
 *      `scannedBuildArtifacts` — return `{ finding: firstRaw,
 *      allFindingsVendor: true }`. The caller branches to a scope-down
 *      structured suggestion (`scan_project` with `additionalPaths` /
 *      `cwd` narrowing) instead of naming a vendor target the agent
 *      can't edit. Per the AI-first doctrine "NextStep prioritization
 *      on truncated/bulk responses must avoid first-by-filename
 *      routing."
 *
 * When `truncated` is true AND the first callable finding is itself
 * non-vendor (so the vendor-reroute lanes don't fire), the picker
 * STILL reroutes when the alphabetical-first pick isn't the highest-
 * firing non-vendor rule's first finding. Generalizes the doctrine
 * rule from "vendor first finding" to "any first-by-filename pick on
 * a paged corpus": the alphabetical default surfaces visual-regression
 * fixtures, scaffold dirs, and underscore-prefixed templates ahead of
 * the rule with the broadest authored impact, and an agent following
 * the reroute lands on the action-target with leverage instead of
 * the corpus's earliest path. When `truncated` is absent or false,
 * this lane short-circuits and the alphabetical first pick wins —
 * matching the pre-change shape on small scans where the whole
 * inventory ships and pagination is trivially complete.
 *
 * When `vendorPaths` is absent or empty AND `truncated` is absent or
 * false, the whole reroute path short-circuits and the behavior is
 * exactly the pre-change `firstCallableFinding` output.
 */
function pickFirstFinding(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
  vendorPaths: ReadonlySet<string> | undefined,
  truncated: boolean | undefined,
): FirstFindingPick {
  const firstRaw = firstCallableFinding(files);
  if (firstRaw === null) return { finding: null };
  const safeVendorPaths: ReadonlySet<string> =
    vendorPaths === undefined ? new Set<string>() : vendorPaths;
  // Vendor reroute takes precedence — the vendor lane already routes
  // to highest-firing non-vendor on its dominant-rule fallback, so
  // when both signals fire (vendor first pick AND truncated), the
  // existing three-lane walk is the right answer. Skipping straight
  // to the truncation lane below would lose the same-`ruleId` fast
  // path the vendor lane prefers.
  if (safeVendorPaths.size > 0 && safeVendorPaths.has(firstRaw.path)) {
    return reroutePickAwayFromVendor(files, safeVendorPaths, firstRaw);
  }
  // Truncation lane — fires when the response is paged AND the
  // alphabetical first pick isn't the highest-firing non-vendor rule's
  // first finding. Reuses the existing dominant-rule walker so the
  // reroute target matches the vendor lane's lane-2 fallback, and the
  // prose channel uses the same `dominantRuleReroute: true` framing
  // (no need to invent a parallel framing for the same routing
  // decision).
  if (truncated === true) {
    return rerouteOnTruncation(files, safeVendorPaths, firstRaw);
  }
  return { finding: firstRaw };
}

/**
 * Reroute lane for the truncated-response case where the first
 * callable finding is itself non-vendor. Generalizes the doctrine
 * from "vendor first finding" to "any first-by-filename pick on a
 * paged corpus": when the alphabetical first pick differs from the
 * highest-firing non-vendor rule's first finding, route to the
 * dominant target so the agent's first action lands on the rule with
 * the broadest authored impact instead of whatever path sorted
 * earliest (visual-regression fixture, scaffold dir, etc.).
 *
 * Branches:
 *   - When the dominant pick equals the alphabetical first pick (same
 *     file + line + rule), no reroute — the alphabetical default IS
 *     already the highest-impact target, and the prose stays clean.
 *   - When the dominant pick is a non-vendor finding under a
 *     different rule (or different file/line under the same rule),
 *     return the dominant pick with `reroutedFromVendorPath: firstRaw.path`
 *     and `dominantRuleReroute: true`. The vendor-path field is
 *     reused as "rerouted-from path" — the prose surface reads it as
 *     the path the picker steered away from regardless of whether
 *     that path was vendor or just alphabetical-first.
 *   - When NO non-vendor finding exists across the paged response
 *     (every finding sits in `vendorPaths`), signal the all-vendor
 *     case so the caller branches to scope-down. Same shape as the
 *     vendor lane's lane-3 exit.
 */
function rerouteOnTruncation(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
  vendorPaths: ReadonlySet<string>,
  firstRaw: FirstFinding,
): FirstFindingPick {
  // No non-vendor finding exists at all → all-vendor scope-down.
  // Matches the vendor lane's lane-3 exit so the caller branches the
  // same way regardless of which lane diagnosed the all-vendor shape.
  const dominantPick = pickHighestFiringNonVendorFinding(files, vendorPaths);
  if (dominantPick === null) {
    return { finding: firstRaw, allFindingsVendor: true };
  }
  // Alphabetical first IS the highest-firing non-vendor target →
  // no reroute. The reason-text channel stays clean and the prose
  // looks like a small-scan response.
  if (
    dominantPick.path === firstRaw.path &&
    dominantPick.line === firstRaw.line &&
    dominantPick.ruleId === firstRaw.ruleId
  ) {
    return { finding: firstRaw };
  }
  return {
    finding: dominantPick,
    reroutedFromVendorPath: firstRaw.path,
    dominantRuleReroute: true,
    truncatedAlphabeticalReroute: true,
  };
}

/**
 * Reroute lane for the case where the first callable finding sits on
 * a vendor path. Walks the three-tier fallback documented in {@link
 * pickFirstFinding}: same-`ruleId` non-vendor sibling → highest-firing
 * non-vendor rule's first finding → all-vendor signal. Extracted so
 * `pickFirstFinding` stays under the cognitive-complexity lint cap;
 * the early-exit cases (no findings, no vendor classification, first
 * pick already authored) are conceptually distinct from this reroute
 * walk and read better as separate functions.
 */
function reroutePickAwayFromVendor(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
  vendorPaths: ReadonlySet<string>,
  firstRaw: FirstFinding,
): FirstFindingPick {
  // Lane 1: same-`ruleId` non-vendor sibling. Same-rule keeps the
  // agent's fix workflow identical and is preferred over the broader
  // dominant-rule fallback.
  const sameRulePick = findSameRuleIdNonVendorFinding(files, vendorPaths, firstRaw.ruleId);
  if (sameRulePick !== null) {
    return {
      finding: sameRulePick,
      reroutedFromVendorPath: firstRaw.path,
    };
  }
  // Lane 2: highest-firing non-vendor rule's first finding. Crosses
  // rule families — the caller widens the prose to name the
  // rule-family change via `dominantRuleReroute: true`.
  const dominantPick = pickHighestFiringNonVendorFinding(files, vendorPaths);
  if (dominantPick !== null) {
    return {
      finding: dominantPick,
      reroutedFromVendorPath: firstRaw.path,
      dominantRuleReroute: true,
    };
  }
  // Lane 3: every callable finding sits on a vendor path. Signal the
  // all-vendor case so the caller branches to a scope-down structured
  // suggestion. The vendor `firstRaw` is still returned so the prose
  // can name what was rerouted away from for context.
  return {
    finding: firstRaw,
    allFindingsVendor: true,
  };
}

/**
 * Walks `files` looking for a non-vendor finding whose `ruleId`
 * matches `targetRuleId`. Returns the first match (file order is
 * pre-sorted by response priority) or `null` when no same-`ruleId`
 * non-vendor sibling exists. Extracted from {@link
 * reroutePickAwayFromVendor} for readability; the same-rule lane is
 * the most common reroute path in practice.
 */
function findSameRuleIdNonVendorFinding(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
  vendorPaths: ReadonlySet<string>,
  targetRuleId: string,
): FirstFinding | null {
  for (const file of files) {
    if (vendorPaths.has(file.path)) continue;
    for (const raw of file.findings) {
      const extracted = readFindingRuleIdAndLine(raw);
      if (extracted === null) continue;
      if (extracted.ruleId !== targetRuleId) continue;
      return { path: file.path, ...extracted };
    }
  }
  return null;
}

/**
 * Tallies finding counts per `ruleId` over non-vendor files only,
 * picks the rule with the highest count, then returns that rule's
 * first non-vendor finding (file, line, ruleId). Used by the dominant-
 * rule reroute lane in {@link pickFirstFinding} when no same-`ruleId`
 * non-vendor sibling exists.
 *
 * On a clean tie (two rules with equal max count), picks the one whose
 * first non-vendor finding appears earliest in `files[]` order. The
 * `pickTopRuleByCount` helper used by the per-rule narrowing reroute
 * returns `undefined` on ties (honest "we couldn't pick" for the
 * `explain_rule` reroute), but here a tie-break IS available: file
 * order is deterministic and the tie-break aligns with the same
 * "earliest in the page" intuition the default first-callable picker
 * already uses. Returns `null` only when every finding on every file
 * sits in `vendorPaths` (the all-vendor signal — caller routes to
 * scope-down).
 */
function pickHighestFiringNonVendorFinding(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
  vendorPaths: ReadonlySet<string>,
): FirstFinding | null {
  const counts = countNonVendorFindingsByRuleId(files, vendorPaths);
  if (counts.size === 0) return null;
  const topCount = maxValue(counts);
  return firstNonVendorFindingMatchingCount(files, vendorPaths, counts, topCount);
}

/**
 * Tallies finding counts per `ruleId` over non-vendor files only.
 * Extracted from {@link pickHighestFiringNonVendorFinding} so the
 * function stays under the cognitive-complexity lint cap; the tally,
 * max-pick, and walk-for-first-match phases are conceptually distinct
 * and read better as three helpers.
 */
function countNonVendorFindingsByRuleId(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
  vendorPaths: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (vendorPaths.has(file.path)) continue;
    for (const raw of file.findings) {
      const extracted = readFindingRuleIdAndLine(raw);
      if (extracted === null) continue;
      counts.set(extracted.ruleId, (counts.get(extracted.ruleId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Returns the maximum value across a non-empty `Map<string, number>`.
 * Caller has already checked `counts.size > 0`; returns 0 on the
 * unreachable empty-map case for type safety.
 */
function maxValue(counts: ReadonlyMap<string, number>): number {
  let top = 0;
  for (const c of counts.values()) {
    if (c > top) top = c;
  }
  return top;
}

/**
 * Walks `files` in order, returning the first non-vendor finding whose
 * `ruleId` hits `topCount`. File order resolves dominant-rule ties
 * deterministically — when two rules tie at the top, the one whose
 * first non-vendor finding appears earliest on the page wins. Returns
 * `null` when no such finding exists (the caller short-circuits before
 * this point on empty `counts`, so this is defensive only).
 */
function firstNonVendorFindingMatchingCount(
  files: readonly { readonly path: string; readonly findings: readonly unknown[] }[],
  vendorPaths: ReadonlySet<string>,
  counts: ReadonlyMap<string, number>,
  topCount: number,
): FirstFinding | null {
  for (const file of files) {
    if (vendorPaths.has(file.path)) continue;
    for (const raw of file.findings) {
      const extracted = readFindingRuleIdAndLine(raw);
      if (extracted === null) continue;
      if ((counts.get(extracted.ruleId) ?? 0) === topCount) {
        return { path: file.path, ...extracted };
      }
    }
  }
  return null;
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
 * Predicate for the trim: returns true when every
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

/**
 * counts findings by `ruleId`
 * across the page's pre-trim files list and returns the rule ID with
 * the highest occurrence count. Returns `undefined` on empty input or
 * when the top two rules tie (no clear winner — per the AI-first
 * doctrine "Ambiguous field shapes are dishonest," a tied winner is
 * an honest "we couldn't pick" and the caller falls back to the prose-
 * only hint).
 *
 * Scope: counts every finding regardless of severity. The reroute is
 * about escaping per-file pagination on bulk-template scans, where the
 * dominant rule is whatever fires most across the page — `info` wave
 * findings (e.g. opaque-component notes) count toward the dominance
 * tally because they ALSO contribute to the per-file expansion the
 * agent is paginating through. Filtering to `error`/`warning` here
 * would silently miss the wave on info-dense scans.
 *
 * Deterministic tie-break: when counts tie at the top, return
 * `undefined` rather than picking alphabetically — a faked winner
 * would route the agent to a rule that doesn't dominate, and the
 * downstream `explain_rule` reroute would mislead. Falling back to the
 * standard prose ("page-by-page on a 1793-file inventory will be
 * slow") keeps the warning honest without naming a wrong target.
 */
export function pickTopRuleByCount(
  files: readonly { readonly findings: readonly unknown[] }[],
): string | undefined {
  const counts = countFindingsByRuleId(files);
  if (counts.size === 0) return undefined;
  return findUniqueMaxKey(counts);
}

/**
 * Walks every finding across `files` and tallies occurrences keyed by
 * `ruleId`. Skips findings that aren't object-shaped or whose `ruleId`
 * is not a string — synthetic / legacy shapes shouldn't pollute the
 * dominance count. Extracted so {@link pickTopRuleByCount} stays inside
 * the cognitive-complexity lint cap; the tally / max passes are
 * conceptually distinct and read better as two functions.
 */
function countFindingsByRuleId(
  files: readonly { readonly findings: readonly unknown[] }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const raw of file.findings) {
      if (!raw || typeof raw !== "object") continue;
      const ruleId = (raw as Record<string, unknown>)["ruleId"];
      if (typeof ruleId !== "string") continue;
      counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Returns the unique key with the maximum value in `counts`, or
 * `undefined` if the top two values tie. Honest "we couldn't pick" —
 * naming an alphabetically-stable winner here would route the
 * downstream `explain_rule` reroute to a rule that doesn't dominate.
 */
function findUniqueMaxKey(counts: ReadonlyMap<string, number>): string | undefined {
  let topKey: string | undefined;
  let topCount = 0;
  let tie = false;
  for (const [key, count] of counts) {
    if (count > topCount) {
      topKey = key;
      topCount = count;
      tie = false;
    } else if (count === topCount) {
      tie = true;
    }
  }
  if (tie || topKey === undefined) return undefined;
  return topKey;
}

/**
 * builds the per-rule narrowing
 * `nextStep` reroute for the degenerate-pagination case where the
 * token-density cap clipped the page to ≤ 2 files AND the project
 * carries > 100 files-with-findings. Without this reroute, an agent
 * that follows the standard `nextOffset` loop calls `scan_project`
 * once per file — 1793 sequential round trips on the canonical
 * bulk-template repro — which the canonical "what next?" hint
 * (`suggest_fix` on the first finding) doesn't escape from.
 *
 * Reroute target: `explain_rule({ ruleId: topRuleId })`. Per the
 * AI-first doctrine "Don't duplicate capability the agent already has"
 * + "Interrogate the problem before accepting the solution's shape,"
 * the structured hint must name an existing tool with parameters the
 * tool actually accepts. The pairing item
 * tracks the future `findings_by_rule` primitive that would route
 * here directly; until that lands, `explain_rule` is the honest first
 * step — the agent reads what the dominant rule does, decides whether
 * the wave is a vendor-noise mass-suppress candidate or a single-fix
 * mechanical edit that propagates, and acts once instead of paging.
 *
 * Prose names the dominant rule + the file-count math so the agent
 * sees the per-rule narrowing pattern explicitly:
 * "1793 files-with-findings; current page returned 1 file (density
 * cap). The dominant rule is `contrast/minimum` — call `explain_rule`
 * to triage that wave once instead of paging file-by-file."
 *
 * Returns `undefined` (not a fallback `NextStepResult`) when the
 * caller didn't establish a `topRuleId`, so the assembly site can
 * keep the standard nextStep unchanged on ambiguity rather than
 * downgrade to a generic prose-only hint.
 */
export function perRuleNarrowingNextStep(args: {
  readonly topRuleId: string;
  readonly totalFilesWithFindings: number;
  readonly effectiveLimit: number;
}): NextStepResult {
  const { topRuleId, totalFilesWithFindings, effectiveLimit } = args;
  const filesPlural = effectiveLimit === 1 ? "" : "s";
  return {
    prose: `${totalFilesWithFindings} files-with-findings on this scan; the token-density cap clipped this page to ${effectiveLimit} file${filesPlural}, so paging file-by-file from \`nextOffset\` would take ~${totalFilesWithFindings} round trips. The dominant rule on this page is \`${topRuleId}\` — call \`explain_rule\` on it first to decide whether the wave is a single mass-suppress (vendor / generated code) or a one-shot fix that propagates. After triaging the dominant rule, narrow scope with a tighter \`cwd\` or \`additionalPaths\` instead of resuming pagination.`,
    structured: { tool: "explain_rule", args: { ruleId: topRuleId } },
  };
}

/**
 * gate predicate for the
 * per-rule narrowing reroute. Fires when the density cap clipped the
 * page to ≤ 2 files AND the underlying inventory carries > 100
 * files-with-findings. Both thresholds are encoded here (rather than
 * spread across the assembler) so the reroute's trigger is auditable
 * in one place and the condition is testable in isolation.
 *
 * Why both thresholds: the ≤ 2 files clip names the degenerate-
 * pagination regime (one-file pages, the actual pathology); the >
 * 100 inventory threshold filters out small scans where pagination
 * is trivially complete in a few calls — the reroute would be noise
 * on a 12-file scan even if density clipped to 1 file (12 calls is
 * not the 1793-call pathology). Numbers chosen empirically from the
 * Q7 field reports: real bulk-template repros sit at 100+ files-with-
 * findings; small repos with dense findings stay under that floor.
 *
 * NOT a numeric-threshold suppression (per the AI-first doctrine):
 * the standard `nextStep` still ships when this gate fails — the
 * reroute is additive routing for a regime where the standard hint
 * leads the agent into a known degenerate loop. Both file-count and
 * inventory thresholds are encoded as named constants so the
 * predicate's intent is visible.
 */
export function shouldRerouteToPerRuleNarrowing(args: {
  readonly effectiveLimit: number;
  readonly totalFilesWithFindings: number;
}): boolean {
  return (
    args.effectiveLimit <= PER_RULE_REROUTE_MAX_PAGE_FILES &&
    args.totalFilesWithFindings > PER_RULE_REROUTE_MIN_INVENTORY
  );
}

/**
 * Maximum `effectiveLimit` (post-density-cap files in the page) that
 * still qualifies for the per-rule narrowing reroute. Above this the
 * standard `nextOffset` loop is making meaningful progress per call
 * and the per-rule pivot is unnecessary.
 */
const PER_RULE_REROUTE_MAX_PAGE_FILES = 2;

/**
 * Minimum `totalFilesWithFindings` that qualifies the scan for the
 * per-rule narrowing reroute. Strict `>` (not `>=`) so the reroute
 * never fires on a 100-file scan — at that boundary, ~100 calls is
 * still finite and the per-rule narrowing isn't the better pattern.
 * The bulk-template pathology starts well above this; 100 is a
 * conservative floor.
 */
const PER_RULE_REROUTE_MIN_INVENTORY = 100;
