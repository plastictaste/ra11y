import { describe, expect, it } from "bun:test";
import { parseMarkdown } from "../../../../src/input/parsers/markdown.ts";
import type { HtmlElement, HtmlNode } from "../../../../src/types/ast.ts";

/**
 * Walk the HTML tree collecting every element matching `tagName`.
 */
function findAllElements(nodes: readonly HtmlNode[], tagName: string): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  walk(nodes, (node) => {
    if (node.kind === "HtmlElement" && node.tagName === tagName) out.push(node);
  });
  return out;
}

function findFirstElement(nodes: readonly HtmlNode[], tagName: string): HtmlElement | undefined {
  let found: HtmlElement | undefined;
  walk(nodes, (node) => {
    if (found) return;
    if (node.kind === "HtmlElement" && node.tagName === tagName) found = node;
  });
  return found;
}

function walk(nodes: readonly HtmlNode[], visit: (n: HtmlNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === "HtmlElement") walk(node.children, visit);
  }
}

function getAttr(el: HtmlElement, name: string): string | null | undefined {
  const attr = el.attributes.find((a) => a.name === name);
  if (!attr) return undefined;
  return attr.value;
}

describe("parseMarkdown — empty + trivial", () => {
  it("parses empty source without error", () => {
    const { root, errors } = parseMarkdown("");
    expect(root.kind).toBe("HtmlDocument");
    expect(root.children).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("never throws on random garbage", () => {
    const garbage = "---\n---\n```\n{{{<><></>}}}\n```\n<!-- <img> -->\n![broken(";
    expect(() => parseMarkdown(garbage)).not.toThrow();
  });

  it("parses plain-prose markdown without reaching any element", () => {
    const src = "# Heading\n\nA paragraph with some text, no embedded HTML.\n";
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    // Residue-only: no synthesized <h1>. Prose text may remain as
    // HtmlText but no elements.
    expect(findFirstElement(root.children, "h1")).toBeUndefined();
  });
});

describe("parseMarkdown — YAML frontmatter strip", () => {
  it("strips a leading --- frontmatter block so embedded HTML still parses", () => {
    const src = `---
title: My Page
layout: post
---

<img src="/a.png" alt="after-frontmatter">
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(getAttr(img!, "alt")).toBe("after-frontmatter");
  });

  it("does not interpret a mid-document --- as frontmatter", () => {
    const src = `# Heading

Some prose.

---

<img src="/a.png" alt="still-here">
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });

  it("strips a leading +++ TOML frontmatter block", () => {
    const src = `+++
title = "Page"
+++

<iframe src="video" title="tutorial"></iframe>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const iframe = findFirstElement(root.children, "iframe");
    expect(iframe).toBeDefined();
    expect(getAttr(iframe!, "title")).toBe("tutorial");
  });

  it("handles frontmatter-only files without error", () => {
    const src = "---\ntitle: Empty\n---\n";
    const { errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
  });
});

describe("parseMarkdown — fenced code block strip", () => {
  it("strips ``` fenced code blocks so HTML-inside-code doesn't reach the parser", () => {
    const src = `Before fence.

\`\`\`html
<img src="inside-code.png" alt="should-not-appear">
\`\`\`

<img src="after-fence.png" alt="should-appear">
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const imgs = findAllElements(root.children, "img");
    expect(imgs).toHaveLength(1);
    expect(getAttr(imgs[0]!, "alt")).toBe("should-appear");
  });

  it("strips ~~~ fenced code blocks (tilde variant)", () => {
    const src = `~~~
<img src="tilde-fenced.png" alt="hidden">
~~~

<img src="outside.png" alt="visible">
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const imgs = findAllElements(root.children, "img");
    expect(imgs).toHaveLength(1);
    expect(getAttr(imgs[0]!, "alt")).toBe("visible");
  });

  it("handles code-only files without error", () => {
    const src = "```\n<img>\n```\n";
    const { errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
  });

  it("tolerates unterminated fences (treats rest-of-file as code)", () => {
    const src = `
\`\`\`
<img alt="inside">
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    // Unterminated fence absorbs rest of file; no img element surfaces.
    expect(findFirstElement(root.children, "img")).toBeUndefined();
  });
});

describe("parseMarkdown — indented code block strip", () => {
  it("strips a 4-space-indented code block so embedded `<div>` does not surface as a real element", () => {
    const src = `# Docs

Here is an example:

    <div class="alert">
      <p>Example markup</p>
    </div>

After the example.
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    // The block is illustrative — no <div> or <p> should reach the HTML AST.
    expect(findFirstElement(root.children, "div")).toBeUndefined();
    expect(findFirstElement(root.children, "p")).toBeUndefined();
  });

  it("strips a tab-indented code block (CommonMark treats one tab as four columns)", () => {
    const src = `# Title

Code follows:

\t<div class="alert">should be hidden</div>

After.
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "div")).toBeUndefined();
  });

  it("strips a fenced code block sitting inside a list item past the 3-space fence-indent ceiling", () => {
    // Real-world docs idiom: a fenced block nested in a list item ends
    // up indented 6+ columns. The fence-strip pass requires ≤3-space
    // indent, so it doesn't recognize this as a fence — but the
    // indented-code-block strip catches the content via the indent path.
    const src = `# List

- Item one
- Item two with code:

      \`\`\`html
      <div class="alert">should be hidden</div>
      \`\`\`

After list.
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "div")).toBeUndefined();
  });

  it("does NOT strip 4-space-indented children of an HTML block (e.g. <tr> inside <table>)", () => {
    // The "previous line is blank" guard keeps an HTML block's indented
    // children from being mis-classified as code. The <tbody>/<tr> lines
    // sit four+ spaces deep but follow non-blank parent lines.
    const src = `# Docs

<table>
  <thead>
    <tr><th scope="col">Name</th></tr>
  </thead>
  <tbody>
    <tr><td>A</td></tr>
  </tbody>
</table>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "table")).toBeDefined();
    const ths = findAllElements(root.children, "th");
    expect(ths).toHaveLength(1);
    expect(getAttr(ths[0]!, "scope")).toBe("col");
    const trs = findAllElements(root.children, "tr");
    expect(trs).toHaveLength(2);
  });

  it("does NOT strip a paragraph continuation line indented to 4 spaces (cannot interrupt a paragraph)", () => {
    // Inline HTML on a wrapped paragraph line must survive — the
    // continuation line follows a non-blank prose line so it is part of
    // the paragraph, not an indented code block.
    const src = `# Title

Some paragraph that continues
    with <a href="/x">a link</a> indented on this wrapped line.

End.
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const a = findFirstElement(root.children, "a");
    expect(a).toBeDefined();
    expect(getAttr(a!, "href")).toBe("/x");
  });

  it("preserves real embedded HTML alongside an indented code block", () => {
    const src = `# Mixed

<img src="/real.png" alt="real-image">

Example below:

    <img src="/example.png" alt="should-not-extract">

End.
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const imgs = findAllElements(root.children, "img");
    // Only the un-indented <img> at column 0 is real residue; the
    // indented one is illustrative and was stripped.
    expect(imgs).toHaveLength(1);
    expect(getAttr(imgs[0]!, "alt")).toBe("real-image");
  });

  it("extends an indented block across blank interior lines (CommonMark lazy continuation)", () => {
    // The blank line in the middle of the block is part of the block.
    // Both indented `<p>` lines must be stripped.
    const src = `# Title

Code:

    <p>line one</p>

    <p>line three after blank</p>

Paragraph after.
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "p")).toBeUndefined();
  });

  it("preserves line numbers for HTML following an indented code block", () => {
    // Stripping must blank with whitespace so subsequent line numbers
    // do not shift. The <iframe> on line 8 must still report line 8.
    const src = `# Title

Indented block:

    <p>hidden</p>
    <p>also hidden</p>

<iframe src="x" title="visible"></iframe>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const iframe = findFirstElement(root.children, "iframe");
    expect(iframe).toBeDefined();
    expect(iframe!.loc.start.line).toBe(8);
  });
});

describe("parseMarkdown — ATX heading strip", () => {
  it("strips `# Heading` so the text doesn't reach HTML as stray content", () => {
    const src = `# A Top Heading

<table><tr><td>Data</td></tr></table>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "h1")).toBeUndefined();
    expect(findFirstElement(root.children, "table")).toBeDefined();
  });

  it("strips multi-level ATX headings", () => {
    const src = `## Second Level

### Third Level

<iframe src="x" title="embed"></iframe>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "iframe")).toBeDefined();
  });

  it("does not treat `#hash in prose` as a heading", () => {
    // A `#` preceded by non-whitespace is not an ATX heading.
    const src = `Text with a#hash embedded.\n\n<img alt="after">`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });
});

describe("parseMarkdown — Setext heading strip", () => {
  it("strips `Title\\n===` setext heading", () => {
    const src = `My Page Title
=============

<div class="content">body</div>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const divs = findAllElements(root.children, "div");
    expect(divs.some((d) => getAttr(d, "class") === "content")).toBe(true);
  });

  it("strips `Title\\n---` setext heading", () => {
    const src = `Subtitle
--------

<img src="a.png" alt="after-setext">
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(getAttr(img!, "alt")).toBe("after-setext");
  });
});

describe("parseMarkdown — inline code span strip", () => {
  it("strips `inline code` spans so angle brackets inside them don't confuse the HTML parser", () => {
    const src =
      'This is prose with `<img alt="inside-code">` that should not reach HTML.\n\n<img src="real.png" alt="real">\n';
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const imgs = findAllElements(root.children, "img");
    expect(imgs).toHaveLength(1);
    expect(getAttr(imgs[0]!, "alt")).toBe("real");
  });

  it("handles multi-backtick delimiters for spans containing backticks", () => {
    const src = 'Text ``code with ` inside``. Then: <img alt="outside">\n';
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(getAttr(img!, "alt")).toBe("outside");
  });
});

describe("parseMarkdown — markdown image syntax rewrite", () => {
  it("rewrites `![alt](url)` into an <img> the scanner can analyze", () => {
    const src = "Before image.\n\n![a helpful chart](/images/chart.png)\n\nAfter image.\n";
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(getAttr(img!, "alt")).toBe("a helpful chart");
    expect(getAttr(img!, "src")).toBe("/images/chart.png");
  });

  it("rewrites images with empty alt (decorative)", () => {
    const src = "![](/assets/decorative.png)\n";
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(getAttr(img!, "alt")).toBe("");
  });

  it("escapes HTML-significant chars in alt text and URL", () => {
    const src = '![a "quoted" & <dangerous> alt](/x?y=1&z=2)\n';
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    // Attribute value surfaces decoded (the HTML parser decodes
    // `&quot;` / `&amp;` back to `"` / `&`).
    expect(getAttr(img!, "alt")).toBe('a "quoted" & <dangerous> alt');
  });

  it("ignores broken image syntax without newlines in alt or url", () => {
    // Missing closing paren — leave as literal; no img should be produced.
    const src = "![broken(no-close\n\nNormal text.\n";
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "img")).toBeUndefined();
  });
});

describe("parseMarkdown — embedded HTML blocks preserved", () => {
  it("preserves a table with <th scope>", () => {
    const src = `# Docs

| markdown table (ignored) |
| --- |

<table>
  <thead>
    <tr><th scope="col">Name</th><th scope="col">Value</th></tr>
  </thead>
  <tbody>
    <tr><td>A</td><td>1</td></tr>
  </tbody>
</table>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const table = findFirstElement(root.children, "table");
    expect(table).toBeDefined();
    const ths = findAllElements(root.children, "th");
    expect(ths.length).toBeGreaterThanOrEqual(2);
    expect(getAttr(ths[0]!, "scope")).toBe("col");
  });

  it("preserves an <iframe title> video embed", () => {
    const src = `## Video walkthrough

<iframe src="https://player.vimeo.com/video/123" title="Intro tutorial"></iframe>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const iframe = findFirstElement(root.children, "iframe");
    expect(iframe).toBeDefined();
    expect(getAttr(iframe!, "title")).toBe("Intro tutorial");
  });

  it("preserves admonition <div class> blocks", () => {
    const src = `### Note

<div class="note warning">
This is an admonition. Heed it.
</div>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const div = findFirstElement(root.children, "div");
    expect(div).toBeDefined();
    expect(getAttr(div!, "class")).toBe("note warning");
  });

  it("preserves inline <img> embedded in prose", () => {
    const src = `# Title

See this chart <img src="/chart.png" alt="quarterly revenue"> for details.
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(getAttr(img!, "alt")).toBe("quarterly revenue");
  });
});

describe("parseMarkdown — kramdown IAL attachment", () => {
  it("attaches `{: .note}` to the preceding HTML block as class=", () => {
    const src = `<div>content</div>
{: .note}
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const div = findFirstElement(root.children, "div");
    expect(div).toBeDefined();
    expect(getAttr(div!, "class")).toBe("note");
  });

  it("merges multiple class tokens from IAL", () => {
    const src = `<p>text</p>
{: .note .warning}
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const p = findFirstElement(root.children, "p");
    expect(p).toBeDefined();
    expect(getAttr(p!, "class")).toBe("note warning");
  });

  it("appends to an existing class= attribute when present", () => {
    const src = `<div class="existing">x</div>
{: .added}
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const div = findFirstElement(root.children, "div");
    expect(div).toBeDefined();
    expect(getAttr(div!, "class")).toBe("existing added");
  });

  it("strips orphan IAL lines without breaking the HTML parse", () => {
    // No preceding block to attach to — just strip the IAL.
    const src = `# Heading

{: .orphan}

<img alt="after">
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });
});

describe("parseMarkdown — mixed content", () => {
  it("parses a realistic Jekyll doc page: frontmatter + heading + table + image", () => {
    const src = `---
layout: default
title: Configuration
---

# Front matter

The following table lists the supported variables.

<table>
  <thead>
    <tr><th scope="col">Variable</th><th scope="col">Description</th></tr>
  </thead>
  <tbody>
    <tr><td>title</td><td>Page title</td></tr>
  </tbody>
</table>

See the diagram:

![configuration flow](/assets/config-flow.png)

For more, see the notes below.

<div class="note">
Be careful with YAML indentation.
</div>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);

    // Table with th[scope] preserved.
    const ths = findAllElements(root.children, "th");
    expect(ths.length).toBeGreaterThanOrEqual(2);
    expect(getAttr(ths[0]!, "scope")).toBe("col");

    // Image from markdown syntax synthesized as <img>.
    const imgs = findAllElements(root.children, "img");
    expect(imgs).toHaveLength(1);
    expect(getAttr(imgs[0]!, "alt")).toBe("configuration flow");
    expect(getAttr(imgs[0]!, "src")).toBe("/assets/config-flow.png");

    // Admonition div preserved.
    const divs = findAllElements(root.children, "div");
    expect(divs.some((d) => getAttr(d, "class") === "note")).toBe(true);
  });

  it("handles markdown image alongside raw HTML image on separate lines", () => {
    const src = `![markdown-image](/md.png)

<img src="/html.png" alt="html-image">
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const imgs = findAllElements(root.children, "img");
    expect(imgs).toHaveLength(2);
    const alts = imgs.map((i) => getAttr(i, "alt"));
    expect(alts).toContain("markdown-image");
    expect(alts).toContain("html-image");
  });
});

describe("parseMarkdown — edge cases", () => {
  it("never throws on a file with only code fences", () => {
    const src = "```\nsome code\n```\n~~~\nmore code\n~~~\n";
    expect(() => parseMarkdown(src)).not.toThrow();
  });

  it("never throws on a file with overlapping special syntax", () => {
    const src = "# `code in heading`\n\n![alt with `backticks`](/x.png)\n\n`<img>`\n";
    expect(() => parseMarkdown(src)).not.toThrow();
  });

  it("preserves line numbers across stripped regions", () => {
    // Line 6 should carry the iframe; stripped frontmatter and code
    // fence should not shift subsequent lines.
    const src = `---
title: X
---
\`\`\`
code
\`\`\`
<iframe title="on-line-7"></iframe>
`;
    const { root, errors } = parseMarkdown(src);
    expect(errors).toHaveLength(0);
    const iframe = findFirstElement(root.children, "iframe");
    expect(iframe).toBeDefined();
    expect(iframe!.loc.start.line).toBe(7);
  });
});
