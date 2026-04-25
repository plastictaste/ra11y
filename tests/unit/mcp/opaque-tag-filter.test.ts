/**
 * Unit tests for the Q6 phantom-tag-extraction filter shared by
 * `analysis-coverage.ts` (opaque-component inventory) and
 * `detect-wrappers-core.ts` (wrapper-candidate extraction).
 *
 * The filter exists because the in-house TSX parser runs on every
 * `.ts` / `.tsx` / `.js` / `.jsx` file (one parser for the family) and
 * sometimes emits phantom JSX elements from ambiguous angle-bracket
 * expressions in minified expression code. The filter has two pieces:
 * {@link isJsxBearingFile} rejects files whose extension cannot legally
 * embed JSX, and {@link extractComponentIdentifier} normalizes tag-name
 * text to a plausible React component identifier (or `null` for noise).
 */

import { describe, expect, it } from "bun:test";
import {
  extractComponentIdentifier,
  filterEmittedComponentNames,
  isJsxBearingFile,
} from "../../../src/mcp/opaque-tag-filter.ts";

describe("isJsxBearingFile", () => {
  // Positive cases: extensions whose syntax can legally carry JSX.
  it.each([
    ["Button.tsx"],
    ["Button.jsx"],
    ["article.mdx"],
    ["Header.astro"],
    ["/abs/path/to/Foo.tsx"],
    ["nested/Dir/Foo.JSX"], // extension normalized to lowercase
  ])("admits %s", (filePath) => {
    expect(isJsxBearingFile(filePath)).toBe(true);
  });

  // Negative cases: extensions that cannot legally embed JSX. Plain
  // `.ts` / `.js` are the two the Q6 field report specifically hit.
  it.each([
    ["utils.ts"],
    ["bundle.min.js"],
    ["config.ts"],
    ["vendor/jquery.js"],
    ["README.md"],
    ["styles.css"],
    ["no-extension-file"],
  ])("rejects %s", (filePath) => {
    expect(isJsxBearingFile(filePath)).toBe(false);
  });
});

describe("extractComponentIdentifier", () => {
  describe("accepts plausible React component identifiers", () => {
    it("returns bare PascalCase names verbatim", () => {
      expect(extractComponentIdentifier("Button")).toBe("Button");
      expect(extractComponentIdentifier("HeaderNav")).toBe("HeaderNav");
      expect(extractComponentIdentifier("MDXRenderer")).toBe("MDXRenderer");
    });

    it("extracts the root identifier for dotted member-access tags", () => {
      // React's namespaced-component pattern: `<Motion.div>` imports
      // `Motion` from a package and uses `.div` as a member-access
      // component accessor. `nativeWrappers` config lists the root —
      // so the extractor returns the root too.
      expect(extractComponentIdentifier("Motion.div")).toBe("Motion");
      expect(extractComponentIdentifier("Form.Item")).toBe("Form");
      expect(extractComponentIdentifier("Radix.Root")).toBe("Radix");
    });

    it("admits identifiers with digits and underscores after the first letter", () => {
      // Rare but legal React component identifiers. First char must
      // still be uppercase A-Z; subsequent chars can be alphanumeric
      // or underscore. `Comp1`, `Panel_2` surface on real codebases.
      expect(extractComponentIdentifier("Comp1")).toBe("Comp1");
      expect(extractComponentIdentifier("Panel_2")).toBe("Panel_2");
    });
  });

  describe("rejects tag-name noise", () => {
    it("rejects lowercase-first tags — those are intrinsic HTML elements", () => {
      expect(extractComponentIdentifier("div")).toBe(null);
      expect(extractComponentIdentifier("span")).toBe(null);
      expect(extractComponentIdentifier("custom-element")).toBe(null);
    });

    it("rejects single-character identifiers — minified-code noise", () => {
      // `<J>`, `<B>`, `<X>` are overwhelmingly minified-bundle
      // artefacts rather than real React components. The single-char
      // filter is a deterministic exclusion (not a threshold or
      // filename heuristic) trading a rare false negative on
      // obscurely-named components for a large noise reduction.
      expect(extractComponentIdentifier("J")).toBe(null);
      expect(extractComponentIdentifier("B")).toBe(null);
      expect(extractComponentIdentifier("X")).toBe(null);
    });

    it("rejects empty input", () => {
      expect(extractComponentIdentifier("")).toBe(null);
    });

    it("rejects dotted tags whose root is a single character", () => {
      // `J.length`, `B.x` are the canonical minified-JS phantoms the
      // Q6 field report surfaced. The root identifier `J` / `B` is
      // single-char, so the whole tag drops out.
      expect(extractComponentIdentifier("J.length")).toBe(null);
      expect(extractComponentIdentifier("B.x")).toBe(null);
      expect(extractComponentIdentifier("H.length")).toBe(null);
    });

    it("rejects dotted tags whose root is lowercase", () => {
      // Minified bundles also produce `<foo.bar>`-style phantoms;
      // the lowercase-root rejection subsumes them.
      expect(extractComponentIdentifier("foo.bar")).toBe(null);
      expect(extractComponentIdentifier("this.that")).toBe(null);
    });
  });

  describe("honest-contract boundary", () => {
    it("returns null, never an empty string, for rejections — the shape is `string | null`", () => {
      // `docs/kb/architecture/ai-first-consumer.md` calls out
      // empty-string sentinel fields as dishonest; the helper must
      // always return either a meaningful identifier or `null`.
      const rejected = ["", "div", "J", "J.length", "1Start", "foo.bar"];
      for (const input of rejected) {
        const out = extractComponentIdentifier(input);
        // Either null or a non-empty string. Never empty string.
        expect(out === null || (typeof out === "string" && out.length > 0)).toBe(true);
        expect(out).not.toBe("");
      }
    });
  });

  // V1-OPAQUE-COMPONENT-NAMES-MINIFIED-TOKEN-LEAK: minified-bundle
  // tokens like `Math.abs`, `JSON.parse`, `Object.keys` were leaking
  // into `opaqueCustomComponentNames` and reading as React components.
  // The dotted form's root is a JS global / built-in, not a wrapper —
  // surfacing it in the inventory misled agents into adding `Math.abs`
  // (or `Math`) to their `nativeWrappers` config.
  describe("rejects JS global / built-in roots (V1-OPAQUE-COMPONENT-NAMES-MINIFIED-TOKEN-LEAK)", () => {
    it("rejects member-access into a JS global (Math.abs → null)", () => {
      // The historical extractor returned `Math` for `Math.abs`. Now
      // the global-prototype filter rejects it outright so neither
      // the dotted form nor the bare `Math` can pollute the inventory.
      expect(extractComponentIdentifier("Math.abs")).toBe(null);
      expect(extractComponentIdentifier("JSON.parse")).toBe(null);
      expect(extractComponentIdentifier("Object.keys")).toBe(null);
      expect(extractComponentIdentifier("Array.from")).toBe(null);
      expect(extractComponentIdentifier("Reflect.has")).toBe(null);
      expect(extractComponentIdentifier("Symbol.for")).toBe(null);
      expect(extractComponentIdentifier("Promise.all")).toBe(null);
      expect(extractComponentIdentifier("Date.now")).toBe(null);
    });

    it("rejects bare JS global names (Math → null)", () => {
      // Both the dotted and bare forms are rejected — minified
      // bundles produce both shapes and neither is a React component.
      expect(extractComponentIdentifier("Math")).toBe(null);
      expect(extractComponentIdentifier("Object")).toBe(null);
      expect(extractComponentIdentifier("Array")).toBe(null);
      expect(extractComponentIdentifier("JSON")).toBe(null);
      expect(extractComponentIdentifier("Promise")).toBe(null);
      expect(extractComponentIdentifier("Map")).toBe(null);
      expect(extractComponentIdentifier("Set")).toBe(null);
    });

    it("rejects single uppercase letter optionally followed by digits (A1 → null)", () => {
      // The bare single-char form (`A`, `B`) is already caught by the
      // `root.length < 2` branch; this filter extends coverage to
      // identifiers that pass length/shape (`A1`, `B2`, `J7`) but are
      // overwhelmingly minified-bundle variable names.
      expect(extractComponentIdentifier("A1")).toBe(null);
      expect(extractComponentIdentifier("B2")).toBe(null);
      expect(extractComponentIdentifier("J7")).toBe(null);
      expect(extractComponentIdentifier("Z99")).toBe(null);
    });

    it("does not regress valid PascalCase that happens to contain digits beyond the first char", () => {
      // The single-letter+digits filter is anchored — a multi-letter
      // root with digits (`Comp1`, `Panel2`, `MD3Card`) is unchanged.
      expect(extractComponentIdentifier("Comp1")).toBe("Comp1");
      expect(extractComponentIdentifier("Panel2")).toBe("Panel2");
      expect(extractComponentIdentifier("MD3Card")).toBe("MD3Card");
    });
  });
});

describe("filterEmittedComponentNames (V1-OPAQUE-COMPONENT-NAMES-MINIFIED-TOKEN-LEAK)", () => {
  it("matches the field-report acceptance: drops dotted, global, single-letter+digit; keeps PascalCase words", () => {
    // Exact input/output pair from the V1-OPAQUE-COMPONENT-NAMES-
    // MINIFIED-TOKEN-LEAK backlog item. The mixed list represents a
    // candidate array a minified-bundle scan could populate if the
    // upstream extractor regressed; the filter is the emission-time
    // safety net that prevents `Math.abs` / `H.length` / `AG.y` from
    // misleading an agent into wrapper-config noise.
    const input = [
      "MyComponent",
      "AG.y",
      "B",
      "H.length",
      "J",
      "J.length",
      "Math.abs",
      "Box",
      "ButtonGroup",
    ];
    const output = filterEmittedComponentNames(input);
    expect([...output]).toEqual(["MyComponent", "Box", "ButtonGroup"]);
  });

  it("preserves input order (no implicit sort) so callers control ordering", () => {
    // Filter is composable with subsequent `.sort()` — ordering
    // discipline lives at the caller. Two valid names in
    // descending-call-site order should remain in input order.
    const output = filterEmittedComponentNames(["ZComponent", "AComponent"]);
    expect([...output]).toEqual(["ZComponent", "AComponent"]);
  });

  it("returns an empty list when every input is filtered", () => {
    // The all-noise case ships nothing rather than a partial / empty
    // sentinel — callers above should omit the field entirely when
    // the filter empties the list (CLAUDE.md §1 ambiguous-shape rule).
    const output = filterEmittedComponentNames(["Math.abs", "B", "H.length", "A1"]);
    expect([...output]).toEqual([]);
  });

  it("returns the input unchanged when nothing is filtered", () => {
    // No-op path: the common case where the upstream extractor has
    // already done its job — the emission filter sees a clean list
    // and passes it through.
    const input = ["HeaderNav", "Sidebar", "Button"];
    const output = filterEmittedComponentNames(input);
    expect([...output]).toEqual(input);
  });
});
