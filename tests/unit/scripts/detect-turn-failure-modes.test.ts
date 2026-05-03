/**
 * Unit coverage for the turn-artifact failure-mode detector.
 *
 * Pins each deterministic detection rule from
 * .claude/agents/meta-reviewer.md §1 against canned turn artifacts so
 * a future meta-reviewer prompt regression can't silently stop firing.
 * The agent prompt may evolve its NLP-flavored rules; the deterministic
 * rules — branch_naming_drift, cherry_pick_dropped_commits, specialist
 * stall, coverage_md_not_regenerated, integrator errors[], slow
 * specialist, high-cost uneventful turn — must keep firing on the
 * same artifacts.
 */

import { describe, expect, it } from "bun:test";
import {
  detectFailureModes,
  type GitDelta,
  type Signal,
  type TurnArtifact,
} from "../../../scripts/detect-turn-failure-modes.ts";

const EMPTY_DELTA: GitDelta = { commitShasInRange: new Set(), filesChangedInRange: [] };

function deltaWith(overrides: Partial<GitDelta>): GitDelta {
  return {
    commitShasInRange: overrides.commitShasInRange ?? EMPTY_DELTA.commitShasInRange,
    filesChangedInRange: overrides.filesChangedInRange ?? EMPTY_DELTA.filesChangedInRange,
    commitRangeKnown: overrides.commitRangeKnown ?? true,
  };
}

function hasSignalCode(signals: readonly Signal[], code: string): boolean {
  return signals.some((s) => s.code === code);
}

function findSignal(signals: readonly Signal[], code: string): Signal | undefined {
  return signals.find((s) => s.code === code);
}

describe("detectFailureModes — branch_naming_drift", () => {
  it("fires when a specialist returns a different branch than assigned", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-abc",
          branch_returned: "worktree-agent-xyz",
          return: { sha: "deadbee", changed: true, verifyPrecommit: "ok" },
        },
      ],
    };
    const signals = detectFailureModes(artifact, EMPTY_DELTA);
    const sig = findSignal(signals, "branch_naming_drift");
    expect(sig).toBeDefined();
    expect(sig?.evidence).toBe("worktree-agent-abc → worktree-agent-xyz");
  });

  it("does not fire when the returned branch matches the assigned branch", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-abc",
          branch_returned: "worktree-agent-abc",
          return: { sha: "deadbee" },
        },
      ],
    };
    expect(hasSignalCode(detectFailureModes(artifact, EMPTY_DELTA), "branch_naming_drift")).toBe(
      false,
    );
  });
});

describe("detectFailureModes — cherry_pick_dropped_commits", () => {
  it("fires when a specialist's reported commits are absent from main..HEAD", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-multi",
          branch_returned: "worktree-agent-multi",
          return: { sha: "abc1234", commits: ["abc1234", "def5678"], changed: true },
        },
      ],
    };
    // Only abc1234 made it onto main; def5678 was dropped.
    const delta = deltaWith({ commitShasInRange: new Set(["abc1234"]) });
    const signals = detectFailureModes(artifact, delta);
    const dropped = signals.filter((s) => s.code === "cherry_pick_dropped_commits");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.evidence).toContain("def5678");
  });

  it("does not fire when every reported sha appears in the integrated range", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-clean",
          branch_returned: "worktree-agent-clean",
          return: { sha: "abc1234", commits: ["abc1234"], changed: true },
        },
      ],
    };
    const delta = deltaWith({ commitShasInRange: new Set(["abc1234"]) });
    expect(hasSignalCode(detectFailureModes(artifact, delta), "cherry_pick_dropped_commits")).toBe(
      false,
    );
  });

  it("does not fire when commitRangeKnown is false (caller has no information)", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-x",
          branch_returned: "worktree-agent-x",
          return: { sha: "abc1234", commits: ["abc1234"], changed: true },
        },
      ],
    };
    expect(
      hasSignalCode(detectFailureModes(artifact, EMPTY_DELTA), "cherry_pick_dropped_commits"),
    ).toBe(false);
  });
});

describe("detectFailureModes — specialist_stall", () => {
  it("fires when the specialist returns no structured JSON", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-stall",
          branch_returned: null,
          wall_time_seconds: 800,
        },
      ],
    };
    const sig = findSignal(detectFailureModes(artifact, EMPTY_DELTA), "specialist_stall");
    expect(sig).toBeDefined();
    expect(sig?.evidence).toContain("no structured JSON return");
  });

  it("fires when changed=true but no sha is present", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-x",
          branch_returned: "worktree-agent-x",
          return: { changed: true, sha: null },
        },
      ],
    };
    const sig = findSignal(detectFailureModes(artifact, EMPTY_DELTA), "specialist_stall");
    expect(sig).toBeDefined();
    expect(sig?.evidence).toContain("changed=true but no sha");
  });

  it("fires when wall time exceeds 5 minutes with no commits or blocked", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-long",
          branch_returned: "worktree-agent-long",
          wall_time_seconds: 600,
          return: {},
        },
      ],
    };
    const sig = findSignal(detectFailureModes(artifact, EMPTY_DELTA), "specialist_stall");
    expect(sig).toBeDefined();
    expect(sig?.evidence).toContain("600s wall");
  });

  it("does not fire when the specialist returned cleanly within budget", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-clean",
          branch_returned: "worktree-agent-clean",
          wall_time_seconds: 87,
          return: { sha: "deadbee", changed: true, verifyPrecommit: "ok" },
        },
      ],
    };
    expect(hasSignalCode(detectFailureModes(artifact, EMPTY_DELTA), "specialist_stall")).toBe(
      false,
    );
  });
});

describe("detectFailureModes — slow_specialist", () => {
  it("fires when wall>10min AND tokens>200k AND verifyPrecommit:ok with no blocked", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-slow",
          branch_returned: "worktree-agent-slow",
          wall_time_seconds: 720,
          total_tokens: 250_000,
          return: { sha: "abc1234", changed: true, verifyPrecommit: "ok" },
        },
      ],
    };
    expect(hasSignalCode(detectFailureModes(artifact, EMPTY_DELTA), "slow_specialist")).toBe(true);
  });

  it("does not fire when the specialist also has a blocked signal", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-blk",
          branch_returned: "worktree-agent-blk",
          wall_time_seconds: 720,
          total_tokens: 250_000,
          return: { blocked: "verify-red: tsc errors", verifyPrecommit: "fail" },
        },
      ],
    };
    expect(hasSignalCode(detectFailureModes(artifact, EMPTY_DELTA), "slow_specialist")).toBe(false);
  });

  it("does not fire when the cost fields are missing (older artifact shape)", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-old",
          branch_returned: "worktree-agent-old",
          return: { sha: "abc1234", changed: true, verifyPrecommit: "ok" },
        },
      ],
    };
    expect(hasSignalCode(detectFailureModes(artifact, EMPTY_DELTA), "slow_specialist")).toBe(false);
  });
});

describe("detectFailureModes — integrator errors[]", () => {
  it("emits one signal per integrator error, code = prefix-token", () => {
    const artifact: TurnArtifact = {
      integrator_return: {
        errors: ["verify_red: typecheck failed in src/foo.ts", "cherry_pick_conflict: src/bar.ts"],
      },
    };
    const signals = detectFailureModes(artifact, EMPTY_DELTA);
    expect(hasSignalCode(signals, "verify_red")).toBe(true);
    expect(hasSignalCode(signals, "cherry_pick_conflict")).toBe(true);
  });
});

describe("detectFailureModes — coverage_md_not_regenerated", () => {
  it("fires when src/rules/* changed but coverage.md was not", () => {
    const artifact: TurnArtifact = { turn_n: 4 };
    const delta = deltaWith({
      filesChangedInRange: ["src/rules/forms/required.ts", "tests/rules/forms/required.test.ts"],
    });
    const sig = findSignal(detectFailureModes(artifact, delta), "coverage_md_not_regenerated");
    expect(sig).toBeDefined();
    expect(sig?.evidence).toContain("src/rules/forms/required.ts");
  });

  it("does not fire when coverage.md was regenerated alongside the rule", () => {
    const artifact: TurnArtifact = { turn_n: 4 };
    const delta = deltaWith({
      filesChangedInRange: ["src/rules/forms/required.ts", "docs/kb/standards/coverage.md"],
    });
    expect(hasSignalCode(detectFailureModes(artifact, delta), "coverage_md_not_regenerated")).toBe(
      false,
    );
  });

  it("does not fire on a turn that didn't add a rule or finder", () => {
    const artifact: TurnArtifact = { turn_n: 4 };
    const delta = deltaWith({ filesChangedInRange: ["src/mcp/server.ts"] });
    expect(hasSignalCode(detectFailureModes(artifact, delta), "coverage_md_not_regenerated")).toBe(
      false,
    );
  });
});

describe("detectFailureModes — high_cost_uneventful_turn", () => {
  it("fires only when cost > 500k tokens AND no other signals fired", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-clean",
          branch_returned: "worktree-agent-clean",
          wall_time_seconds: 60,
          return: { sha: "abc1234", changed: true, verifyPrecommit: "ok" },
        },
      ],
      turn_cost: { total_tokens: 600_000, wall_seconds: 240 },
    };
    const delta = deltaWith({ commitShasInRange: new Set(["abc1234"]) });
    expect(hasSignalCode(detectFailureModes(artifact, delta), "high_cost_uneventful_turn")).toBe(
      true,
    );
  });

  it("does not fire when other signals are present", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-x",
          branch_returned: "worktree-agent-y",
          return: { sha: "abc1234", changed: true, verifyPrecommit: "ok" },
        },
      ],
      turn_cost: { total_tokens: 600_000 },
    };
    expect(
      hasSignalCode(detectFailureModes(artifact, EMPTY_DELTA), "high_cost_uneventful_turn"),
    ).toBe(false);
  });

  it("does not fire when turn_cost is absent (older artifact shape)", () => {
    const artifact: TurnArtifact = {};
    expect(
      hasSignalCode(detectFailureModes(artifact, EMPTY_DELTA), "high_cost_uneventful_turn"),
    ).toBe(false);
  });
});

describe("detectFailureModes — passthrough channels", () => {
  it("passes specialist signals[] through verbatim", () => {
    const artifact: TurnArtifact = {
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-q",
          branch_returned: "worktree-agent-q",
          return: {
            sha: "abc1234",
            signals: [{ code: "coverage_md_not_regenerated", evidence: "missed regen step" }],
          },
        },
      ],
    };
    const sig = findSignal(
      detectFailureModes(artifact, EMPTY_DELTA),
      "coverage_md_not_regenerated",
    );
    expect(sig?.evidence).toBe("missed regen step");
  });

  it("passes integrator signals[] through verbatim", () => {
    const artifact: TurnArtifact = {
      integrator_return: {
        signals: [
          {
            code: "branch_empty_sibling_has_work",
            evidence: "sibling worktree-agent-x has 1 commit",
          },
        ],
      },
    };
    expect(
      hasSignalCode(detectFailureModes(artifact, EMPTY_DELTA), "branch_empty_sibling_has_work"),
    ).toBe(true);
  });
});

describe("detectFailureModes — clean turn", () => {
  it("returns no signals when nothing went wrong", () => {
    const artifact: TurnArtifact = {
      turn_n: 1,
      specialist_returns: [
        {
          branch_assigned: "worktree-agent-clean",
          branch_returned: "worktree-agent-clean",
          wall_time_seconds: 87,
          total_tokens: 158_234,
          return: { sha: "deadbee", commits: ["deadbee"], changed: true, verifyPrecommit: "ok" },
        },
      ],
      integrator_return: { integrated: [{ item: "X", sha: "deadbee" }], errors: [] },
      turn_cost: { total_tokens: 200_000, wall_seconds: 90 },
    };
    const delta = deltaWith({
      commitShasInRange: new Set(["deadbee"]),
      filesChangedInRange: ["src/mcp/server.ts"],
    });
    expect(detectFailureModes(artifact, delta)).toEqual([]);
  });
});
