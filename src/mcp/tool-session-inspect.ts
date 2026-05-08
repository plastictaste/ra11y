/**
 * `session_inspect` — read-only echo of the current MCP session state.
 *
 * Pairs with `sessionConfigure`. After an agent calls `sessionConfigure`
 * with rule overrides, native wrappers, or excludes, there is no way
 * to verify the merged state without making a no-op `scan` call. This
 * tool returns the same `active` shape `sessionConfigure` echoes plus
 * a `configured: boolean` discriminator so the agent can distinguish
 * "session is at the deterministic defaults" (no `sessionConfigure`
 * has run on this connection, OR every call landed only no-op values)
 * from "session has accumulated overrides."
 *
 * Doctrine: per `docs/kb/architecture/ai-first-consumer.md`
 * "Zero-output success is ambiguous failure" — without `configured`,
 * a default-shaped echo would read identically whether the agent
 * never configured the session or configured it back to the defaults.
 * The `configured` flag splits those two cases.
 */

import { resolveActiveRules } from "./rules-evaluated.ts";
import type { McpSession } from "./session.ts";
import { type McpTool, textResult } from "./tools-helpers.ts";

/**
 * True when any field on the session has diverged from the canonical
 * defaults captured in `McpSession`'s constructor — i.e. at least one
 * `sessionConfigure` call landed a value that was not already in
 * effect. We compare against the structural defaults (not a snapshot
 * of the constructor's literal) so a future default change still
 * answers honestly without a parallel update here.
 */
function isSessionConfigured(session: McpSession): boolean {
  const c = session.config;
  return (
    c.standard !== "wcag22" ||
    c.level !== "AA" ||
    c.exclude.length > 0 ||
    Object.keys(c.rules).length > 0 ||
    c.nativeWrappers.length > 0 ||
    Object.keys(c.nativeWrapperElements).length > 0 ||
    c.nativeWrappersConfiguredCwd !== undefined ||
    c.allowWrite !== false
  );
}

export const sessionInspectTool: McpTool = {
  def: {
    name: "session_inspect",
    description:
      "Read-only retrieval of the current MCP session state — the same `active` shape `sessionConfigure` echoes (standard, level, ruleCount, allowWrite, plus exclude/rules/nativeWrappers/nativeWrapperElements/cwd when set). Pair with `sessionConfigure`: an agent that has just configured rule overrides, native wrappers, or excludes can call `session_inspect` to verify the merged state without making a no-op `scan` call. The `configured` boolean discriminates a session at the deterministic defaults (`configured: false`) from one that has accumulated overrides (`configured: true`) — a default-shaped echo alone is ambiguous between the two.\n\nNote: auto-detected wrappers from a per-scan `autoDetectWrappers: true` call are NOT stored on the session — they ride on the scan response only. This tool surfaces session state, which is connection-wide and persists across tool calls.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  handler(_params, session) {
    const c = session.config;
    const ruleCount = resolveActiveRules(session).length;
    return textResult({
      configured: isSessionConfigured(session),
      active: {
        standard: c.standard,
        level: c.level,
        ruleCount,
        allowWrite: c.allowWrite,
        ...(c.exclude.length > 0 ? { exclude: [...c.exclude] } : {}),
        ...(Object.keys(c.rules).length > 0 ? { rules: { ...c.rules } } : {}),
        ...(c.nativeWrappers.length > 0 ? { nativeWrappers: [...c.nativeWrappers] } : {}),
        ...(Object.keys(c.nativeWrapperElements).length > 0
          ? { nativeWrapperElements: { ...c.nativeWrapperElements } }
          : {}),
        ...(c.nativeWrappersConfiguredCwd === undefined
          ? {}
          : { cwd: c.nativeWrappersConfiguredCwd }),
      },
    });
  },
};
