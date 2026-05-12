/**
 * Integration test: response-level structured limitation code
 * `external_handler_resolution_unavailable` on `plan.limitations[]`
 * when the scan observes a cross-file listener-resolution candidate.
 *
 * Doctrine source: docs/kb/gotchas/cross-file-handler-resolution.md
 *   "Surface the limitation structurally. When a finder needs cross-
 *    file evidence to resolve confidently, it adds an entry to the
 *    response-level `limitations[]` field with the machine-readable
 *    code `external_handler_resolution_unavailable`."
 *
 * Pairs with (does NOT replace) the per-rule
 * `coverageConfidence: "medium"` + reason
 * `cross_file_listener_resolution_not_attempted_by_rule` on
 * `meta.perRuleCoverage[]`. The two layers carry the same underlying
 * limitation on different axes — per-rule (the rule did not attempt
 * this resolution) vs response-level (this scan cannot resolve
 * external handler bindings). An agent reading `plan.limitations` sees
 * the response-level pointer alongside the prose disclaimers without
 * having to walk per-rule coverage to learn the same fact.
 *
 * Fixture shape: a vanilla-JS file with the canonical click-attach
 * pattern that `keyboard/handler-missing`'s external-JS branch fires
 * on — `document.querySelector('.btn').addEventListener('click', …)`
 * with no paired `keydown`/`keyup` for the same identifier. The HTML
 * binding target lives elsewhere (a sibling `index.html` not parsed
 * here); the rule's `crossFileCapable: false` flag declares its design
 * does not attempt to look up that target, and the per-rule coverage
 * row for `keyboard/handler-missing` ships at
 * `coverageConfidence: "medium"` with the listener-resolution reason —
 * which is the predicate the response-level limitation code names.
 */

import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../src/engine/scanner.ts";
import { parseHtml, parseTsx } from "../../src/input/parsers/index.ts";
import { assembleScanFamilyResponse } from "../../src/mcp/response-assembler.ts";
import { EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE } from "../../src/mcp/scan-assembly.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { wcag22 } from "../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../src/types/ast.ts";

function htmlFile(path: string, source: string): ParsedFile {
  const parsed = parseHtml(source);
  return {
    filePath: path,
    source,
    ast: { language: "html", root: parsed.root, errors: parsed.errors },
  };
}

function jsFile(path: string, source: string): ParsedFile {
  const parsed = parseTsx(source);
  const ast: Ast = { language: "js", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

describe("external_handler_resolution_unavailable on plan.limitations[]", () => {
  it("surfaces the structured code when a vanilla-JS HTML page references an external script for handler binding", () => {
    // Vanilla-JS scenario: `index.html` with `<script src="widget.js">`
    // and a bare `<div onclick>` whose keyboard wiring may live in the
    // referenced `widget.js`. The HTML branch detects the `<script src>`
    // as a cross-file candidate (bumps `markCrossFileCandidate`), the
    // rule's `crossFileCapable: false` flag downgrades the per-rule
    // coverage row to `"medium"` with the listener-resolution reason —
    // which is the predicate the response-level
    // `external_handler_resolution_unavailable` code names.
    const html = `<!DOCTYPE html><html><body>
<script src="widget.js"></script>
<div class="btn" onclick="doit()">Open</div>
</body></html>`;
    const widgetJs = `var el = document.querySelector('.btn');
el.addEventListener('click', function () { doit(); });
`;
    const files = [htmlFile("index.html", html), jsFile("widget.js", widgetJs)];

    const { result, perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    // Sanity: the rule must have fired (the response-level limitation
    // is gated on `crossFileCandidates > 0`, which only flips true when
    // the rule observed a real candidate token).
    const handlerRow = perRuleCoverage.find((r) => r.ruleId === "keyboard/handler-missing");
    expect(handlerRow).toBeDefined();
    expect(handlerRow!.coverageConfidence).toBe("medium");
    expect(handlerRow!.reason).toBe("cross_file_listener_resolution_not_attempted_by_rule");

    const response = assembleScanFamilyResponse({
      violations: result.violations,
      rawViolations: result.violations,
      parsedFiles: files,
      activeRules: BUILTIN_RULES,
      durationMs: result.durationMs,
      enabledStandards: result.enabledStandards,
      perRuleCoverage,
      reviewCandidates: [],
      wrappers: {
        wrappers: [],
        sessionOnly: [],
        bySource: {
          fromConfig: [],
          fromSession: [],
          fromAutoDetect: { confirmed: [], assumed: [] },
        },
        elements: {},
      },
      unusedWrappers: [],
      suppressions: [],
      verboseMeta: true,
      preset: undefined,
      actionableManual: 0,
      untargetedCriteria: 0,
      configSource: null,
      rootSource: "explicit",
    });

    const limitations = (response.plan as { limitations?: readonly string[] }).limitations;
    expect(limitations).toBeDefined();
    expect(limitations!).toContain(EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE);
    // The two prose disclaimers must remain — the structured code rides
    // alongside them, not in place of them.
    expect(limitations!.length).toBeGreaterThanOrEqual(3);
    expect(
      limitations!.some((entry) =>
        entry.startsWith("Static analysis can prove failure but not conformance"),
      ),
    ).toBe(true);
    expect(limitations!.some((entry) => entry.startsWith("Runtime-only checks"))).toBe(true);
  });

  it("does NOT surface the code on a clean scan with no cross-file listener candidates", () => {
    // HTML page with no `<script src>` reference — the rule's HTML
    // branch never bumps `markCrossFileCandidate`, the per-rule row
    // stays at `coverageConfidence: "high"` (the `crossFileCandidates
    // > 0` gate in `per-rule-coverage.ts` keeps clean substrates
    // honest), and the response-level limitation code stays absent.
    const html = `<!DOCTYPE html><html><body>
<button>Click</button>
</body></html>`;
    const path = "index.html";
    const files = [htmlFile(path, html)];

    const { result, perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    const handlerRow = perRuleCoverage.find((r) => r.ruleId === "keyboard/handler-missing");
    expect(handlerRow).toBeDefined();
    // No candidates → row stays at "high" with no cross-file reason.
    expect(handlerRow!.coverageConfidence).toBe("high");

    const response = assembleScanFamilyResponse({
      violations: result.violations,
      rawViolations: result.violations,
      parsedFiles: files,
      activeRules: BUILTIN_RULES,
      durationMs: result.durationMs,
      enabledStandards: result.enabledStandards,
      perRuleCoverage,
      reviewCandidates: [],
      wrappers: {
        wrappers: [],
        sessionOnly: [],
        bySource: {
          fromConfig: [],
          fromSession: [],
          fromAutoDetect: { confirmed: [], assumed: [] },
        },
        elements: {},
      },
      unusedWrappers: [],
      suppressions: [],
      verboseMeta: true,
      preset: undefined,
      actionableManual: 0,
      untargetedCriteria: 0,
      configSource: null,
      rootSource: "explicit",
    });

    const limitations = (response.plan as { limitations?: readonly string[] }).limitations;
    expect(limitations).toBeDefined();
    expect(limitations!).not.toContain(EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE);
  });

  // Per-finding / per-rule parity on a vanilla-JS-only corpus —
  // doctrine source: docs/kb/architecture/ai-first-consumer.md
  // "Per-finding confidence must reflect per-rule coverage limitations."
  //
  // Before the closure: a `.js` file with
  // `document.querySelector('.btn').addEventListener('click', …)` and
  // no sibling-module import emitted findings at
  // `confidence: "medium"` + `couldBeWrongBecause:
  // ["cross_file_listener_resolution_not_attempted_by_rule"]` (the
  // external-JS path stamps these unconditionally) — but the per-rule
  // coverage row stayed at `coverageConfidence: "high"` because the
  // rule's `markCrossFileCandidate()` bump only fired on the
  // per-element walk (HTML `<script src>` / JSX sibling-module
  // import), not on the `afterFile` external-JS emission branch. The
  // contradictory shape is exactly what the doctrine names: the
  // per-rule layer says "the rule had full evidence on this corpus,"
  // the per-finding layer says "the rule could not honestly verify
  // this." An agent reading per-rule coverage as scan-confidence
  // telemetry was silently misled.
  //
  // Closure: bump `markCrossFileCandidate` on the external-JS branch
  // so the per-rule cascade observes the candidate and downgrades the
  // aggregate row to `"medium"` with reason
  // `cross_file_listener_resolution_not_attempted_by_rule` — the same
  // code the per-finding emission already carries.
  it("vanilla-JS-only corpus: per-rule row and per-finding emissions agree on medium with the cross-file-not-attempted reason", () => {
    // Single `.js` file, no HTML peer, no JSX sibling-module import.
    // Canonical click-attach pattern that fires the external-JS branch
    // in `keyboard/handler-missing`'s `afterFile` lifecycle.
    const widgetJs = `var el = document.querySelector('.btn');
el.addEventListener('click', function () { doit(); });
`;
    const files = [jsFile("widget.js", widgetJs)];

    const { result, perRuleCoverage } = runScan({
      standards: [wcag22],
      rules: BUILTIN_RULES,
      enabled: ["wcag22"],
      files,
    });

    // Per-rule row reflects the cross-file bound — the rule observed a
    // candidate token (the click-attach against an unresolved DOM
    // target) and `crossFileCapable: false` downgrades to medium with
    // the listener-resolution reason.
    const handlerRow = perRuleCoverage.find((r) => r.ruleId === "keyboard/handler-missing");
    expect(handlerRow).toBeDefined();
    expect(handlerRow!.coverageConfidence).toBe("medium");
    expect(handlerRow!.reason).toBe("cross_file_listener_resolution_not_attempted_by_rule");

    // Per-finding emission carries the same reason on
    // `couldBeWrongBecause` and ships at `confidence: "medium"` — the
    // two layers agree, no silent contradiction.
    const finding = result.violations.find((v) => v.ruleId === "keyboard/handler-missing");
    expect(finding).toBeDefined();
    expect(finding!.confidence).toBe("medium");
    expect(finding!.couldBeWrongBecause ?? []).toContain(
      "cross_file_listener_resolution_not_attempted_by_rule",
    );

    // Response-level: the structured limitation code ships because the
    // gate (`crossFileCandidates > 0`) is now satisfied on a corpus
    // where it previously misfired as "no candidates observed."
    const response = assembleScanFamilyResponse({
      violations: result.violations,
      rawViolations: result.violations,
      parsedFiles: files,
      activeRules: BUILTIN_RULES,
      durationMs: result.durationMs,
      enabledStandards: result.enabledStandards,
      perRuleCoverage,
      reviewCandidates: [],
      wrappers: {
        wrappers: [],
        sessionOnly: [],
        bySource: {
          fromConfig: [],
          fromSession: [],
          fromAutoDetect: { confirmed: [], assumed: [] },
        },
        elements: {},
      },
      unusedWrappers: [],
      suppressions: [],
      verboseMeta: true,
      preset: undefined,
      actionableManual: 0,
      untargetedCriteria: 0,
      configSource: null,
      rootSource: "explicit",
    });
    const limitations = (response.plan as { limitations?: readonly string[] }).limitations;
    expect(limitations).toBeDefined();
    expect(limitations!).toContain(EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE);
  });
});
