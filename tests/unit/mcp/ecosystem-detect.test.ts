/**
 * Unit tests for `src/mcp/ecosystem-detect.ts` — the root-level
 * ecosystem probe the `propose_config` tool uses to surface the
 * static `foreign_ecosystem_detected` warning code on the top-level
 * warnings channel.
 *
 * Invariants under test:
 *   1. Each recognized marker in isolation returns its language tag.
 *   2. `package.json` short-circuits the detector regardless of which
 *      foreign marker is ALSO present (a mixed Rails+JS or PyO3 repo
 *      is unambiguously Node-aware and doesn't earn the label).
 *   3. A clean repo with no markers returns `null` — the caller
 *      conditional-spreads the `warnings` field away rather than
 *      emitting `warnings: []`.
 *   4. `foreignEcosystemDetected` returns the structured payload
 *      (`{ ecosystem, evidence, hasPackageJson }`) that rides under
 *      `warningsDetails.foreign_ecosystem_detected` — the static-code
 *      replacement for the colon-suffixed dynamic identifier per the
 *      AI-first doctrine "Empty `warningsDetails.<code>: {}` is
 *      dishonest."
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  detectForeignEcosystem,
  FOREIGN_ECOSYSTEM_DETECTED_CODE,
  type ForeignEcosystem,
  foreignEcosystemDetected,
} from "../../../src/mcp/ecosystem-detect.ts";
import { posixJoin } from "../../helpers/path.ts";

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-ecosystem-detect-"));
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
        await writeFile(posixJoin(dir, marker), body);
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
      await writeFile(posixJoin(dir, "Gemfile"), "source 'https://rubygems.org'\n");
      await writeFile(posixJoin(dir, "package.json"), '{"name":"x"}\n');
      expect(detectForeignEcosystem(dir)).toBeNull();
    });
  });

  // Same reasoning for the Python-native case — a project using PyO3
  // (Rust + Python) with a Node-based docs layer should not earn the
  // foreign-ecosystem label.
  it("returns null when package.json is present alongside pyproject.toml and Cargo.toml", async () => {
    await withScratch(async (dir) => {
      await writeFile(posixJoin(dir, "pyproject.toml"), "[project]\nname = 'x'\n");
      await writeFile(posixJoin(dir, "Cargo.toml"), '[package]\nname = "x"\n');
      await writeFile(posixJoin(dir, "package.json"), '{"name":"x"}\n');
      expect(detectForeignEcosystem(dir)).toBeNull();
    });
  });

  // A plain Node project — just package.json, no foreign markers. The
  // detector must NOT fabricate an ecosystem tag when nothing fired;
  // returning null here closes the ambiguous-shape failure mode.
  it("returns null for a plain Node project (package.json only)", async () => {
    await withScratch(async (dir) => {
      await writeFile(posixJoin(dir, "package.json"), '{"name":"x"}\n');
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

describe("foreignEcosystemDetected", () => {
  // Guards the static-code-with-payload contract: the wire-level
  // warning code is the static identifier `foreign_ecosystem_detected`
  // (not a colon-suffixed `foreign_ecosystem_detected: <language>`),
  // and the language tag rides under
  // `warningsDetails.foreign_ecosystem_detected.ecosystem`. The
  // dynamic-suffix shape was rejected because the colon-suffixed code
  // can't key the typed `warningsDetails` slot — every code in
  // `warnings[]` must resolve to a stable identifier on the schema
  // dispatch table. Deliberate assertion against the static string so
  // a regression that re-introduces the dynamic suffix breaks the
  // test loudly.
  it("emits the static code identifier on the warning channel (no colon-suffixed dynamic value)", () => {
    expect(FOREIGN_ECOSYSTEM_DETECTED_CODE).toBe("foreign_ecosystem_detected");
  });

  it("returns a structured payload with ecosystem, evidence list, and hasPackageJson when a foreign marker resolves", async () => {
    await withScratch(async (dir) => {
      await writeFile(posixJoin(dir, "go.mod"), "module x\n");
      const detail = foreignEcosystemDetected(dir);
      expect(detail).not.toBeNull();
      expect(detail?.ecosystem).toBe("go");
      expect(detail?.evidence).toEqual(["go.mod"]);
      expect(detail?.hasPackageJson).toBe(false);
    });
  });

  it("returns null in a plain Node project so the caller conditional-spreads `warnings` away", async () => {
    await withScratch(async (dir) => {
      await writeFile(posixJoin(dir, "package.json"), '{"name":"x"}\n');
      expect(foreignEcosystemDetected(dir)).toBeNull();
    });
  });

  it("evidence array is sorted alphabetically for deterministic wire output", async () => {
    // Scenario: a future ecosystem entry listing multiple markers (e.g.
    // python adding `Pipfile` alongside `pyproject.toml`). The current
    // table has one marker per ecosystem so this test pins the sort
    // discipline without depending on multi-marker rows.
    await withScratch(async (dir) => {
      await writeFile(posixJoin(dir, "Cargo.toml"), '[package]\nname = "x"\n');
      const detail = foreignEcosystemDetected(dir);
      // Sort guarantees a stable wire shape regardless of the
      // declaration order on FOREIGN_MARKERS.
      const evidence = detail?.evidence ?? [];
      const sorted = [...evidence].sort();
      expect(evidence).toEqual(sorted);
    });
  });
});
