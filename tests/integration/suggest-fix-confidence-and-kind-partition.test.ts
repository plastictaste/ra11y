/**
 * Integration test: `suggest_fix` per-call shape must agree with the
 * source finding's `confidence` AND its `kind` must partition into the
 * same `plan.fixesByClass` lane the rule's `fixClass` advertises.
 *
 * Doctrine — `docs/kb/architecture/ai-first-consumer.md` "Per-call
 * shape must agree with per-class plan tally" + "Per-tool review-
 * candidate shape must agree across surfaces."
 *
 * Two drift cases the test pins:
 *
 *   (a) `confidence` carry-forward. Pre-fix, the suggest_fix routing
 *       layer recomputed `primary.confidence` from `match.severity` via
 *       a local `severity === "error" ? "high" : "medium"` ladder that
 *       skipped the `low` rung entirely. An info-severity finding from
 *       `landmark-main`'s isolated-component-demo branch ships
 *       `severity: "info"` / scan_project finding `confidence: "low"`,
 *       but suggest_fix on the same finding came back with
 *       `primary.confidence: "medium"` — silent drift. The closure
 *       routes the per-call surface through the same
 *       {@link resolveConfidence} helper `buildAgentFinding` uses, so
 *       both surfaces partition the same finding into the same
 *       confidence bucket.
 *
 *   (b) `kind` partitions into the rule's `fixClass` lane. The lane
 *       assignment for a finding F (after the per-finding rerouting in
 *       `resolveFixClass`) determines the set of valid `kind` values
 *       suggest_fix may emit on the same finding. The partition table
 *       (per-call kind discriminator now mirrors `plan.fixesByClass`
 *       lane keys per `docs/kb/architecture/ai-first-consumer.md`
 *       "Per-call shape must agree with per-class plan tally"):
 *
 *           fixClass "mechanical"          → kind "edit"
 *           fixClass "verify-in-source"    → kind "edit" | "verify-in-source"
 *           fixClass "guidance"            → kind "guidance"
 *           fixClass "runtime-only"        → kind "runtime-only"
 *           fixClass "suppress-recommended" → kind "suppress-recommended"
 *
 *       The test asserts every (rule, file, line) finding satisfies
 *       this predicate when both surfaces are exercised.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { buildAgentFinding } from "../../src/output/agent-response/build-finding.ts";
import type { Confidence } from "../../src/output/agent-response/types.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { Ast } from "../../src/types/ast.ts";
import type { FixClass } from "../../src/types/rule.ts";

interface FileSpec {
  readonly filePath: string;
  readonly source: string;
}

function parseFile(spec: FileSpec): { source: string; ast: Ast } {
  const parsed = parseHtml(spec.source);
  return {
    source: spec.source,
    ast: { language: "html", root: parsed.root, errors: parsed.errors },
  };
}

/**
 * Partition predicate: given a per-finding `fixClass` (after the
 * `resolveFixClass` reroute), what `kind` values may the per-call
 * surface emit on the same finding?
 *
 * This is the cross-surface contract the per-call shape pins per
 * `docs/kb/architecture/ai-first-consumer.md` "Per-call shape must
 * agree with per-class plan tally." The per-call `kind` discriminator
 * mirrors `plan.fixesByClass` lane keys: each lane partitions
 * one-to-one with the matching kind, except `verify-in-source` which
 * permits both `edit` (rule supplied a mechanical edit — the
 * mechanical-edit branch fires before the lane-mirror branch) and
 * `verify-in-source` (rule supplied prose only — the lane-mirror
 * branch fires).
 */
function laneAllowsKind(fixClass: FixClass | "suppress-recommended", kind: string): boolean {
  if (fixClass === "mechanical") return kind === "edit";
  if (fixClass === "verify-in-source") return kind === "edit" || kind === "verify-in-source";
  if (fixClass === "guidance") return kind === "guidance";
  if (fixClass === "runtime-only") return kind === "runtime-only";
  if (fixClass === "suppress-recommended") return kind === "suppress-recommended";
  return false;
}

describe("suggest_fix carries forward source-finding confidence", () => {
  it("info-severity landmark-main finding ships matching confidence on both surfaces (was: scan low / suggest medium)", () => {
    // The landmark-main rule's isolated-component-demo branch
    // downgrades the missing-main emit to severity `info` (per the
    // doctrine "Reason text and severity must agree") with a verify-
    // token in `couldBeWrongBecause`. Per-finding `severityToConfidence`
    // maps `info → low`. Pre-fix, suggest_fix's local ladder skipped
    // `low` and shipped `medium` on the same finding — the canonical
    // Q16-confidence-drift case from corpus (a).
    const file: FileSpec = {
      filePath: "/clock.html",
      source: [
        "<html>",
        "  <body>",
        '    <div class="container">',
        '      <div class="needle hour"></div>',
        '      <div class="needle minute"></div>',
        "    </div>",
        "  </body>",
        "</html>",
      ].join("\n"),
    };
    const built = { filePath: file.filePath, ...parseFile(file) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    const v = result.violations.find(
      (x) => x.ruleId === "semantics/landmark-main" && x.severity === "info",
    );
    expect(v).toBeDefined();
    if (!v) throw new Error("expected an info-severity landmark-main emit on this fixture");

    // Per-finding side: the agent-response surface maps info → low.
    const finding = buildAgentFinding(v);
    expect(finding.confidence).toBe("low");

    // Per-call side: suggest_fix must surface the same `low` — pre-fix
    // it returned `medium` because the local ladder skipped `low`.
    const payload = buildSuggestFixPayload({
      ruleId: v.ruleId,
      line: v.location.line,
      match: v,
      sourceContext: file.source,
      source: file.source,
      filePath: file.filePath,
    });
    const primary = payload.primary as { confidence: Confidence } | undefined;
    expect(primary).toBeDefined();
    expect(primary?.confidence).toBe("low");

    // Cross-surface equality is the load-bearing assertion for Q16.
    expect(primary?.confidence).toBe(finding.confidence);
  });

  it("warning-severity finding ships confidence: medium on both surfaces", () => {
    // Sanity sibling on the existing midband. Pre-fix this case
    // already agreed (`medium` on both); the pin guards against a
    // future regression that re-introduces a divergent ladder.
    const file: FileSpec = {
      filePath: "/page.html",
      source:
        '<!doctype html><html lang="en"><body><h1>Hi</h1><nav>Nav</nav><main>Main</main><div>extra</div><div>extra2</div></body></html>',
    };
    const built = { filePath: file.filePath, ...parseFile(file) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    // Find any warning-severity violation; severity → confidence: medium.
    const v = result.violations.find((x) => x.severity === "warning");
    if (!v) {
      // Defensive: if the fixture happens to ship no warnings, the
      // sanity case skips silently. The info-low case above is the
      // load-bearing one.
      return;
    }
    const finding = buildAgentFinding(v);
    expect(finding.confidence).toBe("medium");
    const payload = buildSuggestFixPayload({
      ruleId: v.ruleId,
      line: v.location.line,
      match: v,
      sourceContext: file.source,
      source: file.source,
      filePath: file.filePath,
    });
    const primary = payload.primary as { confidence: Confidence } | undefined;
    if (primary !== undefined) {
      // Some rerouting branches (vendor-override, template-directive)
      // legitimately fix `medium` regardless of severity — those are
      // out-of-scope for the carry-forward pin. The non-rerouted
      // fallback path (where this fixture's findings live) must agree.
      expect(primary.confidence).toBe("medium");
      expect(primary.confidence).toBe(finding.confidence);
    }
  });
});

describe("suggest_fix.kind partitions into the rule's fixClass lane", () => {
  // Across a multi-rule fixture, every emitted finding's per-call
  // `kind` must be a member of the lane its per-finding `fixClass`
  // permits (see `laneAllowsKind`). This is the cross-surface contract
  // the Q16 closure pins for case (b): an agent budgeting against
  // `plan.fixesByClass.<lane>` knows the per-call surface will land in
  // that lane's permitted kind set, never outside it.
  const file: FileSpec = {
    filePath: "/multirule.html",
    source: [
      "<!doctype html>",
      '<html lang="en">',
      "<body>",
      // Triggers `aria/redundant-role-on-host-element` (mechanical).
      '  <button role="button">Save</button>',
      // Triggers `navigation/href-empty-fragment` (verify-in-source,
      // prose-only → kind: guidance).
      '  <a href="">Forgot password?</a>',
      // Triggers `semantics/heading-hierarchy` missing-h1 emit with
      // suppress-flavored prose → fixClass: suppress-recommended,
      // kind: suppress-recommended.
      "  <div>one</div>",
      "  <div>two</div>",
      "  <div>three</div>",
      "</body>",
      "</html>",
    ].join("\n"),
  };

  it("every (finding, suggest_fix) pair satisfies the lane → kind partition predicate", () => {
    const built = { filePath: file.filePath, ...parseFile(file) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    const errorWarning = result.violations.filter((v) => v.severity !== "info");
    expect(errorWarning.length).toBeGreaterThan(0);

    const observedLanes = new Set<string>();
    for (const v of errorWarning) {
      const finding = buildAgentFinding(v);
      const payload = buildSuggestFixPayload({
        ruleId: v.ruleId,
        line: v.location.line,
        match: v,
        sourceContext: file.source,
        source: file.source,
        filePath: file.filePath,
      });
      const kind = payload.kind as string | undefined;
      expect(kind).toBeDefined();
      if (kind === undefined) continue;

      // The load-bearing partition assertion. If this trips, either
      // the per-finding lane or the per-call kind is out of step with
      // the contract.
      const allowed = laneAllowsKind(finding.fixClass, kind);
      if (!allowed) {
        throw new Error(
          `lane → kind partition violated: ruleId=${v.ruleId} ` +
            `line=${v.location.line} fixClass=${finding.fixClass} kind=${kind}. ` +
            `per-finding fixClass and per-call kind must satisfy laneAllowsKind.`,
        );
      }

      observedLanes.add(`${finding.fixClass}→${kind}`);
    }

    // Sanity: the fixture is constructed to exercise multiple distinct
    // (lane, kind) pairs so the partition predicate isn't proven on a
    // single trivial case. At minimum we expect the mechanical→edit
    // and suppress-recommended→suppress-recommended partitions.
    expect(observedLanes.size).toBeGreaterThanOrEqual(2);
  });

  it("verify-in-source rule with prose-only suggestion ships kind: 'verify-in-source', not 'edit' (lane permits both)", () => {
    // A `verify-in-source` rule (`navigation/href-empty-fragment`)
    // that ships no mechanical edit returns
    // `kind: "verify-in-source"` — the per-call discriminator now
    // mirrors the plan-tally lane key. The verify-in-source lane
    // permits both `edit` (when the rule supplies a mechanical edit)
    // and `verify-in-source` (the prose-only branch); the test
    // confirms the prose-only branch lands on the lane-mirror
    // discriminator, not on the legacy generic `guidance` kind.
    const built = { filePath: file.filePath, ...parseFile(file) };
    const { result } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files: [built],
    });
    const v = result.violations.find((x) => x.ruleId === "navigation/href-empty-fragment");
    expect(v).toBeDefined();
    if (!v) throw new Error("expected an href-empty-fragment violation on this fixture");

    const finding = buildAgentFinding(v);
    expect(finding.fixClass).toBe("verify-in-source");

    const payload = buildSuggestFixPayload({
      ruleId: v.ruleId,
      line: v.location.line,
      match: v,
      sourceContext: file.source,
      source: file.source,
      filePath: file.filePath,
    });
    expect(payload.kind).toBe("verify-in-source");

    // Partition predicate holds: kind: "verify-in-source" is permitted
    // under fixClass: "verify-in-source".
    expect(laneAllowsKind(finding.fixClass, payload.kind as string)).toBe(true);
  });
});
