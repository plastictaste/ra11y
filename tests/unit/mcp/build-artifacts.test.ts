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

  it("does NOT classify a path under `/public/` (static-assets convention, not bundler-output)", () => {
    // Astro / Vite / Next / Nuxt all treat `public/` as a static-assets
    // directory: user-authored files (favicons, brand marks, hero
    // images) copied as-is to the build root. An authored `hero.jpg`,
    // `brand-mark.svg`, or `favicon.png` under `public/` would
    // mis-classify under a `public/ → bundler-output` predicate and
    // silently land under `scannedBuildArtifacts`, which downstream
    // tools treat as "not user-fixable." The path-segment signal is
    // dropped; the deterministic vendor signals (`.min.` infix,
    // hashed filename, sourcemap-sibling) still classify when
    // applicable, and framework-specific markers (`.output/`,
    // `_site/`) still fire when `public/` sits inside a generated
    // tree (covered by the `.output/` test above). Per
    // `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
    // meta sub-fields are dishonest."
    expect(classifyBuildArtifact("/proj/public/main.css", ".a {}")).toBe(null);
    expect(classifyBuildArtifact("/proj/public/hero.jpg", "")).toBe(null);
    expect(classifyBuildArtifact("public/brand-mark.svg", "<svg></svg>")).toBe(null);
    expect(classifyBuildArtifact("/proj/public/favicon.png", "")).toBe(null);
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

describe("classifyBuildArtifact — data-URL-dominated long-line dedupct (regression guard)", () => {
  // Long lines whose >threshold reach is dominated by an inline `data:`
  // URL payload are authored content (CSS background icons, HTML
  // `src="data:..."` attributes, SVG mask gradients) — not minified
  // bytes. The corroborated long-line probe deducts these lines from
  // its count before applying the count floor / ratio / median checks,
  // so a hand-authored design-system SCSS sprinkling several inline
  // base64 icons across a small file no longer trips `likely-
  // minified-by-line-stats` on authored payload alone. Per
  // `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
  // meta sub-fields are dishonest": when content evidence shows the
  // long line is authored payload, the corroborator's verdict ("this
  // file is minified bytes") contradicts the source shape.
  it("does NOT classify a small design-system SCSS where the only long lines are inline data-URL icons", () => {
    // Canonical Q9 false-positive shape: ~8 short authored rules + 3
    // inline base64 PNG icons whose lines cross the 500-char threshold
    // because of the data-URL payload. Without dedupct: longLineCount
    // = 3, totalLines = 11, ratio = 27% (above 25% floor), count floor
    // satisfied at 3 — would mislabel. With dedupct: residual long
    // lines = 0, neither corroborator fires, file stays unlabeled.
    const lines = ["/* Icons */"];
    for (let i = 0; i < 7; i++) lines.push(`.token-${i} { color: red; }`);
    for (let i = 0; i < 3; i++) {
      lines.push(`.icon-${i} { background: url(data:image/png;base64,${"A".repeat(700)}); }`);
    }
    const source = lines.join("\n");
    expect(classifyBuildArtifact("scss/_icons.scss", source)).toBe(null);
  });

  it("does NOT classify a 1350-line authored SCSS with a single inline data-URL marker", () => {
    // Canonical 1350-line authored design-system SCSS shape: `/* Base */`
    // opener, hundreds of short hand-written rules, one inline base64
    // PNG icon whose line crosses the long-line threshold. Even before
    // the dedupct landed this shape already returned null (1-of-1342
    // long-line ratio is well below 25%); this test pins the invariant
    // so a future tightening of the count floor can't silently re-
    // introduce the mislabeling.
    const lines = ["/* Base */", ""];
    for (let i = 0; i < 1340; i++) {
      lines.push(`.token-${i} { color: red; padding: 0.5rem; }`);
    }
    lines.push(`.icon-bg { background: url(data:image/png;base64,${"A".repeat(700)}); }`);
    const source = lines.join("\n");
    expect(classifyBuildArtifact("scss/_style.scss", source)).toBe(null);
  });

  it("does NOT classify a small file whose long lines are dominated by URL-encoded SVG data URIs", () => {
    // SVG mask icon shape — `data:image/svg+xml,%3Csvg…%3C/svg%3E` is
    // URL-encoded rather than base64, but the deduction predicate
    // covers both forms (`data:<mediatype>[;base64],<payload>` regex
    // captures the comma-separated payload regardless of encoding).
    const lines = [".tokens {"];
    for (let i = 0; i < 8; i++) lines.push(`  --color-${i}: oklch(0.5 0.1 0);`);
    for (let i = 0; i < 3; i++) {
      lines.push(
        `  --mask-${i}: url(data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E${"%3Cpath%20d%3D%22M0%2C0%22%2F%3E".repeat(20)}%3C%2Fsvg%3E);`,
      );
    }
    lines.push("}");
    const source = lines.join("\n");
    expect(classifyBuildArtifact("scss/_masks.scss", source)).toBe(null);
  });

  it("does NOT classify a 1-line HTML where the only long-line content is an inline data: image", () => {
    // Vanilla landing-page shape: one short HTML line whose `<img>`
    // src embeds a base64 PNG. Without dedupct the median corroborator
    // fires trivially (totalLines = 1, median = entire line length).
    // With dedupct the residual non-data-URL length is well below the
    // threshold, the median drops, and the file stays unlabeled.
    const source = `<img src="data:image/png;base64,${"A".repeat(700)}" alt="hero"/>`;
    expect(source.length).toBeGreaterThan(500);
    expect(classifyBuildArtifact("hero.html", source)).toBe(null);
  });

  it("classifies a real minified bundle even when one of its lines inlines a data-URL", () => {
    // Sanity: dedupct only affects lines whose >threshold reach is
    // dominated by the data-URL payload. A minified CSS bundle whose
    // residual non-data-URL line content still crosses the threshold
    // (real minified rules concatenated alongside the inline asset)
    // continues to classify — the dedupct is conservative by design.
    const minifiedRule = `.a{color:red;}`.repeat(50); // ~700 chars of bundle rules
    const inlineDataUrl = `.b{background:url(data:image/png;base64,${"A".repeat(400)});}${"x".repeat(400)}`;
    const source = [minifiedRule, inlineDataUrl, minifiedRule].join("\n");
    // The middle line has both data-URL payload AND ~400 chars of
    // residual bundle content; len - longestPayload > 500, so it does
    // NOT count as data-URL-dominated and the corroborator still fires.
    expect(classifyBuildArtifact("vendor/bundle.css", source)).toBe(
      "likely-minified-by-line-stats",
    );
  });

  it("classifies a real minified bundle whose median is one enormous data-URL-free line", () => {
    // Sanity: the canonical minified-JS-bundle shape (one ~700-char
    // line, no data-URLs anywhere) is unaffected by the dedupct — no
    // line is data-URL-dominated, so longLineCount and median are
    // unchanged from the pre-dedupct baseline.
    const source = `(function(){${"a=1;".repeat(200)}})();`;
    expect(classifyBuildArtifact("vendor/app.bundle.js", source)).toBe(
      "likely-minified-by-line-stats",
    );
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

describe("classifyBuildArtifact — authored SVG fonts (FontAwesome-shape carve-out)", () => {
  // Authored SVG fonts (FontAwesome / Lucide / Phosphor) ship as `.svg`
  // sources whose body is `<font>` + `<glyph>` element runs, frequently
  // with a `.min.` infix in the basename or under `dist/icons/` because
  // they're distributed alongside the icon webfont. Without this gate
  // the path predicates (min-infix, hashed-filename, build-dir marker)
  // mis-label these hand-authored vector glyph paths as minified output,
  // routing the agent's triage away from a file the user did author.
  // Per `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
  // meta sub-fields are dishonest" — the source body proves the file is
  // authored vector content, so the path's "minified" verdict
  // contradicts the source shape.
  it("does NOT classify a `.svg` whose body contains `<font>` element markers", () => {
    // FontAwesome-style: SVG-font wrapper with glyph children. The
    // `<font>` element opener is the canonical SVG-font marker; minified
    // bytes never contain literal element-name tokens.
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><defs><font id="fa" horiz-adv-x="512"><font-face font-family="FontAwesome" units-per-em="512"/><missing-glyph horiz-adv-x="0"/><glyph unicode="&#xf000;" d="M0 0L10 10Z"/><glyph unicode="&#xf001;" d="M10 10L20 20Z"/></font></defs></svg>`;
    expect(classifyBuildArtifact("dist/icons/fontawesome.svg", source)).toBe(null);
  });

  it("does NOT classify a `.min.svg` whose body contains `<font>` element markers (path verdict overridden)", () => {
    // Even with the `.min.` path infix that would otherwise earn
    // `definite-min-infix`, the source body proves the file is an
    // authored SVG font. The carve-out runs first and pre-empts the
    // path-anchored verdict.
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><defs><font id="lucide"><font-face font-family="Lucide"/><glyph unicode="A" d="M0,0Z"/></font></defs></svg>`;
    expect(classifyBuildArtifact("public/lucide.min.svg", source)).toBe(null);
  });

  it("does NOT classify a `.svg` under `dist/` whose body contains `<glyph>` element markers", () => {
    // `<glyph>` element opener is the sibling marker; SVG-font glyph
    // children never appear in minified output.
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><glyph unicode="A" d="M10,10L20,20Z"/><glyph unicode="B" d="M0,0L5,5Z"/></svg>`;
    expect(classifyBuildArtifact("dist/icons/glyphs.svg", source)).toBe(null);
  });

  it("does NOT classify a pretty-printed `.svg` (>100 lines) with an authored copyright comment", () => {
    // FontAwesome / Lucide / Phosphor distributions open with an SVG
    // comment block citing the project + license. Without `<font>` /
    // `<glyph>` markers the conjunctive predicate (line-count + license
    // header) credits the file as authored.
    const lines: string[] = [
      `<!-- Font Awesome Free 6.4.0 by @fontawesome - https://fontawesome.com -->`,
      `<!-- License - https://fontawesome.com/license/free (Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT License) -->`,
      `<!-- Copyright 2024 Fonticons, Inc. -->`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`,
    ];
    for (let i = 0; i < 200; i++) {
      lines.push(`  <path d="M${i},${i}L${i + 1},${i + 1}Z"/>`);
    }
    lines.push(`</svg>`);
    const source = lines.join("\n");
    expect(classifyBuildArtifact("dist/icons/fa-solid.svg", source)).toBe(null);
  });

  it("does NOT classify a pretty-printed `.svg` with an SPDX-License-Identifier comment", () => {
    // Recent FontAwesome / Phosphor releases use the SPDX preamble
    // form. The license-token regex includes `SPDX-License-Identifier`
    // so the SPDX-only comment shape credits.
    const lines: string[] = [
      `<!-- SPDX-License-Identifier: MIT -->`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">`,
    ];
    for (let i = 0; i < 150; i++) {
      lines.push(`  <path d="M${i},0L${i + 1},1Z"/>`);
    }
    lines.push(`</svg>`);
    const source = lines.join("\n");
    expect(classifyBuildArtifact("dist/phosphor/phosphor.svg", source)).toBe(null);
  });

  it("DOES still classify a single-long-line `.min.svg` with no authored markers (real minified bundle)", () => {
    // Symmetric guard: the carve-out is conservative — it must NOT
    // skip a real minified SVG bundle. No `<font>`, no `<glyph>`, no
    // multi-line + license-header conjunction. The path predicate
    // still fires per the existing `.min.svg` regression guard.
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0,0L1,1Z"/></svg>`;
    expect(classifyBuildArtifact("public/logo.min.svg", source)).toBe("definite-min-infix");
  });

  it("DOES still classify a pretty-printed `.svg` with no license header (line-count alone is not enough)", () => {
    // Symmetric guard: the comment-conjunctive branch requires BOTH a
    // line-count exceedance AND a license header. A 200-line authored
    // SVG with no license comment is still authored content, but
    // because the carve-out doesn't credit it, the path predicate is
    // free to run. Under `dist/` the verdict is the path-anchored
    // `likely-bundler-output-dir` (the existing single-line behavior
    // at `dist/icons/sprite.svg`).
    const lines: string[] = [`<svg xmlns="http://www.w3.org/2000/svg">`];
    for (let i = 0; i < 200; i++) {
      lines.push(`  <path d="M${i},${i}Z"/>`);
    }
    lines.push(`</svg>`);
    const source = lines.join("\n");
    expect(classifyBuildArtifact("dist/icons/sprite.svg", source)).toBe(
      "likely-bundler-output-dir",
    );
  });

  it("DOES still classify a single-line `.svg` with `MIT` inside a text node (no comment opener required)", () => {
    // Symmetric guard: the comment-opener requirement (`<!--` must be
    // in the head window) prevents an attribute / text-node literal
    // from accidentally crediting. A single-line SVG with `MIT` in a
    // `<text>` node and no multi-line shape stays unclassified by the
    // carve-out; behavior reverts to the existing single-line SVG
    // norm (also unclassified — the long-line probe is gated off).
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><text>MIT</text></svg>`;
    expect(classifyBuildArtifact("assets/license-icon.svg", source)).toBe(null);
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

describe("classifyBuildArtifact — generic copyright-banner vendor-distribution", () => {
  // Field-report shape: unminified vendor bundles whose first lines are
  // a `/*!` banner with a Copyright / License / Released-under / SPDX
  // token, but no `.min.` infix and no curated `VENDOR_LIBRARY_BANNERS`
  // entry. Recurring across two corpora; in bulk corpora drove
  // 150+ contrast findings emitted against vendor stylesheets that the
  // long-line probe misclassified as `likely-minified-by-line-stats`.
  // The generic copyright-banner predicate catches the publishing-
  // convention shape (`/*!` opener + license token in the first 1024
  // chars) for libraries that the curated table does not enumerate.

  it("labels a Bootstrap CSS bundle carrying a `/*! Bootstrap v3.3.7 ... Copyright ... */` banner via the curated table (more informative `vendor-banner-version` signal)", () => {
    // The curated table runs FIRST so a Bootstrap banner with a version
    // slot still gets the more informative `vendor-banner-version`
    // signal carrying `bootstrap v3.3.7`. The generic copyright-banner
    // branch is the fallback for libraries the curated table does not
    // enumerate; this test pins the precedence so the curated entries
    // keep their version-bearing signal even when the generic branch
    // would also match.
    const source =
      "/*! Bootstrap v3.3.7 (https://getbootstrap.com) Copyright 2011-2017 Twitter, Inc. Released under MIT license */\nbody { margin: 0; }\n";
    const result = classifyBuildArtifactDetailed("vendor/bootstrap.css", source);
    expect(result?.classification).toBe("likely-vendor-distribution");
    expect(result?.signal).toEqual({
      kind: "vendor-banner-version",
      value: "bootstrap v3.3.7",
    });
  });

  it("labels a `jquery-scrolltofixed`-style bundle as `likely-vendor-distribution` when the body also crosses the long-line corroborator", () => {
    // jquery-scrolltofixed is not on the curated `VENDOR_LIBRARY_BANNERS`
    // table (the long tail of jQuery plugins is too broad to enumerate).
    // Its banner follows the publishing convention: `/*!` opener +
    // `Copyright` + `Released under` + a license identifier. Under the
    // co-occurrence rule, the generic banner alone does not earn the
    // verdict — banner-only matches an authored SCSS partial that
    // adopted the publishing convention. The body must ALSO cross the
    // long-line minification corroborator (here: three 600-char lines)
    // for the verdict to fire. The banner wins the signal slot because
    // it names the more informative "vendor distribution" verdict.
    const longLine = "x".repeat(600);
    const source = `/*!\n * jQuery scrollToFixed Plugin\n * Copyright (c) 2011-2014 Joseph Cava-Lynch\n * Released under the MIT license\n */\nvar a = "${longLine}";\nvar b = "${longLine}";\nvar c = "${longLine}";\n`;
    const result = classifyBuildArtifactDetailed("vendor/jquery-scrolltofixed.js", source);
    expect(result?.classification).toBe("likely-vendor-distribution");
    expect(result?.signal.kind).toBe("vendor-copyright-banner");
    // The `value` carries the matched bang-comment opener trimmed to
    // ≤120 chars so the agent can grep for the banner shape.
    expect(result?.signal.kind === "vendor-copyright-banner" && result.signal.value).toMatch(
      /^\/\*!/u,
    );
  });

  it("labels a generic vendor bundle whose banner cites the Apache license when the body also crosses the long-line corroborator", () => {
    // SPDX identifiers (Apache, MIT, GPL, BSD) are word-bounded in the
    // matcher so a coincidental substring inside a longer identifier
    // never over-fires. Apache is one of the canonical license tokens.
    // Under the co-occurrence rule, the body must also cross the long-
    // line minification corroborator for the verdict to fire — banner
    // alone matches authored partials that adopted the publishing
    // convention.
    const longLine = "y".repeat(600);
    const source = `/*! some-vendor-lib v0.1 | Apache 2.0 License */\nvar a = "${longLine}";\nvar b = "${longLine}";\nvar c = "${longLine}";\n`;
    const result = classifyBuildArtifactDetailed("vendor/some-lib.js", source);
    expect(result?.classification).toBe("likely-vendor-distribution");
    expect(result?.signal.kind).toBe("vendor-copyright-banner");
  });

  it("labels a Modernizr bundle carrying a `/*! modernizr ... */` banner via the curated table when the version is present", () => {
    // Modernizr is on the curated table; the curated branch picks it up
    // first and produces the version-bearing signal. This test pins
    // that precedence (curated wins over generic when both would match).
    const source = "/*! modernizr 3.6.0 (Custom Build) | MIT */\n!function(){}();\n";
    const result = classifyBuildArtifactDetailed("vendor/modernizr.js", source);
    expect(result?.classification).toBe("likely-vendor-distribution");
    expect(result?.signal).toEqual({
      kind: "vendor-banner-version",
      value: "modernizr v3.6.0",
    });
  });

  it("does NOT label a hand-authored file with a `/*` (non-bang) copyright banner — bang-comment is the publishing convention", () => {
    // A regular `/*` comment with a copyright header is the canonical
    // hand-authored license-header shape. The bang-comment `/*!` form
    // is the minifier-preserve marker — rare in authored sources. The
    // predicate requires the bang specifically so authored copyright
    // headers stay unlabeled.
    const source = "/* Copyright (c) 2024 Acme Corp. All rights reserved. */\nvar x = 1;\n";
    expect(classifyBuildArtifact("src/utils.js", source)).toBe(null);
  });

  it("does NOT label a `/*!` banner without any license/copyright token", () => {
    // The bang-comment opener alone is not enough — minifiers also
    // preserve `/*!` for non-license markers (build timestamps, SRI
    // hash hints). The predicate requires BOTH the bang opener AND a
    // license/copyright token in the leading window.
    const source = "/*! Built 2024-01-01 */\nvar x = 1;\n";
    expect(classifyBuildArtifact("src/build-meta.js", source)).toBe(null);
  });

  it("does NOT label a file whose `/*!` banner sits beyond the 1024-char probe window", () => {
    // The probe is bounded to the leading 1024 chars to keep the helper
    // O(1) regardless of file size. Banners conventionally sit at the
    // top of distributed bundles; a `/*!` comment buried deep in a
    // multi-megabyte source is not the field-report shape this targets.
    const padding = "x".repeat(1100);
    const source = `${padding}\n/*! deep-banner Copyright 2024 */\nvar x = 1;\n`;
    expect(classifyBuildArtifact("src/utils.js", source)).toBe(null);
  });

  it("captures the matched banner opener as the signal `value` for greppability when the long-line corroborator co-fires", () => {
    // The signal `value` shape is independent of the co-occurrence
    // gate; the helper that produces it (`detectVendorCopyrightBanner`)
    // is the same function in both branches. To exercise the value-
    // shape contract through the public classifier, the co-occurrence
    // gate must be satisfied — three 600-char lines stand in for the
    // bundle-shape body of a real vendored release.
    const longLine = "z".repeat(600);
    const source = `/*! my-lib v2 | (c) 2024 Author | Released under MIT */\nvar a = "${longLine}";\nvar b = "${longLine}";\nvar c = "${longLine}";\n`;
    const result = classifyBuildArtifactDetailed("vendor/my-lib.js", source);
    expect(result?.signal.kind).toBe("vendor-copyright-banner");
    if (result?.signal.kind === "vendor-copyright-banner") {
      // The `value` is the matched bang-comment opener through the end
      // of the first line (or 120 chars, whichever comes first).
      expect(result.signal.value.startsWith("/*!")).toBe(true);
      expect(result.signal.value.length).toBeLessThanOrEqual(120);
      expect(result.signal.value).toContain("MIT");
    }
  });

  it("does NOT mislabel a banner-bearing readable source whose body crosses the line-stats threshold as `likely-minified-by-line-stats`", () => {
    // Field-report shape: a banner-bearing readable vendor bundle whose
    // body happens to contain enough long lines to trigger the line-
    // stats corroborator. The copyright-banner branch runs BEFORE the
    // long-line probe so the honest verdict ("this is a release
    // artifact") wins over the misleading "minified bytes" label.
    const longLine = "x".repeat(600);
    const source = `/*! some-vendor v0.1 | Copyright 2024 | MIT */\nvar code = "${longLine}";\nvar more = "${longLine}";\nvar third = "${longLine}";\n`;
    const result = classifyBuildArtifactDetailed("vendor/some-vendor.js", source);
    expect(result?.classification).toBe("likely-vendor-distribution");
    expect(result?.signal.kind).toBe("vendor-copyright-banner");
  });

  it("does NOT label a hand-authored SCSS partial whose only vendor-shaped signal is a `/*!` banner with a copyright token", () => {
    // Field-report shape: hand-authored design-system / theme partials
    // commonly adopt the `/*!` + license publishing convention so
    // downstream minifiers preserve the legal banner ("/*! Author
    // copyright 2024 | MIT */"). Per `docs/kb/architecture/ai-first-
    // consumer.md` "Heuristic-mislabeled meta sub-fields are
    // dishonest", banner-only is too weak to drive a
    // `likely-vendor-distribution` verdict — the agent reading the
    // classification budgets the file as not-its-problem and silently
    // misses authored source. Co-occurrence with the long-line
    // corroborator is required; a normal authored partial (short-line
    // body throughout) returns null. The SCSS partial here uses the
    // canonical `_partial.scss` Sass-partial filename + path that the
    // field report named, with a banner adopting the publishing
    // convention but no minification-shape body.
    const source =
      "/*! Author copyright 2024 | MIT */\n$primary-color: #1a73e8;\n$accent-color: #ff5722;\n\n@mixin button-base {\n  display: inline-flex;\n  align-items: center;\n  padding: 0.5rem 1rem;\n  border-radius: 0.25rem;\n}\n";
    expect(classifyBuildArtifact("src/styles/_partial.scss", source)).toBe(null);
  });

  it("does NOT label a hand-authored utility module whose only vendor-shaped signal is a `/*!` banner naming a license", () => {
    // Companion to the SCSS partial test — same shape on the JS axis.
    // An authored utility module that opens with a `/*!` license
    // banner (a publishing convention some teams adopt for internally-
    // shared modules) must not get the `likely-vendor-distribution`
    // verdict on banner alone. The body is short-line throughout, so
    // the long-line corroborator does not co-fire and the predicate
    // returns null — the honest verdict for an authored module the
    // agent should still budget findings against.
    const source =
      "/*! Internal Tools Library | Copyright 2024 Acme | Apache-2.0 */\nexport function formatDate(date) {\n  return date.toISOString().split('T')[0];\n}\n\nexport function parseQuery(input) {\n  return new URLSearchParams(input);\n}\n";
    expect(classifyBuildArtifact("src/utils/internal-tools.js", source)).toBe(null);
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

describe("collectBuildArtifacts — minified-shaped classifications route only through the per-file classifier", () => {
  // Stamp-site discipline invariant: the only classifications that
  // tell agents "this file is the minified bytes" are the two
  // minified-shaped tokens — `definite-min-infix` (path-anchored
  // `.min.` basename) and `likely-minified-by-line-stats` (long-line
  // content-shape probe). Both originate inside
  // `classifyBuildArtifactDetailed`. The sibling-set branches in
  // `collectBuildArtifacts` (`detectSiblingArtifact` →
  // `findSiblingSourcemap`, `findSiblingMinFile`) intentionally emit
  // ONLY `definite-sourcemap-paired` / `definite-vendor-distribution`
  // because the sibling evidence is deterministic for "release
  // artifact" but not for "the bytes in THIS file are minified."
  //
  // Why this guard exists: a previous shape collapsed
  // vendor-distribution and minified into the same `"minified"` token,
  // so a readable jQuery source paired with `jquery.min.js` got the
  // same agent-routing as the actually-minified twin — agents skipped
  // findings on the file the user could read. The split (turn 1) +
  // banner detection (turn 9) restored the per-file classifier as the
  // single stamp site for minified-shaped verdicts. Tests below pin
  // that invariant against future bypass paths (a new sibling-set
  // probe, a new path-pattern shortcut, a new banner classifier
  // mapping the wrong way) re-introducing the regression.

  const MINIFIED_SHAPED: ReadonlySet<BuildArtifactClassification> = new Set([
    "definite-min-infix",
    "likely-minified-by-line-stats",
  ]);

  it("does NOT label an authored HTML file (no min infix, no minification signals) as minified-shaped", () => {
    // Canonical authored HTML: short lines, no `.min.` infix, no
    // hashed filename, not under any build-dir marker, no sourcemap
    // pointer, no vendor banner. `classifyBuildArtifact` must return
    // `null`; `collectBuildArtifacts` must surface no entry at all
    // for this file.
    const source = [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      "  <title>Contact us</title>",
      "</head>",
      "<body>",
      "  <main>",
      "    <h1>Contact</h1>",
      "    <p>Reach the team via the form below.</p>",
      "  </main>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
    expect(classifyBuildArtifact("public-pages/contact.html", source)).toBe(null);
    const labeled = collectBuildArtifacts([{ filePath: "public-pages/contact.html", source }]);
    expect(labeled).toEqual([]);
  });

  it("does NOT label an authored HTML file paired with a sibling `.map` as minified-shaped (sibling branch caps at `definite-sourcemap-paired`)", () => {
    // The sibling-map branch in `detectSiblingArtifact` is the only
    // bypass path the file-level classifier doesn't gate. It MUST emit
    // `definite-sourcemap-paired`, never a minified-shaped token —
    // because pairing a `.map` against its source proves "release
    // artifact pipeline ran," not "the bytes in this file are
    // minified."
    const source = "<!doctype html>\n<html><body><p>Hi</p></body></html>\n";
    const files = [
      { filePath: "site/contact.html", source },
      { filePath: "site/contact.html.map", source: '{"version":3}' },
    ];
    const labeled = collectBuildArtifacts(files);
    const contact = labeled.find((e) => e.path === "site/contact.html");
    expect(contact?.classification).toBe("definite-sourcemap-paired");
    expect(MINIFIED_SHAPED.has(contact?.classification ?? "definite-min-infix")).toBe(false);
  });

  it("does NOT label an authored HTML file paired with a sibling `.min.html` as minified-shaped (sibling branch caps at `definite-vendor-distribution`)", () => {
    // The sibling-min branch in `detectSiblingArtifact` is the second
    // bypass path. It MUST emit `definite-vendor-distribution`, never
    // a minified-shaped token — pairing a `.min.<ext>` sibling proves
    // "this file is a release artifact distributed alongside its
    // minified twin," not "the bytes in this file are minified."
    const files = [
      {
        filePath: "site/landing.html",
        source: "<!doctype html>\n<html><body><h1>Welcome</h1></body></html>\n",
      },
      {
        filePath: "site/landing.min.html",
        source: "<!doctype html><html><body><h1>Welcome</h1></body></html>",
      },
    ];
    const labeled = collectBuildArtifacts(files);
    const landing = labeled.find((e) => e.path === "site/landing.html");
    expect(landing?.classification).toBe("definite-vendor-distribution");
    expect(MINIFIED_SHAPED.has(landing?.classification ?? "definite-min-infix")).toBe(false);
  });

  it("every minified-shaped entry from `collectBuildArtifacts` agrees with the per-file classifier on the same input — no bypass stamp site", () => {
    // Cross-check invariant: for every file in a mixed batch,
    // `collectBuildArtifacts` must agree with `classifyBuildArtifact`
    // on whether the classification is minified-shaped. If the
    // collector ever stamps `definite-min-infix` /
    // `likely-minified-by-line-stats` on a file the per-file
    // classifier returns `null` for (or any non-minified-shaped
    // verdict), a bypass has been re-introduced. The mixed batch
    // includes:
    //   - an authored HTML file with no signals (must not appear)
    //   - a `.min.` HTML twin (must appear, classifier verdict
    //     matches)
    //   - the authored sibling of the `.min.` twin (sibling branch
    //     fires, classification must be vendor-distribution NOT
    //     minified-shaped)
    //   - a sourcemap-paired authored file (sibling-map branch fires,
    //     classification must be sourcemap-paired NOT minified-shaped)
    //   - a content-shape minified CSS bundle (long-line probe fires,
    //     classifier verdict matches the collector's verdict)
    const longLine = "x".repeat(600);
    const minifiedCss = `${longLine}\n${longLine}\n${longLine}\n${longLine}\n`;
    const files = [
      {
        filePath: "pages/about.html",
        source: "<!doctype html>\n<html><body><p>About</p></body></html>\n",
      },
      { filePath: "site/landing.html", source: "<!doctype html>\n<html><body></body></html>\n" },
      { filePath: "site/landing.min.html", source: "<!doctype html><html></html>" },
      { filePath: "site/contact.html", source: "<!doctype html>\n<html></html>\n" },
      { filePath: "site/contact.html.map", source: '{"version":3}' },
      { filePath: "vendor/bundle.css", source: minifiedCss },
    ];
    const labeled = collectBuildArtifacts(files);
    for (const entry of labeled) {
      const file = files.find((f) => f.filePath === entry.path);
      expect(file).toBeDefined();
      if (file === undefined) continue;
      const perFile = classifyBuildArtifact(file.filePath, file.source);
      const collectorMinifiedShaped = MINIFIED_SHAPED.has(entry.classification);
      const perFileMinifiedShaped = perFile !== null && MINIFIED_SHAPED.has(perFile);
      // The invariant: a minified-shaped collector verdict implies the
      // per-file classifier returned the SAME minified-shaped verdict.
      // Sibling-branch verdicts (vendor-distribution, sourcemap-paired)
      // are non-minified-shaped, so they trivially satisfy the
      // implication.
      if (collectorMinifiedShaped) {
        expect(perFileMinifiedShaped).toBe(true);
        expect(perFile).toBe(entry.classification);
      }
    }
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
    expect(out.classified).toEqual([]);
  });

  it("keeps sub-threshold same-basename entries in `classified[]` with kind + classification + signal preserved", () => {
    // Two paths share a basename but fall below the grouping
    // threshold. Zero information loss: the full
    // `{ kind, classification, signal }` record survives under each
    // `classified[i].classifications[]` entry so an agent can read
    // the predicate family, the per-path classification, AND the
    // deterministic predicate evidence.
    const entries = [
      mkEntry("/root/dist/a.min.css", "definite-min-infix"),
      mkEntry("/root/dist/other/a.min.css", "definite-min-infix"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped).toEqual([]);
    expect(out.classified).toEqual([
      {
        path: "dist/a.min.css",
        classifications: [
          {
            kind: "min-infix",
            classification: "definite-min-infix",
            signal: { kind: "min-infix", value: "a.min.css" },
          },
        ],
      },
      {
        path: "dist/other/a.min.css",
        classifications: [
          {
            kind: "min-infix",
            classification: "definite-min-infix",
            signal: { kind: "min-infix", value: "a.min.css" },
          },
        ],
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

  it("sorts classified entries by path alphabetical", () => {
    // Three distinct singletons below threshold — each enters
    // `classified[]` and the output sorts deterministically
    // regardless of input order.
    const entries = [
      mkEntry("/root/z/one.css", "likely-bundler-output-dir"),
      mkEntry("/root/a/two.css", "likely-bundler-output-dir"),
      mkEntry("/root/m/three.css", "likely-bundler-output-dir"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.classified.map((e) => e.path)).toEqual(["a/two.css", "m/three.css", "z/one.css"]);
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

  it("omits `pathHint` + emits repo-wide suggestedGlob when group members share no directory", () => {
    // The three members sit under different top-level dirs, so the
    // longest shared prefix is the empty string. The suggestedGlob
    // degrades to `**/<basename>` — still a legal exclude entry,
    // just repo-wide. The agent sees this and can tighten the glob
    // manually if needed. Per AI-first "ambiguous field shapes"
    // doctrine the `pathHint` field is omitted entirely rather
    // than shipped as `""`, so the agent reads "no actionable
    // directory prefix for this group" rather than disambiguating
    // an empty-string sentinel.
    const entries = [
      mkEntry("/root/dist/a.css", "likely-bundler-output-dir"),
      mkEntry("/root/build/a.css", "likely-bundler-output-dir"),
      mkEntry("/root/public/a.css", "likely-bundler-output-dir"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    const group = out.grouped[0];
    expect(group).toBeDefined();
    expect(group?.pathHint).toBeUndefined();
    expect(group !== undefined && "pathHint" in group).toBe(false);
    expect(group?.suggestedGlob).toBe("**/a.css");
  });

  it("retains `pathHint` when group members share a real common directory prefix", () => {
    // Counter-test to the omission above: when members share a
    // real common directory, `pathHint` is present so the agent
    // can paste it into a tightened exclude glob. Pinning both
    // the present and absent sides locks in the present-when-
    // meaningful contract — drift on either side surfaces here.
    const entries = [
      mkEntry("/root/vendor/bootstrap/5.0/lib.css", "likely-bundler-output-dir"),
      mkEntry("/root/vendor/bootstrap/5.1/lib.css", "likely-bundler-output-dir"),
      mkEntry("/root/vendor/bootstrap/5.2/lib.css", "likely-bundler-output-dir"),
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    const group = out.grouped[0];
    expect(group?.pathHint).toBe("vendor/bootstrap/");
    expect(group?.suggestedGlob).toBe("vendor/bootstrap/**/lib.css");
  });

  it("returns an empty envelope on zero input (honest shape on clean scans)", () => {
    // The caller conditional-spreads the whole meta field on
    // presence (`buildArtifacts.present`), so this function itself
    // returns `{ grouped: [], classified: [] }` when called with no
    // entries — no sentinel `null`, no thrown error.
    expect(groupBuildArtifactsByBasename([], "/root")).toEqual({ grouped: [], classified: [] });
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
    const allPaths = [...out.grouped.map((g) => g.basename), ...out.classified.map((e) => e.path)];
    expect(allPaths).not.toContain("a.css");
    expect(out.classified.map((e) => e.path)).toEqual(["dist/a/b.css"]);
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

// Q12: vendor-library banner detection and the per-file build-artifact
// classifier produced two parallel surfaces (`ungrouped[]` +
// `vendorLibraries[]`) that an agent had to union when triaging a
// path. The merged shape lifts both into `classified[]` with a `kind`
// discriminator; a path firing both predicates rides as one row
// carrying multiple `classifications[]` entries — predicate evidence
// is never collapsed.
describe("groupBuildArtifactsByBasename — Q12 merged classified[] shape", () => {
  it("folds banner-detected vendor libraries into classified[] under kind: vendor-library-version-detected", () => {
    // No build-artifact entries; only a banner identification. The
    // vendor library still rides in `classified[]` so the agent
    // reads one list rather than chasing a separate vendorLibraries
    // sibling.
    const out = groupBuildArtifactsByBasename([], "/root", [
      { path: "/root/vendor/jquery.js", library: "jquery", version: "3.6.0" },
    ]);
    expect(out.grouped).toEqual([]);
    expect(out.classified).toEqual([
      {
        path: "vendor/jquery.js",
        classifications: [
          {
            kind: "vendor-library-version-detected",
            library: "jquery",
            version: "3.6.0",
          },
        ],
      },
    ]);
  });

  it("omits version when the banner did not carry a parseable version slot (animate.css canonical case)", () => {
    const out = groupBuildArtifactsByBasename([], "/root", [
      { path: "/root/vendor/animate.css", library: "animate.css" },
    ]);
    expect(out.classified).toEqual([
      {
        path: "vendor/animate.css",
        classifications: [{ kind: "vendor-library-version-detected", library: "animate.css" }],
      },
    ]);
  });

  it("lists multiple classifications when both predicates fire on the same path (no collapse to strongest)", () => {
    // Bootstrap distribution at `bootstrap.min.css` qualifies under
    // both the `definite-min-infix` predicate AND a banner match.
    // Per AI-first doctrine "list multiple signals — do NOT collapse
    // to the strongest one," both ride.
    const entries = [mkEntry("/root/vendor/bootstrap.min.css", "definite-min-infix")];
    const vendorLibraries = [
      { path: "/root/vendor/bootstrap.min.css", library: "bootstrap", version: "5.3.0" },
    ];
    const out = groupBuildArtifactsByBasename(entries, "/root", vendorLibraries);
    expect(out.grouped).toEqual([]);
    expect(out.classified).toEqual([
      {
        path: "vendor/bootstrap.min.css",
        classifications: [
          {
            kind: "min-infix",
            classification: "definite-min-infix",
            signal: { kind: "min-infix", value: "bootstrap.min.css" },
          },
          {
            kind: "vendor-library-version-detected",
            library: "bootstrap",
            version: "5.3.0",
          },
        ],
      },
    ]);
  });

  it("path-prefix kind covers every non-min build-artifact classification", () => {
    // Path-anchored (bundler-output-dir) and content-shape (compiled-
    // tailwind, vendor-distribution) classifications all land under
    // `kind: "path-prefix"`. The paired `classification` field
    // preserves the specific predicate so auditability isn't lost.
    const entries = [mkEntry("/root/dist/x/app.css", "likely-bundler-output-dir")];
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.classified[0]?.classifications[0]).toEqual({
      kind: "path-prefix",
      classification: "likely-bundler-output-dir",
      signal: { kind: "build-dir-segment", value: "dist/" },
    });
  });

  it("drops vendor-library entries whose path escapes the scan root", () => {
    // Symmetric to the `..`-relative escape behavior of the build-
    // artifact bucketing — a banner identification on a path
    // outside the root is meaningless as an exclude entry, so the
    // merger drops it rather than surfacing a `..`-prefixed path.
    const out = groupBuildArtifactsByBasename([], "/root", [
      { path: "/outside/vendor/jquery.js", library: "jquery" },
    ]);
    expect(out.classified).toEqual([]);
  });
});

// Q-SHARED-META-ARRAY-BUDGET-CAP: `classified` is the tail of the
// grouped shape — it held hundreds of sub-threshold entries on the
// website-templates scan that motivated the cap (148KB of the 281KB
// meta block, then under the prior `ungrouped` field name). The cap
// trims the *list* head-first (alphabetical, deterministic) while
// `classifiedTruncated: { shown, total }` names the settlement.
describe("groupBuildArtifactsByBasename — classified cap (Q-SHARED-META-ARRAY-BUDGET-CAP)", () => {
  it("caps classified at 50 entries and emits classifiedTruncated with the pre-cap total", () => {
    // 120 unique basenames (no clusters form) → every entry lands in
    // `classified[]`, which must cap to 50 with a sibling summary.
    const entries = Array.from({ length: 120 }, (_, i) =>
      mkEntry(`/root/dist/f${String(i).padStart(3, "0")}.css`, "likely-bundler-output-dir"),
    );
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped).toEqual([]);
    expect(out.classified.length).toBe(50);
    expect(out.classifiedTruncated).toEqual({ shown: 50, total: 120 });
    // Head is alphabetical — stable across runs.
    expect(out.classified[0]?.path).toBe("dist/f000.css");
    expect(out.classified[49]?.path).toBe("dist/f049.css");
  });

  it("omits classifiedTruncated when the list fits under the cap", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      mkEntry(`/root/dist/f${i}.css`, "likely-bundler-output-dir"),
    );
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.classified.length).toBe(10);
    expect(out.classifiedTruncated).toBeUndefined();
  });

  it("grouped rows stay compact and uncapped — the cap is a tail-only concern", () => {
    // 60 entries sharing one basename → one grouped row (compact by
    // definition), classified stays empty. The cap doesn't fire and
    // the grouped row's count stays honest.
    const entries = Array.from({ length: 60 }, (_, i) =>
      mkEntry(`/root/d${i}/bootstrap.css`, "likely-bundler-output-dir"),
    );
    const out = groupBuildArtifactsByBasename(entries, "/root");
    expect(out.grouped.length).toBe(1);
    expect(out.grouped[0]?.count).toBe(60);
    expect(out.classified).toEqual([]);
    expect(out.classifiedTruncated).toBeUndefined();
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
