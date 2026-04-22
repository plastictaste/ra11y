/**
 * Stale-MCP-subprocess detection.
 *
 * Closes the "rebuild lands on disk but nothing changes in the session"
 * silent-miss mode: the host spawned the MCP subprocess against the
 * bundle on disk, the user ran `bun run build`, and the bundle on disk
 * is now newer than the code the running subprocess is executing. Every
 * subsequent tool call returns results from the pre-rebuild bundle;
 * without a signal, the agent reads them as current.
 *
 * Detection is a deterministic mtime comparison — two baseline stat
 * targets are captured at MCP server startup, and each tool call
 * re-stats both. A stat whose current mtime is strictly greater than
 * the baseline means that file was rewritten after startup → the
 * running subprocess is stale. Not a heuristic: if either stat advanced,
 * the process running the old bytes is provably behind.
 *
 * The two targets are complementary:
 *   - `process.argv[1]` — the actual entry script the process was spawned
 *     from. In production this is `dist/cli.js`; in dev (`bun src/cli.ts`)
 *     it is `src/cli.ts`. This is the canonical "what is this subprocess
 *     running from" signal and the one most likely to advance on rebuild.
 *   - `import.meta.url` — the path this module lives at. In a bundled
 *     deployment it resolves to the same `dist/cli.js`; in dev it
 *     resolves to `src/mcp/stale-subprocess.ts`. Redundant in production,
 *     additive coverage in dev (catches direct edits to this module).
 *
 * Tracking both targets means a dev-mode subprocess whose entry script
 * was edited mid-session also surfaces the warning — the previous
 * single-target implementation relied on `import.meta.url` alone and
 * silently missed the entry-script-change case (root cause of the
 * Q3-MCP-RESTART-HINT-SUBPROCESS-RACE report: 23 tool calls across 90
 * minutes, `dist/cli.js` mtime advanced, warning never fired because
 * the process was running from a different entry path).
 *
 * When stale, we inject `"stale_mcp_subprocess"` into the tool response's
 * `warnings[]` (merged with any scan-meta warnings that already fired)
 * plus a prose `staleSubprocessHint` the agent can surface verbatim.
 * Not heuristic suppression — additive accountability. See CLAUDE.md §1
 * "Zero-output success is ambiguous failure" for the warnings channel
 * doctrine.
 */

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpToolResult } from "./tools-helpers.ts";

export const STALE_SUBPROCESS_WARNING = "stale_mcp_subprocess";
export const STALE_SUBPROCESS_HINT =
  "rebuild detected; reconnect the MCP to pick up parser and rule changes";

interface RecordedStart {
  /** Entry path recorded from `process.argv[1]` at startup. */
  readonly argvEntry: PathBaseline | null;
  /** Module path recorded from `import.meta.url` at startup. */
  readonly moduleUrl: PathBaseline | null;
}

interface PathBaseline {
  readonly path: string;
  readonly mtimeMs: number;
}

let recorded: RecordedStart | null = null;

/**
 * Test-only override for the entry-path resolution. Leave `null` in
 * production — real resolution reads `process.argv[1]`. Setting this
 * lets a test point the detector at a synthetic temp file so the
 * record→rewrite→stale cycle can be exercised without spawning a real
 * subprocess. Paired with `overrideModulePath` so tests can control
 * both baselines independently.
 */
let overrideEntryPath: string | null = null;
let overrideModulePath: string | null = null;

/**
 * Resolves the filesystem path of the module that called into this
 * function's own bundle. When ra11y is installed from npm and run via
 * `dist/cli.js`, `bun build` inlines this module into the single entry
 * bundle — `import.meta.url` resolves to `dist/cli.js`, and its mtime
 * is the thing that changes on rebuild. When running from source
 * (`bun src/cli.ts` in dev), `import.meta.url` resolves to
 * `src/mcp/stale-subprocess.ts`, so edits to the server source track
 * through the same way.
 *
 * Returns `null` when the URL scheme is not `file:` (extremely rare —
 * e.g. a custom loader serving modules from a data URL). The caller
 * treats that as "detection unavailable" and the warning simply never
 * fires; the scanner stays fully functional.
 */
function resolveModulePath(): string | null {
  if (overrideModulePath !== null) return overrideModulePath;
  try {
    const u = new URL(import.meta.url);
    if (u.protocol !== "file:") return null;
    return fileURLToPath(u);
  } catch {
    return null;
  }
}

/**
 * Resolves the entry script the current process was spawned from.
 * `process.argv[1]` is the canonical "what is this subprocess running
 * from" signal — it's the path Node received on the command line.
 *
 * In production (`node dist/cli.js --mcp`) this is the bundle's
 * absolute path; in dev (`bun src/cli.ts --mcp`) it is the source entry.
 * Either way, a rebuild that replaces the entry will advance this
 * file's mtime, which is what we want to detect.
 *
 * Returns `null` when `process.argv[1]` is missing (e.g. a REPL launch)
 * or empty; the caller falls back to the module-url baseline alone.
 */
function resolveEntryPath(): string | null {
  if (overrideEntryPath !== null) return overrideEntryPath;
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return null;
  return entry;
}

/**
 * Stats a path and returns the mtime in ms. Returns `null` on any stat
 * failure — detection is additive signal, not a correctness gate, so
 * inaccessible paths simply mean the baseline for that target is
 * unavailable.
 */
function safeStatMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Builds a baseline record for a given path. Returns `null` if the
 * path is itself `null` or the stat fails — the caller preserves the
 * null so subsequent {@link isSubprocessStale} calls don't misread an
 * "unavailable baseline" as "same mtime."
 */
function recordBaseline(path: string | null): PathBaseline | null {
  if (path === null) return null;
  const mtimeMs = safeStatMtime(path);
  if (mtimeMs === null) return null;
  return { path, mtimeMs };
}

/**
 * Records the baseline mtimes at MCP server startup. Subsequent calls
 * are no-ops only when a baseline was successfully captured — if
 * recording failed (both targets null), the next call retries so a
 * transient fs hiccup at startup doesn't wedge detection off for the
 * whole process lifetime. Safe to call from module init or from
 * {@link startMcpServer}; the latter is preferred so it only runs when
 * the MCP binary is actually serving.
 */
export function recordSubprocessStart(): void {
  if (recorded !== null && (recorded.argvEntry !== null || recorded.moduleUrl !== null)) {
    return;
  }
  const argvEntry = recordBaseline(resolveEntryPath());
  const moduleUrl = recordBaseline(resolveModulePath());
  recorded = { argvEntry, moduleUrl };
}

/**
 * Test-only reset for the recorded baseline. Intentionally not exported
 * from the package barrel; tests import from this module directly.
 * Also clears any path overrides set via {@link __setBundlePathOverride}.
 */
export function __resetSubprocessRecord(): void {
  recorded = null;
  overrideEntryPath = null;
  overrideModulePath = null;
}

/**
 * Test-only seam — points the detector at synthetic paths so a test can
 * exercise the full record→rewrite→stale cycle against a temp file
 * without spawning a real subprocess. Either argument may be `null` to
 * leave that baseline target at its production resolver. Mirrors
 * {@link build-provenance.ts}'s `__setBundlePathOverride` pattern.
 *
 * The caller is responsible for invoking
 * {@link __resetSubprocessRecord} between tests so the override and
 * baseline stay in sync.
 */
export function __setBundlePathOverride(
  entry: string | null,
  moduleUrl: string | null = null,
): void {
  overrideEntryPath = entry;
  overrideModulePath = moduleUrl;
  recorded = null;
}

/**
 * Returns true when any tracked baseline's current mtime is strictly
 * greater than the mtime captured at startup. Both the entry path and
 * the module path are checked; an advance on either fires. Same-mtime
 * is not stale — an fs snapshot at the exact moment of write should not
 * self-trigger. Read failure at probe time returns `false`: the scanner
 * keeps working and the warning simply doesn't fire. Stale-detection
 * is additive signal, not a correctness gate.
 */
export function isSubprocessStale(): boolean {
  if (recorded === null) return false;
  return isBaselineStale(recorded.argvEntry) || isBaselineStale(recorded.moduleUrl);
}

function isBaselineStale(baseline: PathBaseline | null): boolean {
  if (baseline === null) return false;
  const current = safeStatMtime(baseline.path);
  if (current === null) return false;
  return current > baseline.mtimeMs;
}

/**
 * Merges the stale-subprocess warning + prose hint into a tool result's
 * JSON text payload. Only called when {@link isSubprocessStale} returns
 * true, so the per-call parse/serialize cost is paid exclusively in the
 * error path — not on every healthy call.
 *
 * Shape handling:
 *   - `content[0].text` is parsed as JSON. If parsing fails or the
 *     payload isn't an object (e.g. a bare string), the result is
 *     returned unchanged — we never corrupt a handler that returns
 *     something other than the conventional object-wrapped payload.
 *   - Existing `warnings: string[]` are preserved; the stale code is
 *     prepended so it's the first thing an agent sees. Duplicates are
 *     dropped so a second call doesn't double-surface. Non-string
 *     entries (junk the handler leaked) are filtered rather than
 *     passed through — the agent reading the array gets a clean
 *     `string[]`.
 *   - `staleSubprocessHint` is added as a sibling prose field so the
 *     agent can surface remediation text verbatim without decoding the
 *     warning code.
 *   - `isError: true` results are annotated too — the warning is about
 *     the *subprocess*, not the individual call's success, so hiding it
 *     behind an error envelope is the canonical silent-miss failure
 *     mode (an agent that hits `file-unsupported` on a `.md` file
 *     during a stale subprocess never learns the tool needs a
 *     restart). `isError` and `structuredContent` are preserved
 *     verbatim; the warning + hint are merged into the text payload,
 *     and the warning (not the hint prose — agents branch on codes,
 *     not message text) is merged into `structuredContent` too so
 *     consumers reading the structured lane still see it. See
 *     AI-first consumer doctrine: "Zero-output success is ambiguous
 *     failure" — an error envelope without the stale signal reads as
 *     "tool is fine, just this call failed."
 */
export function annotateStaleSubprocess(result: McpToolResult): McpToolResult {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return result;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result;
  const payload = parsed as Record<string, unknown>;
  const existing = Array.isArray(payload["warnings"])
    ? (payload["warnings"] as readonly unknown[]).filter(
        (w): w is string => typeof w === "string" && w !== STALE_SUBPROCESS_WARNING,
      )
    : [];
  payload["warnings"] = [STALE_SUBPROCESS_WARNING, ...existing];
  payload["staleSubprocessHint"] = STALE_SUBPROCESS_HINT;
  const nextText = JSON.stringify(payload);
  const remaining = result.content.slice(1);
  // Preserve structuredContent verbatim when present, but also merge the
  // stale code into its warnings lane so agents reading structuredContent
  // (not content[0].text) still see the signal. Leave the structured
  // shape otherwise untouched — the error's code/message/details/
  // remediation fields are the contract.
  const nextStructured =
    result.structuredContent === undefined
      ? undefined
      : mergeStaleIntoStructured(result.structuredContent);
  return {
    ...result,
    content: [{ type: "text", text: nextText }, ...remaining],
    ...(nextStructured === undefined ? {} : { structuredContent: nextStructured }),
  };
}

/**
 * Merges the stale warning code into a `structuredContent` object's
 * `warnings: string[]` lane. Non-string entries are filtered, the
 * stale code is prepended, and existing fields are preserved. The
 * input object is not mutated.
 */
function mergeStaleIntoStructured(structured: Record<string, unknown>): Record<string, unknown> {
  const existing = Array.isArray(structured["warnings"])
    ? (structured["warnings"] as readonly unknown[]).filter(
        (w): w is string => typeof w === "string" && w !== STALE_SUBPROCESS_WARNING,
      )
    : [];
  return {
    ...structured,
    warnings: [STALE_SUBPROCESS_WARNING, ...existing],
  };
}
