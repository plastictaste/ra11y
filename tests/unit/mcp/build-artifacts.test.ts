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
  BASENAME_GROUP_THRESHOLD,
  classifyBuildArtifact,
  collectBuildArtifacts,
  groupBuildArtifactsByBasename,
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
    expect(classifyBuildArtifact("/proj/.svelte-kit/output/client.css", ".a {}")).toBe("dist-path");
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

describe("groupBuildArtifactsByBasename — grouped shape (Q6-SCANNED-BUILD-ARTIFACTS-GROUP-BY-BASENAME)", () => {
  it("collapses a ≥3-path same-basename cluster under one group with a paste-ready suggestedGlob", () => {
    // The field-report case: a bootstrap repo emits the same
    // `bootstrap.css` under three themed subtrees. Under the flat
    // shape the agent saw three individual paths; under the grouped
    // shape the three collapse to one inspect-once row with a
    // `suggestedGlob` that covers every member.
    const entries = [
      { path: "/root/dist/5.0/bootstrap.css", reason: "dist-path" as const },
      { path: "/root/dist/5.1/bootstrap.css", reason: "dist-path" as const },
      { path: "/root/dist/5.2/bootstrap.css", reason: "dist-path" as const },
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped).toEqual([
      {
        basename: "bootstrap.css",
        count: 3,
        pathHint: "dist/",
        reasons: ["dist-path"],
        suggestedGlob: "dist/**/bootstrap.css",
      },
    ]);
    expect(out.ungrouped).toEqual([]);
  });

  it("keeps sub-threshold same-basename entries in `ungrouped` with reasons preserved", () => {
    // Two paths share a basename but fall below the grouping
    // threshold. Zero information loss: the full `{ path, reason }`
    // record survives under `ungrouped` so an agent can still read
    // the per-path classification.
    const entries = [
      { path: "/root/dist/a.min.css", reason: "minified" as const },
      { path: "/root/dist/other/a.min.css", reason: "minified" as const },
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped).toEqual([]);
    expect(out.ungrouped).toEqual([
      { path: "dist/a.min.css", reason: "minified" },
      { path: "dist/other/a.min.css", reason: "minified" },
    ]);
  });

  it("sorts grouped entries by count descending with ties broken by basename alphabetical", () => {
    // Three groups: one of size 5 (font-awesome.css), one of size 3
    // (app.css), one of size 3 (bootstrap.css). The size-5 leads;
    // the two size-3 groups appear in basename order.
    const mk = (name: string, n: number): ReadonlyArray<{ path: string; reason: "dist-path" }> =>
      Array.from({ length: n }, (_, i) => ({
        path: `/root/dist/v${i}/${name}`,
        reason: "dist-path" as const,
      }));
    const entries = [...mk("bootstrap.css", 3), ...mk("font-awesome.css", 5), ...mk("app.css", 3)];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped.map((g) => g.basename)).toEqual([
      "font-awesome.css",
      "app.css",
      "bootstrap.css",
    ]);
  });

  it("sorts ungrouped entries by path alphabetical", () => {
    // Three distinct singletons below threshold — each enters
    // `ungrouped` and the output sorts deterministically regardless
    // of input order.
    const entries = [
      { path: "/root/z/one.css", reason: "dist-path" as const },
      { path: "/root/a/two.css", reason: "dist-path" as const },
      { path: "/root/m/three.css", reason: "dist-path" as const },
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.ungrouped.map((e) => e.path)).toEqual(["a/two.css", "m/three.css", "z/one.css"]);
  });

  it("dedupes and sorts `reasons` when members of one group carry multiple classifier reasons", () => {
    // Mixed-reason group: `dist-path` and `minified` both fire
    // across the three members. The `reasons` field surfaces both
    // so the agent reading `reasons: ["dist-path", "minified"]`
    // knows the group isn't monolithic.
    const entries = [
      { path: "/root/dist/a/lib.css", reason: "dist-path" as const },
      { path: "/root/dist/b/lib.css", reason: "minified" as const },
      { path: "/root/dist/c/lib.css", reason: "dist-path" as const },
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped[0].reasons).toEqual(["dist-path", "minified"]);
  });

  it("computes a directory-boundary pathHint, never a partial-basename prefix", () => {
    // Two directories share a non-directory prefix (`vendor/bo`).
    // The pathHint must stop at the last `/` so the suggestedGlob
    // stays a legal glob and never over-captures unrelated files.
    const entries = [
      { path: "/root/vendor/bootstrap/x.css", reason: "dist-path" as const },
      { path: "/root/vendor/bose-theme/x.css", reason: "dist-path" as const },
      { path: "/root/vendor/boxy/x.css", reason: "dist-path" as const },
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped[0].pathHint).toBe("vendor/");
    expect(out.grouped[0].suggestedGlob).toBe("vendor/**/x.css");
  });

  it("emits empty `pathHint` + repo-wide suggestedGlob when group members share no directory", () => {
    // The three members sit under different top-level dirs, so the
    // longest shared prefix is the empty string. The suggestedGlob
    // degrades to `**/<basename>` — still a legal exclude entry,
    // just repo-wide. The agent sees this and can tighten the glob
    // manually if needed.
    const entries = [
      { path: "/root/dist/a.css", reason: "dist-path" as const },
      { path: "/root/build/a.css", reason: "dist-path" as const },
      { path: "/root/public/a.css", reason: "dist-path" as const },
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped[0].pathHint).toBe("");
    expect(out.grouped[0].suggestedGlob).toBe("**/a.css");
  });

  it("returns an empty envelope on zero input (honest shape on clean scans)", () => {
    // The caller conditional-spreads the whole meta field on
    // presence (`buildArtifacts.present`), so this function itself
    // returns `{ grouped: [], ungrouped: [] }` when called with no
    // entries — no sentinel `null`, no thrown error.
    expect(groupBuildArtifactsByBasename([], "/root")).toEqual({ grouped: [], ungrouped: [] });
  });

  it("drops paths that escape the scan root (meaningless as exclude entries)", () => {
    // Symlinked sources or paths outside the scanned project would
    // produce `../`-prefixed relative paths — these don't match
    // ra11y's gitignore-style excludes and their suggestedGlob
    // would leak `..` segments. The helper drops them rather than
    // surface a broken pattern.
    const entries = [
      { path: "/outside/a.css", reason: "dist-path" as const },
      { path: "/root/dist/a/b.css", reason: "dist-path" as const },
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    const allPaths = [...out.grouped.map((g) => g.basename), ...out.ungrouped.map((e) => e.path)];
    expect(allPaths).not.toContain("a.css");
    expect(out.ungrouped.map((e) => e.path)).toEqual(["dist/a/b.css"]);
  });

  it("normalizes Windows-style backslashes in paths to POSIX separators", () => {
    // The scanner emits whatever separators the host gave us. The
    // grouper normalizes so `pathHint` / `suggestedGlob` read the
    // same on macOS and Windows CI, matching the POSIX convention
    // `propose_config` uses downstream.
    const entries = [
      { path: "C:\\root\\dist\\v1\\lib.css", reason: "dist-path" as const },
      { path: "C:\\root\\dist\\v2\\lib.css", reason: "dist-path" as const },
      { path: "C:\\root\\dist\\v3\\lib.css", reason: "dist-path" as const },
    ];
    const out = groupBuildArtifactsByBasename(entries, "C:\\root");
    expect(out.grouped[0].pathHint).toBe("dist/");
    expect(out.grouped[0].suggestedGlob).toBe("dist/**/lib.css");
  });

  it("uses the shared 3-entry threshold — a 2-entry cluster stays ungrouped, a 3-entry cluster groups", () => {
    // Regression guard on the threshold constant: match the
    // precedent set by `tool-propose-config.ts`'s
    // EXCLUDE_GLOB_COLLAPSE_THRESHOLD. A test asserting the
    // constant ensures future edits stay aligned with the paired
    // exclude-collapse logic.
    expect(BASENAME_GROUP_THRESHOLD).toBe(3);
    const two = [
      { path: "/root/a/x.css", reason: "dist-path" as const },
      { path: "/root/b/x.css", reason: "dist-path" as const },
    ];
    expect(groupBuildArtifactsByBasename(two, "/root").grouped).toEqual([]);
    const three = [...two, { path: "/root/c/x.css", reason: "dist-path" as const }];
    expect(groupBuildArtifactsByBasename(three, "/root").grouped.length).toBe(1);
  });
});
