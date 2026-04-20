import { describe, expect, it } from "bun:test";
import { truncateForEcho } from "../../../src/engine/ast-helpers.ts";

/**
 * Unit tests for the user-authored-echo cap. The helper backstops every
 * rule that interpolates a free-form attribute value (alt, aria-label,
 * title, href, src) or a visible text run into an agent-visible response
 * string — without it, a single 1.5 KB lorem-ipsum label can balloon a
 * scan response by tens of KB once the value is echoed twice per
 * finding across many findings.
 */

const ELLIPSIS = "\u2026"; // U+2026 HORIZONTAL ELLIPSIS — single character, not three dots.

describe("truncateForEcho", () => {
  it("returns text unchanged when shorter than max", () => {
    expect(truncateForEcho("hello", 200)).toBe("hello");
  });

  it("returns text unchanged when exactly at max", () => {
    const text = "a".repeat(200);
    expect(truncateForEcho(text, 200)).toBe(text);
  });

  it("truncates and appends a single ellipsis when one char over max", () => {
    const text = `${"a".repeat(200)}b`;
    const result = truncateForEcho(text, 200);
    expect(result).toBe(`${"a".repeat(200)}${ELLIPSIS}`);
    // length is max + 1 (200 sliced chars + 1 ellipsis char).
    expect(result.length).toBe(201);
    expect(result).not.toContain("b");
  });

  it("truncates much-longer text to the same shape", () => {
    const text = "x".repeat(5000);
    const result = truncateForEcho(text, 200);
    expect(result).toBe(`${"x".repeat(200)}${ELLIPSIS}`);
    expect(result.endsWith(ELLIPSIS)).toBe(true);
    expect(result.length).toBe(201);
  });

  it("returns empty string unchanged", () => {
    expect(truncateForEcho("", 200)).toBe("");
  });

  it("handles max = 0 by returning the ellipsis alone for non-empty input", () => {
    // Documented behavior: max = 0 means "no characters allowed" — empty
    // input passes (0 <= 0), any non-empty input collapses to just the
    // ellipsis sentinel. Edge case for completeness.
    expect(truncateForEcho("", 0)).toBe("");
    expect(truncateForEcho("anything", 0)).toBe(ELLIPSIS);
  });

  it("applies the default max of 200 when omitted", () => {
    const exact = "a".repeat(200);
    const over = `${"a".repeat(200)}b`;
    expect(truncateForEcho(exact)).toBe(exact);
    expect(truncateForEcho(over)).toBe(`${"a".repeat(200)}${ELLIPSIS}`);
  });

  it("uses the U+2026 single-character ellipsis (not three ASCII dots)", () => {
    const result = truncateForEcho("a".repeat(500), 200);
    expect(result.endsWith(ELLIPSIS)).toBe(true);
    expect(result.endsWith("...")).toBe(false);
  });

  it("respects a custom cap below the default", () => {
    const result = truncateForEcho("a".repeat(50), 40);
    expect(result).toBe(`${"a".repeat(40)}${ELLIPSIS}`);
    expect(result.length).toBe(41);
  });
});
