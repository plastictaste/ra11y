/**
 * Unit tests for `src/input/file-fingerprint.ts` — the deterministic
 * SHA-1 fingerprint pre-pass that drops byte-identical vendor file
 * copies from the parse loop.
 *
 * Directions:
 *   1. Three byte-identical eligible files collapse to one canonical
 *      (lex-smallest path) plus two duplicates.
 *   2. Non-eligible extensions pass through unchanged regardless of
 *      content (HTML / TSX / etc. never fingerprint).
 *   3. Single-file groups (no duplicates) emit no map entry — the
 *      duplicates map is empty when no dedupe applies.
 *   4. Mixed-content same-extension files do NOT collapse — byte-
 *      identity is the load-bearing predicate, not basename.
 *   5. Reader failure (throws or returns null/undefined) leaves the
 *      path canonical (safe default: never silently drop).
 *   6. Determinism: canonical selection is purely lex-smallest, so
 *      input order doesn't change output.
 *   7. Singletons still ship in `canonicalFiles` (the helper preserves
 *      every input path; only DUPLICATES are dropped).
 */

import { describe, expect, it } from "bun:test";
import {
  FINGERPRINT_DEDUPE_MIN_DISTINCT_PATHS,
  FINGERPRINT_ELIGIBLE_EXTENSIONS,
  fingerprintBytes,
  fingerprintEligibleDuplicates,
  isFingerprintEligibleExtension,
} from "../../../src/input/file-fingerprint.ts";

function reader(map: Readonly<Record<string, string | Buffer | null | undefined>>) {
  return async (path: string) => map[path];
}

describe("file-fingerprint — eligibility predicate", () => {
  it("recognizes the four canonical extensions", () => {
    expect(isFingerprintEligibleExtension("vendor/bootstrap.min.css")).toBe(true);
    expect(isFingerprintEligibleExtension("vendor/jquery.js")).toBe(true);
    expect(isFingerprintEligibleExtension("vendor/bundle.mjs")).toBe(true);
    expect(isFingerprintEligibleExtension("icons/feather.svg")).toBe(true);
  });

  it("rejects authored-source extensions", () => {
    expect(isFingerprintEligibleExtension("src/App.tsx")).toBe(false);
    expect(isFingerprintEligibleExtension("src/App.jsx")).toBe(false);
    expect(isFingerprintEligibleExtension("templates/index.html")).toBe(false);
    expect(isFingerprintEligibleExtension("docs/README.md")).toBe(false);
    expect(isFingerprintEligibleExtension("themes/site.scss")).toBe(false);
  });

  it("matches case-insensitively (Windows-authored repos)", () => {
    expect(isFingerprintEligibleExtension("vendor/BOOTSTRAP.CSS")).toBe(true);
    expect(isFingerprintEligibleExtension("vendor/JQUERY.JS")).toBe(true);
  });

  it("exposes the eligibility set as readonly data", () => {
    expect([...FINGERPRINT_ELIGIBLE_EXTENSIONS].sort()).toEqual([".css", ".js", ".mjs", ".svg"]);
  });
});

describe("fingerprintBytes — sha-1 hex digest", () => {
  it("produces stable hex digests for known inputs", () => {
    // SHA-1 of empty string is a documented constant.
    expect(fingerprintBytes("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(fingerprintBytes("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("treats string and Buffer inputs identically", () => {
    const text = ".btn { color: red; }";
    expect(fingerprintBytes(text)).toBe(fingerprintBytes(Buffer.from(text)));
  });
});

describe("fingerprintEligibleDuplicates — canonical Q15 case", () => {
  it("collapses three byte-identical CSS copies to one canonical with two duplicates", async () => {
    const body = ".btn-warning { color: #aabbcc; background: #fff; }";
    const result = await fingerprintEligibleDuplicates(
      [
        "site-c/css/bootstrap.min.css",
        "site-a/css/bootstrap.min.css",
        "site-b/css/bootstrap.min.css",
      ],
      reader({
        "site-c/css/bootstrap.min.css": body,
        "site-a/css/bootstrap.min.css": body,
        "site-b/css/bootstrap.min.css": body,
      }),
    );
    // Canonical is the lex-smallest path so the wire shape is
    // deterministic across runs regardless of discovery order.
    expect(result.canonicalFiles).toEqual(["site-a/css/bootstrap.min.css"]);
    expect(result.duplicatesByCanonical.size).toBe(1);
    const dups = result.duplicatesByCanonical.get("site-a/css/bootstrap.min.css");
    expect(dups).toEqual(["site-b/css/bootstrap.min.css", "site-c/css/bootstrap.min.css"]);
  });
});

describe("fingerprintEligibleDuplicates — non-eligible extensions", () => {
  it("passes HTML / TSX paths through unchanged regardless of content", async () => {
    // Two byte-identical .tsx files should NOT collapse (eligibility
    // is by extension, not by content). This is the load-bearing
    // guard against silently dropping authored Astro / TSX files
    // sharing a basename — the same failure mode the basename-keyed
    // post-scan dedupe already pinned via VENDOR_DEDUPE_ELIGIBLE_EXTENSIONS.
    const body = "export default function Foo() { return <div />; }";
    const result = await fingerprintEligibleDuplicates(
      ["pkg-a/Foo.tsx", "pkg-b/Foo.tsx"],
      reader({ "pkg-a/Foo.tsx": body, "pkg-b/Foo.tsx": body }),
    );
    expect([...result.canonicalFiles].sort()).toEqual(["pkg-a/Foo.tsx", "pkg-b/Foo.tsx"]);
    expect(result.duplicatesByCanonical.size).toBe(0);
  });
});

describe("fingerprintEligibleDuplicates — singletons + distinct content", () => {
  it("emits empty duplicates map when every eligible file is unique", async () => {
    const result = await fingerprintEligibleDuplicates(
      ["a/style.css", "b/style.css"],
      reader({
        "a/style.css": ".a { color: red; }",
        "b/style.css": ".b { color: blue; }",
      }),
    );
    expect([...result.canonicalFiles].sort()).toEqual(["a/style.css", "b/style.css"]);
    expect(result.duplicatesByCanonical.size).toBe(0);
  });

  it("preserves a single eligible file as canonical without a duplicates entry", async () => {
    const result = await fingerprintEligibleDuplicates(
      ["only/style.css"],
      reader({ "only/style.css": ".x { color: red; }" }),
    );
    expect(result.canonicalFiles).toEqual(["only/style.css"]);
    expect(result.duplicatesByCanonical.size).toBe(0);
  });
});

describe("fingerprintEligibleDuplicates — mixed eligible + ineligible", () => {
  it("dedupes the eligible subset and passes ineligible paths through unchanged", async () => {
    const cssBody = ".btn { color: red; }";
    const result = await fingerprintEligibleDuplicates(
      ["a/style.css", "b/style.css", "src/App.tsx", "src/Other.tsx"],
      reader({
        "a/style.css": cssBody,
        "b/style.css": cssBody,
        "src/App.tsx": "<div />",
        "src/Other.tsx": "<span />",
      }),
    );
    // CSS dedupe to one canonical; TSX paths pass through unchanged.
    expect([...result.canonicalFiles].sort()).toEqual([
      "a/style.css",
      "src/App.tsx",
      "src/Other.tsx",
    ]);
    expect(result.duplicatesByCanonical.get("a/style.css")).toEqual(["b/style.css"]);
  });
});

describe("fingerprintEligibleDuplicates — read failures", () => {
  it("keeps the path canonical when the reader returns null", async () => {
    const result = await fingerprintEligibleDuplicates(["broken/style.css"], async () => null);
    // Safe default: better to parse a file twice than to silently
    // drop one whose contents we couldn't verify.
    expect(result.canonicalFiles).toEqual(["broken/style.css"]);
    expect(result.duplicatesByCanonical.size).toBe(0);
  });

  it("keeps the path canonical when the reader throws", async () => {
    const result = await fingerprintEligibleDuplicates(["broken/style.css"], () =>
      Promise.reject(new Error("permission denied")),
    );
    expect(result.canonicalFiles).toEqual(["broken/style.css"]);
    expect(result.duplicatesByCanonical.size).toBe(0);
  });
});

describe("fingerprintEligibleDuplicates — determinism", () => {
  it("picks the same canonical regardless of input order", async () => {
    const body = ".x { color: red; }";
    const r = reader({
      "a/x.css": body,
      "b/x.css": body,
      "c/x.css": body,
    });
    const forward = await fingerprintEligibleDuplicates(["a/x.css", "b/x.css", "c/x.css"], r);
    const reverse = await fingerprintEligibleDuplicates(["c/x.css", "b/x.css", "a/x.css"], r);
    expect(forward.canonicalFiles).toEqual(reverse.canonicalFiles);
    expect(forward.duplicatesByCanonical.get("a/x.css")).toEqual(
      reverse.duplicatesByCanonical.get("a/x.css"),
    );
  });
});

describe("fingerprintEligibleDuplicates — threshold constant", () => {
  it("requires at least two distinct paths to collapse", () => {
    expect(FINGERPRINT_DEDUPE_MIN_DISTINCT_PATHS).toBe(2);
  });
});
