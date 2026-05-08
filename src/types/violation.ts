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
   * scan time without a per-finding `suggest_fix` round-trip. Sibling
   * of `suggest_fix`'s response-level `kind` discriminator: the
   * per-call shape uses the same lane vocabulary (`mechanical →
   * "edit"`, `verify-in-source → "verify-in-source"`, `runtime-only →
   * "runtime-only"`, `guidance → "guidance"`, plus the suppression-
   * flavored carve-out `"suppress-recommended"` and the no-match
   * `"none"`) so per-finding `fixClass` and per-call `kind` partition
   * the same finding into the same lane. Per
   * `docs/kb/architecture/ai-first-consumer.md` "Per-call shape must
   * agree with per-class plan tally."
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
  /**
   * Declaration-line sibling for selector-scoped findings, where the
   * structural anchor (the CSS rule whose selector defines what the
   * finding applies to) sits one or more lines above the offending
   * `animation:` / `transition:` declaration. `location.line` carries
   * the selector start line — the structural anchor an agent reads to
   * understand what the rule targets — and `decline` (declaration line)
   * carries the line of the offending declaration token within that
   * rule.
   *
   * Canonical case: an icon-spinner
   * selector opens at line 80; an unprefixed `animation:` declaration
   * sits at line 84. Without the split, the finding cited line 84 and
   * the agent reading the file saw the declaration but had to scroll up
   * four lines to find the selector context (which determines whether
   * the rule is interaction-triggered or auto-playing). With the split,
   * `line` = 80 (the agent lands on the structural anchor) and
   * `decline` = 84 (the agent knows where the offending token is).
   *
   * Optional / present-when-meaningful: only stamped when (a) the rule
   * is selector-scoped and (b) the declaration line differs from the
   * selector line. A single-line `.x { animation: spin 1s infinite }`
   * has selector and declaration on the same line — `decline` is
   * omitted. Per CLAUDE.md §1 "Ambiguous field shapes are dishonest,"
   * forwarders use a conditional spread so `decline: undefined` never
   * reaches the wire. Currently emitted by `motion/pause-stop-hide`;
   * other selector-scoped CSS rules may opt in by emitting it.
   */
  readonly decline?: number;
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
   * a wrapper DEFINITION. The real site that
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
   * inherited from a wrapper definition, per), points
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
   * Per-emission unique address — the token `suggest_fix(findingId)`
   * and source-level disable pragmas resolve against. Every emission
   * within a single scan response gets a distinct id, even when two
   * findings share the same rule + file + line text (the prior
   * single-token design collapsed those into one id, breaking
   * addressability).
   *
   * Computed as `sha256(ruleId, relativeFilePath, line, column,
   * variantKey?)` truncated to 12 hex chars. See
   * `src/utils/finding-id.ts` for the exact recipe. Required on
   * every Violation — if a call site needs to synthesize one, use
   * `computeFindingId`.
   *
   * For cross-run identity (baselines, scan_diff), use
   * {@link findingGroupId} — that token is line-drift resilient,
   * `findingId` is not.
   */
  readonly findingId: string;
  /**
   * Cross-run-stable identity. The same opaque token across re-runs
   * of the same scan even when an unrelated edit shifts the
   * violation's line number — baselines and `scan_diff` match on
   * this token, not on `findingId`.
   *
   * Hashes `(ruleId, relativeFilePath, normalizedLineText,
   * variantKey?)`; line NUMBER is deliberately NOT in the input so
   * inserting code above the violation does not invalidate the
   * baseline entry. Two emissions of the same rule whose violation
   * lines hold byte-identical text collapse to one
   * `findingGroupId` — the dedup behavior baselines and propose-
   * baseline depend on. For per-emission addressability use
   * {@link findingId}, which always distinguishes those emissions.
   *
   * Computed as `sha256(ruleId, relativeFilePath, normalizedLineText,
   * variantKey?)` truncated to 12 hex chars. See
   * `src/utils/finding-id.ts` for the exact recipe. Required on
   * every Violation — if a call site needs to synthesize one, use
   * `computeFindingGroupId`.
   */
  readonly findingGroupId: string;
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
   * Motivation: website-template
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
   * Sibling cross-file fingerprint for findings whose dedup unit is a
   * CSS selector + property + value triple rather than an HTML/JSX
   * element snippet. {@link patternId} cannot fingerprint CSS-
   * declaration rules because its canonicalization gates on a non-
   * empty `snippet`, and rules like `contrast/minimum`,
   * `contrast/non-text`, `contrast/enhanced`, and
   * `motion/pause-stop-hide`'s CSS branches don't emit one. Without
   * this token, a website-template catalog with 117 byte-identical
   * `.img-thumbnail { transition: …; }` rules collapses to 117
   * distinct `(ruleId, groupKey)` pairs because `groupKey` walks the
   * per-file AST shape — the cross-file collapse mode has no
   * affordance for "same canonical CSS declaration, N copies."
   *
   * `cssPatternId` is computed from
   * `sha256(ruleId + selectorFamily + propertyFamily + valueShape)`
   * (see `src/utils/css-pattern-id.ts`) — not from a snippet — so the
   * 117 copies collapse to one fingerprint by construction. Rules
   * populate the structured triple at emit time via
   * {@link import("./rule.ts").EmittedViolation.cssFingerprint}; the
   * engine's stamp sites hash it into this token.
   *
   * Surface-don't-suppress: every finding still appears individually;
   * `cssPatternId` is additive affordance, not a filter (per
   * docs/kb/architecture/ai-first-consumer.md). The collapse helper
   * in `src/mcp/scan-project-collapse-by-group.ts` consumes the token
   * to bucket cross-file copies into one canonical entry with a
   * full `occurrences[]` enumeration — the agent reads "117 copies of
   * one canonical pattern" without paging through 117 finding rows.
   *
   * Optional / present-when-meaningful: only stamped when the rule
   * emitted a non-empty `cssFingerprint`. Forwarders MUST use a
   * conditional spread so `cssPatternId: undefined` never reaches
   * the wire (CLAUDE.md §1 "Ambiguous field shapes are dishonest").
   */
  readonly cssPatternId?: string;
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
   * Canonical acute case:
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
  /**
   * In-file sibling rollup for findings the **rule itself** identified
   * as N near-identical emissions on visually-grouped sibling elements
   * sharing the same parent and the same `(tagName, type, attributes-
   * modulo-id)` shape. Distinct from {@link vendorOccurrences} (cross-
   * file copies stamped by the MCP assembly layer): `siblingInstances`
   * is intra-file, intra-parent, and stamped by the rule at emit time
   * because only the rule has the parent-DOM context.
   *
   * Canonical acute case: a
   * one-time-code (OTP) cluster — six `<input class="otp" type="number"
   * maxlength="1">` siblings sharing one parent, each missing a label.
   * Without the rollup, `forms/labels-required` emitted six findings
   * with identical `groupKey` and identical fix shape; with the rollup,
   * one canonical finding ships with `siblingInstances: [{ line, id? },
   * …]` naming every sibling the agent should fix together. Same
   * pattern applies to quiz radio-button sets and day-of-week checkbox
   * sets.
   *
   * Surface-don't-suppress: the collapsed siblings are fully enumerable
   * via the list. The list always includes the canonical finding's own
   * `(line, id?)` as the first entry so consumers can iterate without a
   * second lookup. Threshold: ≥3 siblings sharing the fingerprint
   * trigger collapse — singletons and pairs stay individually emitted
   * because the rollup is meaningful only when the cluster has the
   * shape of a deliberate visual group.
   *
   * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": omit
   * `siblingInstances` entirely when no collapse happened; never emit
   * `siblingInstances: []` as a sentinel. Forwarders use a conditional
   * spread.
   *
   * See `src/rules/forms/labels-required.ts` for the canonical emit
   * site and the fingerprint recipe.
   */
  readonly siblingInstances?: readonly {
    readonly line: number;
    readonly id?: string;
  }[];
  /**
   * Structured discriminating evidence the rule observed when emitting
   * this finding — the same fact the rule's prose `reason`/`message`
   * names, exposed as a typed sub-shape so an agent triaging high-
   * volume findings can branch on the evidence without parsing English.
   *
   * Canonical motivating case: `semantics/list-structure` fires on
   * "list container has a non-`<li>` child" — at 59 emissions on one
   * scan, an agent triaging "intentional `<hr>`-as-divider sibling
   * under `<ul>`" vs "real list misnesting" otherwise has to read
   * source for every finding because the offending tag is buried in
   * the prose. With `evidence`, the agent reads
   * `evidence.kind === "list-wrong-child"` plus
   * `evidence.offendingChildTag` and routes the triage branch on the
   * first finding. Same pattern for `aria/expanded-on-disclosure`
   * (169 emissions, 4 predicate branches): the prose names the branch
   * but the agent has no machine-readable lever to "skip every
   * `disclosure-class`-branch finding and triage the
   * `aria-controls`-branch ones first."
   *
   * Discriminated union by `kind`. Each variant names the rule-family
   * that owns the shape — adding a new rule that wants structured
   * evidence adds a new `kind`. Variants stay small (≤4 fields) by
   * design: this is a discriminator, not a payload — anything that
   * needs richer shape lives on a per-rule sibling field
   * ({@link siblingInstances}, {@link classEvidence},
   * {@link concentration}, …).
   *
   * Surface-don't-suppress: every finding still appears individually
   * with its prose `message`/`suggestion`. `evidence` is ADDITIVE
   * structured signal — agents that don't read the field see no
   * regression from the existing prose; agents that do read it get a
   * machine-routable lever for high-density triage. Per
   * docs/kb/architecture/ai-first-consumer.md "Surface, don't
   * suppress" + "Don't duplicate capability the agent already has":
   * we are not interpreting the evidence, just exposing it as a
   * structured field instead of letting the agent re-derive it from
   * prose.
   *
   * Optional / present-when-meaningful per CLAUDE.md §1 "Ambiguous
   * field shapes are dishonest": rules that don't populate the field
   * omit it entirely (the rule-runner's stamp uses a conditional
   * spread). Never `evidence: {}`. Currently emitted by
   * `semantics/list-structure` (`list-wrong-child`) and
   * `aria/expanded-on-disclosure` (`disclosure-predicate-branch`).
   */
  readonly evidence?: ViolationEvidence;
}

/**
 * Structured discriminating evidence for high-density rules — see
 * {@link Violation.evidence} for motivation and the surface contract.
 *
 * Each variant is owned by one rule family. Adding a new variant adds
 * a new `kind` literal. Variant shapes stay narrow (≤4 fields) by
 * design — `evidence` is the discriminator the agent branches on,
 * not a payload that subsumes other Violation fields.
 */
export type ViolationEvidence =
  /**
   * `semantics/list-structure` — emitted on the "list container has a
   * non-`<li>` child" branch. Names the offending child tag (e.g.
   * `"hr"`, `"div"`) and, when present, its class attribute, so an
   * agent can branch "intentional `<hr>`-as-divider" vs "real list
   * misnesting" without reading the source. Stray-`<li>` and JSX-
   * primitive emissions don't carry this evidence shape — the
   * structural fact those emissions name (`<li>` is outside any list
   * container) has no offending-child analog.
   */
  | {
      readonly kind: "list-wrong-child";
      readonly listTag: string;
      readonly offendingChildTag: string;
      readonly offendingChildClass?: string;
    }
  /**
   * `aria/expanded-on-disclosure` — names which predicate branch
   * fired so the agent can route the triage. The four branches map
   * 1:1 onto the rule's internal `PredicateBranch` discriminator:
   * `aria-controls` (the trigger references an existing id),
   * `data-toggle` (a `data-*-toggle` attribute carries a disclosure
   * value), `onclick-classlist` (an inline handler toggles a known
   * visibility class), `disclosure-class` (the trigger's own class
   * list contains a disclosure-pattern token). The `findingKind`
   * field distinguishes the two findings the rule emits
   * (`missing-expanded` vs `missing-controls`).
   *
   * Label-evidence fields (`visuallyHiddenLabelClass`, `inlineAriaLabel`)
   * are surfaced when the flagged trigger carries label signal in the
   * tree. Both fields are present-when-meaningful (omitted when the
   * underlying evidence is absent — never `null` / `false` sentinel)
   * per the AI-first consumer model. They exist to make the per-emit
   * severity downgrade auditable: severity drops from `warning` to
   * `info` when `visuallyHiddenLabelClass` is populated (two stacked
   * concessions in the message — see the rule docstring), and the
   * agent reading `evidence` can see which evidence inputs gated the
   * downgrade rather than re-deriving them from prose. Identical
   * evidence inputs across two findings therefore yield identical
   * severity + identical evidence shape — the cross-finding invariant
   * the AI-first doctrine requires.
   */
  | {
      readonly kind: "disclosure-predicate-branch";
      readonly predicateBranch:
        | "aria-controls"
        | "data-toggle"
        | "onclick-classlist"
        | "disclosure-class";
      readonly findingKind: "missing-expanded" | "missing-controls";
      /**
       * The matched visually-hidden class token (e.g. `sr-only`,
       * `visually-hidden`) on a direct element child of the flagged
       * trigger. Present when the trigger ships a hidden text label
       * inline (the Bootstrap collapse-button canonical pattern).
       * Drives the per-emit severity downgrade to `info`.
       */
      readonly visuallyHiddenLabelClass?: string;
      /**
       * `true` when the flagged trigger carries a non-empty inline
       * `aria-label` attribute (literal value for JSX). An inline
       * `aria-label` is provably part of the accessible name per
       * ARIA, so it does NOT trigger the severity downgrade — but
       * surfacing it as evidence keeps the cross-finding invariant
       * honest (two findings with identical evidence shape have
       * identical severity).
       */
      readonly inlineAriaLabel?: true;
    }
  /**
   * `semantics/landmark-main` — emitted on the missing-`<main>` branch
   * when a probable wrapper candidate exists in the document. Names the
   * largest top-level non-landmark block under `<body>` (the candidate
   * the rule would suggest wrapping in `<main>` or relabelling with
   * `role="main"`).
   *
   * The probable candidate is reproducible from the AST: among the
   * `<body>`'s direct element children, exclude landmark / non-visible
   * tags (`<header>`, `<footer>`, `<nav>`, `<aside>`, `<script>`,
   * `<style>`, `<noscript>`, `<template>`) and pick the one with the
   * most descendant elements (ties broken by document order). The
   * `selectorHint` field is populated when the candidate carries an
   * `id` or `class` attribute (rendered as `div#content` or
   * `div.app-shell`); omitted otherwise. Pre-fix, every fire on a
   * page-shaped HTML file with no `<main>` carried identical reason
   * text, leaving the agent with no per-file signal to triage. The
   * hint surfaces a concrete wrapping target.
   *
   * Same shape polarity as the other variants: discriminating evidence
   * exposed as a typed sub-shape so the agent can branch-route triage
   * without parsing prose. The prose `message` is also enriched with
   * the same evidence; `evidence` is the additive structured signal.
   */
  | {
      readonly kind: "landmark-main-probable-candidate";
      readonly tag: string;
      readonly line: number;
      readonly selectorHint?: string;
    }
  /**
   * `semantics/table-caption-missing` — emitted on the missing-caption
   * branch when a heading element (`<h1>`–`<h6>`) precedes the data
   * table within the same ancestor chain. Names the heading's tag and
   * line so the agent has a per-finding signal that the rule's
   * `aria-labelledby` alternative fix path is grounded in real markup
   * (rather than a generic "you could use aria-labelledby" prose).
   *
   * `id` is populated only when the heading already carries an `id`
   * attribute — its absence means the agent (or a mechanical edit)
   * would need to mint one before wiring `aria-labelledby` on the
   * `<table>`. The suggestion text exposes the same distinction in
   * prose; `evidence.id` is the machine-routable echo.
   */
  | {
      readonly kind: "table-caption-preceding-heading";
      readonly tag: string;
      readonly line: number;
      readonly id?: string;
    }
  /**
   * `semantics/section-accessible-name-missing` — emitted when an
   * unnamed `<section>` qualifies for the rule (body-direct-child or
   * landmark-sibling) and the rule found a nearby visible heading the
   * author could wire as the section's accessible name. The structured
   * fields let the agent compose the fix mechanically without reading
   * the source — when `id` is populated, the fix is
   * `aria-labelledby="<id>"`; when absent, the agent (or an edit) mints
   * an id on the heading first.
   *
   * Search recipe (mirrors the rule's `findNearestVisibleHeading`):
   *   - Preceding-sibling chain of the section's parent — the last
   *     `<h1>`–`<h6>` element appearing before the section in document
   *     order under the same parent.
   *   - Then the parent's preceding-sibling chain — same scan walked
   *     one level up, so a heading inside `<header>` or above the
   *     wrapping `<div>` is reachable.
   *
   * Pre-fix, every fire on a body-direct-child or landmark-sibling
   * section carried a generic `aria-labelledby="<id-of-existing-
   * heading>"` suggestion with no per-finding hint at *which* heading
   * — leaving the agent to read the file. Post-fix, the structured
   * evidence names the heading's tag, text, and line, so the agent
   * can compose the fix from the response alone. Same shape polarity
   * as the other variants: the prose `suggestion` is enriched with
   * the same data; `evidence` is the additive machine-routable echo.
   */
  | {
      readonly kind: "section-nearest-visible-heading";
      readonly tag: string;
      readonly text: string;
      readonly line: number;
      readonly id?: string;
    };

/**
 * Per-rule coverage confidence for a single scan. Answers "this rule
 * produced 0 findings — should I trust that?" for every rule the scan
 * evaluated. The canonical acute case: `contrast/minimum` targets
 * `.css`, and a Tailwind project pre-build has 0 eligible CSS sources
 * — a clean tally means nothing.
 *
 * Invariant (
 *): every rule the scanner loaded
 * (post-config-filter `activeRules`) gets exactly one entry — that's
 * the same set `meta.rulesEvaluated.loaded` counts, so
 * `perRuleCoverage.length === meta.rulesEvaluated.loaded` by
 * construction. Zero-eligible rules surface as `filesEvaluated: 0`
 * with `coverageConfidence: "low"`; rules pre-filtered by the active
 * conformance level (canonical: AAA-only rules under a default `AA`
 * scan) surface with {@link skipReason} = `"gated_by_level"` rather
 * than going silently absent. Either way, the agent can tell "ran-
 * with-zero-eligible-files" from "filtered before evaluation" from
 * "never-loaded" without guessing.
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
 * omit, never `null`.
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
 *         (e.g. `"cross_file_listener_resolution_not_attempted_by_rule"`).
 *         Introduced by ADR 0026; not yet emitted by any producer —
 * the downstream audit (-
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
 * both thresholds.
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
   * Convenience boolean equal to `findingsEmitted > 0` — `true` when the
   * rule produced at least one violation on this scan. Always populated.
   *
   * Stamped at row construction time so an agent reading
   * `meta.perRuleCoverage[]` can branch directly on `fired === true`
   * without re-deriving the predicate from `findingsEmitted`. The
   * canonical cross-surface invariant
   * `meta.rulesEvaluated.fired === count(perRuleCoverage[].fired === true)`
   * stays computable in one pass per surface; before this field, an
   * agent triaging a "rules that fired" question had to first scan the
   * array, count `findingsEmitted > 0` rows, and reconcile the result
   * against the headline counter — silent drift between the two reads
   * was difficult to detect without bespoke tooling. Adding the
   * deterministic flag at the row level pins the relationship at
   * construction time so downstream consumers cannot disagree.
   *
   * Schema-required: never omitted, never `null`. The boolean shape is
   * load-bearing — a sentinel-empty value would re-introduce the
   * "absent vs zero" ambiguity the AI-first consumer model rules
   * against.
   */
  readonly fired: boolean;
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
   * `"cross_file_listener_resolution_not_attempted_by_rule"`); this
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
   * usages downstream. The
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
   *   - `"fragment-input-no-document-envelope"` — at least one file
   *     matching the rule's extension gate parsed as an HTML fragment
   *     (no `<html>` root, no `<body>` descendant — Jekyll `_includes/`,
   *     Hugo / Astro / Handlebars partials, raw component templates, or
   *     README markdown residue). The file parsed cleanly; the rule ran
   *     against it; the rule's evidence model assumes the file IS the
   *     page (`semantics/landmark-main`, `semantics/heading-hierarchy`,
   *     `document/page-titled`, `document/lang-attribute`,
   *     `parsing/html-has-lang`, `semantics/empty-heading`). On a
   *     fragment, the document envelope a parent layout will provide is
   *     not visible to the scanner, so a clean tally on a fragment is
   *     bounded — the parent's `<main>` / `<title>` / `lang=` may
   *     satisfy the criterion. Confidence drops to `"medium"` (not
   *     `"low"` — the rule did run; the substrate is honestly out of
   *     scope for the rule's evidence model), with a `reason` pointing
   *     the agent at the cited file so the parent template is the next
   *     read. Pairs with the `analysisCoverage.fragmentFiles` list so
   *     the agent can cross-reference which files are fragments.
   *   - `"scss-partial-input"` — at least one `.scss` file matching
   *     the rule's extension gate is a Sass partial: basename starts
   *     with `_` AND the source declares a top-level `&` parent-
   *     reference selector (`&.foo { … }`, `&:hover { … }`). These
   *     are intentionally fragments — the file is meant to be `@use`d /
   *     `@import`ed by a sibling that wraps the content in a parent
   *     rule. The SCSS preprocessor's dangling-`&` verdict is correct
   *     in isolation but wrong about the file's authorial intent. The
   *     SCSS partial peer of `fragment-input-no-document-envelope`:
   *     parsed substrate, rule ran, evidence horizon bounded by the
   *     fragment-of-another-file shape. Confidence drops to `"medium"`
   *     so a clean tally on a partial doesn't read as `"high"` the
   *     rule could not honestly establish — the parent SCSS file's
   *     selector chain is unobservable here. Per backlog Q10 closure
   *     and AI-first doctrine "Heuristic-mislabeled meta sub-fields
   *     are dishonest": the parser bail surfaces under a
   *     classification reason rather than as a hard
   *     `parseErrorFiles[]` entry, so the agent reading per-rule
   *     coverage gets the structural signal without the parse-error
   *     narrative routing them toward "fix the parse error."
   *   - `"corpus-parse-error-rate-above-threshold"` — corpus-aggregation
   *     axis sibling of `"file-parse-error"` / `"partial-parse"`. The
   *     per-file adjuster intentionally lets a rule's aggregate stay
   *     `"high"` as long as one cleanly-parsed eligible file survives
   *     (per the per-file-not-corpus-wide invariant), but the agent
   *     reads the aggregate scalar to budget against — a 12% parse-
   *     error rate across a 4000-file corpus leaves every rule with
   *     ≥1 clean file showing `"high"` even though hundreds of its
   *     eligible files were invisible. This reason fires when the
   *     ratio of `byFile.length / filesEligible` exceeds the medium
   *     (10%) or low (25%) threshold, dropping the aggregate to
   *     `"medium"` or `"low"` accordingly. Reason text quotes the
   *     exact percentage so the agent can read the bound additively;
   *     per-file `byFile[]` still carries the per-file degradation
   *     for triage. Cross-references the same `parseErrorFiles[]` /
   *     `partialParseFiles[]` evidence the per-file adjuster consumed.
   *   - `"parse-bailed-non-jsx-in-tsx-route"` — at least one file
   *     matching this rule's extension gate was routed through the TSX
   *     parser despite a non-TSX natural parser (`.js` / `.ts` / `.mdx`)
   *     AND produced zero findings on that file. The TSX parser silently
   *     bails on relational expressions read as JSX (`r.length<b.length`)
   *     so the recovered AST may have no findings even when the source
   *     contains rule-relevant content. The same evidence drives the
   *     `parser_bailed_on_non_jsx_in_tsx_route` (project-shape) and
   *     `scan_file_parser_bail_no_findings` (single-file shape) warning
   *     codes — the per-rule downgrade keeps the per-rule layer honest
   *     when the warning channel reports the route ambiguity. Files that
   *     parsed cleanly through their natural parser are NOT in scope for
   *     this reason; only the silent-bail-suspect routing-mismatch case.
   *
   * Stamped by the MCP assembly layer (`src/mcp/scan-assembly.ts`), not
   * by the engine — rules and the per-rule-coverage builder stay pure
   * over the scanner's evaluation tracker. Present-when-meaningful per
   * CLAUDE.md §1 "Ambiguous field shapes are dishonest": absent when no
   * parse-error / partial-parse / unresolved-variable / fragment-input
   * files contributed to this rule's gate.
   *
   * Doctrine: zero-output success is ambiguous failure. Without this
   * field, a rule whose only eligible files all failed to parse would
   * surface as `findingsEmitted: 0, coverageConfidence: "high"` — the
   * agent reads "ran clean" when the truth is "rules never saw the
   * file".
   */
  readonly coverageConfidenceReason?:
    | "file-parse-error"
    | "partial-parse"
    | "scss-unresolved-variables"
    | "fragment-input-no-document-envelope"
    | "scss-partial-input"
    | "corpus-parse-error-rate-above-threshold"
    | "parse-bailed-non-jsx-in-tsx-route"
    | "astro-islands-unrendered-static-only";
  /**
   * Discriminator for an `eligible === 0` extension-gated row,
   * differentiating two structurally distinct gaps the original
   * `reason: "no files matching .css were scanned"` text conflated:
   *
   *   - `"extension-absent"` — the cwd genuinely contains no files of
   *     this rule's gated extension(s) anywhere under the project
   *     root. Acute case: a Tailwind project pre-build where no `.css`
   *     source exists; the agent should `additionalPaths: ["dist/"]`
   *     to reach compiled output, OR add `.css` source files.
   *   - `"extension-present-but-out-of-scope"` — files of the gated
   *     extension(s) DO exist somewhere under the cwd but were pruned
   *     from the scan by `additionalPaths`, the user's `exclude` list,
   *     default build-dir skips (`dist`, `build`, …), or `.gitignore`.
   *     The agent should broaden the scan scope, NOT add more paths.
   *     Acute case: a project with `.css` under `assets/` whose user
   *     ran `additionalPaths: ["dist/assets"]` thinking it widened
   *     coverage when it actually narrowed an already-out-of-scope
   *     subtree. The original `reason` text steered them toward the
   *     wrong fix; this field carries the structured discriminator
   *     and the row's `remediation` is rewritten accordingly.
   *
   * Stamped only on rows with `coverageConfidence: "low"`,
   * `filesEligible: 0`, and a non-empty `appliesTo.fileExtensions`.
   * Determined by a bounded directory walk at the cwd that does NOT
   * respect `.gitignore` / `exclude` / `additionalPaths` filters — the
   * point is to detect what the scoped scan was blind to. The walk
   * skips infrastructure dirs (`node_modules`, `.git`, language
   * virtualenvs) only; user-source extensions never live in those.
   *
   * Per `docs/kb/architecture/ai-first-consumer.md` "Heuristic-
   * mislabeled meta sub-fields are dishonest," the value is provable
   * from the directory walk's evidence — not a heuristic guess. Absent
   * when the caller didn't run the probe (e.g. `scan_file`'s explicit-
   * paths surface has no cwd-rooted scope to reason about), or when
   * the row is not an `eligible === 0` extension-gated case.
   */
  readonly subkind?: "extension-absent" | "extension-present-but-out-of-scope";
  /**
   * Reason this rule was loaded but did not run on this scan. Sibling of
   * {@link coverageConfidence} for the orthogonal "rule never executed"
   * axis: `coverageConfidence` answers "trust the clean tally" for rules
   * that DID run; `skipReason` answers "why is this row showing zero
   * across the board?" for rules that the engine pre-filtered before any
   * evaluation. Without this field, level-gated rules silently disappear
   * from `perRuleCoverage` and the agent reading "the AAA-only rule isn't
   * here" cannot tell "the rule wasn't loaded" from "the rule was loaded
   * but the active level filtered it out" — the canonical-
   * LOADER-SILENT-NORUN failure mode.
   *
   * Values:
   *   - `"gated_by_level"` — every cited criterion's level was strictly
   *     above the active conformance level (e.g. an AAA-only rule under
   *     a default `level: "AA"` scan). Pairs with {@link requiredLevel}
   *     (the rule's minimum criterion level) and {@link requestedLevel}
   *     (the active scan level) so the agent has the exact remediation
   *     ("re-run with `level: 'AAA'` to evaluate this rule") without
   *     needing a docs round trip.
   *
   * Present-when-meaningful per CLAUDE.md §1 "Ambiguous field shapes are
   * dishonest": rules that DID run never carry this field. Doctrine:
   * surface, don't suppress — the row exists so the agent knows the rule
   * is in the registry and what would unlock it, instead of inferring
   * "rule does not exist" from silent absence.
   */
  readonly skipReason?: "gated_by_level";
  /**
   * Minimum conformance level any of the rule's cited criteria require —
   * the level a caller would have to request for the rule to run. Stamped
   * only when {@link skipReason} is `"gated_by_level"`. The
   * `"base"` value covers Section 508 / EN 301 549-style standards that
   * have no A/AA/AAA axis; in practice gated rows only carry the WCAG
   * tiers (A/AA/AAA) because `base`-level criteria pass the level filter
   * unconditionally and never hit this branch.
   */
  readonly requiredLevel?: "A" | "AA" | "AAA";
  /**
   * Active scan level that filtered the rule out. Stamped only when
   * {@link skipReason} is `"gated_by_level"`. Mirrors the engine's
   * {@link import("../engine/standard-filter.ts").ConformanceLevel}.
   */
  readonly requestedLevel?: "A" | "AA" | "AAA";
  /**
   * Honest per-rule file-concentration hint: when a rule's findings
   * cluster on one file (total > {@link findingsEmitted} threshold AND
   * densest-file share strictly exceeds 50%), points at that file with
   * its finding count. Zero information loss — every finding stays in
   * `files[].findings`; this is additive scan-confidence telemetry on
   * top of the per-rule row so agents can read the idiom's home once
   * instead of N times. Omitted (conditional spread) when the rule
   * doesn't clear both thresholds, per CLAUDE.md §1 "Ambiguous field
   * shapes are dishonest".
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
  /**
   * Per-file confidence detail for files where this rule's evidence
   * horizon was bounded on a per-file (not corpus-wide) axis. Each
   * entry names a single file the rule's gate matched but where a
   * substrate-level signal — parser failure (`file-parse-error`) or
   * partial-parse recovery — invalidates the rule's per-file confidence
   * on that one file. Files that parsed cleanly are NOT enumerated
   * here (their per-file confidence equals the aggregate
   * {@link coverageConfidence} via implication); only the degraded
   * subset rides so the field is bounded by the parse-error /
   * partial-parse population, not the eligible-file count.
   *
   * Why per-file: a single parse-error file in a 429-file corpus used to
   * blanket-degrade EVERY rule's aggregate `coverageConfidence` to
   * `"low"` with `coverageConfidenceReason: "file-parse-error"`,
   * regardless of which file the rule actually produced its evidence
   * from — the canonical silent-miss the AI-first doctrine "Parser-
   * failure invalidates per-file confidence" names at the per-rule
   * layer. The aggregate now folds from these per-file entries: as long
   * as the rule has at least {@link MIN_FILES_FOR_HIGH_CONFIDENCE}
   * cleanly-evaluated files outside the degraded set, the aggregate
   * stays `"high"` and `byFile` carries the per-file-bounded entries
   * the agent reads to triage the small handful of degraded files
   * specifically.
   *
   * Cross-surface contract: when a rule's aggregate
   * {@link coverageConfidence} stays `"high"` but `byFile` is non-empty,
   * the per-finding propagation helper
   * (`src/mcp/per-finding-confidence-parity.ts`) STILL attaches the
   * file-scoped substrate code (`file_parse_error` / `partial_parse`)
   * to findings whose path appears in `byFile` — the per-rule-coverage
   * row is the one truthful surface that names which files the rule's
   * confidence was bounded on, regardless of whether the aggregate
   * scalar dropped.
   *
   * Schema: `confidence` is the per-file label (`"low"` for parse-error
   * files, `"low"` for partial-parse files — matching the aggregate's
   * pre-fix behavior on the file-scoped axis); `reason` mirrors the
   * substrate-level enum on {@link coverageConfidenceReason}
   * (`"file-parse-error"` / `"partial-parse"`). Sorted by `path` for
   * deterministic wire output. Present-when-meaningful per CLAUDE.md
   * §1: omitted entirely when no parse-error / partial-parse file
   * matched the rule's gate.
   */
  readonly byFile?: readonly {
    readonly path: string;
    readonly confidence: "high" | "medium" | "low";
    readonly reason: "file-parse-error" | "partial-parse" | "parse-bailed-non-jsx-in-tsx-route";
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
