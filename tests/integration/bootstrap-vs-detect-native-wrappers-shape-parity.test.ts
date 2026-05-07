/**
 * Integration test: `bootstrap.wrappers` enumerates the same
 * discriminator field set the standalone `detect_native_wrappers`
 * surface ships on identical cwd.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md`
 *   - "Bootstrap-class lanes must equal project-rooted lanes" — the
 *     bootstrap composer subset must enumerate the same field set
 *     the upstream tool enumerates, not a smaller mental model.
 *   - "Per-tool review-candidate shape must agree across surfaces" —
 *     same field shape across surfaces; an agent calling bootstrap
 *     first must read the same discriminators it would read off the
 *     standalone tool.
 *
 * Pre-fix observation: `bootstrap.wrappers` shipped
 * `{ candidates: [], suggestedConfigSnippet? }` only — bare list, no
 * `projectKind` / `inapplicable` / `emptyReason` /
 * `opaqueCustomComponentNames` / `absentDeclaredWrappers`. An agent
 * calling bootstrap first on a Rails site (Gemfile + .erb) saw an
 * empty candidates array and could not tell "tool doesn't apply on
 * this projectKind" from "ran clean / coverage miss" without a
 * follow-up `detect_native_wrappers` call. The closure forwards every
 * upstream discriminator onto the bootstrap subset.
 *
 * Three branches pinned, exercising each upstream branch:
 *   1. JSX with PascalCase+onClick — populated `candidates`,
 *      `projectKind: "jsx"`, no `inapplicable` / `emptyReason`.
 *   2. JSX without PascalCase — empty `candidates`,
 *      `projectKind: "jsx"`, `emptyReason: "no-pascalcase-onclick-components"`.
 *   3. No JSX in tree (HTML only) — empty `candidates`,
 *      `inapplicable: { reason: "no_jsx_in_tree", filesByExtension }`,
 *      `projectKind: "static-site"`.
 *
 * Tests drive the handlers directly (no MCP subprocess) so failures
 * point at the shape-forwarding predicate without a transport delta.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { McpSession } from "../../src/mcp/session.ts";
import { bootstrapTool } from "../../src/mcp/tool-bootstrap.ts";
import { detectNativeWrappersTool } from "../../src/mcp/tool-detect-wrappers.ts";
import { posixJoin } from "../helpers/path.ts";

interface DetectResponse {
  readonly candidates: readonly unknown[];
  readonly projectKind: string;
  readonly inapplicable?: {
    readonly reason: string;
    readonly filesByExtension: Readonly<Record<string, number>>;
  };
  readonly emptyReason?: string;
  readonly opaqueCustomComponentNames?: readonly string[];
  readonly absentDeclaredWrappers?: readonly string[];
  readonly suggestedConfigSnippet?: string;
}

interface BootstrapResponse {
  readonly wrappers: DetectResponse;
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-bootstrap-detect-shape-parity-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function callDetect(dir: string): Promise<DetectResponse> {
  const session = new McpSession();
  const result = await detectNativeWrappersTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as DetectResponse;
}

async function callBootstrap(dir: string): Promise<BootstrapResponse> {
  const session = new McpSession();
  const result = await bootstrapTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as BootstrapResponse;
}

/**
 * Per-field equality check: every discriminator the upstream surface
 * ships must land on the bootstrap subset with the same value. Field
 * absence is itself the signal — when the upstream omits `emptyReason`
 * (because candidates is non-empty), bootstrap must also omit it; the
 * reverse case is the silent-miss the closure exists to prevent.
 */
function expectWrappersShapeParity(boot: DetectResponse, detect: DetectResponse): void {
  // `candidates` and `projectKind` are always present on both
  // surfaces — schema-required fields per the present-when-meaningful
  // rules.
  expect(boot.candidates).toEqual(detect.candidates);
  expect(boot.projectKind).toBe(detect.projectKind);

  // Optional fields: presence on bootstrap matches presence on
  // detect. `key in obj` distinguishes "field omitted entirely" from
  // "field present with falsy value" — the discriminator the agent
  // reads must agree at the structural level.
  const optionalFields: readonly (keyof DetectResponse)[] = [
    "inapplicable",
    "emptyReason",
    "opaqueCustomComponentNames",
    "absentDeclaredWrappers",
    "suggestedConfigSnippet",
  ];
  for (const key of optionalFields) {
    const bootHas = key in boot;
    const detectHas = key in detect;
    expect(bootHas).toBe(detectHas);
    if (bootHas && detectHas) {
      expect(boot[key]).toEqual(detect[key]);
    }
  }
}

describe("bootstrap.wrappers vs detect_native_wrappers: shape parity", () => {
  it("forwards candidates + projectKind + suggestedConfigSnippet on a JSX tree with PascalCase+onClick wrappers", async () => {
    await withScratch(async (dir) => {
      // PascalCase + onClick → populated candidates, projectKind: "jsx".
      // No empty-branch discriminators on this branch.
      await writeFile(
        posixJoin(dir, "app.tsx"),
        [
          "export function App() {",
          "  return (",
          "    <>",
          "      <ActionButton onClick={a} />",
          "      <Card onClick={b} />",
          "    </>",
          "  );",
          "}",
        ].join("\n"),
      );
      const detect = await callDetect(dir);
      const boot = await callBootstrap(dir);
      // Sanity that the fixture exercises the populated-candidates
      // branch — the parity check would pass vacuously on an empty
      // tree.
      expect(detect.candidates.length).toBeGreaterThan(0);
      expect(detect.projectKind).toBe("jsx");
      expect(detect.emptyReason).toBeUndefined();
      expect(detect.inapplicable).toBeUndefined();
      expectWrappersShapeParity(boot.wrappers, detect);
    });
  });

  it("forwards emptyReason: no-pascalcase-onclick-components when JSX has no PascalCase tags", async () => {
    await withScratch(async (dir) => {
      // `.tsx` with no PascalCase tags → projectKind "jsx",
      // emptyReason set, no opaqueCustomComponentNames (no PascalCase
      // sighted).
      await writeFile(
        posixJoin(dir, "app.tsx"),
        ["export function App() {", "  return <div>plain content</div>;", "}"].join("\n"),
      );
      const detect = await callDetect(dir);
      const boot = await callBootstrap(dir);
      expect(detect.candidates).toEqual([]);
      expect(detect.projectKind).toBe("jsx");
      expect(detect.emptyReason).toBe("no-pascalcase-onclick-components");
      expectWrappersShapeParity(boot.wrappers, detect);
    });
  });

  it("forwards inapplicable block + projectKind on a static-site tree (no JSX in scan)", async () => {
    await withScratch(async (dir) => {
      // HTML-only tree → upstream emits `inapplicable: { reason:
      // "no_jsx_in_tree", filesByExtension }`, projectKind:
      // "static-site". The `inapplicable` block is the discriminator
      // the regression dropped — the silent-miss it forced was the
      // canonical case.
      await writeFile(
        posixJoin(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>x</p></body></html>\n',
      );
      const detect = await callDetect(dir);
      const boot = await callBootstrap(dir);
      expect(detect.candidates).toEqual([]);
      expect(detect.projectKind).toBe("static-site");
      expect(detect.inapplicable).toBeDefined();
      expect(detect.inapplicable?.reason).toBe("no_jsx_in_tree");
      expectWrappersShapeParity(boot.wrappers, detect);
    });
  });

  it("forwards opaqueCustomComponentNames when JSX has PascalCase but no onClick handlers", async () => {
    await withScratch(async (dir) => {
      // PascalCase components without the detector's required
      // onClick / controlled-input props → empty candidates +
      // emptyReason: "no-jsx-onclick-candidates-found-but-opaque-
      // components-present" + the inlined `opaqueCustomComponentNames`
      // inventory. This is the branch where the bootstrap surface
      // dropping the inventory forces a follow-up `scan_project`
      // call to read the same names.
      await writeFile(
        posixJoin(dir, "app.tsx"),
        [
          "export function App() {",
          "  return (",
          "    <>",
          '      <Hero title="t" />',
          '      <Card body="b" />',
          "    </>",
          "  );",
          "}",
        ].join("\n"),
      );
      const detect = await callDetect(dir);
      const boot = await callBootstrap(dir);
      expect(detect.candidates).toEqual([]);
      expect(detect.projectKind).toBe("jsx");
      expect(detect.emptyReason).toBe(
        "no-jsx-onclick-candidates-found-but-opaque-components-present",
      );
      expect(detect.opaqueCustomComponentNames).toBeDefined();
      expect((detect.opaqueCustomComponentNames ?? []).length).toBeGreaterThan(0);
      expectWrappersShapeParity(boot.wrappers, detect);
    });
  });
});
