/**
 * Shared `(cwd, path)` containment guard used by every MCP tool that
 * reads or writes a caller-supplied file path. Resolves `filePath`
 * against `cwd` and returns the absolute path only when it stays
 * inside the scan root; returns `null` for any traversal attempt —
 * absolute paths outside cwd, relative paths climbing out via `..`,
 * or symlinks whose real target escapes the cwd's real root.
 *
 * `scan_file`, `suggest_fix`,
 * `apply_fix`, and `suppress` all take a `(cwd, path)` pair and must
 * enforce the same escape boundary. Previously the guard lived
 * duplicated in `tool-apply-fix-internals.ts` and `tool-suppress.ts`
 * and was absent from `scan_file` / `suggest_fix`, so a caller passing
 * `{ cwd: "/x/a", path: "../b/file.html" }` could scan a sibling
 * directory outside the declared sandbox.
 *
 * The macOS symlink caveat — `/tmp` is a symlink to `/private/tmp`,
 * so naive `path.relative` against an absolute cwd that the shell
 * already realpath-resolved would false-positive the escape. Hence
 * the realpath pass on both sides: if either side refuses to realpath
 * (ENOENT on a not-yet-created file, permission denied, loop), we
 * fall back to a structural `path.relative` check. The fallback is
 * weaker against attacker-controlled symlinks, but for the common
 * case where the path exists on disk, the realpath pass catches the
 * macOS-style symlink-to-private canonicalization and the
 * attacker-controlled symlink-escape case alike.
 */

import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { posixRelative, posixResolve } from "../utils/path.ts";
/**
 * Sync variant — tolerates missing files on either side by falling
 * back to a pure `path.resolve` / `path.relative` check. Returns the
 * absolute (but not necessarily real) path when inside cwd, `null`
 * otherwise. Use when the caller needs a sync answer (rare); prefer
 * {@link resolveInsideCwd} which layers realpath on top.
 */
export function resolveInsideCwdSync(filePath: string, cwd: string): string | null {
  const absCwd = isAbsolute(cwd) ? cwd : posixResolve(process.cwd(), cwd);
  const abs = isAbsolute(filePath) ? filePath : posixResolve(absCwd, filePath);
  const rel = posixRelative(absCwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/**
 * Async guard. Layers symlink resolution on top of the structural
 * check: realpaths both `cwd` and the resolved target, then verifies
 * the realpath stays inside the real cwd. Falls back to the sync
 * structural check when either realpath fails (missing file, EACCES,
 * symlink loop) — losing anti-symlink safety in that branch but
 * preserving the honest `..` traversal guard. Returns the original
 * (non-realpathed) absolute path on success so callers preserve the
 * path shape the agent passed in — callsites downstream (logging,
 * error envelopes) read better with the caller's form.
 */
export async function resolveInsideCwd(filePath: string, cwd: string): Promise<string | null> {
  const structural = resolveInsideCwdSync(filePath, cwd);
  if (structural === null) return null;
  const absCwd = isAbsolute(cwd) ? cwd : posixResolve(process.cwd(), cwd);
  let realCwd: string;
  try {
    realCwd = await realpath(absCwd);
  } catch {
    return structural;
  }
  let realTarget: string;
  try {
    realTarget = await realpath(structural);
  } catch {
    // Target may not exist yet (suppress creating a pragma in a file
    // the caller just pointed at? — no, suppress requires the file to
    // exist; but apply_fix / scan_file may race the fs). Fall back to
    // the structural answer; the existence check the caller runs
    // afterwards handles the honest not-found envelope.
    return structural;
  }
  const realRel = posixRelative(realCwd, realTarget);
  if (realRel.startsWith("..") || isAbsolute(realRel)) return null;
  return structural;
}
