/**
 * Unit tests for the `rulesEvaluated` shape builder
 *
 * The three shapes that matter — the scenarios named in the backlog
 * item — are each exercised here so regressions show up at the helper
 * level before they drift into the scan-family or derivative-tool
 * response shapes:
 *
 *   (a) empty scan → zeros all the way down.
 *   (b) normal scan → `loaded > withEligibleInputs > fired`, monotone.
 *   (c) "no eligible" / pure-HTML-against-React-rules scan → `loaded > 0`
 *       but `withEligibleInputs === 0` and `fired === 0` — the acute
 *       case the composite-count split was designed to surface.
 *
 * Plus the degenerate "don't-know" case: a caller (e.g. list_suppressions)
 * with no `perRuleCoverage` array gets a single-field `{ loaded }` back
 * — the derived sub-counters are omitted via conditional spread so the
 * agent can't mistake "tool didn't compute this" for "zero rules were
 * eligible." CLAUDE.md §1 "Ambiguous field shapes are dishonest."
 */

import { describe, expect, it } from "bun:test";
import { buildRulesEvaluated } from "../../../src/mcp/rules-evaluated.ts";
import type { PerRuleCoverage } from "../../../src/types/violation.ts";

function row(ruleId: string, filesEligible: number, findingsEmitted: number): PerRuleCoverage {
  return {
    ruleId,
    filesEvaluated: filesEligible,
    filesEligible,
    findingsEmitted,
    coverageConfidence: filesEligible > 0 ? "high" : "low",
    ...(filesEligible === 0
      ? {
          reason: "no files matching .css were scanned",
          remediation: "add CSS files",
        }
      : {}),
  };
}

describe("buildRulesEvaluated", () => {
  // Scenario (a): an empty scan — no files parsed, every rule's
  // perRuleCoverage row lands at filesEligible:0 / findingsEmitted:0.
  // The sub-counters must collapse to zero honestly, and `loaded` must
  // still reflect the configured rule count so the agent can see "N
  // rules were loaded; none had inputs to evaluate against."
  it("empty scan: withEligibleInputs and fired are both 0 while loaded is preserved", () => {
    const perRuleCoverage: readonly PerRuleCoverage[] = [
      row("alt-text/missing", 0, 0),
      row("contrast/minimum", 0, 0),
      row("focus/outline-visible", 0, 0),
    ];
    const result = buildRulesEvaluated({ loadedCount: 3, perRuleCoverage });
    expect(result).toEqual({
      loaded: 3,
      withEligibleInputs: 0,
      fired: 0,
    });
  });

  // Scenario (b): a normal scan with some rules firing, some silent-
  // clean, and some with zero eligible files. The monotone invariant
  // (`fired <= withEligibleInputs <= loaded`) must hold.
  it("normal scan: loaded > withEligibleInputs > fired, monotone", () => {
    const perRuleCoverage: readonly PerRuleCoverage[] = [
      // Fired — has eligible inputs AND produced findings.
      row("alt-text/missing", 3, 2),
      row("contrast/minimum", 1, 1),
      // Eligible, didn't fire.
      row("label/missing", 5, 0),
      row("heading/order", 2, 0),
      // No eligible inputs.
      row("css/only-rule", 0, 0),
    ];
    const result = buildRulesEvaluated({ loadedCount: 7, perRuleCoverage });
    // `loaded` reflects the caller's ceiling (config on/off set) — may
    // exceed the perRuleCoverage count when some rules were dropped by
    // the standard filter before evaluation.
    expect(result.loaded).toBe(7);
    expect(result.withEligibleInputs).toBe(4);
    expect(result.fired).toBe(2);
    // Monotone invariant: fired <= withEligibleInputs <= loaded.
    expect(result.fired).toBeLessThanOrEqual(result.withEligibleInputs!);
    expect(result.withEligibleInputs).toBeLessThanOrEqual(result.loaded);
  });

  // Scenario (c): the acute case from the Q4 backlog item — a pure-
  // HTML/SSG project where every React/CSS-specific rule got a row
  // but landed at filesEligible:0. Under the old single-number shape
  // this was invisible: `rulesEvaluated: 52` read as "52 rules
  // evaluated" when 0 of them actually had inputs. The split makes
  // the gap legible at the headline level.
  it("degenerate 'no eligible' scan: loaded > 0, withEligibleInputs = 0, fired = 0", () => {
    const perRuleCoverage: readonly PerRuleCoverage[] = [
      row("react/aria-prop", 0, 0),
      row("css/contrast", 0, 0),
      row("jsx/alt-text", 0, 0),
    ];
    const result = buildRulesEvaluated({ loadedCount: 52, perRuleCoverage });
    expect(result.loaded).toBe(52);
    expect(result.withEligibleInputs).toBe(0);
    expect(result.fired).toBe(0);
  });

  // Callers without a scan (list_suppressions, propose_config's
  // top-level meta) can't honestly populate the derived sub-counters.
  // The helper omits them via conditional spread — emitting `0` would
  // read as "zero rules had eligible inputs" and silently mislead the
  // agent. Per CLAUDE.md §1 "Ambiguous field shapes are dishonest."
  it("no perRuleCoverage: returns { loaded } only; sub-counters are absent", () => {
    const result = buildRulesEvaluated({ loadedCount: 52 });
    expect(result.loaded).toBe(52);
    expect("withEligibleInputs" in result).toBe(false);
    expect("fired" in result).toBe(false);
    // Exhaustive shape check so a future accidental addition fails.
    expect(Object.keys(result).sort()).toEqual(["loaded"]);
  });

  // Guard: an empty perRuleCoverage array (caller scanned but the
  // standard filter dropped every rule — unusual but possible with a
  // custom standard setup) must still emit the sub-counters as 0, not
  // omit them. The distinction from the no-scan case is "we tried and
  // got zero" vs "we didn't try." The presence of the array signals
  // the former.
  it("empty perRuleCoverage array: sub-counters emitted as 0 (distinct from omitted)", () => {
    const result = buildRulesEvaluated({ loadedCount: 5, perRuleCoverage: [] });
    expect(result).toEqual({
      loaded: 5,
      withEligibleInputs: 0,
      fired: 0,
    });
  });
});
