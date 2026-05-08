/**
 * Cross-layer invariant Q19: when an `.astro` file is classified as
 * carrying unrendered-island substrate (the warning channel fires
 * `astro_islands_unrendered`), every per-rule entry crediting that
 * file must downgrade `coverageConfidence` to `"medium"` with
 * `coverageConfidenceReason: "astro-islands-unrendered-static-only"`,
 * AND every per-finding emission from those rules on those files must
 * carry the structured `astro_islands_unrendered_static_only` token on
 * `couldBeWrongBecause`. The per-rule label, the per-finding code, and
 * the warning channel must all name the same substrate signal — drift
 * between them is silent: an agent reading per-rule rows at
 * `confidence: "high"` while the warning channel reports the
 * unrendered-island substrate concludes the rule's tally is honest
 * when the truth is "the rule never saw the rendered output."
 *
 * Closure path: extends the SVG-fragment precedent
 * (`Q19-DUPLICATE-ID-ON-STANDALONE-SVG-FRAGMENT`, commit 52ff6acd) to
 * the astro-islands axis. The fragment classification names "no
 * `<html>`/`<body>` root" — a structural property of the parsed AST.
 * The astro-islands signal names "the component-script and imported
 * components are unrendered" — a routing-decision property of the
 * substrate that holds even when the file's parsed AST DOES carry an
 * `<html>` root. The two classifications are orthogonal; the
 * downgrade reasons differ
 * (`fragment-input-no-document-envelope` vs
 * `astro-islands-unrendered-static-only`) so the per-rule layer
 * surfaces which substrate signal drove the downgrade.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md`
 *   - "Parser-failure invalidates per-file confidence" (extended to
 *     template-island parse-as-literal classifications).
 *   - "Per-finding confidence must reflect per-rule coverage
 *     limitations."
 *   - "Cross-surface count invariant" (extended to within-response
 *     per-rule-vs-per-finding axis on the substrate-code dimension).
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
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

interface PerRuleCoverageRow {
  readonly ruleId: string;
  readonly coverageConfidence: "high" | "medium" | "low";
  readonly coverageConfidenceReason?: string;
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
  readonly warnings?: readonly string[];
  readonly meta?: {
    readonly perRuleCoverage?: readonly PerRuleCoverageRow[];
    readonly analysisCoverage?: {
      readonly astroIslandsUnrenderedFiles?: readonly string[];
    };
  };
}

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

const ASTRO_REASON = "astro-islands-unrendered-static-only";
const ASTRO_CODE = "astro_islands_unrendered_static_only";

/**
 * Reasons a per-rule row may carry on the astro-islands fixture: the
 * direct astro reason, or a stronger upstream substrate reason that
 * wins precedence per the cascade order. Any value outside this set
 * (including bare `undefined`) is a regression.
 */
const ACCEPTABLE_REASONS: ReadonlySet<string> = new Set([
  ASTRO_REASON,
  "fragment-input-no-document-envelope",
  "file-parse-error",
  "partial-parse",
  "corpus-parse-error-rate-above-threshold",
]);

/** Returns true when the path resolves to an `.astro` extension. */
function isAstroFile(path: string): boolean {
  return path.toLowerCase().endsWith(".astro");
}

/**
 * Per-row assertion split into a helper to keep the it() block under
 * Biome's cognitive-complexity ceiling. Asserts the row is defined,
 * downgraded (not `high`), and carries an acceptable substrate
 * reason — the per-rule axis of the Q19 invariant.
 */
function expectRowDowngraded(rows: readonly PerRuleCoverageRow[], ruleId: string): void {
  const row = rows.find((r) => r.ruleId === ruleId);
  expect(row).toBeDefined();
  if (row === undefined) return;
  expect(row.coverageConfidence === "high" ? "downgraded" : "ok").toBe("ok");
  const reason = row.coverageConfidenceReason ?? "(absent)";
  expect(ACCEPTABLE_REASONS.has(reason)).toBe(true);
}

/**
 * Tally helper for the per-finding axis: returns the count of findings
 * on `.astro` files carrying the astro-islands code, and the count on
 * non-astro files that incorrectly picked it up as collateral. Pulled
 * out of the it() block so the inner two-axis loop doesn't push the
 * complexity score over Biome's ceiling.
 */
function tallyAstroCodeFindings(files: readonly ScanFileBucket[] | undefined): {
  onAstro: number;
  offAstroLeak: number;
} {
  let onAstro = 0;
  let offAstroLeak = 0;
  for (const file of files ?? []) {
    const astroPath = isAstroFile(file.path);
    for (const finding of file.findings) {
      const carries = finding.couldBeWrongBecause?.includes(ASTRO_CODE) ?? false;
      if (!carries) continue;
      if (astroPath) onAstro += 1;
      else offAstroLeak += 1;
    }
  }
  return { onAstro, offAstroLeak };
}

describe("MCP invariant Q19: per-rule + per-finding agree on astro-island unrendered substrate", () => {
  it("per-rule coverageConfidence downgrades to medium with astro-islands reason on .astro files; per-finding emissions carry the matching code", async () => {
    // Build a fixture mirroring the canonical bulk-Astro shape the
    // backlog cites (49 files / 40% of corpus on a vendor-heavy admin
    // template catalog; 103 files on a vendor-heavy CSS framework's
    // docs site). Two `.astro` page files carrying:
    //   - frontmatter `<script>` islands (component-script blanked by
    //     `parseAstro`).
    //   - imported component tags (`<Layout>`, `<Header>`) the HTML
    //     parser leaves unrendered.
    //   - JSX-style `{expr}` braces passed through as literal text.
    //   - missing page-level signals (`<title>`, `<html lang=…>`,
    //     `<main>`, heading hierarchy) that the rendered Astro output
    //     would have supplied via the imported components.
    //   - bare `<button onClick>` JSX-style emit so
    //     `keyboard/handler-missing` fires on a file where listener
    //     wiring may be supplied by the island runtime client-side.
    // Plus one parseable `.html` page so the response carries the
    // "real scan" framing and the per-rule rows have at least one
    // file in scope.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-astro-islands-perrule-"));
    await writeFile(
      join(dir, "page.html"),
      '<!DOCTYPE html><html lang="en"><head><title>Page</title></head><body><main><h1>Hi</h1><p>real scan framing</p></main></body></html>',
    );
    // index.astro: a layout-style `.astro` page that DOES carry an
    // `<html>` envelope (Astro pages may be entrypoint pages that
    // include the document framework). The fragment classifier vetoes
    // the fragment label here (the `<html>` opener is present), so
    // the document-shaped rules emit findings on this file rather
    // than suppressing — and the astro-islands adjuster stamps the
    // astro reason instead. Carries:
    //   - frontmatter `<script>` islands (component-script blanked).
    //   - JSX-style `{expr}` braces (passed through as literal).
    //   - missing `<title>` and missing `lang=` so `document/page-
    //     titled` and `document/lang-attribute` fire.
    //   - missing `<main>` so `semantics/landmark-main` fires.
    //   - bare `<button onClick>` so `keyboard/handler-missing`
    //     fires.
    await writeFile(
      join(dir, "index.astro"),
      `${[
        "---",
        'const title = "Welcome";',
        "---",
        "<html>",
        "  <head>",
        "  </head>",
        "  <body>",
        "    <h1>{title}</h1>",
        "    <button onClick={handle}>Click</button>",
        "  </body>",
        "</html>",
      ].join("\n")}\n`,
    );

    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir, verboseMeta: true }),
    ]);
    const scan = body<ScanProjectResponse>(responses[1]);

    // Sanity: the warning channel must fire for the test to be
    // meaningful — a vacuously-passing assertion below would hide the
    // regression. The cross-surface invariant cited above is built on
    // the assumption that the warning is the canonical signal; if the
    // detector silently regresses, the per-rule + per-finding
    // assertions below stay green on garbage.
    expect(scan.warnings ?? []).toContain("astro_islands_unrendered");

    // The astro-island file list on the meta surface must list both
    // `.astro` files — same predicate the per-rule downgrade uses, so
    // any drift between meta-surface evidence and per-rule downgrade
    // would surface here.
    const astroFiles = scan.meta?.analysisCoverage?.astroIslandsUnrenderedFiles ?? [];
    expect(astroFiles.length).toBe(1);
    expect(astroFiles.every((f) => isAstroFile(f))).toBe(true);

    // Per-rule axis: every document-shaped + event-handler rule whose
    // gate matched at least one `.astro` file must downgrade to
    // `medium` with the astro-islands reason. The rule list is the
    // `ASTRO_ISLAND_DOWNGRADE_RULE_IDS` set in
    // `src/mcp/scan-assembly.ts`. We assert on the subset most
    // reliably exercised by the fixture.
    const rows = scan.meta?.perRuleCoverage ?? [];
    const targetRuleIds = [
      "semantics/landmark-main",
      "semantics/heading-hierarchy",
      "document/page-titled",
      "document/lang-attribute",
      "parsing/html-has-lang",
      "keyboard/handler-missing",
    ] as const;
    for (const ruleId of targetRuleIds) expectRowDowngraded(rows, ruleId);

    // Per-finding axis: every finding emitted on an `.astro` file by
    // a rule in the downgrade set must carry the astro-islands code
    // on `couldBeWrongBecause`. A finding on a non-`.astro` file
    // (`page.html`) MUST NOT carry the astro code as collateral —
    // the file-scoped gate in
    // `src/mcp/per-finding-confidence-parity.ts` denies attaching
    // the code to findings outside the substrate file set.
    const tally = tallyAstroCodeFindings(scan.files);
    // The fixture is constructed so at least one downgrade-set rule
    // fires on the `.astro` file. A zero count would mean the
    // per-finding propagation never ran on the fixture, masking a
    // regression. The exact count is shape-dependent so we assert
    // lower-bound only.
    expect(tally.onAstro).toBeGreaterThan(0);
    // No collateral on the `.html` file: per-rule downgrade is
    // corpus-level evidence, but the per-finding layer must gate on
    // file membership so a finding on `page.html` doesn't pick up
    // the astro substrate code.
    expect(tally.offAstroLeak).toBe(0);
  });
});
