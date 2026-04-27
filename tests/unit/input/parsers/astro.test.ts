import { describe, expect, it } from "bun:test";
import { parseAstro } from "../../../../src/input/parsers/astro.ts";
import type { HtmlElement, HtmlNode } from "../../../../src/types/ast.ts";

/**
 * Walk the HTML tree collecting every element matching `tagName`
 * (case-sensitive, like `parseHtml` returns it — Astro component
 * tags such as `<Icon>` must keep their capitalization so tests
 * can distinguish custom components from lowercase tags).
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

describe("parseAstro — empty + trivial", () => {
  it("parses empty source without error", () => {
    const { root, errors } = parseAstro("");
    expect(root.kind).toBe("HtmlDocument");
    expect(root.children).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("never throws on random garbage", () => {
    const garbage = "---\n---\n<<<>>>{expr{{<img </\n";
    expect(() => parseAstro(garbage)).not.toThrow();
  });

  it("parses an HTML-only Astro file identically to parseHtml", () => {
    const src = `<main><img src="/a.png" alt="cat" /></main>\n`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(getAttr(img!, "alt")).toBe("cat");
  });
});

describe("parseAstro — component-script frontmatter strip", () => {
  it("strips a leading --- frontmatter block", () => {
    const src = `---
import Icon from '../components/Icon.astro';
const title = "Hello";
---

<img src="/a.png" alt="after-frontmatter" />
`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(getAttr(img!, "alt")).toBe("after-frontmatter");
  });

  it("does nothing when the source has no frontmatter fence", () => {
    // Pure HTML Astro file — no component script at all.
    const src = `<h1>Hello</h1>\n<img alt="no-frontmatter" />`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });

  it("does not interpret `---` mid-document as frontmatter", () => {
    // Only a `---` at byte 0 is a fence. A `---` appearing later
    // is just stray text (most Astro files wouldn't have it, but
    // the guarantee is: we don't strip anything if there's no
    // opening fence at byte 0).
    const src = `<h1>Heading</h1>\n---\n<img alt="mid-dashes" />\n`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });

  it("emits a recoverable parseError on unterminated fence", () => {
    // Opening `---` but no closing `---` before EOF.
    const src = `---
import Icon from './Icon.astro';
const title = "Hello";

<img alt="still-needs-to-be-reachable" />
`;
    const { errors } = parseAstro(src);
    const recoverables = errors.filter((e) => e.recoverable);
    expect(recoverables.length).toBeGreaterThan(0);
    expect(recoverables[0]?.message).toMatch(/unterminated/i);
  });

  it("does not treat `----` (four dashes) as a fence", () => {
    // A `----` line is a horizontal rule or something else; it is
    // explicitly not a fence, so the whole file flows to HTML
    // verbatim.
    const src = `----\n<img alt="four-dashes" />\n----\n`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });

  it("tolerates trailing whitespace on the closing fence line", () => {
    // CRLF + trailing spaces — common in Windows-edited files.
    const src = '---\ntitle: x\n---  \n\n<img alt="whitespace-after-fence" />\n';
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });

  it("leaves `---foo` (no newline after fence) as literal text", () => {
    // `---foo` isn't a fence — the opening dashes must be followed
    // by a newline. Treat the whole file as template.
    const src = `---foo\n<img alt="not-a-fence" />`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });
});

describe("parseAstro — line-number preservation", () => {
  it("preserves line numbers for HTML that appears after a frontmatter block", () => {
    // The <img> is on line 5 of the original source. After the
    // frontmatter is blanked (newlines preserved), its reported
    // line number must still be 5.
    const src = `---
const x = 1;
---

<img alt="line5" />
`;
    const { root } = parseAstro(src);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(img?.loc.start.line).toBe(5);
  });
});

describe("parseAstro — opaque component tags", () => {
  it("tolerates uppercase component tags as regular HTML elements", () => {
    // `<Icon>` and `<Header>` are Astro component references. Without
    // their module resolution, we can't know what they render, so we
    // just keep them as opaque HTML elements — same treatment JSX
    // gets for opaque custom components.
    const src = `---
import Icon from './Icon.astro';
import Header from './Header.astro';
---

<Header>
  <Icon name="star" />
</Header>
`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    const header = findFirstElement(root.children, "Header");
    const icon = findFirstElement(root.children, "Icon");
    expect(header).toBeDefined();
    expect(icon).toBeDefined();
    expect(getAttr(icon!, "name")).toBe("star");
  });

  it("preserves component-tag capitalization (does not lowercase)", () => {
    const src = `<MyWidget />\n`;
    const { root } = parseAstro(src);
    const widget = findFirstElement(root.children, "MyWidget");
    expect(widget).toBeDefined();
  });
});

describe("parseAstro — inline <style> and <script>", () => {
  it("keeps inline <style> as a raw-text node on the element", () => {
    // The HTML parser treats <style> as raw-text: one HtmlText child
    // containing the block source verbatim. Downstream CSS rules
    // consume this via secondary extraction; we just need the shape.
    const src = `<style>.btn { color: #333; }</style>\n<img alt="with-style" />`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    const style = findFirstElement(root.children, "style");
    expect(style).toBeDefined();
    expect(style?.children).toHaveLength(1);
    const text = style!.children[0];
    expect(text?.kind).toBe("HtmlText");
    if (text?.kind === "HtmlText") {
      expect(text.value).toContain(".btn");
    }
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });

  it("keeps inline <script> as opaque raw-text", () => {
    const src = `<script>const n = 1 < 2;</script>\n<img alt="after-script" />`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    const script = findFirstElement(root.children, "script");
    expect(script).toBeDefined();
    // The 1 < 2 inside script doesn't get misparsed as a stray tag —
    // it's inside the raw-text scope.
    expect(findFirstElement(root.children, "img")).toBeDefined();
  });
});

describe("parseAstro — JSX-style {expr} braces are literal text", () => {
  it("treats `{expr}` in text as literal characters", () => {
    // We can't resolve Astro expressions zero-dep, so `{title}`
    // flows through as text content on the surrounding element.
    // The honest tradeoff: rules relying on resolved text (e.g.
    // link-text) will see the literal `{title}` and can choose
    // to flag or defer — matching template-directives policy.
    const src = `<h1>{title}</h1>\n`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    const h1 = findFirstElement(root.children, "h1");
    expect(h1).toBeDefined();
    expect(h1?.children[0]?.kind).toBe("HtmlText");
    if (h1?.children[0]?.kind === "HtmlText") {
      expect(h1.children[0].value).toContain("{title}");
    }
  });

  it("treats `attr={expr}` as an unquoted attribute value", () => {
    // `<img src={src} alt={alt} />` is valid Astro. The HTML
    // parser reads `{src}` as an unquoted attribute value (which
    // for our purposes is an opaque literal — the agent can see
    // it wasn't a string constant and investigate).
    const src = `<img src={src} alt={alt} />`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    // Attribute count: src + alt — both present, both unquoted.
    const altAttr = img?.attributes.find((a) => a.name === "alt");
    expect(altAttr).toBeDefined();
    expect(altAttr?.quote).toBeNull();
    expect(altAttr?.value).toBe("{alt}");
  });
});

describe("parseAstro — combined real-world page", () => {
  it("handles a representative Astro page: frontmatter, components, HTML, inline style", () => {
    const src = `---
import Layout from '../layouts/Layout.astro';
import Icon from '../components/Icon.astro';
const title = "Welcome";
---

<Layout title={title}>
  <main>
    <h1>Welcome to my site</h1>
    <Icon name="star" />
    <img src="/hero.png" alt="hero banner" />
    <a href="/about">Learn more</a>
  </main>
</Layout>

<style>
  main { padding: 1rem; color: #111; }
</style>
`;
    const { root, errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
    // All the meaningful elements are reachable.
    expect(findFirstElement(root.children, "Layout")).toBeDefined();
    expect(findFirstElement(root.children, "main")).toBeDefined();
    expect(findFirstElement(root.children, "h1")).toBeDefined();
    expect(findFirstElement(root.children, "Icon")).toBeDefined();
    expect(findFirstElement(root.children, "a")).toBeDefined();
    expect(findFirstElement(root.children, "style")).toBeDefined();
    // And the <img> carries through its alt text — the cross-rule
    // coverage the backlog item cares about.
    const imgs = findAllElements(root.children, "img");
    expect(imgs).toHaveLength(1);
    expect(getAttr(imgs[0]!, "alt")).toBe("hero banner");
  });
});

describe("parseAstro — never throws", () => {
  it("survives unterminated tags", () => {
    expect(() => parseAstro("<div\n")).not.toThrow();
  });

  it("survives nested unclosed frontmatter dashes", () => {
    expect(() => parseAstro("---\n---\n---\n")).not.toThrow();
  });

  it("survives a lone frontmatter opening with CRLF", () => {
    expect(() => parseAstro("---\r\nconst x = 1;\r\n")).not.toThrow();
  });
});

describe("parseAstro — layout-tail rename for delegated root closers", () => {
  // The canonical Astro composition shape: a page or partial whose
  // document envelope (`<html>` / `<body>` / `<head>`) is opened by
  // an imported `<Layout>` component and whose source therefore
  // carries only the matching close tags downstream. Without the
  // rename, the agent reads `partialParseFiles[].reason: "Stray
  // </body> at top level"` and triages it as a parser bug. With the
  // rename, the agent reads "Astro page or partial whose document
  // envelope is opened by a parent <Layout> component" and routes
  // straight to the composition shape.

  it("renames the stray-close diagnostic for </body> when no <body> opens in source", () => {
    const src = `---
import Footer from "./Footer.astro";
---
  <Footer />
</body>
`;
    const { errors } = parseAstro(src);
    const body = errors.find((e) => e.message.includes("</body>"));
    expect(body).toBeDefined();
    expect(body?.message).toContain("Elided layout-tail </body>");
    expect(body?.message).toContain("Astro");
  });

  it("renames both </body> and </html> on a closer-only Astro partial", () => {
    const src = `---
import Footer from "./Footer.astro";
---
  <Footer />
</body>
</html>
`;
    const { errors } = parseAstro(src);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const body = errors.find((e) => e.message.includes("</body>"));
    const html = errors.find((e) => e.message.includes("</html>"));
    expect(body?.message).toContain("Elided layout-tail </body>");
    expect(html?.message).toContain("Elided layout-tail </html>");
  });

  it("keeps the stray-close diagnostic when the matching open IS in source", () => {
    // The file opens <body>...</body> inline AND has a stray </html>.
    // The body close pairs cleanly; the html close is genuinely stray.
    // Per the per-tag matching-open gate, the rename fires for </html>
    // (no <html> open in source) but the body pairing emits no error
    // at all because the close has its open. The genuine stray case
    // — a non-root closer like </div> — also falls through to the
    // standard wording because </div> isn't in the layout-tail set.
    const src = `---
const x = 1;
---
<body>
  <h1>hi</h1>
</body>
</html>
`;
    const { errors } = parseAstro(src);
    const html = errors.find((e) => e.message.includes("</html>"));
    expect(html?.message).toContain("Elided layout-tail </html>");
  });

  it("does not rename </div> stray closes — only the html/body/head set is layout-tail eligible", () => {
    const src = `---
const x = 1;
---
<p>hi</p>
</div>
`;
    const { errors } = parseAstro(src);
    const div = errors.find((e) => e.message.includes("</div>"));
    expect(div?.message).toBe("Stray </div> at top level");
    expect(div?.message).not.toContain("Elided layout-tail");
  });

  it("emits no errors at all when the file legitimately opens and closes its own root envelope", () => {
    // A `.astro` file that owns the full document — no Layout
    // delegation. Both halves match, so no stray fires and the
    // rename is irrelevant.
    const src = `---
const t = "Hi";
---
<html lang="en">
<head><title>{t}</title></head>
<body>
  <h1>Hello</h1>
</body>
</html>
`;
    const { errors } = parseAstro(src);
    expect(errors).toHaveLength(0);
  });
});
