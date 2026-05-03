# ADR 0029 — MCP subprocess flake root cause

- Status: Accepted
- Date: 2026-05-02
- Supersedes: none
- Superseded by: none
- Related: `tests/unit/mcp/outbound.test.ts`, `src/mcp/outbound.ts`, `.claude/backlog.md` (V1-MCP-SUBPROCESS-FLAKE-INVESTIGATE, V1-MCP-SUBPROCESS-TEST-DEFLAKE)

## Context

`bun run verify` flaked intermittently with `<method> request timed out after 10000ms` thrown from `src/mcp/outbound.ts:56`. The failure clustered around a small set of MCP integration tests (`mcp-sampling`, `mcp-roots`, `mcp-protocol`, `mcp-consistency/scan-time-warnings-cross-surface`, `mcp-consistency/coverage-checklist-consistency`), and reproduced under load — single-worktree full-verify hit it; 3-worktree concurrent verify hit it nearly every time. The 2026-05-02 stop-hook failure attributed the timeout to `coverage-checklist-consistency.test.ts` *despite* that test running in 212 ms — a 10-second timeout cannot fire inside a 212 ms test window. The attribution had to be wrong; some other source was emitting the timeout.

The `V1-MCP-SUBPROCESS-FLAKE-INVESTIGATE` backlog item proposed four falsifiable hypotheses: (1) handler-registration race, (2) teardown not awaiting pending outbound requests, (3) shared module-scope subprocess across parallel workers, (4) bun stdio-buffering latency under load. None of them quite fit — the failing tests were a mix of in-process harness (`startMcpHarness`) and real-subprocess (`Bun.spawn`); a registration race would not produce a 10000 ms-literal timeout (default sampling timeout is 60 000 ms); and the failure's per-test attribution was inconsistent across runs.

## Investigation

A grep for `\b10_000\b|\b10000\b` against `tests/` and `src/` against the timeout-call surface narrowed the source to a single literal:

```ts
// tests/unit/mcp/outbound.test.ts:41-42
void rail.sendRequest("sampling/createMessage", { a: 1 }, 10_000);
void rail.sendRequest("roots/list", null, 10_000);
```

The test asserts that the JSON-RPC bytes were written, then returns. Both `sendRequest` promises are discarded via `void`, so:

- Each call schedules a `setTimeout(..., 10_000)` inside `createOutbound`.
- Neither pending entry is ever resolved or rejected by routing a response.
- 10 seconds later, the timer fires, `pending.delete(id)`, and `reject(new Error("<method> request timed out after 10000ms"))` runs.
- Because the promises were `void`-discarded, the rejection has no `.catch` handler attached — it surfaces as an `unhandledRejection` on the test process.

Reproduction (proof-script):

```ts
import { createOutbound } from "/Users/van/dev/ra11y/src/mcp/outbound.ts";
let unhandled = 0;
process.on("unhandledRejection", (r) => { unhandled++; console.log(`unhandled: ${(r as Error).message}`); });
const rail = createOutbound(() => {}, () => {});
void rail.sendRequest("sampling/createMessage", { a: 1 }, 200);
void rail.sendRequest("roots/list", null, 200);
await new Promise((r) => setTimeout(r, 400));
console.log(`unhandled count: ${unhandled}`);
// → "unhandled rejection: sampling/createMessage request timed out after 200ms"
// → "unhandled rejection: roots/list request timed out after 200ms"
// → "unhandled count: 2"
```

That confirms the orphan mechanism in isolation. In the full test run, `tests/unit/mcp/outbound.test.ts` runs near the start of the suite. The two orphan timers fire 10 seconds later, mid-suite. Bun's test runner hooks `process.on("unhandledRejection", ...)` and attributes the rejection to whichever test is *currently* `in_progress` when the rejection finalizes, then bails out. The "current test" is non-deterministic — it depends on test execution order and per-test wall time. Under load, slower tests are likelier victims, which matches the observed clustering on the 5 MCP-integration tests (each spawning subprocesses, all longer than the typical ~10–100 ms unit test).

Hypothesis (e) from the backlog item — "the bun output sometimes shows the timeout as an 'unhandled error between tests' with no failed test attached, suggesting the request fires from a previous test and times out into a later test's window" — was the closest to the actual mechanism. The refinement: the orphan source is not a test that "fires a request" in the production sense; it is a unit test that exercises `sendRequest`'s wire-format with literal `10_000` ms timeouts and discards the promise.

## Decision

The deflake is the source-level fix V1-MCP-SUBPROCESS-TEST-DEFLAKE specified, but with a tighter scope than any of the three closure paths it proposed (sequential subprocess pool, raise per-test timeout, split MCP tests into a serial bun invocation). All three would have masked the symptom without fixing the orphan; none of them apply to a unit test that doesn't spawn a subprocess at all.

The fix lives in `tests/unit/mcp/outbound.test.ts`: clear the pending timers before the test returns, by routing synthetic responses for the two ids the test issued. This costs two `tryRouteResponse` calls + one `await Promise.all([...])` per test case.

This is a one-test fix — no harness changes, no production code changes, no per-test-timeout increases, no serial split. The lock-out on `.claude/skills/continue/SKILL.md` for `verify_flaky_mcp_subprocess` lifts once the fix lands and `bun run verify` is green under 3-worktree concurrent reproduction.

## Why this hid for so long

- The failure's per-test attribution was inconsistent across runs, which made the symptom look like a transport / subprocess problem rather than a unit-test bookkeeping problem. The 4 hypotheses in V1-MCP-SUBPROCESS-FLAKE-INVESTIGATE all framed the bug as a transport race; the actual bug is in test code that doesn't touch the transport at all.
- `bun test tests/unit/mcp/outbound.test.ts` in isolation passes in ~93 ms. The orphan timers fire 10 s later, but the bun process exits before then because there are no further tests to keep it alive. The bug only surfaces when other tests are still running 10 s after this file completes — i.e. in the full suite or in concurrent verify.
- The failure looked like an MCP / sampling problem because the error string came from the MCP outbound rail. The error's true caller was a unit test in `tests/unit/mcp/`, not any of the integration tests that bun blamed.

## Recommendation

Close `V1-MCP-SUBPROCESS-FLAKE-INVESTIGATE` with a pointer to this ADR. Close `V1-MCP-SUBPROCESS-TEST-DEFLAKE` once the one-test fix lands and `bun run verify` passes under 3-worktree concurrent reproduction. Drop `V1-VERIFY-PRECOMMIT-FAST-FOR-SPECIALIST` — its premise (a permanent flake we work around) no longer holds; with the orphan eliminated, full verify is the right specialist gate.
