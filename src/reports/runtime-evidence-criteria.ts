/**
 * Runtime-evidence-required criterion set + the claim-level verdict
 * logic that sits on top of the evidence ledger.
 *
 * Extracted from `src/reports/conformance.ts` to keep that file under
 * the 500-line budget. The spec-derived enumeration below is the one
 * source of truth — adding a criterion here flows through the blocker
 * classifier, the `status: "undetermined"` stamping, and the
 * `limitations[]` prose assembly without any other call-site edits.
 *
 * See `docs/kb/architecture/ai-first-consumer.md` (zero-output success
 * rule, surface-don't-suppress rule) for the doctrine this module
 * enforces: static analysis of source cannot prove runtime behavior,
 * and collapsing "no evidence" into `status: "pass"` is the silent-miss
 * failure mode the AI-first consumer model exists to prevent.
 */

/**
 * WCAG criteria that static source analysis fundamentally cannot prove
 * in the passing direction — the normative requirement is about runtime
 * behavior (keyboard traversal, focus management, color contrast against
 * the rendered composite, heading/label adequacy) that lives beyond a
 * file-level AST. A static rule here can catch some failures, but the
 * absence of a finding is not evidence of conformance; only a runtime
 * observation (rehearsed through an `attest` verdict with a runtime
 * harness as `by`) or a human review can close the gap.
 *
 * When one of these criteria is in scope AND the evidence ledger shows
 * zero static violations, zero attested sources, and zero sampled
 * sources, the conformance builder emits a `runtime-evidence-required`
 * blocker with `status: "undetermined"` — rather than the former
 * silent `status: "pass"` + `reason: "no-evidence"` collapse that read
 * to an agent as "this criterion checked clean" when the reality was
 * "the static layer can't answer this question." See `limitations[]`
 * on the emitted statement.
 *
 * Spec-derived enumeration, not a heuristic: every entry cites the
 * normative basis below. WCAG 2.1 aliases are included so profiles
 * pinned to 2.1 route the same way.
 *
 * Entries:
 *   - `1.4.3 Contrast (Minimum)` — static CSS parsing is partial; the
 *     final rendered composite (backgrounds, images, gradients, opacity
 *     stacks, user-agent defaults, system fonts) is only observable at
 *     runtime.
 *   - `1.4.11 Non-text Contrast` — same runtime-rendering basis as
 *     1.4.3, applied to UI components and graphical objects.
 *   - `2.1.1 Keyboard` — "all functionality operable through a keyboard
 *     interface" is a runtime property of event handlers + focus
 *     management; static analysis sees handler presence, not reachability.
 *   - `2.4.3 Focus Order` — focus order depends on tabindex, DOM order
 *     AT RUNTIME, and any dynamic focus moves. Source-level tabindex
 *     inspection is necessary, not sufficient.
 *   - `2.4.6 Headings and Labels` — "describe topic or purpose" is a
 *     semantic adequacy check; static analysis catches missing/empty
 *     headings but cannot judge descriptiveness.
 *   - `2.4.7 Focus Visible` — visibility of the focus indicator requires
 *     observing the rendered `:focus` / `:focus-visible` styles against
 *     the actual composite; a `outline: none` cascade override is only
 *     knowable at runtime.
 *   - `1.4.10 Reflow` — reflow at 320 CSS pixels is a runtime viewport
 *     observation; static CSS inspection can catch fixed-width patterns
 *     but cannot prove reflow holds.
 *   - `1.4.12 Text Spacing` — text-spacing tolerance is a runtime style
 *     override check; static inspection is partial.
 *   - `1.4.13 Content on Hover or Focus` — hover/focus-triggered content
 *     (tooltips, popovers) dismissable/hoverable/persistent behavior is
 *     runtime-only.
 *   - `2.5.7 Dragging Movements` (WCAG 2.2) — "functionality that uses a
 *     dragging movement … can be achieved by a single pointer without
 *     dragging" is a runtime interaction property.
 *   - `2.5.8 Target Size (Minimum)` (WCAG 2.2) — minimum tap target size
 *     depends on rendered layout; static CSS is partial (computed
 *     dimensions, padding stacks, viewport zoom are runtime).
 *   - `3.3.7 Redundant Entry` / `3.3.8 Accessible Authentication (Minimum)` /
 *     `3.3.9 Accessible Authentication (Enhanced)` — authentication-flow
 *     properties (cognitive-function tests, redundant re-entry) are
 *     runtime session behavior, not statically determinable.
 */
export const RUNTIME_EVIDENCE_REQUIRED_CRITERIA: ReadonlySet<string> = new Set([
  // 1.4.x contrast / reflow / text-spacing / content-on-hover — rendered composite is runtime.
  "wcag22:1.4.3",
  "wcag21:1.4.3",
  "wcag22:1.4.10",
  "wcag21:1.4.10",
  "wcag22:1.4.11",
  "wcag21:1.4.11",
  "wcag22:1.4.12",
  "wcag21:1.4.12",
  "wcag22:1.4.13",
  "wcag21:1.4.13",
  // 2.1.1 keyboard — handler presence ≠ keyboard reachability.
  "wcag22:2.1.1",
  "wcag21:2.1.1",
  // 2.4.3 / 2.4.6 / 2.4.7 — focus order, heading adequacy, focus visibility.
  "wcag22:2.4.3",
  "wcag21:2.4.3",
  "wcag22:2.4.6",
  "wcag21:2.4.6",
  "wcag22:2.4.7",
  "wcag21:2.4.7",
  // 2.5.7 / 2.5.8 — WCAG 2.2 pointer interaction + target size (runtime layout).
  "wcag22:2.5.7",
  "wcag22:2.5.8",
  // 3.3.7 / 3.3.8 / 3.3.9 — authentication flow + redundant entry (runtime session).
  "wcag22:3.3.7",
  "wcag22:3.3.8",
  "wcag22:3.3.9",
]);
