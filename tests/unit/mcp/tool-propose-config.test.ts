/**
 * Unit tests for the `propose_config` MCP tool.
 *
 * Five scenarios covering the four cases the config builder
 * recognises (clean scan → minimal, wrappers only, wrappers +
 * build-artifact excludes, wrappers + findings → commented rules
 * stub), plus one zero-findings-zero-wrappers case that proves the
 * honest-empty shape is a syntactically complete `defineConfig({})`
 * with a comment rather than an empty string.
 *
 * Tests drive the handler directly with a scratch filesystem fixture
 * rather than through the MCP protocol — the integration path is
 * exercised by the shared `mcp-tools` integration test.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { proposeConfigTool } from "../../../src/mcp/tool-propose-config.ts";

interface ProposeConfigResponse {
  readonly suggestedConfig: string;
  readonly meta: {
    readonly scanned: { readonly mode: "project"; readonly root: string };
    readonly configSource: string | null;
    readonly filesScanned: number;
    readonly rulesEvaluated: {
      readonly loaded: number;
      readonly withEligibleInputs?: number;
      readonly fired?: number;
    };
    readonly wrappersIncluded: number;
    readonly buildArtifactsIncluded: number;
    readonly likelyBuildPathsIncluded: number;
    readonly topRulesIncluded: number;
  };
  readonly nextStep: string;
  readonly warnings?: readonly string[];
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-propose-config-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function callTool(dir: string): Promise<ProposeConfigResponse> {
  const session = new McpSession();
  const result = await proposeConfigTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "") as ProposeConfigResponse;
}

describe("propose_config: clean scan → minimal config", () => {
  // Guards the zero-findings-zero-wrappers case: the proposal must be
  // a syntactically complete `defineConfig({})` with a comment
  // naming why it's empty, NOT an empty string. Per CLAUDE.md §1
  // "Zero-output success is ambiguous failure" — an empty
  // `suggestedConfig` would read as "tool never ran" to an agent.
  it("emits defineConfig({}) with a clean-scan comment when nothing fires", async () => {
    await withScratch(async (dir) => {
      // A file that produces no findings — a proper <html> with lang,
      // title, and a labeled image. Using a minimal but compliant page
      // so no rule trips.
      await writeFile(
        join(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Hello</title></head><body><p>content</p></body></html>\n',
      );
      const body = await callTool(dir);
      expect(body.suggestedConfig).toContain('import { defineConfig } from "@ra11y/core";');
      expect(body.suggestedConfig).toContain("No overrides needed — scan was clean.");
      expect(body.suggestedConfig).toContain("export default defineConfig({});");
      expect(body.suggestedConfig).not.toContain("nativeWrappers");
      expect(body.suggestedConfig).not.toContain("exclude");
      expect(body.suggestedConfig).not.toContain("rules:");
      expect(body.meta.wrappersIncluded).toBe(0);
      expect(body.meta.buildArtifactsIncluded).toBe(0);
      expect(body.meta.topRulesIncluded).toBe(0);
      expect(body.nextStep).toContain("clean");
      // Trailing newline — paste-ready file content, not a fragment.
      expect(body.suggestedConfig.endsWith("\n")).toBe(true);
    });
  });
});

describe("propose_config: wrappers only", () => {
  // A Button.tsx whose JSX root is a native <button> — the one-hop
  // probe confirms it — and call sites elsewhere. No build artifacts,
  // and the call sites are suppressed by the wrapper so no findings
  // fire either. Proposal carries ONLY the nativeWrappers field.
  it("emits nativeWrappers with only confirmed auto-detected components", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "Button.tsx"),
        "export function Button(props: { onClick: () => void; children: unknown }) {\n" +
          "  return <button onClick={props.onClick}>{props.children}</button>;\n" +
          "}\n",
      );
      await writeFile(
        join(dir, "App.tsx"),
        "import { Button } from './Button';\n" +
          "export const App = () => <Button onClick={() => {}}>hi</Button>;\n",
      );
      const body = await callTool(dir);
      expect(body.meta.wrappersIncluded).toBe(1);
      expect(body.meta.buildArtifactsIncluded).toBe(0);
      expect(body.suggestedConfig).toContain("nativeWrappers: [");
      expect(body.suggestedConfig).toContain('"Button"');
      expect(body.suggestedConfig).not.toContain("exclude:");
      // Shape invariant: array form (all names, no mappings), matching
      // the shared buildNativeWrappersBody output.
      expect(body.suggestedConfig).toMatch(/nativeWrappers: \[\s+"Button",\s+\],/);
      expect(body.nextStep).toContain("1 confirmed wrapper");
    });
  });
});

describe("propose_config: wrappers + build-artifact excludes", () => {
  // Guards the exclude branch: a `definite-*` build-artifact file
  // (here: `.min.` infix in the basename — definite-min-infix) is
  // labeled by `collectBuildArtifacts` and surfaces in the proposed
  // live `exclude` array. Heuristic (`likely-*`) classifications go
  // to the commented `// likelyBuildPaths` block instead — see the
  // sibling describe block "heuristic vs definite split."
  it("emits exclude entries for every definite-classified build artifact", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "Button.tsx"),
        "export function Button(props: { onClick: () => void; children: unknown }) {\n" +
          "  return <button onClick={props.onClick}>{props.children}</button>;\n" +
          "}\n",
      );
      // `.min.` infix in the basename → definite-min-infix.
      // Provable from the path alone, so the entry is paste-safe in
      // the live `exclude: [...]` array.
      await writeFile(join(dir, "vendor.min.js"), "// minified vendor bundle\n");
      const body = await callTool(dir);
      expect(body.meta.buildArtifactsIncluded).toBeGreaterThanOrEqual(1);
      expect(body.suggestedConfig).toContain("exclude: [");
      expect(body.suggestedConfig).toContain("vendor.min.js");
      expect(body.nextStep).toContain("build-artifact path");
    });
  });

  it("emits exclude paths relative to the scan root — no absolute leaked filesystem paths", async () => {
    // Closes Q-SHARED-PROPOSE-CONFIG-RELATIVE-PATHS: prior behaviour
    // emitted `/tmp/<scratch>/vendor.min.js` verbatim, which (a)
    // does not match ra11y's gitignore-style exclude globs so the
    // paste-in config silently does nothing, and (b) leaks the
    // scan-host filesystem into a committed artifact. Relative-only
    // is the honest, portable shape.
    await withScratch(async (dir) => {
      await writeFile(join(dir, "vendor.min.js"), "// minified bundle\n");
      const body = await callTool(dir);
      expect(body.suggestedConfig).toContain("vendor.min.js");
      expect(body.suggestedConfig).not.toContain(dir);
      expect(body.suggestedConfig).not.toMatch(/"\//);
    });
  });

  it("collapses 3+ definite-classified files sharing a top-level directory into a single <dir>/** glob", async () => {
    // Motivating field report: website-templates repo emitted 301
    // absolute `exclude` entries, all under one `dist/`-style tree.
    // Collapsing to a single `<dir>/**` is strictly easier to review
    // and edit than an itemized dump — but the collapse only applies
    // to `definite-*` classifications (paste-safe). Heuristic
    // signals never collapse to `<topdir>/**`; that's the canonical
    // regression the heuristic-vs-definite split fixes.
    await withScratch(async (dir) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "assets"), { recursive: true });
      // Three `.min.`-infix files → all definite-min-infix.
      await writeFile(join(dir, "assets", "a.min.js"), "// min\n");
      await writeFile(join(dir, "assets", "b.min.js"), "// min\n");
      await writeFile(join(dir, "assets", "c.min.js"), "// min\n");
      const body = await callTool(dir);
      expect(body.suggestedConfig).toContain('"assets/**"');
      // Individual entries must NOT appear once the collapse fires —
      // the whole point is that the emitted config is one line, not
      // three.
      expect(body.suggestedConfig).not.toContain('"assets/a.min.js"');
      expect(body.suggestedConfig).not.toContain('"assets/b.min.js"');
      expect(body.suggestedConfig).not.toContain('"assets/c.min.js"');
    });
  });

  it("keeps 2 sibling definite-classified files itemized — below the collapse threshold a wildcard would overreach", async () => {
    // A two-file `assets/` is still specific enough that the
    // unglobbed pair is clearer than `assets/**`. The collapse cap
    // applies only when the count starts to dominate the emitted
    // config.
    await withScratch(async (dir) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "assets"), { recursive: true });
      await writeFile(join(dir, "assets", "a.min.js"), "// min\n");
      await writeFile(join(dir, "assets", "b.min.js"), "// min\n");
      const body = await callTool(dir);
      expect(body.suggestedConfig).toContain('"assets/a.min.js"');
      expect(body.suggestedConfig).toContain('"assets/b.min.js"');
      expect(body.suggestedConfig).not.toContain('"assets/**"');
    });
  });
});

describe("propose_config: heuristic vs definite split — paste-safe `exclude`", () => {
  // Guards "Bootstrap output must be paste-safe" doctrine
  // (`docs/kb/architecture/ai-first-consumer.md`): only
  // `definite-*` build-artifact classifications populate the live
  // `exclude: [...]` array. Heuristic (`likely-*`) classifications
  // — bundler-output dir, hashed-bundle, compiled-tailwind,
  // vendor-banner, long-line-stats — land in a commented-out
  // `// likelyBuildPaths` hint block, individually itemized, so
  // the agent opts in per-path after reading the source.
  //
  // Canonical regression: a `js/` directory with three small files
  // crossing a heuristic threshold collapsed to `js/**`, sweeping
  // every authored module in the project. The split makes that
  // shape unreachable at the generator step.

  it("does NOT emit `js/**` when only heuristic signals fire on files under js/", async () => {
    // Three files under `js/components/` containing Tailwind escape
    // selectors in JSX string literals — but the tailwind probe is
    // gated to .css/.scss/.less paths so it does NOT fire on these
    // .tsx files. We instead simulate the realistic "small repo
    // under js/ tripping a heuristic" shape with files whose names
    // alone would not classify but which a heuristic predicate does
    // catch. We use minified-by-line-stats: a single >500-char line
    // PLUS a high-median-line-length corroborator across siblings.
    await withScratch(async (dir) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "js", "components"), { recursive: true });
      // A long, single-line JS file that crosses the heuristic
      // threshold for `likely-minified-by-line-stats`. Three such
      // files in a directory previously triggered the `js/**`
      // collapse.
      const long = `const data = ${JSON.stringify("x".repeat(800))};`;
      await writeFile(join(dir, "js", "components", "a.js"), long);
      await writeFile(join(dir, "js", "components", "b.js"), long);
      await writeFile(join(dir, "js", "components", "c.js"), long);
      const body = await callTool(dir);
      // The live `exclude: [...]` array must NOT contain `js/**`
      // or any individual `js/components/*.js` entry — they are
      // heuristic-only classifications and the generator must not
      // mechanically paste them into the user's `exclude`.
      expect(body.suggestedConfig).not.toContain('"js/**"');
      expect(body.suggestedConfig).not.toMatch(/^\s+"js\/components\/[abc]\.js"/m);
      // The exclude array, if present at all, must not be the
      // dominant noise from this heuristic-only corpus. Either the
      // exclude block is absent or it carries only paths from
      // `definite-*` classifications (none here).
      const excludeBlockMatch = body.suggestedConfig.match(/exclude: \[([\s\S]*?)\]/);
      if (excludeBlockMatch !== null) {
        expect(excludeBlockMatch[1]).not.toContain("js/");
      }
    });
  });

  it("routes heuristic classifications to the commented `// likelyBuildPaths` block", async () => {
    await withScratch(async (dir) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, "js", "components"), { recursive: true });
      const long = `const data = ${JSON.stringify("x".repeat(800))};`;
      await writeFile(join(dir, "js", "components", "Foo.js"), long);
      const body = await callTool(dir);
      // Hint preamble + commented array marker must both land.
      expect(body.suggestedConfig).toContain("likely-build-paths");
      expect(body.suggestedConfig).toContain("// likelyBuildPaths: [");
      // The path itself rides as a quoted, commented entry —
      // itemized (not glob-collapsed), so the agent reads each
      // path before opting any into `exclude`.
      expect(body.suggestedConfig).toMatch(/\/\/\s+"js\/components\/Foo\.js"/);
      // Every line inside the block is commented — pasting the
      // proposal into ra11y.config.ts must NOT silently exclude
      // any of these heuristic paths.
      const lines = body.suggestedConfig.split("\n");
      const start = lines.findIndex((l) => l.includes("// likelyBuildPaths: ["));
      const end = lines.findIndex((l, i) => i > start && l.includes("// ],"));
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      for (let i = start; i <= end; i += 1) {
        const line = lines[i] ?? "";
        if (line.trim().length === 0) continue;
        expect(line.trimStart().startsWith("//")).toBe(true);
      }
      // Meta carries the per-axis count split — heuristic hints
      // never inflate `buildArtifactsIncluded`.
      expect(body.meta.buildArtifactsIncluded).toBe(0);
      expect(body.meta.likelyBuildPathsIncluded).toBeGreaterThan(0);
    });
  });

  it("definite-min-infix paths still populate the live `exclude` array", async () => {
    // Sanity guard for the corollary: a file with `.min.` infix in
    // the basename is provable from the path alone, classifies as
    // `definite-min-infix`, and lands in the paste-safe `exclude`
    // surface (not the commented hint block). `vendor/` is in the
    // default-excluded artifact-dir-names set so the discovery
    // walk skips it; place the `.min.` file at the repo root so
    // the labeller sees it.
    await withScratch(async (dir) => {
      await writeFile(join(dir, "library.min.js"), "// vendor bundle\n");
      const body = await callTool(dir);
      // Live exclude must carry the `.min.` path. Either as the
      // single entry or via collapse — but the path-substring must
      // appear inside the `exclude: [...]` block, not the
      // commented `likelyBuildPaths` block.
      const excludeBlockMatch = body.suggestedConfig.match(/exclude: \[([\s\S]*?)\]/);
      expect(excludeBlockMatch).not.toBeNull();
      expect(excludeBlockMatch?.[1]).toContain("library.min.js");
      expect(body.meta.buildArtifactsIncluded).toBeGreaterThan(0);
    });
  });

  it("splits a mixed corpus: definite-min-infix to `exclude`, likely-bundler-output-dir to hint block", async () => {
    // A file under `dist/` is `likely-bundler-output-dir`
    // (heuristic — the bundler-dir marker is a path-prefix probe,
    // not a content one). A `.min.` file is `definite-min-infix`.
    // The two must split correctly: definite path in the live
    // exclude array, likely path in the commented hint block.
    await withScratch(async (dir) => {
      const { mkdir } = await import("node:fs/promises");
      // `dist/` is in DEFAULT_EXCLUDED_PATTERNS so the discovery
      // walk skips it; use `public/` which is a build-dir marker
      // but not in the default-excluded set, so the file reaches
      // the labeller.
      await mkdir(join(dir, "public"), { recursive: true });
      await writeFile(
        join(dir, "public", "page.html"),
        "<!doctype html><html><body></body></html>\n",
      );
      // Add a definite-min-infix file at the repo root.
      await writeFile(join(dir, "lib.min.js"), "// minified\n");
      const body = await callTool(dir);
      // Definite path lands in live exclude.
      const excludeBlockMatch = body.suggestedConfig.match(/exclude: \[([\s\S]*?)\]/);
      expect(excludeBlockMatch?.[1]).toContain("lib.min.js");
      // Likely path lands in the commented hint block.
      expect(body.suggestedConfig).toContain("// likelyBuildPaths: [");
      const hintBlockMatch = body.suggestedConfig.match(
        /\/\/ likelyBuildPaths: \[([\s\S]*?)\/\/ \],/,
      );
      expect(hintBlockMatch).not.toBeNull();
      expect(hintBlockMatch?.[1]).toContain("public/");
      // The likely path must NOT appear inside the live exclude
      // block.
      expect(excludeBlockMatch?.[1]).not.toContain("public/");
    });
  });
});

describe("propose_config: wrappers + findings → commented rules stub", () => {
  // Guards the commented-out rules stub: a file that fires several
  // rules must produce the top-3 block, commented out (so paste does
  // not change behavior), with each entry carrying its default
  // severity. Per CLAUDE.md §1 "Surface, don't suppress" — we don't
  // ship auto-downgrades; we ship a paste-ready tuning point.
  it("commented rules stub lists the top-3 most-fired rules with default severity", async () => {
    await withScratch(async (dir) => {
      // A page that deliberately trips multiple rules:
      //   - html-has-lang: <html> without lang
      //   - page-titled: no <title>
      //   - alt-text-missing: multiple <img> without alt
      await writeFile(
        join(dir, "a.html"),
        "<!DOCTYPE html><html><head></head><body>" +
          '<img src="/a.png"><img src="/b.png"><img src="/c.png">' +
          "</body></html>\n",
      );
      const body = await callTool(dir);
      expect(body.meta.topRulesIncluded).toBeGreaterThan(0);
      expect(body.meta.topRulesIncluded).toBeLessThanOrEqual(3);
      // Commented block preamble + closing brace must both land.
      expect(body.suggestedConfig).toContain("// rules: {");
      expect(body.suggestedConfig).toContain("// },");
      // Top-fired rule (alt-text-missing — 3 findings, beats the
      // single-firing title/lang rules) must appear with its default
      // severity and a findings comment.
      expect(body.suggestedConfig).toContain("// ");
      expect(body.suggestedConfig).toMatch(
        /"media\/alt-text-missing":\s*"error",\s*\/\/ 3 findings/,
      );
      // Tuning-guidance comment — paste-ready hint, not prose
      // masquerading as code.
      expect(body.suggestedConfig).toContain("Uncomment + adjust the severity");
      // Every line inside the stub block must be commented so pasting
      // the proposal into ra11y.config.ts does NOT silently change
      // scanner behavior.
      const lines = body.suggestedConfig.split("\n");
      const start = lines.findIndex((l) => l.includes("// rules: {"));
      const end = lines.findIndex((l, i) => i > start && l.includes("// },"));
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      for (let i = start; i <= end; i += 1) {
        const line = lines[i] ?? "";
        // Allow blank lines; non-blank lines inside the block must be
        // commented.
        if (line.trim().length === 0) continue;
        expect(line.trimStart().startsWith("//")).toBe(true);
      }
    });
  });

  // Guards the tie-break contract: when two rules fire the same
  // number of times, they're ordered by rule ID ascending. Deterministic
  // output is load-bearing for review workflows that diff proposals.
  it("breaks ties between equally-fired rules by rule ID ascending", async () => {
    await withScratch(async (dir) => {
      // Two pages, each firing one rule exactly once: one missing the
      // lang attribute (`document/lang-attribute`), one missing a
      // title (`document/page-titled`). Both tally to 1, so the tie-
      // break rule — rule ID ascending — orders
      // `document/lang-attribute` before `document/page-titled`.
      await writeFile(
        join(dir, "a.html"),
        '<!DOCTYPE html><html lang="en"><head></head><body><p>no title</p></body></html>\n',
      );
      await writeFile(
        join(dir, "b.html"),
        "<!DOCTYPE html><html><head><title>x</title></head><body><p>no lang</p></body></html>\n",
      );
      const body = await callTool(dir);
      const langIdx = body.suggestedConfig.indexOf('"document/lang-attribute"');
      const titleIdx = body.suggestedConfig.indexOf('"document/page-titled"');
      // Both rules must appear — a vacuous pass (either index -1)
      // would silently accept a regression that dropped one of them.
      expect(langIdx).toBeGreaterThan(-1);
      expect(titleIdx).toBeGreaterThan(-1);
      // `document/lang-attribute` < `document/page-titled` lexically,
      // so it must appear first in the commented stub.
      expect(langIdx).toBeLessThan(titleIdx);
    });
  });
});

describe("propose_config: zero wrappers, zero build artifacts, zero findings", () => {
  // Guards the honest-empty shape in the presence of a real-but-
  // compliant codebase. Distinct from the "clean scan" test at the top
  // in that this case ships a SOURCE file (not just HTML) so the
  // auto-detect scan ran with teeth — parsing happened, rules
  // evaluated, and none of them fired. The proposal is still a
  // minimal defineConfig({}) because nothing warrants an override.
  it("still emits defineConfig({}) with the clean-scan comment on a real-source clean repo", async () => {
    await withScratch(async (dir) => {
      // A tsx module with no JSX at all — parses, contributes to the
      // scan count, produces no findings and no wrapper candidates.
      await writeFile(
        join(dir, "util.ts"),
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      );
      const body = await callTool(dir);
      expect(body.meta.filesScanned).toBeGreaterThan(0);
      expect(body.meta.wrappersIncluded).toBe(0);
      expect(body.meta.buildArtifactsIncluded).toBe(0);
      expect(body.meta.topRulesIncluded).toBe(0);
      expect(body.suggestedConfig).toContain("No overrides needed — scan was clean.");
      expect(body.suggestedConfig).toContain("export default defineConfig({});");
    });
  });
});

describe("propose_config: foreign-ecosystem detection", () => {
  // Guards the end-to-end wire contract: a Ruby / Python / Go / Rust
  // project root without package.json fires
  // `warnings: ["foreign_ecosystem_detected: <language>"]` and the
  // nextStep hint names the `npx @ra11y/core scan` alternative. The
  // config string itself is unchanged — surface, don't suppress.
  const cases: ReadonlyArray<{ readonly marker: string; readonly tag: string }> = [
    { marker: "Gemfile", tag: "ruby" },
    { marker: "pyproject.toml", tag: "python" },
    { marker: "go.mod", tag: "go" },
    { marker: "Cargo.toml", tag: "rust" },
  ];

  for (const { marker, tag } of cases) {
    it(`emits \`foreign_ecosystem_detected: ${tag}\` when ${marker} is present and package.json is absent`, async () => {
      await withScratch(async (dir) => {
        await writeFile(join(dir, marker), "# minimal stub\n");
        // A trivially-parseable source file so the scan has teeth —
        // otherwise filesScanned: 0 would trip a separate silent-
        // success concern, not the foreign-ecosystem axis under test.
        await writeFile(
          join(dir, "util.ts"),
          "export function add(a: number, b: number): number { return a + b; }\n",
        );
        const body = await callTool(dir);
        expect(body.warnings).toEqual([`foreign_ecosystem_detected: ${tag}`]);
        // Config string is unchanged — the foreign ecosystem is a
        // label, not a filter. The minimal defineConfig({}) still
        // lands because the scan was clean.
        expect(body.suggestedConfig).toContain('import { defineConfig } from "@ra11y/core";');
        // nextStep hint names the alternative `npx @ra11y/core scan`
        // invocation so the agent has a one-shot option that doesn't
        // add a Node toolchain to the repo.
        expect(body.nextStep).toContain("npx @ra11y/core scan");
        expect(body.nextStep).toContain(tag);
      });
    });
  }

  // Guards the package.json short-circuit at the handler level: a
  // mixed stack (say, Rails + JS bundler) is unambiguously Node-aware
  // and must NOT earn the foreign-ecosystem warning. Without this
  // test, a regression that dropped the package.json check would
  // fire on every Rails-plus-webpacker monorepo.
  it("does NOT fire the warning when package.json is present alongside Gemfile", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "Gemfile"), "source 'https://rubygems.org'\n");
      await writeFile(join(dir, "package.json"), '{"name":"x"}\n');
      await writeFile(
        join(dir, "util.ts"),
        "export function add(a: number, b: number): number { return a + b; }\n",
      );
      const body = await callTool(dir);
      expect(body.warnings).toBeUndefined();
      expect(body.nextStep).not.toContain("npx @ra11y/core scan");
    });
  });

  // Guards the omit-on-none shape: a plain Node project (no foreign
  // markers, no package.json either) must NOT emit a `warnings: []`
  // sentinel. Per CLAUDE.md §1 "Ambiguous field shapes are
  // dishonest" — the field is either populated or absent.
  it("omits the warnings field entirely on a clean repo with no foreign markers", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "util.ts"),
        "export function add(a: number, b: number): number { return a + b; }\n",
      );
      const body = await callTool(dir);
      expect(body.warnings).toBeUndefined();
    });
  });
});

describe("propose_config: meta telemetry", () => {
  // Guards the scan-confidence telemetry contract: every response
  // carries scanned, configSource, filesScanned, rulesEvaluated
  // so the agent can cross-check against scan_project without a
  // second round-trip. Per CLAUDE.md §1 "Verbose meta is signal."
  it("populates scanned, filesScanned, and rulesEvaluated on every response", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body></body></html>\n',
      );
      const body = await callTool(dir);
      expect(body.meta.scanned).toEqual({ mode: "project", root: dir });
      expect(body.meta.configSource).toBeNull();
      expect(body.meta.filesScanned).toBe(1);
      expect(body.meta.rulesEvaluated.loaded).toBeGreaterThan(0);
      // propose_config scans only to derive top-rule frequencies and
      // doesn't retain the per-rule coverage array, so the derived
      // sub-counters are omitted (conditional-spread).
      expect("withEligibleInputs" in body.meta.rulesEvaluated).toBe(false);
      expect("fired" in body.meta.rulesEvaluated).toBe(false);
    });
  });

  // Guards the cwd existence gate: a nonexistent cwd must hard-error
  // rather than silently return a clean-scan proposal (the zero-
  // output-success-is-ambiguous-failure pattern CLAUDE.md §1 warns
  // against).
  it("hard-errors with code cwd-not-found when cwd does not exist on disk", async () => {
    const session = new McpSession();
    const result = await proposeConfigTool.handler(
      { cwd: "/nonexistent/path/that/does/not/exist-xyz123" },
      session,
    );
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { code?: string };
    expect(payload.code).toBe("cwd-not-found");
  });
});
