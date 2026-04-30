/**
 * Tests for `detectVendorContext` and the override-prose composition
 * helpers. Pure-function unit tests over the (filePath, source) input
 * pair — no fs, no parser. The integration-side test that the
 * suggest_fix payload restructures around a populated `vendorContext`
 * lives in `build-suggest-fix-payload.test.ts`.
 *
 * Doctrine bar (`docs/kb/architecture/ai-first-consumer.md` —
 * "Heuristic-mislabeled meta sub-fields are dishonest"): the `signal`
 * field of the returned context names an evidence type the scanner
 * actually has — either a build-artifact predicate that already powers
 * `meta.scannedBuildArtifacts`, or a vendor-library banner match. No
 * filename guessing, no "looks vendored to me" heuristic.
 */

import { describe, expect, it } from "bun:test";

import {
  buildOverridePrimaryExplanation,
  detectVendorContext,
  IN_VENDOR_EDIT_ALTERNATIVE_APPROACH,
  OVERRIDE_PRIMARY_APPROACH,
} from "../../../src/mcp/suggest-fix-vendor-context.ts";

describe("detectVendorContext — vendor-library banner match", () => {
  it("detects Bootstrap by its canonical banner and returns library + version", () => {
    const source = "/*! Bootstrap v5.3.0 (https://getbootstrap.com/) ... */\n.foo {}\n";
    const ctx = detectVendorContext("vendor/bootstrap.css", source);
    expect(ctx).not.toBeNull();
    if (ctx === null) return;
    expect(ctx.signal.kind).toBe("vendor-library");
    if (ctx.signal.kind !== "vendor-library") return;
    expect(ctx.signal.library).toBe("bootstrap");
    expect(ctx.signal.version).toBe("5.3.0");
    expect(ctx.redirectTo).toBe("consumer-override");
  });

  it("detects jQuery without the `Library` token in the banner and captures the version", () => {
    const source = "/*! jQuery v3.6.0 | (c) OpenJS Foundation ... */\n";
    const ctx = detectVendorContext("vendor/jquery.js", source);
    expect(ctx).not.toBeNull();
    if (ctx === null || ctx.signal.kind !== "vendor-library") {
      throw new Error("expected vendor-library signal");
    }
    expect(ctx.signal.library).toBe("jquery");
    expect(ctx.signal.version).toBe("3.6.0");
  });

  it("omits version on libraries whose banner doesn't carry one (animate.css)", () => {
    const source = "/*! @license animate.css - http://daneden.me/animate ... */\n";
    const ctx = detectVendorContext("vendor/animate.css", source);
    expect(ctx).not.toBeNull();
    if (ctx === null || ctx.signal.kind !== "vendor-library") {
      throw new Error("expected vendor-library signal");
    }
    expect(ctx.signal.library).toBe("animate.css");
    expect(ctx.signal).not.toHaveProperty("version");
  });

  it("prefers vendor-library over build-artifact when both fire (e.g. bootstrap.min.css)", () => {
    // .min.css → build-artifact `definite-min-infix` AND Bootstrap
    // banner → vendor-library. The library label is more actionable
    // for the override-prose lane, so it wins.
    const source = "/*! Bootstrap v5.3.0 (https://getbootstrap.com/) ... */\n.foo{color:red}\n";
    const ctx = detectVendorContext("vendor/bootstrap.min.css", source);
    expect(ctx).not.toBeNull();
    if (ctx === null) return;
    expect(ctx.signal.kind).toBe("vendor-library");
  });

  it("classificationSignals carries the banner + the concurrent build-artifact signal", () => {
    // bootstrap.min.css matches both the vendor-library banner and
    // the `definite-min-infix` build-artifact predicate. The
    // `signal` field prefers vendor-library for prose, but
    // `classificationSignals` enumerates both so the agent can
    // sanity-check the redirect rests on multiple deterministic
    // tokens co-occurring (banner + min-infix).
    const source = "/*! Bootstrap v5.3.0 (https://getbootstrap.com/) ... */\n.foo{color:red}\n";
    const ctx = detectVendorContext("vendor/bootstrap.min.css", source);
    if (ctx === null) throw new Error("expected vendor context");
    expect(ctx.classificationSignals).toHaveLength(2);
    expect(ctx.classificationSignals[0]?.kind).toBe("vendor-banner-version");
    expect(ctx.classificationSignals[1]?.kind).toBe("min-infix");
  });

  it("classificationSignals enumerates every deterministic signal that fired (banner + copyright-banner)", () => {
    // The Bootstrap canonical opener (`/*! Bootstrap v5.3.0 ...`)
    // matches BOTH the curated banner table (`vendor-banner-version`)
    // AND the generic `/*!` + license-token predicate
    // (`vendor-copyright-banner`). Both are deterministic; the array
    // surfaces both so the agent can sanity-check the redirect rests
    // on multiple co-occurring signals.
    const source = "/*! Bootstrap v5.3.0 (https://getbootstrap.com/) ... */\n.foo {}\n";
    const ctx = detectVendorContext("vendor/bootstrap.css", source);
    if (ctx === null) throw new Error("expected vendor context");
    expect(ctx.classificationSignals.length).toBeGreaterThanOrEqual(1);
    expect(ctx.classificationSignals[0]?.kind).toBe("vendor-banner-version");
  });
});

describe("detectVendorContext — build-artifact match (high-confidence gate)", () => {
  it("detects .min. infix as definite-min-infix and redirects", () => {
    const ctx = detectVendorContext("vendor/some.min.css", ".a{}");
    expect(ctx).not.toBeNull();
    if (ctx === null || ctx.signal.kind !== "build-artifact") {
      throw new Error("expected build-artifact signal");
    }
    expect(ctx.signal.classification).toBe("definite-min-infix");
    expect(ctx.signal.evidence.kind).toBe("min-infix");
    expect(ctx.redirectTo).toBe("consumer-override");
  });

  it("returns null for likely-bundler-output-dir (dist/) — heuristic, not deterministic", () => {
    // `dist/` is the heuristic-grade `likely-bundler-output-dir`
    // predicate; an author can name a top-level directory `dist/` for
    // unrelated reasons. The redirect must rest on deterministic
    // evidence, so this returns null and the agent gets the rule's
    // actual fix on the non-vendor lane. The
    // `meta.scannedBuildArtifacts` surface still labels the file
    // separately so the agent can audit.
    const ctx = detectVendorContext("dist/assets/app.css", ".a{}");
    expect(ctx).toBeNull();
  });

  it("returns null for likely-hashed-bundle (hex segment) — heuristic, not deterministic", () => {
    // The hashed-filename predicate fires on `app.a1b2c3d4.js` shapes.
    // It is heuristic-grade because tooling tests and identifier-named
    // files can match the same regex; the redirect must not compound a
    // mis-classification.
    const ctx = detectVendorContext("assets/app.a1b2c3d4.js", "// bundle");
    expect(ctx).toBeNull();
  });

  it("returns null for likely-minified-by-line-stats — heuristic, not deterministic", () => {
    // Synthetic minified-shape source: ≥3 long lines (≥ 500 chars each)
    // so the count-floor + ratio corroborator both fire alongside the
    // single-long-line probe — produces the
    // `likely-minified-by-line-stats` classification. This is the
    // canonical Q9 false-positive shape (long-line SCSS function
    // bodies, MDX prop bundles, `calc()` token modules); the redirect
    // must NOT take when only this heuristic fires.
    const longLine = `.foo { content: "${"x".repeat(600)}"; }`;
    const source = [
      ".a { color: red; }",
      longLine,
      ".b { color: blue; }",
      longLine,
      ".c { color: green; }",
      longLine,
    ].join("\n");
    const ctx = detectVendorContext("src/styles/foo.css", source);
    expect(ctx).toBeNull();
  });

  it("classificationSignals carries the build-artifact evidence on the high-confidence path", () => {
    const ctx = detectVendorContext("vendor/some.min.css", ".a{}");
    if (ctx === null) throw new Error("expected vendor context");
    expect(ctx.classificationSignals).toHaveLength(1);
    expect(ctx.classificationSignals[0]?.kind).toBe("min-infix");
  });
});

describe("detectVendorContext — non-vendor / hand-authored cases", () => {
  it("returns null for a plain authored CSS file with no banner and no path marker", () => {
    const ctx = detectVendorContext("src/styles/Button.css", ".btn { color: blue; }\n");
    expect(ctx).toBeNull();
  });

  it("returns null for a hand-authored TSX file at the project root", () => {
    const ctx = detectVendorContext("src/components/Toolbar.tsx", "const x = 1;\n");
    expect(ctx).toBeNull();
  });

  it("returns null for an empty source with a non-vendor path", () => {
    expect(detectVendorContext("src/index.ts", "")).toBeNull();
  });
});

describe("buildOverridePrimaryExplanation", () => {
  it("names the vendor library + the failing selector when both are known", () => {
    const ctx = detectVendorContext(
      "vendor/bootstrap.css",
      "/*! Bootstrap v5.3.0 (https://getbootstrap.com/) ... */\n.foo {}\n",
    );
    if (ctx === null) throw new Error("expected vendor context");
    const prose = buildOverridePrimaryExplanation(
      "vendor/bootstrap.css",
      ctx,
      ".btn-primary { color: #fff; background: #007bff; }",
    );
    expect(prose).toContain("bootstrap");
    expect(prose).toContain(".btn-primary");
    expect(prose).toContain("bootstrap.css");
    // Prose names the load-order rule the agent has to apply.
    expect(prose).toContain("AFTER");
  });

  it("falls back to a generic selector phrase when the rule didn't emit a snippet", () => {
    const ctx = detectVendorContext(
      "vendor/bootstrap.css",
      "/*! Bootstrap v5.3.0 (https://getbootstrap.com/) ... */\n.foo {}\n",
    );
    if (ctx === null) throw new Error("expected vendor context");
    const prose = buildOverridePrimaryExplanation("vendor/bootstrap.css", ctx, undefined);
    expect(prose).toContain("flagged above");
    // Backticked-snippet path is NOT taken when no selector evidence
    // exists — the prose stays honest about what the scanner knows.
    expect(prose).not.toMatch(/`\.btn-/);
  });

  it("uses the artifact basename + generic ordering hint on a build-artifact (non-library) signal", () => {
    // `vendor/app.min.css` is `definite-min-infix` — passes the high-
    // confidence gate. (`dist/assets/app.css` is now `null` because
    // `likely-bundler-output-dir` is heuristic-grade and no longer
    // earns the redirect.)
    const ctx = detectVendorContext("vendor/app.min.css", ".a{}");
    if (ctx === null) throw new Error("expected vendor context");
    const prose = buildOverridePrimaryExplanation("vendor/app.min.css", ctx, ".foo");
    expect(prose).toContain("app.min.css");
    expect(prose).toContain("build artifact");
    expect(prose).toContain("AFTER");
    // No library name to thread when the signal is build-artifact-only.
    expect(prose).not.toContain("library");
  });

  it("warns about dependency-bump churn so the agent knows why in-place edits lose", () => {
    const ctx = detectVendorContext("vendor/some.min.css", ".a{}");
    if (ctx === null) throw new Error("expected vendor context");
    const prose = buildOverridePrimaryExplanation("vendor/some.min.css", ctx, undefined);
    expect(prose).toContain("dependency");
  });
});

describe("OVERRIDE_PRIMARY_APPROACH / IN_VENDOR_EDIT_ALTERNATIVE_APPROACH labels", () => {
  it("primary-approach label names the override action terse-first", () => {
    expect(OVERRIDE_PRIMARY_APPROACH).toBe("Override the failing selector in your own stylesheet");
  });

  it("alternative-approach label names the demoted in-vendor edit fallback", () => {
    expect(IN_VENDOR_EDIT_ALTERNATIVE_APPROACH).toMatch(/^Edit the vendor file in place/);
  });
});
