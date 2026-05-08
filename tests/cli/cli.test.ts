import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { runCli } from "../../src/cli/run.ts";
import { setColorEnabled } from "../../src/utils/ansi.ts";

// CLI tests run in the fixture directory so --positional paths are
// relative to somewhere with predictable content.
const FIXTURES_ROOT = join(import.meta.dir, "..", "fixtures");
const originalCwd = cwd();

beforeAll(() => {
  // Ensure formatter output is deterministic across environments.
  setColorEnabled(false);
  chdir(FIXTURES_ROOT);
});

afterAll(() => {
  chdir(originalCwd);
});

describe("runCli", () => {
  it("--help prints usage and exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ra11y");
    expect(r.stdout).toContain("USAGE");
    expect(r.stdout).toContain("--standard");
  });

  it("-h is an alias for --help", async () => {
    const r = await runCli(["-h"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("USAGE");
  });

  it("--version prints the version and exits 0", async () => {
    const r = await runCli(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^ra11y v\d+\.\d+\.\d+/);
  });

  it("--list-rules includes media/alt-text-missing", async () => {
    const r = await runCli(["--list-rules"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("media/alt-text-missing");
    expect(r.stdout).toContain("wcag22:1.1.1");
  });

  it("--list-standards lists wcag22 with its metadata", async () => {
    const r = await runCli(["--list-standards"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("wcag22");
    expect(r.stdout).toContain("WCAG 2.2");
    expect(r.stdout).toContain("W3C");
    expect(r.stdout).toContain("86 total");
  });

  it("--explain <rule-id> prints detailed rule metadata", async () => {
    const r = await runCli(["--explain", "media/alt-text-missing"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("media/alt-text-missing");
    expect(r.stdout).toContain("Normative text");
    expect(r.stdout).toContain("Rationale");
    expect(r.stdout).toContain("References");
  });

  it("--explain with a missing rule errors with exit 2", async () => {
    const r = await runCli(["--explain", "nope/missing"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not found");
  });

  it("scan over good fixtures returns exit 0", async () => {
    const r = await runCli(["good/alt-text-missing", "--format", "plain"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("0 violations");
  });

  it("scan over bad fixtures surfaces violations and exits 1", async () => {
    const r = await runCli(["bad/alt-text-missing", "--format", "plain"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("media/alt-text-missing");
    expect(r.stdout).toContain("error");
  });

  it("--format json produces parseable JSON output", async () => {
    const r = await runCli(["bad/alt-text-missing", "--format", "json"]);
    expect(r.exitCode).toBe(1);
    // runCli appends a newline at the end via the scan command; trim.
    const parsed = JSON.parse(r.stdout) as {
      ra11y: { version: string };
      result: { violations: unknown[] };
    };
    expect(parsed.ra11y.version).toBeDefined();
    expect(Array.isArray(parsed.result.violations)).toBe(true);
    expect(parsed.result.violations.length).toBeGreaterThan(0);
  });

  it("--fail-on never forces exit 0 even with violations", async () => {
    const r = await runCli(["bad/alt-text-missing", "--format", "plain", "--fail-on", "never"]);
    expect(r.exitCode).toBe(0);
    // Violations are still reported — just not failed on.
    expect(r.stdout).toContain("media/alt-text-missing");
  });

  it("--standard with an unknown standard exits 2 with a clear error", async () => {
    const r = await runCli(["good/alt-text-missing", "--standard", "nosuch"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown standard");
  });

  it("--exclude skips matching files (gitignore-style glob)", async () => {
    const r = await runCli(["bad/alt-text-missing", "--format", "plain", "--exclude", "jsx-img*"]);
    expect(r.exitCode).toBe(1);
    // jsx file should be filtered out; still fails on HTML violations.
    expect(r.stdout).not.toContain("jsx-img-no-alt.tsx");
    expect(r.stdout).toContain("img-no-alt.html");
  });

  it("scan with no positionals uses the current directory", async () => {
    // cwd is tests/fixtures — walks good/ and bad/ together.
    const r = await runCli(["--format", "plain"]);
    // Has both good (zero violations locally) and bad (some violations).
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("media/alt-text-missing");
  });

  // Guards CLI-side argument routing for `--format <name>`. v1.0 ships
  // 8 builtin formatters as a public surface; a regression in the
  // `--format` switch or in formatter registration would not surface
  // until release without an end-to-end CLI exercise. The snapshot
  // tests at tests/snapshot/formatters.test.ts cover formatter content;
  // this suite covers the CLI seam each formatter sits behind.
  describe("--format <name> end-to-end through the CLI", () => {
    // Enumerated from src/output/formatters/index.ts — keep in lockstep
    // with BuiltinFormatters when a new formatter lands. When the union
    // grows, this list should grow too.
    const FORMATTERS = [
      "terminal",
      "plain",
      "json",
      "sarif",
      "junit",
      "markdown",
      "html",
      "agent",
    ] as const;

    for (const name of FORMATTERS) {
      it(`--format ${name} produces non-empty stdout against a real fixture`, async () => {
        const r = await runCli(["bad/alt-text-missing", "--format", name]);
        // Bad fixtures fire violations; default --fail-on=error → exit 1.
        expect(r.exitCode).toBe(1);
        expect(r.stdout.length).toBeGreaterThan(0);
      });
    }

    it("--format sarif emits a SARIF 2.1.0 log with a populated runs[] array", async () => {
      const r = await runCli(["bad/alt-text-missing", "--format", "sarif"]);
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(r.stdout) as {
        version: string;
        runs: { results: unknown[] }[];
      };
      expect(parsed.version).toBe("2.1.0");
      expect(parsed.runs.length).toBeGreaterThan(0);
      expect(Array.isArray(parsed.runs[0]?.results)).toBe(true);
    });

    it("--format junit emits a <testsuites> XML envelope with at least one suite", async () => {
      const r = await runCli(["bad/alt-text-missing", "--format", "junit"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('<?xml version="1.0"');
      expect(r.stdout).toContain("<testsuites");
      expect(r.stdout).toContain("<testsuite ");
      expect(r.stdout).toContain("</testsuites>");
    });

    it("--format agent emits parseable JSON with plan, files, reviewCandidates, meta", async () => {
      const r = await runCli(["bad/alt-text-missing", "--format", "agent"]);
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(r.stdout) as {
        plan: unknown;
        files: unknown[];
        reviewCandidates: unknown[];
        meta: unknown;
      };
      expect(parsed.plan).toBeDefined();
      expect(Array.isArray(parsed.files)).toBe(true);
      expect(parsed.meta).toBeDefined();
    });

    it("--format markdown emits a header readable in PR comment renderers", async () => {
      const r = await runCli(["bad/alt-text-missing", "--format", "markdown"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("## ra11y accessibility report");
    });

    it("--format html emits a self-contained <html> document", async () => {
      const r = await runCli(["bad/alt-text-missing", "--format", "html"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("<html");
      expect(r.stdout).toContain("</html>");
    });

    it("--format with an unknown name silently falls back to terminal (per normalizeFormat)", async () => {
      // normalizeFormat() maps any unrecognized value to "terminal"; the
      // CLI does not error on unknown formats. This pins that behavior
      // so a future tightening (exit 2 on unknown) is a deliberate change.
      const r = await runCli([
        "bad/alt-text-missing",
        "--format",
        "definitely-not-a-real-formatter",
      ]);
      expect(r.exitCode).toBe(1);
      // Terminal output is not JSON; agent/json/sarif outputs would parse.
      // Asserting non-JSON is the cheapest fallback proof.
      expect(() => JSON.parse(r.stdout)).toThrow();
    });
  });

  describe("processes config threading", () => {
    // Guards the CLI-side wiring: `runScan({ processes })` must receive
    // `LoadedConfig.processes` so project-scoped finders (WCAG 3.2.3 /
    // 3.2.4) fire when a config declares `processes`. The test scans a
    // scratch tree where two pages share `data-testid="primary"` but
    // carry divergent visible labels — the canonical
    // consistent-identification divergence. With `processes` threaded,
    // the `agent` formatter's `reviewCandidates` array carries a
    // `wcag22:3.2.4` entry; without threading, the finder returns no
    // candidates (honest "needs processes config" per ADR 0016).
    it("surfaces a wcag22:3.2.4 review candidate when processes config is declared", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { realpathSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const raw = await mkdtemp(joinPath(tmpdir(), "ra11y-cli-proc-"));
      const dir = realpathSync(raw);
      // Full <head> so rule-level violations (missing title/lang) don't
      // fire and the scan exit code reflects only the threading delta.
      await writeFile(
        joinPath(dir, "cart.html"),
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cart</title></head><body><button data-testid="primary">Save</button></body></html>',
      );
      await writeFile(
        joinPath(dir, "checkout.html"),
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checkout</title></head><body><button data-testid="primary">Submit</button></body></html>',
      );
      await writeFile(
        joinPath(dir, "ra11y.config.json"),
        JSON.stringify({
          processes: [{ name: "checkout", pages: ["cart.html", "checkout.html"] }],
        }),
      );

      const savedCwd = cwd();
      chdir(dir);
      try {
        const r = await runCli(["--format", "agent"]);
        expect(r.exitCode).toBe(0);
        const data = JSON.parse(r.stdout) as {
          reviewCandidates: readonly { criterionId: string }[];
        };
        const has324 = data.reviewCandidates.some((c) => c.criterionId === "wcag22:3.2.4");
        expect(has324).toBe(true);
      } finally {
        chdir(savedCwd);
      }
    });
  });
});
