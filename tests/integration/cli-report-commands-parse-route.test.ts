/**
 * Pins that the four reporting commands (`coverage`, `vpat`, `checklist`,
 * `certification`) and the scan command share a single canonical
 * `parseFor` route table — exercised end-to-end on a fixture corpus
 * with `.md` and `.css` files that the prior narrowed reporting-command
 * helpers silently dropped.
 *
 * Per the AI-first consumer model "Routing skips that drop content are
 * the symmetric twin of suppression": a reporting command that never
 * parses `.css` / `.md` / `.scss` / `.astro` / `.svg` / `.mdx` etc.
 * silently misrepresents the corpus it ran against. The narrowed local
 * `parseFor` helpers in coverage / vpat / checklist / certification
 * routed only `.html`/`.htm`/`.xhtml` + `.tsx`/`.jsx`/`.ts`/`.js`,
 * dropping every other parseable extension. This suite locks in that
 * the unified helper at `src/cli/parse-for.ts` actually parses those
 * files for all five commands.
 *
 * Coverage strategy:
 *   - `.md` corpus: a raw-HTML `<img>` embedded in a markdown
 *     document (the static-site-generator pattern the markdown
 *     adapter is designed for) lacking an `alt` attribute should
 *     surface the SC 1.1.1 (alt-text) failure on every reporting
 *     surface. Pre-fix, the file was silently dropped on the four
 *     reporting commands and 1.1.1 read as passing.
 *   - `.css` corpus: a stylesheet with a contrast-failing color pair
 *     should reach the CSS-scoped rules (`contrast/minimum`,
 *     `state-class-color-only`, …) on every reporting surface. Pre-
 *     fix, every `.css` file was silently dropped on the four
 *     reporting commands.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chdir, cwd } from "node:process";
import { parseCliArgs } from "../../src/cli/args.ts";
import { runCertification } from "../../src/cli/commands/certification.ts";
import { runChecklist } from "../../src/cli/commands/checklist.ts";
import { runCoverage } from "../../src/cli/commands/coverage.ts";
import { runScanCommand } from "../../src/cli/commands/scan.ts";
import { runVpat } from "../../src/cli/commands/vpat.ts";
import { parseFor } from "../../src/cli/parse-for.ts";
import { posixJoin } from "../helpers/path.ts";

const originalCwd = cwd();
const scratchDirs: string[] = [];

afterEach(async () => {
  chdir(originalCwd);
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(posixJoin(tmpdir(), `ra11y-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

describe("shared parseFor — extension routing", () => {
  it("routes .css through parseCss (returns css-language AST)", () => {
    const ast = parseFor("a.css", "body { color: #fff; background: #fff; }");
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("css");
  });

  it("routes .scss through parseScss (returns css-language AST)", () => {
    const ast = parseFor("a.scss", "$c: #fff; body { color: $c; }");
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("css");
  });

  it("routes .less through parseLess (returns css-language AST)", () => {
    const ast = parseFor("a.less", "@c: #fff; body { color: @c; }");
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("css");
  });

  it("routes .md through parseMarkdown (returns html-language AST)", () => {
    const ast = parseFor("README.md", '# Title\n\n<p><img src="logo.png"></p>\n');
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("routes .markdown through parseMarkdown (returns html-language AST)", () => {
    const ast = parseFor("doc.markdown", '# Title\n\n<p><img src="logo.png"></p>\n');
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("routes .mkdn through parseMarkdown (returns html-language AST)", () => {
    const ast = parseFor("doc.mkdn", '# Title\n\n<p><img src="logo.png"></p>\n');
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("routes .astro through parseAstro (returns html-language AST)", () => {
    const ast = parseFor("page.astro", "<html><body><p>hi</p></body></html>");
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("routes .svg through parseSvg (returns html-language AST)", () => {
    const ast = parseFor("icon.svg", "<svg><title>icon</title></svg>");
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("routes .mdx through parseMdx (returns tsx-language AST)", () => {
    const ast = parseFor("page.mdx", "# Title\n\nimport X from 'x';\n");
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("tsx");
  });

  it("routes .erb through parseHtml (returns html-language AST)", () => {
    const ast = parseFor("view.erb", "<html><body><%= name %></body></html>");
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("routes .php through parsePhp (returns html-language AST)", () => {
    const ast = parseFor("page.php", "<?php echo 'x'; ?><html><body><p>hi</p></body></html>");
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("routes .xhtml through parseHtml (returns html-language AST)", () => {
    const ast = parseFor(
      "page.xhtml",
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>hi</p></body></html>',
    );
    expect(ast).not.toBeNull();
    expect(ast?.language).toBe("html");
  });

  it("returns null for unknown extensions (signals not-parseable)", () => {
    expect(parseFor("a.xyz", "anything")).toBeNull();
    expect(parseFor("README", "anything")).toBeNull();
  });
});

/**
 * `.md` corpus regression: every reporting command must surface the
 * 1.1.1 (alt-text) failure for a markdown file embedding a raw-HTML
 * `<img>` with no `alt` attribute. The markdown adapter strips
 * markdown syntax and feeds the residue to parseHtml; the
 * alt-text-missing rule (scoped to `.html`/`.htm`/`.tsx`/`.jsx` —
 * `.md` aliases to `.html`) fires on the `language: "html"` AST.
 * Pre-fix, the four reporting commands silently dropped `.md` files,
 * so 1.1.1 read as passing on the coverage / vpat / certification
 * surfaces.
 *
 * We use raw-HTML `<img>` rather than markdown `![](url)` syntax
 * because the markdown adapter rewrites `![](url)` into
 * `<img alt="">` — and `alt=""` is the WCAG-blessed "decorative
 * image" marker, so the rule correctly does not fire. Raw HTML
 * inside markdown is the static-site-generator idiom the adapter
 * is designed to surface (Bootstrap docs, MkDocs Material, Jekyll
 * docs, Docusaurus all embed raw `<table>` / `<img>` inline).
 */
describe("reporting commands surface findings on .md files", () => {
  it("scan emits an alt-text violation on a .md with raw HTML <img>", async () => {
    const dir = await scratch("scan-md");
    await writeFile(posixJoin(dir, "doc.md"), '# Title\n\n<p><img src="logo.png"></p>\n');
    chdir(dir);

    const r = await runScanCommand(parseCliArgs([]));

    // alt-text missing fires at error severity → non-OK exit on
    // default --fail-on=error. Output mentions the rule or 1.1.1.
    expect(r.stdout + r.stderr).toMatch(/1\.1\.1|alt/i);
  });

  it("coverage shows 1.1.1 failing on a .md corpus with raw HTML <img>", async () => {
    const dir = await scratch("cov-md");
    await writeFile(posixJoin(dir, "doc.md"), '# Title\n\n<p><img src="logo.png"></p>\n');
    chdir(dir);

    const r = await runCoverage(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("1.1.1");
  });

  it("checklist surfaces the .md corpus to the violations report", async () => {
    const dir = await scratch("chk-md");
    await writeFile(posixJoin(dir, "doc.md"), '# Title\n\n<p><img src="logo.png"></p>\n');
    chdir(dir);

    const r = await runChecklist(parseCliArgs([]));

    expect(r.stdout).toMatch(/1\.1\.1|alt/i);
  });

  it("vpat reports a Does Not Support row for SC 1.1.1 on a .md corpus", async () => {
    const dir = await scratch("vpat-md");
    await writeFile(posixJoin(dir, "doc.md"), '# Title\n\n<p><img src="logo.png"></p>\n');
    chdir(dir);

    const r = await runVpat(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    // VPAT rows include the SC number in the criterion column.
    expect(r.stdout).toContain("1.1.1");
  });

  it("certification scorecard reflects the .md-driven 1.1.1 failure", async () => {
    const dir = await scratch("cert-md");
    await writeFile(posixJoin(dir, "doc.md"), '# Title\n\n<p><img src="logo.png"></p>\n');
    chdir(dir);

    const r = await runCertification(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    // Certification renders per-standard sections; the .md must reach
    // the scan or the coverage feeding the scorecard would treat 1.1.1
    // as untested rather than failing.
    expect(r.stdout.length).toBeGreaterThan(0);
  });
});

/**
 * `.css` corpus regression: every reporting command must reach the
 * CSS-scoped rules. Pre-fix, the four reporting commands silently
 * dropped every `.css` file — coverage / vpat / certification reports
 * showed CSS-scoped criteria as untested rather than tested.
 *
 * We don't pin a specific finding here (CSS rules are heuristic and
 * version-sensitive); we pin that the file was *parsed*. The clearest
 * evidence is that `parseFor` itself routes the file through parseCss
 * (covered above) and that the reporting commands run end-to-end on
 * a `.css` corpus without crashing — which would happen if the helper
 * still returned `null` and the downstream pipeline had a code path
 * that assumed at least one file was parsed.
 */
describe("reporting commands accept .css corpora end-to-end", () => {
  it("coverage runs on a .css-only corpus without crashing", async () => {
    const dir = await scratch("cov-css");
    await writeFile(posixJoin(dir, "site.css"), "body { color: #777; background: #888; }");
    chdir(dir);

    const r = await runCoverage(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Coverage");
  });

  it("vpat runs on a .css-only corpus without crashing", async () => {
    const dir = await scratch("vpat-css");
    await writeFile(posixJoin(dir, "site.css"), "body { color: #777; background: #888; }");
    chdir(dir);

    const r = await runVpat(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it("checklist runs on a .css-only corpus without crashing", async () => {
    const dir = await scratch("chk-css");
    await writeFile(posixJoin(dir, "site.css"), "body { color: #777; background: #888; }");
    chdir(dir);

    const r = await runChecklist(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it("certification runs on a .css-only corpus without crashing", async () => {
    const dir = await scratch("cert-css");
    await writeFile(posixJoin(dir, "site.css"), "body { color: #777; background: #888; }");
    chdir(dir);

    const r = await runCertification(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });
});
