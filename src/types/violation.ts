/**
 * Types for violations and scan results.
 *
 * A {@link Violation} is what a rule emits when it finds a problem. It cites
 * both the rule ID that produced it and the criteria (across every enabled
 * standard) that the violation maps to — so a single check can inform the
 * WCAG 2.2 report, the Section 508 report, and the EN 301 549 report from
 * the same run.
 *
 * See docs/kb/architecture/rule-engine.md.
 */

export type Severity = "error" | "warning" | "info";

/** A location in a source file. Byte-offset-agnostic; columns are 1-based. */
export interface Location {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

/** A structured edit that an auto-fixer can apply. */
export interface Fix {
  readonly type: "insert" | "replace" | "delete";
  readonly range: { readonly start: number; readonly end: number };
  readonly text: string;
  readonly description: string;
  readonly safety: "safe" | "unsafe";
}

/**
 * Ranked resolution paths for a violation, split into the most-likely
 * fix and lower-likelihood alternatives. Labels are human-readable
 * sentences the agent can act on ("widen aria-label to contain the
 * visible text…"). When a rule can also produce a mechanical edit it
 * may populate `edit` on a path; absent `edit`, the path is guidance
 * only (still more useful than an empty oldText/newText pair).
 *
 * `editCandidate` is the softer sibling of `edit`: a synthesized
 * rewrite the rule would write "if it had to" — same shape as `edit`,
 * but the caller still has to decide whether the text is right. The
 * response `kind` remains `"guidance"` when only `editCandidate` is
 * populated (see `buildSuggestFixPayload`) — promotion to `kind: "edit"`
 * is reserved for deterministic rewrites. Use this for cases where a
 * templated rewrite is useful as a starting point but the choice of
 * phrasing is genuinely the author's call (e.g. `label-in-name` when
 * visible-text tokens are non-contiguous in aria-label).
 *
 * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": omit
 * `editCandidate` entirely when no candidate can be synthesized; never
 * emit `editCandidate: { oldText: "", newText: "" }`.
 */
export interface FixPath {
  readonly label: string;
  readonly edit?: {
    readonly oldText: string;
    readonly newText: string;
  };
  readonly editCandidate?: {
    readonly oldText: string;
    readonly newText: string;
  };
}

export interface FixPaths {
  readonly primary: FixPath;
  readonly alternatives: readonly FixPath[];
}

/** A single accessibility finding emitted by a rule. */
export interface Violation {
  readonly ruleId: string;
  /**
   * Remediation lane this finding routes into, stamped from the rule's
   * `fixClass` metadata at emit time. Values: `"mechanical"`,
   * `"guidance"`, `"runtime-only"`, `"verify-in-source"`. See
   * {@link import("./rule.ts").FixClass} and docs/adr/0007-violation-fix-class-metadata.md.
   *
   * Inlined on every violation so agents can batch-route findings at
   * scan time without a per-finding `suggest_fix` round-trip. Distinct
   * from `suggest_fix`'s response-level `kind: "edit" | "guidance"` —
   * that describes what the suggest_fix payload *contains*; `fixClass`
   * describes the *nature* of the fix the rule demands.
   */
  readonly fixClass: import("./rule.ts").FixClass;
  /** Criterion IDs this violation counts against, filtered to enabled standards. */
  readonly criteria: readonly string[];
  /**
   * Short human titles for {@link Violation.criteria}, aligned index-for-index:
   * `criteriaTitles[i]` is the title of `criteria[i]`. Lets consumers compose
   * PR bodies, commit messages, and human-readable reports without a second
   * `explain_rule` / `explain_standard` round-trip.
   *
   * When the criterion ID cannot be resolved against any loaded standard
   * (should not happen in practice — belt-and-braces), the criterion ID
   * itself is emitted as its own title rather than an empty string. Per
   * CLAUDE.md §1 "Ambiguous field shapes are dishonest," empty placeholders
   * are a silent-miss hazard; the ID as a fallback is deterministic and
   * always non-empty.
   *
   * Optional so that callers building synthetic Violations (e.g. crash
   * records with `criteria: []`) don't have to populate a parallel empty
   * array, but the engine stamps it on every emitted finding.
   */
  readonly criteriaTitles?: readonly string[];
  readonly severity: Severity;
  readonly location: Location;
  readonly message: string;
  readonly suggestion?: string;
  readonly fix?: Fix;
  readonly fixPaths?: FixPaths;
  readonly snippet?: string;
  /**
   * Scanner-level confidence that this is a real finding. Distinct from
   * `severity` (which is the WCAG-side impact if real) and from the
   * agent-response `Confidence` mirror that derives from severity. Four
   * values:
   *
   *   - `"high"` / `"medium"` / `"low"` — classical confidence levels,
   *     reserved for rules that want to signal probabilistic strength.
   *     Most rules leave this field unset; forwarders treat "unset" as
   *     "inherit from severity" (the agent-response layer does this).
   *   - `"inherited"` — this finding was synthesized from a finding at
   *     a wrapper DEFINITION (Q2R2-INHERITED). The real site that
   *     needs fixing is `sourceOfFinding`; this location is a call site
   *     surfaced so the agent sees the downstream impact. Agents MAY
   *     branch on `"inherited"` to group, sort, or route, but per
   *     CLAUDE.md §1 "Don't downgrade priority to hide things" the
   *     scanner never hides inherited findings — every call site is
   *     surfaced.
   *
   * Present-when-meaningful. Unset by default.
   */
  readonly confidence?: "high" | "medium" | "low" | "inherited";
  /**
   * When this finding was synthesized from another location (e.g.
   * inherited from a wrapper definition, per Q2R2-INHERITED), points
   * at the source of truth — the location the agent should fix.
   * Absent on primary findings. Present-when-meaningful; forwarders
   * use a conditional spread so `sourceOfFinding: undefined` never
   * reaches the wire (CLAUDE.md §1 "Ambiguous field shapes are
   * dishonest").
   *
   * See docs/adr/0012-wrapper-introspection-role.md.
   */
  readonly sourceOfFinding?: {
    readonly filePath: string;
    readonly line: number;
    readonly column?: number;
  };
  /**
   * Stable identity for the finding — the same opaque token across
   * re-runs of the same scan, so an agent can verify "did my edit
   * close finding X?" by exact identity rather than fuzzy `(file,
   * line, ruleId)` matching. Survives line-number drift inside the
   * file when unrelated code is inserted above the violation, and
   * survives edits to ANY line other than the violation's own
   * (V1-FINDING-ID-STABILITY).
   *
   * Computed as `sha256(ruleId, relativeFilePath, normalizedLineText,
   * variantKey?)` truncated to 12 hex chars. See
   * `src/utils/finding-id.ts` for the exact recipe. Required on
   * every Violation — if a call site needs to synthesize one, use
   * `computeFindingId`.
   */
  readonly findingId: string;
  /**
   * Stable grouping key for findings that share a rule and an AST
   * shape. Sibling of `findingId` with opposite polarity: `findingId`
   * identifies *one finding* across runs, `groupKey` identifies *one
   * kind of problem* across findings. Same rule firing on
   * AST-equivalent `<img>` elements in 40 files → same `groupKey`.
   *
   * Lets agents write "fix every finding with groupKey X the same
   * way" scripts without re-deriving the pattern from rule ID +
   * filename + line number.
   *
   * Computed as `sha256(ruleId + "\0" + normalizedShape)` truncated to
   * `GROUP_KEY_HEX_LENGTH` hex chars. See `src/utils/group-key.ts`
   * and `describeNodeShape` in `src/engine/ast-helpers.ts` for the
   * exact recipe. Required on every Violation — if a call site needs
   * to synthesize one (synthetic crash records, test helpers), use
   * `computeGroupKey` with `UNKNOWN_SHAPE`.
   *
   * See docs/adr/0008-violation-group-key.md.
   */
  readonly groupKey: string;
  /**
   * Stable *source-pattern* fingerprint — the third dedup token, sibling
   * of `findingId` (cross-run identity) and `groupKey` (AST-shape
   * grouping). Computed from the emitted `snippet` after canonicalizing
   * attribute order, trivial whitespace, unique id/class tokens, and
   * template/SSG interpolation placeholders.
   *
   * Motivation (Q6-PATTERN-FINGERPRINT-CROSS-TEMPLATE): website-template
   * catalogs copy-paste the same Bootstrap navbar snippet across 174
   * sibling template directories. `findingId` differs by file, and
   * `groupKey` differs when attribute VALUES differ (e.g.
   * `class="navbar-toggle btn-primary"` vs `class="navbar-toggle btn-secondary"`
   * share the AST shape but not the full value set — yet both round
   * to the same canonical pattern). Without `patternId`, an agent has
   * no affordance to bulk-dismiss or bulk-fix "this pattern, everywhere
   * it appears." With it, `patternId === X` identifies one canonical
   * copy regardless of filename, line, or unique-id churn.
   *
   * Surface-don't-suppress: every finding still appears individually;
   * `patternId` is additive affordance, not a filter (per
   * docs/kb/architecture/ai-first-consumer.md).
   *
   * Optional / present-when-meaningful: only stamped when the rule
   * emitted a non-empty `snippet` (otherwise the canonicalized input
   * would be empty and the hash would be meaningless). Forwarders MUST
   * use a conditional spread so `patternId: undefined` never reaches
   * the wire (CLAUDE.md §1 "Ambiguous field shapes are dishonest").
   *
   * See `src/utils/pattern-id.ts` for the canonicalization recipe.
   */
  readonly patternId?: string;
  /**
   * Structured reason codes naming known escape hatches that could
   * make this finding a false positive in context. Each entry is a
   * stable snake_case identifier (`replacement_indicator_in_sibling_file`,
   * `tailwind_class_on_consumer`, …) pointing at a specific pattern an
   * agent can investigate with one `Read` or `Grep`.
   *
   * Strictly **informational**. Per the AI-first consumer doctrine
   * (docs/kb/architecture/ai-first-consumer.md §"No heuristic
   * suppression"), the scanner does NOT auto-suppress, downgrade, or
   * bucket findings based on the presence of codes — the agent reads
   * the cited file and decides. The scanner's attribute-level evidence
   * is categorically weaker than the agent's file-level evidence.
   *
   * Rules that know their own false-positive axes populate this field
   * at `ctx.emit()` time. Rules with no known escape hatches omit the
   * field. Optional: present-when-meaningful. Forwarders MUST NOT emit
   * `couldBeWrongBecause: []` (CLAUDE.md §1 "Ambiguous field shapes
   * are dishonest") — use a conditional spread:
   *
   * ```ts
   * ...(v.couldBeWrongBecause && v.couldBeWrongBecause.length > 0
   *   ? { couldBeWrongBecause: v.couldBeWrongBecause }
   *   : {})
   * ```
   *
   * See docs/adr/0009-violation-could-be-wrong-because.md.
   */
  readonly couldBeWrongBecause?: readonly string[];
  /**
   * Raw class-attribute evidence captured at emit time by rules whose
   * detection keys off a class attribute (currently `aria/icon-font-hidden`).
   * Fuels the per-file-per-class-pattern concentration aggregation in
   * {@link PerRuleCoverage.classPatternConcentration} — the aggregator
   * splits the value on whitespace, derives the rule-family pattern
   * (e.g. `fa fa-*`), and rolls up samples + counts per file.
   *
   * Optional: present-when-meaningful. Rules that don't participate in
   * class-pattern rollup omit the field. Never the empty string — the
   * conditional spread at the emit site keeps `classEvidence: ""` off
   * the wire per CLAUDE.md §1 "Ambiguous field shapes are dishonest."
   */
  readonly classEvidence?: string;
  /**
   * Cross-file occurrence list for findings the MCP assembly layer
   * identified as identical copies of the same (ruleId, `patternId` or
   * canonicalized message) across sibling files sharing a basename.
   *
   * Canonical acute case (Q6-CONTRAST-VENDOR-CSS-CROSS-FILE-DEDUPE):
   * website-template catalogs ship one `bootstrap.css` / `animate.css`
   * per template directory, so `contrast/minimum` emits the same
   * `(selector, ratio, colors)` finding 100+ times across sibling copies
   * of the vendor bundle. Without this field, each copy shows up as an
   * independent finding and the agent has no affordance for "one fix
   * propagates to N siblings." With it, one canonical finding ships
   * with `vendorOccurrences: [{ path, line }, …]` naming every copy —
   * agents bulk-route the fix once.
   *
   * Surface-don't-suppress: the collapsed siblings are fully enumerable
   * via the occurrences list. This is the dedupe analogue of the review
   * layer's {@link import("./review.ts").ReviewCandidateSibling}
   * rollup — same shape polarity (one canonical + occurrences list) on
   * the finding side.
   *
   * Stamped by the MCP assembly layer (`src/mcp/vendor-dedupe.ts`), not
   * by rules — rules stay pure. Present-when-meaningful: omitted on
   * singleton findings (never `[]`). When present, the list always
   * includes the canonical finding's own `(filePath, line)` as the
   * first entry so consumers can iterate without a second lookup.
   *
   * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": omit
   * `vendorOccurrences` entirely when no dedupe happened; never emit
   * `vendorOccurrences: []` as a sentinel.
   */
  readonly vendorOccurrences?: readonly {
    readonly path: string;
    readonly line: number;
  }[];
}

/**
 * Per-rule coverage confidence for a single scan. Answers "this rule
 * produced 0 findings — should I trust that?" for every rule the scan
 * evaluated. The canonical acute case: `contrast/minimum` targets
 * `.css`, and a Tailwind project pre-build has 0 eligible CSS sources
 * — a clean tally means nothing.
 *
 * Invariant (V1-META-RULES-EVALUATED-COVERAGE-DRIFT): every rule in
 * the "was evaluated" set gets exactly one entry — that's the same set
 * that drives `meta.rulesEvaluated`, so
 * `perRuleCoverage.length === meta.rulesEvaluated` by construction.
 * Zero-eligible rules surface as `filesEvaluated: 0` with
 * `coverageConfidence: "low"` rather than going silently absent; the
 * agent can tell "ran-with-zero-eligible-files" from "never-ran"
 * without guessing.
 *
 * Semantics:
 *   - `filesEligible` — parseable files whose extension matches the
 *     rule's `appliesTo.fileExtensions`. Project-scoped rules
 *     (`afterProject` only) evaluate against the full scanned-file set
 *     in one shot, so their `filesEligible` equals the scan's
 *     `filesScanned`.
 *   - `filesEvaluated` — subset of eligible files the rule actually
 *     ran over (non-eligible files are filtered out before invocation;
 *     evaluated <= eligible by construction).
 *   - `findingsEmitted` — count of violations this rule emitted in this
 *     scan. Always populated, including zero — `0` is the meaningful
 *     "rule ran and found nothing" signal that pairs with
 *     `coverageConfidence` to distinguish "confidently clean" from
 *     "clean but didn't exercise the pattern." Schema-required: never
 *     omit, never `null` (V1-SHAPE-RULECOV-COUNT).
 *   - `coverageConfidence` — three-valued discriminator:
 *       - `"low"` when `filesEligible === 0` or the rule ran on fewer
 *         than `MIN_FILES_FOR_HIGH_CONFIDENCE` files. Carries the
 *         zero-eligible-files case (`filesEvaluated: 0` with a `reason`
 *         naming the gap).
 *       - `"medium"` when the rule has `crossFileCapable: false` (see
 *         {@link import("./rule.ts").Rule.crossFileCapable}) and was
 *         invoked on a substrate that truncates its evidence horizon —
 *         e.g. `keyboard/handler-missing` on an HTML-only scan_file
 *         call where the click handler is wired from an external `.js`
 *         file the rule cannot see. The rule ran; its evidence was
 *         bounded. Carries a structured `reason` naming the bound
 *         (e.g. `"cross_file_listener_resolution_limited_on_this_input"`).
 *         Introduced by ADR 0026; not yet emitted by any producer —
 *         the downstream audit (Q5-COVERAGE-CONFIDENCE-HONESTY-CROSS-
 *         FILE-BLINDSPOT) wires the downgrade.
 *       - `"high"` otherwise — the rule ran on eligible inputs and the
 *         substrate was not known to bound its evidence horizon.
 *     The three-valued enum names the continuum in one place rather
 *     than pairing `"high" | "low"` with a sibling `coverageBounded`
 *     boolean (see ADR 0026). Finer-grained labels like `"no-eligible-
 *     files"` were rejected — the `reason` field already names that
 *     structurally.
 *   - `reason` / `remediation` — populated only on low-confidence
 *     entries, per CLAUDE.md §1 "Ambiguous field shapes are dishonest"
 *     (conditional spread at the response-assembly site).
 *   - `concentration` — present only when the rule's findings cluster
 *     heavily on a single file (total > threshold, densest-file share
 *     > threshold). Honest hint, not a suppression — every finding
 *     remains in `files[].findings`; the field points the agent at the
 *     file where the idiom likely lives so a single read can triage
 *     many candidates. Omitted entirely when the rule doesn't clear
 *     both thresholds (V1-NOISE-RULE-PER-FILE-ROLLUP).
 *
 * Produced by the scanner as a sibling field on
 * {@link import("../engine/scanner.ts").ScanProducts} — not on
 * {@link ScanResult}, because the MCP response layer is the sole
 * consumer. Keeping it off the shared result type avoids churning every
 * fixture that constructs a `ScanResult` literal when the shape evolves.
 *
 * See also: the top-level `ruleCoverage` derivative on scan responses
 * (`confidentlyClean` vs `lowConfidenceClean`) assembled by the MCP
 * layer from this array.
 */
export interface PerRuleCoverage {
  readonly ruleId: string;
  readonly filesEvaluated: number;
  readonly filesEligible: number;
  /**
   * Count of findings this rule emitted in this scan. Zero is meaningful
   * — "rule ran and found nothing." Always populated; pair with
   * {@link coverageConfidence} to distinguish "confidently clean" from
   * "clean but didn't exercise the pattern."
   */
  readonly findingsEmitted: number;
  /**
   * Scan-confidence discriminator. Three values:
   *
   *   - `"high"` — rule ran on eligible inputs; trust the clean tally.
   *   - `"medium"` — rule ran but its evidence horizon was bounded
   *     (see {@link import("./rule.ts").Rule.crossFileCapable}). Paired
   *     with a structured {@link reason}. Introduced by ADR 0026 and
   *     reserved for the downstream audit — current producers never
   *     emit this value.
   *   - `"low"` — rule had zero eligible files, or ran on fewer than
   *     `MIN_FILES_FOR_HIGH_CONFIDENCE` files. Paired with a {@link reason}
   *     + {@link remediation}.
   */
  readonly coverageConfidence: "high" | "medium" | "low";
  readonly reason?: string;
  readonly remediation?: string;
  /**
   * Structured code naming the substrate-level cause of a confidence
   * downgrade, when the cause is parser-level rather than rule-level.
   *
   * Sibling of {@link reason}: `reason` is human-prose or rule-family
   * structured codes (`"no files matching .css were scanned"`,
   * `"cross_file_listener_resolution_limited_on_this_input"`); this
   * field is a strict kebab-case enum that the response-assembly layer
   * stamps when files in the scan failed to parse cleanly. Both can
   * coexist on one row when a rule had a low-confidence cause AND a
   * parse-error file matched its extension gate (e.g. zero eligible CSS
   * files PLUS a `.css` file that failed to parse — both are honest
   * signals the agent reads on different axes).
   *
   * Values:
   *   - `"file-parse-error"` — at least one file matching this rule's
   *     extension gate was in `meta.analysisCoverage.parseErrorFiles`
   *     (total parse failure, file invisible to rules). The rule's
   *     `filesEvaluated` excludes those files; the count an agent reads
   *     is the *clean-parse* count, not the gate's match count. Pairs
   *     naturally with the `parseErrorFiles` bucket for cross-reference.
   *   - `"partial-parse"` — at least one file matching the gate was in
   *     `meta.analysisCoverage.partialParseFiles` (parser emitted errors
   *     but rules fired on the recovered slice). The file IS counted in
   *     `filesEvaluated` because the rule did run on the recovered AST,
   *     but the evidence horizon is degraded — confidence drops to
   *     `"low"` so the agent reads the cited file rather than trusting
   *     the clean tally.
   *   - `"scss-unresolved-variables"` — at least one `.scss` file
   *     matching the rule's extension gate carried `$variable: …`
   *     declarations whose substitution pass produced zero literal-color
   *     usages downstream (V1-SCSS-CONTRAST-VARIABLES-ZERO-OUTPUT). The
   *     file parsed cleanly; the SCSS preprocessor cannot statically
   *     resolve mixin bodies / `@function` / cross-file `@use` /
   *     interpolation — so a token-only theme partial like
   *     `_variables.scss` produces an empty AST and contrast-rule
   *     coverage on that substrate is honestly bounded. Confidence drops
   *     to `"medium"` (not `"low"` — the rule did run; the substrate's
   *     variable layer was outside the static scanner's reach), with a
   *     `reason` telling the agent to scan the compiled CSS output for
   *     full coverage. Pairs with the response-level
   *     `scss_unresolved_variables` warning code carrying the file list.
   *
   * Stamped by the MCP assembly layer (`src/mcp/scan-assembly.ts`), not
   * by the engine — rules and the per-rule-coverage builder stay pure
   * over the scanner's evaluation tracker. Present-when-meaningful per
   * CLAUDE.md §1 "Ambiguous field shapes are dishonest": absent when no
   * parse-error / partial-parse / unresolved-variable files contributed
   * to this rule's gate.
   *
   * Doctrine: zero-output success is ambiguous failure. Without this
   * field, a rule whose only eligible files all failed to parse would
   * surface as `findingsEmitted: 0, coverageConfidence: "high"` — the
   * agent reads "ran clean" when the truth is "rules never saw the
   * file" (V1-PERRULE-COVERAGE-HONESTY-ON-PARSE-ERRORS).
   */
  readonly coverageConfidenceReason?:
    | "file-parse-error"
    | "partial-parse"
    | "scss-unresolved-variables";
  /**
   * Honest per-rule file-concentration hint: when a rule's findings
   * cluster on one file (total > {@link findingsEmitted} threshold AND
   * densest-file share strictly exceeds 50%), points at that file with
   * its finding count. Zero information loss — every finding stays in
   * `files[].findings`; this is additive scan-confidence telemetry on
   * top of the per-rule row so agents can read the idiom's home once
   * instead of N times. Omitted (conditional spread) when the rule
   * doesn't clear both thresholds, per CLAUDE.md §1 "Ambiguous field
   * shapes are dishonest" (V1-NOISE-RULE-PER-FILE-ROLLUP).
   *
   * The optional `kind: "vendor"` annotation is stamped by the MCP
   * response-assembly layer when the densest file is classified as a
   * build artifact (see `src/mcp/build-artifacts.ts`) AND the finding
   * count crosses a stricter vendor-only floor — the canonical acute
   * case is `motion/pause-stop-hide` firing 8940 times against
   * `bootstrap.css` alone on a vendor-heavy scan. Absence of `kind`
   * means either (a) the file is authored code, or (b) the call site
   * didn't plumb vendor classification (e.g. `scan_file` on an
   * explicit path). Vendor awareness is additive signal only — no
   * findings are filtered or downgraded by the tag
   * (Q6-MOTION-PAUSE-STOP-PER-FILE-AGGREGATION).
   */
  readonly concentration?: {
    readonly file: string;
    readonly count: number;
    readonly kind?: "vendor";
  };
  /**
   * Per-file-per-class-pattern concentration rollup for rules whose
   * detection keys off a class attribute. Sibling of
   * {@link concentration} with finer grain: instead of "one file
   * dominates by finding count," it names "one class pattern repeats
   * within one file" so the agent can route "one fix applied
   * site-wide" triage in a single read.
   *
   * Canonical acute case: `aria/icon-font-hidden` emits 180 findings
   * on a Bootstrap-admin template; most are sibling buttons repeating
   * the `<i class="fa fa-*">` idiom in one file. `groupKey` already
   * groups across files, but the agent still pays 180 findings' worth
   * of attention budget to confirm the idiom is one fix; this hint
   * names the (file, pattern) home so the confirmation is one file
   * read.
   *
   * Zero information loss — every finding stays in `files[].findings`;
   * this is additive scan-confidence telemetry on top of the per-rule
   * row. Omitted entirely (conditional spread) when no (file, pattern)
   * pair clears the thresholds, per CLAUDE.md §1 "Ambiguous field
   * shapes are dishonest."
   *
   * Thresholds (deliberately strict so the hint names real clusters,
   * not statistical noise — see `per-rule-coverage.ts`):
   *   - (file, pattern) count ≥ {@link CLASS_PATTERN_MIN_COUNT}
   *   - (file, pattern) count / rule's total findings on that file
   *     ≥ {@link CLASS_PATTERN_MIN_SHARE}
   *
   * Populated only for rules in the class-pattern registry (currently
   * `aria/icon-font-hidden`). Other rules omit the field regardless
   * of their finding volume.
   */
  readonly classPatternConcentration?: readonly {
    readonly file: string;
    readonly count: number;
    /**
     * Canonicalized class pattern (e.g. `fa fa-*`, `material-icons`,
     * `bi bi-*`) derived from the family marker plus glyph-slug
     * prefix. Rule-specific — the extractor lives alongside the
     * aggregation in `per-rule-coverage.ts` so new rules can opt in
     * by registering their own pattern derivation.
     */
    readonly classPattern: string;
    /**
     * Up to {@link CLASS_PATTERN_MAX_SAMPLES} distinct class-attribute
     * values observed in this (file, pattern) cluster — e.g.
     * `["fa fa-times", "fa fa-home", "fa fa-search"]`. Lets the agent
     * sanity-check the pattern against concrete evidence without
     * re-reading N findings. Sorted for deterministic output.
     */
    readonly samples: readonly string[];
  }[];
}

/** Aggregate result of a full scan. */
export interface ScanResult {
  readonly violations: readonly Violation[];
  readonly filesScanned: number;
  readonly durationMs: number;
  readonly enabledStandards: readonly string[];
  readonly isTTY: boolean;
}

/** Structured data produced from a ScanResult, consumed by formatters and reports. */
export interface ReportData {
  readonly coverage: readonly CoverageEntry[];
  readonly manualReviewNeeded: readonly string[];
  /** Review candidates grouped by criterion ID (populated when finders are run). */
  readonly candidates?: readonly import("./review.ts").ReviewCandidate[];
}

export interface CoverageEntry {
  readonly standardId: string;
  readonly automated: number;
  readonly total: number;
  readonly passing: number;
  readonly failing: number;
}
