/**
 * Unit tests for `src/mcp/stale-subprocess.ts`.
 *
 * Covers the two invariants that keep the silent-rebuild failure mode
 * from regressing:
 *   1. `isSubprocessStale` is a deterministic mtime comparison — it
 *      returns false when the bundle is unchanged, true when it is
 *      rewritten, and false (not-throw) when recording failed or the
 *      path is inaccessible.
 *   2. `annotateStaleSubprocess` merges the warning + hint into the
 *      content payload without destroying pre-existing warnings,
 *      touches only conventional JSON-object payloads, and leaves
 *      error results alone.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __recordSubprocessStartForTest,
  __resetSubprocessRecord,
  annotateStaleSubprocess,
  isSubprocessStale,
  recordSubprocessStart,
  STALE_SUBPROCESS_HINT,
  STALE_SUBPROCESS_WARNING,
} from "../../../src/mcp/stale-subprocess.ts";
import type { McpToolResult } from "../../../src/mcp/tools-helpers.ts";

describe("isSubprocessStale", () => {
  beforeEach(() => {
    __resetSubprocessRecord();
  });
  afterEach(() => {
    __resetSubprocessRecord();
  });

  it("returns false when no baseline has been recorded", () => {
    expect(isSubprocessStale()).toBe(false);
  });

  it("returns false immediately after a successful record (same mtime)", () => {
    recordSubprocessStart();
    expect(isSubprocessStale()).toBe(false);
  });

  it("records the baseline once — subsequent record calls do not overwrite it", () => {
    recordSubprocessStart();
    // If the second call overwrote the baseline, a rebuild-after-record
    // could not be distinguished from a fresh start. Invariant check via
    // behavior: isSubprocessStale stays false after re-record.
    recordSubprocessStart();
    expect(isSubprocessStale()).toBe(false);
  });
});

describe("annotateStaleSubprocess", () => {
  const makeResult = (payload: unknown): McpToolResult => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });

  it("injects the warning code and prose hint into an object payload with no prior warnings", () => {
    const result = makeResult({ plan: { violations: 3 }, meta: {} });
    const annotated = annotateStaleSubprocess(result);
    const parsed = JSON.parse(annotated.content[0]!.text) as {
      warnings: string[];
      staleSubprocessHint: string;
      plan: { violations: number };
    };
    expect(parsed.warnings).toEqual([STALE_SUBPROCESS_WARNING]);
    expect(parsed.staleSubprocessHint).toBe(STALE_SUBPROCESS_HINT);
    expect(parsed.plan.violations).toBe(3);
  });

  it("prepends the stale code to existing warnings so it is the first signal the agent sees", () => {
    const result = makeResult({
      warnings: ["scanned_zero_files", "no_config_found"],
      meta: {},
    });
    const annotated = annotateStaleSubprocess(result);
    const parsed = JSON.parse(annotated.content[0]!.text) as { warnings: string[] };
    expect(parsed.warnings).toEqual([
      STALE_SUBPROCESS_WARNING,
      "scanned_zero_files",
      "no_config_found",
    ]);
  });

  it("deduplicates — a pre-existing stale code is not double-surfaced", () => {
    const result = makeResult({
      warnings: [STALE_SUBPROCESS_WARNING, "scanned_zero_files"],
    });
    const annotated = annotateStaleSubprocess(result);
    const parsed = JSON.parse(annotated.content[0]!.text) as { warnings: string[] };
    expect(parsed.warnings).toEqual([STALE_SUBPROCESS_WARNING, "scanned_zero_files"]);
  });

  it("filters non-string warning entries while preserving valid ones", () => {
    const result = makeResult({
      warnings: ["scanned_zero_files", 42, null, "no_config_found"],
    });
    const annotated = annotateStaleSubprocess(result);
    const parsed = JSON.parse(annotated.content[0]!.text) as { warnings: string[] };
    expect(parsed.warnings).toEqual([
      STALE_SUBPROCESS_WARNING,
      "scanned_zero_files",
      "no_config_found",
    ]);
  });

  it("leaves non-JSON content unchanged — a handler that emits plain text is not corrupted", () => {
    const result: McpToolResult = {
      content: [{ type: "text", text: "plain prose, not JSON" }],
    };
    const annotated = annotateStaleSubprocess(result);
    expect(annotated).toBe(result);
  });

  it("leaves bare-value JSON payloads (arrays, strings, numbers) unchanged", () => {
    const arrayResult = makeResult(["a", "b"]);
    expect(annotateStaleSubprocess(arrayResult)).toBe(arrayResult);
    const stringResult: McpToolResult = {
      content: [{ type: "text", text: JSON.stringify("just a string") }],
    };
    expect(annotateStaleSubprocess(stringResult)).toBe(stringResult);
  });

  it("annotates isError results — the warning is about the subprocess, not this call's failure", () => {
    // Silent-miss mode the fix closes: an agent hitting `file-unsupported`
    // on a `.md` file during a stale subprocess would, without this
    // annotation, read the error as "extension truly unsupported" and
    // never learn the tool needs a restart.
    const errorResult: McpToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "unsupported extension", code: "file-unsupported" }),
        },
      ],
      isError: true,
    };
    const annotated = annotateStaleSubprocess(errorResult);
    expect(annotated.isError).toBe(true);
    const parsed = JSON.parse(annotated.content[0]!.text) as {
      warnings: string[];
      staleSubprocessHint: string;
      error: string;
      code: string;
    };
    expect(parsed.warnings).toEqual([STALE_SUBPROCESS_WARNING]);
    expect(parsed.staleSubprocessHint).toBe(STALE_SUBPROCESS_HINT);
    // The error envelope's own fields remain intact — code + message are
    // the contract agents branch on for the failed call itself.
    expect(parsed.error).toBe("unsupported extension");
    expect(parsed.code).toBe("file-unsupported");
  });

  it("filters non-string warning entries on an error envelope too", () => {
    // Error envelopes can carry a pre-existing `warnings` array (e.g.
    // from a handler that attaches soft-signals before failing). Junk
    // entries get filtered the same way as on a nominal payload so the
    // agent-facing array stays a clean `string[]`.
    const result: McpToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "boom",
            code: "file-not-found",
            warnings: ["scanned_zero_files", 42, null, { not: "a string" }, "no_config_found"],
          }),
        },
      ],
      isError: true,
    };
    const annotated = annotateStaleSubprocess(result);
    const parsed = JSON.parse(annotated.content[0]!.text) as { warnings: string[] };
    expect(parsed.warnings).toEqual([
      STALE_SUBPROCESS_WARNING,
      "scanned_zero_files",
      "no_config_found",
    ]);
  });

  it("preserves structuredContent on an error envelope and merges the stale code into its warnings lane", () => {
    // Error envelopes carry structuredContent with { code, message,
    // details?, remediation? }. Annotating must not drop it — agents
    // that branch on structuredContent (e.g. the audit meta-tool) still
    // need those fields, plus the stale signal so they know the
    // subprocess is stale regardless of which lane they read.
    const structured: Record<string, unknown> = {
      code: "file-unsupported",
      message: "unsupported extension",
      details: { path: "README.md", extension: ".md" },
      remediation: "pass a .tsx/.jsx/.html/.css file",
    };
    const errorResult: McpToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "unsupported extension", code: "file-unsupported" }),
        },
      ],
      structuredContent: structured,
      isError: true,
    };
    const annotated = annotateStaleSubprocess(errorResult);
    expect(annotated.isError).toBe(true);
    expect(annotated.structuredContent).toBeDefined();
    const nextStructured = annotated.structuredContent as Record<string, unknown>;
    expect(nextStructured["code"]).toBe("file-unsupported");
    expect(nextStructured["message"]).toBe("unsupported extension");
    expect(nextStructured["details"]).toEqual({ path: "README.md", extension: ".md" });
    expect(nextStructured["remediation"]).toBe("pass a .tsx/.jsx/.html/.css file");
    expect(nextStructured["warnings"]).toEqual([STALE_SUBPROCESS_WARNING]);
    // Source structuredContent object is not mutated — the handler that
    // produced it may retain references for logging or telemetry.
    expect(structured["warnings"]).toBeUndefined();
  });

  it("merges stale code into a pre-populated structuredContent.warnings lane (dedup + non-string filter)", () => {
    const structured: Record<string, unknown> = {
      code: "cwd-not-found",
      message: "cwd does not exist",
      warnings: [STALE_SUBPROCESS_WARNING, "scanned_zero_files", 99, null],
    };
    const errorResult: McpToolResult = {
      content: [{ type: "text", text: JSON.stringify({ error: "cwd does not exist" }) }],
      structuredContent: structured,
      isError: true,
    };
    const annotated = annotateStaleSubprocess(errorResult);
    const nextStructured = annotated.structuredContent as Record<string, unknown>;
    expect(nextStructured["warnings"]).toEqual([STALE_SUBPROCESS_WARNING, "scanned_zero_files"]);
  });

  it("leaves results with no content items unchanged", () => {
    const empty: McpToolResult = { content: [] };
    expect(annotateStaleSubprocess(empty)).toBe(empty);
  });

  it("preserves additional content entries after the first text block", () => {
    const result: McpToolResult = {
      content: [
        { type: "text", text: JSON.stringify({ meta: {} }) },
        { type: "text", text: "trailing prose" },
      ],
    };
    const annotated = annotateStaleSubprocess(result);
    expect(annotated.content.length).toBe(2);
    expect(annotated.content[1]).toEqual({ type: "text", text: "trailing prose" });
  });
});

describe("mtime-based detection (deterministic, with injected paths)", () => {
  // These tests exercise the record/compare logic end-to-end against
  // real temp files whose mtimes we control via `utimesSync`. The
  // invariant: the running subprocess's baseline must notice when
  // ANY of the files it treats as "the code I'm running" advance
  // mtime after record time — so a mid-session rebuild surfaces as
  // a stale-warning on the next tool call regardless of which file
  // in the code-path (bundle, entry script, etc.) got rewritten.
  //
  // The `__recordSubprocessStartForTest` seam lets us feed in a
  // synthetic set of paths — without it we could only exercise the
  // real `import.meta.url` / `process.argv[1]` resolution, and those
  // files are either tracked source (dangerous to touch) or the bun
  // binary itself (not ours to mutate).
  let tmpDir: string;
  let bundlePath: string;
  let entryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ra11y-stale-"));
    bundlePath = join(tmpDir, "fake-bundle.js");
    entryPath = join(tmpDir, "fake-entry.js");
    writeFileSync(bundlePath, "// initial bundle\n");
    writeFileSync(entryPath, "// initial entry\n");
    __resetSubprocessRecord();
  });

  afterEach(() => {
    __resetSubprocessRecord();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when the recorded paths are unchanged", () => {
    __recordSubprocessStartForTest([bundlePath, entryPath]);
    expect(isSubprocessStale()).toBe(false);
  });

  it("returns true when the bundle path's mtime advances after record", () => {
    // Dist-mode shape: the subprocess records its baseline, the user
    // runs `bun run build`, `dist/cli.js` gets rewritten with a later
    // mtime, and the next tool call must surface the stale warning.
    __recordSubprocessStartForTest([bundlePath, entryPath]);
    const future = new Date(Date.now() + 5000);
    utimesSync(bundlePath, future, future);
    expect(isSubprocessStale()).toBe(true);
  });

  it("returns true when the entry script's mtime advances — closes the source-mode miss", () => {
    // Source-mode shape: the subprocess was launched as `bun
    // src/cli.ts --mcp`, so `import.meta.url` resolves to
    // `src/mcp/stale-subprocess.ts` but `process.argv[1]` is
    // `src/cli.ts`. A rebuild (or a source edit to the entry script)
    // advances the entry-path mtime even when the module file is
    // untouched. Tracking both paths closes the silent miss.
    __recordSubprocessStartForTest([bundlePath, entryPath]);
    const future = new Date(Date.now() + 5000);
    utimesSync(entryPath, future, future);
    expect(isSubprocessStale()).toBe(true);
  });

  it("returns false when a recorded path becomes inaccessible but siblings stay stable", () => {
    // A missing path should not crash detection or flip to stale — the
    // file genuinely has no 'newer mtime' signal to offer. Sibling
    // entries still drive the decision.
    __recordSubprocessStartForTest([bundlePath, entryPath]);
    rmSync(bundlePath);
    expect(isSubprocessStale()).toBe(false);
  });

  it("returns true when a sibling path advances even if another recorded path became inaccessible", () => {
    __recordSubprocessStartForTest([bundlePath, entryPath]);
    rmSync(bundlePath);
    const future = new Date(Date.now() + 5000);
    utimesSync(entryPath, future, future);
    expect(isSubprocessStale()).toBe(true);
  });

  it("same-mtime is not stale — a snapshot at the moment of write does not self-trigger", () => {
    __recordSubprocessStartForTest([bundlePath, entryPath]);
    // Re-set the mtime to what it currently is. `>` comparison means
    // equal is not stale.
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const current = statSync(bundlePath).mtimeMs;
    const same = new Date(current);
    utimesSync(bundlePath, same, same);
    expect(isSubprocessStale()).toBe(false);
  });

  it("the test seam is also one-shot — repeated calls do not overwrite the baseline", () => {
    __recordSubprocessStartForTest([bundlePath]);
    const future = new Date(Date.now() + 5000);
    utimesSync(bundlePath, future, future);
    // If the second call overwrote the baseline to the new (advanced)
    // mtime, detection would silently flip back to "not stale" — the
    // exact silent-miss pattern the field report is about.
    __recordSubprocessStartForTest([bundlePath]);
    expect(isSubprocessStale()).toBe(true);
  });
});

describe("recordSubprocessStart resolves multiple candidate paths", () => {
  beforeEach(() => {
    __resetSubprocessRecord();
  });
  afterEach(() => {
    __resetSubprocessRecord();
  });

  it("records without throwing in a real process — `import.meta.url` + `process.argv[1]` both exist", () => {
    // Smoke test that the real resolution path works inside the bun
    // test runner. If either resolver throws, this would blow up.
    // Stale detection should be false immediately after record since
    // neither file's mtime has advanced.
    recordSubprocessStart();
    expect(isSubprocessStale()).toBe(false);
  });
});
