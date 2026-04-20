/**
 * CLI integration tests for `ra11y attest`. Mirrors
 * `tests/cli/attestations-prune.test.ts`: scratch dir, drive through
 * `runCli`, assert argv → disk round-trip.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { runCli } from "../../src/cli/run.ts";
import type { AttestationRecord } from "../../src/types/evidence.ts";

const originalCwd = cwd();
const scratchDirs: string[] = [];

afterAll(async () => {
  chdir(originalCwd);
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

async function makeScratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-attest-cli-"));
  scratchDirs.push(dir);
  return dir;
}

async function readStore(dir: string): Promise<readonly AttestationRecord[]> {
  const raw = await readFile(join(dir, ".ra11y", "attestations.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AttestationRecord);
}

describe("ra11y attest", () => {
  it("appends a valid record with --reason + --verdict", async () => {
    const dir = await makeScratch();
    chdir(dir);
    const r = await runCli([
      "attest",
      "wcag22:1.1.1",
      "--reason",
      "ran axe-core 2026-04-19 confirming no img elements",
      "--verdict",
      "na",
      "--by",
      "ci-bot",
    ]);
    chdir(originalCwd);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("appended attestation for wcag22:1.1.1");
    expect(r.stdout).toContain("verdict=n/a");
    const records = await readStore(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      criterionId: "wcag22:1.1.1",
      by: "ci-bot",
      reason: "ran axe-core 2026-04-19 confirming no img elements",
      verdict: "n/a",
    });
  });

  it("rejects bare invocation without --reason with exit 2", async () => {
    const dir = await makeScratch();
    chdir(dir);
    const r = await runCli(["attest", "wcag22:1.1.1"]);
    chdir(originalCwd);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--reason is required");
  });

  it("rejects empty/whitespace --reason with exit 2", async () => {
    const dir = await makeScratch();
    chdir(dir);
    const r = await runCli(["attest", "wcag22:1.1.1", "--reason", "   "]);
    chdir(originalCwd);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--reason is required");
  });

  it("rejects missing <criterionId> positional with exit 2", async () => {
    const dir = await makeScratch();
    chdir(dir);
    const r = await runCli(["attest", "--reason", "x"]);
    chdir(originalCwd);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("missing <criterionId>");
  });

  it("rejects unknown criterion ID with exit 2", async () => {
    const dir = await makeScratch();
    chdir(dir);
    const r = await runCli(["attest", "wcag22:99.99.99", "--reason", "nonsense"]);
    chdir(originalCwd);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown criterion");
  });

  it("rejects rule IDs that do not satisfy the criterion", async () => {
    const dir = await makeScratch();
    chdir(dir);
    const r = await runCli([
      "attest",
      "wcag22:1.1.1",
      "--reason",
      "valid reason",
      "--rule-ids",
      "nonexistent/rule-id",
    ]);
    chdir(originalCwd);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("do not satisfy");
  });

  it("emits non_git_repo_commit_omitted warning when cwd is outside a repo", async () => {
    const dir = await makeScratch();
    chdir(dir);
    const r = await runCli(["attest", "wcag22:1.1.1", "--reason", "outside git"]);
    chdir(originalCwd);

    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("non_git_repo_commit_omitted");
  });

  it("parses --location <file>:<line>:<col> with scope=file", async () => {
    const dir = await makeScratch();
    await writeFile(join(dir, "a.tsx"), "export {};\n");
    chdir(dir);
    const r = await runCli([
      "attest",
      "wcag22:1.1.1",
      "--reason",
      "manual review complete",
      "--scope",
      "file",
      "--location",
      "a.tsx:1:1",
    ]);
    chdir(originalCwd);

    expect(r.exitCode).toBe(0);
    const records = await readStore(dir);
    expect(records[0]?.scope).toBe("file");
    expect(records[0]?.location).toMatchObject({ filePath: "a.tsx", line: 1, column: 1 });
  });

  it("rejects scope=file without --location with exit 2", async () => {
    const dir = await makeScratch();
    chdir(dir);
    const r = await runCli(["attest", "wcag22:1.1.1", "--reason", "x", "--scope", "file"]);
    chdir(originalCwd);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--location");
  });

  it("appends idempotently — multiple calls produce multiple lines", async () => {
    const dir = await makeScratch();
    chdir(dir);
    await runCli(["attest", "wcag22:1.1.1", "--reason", "first"]);
    await runCli(["attest", "wcag22:1.1.1", "--reason", "second"]);
    chdir(originalCwd);

    const records = await readStore(dir);
    expect(records).toHaveLength(2);
    expect(records[0]?.reason).toBe("first");
    expect(records[1]?.reason).toBe("second");
  });
});
