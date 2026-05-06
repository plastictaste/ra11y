/**
 * Parser-routing coverage for `.xhtml` and `.mkdn`.
 *
 * `.xhtml` (XML-serialized HTML — `<?xml ... ?>` prologue, mandatory
 * `xmlns` on `<html>`, self-closing tags) and `.mkdn` (alternate
 * Markdown extension used by Vim and older static-site generators) are
 * equivalent input shapes to their accepted siblings (`.html` /
 * `.markdown`). Routing them through the same parsers (parseHtml /
 * parseMarkdown) keeps every HTML-scoped rule applicable without a
 * dedicated adapter — a routing skip would silently drop every finding
 * the file could surface (per the AI-first consumer model: under-parsing
 * is the symmetric twin of suppression).
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { McpSession } from "../../../src/mcp/session.ts";
import { posixJoin } from "../../helpers/path.ts";

describe("McpSession.parseFile: .xhtml routes through parseHtml", () => {
  it("parses an XHTML 1.0 document with `<?xml ... ?>` prologue and self-closing tags", async () => {
    const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-parse-xhtml-"));
    const filePath = posixJoin(dir, "page.xhtml");
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"
  "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <title>Test XHTML</title>
</head>
<body>
  <h1>Heading</h1>
  <p>Paragraph with <a href="x">link</a>.</p>
  <img src="x.png" alt="An image" />
</body>
</html>
`;
    await writeFile(filePath, xhtml);

    const session = new McpSession();
    const parsed = await session.parseFile(filePath);

    // Routing decision: parser must NOT return null (silent drop) and
    // must classify the file as HTML-shape so every `.html`-scoped rule
    // applies.
    expect(parsed).not.toBeNull();
    expect(parsed?.ast.language).toBe("html");
    // The HTML tokenizer tolerates the `<?xml ... ?>` prologue and
    // self-closing tags — neither should produce a parse error.
    expect(parsed?.ast.errors).toEqual([]);
  });
});

describe("McpSession.parseFile: .mkdn routes through parseMarkdown", () => {
  it("parses a `.mkdn` document and tags the AST as html-shape", async () => {
    const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-parse-mkdn-"));
    const filePath = posixJoin(dir, "README.mkdn");
    const mkdn = `# Title

A paragraph.

![A photo](pic.png)

## Subheading

- Item one
- Item two

<a href="x">Link</a>
`;
    await writeFile(filePath, mkdn);

    const session = new McpSession();
    const parsed = await session.parseFile(filePath);

    // Routing decision: same shape as .md / .markdown — markdown
    // adapter strips ATX/Setext syntax and feeds the residue to
    // parseHtml, so the AST language is "html".
    expect(parsed).not.toBeNull();
    expect(parsed?.ast.language).toBe("html");
    expect(parsed?.ast.errors).toEqual([]);
  });
});
