/**
 * Unit tests for `src/mcp/ssg-detect.ts` — the root-level static-site-
 * generator probe that `scan_project` uses to surface
 * `meta.detectedFramework` + an `analysisCoverage.hints` entry nudging
 * the agent toward the "build the site, then scan the rendered output"
 * workflow.
 *
 * Invariants under test:
 *   1. Each canonical (unambiguous-filename) config marker in isolation
 *      resolves to the expected framework tag + build output + build
 *      command at `confidence: "high"`. The filenames (`hugo.toml`,
 *      `astro.config.mjs`, `gatsby-config.js`, etc.) are not shared
 *      with non-SSG tooling, so a bare match is strong evidence.
 *   2. Jekyll's `_config.yml` is the documented ambiguous sentinel
 *      (third-party site templates, ecosystem dumps, and unrelated
 *      YAML-config tools ship one). The detector grades confidence by
 *      corroborator count instead of suppressing weak matches:
 *      0 corroborators → `low`, 1 → `medium`, ≥2 → `high`. Corroborators
 *      are `_layouts/`, `_includes/`, `_posts/`, `_drafts/` directories
 *      and a Gemfile mentioning the `jekyll` gem.
 *   3. Hugo's legacy `config.toml` only resolves when it carries a
 *      `[markup]` section header (the disambiguator vs. Rust workspaces)
 *      — a positive content-probe match ships at `confidence: "high"`.
 *   4. A clean repo with no markers returns `null` so the caller can
 *      conditional-spread the field away.
 *   5. Sub-scope inheritance: the detector probes EXACTLY the path
 *      passed as `root`, never an ancestor. A sub-tree without its own
 *      sentinel returns `null` even if a parent directory has one —
 *      no walk-up.
 *   6. `ssgHint` embeds the framework tag inline and names the
 *      `additionalPaths` argument the agent copies into a follow-up
 *      scan call.
 *   7. Declaration order breaks ties deterministically (first marker
 *      in SSG_DESCRIPTORS wins).
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DetectedFramework,
  detectSsgFramework,
  type SsgFramework,
  ssgHint,
} from "../../../src/mcp/ssg-detect.ts";

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-ssg-detect-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("detectSsgFramework: canonical single-marker repos", () => {
  // One representative marker per framework — the modern / most-common
  // filename the SSG documents as the canonical config. Alternate
  // filenames (hugo.yaml, eleventy.config.js, etc.) are covered in
  // the alternate-markers block below. Jekyll is excluded here because
  // `_config.yml` alone is ambiguous (third-party templates ship one);
  // see the dedicated jekyll corroboration block below.
  const cases: ReadonlyArray<{
    readonly marker: string;
    readonly name: SsgFramework;
    readonly buildOutput: string;
    readonly buildCommand: string;
    readonly body: string;
  }> = [
    {
      marker: "hugo.toml",
      name: "hugo",
      buildOutput: "public/",
      buildCommand: "hugo",
      body: 'baseURL = "https://example.org/"\n',
    },
    {
      marker: "astro.config.mjs",
      name: "astro",
      buildOutput: "dist/",
      buildCommand: "astro build",
      body: 'import { defineConfig } from "astro/config";\nexport default defineConfig({});\n',
    },
    {
      marker: ".eleventy.js",
      name: "eleventy",
      buildOutput: "_site/",
      buildCommand: "npx @11ty/eleventy",
      body: "module.exports = function (eleventyConfig) {};\n",
    },
    {
      marker: "gatsby-config.js",
      name: "gatsby",
      buildOutput: "public/",
      buildCommand: "gatsby build",
      body: "module.exports = { siteMetadata: {} };\n",
    },
    {
      marker: "mkdocs.yml",
      name: "mkdocs",
      buildOutput: "site/",
      buildCommand: "mkdocs build",
      body: "site_name: My docs\n",
    },
  ];

  for (const { marker, name, buildOutput, buildCommand, body } of cases) {
    it(`resolves ${marker} → ${name} with build output "${buildOutput}" and command "${buildCommand}" at confidence "high"`, async () => {
      await withScratch(async (dir) => {
        await writeFile(join(dir, marker), body);
        // Unambiguous-filename markers ship `confidence: "high"`
        // — the filenames (`hugo.toml`, `astro.config.mjs`, etc.)
        // are not shared with non-SSG tooling, so a bare match is
        // strong evidence. Jekyll is the exception; its confidence
        // is graded by corroborator count (covered below).
        expect(detectSsgFramework(dir)).toEqual({
          name,
          buildOutput,
          buildCommand,
          confidence: "high",
        });
      });
    });
  }
});

describe("detectSsgFramework: alternate markers within a framework", () => {
  // Hugo publishes three modern config-filename conventions (`hugo.toml`,
  // `hugo.yaml`, `hugo.json`) — agents branch on the framework tag, not
  // the filename, so each must resolve identically.
  it("resolves hugo.yaml to the hugo descriptor", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "hugo.yaml"), "baseURL: https://example.org/\n");
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("hugo");
    });
  });

  it("resolves astro.config.ts to the astro descriptor", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "astro.config.ts"), "export default {};\n");
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("astro");
    });
  });

  it("resolves eleventy.config.js to the eleventy descriptor", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "eleventy.config.js"), "module.exports = () => {};\n");
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("eleventy");
    });
  });

  it("resolves gatsby-config.ts to the gatsby descriptor", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "gatsby-config.ts"), "export default {};\n");
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("gatsby");
    });
  });

  it("resolves mkdocs.yaml (alternate extension) to the mkdocs descriptor", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "mkdocs.yaml"), "site_name: docs\n");
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("mkdocs");
    });
  });
});

describe("detectSsgFramework: jekyll confidence is graded by corroborator count", () => {
  // `_config.yml` alone is too weak to ship a `confident` Jekyll
  // classification: third-party site templates, ecosystem dumps, and
  // unrelated YAML-config tools ship a stray top-level `_config.yml`.
  // The doctrine-correct response is NOT to silently drop the signal
  // (which made an unaccompanied stray `_config.yml` indistinguishable
  // from "no SSG here") — it is to surface the framework with the
  // calibrated confidence the evidence actually supports. The
  // detector therefore now grades:
  //   - 0 corroborators → confidence: "low"
  //   - 1 corroborator  → confidence: "medium"
  //   - ≥2 corroborators → confidence: "high"
  // Corroborators: `_layouts/`, `_includes/`, `_posts/`, `_drafts/`
  // directories at root, plus a Gemfile mentioning the `jekyll` gem.
  // Per `docs/kb/architecture/ai-first-consumer.md`
  // "Heuristic-mislabeled meta sub-fields are dishonest": surfacing
  // `confidence: "low"` is honest evidence-calibration; returning
  // `null` for sentinel-only matches was silent suppression.

  it('surfaces confidence: "low" for bare _config.yml with no jekyll-shaped neighbours', async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      expect(detectSsgFramework(dir)).toEqual({
        name: "jekyll",
        buildOutput: "_site/",
        buildCommand: "bundle exec jekyll build",
        confidence: "low",
      });
    });
  });

  it('resolves _config.yml + _layouts/ to jekyll at confidence: "medium"', async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_layouts"));
      expect(detectSsgFramework(dir)).toEqual({
        name: "jekyll",
        buildOutput: "_site/",
        buildCommand: "bundle exec jekyll build",
        confidence: "medium",
      });
    });
  });

  it('resolves _config.yml + _includes/ to jekyll at confidence: "medium"', async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_includes"));
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("medium");
    });
  });

  it('resolves _config.yml + _posts/ to jekyll at confidence: "medium"', async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_posts"));
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("medium");
    });
  });

  it('resolves _config.yml + _drafts/ to jekyll at confidence: "medium"', async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_drafts"));
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("medium");
    });
  });

  it('resolves _config.yml + Gemfile mentioning jekyll at confidence: "medium"', async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await writeFile(
        join(dir, "Gemfile"),
        'source "https://rubygems.org"\ngem "jekyll", "~> 4.3"\n',
      );
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("medium");
    });
  });

  it('surfaces confidence: "low" for _config.yml + Gemfile that does NOT mention jekyll', async () => {
    // A Ruby project with a stray YAML config file but a non-jekyll
    // Gemfile (rails, sinatra, plain bundler) is not a Jekyll site.
    // The Gemfile's mere existence is not corroboration; the gem
    // declaration is. With sentinel-only evidence the framework still
    // ships, but at honest `low` confidence.
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await writeFile(
        join(dir, "Gemfile"),
        'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
      );
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("low");
    });
  });

  it("does NOT count a regular-file `_layouts` (non-directory) as a corroborator", async () => {
    // `_layouts` as a stray text file (some unrelated template might
    // ship one) does not corroborate Jekyll — the directory shape
    // matters, since Jekyll resolves layouts by reading children. The
    // sentinel is still present, so the framework ships at `low`.
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await writeFile(join(dir, "_layouts"), "not a directory\n");
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("low");
    });
  });

  it('resolves _config.yml + _layouts/ + _includes/ to jekyll at confidence: "high" (≥2 corroborators)', async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_layouts"));
      await mkdir(join(dir, "_includes"));
      expect(detectSsgFramework(dir)).toEqual({
        name: "jekyll",
        buildOutput: "_site/",
        buildCommand: "bundle exec jekyll build",
        confidence: "high",
      });
    });
  });

  it('resolves _config.yml + _layouts/ + Gemfile mentioning jekyll at confidence: "high"', async () => {
    // Two corroborators of different kinds (directory + Gemfile gem
    // declaration) cross the high-confidence threshold even when no
    // second Jekyll-shaped directory is present.
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_layouts"));
      await writeFile(
        join(dir, "Gemfile"),
        'source "https://rubygems.org"\ngem "jekyll", "~> 4.3"\n',
      );
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("high");
    });
  });
});

describe("detectSsgFramework: sub-scope inheritance", () => {
  // The detector probes EXACTLY the path the caller passes as `root`,
  // never an ancestor. When an agent runs `scan_project` against a
  // sub-template directory whose own tree has no `_config.yml`, the
  // parent's framework label does NOT propagate down — `detectedFramework`
  // is omitted from the response (returned as `null` here, conditional-
  // spread away by the caller). This pins the "no walk-up inheritance"
  // invariant: an agent calling `scan_project({ cwd: "<sub-dir>" })`
  // inside a 174-template dump gets framework data only when the sub-
  // tree itself corroborates, not because the dump root one level up
  // happens to look Jekyll-shaped. Per `docs/kb/architecture/
  // ai-first-consumer.md` "Heuristic-mislabeled meta sub-fields are
  // dishonest" — inheriting an ancestor's classification onto a
  // sub-scope without its own evidence is a dishonest shape.
  it("returns null when the scanned sub-tree has no sentinel even though an ancestor does", async () => {
    await withScratch(async (dir) => {
      // Simulate a parent corpus with full Jekyll evidence at `dir`,
      // and a sub-template directory `dir/templates/site-42/` that
      // has none of its own.
      await writeFile(join(dir, "_config.yml"), "title: Parent corpus\n");
      await mkdir(join(dir, "_layouts"));
      await mkdir(join(dir, "_includes"));
      const subDir = join(dir, "templates", "site-42");
      await mkdir(subDir, { recursive: true });
      // The parent resolves cleanly; the sub-tree does not.
      expect(detectSsgFramework(dir)?.name).toBe("jekyll");
      expect(detectSsgFramework(subDir)).toBeNull();
    });
  });

  it("returns null for an arbitrary directory with no SSG sentinel anywhere up the path", async () => {
    // Defensive case: a scan against a deep sub-directory of a non-SSG
    // project must not invent a framework. Combined with the test
    // above, this pins the "probe at root only, never walk up"
    // invariant from both directions.
    await withScratch(async (dir) => {
      const deep = join(dir, "src", "components", "card");
      await mkdir(deep, { recursive: true });
      expect(detectSsgFramework(deep)).toBeNull();
    });
  });
});

describe("detectSsgFramework: legacy Hugo config.toml disambiguation", () => {
  // `config.toml` without `[markup]` is ambiguous — a Rust workspace or
  // any other TOML-config tool could drop one. The detector must NOT
  // fabricate a Hugo classification on the filename alone.
  it("returns null for a bare config.toml with no [markup] section", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "config.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
      expect(detectSsgFramework(dir)).toBeNull();
    });
  });

  // `config.toml` with `[markup]` is Hugo's legacy pre-0.110 shape —
  // the section header is the stable disambiguator (Hugo configs
  // reliably carry it; Cargo workspaces / other TOML configs never do).
  // Confidence is `high` because the section-header content probe is
  // strong corroboration equivalent to an unambiguous filename.
  it('resolves config.toml with a [markup] section header to hugo at confidence: "high"', async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "config.toml"),
        'baseURL = "https://example.org/"\n\n[markup]\n  [markup.goldmark]\n    [markup.goldmark.renderer]\n      unsafe = true\n',
      );
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("hugo");
      expect(result?.buildOutput).toBe("public/");
      expect(result?.buildCommand).toBe("hugo");
      expect(result?.confidence).toBe("high");
    });
  });

  // The section header check is line-anchored — an inline mention
  // inside a TOML string or comment must NOT trip the match.
  it("ignores the string [markup] inside a TOML value on a non-Hugo config", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "config.toml"),
        'description = "note: uses [markup] extensions"\nname = "x"\n',
      );
      expect(detectSsgFramework(dir)).toBeNull();
    });
  });
});

describe("detectSsgFramework: declaration order breaks ties", () => {
  // SSG_DESCRIPTORS is declared jekyll → hugo → astro → eleventy →
  // gatsby → mkdocs; the first match wins. Confirm the ordering
  // empirically so a future reshuffle that changed the tie-break
  // doesn't silently land. Jekyll needs corroboration to satisfy
  // its detection precondition (see jekyll corroboration block above).
  it("prefers jekyll over astro when both markers are present (with jekyll corroboration)", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_layouts"));
      await writeFile(join(dir, "astro.config.mjs"), "export default {};\n");
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
    });
  });
});

describe("detectSsgFramework: empty repo", () => {
  it("returns null when no recognized marker is present", async () => {
    // No config files at all — no package.json, no _config.yml, no
    // config.toml. Detector must stay total and return null so the
    // caller can conditional-spread the meta field away (CLAUDE.md §1
    // "Ambiguous field shapes are dishonest").
    await withScratch((dir) => {
      expect(detectSsgFramework(dir)).toBeNull();
      return Promise.resolve();
    });
  });

  it("returns null in a plain Node project (package.json only)", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"name":"x"}\n');
      expect(detectSsgFramework(dir)).toBeNull();
    });
  });
});

describe("detectSsgFramework: sentinelless Jekyll path (no _config.yml)", () => {
  // The closure for the silent-miss case where a corpus has unambiguous
  // Jekyll evidence (`_layouts/`, `_includes/`, frontmatter fences,
  // Liquid/ERB tokens) but `_config.yml` is absent. The prior closure
  // returned `null` and silently dropped the framework signal; per
  // `docs/kb/architecture/ai-first-consumer.md` "Verbose meta is signal,
  // not clutter," the corroborating evidence the scanner has access to
  // must reach the framework label rather than be ignored. The
  // sentinelless path requires BOTH `_layouts/` AND `_includes/` at
  // root (the conservative discriminator — Hugo uses `layouts/` without
  // an underscore; single-directory matches are too weak to fingerprint
  // Jekyll on). Confidence stays bounded at `medium` because no
  // sentinel filename was observed.

  it('surfaces confidence: "low" for _layouts/ + _includes/ alone with no corpus evidence', async () => {
    await withScratch(async (dir) => {
      await mkdir(join(dir, "_layouts"));
      await mkdir(join(dir, "_includes"));
      expect(detectSsgFramework(dir)).toEqual({
        name: "jekyll",
        buildOutput: "_site/",
        buildCommand: "bundle exec jekyll build",
        confidence: "low",
      });
    });
  });

  it('lifts to confidence: "medium" with _layouts/ + _includes/ + frontmatter fence corpus signal', async () => {
    await withScratch(async (dir) => {
      await mkdir(join(dir, "_layouts"));
      await mkdir(join(dir, "_includes"));
      const result = detectSsgFramework(dir, { hasFrontmatterFence: true });
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("medium");
    });
  });

  it('lifts to confidence: "medium" with _layouts/ + _includes/ + Liquid/ERB token corpus signal', async () => {
    await withScratch(async (dir) => {
      await mkdir(join(dir, "_layouts"));
      await mkdir(join(dir, "_includes"));
      const result = detectSsgFramework(dir, { hasLiquidOrErbTokens: true });
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("medium");
    });
  });

  it("stays bounded at medium even with both corpus signals present (no sentinel was observed)", async () => {
    // The sentinelless path caps at `medium` per the doctrine that
    // sentinel-bearing matches reach `high` because the filename
    // presence is independent evidence; a sentinelless match stays
    // one step shy so the agent reading `confidence: "medium"` knows
    // to verify the absence of `_config.yml` rather than treating
    // the classification as fully grounded.
    await withScratch(async (dir) => {
      await mkdir(join(dir, "_layouts"));
      await mkdir(join(dir, "_includes"));
      const result = detectSsgFramework(dir, {
        hasFrontmatterFence: true,
        hasLiquidOrErbTokens: true,
      });
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("medium");
    });
  });

  it("returns null when only _layouts/ is present (single-corroborator predicate is too weak)", async () => {
    // Hugo uses `layouts/` (no underscore) and various templating
    // tools ship a `_layouts/` directory in isolation; demanding the
    // pair is the conservative discriminator that keeps single-
    // directory matches from misclassifying.
    await withScratch(async (dir) => {
      await mkdir(join(dir, "_layouts"));
      expect(detectSsgFramework(dir, { hasFrontmatterFence: true })).toBeNull();
    });
  });

  it("returns null when only _includes/ is present (single-corroborator predicate is too weak)", async () => {
    await withScratch(async (dir) => {
      await mkdir(join(dir, "_includes"));
      expect(detectSsgFramework(dir, { hasLiquidOrErbTokens: true })).toBeNull();
    });
  });

  it("returns null when _layouts is a regular file (Jekyll requires the directory shape)", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_layouts"), "not a directory\n");
      await mkdir(join(dir, "_includes"));
      expect(detectSsgFramework(dir, { hasFrontmatterFence: true })).toBeNull();
    });
  });

  it("does NOT walk up to ancestor directories looking for the dir pair", async () => {
    // Sub-scope inheritance invariant: the sentinelless path probes
    // EXACTLY at `root`. A sub-tree without its own `_layouts/` +
    // `_includes/` returns `null` even when an ancestor has both —
    // pairs with the no-walk-up rule on the sentinel-bearing path.
    await withScratch(async (dir) => {
      await mkdir(join(dir, "_layouts"));
      await mkdir(join(dir, "_includes"));
      const subDir = join(dir, "templates", "site-42");
      await mkdir(subDir, { recursive: true });
      // Parent resolves on the sentinelless path; sub-tree does not.
      expect(detectSsgFramework(dir)?.name).toBe("jekyll");
      expect(detectSsgFramework(subDir, { hasFrontmatterFence: true })).toBeNull();
    });
  });

  it("the real config-marker path takes precedence over the sentinelless path", async () => {
    // When both `_config.yml` AND the dir pair exist, the
    // sentinel-bearing Jekyll path runs first and the corroboration
    // count includes the dir pair — so the result reaches `high`
    // rather than the sentinelless cap of `medium`. Documents the
    // ordering invariant.
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_layouts"));
      await mkdir(join(dir, "_includes"));
      const result = detectSsgFramework(dir, {
        hasFrontmatterFence: true,
        hasLiquidOrErbTokens: true,
      });
      expect(result?.name).toBe("jekyll");
      expect(result?.confidence).toBe("high");
    });
  });
});

describe("ssgHint", () => {
  // Guards the wire-level shape. Agents reading the hint prose may
  // key off the framework tag and the additionalPaths argument, so
  // both must appear inline and in the expected format.
  it("embeds the framework tag, build command, and quoted additionalPaths argument in text + structured detail", () => {
    const framework: DetectedFramework = {
      name: "jekyll",
      buildOutput: "_site/",
      buildCommand: "bundle exec jekyll build",
      confidence: "high",
    };
    const hint = ssgHint(framework);
    expect(hint.code).toBe("ssg_build_output_hint");
    expect(hint.text).toContain("jekyll");
    expect(hint.text).toContain("bundle exec jekyll build");
    // The trailing slash on buildOutput is stripped from the
    // additionalPaths argument — agents pasting the value into a
    // `string[]` do not want a trailing slash because the scanner
    // normalizes input paths either way and an un-trimmed path
    // reads as a typo on the review diff.
    expect(hint.text).toContain('additionalPaths: ["_site"]');
    expect(hint.text).not.toContain('"_site/"');
    // Structured detail: every field the agent would otherwise have
    // to parse out of `text` is exposed directly.
    expect(hint.detail?.["framework"]).toBe("jekyll");
    expect(hint.detail?.["buildCommand"]).toBe("bundle exec jekyll build");
    expect(hint.detail?.["buildOutput"]).toBe("_site/");
    expect(hint.detail?.["additionalPathsArgument"]).toBe("_site");
  });

  it("works symmetrically for every framework the detector returns", () => {
    // Compact smoke test — guards against a future reshuffle that
    // accidentally names one framework's output in another's hint.
    const frameworks: readonly DetectedFramework[] = [
      { name: "hugo", buildOutput: "public/", buildCommand: "hugo", confidence: "high" },
      { name: "astro", buildOutput: "dist/", buildCommand: "astro build", confidence: "high" },
      {
        name: "eleventy",
        buildOutput: "_site/",
        buildCommand: "npx @11ty/eleventy",
        confidence: "high",
      },
      { name: "gatsby", buildOutput: "public/", buildCommand: "gatsby build", confidence: "high" },
      { name: "mkdocs", buildOutput: "site/", buildCommand: "mkdocs build", confidence: "high" },
    ];
    for (const fw of frameworks) {
      const hint = ssgHint(fw);
      expect(hint.code).toBe("ssg_build_output_hint");
      expect(hint.text).toContain(fw.name);
      expect(hint.text).toContain(fw.buildCommand);
      expect(hint.text).toContain(`additionalPaths: ["${fw.buildOutput.replace(/\/$/, "")}"]`);
      expect(hint.detail?.["framework"]).toBe(fw.name);
      expect(hint.detail?.["buildCommand"]).toBe(fw.buildCommand);
    }
  });
});
