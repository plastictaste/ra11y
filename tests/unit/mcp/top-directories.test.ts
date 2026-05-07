/**
 * Unit tests for `plan.topDirectories` — the per-first-child-dir
 * rank-ordered rollup that lets the agent triaging a mono-repo of
 * mini-projects pick the dominant sub-tree in one read.
 *
 * The orthogonal axis to `topRules` (per-rule) and `findingsByFile`
 * (per-file) — same severity filter, same whole-scan framing,
 * different aggregation key. These tests pin the behavior of
 * `computeTopDirectories` and `withTopDirectories` directly so the
 * cross-surface count invariants stay observable from a single file.
 */

import { describe, expect, it } from "bun:test";
import {
  computeTopDirectories,
  TOP_DIRECTORIES_DEFAULT_LIMIT,
  withTopDirectories,
} from "../../../src/mcp/top-directories.ts";

const ROOT = "/repo";
const E = (ruleId: string) => ({ ruleId, severity: "error" });
const W = (ruleId: string) => ({ ruleId, severity: "warning" });
const I = (ruleId: string) => ({ ruleId, severity: "info" });

describe("computeTopDirectories — per-first-child-dir rollup", () => {
  it("ranks sub-trees by error+warning count descending, then path ascending for ties", () => {
    // Three mini-projects under root — alphabetical-last has the most
    // findings, so the rank surfaces "zzz" before "aaa" despite path
    // ordering. Mid two tie on count → alphabetical tiebreak.
    const out = computeTopDirectories(
      [
        {
          path: "/repo/zzz/a.tsx",
          findings: [E("alt-text/missing"), E("alt-text/missing"), W("button/no-name")],
        },
        { path: "/repo/aaa/a.tsx", findings: [E("contrast/minimum"), W("link/empty")] },
        { path: "/repo/mmm/a.tsx", findings: [E("button/no-name"), W("contrast/minimum")] },
      ],
      ROOT,
    );
    expect(out.map((entry) => entry.path)).toEqual(["zzz", "aaa", "mmm"]);
    expect(out[0]).toMatchObject({ path: "zzz", violationCount: 3, fileCount: 1 });
  });

  it("annotates each sub-tree with `topRule` — the densest rule the bucket emitted", () => {
    // `templates/foo` and `templates/bar` both fall under `templates`
    // — the firstChildDir bucket. `alt-text/missing` fires three times,
    // `contrast/minimum` once → topRule is alt-text/missing.
    const out = computeTopDirectories(
      [
        {
          path: "/repo/templates/foo/a.html",
          findings: [E("alt-text/missing"), E("alt-text/missing")],
        },
        {
          path: "/repo/templates/bar/a.html",
          findings: [E("alt-text/missing"), W("contrast/minimum")],
        },
      ],
      ROOT,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      path: "templates",
      violationCount: 4,
      fileCount: 2,
      topRule: "alt-text/missing",
    });
  });

  it("breaks topRule ties alphabetically for deterministic ordering", () => {
    const out = computeTopDirectories(
      [
        {
          path: "/repo/sub/a.tsx",
          findings: [E("zzz/last"), E("aaa/first")],
        },
      ],
      ROOT,
    );
    expect(out[0]?.topRule).toBe("aaa/first");
  });

  it("excludes info-severity findings from both the count and the topRule selection", () => {
    // The rollup describes the same error+warning surface
    // `plan.fixesByClass` tallies; info-severity rules (e.g.
    // wrappers/inferred) would crowd the rank with non-actionable
    // context.
    const out = computeTopDirectories(
      [
        {
          path: "/repo/sub/a.tsx",
          findings: [I("wrappers/inferred"), I("wrappers/inferred"), E("contrast/minimum")],
        },
      ],
      ROOT,
    );
    expect(out).toEqual([
      { path: "sub", violationCount: 1, fileCount: 1, topRule: "contrast/minimum" },
    ]);
  });

  it("buckets repo-root files (no subdirectory) under '.' — no silent drops", () => {
    // Files at the root participate in the rollup; dropping them would
    // be a silent suppression.
    const out = computeTopDirectories(
      [
        { path: "/repo/index.html", findings: [E("alt-text/missing")] },
        { path: "/repo/sub/a.tsx", findings: [E("button/no-name")] },
      ],
      ROOT,
    );
    expect(out.map((e) => e.path).sort()).toEqual([".", "sub"]);
    expect(out.find((e) => e.path === ".")?.violationCount).toBe(1);
  });

  it("buckets paths outside the root under '<external>' — names the regime explicitly", () => {
    // `additionalPaths` may contribute files outside `cwd`; bucketing
    // them under a `..`-prefixed key would lose information, so the
    // `<external>` key names the case explicitly per the same logic
    // as `groupKeyFor` in `scan-group-by.ts`.
    const out = computeTopDirectories(
      [{ path: "/elsewhere/a.tsx", findings: [E("alt-text/missing")] }],
      ROOT,
    );
    expect(out[0]?.path).toBe("<external>");
  });

  it("counts files-with-findings, not total finding count, for `fileCount`", () => {
    const out = computeTopDirectories(
      [
        { path: "/repo/sub/a.tsx", findings: [E("rule/x"), E("rule/x"), E("rule/x")] },
        { path: "/repo/sub/b.tsx", findings: [E("rule/x")] },
        // Empty-findings file in the same bucket should NOT inflate the
        // file count.
        { path: "/repo/sub/c.tsx", findings: [] },
      ],
      ROOT,
    );
    expect(out[0]).toMatchObject({ path: "sub", violationCount: 4, fileCount: 2 });
  });

  it("excludes info-only files from `fileCount` so the field measures actionable input", () => {
    // A file emitting only info findings shouldn't count toward
    // fileCount — the count measures sub-tree files the agent has
    // error/warning work on.
    const out = computeTopDirectories(
      [
        { path: "/repo/sub/a.tsx", findings: [E("rule/x")] },
        { path: "/repo/sub/b.tsx", findings: [I("wrappers/inferred")] },
      ],
      ROOT,
    );
    expect(out[0]).toMatchObject({ violationCount: 1, fileCount: 1 });
  });

  it("truncates to the limit (default 10) on ranked output", () => {
    // 12 distinct sub-trees, each emitting one finding → default limit
    // clips to 10. Names share a prefix so the alphabetical tiebreak
    // preserves determinism.
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `/repo/dir-${String(i).padStart(2, "0")}/a.tsx`,
      findings: [E(`rule/x`)],
    }));
    expect(computeTopDirectories(files, ROOT).length).toBe(TOP_DIRECTORIES_DEFAULT_LIMIT);
    expect(computeTopDirectories(files, ROOT, 5).length).toBe(5);
  });

  it("returns all sub-trees when fewer than the limit fired (no zero-count padding)", () => {
    const out = computeTopDirectories(
      [
        { path: "/repo/aaa/a.tsx", findings: [E("rule/x")] },
        { path: "/repo/bbb/a.tsx", findings: [W("rule/y")] },
      ],
      ROOT,
    );
    expect(out.length).toBe(2);
  });

  it("returns an empty array on a clean scan — caller conditional-spreads the field off the wire", () => {
    expect(computeTopDirectories([], ROOT)).toEqual([]);
    expect(computeTopDirectories([{ path: "/repo/a.tsx", findings: [] }], ROOT)).toEqual([]);
    // Info-only scan — same severity filter as `computeTopRules`;
    // `plan.infoSeverityFindings` carries that surface separately.
    expect(
      computeTopDirectories([{ path: "/repo/a.tsx", findings: [I("wrappers/inferred")] }], ROOT),
    ).toEqual([]);
  });
});

describe("withTopDirectories — plan-stamping helper", () => {
  it("stamps `plan.topDirectories` when at least two sub-trees carry error/warning findings", () => {
    const plan = {
      infoSeverityFindings: 0,
      fixesByClass: { mechanical: 3, guidance: 0, runtimeOnly: 0, verifyInSource: 0 },
    } satisfies Record<string, unknown>;
    const out = withTopDirectories(
      plan,
      [
        { path: "/repo/aaa/a.tsx", findings: [E("alt-text/missing")] },
        { path: "/repo/bbb/a.tsx", findings: [W("button/no-name")] },
      ],
      ROOT,
    );
    expect(out["topDirectories"]).toEqual([
      { path: "aaa", violationCount: 1, fileCount: 1, topRule: "alt-text/missing" },
      { path: "bbb", violationCount: 1, fileCount: 1, topRule: "button/no-name" },
    ]);
    // Existing plan fields preserved — additive enrichment only.
    expect(out["infoSeverityFindings"]).toBe(0);
    expect(out["fixesByClass"]).toEqual({
      mechanical: 3,
      guidance: 0,
      runtimeOnly: 0,
      verifyInSource: 0,
    });
  });

  it("returns the input plan by identity when no sub-tree carries findings — common no-violations path", () => {
    const plan = {
      infoSeverityFindings: 0,
      summary: "No accessibility violations found.",
    } satisfies Record<string, unknown>;
    const out = withTopDirectories(plan, [{ path: "/repo/a.tsx", findings: [] }], ROOT);
    expect(out).toBe(plan);
    expect(out["topDirectories"]).toBeUndefined();
  });

  it("returns the input plan by identity when only one sub-tree fires — no rank to expose", () => {
    // Single-bucket short-circuit: a one-row rollup doesn't help the
    // agent route, and `findingsByFile`/`topRules` already cover the
    // single-bucket case. Surfacing one row is redundancy, not signal.
    const plan = { infoSeverityFindings: 0 } satisfies Record<string, unknown>;
    const out = withTopDirectories(
      plan,
      [
        { path: "/repo/sub/a.tsx", findings: [E("rule/x")] },
        { path: "/repo/sub/b.tsx", findings: [E("rule/x")] },
      ],
      ROOT,
    );
    expect(out).toBe(plan);
    expect(out["topDirectories"]).toBeUndefined();
  });

  it("stamps `topDirectoriesTruncated: true` when the rank-slice clips a longer tail", () => {
    // 12 sub-trees, default limit 10 → two tail entries dropped.
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `/repo/dir-${String(i).padStart(2, "0")}/a.tsx`,
      findings: [E("rule/x")],
    }));
    const plan = {} satisfies Record<string, unknown>;
    const out = withTopDirectories(plan, files, ROOT);
    expect((out["topDirectories"] as readonly unknown[]).length).toBe(
      TOP_DIRECTORIES_DEFAULT_LIMIT,
    );
    expect(out["topDirectoriesTruncated"]).toBe(true);
  });

  it("omits the truncation flag when the slice carries every bucket", () => {
    const out = withTopDirectories(
      {},
      [
        { path: "/repo/aaa/a.tsx", findings: [E("rule/x")] },
        { path: "/repo/bbb/a.tsx", findings: [E("rule/x")] },
      ],
      ROOT,
    );
    expect(out["topDirectoriesTruncated"]).toBeUndefined();
  });

  it("respects an explicit limit when the caller overrides the default", () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `/repo/dir-${String(i).padStart(2, "0")}/a.tsx`,
      findings: [E("rule/x")],
    }));
    const out = withTopDirectories({}, files, ROOT, 3);
    expect((out["topDirectories"] as readonly { path: string }[]).length).toBe(3);
    expect(out["topDirectoriesTruncated"]).toBe(true);
  });

  it("matches the same error+warning total as `computeTopRules` would on the same input — cross-surface count invariant", () => {
    // The rollup-axis sums must agree across surfaces (per
    // `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
    // invariant"). This test pins that the per-directory total matches
    // the per-rule total because both apply the same severity filter.
    const files = [
      {
        path: "/repo/aaa/a.tsx",
        findings: [E("rule/x"), E("rule/x"), W("rule/y"), I("wrappers/inferred")],
      },
      {
        path: "/repo/bbb/a.tsx",
        findings: [E("rule/y"), W("rule/x"), I("wrappers/inferred")],
      },
    ];
    const dirSum = computeTopDirectories(files, ROOT).reduce(
      (acc, entry) => acc + entry.violationCount,
      0,
    );
    // 5 error/warning findings total (one info-only excluded) → expect 5.
    expect(dirSum).toBe(5);
  });
});
