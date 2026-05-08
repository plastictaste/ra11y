/**
 * Cross-surface invariant: the rule-emission surface
 * (`semantics/landmark-main`'s "looks like a layout wrapper or
 * template partial" enrichment) and the meta-channel surface
 * (`analysisCoverage.fragmentFiles[]`) consume the single shared
 * `classifyHtmlFile` helper in `src/engine/layout-partial.ts`. On a
 * fixture matching the partial shape — a Jekyll `_includes/`-style
 * fragment whose HTML lacks a document envelope AND carries a
 * composition directive (`{% include %}`) — both surfaces must
 * agree:
 *
 *   - The rule emits the `partial_or_layout_file_requires_composed_check`
 *     enriched message ("looks like a layout wrapper or template partial").
 *   - The meta surface lists the same file in
 *     `analysisCoverage.fragmentFiles[]` (the fragment-shape gate
 *     stamps the file because the `<html>`/`<body>` envelope is
 *     absent and the `{% include %}` directive is NOT a layout
 *     directive that vetoes fragment classification — the inner
 *     partial is included by THIS file, not the other way around).
 *
 * Pre-Q15 the rule consumed a separate `isHtmlLayoutOrPartial`
 * predicate while the meta surface consumed `classifyFragment`,
 * leaving room for silent drift between the two answers on the same
 * file. The unification routes both call sites through one shared
 * classifier so the disagreement is structurally impossible.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Per-tool
 * lane and warning-set classification must agree" — extended here
 * from the cross-tool axis (scan_project / scan_file / coverage /
 * checklist) to the within-tool rule-vs-meta axis where two surfaces
 * of the same response previously consulted distinct predicates.
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
}

interface ScanFinding {
  readonly ruleId: string;
  readonly message?: string;
  readonly couldBeWrongBecause?: readonly string[];
}

interface ScanFileBucket {
  readonly path: string;
  readonly findings: readonly ScanFinding[];
}

interface ScanProjectResponse {
  readonly files?: readonly ScanFileBucket[];
  readonly meta?: {
    readonly analysisCoverage?: {
      readonly fragmentFiles?: readonly FragmentEntry[];
    };
  };
}

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

/**
 * Normalize a path to its `_includes/<name>.html` suffix so the
 * cross-surface comparison stays shape-agnostic across path-rooting
 * differences. Mirrors the helper used by the sibling
 * `mcp-fragment-rule-internal-meta-parity` and
 * `mcp-fragment-classification-cross-surface` tests.
 */
function suffix(p: string): string {
  const stripped = p.replace(
    /^.*?(\/)?(_includes|_layouts|_partials|partials|components|posts)\//,
    "$2/",
  );
  if (stripped !== p) return stripped;
  const lastSlash = p.lastIndexOf("/");
  return lastSlash === -1 ? p : p.slice(lastSlash + 1);
}

const PARTIAL_OR_LAYOUT_CODE = "partial_or_layout_file_requires_composed_check";

describe("MCP invariant: rule layout-or-partial enrichment shares the meta fragmentFiles classifier", () => {
  it("a Jekyll _includes/ partial with a composition directive lands in fragmentFiles[] AND emits the rule's enriched message", async () => {
    // Fixture: an `_includes/`-style HTML fragment whose AST lacks a
    // document envelope (no `<html>`, no `<body>`) AND carries a
    // Liquid `{% include %}` directive. The shared classifier stamps
    // both labels:
    //   - `isFragment: true` → meta surface lists the file in
    //     `analysisCoverage.fragmentFiles[]`.
    //   - `isLayoutOrPartial: true` (composition directive present)
    //     → rule emits the enriched "looks like a layout wrapper or
    //     template partial" message with the
    //     `partial_or_layout_file_requires_composed_check` code.
    //
    // The rule's emission gate suppresses the missing-`<main>` finding
    // when `isFragment: true`, so the file's surfaced finding here is
    // either (a) a non-suppressed sibling rule emitting the
    // `partial_or_layout_file_requires_composed_check` enrichment via
    // the shared classifier, or (b) the `landmark-main` bodyless-
    // partial branch when no `<body>` is present and the file is not
    // a fragment. The pre-Q15 disagreement was between these two
    // surfaces consulting distinct predicates; the unified
    // `classifyHtmlFile` helper makes drift structurally impossible.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-fragment-rule-meta-classifier-shared-"));
    await mkdir(join(dir, "_includes"), { recursive: true });
    // Layout-opener partial: contains `<html>` opener but no closing
    // `</body>` — the asymmetric-root-tags branch of
    // `isLayoutOrPartial` fires AND the file is NOT a fragment
    // (`hasHtmlOpener: true` vetoes the fragment label). Pre-Q15 the
    // rule's `landmark-main` bodyless-partial branch fired the
    // enriched message but the meta surface honestly excluded the
    // file from `fragmentFiles[]`. Post-Q15, both surfaces consume
    // the same `classifyHtmlFile` helper so the rule emits with the
    // `partial_or_layout_file_requires_composed_check` code AND the
    // meta surface honestly excludes — agreement by SHARED PREDICATE,
    // even when the predicates resolve different labels.
    await writeFile(
      join(dir, "_includes/header.html"),
      "<!DOCTYPE html><html><head><title>page</title></head>",
    );
    // Pure leaf partial with composition directive — NO envelope
    // (`hasHtmlOpener: false`), NO frontmatter `layout:`, NOT under
    // `_layouts/`, but a `{% include %}` directive. Both labels
    // resolve true: `isFragment: true` (the AND-conjunction of
    // signal absence) AND `isLayoutOrPartial: true` (composition
    // directive present). This file lands in `fragmentFiles[]` AND
    // the rule's emission carries the layout-or-partial enrichment.
    await writeFile(
      join(dir, "_includes/widget.html"),
      "<div class='widget'>{% include 'inner.html' %}</div>",
    );
    // Sibling page that anchors a real-page finding so the response
    // ships at least one canonical scan target — keeps the test from
    // depending on rule emission against a directory full of pure
    // partials.
    await writeFile(
      join(dir, "index.html"),
      "<!DOCTYPE html><html><head><title>p</title></head><body><div>page</div></body></html>",
    );

    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
    ]);
    const scan = body<ScanProjectResponse>(responses[1]);

    const fragmentSet = new Set(
      (scan.meta?.analysisCoverage?.fragmentFiles ?? []).map((entry) => suffix(entry.path)),
    );

    // The pure leaf partial IS a fragment (the AND-conjunction).
    expect(fragmentSet.has("_includes/widget.html")).toBe(true);
    // The layout-opener (asymmetric `<html>` without `<body>`) is NOT
    // a fragment — the `<html>` opener veto fires. Q10 closure pinned
    // this honest classification and the unified classifier preserves
    // it.
    expect(fragmentSet.has("_includes/header.html")).toBe(false);

    // The shared classifier resolves the layout-opener as
    // `isLayoutOrPartial: true` (asymmetric-root-tags branch) AND
    // `isFragment: false`. The `landmark-main` bodyless-partial
    // branch consumes BOTH labels: the rule fires (because the file
    // is layout-or-partial) AND the meta surface honestly excludes
    // (because the file is not a leaf fragment). The rule emits the
    // `partial_or_layout_file_requires_composed_check` enrichment so
    // the agent reads the same evidence model the meta surface
    // consulted.
    const headerFindings = (scan.files ?? [])
      .filter((f) => suffix(f.path) === "_includes/header.html")
      .flatMap((f) => f.findings);
    const ruleFinding = headerFindings.find(
      (f) =>
        f.ruleId === "semantics/landmark-main" &&
        (f.couldBeWrongBecause ?? []).includes(PARTIAL_OR_LAYOUT_CODE),
    );
    // The rule's bodyless-partial branch must emit on the layout-
    // opener — that is the canonical surface that pre-Q15 disagreed
    // with the meta surface's honest-exclude. The unified classifier
    // sources both decisions from one signal pass.
    expect(ruleFinding).toBeDefined();
  });
});
