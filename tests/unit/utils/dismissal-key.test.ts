/**
 * Unit tests for the dismissal-key fingerprint utility.
 *
 * Sibling of `tests/unit/utils/group-key.test.ts` for the review-
 * candidate surface. The fingerprint is workflow scaffolding for
 * verdict deduplication on bulk-template trees — the same brand mark
 * fanning out across N templated routes must hash to the same key
 * so an agent records ONE verdict.
 */

import { describe, expect, it } from "bun:test";
import {
  computeDismissalKey,
  DISMISSAL_KEY_HEX_LENGTH,
  normalizeFilenamePattern,
  normalizeSrcBasenamePattern,
} from "../../../src/utils/dismissal-key.ts";

describe("computeDismissalKey", () => {
  it("produces a hex digest of the configured length", () => {
    const key = computeDismissalKey({
      ruleId: "review/images-of-text",
      filenamePattern: "products/*.html",
      srcBasenamePattern: "logo",
    });
    expect(key).toMatch(/^[0-9a-f]+$/);
    expect(key.length).toBe(DISMISSAL_KEY_HEX_LENGTH);
  });

  it("is deterministic — same inputs produce the same key", () => {
    const inputs = {
      ruleId: "review/images-of-text",
      filenamePattern: "products/*.html",
      srcBasenamePattern: "logo",
    };
    expect(computeDismissalKey(inputs)).toBe(computeDismissalKey(inputs));
  });

  it("different rules on the same shape produce different keys", () => {
    const a = computeDismissalKey({
      ruleId: "rule/a",
      filenamePattern: "products/*.html",
      srcBasenamePattern: "logo",
    });
    const b = computeDismissalKey({
      ruleId: "rule/b",
      filenamePattern: "products/*.html",
      srcBasenamePattern: "logo",
    });
    expect(a).not.toBe(b);
  });

  it("different filename patterns on the same rule produce different keys", () => {
    const a = computeDismissalKey({
      ruleId: "review/images-of-text",
      filenamePattern: "products/*.html",
      srcBasenamePattern: "logo",
    });
    const b = computeDismissalKey({
      ruleId: "review/images-of-text",
      filenamePattern: "docs/*.html",
      srcBasenamePattern: "logo",
    });
    expect(a).not.toBe(b);
  });

  it("different src-basename patterns on the same rule produce different keys", () => {
    const a = computeDismissalKey({
      ruleId: "review/images-of-text",
      filenamePattern: "products/*.html",
      srcBasenamePattern: "logo",
    });
    const b = computeDismissalKey({
      ruleId: "review/images-of-text",
      filenamePattern: "products/*.html",
      srcBasenamePattern: "brand-mark",
    });
    expect(a).not.toBe(b);
  });
});

describe("normalizeFilenamePattern", () => {
  it("collapses sibling pages under the same parent dir to one pattern", () => {
    expect(normalizeFilenamePattern("products/iphone-15.html")).toBe("products/*.html");
    expect(normalizeFilenamePattern("products/galaxy-s24.html")).toBe("products/*.html");
    expect(normalizeFilenamePattern("products/pixel-9.html")).toBe("products/*.html");
  });

  it("normalizes leading-slash absolute paths the same as relative", () => {
    expect(normalizeFilenamePattern("/products/iphone.html")).toBe("products/*.html");
  });

  it("uses the LAST directory segment as the pattern anchor", () => {
    // Intermediate dirs vary across sibling routes; the actionable
    // grouping unit is the immediate parent dir.
    expect(normalizeFilenamePattern("2024/products/iphone.html")).toBe("products/*.html");
    expect(normalizeFilenamePattern("2025/products/galaxy.html")).toBe("products/*.html");
  });

  it("handles bare filenames with no directory portion", () => {
    expect(normalizeFilenamePattern("index.html")).toBe("*.html");
    expect(normalizeFilenamePattern("README.md")).toBe("*.md");
  });

  it("handles no-extension files", () => {
    expect(normalizeFilenamePattern("Makefile")).toBe("*");
    expect(normalizeFilenamePattern("docs/Makefile")).toBe("docs/*");
  });

  it("returns empty string on null / undefined / empty input", () => {
    expect(normalizeFilenamePattern(null)).toBe("");
    expect(normalizeFilenamePattern(undefined)).toBe("");
    expect(normalizeFilenamePattern("")).toBe("");
  });
});

describe("normalizeSrcBasenamePattern", () => {
  it("strips the directory portion of a path-style src", () => {
    expect(normalizeSrcBasenamePattern("/assets/logo.png")).toBe("logo");
    expect(normalizeSrcBasenamePattern("/cdn/img/logo.png")).toBe("logo");
  });

  it("drops the file extension so .png and .svg variants of one brand collapse", () => {
    expect(normalizeSrcBasenamePattern("/logo.png")).toBe("logo");
    expect(normalizeSrcBasenamePattern("/logo.svg")).toBe("logo");
    expect(normalizeSrcBasenamePattern("/logo.webp")).toBe("logo");
  });

  it("strips query and fragment components", () => {
    expect(normalizeSrcBasenamePattern("/logo.png?v=2")).toBe("logo");
    expect(normalizeSrcBasenamePattern("/logo.png#hash")).toBe("logo");
    expect(normalizeSrcBasenamePattern("/logo.png?cb=1#h")).toBe("logo");
  });

  it("collapses runs of digits to wildcards (version-stable)", () => {
    expect(normalizeSrcBasenamePattern("/logo-v2.png")).toBe("logo-v*");
    expect(normalizeSrcBasenamePattern("/logo-2024.png")).toBe("logo-*");
    expect(normalizeSrcBasenamePattern("/logo-v3.png")).toBe("logo-v*");
  });

  it("collapses opaque hex hashed filenames to bare wildcard", () => {
    expect(normalizeSrcBasenamePattern("/abc123def.png")).toBe("*");
    expect(normalizeSrcBasenamePattern("/7f3e9a2b1c.png")).toBe("*");
  });

  it("lowercases case-different variants to the same pattern", () => {
    expect(normalizeSrcBasenamePattern("/LOGO.png")).toBe("logo");
    expect(normalizeSrcBasenamePattern("/Logo.PNG")).toBe("logo");
  });

  it("returns empty string on data URIs (no path-bearing identity)", () => {
    expect(normalizeSrcBasenamePattern("data:image/svg+xml,%3Csvg%2F%3E")).toBe("");
    expect(normalizeSrcBasenamePattern("data:image/png;base64,iVBORw0KGgo")).toBe("");
  });

  it("returns empty string on null / undefined / empty input", () => {
    expect(normalizeSrcBasenamePattern(null)).toBe("");
    expect(normalizeSrcBasenamePattern(undefined)).toBe("");
    expect(normalizeSrcBasenamePattern("")).toBe("");
  });

  it("alphabetic suffix variants stay distinct (different brand variants)", () => {
    // `logo-dark` vs `logo-light` are honestly different brand variants
    // — only digit runs are collapsed; alpha suffixes are preserved.
    expect(normalizeSrcBasenamePattern("/logo-dark.svg")).toBe("logo-dark");
    expect(normalizeSrcBasenamePattern("/logo-light.svg")).toBe("logo-light");
  });
});
