/**
 * Integration test: `suggest_fix` on a target file classified as a
 * build artifact OR vendor-library bundle returns the override-redirect
 * `kind: "guidance"` shape regardless of which classification fired.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` —
 * "Heuristic-mislabeled meta sub-fields are dishonest" + "Don't
 * duplicate capability the agent already has". Editing vendor bytes in
 * place is defeated by the next dependency bump; the response surface
 * must redirect the agent to override the failing selector in their own
 * stylesheet.
 *
 * Test strategy: build a real CSS source carrying a vendor-library
 * banner (Bootstrap) with a low-contrast `.text-muted` selector, run
 * the scan, then walk the same vendor-detection + payload-build path
 * the `suggest_fix` MCP handler walks (`detectVendorContext` →
 * `buildSuggestFixPayload`). Assertions cover:
 *   (a) the resolved match's payload is `kind: "guidance"`,
 *   (b) `primary.approach` is the override label,
 *   (c) the rule's original suggestion is demoted to `alternatives[0]`
 *       under the in-vendor-edit label,
 *   (d) `vendorContext.signal.kind` names the deterministic evidence
 *       (`vendor-library` here; `build-artifact` for the second case),
 *   (e) the same restructure fires on a `.min.` build-artifact path
 *       — covering the rule-agnostic "regardless of classification"
 *       half of the contract.
 *
 * Sibling unit tests: `tests/unit/mcp/build-suggest-fix-payload.test.ts`
 * tests the payload builder over synthetic `vendorContext` inputs;
 * `tests/unit/mcp/suggest-fix-vendor-context.test.ts` tests the
 * `detectVendorContext` predicate. This file pins the end-to-end wiring
 * — the predicate firing on real (filePath, source) inputs and the
 * payload builder actually restructuring — so a regression in any link
 * of the chain (predicate failing on a real banner, builder ignoring
 * vendorContext, scanner failing to surface the violation that drives
 * the lookup) trips this test.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseCss } from "../../src/input/parsers/index.ts";
import {
  detectVendorContext,
  IN_VENDOR_EDIT_ALTERNATIVE_APPROACH,
  OVERRIDE_PRIMARY_APPROACH,
} from "../../src/mcp/suggest-fix-vendor-context.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";

/**
 * Drives the same vendor-detection + payload-assemble path the
 * suggest_fix handler walks (minus the McpSession / parseFile cache,
 * neither of which are part of the override-redirect contract). Returns
 * the raw payload so the test bodies can read fields directly.
 */
function vendorReroutePayload(args: {
  readonly filePath: string;
  readonly source: string;
  readonly ruleId: string;
}): Record<string, unknown> {
  const { filePath, source, ruleId } = args;
  const parsed = parseCss(source);
  const ast = { language: "css" as const, root: parsed.root, errors: parsed.errors };
  const { result } = runScan({
    standards: BUILTIN_STANDARDS,
    rules: BUILTIN_RULES,
    enabled: ["wcag22"],
    files: [{ filePath, source, ast }],
  });
  const match = result.violations.find((v) => v.ruleId === ruleId);
  if (match === undefined) {
    throw new Error(
      `Test setup error: scan did not produce a ${ruleId} violation in ${filePath}. ` +
        `Saw ruleIds: ${result.violations.map((v) => v.ruleId).join(", ") || "(none)"}`,
    );
  }
  // Mirror the handler's vendor-detection step against the real
  // (filePath, source) — this is the same call
  // `collectSuggestFixContext` makes in src/mcp/suggest-fix-context.ts.
  const vendorContext = detectVendorContext(filePath, source);
  if (vendorContext === null) {
    throw new Error(
      `Test setup error: detectVendorContext returned null for ${filePath} — the input does not match the vendor predicates the handler relies on.`,
    );
  }
  return buildSuggestFixPayload({
    ruleId,
    line: match.location.line,
    match,
    sourceContext: source,
    source,
    filePath,
    sameFileFindings: result.violations,
    vendorContext,
  });
}

describe("suggest_fix on a vendor-classified file routes to override-redirect guidance", () => {
  // Real bootstrap-banner CSS with a `.text-muted` selector whose
  // foreground/background pair fails WCAG AA contrast — this is the
  // exact field-report shape the override-redirect was built for
  // (a `contrast/minimum` fire on a vendor stylesheet the user
  // didn't author). Reused across the vendor-library banner cases so
  // the test data lives in one place.
  const BOOTSTRAP_BANNER_CSS = [
    "/*! Bootstrap v5.3.0 (https://getbootstrap.com/) */",
    ".text-muted { color: #adb5bd; background-color: #ffffff; }",
    "",
  ].join("\n");
  const BOOTSTRAP_PATH = "vendor/bootstrap.css";

  it("vendor-library banner (Bootstrap CSS): payload is kind: 'guidance' with the override approach", () => {
    const payload = vendorReroutePayload({
      filePath: BOOTSTRAP_PATH,
      source: BOOTSTRAP_BANNER_CSS,
      ruleId: "contrast/minimum",
    });
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { approach: string };
    expect(primary.approach).toBe(OVERRIDE_PRIMARY_APPROACH);
  });

  it("vendor-library banner: explanation cites the library by name + the load-order rule", () => {
    const payload = vendorReroutePayload({
      filePath: BOOTSTRAP_PATH,
      source: BOOTSTRAP_BANNER_CSS,
      ruleId: "contrast/minimum",
    });
    const primary = payload["primary"] as { explanation: string };
    expect(primary.explanation.toLowerCase()).toContain("bootstrap");
    expect(primary.explanation).toContain("AFTER");
    expect(primary.explanation.toLowerCase()).toContain("dependency");
  });

  it("vendor-library banner: original rule suggestion is demoted to alternatives[0]", () => {
    const payload = vendorReroutePayload({
      filePath: BOOTSTRAP_PATH,
      source: BOOTSTRAP_BANNER_CSS,
      ruleId: "contrast/minimum",
    });
    const alternatives = payload["alternatives"] as ReadonlyArray<{
      approach: string;
      explanation: string;
    }>;
    expect(alternatives.length).toBeGreaterThanOrEqual(1);
    expect(alternatives[0]?.approach).toBe(IN_VENDOR_EDIT_ALTERNATIVE_APPROACH);
    // The demoted explanation carries the rule's own remediation prose
    // so the agent can still see what would have been proposed if
    // forking the dependency were the chosen path.
    expect(alternatives[0]?.explanation.length).toBeGreaterThan(0);
  });

  it("vendor-library banner: top-level vendorContext.signal names the deterministic evidence", () => {
    const payload = vendorReroutePayload({
      filePath: BOOTSTRAP_PATH,
      source: BOOTSTRAP_BANNER_CSS,
      ruleId: "contrast/minimum",
    });
    const vendorContext = payload["vendorContext"] as { signal: { kind: string; library?: string } };
    expect(vendorContext.signal.kind).toBe("vendor-library");
    expect(vendorContext.signal.library).toBe("bootstrap");
  });

  it("build-artifact path (.min. infix, no banner): same restructure fires via the second classification pathway", () => {
    // No vendor-library banner here — the predicate falls through to
    // `classifyBuildArtifactDetailed` and matches on the `.min.` infix.
    // The override-redirect is classification-agnostic by design: the
    // payload builder restructures any match into the override lane
    // whenever vendorContext is set, regardless of which detector
    // produced it. This sub-case pins that contract on the second
    // real classification pathway.
    const payload = vendorReroutePayload({
      filePath: "vendor/site.min.css",
      source: ".text-muted{color:#adb5bd;background-color:#fff}\n",
      ruleId: "contrast/minimum",
    });
    expect(payload["kind"]).toBe("guidance");
    const primary = payload["primary"] as { approach: string };
    expect(primary.approach).toBe(OVERRIDE_PRIMARY_APPROACH);
    const vendorContext = payload["vendorContext"] as { signal: { kind: string } };
    expect(vendorContext.signal.kind).toBe("build-artifact");
    const alternatives = payload["alternatives"] as ReadonlyArray<{ approach: string }>;
    expect(alternatives[0]?.approach).toBe(IN_VENDOR_EDIT_ALTERNATIVE_APPROACH);
  });
});
