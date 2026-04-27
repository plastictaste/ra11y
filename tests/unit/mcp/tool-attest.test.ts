/**
 * Unit tests for the `attest` MCP tool.
 *
 * Happy path — criterion-level attestation lands in
 * `.ra11y/attestations.jsonl` and round-trips through
 * readAttestations. Every error-envelope branch is exercised
 * directly: allow-write gate, missing criterionId / reason, unknown
 * criterion, invalid verdict / scope, scope=file without location.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAttestations } from "../../../src/config/attestation-store.ts";
import { McpSession } from "../../../src/mcp/session.ts";
import { attestTool } from "../../../src/mcp/tool-attest.ts";

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-attest-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function allowWriteSession(): McpSession {
  const session = new McpSession();
  session.configure({ allowWrite: true });
  return session;
}

async function call(
  session: McpSession,
  params: Record<string, unknown>,
): Promise<{ readonly isError: boolean; readonly body: Record<string, unknown> }> {
  const result = await attestTool.handler(params, session);
  const body = JSON.parse(result.content[0]?.text ?? "");
  return { isError: result.isError === true, body };
}

describe("attest: happy path", () => {
  it("appends a valid attestation and round-trips through the store", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "runtime harness 2026-04-18 reported pass for focus-visible",
        by: "ci-bot",
        verdict: "pass",
        evidenceSource: "runtime_tool",
        toolName: "runtime-harness 1.0.0",
        runUrl: "https://ci.example.test/runs/123",
        observedAt: "2026-04-18T00:00:00.000Z",
        attestedAt: "2026-04-18T00:00:00.000Z",
        cwd,
      });
      expect(isError).toBe(false);
      expect(body["applied"]).toBe(true);
      const read = await readAttestations(cwd);
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({
        criterionId: "wcag22:2.4.7",
        by: "ci-bot",
        reason: "runtime harness 2026-04-18 reported pass for focus-visible",
        attestedAt: "2026-04-18T00:00:00.000Z",
        evidenceSource: "runtime_tool",
        toolName: "runtime-harness 1.0.0",
        runUrl: "https://ci.example.test/runs/123",
        observedAt: "2026-04-18T00:00:00.000Z",
        verdict: "pass",
      });
    });
  });

  it("defaults by to 'agent' and stamps current attestedAt when omitted", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const before = new Date().toISOString();
      const { isError } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "manual keyboard traversal confirmed",
        evidenceSource: "manual_review",
        cwd,
      });
      expect(isError).toBe(false);
      const read = await readAttestations(cwd);
      expect(read[0]?.by).toBe("agent");
      expect(read[0]?.attestedAt >= before).toBe(true);
    });
  });

  it("accepts scope=file with a full location", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "component verified in storybook isolation",
        evidenceSource: "manual_review",
        scope: "file",
        location: { filePath: "src/button.tsx", line: 42, column: 3 },
        cwd,
      });
      expect(isError).toBe(false);
      expect(body["applied"]).toBe(true);
      const read = await readAttestations(cwd);
      expect(read[0]?.scope).toBe("file");
      expect(read[0]?.location).toEqual({ filePath: "src/button.tsx", line: 42, column: 3 });
    });
  });
});

describe("attest: error envelopes", () => {
  it("rejects when session allowWrite is false", async () => {
    await withScratch(async (cwd) => {
      const session = new McpSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "x",
        evidenceSource: "manual_review",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("allow-write-disabled");
    });
  });

  it("rejects empty reason with missing-required-param", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "   ",
        evidenceSource: "manual_review",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("missing-required-param");
    });
  });

  it("rejects a request missing evidenceSource with missing-required-param", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "manual keyboard traversal confirmed",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("missing-required-param");
      expect((body["error"] as string).toLowerCase()).toContain("evidencesource");
    });
  });

  it("rejects an unrecognized evidenceSource value with invalid-param", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "manual keyboard traversal confirmed",
        evidenceSource: "vendor_specific_thing",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("invalid-param");
    });
  });

  it("rejects a malformed observedAt timestamp with invalid-param", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "manual keyboard traversal confirmed",
        evidenceSource: "runtime_tool",
        observedAt: "yesterday afternoon",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("invalid-param");
    });
  });

  it("rejects unknown criterion with criterion-not-found", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:9.9.9",
        reason: "nonexistent",
        evidenceSource: "manual_review",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("criterion-not-found");
    });
  });

  it("rejects invalid verdict", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "x",
        evidenceSource: "manual_review",
        verdict: "maybe",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("invalid-param");
    });
  });

  it("rejects scope=file without a location", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "x",
        evidenceSource: "manual_review",
        scope: "file",
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("invalid-param");
    });
  });

  it("rejects ruleIds that do not satisfy the given criterion", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "scoping to a rule that actually covers 4.1.2",
        evidenceSource: "manual_review",
        ruleIds: ["aria/required-attrs"],
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("rule-not-under-criterion");
    });
  });

  it("rejects an empty ruleIds array as ambiguous", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:2.4.7",
        reason: "x",
        evidenceSource: "manual_review",
        ruleIds: [],
        cwd,
      });
      expect(isError).toBe(true);
      expect(body["code"]).toBe("invalid-param");
    });
  });
});

describe("attest: ruleIds (ADR 0013)", () => {
  it("accepts an explicit ruleIds list and writes it to the durable store", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:4.1.2",
        reason: "verified aria-required attrs for every input in checkout flow",
        evidenceSource: "manual_review",
        ruleIds: ["aria/required-attrs"],
        cwd,
      });
      expect(isError).toBe(false);
      expect(body["applied"]).toBe(true);
      const read = await readAttestations(cwd);
      expect(read[0]?.ruleIds).toEqual(["aria/required-attrs"]);
      const coverage = body["coverage"] as { readonly kind: string } | undefined;
      expect(coverage?.kind).toBe("rule-scoped");
    });
  });

  it("discloses the criterion-wide fan-out when ruleIds is omitted", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError, body } = await call(session, {
        criterionId: "wcag22:4.1.2",
        reason: "full manual audit of every interactive surface",
        evidenceSource: "manual_review",
        cwd,
      });
      expect(isError).toBe(false);
      const coverage = body["coverage"] as { readonly kind: string } | undefined;
      expect(coverage?.kind).toBe("criterion-wide");
      const covered = body["coveredRules"] as readonly string[];
      expect(covered.length).toBeGreaterThan(1);
      const read = await readAttestations(cwd);
      expect(read[0]?.ruleIds).toBeUndefined();
    });
  });

  it("dedupes repeated ruleIds within one call", async () => {
    await withScratch(async (cwd) => {
      const session = allowWriteSession();
      const { isError } = await call(session, {
        criterionId: "wcag22:4.1.2",
        reason: "dedupe test",
        evidenceSource: "manual_review",
        ruleIds: ["aria/required-attrs", "aria/required-attrs"],
        cwd,
      });
      expect(isError).toBe(false);
      const read = await readAttestations(cwd);
      expect(read[0]?.ruleIds).toEqual(["aria/required-attrs"]);
    });
  });
});
