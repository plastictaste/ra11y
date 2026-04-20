/**
 * Unit tests for `src/mcp/session.ts` — the McpSession construction
 * contract.
 *
 * Stage 2 of ADR 0022's migration attaches a Registry to every session.
 * The invariants this file pins:
 *   1. `new McpSession()` populates `session.registry` with the shipped
 *      built-ins, so downstream tools can read rules/standards/finders
 *      through the aggregate instead of reaching for the `BUILTIN_*`
 *      barrels directly.
 *   2. `session.registry.findRule` resolves known IDs to the loaded
 *      Rule object and returns `undefined` for unknown IDs — matching
 *      the underlying primitive's lookup semantics without throws.
 */

import { describe, expect, it } from "bun:test";
import { Registry } from "../../../src/engine/registry/registry.ts";
import { McpSession } from "../../../src/mcp/session.ts";

describe("McpSession.registry", () => {
  it("constructs a Registry populated with the shipped built-ins", () => {
    const session = new McpSession();

    expect(session.registry).toBeInstanceOf(Registry);
    expect(session.registry.rules.length).toBeGreaterThan(0);
    expect(session.registry.standards.length).toBeGreaterThan(0);
    expect(session.registry.finders.length).toBeGreaterThan(0);
  });

  it("resolves a known rule ID via findRule", () => {
    const session = new McpSession();
    const rule = session.registry.findRule("contrast/minimum");

    expect(rule).toBeDefined();
    expect(rule?.id).toBe("contrast/minimum");
  });

  it("returns undefined for an unknown rule ID", () => {
    const session = new McpSession();
    expect(session.registry.findRule("not-a-real-rule/nope")).toBeUndefined();
  });
});
