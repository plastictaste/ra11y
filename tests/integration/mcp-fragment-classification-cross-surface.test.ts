/**
 * Cross-surface invariant: every project-rooted MCP tool that consumes
 * the same fragment classification (scan_project, scan_file, coverage,
 * checklist) must produce the same `analysisCoverage.fragmentFiles[]`
 * shape on identical input. Drift here is silent — an agent calling
 * one tool gets a different fragment set than another, and the per-
 * rule confidence-downgrade for document-shaped rules silently
 * disagrees.
 *
 * The shared classifier in `src/engine/layout-partial.ts` is the single
 * source of truth; this test confirms every consumer routes through it.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Cross-surface
 * count invariant" (extended to fragment classification per the Q9
 * closure) and "Heuristic-mislabeled meta sub-fields are dishonest"
 * (per Q10 — full-page layouts must not silently classify as
 * fragments).
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  proc.stdin.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

const initMsg = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});
const toolCall = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

interface FragmentEntry {
  readonly path: string;
  readonly kind: string;
  readonly fragmentClassificationSignals?: {
    readonly hasHtmlOpener: boolean;
    readonly hasLayoutDirective: boolean;
    readonly inLayoutsDir: boolean;
  };
}

interface FragmentBlock {
  readonly fragmentFileCount?: number;
  readonly fragmentFiles?: readonly FragmentEntry[];
}

interface FragmentEnvelope {
  // `scan_project` and `scan_file` ship `analysisCoverage` under
  // `meta.analysisCoverage`; `coverage` and `checklist` lift it to the
  // top level (mirror of how `analysisCoverage` already escapes the
  // meta block on those tools per their tool-handler comments).
  // Normalize via {@link analysisCoverageOf} below.
  readonly meta?: {
    readonly analysisCoverage?: FragmentBlock;
  };
  readonly analysisCoverage?: FragmentBlock;
}

function analysisCoverageOf(env: FragmentEnvelope): FragmentBlock | undefined {
  return env.meta?.analysisCoverage ?? env.analysisCoverage;
}

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

function fragmentPaths(env: FragmentEnvelope): readonly string[] {
  // Different MCP surfaces ship paths with different rooting:
  // scan_project surfaces project-relative paths, scan_file surfaces
  // the resolved absolute path it scanned. Normalize to basename-
  // segments so the cross-surface comparison stays shape-agnostic.
  return [...(analysisCoverageOf(env)?.fragmentFiles ?? [])]
    .map((entry) =>
      entry.path.replace(
        /^.*?(\/)?(_includes|_layouts|_partials|partials|components|posts)\//,
        "$2/",
      ),
    )
    .sort();
}

describe("MCP invariant: fragment classification agrees across surfaces", () => {
  it("scan_project, coverage, checklist agree on fragmentFiles[] for a Jekyll-shape corpus", async () => {
    // Build a fixture combining the canonical fragment shapes the
    // shared classifier must agree on across every surface:
    //   - `_includes/header.html`: bare partial, no `<html>`, no
    //     layout directive, not in layouts dir → fragment.
    //   - `_layouts/default.html`: full-page layout with `<html>`
    //     opener AND `{{ content }}` directive AND in layouts dir →
    //     NOT a fragment (Q10 closure: was previously over-stamped).
    //   - `index.html`: self-contained page with `<html>` → NOT a
    //     fragment.
    //   - `posts/welcome.md`: front-matter declaring `layout: post`
    //     (a child-role layout-composition directive) → NOT a
    //     fragment. The shared classifier extends `hasLayoutDirective`
    //     to fire on frontmatter `layout:` / `permalink:` keys so the
    //     meta entry reports the evidence honestly (the parent layout
    //     supplies the envelope; the file is part of a multi-file
    //     layout system, not a leaf fragment).
    const dir = await mkdtemp(join(tmpdir(), "ra11y-fragment-cross-surface-"));
    await mkdir(join(dir, "_includes"), { recursive: true });
    await mkdir(join(dir, "_layouts"), { recursive: true });
    await mkdir(join(dir, "posts"), { recursive: true });
    await writeFile(
      join(dir, "_includes/header.html"),
      '<header><nav><a href="/">Home</a></nav></header>',
    );
    await writeFile(
      join(dir, "_layouts/default.html"),
      "---\n---\n<!DOCTYPE html><html><head><title>p</title></head><body><main>{{ content }}</main></body></html>",
    );
    await writeFile(
      join(dir, "index.html"),
      "<!DOCTYPE html><html><head><title>p</title></head><body><main><h1>Hi</h1></main></body></html>",
    );
    await writeFile(join(dir, "posts/welcome.md"), "---\nlayout: post\n---\n# Hello\n\nWorld\n");

    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
      toolCall(3, "coverage", { cwd: dir, verboseMeta: true }),
      toolCall(4, "checklist", { cwd: dir, verboseMeta: true }),
    ]);
    const scanProject = body<FragmentEnvelope>(responses[1]);
    const coverage = body<FragmentEnvelope>(responses[2]);
    const checklist = body<FragmentEnvelope>(responses[3]);

    const scanPaths = fragmentPaths(scanProject);
    const coveragePaths = fragmentPaths(coverage);
    const checklistPaths = fragmentPaths(checklist);

    // Every consumer reports the same fragment file set. Drift is
    // silent: the agent reads one surface's headline, trusts it, and
    // the next tool's count disagrees only when the agent calls it.
    expect(coveragePaths).toEqual(scanPaths);
    expect(checklistPaths).toEqual(scanPaths);

    // Q10 closure: the full-page layout with `<html>` + `{{ content }}`
    // + in `_layouts/` must NOT be classified as a fragment on any
    // surface. The prior OR-branch predicate stamped fragment via the
    // front-matter delimiter alone; the AND-conjunction respects the
    // `<html>` opener as a positive page signal.
    expect(scanPaths).not.toContain("_layouts/default.html");

    // The bare include partial IS a fragment on every surface — its
    // structural / source / path signals all align with the predicate.
    expect(scanPaths).toContain("_includes/header.html");

    // The Jekyll post with `--- layout: post ---` frontmatter must
    // NOT be classified as a fragment on any surface. The frontmatter
    // declares a child-role layout directive — the file participates
    // in a multi-file layout system, so the meta entry reports the
    // composition evidence honestly via `hasLayoutDirective: true`
    // and document-shape rules surface findings rather than silently
    // suppressing.
    expect(scanPaths).not.toContain("posts/welcome.md");
  });

  it("scan_file agrees with scan_project on the same `_includes/` fragment file", async () => {
    // Q9 closure: scan_file and scan_project must report the same
    // fragment classification on the same file. Prior to the shared
    // classifier the two surfaces could disagree on edge cases (e.g.
    // when the scan-time substrate or rule-side suppression diverged
    // from the meta-side telemetry list).
    const dir = await mkdtemp(join(tmpdir(), "ra11y-fragment-scan-file-parity-"));
    await mkdir(join(dir, "_includes"), { recursive: true });
    await writeFile(
      join(dir, "_includes/header.html"),
      '<header><nav><a href="/">Home</a></nav></header>',
    );

    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
      toolCall(3, "scan_file", {
        path: "_includes/header.html",
        cwd: dir,
        verboseMeta: true,
      }),
    ]);
    const scanProject = body<FragmentEnvelope>(responses[1]);
    const scanFile = body<FragmentEnvelope>(responses[2]);

    // Both surfaces classify the partial as a fragment.
    expect(fragmentPaths(scanProject)).toContain("_includes/header.html");
    const scanFileBlock = analysisCoverageOf(scanFile);
    expect(scanFileBlock?.fragmentFiles).toBeDefined();
    expect(scanFileBlock?.fragmentFiles?.length).toBeGreaterThan(0);
    const scanFileEntry = scanFileBlock?.fragmentFiles?.[0];
    // scan_file's path may be absolute (the tool resolves the path
    // against cwd before scanning); check the suffix to keep the
    // comparison shape-agnostic.
    expect(scanFileEntry?.path.endsWith("_includes/header.html")).toBe(true);

    // Both surfaces surface the same structural-signal evidence —
    // every signal is `false` (the AND-conjunction stamped fragment)
    // and the kind is `layout_include_partial` (the recognized SSG
    // include path AND fragment-shape gate fires).
    const scanProjectEntry = analysisCoverageOf(scanProject)?.fragmentFiles?.find((e) =>
      e.path.endsWith("_includes/header.html"),
    );
    expect(scanProjectEntry?.kind).toBe("layout_include_partial");
    expect(scanFileEntry?.kind).toBe("layout_include_partial");
    expect(scanProjectEntry?.fragmentClassificationSignals).toEqual({
      hasHtmlOpener: false,
      hasLayoutDirective: false,
      inLayoutsDir: false,
    });
    expect(scanFileEntry?.fragmentClassificationSignals).toEqual({
      hasHtmlOpener: false,
      hasLayoutDirective: false,
      inLayoutsDir: false,
    });
  });
});
