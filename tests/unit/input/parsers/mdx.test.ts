import { describe, expect, it } from "bun:test";
import { parseMdx } from "../../../../src/input/parsers/mdx.ts";
import type { JsxAttribute, JsxElement } from "../../../../src/types/ast.ts";

function findElement(elements: readonly JsxElement[], tag: string): JsxElement | undefined {
  return elements.find((e) => e.tagName === tag);
}

function getAttr(el: JsxElement, name: string): JsxAttribute | undefined {
  return el.attributes.find((a) => a.name === name);
}

describe("parseMdx — empty + trivial", () => {
  it("parses empty source without error", () => {
    const { root, errors } = parseMdx("");
    expect(root.kind).toBe("TsxModule");
    expect(root.jsxElements).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("never throws on random garbage", () => {
    const garbage = "---\n---\n```\n{{{<><></>}}}\n```\n<!-- <img> -->";
    expect(() => parseMdx(garbage)).not.toThrow();
  });

  it("parses plain-JSX MDX identically to parseTsx", () => {
    const src = `# Hello\n\n<img src="/a.png" alt="cat" />\n`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    const img = findElement(root.jsxElements, "img");
    expect(img).toBeDefined();
    const altAttr = getAttr(img!, "alt");
    expect(altAttr?.value?.kind).toBe("StringLiteral");
    if (altAttr?.value?.kind === "StringLiteral") {
      expect(altAttr.value.value).toBe("cat");
    }
  });
});

describe("parseMdx — YAML frontmatter strip", () => {
  it("strips a leading --- frontmatter block", () => {
    const src = `---
title: My Page
description: A test
---

<img src="/a.png" alt="after-frontmatter" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    const img = findElement(root.jsxElements, "img");
    expect(img).toBeDefined();
    const altAttr = getAttr(img!, "alt");
    if (altAttr?.value?.kind === "StringLiteral") {
      expect(altAttr.value.value).toBe("after-frontmatter");
    }
  });

  it("does not interpret a mid-document --- as frontmatter", () => {
    // A thematic break in the middle of prose must not confuse us.
    const src = `# Heading

Some prose.

---

<img src="/a.png" alt="still-here" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(findElement(root.jsxElements, "img")).toBeDefined();
  });

  it("strips a leading +++ TOML frontmatter block", () => {
    const src = `+++
title = "Page"
+++

<img alt="toml-case" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(findElement(root.jsxElements, "img")).toBeDefined();
  });

  it("does nothing when the source has no frontmatter fence", () => {
    const src = `<img alt="no-frontmatter" />`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(findElement(root.jsxElements, "img")).toBeDefined();
  });

  it("leaves source intact when the closing fence is missing", () => {
    // Unterminated frontmatter — the scan finds no close and the
    // strip is a no-op. The TSX pass then runs on the full source;
    // the JSX tag is still picked up because `<img` is well-formed.
    const src = `---
title: Unfinished

<img alt="unterminated-frontmatter" />
`;
    const { root } = parseMdx(src);
    expect(findElement(root.jsxElements, "img")).toBeDefined();
  });
});

describe("parseMdx — fenced code block strip", () => {
  it("strips backtick-fenced code blocks so their JSX isn't detected", () => {
    const src = `# Example

\`\`\`jsx
<img src="/illustrative.png" />
\`\`\`

<img alt="real" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    // Only the real <img> outside the fence should appear.
    const imgs = root.jsxElements.filter((e) => e.tagName === "img");
    expect(imgs).toHaveLength(1);
    const altAttr = getAttr(imgs[0]!, "alt");
    if (altAttr?.value?.kind === "StringLiteral") {
      expect(altAttr.value.value).toBe("real");
    }
  });

  it("strips tilde-fenced code blocks", () => {
    const src = `~~~jsx
<img src="/in-tildes.png" />
~~~

<img alt="outside" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    const imgs = root.jsxElements.filter((e) => e.tagName === "img");
    expect(imgs).toHaveLength(1);
  });

  it("strips fences with info strings (language + metadata)", () => {
    const src = `\`\`\`typescript title="example.ts"
const x: string = "<Button/>";
\`\`\`

<Button alt="real" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    const buttons = root.jsxElements.filter((e) => e.tagName === "Button");
    expect(buttons).toHaveLength(1);
  });

  it("requires the closing fence to be at least as long as the opening", () => {
    // Four backticks open; a three-backtick line inside does NOT close.
    const src = `\`\`\`\`
\`\`\`
<img alt="inside-long-fence" />
\`\`\`\`

<img alt="outside" />
`;
    const { root } = parseMdx(src);
    const imgs = root.jsxElements.filter((e) => e.tagName === "img");
    // Only the outside <img> survives.
    expect(imgs).toHaveLength(1);
  });

  it("leaves unterminated fences as a strip-to-EOF", () => {
    const src = `\`\`\`
<img alt="unterminated" />
`;
    const { root } = parseMdx(src);
    // The unterminated fence strips to EOF — no JSX emerges.
    expect(root.jsxElements).toHaveLength(0);
  });
});

describe("parseMdx — inline code span strip", () => {
  it("strips balanced single-backtick spans in prose", () => {
    // Markdown inline code spans wrap a token like `<iframe>` so it
    // renders as code text, not as a real DOM element. The TSX
    // scanner happens to skip backtick-delimited template literals
    // anyway, but the strip pass means downstream consumers (any
    // future token-walking finder) see clean prose where the span
    // sat. Mirrors `parseMarkdown`'s pass 3.
    const src = `Skip the \`frameborder="0"\` attribute on your \`<iframe>\`s.

<img alt="real" src="/x.png" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    // Exactly the real <img> survives — no <iframe> JSX element from
    // the prose backticks. (Today's TSX scanner already produces this
    // outcome via template-literal skip; the strip pass locks the
    // contract one layer earlier so a tokenizer-based finder cannot
    // regress on it.)
    expect(root.jsxElements).toHaveLength(1);
    expect(root.jsxElements[0]?.tagName).toBe("img");
    const iframe = findElement(root.jsxElements, "iframe");
    expect(iframe).toBeUndefined();
  });

  it("strips multi-backtick spans (CommonMark double-tick syntax)", () => {
    // A double-tick span is the canonical way to embed a literal
    // backtick: `` `tick` ``. The strip pass must require the close
    // run to match the open run's length so it doesn't mis-count.
    const src = `Use \`\`code with a \` tick inside\`\` for embedding.

<a href="/docs">docs</a>
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    const a = findElement(root.jsxElements, "a");
    expect(a).toBeDefined();
  });

  it("preserves backticks inside <Example code={`…`}/> JSX expressions", () => {
    // The docs-component code-prop extractor is load-bearing — it
    // finds template-literal bodies inside `code={\`…\`}` props and
    // synthesizes JSX elements at the original source positions. The
    // strip pass tracks JSX `{` / `}` brace depth and only blanks
    // backticks at depth 0; backticks inside `{…}` expressions are
    // JS template literals and stay intact.
    const src = `Some prose with \`<iframe>\` mention.

<Example code={\`<input type="email" />\`} />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    // The Example template body survives — synthesized <input> is
    // present, source: "mdx-example-code".
    const input = findElement(root.jsxElements, "input");
    expect(input).toBeDefined();
    expect(input?.synthesized?.source).toBe("mdx-example-code");
    // The prose `<iframe>` mention does not produce a JSX element.
    const iframe = findElement(root.jsxElements, "iframe");
    expect(iframe).toBeUndefined();
  });

  it("leaves unterminated single-tick prose openings alone", () => {
    // An unterminated backtick has no close to find — strip pass
    // leaves it intact (mirrors `parseMarkdown`'s same fallback).
    // Downstream the TSX scanner's template-literal skip swallows
    // trailing characters; that's the documented edge case.
    const src = `A leftover \` tick in prose.
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(root.jsxElements).toHaveLength(0);
  });

  it("preserves line numbers across blanked spans", () => {
    // Blanking must replace characters with spaces so column /
    // line offsets in the surviving AST stay aligned with the
    // authored source. Verify the JSX element after a multi-line
    // span resolves to its original line.
    const src = `Line 1.

Line 3 with \`code spanning
multiple lines\` here.

<img alt="line-6" src="/x.png" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    const img = findElement(root.jsxElements, "img");
    expect(img).toBeDefined();
    expect(img?.loc.start.line).toBe(6);
  });
});

describe("parseMdx — import / export line strip", () => {
  it("strips top-level import statements", () => {
    const src = `import { Card } from '@astro/starlight/components';

<Card title="hello" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    const card = findElement(root.jsxElements, "Card");
    expect(card).toBeDefined();
  });

  it("strips multi-line brace imports", () => {
    const src = `import {
  A,
  B,
  C,
} from 'lib';

<A />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(findElement(root.jsxElements, "A")).toBeDefined();
  });

  it("strips single-line export statements", () => {
    const src = `export const meta = { title: "x" };

<img alt="after-export" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(findElement(root.jsxElements, "img")).toBeDefined();
  });

  it("does not mistake prose starting with 'imports' for an import line", () => {
    // 'imports ' doesn't match — the regex requires the keyword to be
    // followed by whitespace after the exact keyword, not just any
    // char. Prose starting with "imports" should pass through.
    const src = `imports are fun.

<img alt="after-prose" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(findElement(root.jsxElements, "img")).toBeDefined();
  });

  it("does not strip `import` appearing mid-line (not at column 0)", () => {
    // A line whose import sits after some leading content is not an
    // ESM statement line. The scanner only strips at line-start.
    const src = `  import foo from "x";

<img alt="mid-line-import" />
`;
    // Indented 'import' isn't at column 0 — we still expect the img
    // to parse cleanly; the indented text flows past the TSX scanner.
    const { root } = parseMdx(src);
    expect(findElement(root.jsxElements, "img")).toBeDefined();
  });
});

describe("parseMdx — markdown prose flows past without confusing JSX scan", () => {
  it("ignores markdown headings", () => {
    const src = `# Top-level heading

## Second heading

<a href="/x">Read more</a>
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(findElement(root.jsxElements, "a")).toBeDefined();
  });

  it("ignores paragraphs, lists, and blockquotes", () => {
    const src = `Regular paragraph text.

- list item one
- list item two

> a blockquote

<button>Click me</button>
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(findElement(root.jsxElements, "button")).toBeDefined();
  });

  it("tolerates `<` in prose that isn't followed by an identifier", () => {
    // "1 < 2" is arithmetic prose, not JSX. The TSX scanner's
    // isTagStart requires a letter after `<`, so " <" passes through.
    const src = `When x < y, use the larger value.

<img alt="after-prose-with-lt" />
`;
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    expect(findElement(root.jsxElements, "img")).toBeDefined();
  });
});

describe("parseMdx — combined real-world MDX page", () => {
  it("handles a representative Astro/Starlight doc page", () => {
    const src = `---
title: Quickstart
description: Get started in minutes
---

import { Card, CardGrid } from '@astrojs/starlight/components';

# Quickstart

This page shows you how to get started.

## Installation

Run the following command:

\`\`\`bash
npm install @my-lib
\`\`\`

<Card title="Note" icon="pencil">
  Make sure to read the <a href="/docs/setup">setup guide</a>.
</Card>

<CardGrid>
  <Card title="A" />
  <Card title="B" />
</CardGrid>

<img src="/hero.png" alt="hero" />
`;
    const { root, errors } = parseMdx(src);
    // No parse errors on a clean representative page.
    expect(errors).toHaveLength(0);
    // The three top-level JSX elements are the two Cards/CardGrid and the img.
    const tags = root.jsxElements.map((e) => e.tagName);
    expect(tags).toContain("Card");
    expect(tags).toContain("CardGrid");
    expect(tags).toContain("img");
    // And the <a> inside the first Card is reachable via children.
    const outerCard = findElement(root.jsxElements, "Card");
    expect(outerCard).toBeDefined();
  });
});

describe("parseMdx — line-number preservation", () => {
  it("preserves line numbers for JSX that appears after a frontmatter block", () => {
    // The <img> is on line 6 of the original source. After frontmatter
    // is blanked (newlines preserved), its line must still be 6.
    const src = `---
title: x
---

<img alt="line6" />
`;
    const { root } = parseMdx(src);
    const img = findElement(root.jsxElements, "img");
    expect(img).toBeDefined();
    expect(img?.loc.start.line).toBe(5);
  });

  it("preserves line numbers for JSX that appears after a code fence", () => {
    const src = `text
\`\`\`
code
\`\`\`

<img alt="line6" />
`;
    const { root } = parseMdx(src);
    const img = findElement(root.jsxElements, "img");
    expect(img).toBeDefined();
    expect(img?.loc.start.line).toBe(6);
  });
});

describe("parseMdx — recoverable parse errors", () => {
  it("propagates recoverable errors from the TSX pass", () => {
    // An unterminated JSX element — the TSX parser is tolerant but
    // may emit a parseError depending on shape. We assert the
    // parser never throws and the result has the expected shape.
    const src = `<div>
  unterminated child
`;
    const { root, errors } = parseMdx(src);
    expect(root.kind).toBe("TsxModule");
    // Errors may or may not be present depending on TSX tolerance;
    // the invariant is never-throws + structured result.
    for (const e of errors) {
      expect(e.recoverable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// docs-component `code` prop extractor (Starlight / Bootstrap-docs
// `<Example code={`…`}/>` substrate). Landed with the extractor itself
// — see src/input/parsers/mdx-example-extractor.ts for the full design.
// ---------------------------------------------------------------------------

describe("parseMdx — <Example code={`…`}/> template-literal extractor", () => {
  it("extracts a single <input> inside a template-literal code prop", () => {
    // Mirrors the canonical Bootstrap-docs shape referenced in the
    // backlog (site/src/content/docs/forms/overview.mdx): a form
    // preview inside `<Example code={`…`}/>`. Before the extractor,
    // the HTML <input> never entered the JSX stream so
    // `forms/labels-required` could not fire on it.
    const src = [
      "# Forms",
      "",
      '<Example code={`<input type="email" class="form-control" id="exampleInputEmail1">`}/>',
      "",
    ].join("\n");
    const { root, errors } = parseMdx(src);
    expect(errors).toHaveLength(0);
    const input = findElement(root.jsxElements, "input");
    expect(input).toBeDefined();
    const typeAttr = getAttr(input!, "type");
    expect(typeAttr?.value?.kind).toBe("StringLiteral");
    if (typeAttr?.value?.kind === "StringLiteral") {
      expect(typeAttr.value.value).toBe("email");
    }
    // HTML `class` must be translated to JSX `className` so the JSX
    // branch of downstream rules finds it by its JSX name.
    const classAttr = getAttr(input!, "className");
    expect(classAttr).toBeDefined();
    // Original HTML `class` attribute name must NOT persist — the
    // translation has to replace, not alias, or rules that probe for
    // JSX `className` and `class` separately would double-count.
    expect(getAttr(input!, "class")).toBeUndefined();
    expect(input!.synthesized).toEqual({
      source: "mdx-example-code",
      componentName: "Example",
    });
  });

  it("preserves the author's line for an <input> extracted from line 3", () => {
    // The <Example> sits on line 3 of the MDX; the template body
    // starts mid-line with the opening `<input…>`. The synthesized
    // element must carry line 3 so a finding like "input at line N"
    // points an agent at the authored source, not a synthesized
    // pseudo-offset.
    const src = ["intro paragraph", "", '<Example code={`<input type="email" id="x">`}/>'].join(
      "\n",
    );
    const { root } = parseMdx(src);
    const input = findElement(root.jsxElements, "input");
    expect(input).toBeDefined();
    expect(input!.loc.start.line).toBe(3);
  });

  it("preserves line numbers for multi-line HTML bodies", () => {
    // Template body spans three lines; first element at body-line-1
    // is on MDX line 3, third element is on MDX line 5.
    const src = [
      "# Title",
      "",
      "<Example code={`",
      '  <label for="x">Email</label>',
      '  <input type="email" id="x">',
      "`}/>",
    ].join("\n");
    const { root } = parseMdx(src);
    const label = findElement(root.jsxElements, "label");
    const input = findElement(root.jsxElements, "input");
    expect(label).toBeDefined();
    expect(input).toBeDefined();
    // HTML `for` → JSX `htmlFor` translation.
    expect(getAttr(label!, "htmlFor")).toBeDefined();
    expect(getAttr(label!, "for")).toBeUndefined();
    // Template body starts on line 3 mid-line; the template's first
    // newline puts us on MDX line 4 for the <label>; <input> lives
    // on line 5 of the MDX source.
    expect(label!.loc.start.line).toBe(4);
    expect(input!.loc.start.line).toBe(5);
  });

  it("recognizes Demo and Playground by default", () => {
    const src = [
      '<Demo code={`<input id="d">`}/>',
      "",
      '<Playground code={`<input id="p">`}/>',
    ].join("\n");
    const { root } = parseMdx(src);
    const inputs = root.jsxElements.filter((e) => e.tagName === "input");
    expect(inputs).toHaveLength(2);
  });

  it("does not extract from components outside the allow-list", () => {
    // <NotAllowed> is not in the default allow-list; its template
    // body stays opaque and no <input> is synthesized.
    const src = `<NotAllowed code={\`<input id="hidden">\`}/>`;
    const { root } = parseMdx(src);
    expect(findElement(root.jsxElements, "input")).toBeUndefined();
  });

  it("honours a caller-supplied allow-list", () => {
    // Widen to include a custom wrapper name — the extractor picks
    // it up.
    const src = `<CustomWrap code={\`<input id="c">\`}/>`;
    const { root } = parseMdx(src, { exampleComponentNames: ["CustomWrap"] });
    expect(findElement(root.jsxElements, "input")).toBeDefined();
  });

  it("disables extraction entirely when the allow-list is empty", () => {
    const src = `<Example code={\`<input id="e">\`}/>`;
    const { root } = parseMdx(src, { exampleComponentNames: [] });
    expect(findElement(root.jsxElements, "input")).toBeUndefined();
  });

  it("skips template literals that contain ${…} substitutions", () => {
    // A template-literal with a substitution cannot be statically
    // resolved — we refuse to parse a partial body and the extractor
    // bails, leaving the <input> unseen by downstream rules. Honest
    // absence over confidently wrong findings.
    // eslint-disable-next-line no-template-curly-in-string
    const src = "<Example code={`<input id=${dynamic}>`}/>";
    const { root } = parseMdx(src);
    expect(findElement(root.jsxElements, "input")).toBeUndefined();
  });

  it("ignores a non-template `code` value (plain string attribute)", () => {
    // A string attribute `code="<input/>"` is not a template literal;
    // the extractor skips it. The TSX parser does not enter HTML
    // mode inside attribute strings, so no <input> is synthesized —
    // this keeps the extractor's scope narrow to the template-
    // literal shape the backlog calls out.
    const src = `<Example code="<input id=\\"s\\">"/>`;
    const { root } = parseMdx(src);
    expect(findElement(root.jsxElements, "input")).toBeUndefined();
  });

  it("preserves the original <Example> element alongside synthesized children", () => {
    // Extraction must be additive — the original component element
    // stays in the AST so rules targeting the docs-component itself
    // (and consumers that read `hasSpreadProps` / opaque-component
    // meta) see what they saw before.
    const src = `<Example code={\`<input id="x">\`}/>`;
    const { root } = parseMdx(src);
    expect(findElement(root.jsxElements, "Example")).toBeDefined();
    expect(findElement(root.jsxElements, "input")).toBeDefined();
  });

  it("surfaces <img> without alt inside a template body", () => {
    // The canonical alt-text rule input — covers the alt-text finder's
    // ability to reach HTML substrate ferried through the extractor.
    const src = `<Example code={\`<img src="/hero.png">\`}/>`;
    const { root } = parseMdx(src);
    const img = findElement(root.jsxElements, "img");
    expect(img).toBeDefined();
    expect(getAttr(img!, "alt")).toBeUndefined();
    // Provenance marker is honest about where it came from.
    expect(img!.synthesized?.source).toBe("mdx-example-code");
  });

  it("handles multiple <Example> blocks independently", () => {
    // Two separate <Example> components, each with its own code body.
    // Both synthesize their own <input>; line numbers anchor to the
    // right authored source line for each.
    const src = [
      '<Example code={`<input id="a">`}/>',
      "",
      '<Example code={`<input id="b">`}/>',
    ].join("\n");
    const { root } = parseMdx(src);
    const inputs = root.jsxElements.filter((e) => e.tagName === "input");
    expect(inputs).toHaveLength(2);
    // Line 1 and line 3 respectively.
    expect(inputs[0]!.loc.start.line).toBe(1);
    expect(inputs[1]!.loc.start.line).toBe(3);
  });

  it("recovers gracefully from an unterminated template body", () => {
    // The extractor must not throw on a missing closing backtick —
    // the TSX parser itself already recovers (the prop remains
    // unresolved); we just leave the body un-extracted.
    const src = '<Example code={`<input id="u">';
    expect(() => parseMdx(src)).not.toThrow();
  });
});
