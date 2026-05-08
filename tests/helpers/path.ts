/**
 * POSIX path helpers for tests. Re-exports the boundary helpers from
 * `src/utils/path.ts` so test files can `import { posixJoin } from
 * "../helpers/path.ts"` without reaching into `src/`. The scanner
 * normalizes its output paths to POSIX on every host (see
 * `docs/kb/architecture/cross-platform-paths.md`); tests that compare
 * against scanner output must build their expected strings the same
 * way, or the windows-shard verify run drifts on every cross-platform
 * regression.
 */

export {
  posixDirname,
  posixJoin,
  posixRelative,
  posixResolve,
  toPosix,
} from "../../src/utils/path.ts";
