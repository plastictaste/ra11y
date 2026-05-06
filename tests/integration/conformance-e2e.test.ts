/**
 * End-to-end integration test for the conformance pipeline:
 *
 *   scan → attest → conformance_statement → verifyConformanceBundle
 *
 * Each scenario runs against a fresh on-disk git repository under
 * `os.tmpdir()`. Git operations are shelled out via `node:child_process`
 * to keep the test against the same interface `src/utils/git.ts` uses in
 * production — no mocks — per the zero-deps rule (CLAUDE.md §3) and the
 * "no mocks for databases / filesystems / network" constraint.
 *
 * Four scenarios:
 *   (a) Happy-path signed-bundle round trip — every A-level criterion
 *       attested, statement conformant, signature populated, the same
 *       fingerprint verifies valid.
 *   (b) Stale-attestation blocker — attestations stamped at a commit
 *       before the most recent scanned mutation surface as
 *       `reason: "stale-attestation"` blockers.
 *   (c) Source-modified after sign — flipping one scanned file on disk
 *       without committing drifts the file-manifest SHA; re-verifying
 *       the stored signature against the rebuilt current-state input
 *       returns `file-manifest-mismatch`.
 *   (d) Tampered `.ra11y/attestations.jsonl` ledger — rewriting a
 *       committed attestation line in the working tree without a
 *       corresponding commit surfaces a `removed-since-head` finding
 *       from `ra11y attestations verify`, which exits non-zero per
 *       ADR 0020.
 *
 * The test avoids time-based assertions. Ordering is anchored on
 * explicit author/committer dates passed to `git commit` so
 * `git rev-list --before=<stamp>` resolves deterministically.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chdir, cwd as getCwd } from "node:process";
import { runCli } from "../../src/cli/run.ts";
import {
  appendAttestation,
  resolveAttestationStorePath,
} from "../../src/config/attestation-store.ts";
import { McpSession } from "../../src/mcp/session.ts";
import { conformanceStatementTool } from "../../src/mcp/tool-conformance-statement.ts";
import {
  type ConformanceSignature,
  type SignatureInput,
  verifyConformanceBundle,
} from "../../src/reports/conformance-signature.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";
import type { AttestationRecord } from "../../src/types/evidence.ts";
import { posixJoin } from "../helpers/path.ts";

// ─── Shared harness ────────────────────────────────────────────────────────

// Explicit timeline anchors. T0 seeds the initial commit, T1 stamps the
// attestations (resolves to the T0 commit via `git rev-list --before`),
// T2 is reserved for a post-attestation mutation commit in scenario (b).
// Pinning both author + committer dates makes stamp resolution
// deterministic across hosts regardless of wall-clock precision.
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";
const T2 = "2026-03-01T00:00:00.000Z";

const originalCwd = getCwd();

interface ScratchRepo {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

async function makeScratchRepo(): Promise<ScratchRepo> {
  // Canonicalize the scratch path. macOS tmpdirs return `/var/folders/...`
  // symlinks while `git rev-parse --show-toplevel` canonicalizes to
  // `/private/var/folders/...`; the staleness probe and manifest paths
  // must live in the same namespace for set-membership comparisons to
  // match.
  const raw = await mkdtemp(posixJoin(tmpdir(), "ra11y-conform-e2e-"));
  const dir = realpathSync(raw);
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function git(cwdPath: string, args: readonly string[], env?: Record<string, string>): void {
  const result = spawnSync("git", args, {
    cwd: cwdPath,
    encoding: "utf8",
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  }
}

function initRepo(dir: string): void {
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["config", "user.email", "test@ra11y.local"]);
  git(dir, ["config", "user.name", "ra11y test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitAll(dir: string, message: string, isoDate: string): void {
  git(dir, ["commit", "--quiet", "--allow-empty", "--date", isoDate, "-m", message], {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  });
}

/**
 * Writes a minimal-but-real app.tsx that survives the scanner without
 * emitting static violations. Keeps the scenarios focused on the
 * attestation + signing flow rather than rule behavior.
 */
async function seedApp(dir: string, contents = "export const App = () => null;\n"): Promise<void> {
  await writeFile(posixJoin(dir, "app.tsx"), contents, "utf8");
}

/**
 * Builds pass-verdict project-scope attestations for every in-scope
 * criterion at the given standard + level so the builder's refusal gate
 * opens and the signing flow runs.
 */
function attestationsForProfile(
  standardId: string,
  level: "A" | "AA" | "AAA" | "base",
  stamp: string = T1,
): readonly AttestationRecord[] {
  const std = BUILTIN_STANDARDS.find((s) => s.id === standardId);
  if (!std) throw new Error(`standard not found: ${standardId}`);
  const inScope = std.criteria.filter((c) => {
    if (level === "base") return true;
    if (c.level === "A") return true;
    if (c.level === "AA") return level === "AA" || level === "AAA";
    if (c.level === "AAA") return level === "AAA";
    return false;
  });
  return inScope.map((c) => ({
    criterionId: c.id,
    by: "test",
    reason: "manual review for conformance e2e",
    attestedAt: stamp,
    evidenceSource: "manual_review" as const,
    verdict: "pass" as const,
    scope: "project" as const,
  }));
}

async function seedAttestationsFile(
  dir: string,
  records: readonly AttestationRecord[],
): Promise<void> {
  await mkdir(posixJoin(dir, ".ra11y"), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  await writeFile(resolveAttestationStorePath(dir), body.length > 0 ? `${body}\n` : "", "utf8");
}

interface StatementBody {
  readonly conformant: boolean;
  readonly blockers: readonly {
    readonly criterionId: string;
    readonly reason: string;
    readonly status?: string;
    readonly staleAttestedAt?: string;
  }[];
  readonly signature?: ConformanceSignature;
  readonly warnings?: readonly string[];
  readonly limitations?: readonly string[];
  readonly markdown?: string;
}

async function callConformanceStatement(dir: string): Promise<StatementBody> {
  const session = new McpSession();
  const result = await conformanceStatementTool.handler(
    { standard: "wcag22", level: "A", cwd: dir },
    session,
  );
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "") as StatementBody;
}

let scratch: ScratchRepo | undefined;

beforeEach(async () => {
  scratch = await makeScratchRepo();
});

afterEach(async () => {
  chdir(originalCwd);
  if (scratch !== undefined) {
    await scratch.cleanup();
    scratch = undefined;
  }
});

// ─── Scenario (a): happy-path signed-bundle round trip ────────────────────

describe("conformance e2e: happy-path signed bundle", () => {
  it("signs a conformant statement whose fingerprint verifies valid", async () => {
    const dir = scratch?.dir as string;
    initRepo(dir);
    await seedApp(dir);
    git(dir, ["add", "app.tsx"]);
    commitAll(dir, "initial", T0);

    // Every A-level criterion gets a pass attestation, so the refusal
    // gate opens and the builder attaches a signature.
    await seedAttestationsFile(dir, attestationsForProfile("wcag22", "A"));

    const body = await callConformanceStatement(dir);
    expect(body.conformant).toBe(true);
    expect(body.blockers).toHaveLength(0);
    const signature = body.signature;
    expect(signature).toBeDefined();
    if (signature === undefined) return;
    // Round-trip: the stamped fingerprint verifies against itself.
    expect(verifyConformanceBundle(signature, signature.inputFingerprint)).toEqual({ valid: true });
  });
});

// ─── Scenario (b): stale-attestation blocker ──────────────────────────────

describe("conformance e2e: stale attestation blocker", () => {
  it("surfaces reason: 'stale-attestation' after a post-attestation commit", async () => {
    const dir = scratch?.dir as string;
    initRepo(dir);
    await seedApp(dir);
    git(dir, ["add", "app.tsx"]);
    commitAll(dir, "initial", T0);

    // Attestations stamped at T1 (resolves to the T0 commit).
    await seedAttestationsFile(dir, attestationsForProfile("wcag22", "A", T1));

    // Commit a modification AFTER T1. `createGitStalenessProbe` resolves
    // the stamp to the T0 commit, then compares against HEAD (which is
    // now the T2 commit) and finds app.tsx in the changed-files set.
    await writeFile(posixJoin(dir, "app.tsx"), "export const App = () => <div />;\n", "utf8");
    git(dir, ["add", "app.tsx"]);
    commitAll(dir, "update app", T2);

    const body = await callConformanceStatement(dir);
    expect(body.conformant).toBe(false);
    // Every attested-pass criterion should now carry the stale reason.
    // Assert existence of at least one and that each stale blocker
    // cites the attestation timestamp so agents can re-attest.
    const staleBlockers = body.blockers.filter((b) => b.reason === "stale-attestation");
    expect(staleBlockers.length).toBeGreaterThan(0);
    expect(staleBlockers.every((b) => b.staleAttestedAt === T1)).toBe(true);
  });
});

// ─── Scenario (c): source modified after sign → signature mismatch ────────

describe("conformance e2e: file-manifest drift after signing", () => {
  it("returns file-manifest-mismatch when a scanned file changes post-sign", async () => {
    const dir = scratch?.dir as string;
    initRepo(dir);
    await seedApp(dir);
    git(dir, ["add", "app.tsx"]);
    commitAll(dir, "initial", T0);
    await seedAttestationsFile(dir, attestationsForProfile("wcag22", "A"));

    // Build + sign the bundle.
    const body = await callConformanceStatement(dir);
    expect(body.conformant).toBe(true);
    const signature = body.signature;
    expect(signature).toBeDefined();
    if (signature === undefined) return;

    // Mutate the scanned file WITHOUT committing — the file-content
    // SHA-256 in the fingerprint manifest no longer matches the tree.
    await writeFile(posixJoin(dir, "app.tsx"), "export const App = () => <span />;\n", "utf8");

    // Rebuild a fresh SignatureInput by re-running the statement
    // pipeline, then feed it to the verifier. The rebuilt manifest's
    // SHA for app.tsx has drifted; the verifier reports the mismatch.
    const reBody = await callConformanceStatement(dir);
    // After the mutation the attested-pass-only claim still stands at
    // the ledger level (attestations unchanged), so the refusal gate
    // still passes and a fresh fingerprint is produced on `reBody`.
    const freshFingerprint = (reBody.signature as ConformanceSignature | undefined)
      ?.inputFingerprint as SignatureInput | undefined;
    expect(freshFingerprint).toBeDefined();
    if (freshFingerprint === undefined) return;
    const result = verifyConformanceBundle(signature, freshFingerprint);
    expect(result).toEqual({ valid: false, reason: "file-manifest-mismatch" });
  });
});

// ─── Scenario (e): runtime-evidence-required limitations ────────────────

describe("conformance e2e: runtime-evidence-required limitations", () => {
  it("surfaces runtime-only SCs as undetermined blockers + limitations[] on bootstrap", async () => {
    // Bootstrap scenario from the backlog: a fresh repo, zero attestations,
    // one file, scan runs clean. Previously 2.1.1 / 2.4.3 / 2.4.7 / 1.4.3 /
    // 1.4.11 / 2.4.6 all collapsed to `status: "pass", reason:
    // "no-evidence"` — "no evidence" dressed up as pass. The honest
    // response is `status: "undetermined"` with `reason:
    // "runtime-evidence-required"` and the criterion cited in
    // `limitations[]`.
    const dir = scratch?.dir as string;
    initRepo(dir);
    await seedApp(dir);
    git(dir, ["add", "app.tsx"]);
    commitAll(dir, "initial", T0);

    // No attestations seeded — every SC stands on static evidence alone.

    const body = await callConformanceStatement(dir);
    expect(body.conformant).toBe(false);

    // Every runtime-dependent SC in the A-level set should surface as
    // an undetermined blocker with `runtime-evidence-required`. The
    // backlog cites 2.1.1 and 2.4.3 as A-level members of the set.
    const runtimeBlockers = body.blockers.filter((b) => b.reason === "runtime-evidence-required");
    expect(runtimeBlockers.length).toBeGreaterThan(0);
    expect(runtimeBlockers.every((b) => b.status === "undetermined")).toBe(true);
    // 2.1.1 Keyboard is the canonical entry — must appear.
    const keyboard = runtimeBlockers.find((b) => b.criterionId === "wcag22:2.1.1");
    expect(keyboard).toBeDefined();

    // Top-level limitations[] list carries a prose entry per runtime SC.
    expect(body.limitations).toBeDefined();
    expect((body.limitations ?? []).length).toBeGreaterThan(0);
    const joined = (body.limitations ?? []).join("\n");
    expect(joined).toContain("wcag22:2.1.1");
    expect(joined).toContain("runtime evidence required");

    // Markdown carries a ## Limitations section.
    expect(body.markdown ?? "").toContain("## Limitations");

    // None of the runtime SCs should be dishonestly stamped `status:
    // "pass"` anywhere in the blocker list.
    const stampedPass = body.blockers.filter(
      (b) =>
        b.reason === "runtime-evidence-required" && (b.status === "pass" || b.status === "n/a"),
    );
    expect(stampedPass).toEqual([]);
  });

  it("runtime attestation for 2.1.1 clears the blocker and drops the limitation entry", async () => {
    // A runtime harness verdict (passed through `attest` with the
    // harness as `by`) is the deterministic escape hatch the doctrine
    // prescribes. Once attested, the criterion should clear entirely.
    const dir = scratch?.dir as string;
    initRepo(dir);
    await seedApp(dir);
    git(dir, ["add", "app.tsx"]);
    commitAll(dir, "initial", T0);

    await seedAttestationsFile(dir, [
      {
        criterionId: "wcag22:2.1.1",
        by: "ci-runtime-harness",
        reason: "Playwright keyboard traversal over all routes — zero unreachable handlers.",
        attestedAt: T1,
        evidenceSource: "runtime_tool",
        toolName: "playwright",
        verdict: "pass",
        scope: "project",
      },
    ]);

    const body = await callConformanceStatement(dir);
    // Other criteria may still block, but 2.1.1 specifically must not
    // surface as runtime-evidence-required anymore.
    const stillUndetermined2_1_1 = body.blockers.some(
      (b) => b.criterionId === "wcag22:2.1.1" && b.reason === "runtime-evidence-required",
    );
    expect(stillUndetermined2_1_1).toBe(false);
    const limitations2_1_1 = (body.limitations ?? []).some((l) => l.includes("wcag22:2.1.1"));
    expect(limitations2_1_1).toBe(false);
  });
});

// ─── Scenario (d): tampered attestations.jsonl detected ───────────────────

describe("conformance e2e: tampered attestation ledger", () => {
  it("surfaces removed-since-head when a committed ledger line is edited in the tree", async () => {
    const dir = scratch?.dir as string;
    initRepo(dir);
    await seedApp(dir);
    git(dir, ["add", "app.tsx"]);
    commitAll(dir, "initial", T0);

    // Append one attestation via the sanctioned write path, then
    // commit the ledger so it's the HEAD view a tamper is compared
    // against. `appendAttestation` is the only sanctioned write path
    // and goes through the strict validator in the store.
    await appendAttestation(dir, {
      criterionId: "wcag22:2.4.7",
      by: "ci-bot",
      reason: "focus-visible verified by manual keyboard traversal",
      attestedAt: T1,
      evidenceSource: "manual_review",
      verdict: "pass",
      scope: "project",
    });
    git(dir, ["add", ".ra11y/attestations.jsonl"]);
    commitAll(dir, "record focus attestation", T1);

    // Simulate a working-tree tamper: rewrite the line to a different
    // `by` value. Git now sees the HEAD revision carrying the original
    // record while the working tree carries a different one — the
    // integrity verifier flags the HEAD-side line as
    // `removed-since-head` because exact-JSON equality fails.
    const tampered: AttestationRecord = {
      criterionId: "wcag22:2.4.7",
      by: "attacker",
      reason: "rewrote history",
      attestedAt: T1,
      evidenceSource: "manual_review",
      verdict: "pass",
      scope: "project",
    };
    writeFileSync(resolveAttestationStorePath(dir), `${JSON.stringify(tampered)}\n`, "utf8");

    chdir(dir);
    const verify = await runCli(["attestations", "verify"]);
    chdir(originalCwd);

    expect(verify.exitCode).not.toBe(0);
    // Both the HEAD-removal of the original line AND the uncommitted
    // tampered replacement surface. The agent routes on either signal.
    expect(verify.stdout).toContain("removed-since-head");
    expect(verify.stdout).toContain("wcag22:2.4.7");
  });

  it("signature verify returns attestation-set-mismatch when the ledger is tampered post-sign", async () => {
    const dir = scratch?.dir as string;
    initRepo(dir);
    await seedApp(dir);
    git(dir, ["add", "app.tsx"]);
    commitAll(dir, "initial", T0);
    const records = attestationsForProfile("wcag22", "A");
    await seedAttestationsFile(dir, records);

    // Sign the bundle with the ledger as it stands.
    const body = await callConformanceStatement(dir);
    expect(body.conformant).toBe(true);
    const signature = body.signature;
    if (signature === undefined) throw new Error("expected signature");

    // Tamper: forge an extra attestation line directly into the ledger
    // (bypassing the sanctioned write path) so the attestation set
    // drifts vs. the stamped fingerprint. The verifier reports
    // attestation-set-mismatch when the rebuilt attestation list no
    // longer matches what was signed.
    const forged: AttestationRecord = {
      criterionId: "wcag22:1.1.1",
      by: "attacker",
      reason: "forged after signing",
      attestedAt: T2,
      evidenceSource: "manual_review",
      verdict: "pass",
      scope: "project",
    };
    await seedAttestationsFile(dir, [...records, forged]);

    const reBody = await callConformanceStatement(dir);
    const freshFingerprint = reBody.signature?.inputFingerprint as SignatureInput | undefined;
    if (freshFingerprint === undefined) throw new Error("expected fresh fingerprint");
    const result = verifyConformanceBundle(signature, freshFingerprint);
    expect(result).toEqual({ valid: false, reason: "attestation-set-mismatch" });
  });
});
