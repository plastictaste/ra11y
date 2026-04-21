/**
 * Unit tests for `src/mcp/build-artifacts.ts` — the deterministic
 * compiled-CSS / bundler-output labeller surfaced as
 * `meta.scannedBuildArtifacts` on `scan_project` responses.
 *
 * Two directions:
 *   1. Each signal (escaped-bracket Tailwind selector, `.min.`
 *      infix, hashed-filename infix, bundler-output path
 *      ancestry, sibling `.map` sourcemap) fires on its named
 *      condition AND only on its named condition — over-labeling a
 *      hand-written stylesheet would push the agent to investigate
 *      non-generated code, the expensive failure mode.
 *   2. Sass partials (`_variables.scss`, `_mixins.scss`) must NOT be
 *      labeled as artifacts — the leading `_` is the Sass partial
 *      convention for authored source, not a generated-artifact
 *      signal. Regression guard: without this test the mistake can
 *      re-enter on a future refactor.
 *   3. `collectBuildArtifacts` returns an empty array (not `[""]`,
 *      `[null]`, or a placeholder) when no file in the batch
 *      matches. The caller conditional-spreads on that emptiness; a
 *      subtle "always return a list with one element" bug would
 *      silently emit `scannedBuildArtifacts: [""]`.
 */

import { describe, expect, it } from "bun:test";
import { collectBuildArtifacts, isBuildArtifact } from "../../../src/mcp/build-artifacts.ts";

describe("isBuildArtifact — Sass-partial NEGATIVE cases (regression guard)", () => {
  it("does NOT flag `_variables.scss` just because the filename starts with `_`", () => {
    // Bootstrap-style authored partial: the leading underscore is the
    // Sass partial convention, not a generated-artifact signal.
    const source = "$primary: #0d6efd;\n$secondary: #6c757d;\n";
    expect(isBuildArtifact("scss/_variables.scss", source)).toBe(false);
  });

  it("does NOT flag `_mixins.scss` authored at the repo root", () => {
    const source = "@mixin button-variant($bg) {\n  background-color: $bg;\n}\n";
    expect(isBuildArtifact("_mixins.scss", source)).toBe(false);
  });

  it("does NOT flag `_style.scss` even when the file is several thousand lines", () => {
    // Bootstrap's authored `_variables.scss` is ~2000 lines of `$var`
    // declarations. A raw line-count threshold would misfire here; the
    // new classifier has no such threshold.
    const source = Array.from({ length: 2500 }, (_, i) => `$token-${i}: #ffffff;`).join("\n");
    expect(isBuildArtifact("scss/_style.scss", source)).toBe(false);
  });

  it("does NOT flag a hand-written `_forms.scss` under a nested directory", () => {
    const source = ".form-control { padding: 0.5rem; }\n";
    expect(isBuildArtifact("site/assets/scss/_forms.scss", source)).toBe(false);
  });
});

describe("isBuildArtifact — `.min.` infix signal", () => {
  it("flags `bootstrap.min.css` as a minified distribution bundle", () => {
    expect(isBuildArtifact("vendor/bootstrap.min.css", ".a{}")).toBe(true);
  });

  it("flags `jquery.min.js` at the repo root", () => {
    expect(isBuildArtifact("jquery.min.js", "!function(){}();")).toBe(true);
  });

  it("flags `vendor.min.js` under an arbitrary directory", () => {
    expect(isBuildArtifact("assets/js/vendor.min.js", "/* min */")).toBe(true);
  });

  it("does NOT flag a directory literally named `min.css` containing an authored file", () => {
    // Basename-only probe — a `min.css` directory cannot fool the match
    // into thinking the file inside was minified.
    expect(isBuildArtifact("assets/min.css/index.html", "<p>x</p>")).toBe(false);
  });

  it("does NOT flag a filename missing the `.min.` infix (e.g. `minimal.css`)", () => {
    expect(isBuildArtifact("src/styles/minimal.css", ".a{}")).toBe(false);
  });
});

describe("isBuildArtifact — hashed-filename signal", () => {
  it("flags `app.a1b2c3d4.js` (8-char hex hash between dots)", () => {
    expect(isBuildArtifact("assets/app.a1b2c3d4.js", "// bundle")).toBe(true);
  });

  it("flags `chunk.0123abcdef.css` (10-char hex hash)", () => {
    expect(isBuildArtifact("assets/chunk.0123abcdef.css", ".a{}")).toBe(true);
  });

  it("flags `vendor.deadbeefcafebabe.mjs` (long hex run)", () => {
    expect(isBuildArtifact("assets/vendor.deadbeefcafebabe.mjs", "export {};")).toBe(true);
  });

  it("does NOT flag filenames with a too-short hex run (e.g. 7 chars)", () => {
    expect(isBuildArtifact("assets/app.abcdef1.js", "// src")).toBe(false);
  });

  it("does NOT flag `README.md` or `index.html` (no hex run between dots)", () => {
    expect(isBuildArtifact("README.md", "# Title")).toBe(false);
    expect(isBuildArtifact("index.html", "<html></html>")).toBe(false);
  });

  it("does NOT flag a hex run that is not flanked by dots (e.g. at the start)", () => {
    // `abcdef12.js` has no leading dot before the hex run; the probe
    // requires dots on both sides so this stays unmatched. Keeps the
    // signal anchored to the "generated segment inside a filename"
    // shape rather than every-hex-token-ever.
    expect(isBuildArtifact("assets/abcdef12.js", "// src")).toBe(false);
  });
});

describe("isBuildArtifact — bundler-output path ancestry signal", () => {
  it("flags a path under `/dist/`", () => {
    expect(isBuildArtifact("/proj/dist/main.css", ".a {}")).toBe(true);
  });

  it("flags a path under `/build/`", () => {
    expect(isBuildArtifact("/proj/build/out.css", ".a {}")).toBe(true);
  });

  it("flags a path under `/_site/` (Jekyll output)", () => {
    expect(isBuildArtifact("/proj/_site/index.html", "<html></html>")).toBe(true);
  });

  it("flags a path under `/public/` (Hugo / Nuxt generated tree)", () => {
    expect(isBuildArtifact("/proj/public/main.css", ".a {}")).toBe(true);
  });

  it("flags a path under `/node_modules/`", () => {
    expect(isBuildArtifact("/proj/node_modules/react/umd/react.js", "/* umd */")).toBe(true);
  });

  it("flags a path under `/.next/`", () => {
    expect(isBuildArtifact("/proj/.next/static/css/app.css", ".a {}")).toBe(true);
  });

  it("flags a path under `/.svelte-kit/`", () => {
    expect(isBuildArtifact("/proj/.svelte-kit/output/client.css", ".a {}")).toBe(true);
  });

  it("flags a path under `/.output/`", () => {
    expect(isBuildArtifact("/proj/.output/public/_nuxt/entry.css", ".a {}")).toBe(true);
  });

  it("flags a path under `/static/assets/`", () => {
    expect(isBuildArtifact("/proj/app/static/assets/index.css", ".a {}")).toBe(true);
  });

  it("does NOT flag a root-level file literally named `dist.ts`", () => {
    // The marker probe requires a trailing `/` so a file named
    // `dist.ts` or `build.md` at the repo root is not mislabeled.
    expect(isBuildArtifact("/proj/dist.ts", "const x = 1;")).toBe(false);
  });

  it("does NOT flag a source file under `/src/` with no other signals", () => {
    expect(isBuildArtifact("/proj/src/components/Button.tsx", "export const x = 1;")).toBe(false);
  });

  it("normalizes Windows-style backslashes so `\\dist\\` is recognized", () => {
    expect(isBuildArtifact("C:\\proj\\dist\\main.css", ".a {}")).toBe(true);
  });
});

describe("isBuildArtifact — escape-bracket Tailwind selector signal", () => {
  it("matches a `.w-\\[400px\\]` utility selector (pixel width)", () => {
    const source = ".w-\\[400px\\] { width: 400px; }\n";
    expect(isBuildArtifact("app/styles.css", source)).toBe(true);
  });

  it("matches a `.h-\\[2rem\\]` utility selector (rem height)", () => {
    const source = ".h-\\[2rem\\] { height: 2rem; }\n";
    expect(isBuildArtifact("app/styles.css", source)).toBe(true);
  });

  it("matches a `.w-\\[50%\\]` utility selector (percentage)", () => {
    const source = ".w-\\[50%\\] { width: 50%; }\n";
    expect(isBuildArtifact("app/styles.css", source)).toBe(true);
  });

  it("matches a `.focus-visible\\:ring-2` utility (escaped-colon form)", () => {
    // The Tailwind variant form emits `.focus-visible\:` — the escape
    // pattern probes for `\:focus-visible:` which matches the
    // compiler's actual output (`.group\:focus-visible:etc`).
    const source = ".group\\:focus-visible:before { outline: 2px solid blue; }\n";
    expect(isBuildArtifact("app/styles.css", source)).toBe(true);
  });

  it("matches a `.bg-\\[--color\\]` CSS-variable utility", () => {
    const source = ".bg-\\[--my-color\\] { background-color: var(--my-color); }\n";
    expect(isBuildArtifact("app/styles.css", source)).toBe(true);
  });

  it("does NOT match hand-written CSS with a normal attribute selector like `[role='button']`", () => {
    const source = "[role='button'] { cursor: pointer; }\n.card { padding: 1rem; }\n";
    expect(isBuildArtifact("app/styles.css", source)).toBe(false);
  });

  it("does NOT match escaped-bracket-like patterns inside a JSX source (pattern gated to .css paths)", () => {
    // A JSX file can carry `.w-\[400px\]` as a className literal; that
    // is Tailwind *usage*, not compiled output. The detector must not
    // label the TSX file as a build artifact.
    const source = 'const x = <div className="w-\\[400px\\]" />;';
    expect(isBuildArtifact("src/Component.tsx", source)).toBe(false);
  });
});

describe("collectBuildArtifacts — sibling `.map` sourcemap signal", () => {
  it("labels `app.js` when `app.js.map` is also in the scanned set", () => {
    const files = [
      { filePath: "dist-out/app.js", source: "// bundled code" },
      { filePath: "dist-out/app.js.map", source: '{"version":3}' },
    ];
    // Both files sit outside the BUILD_DIR_MARKERS set ("dist-out/"
    // is not "dist/") so the label has to come from the sibling-map
    // signal, not a path probe.
    expect(collectBuildArtifacts(files)).toEqual(["dist-out/app.js"]);
  });

  it("excludes the `.map` file itself from the returned set", () => {
    const files = [
      { filePath: "out/main.css", source: ".a{}" },
      { filePath: "out/main.css.map", source: '{"version":3}' },
    ];
    const labeled = collectBuildArtifacts(files);
    expect(labeled).toContain("out/main.css");
    expect(labeled).not.toContain("out/main.css.map");
  });

  it("does NOT label a source whose would-be `.map` sibling lives in a different directory", () => {
    // Match is by full path plus `.map`, so a same-basename `.map` in
    // another directory does not pair.
    const files = [
      { filePath: "src/app.js", source: "// authored" },
      { filePath: "unrelated/app.js.map", source: '{"version":3}' },
    ];
    expect(collectBuildArtifacts(files)).toEqual([]);
  });
});

describe("collectBuildArtifacts", () => {
  it("returns the subset of files that match any signal, preserving input order", () => {
    const files = [
      { filePath: "src/Component.tsx", source: "export const x = 1;" },
      { filePath: "app/styles.css", source: ".w-\\[400px\\] { width: 400px; }" },
      { filePath: "src/styles.css", source: ".card { padding: 1rem; }" },
      { filePath: "dist/main.css", source: "/* compiled */" },
      { filePath: "vendor/jquery.min.js", source: "!function(){}();" },
    ];
    expect(collectBuildArtifacts(files)).toEqual([
      "app/styles.css",
      "dist/main.css",
      "vendor/jquery.min.js",
    ]);
  });

  it("returns an empty array when no file matches — callers conditional-spread on this", () => {
    const files = [
      { filePath: "src/Component.tsx", source: "export const x = 1;" },
      { filePath: "src/styles.css", source: ".card { padding: 1rem; }" },
      { filePath: "scss/_variables.scss", source: "$primary: #0d6efd;" },
    ];
    expect(collectBuildArtifacts(files)).toEqual([]);
  });

  it("returns an empty array for an empty input batch (honest shape on zero-file scans)", () => {
    expect(collectBuildArtifacts([])).toEqual([]);
  });
});
