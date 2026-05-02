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

  describe("opaque-text carve-out for <code> and <pre>", () => {
    // Documentation pages routinely use <code> and <pre> to display
    // literal HTML examples (sometimes balanced, sometimes intentionally
    // showing only a close tag for narrative purposes). The parser
    // treats their text content as opaque so a literal `</ul>` shown
    // for narrative purposes is not a stray-close diagnostic. See
    // src/input/parsers/html.ts::OPAQUE_TEXT_ELEMENTS for the carve-out
    // definition and the code-block-cdata real-world fixture for the
    // originating bug.

    it("treats <code> body as opaque text — literal close tags do not surface as stray closers", () => {
      const { root, errors } = parseHtml("<code></ul></code>");
      expect(errors.length).toBe(0);
      const code = findFirst(root, "code");
      expect(code?.children.length).toBe(1);
      expect(code?.children[0]?.kind).toBe("HtmlText");
      const text = code?.children[0] as { value: string };
      expect(text.value).toBe("</ul>");
    });

    it("treats <pre> body as opaque text — literal close tags do not surface as stray closers", () => {
      const { root, errors } = parseHtml("<pre></button></pre>");
      expect(errors.length).toBe(0);
      const pre = findFirst(root, "pre");
      expect(pre?.children[0]?.kind).toBe("HtmlText");
      const text = pre?.children[0] as { value: string };
      expect(text.value).toBe("</button>");
    });

    it("does not parse a literal <a> nested inside <code> as a child element (carve-out trade-off)", () => {
      const { root, errors } = parseHtml(`<code><a href="#">x</a></code>`);
      expect(errors.length).toBe(0);
      // The <a> is text inside the <code>, not a child element — that's
      // the intended outcome for content shown as a code example.
      expect(findFirst(root, "a")).toBeNull();
      const code = findFirst(root, "code");
      expect(code?.children.length).toBe(1);
      expect(code?.children[0]?.kind).toBe("HtmlText");
    });

    it("balances same-tag nesting — <code><code>x</code></code> closes the outer at the matching outer </code>", () => {
      const { root, errors } = parseHtml("<code><code>x</code></code>after");
      expect(errors.length).toBe(0);
      const code = findFirst(root, "code");
      expect(code?.children.length).toBe(1);
      // The body is the literal inner-tag string (entities decoded as
      // for any opaque-text body).
      const text = code?.children[0] as { value: string };
      expect(text.value).toBe("<code>x</code>");
      // "after" is a sibling text node of <code>, not nested.
      const docTexts = root.children.filter((c) => c.kind === "HtmlText");
      expect(docTexts.some((t) => (t as { value: string }).value.includes("after"))).toBe(true);
    });

    it("attribute quotes inside an inner same-tag opener don't terminate the opaque body prematurely", () => {
      // Inner `<code class="x">` has a `>` inside an attribute value
      // shape; the opaque-text walker must skip the start-tag body
      // quote-aware so depth balancing stays accurate.
      const { root, errors } = parseHtml('<code><code class=">"></code></code>tail');
      expect(errors.length).toBe(0);
      const code = findFirst(root, "code");
      expect(code?.children[0]?.kind).toBe("HtmlText");
    });
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

  // ─── template-directive stripping ─────────────
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
  // non-root closer, or a non-Liquid (or non-include) head falls
  // through to the scope-aware default wording (`Stray </X> at top
  // level` at depth 0; `Mismatched </X> close at line N (inside
  // <ancestor>)` at depth > 0) so real structural bugs don't get
  // dressed up as layout-composition tails.

  it("renames the stray-close diagnostic for a Liquid root-layout </html> tail", () => {
    const src = `{%- include top.html -%}

<main>content</main>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors.length).toBe(1);
    expect(errors[0]?.recoverable).toBe(true);
    // The reason names the elided side honestly: `<html>` open is
    // elided (provided by the partial); `</html>` close is in source.
    // Naming the closer as "elided" inverted the routing direction
    // an agent reads off `partialParseFiles[].reason`.
    expect(errors[0]?.message).toContain("Elided layout-tail <html> open");
    expect(errors[0]?.message).toContain("</html>");
    expect(errors[0]?.message).toContain("Liquid");
  });

  it("renames the stray-close diagnostic for a </body> layout tail", () => {
    const src = `{% include head.html %}
<main>x</main>
</body>
`;
    const { errors } = parseHtml(src);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain("Elided layout-tail <body> open");
    expect(errors[0]?.message).toContain("</body>");
  });

  it("accepts {% render %} as an equivalent layout-composition head", () => {
    const src = `{% render 'top.html' %}
<main>x</main>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors[0]?.message).toContain("Elided layout-tail <html> open");
  });

  it("keeps the root-level wording for a non-root closer under a Liquid head", () => {
    // `</div>` at depth 0 is genuinely top-level (no enclosing
    // ancestor on the open stack) — the message should name the
    // actual stray and reserve the "top level" claim for this
    // honest case.
    const src = `{%- include top.html -%}
</div>
`;
    const { errors } = parseHtml(src);
    expect(errors[0]?.message).toBe("Stray </div> at top level");
  });

  it("keeps the root-level wording when the file does not open with a Liquid include", () => {
    const src = `<!DOCTYPE html>
<div>x</div>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors[0]?.message).toBe("Stray </html> at top level");
  });

  it("keeps the root-level wording when the Liquid head is {% capture %} / {% if %} rather than an include", () => {
    // `{% capture %}` and `{% if %}` don't delegate the root-tag open
    // to a sibling partial — they render their body inline. A trailing
    // bare `</html>` on those files really IS a parse bug; naming it
    // "elided layout-tail" would hide the signal an agent needs.
    const capture = parseHtml(`{% capture x %}a{% endcapture %}\n</html>\n`);
    expect(capture.errors[0]?.message).toBe("Stray </html> at top level");
    const conditional = parseHtml(`{% if x %}a{% endif %}\n</html>\n`);
    expect(conditional.errors[0]?.message).toBe("Stray </html> at top level");
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

  it("does not claim layout-tail elision when the file already closes its own root envelope", () => {
    // A wrapper that delegates root closure to a sibling partial has
    // exactly one root-envelope closer in its source — the trailing
    // stray. A file whose tail reads literally `</body>\n</html>` has
    // two root-envelope closers and is closing its own document
    // (broken or otherwise). Naming such a tail "Elided layout-tail"
    // lies to the agent: the parse error is something else (forgotten
    // opens, hand-completed envelope on a file the partial expects to
    // leave unclosed). Both stray closers fall through to the
    // scope-aware default wording.
    const src = `{% include top.html %}
<main>content</main>
</body>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors.some((e) => e.message.includes("Elided layout-tail"))).toBe(false);
    expect(errors.some((e) => e.message === "Stray </body> at top level")).toBe(true);
    expect(errors.some((e) => e.message === "Stray </html> at top level")).toBe(true);
  });

  it("does not claim elision when the file pairs a real <body>...</body> with a trailing stray </html>", () => {
    // The file opens `<body>` itself and closes it cleanly; only
    // `</html>` is stray. Even with one root closer outside the
    // pairing (`</html>` itself) the file's source still contains
    // TWO root-envelope tokens (`</body>` from the in-file pairing
    // plus `</html>`). The elision rename's "exactly one closer"
    // guard correctly suppresses the rename — the file is closing
    // its own body, the trailing `</html>` is honestly stray, not a
    // delegated root-tag close. The standard "Stray </html> at top
    // level" wording surfaces the genuine structural mismatch.
    const src = `{% include top.html %}
<body>x</body>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors.some((e) => e.message.includes("Elided layout-tail"))).toBe(false);
    expect(errors.some((e) => e.message === "Stray </html> at top level")).toBe(true);
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

  // ─── HTML5 implicit-close behavior ─────────────────────────────────────
  //
  // The HTML Living Standard's "Tag omission in text/html" notes allow
  // several elements to omit their explicit end tag when the close can
  // be inferred from context. Browser-renderable, hand-authored HTML
  // routinely relies on this — `<p>foo<p>bar`, `<li>one<li>two`,
  // `<tr><td>a<td>b`, and (most commonly) a `<p>` with no `</p>` before
  // `</body></html>`. Without implicit-close handling, every such file
  // routes into `analysisCoverage.partialParseFiles` with reasons that
  // read as parser failures, so the agent reading them dismisses real
  // a11y findings on the recovered subtree.
  //
  // See `IMPLIED_END_TAG_ELEMENTS` and `IMPLICIT_CLOSE_ON_OPEN` in the
  // parser for the closed sets backing these tests; the closed sets
  // mirror the spec's tag-omission notes for each element.

  it("closes <p> implicitly when </body> arrives", () => {
    const { errors } = parseHtml("<!DOCTYPE html><html><body><p>hello</body></html>\n");
    expect(errors).toEqual([]);
  });

  it("closes <p> implicitly when a sibling <p> opens", () => {
    const { root, errors } = parseHtml("<div><p>one<p>two<p>three</div>");
    expect(errors).toEqual([]);
    const div = findFirst(root, "div");
    const ps = (div?.children ?? []).filter(
      (c) => c.kind === "HtmlElement" && (c as HtmlElement).tagName === "p",
    );
    expect(ps.length).toBe(3);
  });

  it("closes <p> implicitly when a sibling block-level element opens", () => {
    // `<p>` followed by `<ul>` / `<table>` / `<div>` — the spec's
    // "p-closer" set. The previous `<p>` ends; `<ul>` becomes a
    // sibling, not a child.
    const { root, errors } = parseHtml(
      "<div><p>before<ul><li>a<li>b</ul><table><tr><td>x</table></div>",
    );
    expect(errors).toEqual([]);
    const div = findFirst(root, "div");
    const directChildren = (div?.children ?? []).filter(
      (c) => c.kind === "HtmlElement",
    ) as HtmlElement[];
    expect(directChildren.map((c) => c.tagName)).toEqual(["p", "ul", "table"]);
  });

  it("closes <li> implicitly when a sibling <li> opens or </ul> arrives", () => {
    const { root, errors } = parseHtml("<ul><li>one<li>two<li>three</ul>");
    expect(errors).toEqual([]);
    const ul = findFirst(root, "ul");
    const lis = (ul?.children ?? []).filter(
      (c) => c.kind === "HtmlElement" && (c as HtmlElement).tagName === "li",
    );
    expect(lis.length).toBe(3);
  });

  it("closes <dt> / <dd> implicitly on each other and on </dl>", () => {
    const { root, errors } = parseHtml("<dl><dt>term1<dd>def1<dt>term2<dd>def2</dl>");
    expect(errors).toEqual([]);
    const dl = findFirst(root, "dl");
    const tags = (dl?.children ?? [])
      .filter((c) => c.kind === "HtmlElement")
      .map((c) => (c as HtmlElement).tagName);
    expect(tags).toEqual(["dt", "dd", "dt", "dd"]);
  });

  it("closes table cells and rows implicitly", () => {
    const { errors } = parseHtml(
      "<table><thead><tr><th>a<th>b</thead><tbody><tr><td>1<td>2<tr><td>3<td>4</tbody></table>",
    );
    expect(errors).toEqual([]);
  });

  it("closes <option> implicitly on sibling <option>", () => {
    const { errors } = parseHtml("<select><option>a<option>b<option>c</select>");
    expect(errors).toEqual([]);
  });

  it("reports a nested stray with the actual stray + enclosing scope", () => {
    // `</span>` has no matching opener anywhere in the open stack;
    // it sits inside an open `<div>` body, so the message must name
    // the enclosing scope rather than claim the stray is "at top
    // level" — the historic wording was a misdiagnosis on every
    // nested stray, forcing agents to re-open the file to confirm
    // the root closes cleanly.
    const { errors } = parseHtml("<div>hello</span></div>");
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) => e.message === "Mismatched </span> close at line 1 (inside <div>)"),
    ).toBe(true);
  });

  it("nested-stray message reports the line number of the stray, not the document head", () => {
    // The `partialParseFiles[].reason` field on the wire is just the
    // message string; the underlying `ParseError.position` doesn't
    // reach the agent. Pinning the line number in the message keeps
    // the reason itself self-locating — a stray on line 3 must read
    // "line 3", not "line 1".
    const src = "<section>\n  <p>x</p>\n  </span>\n</section>";
    const { errors } = parseHtml(src);
    expect(
      errors.some((e) => e.message === "Mismatched </span> close at line 3 (inside <section>)"),
    ).toBe(true);
  });

  it("nested-stray message names the innermost still-open ancestor", () => {
    // `</p>` has no matching opener; the stray sits inside `<span>`
    // (innermost open) which is itself inside `<div>`. The message
    // must name the innermost ancestor — naming a more outer one
    // would mislead the agent on which scope to grep for the
    // mis-paired opener.
    const { errors } = parseHtml("<div><span></p></span></div>");
    expect(
      errors.some((e) => e.message === "Mismatched </p> close at line 1 (inside <span>)"),
    ).toBe(true);
  });

  it("still reports a stray closing tag for </> orphans inside content", () => {
    const { errors } = parseHtml("<div>foo</></div>");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("still reports an unclosed <div> at EOF — <div> is not in the implied-end set", () => {
    // A non-implied-end element with no close tag IS a real bug; the
    // parser must keep emitting "Unclosed <div>" so the agent sees
    // the genuine structural break. The implicit-close work tightened
    // the predicate; it did not silence it for the elements where
    // the spec still requires an explicit end tag.
    const { errors } = parseHtml("<div><span>unfinished");
    expect(errors.some((e) => e.message.includes("Unclosed <div>"))).toBe(true);
    expect(errors.some((e) => e.message.includes("Unclosed <span>"))).toBe(true);
  });

  it("parses a real-world index.html ending with </body></html> + trailing whitespace", () => {
    const src =
      "<!DOCTYPE html>\n" +
      '<html lang="en">\n' +
      '<head><meta charset="utf-8"><title>x</title></head>\n' +
      "<body>\n" +
      "<main><h1>Hi</h1><p>one<p>two</main>\n" +
      "</body></html>\n\n";
    const { errors } = parseHtml(src);
    expect(errors).toEqual([]);
  });
});
