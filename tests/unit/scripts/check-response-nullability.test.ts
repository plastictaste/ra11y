/**
 * Unit coverage for the MCP response-shape sentinel linter.
 *
 * The linter enforces the AI-first consumer model's "present-when-
 * meaningful" rule on optional fields: object-literal properties
 * destined for an MCP response envelope must not fall back to
 * `?? null` / `?? []` / `?? ""` / `?? 0`. These tests exercise the
 * core analyzer (`findResponseSentinelViolations`) against synthetic
 * TypeScript sources so the invariants are checked independently of
 * the current `src/mcp/**` tree shape.
 */

import { describe, expect, test } from "bun:test";
import type { AllowlistEntry } from "../../../scripts/check-response-nullability.ts";
import { findResponseSentinelViolations } from "../../../scripts/check-response-nullability.ts";

const NO_ALLOWLIST: readonly AllowlistEntry[] = [];

describe("findResponseSentinelViolations", () => {
  test("flags `?? null` inside a textResult response shape", () => {
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        const rule = getRule();
        return textResult({
          id: rule.id,
          normativeQuote: rule.docs.normativeQuote ?? null,
        });
      }
    `;
    const violations = findResponseSentinelViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.property).toBe("normativeQuote");
    expect(violations[0]?.fallback).toBe("null");
    expect(violations[0]?.file).toBe("synthetic.ts");
  });

  test("flags `?? []` inside an errorResult details object (nested shape)", () => {
    const src = `
      import { errorResult } from "./helpers";
      export function handler(params: unknown) {
        return errorResult({
          code: "bad-input",
          message: "bad input",
          details: {
            attempted: getAttempted(params) ?? [],
          },
        });
      }
    `;
    const violations = findResponseSentinelViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.property).toBe("attempted");
    expect(violations[0]?.fallback).toBe("[]");
  });

  test('flags `?? ""` and `?? 0` sentinels — all four literal forms', () => {
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          label: maybeLabel() ?? "",
          count: maybeCount() ?? 0,
        });
      }
    `;
    const violations = findResponseSentinelViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(2);
    const fallbacks = violations.map((v) => v.fallback).sort();
    expect(fallbacks).toEqual(['""', "0"]);
  });

  test("passes when `??` falls back to a non-sentinel value (default const, process.cwd())", () => {
    const src = `
      import { textResult } from "./helpers";
      const DEFAULT_ID = "unknown";
      export function handler(params: unknown) {
        return textResult({
          id: resolveId(params) ?? DEFAULT_ID,
          cwd: strParam(params, "cwd") ?? process.cwd(),
        });
      }
    `;
    const violations = findResponseSentinelViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(0);
  });

  test("passes when `?? null` appears in a helper that never feeds textResult/errorResult", () => {
    const src = `
      export function readObject(value: unknown, key: string): unknown {
        if (!value || typeof value !== "object") return null;
        const record = value as Record<string, unknown>;
        // Not inside textResult(...) — plain helper return value.
        return { found: record[key] ?? null };
      }
    `;
    const violations = findResponseSentinelViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(0);
  });

  test("passes for input-param normalization — `const x = ... ?? []` before any response call", () => {
    const src = `
      import { textResult } from "./helpers";
      export function handler(params: unknown) {
        // Input-param normalization: the ?? [] lives on a local const,
        // never inside the object literal that ships to the agent.
        const additionalPaths = strArrayParam(params, "additionalPaths") ?? [];
        const standard = strParam(params, "standard") ?? "wcag22";
        return textResult({
          additionalPaths,
          standard,
        });
      }
    `;
    const violations = findResponseSentinelViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(0);
  });

  test("respects allowlist — wrapper-definition-file entry suppresses `definitionFile: ... ?? null`", () => {
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          wrappers: wrappers.map((w) => ({
            component: w.name,
            definitionFile: definitions.get(w.name)?.filePath ?? null,
          })),
        });
      }
    `;
    // First verify it flags without allowlist …
    const unlisted = findResponseSentinelViolations(src, "src/mcp/detect-wrappers-core.ts", []);
    expect(unlisted).toHaveLength(1);
    expect(unlisted[0]?.property).toBe("definitionFile");

    // … then confirm the allowlist suppresses it.
    const allowlist: readonly AllowlistEntry[] = [
      {
        file: "src/mcp/detect-wrappers-core.ts",
        property: "definitionFile",
        reason: "definitionFile null sentinel is intentional",
      },
    ];
    const listed = findResponseSentinelViolations(
      src,
      "src/mcp/detect-wrappers-core.ts",
      allowlist,
    );
    expect(listed).toHaveLength(0);
  });

  test("allowlist is file-scoped — same property in a different file is still flagged", () => {
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          definitionFile: lookup() ?? null,
        });
      }
    `;
    const allowlist: readonly AllowlistEntry[] = [
      {
        file: "src/mcp/detect-wrappers-core.ts",
        property: "definitionFile",
        reason: "definitionFile null sentinel is intentional",
      },
    ];
    const violations = findResponseSentinelViolations(src, "src/mcp/other-tool.ts", allowlist);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.property).toBe("definitionFile");
  });

  test("ignores `||` fallbacks — only nullish-coalescing `??` is the targeted pattern", () => {
    const src = `
      import { textResult } from "./helpers";
      export function handler() {
        return textResult({
          // || is a different operator with truthy-falsy semantics — out of
          // scope for this check. If it's wrong, a different tool flags it.
          title: maybeTitle() || "",
          items: maybeItems() || [],
        });
      }
    `;
    const violations = findResponseSentinelViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(0);
  });

  test("reports accurate line numbers for each violation", () => {
    const src = [
      'import { textResult } from "./helpers";',
      "export function handler() {",
      "  return textResult({",
      "    a: x() ?? null,", // line 4
      "    b: y(),",
      "    c: z() ?? [],", // line 6
      "  });",
      "}",
    ].join("\n");
    const violations = findResponseSentinelViolations(src, "synthetic.ts", NO_ALLOWLIST);
    expect(violations).toHaveLength(2);
    expect(violations[0]?.line).toBe(4);
    expect(violations[1]?.line).toBe(6);
  });
});
