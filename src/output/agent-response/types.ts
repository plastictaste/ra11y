/**
 * Shared agent-facing response shape types.
 *
 * These types are the single source of truth for the shape of agent-facing
 * JSON output. Both the CLI agent formatter (`src/output/formatters/agent.ts`)
 * and the MCP tools layer (`src/mcp/tools-helpers.ts`) consume this module so
 * the two surfaces stay structurally consistent.
 *
 * See docs/kb/architecture/output-formatters.md for the formatter contract
 * and docs/kb/architecture/ai-first-consumer.md for doctrine.
 */

import type { FixClass } from "../../types/rule.ts";
import type { Severity } from "../../types/violation.ts";

export type Effort = "trivial" | "moderate" | "significant";
export type Category = "auto-fix" | "review" | "manual";
/**
 * Agent-facing confidence axis.
 *
 * By default derived from severity — `error` → `high`, `warning` →
 * `medium`, `info` → `low`. When the underlying Violation carries
 * `confidence: "inherited"` (synthesized from a wrapper-definition
 * finding per Q2R2-INHERITED / ADR 0012), the forwarder surfaces
 * `"inherited"` verbatim so agents can branch/sort/route on it. Per
 * CLAUDE.md §1 "Don't downgrade priority to hide things," `"inherited"`
 * is not a suppression axis — every inherited finding is surfaced.
 */
export type Confidence = "high" | "medium" | "low" | "inherited";
export type Safety = "safe" | "unsafe";

/**
 * A structured fix suggestion attached to a single finding.
 *
 * `oldText` and `newText` are present only when the rule emits a mechanical
 * edit that can be applied verbatim. For guidance-only findings they are
 * omitted — per CLAUDE.md §1 "Ambiguous field shapes are dishonest," empty
 * string sentinels (`oldText: ""`) are a silent-miss hazard. Use the
 * `description` field for prose guidance in both cases.
 *
 * `description` is present on every newly-built fix, but **optional**
 * on the wire: in MCP scan-family responses (scan, scan_file,
 * scan_project, scan_diff) `description` is stripped when the same
 * `(ruleId, description)` pair appears ≥2 times in a response — the
 * prose hoists into top-level `referenceGuide.fixDescriptions`
 * (V1-SIZE-RESPONSE-BUDGET-DENSITY option b) and the finding gains a
 * `fixDescriptionRef: { hash }` pointer. Never emit BOTH the pointer
 * and the inline description; the two shapes are alternatives. On CLI
 * `--format agent` output and tools that don't hoist (apply_fix,
 * baseline), `description` stays inline.
 *
 * Confidence lives on the parent {@link AgentFinding} — one confidence
 * per finding, derived from severity. A separate per-fix confidence
 * was redundant.
 */
export interface AgentFix {
  readonly oldText?: string;
  readonly newText?: string;
  readonly safety: Safety;
  readonly description?: string;
}

export interface AgentFinding {
  /**
   * Stable identity — lets agents verify "did my edit close finding
   * X?" by exact ID rather than (file, line, ruleId) fuzzy match that
   * breaks on line-number drift. Disambiguated from `ruleId` /
   * `groupKey` by the `Id` suffix. Derived from
   * `Violation.findingId` — see `src/utils/finding-id.ts`.
   */
  readonly findingId: string;
  /**
   * Stable group identity — same rule firing on AST-equivalent nodes
   * across files all share this key. Lets agents batch one fix across
   * every finding with the same `groupKey`. See
   * docs/adr/0008-violation-group-key.md.
   */
  readonly groupKey: string;
  readonly ruleId: string;
  /**
   * Per-finding remediation lane stamped from the rule's `fixClass`
   * metadata. Lets agents batch-route at scan time without a per-
   * finding `suggest_fix` round-trip. See
   * docs/adr/0007-violation-fix-class-metadata.md. Distinct axis from
   * `suggest_fix.kind` ("what does the payload contain") — do not
   * conflate.
   */
  readonly fixClass: FixClass;
  readonly criteria: readonly string[];
  /**
   * Short human titles aligned index-for-index with `criteria`. Present
   * when the engine stamped them (every real emitted violation); omitted
   * when the upstream Violation had no `criteriaTitles` field.
   */
  readonly criteriaTitles?: readonly string[];
  /**
   * Structured reason codes naming known escape hatches that could
   * make this finding a false positive in context. Informational only —
   * the agent reads the cited file and decides. Omitted when empty, per
   * docs/adr/0009-violation-could-be-wrong-because.md.
   */
  readonly couldBeWrongBecause?: readonly string[];
  readonly severity: Severity;
  /**
   * Top-level confidence for this finding, derived deterministically
   * from `severity`: `error` → `high`, `warning` → `medium`, `info` →
   * `low`. Lives on the finding (not on {@link AgentFix}) so callers
   * can consume it without reading into the optional `fix` object —
   * including findings that emit no fix at all.
   */
  readonly confidence: Confidence;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly message: string;
  /**
   * The flagged source text, when the rule produced one. Present-when-
   * meaningful: omitted entirely when the violation had no snippet.
   *
   * V1-SHAPE-SNIPPET-EMPTY: previously `{ before: [], highlighted, after: [] }`
   * where `before` and `after` had zero writers anywhere in src/. The
   * empty-array sentinel was indistinguishable from "snippet builder
   * failed" — canonical ambiguous-field-shape anti-pattern per
   * docs/kb/architecture/ai-first-consumer.md.
   */
  readonly snippet?: string;
  /** Present when the violation has a mechanical edit or prose guidance; absent otherwise. */
  readonly fix?: AgentFix;
  /**
   * Pointer into `referenceGuide.fixDescriptions[ruleId][hash]` on the
   * top-level scan response, present only when the prose that would
   * otherwise live at `fix.description` was hoisted out of this finding
   * because the same `(ruleId, description)` pair appears on two or
   * more findings in the same response (V1-SIZE-RESPONSE-BUDGET-DENSITY
   * option b).
   *
   * Contract — the hoist shape must never be ambiguous per
   * `docs/kb/architecture/ai-first-consumer.md`:
   *
   *   - When `fixDescriptionRef` is present, `fix.description` is
   *     absent on this finding. Resolve the prose via
   *     `referenceGuide.fixDescriptions[ruleId][hash]`.
   *   - When `fixDescriptionRef` is absent and `fix.description` is
   *     present, the prose is unique-in-response and stays inline.
   *   - Never emit both.
   *
   * The hash is a 12-hex-char truncated SHA-256 of the description —
   * same recipe as `findingId` — so it reads cleanly in agent
   * transcripts.
   *
   * Tools that don't hoist (apply_fix, baseline, CLI `--format agent`)
   * never emit this field; their responses carry descriptions inline.
   */
  readonly fixDescriptionRef?: {
    readonly hash: string;
  };
  readonly effort: Effort;
  readonly category: Category;
  readonly suppressWith: string;
  /**
   * Per-file-type guidance on where the `suppressWith` pragma should
   * land. Emitted inline by default — CLI agent-format consumers read
   * it per-finding. MCP call sites pass `{ suppressPlacement: "omit" }`
   * to {@link buildAgentFinding} so the same guidance rides once at
   * the top level under `referenceGuide.suppressPlacement` instead of
   * repeating on every finding.
   */
  readonly suppressPlacement?: string;
  /**
   * Present on findings synthesized from another location — canonically,
   * inherited findings at wrapper call sites whose root cause lives at
   * a wrapper DEFINITION (Q2R2-INHERITED / ADR 0012). The agent should
   * edit `sourceOfFinding`, not the call-site location. Omitted on
   * primary findings per CLAUDE.md §1 "Ambiguous field shapes are
   * dishonest."
   */
  readonly sourceOfFinding?: {
    readonly filePath: string;
    readonly line: number;
    readonly column?: number;
  };
}

export interface AgentFile {
  readonly path: string;
  readonly findings: readonly AgentFinding[];
}

export interface AgentReviewCandidate {
  readonly criterionId: string;
  readonly tier?: 1 | 2 | 3;
  readonly path: string;
  readonly line: number;
  readonly reason: string;
  readonly snippet?: string;
  readonly question?: string;
  readonly passCriteria?: string;
  readonly failExample?: string;
  readonly passExample?: string;
  readonly suggestedFix?: string;
}

/**
 * Per-{@link FixClass} lane tally exposed on {@link AgentPlan#fixesByClass}.
 *
 * Keys are one-to-one with the `FixClass` union, renamed to camelCase for
 * JSON ergonomics (`runtime-only` → `runtimeOnly`, `verify-in-source` →
 * `verifyInSource`). Each value counts one kind of thing per CLAUDE.md §1
 * "Composite headline counts are dishonest," so agents can budget
 * per-lane (mechanical edits vs. guidance rewrites vs. runtime harness
 * vs. source-read decisions) without a guess.
 */
export interface FixesByClass {
  readonly mechanical: number;
  readonly guidance: number;
  readonly runtimeOnly: number;
  readonly verifyInSource: number;
}

/**
 * Executive summary for the agent: counts, effort, and a natural-language blurb.
 *
 * `mechanicalEditsAvailable` counts violations where `fixPaths?.primary.edit`
 * is present — deterministic, batch-apply work `apply_fix` can take without
 * a round-trip.
 *
 * `fixesByClass` is the structured per-{@link FixClass} tally — one count
 * per remediation lane (`mechanical` / `guidance` / `runtimeOnly` /
 * `verifyInSource`). It replaces the former `guidanceFixesAvailable`
 * composite, which summed four categorically different lanes (anything
 * with a prose `suggestion` but no mechanical edit) under one headline.
 * Agents that previously budgeted against `guidanceFixesAvailable` read
 * `fixesByClass.guidance` (prose-rewrite work) or
 * `fixesByClass.mechanical + fixesByClass.guidance` (anything
 * `suggest_fix` can act on) instead.
 *
 * Per CLAUDE.md §1 "Composite headline counts are dishonest," a
 * top-level counter must count one kind of thing; when several kinds
 * exist, a structured sibling keyed by kind is the honest shape.
 */
export interface AgentPlan {
  readonly totalFindings: number;
  readonly mechanicalEditsAvailable: number;
  readonly fixesByClass: FixesByClass;
  readonly reviewNeeded: number;
  readonly manualOnly: number;
  readonly estimatedEffort: Effort;
  readonly summary: string;
}

export interface AgentMeta {
  readonly tool: string;
  readonly version: string;
  readonly standards: readonly string[];
  readonly level: string;
  readonly filesScanned: number;
  readonly durationMs: number;
}

export interface AgentOutput {
  readonly plan: AgentPlan;
  readonly files: readonly AgentFile[];
  readonly reviewCandidates: readonly AgentReviewCandidate[];
  readonly meta: AgentMeta;
}
