import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../../../src/engine/scanner.ts";
import { parseHtml, parseTsx } from "../../../../src/input/parsers/index.ts";
import { rule } from "../../../../src/rules/aria/live-region-missing-on-innerhtml-target.ts";
import { wcag22 } from "../../../../src/standards/wcag22/standard.ts";
import type { Violation } from "../../../../src/types/violation.ts";

function htmlFile(filePath: string, source: string): ParsedFile {
  const r = parseHtml(source);
  return { filePath, source, ast: { language: "html", root: r.root, errors: r.errors } };
}

function jsFile(filePath: string, source: string): ParsedFile {
  const r = parseTsx(source);
  // The TSX parser handles plain JS via `.js` / `.ts` extensions; the
  // language label is normalized to match the file extension.
  const language = filePath.endsWith(".js")
    ? "js"
    : filePath.endsWith(".ts")
      ? "ts"
      : filePath.endsWith(".jsx")
        ? "jsx"
        : "tsx";
  return { filePath, source, ast: { language, root: r.root, errors: r.errors } };
}

function scan(files: readonly ParsedFile[]): readonly Violation[] {
  const { result } = runScan({
    standards: [wcag22],
    rules: [rule],
    enabled: ["wcag22"],
    files,
  });
  return result.violations.filter((v) => v.ruleId === rule.id);
}

function scanWithCoverage(files: readonly ParsedFile[]): ReturnType<typeof runScan> {
  return runScan({
    standards: [wcag22],
    rules: [rule],
    enabled: ["wcag22"],
    files,
  });
}

describe("rule aria/live-region-missing-on-innerhtml-target", () => {
  describe("fires a violation when", () => {
    it("setInterval rewrites innerHTML on a host with no aria-live", () => {
      const v = scan([
        htmlFile(
          "index.html",
          `<!DOCTYPE html><html><body><div id="clock"></div><script src="./app.js"></script></body></html>`,
        ),
        jsFile(
          "app.js",
          `setInterval(() => {\n  document.getElementById('clock').innerHTML = new Date().toLocaleTimeString();\n}, 1000);`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.location.filePath).toBe("index.html");
      expect(v[0]?.message).toContain('id="clock"');
      expect(v[0]?.message).toContain("aria-live");
      expect(v[0]?.suggestion).toMatch(/aria-live="polite"/);
      expect(v[0]?.suggestion).toContain("app.js:2");
      expect(v[0]?.confidence).toBe("medium");
      expect(v[0]?.couldBeWrongBecause).toEqual([
        "cross_file_innerhtml_target_resolution_not_attempted_by_rule",
      ]);
    });

    it("setTimeout callback rewrites textContent on a bare div", () => {
      const v = scan([
        htmlFile("index.html", `<div id="result"></div>`),
        jsFile(
          "app.js",
          `setTimeout(() => { document.getElementById('result').textContent = 'Saved.'; }, 500);`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("textContent");
    });

    it("event-handler addEventListener rewrites innerHTML on a captured-variable target", () => {
      const v = scan([
        htmlFile("page.html", `<button id="save">Save</button><span id="status"></span>`),
        jsFile(
          "app.js",
          [
            `const status = document.getElementById('status');`,
            `const save = document.getElementById('save');`,
            `save.addEventListener('click', () => {`,
            `  status.innerHTML = '<strong>Saved</strong>';`,
            `});`,
          ].join("\n"),
        ),
      ]);
      // Only the `<span id="status">` is a JS target — `<button id="save">`
      // is the trigger, not the rewrite host. The rule emits exactly one
      // finding at the `<span>`.
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('id="status"');
    });
  });

  describe("does not fire when", () => {
    it("the host already has aria-live", () => {
      const v = scan([
        htmlFile("index.html", `<div id="clock" aria-live="polite"></div>`),
        jsFile(
          "app.js",
          `setInterval(() => { document.getElementById('clock').innerHTML = '12:00'; }, 1000);`,
        ),
      ]);
      expect(v).toHaveLength(0);
    });

    it('the host has role="status"', () => {
      const v = scan([
        htmlFile("index.html", `<div id="status" role="status"></div>`),
        jsFile(
          "app.js",
          `setInterval(() => { document.getElementById('status').textContent = 'Saved'; }, 1000);`,
        ),
      ]);
      expect(v).toHaveLength(0);
    });

    it("the host is <output>", () => {
      const v = scan([
        htmlFile("index.html", `<output id="result"></output>`),
        jsFile(
          "app.js",
          `setInterval(() => { document.getElementById('result').textContent = '42'; }, 1000);`,
        ),
      ]);
      expect(v).toHaveLength(0);
    });

    it("an ancestor element carries the live region", () => {
      const v = scan([
        htmlFile("index.html", `<div role="status"><span id="time"></span></div>`),
        jsFile(
          "app.js",
          `setInterval(() => { document.getElementById('time').innerHTML = '12:00'; }, 1000);`,
        ),
      ]);
      expect(v).toHaveLength(0);
    });

    it("the JS mutation sits at module top-level (not inside a callback)", () => {
      const v = scan([
        htmlFile("index.html", `<div id="banner"></div>`),
        jsFile(
          "app.js",
          // One-shot initialization, NOT a recurring update — SC 4.1.3
          // doesn't apply.
          `document.getElementById('banner').innerHTML = '<h1>Welcome</h1>';`,
        ),
      ]);
      expect(v).toHaveLength(0);
    });

    it("no JS half references the host's id at all", () => {
      const v = scan([
        htmlFile("index.html", `<div id="clock"></div>`),
        jsFile(
          "app.js",
          `setInterval(() => { document.getElementById('other').innerHTML = '12:00'; }, 1000);`,
        ),
      ]);
      // The `<div id="clock">` exists, but no JS rewrites it — no
      // status-message concern.
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("multiple JS sites referencing the same id list all sites in the suggestion", () => {
      const v = scan([
        htmlFile("index.html", `<div id="clock"></div>`),
        jsFile(
          "tick.js",
          `setInterval(() => { document.getElementById('clock').innerHTML = '12:00'; }, 1000);`,
        ),
        jsFile(
          "reset.js",
          `setTimeout(() => { document.getElementById('clock').textContent = '0:00'; }, 60000);`,
        ),
      ]);
      expect(v).toHaveLength(1);
      expect(v[0]?.suggestion).toContain("tick.js");
      expect(v[0]?.suggestion).toContain("reset.js");
    });

    it("equality comparison `el.innerHTML === '...'` does not register as a mutation", () => {
      const v = scan([
        htmlFile("index.html", `<div id="check"></div>`),
        jsFile(
          "app.js",
          `setInterval(() => { if (document.getElementById('check').innerHTML === 'done') return; }, 1000);`,
        ),
      ]);
      expect(v).toHaveLength(0);
    });

    it("scan with only the JS half (HTML missing) emits nothing", () => {
      const v = scan([
        jsFile(
          "app.js",
          `setInterval(() => { document.getElementById('missing').innerHTML = 'x'; }, 1000);`,
        ),
      ]);
      // No HTML for the rule to point at — nothing to emit.
      expect(v).toHaveLength(0);
    });

    it("scan with only the HTML half (JS missing) emits nothing", () => {
      const v = scan([htmlFile("index.html", `<div id="clock"></div>`)]);
      // No JS evidence of dynamic rewrites — putative finding would be
      // heuristic emission on speculation, which the AI-first doctrine
      // rejects.
      expect(v).toHaveLength(0);
    });
  });

  // Per-rule coverage downgrade — doctrine source:
  // docs/kb/architecture/ai-first-consumer.md "Per-finding confidence
  // must reflect per-rule coverage limitations." The rule walks both
  // halves in `afterProject` when both reach the scan, but on a
  // single-file substrate (`scan_file` on the HTML alone or JS alone)
  // the rule cannot resolve the other half — a `coverageConfidence:
  // "high"` row on this shape would silently mis-state the evidence
  // model. Declaring `crossFileCapable: false` downgrades to `medium`
  // with the structured `_not_attempted_by_rule` reason.
  describe("per-rule coverage downgrade", () => {
    it("reports coverageConfidence: medium with _not_attempted_by_rule reason on a single-file scan", () => {
      const { perRuleCoverage } = scanWithCoverage([
        htmlFile("index.html", `<div id="clock"></div>`),
      ]);
      const row = perRuleCoverage.find((r) => r.ruleId === rule.id);
      expect(row).toBeDefined();
      expect(row?.coverageConfidence).toBe("medium");
      expect(row?.reason).toBe("cross_file_innerhtml_target_resolution_not_attempted_by_rule");
    });

    it("reason code uses the _not_attempted_by_rule suffix (never _limited_on_this_input)", () => {
      // Suffix-agreement invariant — doctrine source:
      // docs/kb/architecture/ai-first-consumer.md "Reason-token
      // suffixes must name the actual predicate, not an input-specific
      // hiccup." The rule declares `crossFileCapable: false`, so its
      // cross-file limitation is a permanent rule-design fact, not an
      // input-specific hiccup. Pin that the per-finding
      // `couldBeWrongBecause` carries `_not_attempted_by_rule` (never
      // `_limited_on_this_input`) so per-finding and per-rule layers
      // agree on the suffix shape.
      const v = scan([
        htmlFile(
          "index.html",
          `<!DOCTYPE html><html><body><div id="clock"></div><script src="./app.js"></script></body></html>`,
        ),
        jsFile(
          "app.js",
          `setInterval(() => { document.getElementById('clock').innerHTML = '12:00'; }, 1000);`,
        ),
      ]);
      expect(v.length).toBeGreaterThan(0);
      for (const finding of v) {
        const codes = finding.couldBeWrongBecause ?? [];
        const limitedOnInput = codes.filter((c) => c.endsWith("_limited_on_this_input")).length;
        const notAttempted = codes.filter((c) => c.endsWith("_not_attempted_by_rule")).length;
        // At most one of the two suffix shapes; never both.
        expect(limitedOnInput + notAttempted).toBeLessThanOrEqual(1);
        expect(limitedOnInput).toBe(0);
        expect(notAttempted).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
