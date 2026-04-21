/**
 * Unit tests for `src/mcp/ecosystem-detect.ts` — the root-level
 * ecosystem probe the `propose_config` tool uses to surface
 * `foreign_ecosystem_detected: <language>` on the top-level warnings
 * channel.
 *
 * Invariants under test:
 *   1. Each recognized marker in isolation returns its language tag.
 *   2. `package.json` short-circuits the detector regardless of which
 *      foreign marker is ALSO present (a mixed Rails+JS or PyO3 repo
 *      is unambiguously Node-aware and doesn't earn the label).
 *   3. A clean repo with no markers returns `null` — the caller
 *      conditional-spreads the `warnings` field away rather than
 *      emitting `warnings: []`.
 *   4. `foreignEcosystemWarning` wraps the detected language in the
 *      wire-level `foreign_ecosystem_detected: <language>` string.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectForeignEcosystem,
  type ForeignEcosystem,
  foreignEcosystemWarning,
} from "../../../src/mcp/ecosystem-detect.ts";

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-ecosystem-detect-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("detectForeignEcosystem: single-marker repos", () => {
  const cases: ReadonlyArray<{
    readonly marker: string;
    readonly language: ForeignEcosystem;
    readonly body: string;
  }> = [
    { marker: "Gemfile", language: "ruby", body: "source 'https://rubygems.org'\n" },
    { marker: "pyproject.toml", language: "python", body: "[project]\nname = 'x'\n" },
    { marker: "go.mod", language: "go", body: "module example.com/x\n\ngo 1.22\n" },
    { marker: "Cargo.toml", language: "rust", body: '[package]\nname = "x"\n' },
  ];

  for (const { marker, language, body } of cases) {
    it(`returns "${language}" when ${marker} is present and package.json is absent`, async () => {
      await withScratch(async (dir) => {
        await writeFile(join(dir, marker), body);
        expect(detectForeignEcosystem(dir)).toBe(language);
      });
    });
  }
});

describe("detectForeignEcosystem: package.json short-circuits", () => {
  // Canonical "mixed stack" case — a Rails monorepo with a JS bundler
  // layer carries both Gemfile and package.json. The predicate reads
  // this as "Node-aware" and returns null so the agent doesn't get a
  // warning that would be wrong in context.
  it("returns null when package.json is present alongside Gemfile", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "Gemfile"), "source 'https://rubygems.org'\n");
      await writeFile(join(dir, "package.json"), '{"name":"x"}\n');
      expect(detectForeignEcosystem(dir)).toBeNull();
    });
  });

  // Same reasoning for the Python-native case — a project using PyO3
  // (Rust + Python) with a Node-based docs layer should not earn the
  // foreign-ecosystem label.
  it("returns null when package.json is present alongside pyproject.toml and Cargo.toml", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "pyproject.toml"), "[project]\nname = 'x'\n");
      await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
      await writeFile(join(dir, "package.json"), '{"name":"x"}\n');
      expect(detectForeignEcosystem(dir)).toBeNull();
    });
  });

  // A plain Node project — just package.json, no foreign markers. The
  // detector must NOT fabricate an ecosystem tag when nothing fired;
  // returning null here closes the ambiguous-shape failure mode.
  it("returns null for a plain Node project (package.json only)", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"name":"x"}\n');
      expect(detectForeignEcosystem(dir)).toBeNull();
    });
  });
});

describe("detectForeignEcosystem: empty repo", () => {
  it("returns null when no recognized marker is present", async () => {
    // Intentionally empty — no package.json, no Gemfile, no go.mod.
    // Resolve via Promise.resolve so the `withScratch` callback remains
    // async-compatible without awaiting a synchronous probe.
    await withScratch((dir) => {
      expect(detectForeignEcosystem(dir)).toBeNull();
      return Promise.resolve();
    });
  });
});

describe("foreignEcosystemWarning", () => {
  // Guards the wire-level shape — agents branch on the exact string
  // `foreign_ecosystem_detected: <language>`, so drift in the prefix
  // or tag format breaks consumers. Deliberate assertion against the
  // full literal rather than a substring check.
  it("returns the wire-level warning string `foreign_ecosystem_detected: <language>` when a foreign ecosystem resolves", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "go.mod"), "module x\n");
      expect(foreignEcosystemWarning(dir)).toBe("foreign_ecosystem_detected: go");
    });
  });

  it("returns null in a plain Node project so the caller conditional-spreads `warnings` away", async () => {
    await withScratch(async (dir) => {
      await writeFile(join(dir, "package.json"), '{"name":"x"}\n');
      expect(foreignEcosystemWarning(dir)).toBeNull();
    });
  });
});
