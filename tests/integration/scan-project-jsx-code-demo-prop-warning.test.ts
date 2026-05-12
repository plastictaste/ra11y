/**
 * Integration: `scan_project` against a corpus where an `.mdx` file
 * carries a docs-component (`<Example>`) with a code-demo prop
 * (`code` / `example` / `source` / `template`) whose value is a
 * substitution-free template literal containing HTML emits the
 * `jsx_code_demo_prop_parsed_as_live_dom` warning + paired payload,
 * AND propagates `couldBeWrongBecause: ["template_literal_in_code_demo_prop"]`
 * to every finding emitted on synthesized JSX inside the prop body.
 *
 * Closes the silent-miss shape the backlog item names: an MDX docs
 * tree where every `forms/labels-required` / `navigation/href-empty-fragment`
 * / alt-text fire lives inside a `<Example code={`<form>…`}/>` body
 * the docs site renders as rhetorical preview, not as authored
 * production source — without the warning + per-finding propagation,
 * the agent's triage budget vanishes into rendered illustrations.
 *
 * Surface, don't suppress (per `docs/kb/architecture/ai-first-consumer.md`):
 * the finding stays on the wire (the markup IS structurally what the
 * rule's predicate names) — but per "Reason text and severity must
 * agree" the per-finding `severity` downgrades to `"info"` and
 * `confidence` to `"low"` so the attention-budget signal points the
 * same direction as the appended `couldBeWrongBecause` token.
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
      readonly files: readonly {
        readonly path: string;
        readonly propNames: readonly string[];
        readonly matchCount: number;
      }[];
      readonly propNames: readonly string[];
    };
  };
  readonly files?: readonly {
    readonly path: string;
    readonly findings: readonly {
      readonly ruleId: string;
      readonly line: number;
      readonly severity?: string;
      readonly confidence?: string;
      readonly couldBeWrongBecause?: readonly string[];
    }[];
  }[];
}

async function makeMdxCodeDemoFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-mdx-code-demo-"));
  // MDX file with a `<Example code={`...`}/>` whose body contains a
  // `<form>` with an unlabeled `<input>`. The MDX adapter descends into
  // the template literal and synthesizes JSX elements pinned to MDX
  // source positions; rules then fire on the synthesized markup at the
  // original MDX line numbers.
  const mdxSource = `# Forms documentation

Use the helper to render a labeled form:

<Example code={\`<form>
  <input type="email" />
</form>\`} />

End of docs.
`;
  await writeFile(join(dir, "forms.mdx"), mdxSource);
  return dir;
}

describe("scan_project — jsx_code_demo_prop_parsed_as_live_dom warning + per-finding propagation", () => {
  it("emits the warning, populates the payload, and propagates the reason code onto findings inside the prop body", async () => {
    const cwd = await makeMdxCodeDemoFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd })]);
    const scanResp = responses.find((r) => r.id === 2);
    if (scanResp === undefined) throw new Error("scan_project response missing");
    const result = body<ScanProjectBody>(scanResp);

    // (a) The warning surfaces in the top-level warnings[] channel.
    expect(result.warnings ?? []).toContain("jsx_code_demo_prop_parsed_as_live_dom");

    // (b) The paired payload lists the file with prop names + match
    // count — populated, not the empty `{}` shape doctrine forbids.
    const detail = result.warningsDetails?.jsx_code_demo_prop_parsed_as_live_dom;
    expect(detail).toBeDefined();
    expect(detail?.fileCount).toBeGreaterThan(0);
    expect(detail?.files.length).toBeGreaterThan(0);
    const formsEntry = detail?.files.find((f) => f.path.endsWith("forms.mdx"));
    expect(formsEntry).toBeDefined();
    expect(formsEntry?.propNames).toEqual(["code"]);
    expect(formsEntry?.matchCount).toBe(1);
    // Corpus-level propNames union surfaces the same set.
    expect(detail?.propNames).toEqual(["code"]);

    // (c) The scan still emits the underlying finding (surface, don't
    // suppress) AND each finding inside the descended body carries the
    // propagated `template_literal_in_code_demo_prop` reason code.
    const fileEntry = result.files?.find((f) => f.path.endsWith("forms.mdx"));
    expect(fileEntry).toBeDefined();
    // `<input type="email">` is unlabeled — at minimum the
    // `forms/label-adjacent-unassociated` or `forms/labels-required`
    // rule should fire on it. We assert that AT LEAST ONE finding is
    // emitted (the rule still fires) AND it carries the propagated
    // reason.
    expect((fileEntry?.findings ?? []).length).toBeGreaterThan(0);
    const findingInBody = fileEntry?.findings.find(
      (f) => f.couldBeWrongBecause?.includes("template_literal_in_code_demo_prop") === true,
    );
    expect(findingInBody).toBeDefined();

    // (d) Per "Reason text and severity must agree": every finding
    // carrying the per-LOCATION token also rides at `severity: "info"`
    // + `confidence: "low"`. The downgrade is uniform across rule
    // families (the per-finding assembler stamps it; no per-rule guard
    // needed), so any rule firing inside the descended body matches
    // the verify-in-source attention-budget lane the doctrine names.
    const inBodyFindings = (fileEntry?.findings ?? []).filter(
      (f) => f.couldBeWrongBecause?.includes("template_literal_in_code_demo_prop") === true,
    );
    expect(inBodyFindings.length).toBeGreaterThan(0);
    for (const f of inBodyFindings) {
      expect(f.severity).toBe("info");
      expect(f.confidence).toBe("low");
    }
  }, 30000);
});
