/**
 * Tests for `buildManualOnlyCriterionGuidance` — the `kind: "guidance"`
 * payload `suggest_fix` returns when the caller passes a criterion ID
 * that exists in the registry but no automated rule satisfies it.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Per-tool
 * review-candidate shape must agree across surfaces" — `checklist`
 * candidates carrying a manual-only criterion ID must address from
 * `suggest_fix`. The helper produces the response shape the handler
 * threads through; this file pins the shape contract.
 */

import { describe, expect, it } from "bun:test";

import { buildManualOnlyCriterionGuidance } from "../../../src/mcp/suggest-fix-manual-only-criterion.ts";
import type { Criterion } from "../../../src/types/standard.ts";

const MULTIPLE_WAYS: Criterion = {
  id: "wcag22:2.4.5",
  standardId: "wcag22",
  localId: "2.4.5",
  title: "Multiple Ways",
  level: "AA",
  description:
    "More than one way is available to locate a web page within a set of web pages, except where the web page is the result of, or a step in, a process.",
  url: "https://www.w3.org/TR/WCAG22/#multiple-ways",
  automatable: "manual",
};

function fields() {
  return {
    warningsField: {},
    vendorContextField: {},
    verify: {
      verifyCommandStructured: {
        tool: "scan_file" as const,
        args: { path: "page.html" },
        verifyRuleId: "wcag22:2.4.5",
      },
    },
  };
}

describe("buildManualOnlyCriterionGuidance", () => {
  it("returns kind: 'guidance' (not 'none' / not error)", () => {
    const out = buildManualOnlyCriterionGuidance({
      criterion: MULTIPLE_WAYS,
      inputCriterionId: "wcag22:2.4.5",
      filePath: "page.html",
      line: 1,
      fields: fields(),
    });
    expect(out["kind"]).toBe("guidance");
  });

  it("primary.explanation quotes the criterion title and normative description", () => {
    const out = buildManualOnlyCriterionGuidance({
      criterion: MULTIPLE_WAYS,
      inputCriterionId: "wcag22:2.4.5",
      filePath: "page.html",
      line: 1,
      fields: fields(),
    });
    const primary = out["primary"] as { explanation?: string };
    expect(primary.explanation).toContain("wcag22:2.4.5");
    expect(primary.explanation).toContain("Multiple Ways");
    // Normative description text is embedded so the agent can act on
    // the spec text without a second tool call.
    expect(primary.explanation).toContain("More than one way");
    expect(primary.explanation).toContain("https://www.w3.org/TR/WCAG22/#multiple-ways");
  });

  it("primary frames the response as manual-review only", () => {
    const out = buildManualOnlyCriterionGuidance({
      criterion: MULTIPLE_WAYS,
      inputCriterionId: "wcag22:2.4.5",
      filePath: "page.html",
      line: 1,
      fields: fields(),
    });
    const primary = out["primary"] as { explanation?: string; approach?: string };
    expect(primary.explanation).toMatch(/manual-review only/i);
    // Approach label names the verification action, not a fix recipe.
    expect(primary.approach).toMatch(/verify/i);
  });

  it("primary.confidence is 'medium' — investigation prompt, not a fix", () => {
    const out = buildManualOnlyCriterionGuidance({
      criterion: MULTIPLE_WAYS,
      inputCriterionId: "wcag22:2.4.5",
      filePath: "page.html",
      line: 1,
      fields: fields(),
    });
    const primary = out["primary"] as { confidence?: string };
    // `medium` matches the candidate-match guidance lane — review
    // candidates are softer signals than rule violations. Per
    // doctrine "Reason / priority / fix-description must agree across
    // all three channels."
    expect(primary.confidence).toBe("medium");
  });

  it("alternatives carries a 'read the spec' pointer at the criterion URL", () => {
    const out = buildManualOnlyCriterionGuidance({
      criterion: MULTIPLE_WAYS,
      inputCriterionId: "wcag22:2.4.5",
      filePath: "page.html",
      line: 1,
      fields: fields(),
    });
    const alts = out["alternatives"] as { approach: string; explanation: string }[] | undefined;
    expect(alts).toBeDefined();
    expect(alts?.length).toBeGreaterThan(0);
    expect(alts?.some((a) => /spec/i.test(a.approach))).toBe(true);
    expect(alts?.some((a) => a.explanation.includes(MULTIPLE_WAYS.url))).toBe(true);
  });

  it("does NOT advertise a suppression-pragma alternative", () => {
    // The prose-only fallback offers a `ra11y-disable` pragma; for
    // manual-only criteria that is dishonest (the scanner cannot
    // detect what the pragma would silence — pasting it would only
    // litter source). The helper omits it.
    const out = buildManualOnlyCriterionGuidance({
      criterion: MULTIPLE_WAYS,
      inputCriterionId: "wcag22:2.4.5",
      filePath: "page.html",
      line: 1,
      fields: fields(),
    });
    const alts = out["alternatives"] as { approach: string; explanation: string }[] | undefined;
    expect(alts?.some((a) => /ra11y-disable/i.test(a.explanation))).toBe(false);
    expect(alts?.some((a) => /suppression/i.test(a.approach))).toBe(false);
  });

  it("threads verifyCommandStructured at the top level", () => {
    const out = buildManualOnlyCriterionGuidance({
      criterion: MULTIPLE_WAYS,
      inputCriterionId: "wcag22:2.4.5",
      filePath: "page.html",
      line: 1,
      fields: fields(),
    });
    const verify = out["verifyCommandStructured"] as
      | { tool?: string; verifyRuleId?: string; args?: { path?: string } }
      | undefined;
    expect(verify?.tool).toBe("scan_file");
    expect(verify?.verifyRuleId).toBe("wcag22:2.4.5");
    expect(verify?.args?.path).toBe("page.html");
  });

  it("sourceContext names the file:line and criterion ID", () => {
    const out = buildManualOnlyCriterionGuidance({
      criterion: MULTIPLE_WAYS,
      inputCriterionId: "wcag22:2.4.5",
      filePath: "src/pages/home.html",
      line: 42,
      fields: fields(),
    });
    const primary = out["primary"] as { sourceContext?: string };
    expect(primary.sourceContext).toContain("src/pages/home.html");
    expect(primary.sourceContext).toContain("42");
    expect(primary.sourceContext).toContain("wcag22:2.4.5");
  });
});
