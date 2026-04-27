import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/link-target-blank-announcement.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/link-target-blank-announcement", () => {
  describe("HTML: fires when target='_blank' has no announcement", () => {
    it("bare <a target='_blank'> with only visible destination text", () => {
      const v = runRule(rule, `<a href="/docs" target="_blank">Docs</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.ruleId).toBe("navigation/link-target-blank-announcement");
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("opens a new window");
      expect(v[0]?.suggestion).toContain("opens in new window");
    });

    it("<a target='_blank'> with aria-label missing the phrase", () => {
      const v = runRule(
        rule,
        `<a href="/pricing" target="_blank" aria-label="Pricing page">Pricing</a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
    });

    it("<a target='_blank'> with an icon child whose aria-label is unrelated", () => {
      const v = runRule(
        rule,
        `<a href="/support" target="_blank">Support <svg aria-label="arrow"></svg></a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("target is not _blank (same-tab navigation, no context change)", () => {
      const v = runRule(rule, `<a href="/docs">Docs</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("aria-label on the link announces the new window", () => {
      const v = runRule(
        rule,
        `<a href="/docs" target="_blank" aria-label="Docs (opens in new window)">Docs</a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("visible link text includes 'external'", () => {
      const v = runRule(
        rule,
        `<a href="https://example.com" target="_blank">Example (external)</a>`,
        {
          filePath: "index.html",
        },
      );
      expect(v).toHaveLength(0);
    });

    it("sr-only span inside the link announces the new tab", () => {
      const v = runRule(
        rule,
        `<a href="/docs" target="_blank">Docs<span class="sr-only"> (opens in new tab)</span></a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("descendant icon's aria-label carries the announcement", () => {
      const v = runRule(
        rule,
        `<a href="/support" target="_blank">Support <svg aria-label="opens in new window"></svg></a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: covers <a>, <Link>, <NavLink>", () => {
    it("fires on <a target='_blank'>Docs</a>", () => {
      const v = runRule(rule, `const X = <a href="/docs" target="_blank">Docs</a>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('<a target="_blank">');
    });

    it("fires on <Link target='_blank'>Docs</Link>", () => {
      const v = runRule(rule, `const X = <Link to="/docs" target="_blank">Docs</Link>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('<Link target="_blank">');
    });

    it("fires on <NavLink target='_blank'> with aria-label that misses the phrase", () => {
      const v = runRule(
        rule,
        `const X = <NavLink to="/x" target="_blank" aria-label="Go to docs">Docs</NavLink>;`,
      );
      expect(v).toHaveLength(1);
    });

    it("does not fire when aria-label announces the new window", () => {
      const v = runRule(
        rule,
        `const X = <a href="/docs" target="_blank" aria-label="Docs (opens in new window)">Docs</a>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("does not fire when an sr-only span inside the link carries the announcement", () => {
      const v = runRule(
        rule,
        `const X = <a href="/docs" target="_blank">Docs<span className="sr-only"> (opens in new tab)</span></a>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("does not fire when descendant icon aria-label has the phrase", () => {
      const v = runRule(
        rule,
        `const X = <a href="/docs" target="_blank">Docs <ExternalIcon aria-label="opens in new window" /></a>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("does not fire when target is not _blank", () => {
      const v = runRule(rule, `const X = <a href="/docs">Docs</a>;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("case-insensitive phrase matching in visible text", () => {
      const v = runRule(rule, `<a href="/x" target="_blank">Docs (Opens In New Window)</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("link text alone cannot rescue when phrase is 'newer' (not a phrase match)", () => {
      // "newer" contains neither "new window" nor "new tab" as a
      // substring — the whitespace before "window"/"tab" keeps the
      // phrase boundaries intact.
      const v = runRule(rule, `<a href="/x" target="_blank">Read the newer docs</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("suggestion echoes the visible link text", () => {
      const v = runRule(rule, `<a href="/api" target="_blank">API reference</a>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain("API reference");
    });

    it("suggestion falls back when link has no visible text", () => {
      const v = runRule(rule, `<a href="/x" target="_blank"><img src="/x.png" alt=""></a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("(opens in new window)");
    });
  });

  it("cites wcag22:3.2.5 (Change on Request, AAA)", () => {
    expect(rule.satisfies).toContain("wcag22:3.2.5");
    expect(rule.satisfies).toHaveLength(1);
  });

  describe("nativeWrapperElements mapping", () => {
    it("opts in to the native `a` tag", () => {
      expect(rule.wrapperTreatsAsElement).toBe("a");
    });

    it("fires on a declared <a> wrapper with target='_blank' and no announcement", () => {
      const v = runRule(
        rule,
        `const X = <MyRouterLink to="/docs" target="_blank">Docs</MyRouterLink>;`,
        { nativeWrapperElements: { MyRouterLink: "a" } },
      );
      expect(v).toHaveLength(1);
    });

    it("does not fire on a wrapper mapped to a different tag", () => {
      const v = runRule(rule, `const X = <Chip to="/docs" target="_blank">Docs</Chip>;`, {
        nativeWrapperElements: { Chip: "button" },
      });
      expect(v).toHaveLength(0);
    });
  });
});

// Registry-integration regression: rule must appear in perRuleCoverage and fire
// when the scanner is run with level: "AAA". The rule's sole criterion is wcag22:3.2.5
// (AAA), so it is level-gated at the default AA scan level — this test confirms it
// is wired correctly in the HTML rule-runner path and fires under explicit AAA.
describe("engine registry integration — AAA level wiring", () => {
  it("rule fires through the full scanner pipeline when level is AAA (HTML file)", async () => {
    const { runScan } = await import("../../../../src/engine/scanner.ts");
    const { parseHtml } = await import("../../../../src/input/parsers/index.ts");
    const { BUILTIN_RULES } = await import("../../../../src/rules/index.ts");
    const { wcag22 } = await import("../../../../src/standards/wcag22/standard.ts");
    const { wcag21 } = await import("../../../../src/standards/wcag21/standard.ts");

    const source = `<html><body><a href="/docs" target="_blank">Docs</a></body></html>`;
    const { root, errors } = parseHtml(source);
    const { result, perRuleCoverage } = runScan({
      standards: [wcag22, wcag21],
      rules: BUILTIN_RULES,
      enabled: ["wcag22", "wcag21"],
      level: "AAA",
      files: [{ filePath: "test.html", source, ast: { language: "html", root, errors } }],
    });

    const ruleViolations = result.violations.filter(
      (v) => v.ruleId === "navigation/link-target-blank-announcement",
    );
    expect(ruleViolations).toHaveLength(1);
    expect(ruleViolations[0]?.criteria).toContain("wcag22:3.2.5");

    // Rule must appear in perRuleCoverage with at least 1 eligible file.
    const coverageRow = perRuleCoverage.find(
      (r) => r.ruleId === "navigation/link-target-blank-announcement",
    );
    expect(coverageRow).toBeDefined();
    expect(coverageRow?.filesEligible).toBeGreaterThanOrEqual(1);
    expect(coverageRow?.findingsEmitted).toBe(1);
  });

  it("rule is level-gated at AA (excluded from active rule set, NOT in perRuleCoverage findings)", async () => {
    const { runScan } = await import("../../../../src/engine/scanner.ts");
    const { parseHtml } = await import("../../../../src/input/parsers/index.ts");
    const { BUILTIN_RULES } = await import("../../../../src/rules/index.ts");
    const { wcag22 } = await import("../../../../src/standards/wcag22/standard.ts");
    const { wcag21 } = await import("../../../../src/standards/wcag21/standard.ts");

    const source = `<html><body><a href="/docs" target="_blank">Docs</a></body></html>`;
    const { root, errors } = parseHtml(source);
    const { result } = runScan({
      standards: [wcag22, wcag21],
      rules: BUILTIN_RULES,
      enabled: ["wcag22", "wcag21"],
      level: "AA",
      files: [{ filePath: "test.html", source, ast: { language: "html", root, errors } }],
    });

    // At AA the AAA-only rule must not fire — confirms level-gating works.
    const ruleViolations = result.violations.filter(
      (v) => v.ruleId === "navigation/link-target-blank-announcement",
    );
    expect(ruleViolations).toHaveLength(0);
  });
});
