/**
 * Integration test: `bootstrap` and `propose_config` emit
 * `import { defineConfig } from "@ra11y/core"` in their suggested
 * config; this test pins that the named export actually resolves
 * against the package main entry.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Bootstrap
 * output must be paste-safe." The agent CANNOT redo bootstrap's
 * predicate cheaply with Read+Grep — the suggested config IS the
 * work product. Earlier paste-safety tests (`bootstrap-suggested-
 * config-paste-safe.test.ts`) prove the body parses as valid TS by
 * stubbing the import. That covers brackets / quotes / commas, but
 * specifically does NOT exercise the import-resolution surface — so
 * a regression where `@ra11y/core` stops re-exporting `defineConfig`
 * (the canonical case Q17 closed) slips past it. This test is the
 * counterpart: prove the named export is reachable from the package
 * main, and prove every emitter that writes the import line spells
 * the package name and symbol identically to what the package main
 * actually exports.
 *
 * The runtime check loads `src/index.ts` directly — which is the
 * file `package.json` `exports.".".default` resolves to once built
 * — and asserts `defineConfig` is a function. Going through the
 * built `dist/` bundle would couple the test to the build script
 * and require an extra step in `verify:precommit`; checking the
 * source barrel is equivalent because `dist/index.js` is a verbatim
 * transpile of `src/index.ts` (Bun.build with no rewrites). If the
 * named export disappears from `src/index.ts`, the import falls
 * back to undefined and the test fails before hitting the assertion.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { McpSession } from "../../src/mcp/session.ts";
import { bootstrapTool } from "../../src/mcp/tool-bootstrap.ts";
import { proposeConfigTool } from "../../src/mcp/tool-propose-config.ts";
import { posixJoin } from "../helpers/path.ts";

interface SuggestedConfigShape {
  readonly suggestedConfig?: string;
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-bootstrap-defineconfig-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("bootstrap suggestedConfig: defineConfig resolves from @ra11y/core", () => {
  it("re-exports defineConfig from the package main entry (src/index.ts)", async () => {
    // Direct import from the package main barrel. If `defineConfig`
    // stops being re-exported here, this line fails to type-check
    // OR the destructured value is undefined at runtime.
    const mod = (await import("../../src/index.ts")) as Record<string, unknown>;
    expect(typeof mod.defineConfig).toBe("function");
    // Round-trip through the helper to confirm it's the identity
    // helper plugin authors get from the `./plugin` entry, not a
    // shape-changing wrapper. A Config-shaped value passed in
    // returns equal-by-reference.
    const sentinel = { standards: ["wcag22"] as const, level: "AA" as const };
    const fn = mod.defineConfig as (c: typeof sentinel) => typeof sentinel;
    expect(fn(sentinel)).toBe(sentinel);
  });

  it("bootstrap suggestedConfig imports defineConfig from a name+symbol pair the package main exports", async () => {
    // The deterministic check the paste-safety test cannot do via
    // its `transpileModule` stub: the literal string the emitter
    // writes must match a real exported binding. We verify by
    // pattern, not by runtime `import()` — Bun's import resolver
    // does not bind `@ra11y/core` to the in-tree source unless we
    // mutate `bunfig.toml`, which we won't. The pattern check
    // catches every honest regression: if the emitter switches to
    // `@ra11y/plugin` / `defineRa11yConfig` / a typo, the assertion
    // fails. If the package main stops exporting `defineConfig`,
    // the sibling `re-exports defineConfig…` test fails first.
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Hi</title></head><body><p>x</p></body></html>\n',
      );
      const session = new McpSession();
      const result = await bootstrapTool.handler({ cwd: dir }, session);
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0]?.text ?? "{}") as SuggestedConfigShape;
      const suggested = body.suggestedConfig ?? "";
      expect(suggested).toContain('import { defineConfig } from "@ra11y/core";');
      expect(suggested).toContain("defineConfig({");
    });
  });

  it("propose_config suggestedConfig imports defineConfig from a name+symbol pair the package main exports", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Hi</title></head><body><p>x</p></body></html>\n',
      );
      const session = new McpSession();
      const result = await proposeConfigTool.handler({ cwd: dir }, session);
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0]?.text ?? "{}") as { suggestedConfig: string };
      expect(body.suggestedConfig).toContain('import { defineConfig } from "@ra11y/core";');
      expect(body.suggestedConfig).toContain("defineConfig(");
    });
  });
});
