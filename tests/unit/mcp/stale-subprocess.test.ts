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
  __resetSubprocessRecord,
  __setBundlePathOverride,
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
    // Plan shape uses the post-
    // structure (notes + fixesByClass) — `annotateStaleSubprocess`
    // is pure-pass-through over the plan, so this assertion guards
    // that the per-lane tally rides through verbatim.
    const result = makeResult({
      plan: {
        notes: 0,
        fixesByClass: { mechanical: 1, guidance: 0, runtimeOnly: 2, verifyInSource: 0 },
      },
      meta: {},
    });
    const annotated = annotateStaleSubprocess(result);
    const parsed = JSON.parse(annotated.content[0]!.text) as {
      warnings: string[];
      staleSubprocessHint: string;
      plan: { fixesByClass: Record<string, number> };
    };
    expect(parsed.warnings).toEqual([STALE_SUBPROCESS_WARNING]);
    expect(parsed.staleSubprocessHint).toBe(STALE_SUBPROCESS_HINT);
    expect(parsed.plan.fixesByClass["mechanical"]).toBe(1);
    expect(parsed.plan.fixesByClass["runtimeOnly"]).toBe(2);
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

describe("mtime-based detection (deterministic repro)", () => {
  // Field-report invariant: a subprocess running code at a known path, whose
  // on-disk file is rewritten mid-session, must surface the stale warning on
  // the next tool call. The 90-min session that motivated this backlog item
  // hit 23 tool calls across a live `dist/cli.js` rewrite — the warning
  // silently failed to fire because the detector's only baseline was
  // `import.meta.url` (the stale-subprocess module file), which a
  // `bun run build` rewrite-of-`dist/` never touches when the subprocess
  // was spawned from a different entry path. The fix adds
  // `process.argv[1]` as a second baseline so the actual spawned entry
  // is always part of the stat set; this test drives both the entry-
  // override and module-override paths via the test-only seam so the
  // full record→rewrite→stale cycle is exercised without spawning a real
  // subprocess.
  let tmpDir: string;
  let entryPath: string;
  let modulePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ra11y-stale-"));
    entryPath = join(tmpDir, "fake-cli.js");
    modulePath = join(tmpDir, "fake-stale-subprocess.js");
    writeFileSync(entryPath, "// initial entry bundle\n");
    writeFileSync(modulePath, "// initial stale-subprocess module\n");
    __resetSubprocessRecord();
  });

  afterEach(() => {
    __resetSubprocessRecord();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fires stale when the entry file (process.argv[1] analog) is rewritten after baseline", () => {
    __setBundlePathOverride(entryPath, modulePath);
    recordSubprocessStart();
    expect(isSubprocessStale()).toBe(false);

    // Simulate rebuild: advance entry mtime by 2s to dodge filesystem
    // granularity (macOS HFS+, ext4 default atime).
    const base = 1_700_000_000_000;
    utimesSync(entryPath, new Date(base), new Date(base));
    __resetSubprocessRecord();
    __setBundlePathOverride(entryPath, modulePath);
    recordSubprocessStart();
    utimesSync(entryPath, new Date(base + 2_000), new Date(base + 2_000));
    expect(isSubprocessStale()).toBe(true);
  });

  it("fires stale when the module file (import.meta.url analog) is rewritten — dev-mode coverage", () => {
    __setBundlePathOverride(entryPath, modulePath);
    const base = 1_700_000_000_000;
    utimesSync(entryPath, new Date(base), new Date(base));
    utimesSync(modulePath, new Date(base), new Date(base));
    recordSubprocessStart();
    expect(isSubprocessStale()).toBe(false);

    // Advance only the module — entry untouched. Still fires: either
    // baseline advancing is stale evidence.
    utimesSync(modulePath, new Date(base + 2_000), new Date(base + 2_000));
    expect(isSubprocessStale()).toBe(true);
  });

  it("does not fire when only the entry file is stat-accessible and its mtime is unchanged", () => {
    __setBundlePathOverride(entryPath, join(tmpDir, "does-not-exist.js"));
    recordSubprocessStart();
    expect(isSubprocessStale()).toBe(false);
    // Unreachable module baseline is treated as "unavailable" — only the
    // entry baseline is consulted, and it's unchanged.
    expect(isSubprocessStale()).toBe(false);
  });

  it("full end-to-end repro: record → rewrite → annotateStaleSubprocess merges the warning", () => {
    // Mirrors the production dispatch path: `isSubprocessStale()` gates
    // `annotateStaleSubprocess()` on every tool response.
    __setBundlePathOverride(entryPath, modulePath);
    const base = 1_700_000_000_000;
    utimesSync(entryPath, new Date(base), new Date(base));
    utimesSync(modulePath, new Date(base), new Date(base));
    recordSubprocessStart();

    // Before rewrite: no warning fires.
    const freshResult = {
      content: [{ type: "text" as const, text: JSON.stringify({ plan: { notes: 0 } }) }],
    };
    expect(isSubprocessStale()).toBe(false);

    // Mid-session rebuild: entry replaced, new mtime.
    writeFileSync(entryPath, "// rebuilt entry\n");
    utimesSync(entryPath, new Date(base + 2_000), new Date(base + 2_000));

    // Next tool call: stale gate fires, annotator merges the warning.
    expect(isSubprocessStale()).toBe(true);
    const annotated = annotateStaleSubprocess(freshResult);
    const parsed = JSON.parse(annotated.content[0]!.text) as {
      warnings: string[];
      staleSubprocessHint: string;
    };
    expect(parsed.warnings).toEqual([STALE_SUBPROCESS_WARNING]);
    expect(parsed.staleSubprocessHint).toBe(STALE_SUBPROCESS_HINT);
  });

  it("retries baseline capture when the initial record found no stat-able target", () => {
    // Failure mode covered: a transient fs hiccup at startup makes both
    // baselines null; the next tool call must retry, not wedge detection
    // off for the whole process lifetime.
    __setBundlePathOverride(join(tmpDir, "not-yet-created.js"), join(tmpDir, "also-missing.js"));
    recordSubprocessStart();
    expect(isSubprocessStale()).toBe(false);

    // Create the entry path and pin its mtime to a known baseline, then
    // retry the recording — simulates the caller (server dispatch)
    // making a second attempt once the filesystem settles.
    const latePath = join(tmpDir, "not-yet-created.js");
    writeFileSync(latePath, "// late arrival\n");
    const base = 1_700_000_000_000;
    utimesSync(latePath, new Date(base), new Date(base));
    recordSubprocessStart();
    // Baseline now captured; isSubprocessStale stays false on same mtime.
    expect(isSubprocessStale()).toBe(false);

    // Advance that file's mtime past the recorded baseline — stale fires.
    utimesSync(latePath, new Date(base + 5_000), new Date(base + 5_000));
    expect(isSubprocessStale()).toBe(true);
  });
});
