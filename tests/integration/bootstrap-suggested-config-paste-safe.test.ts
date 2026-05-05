/**
 * Integration test: `bootstrap` and `propose_config` produce paste-safe
 * `suggestedConfig` strings.
 *
 * Doctrine: docs/kb/architecture/ai-first-consumer.md "Bootstrap output
 * must be paste-safe." Bootstrap-class tools ship code the agent is
 * expected to paste directly into `ra11y.config.ts`. The output bears
 * a higher correctness bar than ordinary tool output:
 *
 *   1. It must parse as valid TypeScript by construction (not "valid
 *      modulo a permissive parser") — a paste that yields a TS syntax
 *      error breaks the user's project at compile time.
 *   2. Classification predicates must err on the side of false-negative
 *      inclusion. A `<topdir>/**` glob in `exclude` may only land when
 *      the entire topdir is build-artifact-classified — never when
 *      authored siblings live there. A bulk-template corpus where
 *      `templates/` has 3 minified files plus 100 authored quiet
 *      templates must NOT collapse to `templates/**`.
 *
 * The test rounds-trips: build a fixture corpus mixing
 * definite-build-artifact files with authored siblings, call both
 * `bootstrap` and `propose_config`, parse the resulting
 * `suggestedConfig` via `ts.transpileModule`, and assert no parse
 * errors AND no `<authored-src-tree>/**` glob in the emitted
 * `exclude`.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { McpSession } from "../../src/mcp/session.ts";
import { bootstrapTool } from "../../src/mcp/tool-bootstrap.ts";
import { proposeConfigTool } from "../../src/mcp/tool-propose-config.ts";

interface BootstrapResponseLike {
  readonly suggestedConfig?: string;
}

interface ProposeConfigResponseLike {
  readonly suggestedConfig: string;
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-bootstrap-paste-safe-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Parses the emitted `suggestedConfig` string via the TypeScript
 * compiler API. Returns an object describing diagnostic count and the
 * first diagnostic message (if any) so failures surface the
 * underlying syntax error rather than a bare boolean. We swap the
 * `import { defineConfig } from "@ra11y/core"` for a local stub so
 * the parse stays self-contained and doesn't require module
 * resolution.
 */
function parseSuggestedConfig(source: string): {
  readonly diagnosticCount: number;
  readonly firstMessage: string | null;
} {
  // Stub the import so the snippet is parseable in isolation. The
  // surface under test is the body shape (commas, brackets, quotes),
  // not module resolution.
  const stubbed = source.replace(
    /import \{ defineConfig \} from "@ra11y\/core";/,
    "const defineConfig = (x: unknown) => x;",
  );
  const result = ts.transpileModule(stubbed, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: false,
      noEmit: false,
    },
    reportDiagnostics: true,
  });
  const diags = result.diagnostics ?? [];
  const firstMessage =
    diags.length === 0 ? null : ts.flattenDiagnosticMessageText(diags[0]?.messageText ?? "", "\n");
  return { diagnosticCount: diags.length, firstMessage };
}

/**
 * Returns the body of the `exclude: [...]` block from a
 * `suggestedConfig` string, or null when the block is absent.
 * Captures content between `exclude: [` and the matching `],` —
 * tolerant of multi-line entries.
 */
function extractExcludeBody(source: string): string | null {
  const match = source.match(/exclude: \[([\s\S]*?)\n\s*\],/);
  return match === null ? null : (match[1] ?? "");
}

/**
 * Seeds N sibling subtrees, each mixing definite-classified `.min.js`
 * files with authored HTML pages. Used by the bulk-template-corpus
 * sweep test so the per-test arrow stays under Biome's
 * cyclomatic-complexity ceiling.
 */
async function seedMixedSubtrees(root: string, topdirs: readonly string[]): Promise<void> {
  for (const topdir of topdirs) {
    await mkdir(join(root, topdir), { recursive: true });
    for (const minName of ["a.min.js", "b.min.js", "c.min.js"]) {
      await writeFile(join(root, topdir, minName), "// min\n");
    }
    for (const htmlName of ["one.html", "two.html"]) {
      await writeFile(
        join(root, topdir, htmlName),
        `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${htmlName}</title></head><body><p>x</p></body></html>\n`,
      );
    }
  }
}

/**
 * Asserts that none of `topdirs` shows up as a `<topdir>/**` glob in
 * the emitted exclude body. Tolerant to the body being absent
 * (gated entries fully stripped).
 */
function assertNoTopdirGlobs(suggestedConfig: string, topdirs: readonly string[]): void {
  const excludeBody = extractExcludeBody(suggestedConfig);
  if (excludeBody === null) return;
  for (const topdir of topdirs) {
    expect(excludeBody).not.toContain(`"${topdir}/**"`);
  }
}

async function callBootstrap(dir: string): Promise<BootstrapResponseLike> {
  const session = new McpSession();
  const result = await bootstrapTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as BootstrapResponseLike;
}

async function callProposeConfig(dir: string): Promise<ProposeConfigResponseLike> {
  const session = new McpSession();
  const result = await proposeConfigTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as ProposeConfigResponseLike;
}

describe("bootstrap suggestedConfig: parses as valid TS", () => {
  // Pin the syntax-pre-check axis: regardless of which scan shape
  // exercises the emitter, the resulting string must transpile.
  // Doctrine: "Bootstrap output must be paste-safe."
  it("produces TS that transpiles without diagnostics on a clean codebase", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Hello</title></head><body><p>content</p></body></html>\n',
      );
      const { suggestedConfig } = await callBootstrap(dir);
      expect(typeof suggestedConfig).toBe("string");
      const { diagnosticCount, firstMessage } = parseSuggestedConfig(suggestedConfig ?? "");
      expect(diagnosticCount).toBe(0);
      // firstMessage assertion would be vacuous when count is 0; if a
      // regression flips the count, the helper carries the diagnostic
      // text into the failure banner via the surrounding object.
      expect(firstMessage).toBeNull();
    });
  });

  it("produces TS that transpiles without diagnostics on a corpus with definite-min-infix files", async () => {
    await withScratch(async (dir) => {
      await mkdir(join(dir, "assets"), { recursive: true });
      // Three `.min.`-infix files — all definite-min-infix, vendor-
      // classified. The collapse fires; emitted body must still parse.
      await writeFile(join(dir, "assets", "a.min.js"), "// min\n");
      await writeFile(join(dir, "assets", "b.min.js"), "// min\n");
      await writeFile(join(dir, "assets", "c.min.js"), "// min\n");
      const { suggestedConfig } = await callProposeConfig(dir);
      const { diagnosticCount, firstMessage } = parseSuggestedConfig(suggestedConfig);
      expect(diagnosticCount).toBe(0);
      expect(firstMessage).toBeNull();
    });
  });

  it("produces TS that transpiles when wrappers, excludes, and rules stub all coexist", async () => {
    await withScratch(async (dir) => {
      // Confirmed-wrapper case (Button.tsx native <button> root).
      await writeFile(
        join(dir, "Button.tsx"),
        "export function Button(props: { onClick: () => void; children: unknown }) {\n" +
          "  return <button onClick={props.onClick}>{props.children}</button>;\n" +
          "}\n",
      );
      // Definite-classified vendor file at root → exclude entry.
      await writeFile(join(dir, "vendor.min.js"), "// minified vendor bundle\n");
      // A page that fires several rules → top-rules stub populated.
      await writeFile(
        join(dir, "a.html"),
        "<!DOCTYPE html><html><head></head><body>" +
          '<img src="/a.png"><img src="/b.png"><img src="/c.png">' +
          "</body></html>\n",
      );
      const { suggestedConfig } = await callProposeConfig(dir);
      const { diagnosticCount, firstMessage } = parseSuggestedConfig(suggestedConfig);
      expect(diagnosticCount).toBe(0);
      expect(firstMessage).toBeNull();
    });
  });
});

describe("bootstrap suggestedConfig: vendor-classification gate keeps authored subtrees out of exclude", () => {
  // Pin the bulk-template-corpus regression. A topdir with a few
  // definite-classified files plus many authored siblings (parsed,
  // produce zero findings) must NOT collapse to `<topdir>/**`. The
  // gate's third axis (`topdirHasAuthoredFile`) is the deterministic
  // predicate that earns the glob.
  it("does NOT emit `templates/**` when templates/ contains authored HTML alongside minified vendor", async () => {
    await withScratch(async (dir) => {
      await mkdir(join(dir, "templates"), { recursive: true });
      // Three minified files — definite-min-infix.
      await writeFile(join(dir, "templates", "a.min.js"), "// min\n");
      await writeFile(join(dir, "templates", "b.min.js"), "// min\n");
      await writeFile(join(dir, "templates", "c.min.js"), "// min\n");
      // Five authored HTML pages, all WCAG-clean (proper lang +
      // title, no images). They produce zero findings, so the
      // earlier finding-bearing-directory gate would have allowed
      // the collapse. The new vendor-classification gate refuses
      // because the authored pages are parsed-but-not-artifact.
      for (const name of ["intro.html", "guide.html", "faq.html", "about.html", "contact.html"]) {
        await writeFile(
          join(dir, "templates", name),
          `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${name}</title></head><body><p>content</p></body></html>\n`,
        );
      }
      const { suggestedConfig } = await callProposeConfig(dir);
      const excludeBody = extractExcludeBody(suggestedConfig);
      // Either the exclude block is absent (gated entries fully
      // stripped) or, if present, must NOT carry `templates/**`.
      if (excludeBody !== null) {
        expect(excludeBody).not.toContain('"templates/**"');
      }
    });
  });

  it("does NOT emit `<topdir>/**` for any topdir containing authored siblings — sweep across multiple subtrees", async () => {
    // Bulk-template-corpus simulation: 4 sibling subtrees each
    // mixing minified vendor with authored HTML. Without the gate
    // the emitter ships `<topdir>/**` for all four, sweeping
    // ~20 authored pages. With the gate, none of them collapse.
    const topdirs = ["templates", "snippets", "components", "examples"];
    await withScratch(async (dir) => {
      await seedMixedSubtrees(dir, topdirs);
      const { suggestedConfig } = await callProposeConfig(dir);
      assertNoTopdirGlobs(suggestedConfig, topdirs);
    });
  });

  it("DOES emit `<topdir>/**` when the topdir is fully vendor-classified — no authored siblings", async () => {
    // The negative case: a topdir whose every parsed file is
    // build-artifact-classified earns the collapse. This is the
    // canonical onboarding shape — a `vendor/`-style subtree with
    // only minified bundles inside.
    await withScratch(async (dir) => {
      await mkdir(join(dir, "assets"), { recursive: true });
      await writeFile(join(dir, "assets", "a.min.js"), "// min\n");
      await writeFile(join(dir, "assets", "b.min.js"), "// min\n");
      await writeFile(join(dir, "assets", "c.min.js"), "// min\n");
      const { suggestedConfig } = await callProposeConfig(dir);
      expect(suggestedConfig).toContain('"assets/**"');
    });
  });
});
