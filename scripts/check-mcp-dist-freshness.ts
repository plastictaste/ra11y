#!/usr/bin/env bun
/**
 * Detects a stale shipped MCP `dist/cli.js` relative to current `src/`.
 *
 * The MCP server is invoked by agents as `node dist/cli.js mcp` (the
 * `ra11y` bin entry). When a developer or release process forgets to
 * rebuild after editing `src/`, the running server is a fossil — fixes
 * already merged on `main` reproduce as field-test "bugs" because the
 * shipped artifact predates them. This check is the systemic
 * counterweight: it asks "if I rebuilt right now, would the result
 * match what's on disk?" and fails when the answer is no.
 *
 * Behavior:
 *   - If `dist/cli.js` does not exist → skip with a note. Local dev
 *     before the first `bun run build` is not staleness, it's absence.
 *     The publish path (`prepublishOnly`) always rebuilds before this
 *     check would matter.
 *   - If `dist/cli.js` exists → re-run the same `Bun.build()` config
 *     `scripts/build.ts` uses, but emit to a tmp directory. Compare the
 *     tmp `cli.js` byte-for-byte against the on-disk `dist/cli.js`. A
 *     mismatch means `dist/` is older than `src/` and must be rebuilt.
 *
 * Why byte-equality and not a hash manifest: a hash manifest needs a
 * tracked file that gets updated on every src change, multiplying churn.
 * Byte-equality is self-validating — same Bun + same `src/` + same
 * config = same output. The build script proves this is reproducible
 * (verified locally before this check landed).
 *
 * Why only `cli.js` and not all of `dist/`: `cli.js` is the entry the
 * MCP server runs from. Comparing every artifact would be more thorough
 * but redundant — `cli.js` either bundles the changed code (if it
 * imports from a touched file) or is unaffected (if the touched file
 * isn't reachable). Either way, mismatch on `cli.js` is sufficient
 * evidence the build is stale; equality on `cli.js` is sufficient
 * evidence the MCP entry is current.
 *
 * Bun-specific APIs (`Bun.build`) are allowed here — `scripts/` is
 * exempt from the "Node-compatible only" rule that governs `src/`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir ?? process.cwd(), "..");
const SRC = join(ROOT, "src");
const DIST_CLI = join(ROOT, "dist", "cli.js");

// Must match scripts/build.ts entrypoints exactly. With `splitting: true`
// Bun shares chunks across the entry set, so the bytes of `cli.js`
// depend on which other entries are present — rebuilding from `cli.ts`
// alone produces a different (correct-but-not-equal) cli.js. To diff
// staleness honestly we have to use the same entry set the real build
// uses.
const ENTRYPOINTS = [join(SRC, "index.ts"), join(SRC, "cli.ts"), join(SRC, "api/plugin.ts")];

if (!existsSync(DIST_CLI)) {
  console.log("✓ MCP dist freshness: skipped (no dist/cli.js — run `bun run build` first)");
  process.exit(0);
}

for (const entry of ENTRYPOINTS) {
  if (!existsSync(entry)) {
    console.error(`✗ MCP dist freshness: entrypoint missing: ${entry}`);
    process.exit(1);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "ra11y-dist-freshness-"));

try {
  // Mirror scripts/build.ts step 2 byte-for-byte. Splitting/sourcemap/
  // external/naming + the full entry set must match so chunk inlining
  // and module ordering reproduce — otherwise the rebuild's cli.js
  // diverges from a fresh real build for reasons unrelated to staleness.
  const result = await Bun.build({
    entrypoints: ENTRYPOINTS,
    outdir: tmpRoot,
    target: "node",
    format: "esm",
    splitting: true,
    sourcemap: "none",
    external: ["typescript"],
    naming: {
      entry: "[dir]/[name].[ext]",
      chunk: "[name]-[hash].[ext]",
    },
  });

  if (!result.success) {
    console.error("✗ MCP dist freshness: rebuild from src/ failed:");
    for (const log of result.logs) console.error(`  ${log.message}`);
    process.exit(1);
  }

  const rebuiltCli = join(tmpRoot, "cli.js");
  if (!existsSync(rebuiltCli)) {
    console.error(`✗ MCP dist freshness: rebuild produced no cli.js at ${rebuiltCli}`);
    process.exit(1);
  }

  // Compare transpiled JS modulo shebang. `src/cli.ts` carries a
  // `#!/usr/bin/env node` line that Bun preserves, and `scripts/build.ts`
  // step 3 also re-prepends one if absent — both paths land on the same
  // bytes in practice, but stripping on both sides isolates the question
  // to "does the transpiled JS match" rather than "is the packaging
  // step also identical."
  const distBytes = readFileSync(DIST_CLI, "utf8");
  const rebuiltBytes = readFileSync(rebuiltCli, "utf8");
  const distStripped = stripShebang(distBytes);
  const rebuiltStripped = stripShebang(rebuiltBytes);

  if (distStripped === rebuiltStripped) {
    console.log("✓ MCP dist freshness: dist/cli.js matches a fresh build of src/cli.ts");
    process.exit(0);
  }

  // Surface the divergence concretely so the user knows what to do.
  // Don't dump the full diff — the artifacts are megabytes. Point at
  // the action (rebuild) and the diagnostic the agent can run if they
  // want to dig deeper.
  console.error("✗ MCP dist freshness: dist/cli.js is stale relative to src/.");
  console.error(`    on-disk size:  ${distStripped.length} bytes`);
  console.error(`    rebuilt size:  ${rebuiltStripped.length} bytes`);
  console.error("");
  console.error("  The shipped MCP entry (dist/cli.js) does not match what `bun build src/cli.ts`");
  console.error("  produces from the current src/ tree. Field-test reports against this dist will");
  console.error("  reproduce bugs that are already fixed on main; closures rated 'shipped' are");
  console.error("  not actually shipped to the running MCP server until dist/ is rebuilt.");
  console.error("");
  console.error("  Fix:  bun run build");
  console.error("");
  console.error(
    "  Background: docs/kb/architecture/ai-first-consumer.md (search 'V1-MCP-DIST-STALE-CI-GATE').",
  );
  process.exit(1);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

/**
 * Removes a leading `#!...\n` shebang line if present. Both the on-disk
 * `dist/cli.js` (Bun preserves the `#!/usr/bin/env node` line that lives
 * at the top of `src/cli.ts`, and `scripts/build.ts` step 3 also
 * re-prepends one defensively if absent) and the tmp rebuild carry a
 * shebang. Stripping on both sides isolates the comparison to "does
 * the transpiled JS match" — which is the staleness signal we want —
 * rather than "is the packaging step also identical," which is
 * invariant under src/ changes.
 */
function stripShebang(s: string): string {
  if (!s.startsWith("#!")) return s;
  const nl = s.indexOf("\n");
  return nl === -1 ? "" : s.slice(nl + 1);
}
