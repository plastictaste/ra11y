import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../../src/index.ts";

describe("programmatic scan()", () => {
  it("discovers, parses, and scans files from the public API", async () => {
    await withTempFile(
      `<html lang="en"><head><title>x</title></head><body><img src="x.png"></body></html>`,
      async (filePath) => {
        const result = await scan({ paths: [filePath] });
        expect(result.filesScanned).toBe(1);
        expect(result.enabledStandards).toEqual(["wcag22"]);
        expect(result.violations.some((v) => v.ruleId === "media/alt-text-missing")).toBe(true);
      },
    );
  });

  it("honors explicit standards", async () => {
    await withTempFile(
      `<html lang="en"><head><title>x</title></head><body><img src="x.png"></body></html>`,
      async (filePath) => {
        const result = await scan({ paths: [filePath], standards: ["wcag21"] });
        expect(result.enabledStandards).toEqual(["wcag21"]);
      },
    );
  });
});

async function withTempFile(
  source: string,
  run: (filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-programmatic-scan-"));
  try {
    const filePath = join(dir, "index.html");
    await writeFile(filePath, source);
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
