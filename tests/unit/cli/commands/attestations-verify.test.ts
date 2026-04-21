/**
 * Unit tests for `ra11y attestations verify` — the ADR 0020 ledger
 * integrity command.
 *
 * Splits across two suites:
 *   - `verifyAttestationIntegrity`: the pure helper. Exercised without
 *     git via handcrafted working-tree + HEAD bodies and a synthetic
 *     per-line commit-date map. Covers the four kinds the verifier
 *     emits (removed-since-head, backdated-attestation,
 *     future-attestation-before-commit, uncommitted).
 *   - `parseBlameLineDates`: the blame porcelain parser. Hand-crafted
 *     fixtures drive the line → ISO date mapping so we don't depend on
 *     the host's `git` invariants.
 *   - CLI wrapper: a non-git-repo tmpdir invocation to confirm the
 *     graceful-error path — no crash, exit 2, clear message.
 *
 * Invariants under test (not behavior rehearsal):
 *   - Clean working tree + matching HEAD → zero findings.
 *   - Entry present in HEAD but missing from working tree → one
 *     `removed-since-head` finding.
 *   - `attestedAt` strictly after the adding-commit date → one
 *     `backdated-attestation` finding.
 *   - `attestedAt` strictly before the adding-commit date → one
 *     `future-attestation-before-commit` finding.
 *   - Working-tree line with no commit-date entry → `uncommitted`.
 *   - Non-git-repo CLI invocation → exit 2 + stderr naming the
 *     precondition; never a crash.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import {
  parseBlameLineDates,
  runAttestationsCommand,
} from "../../../../src/cli/commands/attestations.ts";
import { verifyAttestationIntegrity } from "../../../../src/config/attestation-store.ts";
import type { AttestationRecord } from "../../../../src/types/evidence.ts";

const BASE: AttestationRecord = {
  criterionId: "wcag22:2.4.5",
  by: "agent",
  reason: "manual keyboard traversal verifies focus order",
  attestedAt: "2026-04-18T00:00:00.000Z",
  evidenceSource: "manual_review",
};

function ledgerBody(records: readonly AttestationRecord[]): string {
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  return body.length > 0 ? `${body}\n` : "";
}

const originalCwd = cwd();
const scratchDirs: string[] = [];

afterEach(async () => {
  chdir(originalCwd);
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-verify-"));
  scratchDirs.push(dir);
  return dir;
}

describe("verifyAttestationIntegrity: clean ledger", () => {
  it("emits no findings when working tree matches HEAD and every line has a commit-date ≤ attestedAt", () => {
    const record = { ...BASE };
    const body = ledgerBody([record]);
    const commitDates = new Map([[1, record.attestedAt]]);

    const { findings } = verifyAttestationIntegrity(body, body, commitDates);

    expect(findings).toHaveLength(0);
  });

  it("emits no findings when HEAD is empty and every working-tree line is marked uncommitted (via an absent map entry that the caller materializes as no-map or empty-map)", () => {
    // Pure helper intentionally has no visibility into "is this a git
    // repo"; the CLI wrapper owns that precondition. When the map is
    // empty and HEAD is empty, every working-tree line reports as
    // uncommitted — expected when `attest` has just been run and
    // nothing has been committed yet.
    const body = ledgerBody([{ ...BASE }]);

    const { findings } = verifyAttestationIntegrity(body, "", new Map());

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("uncommitted");
  });
});

describe("verifyAttestationIntegrity: removed-since-head", () => {
  it("flags HEAD lines that are missing from the working tree", () => {
    const keptRecord = { ...BASE };
    const droppedRecord = { ...BASE, criterionId: "wcag22:1.4.3" };
    const headBody = ledgerBody([keptRecord, droppedRecord]);
    const workingBody = ledgerBody([keptRecord]);
    const commitDates = new Map([[1, keptRecord.attestedAt]]);

    const { findings } = verifyAttestationIntegrity(workingBody, headBody, commitDates);

    const removals = findings.filter((f) => f.kind === "removed-since-head");
    expect(removals).toHaveLength(1);
    expect(removals[0]?.record.criterionId).toBe("wcag22:1.4.3");
  });

  it("treats a byte-identical reordering of keys inside a record as a removal (any edit to a committed line flips equality)", () => {
    const original = { ...BASE };
    const reorderedBody = `${JSON.stringify({
      attestedAt: original.attestedAt,
      reason: original.reason,
      by: original.by,
      criterionId: original.criterionId,
    })}\n`;
    const headBody = ledgerBody([original]);
    const commitDates = new Map([[1, original.attestedAt]]);

    const { findings } = verifyAttestationIntegrity(reorderedBody, headBody, commitDates);

    expect(findings.some((f) => f.kind === "removed-since-head")).toBe(true);
  });
});

describe("verifyAttestationIntegrity: backdated-attestation", () => {
  it("flags entries whose attestedAt is strictly after the adding-commit date", () => {
    const record: AttestationRecord = {
      ...BASE,
      attestedAt: "2026-04-18T12:00:00.000Z",
    };
    const body = ledgerBody([record]);
    const commitDate = "2026-04-15T00:00:00.000Z";
    const commitDates = new Map([[1, commitDate]]);

    const { findings } = verifyAttestationIntegrity(body, body, commitDates);

    const backdated = findings.filter((f) => f.kind === "backdated-attestation");
    expect(backdated).toHaveLength(1);
    const only = backdated[0];
    if (only?.kind !== "backdated-attestation") throw new Error("expected backdated");
    expect(only.attestedAt).toBe("2026-04-18T12:00:00.000Z");
    expect(only.commitDate).toBe(commitDate);
  });

  it("does not flag when attestedAt is exactly equal to the adding-commit date", () => {
    const record = { ...BASE };
    const body = ledgerBody([record]);
    const commitDates = new Map([[1, record.attestedAt]]);

    const { findings } = verifyAttestationIntegrity(body, body, commitDates);

    expect(findings).toHaveLength(0);
  });
});

describe("verifyAttestationIntegrity: future-attestation-before-commit", () => {
  it("flags entries whose attestedAt is strictly before the adding-commit date", () => {
    const record: AttestationRecord = {
      ...BASE,
      attestedAt: "2026-04-10T00:00:00.000Z",
    };
    const body = ledgerBody([record]);
    const commitDate = "2026-04-18T00:00:00.000Z";
    const commitDates = new Map([[1, commitDate]]);

    const { findings } = verifyAttestationIntegrity(body, body, commitDates);

    const future = findings.filter((f) => f.kind === "future-attestation-before-commit");
    expect(future).toHaveLength(1);
  });
});

describe("verifyAttestationIntegrity: uncommitted", () => {
  it("marks working-tree lines without a commit-date entry as uncommitted", () => {
    const committed = { ...BASE };
    const pending = { ...BASE, criterionId: "wcag22:1.1.1" };
    const workingBody = ledgerBody([committed, pending]);
    const headBody = ledgerBody([committed]);
    const commitDates = new Map([[1, committed.attestedAt]]);

    const { findings } = verifyAttestationIntegrity(workingBody, headBody, commitDates);

    const uncommitted = findings.filter((f) => f.kind === "uncommitted");
    expect(uncommitted).toHaveLength(1);
    expect(uncommitted[0]?.record.criterionId).toBe("wcag22:1.1.1");
  });

  it("does not emit a backdated finding when the line is also uncommitted", () => {
    // Uncommitted short-circuits before any date math — we have no
    // adding-commit date to compare against yet.
    const record: AttestationRecord = {
      ...BASE,
      attestedAt: "3000-01-01T00:00:00.000Z",
    };
    const workingBody = ledgerBody([record]);

    const { findings } = verifyAttestationIntegrity(workingBody, "", new Map());

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("uncommitted");
  });
});

describe("verifyAttestationIntegrity: malformed input", () => {
  it("skips lines that don't parse as JSON rather than crashing", () => {
    const body = `${JSON.stringify({ ...BASE })}\nnot-json\n${JSON.stringify({
      ...BASE,
      criterionId: "wcag22:1.4.3",
    })}\n`;
    const commitDates = new Map([
      [1, BASE.attestedAt],
      [3, BASE.attestedAt],
    ]);

    const { findings } = verifyAttestationIntegrity(body, body, commitDates);

    expect(findings).toHaveLength(0);
  });

  it("skips lines missing required fields (malformed record) without crashing", () => {
    const body = `${JSON.stringify({ criterionId: "wcag22:1.1.1" })}\n`;

    const { findings } = verifyAttestationIntegrity(body, "", new Map());

    expect(findings).toHaveLength(0);
  });

  it("skips the date comparison (returns no finding) when attestedAt is unparseable", () => {
    const bad: AttestationRecord = { ...BASE, attestedAt: "not-a-date" };
    const body = ledgerBody([bad]);
    const commitDates = new Map([[1, "2026-04-18T00:00:00.000Z"]]);

    const { findings } = verifyAttestationIntegrity(body, body, commitDates);

    expect(findings).toHaveLength(0);
  });
});

describe("parseBlameLineDates", () => {
  it("extracts per-line ISO dates from porcelain output", () => {
    const blame = [
      "abcdef0123456789abcdef0123456789abcdef01 1 1 1",
      "author Test",
      "author-mail <t@example.test>",
      "author-time 1744502400",
      "author-tz +0000",
      "committer Test",
      "committer-mail <t@example.test>",
      "committer-time 1744502400",
      "committer-tz +0000",
      "summary first",
      "filename .ra11y/attestations.jsonl",
      '\t{"criterionId":"wcag22:1.1.1","by":"a","reason":"r","attestedAt":"x"}',
    ].join("\n");

    const out = parseBlameLineDates(blame);

    expect(out.size).toBe(1);
    expect(out.get(1)).toBe(new Date(1744502400 * 1000).toISOString());
  });

  it("omits lines attributed to the all-zero SHA (uncommitted marker)", () => {
    const blame = [
      "0000000000000000000000000000000000000000 1 1 1",
      "author Not Committed Yet",
      "author-time 1744502500",
      "author-tz +0000",
      "summary Version of .ra11y/attestations.jsonl from .ra11y/attestations.jsonl",
      '\t{"criterionId":"wcag22:1.1.1","by":"a","reason":"r","attestedAt":"x"}',
    ].join("\n");

    const out = parseBlameLineDates(blame);

    expect(out.size).toBe(0);
  });

  it("returns an empty map for empty input", () => {
    expect(parseBlameLineDates("").size).toBe(0);
  });
});

describe("runAttestationsCommand: verify CLI wrapper", () => {
  it("returns exit 2 with a clear error when the cwd is not a git repo", async () => {
    const dir = await scratch();
    chdir(dir);

    const result = await runAttestationsCommand({
      command: "attestations",
      positionals: ["verify"],
      format: "terminal",
      standards: ["wcag22"],
      level: "AA",
      profile: undefined,
      profileOverridesExplicit: false,
      exclude: [],
      failOn: "error",
      noColor: false,
      verbose: false,
      debug: false,
      quiet: false,
      changed: false,
      since: undefined,
      baseline: undefined,
      baselineFile: undefined,
      baselineAction: undefined,
      baselineDryRun: false,
      attestationsAction: "verify",
      attestationsDryRun: false,
      attestVerdict: undefined,
      attestReason: undefined,
      attestRuleIds: [],
      attestScope: undefined,
      attestBy: undefined,
      attestLocation: undefined,
      attestEvidenceSource: undefined,
      attestToolName: undefined,
      attestRunUrl: undefined,
      attestObservedAt: undefined,
      conformanceVerify: undefined,
      conformanceOutput: "markdown",
      conformanceScanRoot: undefined,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("requires a git repository");
  });
});
