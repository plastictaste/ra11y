/**
 * Unit tests for `runCertification` — the handler backing
 * `ra11y --certification`. Tests drive the exported command function
 * directly against a tmpdir fixture so coverage is captured.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chdir, cwd } from "node:process";
import { defineStandard } from "../../../../src/api/plugin.ts";
import { parseCliArgs } from "../../../../src/cli/args.ts";
import { runCertification } from "../../../../src/cli/commands/certification.ts";
import type { ManualReview } from "../../../../src/reports/index.ts";
import {
  buildCertificationScorecard,
  buildCoverageReport,
  renderCertificationMarkdown,
} from "../../../../src/reports/index.ts";
import type { Standard } from "../../../../src/types/standard.ts";
import type { ScanResult } from "../../../../src/types/violation.ts";
import { withFindingIds } from "../../../helpers/make-violation.ts";
import { posixJoin } from "../../../helpers/path.ts";

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
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-cert-"));
  scratchDirs.push(dir);
  return dir;
}

describe("runCertification", () => {
  it("emits a markdown scorecard for a clean project at exit 0", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runCertification(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("# Certification Readiness Scorecard");
    expect(r.stdout).toContain("Readiness:");
  });

  it("reports blocking issues for a project with a failing criterion", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "bad.html"),
      '<!doctype html><html><body><img src="x"></body></html>',
    );
    chdir(dir);

    const r = await runCertification(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Blocking issues");
    expect(r.stdout).toContain("1.1.1");
  });

  it("credits manual reviews recorded in .ra11y-manual.json", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    await writeFile(
      posixJoin(dir, ".ra11y-manual.json"),
      JSON.stringify({ "wcag22:1.2.1": { reviewed: true, status: "supports" } }),
    );
    chdir(dir);

    const r = await runCertification(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Manual review:");
    // At least one manual review should be credited — non-zero numerator.
    expect(r.stdout).not.toContain("Manual review: 0/");
  });

  it("tolerates a malformed .ra11y-manual.json without throwing", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    await writeFile(posixJoin(dir, ".ra11y-manual.json"), "{ not json");
    chdir(dir);

    const r = await runCertification(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Certification Readiness");
  });

  it("respects --standard when filtering scorecard standards", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runCertification(parseCliArgs(["--standard", "wcag22"]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("WCAG 2.2");
  });

  it("respects --level AAA by widening the target criterion set", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runCertification(parseCliArgs(["--level", "AAA"]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("target Level AAA");
  });

  it("skips unparseable files without aborting the report", async () => {
    const dir = await scratch();
    await writeFile(posixJoin(dir, "notes.md"), "# not parseable as tsx or html");
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runCertification(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Certification Readiness");
  });
});

// Tiny synthetic standard used for shape-stability snapshots. Four
// criteria deliberately chosen to exercise the readiness scorecard
// composition: one failing automated criterion (lands in
// blockingIssues), one passing automated criterion, one manual
// criterion that is reviewed as supports, one manual criterion that
// is unreviewed (drives the pending manual count). Keeps snapshots
// small and reviewable — the builder's full WCAG 2.2 / 2.1 / Section
// 508 / EN 301 549 behaviors stay covered by `tests/unit/reports/`.
const SNAPSHOT_STANDARD: Standard = defineStandard({
  id: "snapstd",
  name: "Snapshot Standard",
  version: "1.0",
  publisher: "Snapshot Test Suite",
  url: "https://example.test/snapshot-standard",
  levels: ["A", "AA", "AAA"],
  criteria: [
    {
      id: "snapstd:1.1.1",
      standardId: "snapstd",
      localId: "1.1.1",
      title: "Failing Automated Criterion",
      level: "A",
      description: "Synthetic criterion that fails because a rule emitted an error violation.",
      url: "https://example.test/snapshot-standard#1-1-1",
      automatable: "full",
    },
    {
      id: "snapstd:2.1.1",
      standardId: "snapstd",
      localId: "2.1.1",
      title: "Passing Automated Criterion",
      level: "A",
      description: "Synthetic criterion the scan checked with no findings.",
      url: "https://example.test/snapshot-standard#2-1-1",
      automatable: "full",
    },
    {
      id: "snapstd:3.1.1",
      standardId: "snapstd",
      localId: "3.1.1",
      title: "Reviewed Manual Criterion",
      level: "AA",
      description: "Synthetic criterion that requires manual review (pre-credited).",
      url: "https://example.test/snapshot-standard#3-1-1",
      automatable: "manual",
    },
    {
      id: "snapstd:4.1.1",
      standardId: "snapstd",
      localId: "4.1.1",
      title: "Unreviewed Manual Criterion",
      level: "AA",
      description: "Synthetic criterion that requires manual review (pending).",
      url: "https://example.test/snapshot-standard#4-1-1",
      automatable: "manual",
    },
  ],
});

const SNAPSHOT_RESULT: ScanResult = {
  violations: withFindingIds([
    {
      ruleId: "synthetic/error-rule",
      fixClass: "mechanical",
      criteria: ["snapstd:1.1.1"],
      severity: "error",
      location: { filePath: "src/Bad.tsx", line: 12, column: 5 },
      message: "Synthetic error violation.",
      suggestion: "Apply the deterministic edit.",
    },
  ]),
  filesScanned: 1,
  durationMs: 4,
  enabledStandards: ["snapstd"],
  isTTY: false,
};

const SNAPSHOT_MANUAL_REVIEW: ManualReview = {
  "snapstd:3.1.1": { reviewed: true, status: "supports" },
};

describe("certification snapshot shape pin", () => {
  it("matches the JSON snapshot for the pinned synthetic scorecard", () => {
    const coverage = buildCoverageReport(SNAPSHOT_RESULT, [SNAPSHOT_STANDARD]);
    const scores = buildCertificationScorecard(
      coverage,
      [SNAPSHOT_STANDARD],
      SNAPSHOT_MANUAL_REVIEW,
      "AA",
    );
    expect(scores).toMatchSnapshot();
  });

  it("matches the markdown snapshot for the pinned synthetic scorecard", () => {
    const coverage = buildCoverageReport(SNAPSHOT_RESULT, [SNAPSHOT_STANDARD]);
    const scores = buildCertificationScorecard(
      coverage,
      [SNAPSHOT_STANDARD],
      SNAPSHOT_MANUAL_REVIEW,
      "AA",
    );
    expect(renderCertificationMarkdown(scores)).toMatchSnapshot();
  });
});
