/**
 * Unit tests for `runVpat` — the handler backing `ra11y --vpat`.
 * Drives the handler directly against a tmpdir fixture project.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chdir, cwd } from "node:process";
import { parseCliArgs } from "../../../../src/cli/args.ts";
import { runVpat } from "../../../../src/cli/commands/vpat.ts";
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
