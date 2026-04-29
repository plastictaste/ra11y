#!/usr/bin/env bun
/**
 * Verifies that staged TS/TSX content matches biome formatter output.
 *
 * Catches the format-after-add bug: agent edits file (long line),
 * runs `git add`, runs `bun run format`, commits. Staged content is
 * pre-format; on-disk content is post-format. `biome check .` reads
 * from disk so pre-commit verify passes — but git commits the staged
 * (pre-format) content, so the bad format lands anyway.
 *
 * This check reads index content directly via `git show :path` and
 * pipes it through `biome format --stdin-file-path=path`. Disk state
 * is never read. If formatter output differs from staged content, the
 * commit is blocked with a clear "re-stage after format" message.
 *
 * Skips when no .ts / .tsx files are staged.
 */
import { spawnSync } from "node:child_process";

const stagedRaw = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
});
if (stagedRaw.status !== 0) process.exit(0);

const staged = stagedRaw.stdout
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && /\.(ts|tsx)$/.test(s));

if (staged.length === 0) process.exit(0);

const divergent: string[] = [];
for (const path of staged) {
  const indexContent = spawnSync("git", ["show", `:${path}`], { encoding: "utf8" });
  if (indexContent.status !== 0) continue;
  const formatted = spawnSync("bunx", ["--bun", "biome", "format", `--stdin-file-path=${path}`], {
    input: indexContent.stdout,
    encoding: "utf8",
  });
  if (formatted.status !== 0) {
    divergent.push(`${path} (biome format failed)`);
    continue;
  }
  if (formatted.stdout !== indexContent.stdout) divergent.push(path);
}

if (divergent.length > 0) {
  process.stderr.write(
    `staged content differs from biome formatter output (${divergent.length} file${
      divergent.length === 1 ? "" : "s"
    }):\n`,
  );
  for (const p of divergent) process.stderr.write(`  ${p}\n`);
  const sample = divergent
    .slice(0, 3)
    .map((p) => p.split(" ")[0] ?? p)
    .join(" ");
  process.stderr.write(
    `\nLikely cause: you ran 'bun run format' AFTER 'git add'. The on-disk\n` +
      `file matches biome but the staged blob does not. Fix:\n\n` +
      `  bun run format && git add ${sample || "<files>"}\n\n` +
      `Then commit again. (Never --no-verify.)\n`,
  );
  process.exit(1);
}

process.exit(0);
