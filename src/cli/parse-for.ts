/**
 * Canonical CLI parse-for helper. The five project-rooted CLI commands
 * (`scan`, `coverage`, `vpat`, `checklist`, `certification`) used to
 * carry their own `parseFor(filePath, source)` copies. Four of them —
 * the reporting commands — narrowed the route table to only `.html` /
 * `.htm` / `.xhtml` and `.tsx` / `.jsx` / `.ts` / `.js`, silently
 * dropping every other parseable extension (`.astro`, `.mdx`, `.svg`,
 * `.md`, `.markdown`, `.mkdn`, `.erb`, `.css`, `.scss`, `.less`,
 * `.php`, `.phtml`). Per the AI-first consumer model "Routing skips
 * that drop content are the symmetric twin of suppression" — the
 * reporting commands cannot un-skip a file the helper refused to
 * parse, so coverage / vpat / checklist / certification reports
 * silently misrepresented the corpus they ran against (a 226-file
 * project with 50 `.css` files and 30 Markdown files showed only the
 * HTML+TSX-ish slice).
 *
 * This module is the single canonical route table consumed by all
 * five commands. The mapping mirrors the `parseForExtension`
 * dispatcher in `src/mcp/session.ts` (the most complete in-tree route
 * table) so the CLI surface and the MCP surface produce comparable
 * results on the same corpus. When new parseable extensions are
 * added (`PARSEABLE_EXTENSIONS` in `src/utils/path.ts`), update both
 * dispatchers in the same commit.
 */

import {
  parseAstro,
  parseCss,
  parseHtml,
  parseLess,
  parseMarkdown,
  parseMdx,
  parsePhp,
  parseScss,
  parseSvg,
  parseTsx,
} from "../input/parsers/index.ts";
import type { Ast } from "../types/ast.ts";
import { stripTemplatingTail } from "../utils/path.ts";

/**
 * Routes `source` through the in-house parser whose extension owns
 * `filePath`. Returns `null` when the extension is not in the
 * canonical parseable allow-list (see `PARSEABLE_EXTENSIONS` in
 * `src/utils/path.ts`); call sites should treat `null` as "skip,
 * not parseable" — distinct from an empty AST.
 *
 * The route table:
 *
 *   - `.html` / `.htm` / `.xhtml` / `.erb` → parseHtml
 *     (`.xhtml` is XML-serialized HTML; the HTML tokenizer tolerates
 *     the `<?xml ... ?>` prologue and self-closing tags. `.erb` is
 *     the Ruby embedded-template syntax (Rails views, Middleman,
 *     Jekyll `*.md.erb`); the HTML parser's `stripTemplateDirectives`
 *     pass strips `<%= … %>` / `<% … %>` / `<%# … %>` from text
 *     nodes so rules see the rendered-text shape.)
 *   - `.css` → parseCss
 *   - `.scss` → parseScss (produces a CSS AST; every `.css`-scoped
 *     rule applies)
 *   - `.less` → parseLess (produces a CSS AST; same as `.scss`)
 *   - `.mdx` → parseMdx (produces a TSX AST; every `.tsx`/`.jsx`-
 *     scoped rule applies)
 *   - `.astro` → parseAstro (produces an HTML AST)
 *   - `.svg` → parseSvg (passes through to parseHtml; the HTML
 *     tokenizer tolerates SVG's tag zoo and preserves `<title>` as
 *     raw text)
 *   - `.md` / `.markdown` / `.mkdn` → parseMarkdown (ADR 0025
 *     Option B: strip markdown syntax, rewrite `![alt](url)` as
 *     `<img>`, feed the residue to parseHtml)
 *   - `.php` / `.phtml` → parsePhp (blanks `<?php … ?>` /
 *     `<?= … ?>` / `<? … ?>` islands while preserving line/col, then
 *     feeds the HTML residue to parseHtml)
 *   - `.tsx` / `.jsx` / `.ts` / `.js` → parseTsx (`filePath` is
 *     forwarded so `inferJsxMode` can disable JSX-mode entry on bare
 *     `.js`/`.ts` inputs that lack a JSX-import signal — without
 *     this, every plain-JS file with an `<Identifier` comparison
 *     operator emits a fake `Unclosed JSX element <…>`)
 */
export function parseFor(filePath: string, source: string): Ast | null {
  // Strip a known templating tail (`.erb` / `.liquid` / `.ejs`) when
  // it follows another extension so e.g. `README.md.erb` routes by the
  // leading `.md` (markdown adapter) rather than the trailing `.erb`
  // (HTML adapter). Standalone `view.erb` is unchanged — the strip
  // predicate only triggers when there's a leading extension under
  // the tail. See `stripTemplatingTail` in `src/utils/path.ts`.
  const routablePath = stripTemplatingTail(filePath);
  if (
    routablePath.endsWith(".html") ||
    routablePath.endsWith(".htm") ||
    routablePath.endsWith(".xhtml") ||
    routablePath.endsWith(".erb")
  ) {
    const r = parseHtml(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (routablePath.endsWith(".css")) {
    const r = parseCss(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (routablePath.endsWith(".scss")) {
    const r = parseScss(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (routablePath.endsWith(".less")) {
    const r = parseLess(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (routablePath.endsWith(".mdx")) {
    const r = parseMdx(source);
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  if (routablePath.endsWith(".astro")) {
    const r = parseAstro(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (routablePath.endsWith(".svg")) {
    const r = parseSvg(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (routablePath.endsWith(".php") || routablePath.endsWith(".phtml")) {
    const r = parsePhp(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (
    routablePath.endsWith(".md") ||
    routablePath.endsWith(".markdown") ||
    routablePath.endsWith(".mkdn")
  ) {
    const r = parseMarkdown(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (
    routablePath.endsWith(".tsx") ||
    routablePath.endsWith(".jsx") ||
    routablePath.endsWith(".ts") ||
    routablePath.endsWith(".js")
  ) {
    const r = parseTsx(source, { filePath });
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  return null;
}
