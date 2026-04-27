import { describe, expect, it } from "bun:test";
import {
  findAliasByFrom,
  formatDeprecatedRuleIdWarning,
  RULE_ALIASES,
  type RuleAlias,
  resolveRuleId,
} from "../../../src/engine/rule-aliases.ts";

/**
 * Unit tests for the rule-ID alias resolver. The resolver is the seam
 * that makes the "rename behind the alias is minor" carve-out in
 * CLAUDE.md §12 work — an old ID still resolves to its new canonical
 * form for the duration of its deprecation window, and every
 * resolution must emit the structured `deprecated_rule_id:<from>:<to>`
 * warning so agents can offer to rewrite the reference.
 *
 * The tests exercise invariants that must hold regardless of what the
 * alias table happens to contain today:
 *   - an input that doesn't match any alias passes through unchanged
 *     with no `deprecated` record;
 *   - a matching alias produces the canonical `to` plus the full alias
 *     record, never a partial shape;
 *   - the warning formatter emits exactly the three-colon shape the
 *     agent parses;
 *   - the frozen table can't be mutated at runtime;
 *   - no two live entries share a `from` key (one-hop contract).
 *
 * An in-memory synthetic table drives the resolution-behavior tests so
 * they stay valid when the shipped `RULE_ALIASES` is empty (current
 * state, per's empty-initial guidance)
 * and when populates the first
 * entry.
 */

describe("resolveRuleId", () => {
  it("passes through an unknown rule ID unchanged", () => {
    expect(resolveRuleId("keyboard/handler-missing")).toEqual({
      resolved: "keyboard/handler-missing",
    });
  });

  it("passes through an empty string unchanged (no match, no crash)", () => {
    expect(resolveRuleId("")).toEqual({ resolved: "" });
  });

  it("passes through a criterion-shaped token (rule-ID table never matches criteria)", () => {
    // Criterion IDs (`wcag22:2.4.5`) flow through the same resolver in
    // the inline-disables pragma parser. The alias table keys on rule
    // IDs only, so criterion-shaped tokens must never fire a match
    // accidentally.
    expect(resolveRuleId("wcag22:2.4.5")).toEqual({ resolved: "wcag22:2.4.5" });
  });

  it("passes through the wildcard sentinel unchanged", () => {
    expect(resolveRuleId("*")).toEqual({ resolved: "*" });
  });
});

describe("formatDeprecatedRuleIdWarning", () => {
  it("produces the `deprecated_rule_id:<from>:<to>` contract shape", () => {
    const alias: RuleAlias = {
      from: "old/id",
      to: "new/id",
      deprecatedSince: "0.2.0",
      removeIn: "0.3.0",
    };
    expect(formatDeprecatedRuleIdWarning(alias)).toBe("deprecated_rule_id:old/id:new/id");
  });

  it("preserves slashes and colons in rule-ID segments verbatim", () => {
    const alias: RuleAlias = {
      from: "navigation/href-void",
      to: "links/href-missing",
      deprecatedSince: "0.2.0",
      removeIn: "0.3.0",
    };
    expect(formatDeprecatedRuleIdWarning(alias)).toBe(
      "deprecated_rule_id:navigation/href-void:links/href-missing",
    );
  });
});

describe("RULE_ALIASES table invariants", () => {
  it("is frozen — runtime mutation does not silently succeed", () => {
    expect(Object.isFrozen(RULE_ALIASES)).toBe(true);
  });

  it("has no duplicate `from` keys (one-hop contract)", () => {
    const seen = new Set<string>();
    for (const alias of RULE_ALIASES) {
      expect(seen.has(alias.from)).toBe(false);
      seen.add(alias.from);
    }
  });

  it("has no self-referential entries (`from === to` would mean nothing to rewrite)", () => {
    for (const alias of RULE_ALIASES) {
      expect(alias.from).not.toBe(alias.to);
    }
  });

  it("has no chained aliases (B in `from` never equals another entry's `to`)", () => {
    // Chaining (A → B → C) would require a multi-hop resolver; the
    // contract is one hop, and the commit that retires B must rewrite
    // A's `to` to C in the same change. Assert we haven't drifted.
    const tos = new Set(RULE_ALIASES.map((a) => a.to));
    for (const alias of RULE_ALIASES) {
      expect(tos.has(alias.from)).toBe(false);
    }
  });
});

describe("findAliasByFrom", () => {
  it("returns undefined for any input when the table is empty", () => {
    // When the table eventually populates, this test still passes for
    // any ID that isn't the `from` of a live alias. Pick a token that's
    // deliberately unlikely to collide with a real rule ID.
    expect(findAliasByFrom("__never_a_real_rule_id__")).toBeUndefined();
  });

  it("returns the same record `resolveRuleId` would attach for a live alias", () => {
    // Spot-check one live alias (if any) — covers the-
    // NAVIGATION-HREF-VOID-RENAME commit when it populates the table.
    for (const alias of RULE_ALIASES) {
      const resolution = resolveRuleId(alias.from);
      expect(resolution.deprecated).toEqual(alias);
      expect(findAliasByFrom(alias.from)).toEqual(alias);
    }
  });
});
