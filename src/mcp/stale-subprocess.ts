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
 * Detection is a deterministic mtime comparison — the bundle file that
 * sourced this module is stat'd at server startup; on each tool call,
 * we re-stat it and compare. Newer on-disk mtime → the file was
 * rewritten after startup → the running subprocess is stale. Not a
 * heuristic: if the bundle changed, the process running the old bytes
 * is provably behind.
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
  readonly path: string;
  readonly mtimeMs: number;
}

let recorded: RecordedStart | null = null;

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
function resolveBundlePath(): string | null {
  try {
    const u = new URL(import.meta.url);
    if (u.protocol !== "file:") return null;
    return fileURLToPath(u);
  } catch {
    return null;
  }
}

/**
 * Records the bundle mtime at MCP server startup. Subsequent calls are
 * no-ops so the captured baseline is never overwritten — a legitimate
 * rebuild must remain detectable even if the caller accidentally
 * re-records mid-session. Safe to call from module init or from
 * {@link startMcpServer}; the latter is preferred so it only runs when
 * the MCP binary is actually serving.
 */
export function recordSubprocessStart(): void {
  if (recorded !== null) return;
  const path = resolveBundlePath();
  if (path === null) return;
  try {
    const stat = statSync(path);
    recorded = { path, mtimeMs: stat.mtimeMs };
  } catch {
    // Bundle path inaccessible (chmod, deletion, etc.) — detection is
    // unavailable; no warning will fire.
  }
}

/**
 * Test-only reset for the recorded baseline. Intentionally not exported
 * from the package barrel; tests import from this module directly.
 */
export function __resetSubprocessRecord(): void {
  recorded = null;
}

/**
 * Returns true when the bundle file's current mtime is strictly greater
 * than the mtime captured at startup. Same-mtime is not stale — an fs
 * snapshot at the exact moment of write should not self-trigger. Read
 * failure at probe time returns `false`: the scanner keeps working and
 * the warning simply doesn't fire. Stale-detection is additive signal,
 * not a correctness gate.
 */
export function isSubprocessStale(): boolean {
  if (recorded === null) return false;
  try {
    const stat = statSync(recorded.path);
    return stat.mtimeMs > recorded.mtimeMs;
  } catch {
    return false;
  }
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
