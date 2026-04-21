/**
 * Unit tests for the tamper-evident signing layer on the conformance
 * statement. Targets:
 *   - Determinism: identical input → identical digest across runs.
 *   - Canonicalization: attestation reordering and object-key
 *     reordering don't drift the digest.
 *   - Sensitivity: any load-bearing input change flips the digest.
 *   - Verification: matching input verifies; each drift axis returns
 *     a specific, stable `reason` string.
 */

import { describe, expect, it } from "bun:test";
import {
  type ConformanceSignature,
  type SignatureInput,
  signConformanceBundle,
  signConformanceBundleAt,
  verifyConformanceBundle,
} from "../../../src/reports/conformance-signature.ts";
import type { AttestationRecord } from "../../../src/types/evidence.ts";

const STAMP_A = "2026-04-18T00:00:00.000Z";
const STAMP_B = "2026-04-18T00:05:00.000Z";

function mkAttestation(
  criterionId: string,
  by: string,
  attestedAt: string,
  extras: Partial<AttestationRecord> = {},
): AttestationRecord {
  return {
    criterionId,
    by,
    reason: "confirmed",
    attestedAt,
    evidenceSource: "manual_review",
    ...extras,
  };
}

function mkInput(overrides: Partial<SignatureInput> = {}): SignatureInput {
  return {
    commitHash: "abc123",
    attestations: [
      mkAttestation("wcag22:1.4.3", "tester", STAMP_A),
      mkAttestation("wcag22:2.4.5", "tester", STAMP_B),
    ],
    inScopeCriterionIds: ["wcag22:1.4.3", "wcag22:2.4.5"],
    configFingerprint: { standards: ["wcag22"], level: "AA" },
    ...overrides,
  };
}

describe("signConformanceBundle (determinism)", () => {
  it("identical input yields the same digest across calls", () => {
    const a = signConformanceBundleAt(mkInput(), STAMP_A);
    const b = signConformanceBundleAt(mkInput(), STAMP_A);
    expect(a.digest).toBe(b.digest);
    expect(a.algorithm).toBe("sha256");
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signConformanceBundle stamps signedAt but the digest is stable", () => {
    const a = signConformanceBundle(mkInput());
    const b = signConformanceBundle(mkInput());
    expect(a.digest).toBe(b.digest);
  });
});

describe("signConformanceBundle (canonicalization)", () => {
  it("attestation list reordering does not change the digest", () => {
    const forward = mkInput();
    const reversed = mkInput({ attestations: [...forward.attestations].reverse() });
    const a = signConformanceBundleAt(forward, STAMP_A);
    const b = signConformanceBundleAt(reversed, STAMP_A);
    expect(a.digest).toBe(b.digest);
  });

  it("object-key order on the configFingerprint does not change the digest", () => {
    const ordered = mkInput({
      configFingerprint: { standards: ["wcag22"], level: "AA" },
    });
    // Build a new input where the key-insertion order on
    // configFingerprint is flipped — canonical JSON sorts keys so the
    // digest must not change.
    const flipped: SignatureInput = {
      ...ordered,
      configFingerprint: { level: "AA", standards: ["wcag22"] },
    };
    const a = signConformanceBundleAt(ordered, STAMP_A);
    const b = signConformanceBundleAt(flipped, STAMP_A);
    expect(a.digest).toBe(b.digest);
  });

  it("inScopeCriterionIds ordering does not change the digest", () => {
    const a = signConformanceBundleAt(
      mkInput({ inScopeCriterionIds: ["wcag22:1.4.3", "wcag22:2.4.5"] }),
      STAMP_A,
    );
    const b = signConformanceBundleAt(
      mkInput({ inScopeCriterionIds: ["wcag22:2.4.5", "wcag22:1.4.3"] }),
      STAMP_A,
    );
    expect(a.digest).toBe(b.digest);
  });

  it("ruleIds ordering inside an attestation does not change the digest", () => {
    const forward = mkInput({
      attestations: [
        mkAttestation("wcag22:4.1.2", "tester", STAMP_A, {
          ruleIds: ["aria/role-invalid", "aria/required-attrs"],
        }),
      ],
    });
    const reversed = mkInput({
      attestations: [
        mkAttestation("wcag22:4.1.2", "tester", STAMP_A, {
          ruleIds: ["aria/required-attrs", "aria/role-invalid"],
        }),
      ],
    });
    const a = signConformanceBundleAt(forward, STAMP_A);
    const b = signConformanceBundleAt(reversed, STAMP_A);
    expect(a.digest).toBe(b.digest);
  });
});

describe("signConformanceBundle (sensitivity)", () => {
  it("one extra attestation changes the digest", () => {
    const base = mkInput();
    const augmented = mkInput({
      attestations: [...base.attestations, mkAttestation("wcag22:3.3.2", "tester", STAMP_A)],
    });
    const a = signConformanceBundleAt(base, STAMP_A);
    const b = signConformanceBundleAt(augmented, STAMP_A);
    expect(a.digest).not.toBe(b.digest);
  });

  it("changing the commit hash changes the digest", () => {
    const a = signConformanceBundleAt(mkInput({ commitHash: "abc123" }), STAMP_A);
    const b = signConformanceBundleAt(mkInput({ commitHash: "def456" }), STAMP_A);
    expect(a.digest).not.toBe(b.digest);
  });

  it("changing the in-scope criterion set changes the digest", () => {
    const a = signConformanceBundleAt(mkInput({ inScopeCriterionIds: ["wcag22:1.4.3"] }), STAMP_A);
    const b = signConformanceBundleAt(
      mkInput({ inScopeCriterionIds: ["wcag22:1.4.3", "wcag22:2.4.5"] }),
      STAMP_A,
    );
    expect(a.digest).not.toBe(b.digest);
  });

  it("changing the config level changes the digest", () => {
    const a = signConformanceBundleAt(
      mkInput({ configFingerprint: { standards: ["wcag22"], level: "AA" } }),
      STAMP_A,
    );
    const b = signConformanceBundleAt(
      mkInput({ configFingerprint: { standards: ["wcag22"], level: "AAA" } }),
      STAMP_A,
    );
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("verifyConformanceBundle", () => {
  it("returns valid when the current input matches the stamped fingerprint", () => {
    const signature = signConformanceBundleAt(mkInput(), STAMP_A);
    expect(verifyConformanceBundle(signature, mkInput())).toEqual({ valid: true });
  });

  it("routes commit drift to commit-drift", () => {
    const signature = signConformanceBundleAt(mkInput({ commitHash: "abc123" }), STAMP_A);
    const result = verifyConformanceBundle(signature, mkInput({ commitHash: "def456" }));
    expect(result).toEqual({ valid: false, reason: "commit-drift" });
  });

  it("routes attestation-set drift to attestation-set-mismatch", () => {
    const signature = signConformanceBundleAt(mkInput(), STAMP_A);
    const drifted = mkInput({
      attestations: [...mkInput().attestations, mkAttestation("wcag22:3.3.2", "tester", STAMP_A)],
    });
    const result = verifyConformanceBundle(signature, drifted);
    expect(result).toEqual({ valid: false, reason: "attestation-set-mismatch" });
  });

  it("routes in-scope criterion drift to in-scope-criterion-mismatch", () => {
    const signature = signConformanceBundleAt(
      mkInput({ inScopeCriterionIds: ["wcag22:1.4.3", "wcag22:2.4.5"] }),
      STAMP_A,
    );
    const result = verifyConformanceBundle(
      signature,
      mkInput({ inScopeCriterionIds: ["wcag22:1.4.3"] }),
    );
    expect(result).toEqual({ valid: false, reason: "in-scope-criterion-mismatch" });
  });

  it("routes config-standards drift to config-standards-mismatch", () => {
    const signature = signConformanceBundleAt(
      mkInput({ configFingerprint: { standards: ["wcag22"], level: "AA" } }),
      STAMP_A,
    );
    const result = verifyConformanceBundle(
      signature,
      mkInput({ configFingerprint: { standards: ["wcag22", "section508"], level: "AA" } }),
    );
    expect(result).toEqual({ valid: false, reason: "config-standards-mismatch" });
  });

  it("routes config-level drift to config-level-mismatch", () => {
    const signature = signConformanceBundleAt(
      mkInput({ configFingerprint: { standards: ["wcag22"], level: "AA" } }),
      STAMP_A,
    );
    const result = verifyConformanceBundle(
      signature,
      mkInput({ configFingerprint: { standards: ["wcag22"], level: "AAA" } }),
    );
    expect(result).toEqual({ valid: false, reason: "config-level-mismatch" });
  });

  it("routes a tampered digest to digest-mismatch", () => {
    const signature = signConformanceBundleAt(mkInput(), STAMP_A);
    const tampered: ConformanceSignature = {
      ...signature,
      digest: "0".repeat(64),
    };
    const result = verifyConformanceBundle(tampered, mkInput());
    expect(result).toEqual({ valid: false, reason: "digest-mismatch" });
  });

  it("canonical-ordering differences on input still verify cleanly", () => {
    const signature = signConformanceBundleAt(mkInput(), STAMP_A);
    const reordered = mkInput({ attestations: [...mkInput().attestations].reverse() });
    expect(verifyConformanceBundle(signature, reordered)).toEqual({ valid: true });
  });
});

// ─── Extended fingerprint: file manifest, tool version, full config ────────

describe("signConformanceBundle (extended fingerprint)", () => {
  it("file manifest reordering does not change the digest", () => {
    const base = mkInput({
      fileManifest: [
        { path: "src/a.tsx", sha256: "aa".repeat(32) },
        { path: "src/b.tsx", sha256: "bb".repeat(32) },
      ],
    });
    const reversed = mkInput({
      fileManifest: [
        { path: "src/b.tsx", sha256: "bb".repeat(32) },
        { path: "src/a.tsx", sha256: "aa".repeat(32) },
      ],
    });
    expect(signConformanceBundleAt(base, STAMP_A).digest).toBe(
      signConformanceBundleAt(reversed, STAMP_A).digest,
    );
  });

  it("file manifest content drift changes the digest", () => {
    const base = mkInput({
      fileManifest: [{ path: "src/a.tsx", sha256: "aa".repeat(32) }],
    });
    const drifted = mkInput({
      fileManifest: [{ path: "src/a.tsx", sha256: "cc".repeat(32) }],
    });
    expect(signConformanceBundleAt(base, STAMP_A).digest).not.toBe(
      signConformanceBundleAt(drifted, STAMP_A).digest,
    );
  });

  it("tool version change flips the digest", () => {
    const a = signConformanceBundleAt(mkInput({ toolVersion: "0.2.0" }), STAMP_A);
    const b = signConformanceBundleAt(mkInput({ toolVersion: "0.3.0" }), STAMP_A);
    expect(a.digest).not.toBe(b.digest);
  });

  it("config fingerprint profile change routes to config-profile-mismatch", () => {
    const signature = signConformanceBundleAt(
      mkInput({ configFingerprint: { standards: ["wcag22"], level: "AA", profile: "wcag22-aa" } }),
      STAMP_A,
    );
    const result = verifyConformanceBundle(
      signature,
      mkInput({ configFingerprint: { standards: ["wcag22"], level: "AA", profile: "wcag22-a" } }),
    );
    expect(result).toEqual({ valid: false, reason: "config-profile-mismatch" });
  });

  it("config fingerprint rules drift routes to config-rules-mismatch", () => {
    const signature = signConformanceBundleAt(
      mkInput({
        configFingerprint: {
          standards: ["wcag22"],
          level: "AA",
          rules: { "contrast/minimum": "error" },
        },
      }),
      STAMP_A,
    );
    const result = verifyConformanceBundle(
      signature,
      mkInput({
        configFingerprint: {
          standards: ["wcag22"],
          level: "AA",
          rules: { "contrast/minimum": "warning" },
        },
      }),
    );
    expect(result).toEqual({ valid: false, reason: "config-rules-mismatch" });
  });

  it("config fingerprint nativeWrappers drift routes to config-native-wrappers-mismatch", () => {
    const signature = signConformanceBundleAt(
      mkInput({
        configFingerprint: {
          standards: ["wcag22"],
          level: "AA",
          nativeWrappers: ["Button"],
        },
      }),
      STAMP_A,
    );
    const result = verifyConformanceBundle(
      signature,
      mkInput({
        configFingerprint: {
          standards: ["wcag22"],
          level: "AA",
          nativeWrappers: ["Button", "Link"],
        },
      }),
    );
    expect(result).toEqual({ valid: false, reason: "config-native-wrappers-mismatch" });
  });

  it("config fingerprint processes drift routes to config-processes-mismatch", () => {
    const signature = signConformanceBundleAt(
      mkInput({
        configFingerprint: {
          standards: ["wcag22"],
          level: "AA",
          processes: [{ name: "checkout", pages: ["/cart", "/pay"] }],
        },
      }),
      STAMP_A,
    );
    const result = verifyConformanceBundle(
      signature,
      mkInput({
        configFingerprint: {
          standards: ["wcag22"],
          level: "AA",
          processes: [{ name: "checkout", pages: ["/cart", "/pay", "/confirm"] }],
        },
      }),
    );
    expect(result).toEqual({ valid: false, reason: "config-processes-mismatch" });
  });

  it("config fingerprint additionalPaths drift routes to config-additional-paths-mismatch", () => {
    const signature = signConformanceBundleAt(
      mkInput({
        configFingerprint: {
          standards: ["wcag22"],
          level: "AA",
          additionalPaths: ["dist/assets"],
        },
      }),
      STAMP_A,
    );
    const result = verifyConformanceBundle(
      signature,
      mkInput({
        configFingerprint: {
          standards: ["wcag22"],
          level: "AA",
          additionalPaths: ["build/assets"],
        },
      }),
    );
    expect(result).toEqual({ valid: false, reason: "config-additional-paths-mismatch" });
  });

  it("file manifest drift routes to file-manifest-mismatch", () => {
    const signature = signConformanceBundleAt(
      mkInput({ fileManifest: [{ path: "src/a.tsx", sha256: "aa".repeat(32) }] }),
      STAMP_A,
    );
    const result = verifyConformanceBundle(
      signature,
      mkInput({ fileManifest: [{ path: "src/a.tsx", sha256: "cc".repeat(32) }] }),
    );
    expect(result).toEqual({ valid: false, reason: "file-manifest-mismatch" });
  });

  it("tool version drift routes to tool-version-mismatch", () => {
    const signature = signConformanceBundleAt(mkInput({ toolVersion: "0.2.0" }), STAMP_A);
    const result = verifyConformanceBundle(signature, mkInput({ toolVersion: "0.3.0" }));
    expect(result).toEqual({ valid: false, reason: "tool-version-mismatch" });
  });

  it("full round-trip with every optional field populated verifies cleanly", () => {
    const input = mkInput({
      configFingerprint: {
        standards: ["wcag22"],
        level: "AA",
        profile: "wcag22-aa",
        rules: { "contrast/minimum": "error" },
        nativeWrappers: ["Button", "Link"],
        processes: [{ name: "checkout", pages: ["/cart", "/pay"] }],
        additionalPaths: ["dist/assets"],
      },
      fileManifest: [
        { path: "src/a.tsx", sha256: "aa".repeat(32) },
        { path: "src/b.tsx", sha256: "bb".repeat(32) },
      ],
      toolVersion: "0.2.0",
    });
    const signature = signConformanceBundleAt(input, STAMP_A);
    expect(verifyConformanceBundle(signature, input)).toEqual({ valid: true });
  });

  it("omitted optional fields on both sides still verify cleanly", () => {
    // Minimal signature (only commit + attestations + criteria + config)
    // — no file manifest, no tool version. Verifier must accept a
    // current input that also omits those fields.
    const signature = signConformanceBundleAt(mkInput(), STAMP_A);
    expect(verifyConformanceBundle(signature, mkInput())).toEqual({ valid: true });
  });
});
