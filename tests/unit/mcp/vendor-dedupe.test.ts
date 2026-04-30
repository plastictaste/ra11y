/**
 * Unit tests for `src/mcp/vendor-dedupe.ts` — the cross-file dedupe pass
 * that collapses identical findings repeating across sibling files sharing
 * a basename (canonical case: 100+ copies of `bootstrap.css` inside a
 * website-template catalog all emitting the same `contrast/minimum`
 * finding) into one canonical finding with a `vendorOccurrences` sibling
 * list.
 *
 * Directions:
 *   1. The canonical case: N identical contrast findings across N sibling
 *      copies of `bootstrap.css` collapse to one with
 *      `vendorOccurrences.length === N`. Direct Q6 reproduction.
 *   2. Same-basename singleton findings pass through unchanged — no
 *      collapse when there's only one copy.
 *   3. Different-basename findings never collapse even when message
 *      matches (same rule on different files is not the vendor-copy
 *      pattern).
 *   4. Same-basename findings keyed off `patternId` (when rule emits
 *      snippet) collapse by patternId, not message. Fallback to message
 *      only when patternId is absent.
 *   5. Determinism: the canonical finding is picked lexicographically by
 *      (path, line) so output is stable regardless of input order.
 *   6. Multiple-file-multiple-finding bucket: same rule firing twice on
 *      the same selector+ratio shape in each of N vendor copies — the
 *      canonical finding carries every occurrence, and per-finding
 *      position on the line doesn't mask the bucket identity.
 */

import { describe, expect, it } from "bun:test";
import {
  collapseVendorCssFindings,
  VENDOR_DEDUPE_MIN_DISTINCT_PATHS,
  VENDOR_JS_BASENAME_PATTERNS,
} from "../../../src/mcp/vendor-dedupe.ts";
import type { Violation } from "../../../src/types/violation.ts";

function contrastViolation(overrides: {
  readonly filePath: string;
  readonly line?: number;
  readonly message?: string;
  readonly ruleId?: string;
  readonly patternId?: string;
}): Violation {
  return {
    ruleId: overrides.ruleId ?? "contrast/minimum",
    fixClass: "guidance",
    criteria: ["wcag22:1.4.3"],
    severity: "error",
    location: {
      filePath: overrides.filePath,
      line: overrides.line ?? 42,
      column: 1,
    },
    message:
      overrides.message ??
      "'.btn-primary' has color contrast ratio 2.30:1 against its background — WCAG 2.2 1.4.3 requires 4.5:1 for normal text.",
    findingId: `fid-${overrides.filePath}-${overrides.line ?? 42}`,
    findingGroupId: `gid-${overrides.filePath}-${overrides.line ?? 42}`,
    groupKey: "gk-contrast",
    ...(overrides.patternId !== undefined && { patternId: overrides.patternId }),
  };
}

describe("collapseVendorCssFindings — canonical Q6 case", () => {
  it("collapses 5 identical contrast findings across sibling bootstrap.css into one with vendorOccurrences.length === 5", () => {
    const input: readonly Violation[] = [
      contrastViolation({ filePath: "templates/site-a/css/bootstrap.css", line: 402 }),
      contrastViolation({ filePath: "templates/site-b/css/bootstrap.css", line: 402 }),
      contrastViolation({ filePath: "templates/site-c/css/bootstrap.css", line: 402 }),
      contrastViolation({ filePath: "templates/site-d/css/bootstrap.css", line: 402 }),
      contrastViolation({ filePath: "templates/site-e/css/bootstrap.css", line: 402 }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(1);
    const canonical = out[0] as Violation;
    expect(canonical.vendorOccurrences).toBeDefined();
    expect(canonical.vendorOccurrences).toHaveLength(5);
    // Canonical is the lexicographically smallest path.
    expect(canonical.location.filePath).toBe("templates/site-a/css/bootstrap.css");
    // vendorOccurrences includes the canonical copy's own (path, line)
    // as the first entry, so consumers iterate the full list without
    // cross-referencing the outer finding's location.
    const paths = canonical.vendorOccurrences?.map((o) => o.path) ?? [];
    expect(paths).toEqual([
      "templates/site-a/css/bootstrap.css",
      "templates/site-b/css/bootstrap.css",
      "templates/site-c/css/bootstrap.css",
      "templates/site-d/css/bootstrap.css",
      "templates/site-e/css/bootstrap.css",
    ]);
  });
});

describe("collapseVendorCssFindings — singletons + different basenames pass through", () => {
  it("passes a single bootstrap.css finding through unchanged (no vendorOccurrences stamp)", () => {
    const input: readonly Violation[] = [
      contrastViolation({ filePath: "templates/site-a/css/bootstrap.css" }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(1);
    expect((out[0] as Violation).vendorOccurrences).toBeUndefined();
  });

  it("does NOT collapse findings across different basenames even when message matches", () => {
    // Canonical counter-case: two different stylesheets (site-a/styles.css
    // and site-b/theme.css) that happen to emit the same message are NOT
    // the vendor-copy pattern. Dedupe keys on basename — by design.
    const input: readonly Violation[] = [
      contrastViolation({ filePath: "site-a/styles.css" }),
      contrastViolation({ filePath: "site-b/theme.css" }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    expect((out[0] as Violation).vendorOccurrences).toBeUndefined();
    expect((out[1] as Violation).vendorOccurrences).toBeUndefined();
  });

  it("does NOT collapse same-basename findings with different messages (different selectors / ratios)", () => {
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "site-a/css/bootstrap.css",
        message: "'.btn-primary' has ratio 2.30:1 …",
      }),
      contrastViolation({
        filePath: "site-b/css/bootstrap.css",
        message: "'.btn-secondary' has ratio 3.10:1 …",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    expect((out[0] as Violation).vendorOccurrences).toBeUndefined();
    expect((out[1] as Violation).vendorOccurrences).toBeUndefined();
  });
});

describe("collapseVendorCssFindings — patternId vs message fallback", () => {
  it("uses patternId when present, collapsing across sibling files with matching patternId", () => {
    // Two findings in sibling dirs sharing a CSS-family basename. The rule
    // emitted a snippet so the engine stamped `patternId`. Messages differ
    // (e.g. line numbers embedded in prose) but patternId matches —
    // collapse.
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "templates/site-a/styles/theme.scss",
        message: "contrast 2.30:1 at line 4",
        patternId: "pid-abc123",
      }),
      contrastViolation({
        filePath: "templates/site-b/styles/theme.scss",
        message: "contrast 2.30:1 at line 6",
        patternId: "pid-abc123",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(1);
    expect((out[0] as Violation).vendorOccurrences).toHaveLength(2);
  });

  it("keeps distinct patternIds separate even with identical basename+ruleId", () => {
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "templates/site-a/styles/theme.scss",
        patternId: "pid-aaa",
      }),
      contrastViolation({
        filePath: "templates/site-b/styles/theme.scss",
        patternId: "pid-bbb",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
  });
});

describe("collapseVendorCssFindings — extension scope", () => {
  // the dedupe is scoped to CSS-family
  // extensions so authored files (Astro layouts, TSX components, HTML
  // partials, etc.) that happen to share a framework-idiomatic basename
  // across sibling directories do not collapse. Collapsing them would drop
  // the non-canonical source files from `scan_project`'s `files[]` entirely
  // — a silent per-file zero-output failure CLAUDE.md §1 warns against.
  it("does NOT collapse same-basename Astro layout files across sibling projects", () => {
    // Canonical repro from the backlog entry: one Astro site defines
    // `BaseLayout.astro` at `site/src/layouts/`, a sibling example site also
    // defines `BaseLayout.astro`. Same basename + same ruleId + (coincidentally)
    // same patternId — the old dedupe would collapse and silently drop the
    // site-a/src/layouts version from the response.
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "site/src/layouts/BaseLayout.astro",
        ruleId: "parsing/html-has-lang",
        patternId: "pid-base",
      }),
      contrastViolation({
        filePath: "examples/starter/src/layouts/BaseLayout.astro",
        ruleId: "parsing/html-has-lang",
        patternId: "pid-base",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    for (const v of out) {
      expect(v.vendorOccurrences).toBeUndefined();
    }
    const paths = out.map((v) => v.location.filePath).sort();
    expect(paths).toEqual([
      "examples/starter/src/layouts/BaseLayout.astro",
      "site/src/layouts/BaseLayout.astro",
    ]);
  });

  it("does NOT collapse authored HTML partials with the same basename", () => {
    // Jekyll-style: multiple projects each with their own `default.html`
    // layout partial. Not a vendor drop; do not collapse.
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "project-a/_layouts/default.html",
        ruleId: "parsing/html-has-lang",
        patternId: "pid-xyz",
      }),
      contrastViolation({
        filePath: "project-b/_layouts/default.html",
        ruleId: "parsing/html-has-lang",
        patternId: "pid-xyz",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
  });

  it("does NOT collapse same-basename TSX component files across sibling directories", () => {
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "packages/app-a/src/Header.tsx",
        ruleId: "aria/labelledby-target-exists",
        patternId: "pid-header",
      }),
      contrastViolation({
        filePath: "packages/app-b/src/Header.tsx",
        ruleId: "aria/labelledby-target-exists",
        patternId: "pid-header",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
  });

  it("still collapses CSS-family extensions (.scss, .less, .sass) alongside .css", () => {
    // The preprocessor extensions land in the same vendor-copy regime as
    // `.css` — bootstrap's `_buttons.scss`, etc., get vendored into
    // template catalogs just as often as the compiled output. Ensure the
    // scope includes all four.
    for (const ext of [".css", ".scss", ".sass", ".less"]) {
      const input: readonly Violation[] = [
        contrastViolation({ filePath: `templates/site-a/styles/bootstrap${ext}`, line: 100 }),
        contrastViolation({ filePath: `templates/site-b/styles/bootstrap${ext}`, line: 100 }),
      ];
      const out = collapseVendorCssFindings(input);
      expect(out).toHaveLength(1);
      expect((out[0] as Violation).vendorOccurrences).toHaveLength(2);
    }
  });
});

describe("collapseVendorCssFindings — multiple rules", () => {
  it("collapses per-rule independently — two different rules on the same basename each get their own vendor bucket", () => {
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "site-a/css/bootstrap.css",
        ruleId: "contrast/minimum",
      }),
      contrastViolation({
        filePath: "site-b/css/bootstrap.css",
        ruleId: "contrast/minimum",
      }),
      contrastViolation({
        filePath: "site-a/css/bootstrap.css",
        ruleId: "motion/pause-stop-hide",
      }),
      contrastViolation({
        filePath: "site-b/css/bootstrap.css",
        ruleId: "motion/pause-stop-hide",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    const ruleIds = new Set(out.map((v) => v.ruleId));
    expect(ruleIds).toEqual(new Set(["contrast/minimum", "motion/pause-stop-hide"]));
    for (const v of out) {
      expect(v.vendorOccurrences).toHaveLength(2);
    }
  });
});

describe("collapseVendorCssFindings — determinism", () => {
  it("picks the lexicographically smallest path as canonical regardless of input order", () => {
    const a = contrastViolation({ filePath: "templates/site-z/css/bootstrap.css", line: 10 });
    const b = contrastViolation({ filePath: "templates/site-a/css/bootstrap.css", line: 20 });
    const c = contrastViolation({ filePath: "templates/site-m/css/bootstrap.css", line: 15 });
    const forward = collapseVendorCssFindings([a, b, c]);
    const reverse = collapseVendorCssFindings([c, b, a]);
    expect(forward).toHaveLength(1);
    expect(reverse).toHaveLength(1);
    expect((forward[0] as Violation).location.filePath).toBe("templates/site-a/css/bootstrap.css");
    expect((reverse[0] as Violation).location.filePath).toBe("templates/site-a/css/bootstrap.css");
    // Same occurrences list either way.
    const forwardPaths = (forward[0] as Violation).vendorOccurrences?.map((o) => o.path);
    const reversePaths = (reverse[0] as Violation).vendorOccurrences?.map((o) => o.path);
    expect(forwardPaths).toEqual(reversePaths);
  });
});

describe("collapseVendorCssFindings — threshold constant", () => {
  it("VENDOR_DEDUPE_MIN_DISTINCT_PATHS is 2 — collapse fires on the first cross-file duplicate", () => {
    expect(VENDOR_DEDUPE_MIN_DISTINCT_PATHS).toBe(2);
  });
});

describe("collapseVendorCssFindings — JS vendor basename scope", () => {
  // extends the cross-file
  // dedupe to JS vendor drops (`jquery.*`, `bootstrap.js`, `wow.*`,
  // `headroom.*`, `fancybox*`, `flexslider*`). Unlike CSS, plain `.js` /
  // `.mjs` is also the default extension for authored code, so JS dedupe
  // is gated on the basename matching a vendor pattern. Authored files
  // sharing a basename across packages (e.g. `index.js`, `utils.js`)
  // continue to pass through untouched.
  it("collapses three copies of jquery.flexslider.js across template directories — the canonical V1 case", () => {
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "templates/template-1/js/jquery.flexslider.js",
        line: 4,
        ruleId: "media/captions-prerecorded",
      }),
      contrastViolation({
        filePath: "templates/template-2/js/jquery.flexslider.js",
        line: 4,
        ruleId: "media/captions-prerecorded",
      }),
      contrastViolation({
        filePath: "templates/template-3/js/jquery.flexslider.js",
        line: 4,
        ruleId: "media/captions-prerecorded",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(1);
    const canonical = out[0] as Violation;
    expect(canonical.vendorOccurrences).toHaveLength(3);
    const paths = canonical.vendorOccurrences?.map((o) => o.path) ?? [];
    expect(paths).toEqual([
      "templates/template-1/js/jquery.flexslider.js",
      "templates/template-2/js/jquery.flexslider.js",
      "templates/template-3/js/jquery.flexslider.js",
    ]);
  });

  it("does NOT collapse two unrelated authored .js files with the same basename", () => {
    // `index.js` is the canonical authored-code basename — every package
    // in a monorepo has one. Same basename + same ruleId + same patternId
    // is coincidence, not a vendor drop. Collapsing would silently drop
    // the non-canonical source from `files[]`.
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "packages/pkg-a/src/index.js",
        ruleId: "media/captions-prerecorded",
        patternId: "pid-shared",
      }),
      contrastViolation({
        filePath: "packages/pkg-b/src/index.js",
        ruleId: "media/captions-prerecorded",
        patternId: "pid-shared",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    for (const v of out) {
      expect(v.vendorOccurrences).toBeUndefined();
    }
  });

  it("does NOT collapse same-basename .ts / .tsx authored code even when basename matches a vendor pattern", () => {
    // A type definition or wrapper file named e.g. `flexslider.ts` is
    // authored code — only the built `.js` / `.mjs` extension qualifies,
    // and only when paired with a vendor-pattern basename.
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "packages/app-a/src/flexslider.ts",
        ruleId: "media/captions-prerecorded",
        patternId: "pid-fs",
      }),
      contrastViolation({
        filePath: "packages/app-b/src/flexslider.ts",
        ruleId: "media/captions-prerecorded",
        patternId: "pid-fs",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
  });

  it("collapses common JS vendor basenames listed in the doctrine: jquery, bootstrap, wow, headroom, fancybox, flexslider", () => {
    // Worked-example sweep — each named pattern in the
    // VENDOR_JS_BASENAME_PATTERNS comment must collapse on the canonical
    // basename it documents. If any line goes red, either the regex is
    // wrong or the doctrine string is wrong.
    const cases: { readonly basename: string }[] = [
      { basename: "jquery.js" },
      { basename: "jquery.min.js" },
      { basename: "jquery-3.6.0.min.js" },
      { basename: "jquery.flexslider.js" },
      { basename: "bootstrap.js" },
      { basename: "bootstrap.min.js" },
      { basename: "bootstrap.bundle.js" },
      { basename: "bootstrap.bundle.mjs" },
      { basename: "wow.js" },
      { basename: "wow.min.js" },
      { basename: "headroom.js" },
      { basename: "headroom.min.js" },
      { basename: "fancybox.js" },
      { basename: "fancybox.pack.js" },
      { basename: "flexslider.js" },
      { basename: "flexslider.min.js" },
    ];
    for (const { basename } of cases) {
      const input: readonly Violation[] = [
        contrastViolation({
          filePath: `templates/site-a/js/${basename}`,
          line: 4,
          ruleId: "media/captions-prerecorded",
        }),
        contrastViolation({
          filePath: `templates/site-b/js/${basename}`,
          line: 4,
          ruleId: "media/captions-prerecorded",
        }),
      ];
      const out = collapseVendorCssFindings(input);
      expect(out).toHaveLength(1);
      expect((out[0] as Violation).vendorOccurrences).toHaveLength(2);
    }
  });

  it("collapses .mjs vendor drops alongside .js (modern ES-module bundle variant)", () => {
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "templates/site-a/js/bootstrap.bundle.mjs",
        line: 4,
        ruleId: "media/captions-prerecorded",
      }),
      contrastViolation({
        filePath: "templates/site-b/js/bootstrap.bundle.mjs",
        line: 4,
        ruleId: "media/captions-prerecorded",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(1);
    expect((out[0] as Violation).vendorOccurrences).toHaveLength(2);
  });

  it("does NOT collapse JS files whose basename does not match any vendor pattern (e.g. lodash, react)", () => {
    // The vendor list is curated, not exhaustive. Other common library
    // basenames pass through as independent findings — the agent dismisses
    // in one read; an over-eager dedupe drops authored code silently.
    const input: readonly Violation[] = [
      contrastViolation({
        filePath: "templates/site-a/js/lodash.min.js",
        ruleId: "media/captions-prerecorded",
        patternId: "pid-shared",
      }),
      contrastViolation({
        filePath: "templates/site-b/js/lodash.min.js",
        ruleId: "media/captions-prerecorded",
        patternId: "pid-shared",
      }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    for (const v of out) {
      expect(v.vendorOccurrences).toBeUndefined();
    }
  });

  it("VENDOR_JS_BASENAME_PATTERNS exports the documented patterns for caller-pinning", () => {
    // The list is the API surface for the doctrine. Pin its identity so a
    // doctrine drift (e.g. accidental `wow.*` removal) shows up red here
    // before it surfaces as a silent regression in the canonical V1 corpus.
    expect(VENDOR_JS_BASENAME_PATTERNS.length).toBeGreaterThanOrEqual(6);
    expect(VENDOR_JS_BASENAME_PATTERNS.some((re) => re.test("jquery.flexslider.js"))).toBe(true);
    expect(VENDOR_JS_BASENAME_PATTERNS.some((re) => re.test("bootstrap.bundle.min.js"))).toBe(true);
    expect(VENDOR_JS_BASENAME_PATTERNS.some((re) => re.test("flexslider.js"))).toBe(true);
    // Authored-code basenames must not match.
    expect(VENDOR_JS_BASENAME_PATTERNS.some((re) => re.test("index.js"))).toBe(false);
    expect(VENDOR_JS_BASENAME_PATTERNS.some((re) => re.test("utils.js"))).toBe(false);
  });
});

describe("collapseVendorCssFindings — same-file duplicates do NOT collapse", () => {
  it("passes two findings on the same file through unchanged — not the cross-file pattern", () => {
    // Two findings on the same bootstrap.css (one file, two rules or two
    // call sites of the same rule) do NOT collapse: the dedupe is
    // cross-file by design. Per-file rollup is a different lane
    // (per-rule-coverage `concentration`), not this one.
    const input: readonly Violation[] = [
      contrastViolation({ filePath: "site-a/css/bootstrap.css", line: 10 }),
      contrastViolation({ filePath: "site-a/css/bootstrap.css", line: 20 }),
    ];
    const out = collapseVendorCssFindings(input);
    expect(out).toHaveLength(2);
    for (const v of out) {
      expect(v.vendorOccurrences).toBeUndefined();
    }
  });
});
