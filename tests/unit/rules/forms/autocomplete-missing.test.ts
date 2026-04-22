import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/forms/autocomplete-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule forms/autocomplete-missing", () => {
  describe("HTML: fires when", () => {
    it("type=email has no autocomplete", () => {
      const violations = runRule(rule, `<input type="email" name="email">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("forms/autocomplete-missing");
      expect(violations[0]?.severity).toBe("warning");
      expect(violations[0]?.suggestion).toContain(`autocomplete="email"`);
      // Reason cites the concrete trigger (type beats name when both fire).
      expect(violations[0]?.message).toContain(`type="email"`);
    });

    it("type=tel has no autocomplete", () => {
      const violations = runRule(rule, `<input type="tel" name="phone">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain(`autocomplete="tel"`);
      expect(violations[0]?.message).toContain(`type="tel"`);
    });

    it("type=password has no autocomplete", () => {
      const violations = runRule(rule, `<input type="password" name="pw">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain(`current-password`);
      expect(violations[0]?.message).toContain(`type="password"`);
    });

    it("type=text with name='firstName' infers given-name", () => {
      const violations = runRule(rule, `<input type="text" name="firstName">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("given-name");
      // Name-path citation: quote the actual attribute value + the matched token.
      expect(violations[0]?.message).toContain(`name "firstName"`);
      expect(violations[0]?.message).toContain(`"firstname"`);
    });

    it("type=text with id='zipCode' infers postal-code", () => {
      const violations = runRule(rule, `<input type="text" id="zipCode">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("postal-code");
      // Id-path citation: different prefix than the name path.
      expect(violations[0]?.message).toContain(`id "zipCode"`);
      expect(violations[0]?.message).toContain(`"zipcode"`);
    });

    it("fixture-shaped input (type=text, name='floatingInput') does not fire — agent can dismiss from reason alone", () => {
      // The exact shape Bootstrap's visual-regression fixtures produced —
      // name token has no personal-info match, so rule stays silent. This
      // is the dismissal path the reason-text enrichment supports for the
      // cases that *do* fire on fixture-shaped inputs (e.g. name="emailInput").
      const violations = runRule(rule, `<input type="text" name="floatingInput">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("fixture-shaped input with matching name token still fires, reason cites name", () => {
      // e.g. `<input type="text" name="emailInput">` — the rule should fire
      // (safe surface default), but the reason text must be specific enough
      // that an agent reading the fixture file dismisses in one read rather
      // than cracking the rule definition open.
      const violations = runRule(rule, `<input type="text" name="emailInput">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`name "emailInput"`);
      expect(violations[0]?.message).toContain(`"email"`);
      // Must not falsely cite a type= trigger when only the name matched.
      expect(violations[0]?.message).not.toContain(`type="email"`);
    });
  });

  describe("HTML: does not fire when", () => {
    it("input has autocomplete", () => {
      const violations = runRule(rule, `<input type="email" autocomplete="email">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("type=checkbox", () => {
      const violations = runRule(rule, `<input type="checkbox" name="agree">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("type=submit", () => {
      const violations = runRule(rule, `<input type="submit" value="Save">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("type=text with unrecognized name", () => {
      const violations = runRule(rule, `<input type="text" name="searchQuery">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("type=hidden", () => {
      const violations = runRule(rule, `<input type="hidden" name="csrfToken">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    // WCAG 1.3.5 Input Purposes enumerates 53 autocomplete tokens;
    // "search" is not one of them. A site-search <input> is out of
    // scope for the criterion entirely — no token would fit the fix.
    // These guards are spec-correctness, not heuristic suppression.
    it("type=search skips the name/id heuristic branch", () => {
      // Before the fix, matchPurpose had a `type !== "search"` carve-out
      // that let search-typed inputs fall through to name/id matching.
      // An id like "search-user-email" would match the email needle and
      // fire with suggestion="autocomplete=email" on a search box.
      const violations = runRule(
        rule,
        `<input type="search" id="search-user-email" name="q">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("role=searchbox skips even when name matches a heuristic", () => {
      const violations = runRule(rule, `<input type="text" role="searchbox" name="firstName">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it('aria-label="Search" skips even when name matches a heuristic', () => {
      const violations = runRule(
        rule,
        `<input type="text" aria-label="Search users" name="firstName">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("name token includes search (camelCase) — skip", () => {
      const violations = runRule(rule, `<input type="text" name="searchInput">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("id token includes search (kebab-case) — skip", () => {
      const violations = runRule(rule, `<input type="text" id="search-input">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it('name="q" (canonical search-query name) — skip', () => {
      const violations = runRule(rule, `<input type="text" name="q">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it('name="query" — skip', () => {
      const violations = runRule(rule, `<input type="text" name="query">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("standalone q-as-token does not over-match identifiers containing q", () => {
      // "query" is a search token too, so this case exercises the
      // tokenize path rather than the q-alone path. The guard must not
      // falsely skip identifiers that merely contain the letter q
      // (e.g. "sequential", "liquor") — neither tokenizes to `q` or
      // `query` as a standalone token, so the rule stays live.
      const violations = runRule(rule, `<input type="text" name="sequentialEmail">`, {
        filePath: "index.html",
      });
      // sequentialEmail contains `email` → rule still fires (name path).
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("email");
    });
  });

  describe("JSX: fires when", () => {
    it("type=email has no autoComplete", () => {
      const violations = runRule(rule, `const X = <input type="email" name="email" />;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("input has autoComplete (React prop name)", () => {
      const violations = runRule(rule, `const X = <input type="email" autoComplete="email" />;`);
      expect(violations).toHaveLength(0);
    });

    it("input has autocomplete (HTML attribute name, also allowed)", () => {
      const violations = runRule(rule, `const X = <input type="email" autocomplete="email" />;`);
      expect(violations).toHaveLength(0);
    });

    it("type=search + id with heuristic needle — skip (spec-correctness)", () => {
      const violations = runRule(
        rule,
        `const X = <input type="search" id="search-user-email" name="q" />;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("role=searchbox — skip even when name matches a heuristic", () => {
      const violations = runRule(
        rule,
        `const X = <input type="text" role="searchbox" name="firstName" />;`,
      );
      expect(violations).toHaveLength(0);
    });

    it('aria-label="Search" — skip even when name matches a heuristic', () => {
      const violations = runRule(
        rule,
        `const X = <input type="text" aria-label="Search users" name="firstName" />;`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:1.3.5 and wcag21:1.3.5", () => {
      expect(rule.satisfies).toContain("wcag22:1.3.5");
      expect(rule.satisfies).toContain("wcag21:1.3.5");
    });
  });
});
