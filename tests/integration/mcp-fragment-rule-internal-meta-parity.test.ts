/**
 * Cross-layer invariant: in any single MCP response, per-finding
 * `couldBeWrongBecause` containing `fragment_input_no_document_envelope`
 * must agree with `meta.analysisCoverage.fragmentFiles[]` on which
 * files are fragments. The rule-internal classification (each rule
 * computes `isFragmentFile(doc, source, filePath)` per emission) and
 * the meta-level classification (the analysis-coverage builder runs
 * the same `classifyFragment` over every parsed HTML file) must
 * resolve to the same set on the same scan — drift between them is
 * silent: an agent reading the per-finding code on a finding from a
 * full `.html` document concludes the file lacks a document envelope,
 * while the meta surface lists only an unrelated markdown-residue
 * file as fragment.
 *
 * Closure path Q13: the per-finding propagation helper
 * (`src/mcp/per-finding-confidence-parity.ts`) gates
 * `fragment_input_no_document_envelope` on file-path membership in
 * the same fragment set the meta surface ships, so a finding on a
 * non-fragment file never carries the code as collateral. Both
 * surfaces consume the single shared classifier in
 * `src/engine/layout-partial.ts`.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md`
 *   - "Heuristic-mislabeled meta sub-fields are dishonest"
 *   - "Per-finding confidence must reflect per-rule coverage limitations"
 *   - "Cross-surface count invariant" (extended to the within-response
 *     rule-internal-vs-meta-level axis).
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

const FRAGMENT_CODE = "fragment_input_no_document_envelope";

/**
 * Normalizes paths from different rootings to a logical key. Different
 * MCP surfaces ship paths with different rootings (project-relative
 * `index.html`, absolute `/tmp/.../index.html`); the comparison only
 * cares about the fixture-distinguishing suffix. Mirrors the pattern
 * used by `mcp-fragment-classification-cross-surface.test.ts`.
 */
function suffix(p: string): string {
  // Trim well-known fixture-root markers down to the segment that
  // distinguishes the file in the fixture (`_includes/admonition.html`,
  // `posts/welcome.md`, `index.html`).
  const stripped = p.replace(
    /^.*?(\/)?(_includes|_layouts|_partials|partials|components|posts)\//,
    "$2/",
  );
  if (stripped !== p) return stripped;
  // Fall back to last segment for top-level files (`index.html`).
  const lastSlash = p.lastIndexOf("/");
  return lastSlash === -1 ? p : p.slice(lastSlash + 1);
}

/**
 * Returns every (file-path-suffix, ruleId) pair where a finding ships
 * `fragment_input_no_document_envelope` on a file NOT in `fragmentSet`
 * — the Q13 regression shape. Empty array means rule-internal
 * classification agrees with meta-level classification across the
 * whole response.
 */
function collectFragmentCodeOffenders(
  files: readonly ScanFileBucket[] | undefined,
  fragmentSet: ReadonlySet<string>,
): { readonly path: string; readonly ruleId: string }[] {
  const offenders: { readonly path: string; readonly ruleId: string }[] = [];
  for (const file of files ?? []) {
    const filePathSuffix = suffix(file.path);
    if (fragmentSet.has(filePathSuffix)) continue;
    for (const finding of file.findings) {
      if (finding.couldBeWrongBecause?.includes(FRAGMENT_CODE)) {
        offenders.push({ path: filePathSuffix, ruleId: finding.ruleId });
      }
    }
  }
  return offenders;
}

describe("MCP invariant: rule-internal fragment code agrees with meta fragmentFiles[]", () => {
  it("findings carrying fragment_input_no_document_envelope come only from files in fragmentFiles[]", async () => {
    // Build a fixture where the rule-internal fragment-emitting rules
    // (`semantics/table-caption-missing`, `aria/role-from-class-only`)
    // would fire on multiple HTML-family files of mixed fragment
    // status. The Q13 regression: a finding on the full-page `.html`
    // file silently carried the fragment code while
    // `analysisCoverage.fragmentFiles[]` listed only the markdown-
    // residue file.
    //
    //   - `_includes/admonition.html`: fragment partial — no `<html>`,
    //     no layout directive, not under `_layouts/` (the canonical
    //     Jekyll partial shape). Carries an admonition-class div with
    //     a stripped Liquid directive so `aria/role-from-class-only`
    //     fires here.
    //   - `index.html`: full-page document — has `<html>` opener so
    //     the shared classifier vetoes the fragment label. Carries a
    //     bare admonition-class div so `aria/role-from-class-only`
    //     fires here too. This is the canonical case the Q13 bug
    //     names.
    //   - `posts/welcome.md`: markdown source routed through
    //     `parseMarkdown` per ADR 0025. Fragment-classified
    //     (markdown_residue kind).
    const dir = await mkdtemp(join(tmpdir(), "ra11y-fragment-rule-internal-meta-"));
    await mkdir(join(dir, "_includes"), { recursive: true });
    await mkdir(join(dir, "posts"), { recursive: true });

    // Fragment partial — exercises the rule-internal AND-conjunction
    // (no <html>, no layout directive, not in layouts dir → fragment).
    await writeFile(
      join(dir, "_includes/admonition.html"),
      '<div class="warning">{{ severity }} body content goes here.</div>',
    );

    // Full-page document with the same admonition shape — the rule
    // fires on the same predicate but the shared classifier vetoes
    // the fragment label via the `<html>` opener. Pre-Q13, the
    // finding here silently carried `fragment_input_no_document_envelope`
    // because the per-rule downgrade propagated corpus-wide.
    await writeFile(
      join(dir, "index.html"),
      '<!DOCTYPE html><html><head><title>p</title></head><body><main><div class="warning">Restart required.</div></main></body></html>',
    );

    // Markdown residue — fragment-classified at the meta level.
    await writeFile(join(dir, "posts/welcome.md"), "---\n---\n# Hello\n\nWorld\n");

    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
    ]);
    const scan = body<ScanProjectResponse>(responses[1]);

    const fragmentSet = new Set(
      (scan.meta?.analysisCoverage?.fragmentFiles ?? []).map((entry) => suffix(entry.path)),
    );

    // The fixture is constructed so the meta surface classifies the
    // partial and the markdown file as fragments and leaves the full
    // document outside the set. Spot-check the meta side first so the
    // per-finding assertion below doesn't silently pass on an empty
    // meta set.
    expect(fragmentSet.has("_includes/admonition.html")).toBe(true);
    expect(fragmentSet.has("index.html")).toBe(false);

    // The fixture must produce at least one finding on the full
    // `index.html` document for the assertion below to be meaningful
    // — `document/lang-attribute` fires on the missing `lang=` and
    // is exactly the rule the per-rule fragment-input downgrade
    // applies to (it sits in the document-shaped FRAGMENT_DOWNGRADE
    // rule set), so its finding is the canonical case the regression
    // would surface on. A vacuously-passing assertion below would hide
    // the bug. (See `aria-first-consumer.md` "Per-finding confidence
    // must reflect per-rule coverage limitations.")
    const indexFindings = (scan.files ?? []).find((f) => suffix(f.path) === "index.html");
    expect(indexFindings).toBeDefined();
    expect(indexFindings?.findings.some((f) => f.ruleId === "document/lang-attribute")).toBe(true);

    // The invariant Q13 closes: `fragment_input_no_document_envelope`
    // may only attach to a finding whose file is in `fragmentSet`. A
    // finding on `index.html` carrying the code would be the canonical
    // regression — rule-internal classification disagreeing with the
    // meta surface in the same response.
    expect(collectFragmentCodeOffenders(scan.files, fragmentSet)).toEqual([]);
  });

  it("findings on a fragment-classified file may still carry the code (rule-internal emit honored)", async () => {
    // Companion to the above: when the file IS in `fragmentFiles[]`,
    // a rule-internal emit of `fragment_input_no_document_envelope`
    // (e.g. `aria/role-from-class-only` on a fragment+template host)
    // must remain on the finding — the file-scoped gate denies only
    // the cross-file collateral attribution, not the rule's honest
    // self-classification. This pins that the gate doesn't over-strip.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-fragment-rule-internal-honored-"));
    await mkdir(join(dir, "_includes"), { recursive: true });
    // Fragment + template host: the rule-internal AND of `isFragmentFile`
    // and `htmlDocumentHasTemplateDirective` fires here, so the rule
    // itself emits `fragment_input_no_document_envelope` on the
    // finding before any cross-rule propagation runs.
    await writeFile(
      join(dir, "_includes/admonition.html"),
      '<div class="warning">{{ severity }} restart required.</div>',
    );

    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
    ]);
    const scan = body<ScanProjectResponse>(responses[1]);

    const fragmentSet = new Set(
      (scan.meta?.analysisCoverage?.fragmentFiles ?? []).map((entry) => suffix(entry.path)),
    );
    expect(fragmentSet.has("_includes/admonition.html")).toBe(true);

    // The fragment+template host is the canonical Q13-doctrine case
    // where the rule-internal emit of the code is honest. The gate
    // must not strip it.
    const fragmentFinding = (scan.files ?? [])
      .filter((f) => suffix(f.path) === "_includes/admonition.html")
      .flatMap((f) => f.findings)
      .find((finding) => finding.couldBeWrongBecause?.includes(FRAGMENT_CODE));
    expect(fragmentFinding).toBeDefined();
  });
});
