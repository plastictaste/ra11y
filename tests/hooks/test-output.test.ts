// Unit tests for the Stop hook's bun-test output interpreter. Two real
// regressions are the load-bearing cases here; behavior-rehearsal tests
// for the rest are intentionally absent (cf. CLAUDE.md §14).
//
// Regression 1: c6cdcba7 added a `(pass)` filter that read from `stdout`,
// but bun emits per-test progress lines (and the summary block) to
// `stderr`. Stdout carries only the version banner. So the original
// filter was a no-op and a real failing turn dumped ~8000 (pass) lines
// into the orchestrator's context. The "filters from stderr" case below
// pins the stream choice.
//
// Regression 2: when the MCP integration tests log `[ra11y error] MCP
// dispatch error: ...` during teardown, bun's exit code flips to non-zero
// even though every test passed. The hook then reported "bun test
// failed" with the full filtered output, even on the green-tests run.
// The "passes-when-summary-zero-fail-despite-nonzero-exit" case below
// pins parsing the summary as the authoritative signal, with the exit
// code as fallback only when the summary is absent.

import { describe, expect, test } from "bun:test";
import { interpretTestRun, stripPassLines } from "../../.claude/hooks/lib/test-output.ts";

describe("stripPassLines", () => {
  test("drops `(pass)` lines, keeps everything else", () => {
    const input = [
      "tests/foo.test.ts:",
      "(pass) does the thing [1.23ms]",
      "(pass) does another thing [0.5ms]",
      "(fail) the failing one [0.27ms]",
      "",
      " 100 pass",
      " 1 fail",
    ].join("\n");
    const out = stripPassLines(input);
    expect(out).not.toContain("(pass)");
    expect(out).toContain("(fail) the failing one");
    expect(out).toContain("tests/foo.test.ts:");
    expect(out).toContain(" 1 fail");
  });

  test("only matches at line start — `(pass)` mid-line stays", () => {
    const input = "error: expected (pass) marker";
    expect(stripPassLines(input)).toBe(input);
  });
});

describe("interpretTestRun — regression 2: success-with-nonzero-exit", () => {
  test("treats a run with `0 fail` summary as passed even when exit is non-zero", () => {
    // Reproduces the observed bug: every test passed, but a teardown-time
    // log line flipped the exit code. The summary is the authority.
    const stderr = [
      "",
      " 8712 pass",
      " 0 fail",
      " 21345 expect() calls",
      "Ran 8712 tests across 412 files. [42.18s]",
      "[ra11y error] MCP dispatch error: stream closed",
    ].join("\n");
    const verdict = interpretTestRun({ status: 1, stdout: "bun test v1.3.11", stderr });
    expect(verdict.failed).toBe(false);
    expect(verdict.reason).toBe("passed-summary-zero-fail");
    expect(verdict.output).toBe("");
  });

  test("treats a run with `N fail` summary as failed (N > 0)", () => {
    const stderr = [
      "",
      "tests/foo.test.ts:",
      "(fail) the failing one [0.27ms]",
      "",
      " 8711 pass",
      " 1 fail",
      " 21344 expect() calls",
    ].join("\n");
    const verdict = interpretTestRun({ status: 1, stdout: "bun test v1.3.11", stderr });
    expect(verdict.failed).toBe(true);
    expect(verdict.reason).toBe("fail-count-nonzero");
    expect(verdict.output).toContain("(fail) the failing one");
    expect(verdict.output).toContain(" 1 fail");
  });

  test("falls back to exit code when no summary line is present", () => {
    // True crash before any test ran (e.g. tsc parse error in a test file).
    const stderr = "ReferenceError: foo is not defined\n  at <anonymous>";
    const verdict = interpretTestRun({ status: 1, stdout: "bun test v1.3.11", stderr });
    expect(verdict.failed).toBe(true);
    expect(verdict.reason).toBe("no-summary-nonzero-exit");
    expect(verdict.output).toContain("ReferenceError");
  });

  test("treats no-summary + zero exit as success (e.g. no matching tests)", () => {
    const stderr = "The following filters did not match any test files...";
    const verdict = interpretTestRun({ status: 0, stdout: "bun test v1.3.11", stderr });
    expect(verdict.failed).toBe(false);
    expect(verdict.reason).toBe("passed-no-summary-zero-exit");
  });
});

describe("interpretTestRun — regression 1: stderr filtering", () => {
  test("strips `(pass)` lines from stderr (where bun actually emits them)", () => {
    // Bun emits per-test markers and the summary to stderr; stdout carries
    // only the version banner. Stuff a fail in there to force the failure
    // path so we can inspect the surfaced output.
    const stderr = [
      "tests/foo.test.ts:",
      ...Array.from({ length: 50 }, (_, i) => `(pass) test ${i} [0.3ms]`),
      "(fail) the failing one [0.27ms]",
      "",
      " 50 pass",
      " 1 fail",
    ].join("\n");
    const verdict = interpretTestRun({ status: 1, stdout: "bun test v1.3.11", stderr });
    expect(verdict.failed).toBe(true);
    expect(verdict.output).not.toContain("(pass)");
    expect(verdict.output).toContain("(fail) the failing one");
    // 50 pass lines stripped; the surviving output is short enough to fit
    // the bounded hook channel.
    const lineCount = verdict.output.split("\n").length;
    expect(lineCount).toBeLessThan(15);
  });

  test("strips `(pass)` lines from stdout too (defensive — covers any bun version that splits differently)", () => {
    const stdout = ["bun test v1.3.11", "(pass) a [0.3ms]", "(pass) b [0.3ms]"].join("\n");
    const stderr = [" 100 pass", " 1 fail", "(fail) bad [0.1ms]"].join("\n");
    const verdict = interpretTestRun({ status: 1, stdout, stderr });
    expect(verdict.failed).toBe(true);
    expect(verdict.output).not.toContain("(pass)");
    expect(verdict.output).toContain("(fail) bad");
  });
});
