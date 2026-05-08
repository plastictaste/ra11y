/**
 * Unit tests for the `list_attestations` MCP tool.
 *
 * Guards the enumerate-only shape the tool promises:
 *
 *   - An empty ledger surfaces `attestations: []` and `totalCount: 0`
 *     (affirmative empty — CLAUDE.md §1 "Surface, don't suppress").
 *   - Fresh attestations (no files changed since the stamp commit)
 *     surface the record but OMIT `stale` (present-when-meaningful).
 *   - Stale attestations (scoped file changed since the stamp) surface
 *     `stale: true` plus a `staleCount` in meta.
 *   - Outside a git repo, the probe is unavailable: the response
 *     surfaces `meta.staleProbeUnavailable: true` and omits
 *     `staleCount` entirely (reporting 0 would be a lie). No record
 *     carries `stale`.
 *   - File-scope attestations stay stale-neutral when only unrelated
 *     files change — the probe answers `false` because the scoped
 *     file wasn't touched.
 *
 * Tests drive the handler directly with scratch git repos rather than
 * through JSON-RPC — the protocol layer is covered by the MCP server
 * test.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAttestation } from "../../../src/config/attestation-store.ts";
import { McpSession } from "../../../src/mcp/session.ts";
import {
  type AttestationOut,
  listAttestationsTool,
} from "../../../src/mcp/tool-list-attestations.ts";

interface ListAttestationsResponse {
  readonly attestations: readonly AttestationOut[];
  readonly meta: {
    readonly cwd: string;
    readonly storePath: string;
    readonly totalCount: number;
    readonly staleCount?: number;
    readonly staleProbeUnavailable?: true;
  };
  readonly nextStep?: string;
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  // Canonicalize the scratch dir before handing it to tests.
  // `mkdtemp` returns the symlinked macOS tmp path (`/var/folders/...`),
  // but `git rev-parse --show-toplevel` canonicalizes to
  // `/private/var/folders/...` — and the staleness probe joins
  // changed-file paths against the canonical root, so scoped record
  // paths have to live in the same space or set-membership fails.
  const raw = await mkdtemp(join(tmpdir(), "ra11y-list-attestations-"));
  const dir = realpathSync(raw);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function git(cwd: string, args: readonly string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

/**
 * Initializes a git repo with a stable identity so commits are
 * deterministic. The identity values are scoped to this repo only
 * (git config without --global) — no interaction with the user's
 * global git config.
 */
function initRepo(cwd: string): void {
  git(cwd, ["init", "--quiet", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@ra11y.local"]);
  git(cwd, ["config", "user.name", "ra11y test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
}

/**
 * Commit every staged + working-tree change with whatever wall-clock
 * date git happens to assign. We deliberately AVOID `GIT_AUTHOR_DATE`
 * / `GIT_COMMITTER_DATE` env-var passthrough — Windows runners have
 * shown the env passthrough to be unreliable in practice (Bun /
 * spawnSync env-block encoding subtleties), and when committer-date
 * defaults to wall-clock-now while the test stamps the attestation at
 * a hard-coded past timestamp, `git rev-list --before=<stamp>` finds
 * no commit and the staleness probe returns null — the test then sees
 * `entry.stale === undefined` instead of `true`.
 *
 * The env-free contract: tests using this helper read back the actual
 * committer-date (`%cI`) and compute relative stamp timestamps from
 * those values, so resolution stays deterministic regardless of host
 * OS or env-var fidelity. {@link readCommitterDateOfHead} is the
 * companion helper.
 */
function commit(cwd: string, message: string): void {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--quiet", "--allow-empty", "-m", message]);
}

/**
 * Returns the committer-date of HEAD as an ISO 8601 string.
 * `git log -1 --format=%cI` emits a strict ISO 8601 timestamp; we
 * pass it back to `Date.parse` to compute "halfway between two
 * commits" timestamps for stamp positioning.
 */
function readCommitterDateOfHead(cwd: string): string {
  const r = spawnSync("git", ["log", "-1", "--format=%cI"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git log failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Returns an ISO timestamp halfway between two ISO timestamps. Used
 * to position an attestation stamp strictly between two commits so
 * `git rev-list --before=<stamp>` deterministically picks the earlier
 * commit even when the two committer-dates are seconds apart.
 */
function midpointIso(earlierIso: string, laterIso: string): string {
  const ms = (Date.parse(earlierIso) + Date.parse(laterIso)) / 2;
  return new Date(ms).toISOString();
}

/**
 * Sleeps long enough that two consecutive `git commit` calls land on
 * distinct committer-second timestamps. Git's committer-date has
 * 1-second resolution, so 1100ms is the minimum guarantee. Used by
 * tests that need `commit1.cdate < commit2.cdate` to compute a
 * midpoint — without the wait, both commits stamp the same second and
 * the midpoint computation collapses.
 */
async function waitForNextCommitterSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
}

async function callTool(cwd: string): Promise<ListAttestationsResponse> {
  const session = new McpSession();
  const result = await listAttestationsTool.handler({ cwd }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "") as ListAttestationsResponse;
}

describe("list_attestations: empty ledger", () => {
  // Guards the affirmative-empty contract: an empty ledger surfaces
  // `attestations: []` and `totalCount: 0` — not a sign the tool never
  // ran. Per CLAUDE.md §1 "Surface, don't suppress."
  it("returns an empty list and totalCount: 0 when no ledger file exists", async () => {
    await withScratch(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, "README.md"), "# scratch\n");
      commit(dir, "initial");
      const body = await callTool(dir);
      expect(body.attestations).toEqual([]);
      expect(body.meta.totalCount).toBe(0);
      expect(body.meta.staleCount).toBe(0);
      expect(body.meta.staleProbeUnavailable).toBeUndefined();
      expect(body.nextStep).toContain("Ledger is empty");
    });
  });
});

describe("list_attestations: fresh attestation", () => {
  // Fresh = stamp commit === HEAD, so NOTHING has changed since. The
  // record must surface, but `stale` must be absent (present-when-
  // meaningful) and `staleCount` must be 0.
  it("surfaces the record with no `stale` flag when the tree is untouched since the stamp", async () => {
    await withScratch(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, "README.md"), "# scratch\n");
      commit(dir, "initial");
      // Read the actual committer-date of the only commit; stamp the
      // attestation 1ms after it so the probe resolves stamp → initial
      // commit, which is also HEAD. Reading committer-date back from
      // git itself sidesteps any host-specific env-var passthrough
      // weirdness — see the `commit` helper's docblock for why we
      // avoid GIT_AUTHOR_DATE / GIT_COMMITTER_DATE on Windows.
      const initialCdate = readCommitterDateOfHead(dir);
      const stampIso = new Date(Date.parse(initialCdate) + 1).toISOString();

      await appendAttestation(dir, {
        criterionId: "wcag22:2.4.7",
        by: "ci-bot",
        reason: "runtime harness 2026-04-18 reported pass for focus-visible",
        attestedAt: stampIso,
        evidenceSource: "runtime_tool",
        toolName: "runtime-harness 1.0.0",
        verdict: "pass",
        scope: "project",
      });

      const body = await callTool(dir);
      expect(body.attestations.length).toBe(1);
      const entry = body.attestations[0];
      if (!entry) throw new Error("missing entry");
      expect(entry.criterionId).toBe("wcag22:2.4.7");
      expect(entry.verdict).toBe("pass");
      expect(entry.scope).toBe("project");
      expect(entry.by).toBe("ci-bot");
      // Provenance fields surface verbatim. `evidenceSource` is always
      // present (the response-shape invariant); `toolName` rides along
      // present-when-meaningful.
      expect(entry.evidenceSource).toBe("runtime_tool");
      expect(entry.toolName).toBe("runtime-harness 1.0.0");
      // `stale` must be absent entirely — key presence, not truthiness.
      expect("stale" in entry).toBe(false);
      expect(body.meta.totalCount).toBe(1);
      expect(body.meta.staleCount).toBe(0);
      expect(body.meta.staleProbeUnavailable).toBeUndefined();
      // No stale records means no re-attest / prune prompt.
      expect(body.nextStep).toBeUndefined();
    });
  });
});

describe("list_attestations: stale attestation", () => {
  // Guards the stale-surface path: an attestation pinned at scope
  // "file" goes stale when the scoped file is in the changed-set
  // between its stamp commit and HEAD. The response must carry
  // `stale: true` on the record AND `staleCount: 1` in meta.
  it("surfaces stale: true when a file-scoped record's file changed since the stamp", async () => {
    await withScratch(async (dir) => {
      initRepo(dir);
      const targetFile = join(dir, "src", "Button.tsx");
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(targetFile, "export function Button() { return null; }\n");
      commit(dir, "initial");
      const initialCdate = readCommitterDateOfHead(dir);

      // Force a 1-second gap so the second commit lands on a distinct
      // committer-second; without this, `--before=midpoint` resolution
      // is ambiguous when both commits share a second.
      await waitForNextCommitterSecond();

      // Mutate the scoped file and commit so the probe sees a
      // non-empty `changedFilesBetween(stamp, HEAD)` containing the
      // scoped Button.tsx path.
      await writeFile(
        targetFile,
        "export function Button() { return <button type='button' />; }\n",
      );
      commit(dir, "update Button");
      const updateCdate = readCommitterDateOfHead(dir);

      // Stamp the attestation strictly between the two commits so
      // `git rev-list -n 1 --before=<stamp> HEAD` deterministically
      // picks the initial commit as the stamp anchor, while HEAD
      // remains at the update commit.
      const stampIso = midpointIso(initialCdate, updateCdate);
      await appendAttestation(dir, {
        criterionId: "wcag22:2.4.7",
        by: "alice",
        reason: "manual keyboard traversal confirmed for Button",
        attestedAt: stampIso,
        evidenceSource: "manual_review",
        verdict: "pass",
        scope: "file",
        location: { filePath: targetFile, line: 1, column: 1 },
      });

      const body = await callTool(dir);
      expect(body.attestations.length).toBe(1);
      const entry = body.attestations[0];
      if (!entry) throw new Error("missing entry");
      expect(entry.stale).toBe(true);
      expect(body.meta.staleCount).toBe(1);
      expect(body.meta.staleProbeUnavailable).toBeUndefined();
      expect(body.nextStep).toContain("stale");
    });
  });
});

describe("list_attestations: probe unavailable", () => {
  // Guards the honest-unknown shape when the probe can't answer:
  // `cwd` is not inside a git repo, so `headSha` returns null,
  // `createGitStalenessProbe` returns undefined, and the response
  // must surface `staleProbeUnavailable: true` WITHOUT a `staleCount`
  // (which would be a lie — we don't know how many are stale).
  it("omits staleCount and surfaces staleProbeUnavailable: true outside a git repo", async () => {
    await withScratch(async (dir) => {
      // Deliberately NO `git init` — this directory is not a repo.
      await appendAttestation(dir, {
        criterionId: "wcag22:2.4.7",
        by: "ci-bot",
        reason: "runtime harness reported pass for focus-visible",
        attestedAt: "2026-04-18T00:00:00.000Z",
        evidenceSource: "runtime_tool",
        toolName: "runtime-harness 1.0.0",
        verdict: "pass",
        scope: "project",
      });

      const body = await callTool(dir);
      expect(body.attestations.length).toBe(1);
      const entry = body.attestations[0];
      if (!entry) throw new Error("missing entry");
      // Every record must have `stale` absent when the probe is
      // unavailable — staleness is indeterminate, and guessing is
      // the silent-miss failure mode CLAUDE.md §1 warns against.
      expect("stale" in entry).toBe(false);
      expect(body.meta.staleProbeUnavailable).toBe(true);
      // staleCount must be absent entirely — key presence, not a
      // sentinel 0. Consumers branch on presence.
      expect("staleCount" in body.meta).toBe(false);
      expect(body.nextStep).toContain("not inside a git repo");
    });
  });
});

describe("list_attestations: file-scope with unrelated changes", () => {
  // Guards the file-scope stale-neutral path: when the scoped file
  // is untouched and only unrelated files changed, the probe must
  // return `false` for that record, not `true`. Without this, a
  // component-level attestation would go stale every time anyone
  // commits anywhere in the tree — noise the agent has to re-verify
  // for no good reason.
  it("keeps stale absent when only unrelated files change (file scope)", async () => {
    await withScratch(async (dir) => {
      initRepo(dir);
      await mkdir(join(dir, "src"), { recursive: true });
      const scopedFile = join(dir, "src", "Button.tsx");
      const unrelatedFile = join(dir, "src", "Icon.tsx");
      await writeFile(scopedFile, "export const Button = () => null;\n");
      await writeFile(unrelatedFile, "export const Icon = () => null;\n");
      commit(dir, "initial");
      const initialCdate = readCommitterDateOfHead(dir);

      await waitForNextCommitterSecond();

      // Change ONLY the unrelated file, then commit. The probe reads
      // changedFilesBetween(stamp, HEAD) and sees just Icon.tsx — the
      // scoped Button.tsx is absent, so the record stays fresh.
      await writeFile(unrelatedFile, "export const Icon = () => <svg />;\n");
      commit(dir, "update Icon");
      const updateCdate = readCommitterDateOfHead(dir);

      const stampIso = midpointIso(initialCdate, updateCdate);
      await appendAttestation(dir, {
        criterionId: "wcag22:2.4.7",
        by: "alice",
        reason: "manual keyboard traversal confirmed for Button",
        attestedAt: stampIso,
        evidenceSource: "manual_review",
        verdict: "pass",
        scope: "file",
        location: { filePath: scopedFile, line: 1, column: 1 },
      });

      const body = await callTool(dir);
      expect(body.attestations.length).toBe(1);
      const entry = body.attestations[0];
      if (!entry) throw new Error("missing entry");
      expect("stale" in entry).toBe(false);
      expect(body.meta.staleCount).toBe(0);
      expect(body.nextStep).toBeUndefined();
    });
  });
});
