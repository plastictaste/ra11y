/**
 * Unit tests for `src/mcp/catalog-detect.ts` — the root-level "catalog
 * of sibling sites" probe that `scan_project` uses to surface
 * `meta.catalogHint` + an `analysisCoverage.hints` entry nudging the
 * agent toward per-subdir scans.
 *
 * Invariants under test:
 *   1. A root with ≥ {@link CATALOG_MIN_SIBLINGS} qualifying sibling
 *      site dirs (each carrying `index.html` AND at least one
 *      asset-shaped sibling directory) resolves to a catalog hint
 *      naming the count plus a stable alphabetical example list.
 *   2. A root with fewer than the threshold returns `null` (honest
 *      absence — no low-confidence positives).
 *   3. A subdir carrying `index.html` but no sibling asset directory
 *      does NOT count as a qualifying site (rules out a single
 *      orphan README rendered into a folder).
 *   4. `withCatalogHint` appends the hint prose to
 *      `analysisCoverage.hints` and seeds an empty coverage block when
 *      none exists; passes `meta` unchanged when no catalog resolved.
 *   5. `catalogHintProse` embeds the count and at least one example
 *      sibling so the message is self-explanatory.
 *   6. `catalogEmptyResultMetaFields` returns the spreadable empty
 *      object on a non-catalog root; returns the
 *      `{ catalogHint, analysisCoverage }` pair on a catalog root.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_EXAMPLE_CAP,
  CATALOG_MIN_SIBLINGS,
  type CatalogHint,
  catalogEmptyResultMetaFields,
  catalogHintProse,
  detectCatalogShape,
  withCatalogHint,
} from "../../../src/mcp/catalog-detect.ts";

async function withScratch<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-catalog-detect-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Creates a site-shaped subdirectory under `root`: `<name>/index.html`
 * plus a matching `<name>/<assetDir>/` directory so the corroboration
 * predicate fires.
 */
async function makeSiteDir(root: string, name: string, assetDir = "css"): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), "<html><body><h1>Hello</h1></body></html>\n");
  await mkdir(join(dir, assetDir), { recursive: true });
}

describe("detectCatalogShape: catalog regime", () => {
  it("resolves a 5-sibling site catalog with the threshold count + alphabetical examples", async () => {
    await withScratch(async (root) => {
      const names = ["coffee-shop", "agile-agency", "delite-music", "frames-corporate", "vone"];
      for (const name of names) await makeSiteDir(root, name);
      const result = detectCatalogShape(root);
      expect(result).not.toBeNull();
      expect(result?.topLevelSiblings).toBe(5);
      // Alphabetical, capped at CATALOG_EXAMPLE_CAP for stability.
      expect(result?.exampleSiblings).toEqual(["agile-agency", "coffee-shop", "delite-music"]);
      expect(result?.exampleSiblings.length).toBeLessThanOrEqual(CATALOG_EXAMPLE_CAP);
    });
  });

  it("counts every qualifying sibling beyond the example cap", async () => {
    await withScratch(async (root) => {
      // 8 site dirs — well above the threshold and the example cap.
      const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
      for (const name of names) await makeSiteDir(root, name);
      const result = detectCatalogShape(root);
      expect(result).not.toBeNull();
      expect(result?.topLevelSiblings).toBe(names.length);
      // Examples remain capped at the alphabetical prefix.
      expect(result?.exampleSiblings).toEqual(["alpha", "bravo", "charlie"]);
    });
  });

  it("accepts varied asset-shaped sibling directories as corroboration", async () => {
    await withScratch(async (root) => {
      // Mix the asset directories so the corroboration predicate is
      // exercised across each accepted name.
      await makeSiteDir(root, "site-a", "css");
      await makeSiteDir(root, "site-b", "images");
      await makeSiteDir(root, "site-c", "assets");
      await makeSiteDir(root, "site-d", "img");
      await makeSiteDir(root, "site-e", "js");
      const result = detectCatalogShape(root);
      expect(result?.topLevelSiblings).toBe(5);
    });
  });
});

describe("detectCatalogShape: honest absence", () => {
  it("returns null when only sub-threshold sibling site dirs exist", async () => {
    await withScratch(async (root) => {
      // 4 site dirs — one below the threshold; the agent can read the
      // layout itself, no nudge needed.
      for (const name of ["s1", "s2", "s3", "s4"]) await makeSiteDir(root, name);
      expect(detectCatalogShape(root)).toBeNull();
    });
  });

  it("returns null when a subdir has index.html but no asset-shaped sibling", async () => {
    await withScratch(async (root) => {
      // Five subdirs each with only index.html — bare README-as-folder
      // shape; not enough corroboration for the catalog predicate.
      for (const name of ["a", "b", "c", "d", "e"]) {
        const d = join(root, name);
        await mkdir(d, { recursive: true });
        await writeFile(join(d, "index.html"), "<html></html>\n");
      }
      expect(detectCatalogShape(root)).toBeNull();
    });
  });

  it("returns null on an empty root", async () => {
    await withScratch((root) => {
      expect(detectCatalogShape(root)).toBeNull();
    });
  });

  it("returns null on a single-app repo with src/ and one index.html", async () => {
    await withScratch(async (root) => {
      // Single-site shape — index.html + asset directories — should not
      // be classified as a catalog (only one site dir at the root).
      await writeFile(join(root, "index.html"), "<html></html>\n");
      await mkdir(join(root, "css"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      expect(detectCatalogShape(root)).toBeNull();
    });
  });

  it("ignores hidden top-level entries (e.g. .git)", async () => {
    await withScratch(async (root) => {
      // Three real sibling sites is below the threshold, so even if a
      // hypothetical `.git` were treated as qualifying, the count would
      // still be below the threshold. Add a `.git` directory anyway so
      // the assertion hits the `name.startsWith(".")` filter.
      await mkdir(join(root, ".git"), { recursive: true });
      for (const name of ["s1", "s2", "s3"]) await makeSiteDir(root, name);
      expect(detectCatalogShape(root)).toBeNull();
    });
  });

  it("returns null on a non-existent path (no throw)", () => {
    expect(detectCatalogShape("/this/path/should/never/exist/ra11y-test")).toBeNull();
  });
});

describe("catalogHintProse", () => {
  it("embeds the sibling count and at least one example", () => {
    const hint: CatalogHint = {
      topLevelSiblings: 174,
      exampleSiblings: ["agile-agency", "coffee-shop", "delite-music"],
    };
    const prose = catalogHintProse(hint);
    expect(prose).toContain("174");
    expect(prose).toContain("agile-agency");
    expect(prose).toContain("coffee-shop");
    // Names the second-call shape so the agent has a paste-ready hint.
    expect(prose).toContain('scan_project({ cwd: "<subdir>" })');
  });
});

describe("withCatalogHint", () => {
  it("returns meta unchanged when no catalog resolved", () => {
    const meta = { filesScanned: 12, analysisCoverage: { hints: ["existing hint"] } };
    expect(withCatalogHint(meta, null)).toBe(meta);
  });

  it("appends the catalog hint to an existing analysisCoverage.hints array", () => {
    const meta = { filesScanned: 12, analysisCoverage: { hints: ["existing hint"] } };
    const result = withCatalogHint(meta, {
      topLevelSiblings: 7,
      exampleSiblings: ["a", "b", "c"],
    });
    const coverage = result["analysisCoverage"] as { readonly hints: readonly string[] };
    expect(coverage.hints[0]).toBe("existing hint");
    expect(coverage.hints[1]).toContain("catalog");
    expect(coverage.hints[1]).toContain("7");
  });

  it("seeds analysisCoverage with just the hint when the meta block has none", () => {
    const meta = { filesScanned: 12 };
    const result = withCatalogHint(meta, {
      topLevelSiblings: 5,
      exampleSiblings: ["a", "b", "c"],
    });
    const coverage = result["analysisCoverage"] as { readonly hints: readonly string[] };
    expect(coverage.hints.length).toBe(1);
    expect(coverage.hints[0]).toContain("catalog");
  });
});

describe("catalogEmptyResultMetaFields", () => {
  it("returns an empty object on a non-catalog root", async () => {
    await withScratch((root) => {
      expect(catalogEmptyResultMetaFields(root)).toEqual({});
    });
  });

  it("returns the catalogHint + analysisCoverage pair on a catalog root", async () => {
    await withScratch(async (root) => {
      for (const name of ["a", "b", "c", "d", "e"]) await makeSiteDir(root, name);
      const fields = catalogEmptyResultMetaFields(root);
      const hint = fields["catalogHint"] as CatalogHint | undefined;
      expect(hint?.topLevelSiblings).toBe(5);
      const coverage = fields["analysisCoverage"] as
        | { readonly hints: readonly string[] }
        | undefined;
      expect(coverage?.hints?.[0]).toContain("catalog");
    });
  });
});

describe("CATALOG_MIN_SIBLINGS", () => {
  it("sits at the 5-sibling trigger from the backlog item", () => {
    // Pinning the constant so a refactor that drifts the threshold
    // surfaces immediately rather than silently.
    expect(CATALOG_MIN_SIBLINGS).toBe(5);
  });
});
