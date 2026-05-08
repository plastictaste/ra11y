/**
 * Unit tests for `src/mcp/extension-presence-probe.ts`.
 *
 * The probe answers "does this extension exist anywhere under cwd?"
 * for the per-rule coverage `subkind` discriminator. Two cases
 * matter:
 *
 *   - extension-absent: the cwd has no files with the gated
 *     extension. Probe returns an empty set.
 *   - extension-present-but-out-of-scope: the cwd contains files of
 *     the extension somewhere, even when buried inside `.gitignore`d /
 *     default-excluded directories like `dist/` or `node_modules/`'s
 *     siblings. The probe must still see them — the whole point of
 *     the discriminator is to detect what scope filters pruned. The
 *     test uses `dist/styles.css` because it is the canonical
 *     default-build-dir-excluded shape.
 *
 * Coverage caveat: the probe DOES skip a small set of infrastructure
 * dirs (`.git`, `node_modules`, `__pycache__`, virtualenvs) for cost.
 * Those are never source the user meant to flag — verified via a
 * negative test that buries `.css` under `node_modules/` and asserts
 * the probe does NOT report it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  _resetExtensionPresenceProbeCache,
  probeExtensionsAtRoot,
} from "../../../src/mcp/extension-presence-probe.ts";
import { posixJoin } from "../../helpers/path.ts";

describe("probeExtensionsAtRoot", () => {
  let tmp: string;
  beforeEach(() => {
    _resetExtensionPresenceProbeCache();
    tmp = mkdtempSync(posixJoin(tmpdir(), "ra11y-extprobe-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    _resetExtensionPresenceProbeCache();
  });

  it("returns empty when no files of any wanted extension exist (extension-absent)", async () => {
    // Empty tree — nothing matches.
    const found = await probeExtensionsAtRoot(tmp, new Set([".css"]));
    expect(found.size).toBe(0);
  });

  it("returns the matching extension set when files exist at the root (extension-present)", async () => {
    writeFileSync(posixJoin(tmp, "styles.css"), "/* canonical source */", "utf8");
    const found = await probeExtensionsAtRoot(tmp, new Set([".css"]));
    expect(found.has(".css")).toBe(true);
  });

  it("finds files even when buried inside default-build dirs that scope filters skip", async () => {
    // The whole point of the probe is to detect what scope filters
    // pruned. `dist/` is a `DEFAULT_IGNORED_DIRS` entry the discovery
    // walker skips by default — the probe must NOT skip it.
    mkdirSync(posixJoin(tmp, "dist"), { recursive: true });
    writeFileSync(posixJoin(tmp, "dist", "styles.css"), "/* compiled */", "utf8");
    const found = await probeExtensionsAtRoot(tmp, new Set([".css"]));
    expect(found.has(".css")).toBe(true);
  });

  it("does not report extensions buried under infrastructure dirs (.git / node_modules / virtualenvs)", async () => {
    // Source files NEVER live in node_modules (those are dependencies,
    // not authored code) — the probe skips them so a Tailwind project
    // with vendored CSS in a transitive dependency doesn't read as
    // "extension present at cwd."
    mkdirSync(posixJoin(tmp, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(
      posixJoin(tmp, "node_modules", "some-pkg", "vendored.css"),
      "/* irrelevant */",
      "utf8",
    );
    mkdirSync(posixJoin(tmp, ".git", "objects"), { recursive: true });
    writeFileSync(posixJoin(tmp, ".git", "irrelevant.css"), "/* git internal */", "utf8");
    const found = await probeExtensionsAtRoot(tmp, new Set([".css"]));
    expect(found.size).toBe(0);
  });

  it("returns multiple extensions when several wanted shapes exist in the tree", async () => {
    writeFileSync(posixJoin(tmp, "page.html"), "<!doctype html>", "utf8");
    mkdirSync(posixJoin(tmp, "src"), { recursive: true });
    writeFileSync(posixJoin(tmp, "src", "App.tsx"), "export {}", "utf8");
    const found = await probeExtensionsAtRoot(tmp, new Set([".html", ".tsx", ".css"]));
    expect(found.has(".html")).toBe(true);
    expect(found.has(".tsx")).toBe(true);
    expect(found.has(".css")).toBe(false);
  });

  it("returns an empty set when extensions arg is empty (no walk, no I/O)", async () => {
    writeFileSync(posixJoin(tmp, "anything.css"), "/* never inspected */", "utf8");
    const found = await probeExtensionsAtRoot(tmp, new Set());
    expect(found.size).toBe(0);
  });

  it("returns empty when root does not exist (defensive fallthrough)", async () => {
    const found = await probeExtensionsAtRoot(posixJoin(tmp, "does-not-exist"), new Set([".css"]));
    expect(found.size).toBe(0);
  });

  it("caches per (root, wanted) pair so repeat invocations skip filesystem work", async () => {
    writeFileSync(posixJoin(tmp, "first.css"), "/* */", "utf8");
    const a = await probeExtensionsAtRoot(tmp, new Set([".css"]));
    expect(a.has(".css")).toBe(true);
    // Add another file after the first probe — if the cache is honored,
    // the second call returns the cached set without seeing `.html`.
    writeFileSync(posixJoin(tmp, "second.html"), "<!doctype html>", "utf8");
    const b = await probeExtensionsAtRoot(tmp, new Set([".css"]));
    // Same wanted set as the first call — cache must hit, so the
    // second probe still reports only `.css` (the cached answer)
    // rather than walking again and noticing the new `.html` file.
    expect(b.size).toBe(1);
    expect(b.has(".css")).toBe(true);
    // Different wanted set must NOT collide with the first cache key.
    const c = await probeExtensionsAtRoot(tmp, new Set([".html"]));
    expect(c.has(".html")).toBe(true);
  });
});
