// Helpers for interpreting `bun test` output inside the Stop hook.
//
// Two responsibilities, both load-bearing:
//
// 1. Strip `(pass)` lines from the captured output. `bun test` prints one
//    line per passing test by default, which floods the bounded
//    hook-feedback channel (~5000–8000 lines on a full suite). The
//    pass-line stream is `stderr`, not stdout — bun writes its progress
//    summary, fail markers, and pass markers to stderr; stdout carries
//    only the version banner. Filtering only stdout (the original c6cdcba7
//    patch) was a no-op because there are no `(pass)` lines to drop there.
//
// 2. Decide whether the run actually failed, independent of the spawn
//    exit code. The MCP integration tests occasionally emit informational
//    `[ra11y error] MCP dispatch error: ...` log lines during teardown
//    that flip the spawn's exit code to non-zero even when every test
//    passed. Trusting `child.status !== 0` alone misclassifies those
//    runs as failures and dumps the entire (filtered) output back to the
//    user. The bun summary line (`N pass\n N fail\n …`) is the
//    authoritative signal — if we can find it and it shows zero failures,
//    the run succeeded regardless of the exit code.
//
// Pure functions; no I/O, no spawn, no globals. Easy to unit-test against
// fixture strings.

const PASS_LINE = /^\(pass\)/;
// Bun summary lines look like ` 8712 pass` / ` 0 fail`. Lead with optional
// whitespace; require an integer; accept either a literal `pass`/`fail` token.
const FAIL_COUNT = /^\s*(\d+)\s+fail\b/m;
const PASS_COUNT = /^\s*(\d+)\s+pass\b/m;

export interface TestRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface TestVerdict {
  failed: boolean;
  // Combined, `(pass)`-stripped output suitable for echoing back when failed.
  // Empty string when the run passed (caller doesn't echo on success).
  output: string;
  // Why we decided what we decided — useful in audit entries.
  reason:
    | "fail-count-nonzero" // summary said "N fail" with N > 0
    | "no-summary-nonzero-exit" // missing summary AND non-zero exit (true crash)
    | "passed-summary-zero-fail" // summary said "0 fail"
    | "passed-no-summary-zero-exit"; // unusual but harmless: 0 exit, no summary parsed
}

/**
 * Drop `(pass)` lines from a captured stream. Bun prints these for every
 * passing test on the slow-test path; over a full suite the count crosses
 * the hook-feedback budget. Other lines (file headers, fail markers, error
 * stacks, summary block) are preserved verbatim.
 */
export function stripPassLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !PASS_LINE.test(line))
    .join("\n");
}

/**
 * Decide whether a `bun test` invocation actually failed and produce the
 * `(pass)`-stripped output to echo back when it did.
 *
 * Decision precedence (most authoritative first):
 *   1. Parse the `N fail` line from the combined output.
 *      - Found and N > 0 → failed.
 *      - Found and N === 0 → passed (even if exit code is non-zero;
 *        transient teardown noise shouldn't shadow the test result).
 *   2. Summary line absent AND exit code non-zero → failed (true crash —
 *      e.g. tsc parse error before tests could run).
 *   3. Otherwise → passed.
 */
export function interpretTestRun(run: TestRun): TestVerdict {
  const filteredStdout = stripPassLines(run.stdout ?? "").trim();
  const filteredStderr = stripPassLines(run.stderr ?? "").trim();
  const combined = `${filteredStdout}\n${filteredStderr}`.trim();

  const failMatch = combined.match(FAIL_COUNT);
  if (failMatch) {
    const failCount = Number(failMatch[1]);
    if (failCount > 0) {
      return { failed: true, output: combined, reason: "fail-count-nonzero" };
    }
    return { failed: false, output: "", reason: "passed-summary-zero-fail" };
  }

  // No bun summary at all — could mean tsc/parse died before any test ran,
  // or the test runner crashed mid-run. If exit was non-zero, treat as
  // failure. If exit was zero, the run was effectively a no-op (e.g. no
  // matching test files); don't surface anything.
  if (run.status !== 0) {
    return { failed: true, output: combined, reason: "no-summary-nonzero-exit" };
  }

  // Sanity: passing run with zero exit but no summary parsed (can happen
  // when bun decides "no tests" and prints a different banner). Treat as
  // success.
  return { failed: false, output: "", reason: "passed-no-summary-zero-exit" };
}

// Exposed for tests so the regex stay in one place.
export const _internals = { PASS_LINE, FAIL_COUNT, PASS_COUNT };
