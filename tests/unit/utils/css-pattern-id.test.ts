/**
 * Unit tests for `src/utils/css-pattern-id.ts` — the cross-file CSS-
 * declaration fingerprint that lets the collapse helper roll up
 * 117-copy template-catalog findings into one canonical entry by
 * construction (instead of 117 distinct per-file `groupKey` rows).
 */

import { describe, expect, it } from "bun:test";
import {
  CSS_PATTERN_ID_HEX_LENGTH,
  canonicalizePropertyFamily,
  canonicalizeSelectorFamily,
  canonicalizeValueShape,
  computeCssPatternId,
  maybeCssPatternId,
} from "../../../src/utils/css-pattern-id.ts";

describe("canonicalizeSelectorFamily", () => {
  it("lowercases and collapses internal whitespace", () => {
    expect(canonicalizeSelectorFamily(".IMG-Thumbnail   .Inner")).toBe(".img-thumbnail .inner");
  });

  it("replaces 3+ digit numeric tokens with #", () => {
    expect(canonicalizeSelectorFamily(".btn-12345")).toBe(".btn-#");
    expect(canonicalizeSelectorFamily("#hash-abc456")).toBe("#hash-abc#");
  });

  it("replaces trailing -<digits> identifiers with -#", () => {
    expect(canonicalizeSelectorFamily(".btn-7")).toBe(".btn-#");
    expect(canonicalizeSelectorFamily(".tab-3")).toBe(".tab-#");
  });

  it("preserves stable alphabetic class tokens", () => {
    // .img-thumbnail / .navbar-toggle survive untouched — the dedup
    // case the collapse helper depends on.
    expect(canonicalizeSelectorFamily(".img-thumbnail")).toBe(".img-thumbnail");
    expect(canonicalizeSelectorFamily(".navbar-toggle")).toBe(".navbar-toggle");
  });

  it("empty input canonicalizes to empty output", () => {
    expect(canonicalizeSelectorFamily("")).toBe("");
  });
});

describe("canonicalizePropertyFamily", () => {
  it("lowercases and trims", () => {
    expect(canonicalizePropertyFamily("  Animation-Duration  ")).toBe("animation-duration");
  });

  it("does NOT fold shorthand and longhand together", () => {
    expect(canonicalizePropertyFamily("background")).not.toBe(
      canonicalizePropertyFamily("background-color"),
    );
  });
});

describe("canonicalizeValueShape", () => {
  it("lowercases and collapses internal whitespace", () => {
    expect(canonicalizeValueShape("Spin   1S    INFINITE")).toBe("spin 1s infinite");
  });

  it("replaces var(--name) with var(#)", () => {
    expect(canonicalizeValueShape("var(--brand-primary)")).toBe("var(#)");
    expect(canonicalizeValueShape("calc(var(--space) * 2)")).toBe("calc(var(#) * 2)");
  });

  it("strips template/SSG interpolation placeholders", () => {
    expect(canonicalizeValueShape("{{ duration }}s ease")).toBe("#s ease");
    expect(canonicalizeValueShape("${duration}s linear")).toBe("#s linear");
  });

  it("empty input canonicalizes to empty output", () => {
    expect(canonicalizeValueShape("")).toBe("");
  });
});

describe("computeCssPatternId", () => {
  it("produces a 12-hex-char digest", () => {
    const id = computeCssPatternId({
      ruleId: "contrast/minimum",
      selectorFamily: ".img-thumbnail",
      propertyFamily: "color+background",
      valueShape: "#fff|#90caf9|4.5",
    });
    expect(id).toBeDefined();
    expect(id?.length).toBe(CSS_PATTERN_ID_HEX_LENGTH);
    expect(id).toMatch(/^[0-9a-f]{12}$/u);
  });

  it("117 byte-identical inputs produce one cssPatternId", () => {
    // The headline invariant from the backlog item: same selector +
    // same declaration shape across N files collapses to ONE token.
    const ids = new Set<string>();
    for (let i = 0; i < 117; i++) {
      const id = computeCssPatternId({
        ruleId: "contrast/minimum",
        selectorFamily: ".img-thumbnail",
        propertyFamily: "color+background",
        valueShape: "#fff|#90caf9|4.5",
      });
      if (id) ids.add(id);
    }
    expect(ids.size).toBe(1);
  });

  it("different rule IDs produce different cssPatternIds for the same triple", () => {
    const idA = computeCssPatternId({
      ruleId: "contrast/minimum",
      selectorFamily: ".img-thumbnail",
      propertyFamily: "color+background",
      valueShape: "#fff|#90caf9|4.5",
    });
    const idB = computeCssPatternId({
      ruleId: "contrast/non-text",
      selectorFamily: ".img-thumbnail",
      propertyFamily: "color+background",
      valueShape: "#fff|#90caf9|4.5",
    });
    expect(idA).not.toBe(idB);
  });

  it("different selector families produce different cssPatternIds", () => {
    const idA = computeCssPatternId({
      ruleId: "motion/pause-stop-hide",
      selectorFamily: ".img-thumbnail",
      propertyFamily: "transition",
      valueShape: "all 0.2s ease",
    });
    const idB = computeCssPatternId({
      ruleId: "motion/pause-stop-hide",
      selectorFamily: ".btn-primary",
      propertyFamily: "transition",
      valueShape: "all 0.2s ease",
    });
    expect(idA).not.toBe(idB);
  });

  it("differs only in numeric suffix collapses to one cssPatternId", () => {
    // `.btn-1` and `.btn-2` both round to `.btn-#`, so the rule firing
    // on `.btn-1`, `.btn-2`, `.btn-3` etc. all fingerprint identically.
    const idA = computeCssPatternId({
      ruleId: "motion/pause-stop-hide",
      selectorFamily: ".btn-1",
      propertyFamily: "transition",
      valueShape: "all 0.2s ease",
    });
    const idB = computeCssPatternId({
      ruleId: "motion/pause-stop-hide",
      selectorFamily: ".btn-99",
      propertyFamily: "transition",
      valueShape: "all 0.2s ease",
    });
    expect(idA).toBe(idB);
  });

  it("var(--token) substitution does not fork the hash", () => {
    // var(--brand-a) and var(--brand-b) both round to var(#) — one-
    // level custom-property substitution doesn't fragment the
    // fingerprint across cross-file token swaps.
    const idA = computeCssPatternId({
      ruleId: "contrast/minimum",
      selectorFamily: ".btn",
      propertyFamily: "color+background",
      valueShape: "var(--brand-a)|#fff|4.5",
    });
    const idB = computeCssPatternId({
      ruleId: "contrast/minimum",
      selectorFamily: ".btn",
      propertyFamily: "color+background",
      valueShape: "var(--brand-b)|#fff|4.5",
    });
    expect(idA).toBe(idB);
  });

  it("returns undefined when all three input fields canonicalize to empty", () => {
    const id = computeCssPatternId({
      ruleId: "contrast/minimum",
      selectorFamily: "",
      propertyFamily: "",
      valueShape: "",
    });
    expect(id).toBeUndefined();
  });
});

describe("maybeCssPatternId", () => {
  it("returns undefined when fingerprint is undefined", () => {
    expect(maybeCssPatternId("contrast/minimum", undefined)).toBeUndefined();
  });

  it("returns the digest when fingerprint is populated", () => {
    const id = maybeCssPatternId("contrast/minimum", {
      selectorFamily: ".img-thumbnail",
      propertyFamily: "color+background",
      valueShape: "#fff|#90caf9|4.5",
    });
    expect(id).toBeDefined();
    expect(id).toMatch(/^[0-9a-f]{12}$/u);
  });
});
