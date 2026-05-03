/**
 * Unit tests for the per-finding `couldBeWrongBecause` propagation
 * onto findings emitted inside MDX docs-component code-demo prop
 * bodies.
 *
 * Companion of the corpus-level
 * `jsx_code_demo_prop_parsed_as_live_dom` warning — the warning names
 * "this corpus carries descents," the per-finding propagation names
 * "THIS finding fired inside one." Without the propagation, the agent
 * reading the corpus-level warning cannot tell which findings sit in
 * rhetorical-preview substrate vs which describe authored production
 * source — silent disagreement between the warning channel and the
 * per-finding channel.
 *
 * Surface, don't suppress per `docs/kb/architecture/ai-first-consumer.md`:
 * the rule still emits at its full severity (the markup IS structurally
 * what the rule's predicate names); the propagation only adds additive
 * triage context so the agent recognizes rhetorical-preview substrate
 * at the per-finding granularity.
 */

import { describe, expect, it } from "bun:test";
import type { AgentFinding } from "../../../src/output/agent-response/types.ts";
import { CODE_DEMO_PROP_REASON_CODE } from "../../../src/input/parsers/mdx-example-extractor.ts";
import { enrichFindingsWithCodeDemoPropMatch } from "../../../src/mcp/per-finding-code-demo-prop-confidence.ts";

function fakeFinding(line: number, extra: Partial<AgentFinding> = {}): AgentFinding {
  return {
    ruleId: "alt/missing",
    severity: "error",
    confidence: "high",
    message: "<img> missing alt attribute",
    line,
    column: 1,
    criteria: ["wcag22:1.1.1"],
    ...extra,
  } as AgentFinding;
}

describe("enrichFindingsWithCodeDemoPropMatch", () => {
  it("attaches the reason code to a finding whose line falls inside a recorded match's body range", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(15)],
      },
    ];
    const matches = new Map([
      [
        "docs/forms.mdx",
        [
          {
            propName: "code",
            tagName: "Example",
            propLine: 12,
            bodyStartLine: 12,
            bodyEndLine: 18,
          },
        ],
      ],
    ]);
    const out = enrichFindingsWithCodeDemoPropMatch(fileEntries, matches);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([CODE_DEMO_PROP_REASON_CODE]);
  });

  it("does NOT attach the reason code to a finding whose line is outside every recorded body range", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(5), fakeFinding(40)],
      },
    ];
    const matches = new Map([
      [
        "docs/forms.mdx",
        [
          {
            propName: "code",
            tagName: "Example",
            propLine: 12,
            bodyStartLine: 12,
            bodyEndLine: 18,
          },
        ],
      ],
    ]);
    const out = enrichFindingsWithCodeDemoPropMatch(fileEntries, matches);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toBeUndefined();
    expect(out[0]?.findings[1]?.couldBeWrongBecause).toBeUndefined();
  });

  it("attaches the code on each finding whose line falls in any of multiple ranges in the same file", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [
          fakeFinding(15), // inside first range
          fakeFinding(33), // inside second range
          fakeFinding(50), // outside both ranges
        ],
      },
    ];
    const matches = new Map([
      [
        "docs/forms.mdx",
        [
          {
            propName: "code",
            tagName: "Example",
            propLine: 12,
            bodyStartLine: 12,
            bodyEndLine: 18,
          },
          {
            propName: "template",
            tagName: "Demo",
            propLine: 30,
            bodyStartLine: 30,
            bodyEndLine: 36,
          },
        ],
      ],
    ]);
    const out = enrichFindingsWithCodeDemoPropMatch(fileEntries, matches);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([CODE_DEMO_PROP_REASON_CODE]);
    expect(out[0]?.findings[1]?.couldBeWrongBecause).toEqual([CODE_DEMO_PROP_REASON_CODE]);
    expect(out[0]?.findings[2]?.couldBeWrongBecause).toBeUndefined();
  });

  it("appends the code to an existing couldBeWrongBecause array (preserves prior reasons)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(15, { couldBeWrongBecause: ["partial_parse"] })],
      },
    ];
    const matches = new Map([
      [
        "docs/forms.mdx",
        [
          {
            propName: "code",
            tagName: "Example",
            propLine: 12,
            bodyStartLine: 12,
            bodyEndLine: 18,
          },
        ],
      ],
    ]);
    const out = enrichFindingsWithCodeDemoPropMatch(fileEntries, matches);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([
      "partial_parse",
      CODE_DEMO_PROP_REASON_CODE,
    ]);
  });

  it("dedupes — does not append the code twice when already present", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [
          fakeFinding(15, {
            couldBeWrongBecause: [CODE_DEMO_PROP_REASON_CODE],
          }),
        ],
      },
    ];
    const matches = new Map([
      [
        "docs/forms.mdx",
        [
          {
            propName: "code",
            tagName: "Example",
            propLine: 12,
            bodyStartLine: 12,
            bodyEndLine: 18,
          },
        ],
      ],
    ]);
    const out = enrichFindingsWithCodeDemoPropMatch(fileEntries, matches);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toEqual([CODE_DEMO_PROP_REASON_CODE]);
  });

  it("returns the input reference unchanged when matches is undefined (no-op fast path)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(15)],
      },
    ];
    const out = enrichFindingsWithCodeDemoPropMatch(fileEntries, undefined);
    expect(out).toBe(fileEntries);
  });

  it("returns the input reference unchanged when matches is empty (no-op fast path)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(15)],
      },
    ];
    const out = enrichFindingsWithCodeDemoPropMatch(fileEntries, new Map());
    expect(out).toBe(fileEntries);
  });

  it("does NOT touch a file the matches map doesn't name (file-scoped gate)", () => {
    const fileEntries = [
      {
        path: "src/component.tsx",
        findings: [fakeFinding(15)],
      },
    ];
    const matches = new Map([
      [
        "docs/forms.mdx",
        [
          {
            propName: "code",
            tagName: "Example",
            propLine: 12,
            bodyStartLine: 12,
            bodyEndLine: 18,
          },
        ],
      ],
    ]);
    const out = enrichFindingsWithCodeDemoPropMatch(fileEntries, matches);
    expect(out[0]?.findings[0]?.couldBeWrongBecause).toBeUndefined();
  });

  it("does NOT downgrade severity or confidence — only appends the reason code (surface, don't suppress)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(15)],
      },
    ];
    const matches = new Map([
      [
        "docs/forms.mdx",
        [
          {
            propName: "code",
            tagName: "Example",
            propLine: 12,
            bodyStartLine: 12,
            bodyEndLine: 18,
          },
        ],
      ],
    ]);
    const out = enrichFindingsWithCodeDemoPropMatch(fileEntries, matches);
    // Confidence and severity unchanged — the propagation is additive
    // triage context per AI-first doctrine "Surface, don't suppress."
    expect(out[0]?.findings[0]?.confidence).toBe("high");
    expect(out[0]?.findings[0]?.severity).toBe("error");
  });
});
