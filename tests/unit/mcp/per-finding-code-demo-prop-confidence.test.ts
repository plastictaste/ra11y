/**
 * Unit tests for the per-finding propagation onto findings emitted
 * inside MDX docs-component code-demo prop bodies — appends the
 * structured reason code AND downgrades `severity` to `"info"` +
 * `confidence` to `"low"` so the attention-budget signal matches the
 * conceded uncertainty per AI-first doctrine "Reason text and severity
 * must agree."
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
 * the finding stays on the wire (the markup IS structurally what the
 * rule's predicate names); the downgrade moves attention-budget signal
 * so the agent reads "please verify in source" rather than
 * "deterministic failure."
 */

import { describe, expect, it } from "bun:test";
import { CODE_DEMO_PROP_REASON_CODE } from "../../../src/input/parsers/mdx-example-extractor.ts";
import { collectVerifyTokenViolationCriteria } from "../../../src/mcp/manual-criteria-tally.ts";
import {
  enrichFindingsWithCodeDemoPropMatch,
  enrichViolationsWithCodeDemoPropMatch,
} from "../../../src/mcp/per-finding-code-demo-prop-confidence.ts";
import type { AgentFinding } from "../../../src/output/agent-response/types.ts";
import type { Violation } from "../../../src/types/violation.ts";

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

function fakeViolation(line: number, extra: Partial<Violation> = {}): Violation {
  return {
    ruleId: "alt/missing",
    fixClass: "mechanical",
    criteria: ["wcag22:1.1.1"],
    severity: "error",
    location: { filePath: "docs/forms.mdx", line, column: 1 },
    message: "<img> missing alt attribute",
    findingId: `docs/forms.mdx:${line}:alt/missing`,
    groupKey: "alt/missing:group",
    ...extra,
  } as Violation;
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

  it("downgrades severity to info AND confidence to low for findings inside a recorded body range (attention-budget agrees with reason text)", () => {
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
    // Per AI-first doctrine "Reason text and severity must agree": when
    // the per-LOCATION evidence concedes the substrate is rhetorical
    // preview, severity slides to info AND confidence to low so the
    // attention-budget signal points the same direction as the appended
    // `couldBeWrongBecause` token.
    expect(out[0]?.findings[0]?.severity).toBe("info");
    expect(out[0]?.findings[0]?.confidence).toBe("low");
  });

  it("downgrades severity from `warning` to `info` (warning-rank case)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [fakeFinding(15, { severity: "warning", confidence: "medium" })],
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
    expect(out[0]?.findings[0]?.severity).toBe("info");
    expect(out[0]?.findings[0]?.confidence).toBe("low");
  });

  it("does NOT touch findings outside any recorded body range (severity / confidence preserved)", () => {
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
    expect(out[0]?.findings[0]?.severity).toBe("error");
    expect(out[0]?.findings[0]?.confidence).toBe("high");
    expect(out[0]?.findings[1]?.severity).toBe("error");
    expect(out[0]?.findings[1]?.confidence).toBe("high");
  });

  it("keeps severity at info when already info (idempotent re-application)", () => {
    const fileEntries = [
      {
        path: "docs/forms.mdx",
        findings: [
          fakeFinding(15, {
            severity: "info",
            confidence: "low",
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
    // Fully no-op: input reference returned unchanged when nothing
    // actually needs to mutate.
    expect(out).toBe(fileEntries);
    expect(out[0]?.findings[0]?.severity).toBe("info");
    expect(out[0]?.findings[0]?.confidence).toBe("low");
  });
});

describe("enrichViolationsWithCodeDemoPropMatch", () => {
  it("downgrades raw violations before plan/manual-review tallies consume them", () => {
    const violations = [fakeViolation(15)];
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
    const out = enrichViolationsWithCodeDemoPropMatch(violations, matches);
    expect(out[0]?.couldBeWrongBecause).toEqual([CODE_DEMO_PROP_REASON_CODE]);
    expect(out[0]?.severity).toBe("info");
    expect(out[0]?.confidence).toBe("low");
    expect([
      ...collectVerifyTokenViolationCriteria(out, new Set(["wcag22:1.1.1"]), undefined),
    ]).toEqual(["wcag22:1.1.1"]);
  });

  it("preserves raw violation identity outside recorded body ranges", () => {
    const violations = [fakeViolation(4)];
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
    const out = enrichViolationsWithCodeDemoPropMatch(violations, matches);
    expect(out).toBe(violations);
    expect(out[0]).toBe(violations[0]);
  });
});
