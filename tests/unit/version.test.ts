import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../src/version.ts";

/**
 * VERSION is the single source of truth every compliance artifact consumes
 * (SARIF tool version, VPAT evaluator, baseline ra11yVersion, JSON payload,
 * terminal banner, CLI --version, agent formatter, MCP serverInfo). The
 * test guarantees the constant always matches `package.json.version` so a
 * shipped scan never mis-identifies the tool.
 */
describe("VERSION", () => {
  it("equals package.json.version", () => {
    const root = join(import.meta.dir, "..", "..");
    const raw = readFileSync(join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("is a non-empty semver-shaped string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
    // loose check: leading number + dots — enough to catch "" or undefined.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
