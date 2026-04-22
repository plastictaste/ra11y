/**
 * Unit tests for `src/mcp/build-artifacts.ts` — the deterministic
 * compiled-CSS / bundler-output classifier surfaced as
 * `meta.scannedBuildArtifacts: { path, reason }[]` on `scan_project`
 * responses.
 *
 * Two directions:
 *   1. Each signal (`.min.` infix, long minified line, hashed-
 *      filename infix, bundler-output path ancestry, sibling `.map`
 *      sourcemap, `data:image/` data-URL inline, escaped-bracket
 *      Tailwind selector) maps to its named {@link
 *      BuildArtifactReason} AND only on its named condition. Over-
 *      labeling a hand-written stylesheet would push the agent to
 *      investigate non-generated code, the expensive failure mode.
 *   2. Sass partials (`_variables.scss`, `_mixins.scss`) must NOT be
 *      labeled as artifacts — the leading `_` is the Sass partial
 *      convention for authored source, not a generated-artifact
 *      signal. Regression guard: without this test the mistake can
 *      re-enter on a future refactor.
 *   3. `collectBuildArtifacts` returns an empty array (not `[{}]`,
 *      `[null]`, or a placeholder) when no file in the batch
 *      matches. The caller conditional-spreads on that emptiness; a
 *      subtle "always return a list with one element" bug would
 *      silently emit `scannedBuildArtifacts: [{ path: "" }]`.
 *   4. First-match semantics: when two signals would match the same
 *      path, the documented evaluation order picks one reason and
 *      the entry appears once (not twice). The classifier's "label
 *      must survive inspection" doctrine bar requires a single
 *      falsifiable verdict per path.
 */

import { describe, expect, it } from "bun:test";
import {
  classifyBuildArtifact,
  collectBuildArtifacts,
  isBuildArtifact,
} from "../../../src/mcp/build-artifacts.ts";

describe("classifyBuildArtifact — Sass-partial NEGATIVE cases (regression guard)", () => {
  it("does NOT classify `_variables.scss` just because the filename starts with `_`", () => {
    // Bootstrap-style authored partial: the leading underscore is the
    // Sass partial convention, not a generated-artifact signal.
    const source = "$primary: #0d6efd;\n$secondary: #6c757d;\n";
    expect(classifyBuildArtifact("scss/_variables.scss", source)).toBe(null);
  });

  it("does NOT classify `_mixins.scss` authored at the repo root", () => {
    const source = "@mixin button-variant($bg) {\n  background-color: $bg;\n}\n";
    expect(classifyBuildArtifact("_mixins.scss", source)).toBe(null);
  });

  it("does NOT classify `_style.scss` even when the file is several thousand lines", () => {
    // Bootstrap's authored `_variables.scss` is ~2000 lines of `$var`
    // declarations across many short lines. The minified detector
    // requires a single line over the threshold so this stays below
    // the bar.
    const source = Array.from({ length: 2500 }, (_, i) => `$token-${i}: #ffffff;`).join("\n");
    expect(classifyBuildArtifact("scss/_style.scss", source)).toBe(null);
  });

  it("does NOT classify a hand-written `_forms.scss` under a nested directory", () => {
    const source = ".form-control { padding: 0.5rem; }\n";
    expect(classifyBuildArtifact("site/assets/scss/_forms.scss", source)).toBe(null);
  });
});

describe("classifyBuildArtifact — `minified` reason", () => {
  it("classifies `bootstrap.min.css` as a minified distribution bundle", () => {
    expect(classifyBuildArtifact("vendor/bootstrap.min.css", ".a{}")).toBe("minified");
  });

  it("classifies `jquery.min.js` at the repo root", () => {
    expect(classifyBuildArtifact("jquery.min.js", "!function(){}();")).toBe("minified");
  });

  it("classifies `vendor.min.js` under an arbitrary directory", () => {
    expect(classifyBuildArtifact("assets/js/vendor.min.js", "/* min */")).toBe("minified");
  });

  it("classifies a file whose source has a single line over the 500-char threshold", () => {
    // Hand-authored stylesheets and scripts wrap lines for
    // readability; minified bundles emit one or a handful of long
    // lines. A single 600-char run is unambiguous output.
    const longLine = `.a{color:red;}`.repeat(50); // ~700 chars on one line
    expect(classifyBuildArtifact("vendor/some-bundle.css", longLine)).toBe("minified");
  });

  it("does NOT classify a file whose lines stay under the threshold even if total source is large", () => {
    // 2000 short lines of authored CSS, no single line over 500 chars.
    const source = Array.from({ length: 2000 }, () => ".btn { padding: 0.5rem; }").join("\n");
    expect(classifyBuildArtifact("src/styles/components.css", source)).toBe(null);
  });

  it("does NOT classify a directory literally named `min.css` containing an authored file", () => {
    // Basename-only probe — a `min.css` directory cannot fool the match
    // into thinking the file inside was minified.
    expect(classifyBuildArtifact("assets/min.css/index.html", "<p>x</p>")).toBe(null);
  });

  it("does NOT classify a filename missing the `.min.` infix (e.g. `minimal.css`)", () => {
    expect(classifyBuildArtifact("src/styles/minimal.css", ".a{}")).toBe(null);
  });
});

describe("classifyBuildArtifact — `hashed-filename` reason", () => {
  it("classifies `app.a1b2c3d4.js` (8-char hex hash between dots)", () => {
    expect(classifyBuildArtifact("assets/app.a1b2c3d4.js", "// bundle")).toBe("hashed-filename");
  });

  it("classifies `chunk.0123abcdef.css` (10-char hex hash)", () => {
    expect(classifyBuildArtifact("assets/chunk.0123abcdef.css", ".a{}")).toBe("hashed-filename");
  });

  it("classifies `vendor.deadbeefcafebabe.mjs` (long hex run)", () => {
    expect(classifyBuildArtifact("assets/vendor.deadbeefcafebabe.mjs", "export {};")).toBe(
      "hashed-filename",
    );
  });

  it("does NOT classify filenames with a too-short hex run (e.g. 7 chars)", () => {
    expect(classifyBuildArtifact("assets/app.abcdef1.js", "// src")).toBe(null);
  });

  it("does NOT classify `README.md` or `index.html` (no hex run between dots)", () => {
    expect(classifyBuildArtifact("README.md", "# Title")).toBe(null);
    expect(classifyBuildArtifact("index.html", "<html></html>")).toBe(null);
  });

  it("does NOT classify a hex run that is not flanked by dots (e.g. at the start)", () => {
    // `abcdef12.js` has no leading dot before the hex run; the probe
    // requires dots on both sides so this stays unmatched. Keeps the
    // signal anchored to the "generated segment inside a filename"
    // shape rather than every-hex-token-ever.
    expect(classifyBuildArtifact("assets/abcdef12.js", "// src")).toBe(null);
  });
});

describe("classifyBuildArtifact — `dist-path` reason (bundler-output path ancestry)", () => {
  it("classifies a path under `/dist/`", () => {
    expect(classifyBuildArtifact("/proj/dist/main.css", ".a {}")).toBe("dist-path");
  });

  it("classifies a path under `/build/`", () => {
    expect(classifyBuildArtifact("/proj/build/out.css", ".a {}")).toBe("dist-path");
  });

  it("classifies a path under `/_site/` (Jekyll output)", () => {
    expect(classifyBuildArtifact("/proj/_site/index.html", "<html></html>")).toBe("dist-path");
  });

  it("classifies a path under `/public/` (Hugo / Nuxt generated tree)", () => {
    expect(classifyBuildArtifact("/proj/public/main.css", ".a {}")).toBe("dist-path");
  });

  it("classifies a path under `/node_modules/`", () => {
    expect(classifyBuildArtifact("/proj/node_modules/react/umd/react.js", "/* umd */")).toBe(
      "dist-path",
    );
  });

  it("classifies a path under `/.next/`", () => {
    expect(classifyBuildArtifact("/proj/.next/static/css/app.css", ".a {}")).toBe("dist-path");
  });

  it("classifies a path under `/.svelte-kit/`", () => {
    expect(classifyBuildArtifact("/proj/.svelte-kit/output/client.css", ".a {}")).toBe(
      "dist-path",
    );
  });

  it("classifies a path under `/.output/`", () => {
    expect(classifyBuildArtifact("/proj/.output/public/_nuxt/entry.css", ".a {}")).toBe(
      "dist-path",
    );
  });

  it("classifies a path under `/static/assets/`", () => {
    expect(classifyBuildArtifact("/proj/app/static/assets/index.css", ".a {}")).toBe("dist-path");
  });

  it("does NOT classify a root-level file literally named `dist.ts`", () => {
    // The marker probe requires a trailing `/` so a file named
    // `dist.ts` or `build.md` at the repo root is not mislabeled.
    expect(classifyBuildArtifact("/proj/dist.ts", "const x = 1;")).toBe(null);
  });

  it("does NOT classify a source file under `/src/` with no other signals", () => {
    expect(classifyBuildArtifact("/proj/src/components/Button.tsx", "export const x = 1;")).toBe(
      null,
    );
  });

  it("normalizes Windows-style backslashes so `\\dist\\` is recognized", () => {
    expect(classifyBuildArtifact("C:\\proj\\dist\\main.css", ".a {}")).toBe("dist-path");
  });
});

describe("classifyBuildArtifact — `contains-data-url-gradient` reason", () => {
  it("classifies a CSS file containing `url(data:image/svg+xml,...)`", () => {
    const source =
      ".bg-icon { background: url(data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F...%22%2F%3E); }";
    expect(classifyBuildArtifact("vendor/styles.css", source)).toBe("contains-data-url-gradient");
  });

  it("classifies a `.scss` file containing `url(data:image/png;base64,...)`", () => {
    const source = ".gradient { background: url(data:image/png;base64,iVBORw0KGgoAAAA…); }";
    expect(classifyBuildArtifact("assets/scss/icons.scss", source)).toBe(
      "contains-data-url-gradient",
    );
  });

  it("does NOT classify a CSS file with a non-image data URL (e.g. inline web font)", () => {
    // `data:application/font-woff2` is normal `@font-face` shape, not
    // an image-blob inline. The probe is anchored to `data:image/`
    // specifically so this hand-authored case stays unflagged.
    const source =
      "@font-face { src: url(data:application/font-woff2;base64,d09GMgABAAAA…) format('woff2'); }";
    expect(classifyBuildArtifact("src/fonts.css", source)).toBe(null);
  });

  it("does NOT classify a JSX file mentioning `url(data:image/`...) as a string literal", () => {
    // The probe is gated to `.css` / `.scss` paths because a JSX
    // string literal carrying `data:image/...` is asset-builder
    // code, not compiled CSS output.
    const source = 'const url = "url(data:image/png;base64,...)";';
    expect(classifyBuildArtifact("src/Component.tsx", source)).toBe(null);
  });
});

describe("classifyBuildArtifact — `tailwind-compiled-escape` reason", () => {
  it("classifies a CSS file containing a `.w-\\[400px\\]` utility selector (pixel width)", () => {
    const source = ".w-\\[400px\\] { width: 400px; }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("tailwind-compiled-escape");
  });

  it("classifies `.h-\\[2rem\\]` utility selector (rem height)", () => {
    const source = ".h-\\[2rem\\] { height: 2rem; }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("tailwind-compiled-escape");
  });

  it("classifies `.w-\\[50%\\]` utility selector (percentage)", () => {
    const source = ".w-\\[50%\\] { width: 50%; }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("tailwind-compiled-escape");
  });

  it("classifies `.focus-visible\\:ring-2` utility (escaped-colon form)", () => {
    // The Tailwind variant form emits `.focus-visible\:` — the escape
    // pattern probes for `\:focus-visible:` which matches the
    // compiler's actual output (`.group\:focus-visible:etc`).
    const source = ".group\\:focus-visible:before { outline: 2px solid blue; }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("tailwind-compiled-escape");
  });

  it("classifies `.bg-\\[--color\\]` CSS-variable utility", () => {
    const source = ".bg-\\[--my-color\\] { background-color: var(--my-color); }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("tailwind-compiled-escape");
  });

  it("does NOT classify hand-written CSS with a normal attribute selector like `[role='button']`", () => {
    const source = "[role='button'] { cursor: pointer; }\n.card { padding: 1rem; }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe(null);
  });

  it("does NOT classify escaped-bracket-like patterns inside a JSX source (pattern gated to .css paths)", () => {
    // A JSX file can carry `.w-\[400px\]` as a className literal; that
    // is Tailwind *usage*, not compiled output. The detector must not
    // label the TSX file as a build artifact.
    const source = 'const x = <div className="w-\\[400px\\]" />;';
    expect(classifyBuildArtifact("src/Component.tsx", source)).toBe(null);
  });
});

describe("classifyBuildArtifact — first-match evaluation order", () => {
  it("prefers `minified` over `dist-path` when both signals fire", () => {
    // `dist/jquery.min.js` matches both the `.min.` infix and the
    // `dist/` directory marker. The documented order has `minified`
    // first because it's the more specific verdict — the agent
    // reading "minified" knows immediately why and doesn't need to
    // reconcile two reasons.
    expect(classifyBuildArtifact("dist/jquery.min.js", "/* min */")).toBe("minified");
  });

  it("prefers `hashed-filename` over `dist-path` when both signals fire", () => {
    expect(classifyBuildArtifact("dist/app.a1b2c3d4.js", "// bundle")).toBe("hashed-filename");
  });

  it("prefers `dist-path` over `contains-data-url-gradient` when both signals fire", () => {
    // A file under `dist/` with a data URL is more usefully reported
    // as a dist-path artifact (the directory tells the agent the
    // entire tree is generated) than as a single-line content match.
    const source = ".bg { background: url(data:image/svg+xml,...); }";
    expect(classifyBuildArtifact("dist/main.css", source)).toBe("dist-path");
  });
});

describe("isBuildArtifact (convenience predicate)", () => {
  it("returns true when classifyBuildArtifact returns a reason", () => {
    expect(isBuildArtifact("vendor/bootstrap.min.css", ".a{}")).toBe(true);
  });

  it("returns false when classifyBuildArtifact returns null", () => {
    expect(isBuildArtifact("scss/_variables.scss", "$primary: #0d6efd;")).toBe(false);
  });
});

describe("collectBuildArtifacts — sibling `.map` sourcemap signal", () => {
  it("labels `app.js` with reason `sourcemap-sibling` when `app.js.map` is also in the scanned set", () => {
    const files = [
      { filePath: "dist-out/app.js", source: "// bundled code" },
      { filePath: "dist-out/app.js.map", source: '{"version":3}' },
    ];
    // Both files sit outside the BUILD_DIR_MARKERS set ("dist-out/"
    // is not "dist/") so the label has to come from the sibling-map
    // signal, not a path probe.
    expect(collectBuildArtifacts(files)).toEqual([
      { path: "dist-out/app.js", reason: "sourcemap-sibling" },
    ]);
  });

  it("excludes the `.map` file itself from the returned set", () => {
    const files = [
      { filePath: "out/main.css", source: ".a{}" },
      { filePath: "out/main.css.map", source: '{"version":3}' },
    ];
    const labeled = collectBuildArtifacts(files);
    expect(labeled.map((entry) => entry.path)).toContain("out/main.css");
    expect(labeled.map((entry) => entry.path)).not.toContain("out/main.css.map");
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

  it("prefers a per-file reason over `sourcemap-sibling` when both would fire on the same path", () => {
    // `vendor/jquery.min.js` matches the `.min.` infix AND has a
    // sibling `.map`. The per-file classifier runs first, so the
    // entry carries `minified` (the more specific verdict) and is
    // not duplicated.
    const files = [
      { filePath: "vendor/jquery.min.js", source: "!function(){}();" },
      { filePath: "vendor/jquery.min.js.map", source: '{"version":3}' },
    ];
    const labeled = collectBuildArtifacts(files);
    expect(labeled).toEqual([{ path: "vendor/jquery.min.js", reason: "minified" }]);
  });
});

describe("collectBuildArtifacts", () => {
  it("returns the subset of files that match any signal as `{ path, reason }` records, preserving input order", () => {
    const files = [
      { filePath: "src/Component.tsx", source: "export const x = 1;" },
      { filePath: "app/styles.css", source: ".w-\\[400px\\] { width: 400px; }" },
      { filePath: "src/styles.css", source: ".card { padding: 1rem; }" },
      { filePath: "dist/main.css", source: "/* compiled */" },
      { filePath: "vendor/jquery.min.js", source: "!function(){}();" },
    ];
    expect(collectBuildArtifacts(files)).toEqual([
      { path: "app/styles.css", reason: "tailwind-compiled-escape" },
      { path: "dist/main.css", reason: "dist-path" },
      { path: "vendor/jquery.min.js", reason: "minified" },
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
