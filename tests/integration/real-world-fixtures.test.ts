/**
 * Real-world fixture harness — one `it(...)` per fixture directory.
 *
 * Walks `tests/fixtures/real-world/` at module-load time so each
 * fixture is a separately-reported bun:test case. Adding a new
 * fixture requires no change to this file: drop a subdirectory with
 * `source/` + `assertions.ts` and it is discovered on the next run.
 *
 * Design notes live in `docs/adr/0006-real-world-fixture-harness.md`.
 * The assertion primitives (`FixtureExpectation`) are evaluated in
 * `tests/fixtures/real-world/runner.ts`; this file's only job is to
 * drive the harness and turn per-expectation results into test-
 * framework assertions with fixture-scoped messages.
 *
 * Fixtures with `assertions.todo === true` are intentionally RED —
 * they capture a known bug before the upstream `src/` fix lands. The
 * test body returns early so CI is not blocked; the fixture remains
 * in the discovery set as a sentinel reminding contributors that the
 * fix is pending. Remove `todo` once the fix lands.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  discoverFixtures,
  evaluateExpectations,
  loadAndScanFixture,
  loadAssertions,
} from "../fixtures/real-world/runner.ts";

const REAL_WORLD_ROOT = join(import.meta.dir, "..", "fixtures", "real-world");

const fixtures = discoverFixtures(REAL_WORLD_ROOT);

describe("real-world fixtures", () => {
  it("discovers at least one fixture (guard against regressions that silently empty the harness)", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(fixture.id, async () => {
      const assertions = await loadAssertions(fixture);

      // Fixtures marked `todo: true` capture a known bug before the
      // upstream `src/` fix lands. Return early so CI is not blocked;
      // the pending fix's commit will remove `todo` and turn the test
      // green permanently. `it.todo()` cannot be called inside an
      // already-running `it()` in bun:test, so early-return is the
      // mechanism here.
      if (assertions.todo === true) return;

      const ctx = await loadAndScanFixture(fixture, assertions.toolInput ?? {});
      const results = evaluateExpectations(ctx, assertions.expectations);

      const failures = results.filter((r) => !r.pass);
      if (failures.length > 0) {
        // One combined message so the test runner prints every
        // failing predicate in one block — ADR §"Harness architecture"
        // explicitly calls for "fixture + failing predicate", never
        // "expected 0 to be 1".
        const joined = failures.map((f) => `  - ${f.message}`).join("\n");
        throw new Error(
          `real-world/${fixture.id}: ${failures.length} of ${results.length} expectation(s) failed:\n${joined}`,
        );
      }

      // Sanity: the harness must have evaluated every expectation the
      // fixture declared. Evaluator skipping silently is the silent-
      // miss failure mode this harness is built to prevent.
      expect(results.length).toBe(assertions.expectations.length);
    });
  }
});
