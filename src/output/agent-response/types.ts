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
 *
 * `safety` used to live here as a constant `"safe"` on every emitted fix,
 * regardless of `fixClass`. Dropped per V1-FIX-SAFETY-CONSTANT-FIELD — a
 * field that never varies conveys no signal, and claiming "safe" on a
 * runtime-only or guidance fix is arguably wrong (static analysis cannot
 * prove safety without runtime context). The parent finding's `fixClass`
 * already distinguishes the remediation lane (`mechanical` vs `guidance`
 * vs `runtime-only` vs `verify-in-source`); a sibling constant is noise.
 * See `docs/kb/architecture/ai-first-consumer.md` under "Ambiguous field
 * shapes are dishonest."
 */
export interface AgentFix {
  readonly oldText?: string;
  readonly newText?: string;
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
  /**
   * Declaration-line sibling for selector-scoped CSS findings — the
   * line of the offending `animation:` / `transition:` declaration when
   * it differs from `line` (the rule's selector start, the structural
   * anchor). Lets the agent land on the selector for context and jump
   * straight to the declaration for the surgical edit without rescanning
   * the rule body.
   *
   * Currently emitted by `motion/pause-stop-hide`. Optional / present-
   * when-meaningful: omitted when selector and declaration share a line
   * (`.x { animation: spin 1s infinite }`) or when the rule is not
   * selector-scoped, per CLAUDE.md §1 "Ambiguous field shapes are
   * dishonest." See Q7-MOTION-FINDING-SELECTOR-LINE.
   */
  readonly decline?: number;
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
   *   - When `fixDescriptionRef` is absent but the finding's
   *     `groupKey` appears in `file.groupFixDescriptionRefs`, the ref
   *     was hoisted one more level (Q-SHARED-FIXDESCREF-SAME-GROUP-
   *     INLINE-DEDUPE) — resolve via
   *     `file.groupFixDescriptionRefs[groupKey].hash` →
   *     `referenceGuide.fixDescriptions[ruleId][hash]`.
   *   - Never emit both the per-finding ref and the per-finding
   *     description; never emit both the per-finding ref and a
   *     group-level ref for the same groupKey.
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
  /**
   * Cross-file occurrence list when the MCP assembly layer identified
   * this finding as a canonical copy across ≥2 sibling files sharing a
   * basename (e.g. 100+ copies of `bootstrap.css` in a
   * website-template catalog all emitting the same
   * `contrast/minimum` selector+ratio finding). The list always
   * includes this finding's own `(path, line)` as the first entry so
   * consumers can iterate without a second lookup.
   *
   * Surface-don't-suppress: collapsed siblings are fully enumerable via
   * this list; the headline count drops by `occurrences.length - 1` per
   * canonical finding. Present-when-meaningful — omitted entirely
   * (never `[]`) for singleton findings, per CLAUDE.md §1 "Ambiguous
   * field shapes are dishonest." See
   * `src/mcp/vendor-dedupe.ts` for the dedupe recipe and
   * {@link import("../../types/violation.ts").Violation#vendorOccurrences}
   * for the upstream source of truth.
   */
  readonly vendorOccurrences?: readonly {
    readonly path: string;
    readonly line: number;
  }[];
  /**
   * In-file sibling rollup mirroring
   * {@link import("../../types/violation.ts").Violation#siblingInstances}.
   * Stamped by a rule (currently `forms/labels-required`) when ≥3
   * direct-child sibling controls share the same parent and the same
   * `(tagName, type, attributes-modulo-id)` fingerprint and would
   * otherwise emit N near-identical findings — collapsed into one
   * canonical finding whose list enumerates every sibling. The list
   * always includes the canonical finding's own `(line, id?)` as the
   * first entry so consumers can iterate without a second lookup.
   *
   * Surface-don't-suppress: collapsed siblings are fully enumerable via
   * this list. Present-when-meaningful — omitted (never `[]`) for
   * singleton findings, per CLAUDE.md §1 "Ambiguous field shapes are
   * dishonest."
   */
  readonly siblingInstances?: readonly {
    readonly line: number;
    readonly id?: string;
  }[];
}

export interface AgentFile {
  readonly path: string;
  readonly findings: readonly AgentFinding[];
  /**
   * Q4-SCAN-FILE-PARSE-ERROR-LIMITATIONS-FIELD: per-file scan-
   * degradation telemetry. When the parser emitted errors on this
   * file, the surrounding findings ran on a degraded AST (recovered
   * slice) or didn't see the file at all. Without this signal on the
   * per-file entry, `findings: []` on a parse-errored file reads as
   * "rules ran clean on this file" when the honest reading is "rules
   * couldn't see the file." Each entry carries
   * `{ reason: "parse_error" | "partial_parse", file, parser,
   * detail? }`; the file/parser/detail fields match the per-entry
   * shape of `meta.analysisCoverage.parseErrorFiles` so the two
   * surfaces stay in lockstep (same source data, different
   * presentation lane). Present-when-meaningful: omitted when the
   * file parsed cleanly (never `[]`).
   */
  readonly limitations?: readonly FileLimitation[];
  /**
   * Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-DEDUPE: file-level pointer
   * into `referenceGuide.fixDescriptions` for cases where ≥2 findings
   * in this file share the same `(groupKey, fixDescriptionRef.hash)`
   * pair. The ref hoists out of each sibling finding and rides once
   * on the file bucket, indexed by `groupKey`; per-finding
   * `fixDescriptionRef` is omitted on those siblings.
   *
   * The per-finding `fixDescriptionRef` already collapses N identical
   * prose descriptions into a single `referenceGuide.fixDescriptions`
   * entry, but V1-REF-DEDUPE still re-inlined the pointer (`{ hash }`)
   * on every finding. On the 50projects50days `verify-account-ui`
   * sample, six adjacent `forms/labels-required` findings shared one
   * `groupKey` and one `hash` — the same 12-hex-char pointer rode the
   * wire six times. That's repeated identical payload, not signal
   * (CLAUDE.md §1 "verbose meta is signal, but repeated identical
   * payload is bloat"). Emitting the ref once at the group level lets
   * the agent resolve all siblings via `file.groupFixDescriptionRefs`.
   *
   * Each entry is `{ groupKey, hash }`. Findings in the group still
   * carry `groupKey` inline on themselves, so the agent walks from
   * finding → `groupKey` → `groupFixDescriptionRefs[groupKey].hash` →
   * `referenceGuide.fixDescriptions[ruleId][hash]` without re-parsing.
   *
   * Present-when-meaningful (CLAUDE.md §1): omitted when no group in
   * this file has ≥2 findings sharing a ref. Findings whose ref was
   * unique within their group keep the inline `fixDescriptionRef` as
   * before — hoisting a singleton would be pure overhead.
   */
  readonly groupFixDescriptionRefs?: readonly {
    readonly groupKey: string;
    readonly hash: string;
  }[];
}

/**
 * Per-file scan-degradation reason surfaced on {@link AgentFile}. The
 * authoritative constructor lives in `src/mcp/file-limitations.ts`;
 * the shape is declared here so {@link AgentFile} can carry it without
 * the output layer importing from the MCP layer.
 */
export interface FileLimitation {
  readonly reason: "parse_error" | "partial_parse";
  readonly file: string;
  readonly parser: string;
  readonly detail?: string;
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
  /**
   * Present-when-meaningful enumeration of sibling occurrences when a
   * finder aggregated ≥2 adjacent same-shape siblings (same parent,
   * same wrapping, alt-text differing only by enumerated token) into
   * this consolidated candidate. Each entry carries `{ line, alt?,
   * href? }` so an agent can iterate the group without re-parsing the
   * file. Omitted (not `[]`) for singleton candidates.
   */
  readonly siblingOccurrences?: readonly {
    readonly line: number;
    readonly alt?: string;
    readonly href?: string;
  }[];
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
 * `violations` and `notes` are the honest split of what `result.violations`
 * carries. `violations` counts findings with `severity` of `error` or
 * `warning` — real WCAG impact the agent is expected to triage. `notes`
 * counts `severity: "info"` findings — additive context (e.g. labeled
 * parents, deprecation hints) that share the violations array but do not
 * represent failure. The former `totalFindings` counter summed both lanes
 * under one headline (`plan.totalFindings: 24772` buried `notes: 1079`
 * under `violations: 23693` on the website-templates field test); per
 * CLAUDE.md §1 "Composite headline counts are dishonest," the split
 * matches the MCP `scan_project` plan shape (`buildScanPlan`) and the
 * `--format agent` summary prose ("N findings (… mechanical, …)") which
 * already breaks the two lanes out — agents reading either surface get
 * one shape to budget against.
 *
 * `fixesByClass` is the structured per-{@link FixClass} tally — one count
 * per remediation lane (`mechanical` / `guidance` / `runtimeOnly` /
 * `verifyInSource`). It replaced the former `guidanceFixesAvailable`
 * composite, which summed four categorically different lanes (anything
 * with a prose `suggestion` but no mechanical edit) under one headline.
 * Agents that previously budgeted against `guidanceFixesAvailable` read
 * `fixesByClass.guidance` (prose-rewrite work) or
 * `fixesByClass.mechanical + fixesByClass.guidance` (anything
 * `suggest_fix` can act on) instead. For the "apply-fix can batch-apply
 * this without a round-trip" slice, callers sum
 * `fixesByClass.mechanical + fixesByClass.verifyInSource` — the two
 * remediation lanes whose edit lands in source.
 *
 * The former `safeEditsAvailable` headline (which counted the two
 * editable lanes under a single composite number) was dropped per
 * Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT: it sat as a sibling
 * to `fixesByClass.mechanical` under names that both framed as "how
 * many fixes an agent can apply," but measured different slices
 * (payload-availability vs. rule-demanded lane) and disagreed by up to
 * 18× on real field-report responses. Per CLAUDE.md §1 "Composite
 * headline counts are dishonest," the structured per-lane tally
 * (`fixesByClass`) is the honest shape; the two editable lanes are
 * adjacent keys the caller sums when they want the combined apply-now
 * count.
 */
export interface AgentPlan {
  readonly violations: number;
  readonly notes: number;
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
