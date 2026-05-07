/**
 * Unit tests for `src/mcp/scan-group-by.ts` — the `plan.byGroup` rollup
 * for bulk-template repos with N parallel sub-project subdirectories.
 *
 * Doctrine: `groupBy: "firstChildDir"` is the high-leverage shape; one
 * whole-tree scan answers the per-sub-project question without N round-
 * trips of `additionalPaths`. The flat `files[]` list still ships
 * (surface, don't suppress); this helper produces the additive
 * aggregator only.
 */

import { describe, expect, it } from "bun:test";
import {
  type ByGroupEntry,
  computeByGroup,
  groupKeyFor,
  readGroupByParam,
  withByGroup,
} from "../../../src/mcp/scan-group-by.ts";

const E = (ruleId: string, criterionIds: readonly string[] = []) => ({
  ruleId,
  severity: "error",
  criterionIds,
});
const W = (ruleId: string, criterionIds: readonly string[] = []) => ({
  ruleId,
  severity: "warning",
  criterionIds,
});
const I = (ruleId: string, criterionIds: readonly string[] = []) => ({
  ruleId,
  severity: "info",
  criterionIds,
});

describe("readGroupByParam — schema validation at the tool seam", () => {
  it("returns the value for the three supported strategies", () => {
    expect(readGroupByParam("firstChildDir")).toBe("firstChildDir");
    expect(readGroupByParam("directory")).toBe("directory");
    expect(readGroupByParam("extension")).toBe("extension");
  });

  it("returns undefined for unknown strings, non-strings, and missing values", () => {
    expect(readGroupByParam("byFile")).toBeUndefined();
    expect(readGroupByParam("")).toBeUndefined();
    expect(readGroupByParam(undefined)).toBeUndefined();
    expect(readGroupByParam(null)).toBeUndefined();
    expect(readGroupByParam(42)).toBeUndefined();
    expect(readGroupByParam({ groupBy: "firstChildDir" })).toBeUndefined();
  });
});

describe("groupKeyFor — strategy-specific key derivation", () => {
  const root = "/repo";

  it("firstChildDir: returns the first relative segment for nested files", () => {
    expect(groupKeyFor("/repo/templates/foo/index.html", root, "firstChildDir")).toBe("templates");
    expect(groupKeyFor("/repo/templates/bar/about.html", root, "firstChildDir")).toBe("templates");
    expect(groupKeyFor("/repo/src/app.tsx", root, "firstChildDir")).toBe("src");
  });

  it("firstChildDir: buckets root-level files under '.' (no silent drop)", () => {
    expect(groupKeyFor("/repo/index.html", root, "firstChildDir")).toBe(".");
    expect(groupKeyFor("/repo/README.md", root, "firstChildDir")).toBe(".");
  });

  it("directory: returns the relative parent directory for nested files", () => {
    expect(groupKeyFor("/repo/templates/foo/index.html", root, "directory")).toBe("templates/foo");
    expect(groupKeyFor("/repo/src/components/button.tsx", root, "directory")).toBe(
      "src/components",
    );
  });

  it("directory: buckets root-level files under '.' (no silent drop)", () => {
    expect(groupKeyFor("/repo/index.html", root, "directory")).toBe(".");
  });

  it("extension: returns the lowercase extension without the leading dot", () => {
    expect(groupKeyFor("/repo/a.tsx", root, "extension")).toBe("tsx");
    expect(groupKeyFor("/repo/sub/b.HTML", root, "extension")).toBe("html");
    expect(groupKeyFor("/repo/c.css", root, "extension")).toBe("css");
  });

  it("extension: returns empty string for files without an extension (honest, not a silent drop)", () => {
    expect(groupKeyFor("/repo/Makefile", root, "extension")).toBe("");
  });

  it("buckets paths outside the root under '<external>' for relative-strategy groupings", () => {
    // Doctrine: `additionalPaths` may contribute files outside the
    // project root; bucketing them under `..` would lose information.
    expect(groupKeyFor("/elsewhere/foo.tsx", root, "firstChildDir")).toBe("<external>");
    expect(groupKeyFor("/elsewhere/foo.tsx", root, "directory")).toBe("<external>");
    // Extension is path-independent so no special case there.
    expect(groupKeyFor("/elsewhere/foo.tsx", root, "extension")).toBe("tsx");
  });
});

describe("computeByGroup — per-group rollup", () => {
  const root = "/repo";

  it("aggregates violations by firstChildDir for a catalog-shaped corpus", () => {
    const out = computeByGroup(
      [
        {
          path: "/repo/templates/site-a/index.html",
          findings: [E("alt-text/missing"), E("contrast/minimum")],
        },
        {
          path: "/repo/templates/site-a/about.html",
          findings: [E("alt-text/missing")],
        },
        {
          path: "/repo/templates/site-b/index.html",
          findings: [E("contrast/minimum")],
        },
        {
          path: "/repo/src/app.tsx",
          findings: [W("aria/labels-required")],
        },
      ],
      root,
      "firstChildDir",
    );
    expect(Object.keys(out).sort()).toEqual(["src", "templates"]);
    expect(out["templates"]).toEqual({
      violations: 4,
      filesWithFindings: 3,
      mostCommonRule: "alt-text/missing",
    } satisfies ByGroupEntry);
    expect(out["src"]).toEqual({
      violations: 1,
      filesWithFindings: 1,
      mostCommonRule: "aria/labels-required",
    } satisfies ByGroupEntry);
  });

  it("populates mostCommonCriterion when criterionIds are present on findings", () => {
    const out = computeByGroup(
      [
        {
          path: "/repo/a/foo.html",
          findings: [
            E("alt-text/missing", ["wcag22:1.1.1"]),
            E("alt-text/missing", ["wcag22:1.1.1"]),
            E("contrast/minimum", ["wcag22:1.4.3"]),
          ],
        },
      ],
      root,
      "firstChildDir",
    );
    expect(out["a"]).toEqual({
      violations: 3,
      filesWithFindings: 1,
      mostCommonRule: "alt-text/missing",
      mostCommonCriterion: "wcag22:1.1.1",
    });
  });

  it("excludes info-severity findings from the violation count and rule frequency", () => {
    // The rollup splits the same error+warning surface
    // `plan.fixesByClass` tallies — info findings (e.g. wrappers/inferred)
    // would crowd top-rule selection with non-actionable context.
    const out = computeByGroup(
      [
        {
          path: "/repo/a/foo.tsx",
          findings: [I("wrappers/inferred"), I("wrappers/inferred"), E("contrast/minimum")],
        },
      ],
      root,
      "firstChildDir",
    );
    expect(out["a"]).toEqual({
      violations: 1,
      filesWithFindings: 1,
      mostCommonRule: "contrast/minimum",
    });
  });

  it("drops groups whose total error+warning count is zero (no zero-row noise)", () => {
    // An info-only file has no `violations` to rank and would land as a
    // {violations: 0, ...} sentinel; the drop matches the
    // `withTopRules` doctrine "no zero-count padding."
    const out = computeByGroup(
      [{ path: "/repo/a/foo.tsx", findings: [I("wrappers/inferred")] }],
      root,
      "firstChildDir",
    );
    expect(out).toEqual({});
  });

  it("aggregates by extension when groupBy is 'extension'", () => {
    const out = computeByGroup(
      [
        { path: "/repo/a/foo.tsx", findings: [E("aria/labels-required")] },
        { path: "/repo/a/bar.tsx", findings: [E("aria/labels-required")] },
        { path: "/repo/b/baz.html", findings: [W("alt-text/missing")] },
        { path: "/repo/c/quux.css", findings: [E("contrast/minimum")] },
      ],
      root,
      "extension",
    );
    expect(out["tsx"]).toEqual({
      violations: 2,
      filesWithFindings: 2,
      mostCommonRule: "aria/labels-required",
    });
    expect(out["html"]).toEqual({
      violations: 1,
      filesWithFindings: 1,
      mostCommonRule: "alt-text/missing",
    });
    expect(out["css"]).toEqual({
      violations: 1,
      filesWithFindings: 1,
      mostCommonRule: "contrast/minimum",
    });
  });

  it("aggregates by directory when groupBy is 'directory'", () => {
    const out = computeByGroup(
      [
        { path: "/repo/src/components/btn.tsx", findings: [E("aria/labels-required")] },
        { path: "/repo/src/components/icon.tsx", findings: [E("aria/labels-required")] },
        { path: "/repo/src/pages/home.tsx", findings: [W("alt-text/missing")] },
      ],
      root,
      "directory",
    );
    expect(Object.keys(out).sort()).toEqual(["src/components", "src/pages"]);
    expect(out["src/components"]?.violations).toBe(2);
    expect(out["src/pages"]?.violations).toBe(1);
  });

  it("returns an empty record on a clean scan — caller conditional-spreads off the wire", () => {
    expect(computeByGroup([], root, "firstChildDir")).toEqual({});
    expect(
      computeByGroup([{ path: "/repo/a/foo.tsx", findings: [] }], root, "firstChildDir"),
    ).toEqual({});
  });

  it("breaks ties on mostCommonRule alphabetically for deterministic ordering", () => {
    const out = computeByGroup(
      [
        {
          path: "/repo/a/foo.tsx",
          findings: [E("zzz/last"), E("aaa/first")],
        },
      ],
      root,
      "firstChildDir",
    );
    expect(out["a"]?.mostCommonRule).toBe("aaa/first");
  });
});

describe("withByGroup — plan-stamping helper", () => {
  const root = "/repo";

  it("identity-stable when strategy is undefined (the standard non-groupBy path)", () => {
    const plan = { infoSeverityFindings: 0 } satisfies Record<string, unknown>;
    const out = withByGroup(
      plan,
      [{ path: "/repo/a/foo.tsx", findings: [{ ruleId: "x", severity: "error" }] }],
      root,
      undefined,
    );
    expect(out).toBe(plan);
    expect(out["byGroup"]).toBeUndefined();
  });

  it("stamps `plan.byGroup` when at least one group has error/warning findings", () => {
    const plan = { infoSeverityFindings: 0 } satisfies Record<string, unknown>;
    const out = withByGroup(
      plan,
      [
        {
          path: "/repo/templates/site-a/index.html",
          findings: [{ ruleId: "alt-text/missing", severity: "error" }],
        },
      ],
      root,
      "firstChildDir",
    );
    expect(out["byGroup"]).toEqual({
      templates: {
        violations: 1,
        filesWithFindings: 1,
        mostCommonRule: "alt-text/missing",
      },
    });
    expect(out["infoSeverityFindings"]).toBe(0);
  });

  it("identity-stable when no group has any error/warning findings (clean scan)", () => {
    const plan = { infoSeverityFindings: 1 } satisfies Record<string, unknown>;
    const out = withByGroup(plan, [], root, "firstChildDir");
    expect(out).toBe(plan);
    expect(out["byGroup"]).toBeUndefined();
  });
});
