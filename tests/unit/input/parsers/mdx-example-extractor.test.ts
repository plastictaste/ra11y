/**
 * Unit tests for the MDX docs-component code-demo prop extractor /
 * detector — the load-bearing seam that powers
 *
 *   1. The corpus-level `jsx_code_demo_prop_parsed_as_live_dom`
 *      warning's per-file payload (file path, prop names, match count).
 *   2. The per-finding `couldBeWrongBecause:
 *      ["template_literal_in_code_demo_prop"]` propagation onto every
 *      violation whose `(filePath, line)` falls inside a recorded
 *      match's body line range.
 *
 * Both surfaces share one evidence source — the MDX adapter descended
 * into a docs-component (`<Example>` / `<Demo>` / `<Playground>`) prop
 * (`code` / `example` / `source` / `template`) carrying a substitution-
 * free template-literal HTML body. Symmetric to
 * `js_innerhtml_template_literal_unparsed` but inverted: that code
 * names parser DROPS (routing-skip failure mode); this code names
 * parser DESCENDS (rhetorical-preview HTML the docs site renders).
 *
 * Surface, don't suppress (per `docs/kb/architecture/ai-first-consumer.md`):
 * the rule still emits at its full severity (the markup IS structurally
 * what the rule's predicate names); the warning + per-finding
 * propagation are additive triage signals.
 */

import { describe, expect, it } from "bun:test";
import { parseMdx } from "../../../../src/input/parsers/mdx.ts";
import {
  CODE_DEMO_PROP_NAMES,
  CODE_DEMO_PROP_REASON_CODE,
  detectCodeDemoPropMatches,
  extractMdxExampleCode,
} from "../../../../src/input/parsers/mdx-example-extractor.ts";

describe("CODE_DEMO_PROP_NAMES", () => {
  it("lists the four canonical docs-framework prop names (lowercase)", () => {
    expect([...CODE_DEMO_PROP_NAMES].sort()).toEqual(["code", "example", "source", "template"]);
  });

  it("CODE_DEMO_PROP_REASON_CODE is the snake_case identifier the agent matches", () => {
    expect(CODE_DEMO_PROP_REASON_CODE).toBe("template_literal_in_code_demo_prop");
  });
});

describe("extractMdxExampleCode — propMatches evidence", () => {
  it("records a propMatch for an Example component with a `code` prop", () => {
    const source = `<Example code={\`<form>
  <input type="email" />
</form>\`} />`;
    const tsx = parseMdx(source);
    const result = extractMdxExampleCode(source, tsx.root, ["Example", "Demo", "Playground"]);
    expect(result.propMatches.length).toBe(1);
    const match = result.propMatches[0];
    expect(match?.propName).toBe("code");
    expect(match?.tagName).toBe("Example");
    // Body content spans 3 source lines.
    expect(match?.bodyStartLine).toBe(1);
    expect(match?.bodyEndLine).toBe(3);
  });

  it("records propMatches for each of the four canonical prop names (case-insensitive)", () => {
    const cases: readonly { readonly propName: string; readonly source: string }[] = [
      {
        propName: "code",
        source: `<Example code={\`<form><input/></form>\`} />`,
      },
      {
        propName: "example",
        source: `<Demo example={\`<button>Click</button>\`} />`,
      },
      {
        propName: "source",
        source: `<Playground source={\`<a href="#">Link</a>\`} />`,
      },
      {
        propName: "template",
        source: `<Example template={\`<img alt="x"/>\`} />`,
      },
      {
        // Case-insensitive: `Code` in source normalizes to lowercase
        propName: "code",
        source: `<Example Code={\`<form/>\`} />`,
      },
    ];
    for (const { propName, source } of cases) {
      const tsx = parseMdx(source);
      const result = extractMdxExampleCode(source, tsx.root, ["Example", "Demo", "Playground"]);
      expect(result.propMatches.length).toBeGreaterThan(0);
      expect(result.propMatches[0]?.propName).toBe(propName);
    }
  });

  it("does NOT record a propMatch for a non-allow-list component", () => {
    // `<Snippet>` is not in the default allow-list.
    const source = `<Snippet code={\`<form/>\`} />`;
    const tsx = parseMdx(source);
    const result = extractMdxExampleCode(source, tsx.root, ["Example", "Demo", "Playground"]);
    expect(result.propMatches.length).toBe(0);
  });

  it("does NOT record a propMatch when the template literal contains substitutions", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` token under test
    const source = "<Example code={`<form>${dynamic}</form>`} />";
    const tsx = parseMdx(source);
    const result = extractMdxExampleCode(source, tsx.root, ["Example", "Demo", "Playground"]);
    expect(result.propMatches.length).toBe(0);
  });

  it("does NOT record a propMatch for non-code-demo prop names", () => {
    // `data` and `props` are not in CODE_DEMO_PROP_NAMES.
    const source = `<Example data={\`<form/>\`} props={\`<button/>\`} />`;
    const tsx = parseMdx(source);
    const result = extractMdxExampleCode(source, tsx.root, ["Example", "Demo", "Playground"]);
    expect(result.propMatches.length).toBe(0);
  });

  it("records multiple propMatches for multiple Example components in one MDX file", () => {
    const source = `# Docs

<Example code={\`<form>
  <input/>
</form>\`} />

Some prose.

<Demo template={\`<button>Submit</button>\`} />
`;
    const tsx = parseMdx(source);
    const result = extractMdxExampleCode(source, tsx.root, ["Example", "Demo", "Playground"]);
    expect(result.propMatches.length).toBe(2);
    const propNames = result.propMatches.map((m) => m.propName).sort();
    expect(propNames).toEqual(["code", "template"]);
  });
});

describe("detectCodeDemoPropMatches — post-parse detector", () => {
  it("returns the same propMatch evidence the extractor records, without synthesizing JSX", () => {
    const source = `<Example code={\`<form><input/></form>\`} />`;
    const tsx = parseMdx(source);
    const matches = detectCodeDemoPropMatches(source, tsx.root);
    expect(matches.length).toBe(1);
    expect(matches[0]?.propName).toBe("code");
    expect(matches[0]?.tagName).toBe("Example");
    expect(matches[0]?.bodyStartLine).toBe(1);
    expect(matches[0]?.bodyEndLine).toBe(1);
  });

  it("returns an empty array when no docs-component carries a code-demo prop", () => {
    const source = `<div className="container">
  <p>Authored prose, no docs components.</p>
</div>`;
    const tsx = parseMdx(source);
    const matches = detectCodeDemoPropMatches(source, tsx.root);
    expect(matches).toEqual([]);
  });

  it("respects a custom allow-list (omitting Example excludes it)", () => {
    const source = `<Example code={\`<form/>\`} />
<Demo code={\`<button/>\`} />`;
    const tsx = parseMdx(source);
    // Only allow-list `Demo`; the `<Example>` descent should not record.
    const matches = detectCodeDemoPropMatches(source, tsx.root, ["Demo"]);
    expect(matches.length).toBe(1);
    expect(matches[0]?.tagName).toBe("Demo");
  });

  it("returns an empty array for an empty allow-list", () => {
    const source = `<Example code={\`<form/>\`} />`;
    const tsx = parseMdx(source);
    expect(detectCodeDemoPropMatches(source, tsx.root, [])).toEqual([]);
  });
});

describe("parseMdx — codeDemoPropMatches side-channel", () => {
  it("surfaces propMatches on the result when the MDX adapter descended", () => {
    const source = `<Example code={\`<form><input/></form>\`} />`;
    const result = parseMdx(source);
    expect(result.codeDemoPropMatches).toBeDefined();
    expect(result.codeDemoPropMatches?.length).toBe(1);
    expect(result.codeDemoPropMatches?.[0]?.propName).toBe("code");
  });

  it("omits codeDemoPropMatches entirely when no descent happened (present-when-meaningful)", () => {
    const source = `<div>plain MDX, no docs components</div>`;
    const result = parseMdx(source);
    expect(result.codeDemoPropMatches).toBeUndefined();
  });
});
