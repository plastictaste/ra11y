/**
 * Unit tests for the `conformance_statement` MCP tool.
 *
 * End-to-end against a real scratch project: write a fixture file,
 * optionally seed `.ra11y/attestations.jsonl`, then call the tool
 * and inspect the `blockers[]` plus the rendered Markdown.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { conformanceStatementTool } from "../../../src/mcp/tool-conformance-statement.ts";
import {
  type ConformanceSignature,
  type SignatureInput,
  verifyConformanceBundle,
} from "../../../src/reports/conformance-signature.ts";
import { BUILTIN_STANDARDS } from "../../../src/standards/index.ts";

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-conform-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function call(
  session: McpSession,
  params: Record<string, unknown>,
): Promise<{ readonly isError: boolean; readonly body: Record<string, unknown> }> {
  const result = await conformanceStatementTool.handler(params, session);
  const body = JSON.parse(result.content[0]?.text ?? "");
  return { isError: result.isError === true, body };
}

async function seedAttestations(cwd: string, records: readonly Record<string, unknown>[]) {
  await mkdir(join(cwd, ".ra11y"), { recursive: true });
  await writeFile(
    join(cwd, ".ra11y", "attestations.jsonl"),
    `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf8",
  );
}

describe("conformance_statement: refusal path", () => {
  it("emits conformant: false with blockers when evidence is missing", async () => {
    await withScratch(async (cwd) => {
      // Minimal scan target — a single TSX file with no obvious
      // violations. The statement should still refuse because
      // automatable criteria have no non-candidate sources.
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      const session = new McpSession();
      const { isError, body } = await call(session, {
        standard: "wcag22",
        level: "AA",
        cwd,
      });
      expect(isError).toBe(false);
      expect(body["conformant"]).toBe(false);
      expect(Array.isArray(body["blockers"])).toBe(true);
      expect((body["blockers"] as unknown[]).length).toBeGreaterThan(0);
      expect(typeof body["markdown"]).toBe("string");
      expect(body["markdown"]).toContain("NOT CONFORMANT");
    });
  });
});

describe("conformance_statement: profile validation", () => {
  it("accepts level=base", async () => {
    await withScratch(async (cwd) => {
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      const session = new McpSession();
      const { isError, body } = await call(session, {
        standard: "wcag22",
        level: "base",
        cwd,
      });
      expect(isError).toBe(false);
      expect((body["profile"] as Record<string, unknown>)["level"]).toBe("base");
    });
  });

  it("rejects an unknown standard with standard-not-found", async () => {
    await withScratch(async (cwd) => {
      const session = new McpSession();
      const { isError, body } = await call(session, {
        standard: "nonexistent",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("standard-not-found");
    });
  });
});

describe("conformance_statement: named profile scope", () => {
  it("profile: wcag22-aa narrows the statement to wcag22 criteria at AA", async () => {
    await withScratch(async (cwd) => {
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      const session = new McpSession();
      const { isError, body } = await call(session, {
        standard: "wcag22",
        level: "AAA",
        profile: "wcag22-aa",
        cwd,
      });
      expect(isError).toBe(false);
      // The profile.level override narrows the claim to AA even though
      // the caller passed AAA — downstream renderers key off this and
      // every blocker must be an A/AA criterion.
      expect((body["profile"] as Record<string, unknown>)["level"]).toBe("AA");
      const blockers = body["blockers"] as { criterionId: string; level: string }[];
      expect(blockers.every((b) => b.level === "A" || b.level === "AA")).toBe(true);
      expect(blockers.every((b) => b.criterionId.startsWith("wcag22:"))).toBe(true);
    });
  });

  it("rejects an unknown profile with invalid-param and the valid-profile list", async () => {
    await withScratch(async (cwd) => {
      const session = new McpSession();
      const { isError, body } = await call(session, {
        standard: "wcag22",
        profile: "nonexistent-profile",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("invalid-param");
      expect(String(body["error"])).toContain("nonexistent-profile");
      const details = body["details"] as Record<string, unknown>;
      const valid = details["valid"] as string[];
      // Built-ins must show up so the agent can self-correct in one
      // response.
      expect(valid).toContain("wcag22-aa");
      expect(valid).toContain("section508");
    });
  });
});

describe("conformance_statement: WCAG §5.3.1 required claim fields", () => {
  it("emits the six required claim fields", async () => {
    await withScratch(async (cwd) => {
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      const session = new McpSession();
      const { isError, body } = await call(session, {
        standard: "wcag22",
        level: "AA",
        cwd,
      });
      expect(isError).toBe(false);
      expect(body["guidelinesTitle"]).toBe("WCAG 2.2");
      expect(body["guidelinesVersion"]).toBe("2.2");
      expect(body["guidelinesUri"]).toBe("https://www.w3.org/TR/WCAG22/");
      expect(Array.isArray((body["scope"] as Record<string, unknown>)["files"])).toBe(true);
      expect(Array.isArray(body["technologiesReliedUpon"])).toBe(true);
      expect((body["technologiesReliedUpon"] as string[]).length).toBeGreaterThan(0);
      expect(Array.isArray(body["technologiesNotReliedUpon"])).toBe(true);
    });
  });

  it("forwards caller-declared technologies", async () => {
    await withScratch(async (cwd) => {
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      const session = new McpSession();
      const { isError, body } = await call(session, {
        standard: "wcag22",
        level: "AA",
        cwd,
        technologiesReliedUpon: ["HTML", "CSS"],
        technologiesNotReliedUpon: ["JavaScript"],
      });
      expect(isError).toBe(false);
      expect(body["technologiesReliedUpon"]).toEqual(["HTML", "CSS"]);
      expect(body["technologiesNotReliedUpon"]).toEqual(["JavaScript"]);
    });
  });

  it("scope.configSnapshot carries session config fields", async () => {
    await withScratch(async (cwd) => {
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      const session = new McpSession();
      const { isError, body } = await call(session, {
        standard: "wcag22",
        level: "AA",
        cwd,
      });
      expect(isError).toBe(false);
      const scope = body["scope"] as Record<string, unknown>;
      const snapshot = scope["configSnapshot"] as Record<string, unknown>;
      expect(snapshot["standard"]).toBe("wcag22");
      expect(snapshot["level"]).toBe("AA");
    });
  });
});

describe("conformance_statement: durable attestations clear blockers", () => {
  it("picks up attestations from .ra11y/attestations.jsonl", async () => {
    await withScratch(async (cwd) => {
      // Seed an attestation for one AA criterion so it clears that
      // specific blocker. Other criteria remain blockers but the
      // count goes down.
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      await seedAttestations(cwd, [
        {
          criterionId: "wcag22:2.4.7",
          by: "test",
          reason: "keyboard focus verified manually on 2026-04-18",
          attestedAt: "2026-04-18T00:00:00.000Z",
        },
      ]);
      const session = new McpSession();
      const { isError, body } = await call(session, {
        standard: "wcag22",
        level: "AA",
        cwd,
      });
      expect(isError).toBe(false);
      const blockerIds = (body["blockers"] as { criterionId: string }[]).map((b) => b.criterionId);
      expect(blockerIds).not.toContain("wcag22:2.4.7");
    });
  });
});

// ─── Signing flow (V1-CERT-STATEMENT-SIGN) ────────────────────────────────

function runGit(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ra11y-test",
      GIT_AUTHOR_EMAIL: "test@ra11y.local",
      GIT_COMMITTER_NAME: "ra11y-test",
      GIT_COMMITTER_EMAIL: "test@ra11y.local",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function initGitRepo(cwd: string): Promise<void> {
  runGit(cwd, "init", "-q", "-b", "main");
  await writeFile(join(cwd, "README.md"), "# scratch\n");
  runGit(cwd, "add", ".");
  runGit(cwd, "commit", "-q", "-m", "initial");
}

/**
 * Seeds an attestation for every in-scope criterion of the given
 * standard + level. Sufficient to drive `buildConformanceStatement`
 * past the refusal gate so the signing path runs end-to-end.
 */
function attestationsForProfile(
  standardId: string,
  level: "A" | "AA" | "AAA" | "base",
): readonly Record<string, unknown>[] {
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
    reason: "manual review for signing round-trip",
    attestedAt: "2026-04-18T00:00:00.000Z",
    verdict: "pass",
    scope: "project",
  }));
}

describe("conformance_statement: signing flow", () => {
  it("emits warnings: [non_git_repo_signature_omitted] when the project is not a git repo", async () => {
    await withScratch(async (cwd) => {
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      const session = new McpSession();
      const { body } = await call(session, { standard: "wcag22", level: "AA", cwd });
      // No commit hash → no signature and the warning fires.
      expect(body["signature"]).toBeUndefined();
      expect(body["warnings"]).toEqual(["non_git_repo_signature_omitted"]);
    });
  });

  it("omits signature + warning on non-conformant git-repo scan", async () => {
    await withScratch(async (cwd) => {
      await initGitRepo(cwd);
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      const session = new McpSession();
      const { body } = await call(session, { standard: "wcag22", level: "AA", cwd });
      // Conformant: false because nothing's attested — no signature
      // emitted. The warning is non-git-only so it must not fire here.
      expect(body["conformant"]).toBe(false);
      expect(body["signature"]).toBeUndefined();
      expect(body["warnings"]).toBeUndefined();
    });
  });

  it("signs the statement when every criterion is attested and verifies round-trip", async () => {
    await withScratch(async (cwd) => {
      await initGitRepo(cwd);
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      // Attest every A-level criterion so the ledger has non-candidate
      // evidence for every in-scope criterion — the refusal gate opens
      // and the signing path runs.
      await seedAttestations(cwd, attestationsForProfile("wcag22", "A"));
      const session = new McpSession();
      const { body } = await call(session, { standard: "wcag22", level: "A", cwd });
      expect(body["conformant"]).toBe(true);
      const signature = body["signature"] as ConformanceSignature | undefined;
      expect(signature).toBeDefined();
      if (signature === undefined) return;
      expect(signature.algorithm).toBe("sha256");
      expect(signature.digest).toMatch(/^[0-9a-f]{64}$/);
      // The fingerprint carries the full scan inputs — verify the key
      // ones populated.
      const fp = signature.inputFingerprint;
      expect(fp.commitHash).toMatch(/^[0-9a-f]{40}$/);
      expect(fp.toolVersion).toBeDefined();
      expect(fp.fileManifest).toBeDefined();
      expect((fp.fileManifest ?? []).length).toBeGreaterThan(0);
      // Round-trip: verifying against the stamped fingerprint passes.
      expect(verifyConformanceBundle(signature, fp)).toEqual({ valid: true });
    });
  });

  it("mutating the file manifest invalidates the signature on re-verify", async () => {
    await withScratch(async (cwd) => {
      await initGitRepo(cwd);
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      await seedAttestations(cwd, attestationsForProfile("wcag22", "A"));
      const session = new McpSession();
      const { body } = await call(session, { standard: "wcag22", level: "A", cwd });
      const signature = body["signature"] as ConformanceSignature | undefined;
      expect(signature).toBeDefined();
      if (signature === undefined) return;
      // Synthesize a drifted current-state by flipping one file's
      // digest — simulates "source edited since signing."
      const original = signature.inputFingerprint;
      const driftedManifest = (original.fileManifest ?? []).map((e, i) =>
        i === 0 ? { ...e, sha256: "0".repeat(64) } : e,
      );
      const drifted: SignatureInput = { ...original, fileManifest: driftedManifest };
      const result = verifyConformanceBundle(signature, drifted);
      expect(result).toEqual({ valid: false, reason: "file-manifest-mismatch" });
    });
  });

  it("mutating the config fingerprint invalidates the signature", async () => {
    await withScratch(async (cwd) => {
      await initGitRepo(cwd);
      await writeFile(join(cwd, "app.tsx"), "export const App = () => null;\n");
      await seedAttestations(cwd, attestationsForProfile("wcag22", "A"));
      const session = new McpSession();
      const { body } = await call(session, { standard: "wcag22", level: "A", cwd });
      const signature = body["signature"] as ConformanceSignature | undefined;
      expect(signature).toBeDefined();
      if (signature === undefined) return;
      const original = signature.inputFingerprint;
      const drifted: SignatureInput = {
        ...original,
        configFingerprint: { ...original.configFingerprint, level: "AAA" },
      };
      const result = verifyConformanceBundle(signature, drifted);
      expect(result).toEqual({ valid: false, reason: "config-level-mismatch" });
    });
  });
});

describe("conformance_statement: scope.files cap (V1-CONFORMANCE-SCOPE-FILES-CAP)", () => {
  it("returns the full file manifest inline with no truncation warning when the scope fits under the cap", async () => {
    await withScratch(async (cwd) => {
      // Three TSX files — well under the default 100 cap. Expect the
      // full list to ship inline and no truncation warning.
      await writeFile(join(cwd, "a.tsx"), "export const A = () => null;\n");
      await writeFile(join(cwd, "b.tsx"), "export const B = () => null;\n");
      await writeFile(join(cwd, "c.tsx"), "export const C = () => null;\n");
      const session = new McpSession();
      const { body } = await call(session, { standard: "wcag22", level: "AA", cwd });
      const scope = body["scope"] as { readonly filesCount: number; readonly files?: string[] };
      expect(scope.filesCount).toBe(3);
      expect(Array.isArray(scope.files)).toBe(true);
      expect(scope.files?.length).toBe(3);
      const warnings = (body["warnings"] as string[] | undefined) ?? [];
      expect(warnings).not.toContain("scope_files_truncated_count_exceeded");
      expect(body["warningsDetails"]).toBeUndefined();
    });
  });

  it("elides scope.files with a warning + warningsDetails payload when the count exceeds the configured cap", async () => {
    await withScratch(async (cwd) => {
      // A tiny cap (2) exercises the truncation branch without needing
      // hundreds of fixture files. Three files > cap of 2 → `files`
      // omitted, `filesCount` still names the real count, warning fires.
      await writeFile(join(cwd, "a.tsx"), "export const A = () => null;\n");
      await writeFile(join(cwd, "b.tsx"), "export const B = () => null;\n");
      await writeFile(join(cwd, "c.tsx"), "export const C = () => null;\n");
      const session = new McpSession();
      const { body } = await call(session, {
        standard: "wcag22",
        level: "AA",
        cwd,
        scopeFilesCap: 2,
      });
      const scope = body["scope"] as { readonly filesCount: number; readonly files?: string[] };
      // Real count stays honest; the list is gone.
      expect(scope.filesCount).toBe(3);
      expect(scope.files).toBeUndefined();
      const warnings = (body["warnings"] as string[] | undefined) ?? [];
      expect(warnings).toContain("scope_files_truncated_count_exceeded");
      const details = body["warningsDetails"] as
        | { readonly scope_files_truncated_count_exceeded?: { totalCount: number; cap: number } }
        | undefined;
      expect(details?.scope_files_truncated_count_exceeded).toEqual({ totalCount: 3, cap: 2 });
    });
  });

  it("verboseScope: true bypasses the cap and returns the full manifest with no truncation warning", async () => {
    await withScratch(async (cwd) => {
      await writeFile(join(cwd, "a.tsx"), "export const A = () => null;\n");
      await writeFile(join(cwd, "b.tsx"), "export const B = () => null;\n");
      await writeFile(join(cwd, "c.tsx"), "export const C = () => null;\n");
      const session = new McpSession();
      const { body } = await call(session, {
        standard: "wcag22",
        level: "AA",
        cwd,
        scopeFilesCap: 2,
        verboseScope: true,
      });
      const scope = body["scope"] as { readonly filesCount: number; readonly files?: string[] };
      expect(scope.filesCount).toBe(3);
      expect(scope.files?.length).toBe(3);
      const warnings = (body["warnings"] as string[] | undefined) ?? [];
      expect(warnings).not.toContain("scope_files_truncated_count_exceeded");
    });
  });

  it("documents the default cap (100) via the conformance_statement tool schema", () => {
    const schema = conformanceStatementTool.def.inputSchema as {
      readonly properties: Record<string, { readonly description?: string }>;
    };
    expect(schema.properties["verboseScope"]).toBeDefined();
    expect(schema.properties["scopeFilesCap"]).toBeDefined();
    // The schema description names the default so callers don't have to
    // read source to pick a sensible override.
    expect(schema.properties["scopeFilesCap"]?.description).toContain("100");
    expect(schema.properties["verboseScope"]?.description).toContain("scope_files_truncated");
  });
});
