/**
 * Unit coverage for the planner-plan sanity checker.
 *
 * The script catches a fixed class of deterministic mistakes the
 * planner prompt patches keep drifting away from: owner-mapping
 * misclassification, intra-turn file collisions, already-shipped
 * picks, stale backlogLine pointers, picksPerTurn arithmetic, and the
 * crossCutting + picksPerTurn=4 allocation rules. Each test pins one
 * rule against a synthetic plan so a future planner refactor can't
 * regress the guard silently.
 */

import { describe, expect, it } from "bun:test";
import {
  ownerForFile,
  type Plan,
  type PlanPick,
  type PlanTurn,
  type ValidationContext,
  validatePlan,
} from "../../../scripts/check-planner-plan.ts";

const EMPTY_CTX: ValidationContext = { closedItemIds: new Set(), backlogLines: [] };

function ctxWith(overrides: Partial<ValidationContext>): ValidationContext {
  return { ...EMPTY_CTX, ...overrides };
}

function pick(overrides: Partial<PlanPick> & Pick<PlanPick, "item">): PlanPick {
  return {
    track: "V",
    specialist: "main-session",
    inferredFiles: ["scripts/a.ts"],
    ...overrides,
  };
}

function turn(n: number, picks: PlanPick[], overrides: Partial<PlanTurn> = {}): PlanTurn {
  return { n, picksPerTurn: picks.length, picks, ...overrides };
}

function plan(turns: PlanTurn[]): Plan {
  return { turns };
}

function expectError(plan: Plan, ctx: ValidationContext, fragment: string): void {
  const errors = validatePlan(plan, ctx);
  expect(errors.some((e) => e.includes(fragment))).toBe(true);
}

describe("ownerForFile", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["src/rules/forms/required.ts", "rule-implementer"],
    ["src/standards/wcag22.ts", "standard-builder"],
    ["src/input/parsers/tsx.ts", "parser-author"],
    ["src/output/formatters/sarif.ts", "formatter-author"],
    ["src/types/violation.ts", "type-smith"],
    ["src/engine/ast-helpers.ts", "type-smith"],
    ["src/mcp/server.ts", "main-session"],
    ["tests/fixtures/real-world/case-1/source/x.tsx", "fixture-curator"],
    ["tests/unit/engine/scanner.test.ts", "test-author"],
    ["docs/kb/wcag/1.4.3.md", "spec-researcher"],
    ["docs/getting-started.md", "doc-writer"],
    ["README.md", "main-session"],
  ];
  for (const [file, expected] of cases) {
    it(`maps "${file}" → ${expected}`, () => {
      expect(ownerForFile(file)).toBe(expected);
    });
  }
});

describe("validatePlan — picksPerTurn arithmetic", () => {
  it("flags picksPerTurn != picks.length", () => {
    const p: Plan = { turns: [{ n: 1, picksPerTurn: 3, picks: [pick({ item: "A" })] }] };
    expectError(p, EMPTY_CTX, "picksPerTurn=3 but picks.length=1");
  });

  it("passes when picksPerTurn matches picks.length", () => {
    expect(validatePlan(plan([turn(1, [pick({ item: "A" })])]), EMPTY_CTX)).toEqual([]);
  });
});

describe("validatePlan — intra-turn collision", () => {
  it("flags two picks sharing an inferredFile", () => {
    const p = plan([
      turn(1, [
        pick({ item: "A", inferredFiles: ["src/mcp/warnings.ts", "src/mcp/scan.ts"] }),
        pick({
          item: "B",
          track: "Q",
          inferredFiles: ["src/mcp/warnings.ts", "src/mcp/checklist.ts"],
        }),
      ]),
    ]);
    expectError(p, EMPTY_CTX, 'intra-turn collision on "src/mcp/warnings.ts"');
  });

  it("does not flag when inferredFiles are disjoint", () => {
    const p = plan([
      turn(1, [
        pick({
          item: "A",
          track: "R",
          specialist: "rule-implementer",
          inferredFiles: ["src/rules/a.ts"],
        }),
        pick({
          item: "B",
          track: "F",
          specialist: "fixture-curator",
          inferredFiles: ["tests/fixtures/real-world/b/source.tsx"],
        }),
      ]),
    ]);
    expect(validatePlan(p, EMPTY_CTX)).toEqual([]);
  });
});

describe("validatePlan — same track + specialist", () => {
  it("flags two picks sharing track and specialist in the same turn", () => {
    const p = plan([
      turn(1, [
        pick({
          item: "R-A",
          track: "R",
          specialist: "rule-implementer",
          inferredFiles: ["src/rules/a.ts"],
        }),
        pick({
          item: "R-B",
          track: "R",
          specialist: "rule-implementer",
          inferredFiles: ["src/rules/b.ts"],
        }),
      ]),
    ]);
    expectError(p, EMPTY_CTX, 'share track+specialist "R::rule-implementer"');
  });
});

describe("validatePlan — cross-turn collision", () => {
  it("flags a file overlap when collisionWith does not reference the earlier turn", () => {
    const p = plan([
      turn(1, [pick({ item: "A", inferredFiles: ["src/mcp/x.ts"] })]),
      turn(2, [pick({ item: "B", inferredFiles: ["src/mcp/x.ts"], collisionWith: null })]),
    ]);
    expectError(p, EMPTY_CTX, 'collides with turn 1 pick "A"');
  });

  it("passes when later pick references the earlier turn via collisionWith", () => {
    const p = plan([
      turn(1, [pick({ item: "A", inferredFiles: ["src/mcp/x.ts"] })]),
      turn(2, [pick({ item: "B", inferredFiles: ["src/mcp/x.ts"], collisionWith: "turn-1/A" })]),
    ]);
    expect(validatePlan(p, EMPTY_CTX)).toEqual([]);
  });
});

describe("validatePlan — owner-mapping misclassification", () => {
  it("flags warning-emission item routed to parser-author when files are src/mcp/**", () => {
    const p = plan([
      turn(1, [
        pick({
          item: "V1-WARN-FOO",
          specialist: "parser-author",
          inferredFiles: ["src/mcp/warnings.ts"],
        }),
      ]),
    ]);
    expectError(p, EMPTY_CTX, 'specialist="parser-author"');
  });

  it("flags rule-item routed to formatter-author", () => {
    const p = plan([
      turn(1, [
        pick({
          item: "R-FOO",
          track: "R",
          specialist: "formatter-author",
          inferredFiles: ["src/rules/a.ts"],
        }),
      ]),
    ]);
    expectError(p, EMPTY_CTX, 'imply "rule-implementer"');
  });

  it("accepts main-session as catch-all for V-track files", () => {
    const p = plan([turn(1, [pick({ item: "X", inferredFiles: ["src/rules/a.ts"] })])]);
    expect(validatePlan(p, EMPTY_CTX)).toEqual([]);
  });

  it("flags multi-group files when specialist is not main-session or type-smith cascade", () => {
    const p = plan([
      turn(1, [
        pick({
          item: "X",
          specialist: "rule-implementer",
          inferredFiles: ["src/rules/a.ts", "src/standards/wcag22.ts"],
        }),
      ]),
    ]);
    expectError(p, EMPTY_CTX, "span multiple specialist groups");
  });

  it("accepts type-smith cascade when src/types/** is in the file set", () => {
    const p = plan([
      turn(
        1,
        [
          pick({
            item: "TYPE-WIDEN",
            specialist: "type-smith",
            inferredFiles: [
              "src/types/violation.ts",
              "src/rules/a.ts",
              "src/output/formatters/json.ts",
            ],
            crossCutting: true,
          }),
        ],
        { picksPerTurn: 1 },
      ),
    ]);
    expect(validatePlan(p, EMPTY_CTX)).toEqual([]);
  });

  it("skips owner-mapping when inferredFiles is empty (new-module case)", () => {
    const p = plan([
      turn(1, [pick({ item: "NEW-HELPER", specialist: "rule-implementer", inferredFiles: [] })]),
    ]);
    expect(validatePlan(p, EMPTY_CTX)).toEqual([]);
  });
});

describe("validatePlan — already-shipped detection", () => {
  it("flags an item whose ID is in closedItemIds", () => {
    const p = plan([turn(1, [pick({ item: "V1-DEAD-ITEM" })])]);
    expectError(p, ctxWith({ closedItemIds: new Set(["V1-DEAD-ITEM"]) }), "already shipped");
  });
});

describe("validatePlan — backlogLine pointer", () => {
  it("flags a backlogLine that lands on a non-[ ] line", () => {
    const p = plan([turn(1, [pick({ item: "V1-FOO", backlogLine: 1 })])]);
    expectError(
      p,
      ctxWith({ backlogLines: ["- [~] **V1-FOO** — in progress"] }),
      "not an open [ ] bullet",
    );
  });

  it("flags a backlogLine whose bullet does not contain the item ID", () => {
    const p = plan([turn(1, [pick({ item: "V1-FOO", backlogLine: 1 })])]);
    expectError(
      p,
      ctxWith({ backlogLines: ["- [ ] **V1-OTHER** — different item"] }),
      "does not contain the item ID",
    );
  });

  it("passes when the line is open and contains the item ID", () => {
    const p = plan([turn(1, [pick({ item: "V1-FOO", backlogLine: 1 })])]);
    expect(validatePlan(p, ctxWith({ backlogLines: ["- [ ] **V1-FOO** — open item"] }))).toEqual(
      [],
    );
  });
});

describe("validatePlan — crossCutting allocation", () => {
  it("flags crossCutting paired with other picks without slotWasteWarning", () => {
    const p = plan([
      turn(1, [
        pick({
          item: "TYPE-WIDEN",
          specialist: "type-smith",
          inferredFiles: ["src/types/violation.ts"],
          crossCutting: true,
        }),
        pick({
          item: "A",
          track: "R",
          specialist: "rule-implementer",
          inferredFiles: ["src/rules/a.ts"],
        }),
        pick({
          item: "B",
          track: "F",
          specialist: "fixture-curator",
          inferredFiles: ["tests/fixtures/real-world/b/source.tsx"],
        }),
      ]),
    ]);
    expectError(p, EMPTY_CTX, "crossCutting pick requires picksPerTurn=1");
  });

  it("accepts crossCutting paired when slotWasteWarning is set", () => {
    const p = plan([
      turn(
        1,
        [
          pick({
            item: "TYPE-WIDEN",
            specialist: "type-smith",
            inferredFiles: ["src/types/violation.ts"],
            crossCutting: true,
          }),
          pick({
            item: "A",
            track: "R",
            specialist: "rule-implementer",
            inferredFiles: ["src/rules/a.ts"],
          }),
          pick({
            item: "B",
            track: "F",
            specialist: "fixture-curator",
            inferredFiles: ["tests/fixtures/real-world/b/source.tsx"],
          }),
        ],
        { slotWasteWarning: true },
      ),
    ]);
    expect(validatePlan(p, EMPTY_CTX)).toEqual([]);
  });
});

describe("validatePlan — picksPerTurn=4 conditions", () => {
  function fourPicks(extra: PlanPick): PlanPick[] {
    return [
      pick({
        item: "A",
        track: "R",
        specialist: "rule-implementer",
        inferredFiles: ["src/rules/a.ts"],
      }),
      pick({
        item: "B",
        track: "F",
        specialist: "fixture-curator",
        inferredFiles: ["tests/fixtures/real-world/b/source.tsx"],
      }),
      pick({
        item: "C",
        track: "R",
        specialist: "test-author",
        inferredFiles: ["tests/unit/c.test.ts"],
      }),
      extra,
    ];
  }

  it("flags picksPerTurn=4 with a main-session specialist", () => {
    const p = plan([
      turn(
        1,
        fourPicks(pick({ item: "D", specialist: "main-session", inferredFiles: ["scripts/d.ts"] })),
        {
          picksPerTurn: 4,
        },
      ),
    ]);
    expectError(p, EMPTY_CTX, "non-V-track specialist");
  });

  it("flags picksPerTurn=4 with a collisionWith on any pick", () => {
    const p = plan([
      turn(
        1,
        fourPicks(
          pick({
            item: "D",
            track: "S",
            specialist: "rule-implementer",
            inferredFiles: ["src/rules/d.ts"],
            collisionWith: "abc1234: prior commit",
          }),
        ),
        { picksPerTurn: 4 },
      ),
    ]);
    expectError(p, EMPTY_CTX, "carries collisionWith");
  });
});
