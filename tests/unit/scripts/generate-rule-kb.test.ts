import { describe, expect, test } from "bun:test";
import { chooseFilesToUnlink, HAND_AUTHORED_KB_SLUGS } from "../../../scripts/generate-rule-kb.ts";

describe("chooseFilesToUnlink — generator-owned unlink decisions", () => {
  test("preserves index.md and README.md regardless of context", () => {
    const present = ["index.md", "README.md"];
    const result = chooseFilesToUnlink(present, []);
    expect(result).toEqual([]);
  });

  test("preserves non-.md entries (directories, stray files)", () => {
    const present = ["subdir", "notes.txt"];
    const result = chooseFilesToUnlink(present, []);
    expect(result).toEqual([]);
  });

  test("removes a previously-generated file whose slug is no longer expected", () => {
    // A rule was deleted; its old KB page is stale and must go.
    const present = ["aria__old-rule.md", "aria__kept.md"];
    const expected = ["aria__kept"];
    const result = chooseFilesToUnlink(present, expected);
    expect(result).toEqual(["aria__old-rule.md"]);
  });

  test("does not remove a file whose slug is in the expected set — it gets overwritten", () => {
    const present = ["aria__current.md"];
    const expected = ["aria__current"];
    const result = chooseFilesToUnlink(present, expected);
    expect(result).toEqual([]);
  });

  test("preserves hand-authored fix-suggestion-audit.md across the rules-dir sweep", () => {
    // The regression V1-TOOL-KB-GEN-PRESERVE-HANDWRITTEN exists to prevent.
    const present = ["fix-suggestion-audit.md", "aria__valid-attr.md", "aria__stale.md"];
    const expected = ["aria__valid-attr"];
    const result = chooseFilesToUnlink(present, expected);
    expect(result).toEqual(["aria__stale.md"]);
    expect(result).not.toContain("fix-suggestion-audit.md");
  });

  test("preserves hand-authored coverage.md across the standards-dir sweep", () => {
    // coverage.md is owned by generate-coverage-matrix.ts; this generator
    // must leave it alone. The drift check already treats it as a known extra.
    const present = ["coverage.md", "wcag22.md", "legacy-standard.md"];
    const expected = ["wcag22", "wcag21", "section508", "en301549"];
    const result = chooseFilesToUnlink(present, expected);
    expect(result).toEqual(["legacy-standard.md"]);
    expect(result).not.toContain("coverage.md");
  });

  test("HAND_AUTHORED_KB_SLUGS covers the two files called out by the bug report", () => {
    expect(HAND_AUTHORED_KB_SLUGS.has("fix-suggestion-audit")).toBe(true);
    expect(HAND_AUTHORED_KB_SLUGS.has("coverage")).toBe(true);
  });

  test("empty present list yields empty result", () => {
    expect(chooseFilesToUnlink([], ["a", "b"])).toEqual([]);
  });

  test("all-stale none-expected: every non-exempt generated file is removed", () => {
    const present = ["aria__a.md", "aria__b.md", "aria__c.md"];
    const result = chooseFilesToUnlink(present, []);
    expect(result).toEqual(["aria__a.md", "aria__b.md", "aria__c.md"]);
  });
});
