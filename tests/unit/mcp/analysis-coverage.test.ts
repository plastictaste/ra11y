/**
 * Unit tests for buildAnalysisCoverage — the MCP-surface telemetry
 * that tells agents what static analysis couldn't reach. The hints
 * block is load-bearing: it's the single actionable "what to do next"
 * an agent uses to unblock a thin scan without reading docs.
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import { parseHtml } from "../../../src/input/parsers/html.ts";
import { buildAnalysisCoverage } from "../../../src/mcp/analysis-coverage.ts";
import type { Rule } from "../../../src/types/rule.ts";

function tsxFile(
  path: string,
  tagNames: readonly string[],
  options: { readonly interactive?: boolean } = {},
): ParsedFile {
  const source = tagNames.map((t) => `<${t} />`).join("\n");
  const interactive = options.interactive === true;
  // An `onClick` attribute makes the scanner treat the component as a
  // wrapper candidate (used in an interactive context). Tests that
  // exercise the top-N ranking set interactive: true; tests that
  // exercise the total opaque count or the "never interactive"
  // structural filter leave it off.
  const interactiveAttr = interactive
    ? [
        {
          kind: "JsxAttribute" as const,
          range: { start: 0, end: 0 },
          loc: {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 1, column: 1, offset: 0 },
          },
          name: "onClick",
          value: { kind: "Expression" as const, raw: "{() => {}}" },
        },
      ]
    : [];
  const jsxElements = tagNames.map((tagName) => ({
    kind: "JsxElement" as const,
    range: { start: 0, end: 0 },
    loc: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
    },
    tagName,
    attributes: interactiveAttr,
    children: [],
    selfClosing: true,
    hasSpreadProps: false,
  }));
  return {
    filePath: path,
    source,
    ast: {
      language: "tsx",
      root: {
        kind: "TsxModule",
        range: { start: 0, end: source.length },
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: source.length },
        },
        jsxElements,
      },
      errors: [],
    },
  };
}

function tsxFileWithClassName(path: string, className: string): ParsedFile {
  const source = `<div className="${className}" />`;
  return {
    filePath: path,
    source,
    ast: {
      language: "tsx",
      root: {
        kind: "TsxModule",
        range: { start: 0, end: source.length },
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: source.length },
        },
        jsxElements: [
          {
            kind: "JsxElement",
            range: { start: 0, end: source.length },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: source.length },
            },
            tagName: "div",
            attributes: [
              {
                kind: "JsxAttribute",
                range: { start: 0, end: 0 },
                loc: {
                  start: { line: 1, column: 1, offset: 0 },
                  end: { line: 1, column: 1, offset: 0 },
                },
                name: "className",
                value: { kind: "StringLiteral", value: className },
              },
            ],
            children: [],
            selfClosing: true,
            hasSpreadProps: false,
          },
        ],
      },
      errors: [],
    },
  };
}

function cssFile(path: string): ParsedFile {
  return {
    filePath: path,
    source: ".foo { color: red; }",
    ast: {
      language: "css",
      root: {
        kind: "CssStylesheet",
        range: { start: 0, end: 0 },
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
        rules: [],
      },
      errors: [],
    },
  };
}

function htmlFile(path: string, source: string): ParsedFile {
  return {
    filePath: path,
    source,
    ast: {
      language: "html",
      root: {
        kind: "HtmlDocument",
        range: { start: 0, end: 0 },
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
        children: [],
      },
      errors: [],
    },
  };
}

const NO_RULES: readonly Rule[] = [];

describe("buildAnalysisCoverage — hints", () => {
  describe("opaque custom components", () => {
    it("does not hint when the count is below threshold", () => {
      const files = [tsxFile("a.tsx", ["Foo", "Bar", "Baz"])];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(3);
      expect(analysisCoverage?.["hints"]).toBeUndefined();
    });

    it("hints with example names when opaque components are plentiful", () => {
      const tags = Array.from({ length: 10 }, (_, i) => `Comp${i}`);
      const files = [tsxFile("a.tsx", tags, { interactive: true })];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const hints = analysisCoverage?.["hints"] as
        | readonly { code: string; text: string; detail?: Record<string, unknown> }[]
        | undefined;
      expect(hints).toBeDefined();
      expect(hints?.[0]?.code).toBe("opaque_components_present");
      expect(hints?.[0]?.text).toContain("nativeWrappers");
      expect(hints?.[0]?.text).toContain("detect_native_wrappers");
      expect(hints?.[0]?.text).toContain("Comp0");
      expect(hints?.[0]?.detail?.["opaqueCount"]).toBe(10);
    });

    it("excludes wrappers already registered from the opaque set", () => {
      const tags = Array.from({ length: 10 }, (_, i) => `Comp${i}`);
      const wrappers = tags.slice(0, 4); // register 4 — remaining 6 under threshold
      const files = [tsxFile("a.tsx", tags)];
      const { analysisCoverage } = buildAnalysisCoverage(files, wrappers, NO_RULES, false);
      expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(6);
      expect(analysisCoverage?.["hints"]).toBeUndefined();
    });

    it("always surfaces the top-by-call-site list inline (no verboseMeta needed)", () => {
      // 3 call sites of Button, 2 of Card, 1 of Widget. All used with
      // onClick so the structural "wrapper candidate" filter keeps them
      // in the ranking.
      const files = [
        tsxFile("a.tsx", ["Button", "Button", "Button", "Card", "Card", "Widget"], {
          interactive: true,
        }),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const top = analysisCoverage?.["opaqueCustomComponentsTop"] as
        | { name: string; callSites: number }[]
        | undefined;
      expect(top).toEqual([
        { name: "Button", callSites: 3 },
        { name: "Card", callSites: 2 },
        { name: "Widget", callSites: 1 },
      ]);
    });

    it("caps the top list at 5 entries so the response stays compact", () => {
      // 10 unique components, one call site each, all interactive.
      const tags = Array.from({ length: 10 }, (_, i) => `Comp${i}`);
      const files = [tsxFile("a.tsx", tags, { interactive: true })];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const top = analysisCoverage?.["opaqueCustomComponentsTop"] as { name: string }[] | undefined;
      expect(top?.length).toBe(5);
    });

    it("returns the full ranked list (not just top 5) when verbose is true", () => {
      // Agent triaging wrapper coverage needs every candidate, not
      // just the head — the top-5 truncation is a human-attention
      // optimization that hurts agent triage. verbose removes the cap.
      const tags = Array.from({ length: 12 }, (_, i) => `Comp${i}`);
      const files = [tsxFile("a.tsx", tags, { interactive: true })];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, true);
      const top = analysisCoverage?.["opaqueCustomComponentsTop"] as { name: string }[] | undefined;
      expect(top?.length).toBe(12);
    });

    it("breaks ties alphabetically so output is deterministic across runs", () => {
      const files = [tsxFile("a.tsx", ["Zeta", "Alpha", "Mike"], { interactive: true })];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const top = analysisCoverage?.["opaqueCustomComponentsTop"] as { name: string }[] | undefined;
      expect(top?.map((e) => e.name)).toEqual(["Alpha", "Mike", "Zeta"]);
    });

    it("excludes components never used with an interactive attribute from the top-N", () => {
      // Route-style non-DOM components: appear plenty but never get
      // onClick/role/tabIndex/href. Previously dominated the top-5;
      // now the structural usage filter drops them. Genuine wrapper
      // candidates (Button with onClick) stay ranked.
      const nonInteractive = Array.from({ length: 20 }, () => "Route");
      const interactive = ["Button", "Button", "Button"];
      const files = [
        tsxFile("a.tsx", nonInteractive, { interactive: false }),
        tsxFile("b.tsx", interactive, { interactive: true }),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const top = analysisCoverage?.["opaqueCustomComponentsTop"] as
        | { name: string; callSites: number }[]
        | undefined;
      expect(top?.map((e) => e.name)).toEqual(["Button"]);
      // Total count still reports both — Route remains "opaque", it's
      // just not a wrapper candidate. Don't hide the inventory signal.
      expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(2);
    });

    it("keeps a component in the ranking when ANY call site is interactive", () => {
      // Mixed usage: <MyBtn /> bare in file A, <MyBtn onClick=...> in
      // file B. Still a wrapper candidate on the strength of file B.
      const files = [
        tsxFile("a.tsx", ["MyBtn", "MyBtn"], { interactive: false }),
        tsxFile("b.tsx", ["MyBtn"], { interactive: true }),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const top = analysisCoverage?.["opaqueCustomComponentsTop"] as
        | { name: string; callSites: number }[]
        | undefined;
      expect(top).toEqual([{ name: "MyBtn", callSites: 3 }]);
    });

    it("treats {...spread} props as possibly interactive (conservative)", () => {
      // Static analysis can't see inside spread, so the component
      // stays ranked rather than silently dropping a design-system
      // wrapper that forwards interactivity via spread.
      const files: ParsedFile[] = [
        {
          filePath: "a.tsx",
          source: "<Wrapper {...props} />",
          ast: {
            language: "tsx",
            root: {
              kind: "TsxModule",
              range: { start: 0, end: 22 },
              loc: {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 22 },
              },
              jsxElements: [
                {
                  kind: "JsxElement",
                  range: { start: 0, end: 22 },
                  loc: {
                    start: { line: 1, column: 1, offset: 0 },
                    end: { line: 1, column: 1, offset: 22 },
                  },
                  tagName: "Wrapper",
                  attributes: [],
                  children: [],
                  selfClosing: true,
                  hasSpreadProps: true,
                },
              ],
            },
            errors: [],
          },
        },
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const top = analysisCoverage?.["opaqueCustomComponentsTop"] as
        | { name: string; callSites: number }[]
        | undefined;
      expect(top).toEqual([{ name: "Wrapper", callSites: 1 }]);
    });

    it("omits the top list when no opaque components were seen", () => {
      const files = [tsxFile("a.tsx", [])];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      expect(analysisCoverage?.["opaqueCustomComponentsTop"]).toBeUndefined();
    });

    it("omits the top list when opaque components exist but none are interactive — prevents the `[]`-while-names-is-15 dishonest shape", () => {
      // 20 route-like components, all non-interactive. Inventory size is
      // non-zero AND large enough to trigger the hint, but the ranked
      // list after the interactive filter is empty. Historical bug:
      // shipped `opaqueCustomComponentsTop: []` alongside a 15-entry
      // `opaqueCustomComponentNames`, which read as dishonest (an empty
      // list on a response that also claimed 15 components).
      const nonInteractive = Array.from({ length: 20 }, (_, i) => `Route${i}`);
      const files = [tsxFile("a.tsx", nonInteractive, { interactive: false })];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      expect(analysisCoverage?.["opaqueCustomComponentsTop"]).toBeUndefined();
      // Inventory count still reports the truth — omission is
      // about the ranked sub-list, not suppression of the signal.
      expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(20);
    });

    it("renders the opaque-components hint without the `(top: )` parenthetical when no component is interactive", () => {
      // Hint fires on `opaqueCount >= OPAQUE_COMPONENT_HINT_MIN` (total
      // inventory), but the examples list is gated on interactivity.
      // Previously: empty examples string produced literal "(top: )"
      // prose with nothing after the colon. Now the parenthetical is
      // omitted entirely rather than shipped as broken English.
      const nonInteractive = Array.from({ length: 20 }, (_, i) => `Route${i}`);
      const files = [tsxFile("a.tsx", nonInteractive, { interactive: false })];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const hints = analysisCoverage?.["hints"] as
        | readonly { code: string; text: string; detail?: Record<string, unknown> }[]
        | undefined;
      const opaqueHint = hints?.find((h) => h.code === "opaque_components_present");
      expect(opaqueHint).toBeDefined();
      expect(opaqueHint?.text).not.toContain("(top: )");
      expect(opaqueHint?.text).not.toContain("(top:");
      // When no component is interactive the topInteractive detail is
      // omitted per conditional-spread — the empty array would be a
      // dishonest sentinel.
      expect(opaqueHint?.detail?.["topInteractive"]).toBeUndefined();
      expect(opaqueHint?.detail?.["opaqueCount"]).toBe(20);
    });

    // when the opaque inventory is small enough to inline (≤50
    // names), the full names list ships on every response — no
    // verboseMeta round-trip. Above the threshold, names stay behind
    // verboseMeta so the default response stays bounded for monorepos.
    describe("inline names", () => {
      it("inlines the full names list when count ≤ 50 and verbose is false", () => {
        const tags = Array.from({ length: 12 }, (_, i) => `Comp${String(i).padStart(2, "0")}`);
        const files = [tsxFile("a.tsx", tags, { interactive: true })];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        const names = analysisCoverage?.["opaqueCustomComponentNames"] as string[] | undefined;
        expect(names).toBeDefined();
        expect(names?.length).toBe(12);
        expect(names).toEqual([...tags].sort());
      });

      it("omits the names list when count > 50 and verbose is false", () => {
        // 51 unique PascalCase components — one past the inline cap.
        const tags = Array.from({ length: 51 }, (_, i) => `Comp${String(i).padStart(3, "0")}`);
        const files = [tsxFile("a.tsx", tags, { interactive: true })];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(51);
        expect(analysisCoverage?.["opaqueCustomComponentNames"]).toBeUndefined();
      });

      it("inlines the names list at the threshold (count = 50, verbose false)", () => {
        const tags = Array.from({ length: 50 }, (_, i) => `Comp${String(i).padStart(3, "0")}`);
        const files = [tsxFile("a.tsx", tags, { interactive: true })];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        const names = analysisCoverage?.["opaqueCustomComponentNames"] as string[] | undefined;
        expect(names?.length).toBe(50);
      });

      it("omits the names list one past the threshold (count = 51, verbose false)", () => {
        const tags = Array.from({ length: 51 }, (_, i) => `Comp${String(i).padStart(3, "0")}`);
        const files = [tsxFile("a.tsx", tags, { interactive: true })];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponentNames"]).toBeUndefined();
      });

      it("still exposes the full names list under verbose when count > 50", () => {
        // verboseMeta preserves prior behavior — the full names list
        // is always returned, independent of the inline-threshold gate.
        const tags = Array.from({ length: 120 }, (_, i) => `Comp${String(i).padStart(3, "0")}`);
        const files = [tsxFile("a.tsx", tags, { interactive: true })];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, true);
        const names = analysisCoverage?.["opaqueCustomComponentNames"] as string[] | undefined;
        expect(names?.length).toBe(120);
      });
    });

    // Q6 extraction-noise filter: the in-house TSX parser accepts plain
    // `.ts` / `.js` files (one parser for the whole JS/TS family) and
    // sometimes materializes phantom JSX elements when ambiguous
    // angle-bracket expressions in minified bundles defeat the
    // generic-vs-JSX classifier. On a real-world scan the phantoms
    // leaked into `opaqueCustomComponentNames` as entries like
    // `Math.abs`, `J.length`, `B`, `H.length`, `J`, `AG.y`. These tests
    // lock down the three filters that keep the inventory honest:
    // (a) skip non-JSX-bearing extensions; (b) extract the root
    // identifier for a dotted member-access tag; (c) exclude
    // single-character identifiers.
    describe("phantom-tag extraction filter", () => {
      it("excludes JSX elements from plain .js files — .js has no JSX syntax", () => {
        // Simulate what the TSX parser emits on minified `.js` when the
        // generic-vs-JSX classifier trips over `a<B.length` or
        // `Math.abs(x)<y`. A real scanner would materialize phantom
        // tags like `Math.abs`, `J.length`, `B`. None of them are real
        // components — they must not pollute the opaque inventory.
        const files = [tsxFile("bundle.min.js", ["Math.abs", "J.length", "B", "AG.y"])];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBeUndefined();
        expect(analysisCoverage?.["opaqueCustomComponentNames"]).toBeUndefined();
      });

      it("excludes JSX elements from plain .ts files — .ts has no JSX syntax", () => {
        // `.ts` files are accepted by the TSX parser for typechecking
        // utility modules but cannot embed JSX; any tag the parser
        // emits from them is noise, same failure class as `.js`.
        const files = [tsxFile("utils.ts", ["Math.abs", "J", "HeaderNav"])];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBeUndefined();
      });

      it("keeps JSX elements from .tsx and .jsx files — those extensions legally carry JSX", () => {
        // Positive control: the extension filter must not regress
        // coverage on the extensions that DO carry JSX syntax. A
        // single `HeaderNav` in a .tsx file still counts.
        const files = [tsxFile("Header.tsx", ["HeaderNav"]), tsxFile("Sidebar.jsx", ["Sidebar"])];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(2);
      });

      it("extracts the root identifier for dotted member-access tags (Motion.div → Motion)", () => {
        // Legitimate React namespaced components render as a single
        // JSX tag whose `tagName` contains a dot. The `nativeWrappers`
        // config lists the importable root, not the dotted leaf — so
        // the extractor groups by the root. Three sightings of
        // `Motion.div`, `Motion.span`, `Motion.section` collapse to
        // one `Motion` entry with 3 call sites.
        const files = [
          tsxFile("a.tsx", ["Motion.div", "Motion.span", "Motion.section"], {
            interactive: true,
          }),
        ];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(1);
        const top = analysisCoverage?.["opaqueCustomComponentsTop"] as
          | { name: string; callSites: number }[]
          | undefined;
        expect(top).toEqual([{ name: "Motion", callSites: 3 }]);
      });

      it("excludes single-character identifiers — minified-code noise", () => {
        // Real React component names are meaningful words; a single
        // uppercase letter is overwhelmingly minified-bundle noise
        // (`<J>`, `<B>`). Accept a rare false negative on obscure
        // single-char components to eliminate the large noise source.
        // Alongside the single-char junk, a valid `Button` tag stays
        // counted as the positive control.
        const files = [tsxFile("a.tsx", ["J", "B", "X", "Button"])];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(1);
        const names = analysisCoverage?.["opaqueCustomComponentNames"] as string[] | undefined;
        expect(names).toEqual(["Button"]);
      });

      it("locks down the full real-world leak: .js with mixed noise does not pollute the inventory", () => {
        // End-to-end repro of the Q6 field report: a .js bundle's
        // phantom tag list was leaking into `opaqueCustomComponentNames`.
        // Mixing the exact noise classes observed (`AG.y`, `B`,
        // `H.length`, `J`, `J.length`, `Math.abs`) in a .js file
        // alongside a legitimate .tsx component confirms the inventory
        // holds only the real one.
        const files = [
          tsxFile("bundle.min.js", ["AG.y", "B", "H.length", "J", "J.length", "Math.abs"]),
          tsxFile("HeaderNav.tsx", ["HeaderNav"], { interactive: true }),
        ];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(1);
        const names = analysisCoverage?.["opaqueCustomComponentNames"] as string[] | undefined;
        expect(names).toEqual(["HeaderNav"]);
      });

      // through the
      // full pipeline, mixing minified-noise tag text with real
      // PascalCase components in a .tsx source confirms the layered
      // filters cooperate. The upstream `extractComponentIdentifier`
      // strips dots, rejects single chars, and now also rejects JS
      // globals (`Math.abs`) and single-letter+digit tokens. The
      // emission-time `filterEmittedComponentNames` is belt-and-
      // braces — it catches anything that bypasses the extractor.
      // `Math.abs` is rejected because `Math` is a global; `B` /
      // `J` reject as single-char; `H.length` / `J.length` reject
      // because root `H` / `J` is single-char; `Math.abs` rejects
      // for the global-root reason. `AG.y` extracts to root `AG`,
      // which is a two-char PascalCase identifier — neither the
      // single-letter-digit nor the global-prototype filter
      // matches, so `AG` is treated as a (plausibly short) real
      // component name and survives. That preserves the existing
      // namespaced-component behavior (`Motion.div` → `Motion`).
      it("filters minified-noise tag text from a .tsx source through the full pipeline", () => {
        const files = [
          tsxFile(
            "Mixed.tsx",
            [
              "MyComponent",
              "AG.y",
              "B",
              "H.length",
              "J",
              "J.length",
              "Math.abs",
              "Box",
              "ButtonGroup",
            ],
            { interactive: true },
          ),
        ];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        const names = analysisCoverage?.["opaqueCustomComponentNames"] as string[] | undefined;
        // Three genuinely-PascalCase multi-letter names plus `AG`
        // (the dotted-stripped root of `AG.y` — extractor preserves
        // the namespaced-root pattern for legitimate uses like
        // `Motion.div`). The four leak-class names (`B`, `H.length`,
        // `J`, `J.length`, `Math.abs`) are all dropped.
        expect(names).toEqual(["AG", "Box", "ButtonGroup", "MyComponent"]);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(4);
      });

      // The acceptance criterion in the backlog item — the exact
      // input/output pair from the field report — is exercised at
      // the unit level on `filterEmittedComponentNames`
      // (tests/unit/mcp/opaque-tag-filter.test.ts) because the full
      // pipeline's upstream root-extraction transforms the input
      // (e.g. `Math.abs` → `Math` → reject). The unit test runs
      // against the raw candidate list a regression-prone code path
      // could theoretically populate; this test covers the realistic
      // scan path where extraction has already normalized.
    });

    // belt-and-braces:
    // regardless of how fake JSX tag positions originate (upstream
    // TSX-parser error-parse leakage on `.js`, parser recovery on
    // syntactically-broken `.tsx`, vendored compiled bundles that
    // happen to land at a JSX-bearing extension), the wrapper
    // extraction must skip files whose parser emitted errors AND files
    // classified as build artifacts. The invariant: every name in
    // `opaqueCustomComponentNames` must trace back to a cleanly-parsed,
    // non-artifact source file.
    describe("parseErrorFiles + scannedBuildArtifacts invariant", () => {
      function tsxFileWithErrors(path: string, tagNames: readonly string[]): ParsedFile {
        const base = tsxFile(path, tagNames, { interactive: true });
        return {
          ...base,
          ast: {
            ...base.ast,
            errors: [
              {
                message: "Unexpected token `<` at position 42",
                position: { line: 1, column: 1, offset: 0 },
                recoverable: true,
              },
            ],
          },
        };
      }

      it("skips wrapper extraction on .tsx files whose parser emitted errors", () => {
        // A broken-parse `.tsx` file recovers a partial AST and can emit
        // fake tag positions off the recovered slice — the `isJsxBearingFile`
        // extension filter admits `.tsx`, so the parse-error filter has
        // to kick in independently. A clean `.tsx` peer ships a real
        // component so the positive control stays visible.
        const files = [
          tsxFileWithErrors("Broken.tsx", ["Phantom", "FakeTag"]),
          tsxFile("Real.tsx", ["HeaderNav"], { interactive: true }),
        ];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(1);
        const names = analysisCoverage?.["opaqueCustomComponentNames"] as string[] | undefined;
        expect(names).toEqual(["HeaderNav"]);
      });

      it("skips wrapper extraction on files classified as build artifacts", () => {
        // A shipped bundle at a `.jsx` extension (canonical `.min.`
        // infix marker) must not contribute names to the inventory —
        // `scannedBuildArtifacts` classification is deterministic from
        // file shape (not a heuristic on tag contents) and an authored
        // wrapper sighting in a compiled artifact is definitionally
        // upstream of scope.
        const files = [
          tsxFile("vendor/lib.min.jsx", ["Phantom", "FakeTag"], { interactive: true }),
          tsxFile("Real.tsx", ["HeaderNav"], { interactive: true }),
        ];
        const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
        expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(1);
        const names = analysisCoverage?.["opaqueCustomComponentNames"] as string[] | undefined;
        expect(names).toEqual(["HeaderNav"]);
      });

      it("invariant: every name in opaqueCustomComponentNames traces to a file not in parseErrorFiles", () => {
        // The load-bearing cross-field invariant — the opaque inventory
        // and the parse-error file list are disjoint. Exercised with
        // a scan that produces both a non-empty opaque inventory AND
        // a non-empty `parseErrorFiles` bucket, so the assertion tests
        // the actual filter rather than a vacuous empty-vs-empty case.
        // Passing an empty `findingFilePaths` set routes every errored
        // file into `parseErrorFiles` (invisible bucket) — that's the
        // classification the invariant is named against.
        const files = [
          tsxFileWithErrors("BadA.tsx", ["PhantomA"]),
          tsxFileWithErrors("BadB.tsx", ["PhantomB"]),
          tsxFile("GoodA.tsx", ["HeaderNav", "Footer"], { interactive: true }),
          tsxFile("GoodB.tsx", ["Sidebar"], { interactive: true }),
        ];
        const { analysisCoverage } = buildAnalysisCoverage(
          files,
          [],
          NO_RULES,
          false,
          0,
          undefined,
          undefined,
          new Set<string>(),
        );
        const names =
          (analysisCoverage?.["opaqueCustomComponentNames"] as string[] | undefined) ?? [];
        const parseErrorEntries =
          (analysisCoverage?.["parseErrorFiles"] as readonly { path: string }[] | undefined) ?? [];
        const parseErrorPaths = new Set(parseErrorEntries.map((e) => e.path));
        // Sanity: both sides populated so the disjointness check isn't vacuous.
        expect(names.length).toBeGreaterThan(0);
        expect(parseErrorPaths.size).toBeGreaterThan(0);
        // Invariant: no name originated from a parseErrorFiles path.
        // Since `opaqueCustomComponentNames` is a deduped set of names
        // (not tagged with source paths), the assertion is that none of
        // the phantom tag names that appear ONLY in parse-error files
        // leak into the inventory.
        for (const phantom of ["PhantomA", "PhantomB"]) {
          expect(names).not.toContain(phantom);
        }
        // Positive control: the names that ONLY appear in clean files
        // are present.
        expect(names).toContain("HeaderNav");
        expect(names).toContain("Footer");
        expect(names).toContain("Sidebar");
      });
    });
  });

  describe("thin CSS coverage", () => {
    it("does not hint when the project is small", () => {
      const files = [tsxFile("a.tsx", []), cssFile("a.css")];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      // `parseModeByExtension` still surfaces on small scans (it's
      // scan-confidence telemetry that reconciles `filesByExtension`
      // against per-rule `filesEvaluated` regardless of project size);
      // the CSS-coverage hint stays absent, which is what this test
      // pins.
      expect(analysisCoverage?.["hints"]).toBeUndefined();
    });

    it("hints when CSS is absent from a React-sized codebase", () => {
      const files = Array.from({ length: 60 }, (_, i) => tsxFile(`c${i}.tsx`, []));
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const hints =
        (analysisCoverage?.["hints"] as
          | readonly { code: string; text: string; detail?: Record<string, unknown> }[]
          | undefined) ?? [];
      const cssHint = hints.find((h) => h.code === "css_coverage_thin");
      expect(cssHint).toBeDefined();
      expect(cssHint?.text).toContain("CSS");
      expect(cssHint?.text.includes("Tailwind") || cssHint?.text.includes("post-compile")).toBe(
        true,
      );
    });

    it("does not hint when CSS coverage is proportionate", () => {
      const jsx = Array.from({ length: 40 }, (_, i) => tsxFile(`c${i}.tsx`, []));
      const css = Array.from({ length: 10 }, (_, i) => cssFile(`c${i}.css`));
      const files = [...jsx, ...css];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const hints =
        (analysisCoverage?.["hints"] as
          | readonly { code: string; text: string; detail?: Record<string, unknown> }[]
          | undefined) ?? [];
      expect(hints.some((h) => h.code === "css_coverage_thin")).toBe(false);
    });

    it("strengthens the hint with additionalPaths when Tailwind usage is detected", () => {
      // 60 Tailwind-looking JSX files + 0 CSS → thin-CSS hint fires
      // AND the Tailwind-specific strengthening kicks in.
      const files = Array.from({ length: 60 }, (_, i) =>
        tsxFileWithClassName(`c${i}.tsx`, "flex items-center bg-red-500 text-white"),
      );
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const hints =
        (analysisCoverage?.["hints"] as
          | readonly { code: string; text: string; detail?: Record<string, unknown> }[]
          | undefined) ?? [];
      const cssHint = hints.find((h) => h.code === "css_coverage_thin");
      expect(cssHint).toBeDefined();
      expect(cssHint?.text).toContain("Tailwind usage detected");
      expect(cssHint?.text).toContain('additionalPaths: ["dist/assets"]');
      // Structured detail drives downstream branching — warnings.ts
      // dispatches on `detail.tailwindDetected` rather than matching
      // `text`.
      expect(cssHint?.detail?.["tailwindDetected"]).toBe(true);
      expect(cssHint?.detail?.["cssFiles"]).toBe(0);
      expect(cssHint?.detail?.["markupFiles"]).toBe(60);
    });

    it("does not flip to the Tailwind variant when class names aren't utility-shaped", () => {
      const files = Array.from({ length: 60 }, (_, i) =>
        tsxFileWithClassName(`c${i}.tsx`, "site-header active"),
      );
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const hints =
        (analysisCoverage?.["hints"] as
          | readonly { code: string; text: string; detail?: Record<string, unknown> }[]
          | undefined) ?? [];
      const cssHint = hints.find((h) => h.code === "css_coverage_thin");
      expect(cssHint).toBeDefined();
      expect(cssHint?.text).not.toContain("Tailwind usage detected");
      expect(cssHint?.detail?.["tailwindDetected"]).toBe(false);
    });
  });

  // Doctrine ("Heuristic-mislabeled meta sub-fields are dishonest"):
  // dialect attribution is impossible from token shape alone — `{{ x }}`
  // is shared by Handlebars, Mustache, Liquid, Jinja, Vue, and Angular,
  // and the GitHub-Actions form `${{ x }}` reused the bare-double-brace
  // surface. Earlier passes shipped a deterministic-sounding family
  // token (`templateDirectivesFound: ["handlebars-or-mustache"]`,
  // `["jinja-or-liquid"]`) that fired wrong on every Vue/Angular/
  // workflow corpus that crossed the parser. The honest shape is the
  // raw evidence: surface the literal interpolation token + its
  // occurrence count, and let the agent disambiguate dialect from the
  // surrounding files.
  describe("template-interpolation token surfacing", () => {
    it("surfaces a plain-English handling note alongside the token list", () => {
      const liquid = htmlFile("t.html", "{% extends 'base.html' %}<p>{{ x }}</p>");
      const { analysisCoverage } = buildAnalysisCoverage([liquid], [], NO_RULES, false);
      const tokens = analysisCoverage?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      const tokenLiterals = (tokens ?? []).map((entry) => entry.token);
      expect(tokenLiterals).toContain("{%x%}");
      expect(tokenLiterals).toContain("{{x}}");
      const handling = analysisCoverage?.["templateDirectiveHandling"] as string | undefined;
      expect(handling).toBeDefined();
      expect(handling).toContain("parsed as literal");
      expect(handling).toContain("rendered output is not reconstructed");
    });

    it("omits the token list and handling note when no interpolation is detected", () => {
      const plain = htmlFile("p.html", "<p>hello</p>");
      const { analysisCoverage } = buildAnalysisCoverage([plain], [], NO_RULES, false);
      expect(analysisCoverage?.["templateInterpolationFound"]).toBeUndefined();
      expect(analysisCoverage?.["templateDirectiveHandling"]).toBeUndefined();
    });

    // Whitespace-control variants of `{%- ... -%}` count as the same
    // `{%x%}` token shape — the dash is a Liquid-specific signal the
    // agent reads from the source itself, not a separate scanner-
    // emitted token. This invariant prevents the field from re-
    // accreting a heuristic dialect axis under another name.
    it("counts `{%- ... -%}` whitespace-control as the same `{%x%}` token", () => {
      const partial = htmlFile(
        "header.html",
        "{%- include 'top.html' -%}\n<h1>{{ page.title }}</h1>",
      );
      const { analysisCoverage } = buildAnalysisCoverage([partial], [], NO_RULES, false);
      const tokens = analysisCoverage?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      const map = new Map((tokens ?? []).map((entry) => [entry.token, entry.count]));
      expect(map.get("{%x%}")).toBe(1);
      expect(map.get("{{x}}")).toBe(1);
    });

    it("counts every occurrence of each token across one file (densest token first)", () => {
      // Three control blocks, two interpolations — the response shape
      // sorts by descending count so an agent reading the first entry
      // sees the densest evidence on the corpus.
      const layout = htmlFile(
        "page.html",
        "{% if a %}{% include 'h.html' %}{% endif %}<p>{{ x }}{{ y }}</p>",
      );
      const { analysisCoverage } = buildAnalysisCoverage([layout], [], NO_RULES, false);
      const tokens = analysisCoverage?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      expect(tokens?.[0]?.token).toBe("{%x%}");
      expect(tokens?.[0]?.count).toBe(3);
      expect(tokens?.[1]?.token).toBe("{{x}}");
      expect(tokens?.[1]?.count).toBe(2);
    });

    it("aggregates token counts across all scanned files", () => {
      // scan_project should sum per-file tallies — an agent budgeting
      // against the densest token reads the cross-file total, not a
      // single file's count.
      const a = htmlFile("a.html", "<h1>{{ title }}</h1>");
      const b = htmlFile("b.html", "<h1>{{ x }}</h1><p>{{ y }}</p>");
      const { analysisCoverage } = buildAnalysisCoverage([a, b], [], NO_RULES, false);
      const tokens = analysisCoverage?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      const map = new Map((tokens ?? []).map((entry) => [entry.token, entry.count]));
      expect(map.get("{{x}}")).toBe(3);
    });

    it("breaks ties on token literal so output is deterministic across runs", () => {
      // Equal counts → token literal is the deterministic tiebreak
      // (via `localeCompare`). The exact ordering follows JS locale-
      // sort semantics; the invariant the test pins is "running the
      // same input twice yields the same order," which a comparator
      // built on `localeCompare` provides.
      const mixed = htmlFile("demo.html", "<pre><% scrap %>{{ value }}</pre>");
      const a = buildAnalysisCoverage([mixed], [], NO_RULES, false).analysisCoverage;
      const b = buildAnalysisCoverage([mixed], [], NO_RULES, false).analysisCoverage;
      const tokensA = a?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      const tokensB = b?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      expect(tokensA).toBeDefined();
      expect(tokensA).toEqual(tokensB);
      // Both shapes are present at count=1 — the corpus genuinely
      // contains one of each. Order is stable but locale-dependent.
      const literalsA = (tokensA ?? []).map((entry) => entry.token).sort();
      expect(literalsA).toEqual(["<%x%>", "{{x}}"]);
    });

    // The existing `={{ ... }}` JSX-attribute-spread filter survives:
    // an Astro / React expression-boundary `{` is not template
    // evidence. Without this filter, every Astro doc page mis-emitted
    // a token.
    it("excludes JSX/Astro attribute spread `={{ ... }}` from the bare-double-brace token", () => {
      const astroLike = htmlFile(
        "index.astro.html",
        "<Component overrides={{ body: bodyProps }} />",
      );
      const { analysisCoverage } = buildAnalysisCoverage([astroLike], [], NO_RULES, false);
      expect(analysisCoverage?.["templateInterpolationFound"]).toBeUndefined();
    });

    // The `${{ ... }}` GitHub-Actions / template-literal expression
    // shape gets its OWN token rather than being silently dropped or
    // mis-emitted as bare interpolation. An agent reading the literal
    // recognizes the workflow-expression form immediately.
    it("emits `${{x}}` as a distinct token for the dollar-double-brace shape", () => {
      // Build the literal at runtime so the source file doesn't carry
      // `${` adjacent to `{{` (Biome's noTemplateCurlyInString lints
      // the shape even in plain double-quoted strings).
      const dollar = "$";
      const workflowExpr = `${dollar}{{ github.event.pull_request.number }}`;
      const workflowEmbed = htmlFile("embed.html", `<pre>run: echo ${workflowExpr}</pre>`);
      const { analysisCoverage } = buildAnalysisCoverage([workflowEmbed], [], NO_RULES, false);
      const tokens = analysisCoverage?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      const literals = (tokens ?? []).map((entry) => entry.token);
      expect(literals).toContain("${{x}}");
      expect(literals).not.toContain("{{x}}");
    });

    // Mixed evidence: a JSX spread (filtered) AND a real `{{ x }}`
    // interpolation in the same file. The bare token survives; the
    // spread is excluded. Tightening the evidence corpus must not
    // drop real template evidence.
    it("counts a real `{{ x }}` even when a JSX spread coexists in the same file", () => {
      const mixed = htmlFile(
        "mixed.html",
        "<Component overrides={{ body: bodyProps }} />\n<h1>{{ title }}</h1>",
      );
      const { analysisCoverage } = buildAnalysisCoverage([mixed], [], NO_RULES, false);
      const tokens = analysisCoverage?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      const map = new Map((tokens ?? []).map((entry) => [entry.token, entry.count]));
      expect(map.get("{{x}}")).toBe(1);
    });

    // Cross-corpus invariants: Vue and Angular templates use the same
    // `{{ x }}` shape as Handlebars, and earlier passes mis-stamped
    // them as `handlebars-or-mustache`. The token-only shape now
    // surfaces the same evidence on every corpus and lets the agent
    // disambiguate dialect from the surrounding files.
    it("emits the bare `{{x}}` token on a Vue-shaped template (no dialect attribution)", () => {
      const vue = htmlFile(
        "App.vue.html",
        "<div class='greeting'>{{ user.name }} signed in at {{ formatTime(time) }}</div>",
      );
      const { analysisCoverage } = buildAnalysisCoverage([vue], [], NO_RULES, false);
      const tokens = analysisCoverage?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      const map = new Map((tokens ?? []).map((entry) => [entry.token, entry.count]));
      expect(map.get("{{x}}")).toBe(2);
      // No dialect string ever ships under this field — the literal
      // token is the only sub-shape allowed.
      const literals = (tokens ?? []).map((entry) => entry.token);
      for (const literal of literals) {
        expect(literal).toMatch(/^[<{$]/);
      }
    });
  });

  // the HTML parser sees
  // a top-of-file `---\n…\n---\n` YAML fence as literal text; this is
  // the substrate Jekyll / Hugo / Eleventy / Astro authors rely on and
  // the scanner must surface so the agent knows the document was
  // parsed with a stray horizontal-rule-looking header in scope.
  describe("frontmatter-fence detection", () => {
    it("flags hasFrontmatterFence when an HTML file opens with a `---\\n…\\n---\\n` fence", () => {
      const jekyllPage = htmlFile(
        "_posts/hello.html",
        "---\ntitle: Hello\nlayout: post\n---\n<p>body</p>",
      );
      const { analysisCoverage } = buildAnalysisCoverage([jekyllPage], [], NO_RULES, false);
      expect(analysisCoverage?.["hasFrontmatterFence"]).toBe(true);
    });

    it("flags hasFrontmatterFence with CRLF line endings (Windows-authored static sites)", () => {
      const crlfPage = htmlFile(
        "_posts/windows.html",
        "---\r\ntitle: Windows\r\n---\r\n<p>body</p>",
      );
      const { analysisCoverage } = buildAnalysisCoverage([crlfPage], [], NO_RULES, false);
      expect(analysisCoverage?.["hasFrontmatterFence"]).toBe(true);
    });

    it("flags hasFrontmatterFence on a 1-line-body post with no interpolation tokens — the V1 repro", () => {
      // Jekyll `test/source/properties.html`: frontmatter + single
      // body line, zero `{{ }}` / `{% %}` / `<% %>` tokens. Before the
      // fix, this scan returned `warnings: ["no_config_found"]` only
      // despite the HTML parser treating `---` as literal text.
      const v1Repro = htmlFile(
        "test/source/properties.html",
        "---\npermalink: /properties/\n---\n<p>properties</p>",
      );
      const { analysisCoverage } = buildAnalysisCoverage([v1Repro], [], NO_RULES, false);
      expect(analysisCoverage?.["hasFrontmatterFence"]).toBe(true);
      // The substrate is the frontmatter, not a `{{ }}` / `{% %}` /
      // `<% %>` token — templateInterpolationFound stays empty because
      // no qualifying token exists in the source.
      expect(analysisCoverage?.["templateInterpolationFound"]).toBeUndefined();
    });

    it("does NOT flag hasFrontmatterFence on a plain HTML file with no fence", () => {
      const plain = htmlFile("index.html", "<p>hello</p>");
      const { analysisCoverage } = buildAnalysisCoverage([plain], [], NO_RULES, false);
      expect(analysisCoverage?.["hasFrontmatterFence"]).toBeUndefined();
    });

    it("does NOT flag hasFrontmatterFence on a mid-document `---` horizontal rule", () => {
      // The fence matcher is anchored at offset 0 — a stray `---`
      // partway through the document (a markdown horizontal rule in an
      // HTML-residue-parsed .md, or a thematic break in authored HTML)
      // must not trip the detector. Only a top-of-file fence with a
      // closing `---` line counts.
      const midDocumentRule = htmlFile(
        "article.html",
        "<h1>Intro</h1>\n---\nnot frontmatter\n---\n<p>body</p>",
      );
      const { analysisCoverage } = buildAnalysisCoverage([midDocumentRule], [], NO_RULES, false);
      expect(analysisCoverage?.["hasFrontmatterFence"]).toBeUndefined();
    });

    it("does NOT flag hasFrontmatterFence when a file opens with `---` but no closing fence", () => {
      // A document that starts with three dashes and a newline but
      // never closes the fence isn't structured frontmatter — the
      // closing `---` line is what distinguishes a post header from a
      // document that opens with a horizontal rule.
      const openOnly = htmlFile("broken.html", "---\ntitle: No close\n<p>body</p>");
      const { analysisCoverage } = buildAnalysisCoverage([openOnly], [], NO_RULES, false);
      expect(analysisCoverage?.["hasFrontmatterFence"]).toBeUndefined();
    });
  });

  // Prose in `.md` / `.markdown` files routinely QUOTES template
  // tokens inside fenced code blocks and inline-code spans. A Jekyll
  // docs page that shows `<%= Time.now %>` as an ERB usage example
  // would emit a `<%x%>` token on the whole scan's telemetry — despite
  // zero `.erb` files reaching the parser. Strip markdown code
  // regions before classification so prose examples stop tripping
  // the detector. The rules here mirror the previous classifier-era
  // behavior because the strip happens BEFORE token detection in
  // `accumulateHtmlCoverageForFile`.
  describe("markdown code-region stripping for token detection", () => {
    it("does not emit `<%x%>` when `<%= x %>` lives in a fenced code block in a .md file", () => {
      const mdDocs = htmlFile(
        "docs/troubleshooting.md",
        [
          "# Troubleshooting",
          "",
          "Here is an ERB example:",
          "",
          "```ruby",
          "<%= Time.now %>",
          "```",
          "",
          "End of section.",
        ].join("\n"),
      );
      const { analysisCoverage } = buildAnalysisCoverage([mdDocs], [], NO_RULES, false);
      expect(analysisCoverage?.["templateInterpolationFound"]).toBeUndefined();
    });

    it("does not emit `{%x%}` when `{% tag %}` lives in a fenced code block in a .markdown file", () => {
      const releaseNotes = htmlFile(
        "History.markdown",
        ["## Release 4.0", "", "```liquid", "{% assign foo = 'bar' %}", "{{ foo }}", "```"].join(
          "\n",
        ),
      );
      const { analysisCoverage } = buildAnalysisCoverage([releaseNotes], [], NO_RULES, false);
      expect(analysisCoverage?.["templateInterpolationFound"]).toBeUndefined();
    });

    it("does not emit `<%x%>` when `<% ... %>` lives in an inline-code span in a .md file", () => {
      const mdInline = htmlFile("docs/tutorial.md", "Use the `<% end %>` tag to close a block.");
      const { analysisCoverage } = buildAnalysisCoverage([mdInline], [], NO_RULES, false);
      expect(analysisCoverage?.["templateInterpolationFound"]).toBeUndefined();
    });

    it("does not emit `{{x}}` when `{{ x }}` lives in an inline-code span in a .md file", () => {
      const mdInline = htmlFile(
        "docs/tutorial.md",
        "The `{{ page.title }}` expression renders the page title.",
      );
      const { analysisCoverage } = buildAnalysisCoverage([mdInline], [], NO_RULES, false);
      expect(analysisCoverage?.["templateInterpolationFound"]).toBeUndefined();
    });

    it("still emits tokens that appear OUTSIDE a fenced block in the same .md file", () => {
      // Mixed: a real token in body prose (rare but possible — a Hugo
      // theme README that literally renders `{{ .Title }}`) plus a
      // quoted example in a fence. The fence is stripped; the live
      // token stays. Over-stripping would silently drop honest
      // template evidence.
      const mixed = htmlFile(
        "README.md",
        [
          "# Title",
          "",
          "{% assign user = 'alice' %}",
          "",
          "```text",
          "<% old example %>",
          "```",
        ].join("\n"),
      );
      const { analysisCoverage } = buildAnalysisCoverage([mixed], [], NO_RULES, false);
      const tokens = analysisCoverage?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      const literals = (tokens ?? []).map((entry) => entry.token);
      expect(literals).toEqual(["{%x%}"]);
    });

    it("does not strip code regions in non-markdown HTML files — prose + fences are an .md concern only", () => {
      // A plain `.html` file with literal backticks does not go
      // through the markdown stripper (backticks are not HTML
      // code-block syntax). The detector sees the full source; a
      // `<%= %>` inside a `<pre><code>` block still surfaces as the
      // `<%x%>` token because stripping `<pre><code>` requires AST
      // analysis, out of scope for this fix.
      const htmlWithPre = htmlFile("example.html", "<pre><code><%= Time.now %></code></pre>");
      const { analysisCoverage } = buildAnalysisCoverage([htmlWithPre], [], NO_RULES, false);
      const tokens = analysisCoverage?.["templateInterpolationFound"] as
        | readonly { token: string; count: number }[]
        | undefined;
      const literals = (tokens ?? []).map((entry) => entry.token);
      expect(literals).toEqual(["<%x%>"]);
    });
  });

  describe("preset: 'storybook'", () => {
    it("counts Storybook primitives as opaque when preset is not active", () => {
      // Story file scanned as plain TSX: every primitive inflates the
      // opaque count and lands in the ranked list. This is the
      // status-quo behavior the preset is designed to improve.
      const files = [
        tsxFile("Button.stories.tsx", ["Meta", "StoryObj", "StoryFn", "Story"], {
          interactive: true,
        }),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(4);
    });

    it("exempts Storybook primitives from the opaque count in story files when preset is active", () => {
      const files = [
        tsxFile("Button.stories.tsx", ["Meta", "StoryObj", "StoryFn", "Story"], {
          interactive: true,
        }),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(
        files,
        [],
        NO_RULES,
        false,
        0,
        "storybook",
      );
      // With the preset, Storybook primitives render transparent in
      // the opaque telemetry — no `analysisCoverage` block at all
      // when there's nothing else to report.
      expect(analysisCoverage?.["opaqueCustomComponents"]).toBeUndefined();
    });

    it("still surfaces non-Storybook components in story files when preset is active", () => {
      // The wrapped component (`Button`) is not exempt — that's the
      // point: the preset surfaces findings on the underlying JSX
      // rather than the wrapper.
      const files = [
        tsxFile("Button.stories.tsx", ["Meta", "StoryObj", "Button"], { interactive: true }),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(
        files,
        [],
        NO_RULES,
        false,
        0,
        "storybook",
      );
      expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(1);
      const top = analysisCoverage?.["opaqueCustomComponentsTop"] as
        | { name: string; callSites: number }[]
        | undefined;
      expect(top?.map((e) => e.name)).toEqual(["Button"]);
    });

    it("does not exempt Storybook tags in non-story files even with preset on", () => {
      // An unrelated product-code file that happens to render a
      // component literally called `Meta` is not a Storybook call
      // site — keep it opaque so real findings aren't suppressed.
      const files = [tsxFile("src/MetaTag.tsx", ["Meta"], { interactive: true })];
      const { analysisCoverage } = buildAnalysisCoverage(
        files,
        [],
        NO_RULES,
        false,
        0,
        "storybook",
      );
      expect(analysisCoverage?.["opaqueCustomComponents"]).toBe(1);
    });
  });

  // The bucket a parse-errored file lands in depends on whether the
  // recovered partial AST was enough for any rule to fire. Combining
  // both cases into a single `parseErrorFiles` bucket (historical
  // behavior) conflated "file invisible to rules, agent should treat
  // as unscanned" with "file partially reported, findings are real" —
  // the canonical motivating case was a `.mdx` file emitting 14
  // findings with live line numbers that ALSO landed in
  // `parseErrorFiles`, causing agents to silently discard the
  // findings as "from an invisible file."
  describe("parse-error file split: total-failure vs partial", () => {
    function htmlFileWithErrors(path: string): ParsedFile {
      return {
        filePath: path,
        source: "<div",
        ast: {
          language: "html",
          root: {
            kind: "HtmlDocument",
            range: { start: 0, end: 0 },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            children: [],
          },
          errors: [
            {
              message: "Unexpected end of input while parsing tag",
              position: { line: 1, column: 5, offset: 4 },
              recoverable: true,
            },
          ],
        },
      };
    }

    it("routes errored files with no findings into parseErrorFiles (invisible-to-rules bucket) with per-entry parser + reason", () => {
      // Errored file, empty finding set -> lands in the invisible bucket.
      // The `{ path, parser, reason }` shape is the actionable fix pivot:
      // without the parser + reason the top-level `parse_errors_present`
      // flag is a silent-failure shape.
      const files = [htmlFileWithErrors("modal.mdx")];
      const { analysisCoverage } = buildAnalysisCoverage(
        files,
        [],
        NO_RULES,
        true,
        0,
        undefined,
        undefined,
        new Set<string>(),
      );
      expect(analysisCoverage?.["parseErrorFileCount"]).toBe(1);
      expect(analysisCoverage?.["parseErrorFiles"]).toEqual([
        {
          path: "modal.mdx",
          parser: "html",
          reason: "Unexpected end of input while parsing tag",
        },
      ]);
      expect(analysisCoverage?.["partialParseFileCount"]).toBeUndefined();
      expect(analysisCoverage?.["partialParseFiles"]).toBeUndefined();
    });

    it("routes errored files WITH findings into partialParseFiles (parser + reason carried per entry)", () => {
      // Same errored file, but the violations set includes its path —
      // rules fired on the recovered slice. Must land in the partial
      // bucket, not `parseErrorFiles`, so the agent doesn't discard
      // the 14 live-line-number findings as "invisible."
      const files = [htmlFileWithErrors("modal.mdx")];
      const { analysisCoverage } = buildAnalysisCoverage(
        files,
        [],
        NO_RULES,
        true,
        0,
        undefined,
        undefined,
        new Set(["modal.mdx"]),
      );
      expect(analysisCoverage?.["parseErrorFileCount"]).toBeUndefined();
      expect(analysisCoverage?.["parseErrorFiles"]).toBeUndefined();
      expect(analysisCoverage?.["partialParseFileCount"]).toBe(1);
      expect(analysisCoverage?.["partialParseFiles"]).toEqual([
        {
          path: "modal.mdx",
          parser: "html",
          reason: "Unexpected end of input while parsing tag",
        },
      ]);
    });

    it("classifies each errored file independently when some produced findings and some did not", () => {
      // Mixed scan: one errored file that rules saw (partial bucket),
      // one errored file they couldn't (invisible bucket). Two
      // separate counts, two separate lists — both carry the full
      // `{ path, parser, reason }` triple.
      const files = [htmlFileWithErrors("a.html"), htmlFileWithErrors("b.html")];
      const { analysisCoverage } = buildAnalysisCoverage(
        files,
        [],
        NO_RULES,
        true,
        0,
        undefined,
        undefined,
        new Set(["a.html"]),
      );
      expect(analysisCoverage?.["parseErrorFileCount"]).toBe(1);
      const invisible = analysisCoverage?.["parseErrorFiles"] as
        | { path: string; parser: string; reason: string }[]
        | undefined;
      expect(invisible?.map((e) => e.path)).toEqual(["b.html"]);
      expect(invisible?.[0]?.parser).toBe("html");
      expect(analysisCoverage?.["partialParseFileCount"]).toBe(1);
      const partial = analysisCoverage?.["partialParseFiles"] as
        | { path: string; parser: string; reason: string }[]
        | undefined;
      expect(partial?.map((e) => e.path)).toEqual(["a.html"]);
      expect(partial?.[0]?.parser).toBe("html");
    });

    it("ships both parse-error buckets with detail regardless of verbose flag (parser + reason is the signal, not a dumpable list)", () => {
      // Previously `parseErrorFiles` hid its paths behind verboseMeta
      // while `partialParseFiles` shipped `{ path, reason }` at every
      // verbosity. The gating left the top-level `parse_errors_present`
      // flag unactionable when verboseMeta: false — the agent knew one
      // file didn't parse but couldn't see which one or why. Per
      //, both buckets now always ship the full
      // `{ path, parser, reason }` triple so the fix pivot is present
      // on every response.
      const files = [htmlFileWithErrors("modal.mdx"), htmlFileWithErrors("broken.html")];
      const { analysisCoverage } = buildAnalysisCoverage(
        files,
        [],
        NO_RULES,
        false, // verbose: false
        0,
        undefined,
        undefined,
        new Set(["modal.mdx"]),
      );
      expect(analysisCoverage?.["partialParseFiles"]).toEqual([
        {
          path: "modal.mdx",
          parser: "html",
          reason: "Unexpected end of input while parsing tag",
        },
      ]);
      expect(analysisCoverage?.["parseErrorFiles"]).toEqual([
        {
          path: "broken.html",
          parser: "html",
          reason: "Unexpected end of input while parsing tag",
        },
      ]);
    });

    it("defaults to the invisible bucket when findingFilePaths is omitted (no silent demotion)", () => {
      // Callers that haven't threaded findings yet get the
      // historical "all errored files are invisible" behavior — the
      // safe direction, because routing a file from invisible to
      // partial without evidence would silently tell the agent
      // "don't worry, some rules ran" when no rules did.
      const files = [htmlFileWithErrors("a.html")];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, true);
      expect(analysisCoverage?.["parseErrorFileCount"]).toBe(1);
      expect(analysisCoverage?.["parseErrorFiles"]).toEqual([
        {
          path: "a.html",
          parser: "html",
          reason: "Unexpected end of input while parsing tag",
        },
      ]);
      expect(analysisCoverage?.["partialParseFileCount"]).toBeUndefined();
    });

    it("propagates parser-emitted triggerToken alongside the structured reason code", () => {
      // When the parser ships a structured `code`/`triggerToken` pair
      // (the `.js`-routed-through-tsx case is the canonical one), the
      // entry must carry `triggerToken` as additive evidence — the
      // agent reads the code via `reason` and the offending fragment
      // via `triggerToken`, never as if the fragment were authored
      // ground truth.
      const file: ParsedFile = {
        filePath: "livereload.js",
        source: "",
        ast: {
          language: "tsx",
          root: {
            kind: "TsxModule",
            range: { start: 0, end: 0 },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            jsxElements: [],
          },
          errors: [
            {
              message: "tsx_parser_on_non_jsx_input",
              position: { line: 2, column: 30, offset: 50 },
              recoverable: true,
              code: "tsx_parser_on_non_jsx_input",
              triggerToken: "<b.length>",
            },
          ],
        },
      };
      const { analysisCoverage } = buildAnalysisCoverage([file], [], NO_RULES, true);
      expect(analysisCoverage?.["parseErrorFiles"]).toEqual([
        {
          path: "livereload.js",
          parser: "tsx",
          reason: "tsx_parser_on_non_jsx_input",
          triggerToken: "<b.length>",
        },
      ]);
    });

    it("omits triggerToken when the parser does not emit one (present-when-meaningful)", () => {
      // Conventional prose-reason entries (the html-parser case) must
      // NOT carry a `triggerToken: ""` sentinel — the field shape is
      // present-when-meaningful per the AI-first consumer rules.
      const files = [htmlFileWithErrors("a.html")];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, true);
      const entries = analysisCoverage?.["parseErrorFiles"] as
        | { path: string; parser: string; reason: string; triggerToken?: string }[]
        | undefined;
      expect(entries?.[0]?.triggerToken).toBeUndefined();
      expect(Object.hasOwn(entries?.[0] ?? {}, "triggerToken")).toBe(false);
    });

    it("names the underlying parser honestly even when the extension disguises it (e.g. .mdx parses through the TSX bridge)", () => {
      // `file.ast.language` is the source of truth for `parser`: an
      // `.mdx` path routed through the MDX → TSX bridge emits
      // `tsx`-class diagnostics even though the extension says `.mdx`.
      // The agent needs the real parser name to pick the right fix
      // pivot (tsx parser quirks vs html parser quirks).
      const mdxAsTsx: ParsedFile = {
        filePath: "content/post.mdx",
        source: "<div",
        ast: {
          language: "tsx",
          root: {
            kind: "TsxModule",
            range: { start: 0, end: 0 },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            jsxElements: [],
          },
          errors: [
            {
              message: "Unexpected token in JSX expression",
              position: { line: 1, column: 5, offset: 4 },
              recoverable: true,
            },
          ],
        },
      };
      const { analysisCoverage } = buildAnalysisCoverage(
        [mdxAsTsx],
        [],
        NO_RULES,
        true,
        0,
        undefined,
        undefined,
        new Set<string>(),
      );
      const invisible = analysisCoverage?.["parseErrorFiles"] as
        | { path: string; parser: string; reason: string }[]
        | undefined;
      expect(invisible?.[0]?.parser).toBe("tsx");
    });

    it("truncates very long parse-error reasons so response size stays bounded", () => {
      // Real parser messages are ≤120 chars. The truncation only
      // bites on hostile input where a recovered parser echoes back
      // a long source snippet; bounds the wire shape without losing
      // the head of the message (where the error kind lives).
      const longMessage = `SyntaxError: ${"x".repeat(500)}`;
      const errored: ParsedFile = {
        filePath: "hostile.html",
        source: "<div",
        ast: {
          language: "html",
          root: {
            kind: "HtmlDocument",
            range: { start: 0, end: 0 },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            children: [],
          },
          errors: [
            {
              message: longMessage,
              position: { line: 1, column: 1, offset: 0 },
              recoverable: true,
            },
          ],
        },
      };
      const { analysisCoverage } = buildAnalysisCoverage(
        [errored],
        [],
        NO_RULES,
        true,
        0,
        undefined,
        undefined,
        new Set(["hostile.html"]),
      );
      const partial = analysisCoverage?.["partialParseFiles"] as
        | { path: string; parser: string; reason: string }[]
        | undefined;
      expect(partial?.[0]?.reason.length).toBeLessThan(longMessage.length);
      // Head of the message survives — the actionable kind-of-error
      // signal is at the start, so truncation from the tail preserves
      // the triage signal.
      expect(partial?.[0]?.reason.startsWith("SyntaxError:")).toBe(true);
    });
  });

  describe("fragmentFiles telemetry", () => {
    // Real-AST helper: drives the live parser so the HtmlDocument
    // passed to buildAnalysisCoverage carries the same tree shape the
    // rule-side `isHtmlFragment` predicate reads. Keeps the
    // telemetry-vs-rule-scope invariant honest (same fragment set on
    // both sides).
    function parsedHtml(path: string, source: string): ParsedFile {
      const parsed = parseHtml(source);
      return {
        filePath: path,
        source,
        ast: { language: "html", root: parsed.root, errors: parsed.errors },
      };
    }

    it("lists HTML files with no <html> root and no <body>", () => {
      // Jekyll `_includes/header.html` shape: a plain chunk of markup
      // meant to be composed into a parent layout at render time.
      const fragment = parsedHtml(
        "_includes/header.html",
        '<nav><a href="/">Home</a><a href="/about">About</a></nav>',
      );
      const { analysisCoverage } = buildAnalysisCoverage([fragment], [], NO_RULES, false);
      expect(analysisCoverage?.["fragmentFileCount"]).toBe(1);
      expect(analysisCoverage?.["fragmentFiles"]).toEqual(["_includes/header.html"]);
    });

    it("omits fragmentFiles entirely when every HTML file has <html> or <body>", () => {
      const fullPage = parsedHtml(
        "index.html",
        "<html><body><h1>Hello</h1><p>World</p></body></html>",
      );
      const { analysisCoverage } = buildAnalysisCoverage([fullPage], [], NO_RULES, false);
      // Present-when-meaningful: a zero-count list would be ambiguous
      // (the scan didn't run vs no fragments), so the field is absent.
      expect(analysisCoverage?.["fragmentFileCount"]).toBeUndefined();
      expect(analysisCoverage?.["fragmentFiles"]).toBeUndefined();
    });

    it("sorts fragmentFiles alphabetically for deterministic wire output", () => {
      const files = [
        parsedHtml("_includes/z-last.html", "<div>z</div>"),
        parsedHtml("_includes/a-first.html", "<div>a</div>"),
        parsedHtml("_includes/m-middle.html", "<div>m</div>"),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      expect(analysisCoverage?.["fragmentFiles"]).toEqual([
        "_includes/a-first.html",
        "_includes/m-middle.html",
        "_includes/z-last.html",
      ]);
    });

    it("counts a full page as NOT a fragment even without <html> (has <body>)", () => {
      // A <body>-only document (no <html> wrapper) is a full page for
      // the scanner — `document/lang-attribute` skips it because there's
      // no <html> to attach lang to, but `landmark-main` evaluates it.
      // The fragment predicate matches: either signal turns the file
      // into a page.
      const bodyOnly = parsedHtml("page.html", "<body><h1>Hi</h1></body>");
      const fragment = parsedHtml("_includes/nav.html", '<nav><a href="/">Home</a></nav>');
      const { analysisCoverage } = buildAnalysisCoverage([bodyOnly, fragment], [], NO_RULES, false);
      expect(analysisCoverage?.["fragmentFileCount"]).toBe(1);
      expect(analysisCoverage?.["fragmentFiles"]).toEqual(["_includes/nav.html"]);
    });

    it("is independent of verboseMeta — telemetry ships at every verbosity", () => {
      // `fragmentFiles` is the actionable per-entry signal (path is the
      // only field), not a bounded-but-large inventory. Gating it on
      // `verboseMeta` would reduce the top-level `fragmentFileCount` to
      // a silent-failure shape (count without paths → "which files?").
      // Same reasoning as `parseErrorFiles` / `partialParseFiles`.
      const fragment = parsedHtml("_includes/footer.html", "<footer>©</footer>");
      const terse = buildAnalysisCoverage([fragment], [], NO_RULES, false).analysisCoverage;
      const verbose = buildAnalysisCoverage([fragment], [], NO_RULES, true).analysisCoverage;
      expect(terse?.["fragmentFiles"]).toEqual(["_includes/footer.html"]);
      expect(verbose?.["fragmentFiles"]).toEqual(["_includes/footer.html"]);
    });
  });

  // `filesByExtension` counts .scss files separately, but every .scss
  // file routes through the SCSS adapter → CSS AST and participates in
  // `.css`-gated rules' `perRuleCoverage.filesEvaluated`. Without
  // disclosing the parse mode, a scan with many `.scss` files and
  // `filesEvaluated` totals that don't cleanly sum forces the agent
  // to guess which parser the scanner used per extension. The
  // `parseModeByExtension` field in `analysisCoverage` answers that
  // question directly: extensions whose parser name equals the
  // extension itself surface as `"native"`, alias-routed extensions
  // surface the AST-language tag they feed into.
  describe("parseModeByExtension disclosure", () => {
    function fileWith(
      path: string,
      language: "html" | "css" | "tsx" | "jsx" | "ts" | "js",
    ): ParsedFile {
      // Minimal ParsedFile shape — only `filePath` + `ast.language`
      // drive `parseModeByExtension`, so the AST body is a stub that
      // satisfies the discriminated union for whichever language the
      // caller asked for. Mirrors the `mkFile` helper used by the
      // sibling `rulesFiredByExtension` alias-coverage block. Real
      // `parseForExtension` always tags the whole JSX family
      // (`.tsx`/`.jsx`/`.ts`/`.js`) with `language: "tsx"`; the
      // helper accepts the narrower union for deliberate test cases
      // that want to exercise the language discriminator directly.
      if (language === "html") {
        return {
          filePath: path,
          source: "",
          ast: {
            language: "html",
            root: {
              kind: "HtmlDocument",
              range: { start: 0, end: 0 },
              loc: {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 0 },
              },
              children: [],
            },
            errors: [],
          },
        };
      }
      if (language === "css") {
        return {
          filePath: path,
          source: "",
          ast: {
            language: "css",
            root: {
              kind: "CssStylesheet",
              range: { start: 0, end: 0 },
              loc: {
                start: { line: 1, column: 1, offset: 0 },
                end: { line: 1, column: 1, offset: 0 },
              },
              rules: [],
            },
            errors: [],
          },
        };
      }
      return {
        filePath: path,
        source: "",
        ast: {
          language,
          root: {
            kind: "TsxModule",
            range: { start: 0, end: 0 },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            jsxElements: [],
          },
          errors: [],
        },
      };
    }

    it("labels native extensions (.html/.css/.tsx) as `native`", () => {
      // An extension whose name equals the AST language has no alias
      // indirection to disclose — the `"native"` sentinel is the honest
      // read: same parser, same rule gate, same `filesEvaluated` lane.
      const files = [
        fileWith("index.html", "html"),
        fileWith("styles.css", "css"),
        fileWith("App.tsx", "tsx"),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const mode = analysisCoverage?.["parseModeByExtension"] as Record<string, string> | undefined;
      expect(mode).toEqual({
        ".css": "native",
        ".html": "native",
        ".tsx": "native",
      });
    });

    it("labels `.scss` as `css` (the aliased AST language it routes through)", () => {
      // The canonical disclosure case: 584 `.scss` files in the
      // website-templates scan were parsed as CSS; an agent reading
      // `parseModeByExtension[".scss"] === "css"` learns that every
      // `.css`-gated rule's `filesEvaluated` includes these files.
      const files = [fileWith("button.scss", "css"), fileWith("main.css", "css")];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const mode = analysisCoverage?.["parseModeByExtension"] as Record<string, string> | undefined;
      expect(mode?.[".scss"]).toBe("css");
      expect(mode?.[".css"]).toBe("native");
    });

    it("labels `.htm` as `native` (same parser family as `.html`)", () => {
      // `.htm` and `.html` both parse to an HTML AST with
      // `language: "html"`. A literal equality check between extension
      // name and language would wrongly tag `.htm` as aliased; the
      // helper normalizes this to `"native"` so the disclosure is
      // honest (no alias indirection to explain).
      const files = [fileWith("legacy.htm", "html")];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const mode = analysisCoverage?.["parseModeByExtension"] as Record<string, string> | undefined;
      expect(mode?.[".htm"]).toBe("native");
    });

    it("labels `.jsx` as `native` even though the AST language tag is `tsx`", () => {
      // The in-house parser emits `language: "tsx"` for the whole
      // JSX family — `.tsx`, `.jsx`, `.ts`, `.js` all land on the
      // same parser. `.tsx` and `.jsx` are the native JSX-family
      // extensions (no alias indirection); `.ts` and `.js` ARE
      // aliases (they can't legally carry JSX and are routed through
      // the TSX parser only because Next.js-style codebases ship JSX
      // in plain `.js`). Normalize `.jsx → "native"` here; keep
      // `.ts` / `.js → "tsx"` as the honest alias disclosure. Real
      // `parseForExtension` tags all four with `language: "tsx"`, so
      // the test mirrors that production reality.
      const files = [
        fileWith("App.jsx", "tsx"),
        fileWith("util.ts", "tsx"),
        fileWith("legacy.js", "tsx"),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const mode = analysisCoverage?.["parseModeByExtension"] as Record<string, string> | undefined;
      expect(mode?.[".jsx"]).toBe("native");
      expect(mode?.[".ts"]).toBe("tsx");
      expect(mode?.[".js"]).toBe("tsx");
    });

    it("covers every EXTENSION_ALIASES row: .scss → css, .mdx → tsx, .astro/.md/.markdown → html, .ts/.js → tsx", () => {
      // Pin the full alias table to the parse-mode disclosure so a
      // future alias addition in `src/utils/path.ts EXTENSION_ALIASES`
      // can't silently drift the disclosure out of sync. AST languages
      // mirror what the dedicated parsers in `src/mcp/session.ts
      // parseForExtension` produce (the TSX parser handles the whole
      // JSX family and tags everything `tsx`).
      const files = [
        fileWith("a.scss", "css"),
        fileWith("b.mdx", "tsx"),
        fileWith("c.astro", "html"),
        fileWith("d.md", "html"),
        fileWith("e.markdown", "html"),
        fileWith("f.js", "tsx"),
        fileWith("g.ts", "tsx"),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const mode = analysisCoverage?.["parseModeByExtension"] as Record<string, string> | undefined;
      expect(mode).toEqual({
        ".astro": "html",
        ".js": "tsx",
        ".markdown": "html",
        ".md": "html",
        ".mdx": "tsx",
        ".scss": "css",
        ".ts": "tsx",
      });
    });

    it("omits the field when no parseable files were scanned (present-when-meaningful)", () => {
      // Empty input → no disclosure to make. A caller distinguishing
      // "no data" from "empty map" reads the field's absence as "no
      // parseable files," matching the honest-shape rule from the
      // ai-first-consumer doctrine.
      const { analysisCoverage } = buildAnalysisCoverage([], [], NO_RULES, false);
      expect(analysisCoverage?.["parseModeByExtension"]).toBeUndefined();
    });

    it("surfaces on the response by default (not gated on verboseMeta) — scan-confidence telemetry", () => {
      // Sibling to `parseErrorFiles`/`fragmentFiles`/`rulesFiredByExtension`:
      // the reconciliation signal the field provides is load-bearing
      // whenever the agent inspects `filesByExtension` — gating it
      // behind verbose would make the field invisible on the default
      // response shape exactly when the agent needs it to explain the
      // `filesEvaluated` mismatch.
      const files = [fileWith("a.scss", "css")];
      const { analysisCoverage: defaultMeta } = buildAnalysisCoverage(files, [], NO_RULES, false);
      expect(defaultMeta?.["parseModeByExtension"]).toEqual({ ".scss": "css" });
    });

    it("sorts extensions alphabetically for deterministic wire output", () => {
      const files = [
        fileWith("z.tsx", "tsx"),
        fileWith("a.scss", "css"),
        fileWith("m.html", "html"),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
      const mode = analysisCoverage?.["parseModeByExtension"] as Record<string, string> | undefined;
      expect(Object.keys(mode ?? {})).toEqual([".html", ".scss", ".tsx"]);
    });
  });

  // `rulesFiredByExtension` and
  // `perRuleCoverage` both name "rules that ran on this extension." Two
  // surfaces naming the same thing must agree — the historical bug was
  // that the per-extension view used literal extension equality while
  // the rule-runner's `applies()` gate routes through `extensionMatches`,
  // which honors the EXTENSION_ALIASES table (`.scss → .css`,
  // `.mdx → .tsx/.jsx`, `.astro → .html`, `.md/.markdown → .html`,
  // `.js → .jsx`, `.ts → .tsx`). On a `.scss`-only scan, every CSS-
  // targeted rule (the entire `contrast/*`, `layout/*`, `focus/not-
  // obscured`, `motion/pause-stop-hide`, …) fires — the SCSS adapter
  // produces a CSS AST and the rule runner matches through the alias —
  // yet `rulesFiredByExtension[".scss"]` historically listed only the
  // rules without any `fileExtensions` gate (e.g. `focus/outline-visible`,
  // `wrapper/drift`). Cross-surface drift.
  //
  // (ADR 0028): the field was renamed
  // from `rulesByExtension` to `rulesFiredByExtension` to disambiguate
  // it from `perRuleCoverage`. The deprecated alias `rulesByExtension`
  // still ships alongside for one minor release; a parity test below
  // pins the alias-mirrors-canonical invariant.
  describe("rulesFiredByExtension alias coverage", () => {
    function scssFile(path: string): ParsedFile {
      // Mirrors the shape `scanFiles` produces for a `.scss` input: the
      // SCSS parser path in `src/input/parsers/css.ts` emits a
      // `CssStylesheet` AST under `language: "css"`, and the file's
      // path retains the `.scss` extension. This is the exact shape
      // `rulesFiredByExtension` must honor — extension `.scss` seen in
      // the file list, even though the AST language is `"css"`.
      return {
        filePath: path,
        source: ".foo { color: red; }",
        ast: {
          language: "css",
          root: {
            kind: "CssStylesheet",
            range: { start: 0, end: 0 },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            rules: [],
          },
          errors: [],
        },
      };
    }

    function syntheticRule(id: string, fileExtensions?: readonly string[]): Rule {
      return {
        id,
        satisfies: [],
        severity: "error",
        scope: "node",
        fixClass: "verify-in-source",
        ...(fileExtensions ? { appliesTo: { fileExtensions } } : {}),
        docs: {
          description: id,
          rationale: "synthetic test rule",
          goodExample: "",
          badExample: "",
          references: [],
        },
        check: () => [],
      };
    }

    it("lists .css-targeted rules under `.scss` because .scss aliases to .css", () => {
      // A rule declared `fileExtensions: [".css"]` runs on `.scss`
      // files via alias — exactly the pattern every in-tree
      // `contrast/*` / `layout/*` rule uses.
      // `rulesFiredByExtension[".scss"]` must include it so the
      // meta-surface agrees with per-file eligibility.
      const cssTargeted = syntheticRule("contrast/fake", [".css"]);
      const unconstrained = syntheticRule("focus/fake");
      const htmlOnly = syntheticRule("aria/fake", [".html", ".htm"]);
      const files = [scssFile("styles/button.scss")];
      const { analysisCoverage } = buildAnalysisCoverage(
        files,
        [],
        [cssTargeted, unconstrained, htmlOnly],
        true,
      );
      const byExt = analysisCoverage?.["rulesFiredByExtension"] as
        | Record<string, readonly string[]>
        | undefined;
      expect(byExt).toBeDefined();
      // The .css-gated rule DOES appear under .scss (alias expansion),
      // the unconstrained rule appears (no gate), and the .html-only
      // rule is correctly absent (no alias from .scss to .html).
      expect(byExt?.[".scss"]).toEqual(["contrast/fake", "focus/fake"]);
    });

    it("expands aliases symmetrically for .mdx → .tsx/.jsx, .astro → .html, .md/.markdown → .html, .js → .jsx, .ts → .tsx", () => {
      // One synthetic rule per gate family. The alias table in
      // src/utils/path.ts EXTENSION_ALIASES is the source of truth —
      // this test pins the cross-surface expectation for every row of
      // that table so a future alias addition can't silently drift
      // rulesFiredByExtension back out of sync with `applies()`.
      const tsxOnly = syntheticRule("r/tsx", [".tsx"]);
      const jsxOnly = syntheticRule("r/jsx", [".jsx"]);
      const htmlOnly = syntheticRule("r/html", [".html"]);
      const cssOnly = syntheticRule("r/css", [".css"]);
      const rules = [tsxOnly, jsxOnly, htmlOnly, cssOnly];
      // File list covers: .scss (→.css), .mdx (→.tsx/.jsx), .astro (→.html),
      // .md (→.html), .markdown (→.html), .js (→.jsx), .ts (→.tsx).
      // We construct the bare ParsedFile shape (AST language is cosmetic
      // for `rulesFiredByExtension` — only the filePath extension is read).
      const mkFile = (path: string): ParsedFile => ({
        filePath: path,
        source: "",
        ast: {
          language: "css",
          root: {
            kind: "CssStylesheet",
            range: { start: 0, end: 0 },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            rules: [],
          },
          errors: [],
        },
      });
      const files = [
        mkFile("a.scss"),
        mkFile("b.mdx"),
        mkFile("c.astro"),
        mkFile("d.md"),
        mkFile("e.markdown"),
        mkFile("f.js"),
        mkFile("g.ts"),
      ];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], rules, true);
      const byExt = analysisCoverage?.["rulesFiredByExtension"] as
        | Record<string, readonly string[]>
        | undefined;
      expect(byExt).toBeDefined();
      // .scss → .css
      expect(byExt?.[".scss"]).toEqual(["r/css"]);
      // .mdx → both .tsx and .jsx
      expect(byExt?.[".mdx"]).toEqual(["r/jsx", "r/tsx"]);
      // .astro → .html
      expect(byExt?.[".astro"]).toEqual(["r/html"]);
      // .md → .html
      expect(byExt?.[".md"]).toEqual(["r/html"]);
      // .markdown → .html
      expect(byExt?.[".markdown"]).toEqual(["r/html"]);
      // .js → .jsx
      expect(byExt?.[".js"]).toEqual(["r/jsx"]);
      // .ts → .tsx
      expect(byExt?.[".ts"]).toEqual(["r/tsx"]);
    });

    it("still exact-matches non-aliased extensions (`.css` rule on `.css` file)", () => {
      // Regression guard: the alias code path must not break the
      // literal-match case. A rule declaring `.css` still appears
      // under `.css` exactly as before.
      const cssOnly = syntheticRule("contrast/fake", [".css"]);
      const files = [cssFile("styles/main.css")];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], [cssOnly], true);
      const byExt = analysisCoverage?.["rulesFiredByExtension"] as
        | Record<string, readonly string[]>
        | undefined;
      expect(byExt?.[".css"]).toEqual(["contrast/fake"]);
    });

    it("cross-surface invariant: `rulesFiredByExtension[ext]` agrees with `perRuleCoverage` evaluation on alias-heavy inputs", async () => {
      // End-to-end: run the real scanner against an in-tree `.scss`
      // file and assert that every rule reporting `filesEvaluated > 0`
      // on the scan is listed under `rulesFiredByExtension[".scss"]`.
      // This is the invariant — two
      // surfaces describing "rules run on this extension" must agree
      // or the doctrine violation recurs silently.
      const { MCP_TOOLS } = await import("../../../src/mcp/tools.ts");
      const { McpSession } = await import("../../../src/mcp/session.ts");
      const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = join(tmpdir(), `ra11y-rulesFiredByExtension-scss-${process.pid}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "styles.scss"),
        ".btn { color: #777; background: #888; outline: none; }\n",
      );
      try {
        const scanTool = MCP_TOOLS.find((t) => t.def.name === "scan_project");
        if (!scanTool) throw new Error("scan_project tool missing");
        const session = new McpSession();
        const result = await scanTool.handler({ cwd: dir, verboseMeta: true }, session);
        const data = JSON.parse(result.content[0].text) as {
          meta: {
            perRuleCoverage?: readonly {
              ruleId: string;
              filesEvaluated: number;
            }[];
            analysisCoverage?: {
              rulesFiredByExtension?: Record<string, readonly string[]>;
              rulesByExtension?: Record<string, readonly string[]>;
            };
          };
          warnings?: readonly string[];
        };
        const ranOnScss = new Set(
          (data.meta.perRuleCoverage ?? [])
            .filter((row) => row.filesEvaluated > 0)
            .map((row) => row.ruleId),
        );
        const listed = new Set(data.meta.analysisCoverage?.rulesFiredByExtension?.[".scss"] ?? []);
        // Every rule that actually evaluated the .scss file must appear
        // under rulesFiredByExtension[".scss"]. Extra entries in
        // `listed` are fine (unconstrained rules, rules whose other
        // declared extensions also match — neither breaks the "agrees"
        // direction the field report names) — what must not drift is
        // the silent-miss direction (rule ran, not listed).
        for (const ruleId of ranOnScss) {
          expect(listed.has(ruleId)).toBe(true);
        }
        // Stronger: at least one .css-gated rule must make the cut,
        // because a .scss scan definitionally exercises the alias.
        // Without this tripwire the test could pass vacuously if the
        // scanner produced no CSS-gated evaluations at all.
        expect(listed.size).toBeGreaterThan(2);
        // (ADR 0028): the deprecated
        // alias `rulesByExtension` ships alongside the canonical name
        // for one minor release with the identical value; the
        // deprecation warning rides whenever the alias is emitted.
        expect(data.meta.analysisCoverage?.rulesByExtension).toEqual(
          data.meta.analysisCoverage?.rulesFiredByExtension,
        );
        expect(data.warnings).toContain(
          "deprecated_field_rules_by_extension_renamed_rules_fired_by_extension",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("emits the deprecated `rulesByExtension` alias alongside `rulesFiredByExtension`", () => {
      // Direct unit-level guard on the rename: the canonical field and
      // the deprecated alias both ship under verbose, with identical
      // contents. Mirrors the precedent from
      // `deprecated_field_id_renamed_criterionId` (-
      // FIELD-NAME-DRIFT) — the alias is presence-only signal so an
      // agent reading the warnings channel can drop its legacy reads
      // on the next call.
      const cssTargeted = syntheticRule("contrast/fake", [".css"]);
      const files = [scssFile("styles/button.scss")];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], [cssTargeted], true);
      expect(analysisCoverage?.["rulesFiredByExtension"]).toBeDefined();
      expect(analysisCoverage?.["rulesByExtension"]).toEqual(
        analysisCoverage?.["rulesFiredByExtension"],
      );
    });

    it("does not emit either field on a non-verbose scan (rename does not change the verbose gate)", () => {
      // The rename moves names, not gating. Both the canonical
      // `rulesFiredByExtension` and the deprecated alias
      // `rulesByExtension` remain verboseMeta-only — a terse scan
      // sheds the per-extension view entirely and the deprecation
      // warning does not fire (predicate keys off alias presence).
      const cssTargeted = syntheticRule("contrast/fake", [".css"]);
      const files = [scssFile("styles/button.scss")];
      const { analysisCoverage } = buildAnalysisCoverage(files, [], [cssTargeted], false);
      expect(analysisCoverage?.["rulesFiredByExtension"]).toBeUndefined();
      expect(analysisCoverage?.["rulesByExtension"]).toBeUndefined();
    });
  });

  // Q-SHARED-META-ARRAY-BUDGET-CAP: `parseErrorFiles`,
  // `partialParseFiles`, and `fragmentFiles` all grow linearly with
  // input. A bulk-template scan produced 121KB of parse-error entries
  // alone. The cap trims the *list* to META_ARRAY_CAP entries while
  // the paired count stays full and a sibling `*Truncated: { shown,
  // total }` describes the trim. Downstream `response_meta_truncated`
  // warning code fires via the returned `metaArrayTruncated` signal.
  describe("meta path-array cap (Q-SHARED-META-ARRAY-BUDGET-CAP)", () => {
    function htmlFileWithErrorsAt(path: string): ParsedFile {
      return {
        filePath: path,
        source: "<div",
        ast: {
          language: "html",
          root: {
            kind: "HtmlDocument",
            range: { start: 0, end: 0 },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            children: [],
          },
          errors: [
            {
              message: "Unexpected end of input while parsing tag",
              position: { line: 1, column: 5, offset: 4 },
              recoverable: true,
            },
          ],
        },
      };
    }

    // `parseErrorFiles` and
    // `partialParseFiles` exited the {@link META_ARRAY_CAP} cap regime
    // in favor of the inline-vs-rollup gate at default verbosity. The
    // `*Truncated` siblings and the `metaArrayTruncated` signal that
    // used to flow from these fields no longer fire — the rollup form
    // (`parseErrorTopReasons` / `partialParseTopReasons`) is the new
    // bounded-default mechanism, and `verboseMeta: true` ships the
    // full uncapped path list. `fragmentFiles` keeps the cap regime
    // (see fragmentFiles cap test below).

    it("emits parseErrorTopReasons rollup (omits parseErrorFiles) when count > 20 at default verbosity", () => {
      // 25 errored HTML files, none with findings → invisible bucket.
      // count > 20 + verbose=false flips the wire shape to rollup-only:
      // the inline path list is omitted; the top distinct reasons (one
      // here, since every file shares the same parser message) ship
      // with the full count.
      const paths = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(3, "0")}.html`);
      const files = paths.map(htmlFileWithErrorsAt);
      const result = buildAnalysisCoverage(
        files,
        [],
        [],
        false, // verbose: false
        0,
        undefined,
        undefined,
        new Set<string>(),
      );
      const coverage = result.analysisCoverage;
      expect(coverage?.["parseErrorFileCount"]).toBe(25);
      expect(coverage?.["parseErrorFiles"]).toBeUndefined();
      expect(coverage?.["parseErrorFilesTruncated"]).toBeUndefined();
      expect(coverage?.["parseErrorTopReasons"]).toEqual([
        { reason: "Unexpected end of input while parsing tag", count: 25 },
      ]);
      // No more cap-truncation signal from these fields.
      expect(result.metaArrayTruncated).toBeUndefined();
    });

    it("re-includes the full (uncapped) parseErrorFiles list under verboseMeta=true", () => {
      // Same 25-file corpus, verbose=true — full path list ships
      // uncapped (no head-slice, no rollup), since the agent has
      // explicitly opted into the wire-size cost.
      const paths = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(3, "0")}.html`);
      const files = paths.map(htmlFileWithErrorsAt);
      const result = buildAnalysisCoverage(
        files,
        [],
        [],
        true, // verbose: true
        0,
        undefined,
        undefined,
        new Set<string>(),
      );
      const coverage = result.analysisCoverage;
      expect(coverage?.["parseErrorFileCount"]).toBe(25);
      const list = coverage?.["parseErrorFiles"] as readonly { path: string }[] | undefined;
      expect(list?.length).toBe(25);
      expect(list?.[0]?.path).toBe("f000.html");
      expect(list?.[24]?.path).toBe("f024.html");
      // Rollup is NOT emitted alongside the full list — the per-entry
      // `reason` strings already carry every signal the rollup
      // aggregates (CLAUDE.md §1 "Verbose meta is signal, not clutter":
      // shipping both would be redundant, not additive).
      expect(coverage?.["parseErrorTopReasons"]).toBeUndefined();
    });

    it("ships the full inline parseErrorFiles array (no rollup) at the threshold (count = 20, verbose=false)", () => {
      // count == PARSE_ERROR_INLINE_THRESHOLD (20): inline list still
      // wins — rollup only fires above the threshold.
      const paths = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}.html`);
      const files = paths.map(htmlFileWithErrorsAt);
      const result = buildAnalysisCoverage(
        files,
        [],
        [],
        false,
        0,
        undefined,
        undefined,
        new Set<string>(),
      );
      const coverage = result.analysisCoverage;
      expect(coverage?.["parseErrorFileCount"]).toBe(20);
      expect((coverage?.["parseErrorFiles"] as readonly unknown[]).length).toBe(20);
      expect(coverage?.["parseErrorTopReasons"]).toBeUndefined();
    });

    it("emits partialParseTopReasons rollup independently when partial bucket count > 20", () => {
      // 30 errored HTML files, every one producing a finding → all
      // route to partial bucket. Same threshold gate, separate rollup
      // field name so the two lanes don't collide on the wire.
      const paths = Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(3, "0")}.html`);
      const files = paths.map(htmlFileWithErrorsAt);
      const result = buildAnalysisCoverage(
        files,
        [],
        [],
        false,
        0,
        undefined,
        undefined,
        new Set(paths),
      );
      const coverage = result.analysisCoverage;
      expect(coverage?.["partialParseFileCount"]).toBe(30);
      expect(coverage?.["partialParseFiles"]).toBeUndefined();
      expect(coverage?.["partialParseTopReasons"]).toEqual([
        { reason: "Unexpected end of input while parsing tag", count: 30 },
      ]);
    });

    it("ranks parseErrorTopReasons by frequency (desc), tied alphabetical, capped at top-5", () => {
      // Build a heterogeneous corpus that exercises the rollup sort:
      // - 10 files with reason A (most common)
      // - 7 with reason B
      // - 7 with reason C (tied with B → alphabetical break: B before C)
      // - 5 with reason D
      // - 3 with reason E
      // - 1 with reason F (drops out of top-5)
      const reasons = [
        ...Array(10).fill("aaaa unexpected"),
        ...Array(7).fill("bbbb unexpected"),
        ...Array(7).fill("cccc unexpected"),
        ...Array(5).fill("dddd unexpected"),
        ...Array(3).fill("eeee unexpected"),
        "ffff unexpected",
      ];
      const files: ParsedFile[] = reasons.map((message, i) => ({
        filePath: `f${String(i).padStart(3, "0")}.html`,
        source: "<div",
        ast: {
          language: "html",
          root: {
            kind: "HtmlDocument",
            range: { start: 0, end: 0 },
            loc: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: 1, offset: 0 },
            },
            children: [],
          },
          errors: [{ message, position: { line: 1, column: 1, offset: 0 }, recoverable: true }],
        },
      }));
      const result = buildAnalysisCoverage(
        files,
        [],
        [],
        false,
        0,
        undefined,
        undefined,
        new Set<string>(),
      );
      const coverage = result.analysisCoverage;
      expect(coverage?.["parseErrorFileCount"]).toBe(33);
      expect(coverage?.["parseErrorTopReasons"]).toEqual([
        { reason: "aaaa unexpected", count: 10 },
        { reason: "bbbb unexpected", count: 7 },
        { reason: "cccc unexpected", count: 7 },
        { reason: "dddd unexpected", count: 5 },
        { reason: "eeee unexpected", count: 3 },
      ]);
      // ffff (1 occurrence) drops out of the top-5; agents reconstruct
      // the residue as parseErrorFileCount - sum(topReasons[].count) = 1.
    });

    it("inlines the full path list when count is small (3 entries, verbose=false)", () => {
      // count ≤ 20 + verbose=false: inline list still ships, rollup
      // is NOT emitted (per-entry detail subsumes it).
      const files = ["a.html", "b.html", "c.html"].map(htmlFileWithErrorsAt);
      const result = buildAnalysisCoverage(
        files,
        [],
        [],
        false,
        0,
        undefined,
        undefined,
        new Set<string>(),
      );
      const coverage = result.analysisCoverage;
      expect((coverage?.["parseErrorFiles"] as readonly unknown[]).length).toBe(3);
      expect(coverage?.["parseErrorTopReasons"]).toBeUndefined();
      expect(coverage?.["parseErrorFilesTruncated"]).toBeUndefined();
      expect(result.metaArrayTruncated).toBeUndefined();
    });

    it("caps fragmentFiles and signals metaArrayTruncated", () => {
      const many = Array.from({ length: 75 }, (_, i) => {
        const parsed = parseHtml("<div>x</div>"); // fragment → no <html>, no <body>
        return {
          filePath: `_includes/frag${String(i).padStart(3, "0")}.html`,
          source: "<div>x</div>",
          ast: { language: "html" as const, root: parsed.root, errors: parsed.errors },
        };
      });
      const result = buildAnalysisCoverage(many, [], [], false);
      const coverage = result.analysisCoverage;
      expect(coverage?.["fragmentFileCount"]).toBe(75);
      expect((coverage?.["fragmentFiles"] as readonly string[]).length).toBe(50);
      expect(coverage?.["fragmentFilesTruncated"]).toEqual({ shown: 50, total: 75 });
      expect(result.metaArrayTruncated).toBe(true);
    });

    it("emits parseErrorsByParser map keyed by in-house parser name", () => {
      // Mix of HTML errored files (every one routed to total-failure
      // bucket because findingFilePaths is empty) so the per-parser
      // count map carries `{ html: N }` — agent reading the warning
      // payload sees parser-attribution dominance without descending
      // into per-entry `parseErrorFiles[].parser`.
      const paths = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(3, "0")}.html`);
      const files = paths.map(htmlFileWithErrorsAt);
      const result = buildAnalysisCoverage(
        files,
        [],
        [],
        false,
        0,
        undefined,
        undefined,
        new Set<string>(),
      );
      const coverage = result.analysisCoverage;
      expect(coverage?.["parseErrorFileCount"]).toBe(25);
      expect(coverage?.["parseErrorsByParser"]).toEqual({ html: 25 });
    });
  });
});

describe("buildAnalysisCoverage — hints response-shape invariant", () => {
  it("every emitted hint carries a string `code` and a string `text`", () => {
    // Exercises every hint-emission path through buildAnalysisCoverage
    // in one scan: opaque components (>=8), thin CSS coverage with
    // Tailwind signal, and at least one markdown file.
    const opaque = Array.from({ length: 10 }, (_, i) => `Comp${i}`);
    const files: readonly ParsedFile[] = [
      ...Array.from({ length: 40 }, (_, i) =>
        tsxFileWithClassName(`c${i}.tsx`, "flex items-center bg-red-500 text-white"),
      ),
      tsxFile("opaque.tsx", opaque, { interactive: true }),
      htmlFile("page.md", "# hi\n\n<p>hello</p>"),
    ];
    const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
    const hints = analysisCoverage?.["hints"] as
      | readonly { code: unknown; text: unknown }[]
      | undefined;
    expect(hints).toBeDefined();
    expect(hints?.length).toBeGreaterThanOrEqual(3);
    for (const hint of hints ?? []) {
      expect(typeof hint.code).toBe("string");
      expect((hint.code as string).length).toBeGreaterThan(0);
      expect(typeof hint.text).toBe("string");
      expect((hint.text as string).length).toBeGreaterThan(0);
    }
  });

  it("every emitted code is a member of the HINT_CODES closed set", async () => {
    // Reads the canonical constant and asserts no hint slips through
    // with a code outside the documented taxonomy. Guards against a
    // future emitter landing a new kebab-case or free-form string.
    const { HINT_CODES } = await import("../../../src/mcp/hint-codes.ts");
    const opaque = Array.from({ length: 10 }, (_, i) => `Comp${i}`);
    const files: readonly ParsedFile[] = [
      ...Array.from({ length: 40 }, (_, i) =>
        tsxFileWithClassName(`c${i}.tsx`, "flex items-center bg-red-500 text-white"),
      ),
      tsxFile("opaque.tsx", opaque, { interactive: true }),
      htmlFile("page.md", "# hi\n\n<p>hello</p>"),
    ];
    const { analysisCoverage } = buildAnalysisCoverage(files, [], NO_RULES, false);
    const hints = analysisCoverage?.["hints"] as
      | readonly { code: string; text: string }[]
      | undefined;
    for (const hint of hints ?? []) {
      expect(HINT_CODES.has(hint.code as never)).toBe(true);
    }
  });

  it("HINT_CODES contains every known hint kind", async () => {
    // Tripwire: renaming / retiring a code must fail a test rather
    // than silently removing the branching discriminator downstream
    // consumers rely on. Names each code string literally so a grep
    // lands here first on a rename.
    const { HINT_CODES } = await import("../../../src/mcp/hint-codes.ts");
    const expected: readonly string[] = [
      "opaque_components_present",
      "css_coverage_thin",
      "markdown_html_residue",
      "ssg_build_output_hint",
      "catalog_shape_detected",
    ];
    for (const code of expected) expect(HINT_CODES.has(code as never)).toBe(true);
    // The set is closed — count equals the expected list.
    expect(HINT_CODES.size).toBe(expected.length);
  });
});
