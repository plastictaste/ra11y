/**
 * Unit tests for `pragmaFormForExtension` — the per-extension
 * `ra11y-disable` pragma builder consumed by the `checklist` tool.
 *
 * The earlier 4-key `{ html, jsx, liquid, hugo }` shape shipped every
 * dialect on every candidate regardless of file extension; an agent
 * picking the `html` form on a `.scss` candidate would corrupt source
 * because HTML-comment syntax is invalid in CSS. The replacement is
 * a single string keyed off the candidate's actual file extension —
 * the canonical "Ambiguous field shapes are dishonest" closure
 * (`docs/kb/architecture/ai-first-consumer.md`).
 *
 * These tests pin the per-extension table so a future refactor can't
 * silently drop or re-route an entry.
 */
import { describe, expect, it } from "bun:test";
import { pragmaFormForExtension } from "../../../src/mcp/checklist-suppress-pragma.ts";

const CRIT = "wcag22:1.4.5";

describe("pragmaFormForExtension", () => {
  describe("JSX-expression form (.jsx / .tsx / .mdx)", () => {
    it.each(["src/Foo.jsx", "src/Foo.tsx", "docs/page.mdx"])("emits {/* … */} for %s", (path) => {
      expect(pragmaFormForExtension(path, CRIT)).toBe(`{/* ra11y-disable ${CRIT} */}`);
    });

    it("normalizes case (.TSX)", () => {
      expect(pragmaFormForExtension("src/Foo.TSX", CRIT)).toBe(`{/* ra11y-disable ${CRIT} */}`);
    });
  });

  describe("CSS-block form (.css / .scss / .sass / .less / .js / .ts / .mjs / .cjs)", () => {
    it.each([
      "app.css",
      "app.scss",
      "app.sass",
      "app.less",
      "app.js",
      "app.ts",
      "app.mjs",
      "app.cjs",
    ])("emits /* … */ for %s", (path) => {
      expect(pragmaFormForExtension(path, CRIT)).toBe(`/* ra11y-disable ${CRIT} */`);
    });
  });

  describe("HTML-comment form (markup + template families)", () => {
    it.each([
      "index.html",
      "index.htm",
      "index.xhtml",
      "README.markdown",
      "README.md",
      "notes.mkdn",
      "logo.svg",
      "page.astro",
      "App.vue",
      "App.svelte",
      "show.html.erb",
      "footer.liquid",
    ])("emits <!-- … --> for %s", (path) => {
      expect(pragmaFormForExtension(path, CRIT)).toBe(`<!-- ra11y-disable ${CRIT} -->`);
    });
  });

  describe("unknown extensions", () => {
    it("falls back to // line comment", () => {
      expect(pragmaFormForExtension("config.toml", CRIT)).toBe(`// ra11y-disable ${CRIT}`);
    });

    it("falls back to // when there is no extension", () => {
      expect(pragmaFormForExtension("Makefile", CRIT)).toBe(`// ra11y-disable ${CRIT}`);
    });
  });

  describe("criterion-ID embedding", () => {
    it("interpolates the criterion ID verbatim", () => {
      expect(pragmaFormForExtension("a.html", "section508:1194.22.c")).toContain(
        "section508:1194.22.c",
      );
    });

    it("interpolates rule-ID-shaped tokens too", () => {
      // The helper does not validate the token shape; pragma reader
      // accepts both rule IDs (`/`) and criterion IDs (`:`).
      expect(pragmaFormForExtension("a.css", "color/contrast")).toBe(
        "/* ra11y-disable color/contrast */",
      );
    });
  });

  describe("never corrupts source: each form is recognized by the inline-disable parser", () => {
    // The whole point of the per-extension routing is that the
    // emitted pragma must (a) parse in the target file's syntax AND
    // (b) be recognized by `parseInlineDisables` so the suppression
    // actually fires. The reader's recognized prefixes are
    // documented in `src/config/inline-disables.ts` `COMMENT_PATTERNS`:
    // `//`, `/* … */`, `<!-- … -->`, and `{/* … */}`. Pin that the
    // emitter never produces a shape outside that recognized set.
    const recognized = [/^\/\//, /^\/\*.*\*\/$/, /^<!--.*-->$/, /^\{\/\*.*\*\/\}$/];
    const samples = [
      "a.tsx",
      "a.jsx",
      "a.mdx",
      "a.css",
      "a.scss",
      "a.sass",
      "a.less",
      "a.js",
      "a.ts",
      "a.mjs",
      "a.cjs",
      "a.html",
      "a.htm",
      "a.xhtml",
      "a.markdown",
      "a.md",
      "a.mkdn",
      "a.svg",
      "a.astro",
      "a.vue",
      "a.svelte",
      "a.html.erb",
      "a.liquid",
      "a.toml",
      "Makefile",
    ];
    it.each(samples)("%s emits a parser-recognized form", (path) => {
      const pragma = pragmaFormForExtension(path, CRIT);
      expect(recognized.some((rx) => rx.test(pragma))).toBe(true);
    });
  });
});
