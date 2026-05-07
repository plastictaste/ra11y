/**
 * Integration: when `scan_project` ships a corpus-level warning whose
 * `warningsDetails.<code>.files` payload names file paths the response
 * also carries findings on, every per-finding entry on those files
 * carries the warning code in `couldBeWrongBecause` AND its
 * `confidence` is downgraded one step (high → medium, medium → low).
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Per-finding confidence must reflect per-rule coverage limitations."
 *   The corpus-warning extension: when the warning channel and the
 *   per-finding channel share evidence about the same file (the
 *   warning's `files: [...]` payload names files the response carries
 *   findings on), the per-finding channel must propagate the corpus-
 *   level signal so the two surfaces don't disagree silently.
 *
 * Bug shape (closed by this pin): an MDX corpus where
 * `jsx_code_demo_prop_parsed_as_live_dom` fires (the file carries an
 * `<Example code={`...`}/>` body the parser descended into), AND the
 * same file also carries non-code-demo markup outside the prop body
 * that the rule pipeline still flags. Without the per-FILE propagation,
 * findings outside the prop body ride at full confidence with no
 * caveat — the agent reading the corpus warning's payload sees the
 * file is named, but the per-finding channel doesn't surface that
 * evidence and the two channels disagree silently. The closure adds
 * the `enrichFindingsWithCorpusWarningFiles` pass to the
 * `tool-scan-project` post-runScanAndFormat pipeline so every finding
 * on a named file carries the warning code as a `couldBeWrongBecause`
 * caveat.
 *
 * Surface, don't suppress (per AI-first doctrine): the rule still
 * emits at full severity; the propagation only moves the per-finding
 * `confidence` axis one step toward less trust and adds an additive
 * caveat the agent can pivot on.
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

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

interface ScanProjectBody {
  readonly warnings?: readonly string[];
  readonly warningsDetails?: {
    readonly jsx_code_demo_prop_parsed_as_live_dom?: {
      readonly fileCount: number;
      readonly files: readonly { readonly path: string }[];
    };
  };
  readonly files?: readonly {
    readonly path: string;
    readonly findings: readonly {
      readonly ruleId: string;
      readonly line: number;
      readonly confidence?: string;
      readonly couldBeWrongBecause?: readonly string[];
    }[];
  }[];
}

async function makeMixedCodeDemoFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-corpus-warning-files-"));
  // MDX file with two finding-eligible patterns:
  //   1. An `<a href="#">` INSIDE an `<Example code={`...`}/>` body —
  //      the existing per-LINE helper tags this as
  //      `template_literal_in_code_demo_prop`.
  //   2. An `<a href="#">` OUTSIDE any code-demo prop, written as
  //      JSX directly in the MDX residue — the per-LINE helper does
  //      NOT tag this. The new per-FILE pass propagates the corpus-
  //      level warning code to the finding because the file as a
  //      whole carries code-demo descents.
  // Both findings fire `navigation/href-empty-fragment`. Without the
  // per-FILE propagation, the outside-body finding rides at
  // `confidence: "high", couldBeWrongBecause: undefined` while the
  // corpus warning's payload names the file — exactly the silent
  // disagreement the doctrine warns against.
  const mdxSource = `---
title: Navigation patterns
---

import Example from "../../../components/Example.astro";

# Navigation patterns

The example below renders a placeholder anchor inside the docs preview:

<Example code={\`<nav>
  <a href="#">Skip to content</a>
</nav>\`} />

Same pattern outside the preview, written directly in MDX residue:

<a href="#">Inline placeholder anchor</a>
`;
  await writeFile(join(dir, "page.mdx"), mdxSource);
  return dir;
}

describe("scan_project — corpus-warning file-list propagation onto per-finding confidence", () => {
  it("propagates jsx_code_demo_prop_parsed_as_live_dom onto findings outside the prop body when the file is in the warning's file list", async () => {
    const cwd = await makeMixedCodeDemoFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd })]);
    const scanResp = responses.find((r) => r.id === 2);
    if (scanResp === undefined) throw new Error("scan_project response missing");
    const result = body<ScanProjectBody>(scanResp);

    // (a) The corpus-level warning fires and lists the file.
    expect(result.warnings ?? []).toContain("jsx_code_demo_prop_parsed_as_live_dom");
    const warningFiles =
      result.warningsDetails?.jsx_code_demo_prop_parsed_as_live_dom?.files ?? [];
    expect(warningFiles.length).toBeGreaterThan(0);
    const namedFile = warningFiles.find((f) => f.path.endsWith("page.mdx"));
    expect(namedFile).toBeDefined();

    // (b) The per-file findings bucket exists and contains
    // `navigation/href-empty-fragment` emissions on at least two
    // distinct lines (one inside the prop body, one outside).
    const fileEntry = result.files?.find((f) => f.path.endsWith("page.mdx"));
    expect(fileEntry).toBeDefined();
    const hrefFindings = (fileEntry?.findings ?? []).filter(
      (f) => f.ruleId === "navigation/href-empty-fragment",
    );
    // Both the inside-body emission and the outside-body emission
    // must be present on the wire — surface, don't suppress.
    expect(hrefFindings.length).toBeGreaterThanOrEqual(2);

    // (c) EVERY href-empty-fragment finding on the named file carries
    // the corpus warning code in `couldBeWrongBecause`. This is the
    // load-bearing assertion: the per-FILE propagation pass tags every
    // finding on the file, regardless of whether the finding lives
    // inside the prop body. Without this pass, only the inside-body
    // findings would carry the (per-LINE) `template_literal_in_code_demo_prop`
    // code; the outside-body findings would ride at `couldBeWrongBecause: undefined`.
    for (const f of hrefFindings) {
      const codes = f.couldBeWrongBecause ?? [];
      expect(codes).toContain("jsx_code_demo_prop_parsed_as_live_dom");
    }

    // (d) Confidence is downgraded one step from the original (high
    // for severity:error). The propagation moves high → medium so the
    // per-finding attention-budget channel agrees with the corpus
    // signal the warning channel ships.
    for (const f of hrefFindings) {
      // Confidence may be downgraded further by other passes (e.g. the
      // per-line code-demo helper itself does not downgrade, but the
      // per-rule pass might). Assert it's NOT "high" — the propagation
      // moved at minimum one step.
      expect(f.confidence).not.toBe("high");
    }
  }, 30000);
});
