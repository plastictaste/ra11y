/**
 * Unit tests for `runVpat` — the handler backing `ra11y --vpat`.
 * Drives the handler directly against a tmpdir fixture project.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chdir, cwd } from "node:process";
import { defineStandard } from "../../../../src/api/plugin.ts";
import { parseCliArgs } from "../../../../src/cli/args.ts";
import { runVpat } from "../../../../src/cli/commands/vpat.ts";
import { buildVpatReport, renderVpatMarkdown } from "../../../../src/reports/index.ts";
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
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-vpat-"));
  scratchDirs.push(dir);
  return dir;
}

describe("runVpat", () => {
  it("renders a VPAT 2.5 Rev markdown report for a clean project at exit 0", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runVpat(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/# VPAT 2\.5 Rev( INT)? Conformance Report/);
    expect(r.stdout).toContain("Evaluator");
    expect(r.stdout).toContain("Generated");
  });

  it("includes WCAG 2.2 section with the conformance table", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runVpat(parseCliArgs([]));

    expect(r.stdout).toContain("## WCAG 2.2");
    expect(r.stdout).toContain("| Criterion | Level | Conformance | Remarks |");
  });

  it("emits 'Does Not Support' when a rule fires", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "bad.html"),
      '<!doctype html><html><body><img src="x"></body></html>',
    );
    chdir(dir);

    const r = await runVpat(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Does Not Support");
  });

  it("honors RA11Y_FIXED_TIMESTAMP-derived Generated field shape", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runVpat(parseCliArgs([]));

    // Generated line is always ISO-like.
    expect(r.stdout).toMatch(/\*\*Generated\*\*: \S+/);
  });

  it("filters sections to wcag21 when --standard wcag21 is passed", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runVpat(parseCliArgs(["--standard", "wcag21"]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("## WCAG 2.1");
  });

  it("ignores files that can't be parsed as TSX or HTML", async () => {
    const dir = await scratch();
    await writeFile(posixJoin(dir, "data.csv"), "a,b,c\n1,2,3\n");
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runVpat(parseCliArgs([]));

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/VPAT 2\.5 Rev/);
  });

  it("surfaces 'Not Applicable' for media SCs when scan has no <audio>/<video>", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const r = await runVpat(parseCliArgs([]));

    expect(r.stdout).toContain("Not Applicable");
    // 1.2.1 is the canonical media SC; with no media elements present
    // the verdict must be Not Applicable, not Not Evaluated.
    expect(r.stdout).toMatch(/1\.2\.1 Audio-only.*\|.*Not Applicable.*\|/);
  });

  it("threads RA11Y_VPAT_PRODUCT_NAME / _VERSION env vars into the header", async () => {
    const dir = await scratch();
    await writeFile(
      posixJoin(dir, "page.html"),
      '<!doctype html><html lang="en"><head><title>Ok</title></head><body><p>hi</p></body></html>',
    );
    chdir(dir);

    const prevName = process.env.RA11Y_VPAT_PRODUCT_NAME;
    const prevVersion = process.env.RA11Y_VPAT_PRODUCT_VERSION;
    const prevOrg = process.env.RA11Y_VPAT_CONTACT_ORGANIZATION;
    process.env.RA11Y_VPAT_PRODUCT_NAME = "Acme Editor";
    process.env.RA11Y_VPAT_PRODUCT_VERSION = "4.2.0";
    process.env.RA11Y_VPAT_CONTACT_ORGANIZATION = "Acme Corp";
    try {
      const r = await runVpat(parseCliArgs([]));
      expect(r.stdout).toContain("Acme Editor");
      expect(r.stdout).toContain("4.2.0");
      expect(r.stdout).toContain("Acme Corp");
    } finally {
      if (prevName === undefined) delete process.env.RA11Y_VPAT_PRODUCT_NAME;
      else process.env.RA11Y_VPAT_PRODUCT_NAME = prevName;
      if (prevVersion === undefined) delete process.env.RA11Y_VPAT_PRODUCT_VERSION;
      else process.env.RA11Y_VPAT_PRODUCT_VERSION = prevVersion;
      if (prevOrg === undefined) delete process.env.RA11Y_VPAT_CONTACT_ORGANIZATION;
      else process.env.RA11Y_VPAT_CONTACT_ORGANIZATION = prevOrg;
    }
  });
});

// Tiny synthetic standard used for shape-stability snapshots. Four
// criteria deliberately chosen to exercise every conformance verdict
// the VPAT builder can emit (Supports / Does Not Support / Partially
// Supports via violations, Not Evaluated for manual). Keeps snapshots
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
      title: "Failing Criterion",
      level: "A",
      description: "Synthetic criterion that fails because a rule emitted an error violation.",
      url: "https://example.test/snapshot-standard#1-1-1",
      automatable: "full",
    },
    {
      id: "snapstd:2.1.1",
      standardId: "snapstd",
      localId: "2.1.1",
      title: "Passing Criterion",
      level: "A",
      description: "Synthetic criterion the scan checked with no findings.",
      url: "https://example.test/snapshot-standard#2-1-1",
      automatable: "full",
    },
    {
      id: "snapstd:3.1.1",
      standardId: "snapstd",
      localId: "3.1.1",
      title: "Manual Criterion",
      level: "AA",
      description: "Synthetic criterion that requires manual review.",
      url: "https://example.test/snapshot-standard#3-1-1",
      automatable: "manual",
    },
    {
      id: "snapstd:4.1.1",
      standardId: "snapstd",
      localId: "4.1.1",
      title: "Warning-Only Criterion",
      level: "A",
      description: "Synthetic criterion that emits warnings but not errors.",
      url: "https://example.test/snapshot-standard#4-1-1",
      automatable: "full",
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
    {
      ruleId: "synthetic/warning-rule",
      fixClass: "guidance",
      criteria: ["snapstd:4.1.1"],
      severity: "warning",
      location: { filePath: "src/Soft.tsx", line: 3, column: 1 },
      message: "Synthetic warning violation.",
      suggestion: "Review the soft case.",
    },
  ]),
  filesScanned: 2,
  durationMs: 7,
  enabledStandards: ["snapstd"],
  isTTY: false,
};

const SNAPSHOT_GENERATED_AT = "2026-04-11T00:00:00Z";
const SNAPSHOT_PRODUCT = {
  productName: "Snapshot Product",
  productVersion: "9.9.9",
  contactEmail: "snapshot@example.test",
  contactOrganization: "Snapshot Org",
  evaluationMethods: "Static source code analysis (snapshot harness).",
  notesOnEvaluation: "Pinned synthetic input — regenerate on intentional shape changes.",
};

/**
 * Replaces the build-driven `evaluator.name` ("ra11y vX.Y.Z") with a
 * version-stable placeholder so the snapshot survives version bumps.
 * Field shapes, ordering, and every other value stay intact.
 */
function normalizeVpatReport(
  report: ReturnType<typeof buildVpatReport>,
): Record<string, unknown> {
  return {
    ...report,
    evaluator: {
      ...report.evaluator,
      name: "ra11y v<pinned>",
    },
  };
}

function normalizeVpatMarkdown(md: string): string {
  return md.replace(/(- \*\*Evaluator\*\*: ra11y v)[^\n]+/g, "$1<pinned>");
}

describe("VPAT snapshot shape pin", () => {
  it("matches the JSON snapshot for the pinned synthetic scan", () => {
    const report = buildVpatReport(SNAPSHOT_RESULT, [SNAPSHOT_STANDARD], {
      generatedAt: SNAPSHOT_GENERATED_AT,
      product: SNAPSHOT_PRODUCT,
    });
    expect(normalizeVpatReport(report)).toMatchSnapshot();
  });

  it("matches the markdown snapshot for the pinned synthetic scan", () => {
    const report = buildVpatReport(SNAPSHOT_RESULT, [SNAPSHOT_STANDARD], {
      generatedAt: SNAPSHOT_GENERATED_AT,
      product: SNAPSHOT_PRODUCT,
    });
    const md = renderVpatMarkdown(report);
    expect(normalizeVpatMarkdown(md)).toMatchSnapshot();
  });
});
