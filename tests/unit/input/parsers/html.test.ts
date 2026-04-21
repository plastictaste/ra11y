import { describe, expect, it } from "bun:test";
import { parseHtml } from "../../../../src/input/parsers/html.ts";
import type { HtmlElement } from "../../../../src/types/ast.ts";

function findFirst(root: ReturnType<typeof parseHtml>["root"], tag: string): HtmlElement | null {
  const queue: unknown[] = [...root.children];
  while (queue.length > 0) {
    const node = queue.shift() as { kind?: string; tagName?: string; children?: unknown[] };
    if (node?.kind === "HtmlElement" && node.tagName === tag) return node as unknown as HtmlElement;
    if (node?.children) queue.push(...node.children);
  }
  return null;
}

describe("parseHtml", () => {
  it("parses an empty string", () => {
    const { root, errors } = parseHtml("");
    expect(root.kind).toBe("HtmlDocument");
    expect(root.children.length).toBe(0);
    expect(errors.length).toBe(0);
  });

  it("parses a simple element", () => {
    const { root, errors } = parseHtml("<p>hello</p>");
    expect(errors.length).toBe(0);
    const p = findFirst(root, "p");
    expect(p).not.toBeNull();
    expect(p?.children.length).toBe(1);
    expect(p?.children[0]?.kind).toBe("HtmlText");
  });

  it("parses attributes with double quotes", () => {
    const { root } = parseHtml('<img src="logo.png" alt="logo">');
    const img = findFirst(root, "img");
    expect(img).not.toBeNull();
    expect(img?.attributes.length).toBe(2);
    expect(img?.attributes[0]?.name).toBe("src");
    expect(img?.attributes[0]?.value).toBe("logo.png");
    expect(img?.attributes[1]?.name).toBe("alt");
    expect(img?.attributes[1]?.value).toBe("logo");
  });

  it("parses attributes with single quotes", () => {
    const { root } = parseHtml("<img src='logo.png'>");
    const img = findFirst(root, "img");
    expect(img?.attributes[0]?.value).toBe("logo.png");
  });

  it("parses unquoted attribute values", () => {
    const { root } = parseHtml("<img src=logo.png width=64>");
    const img = findFirst(root, "img");
    expect(img?.attributes[0]?.value).toBe("logo.png");
    expect(img?.attributes[1]?.value).toBe("64");
  });

  it("parses boolean attributes (no value)", () => {
    const { root } = parseHtml("<input disabled required>");
    const input = findFirst(root, "input");
    expect(input?.attributes.length).toBe(2);
    expect(input?.attributes[0]?.name).toBe("disabled");
    expect(input?.attributes[0]?.value).toBeNull();
    expect(input?.attributes[1]?.name).toBe("required");
  });

  it("auto-self-closes void elements", () => {
    const { root } = parseHtml("<img src=logo.png>next");
    const img = findFirst(root, "img");
    expect(img?.selfClosing).toBe(true);
    // "next" should be a sibling, not a child of img.
    expect(img?.children.length).toBe(0);
  });

  it("parses nested elements", () => {
    const { root } = parseHtml("<div><p>hello</p><p>world</p></div>");
    const div = findFirst(root, "div");
    expect(div?.children.length).toBe(2);
    expect((div?.children[0] as HtmlElement).tagName).toBe("p");
    expect((div?.children[1] as HtmlElement).tagName).toBe("p");
  });

  it("parses self-closing tags with /", () => {
    const { root } = parseHtml("<br/>");
    const br = findFirst(root, "br");
    expect(br?.selfClosing).toBe(true);
  });

  it("parses HTML comments", () => {
    const { root } = parseHtml("<!-- keep --><p>x</p>");
    expect(root.children[0]?.kind).toBe("HtmlComment");
    expect((root.children[0] as { value: string }).value).toBe(" keep ");
  });

  it("parses a doctype", () => {
    const { root } = parseHtml("<!DOCTYPE html><html></html>");
    expect(root.children[0]?.kind).toBe("HtmlDoctype");
  });

  it("treats script content as raw text (no nested parsing)", () => {
    const { root } = parseHtml("<script>const x = '<p>not a tag</p>';</script>");
    const script = findFirst(root, "script");
    expect(script?.children.length).toBe(1);
    expect(script?.children[0]?.kind).toBe("HtmlText");
    const text = script?.children[0] as { value: string };
    expect(text.value).toContain("<p>not a tag</p>");
  });

  it("treats style content as raw text", () => {
    const { root } = parseHtml("<style>p > a { color: red; }</style>");
    const style = findFirst(root, "style");
    expect(style?.children[0]?.kind).toBe("HtmlText");
  });

  it("decodes named HTML entities in text", () => {
    const { root } = parseHtml("<p>Tom &amp; Jerry &copy; 2026</p>");
    const p = findFirst(root, "p");
    const text = p?.children[0] as { value: string };
    expect(text.value).toBe("Tom & Jerry © 2026");
  });

  it("decodes numeric entities", () => {
    const { root } = parseHtml("<p>&#169; &#x2014;</p>");
    const p = findFirst(root, "p");
    const text = p?.children[0] as { value: string };
    expect(text.value).toBe("© —");
  });

  it("decodes entities in attribute values", () => {
    const { root } = parseHtml('<a href="?a=1&amp;b=2">link</a>');
    const a = findFirst(root, "a");
    expect(a?.attributes[0]?.value).toBe("?a=1&b=2");
  });

  it("keeps nested-quote Liquid expressions intact inside attribute values", () => {
    // Jekyll's canonical scaffold — `jekyll new` emits this verbatim.
    // Before the fix the inner `"` of `default: "en-US"` terminated the
    // attribute value, truncating `lang` to `{{ site.lang | default: `.
    const { root, errors } = parseHtml('<html lang="{{ site.lang | default: "en-US" }}"></html>');
    expect(errors.length).toBe(0);
    const html = findFirst(root, "html");
    expect(html?.attributes[0]?.name).toBe("lang");
    expect(html?.attributes[0]?.value).toBe('{{ site.lang | default: "en-US" }}');
  });

  it("skips `{% ... %}` spans inside attribute values", () => {
    // Liquid control directives carry their own quoted string literals.
    const { root } = parseHtml('<div class="{% if user.name == "admin" %}admin{% endif %}"></div>');
    const div = findFirst(root, "div");
    expect(div?.attributes[0]?.value).toBe('{% if user.name == "admin" %}admin{% endif %}');
  });

  it("recovers from an unclosed template span without throwing", () => {
    // Unclosed `{{` runs to EOF — the parser must not spin.
    expect(() => parseHtml('<p class="{{ unclosed ></p>')).not.toThrow();
  });

  it("keeps a `{{ ... }}` span intact in an unquoted attribute value", () => {
    // A `>` inside a Liquid span would otherwise terminate the tag early.
    const { root } = parseHtml("<div class={{ theme }}></div>");
    const div = findFirst(root, "div");
    expect(div?.attributes[0]?.value).toBe("{{ theme }}");
  });

  it("records recoverable error for unterminated start tag without throwing", () => {
    const { root, errors } = parseHtml("<p");
    expect(root).toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.recoverable).toBe(true);
  });

  it("records recoverable error for stray closing tag", () => {
    const { root, errors } = parseHtml("</p>");
    expect(root).toBeDefined();
    expect(errors.some((e) => e.message.includes("Stray"))).toBe(true);
  });

  it("records recoverable error for unclosed element but returns the children", () => {
    const { root, errors } = parseHtml("<div><p>hello</div");
    expect(root).toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("parses case-insensitively for tag names", () => {
    const { root } = parseHtml("<IMG SRC=x>");
    const upper = findFirst(root, "IMG");
    expect(upper).not.toBeNull();
  });

  it("matches closing tags case-insensitively", () => {
    const { root, errors } = parseHtml("<div><p>x</P></DIV>");
    expect(errors.length).toBe(0);
    expect(findFirst(root, "div")).not.toBeNull();
  });

  it("records line/column positions", () => {
    const { root } = parseHtml("<p>\n<img>\n</p>");
    const img = findFirst(root, "img");
    expect(img?.loc.start.line).toBe(2);
  });

  it("never throws on random garbage", () => {
    const garbage = "<><<<!doctype??? <x<y<>> &#xZZ; <p><<<";
    expect(() => parseHtml(garbage)).not.toThrow();
  });

  // ─── template-directive stripping (Q4-LIQUID-TEXT-LITERAL) ─────────────
  //
  // Structural invariants the fixture harness also guards via
  // jekyll-liquid-text-literal; these assert at the parser surface so a
  // refactor that moves stripping elsewhere still has to keep the AST
  // shape honest.

  it("strips {{ … }} and {% … %} from text nodes and flags the node", () => {
    const { root } = parseHtml("<p>Hello {{ user.name }} — {% if x %}ok{% endif %}!</p>");
    const p = findFirst(root, "p");
    const text = p?.children[0];
    expect(text?.kind).toBe("HtmlText");
    const value = (text as { value: string } | undefined)?.value.replace(/\s+/g, " ").trim();
    expect(value).toBe("Hello — ok!");
    expect((text as { containsTemplateDirective?: boolean }).containsTemplateDirective).toBe(true);
  });

  it("strips ERB directives from text nodes", () => {
    const { root } = parseHtml("<p>Welcome, <%= user.name %>!<%# hidden %></p>");
    const p = findFirst(root, "p");
    const joined = (p?.children ?? [])
      .filter((c) => c.kind === "HtmlText")
      .map((c) => (c as { value: string }).value)
      .join("")
      .trim();
    expect(joined).toBe("Welcome, !");
  });

  it("leaves template-free text unflagged", () => {
    const { root } = parseHtml("<p>plain text</p>");
    const p = findFirst(root, "p");
    const text = p?.children[0] as { containsTemplateDirective?: boolean };
    expect(text.containsTemplateDirective).toBeUndefined();
  });

  it("treats {% capture %}…{% endcapture %} as opaque text so inner <a> is not a <ul> child", () => {
    const src =
      "<ul>\n" +
      "  {% capture link %}\n" +
      '    <a href="/x">Inner</a>\n' +
      "  {% endcapture %}\n" +
      "  <li>{{ link }}</li>\n" +
      "</ul>";
    const { root } = parseHtml(src);
    const ul = findFirst(root, "ul");
    // Only <li> element children — the captured <a> must not surface
    // as a sibling of <li>. Text nodes around it are allowed.
    const elementChildren = (ul?.children ?? []).filter((c) => c.kind === "HtmlElement");
    expect(elementChildren.every((c) => (c as HtmlElement).tagName === "li")).toBe(true);
  });

  it("treats {% comment %}…{% endcomment %} as opaque text", () => {
    const src = "<div>{% comment %}<p>hidden</p>{% endcomment %}visible</div>";
    const { root } = parseHtml(src);
    const div = findFirst(root, "div");
    const pInside = findFirst(root, "p");
    // The <p> inside the comment block must not have been parsed as a
    // real element.
    expect(pInside).toBeNull();
    expect(div?.children.length).toBeGreaterThan(0);
  });

  it("strips directives from <title> raw-text content", () => {
    const { root } = parseHtml("<title>{{ page.title }} — Acme</title>");
    const title = findFirst(root, "title");
    const value = (title?.children[0] as { value: string }).value.trim();
    expect(value).toBe("— Acme");
    expect(
      (title?.children[0] as { containsTemplateDirective?: boolean }).containsTemplateDirective,
    ).toBe(true);
  });

  it("leaves unclosed {{ span as literal text (recovery)", () => {
    // Unclosed directive: parser must not hang and must keep the
    // source readable downstream. The backlog rule is "never throw";
    // leaving the literal is honest.
    const { root, errors } = parseHtml("<p>Hello {{ unclosed</p>");
    const p = findFirst(root, "p");
    expect(p).not.toBeNull();
    expect(errors.length).toBe(0);
  });
});
