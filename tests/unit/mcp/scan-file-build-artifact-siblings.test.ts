/**
 * Directory-sibling probe driving scan_file's build-artifact lane
 * parity (per `docs/kb/architecture/ai-first-consumer.md` "Per-tool
 * lane and warning-set classification must agree"). The helper reads
 * the parent directory once and returns the subset of siblings whose
 * filename shape can corroborate
 * {@link findSiblingMinFile} or {@link findSiblingSourcemap} — every
 * other entry is filtered out so the auxiliary path set stays tight.
 *
 * Probe is best-effort: unreadable directories return `[]` so the
 * scan_file response stays honest even when fs access is restricted.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posixJoin } from "../../helpers/path.ts";
import { probeDirectoryForArtifactSiblings } from "../../../src/mcp/scan-file-build-artifact-siblings.ts";

describe("probeDirectoryForArtifactSiblings", () => {
  it("returns the .min.<ext> twin when the target's minified sibling lives in the same directory", () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-sib-min-"));
    try {
      const target = posixJoin(root, "adminlte.css");
      const minTwin = posixJoin(root, "adminlte.min.css");
      writeFileSync(target, "/* x */\n");
      writeFileSync(minTwin, "/* y */\n");
      const siblings = probeDirectoryForArtifactSiblings(target);
      expect(siblings).toContain(minTwin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the .map sibling when a sourcemap pair lives in the same directory", () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-sib-map-"));
    try {
      const target = posixJoin(root, "app.js");
      const map = posixJoin(root, "app.js.map");
      writeFileSync(target, "console.log(1);\n");
      writeFileSync(map, '{"version":3}\n');
      const siblings = probeDirectoryForArtifactSiblings(target);
      expect(siblings).toContain(map);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters out unrelated directory entries (only twins / sourcemaps qualify)", () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-sib-noise-"));
    try {
      const target = posixJoin(root, "site.css");
      writeFileSync(target, ".x{}\n");
      writeFileSync(posixJoin(root, "unrelated.css"), ".y{}\n");
      writeFileSync(posixJoin(root, "README.md"), "x\n");
      writeFileSync(posixJoin(root, "site.scss"), ".z{}\n");
      const siblings = probeDirectoryForArtifactSiblings(target);
      // No .min sibling, no .map sibling — and unrelated entries do
      // not qualify because their names don't match the predicate.
      expect(siblings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not include the target itself in the sibling list", () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-sib-self-"));
    try {
      const target = posixJoin(root, "adminlte.min.css");
      writeFileSync(target, ".x{}\n");
      const siblings = probeDirectoryForArtifactSiblings(target);
      expect(siblings).not.toContain(target);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the target has no extension (no sibling-pair predicate is meaningful)", () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-sib-noext-"));
    try {
      const target = posixJoin(root, "Makefile");
      writeFileSync(target, "all:\n\techo x\n");
      const siblings = probeDirectoryForArtifactSiblings(target);
      expect(siblings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list silently when the target's parent directory cannot be read", () => {
    // Pointing at a path under a directory that does not exist on disk
    // exercises the readdir failure path. The probe must not throw.
    const ghostTarget = "/this-directory/should/never-exist-on-real-fs/site.css";
    const siblings = probeDirectoryForArtifactSiblings(ghostTarget);
    expect(siblings).toEqual([]);
  });
});
