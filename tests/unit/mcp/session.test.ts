/**
 * Unit tests for `src/mcp/session.ts` — the McpSession construction
 * contract plus the cwd-scoped anchor on session native wrappers.
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
 *   3. `sessionConfigure({ nativeWrappers, cwd })` captures the cwd as
 *      the session's wrapper anchor, and `sessionWrappersMismatchCwd`
 *      reports cross-cwd drift so downstream tools can raise the
 *      `session_wrappers_configured_for_different_cwd` warning.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { defineRule } from "../../../src/api/plugin.ts";
import { createRegistry, Registry } from "../../../src/engine/registry/registry.ts";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

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

  /**
   * ADR 0022 plugin seam: when a caller constructs a Registry via
   * `createRegistry({ rules, … })` and passes it to the session, every
   * tool that reads `session.registry` must see the user-authored
   * additions. This pins the constructor override contract so a
   * future `ra11y.config.ts` hook or CLI `--plugin` flag thread path
   * can't silently regress — the `list_rules` and scan pipelines
   * read through exactly this seam.
   */
  it("accepts a registry override carrying a user-authored plugin rule", () => {
    const userRule = defineRule({
      id: "example/session-plugin-smoke",
      satisfies: ["wcag22:1.1.1"],
      severity: "warning",
      scope: "node",
      fixClass: "mechanical",
      docs: {
        description: "Session-override smoke.",
        rationale: "",
        goodExample: "",
        badExample: "",
        references: [],
      },
      check() {
        return undefined;
      },
    });
    const registry = createRegistry({ rules: [userRule] });
    const session = new McpSession(registry);
    expect(session.registry.findRule("example/session-plugin-smoke")?.id).toBe(
      "example/session-plugin-smoke",
    );
    expect(session.registry.findRule("media/alt-text-missing")?.id).toBe("media/alt-text-missing");
  });
});

describe("McpSession native-wrapper cwd anchor", () => {
  /**
   * Config-anchored scenario. `sessionConfigure` passes an explicit
   * `cwd: A` alongside wrappers; a follow-up tool call against the same
   * root reports no mismatch and the wrappers apply as configured.
   * Baseline that proves the anchor doesn't false-positive on a matching
   * root.
   */
  it("records the anchor cwd and reports no mismatch when a scan targets the same root", () => {
    const session = new McpSession();
    session.configure({ nativeWrappers: ["FakeButton"], cwd: "/tmp/project-a" });
    expect(session.config.nativeWrappersConfiguredCwd).toBe("/tmp/project-a");
    expect(session.sessionWrappersMismatchCwd("/tmp/project-a")).toBe(false);
    expect(session.config.nativeWrappers).toEqual(["FakeButton"]);
  });

  /**
   * The core bug this anchor plugs: session state is connection-wide,
   * so a `sessionConfigure({ cwd: A, nativeWrappers: ... })` followed
   * by a scan against `cwd: B` silently applies the wrappers to B. The
   * mismatch method returns true so the scan-side warnings pipeline
   * surfaces `session_wrappers_configured_for_different_cwd` and the
   * agent can re-anchor instead of silently trusting stale state.
   */
  it("reports a mismatch when a scan targets a cwd different from the configured anchor", () => {
    const session = new McpSession();
    session.configure({ nativeWrappers: ["FakeButton"], cwd: "/tmp/project-a" });
    expect(session.sessionWrappersMismatchCwd("/tmp/project-b")).toBe(true);
  });

  /**
   * Backward-compat path: legacy callers pass `nativeWrappers` without
   * `cwd`. The anchor defaults to `process.cwd()` so the flag remains
   * concrete — a later tool call targeting the server's spawn dir reads
   * as no-mismatch, a call targeting anything else fires the warning.
   * Keeps existing session configure flows working without a breaking
   * schema change.
   */
  it("defaults the anchor to process.cwd() when `cwd` is omitted, and mismatches elsewhere", () => {
    const session = new McpSession();
    session.configure({ nativeWrappers: ["FakeButton"] });
    expect(session.config.nativeWrappersConfiguredCwd).toBe(process.cwd());
    expect(session.sessionWrappersMismatchCwd(process.cwd())).toBe(false);
    expect(session.sessionWrappersMismatchCwd("/tmp/elsewhere")).toBe(true);
  });

  /**
   * First-write-wins: only the first call that actually lands wrappers
   * stamps the anchor. A later `sessionConfigure` that refines (e.g.
   * adds another wrapper) inherits the original anchor so the mismatch
   * semantics stay tied to where the wrappers first entered the
   * session.
   */
  it("keeps the anchor from the first wrapper-carrying call when a later call refines the list", () => {
    const session = new McpSession();
    session.configure({ nativeWrappers: ["FakeButton"], cwd: "/tmp/project-a" });
    session.configure({ nativeWrappers: ["AnotherButton"], cwd: "/tmp/project-b" });
    expect(session.config.nativeWrappersConfiguredCwd).toBe("/tmp/project-a");
    expect([...session.config.nativeWrappers].sort()).toEqual(["AnotherButton", "FakeButton"]);
    expect(session.sessionWrappersMismatchCwd("/tmp/project-a")).toBe(false);
    expect(session.sessionWrappersMismatchCwd("/tmp/project-b")).toBe(true);
  });

  /**
   * `configure` calls that only touch non-wrapper fields must not stamp
   * an anchor. Without this, a `sessionConfigure({ standard: "wcag22" })`
   * call before any wrapper is registered would incorrectly bind the
   * anchor to the spawn dir and flip the mismatch bit for every future
   * scan.
   */
  it("does not stamp the anchor when no wrapper-shaped field is set", () => {
    const session = new McpSession();
    session.configure({ standard: "wcag22", level: "AA" });
    expect(session.config.nativeWrappersConfiguredCwd).toBeUndefined();
    expect(session.sessionWrappersMismatchCwd("/tmp/anywhere")).toBe(false);
  });

  /**
   * End-to-end: the real repro from the backlog item. An agent calls
   * `sessionConfigure({ cwd: A, nativeWrappers: ["FakeButton"] })` then
   * `list_suppressions({ cwd: B })` against an unrelated tree. The
   * wrappers still show up in `activeNativeWrappers` (session state is
   * connection-wide — this is option (b)), but the response carries
   * the mismatch warning so the agent can see the state leak.
   */
  it("surfaces session_wrappers_configured_for_different_cwd on list_suppressions cross-cwd", async () => {
    const configure = MCP_TOOLS.find((t) => t.def.name === "sessionConfigure");
    const listSuppressions = MCP_TOOLS.find((t) => t.def.name === "list_suppressions");
    if (configure === undefined || listSuppressions === undefined) {
      throw new Error("expected sessionConfigure and list_suppressions tools to be registered");
    }

    const projectA = await mkdtemp(joinPath(tmpdir(), "ra11y-session-cwd-a-"));
    const projectB = await mkdtemp(joinPath(tmpdir(), "ra11y-session-cwd-b-"));
    // A parseable but trivial file in B so the suppression walker has
    // something to descend into. The file has no pragmas — we only care
    // about the warning channel, not the suppressions list.
    await writeFile(joinPath(projectB, "app.tsx"), "export const App = () => <div />;");

    const session = new McpSession();
    await configure.handler({ nativeWrappers: ["FakeButton"], cwd: projectA }, session);

    const result = await listSuppressions.handler({ cwd: projectB }, session);
    const payload = JSON.parse(result.content[0].text) as {
      warnings?: readonly string[];
      meta?: { activeNativeWrappers?: ReadonlyArray<{ name: string; source: string }> };
    };
    expect(payload.warnings ?? []).toContain("session_wrappers_configured_for_different_cwd");
    // The wrappers still apply — option (b) is honesty, not
    // correctness-by-filter. The agent sees the warning and decides.
    const sessionEntries = (payload.meta?.activeNativeWrappers ?? []).filter(
      (e) => e.source === "session",
    );
    expect(sessionEntries.map((e) => e.name)).toContain("FakeButton");
  });
});
