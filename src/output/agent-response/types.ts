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

import type { ReviewCandidateVendorContext } from "../../types/review.ts";
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
 * finding per / ADR 0012), the forwarder surfaces
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
 * scan_project, scan_diff) `description` is stripped when the rule has
 * ≥2 findings carrying descriptions in a response — the prose hoists
 * into top-level `referenceGuide.fixDescriptions` (-
 * BUDGET-DENSITY option b) and the finding's `fix` object gains a
 * nested `descriptionRef: { hash }` pointer in place of the inline
 * `description`. Never emit BOTH the pointer and the inline
 * description on the same fix; the two shapes are alternatives. On
 * CLI `--format agent` output and tools that don't hoist (apply_fix,
 * baseline), `description` stays inline.
 *
 *:
 * `descriptionRef` lives INSIDE `fix` — never as a sibling on
 * {@link AgentFinding}. The agent reads prose at one path
 * (`finding.fix.description ?? lookup(finding.fix.descriptionRef.hash)`)
 * regardless of which surface emitted the response. Shipping the ref
 * as a sibling field on the finding ("ref-only") forced the agent's
 * fallback to fork — the same finding hit `undefined` on `fix.description`
 * when surfaces disagreed about the hoist decision. Keeping the ref
 * nested keeps the join site uniform.
 *
 * Confidence lives on the parent {@link AgentFinding} — one confidence
 * per finding, derived from severity. A separate per-fix confidence
 * was redundant.
 *
 * `safety` used to live here as a constant `"safe"` on every emitted fix,
 * regardless of `fixClass`. Dropped per — a
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
  /**
   * Pointer into `referenceGuide.fixDescriptions[ruleId][hash]` on the
   * top-level scan response. Present-when-meaningful: emitted only when
   * the prose that would otherwise live at `fix.description` was
   * hoisted out of this finding because the rule had ≥2 findings
   * carrying descriptions in the response (-
   * DENSITY option b). Mutually exclusive with `description` on the
   * same fix — the response shape never carries both at once.
   *
   * Hash is a 12-hex-char truncated SHA-256 of the description — same
   * recipe as `findingId` — so it reads cleanly in agent transcripts.
   *
   * Tools that don't hoist (apply_fix, baseline, CLI `--format agent`)
   * never emit this field; their responses carry descriptions inline.
   *
   * the ref
   * lives INSIDE `fix` (never as a sibling on the finding). Shipping
   * it at two locations forced agents pivoting between `scan_file`
   * (inline) and `scan_project` (hoisted) to read different join
   * paths for the same `findingId`; nesting unifies the path.
   */
  readonly descriptionRef?: {
    readonly hash: string;
  };
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
   * dishonest." See.
   */
  readonly decline?: number;
  readonly message: string;
  /**
   * The flagged source text, when the rule produced one. Present-when-
   * meaningful: omitted entirely when the violation had no snippet.
   *
   * previously `{ before: [], highlighted, after: [] }`
   * where `before` and `after` had zero writers anywhere in src/. The
   * empty-array sentinel was indistinguishable from "snippet builder
   * failed" — canonical ambiguous-field-shape anti-pattern per
   * docs/kb/architecture/ai-first-consumer.md.
   */
  readonly snippet?: string;
  /**
   * Present when the violation has a mechanical edit or prose guidance;
   * absent otherwise.
   *
   * Description prose lives at one path on the wire:
   * `fix.description` (inline) or `fix.descriptionRef.hash` (hoisted
   * pointer into `referenceGuide.fixDescriptions[ruleId][hash]`).
   * Mutually exclusive within a single `fix` object — never both at
   * once. The two-level group-lift path (Q-SHARED-FIXDESCREF-SAME-
   * GROUP-INLINE-DEDUPE) drops `fix` from the sibling findings under
   * the lifted cohort and instead surfaces the pointer on
   * {@link AgentFile#groupFixDescriptionRefs} keyed by `groupKey`.
   *
   * the
   * single-finding ref previously rode as a sibling field
   * (`fixDescriptionRef`) on this interface. Moved inside `fix` so the
   * agent reads prose at one path regardless of which surface
   * emitted the response. Shipping the ref at the finding level (a
   * sibling) forced the agent's fallback to fork: surfaces that
   * hoisted produced `fix.description = undefined` + sibling
   * `fixDescriptionRef`, while surfaces that didn't hoist produced an
   * inline `fix.description` — same `findingId`, different read
   * paths, silent `undefined`-read hazard.
   */
  readonly fix?: AgentFix;
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
   * a wrapper DEFINITION (/ ADR 0012). The agent should
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
  /**
   * Structured discriminating evidence forwarded from the upstream
   * {@link import("../../types/violation.ts").Violation#evidence}.
   * High-density rules (`semantics/list-structure`, `aria/expanded-on-disclosure`)
   * promote the discriminator the prose `message` would otherwise bury
   * (offending child tag, predicate-branch kind) to a typed sub-shape so
   * an agent triaging a 50+ finding cluster can branch without parsing
   * English. Absent when the rule did not populate the field.
   */
  readonly evidence?: import("../../types/violation.ts").ViolationEvidence;
}

export interface AgentFile {
  readonly path: string;
  readonly findings: readonly AgentFinding[];
  /**
   * per-file scan-
   * degradation telemetry. When the parser emitted errors on this
   * file, the surrounding findings ran on a degraded AST (recovered
   * slice) or didn't see the file at all. Without this signal on the
   * per-file entry, `findings: []` on a parse-errored file reads as
   * "rules ran clean on this file" when the honest reading is "rules
   * couldn't see the file." Each entry carries
   * `{ reason: "parse_error" | "partial_parse", file, parserAttempted,
   * naturalParser?, detail? }`; the file / parserAttempted /
   * naturalParser / detail fields match the per-entry shape of
   * `meta.analysisCoverage.parseErrorFiles` so the two surfaces stay
   * in lockstep (same source data, different presentation lane).
   * Present-when-meaningful: omitted when the file parsed cleanly
   * (never `[]`).
   */
  readonly limitations?: readonly FileLimitation[];
  /**
   * Q-SHARED-FIXDESCREF-SAME-GROUP-INLINE-DEDUPE: file-level pointer
   * into `referenceGuide.fixDescriptions` for cases where ≥2 findings
   * in this file share the same `(groupKey, fix.descriptionRef.hash)`
   * pair. The ref hoists out of each sibling finding's `fix` object
   * and rides once on the file bucket, indexed by `groupKey`; the
   * per-finding `fix.descriptionRef` is omitted on those siblings.
   *
   * The per-finding `fix.descriptionRef` already collapses N identical
   * prose descriptions into a single `referenceGuide.fixDescriptions`
   * entry, but still re-inlined the pointer (`{ hash }`)
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
   * unique within their group keep the per-finding `fix.descriptionRef`
   * as before — hoisting a singleton would be pure overhead.
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
 *
 * `parserAttempted` names which in-house parser actually ran on the
 * file — the routing decision the dispatcher took, not a content
 * classification. `naturalParser` is present-when-meaningful: the
 * per-extension default an agent would expect from looking at the
 * extension alone (`.js` → `js`, `.svg` → `svg`). Surfaced only when
 * it differs from `parserAttempted` so the routing-mismatch signal
 * (e.g. `.js` routed through the TSX parser) is visible in one read
 * without echoing the same string twice for files where extension
 * and parser agree (per AI-first consumer model "Ambiguous field
 * shapes are dishonest").
 */
export interface FileLimitation {
  readonly reason: "parse_error" | "partial_parse";
  readonly file: string;
  readonly parserAttempted: string;
  readonly naturalParser?: string;
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
   * same wrapping, alt-text differing only by enumerated token) OR
   * deduplicated ≥2 same-stem candidates by accessible-name pattern
   * into this consolidated candidate. Each entry carries `{ line,
   * alt?, href? }` so an agent can iterate the group without re-parsing
   * the file. Omitted (not `[]`) for singleton candidates.
   */
  readonly siblingOccurrences?: readonly {
    readonly line: number;
    readonly alt?: string;
    readonly href?: string;
  }[];
  /**
   * Structured additive evidence that the cited file looks like
   * third-party / build-output code. Surfaced as a typed boolean so
   * the agent reads the dismissal evidence without parsing free-form
   * reason text. Strictly additive per ai-first-consumer.md
   * "Numeric-threshold heuristics are suppression" — the candidate
   * still surfaces at the same confidence regardless of the value.
   * Omitted for ordinary authored sources.
   */
  readonly vendorPathHint?: boolean;
  /**
   * Sibling structured payload to {@link AgentReviewCandidate#vendorPathHint}
   * — carries the vendor-path-shape evidence as a discriminated
   * `signal` plus a stable `redirectTo: "consumer-override"` enum the
   * agent reads to learn the dismissal direction. Mirrors
   * `ReviewCandidate.vendorContext` on the source-of-truth shape and
   * the field of the same name on the `suggest_fix` response, so an
   * agent reads the same direction across the manual-review and
   * apply-fix lanes. Present-when-meaningful — omitted on
   * authored-source candidates.
   */
  readonly vendorContext?: ReviewCandidateVendorContext;
  /**
   * Structured duration evidence for timing-related candidates
   * (`setTimeout` / `setInterval`). Populated only when the duration
   * argument is a numeric literal — the agent reads a single-typed
   * `number` rather than type-checking a `number | "non-literal"`
   * polymorphic shape. Non-literal expressions surface as a sibling
   * {@link AgentReviewCandidate#durationExpression}. Omitted when the
   * candidate has no duration to report (HTML `<meta refresh>`,
   * degenerate calls).
   */
  readonly durationLiteralMs?: number;
  /**
   * Verbatim non-literal duration expression for timing-related
   * candidates — populated when the underlying duration argument is
   * not a numeric literal (member access, identifier, call, computed
   * expression). Sibling to {@link AgentReviewCandidate#durationLiteralMs}:
   * exactly one of the two is populated when the call has a duration;
   * both are omitted otherwise.
   */
  readonly durationExpression?: string;
  /**
   * Number of source occurrences this candidate represents. Present
   * when the finder collapsed ≥2 candidates whose accessible names
   * share a pattern stem (e.g. ten `<img alt="Sponsor 1">` … `<img
   * alt="Sponsor 10">`) into a single candidate carrying this count
   * plus a matching {@link AgentReviewCandidate#siblingOccurrences}
   * trail. Omitted on singleton candidates per CLAUDE.md §1
   * "Ambiguous field shapes are dishonest."
   */
  readonly sourceCount?: number;
  /**
   * Identifier name of a handler that resolves to a named function
   * reference / call rather than an inline arrow / function expression
   * (mirrors {@link ReviewCandidate#handlerFunctionName}). Populated
   * when the finder could statically extract the symbol the agent's
   * next Read should target — e.g. `onChange={navigateToUrl}` →
   * `handlerFunctionName: "navigateToUrl"`. Omitted on inline-body
   * handlers, per CLAUDE.md §1 "Ambiguous field shapes are
   * dishonest" → present-when-meaningful.
   */
  readonly handlerFunctionName?: string;
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
 * `notes` counts `severity: "info"` findings — additive context
 * (e.g. labeled parents, deprecation hints) that share the violations
 * array but do not represent failure. There is no top-level
 * `violations` counter: a flat `violations: N` headline summed
 * categorically different `fixesByClass` lanes (mechanical edits +
 * verify-in-source prose + guidance rewrites + runtime-only) under
 * one number, and agents budgeted against it as if it were N
 * actionable edits. Same shape as the dropped `plan.totalFindings`
 * (severity-distinct lanes under one name) and `plan.safeEditsAvailable`
 * (two editable lanes under one name) precedents — per
 * `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest," the structured per-lane `fixesByClass` is
 * the honest tally and the composite was deleted (not renamed) so
 * the silent-miss failure mode of two siblings disagreeing on the
 * same response can't reopen.
 *
 * `fixesByClass` is the structured per-{@link FixClass} tally — one count
 * per remediation lane (`mechanical` / `guidance` / `runtimeOnly` /
 * `verifyInSource`). Callers that want the former flat-violations
 * count sum the four lanes themselves; callers that want the
 * "apply-fix can batch-apply this without a round-trip" slice sum
 * `fixesByClass.mechanical + fixesByClass.verifyInSource` — the two
 * remediation lanes whose edit lands in source. Callers that want
 * the "anything `suggest_fix` can act on" slice sum
 * `fixesByClass.mechanical + fixesByClass.guidance`.
 *
 * The former `safeEditsAvailable` headline (which counted the two
 * editable lanes under a single composite number) was dropped per
 * Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT: it sat as a sibling
 * to `fixesByClass.mechanical` under names that both framed as "how
 * many fixes an agent can apply," but measured different slices
 * (payload-availability vs. rule-demanded lane) and disagreed by up to
 * 18× on real field-report responses. The same disagreement-with-itself
 * pattern drove the deletion of the
 * top-level `violations` counter.
 */
export interface AgentPlan {
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
