#!/usr/bin/env bun
// PreToolUse hook for `git commit *`. Runs the full verification suite
// before the commit is allowed through. If any step fails, we block with
// a clear explanation so Claude can fix the underlying issue rather than
// bypass it. Never skip hooks. Never --no-verify.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readHookInput } from "./lib/input.ts";
import { block, ok } from "./lib/output.ts";
import { audit } from "./lib/audit.ts";
import type { PreToolUseInput } from "./lib/types.ts";

interface Check {
  label: string;
  command: string;
  required: () => boolean;
}

const input = await readHookInput<PreToolUseInput>();
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
const hasPackageJson = existsSync(join(projectDir, "package.json"));
const hasNodeModules = existsSync(join(projectDir, "node_modules"));
const hasSrc = existsSync(join(projectDir, "src"));

// We gate checks on whether their preconditions exist. Early phases don't
// have src/ yet — we don't want to block commits for "no tests found."
const checks: Check[] = [
  {
    label: "biome check",
    command: "bunx --bun biome check .",
    required: () => hasPackageJson && hasNodeModules,
  },
  {
    label: "tsc --noEmit",
    command: "bunx tsc --noEmit",
    required: () => hasPackageJson && hasNodeModules && hasSrc,
  },
  {
    label: "bun test",
    command: "bun test --bail",
    required: () => hasPackageJson && hasNodeModules && hasSrc,
  },
  {
    label: "scripts/check-zero-deps.ts",
    command: "bun scripts/check-zero-deps.ts",
    required: () => existsSync(join(projectDir, "scripts", "check-zero-deps.ts")),
  },
  {
    label: "scripts/check-commit.ts",
    command: "bun scripts/check-commit.ts",
    required: () => existsSync(join(projectDir, "scripts", "check-commit.ts")),
  },
];

const failures: string[] = [];
for (const check of checks) {
  if (!check.required()) continue;
  const result = spawnSync(check.command, { cwd: projectDir, shell: true, encoding: "utf8" });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    failures.push(`✗ ${check.label}\n${output}`);
  }
}

if (failures.length > 0) {
  audit({
    event: "PreToolUse:git-commit",
    action: "block",
    detail: { failureCount: failures.length },
  });
  block(
    `pre-commit verification failed — fix these and retry (do NOT --no-verify):\n\n${failures.join("\n\n")}`,
  );
}

audit({ event: "PreToolUse:git-commit", action: "allow" });
ok();
