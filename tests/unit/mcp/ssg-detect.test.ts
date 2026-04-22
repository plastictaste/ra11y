/**
 * Unit tests for `src/mcp/ssg-detect.ts` — the root-level static-site-
 * generator probe that `scan_project` uses to surface
 * `meta.detectedFramework` + an `analysisCoverage.hints` entry nudging
 * the agent toward the "build the site, then scan the rendered output"
 * workflow.
 *
 * Invariants under test:
 *   1. Each canonical config marker in isolation resolves to the
 *      expected framework tag + build output + build command. Jekyll's
 *      `_config.yml` additionally requires a corroborating signal
 *      (`_layouts/`, `_includes/`, `_posts/`, `_drafts/`, or a
 *      jekyll-mentioning Gemfile) — the filename alone is too ambiguous
 *      to confidently classify (bare `_config.yml` files ship in
 *      unrelated templates and ecosystem dumps).
 *   2. Hugo's legacy `config.toml` only resolves when it carries a
 *      `[markup]` section header — a bare `config.toml` (ambiguous
 *      with Rust workspaces) returns `null`.
 *   3. A clean repo with no markers returns `null` so the caller can
 *      conditional-spread the field away.
 *   4. `ssgHint` embeds the framework tag inline and names the
 *      `additionalPaths` argument the agent copies into a follow-up
 *      scan call.
 *   5. Declaration order breaks ties deterministically (first marker
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
    it(`resolves ${marker} → ${name} with build output "${buildOutput}" and command "${buildCommand}"`, async () => {
      await withScratch(async (dir) => {
        await writeFile(join(dir, marker), body);
        expect(detectSsgFramework(dir)).toEqual({ name, buildOutput, buildCommand });
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

describe("detectSsgFramework: jekyll requires corroborating signal", () => {
  // `_config.yml` alone is too weak: third-party site templates,
  // ecosystem dumps, and unrelated YAML-config tools ship a stray
  // top-level `_config.yml`. A confident `detectedFramework: "jekyll"`
  // on filename alone is overconfident-from-weak-evidence (same class
  // as the closed Q3 template-directive misdetect). The detector
  // requires `_config.yml` AND at least one of:
  //   (a) a `_layouts/` directory
  //   (b) an `_includes/` directory
  //   (c) a top-level `_posts/` directory
  //   (d) a top-level `_drafts/` directory
  //   (e) a Gemfile mentioning `jekyll`
  // When only `_config.yml` is present, the detector returns null so
  // the caller can omit `detectedFramework` and let the agent inspect.
  // (Per the AI-first doctrine, surfacing a confident wrong answer is
  // worse than surfacing nothing — `null` here is honest, not
  // suppression: the evidence is genuinely insufficient for the
  // classification, and the corroborated path always resolves.)

  it("returns null for a bare _config.yml with no jekyll-shaped neighbours", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      expect(detectSsgFramework(dir)).toBeNull();
    });
  });

  it("resolves _config.yml + _layouts/ to jekyll", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_layouts"));
      expect(detectSsgFramework(dir)).toEqual({
        name: "jekyll",
        buildOutput: "_site/",
        buildCommand: "bundle exec jekyll build",
      });
    });
  });

  it("resolves _config.yml + _includes/ to jekyll", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_includes"));
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
    });
  });

  it("resolves _config.yml + _posts/ to jekyll", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_posts"));
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
    });
  });

  it("resolves _config.yml + _drafts/ to jekyll", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await mkdir(join(dir, "_drafts"));
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
    });
  });

  it("resolves _config.yml + Gemfile mentioning jekyll to jekyll", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await writeFile(
        join(dir, "Gemfile"),
        'source "https://rubygems.org"\ngem "jekyll", "~> 4.3"\n',
      );
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("jekyll");
    });
  });

  it("returns null for _config.yml + Gemfile that does NOT mention jekyll", async () => {
    // A Ruby project with a stray YAML config file but a non-jekyll
    // Gemfile (rails, sinatra, plain bundler) is not a Jekyll site.
    // Filename + presence-of-Gemfile alone is not enough; the Gemfile
    // must reference the gem.
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await writeFile(
        join(dir, "Gemfile"),
        'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
      );
      expect(detectSsgFramework(dir)).toBeNull();
    });
  });

  it("returns null when a corroborating path exists but is a regular file (not directory)", async () => {
    // `_layouts` as a stray text file (some unrelated template might
    // ship one) does not corroborate Jekyll — the directory shape
    // matters, since Jekyll resolves layouts by reading children.
    await withScratch(async (dir) => {
      await writeFile(join(dir, "_config.yml"), "title: My site\n");
      await writeFile(join(dir, "_layouts"), "not a directory\n");
      expect(detectSsgFramework(dir)).toBeNull();
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
  it("resolves config.toml with a [markup] section header to hugo", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "config.toml"),
        'baseURL = "https://example.org/"\n\n[markup]\n  [markup.goldmark]\n    [markup.goldmark.renderer]\n      unsafe = true\n',
      );
      const result = detectSsgFramework(dir);
      expect(result?.name).toBe("hugo");
      expect(result?.buildOutput).toBe("public/");
      expect(result?.buildCommand).toBe("hugo");
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

describe("ssgHint", () => {
  // Guards the wire-level shape. Agents reading the hint prose may
  // key off the framework tag and the additionalPaths argument, so
  // both must appear inline and in the expected format.
  it("embeds the framework tag, build command, and quoted additionalPaths argument", () => {
    const framework: DetectedFramework = {
      name: "jekyll",
      buildOutput: "_site/",
      buildCommand: "bundle exec jekyll build",
    };
    const hint = ssgHint(framework);
    expect(hint).toContain("jekyll");
    expect(hint).toContain("bundle exec jekyll build");
    // The trailing slash on buildOutput is stripped from the
    // additionalPaths argument — agents pasting the value into a
    // `string[]` do not want a trailing slash because the scanner
    // normalizes input paths either way and an un-trimmed path
    // reads as a typo on the review diff.
    expect(hint).toContain('additionalPaths: ["_site"]');
    expect(hint).not.toContain('"_site/"');
  });

  it("works symmetrically for every framework the detector returns", () => {
    // Compact smoke test — guards against a future reshuffle that
    // accidentally names one framework's output in another's hint.
    const frameworks: readonly DetectedFramework[] = [
      { name: "hugo", buildOutput: "public/", buildCommand: "hugo" },
      { name: "astro", buildOutput: "dist/", buildCommand: "astro build" },
      { name: "eleventy", buildOutput: "_site/", buildCommand: "npx @11ty/eleventy" },
      { name: "gatsby", buildOutput: "public/", buildCommand: "gatsby build" },
      { name: "mkdocs", buildOutput: "site/", buildCommand: "mkdocs build" },
    ];
    for (const fw of frameworks) {
      const hint = ssgHint(fw);
      expect(hint).toContain(fw.name);
      expect(hint).toContain(fw.buildCommand);
      expect(hint).toContain(`additionalPaths: ["${fw.buildOutput.replace(/\/$/, "")}"]`);
    }
  });
});
