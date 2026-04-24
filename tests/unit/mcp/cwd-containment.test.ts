/**
 * V1-SCAN-FILE-CWD-CONTAINMENT: every MCP tool that takes a
 * `(cwd, file|path)` pair must enforce the same escape boundary.
 * Previously the guard lived only in `apply_fix` and `suppress`;
 * `scan_file` and `suggest_fix` let `{ cwd: "/x/a", path: "../b/f" }`
 * scan a sibling directory outside the declared sandbox.
 *
 * These tests pin the cross-tool invariant: the same escape pattern
 * returns `{ code: "path-escapes-cwd" }` from every tool, with the
 * rejected path and resolved cwd echoed in `details` so an agent can
 * tell why the call was refused. Tests also exercise the symlink-
 * canonicalised branch — the shared helper realpaths both sides so
 * a symlink whose target escapes the cwd is caught even when the
 * structural `..` check would accept it.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { scanFileTool } from "../../../src/mcp/tool-scan-file.ts";
import { suggestFixTool } from "../../../src/mcp/tool-suggest-fix.ts";

interface ErrorStructured {
  readonly code?: string;
  readonly details?: Record<string, unknown>;
}

async function withScratchPair<T>(fn: (inside: string, outside: string) => Promise<T>): Promise<T> {
  // Realpath the tmpdir so the macOS `/tmp` → `/private/tmp` symlink
  // is already canonicalised — otherwise test assertions about the
  // symlink branch would be swallowed by the default realpath pass.
  const root = await realpath(await mkdtemp(join(tmpdir(), "ra11y-cwd-containment-")));
  const inside = join(root, "inside");
  const outside = join(root, "outside");
  await mkdir(inside, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    return await fn(inside, outside);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("scan_file: V1-SCAN-FILE-CWD-CONTAINMENT", () => {
  it("accepts a path that resolves inside cwd", async () => {
    await withScratchPair(async (inside) => {
      const file = join(inside, "page.html");
      await writeFile(file, "<img src=x>\n");
      const session = new McpSession();
      const result = await scanFileTool.handler({ path: "page.html", cwd: inside }, session);
      expect(result.isError).toBeUndefined();
    });
  });

  it("rejects `path-escapes-cwd` when a relative path climbs above cwd via `..`", async () => {
    await withScratchPair(async (inside, outside) => {
      const target = join(outside, "escape.html");
      await writeFile(target, "<img src=x>\n");
      const session = new McpSession();
      const result = await scanFileTool.handler(
        { path: "../outside/escape.html", cwd: inside },
        session,
      );
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as ErrorStructured;
      expect(structured.code).toBe("path-escapes-cwd");
      expect(structured.details?.["cwd"]).toBe(inside);
      expect(structured.details?.["file"]).toBe("../outside/escape.html");
    });
  });

  it("rejects absolute paths outside cwd with `path-escapes-cwd`", async () => {
    await withScratchPair(async (inside, outside) => {
      const target = join(outside, "abs.html");
      await writeFile(target, "<img src=x>\n");
      const session = new McpSession();
      const result = await scanFileTool.handler({ path: target, cwd: inside }, session);
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as ErrorStructured;
      expect(structured.code).toBe("path-escapes-cwd");
    });
  });

  it("rejects `path-escapes-cwd` when a symlink inside cwd resolves outside cwd", async () => {
    // Symlink-escape: the target lives outside cwd, but the symlink
    // itself sits inside cwd under a name that passes the structural
    // `..` check. The guard must realpath the target before deciding.
    await withScratchPair(async (inside, outside) => {
      const realTarget = join(outside, "real.html");
      await writeFile(realTarget, "<img src=x>\n");
      const link = join(inside, "link.html");
      await symlink(realTarget, link);
      const session = new McpSession();
      const result = await scanFileTool.handler({ path: "link.html", cwd: inside }, session);
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as ErrorStructured;
      expect(structured.code).toBe("path-escapes-cwd");
    });
  });
});

describe("suggest_fix: V1-SCAN-FILE-CWD-CONTAINMENT", () => {
  it("rejects `path-escapes-cwd` when a relative path climbs above cwd via `..`", async () => {
    await withScratchPair(async (inside, outside) => {
      const target = join(outside, "escape.html");
      await writeFile(target, "<img src=x>\n");
      const session = new McpSession();
      const result = await suggestFixTool.handler(
        {
          ruleId: "media/alt-text-missing",
          file: "../outside/escape.html",
          line: 1,
          cwd: inside,
        },
        session,
      );
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as ErrorStructured;
      expect(structured.code).toBe("path-escapes-cwd");
      expect(structured.details?.["cwd"]).toBe(inside);
      expect(structured.details?.["file"]).toBe("../outside/escape.html");
    });
  });

  it("rejects absolute paths outside cwd with `path-escapes-cwd`", async () => {
    await withScratchPair(async (inside, outside) => {
      const target = join(outside, "abs.html");
      await writeFile(target, "<img src=x>\n");
      const session = new McpSession();
      const result = await suggestFixTool.handler(
        { ruleId: "media/alt-text-missing", file: target, line: 1, cwd: inside },
        session,
      );
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as ErrorStructured;
      expect(structured.code).toBe("path-escapes-cwd");
    });
  });

  it("rejects `path-escapes-cwd` when a symlink inside cwd resolves outside cwd", async () => {
    await withScratchPair(async (inside, outside) => {
      const realTarget = join(outside, "real.html");
      await writeFile(realTarget, "<img src=x>\n");
      const link = join(inside, "link.html");
      await symlink(realTarget, link);
      const session = new McpSession();
      const result = await suggestFixTool.handler(
        { ruleId: "media/alt-text-missing", file: "link.html", line: 1, cwd: inside },
        session,
      );
      expect(result.isError).toBe(true);
      const structured = result.structuredContent as ErrorStructured;
      expect(structured.code).toBe("path-escapes-cwd");
    });
  });
});
