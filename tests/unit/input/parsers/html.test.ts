import { describe, expect, it } from "bun:test";
import { detectLiquidIncludeHead, parseHtml } from "../../../../src/input/parsers/html.ts";
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

  // ─── Liquid root-layout stray-closer rename ────────────────────────────
  //
  // Jekyll's canonical `_layouts/*.html` wraps `{{ content }}` between
  // `{%- include top.html -%}` (opens `<html>` / `<body>`) and
  // `{%- include footer.html -%}` (closes `</body></html>`); a literal
  // trailing `</html>` in the wrapper file therefore has no matching
  // open inside the file. The parser must still surface the recovery
  // via a recoverable ParseError (so `analysisCoverage.partialParseFiles`
  // keeps the honest "scan degraded" telemetry), but the reason string
  // on that error earns a shape-naming rename so an agent reading the
  // entry routes to the include-chain composition instead of treating
  // it as an unexpected parse failure.
  //
  // The rename is narrow — `depth === 0` + root-tag closer + Liquid
  // `{% include %}` / `{% render %}` head. A nested stray close, a
  // non-root closer, or a non-Liquid (or non-include) head keeps the
  // generic "Stray closing tag at top level" wording so real structural
  // bugs don't get dressed up as layout-composition tails.

  it("renames the stray-close diagnostic for a Liquid root-layout </html> tail", () => {
    const src = `{%- include top.html -%}

<main>content</main>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors.length).toBe(1);
    expect(errors[0]?.recoverable).toBe(true);
    expect(errors[0]?.message).toContain("Elided layout-tail </html>");
    expect(errors[0]?.message).toContain("Liquid");
  });

  it("renames the stray-close diagnostic for a </body> layout tail", () => {
    const src = `{% include head.html %}
<main>x</main>
</body>
`;
    const { errors } = parseHtml(src);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain("Elided layout-tail </body>");
  });

  it("accepts {% render %} as an equivalent layout-composition head", () => {
    const src = `{% render 'top.html' %}
<main>x</main>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors[0]?.message).toContain("Elided layout-tail </html>");
  });

  it("keeps the generic stray-close wording for a non-root closer under a Liquid head", () => {
    const src = `{%- include top.html -%}
</div>
`;
    const { errors } = parseHtml(src);
    expect(errors[0]?.message).toBe("Stray closing tag at top level");
  });

  it("keeps the generic stray-close wording when the file does not open with a Liquid include", () => {
    const src = `<!DOCTYPE html>
<div>x</div>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors[0]?.message).toBe("Stray closing tag at top level");
  });

  it("keeps the generic wording when the Liquid head is {% capture %} / {% if %} rather than an include", () => {
    // `{% capture %}` and `{% if %}` don't delegate the root-tag open
    // to a sibling partial — they render their body inline. A trailing
    // bare `</html>` on those files really IS a parse bug; naming it
    // "elided layout-tail" would hide the signal an agent needs.
    const capture = parseHtml(`{% capture x %}a{% endcapture %}\n</html>\n`);
    expect(capture.errors[0]?.message).toBe("Stray closing tag at top level");
    const conditional = parseHtml(`{% if x %}a{% endif %}\n</html>\n`);
    expect(conditional.errors[0]?.message).toBe("Stray closing tag at top level");
  });

  it("keeps the generic wording for a nested stray close even under a Liquid-include head", () => {
    // `</html>` appears inside an unclosed `<section>` body here — it
    // is NOT a top-level layout tail. The depth guard must catch this.
    const src = `{%- include top.html -%}
<section>
  </html>
`;
    const { errors } = parseHtml(src);
    // Multiple errors are fine; none of them should claim this is a
    // recognised layout tail.
    expect(errors.some((e) => e.message.includes("Elided layout-tail"))).toBe(false);
  });

  it("detectLiquidIncludeHead accepts BOM and leading blank lines; rejects non-include heads", () => {
    expect(detectLiquidIncludeHead("{% include top.html %}")).toBe(true);
    expect(detectLiquidIncludeHead("{%- include top.html -%}")).toBe(true);
    expect(detectLiquidIncludeHead("{% render 'top.html' %}")).toBe(true);
    expect(detectLiquidIncludeHead("﻿  \n{%- include top.html -%}")).toBe(true);
    expect(detectLiquidIncludeHead("{% if x %}")).toBe(false);
    expect(detectLiquidIncludeHead("{% capture y %}")).toBe(false);
    expect(detectLiquidIncludeHead("{{ content }}")).toBe(false);
    expect(detectLiquidIncludeHead("<!DOCTYPE html>")).toBe(false);
    expect(detectLiquidIncludeHead("")).toBe(false);
  });

  // ─── Markdown-autolink recovery ────────────────────────────────────────
  //
  // Markdown autolinks (`<https://example.com>`, `<mailto:alice@x.com>`)
  // survive the `.md` → HTML residue pass and would otherwise tokenize
  // into a synthetic element: the tag-name reader accepts `:` as a name
  // char (XML-style `<svg:circle>` is real), so `<https:` becomes a
  // `<https:>` element whose unclosed recovery cascades through every
  // following `</p>` / `</li>`. Rejecting at the open side for a
  // closed URL-scheme keyword set keeps the URL as literal text and
  // lets surrounding structure parse normally. Narrower than "tag ends
  // with `:`" so XML namespace parses stay on the element path.

  it("treats <https://…> markdown autolinks as literal text, not element openers", () => {
    const { root, errors } = parseHtml("<p>See <https://example.com> for details.</p>");
    expect(errors.length).toBe(0);
    const p = findFirst(root, "p");
    expect(p).not.toBeNull();
    // The `<https://example.com>` span is a text node — no phantom
    // `<https:>` element and no unclosed-element cascade.
    expect(findFirst(root, "https:")).toBeNull();
    const joined = (p?.children ?? [])
      .filter((c) => c.kind === "HtmlText")
      .map((c) => (c as { value: string }).value)
      .join("");
    expect(joined).toContain("<https://example.com>");
    expect(joined).toContain("for details.");
  });

  it("treats <mailto:…> autolinks as literal text", () => {
    const { root, errors } = parseHtml("<p>Email <mailto:alice@example.com> now.</p>");
    expect(errors.length).toBe(0);
    const p = findFirst(root, "p");
    expect(p).not.toBeNull();
    expect(findFirst(root, "mailto:alice")).toBeNull();
    const joined = (p?.children ?? [])
      .filter((c) => c.kind === "HtmlText")
      .map((c) => (c as { value: string }).value)
      .join("");
    expect(joined).toContain("<mailto:alice@example.com>");
  });

  it("recovers URL autolinks across every supported scheme (http, ftp, tel, sms, ws, …)", () => {
    // Closed keyword set — widening requires a matching fixture, so a
    // regression that drops one keyword surfaces here.
    const schemes = ["http", "https", "mailto", "ftp", "file", "tel", "sms", "ws", "wss"];
    for (const scheme of schemes) {
      const { errors } = parseHtml(`<p>See <${scheme}:target> .</p>`);
      expect(errors.length).toBe(0);
    }
  });

  it("keeps XML-namespace elements intact — only URL-scheme keywords are rejected", () => {
    // `<svg:circle>`, `<xmlns:foo>`, and any other `namespace:localname`
    // whose namespace is not in the URL-scheme keyword set must still
    // parse as real elements. This guards against overzealous widening
    // to "tag ends with `:`".
    const { root: svgRoot, errors: svgErrors } = parseHtml("<svg:circle r='5'/>");
    expect(svgErrors.length).toBe(0);
    expect(findFirst(svgRoot, "svg:circle")).not.toBeNull();

    const { root: xmlRoot, errors: xmlErrors } = parseHtml("<xmlns:foo>x</xmlns:foo>");
    expect(xmlErrors.length).toBe(0);
    expect(findFirst(xmlRoot, "xmlns:foo")).not.toBeNull();
  });

  it("treats <http> as a normal element when there's no colon after the scheme word", () => {
    // The guard fires only on `<scheme>:` — a bare `<http>` with no
    // following `:` is still a (weird but parseable) element open. The
    // rejection must require the `:` anchor so `<style>`, `<script>`,
    // and any future three-to-four-letter element can't accidentally
    // share a prefix with a scheme keyword.
    const { root, errors } = parseHtml("<p><http>ok</http></p>");
    expect(errors.length).toBe(0);
    expect(findFirst(root, "http")).not.toBeNull();
  });

  it("emits the markdown autolink at a correct line/column so downstream rules point at the URL's line", () => {
    // Line 2 has the autolink; line 1 is the opener. Position tracking
    // must stay aligned — a regression that regressed the text-node's
    // source location would misroute rule findings.
    const { root } = parseHtml("<p>\n  See <https://example.com> here.\n</p>");
    const p = findFirst(root, "p");
    const textNodes = (p?.children ?? []).filter((c) => c.kind === "HtmlText");
    const autolinkNode = textNodes.find((t) =>
      (t as { value: string }).value.includes("https://example.com"),
    ) as { loc: { start: { line: number } } } | undefined;
    expect(autolinkNode?.loc.start.line).toBe(2);
  });

  it("does not cascade unclosed-element errors through sibling tags on the same page", () => {
    // Before the fix: `<https:>` element-open + can't find `</https:>`
    // would steal every sibling `</li>` / `</ul>` as its descendants
    // and cascade `Unclosed <li>`, `Unclosed <ul>` errors through the
    // rest of the file. Guard the full no-cascade shape.
    const { errors } = parseHtml(
      `<ul>
  <li>Visit <https://a.com></li>
  <li>Visit <https://b.com></li>
</ul>`,
    );
    expect(errors.length).toBe(0);
  });
});
