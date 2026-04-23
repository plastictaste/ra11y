/**
 * Integration tests for Violation.patternId. Wires a synthetic rule that
 * emits a concrete `snippet` alongside its violation and runs the full
 * scanner over multiple parsed files to assert the cross-template dedup
 * invariants that define the feature.
 *
 *   - Same rule + byte-identical snippet in different files → same
 *     `patternId` AND different `findingId`.
 *   - Same rule + snippets that differ only by attribute order /
 *     whitespace / unique id tokens → same `patternId`.
 *   - Rules that don't populate `snippet` → `patternId` absent
 *     (conditional spread, present-when-meaningful).
 *
 * See docs/kb/architecture/ai-first-consumer.md (surface-don't-suppress)
 * and `src/utils/pattern-id.ts` for the canonicalization recipe.
 */

import { describe, expect, it } from "bun:test";
import { defineRule, defineStandard } from "../../../src/api/plugin.ts";
import { type ParsedFile, runScan } from "../../../src/engine/scanner.ts";
import { parseHtml } from "../../../src/input/parsers/index.ts";
import type { Ast } from "../../../src/types/ast.ts";

const testStandard = defineStandard({
  id: "teststd",
  name: "Test",
  version: "1.0",
  publisher: "Test",
  url: "https://example.com/teststd",
  levels: ["A"],
  criteria: [
    {
      id: "teststd:1.1",
      standardId: "teststd",
      localId: "1.1",
      title: "Test 1.1",
      level: "A",
      description: "Synthetic criterion for pattern-id engine tests.",
      url: "https://example.com/teststd#1.1",
      automatable: "full",
    },
  ],
});

/**
 * Synthetic rule that fires on every `<button>` element and emits a
 * `snippet` equal to the element's outer source text. Routes each
 * emission through `ctx.emit` so the engine's stamp site exercises
 * `patternId`.
 */
function makeButtonRule(options: { readonly emitSnippet: boolean }) {
  return defineRule({
    id: "test/button-pattern",
    satisfies: ["teststd:1.1"],
    severity: "error",
    scope: "node",
    fixClass: "mechanical",
    appliesTo: { fileExtensions: [".html"] },
    docs: {
      description: "Synthetic test rule — fires on every <button>.",
      rationale: "Test fixture for patternId invariants.",
      goodExample: "<button aria-label='x'/>",
      badExample: "<button/>",
      references: [],
    },
    check(ctx) {
      const source = ctx.source;
      // Walk the raw source for <button ... > openers so the test owns
      // the snippet shape rather than depending on AST serialization.
      const re = /<button\b[^>]*>/giu;
      let match: RegExpExecArray | null = re.exec(source);
      while (match !== null) {
        const openerText = match[0];
        // Compute 1-based line from the match index.
        const prefix = source.slice(0, match.index);
        const line = prefix.split("\n").length;
        const lastNewline = prefix.lastIndexOf("\n");
        const column = match.index - lastNewline;
        ctx.emit({
          severity: "error",
          location: { filePath: "", line, column },
          message: "synthetic button emission",
          ...(options.emitSnippet ? { snippet: openerText } : {}),
        });
        match = re.exec(source);
      }
      return undefined;
    },
  });
}

function htmlFile(path: string, source: string): ParsedFile {
  const parsed = parseHtml(source);
  const ast: Ast = { language: "html", root: parsed.root, errors: parsed.errors };
  return { filePath: path, source, ast };
}

describe("Violation.patternId — cross-file invariants", () => {
  it("byte-identical snippet in two files → same patternId, different findingId", () => {
    const snippet = `<button class="navbar-toggle" data-toggle="collapse">`;
    const a = htmlFile("a.html", `<!doctype html><html><body>${snippet}</body></html>`);
    const b = htmlFile("b.html", `<!doctype html><html><body>   ${snippet}  </body></html>`);
    const { result } = runScan({
      standards: [testStandard],
      rules: [makeButtonRule({ emitSnippet: true })],
      enabled: ["teststd"],
      files: [a, b],
    });
    const findings = result.violations.filter((v) => v.ruleId === "test/button-pattern");
    expect(findings.length).toBe(2);
    expect(findings[0]!.patternId).toBeDefined();
    expect(findings[1]!.patternId).toBeDefined();
    expect(findings[0]!.patternId).toBe(findings[1]!.patternId);
    // findingId differs because filename + source context differ.
    expect(findings[0]!.findingId).not.toBe(findings[1]!.findingId);
  });

  it("attribute-order variation across files still shares one patternId", () => {
    const a = htmlFile(
      "a.html",
      `<!doctype html><html><body><button class="nav" data-toggle="collapse"></button></body></html>`,
    );
    const b = htmlFile(
      "b.html",
      `<!doctype html><html><body><button data-toggle="collapse" class="nav"></button></body></html>`,
    );
    const { result } = runScan({
      standards: [testStandard],
      rules: [makeButtonRule({ emitSnippet: true })],
      enabled: ["teststd"],
      files: [a, b],
    });
    const findings = result.violations.filter((v) => v.ruleId === "test/button-pattern");
    expect(findings.length).toBe(2);
    expect(findings[0]!.patternId).toBe(findings[1]!.patternId);
  });

  it("unique hashed id tokens across templates canonicalize to one patternId", () => {
    // Bootstrap-style sibling template copies: identical structure
    // except for a unique element id in each template dir.
    const a = htmlFile(
      "templates/agency/index.html",
      `<!doctype html><html><body><button id="nav-12345" class="navbar-toggle" data-toggle="collapse"></button></body></html>`,
    );
    const b = htmlFile(
      "templates/grayscale/index.html",
      `<!doctype html><html><body><button id="nav-98765" class="navbar-toggle" data-toggle="collapse"></button></body></html>`,
    );
    const c = htmlFile(
      "templates/resume/index.html",
      `<!doctype html><html><body><button id="nav-54321" class="navbar-toggle" data-toggle="collapse"></button></body></html>`,
    );
    const { result } = runScan({
      standards: [testStandard],
      rules: [makeButtonRule({ emitSnippet: true })],
      enabled: ["teststd"],
      files: [a, b, c],
    });
    const findings = result.violations.filter((v) => v.ruleId === "test/button-pattern");
    expect(findings.length).toBe(3);
    const keys = new Set(findings.map((v) => v.patternId));
    expect(keys.size).toBe(1);
  });

  it("genuinely different patterns under the same rule have different patternIds", () => {
    const a = htmlFile(
      "a.html",
      `<!doctype html><html><body><button class="navbar-toggle" data-toggle="collapse"></button></body></html>`,
    );
    const b = htmlFile(
      "b.html",
      `<!doctype html><html><body><button class="modal-close" data-toggle="modal"></button></body></html>`,
    );
    const { result } = runScan({
      standards: [testStandard],
      rules: [makeButtonRule({ emitSnippet: true })],
      enabled: ["teststd"],
      files: [a, b],
    });
    const findings = result.violations.filter((v) => v.ruleId === "test/button-pattern");
    expect(findings.length).toBe(2);
    expect(findings[0]!.patternId).not.toBe(findings[1]!.patternId);
  });

  it("rule that does not emit snippet → patternId absent on the Violation", () => {
    const a = htmlFile(
      "a.html",
      `<!doctype html><html><body><button class="x"></button></body></html>`,
    );
    const { result } = runScan({
      standards: [testStandard],
      rules: [makeButtonRule({ emitSnippet: false })],
      enabled: ["teststd"],
      files: [a],
    });
    const findings = result.violations.filter((v) => v.ruleId === "test/button-pattern");
    expect(findings.length).toBe(1);
    expect(findings[0]!.patternId).toBeUndefined();
    // Sanity-check: conditional spread keeps the key off the wire too.
    expect(Object.hasOwn(findings[0] as object, "patternId")).toBe(false);
  });

  it("patternId is a 12-char lowercase hex string when populated", () => {
    const a = htmlFile(
      "a.html",
      `<!doctype html><html><body><button class="x"></button></body></html>`,
    );
    const { result } = runScan({
      standards: [testStandard],
      rules: [makeButtonRule({ emitSnippet: true })],
      enabled: ["teststd"],
      files: [a],
    });
    const findings = result.violations.filter((v) => v.ruleId === "test/button-pattern");
    expect(findings[0]!.patternId).toMatch(/^[0-9a-f]{12}$/);
  });
});
