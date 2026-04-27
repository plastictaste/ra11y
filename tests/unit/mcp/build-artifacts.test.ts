/**
 * Unit tests for `src/mcp/build-artifacts.ts` — the
 * compiled-CSS / bundler-output classifier surfaced as
 * `meta.scannedBuildArtifacts: { path, classification, signal }[]`
 * on `scan_project` responses.
 *
 * Tests below pin the confidence-graded
 * {@link BuildArtifactClassification} enum that replaced the previous
 * deterministic-sounding `reason` token. Predicates whose verdict is
 * provable from the path or live scan set alone emit `definite-*`
 * (`definite-min-infix`, `definite-sourcemap-paired`); heuristic
 * predicates emit `likely-*` (`likely-minified-by-line-stats`,
 * `likely-hashed-bundle`, `likely-bundler-output-dir`,
 * `likely-compiled-tailwind`).
 *
 * Two directions:
 *   1. Each signal (`.min.` infix, long minified line, hashed-
 *      filename infix, bundler-output path ancestry, sibling `.map`
 *      sourcemap, escaped-bracket Tailwind selector) maps to its
 *      named {@link BuildArtifactClassification} AND only on its
 *      named condition. Over-labeling a hand-written stylesheet
 *      would push the agent to investigate non-generated code, the
 *      expensive failure mode.
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
 *      path, the documented evaluation order picks one classification
 *      and the entry appears once (not twice). The classifier's
 *      "label must survive inspection" doctrine bar requires a
 *      single falsifiable verdict per path.
 */

import { describe, expect, it } from "bun:test";
import {
  BASENAME_GROUP_THRESHOLD,
  type BuildArtifactClassification,
  type BuildArtifactSignal,
  classifyBuildArtifact,
  classifyBuildArtifactDetailed,
  collectBuildArtifacts,
  detectVendorLibraries,
  groupBuildArtifactsByBasename,
  isBuildArtifact,
  isDefiniteBuildArtifactClassification,
  type ScannedBuildArtifact,
} from "../../../src/mcp/build-artifacts.ts";

/**
 * Stub signal used by `groupBuildArtifactsByBasename` tests that
 * exercise grouping/sorting/relativization logic — the signal field
 * is required by the {@link ScannedBuildArtifact} type but the group
 * helpers don't read its contents (only `path` + `classification`
 * participate in clustering and the aggregated `classifications`
 * field). Centralized here so future additions to the
 * {@link BuildArtifactSignal} union don't force a shotgun edit
 * across the synthetic test entries.
 */
const STUB_SIGNAL = {
  kind: "build-dir-segment",
  value: "dist/",
} as const satisfies BuildArtifactSignal;

/**
 * Build a synthetic `{ path, classification, signal }` entry for the
 * grouping tests. The signal defaults to {@link STUB_SIGNAL} for
 * `likely-bundler-output-dir` entries and to a `min-infix`
 * placeholder for `definite-min-infix` entries — both are
 * deterministic and inert as far as the grouping helper is
 * concerned. Tests that assert on `signal` shape construct entries
 * inline; this helper is for cases where the signal is incidental.
 */
function mkEntry(
  path: string,
  classification: BuildArtifactClassification,
  signal: BuildArtifactSignal = classification === "definite-min-infix"
    ? { kind: "min-infix", value: path.split("/").pop() ?? path }
    : STUB_SIGNAL,
): ScannedBuildArtifact {
  return { path, classification, signal };
}

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

describe("classifyBuildArtifact — minified-shaped classifications", () => {
  it("classifies `bootstrap.min.css` as `definite-min-infix` (path-anchored)", () => {
    expect(classifyBuildArtifact("vendor/bootstrap.min.css", ".a{}")).toBe("definite-min-infix");
  });

  it("classifies `jquery.min.js` at the repo root as `definite-min-infix`", () => {
    expect(classifyBuildArtifact("jquery.min.js", "!function(){}();")).toBe("definite-min-infix");
  });

  it("classifies `vendor.min.js` under an arbitrary directory as `definite-min-infix`", () => {
    expect(classifyBuildArtifact("assets/js/vendor.min.js", "/* min */")).toBe(
      "definite-min-infix",
    );
  });

  it("classifies a content-shape minified source as `likely-minified-by-line-stats`", () => {
    // Hand-authored stylesheets and scripts wrap lines for
    // readability; minified bundles emit one or a handful of long
    // lines. A single ~700-char run with median = 700 corroborates,
    // but the verdict is content-shaped (not path-anchored), so the
    // confidence-graded classification carries a `likely-` prefix.
    const longLine = `.a{color:red;}`.repeat(50); // ~700 chars on one line
    expect(classifyBuildArtifact("vendor/some-bundle.css", longLine)).toBe(
      "likely-minified-by-line-stats",
    );
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

// the single-long-line
// probe on its own mis-labeled authored Astro/Starlight template-literal
// props, Google-Maps iframe URLs, SCSS type signatures, and MDX prop
// bundles. The classifier now gates the `likely-minified-by-line-stats`
// verdict on a second-tier corroborator (long-line ratio ≥ 25% OR median
// line length > 500).: the
// classification carries a `likely-` prefix because the predicate is
// content-shape heuristic — even with the corroborator the verdict is
// not path-anchored. These tests lock the NEGATIVE direction: one long
// line amid many short lines must NOT label.
describe("classifyBuildArtifact — single-long-line second-probe corroboration", () => {
  it("does NOT classify a TSX file whose ONE line over 500 chars sits amid ~50 short authored lines", () => {
    // Shape modeled on Astro `<Example code={`…`}/>` where a multi-tag
    // HTML preview lives on one prop line. Short lines around it drag
    // the median well below the threshold and the long-line ratio to
    // ~2%, so neither corroborator fires and the file stays unlabeled.
    const shortLines = Array.from({ length: 49 }, (_, i) => `const x${i} = ${i};`);
    const longLine = `const html = "${"abc".repeat(200)}";`; // ~620 chars
    const source = [...shortLines, longLine].join("\n");
    expect(classifyBuildArtifact("src/components/Preview.tsx", source)).toBe(null);
  });

  it("does NOT classify an HTML file whose ONE iframe-src line crosses 500 chars amid short authored markup", () => {
    // Website-templates shape: a contact page with a Google-Maps
    // iframe whose URL is long, surrounded by ordinary multi-line
    // HTML. One long line out of ~40 → ratio ~3%, median ~30 chars
    // → neither corroborator fires.
    const shortLines = Array.from({ length: 39 }, (_, i) => `  <p>Short paragraph ${i}.</p>`);
    const iframe = `  <iframe src="https://example.com/?q=${"abc".repeat(180)}"></iframe>`;
    const source = [
      "<!doctype html>",
      "<html><body>",
      ...shortLines,
      iframe,
      "</body></html>",
    ].join("\n");
    expect(classifyBuildArtifact("contact.html", source)).toBe(null);
  });

  it("does NOT classify an SCSS-shape file whose ONE long line is a type signature amid authored rules", () => {
    // SCSS function body shape — the function's signature line can
    // stretch past 500 chars via a long `@return` type chain, but
    // the rest of the file is hand-written. Extension is `.scss`
    // (the CSS probes gate to .css / .scss so this is an authored
    // SCSS file, not a compiled bundle).
    const shortLines = Array.from({ length: 50 }, (_, i) => `.token-${i} { color: red; }`);
    const longSig = `@function compute-token($a, $b, $c, $d, $e, $f) { @return ${"aaaaa, ".repeat(75)}end; }`;
    const source = [...shortLines, longSig].join("\n");
    expect(classifyBuildArtifact("src/_functions.scss", source)).toBe(null);
  });

  it("classifies a CSS bundle whose median line length crosses the threshold (one-enormous-line shape)", () => {
    // Canonical minified-JS/CSS shape: one 700-char line, no newlines.
    // 1 line total, 1 long → median = 700, ratio = 100% → corroborated.
    const source = `.a{color:red;}`.repeat(50);
    expect(classifyBuildArtifact("vendor/some-bundle.css", source)).toBe(
      "likely-minified-by-line-stats",
    );
  });

  it("classifies a CSS bundle whose long-line ratio crosses 25% (multi-long-line shape)", () => {
    // Four long lines out of sixteen → 25% ratio corroborates; median
    // sits below the cap because 12 of the 16 lines are short, so it
    // is the RATIO predicate — not the median — that fires.
    const shortLines = Array.from({ length: 12 }, () => ".btn { padding: 0.5rem; }");
    const longLines = Array.from(
      { length: 4 },
      (_, i) => `.rule-${i} { ${"color:red;".repeat(55)} }`,
    );
    const source = [...shortLines, ...longLines].join("\n");
    expect(classifyBuildArtifact("vendor/multi.css", source)).toBe("likely-minified-by-line-stats");
  });

  it("does NOT classify a TSX file whose long-line ratio stays under 25% (just under the floor)", () => {
    // 3 long lines out of 16 → 18.75% — below the 25% floor. Median
    // stays under 500 too (13 of the 16 lines are short). Neither
    // corroborator fires so the file stays unlabeled, matching the
    // doctrine that a few dense lines in authored code are not
    // minification evidence.
    const shortLines = Array.from({ length: 13 }, (_, i) => `const short${i} = ${i};`);
    const longLines = Array.from({ length: 3 }, (_, i) => `const big${i} = "${"x".repeat(600)}";`);
    const source = [...shortLines, ...longLines].join("\n");
    expect(classifyBuildArtifact("src/prefs.tsx", source)).toBe(null);
  });

  it("treats CRLF line breaks the same as LF (minified bundle with Windows-style newlines still labels)", () => {
    // Regression guard: the line-stats helper must fold CRLF pairs so
    // a Windows-authored or Windows-checked-out bundle reports the
    // same line stats as a POSIX one. Source is one 700-char run
    // plus a trailing CRLF — still one line, median 700, corroborates.
    const source = `${".a{color:red;}".repeat(50)}\r\n`;
    expect(classifyBuildArtifact("vendor/windows-bundle.css", source)).toBe(
      "likely-minified-by-line-stats",
    );
  });

  it("does NOT classify a completely empty source (zero lines → no corroboration)", () => {
    // Degenerate empty-input guard: computeLineStats returns
    // totalLines = 0, and the corroborator caller treats that as "no
    // evidence" rather than dividing by zero.
    expect(classifyBuildArtifact("src/empty.css", "")).toBe(null);
  });

  // the ratio corroborator
  // requires ≥3 long lines, not just `longLineCount/totalLines >= 0.25`.
  // Without the count floor, a tiny authored file with one >500-char
  // line satisfies the ratio at exactly `1/4 = 0.25` and gets
  // mis-labeled `minified`, training agents to skip authored source.
  // The four shapes below are the canonical small-file false-positive
  // cases (real-world fixtures pin the same invariant at the harness
  // layer; these unit tests pin the predicate boundary).
  it("does NOT classify a 4-line HTML whose ONE >500-char line concatenates SRI preload links (1/4 ratio FP)", () => {
    // Vanilla-JS shape: a 4-line authored page where the `<head>` line
    // concatenates several `<link rel="preload" integrity="sha512-...">`
    // tags. One long line out of 4 = 25% ratio — must NOT corroborate
    // under the count-floor predicate.
    const long = `<link integrity="sha512-${"A".repeat(120)}"><link integrity="sha512-${"B".repeat(120)}"><link integrity="sha512-${"C".repeat(120)}">`;
    const source = ["<!doctype html>", "<html><head>", long, "</head></html>"].join("\n");
    expect(classifyBuildArtifact("index.html", source)).toBe(null);
  });

  it("does NOT classify a 4-line HTML whose ONE >500-char line is an inline-SVG path (1/4 ratio FP)", () => {
    // Landing-page shape: a 4-line authored file where the `<svg>` line
    // carries a long `<path d="...">` command sequence. One long line
    // out of 4 = 25% ratio — must NOT corroborate.
    const long = `<svg><path d="M${"1.234,5.678 ".repeat(60)}Z"/></svg>`;
    const source = ["<!doctype html>", "<html><body>", long, "</body></html>"].join("\n");
    expect(classifyBuildArtifact("logo.html", source)).toBe(null);
  });

  it("does NOT classify a 4-line CSS file whose ONE >500-char line is a long calc()/var() bundle (1/4 ratio FP)", () => {
    // Design-system token-module shape (also covers SCSS function-body
    // type signatures, since the harness reads source content + path,
    // not extension semantics). One long line out of 4 = 25% ratio —
    // must NOT corroborate.
    const long = `.scale { --x: calc(${Array.from({ length: 30 }, (_, i) => `var(--v${i}) * 1px`).join(" + ")}); }`;
    const source = [
      ":root { --a: 1; }",
      long,
      ".token-a { color: red; }",
      ".token-b { color: blue; }",
    ].join("\n");
    expect(classifyBuildArtifact("tokens.css", source)).toBe(null);
  });

  it("does NOT classify a 4-line file with TWO long lines (2/4 ratio = 50% but still under the count floor)", () => {
    // Even at 50% ratio, two long lines is below the count floor of 3.
    // The pure-one-line minified-JS bundle case is still covered by the
    // median check; the ratio predicate only carries weight when several
    // long lines exist (canonical minified-CSS shape).
    const long = `${"a".repeat(600)}`;
    const source = [".btn { padding: 0.5rem; }", long, ".x { color: red; }", long].join("\n");
    expect(classifyBuildArtifact("src/prefs.css", source)).toBe(null);
  });
});

describe("classifyBuildArtifact — `likely-hashed-bundle` classification", () => {
  it("classifies `app.a1b2c3d4.js` (8-char hex hash between dots)", () => {
    expect(classifyBuildArtifact("assets/app.a1b2c3d4.js", "// bundle")).toBe(
      "likely-hashed-bundle",
    );
  });

  it("classifies `chunk.0123abcdef.css` (10-char hex hash)", () => {
    expect(classifyBuildArtifact("assets/chunk.0123abcdef.css", ".a{}")).toBe(
      "likely-hashed-bundle",
    );
  });

  it("classifies `vendor.deadbeefcafebabe.mjs` (long hex run)", () => {
    expect(classifyBuildArtifact("assets/vendor.deadbeefcafebabe.mjs", "export {};")).toBe(
      "likely-hashed-bundle",
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

describe("classifyBuildArtifact — `likely-bundler-output-dir` classification (path ancestry)", () => {
  it("classifies a path under `/dist/`", () => {
    expect(classifyBuildArtifact("/proj/dist/main.css", ".a {}")).toBe("likely-bundler-output-dir");
  });

  it("classifies a path under `/build/`", () => {
    expect(classifyBuildArtifact("/proj/build/out.css", ".a {}")).toBe("likely-bundler-output-dir");
  });

  it("classifies a path under `/_site/` (Jekyll output)", () => {
    expect(classifyBuildArtifact("/proj/_site/index.html", "<html></html>")).toBe(
      "likely-bundler-output-dir",
    );
  });

  it("classifies a path under `/public/` (Hugo / Nuxt generated tree)", () => {
    expect(classifyBuildArtifact("/proj/public/main.css", ".a {}")).toBe(
      "likely-bundler-output-dir",
    );
  });

  it("classifies a path under `/node_modules/`", () => {
    expect(classifyBuildArtifact("/proj/node_modules/react/umd/react.js", "/* umd */")).toBe(
      "likely-bundler-output-dir",
    );
  });

  it("classifies a path under `/.next/`", () => {
    expect(classifyBuildArtifact("/proj/.next/static/css/app.css", ".a {}")).toBe(
      "likely-bundler-output-dir",
    );
  });

  it("classifies a path under `/.svelte-kit/`", () => {
    expect(classifyBuildArtifact("/proj/.svelte-kit/output/client.css", ".a {}")).toBe(
      "likely-bundler-output-dir",
    );
  });

  it("classifies a path under `/.output/`", () => {
    expect(classifyBuildArtifact("/proj/.output/public/_nuxt/entry.css", ".a {}")).toBe(
      "likely-bundler-output-dir",
    );
  });

  it("classifies a path under `/static/assets/`", () => {
    expect(classifyBuildArtifact("/proj/app/static/assets/index.css", ".a {}")).toBe(
      "likely-bundler-output-dir",
    );
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
    expect(classifyBuildArtifact("C:\\proj\\dist\\main.css", ".a {}")).toBe(
      "likely-bundler-output-dir",
    );
  });
});

describe("classifyBuildArtifact — data-URL CSS predicate retired (regression guard)", () => {
  // The retired `likely-vendored-data-url-css` classification used to
  // fire on any `.css` / `.scss` source containing the literal
  // `url(data:image/` substring. The predicate failed the
  // ai-first-consumer doctrine bar ("Heuristic-mislabeled meta
  // sub-fields are dishonest") because hand-authored SCSS stylesheets
  // routinely inline tiny SVG mask icons and base64 gradients in
  // design-system token files — a 1350-line authored `_icons.scss`
  // with embedded data-URL gradients was the field-report shape that
  // forced the deletion. These tests pin the deletion: a bare
  // `data:image/` occurrence in CSS source must NOT classify.
  it("does NOT classify a CSS file containing `url(data:image/svg+xml,...)` on content alone", () => {
    const source =
      ".bg-icon { background: url(data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F...%22%2F%3E); }";
    expect(classifyBuildArtifact("vendor/styles.css", source)).toBe(null);
  });

  it("does NOT classify a hand-authored `.scss` partial with embedded data-URL gradients", () => {
    // Canonical false-positive shape from the field: a design-system
    // `_icons.scss` token file inlines a base64 PNG/SVG gradient as a
    // compact background. The agent reading the file sees authored
    // SCSS rules around it; the classifier must not pre-empt that read
    // with a deterministic-sounding "vendored" label.
    const source = "@mixin gradient { background: url(data:image/png;base64,iVBORw0KGgoAAAA…); }";
    expect(classifyBuildArtifact("scss/_icons.scss", source)).toBe(null);
  });

  it("does NOT classify a CSS file with a non-image data URL (e.g. inline web font)", () => {
    // Carryover negative: `data:application/font-woff2` is normal
    // `@font-face` shape and was already untouched by the retired
    // predicate. Pin it here so a future detector re-introducing a
    // data-URL probe can't silently widen scope.
    const source =
      "@font-face { src: url(data:application/font-woff2;base64,d09GMgABAAAA…) format('woff2'); }";
    expect(classifyBuildArtifact("src/fonts.css", source)).toBe(null);
  });

  it("does NOT classify a JSX file mentioning `url(data:image/`...) as a string literal", () => {
    // Carryover negative: a JSX string literal carrying
    // `data:image/...` is asset-builder code, not compiled CSS output.
    const source = 'const url = "url(data:image/png;base64,...)";';
    expect(classifyBuildArtifact("src/Component.tsx", source)).toBe(null);
  });

  it("classifies a CSS file under `dist/` with an inline data-URL via the path predicate (no content credit)", () => {
    // A CSS file under `dist/` with a data-URL still classifies — but
    // the verdict comes from the path predicate
    // (`likely-bundler-output-dir`), not the retired content marker.
    // The agent reading `signal.kind: "build-dir-segment"` sees that
    // the directory is the falsifiable evidence; the data-URL is
    // incidental.
    const source = ".bg { background: url(data:image/svg+xml,...); }";
    expect(classifyBuildArtifact("dist/main.css", source)).toBe("likely-bundler-output-dir");
  });
});

describe("classifyBuildArtifact — SVG single-line authoring norm (regression guard)", () => {
  // Single-line is the canonical SVG authoring shape: a hand-authored
  // brand SVG is one well-formed `<svg ...>...</svg>` element, often
  // exported from a design tool with no inter-tag whitespace. Under
  // the shared `likely-minified-by-line-stats` predicate the whole
  // body becomes one line over the 500-char threshold, totalLines = 1,
  // and `medianLineLength` equals the entire content's length — the
  // median corroborator fires trivially. The classifier must NOT
  // stamp `likely-minified-by-line-stats` on these files; the only
  // honest closure is to skip the long-line probe on `.svg` entirely
  // and let path predicates carry whatever evidence survives.
  it("does NOT classify a hand-authored single-line brand SVG even when its one line crosses 500 chars", () => {
    // Brand-asset shape: one `<svg>` element with several `<path>` /
    // `<g>` children, exported as a single line. Length is well over
    // the 500-char single-long-line probe threshold.
    const path = "M".concat("1.234,5.678 ".repeat(60), "Z");
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${path}"/></svg>`;
    // Sanity — the source MUST cross the long-line threshold so the
    // assertion isn't vacuously testing a short file.
    expect(source.length).toBeGreaterThan(500);
    expect(classifyBuildArtifact("assets/logo.svg", source)).toBe(null);
  });

  it("does NOT classify a 200-char inline brand SVG (well under the threshold but single-line)", () => {
    // Compact inline brand SVG — the whole element is on one line,
    // around the size of a typical icon. The classifier should be
    // null here too: nothing in path or content earns a label.
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>';
    expect(classifyBuildArtifact("src/icons/dot.svg", source)).toBe(null);
  });

  it("does NOT classify a single-line uppercase-extension `.SVG` either (case-insensitive gate)", () => {
    // Windows / design-tool exports sometimes use uppercase `.SVG`.
    // The extension gate is case-insensitive; this case must follow.
    const path = "M".concat("1,2 ".repeat(150), "Z");
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${path}"/></svg>`;
    expect(source.length).toBeGreaterThan(500);
    expect(classifyBuildArtifact("assets/Logo.SVG", source)).toBe(null);
  });

  it("classifies an SVG under `dist/` via the path predicate (path evidence still credits)", () => {
    // Sanity: the SVG gate only suppresses the content-shape
    // `likely-minified-by-line-stats` probe. SVGs under canonical
    // bundler-output directories still classify on path evidence,
    // matching the doctrine bar — the directory is provable from the
    // path alone.
    const source = "<svg><path d='M0,0 Z'/></svg>";
    expect(classifyBuildArtifact("dist/icons/sprite.svg", source)).toBe(
      "likely-bundler-output-dir",
    );
  });

  it("classifies a `.min.svg` via the min-infix predicate (path evidence still credits)", () => {
    // Sanity: a `.min.` infix on an SVG basename still earns
    // `definite-min-infix` — the predicate is path-anchored and
    // independent of the content-shape probe.
    const source = "<svg><path d='M0,0 Z'/></svg>";
    expect(classifyBuildArtifact("public/logo.min.svg", source)).toBe("definite-min-infix");
  });
});

describe("classifyBuildArtifact — `likely-compiled-tailwind` classification", () => {
  it("classifies a CSS file containing a `.w-\\[400px\\]` utility selector (pixel width)", () => {
    const source = ".w-\\[400px\\] { width: 400px; }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("likely-compiled-tailwind");
  });

  it("classifies `.h-\\[2rem\\]` utility selector (rem height)", () => {
    const source = ".h-\\[2rem\\] { height: 2rem; }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("likely-compiled-tailwind");
  });

  it("classifies `.w-\\[50%\\]` utility selector (percentage)", () => {
    const source = ".w-\\[50%\\] { width: 50%; }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("likely-compiled-tailwind");
  });

  it("classifies `.focus-visible\\:ring-2` utility (escaped-colon form)", () => {
    // The Tailwind variant form emits `.focus-visible\:` — the escape
    // pattern probes for `\:focus-visible:` which matches the
    // compiler's actual output (`.group\:focus-visible:etc`).
    const source = ".group\\:focus-visible:before { outline: 2px solid blue; }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("likely-compiled-tailwind");
  });

  it("classifies `.bg-\\[--color\\]` CSS-variable utility", () => {
    const source = ".bg-\\[--my-color\\] { background-color: var(--my-color); }\n";
    expect(classifyBuildArtifact("app/styles.css", source)).toBe("likely-compiled-tailwind");
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
  it("prefers `definite-min-infix` over `likely-bundler-output-dir` when both signals fire", () => {
    // `dist/jquery.min.js` matches both the `.min.` infix and the
    // `dist/` directory marker. The documented order has min-infix
    // first because it's the more specific (path-anchored) verdict —
    // the agent reading "definite-min-infix" knows immediately why
    // and doesn't need to reconcile two classifications.
    expect(classifyBuildArtifact("dist/jquery.min.js", "/* min */")).toBe("definite-min-infix");
  });

  it("prefers `likely-hashed-bundle` over `likely-bundler-output-dir` when both signals fire", () => {
    expect(classifyBuildArtifact("dist/app.a1b2c3d4.js", "// bundle")).toBe("likely-hashed-bundle");
  });

  it("prefers `likely-bundler-output-dir` over the content-shape long-line probe when both apply", () => {
    // A CSS file under `dist/` whose body is one minified-shape long
    // line is reported as `likely-bundler-output-dir` — the path
    // predicate is checked first and is the more specific (path-
    // anchored) verdict, so the agent reads one classification, not
    // two reconciled.
    const source = `.a{${"x".repeat(600)}}`;
    expect(classifyBuildArtifact("dist/main.css", source)).toBe("likely-bundler-output-dir");
  });
});

// the `definite-` /
// `likely-` confidence prefix is the doctrine-aligned shape — agents
// budget per-file investigation by reading the prefix without
// reconciling individual variant strings. The helper exposes the
// contract so future variants don't drift.
describe("isDefiniteBuildArtifactClassification — confidence-prefix contract", () => {
  it("returns true for `definite-min-infix` (path-anchored verdict)", () => {
    expect(isDefiniteBuildArtifactClassification("definite-min-infix")).toBe(true);
  });

  it("returns true for `definite-sourcemap-paired` (paired-map verdict)", () => {
    expect(isDefiniteBuildArtifactClassification("definite-sourcemap-paired")).toBe(true);
  });

  it("returns true for `definite-vendor-distribution` (sibling-min OR sourcemap-pointer-min)", () => {
    expect(isDefiniteBuildArtifactClassification("definite-vendor-distribution")).toBe(true);
  });

  it("returns false for every `likely-*` heuristic classification", () => {
    expect(isDefiniteBuildArtifactClassification("likely-minified-by-line-stats")).toBe(false);
    expect(isDefiniteBuildArtifactClassification("likely-hashed-bundle")).toBe(false);
    expect(isDefiniteBuildArtifactClassification("likely-bundler-output-dir")).toBe(false);
    expect(isDefiniteBuildArtifactClassification("likely-compiled-tailwind")).toBe(false);
    expect(isDefiniteBuildArtifactClassification("likely-vendor-distribution")).toBe(false);
  });
});

// +
// per-entry `signal`
// field carries the deterministic predicate evidence so an agent
// verifying a `classification` has the falsifiable claim already in
// hand. Tests below pin one signal shape per
// `BuildArtifactClassification`. Each `value` is grep-able (path
// substring, basename, marker text) — no derived numbers except the
// line-length probe, where `value` is the longest line observed and
// `threshold` is the 500-char floor.
describe("classifyBuildArtifactDetailed — structured per-entry signal", () => {
  it("stamps `min-infix` with the matched basename for `.min.` filenames", () => {
    expect(classifyBuildArtifactDetailed("vendor/bootstrap.min.css", ".a{}")).toEqual({
      classification: "definite-min-infix",
      signal: { kind: "min-infix", value: "bootstrap.min.css" },
    });
  });

  it("stamps `hex-segment-in-basename` with the matched hex segment (no flanking dots)", () => {
    // The match `.a1b2c3d4.` is sliced to `a1b2c3d4` so the agent can
    // grep the literal hex run without re-deriving the dot convention.
    expect(classifyBuildArtifactDetailed("assets/app.a1b2c3d4.js", "// bundle")).toEqual({
      classification: "likely-hashed-bundle",
      signal: { kind: "hex-segment-in-basename", value: "a1b2c3d4" },
    });
  });

  it("stamps `build-dir-segment` with the matched marker for bundler-output-dir entries", () => {
    expect(classifyBuildArtifactDetailed("/proj/dist/main.css", ".a{}")).toEqual({
      classification: "likely-bundler-output-dir",
      signal: { kind: "build-dir-segment", value: "dist/" },
    });
    expect(classifyBuildArtifactDetailed("/proj/.next/static/css/app.css", ".a{}")).toEqual({
      classification: "likely-bundler-output-dir",
      signal: { kind: "build-dir-segment", value: ".next/" },
    });
  });

  it("stamps `tailwind-escape-selector` with the first matched substring", () => {
    const source = ".w-\\[400px\\] { width: 400px; }\n";
    expect(classifyBuildArtifactDetailed("app/styles.css", source)).toEqual({
      classification: "likely-compiled-tailwind",
      signal: { kind: "tailwind-escape-selector", value: "\\[400px\\]" },
    });
  });

  it("stamps `max-line-length-exceeds-threshold` with the median corroborator on a one-enormous-line bundle", () => {
    // Canonical minified-CSS shape: one ~700-char line. Median = 700,
    // ratio = 100% — but median fires first by evaluation order.
    // `value` is the longest line length observed (700 here), not the
    // median — the agent verifies "this file has a ≥500-char line"
    // by reading `value > threshold`.
    const source = `.a{color:red;}`.repeat(50);
    expect(classifyBuildArtifactDetailed("vendor/some-bundle.css", source)).toEqual({
      classification: "likely-minified-by-line-stats",
      signal: {
        kind: "max-line-length-exceeds-threshold",
        value: source.length,
        threshold: 500,
        corroborator: "median",
      },
    });
  });

  it("stamps `max-line-length-exceeds-threshold` with the ratio corroborator on a multi-long-line bundle", () => {
    // 4 long lines out of 16 → 25% ratio fires; median sits below
    // threshold (12 of 16 lines are short) so the discriminator is
    // `ratio`, not `median`. Lock both halves of the discriminator
    // so a future refactor can't silently flip the corroborator
    // attribution.
    const shortLines = Array.from({ length: 12 }, () => ".btn { padding: 0.5rem; }");
    const longLineText = `.rule { ${"color:red;".repeat(55)} }`;
    const longLines = Array.from({ length: 4 }, () => longLineText);
    const source = [...shortLines, ...longLines].join("\n");
    const out = classifyBuildArtifactDetailed("vendor/multi.css", source);
    expect(out?.classification).toBe("likely-minified-by-line-stats");
    expect(out?.signal).toEqual({
      kind: "max-line-length-exceeds-threshold",
      value: longLineText.length,
      threshold: 500,
      corroborator: "ratio",
    });
  });

  it("returns `null` for files that match no signal — no signal field to disambiguate against", () => {
    expect(classifyBuildArtifactDetailed("scss/_variables.scss", "$primary: #0d6efd;")).toBe(null);
  });
});

describe("isBuildArtifact (convenience predicate)", () => {
  it("returns true when classifyBuildArtifact returns a classification", () => {
    expect(isBuildArtifact("vendor/bootstrap.min.css", ".a{}")).toBe(true);
  });

  it("returns false when classifyBuildArtifact returns null", () => {
    expect(isBuildArtifact("scss/_variables.scss", "$primary: #0d6efd;")).toBe(false);
  });
});

describe("collectBuildArtifacts — sibling `.map` sourcemap signal", () => {
  it("labels `app.js` with classification `definite-sourcemap-paired` when `app.js.map` is also in the scanned set", () => {
    const files = [
      { filePath: "dist-out/app.js", source: "// bundled code" },
      { filePath: "dist-out/app.js.map", source: '{"version":3}' },
    ];
    // Both files sit outside the BUILD_DIR_MARKERS set ("dist-out/"
    // is not "dist/") so the label has to come from the sibling-map
    // signal, not a path probe. The signal carries the matched map
    // path so the agent can grep for both halves of the pair. The
    // classification is `definite-` because pairing a `.map` against
    // its source in the live scan set is path-anchored evidence.
    expect(collectBuildArtifacts(files)).toEqual([
      {
        path: "dist-out/app.js",
        classification: "definite-sourcemap-paired",
        signal: { kind: "sibling-map-file", value: "dist-out/app.js.map" },
      },
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

  it("prefers a per-file classification over `definite-sourcemap-paired` when both would fire on the same path", () => {
    // `vendor/jquery.min.js` matches the `.min.` infix AND has a
    // sibling `.map`. The per-file classifier runs first, so the
    // entry carries `definite-min-infix` (the more specific verdict)
    // and is not duplicated. The accompanying `signal` reflects the
    // winning predicate (the `.min.` infix), not the sibling-map
    // pairing — invariant on the doctrine "label must survive
    // inspection" extended to its evidence sub-field.
    const files = [
      { filePath: "vendor/jquery.min.js", source: "!function(){}();" },
      { filePath: "vendor/jquery.min.js.map", source: '{"version":3}' },
    ];
    const labeled = collectBuildArtifacts(files);
    expect(labeled).toEqual([
      {
        path: "vendor/jquery.min.js",
        classification: "definite-min-infix",
        signal: { kind: "min-infix", value: "jquery.min.js" },
      },
    ]);
  });
});

describe("classifyBuildArtifact — vendor-distribution classifications", () => {
  // Field-report shapes covered: a 138KB readable jQuery whose first
  // lines carry a banner + `//@ sourceMappingURL=jquery.min.map`; a
  // `wow.js` shipped alongside its `wow.min.js` sibling; a
  // `prettify.js` with a recognizable banner; a UMD `livereload.js`
  // with no `.min` infix. Each is a release artifact distributed
  // alongside its minified sibling but is itself the readable source.
  // Mislabeling them as `likely-minified-by-line-stats` routed the
  // agent to skip findings on the source while the actually-minified
  // sibling got the same label — same triage-skip on the wrong file.
  // The `definite-vendor-distribution` and `likely-vendor-distribution`
  // classifications separate "this is a release artifact" from "this
  // file IS the minified bytes" so the agent budgets correctly.

  it("labels a readable jQuery-shape source carrying `//@ sourceMappingURL=jquery.min.map` as `definite-vendor-distribution`", () => {
    // Banner + sourcemap pointer to `.min.map` is the canonical
    // readable-vendor-distribution shape. The pointer at a `.min` map
    // is text-deterministic (only build pipelines emit them), so the
    // verdict earns `definite-`. The body is short here so the
    // long-line probe alone would not fire — what's being pinned is
    // that the new sourcemap-pointer probe runs BEFORE the long-line
    // probe and produces the honest verdict (this IS a vendor
    // release artifact, not minified bytes).
    const source = `/*! jQuery v1.10.2 | (c) 2005, 2013 jQuery Foundation, Inc. */\n//@ sourceMappingURL=jquery.min.map\n!function(window){\nvar jQuery = function(){};\n})(window);\n`;
    expect(classifyBuildArtifactDetailed("vendor/jquery.js", source)).toEqual({
      classification: "definite-vendor-distribution",
      signal: { kind: "sourcemap-pointer-min", value: "//@ sourceMappingURL=jquery.min.map" },
    });
  });

  it("labels a source carrying the modern `//# sourceMappingURL=…min….map` opener as `definite-vendor-distribution`", () => {
    // Both the legacy `//@` and the modern `//#` pointer openers earn
    // the vendor-distribution verdict — the predicate is on the
    // pointer target shape, not the comment opener.
    const source = `/* some banner */\n//# sourceMappingURL=app.min.js.map\nvar x = 1;\n`;
    const result = classifyBuildArtifactDetailed("dist-out/app.js", source);
    expect(result?.classification).toBe("definite-vendor-distribution");
    expect(result?.signal).toEqual({
      kind: "sourcemap-pointer-min",
      value: "//# sourceMappingURL=app.min.js.map",
    });
  });

  it("labels `prettify.js` (recognizable banner, no `.min` infix) as `likely-vendor-distribution`", () => {
    // The curated `VENDOR_LIBRARY_BANNERS` table powers both the
    // standalone `vendorLibraries` meta surface AND the new
    // `likely-vendor-distribution` classification. A banner-with-
    // version match is heuristic (an authored file COULD include a
    // banner) so the verdict is `likely-`. Use jQuery as the canonical
    // banner-bearing shape because the table includes it; prettify
    // would need a curated entry first, but the classification path
    // is the same — pin it on jQuery here.
    const source = `/*! jQuery v3.6.0 | (c) OpenJS Foundation and other contributors */\nvar $ = function(){};\n`;
    const result = classifyBuildArtifactDetailed("js/jquery.js", source);
    expect(result?.classification).toBe("likely-vendor-distribution");
    expect(result?.signal).toEqual({
      kind: "vendor-banner-version",
      value: "jquery v3.6.0",
    });
  });

  it("labels a UMD-bundled source with no `.min` infix and no banner as null when no other predicate fires", () => {
    // A UMD wrapper alone does not earn a vendor-distribution label —
    // the predicate is "banner-with-version OR sourcemap-pointer-at-
    // min OR sibling-min-file," and a UMD wrapper without any of
    // these signals stays unlabeled by the per-file classifier. The
    // sibling-min branch is exercised in collectBuildArtifacts tests
    // below.
    const source = `(function (root, factory) {\n  if (typeof define === 'function' && define.amd) {\n    define([], factory);\n  } else {\n    root.LiveReload = factory();\n  }\n}(this, function () {\n  return {};\n}));\n`;
    expect(classifyBuildArtifact("js/livereload.js", source)).toBe(null);
  });

  it("does NOT mislabel a readable vendor source whose body crosses the line-stats threshold as `likely-minified-by-line-stats`", () => {
    // Field-report shape: a banner-bearing readable source whose body
    // happens to contain enough long lines to trigger the line-stats
    // corroborator. The new vendor-distribution branch runs FIRST so
    // the honest verdict ("this is a release artifact, not minified
    // bytes") wins — labeling it `likely-minified-by-line-stats`
    // would route the agent to skip findings on the file the user
    // can actually inspect.
    const longLine = "x".repeat(600);
    const source = `/*! jQuery v1.10.2 | (c) 2013 jQuery Foundation */\nvar code = "${longLine}";\nvar more = "${longLine}";\nvar third = "${longLine}";\n`;
    const result = classifyBuildArtifactDetailed("vendor/jquery.js", source);
    // Banner is the first non-blank line, so likely-vendor-distribution
    // wins; the long-line probe never runs.
    expect(result?.classification).toBe("likely-vendor-distribution");
  });

  it("does NOT label a hand-authored file with a non-min sourcemap pointer as vendor-distribution", () => {
    // A `//# sourceMappingURL=app.js.map` (no `.min` segment) is the
    // bundler-without-minification shape. The sibling-map probe in
    // collectBuildArtifacts handles that case when the `.map` file
    // is in the scan set; the per-file classifier does not over-fire
    // on a generic sourcemap pointer.
    const source = `var x = 1;\n//# sourceMappingURL=app.js.map\n`;
    expect(classifyBuildArtifact("dist-out/app.js", source)).toBe(null);
  });
});

describe("collectBuildArtifacts — sibling `.min.<ext>` vendor-distribution signal", () => {
  it("labels `wow.js` with `definite-vendor-distribution` when `wow.min.js` is also in the scanned set", () => {
    // Field-report shape: a vendor library shipped as both readable
    // source and minified twin under the same directory. The readable
    // source is a vendor distribution (generated alongside the
    // minified sibling), but it is NOT itself minified — the bytes
    // the user sees are readable. The minified twin separately picks
    // up `definite-min-infix`. Without this branch, the readable
    // source falls through to the long-line probe and may get
    // `likely-minified-by-line-stats`, routing the agent to skip
    // findings on the file the user can read.
    const files = [
      { filePath: "js/wow.js", source: "function WOW() {}\nWOW.prototype.init = function() {};\n" },
      { filePath: "js/wow.min.js", source: "!function(){function W(){}}();" },
    ];
    // Output preserves input order: wow.js (sibling-min path)
    // appears first, wow.min.js (per-file `.min.` infix) second.
    expect(collectBuildArtifacts(files)).toEqual([
      {
        path: "js/wow.js",
        classification: "definite-vendor-distribution",
        signal: { kind: "sibling-min-file", value: "js/wow.min.js" },
      },
      {
        path: "js/wow.min.js",
        classification: "definite-min-infix",
        signal: { kind: "min-infix", value: "wow.min.js" },
      },
    ]);
  });

  it("does NOT cross-pair a `.min.<ext>` sibling living in a different directory", () => {
    // Pairing is by full directory + basename stem so a same-named
    // `.min.js` in an unrelated tree does not over-fire — same
    // discipline as the sibling-map probe.
    const files = [
      { filePath: "src/wow.js", source: "function WOW() {}" },
      { filePath: "vendor/wow.min.js", source: "!function(){}();" },
    ];
    expect(
      collectBuildArtifacts(files)
        .map((e) => e.path)
        .sort(),
    ).toEqual(["vendor/wow.min.js"]);
  });

  it("does NOT label a `.min.<ext>` file as vendor-distribution by sibling-min — `definite-min-infix` already labels it", () => {
    // The sibling-min branch only fires on the readable source, never
    // on the minified twin. The minified twin's verdict comes from
    // rule 1 (`.min.` infix) at the per-file layer, upstream of the
    // sibling-set check.
    const files = [{ filePath: "vendor/wow.min.js", source: "!function(){}();" }];
    expect(collectBuildArtifacts(files)).toEqual([
      {
        path: "vendor/wow.min.js",
        classification: "definite-min-infix",
        signal: { kind: "min-infix", value: "wow.min.js" },
      },
    ]);
  });

  it("prefers a per-file classification over the sibling-min branch when both would fire", () => {
    // A readable source under `dist/` with a sibling `.min.<ext>` —
    // the per-file `likely-bundler-output-dir` predicate fires first
    // and the entry is not duplicated.
    const files = [
      { filePath: "dist/wow.js", source: "function WOW() {}" },
      { filePath: "dist/wow.min.js", source: "!function(){}();" },
    ];
    const labeled = collectBuildArtifacts(files);
    const wow = labeled.find((e) => e.path === "dist/wow.js");
    expect(wow?.classification).toBe("likely-bundler-output-dir");
  });
});

describe("collectBuildArtifacts", () => {
  it("returns the subset of files that match any signal as `{ path, classification, signal }` records, preserving input order", () => {
    const files = [
      { filePath: "src/Component.tsx", source: "export const x = 1;" },
      { filePath: "app/styles.css", source: ".w-\\[400px\\] { width: 400px; }" },
      { filePath: "src/styles.css", source: ".card { padding: 1rem; }" },
      { filePath: "dist/main.css", source: "/* compiled */" },
      { filePath: "vendor/jquery.min.js", source: "!function(){}();" },
    ];
    expect(collectBuildArtifacts(files)).toEqual([
      {
        path: "app/styles.css",
        classification: "likely-compiled-tailwind",
        signal: { kind: "tailwind-escape-selector", value: "\\[400px\\]" },
      },
      {
        path: "dist/main.css",
        classification: "likely-bundler-output-dir",
        signal: { kind: "build-dir-segment", value: "dist/" },
      },
      {
        path: "vendor/jquery.min.js",
        classification: "definite-min-infix",
        signal: { kind: "min-infix", value: "jquery.min.js" },
      },
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

describe("groupBuildArtifactsByBasename — grouped shape", () => {
  it("collapses a ≥3-path same-basename cluster under one group with a paste-ready suggestedGlob", () => {
    // The field-report case: a bootstrap repo emits the same
    // `bootstrap.css` under three themed subtrees. Under the flat
    // shape the agent saw three individual paths; under the grouped
    // shape the three collapse to one inspect-once row with a
    // `suggestedGlob` that covers every member.
    const entries = [
      mkEntry("/root/dist/5.0/bootstrap.css", "likely-bundler-output-dir"),
      mkEntry("/root/dist/5.1/bootstrap.css", "likely-bundler-output-dir"),
      mkEntry("/root/dist/5.2/bootstrap.css", "likely-bundler-output-dir"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped).toEqual([
      {
        basename: "bootstrap.css",
        count: 3,
        pathHint: "dist/",
        classifications: ["likely-bundler-output-dir"],
        suggestedGlob: "dist/**/bootstrap.css",
      },
    ]);
    expect(out.ungrouped).toEqual([]);
  });

  it("keeps sub-threshold same-basename entries in `ungrouped` with classifications + signals preserved", () => {
    // Two paths share a basename but fall below the grouping
    // threshold. Zero information loss: the full `{ path,
    // classification, signal }` record survives under `ungrouped` so
    // an agent can still read both the per-path classification and
    // the deterministic predicate evidence
    //.
    const entries = [
      mkEntry("/root/dist/a.min.css", "definite-min-infix"),
      mkEntry("/root/dist/other/a.min.css", "definite-min-infix"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped).toEqual([]);
    expect(out.ungrouped).toEqual([
      {
        path: "dist/a.min.css",
        classification: "definite-min-infix",
        signal: { kind: "min-infix", value: "a.min.css" },
      },
      {
        path: "dist/other/a.min.css",
        classification: "definite-min-infix",
        signal: { kind: "min-infix", value: "a.min.css" },
      },
    ]);
  });

  it("sorts grouped entries by count descending with ties broken by basename alphabetical", () => {
    // Three groups: one of size 5 (font-awesome.css), one of size 3
    // (app.css), one of size 3 (bootstrap.css). The size-5 leads;
    // the two size-3 groups appear in basename order.
    const mk = (name: string, n: number): readonly ScannedBuildArtifact[] =>
      Array.from({ length: n }, (_, i) =>
        mkEntry(`/root/dist/v${i}/${name}`, "likely-bundler-output-dir"),
      );
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
      mkEntry("/root/z/one.css", "likely-bundler-output-dir"),
      mkEntry("/root/a/two.css", "likely-bundler-output-dir"),
      mkEntry("/root/m/three.css", "likely-bundler-output-dir"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.ungrouped.map((e) => e.path)).toEqual(["a/two.css", "m/three.css", "z/one.css"]);
  });

  it("dedupes and sorts `classifications` when members of one group carry multiple classifier verdicts", () => {
    // Mixed-classification group: `likely-bundler-output-dir` and
    // `definite-min-infix` both fire across the three members. The
    // `classifications` field surfaces both so the agent reading
    // `["definite-min-infix", "likely-bundler-output-dir"]` knows
    // the group isn't monolithic and can budget the confidence-graded
    // mix.
    const entries = [
      mkEntry("/root/dist/a/lib.css", "likely-bundler-output-dir"),
      mkEntry("/root/dist/b/lib.css", "definite-min-infix"),
      mkEntry("/root/dist/c/lib.css", "likely-bundler-output-dir"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped[0]?.classifications).toEqual([
      "definite-min-infix",
      "likely-bundler-output-dir",
    ]);
  });

  it("computes a directory-boundary pathHint, never a partial-basename prefix", () => {
    // Two directories share a non-directory prefix (`vendor/bo`).
    // The pathHint must stop at the last `/` so the suggestedGlob
    // stays a legal glob and never over-captures unrelated files.
    const entries = [
      mkEntry("/root/vendor/bootstrap/x.css", "likely-bundler-output-dir"),
      mkEntry("/root/vendor/bose-theme/x.css", "likely-bundler-output-dir"),
      mkEntry("/root/vendor/boxy/x.css", "likely-bundler-output-dir"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped[0]?.pathHint).toBe("vendor/");
    expect(out.grouped[0]?.suggestedGlob).toBe("vendor/**/x.css");
  });

  it("emits empty `pathHint` + repo-wide suggestedGlob when group members share no directory", () => {
    // The three members sit under different top-level dirs, so the
    // longest shared prefix is the empty string. The suggestedGlob
    // degrades to `**/<basename>` — still a legal exclude entry,
    // just repo-wide. The agent sees this and can tighten the glob
    // manually if needed.
    const entries = [
      mkEntry("/root/dist/a.css", "likely-bundler-output-dir"),
      mkEntry("/root/build/a.css", "likely-bundler-output-dir"),
      mkEntry("/root/public/a.css", "likely-bundler-output-dir"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped[0]?.pathHint).toBe("");
    expect(out.grouped[0]?.suggestedGlob).toBe("**/a.css");
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
      mkEntry("/outside/a.css", "likely-bundler-output-dir"),
      mkEntry("/root/dist/a/b.css", "likely-bundler-output-dir"),
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
      mkEntry("C:\\root\\dist\\v1\\lib.css", "likely-bundler-output-dir"),
      mkEntry("C:\\root\\dist\\v2\\lib.css", "likely-bundler-output-dir"),
      mkEntry("C:\\root\\dist\\v3\\lib.css", "likely-bundler-output-dir"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "C:\\root");
    expect(out.grouped[0]?.pathHint).toBe("dist/");
    expect(out.grouped[0]?.suggestedGlob).toBe("dist/**/lib.css");
  });

  it("uses the shared 3-entry threshold — a 2-entry cluster stays ungrouped, a 3-entry cluster groups", () => {
    // Regression guard on the threshold constant: match the
    // precedent set by `tool-propose-config.ts`'s
    // EXCLUDE_GLOB_COLLAPSE_THRESHOLD. A test asserting the
    // constant ensures future edits stay aligned with the paired
    // exclude-collapse logic.
    expect(BASENAME_GROUP_THRESHOLD).toBe(3);
    const two = [
      mkEntry("/root/a/x.css", "likely-bundler-output-dir"),
      mkEntry("/root/b/x.css", "likely-bundler-output-dir"),
    ];
    expect(groupBuildArtifactsByBasename(two, "/root").grouped).toEqual([]);
    const three = [...two, mkEntry("/root/c/x.css", "likely-bundler-output-dir")];
    expect(groupBuildArtifactsByBasename(three, "/root").grouped.length).toBe(1);
  });
});

// Q-SHARED-META-ARRAY-BUDGET-CAP: `ungrouped` is the tail of the
// grouped shape — it held hundreds of sub-threshold entries on the
// website-templates scan that motivated the cap (148KB of the 281KB
// meta block). The cap trims the *list* head-first (alphabetical,
// deterministic) while `ungroupedTruncated: { shown, total }` names
// the settlement.
describe("groupBuildArtifactsByBasename — ungrouped cap (Q-SHARED-META-ARRAY-BUDGET-CAP)", () => {
  it("caps ungrouped at 50 entries and emits ungroupedTruncated with the pre-cap total", () => {
    // 120 unique basenames (no clusters form) → every entry lands in
    // `ungrouped`, which must cap to 50 with a sibling summary.
    const entries = Array.from({ length: 120 }, (_, i) =>
      mkEntry(`/root/dist/f${String(i).padStart(3, "0")}.css`, "likely-bundler-output-dir"),
    );
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped).toEqual([]);
    expect(out.ungrouped.length).toBe(50);
    expect(out.ungroupedTruncated).toEqual({ shown: 50, total: 120 });
    // Head is alphabetical — stable across runs.
    expect(out.ungrouped[0]?.path).toBe("dist/f000.css");
    expect(out.ungrouped[49]?.path).toBe("dist/f049.css");
  });

  it("omits ungroupedTruncated when the list fits under the cap", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      mkEntry(`/root/dist/f${i}.css`, "likely-bundler-output-dir"),
    );
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.ungrouped.length).toBe(10);
    expect(out.ungroupedTruncated).toBeUndefined();
  });

  it("grouped rows stay compact and uncapped — the cap is a tail-only concern", () => {
    // 60 entries sharing one basename → one grouped row (compact by
    // definition), ungrouped stays empty. The cap doesn't fire and
    // the grouped row's count stays honest.
    const entries = Array.from({ length: 60 }, (_, i) =>
      mkEntry(`/root/d${i}/bootstrap.css`, "likely-bundler-output-dir"),
    );
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped.length).toBe(1);
    expect(out.grouped[0]?.count).toBe(60);
    expect(out.ungrouped).toEqual([]);
    expect(out.ungroupedTruncated).toBeUndefined();
  });
});

// deterministic identification of
// well-known vendor libraries from their first-line banner comment.
// The doctrine bar is "labeled buckets are only honest when provable
// from the code" — these tests pin the positive direction (each
// curated banner matches the right library + extracts the version
// when carried), the negative direction (a hand-authored file with a
// brand name in a comment but the wrong banner shape stays
// unlabeled), and the present-when-meaningful shape (`version` is
// omitted, not sentinel-empty, when the banner doesn't carry one).
describe("detectVendorLibraries — positive direction (curated banners)", () => {
  it("identifies Bootstrap 5 from its single-line banner with version capture", () => {
    const source =
      "/*! Bootstrap v5.3.0 (https://getbootstrap.com/) Copyright 2011-2023 The Bootstrap Authors */\n.btn{}";
    expect(detectVendorLibraries([{ filePath: "vendor/bootstrap.min.css", source }])).toEqual([
      { path: "vendor/bootstrap.min.css", library: "bootstrap", version: "5.3.0" },
    ]);
  });

  it("identifies Bootstrap 3 from its multi-line banner — version on the opener line", () => {
    // The Bootstrap 3.x distribution emits `/*!\n * Bootstrap v3.3.7 ...`
    // — the leading non-blank line is `/*!`, but the regex's leading-`*`
    // tolerance can't reach into the second line of a multi-line banner.
    // Older bundles that fold the version onto the opener line still
    // match; bundles that defer to a follow-up line surface as no-match
    // (documented limitation in `firstNonBlankLine`).
    const source = "/*! * Bootstrap v3.3.7 (http://getbootstrap.com) */\n.btn{}";
    const result = detectVendorLibraries([{ filePath: "bootstrap.min.css", source }]);
    expect(result).toEqual([{ path: "bootstrap.min.css", library: "bootstrap", version: "3.3.7" }]);
  });

  it("identifies jQuery from its canonical banner with version capture", () => {
    const source =
      "/*! jQuery v3.6.0 | (c) OpenJS Foundation and other contributors | jquery.org/license */\n!function(){}();";
    expect(detectVendorLibraries([{ filePath: "vendor/jquery.min.js", source }])).toEqual([
      { path: "vendor/jquery.min.js", library: "jquery", version: "3.6.0" },
    ]);
  });

  it("identifies jQuery UI from its canonical banner with version capture", () => {
    const source =
      "/*! jQuery UI - v1.12.1 - 2016-09-14 http://jqueryui.com */\n.ui-helper-clearfix{}";
    expect(detectVendorLibraries([{ filePath: "vendor/jquery-ui.min.css", source }])).toEqual([
      { path: "vendor/jquery-ui.min.css", library: "jquery-ui", version: "1.12.1" },
    ]);
  });

  it("identifies Font Awesome 6 (Free) from its banner with version capture", () => {
    const source =
      "/*! Font Awesome Free 6.4.0 by @fontawesome - https://fontawesome.com */\n.fa{}";
    expect(detectVendorLibraries([{ filePath: "css/font-awesome.min.css", source }])).toEqual([
      { path: "css/font-awesome.min.css", library: "font-awesome", version: "6.4.0" },
    ]);
  });

  it("identifies Font Awesome Pro from the same banner shape", () => {
    const source = "/*! Font Awesome Pro 6.4.0 by @fontawesome - https://fontawesome.com */\n.fa{}";
    expect(detectVendorLibraries([{ filePath: "css/fontawesome.css", source }])).toEqual([
      { path: "css/fontawesome.css", library: "font-awesome", version: "6.4.0" },
    ]);
  });

  it("identifies Animate.css with version omitted (banner does not carry version)", () => {
    // animate.css's classic banner is `@license animate.css - http://daneden.me/animate ...`
    // with no parseable version slot. Per the present-when-meaningful
    // rule, `version` is omitted entirely (not `""`, not `null`).
    const source =
      "/*! @license animate.css - http://daneden.me/animate Copyright (c) 2017 Daniel Eden */\n.fadeIn{}";
    expect(detectVendorLibraries([{ filePath: "css/animate.css", source }])).toEqual([
      { path: "css/animate.css", library: "animate.css" },
    ]);
  });

  it("identifies Modernizr from its banner with version capture", () => {
    const source =
      "/*! modernizr 3.6.0 (Custom Build) | MIT * https://modernizr.com/download/?-flexbox */\n;!function(){}();";
    expect(detectVendorLibraries([{ filePath: "js/modernizr-custom.js", source }])).toEqual([
      { path: "js/modernizr-custom.js", library: "modernizr", version: "3.6.0" },
    ]);
  });

  it("identifies normalize.css from its banner with version capture", () => {
    const source =
      "/*! normalize.css v8.0.1 | MIT License | github.com/necolas/normalize.css */\nhtml{}";
    expect(detectVendorLibraries([{ filePath: "css/normalize.css", source }])).toEqual([
      { path: "css/normalize.css", library: "normalize.css", version: "8.0.1" },
    ]);
  });

  it("identifies Eric Meyer reset.css from its URL-bearing banner (no version)", () => {
    // Meyer's reset.css banner cites the URL in lieu of a version — the
    // URL is the unique identifying token. `version` stays absent.
    const source = "/* http://meyerweb.com/eric/tools/css/reset/\n   v2.0 | 20110126 */\nhtml{}";
    expect(detectVendorLibraries([{ filePath: "css/reset.css", source }])).toEqual([
      { path: "css/reset.css", library: "reset.css" },
    ]);
  });

  it("identifies fancyBox from its banner with version capture", () => {
    const source =
      "/*! fancyBox v3.5.7 fancyapps.com | fancyapps.com/fancybox/3/docs/#license */\n.fancybox{}";
    expect(detectVendorLibraries([{ filePath: "vendor/fancybox.min.css", source }])).toEqual([
      { path: "vendor/fancybox.min.css", library: "fancybox", version: "3.5.7" },
    ]);
  });

  it("identifies fancyBox from its `// fancyBox v...` line-comment banner (script form)", () => {
    const source = "// fancyBox v3.5.7\n// http://fancyapps.com/fancybox/\n!function(){}();";
    expect(detectVendorLibraries([{ filePath: "js/fancybox.js", source }])).toEqual([
      { path: "js/fancybox.js", library: "fancybox", version: "3.5.7" },
    ]);
  });

  it("tolerates leading whitespace and a UTF-8 BOM before the banner", () => {
    // Some build pipelines and editors prepend a BOM (0xFEFF) or leading
    // blank lines / indentation. The first-line probe skips both so the
    // banner regex still anchors at `/*!`.
    const source = `﻿\n  /*! Bootstrap v5.3.0 (https://getbootstrap.com/) */\n.btn{}`;
    expect(detectVendorLibraries([{ filePath: "vendor/bootstrap.min.css", source }])).toEqual([
      { path: "vendor/bootstrap.min.css", library: "bootstrap", version: "5.3.0" },
    ]);
  });
});

describe("detectVendorLibraries — negative direction (no false positives)", () => {
  it("does NOT label a hand-authored CSS file that mentions Bootstrap in a non-banner comment", () => {
    // The first non-whitespace line is a normal CSS comment, not the
    // canonical `/*! Bootstrap v...` banner. The library name appears
    // elsewhere — that is not enough.
    const source = "/* App styles, inspired by Bootstrap. */\n.app-btn { padding: 0.5rem; }\n";
    expect(detectVendorLibraries([{ filePath: "src/styles/app.css", source }])).toEqual([]);
  });

  it("does NOT label a file whose first line is empty / pure whitespace with no banner", () => {
    const source = "\n\n.btn { color: red; }\n";
    expect(detectVendorLibraries([{ filePath: "src/styles/buttons.css", source }])).toEqual([]);
  });

  it("does NOT label a file whose path contains `bootstrap` but whose source has no banner", () => {
    // Path-based matching is suppression in disguise (see backlog).
    // Only the deterministic banner regex earns the label — a vendor
    // directory name cannot.
    const source = ".my-styles { color: blue; }\n";
    expect(
      detectVendorLibraries([{ filePath: "vendor/bootstrap-themes/custom.css", source }]),
    ).toEqual([]);
  });

  it("does NOT label a hand-authored JS file whose first line mentions jQuery in prose", () => {
    const source = "// This module wraps jQuery for our internal API.\nexport function foo() {}";
    expect(detectVendorLibraries([{ filePath: "src/utils/jquery-wrapper.js", source }])).toEqual(
      [],
    );
  });

  it("returns an empty array on a fully empty file (no banner to read)", () => {
    expect(detectVendorLibraries([{ filePath: "empty.css", source: "" }])).toEqual([]);
  });
});

describe("detectVendorLibraries — batch + ordering", () => {
  it("returns one entry per matched file, sorted by path ascending (deterministic across runs)", () => {
    const files = [
      {
        filePath: "z/jquery.min.js",
        source: "/*! jQuery v3.6.0 | (c) OpenJS Foundation */\n!function(){}();",
      },
      {
        filePath: "a/bootstrap.min.css",
        source: "/*! Bootstrap v5.3.0 (https://getbootstrap.com/) */\n.btn{}",
      },
      {
        filePath: "m/fontawesome.css",
        source: "/*! Font Awesome Free 6.4.0 by @fontawesome */\n.fa{}",
      },
    ];
    expect(detectVendorLibraries(files)).toEqual([
      { path: "a/bootstrap.min.css", library: "bootstrap", version: "5.3.0" },
      { path: "m/fontawesome.css", library: "font-awesome", version: "6.4.0" },
      { path: "z/jquery.min.js", library: "jquery", version: "3.6.0" },
    ]);
  });

  it("returns an empty array when no file in the batch matches a curated banner", () => {
    const files = [
      { filePath: "src/a.css", source: ".x{}" },
      { filePath: "src/b.js", source: "console.log(1);" },
    ];
    expect(detectVendorLibraries(files)).toEqual([]);
  });
});
