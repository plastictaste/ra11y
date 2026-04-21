import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/link-no-href.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/link-no-href", () => {
  describe("HTML: fires when", () => {
    it("a has onclick but no href", () => {
      const violations = runRule(rule, `<a onclick="doThing()">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-no-href");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:2.1.1");
    });
  });

  describe("HTML: does not fire when", () => {
    it("a has a real href", () => {
      const violations = runRule(rule, `<a href="/dashboard" onclick="doThing()">Go</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("a has only href (no handler)", () => {
      const violations = runRule(rule, `<a href="/dashboard">Go</a>`, { filePath: "index.html" });
      expect(violations).toHaveLength(0);
    });

    it("a has neither href nor onclick (named anchor placeholder)", () => {
      // Bare <a> without href is valid HTML (used to be a named anchor).
      // Without a click handler there's no keyboard trap — the element
      // is just inert text. We only flag the a+onclick combo.
      const violations = runRule(rule, `<a name="section">Section heading</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("href is a fragment id (#section-name) — legitimate in-page navigation", () => {
      // Fragment navigation actually navigates — the browser scrolls to
      // and focuses the matching id. Don't flag it.
      const violations = runRule(rule, `<a href="#top" onclick="doThing()">Top</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("href is a plain URL (no handler)", () => {
      const violations = runRule(rule, `<a href="/docs#anchor">Docs</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("HTML: fires on placeholder href", () => {
    // From a screen-reader and keyboard perspective, href="" and
    // href="#" are indistinguishable from a missing href — both are
    // non-navigating placeholders. Bootstrap's docs use href="#" in
    // dropdown/modal/carousel examples; treat those like missing href.

    it("href is empty string with onclick", () => {
      const violations = runRule(rule, `<a href="" onclick="doThing()">Go</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-no-href");
      expect(violations[0]?.severity).toBe("error");
    });

    it("href is '#' with onclick (Bootstrap dropdown pattern)", () => {
      const violations = runRule(rule, `<a href="#" onclick="toggle()">Menu</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-no-href");
    });

    it("href is '  #  ' (whitespace trimmed before comparison)", () => {
      const violations = runRule(rule, `<a href="  #  " onclick="doThing()">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("href is all-whitespace (treated as empty placeholder)", () => {
      const violations = runRule(rule, `<a href="   " onclick="doThing()">Click</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: fires when", () => {
    it("a has onClick but no href", () => {
      const violations = runRule(rule, `const X = <a onClick={handle}>Click</a>;`);
      expect(violations).toHaveLength(1);
    });
  });

  describe("JSX: does not fire when", () => {
    it("a has href and onClick", () => {
      const violations = runRule(rule, `const X = <a href="/x" onClick={handle}>Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("a has only href", () => {
      const violations = runRule(rule, `const X = <a href="/x">Go</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("custom component (PascalCase Link) is ignored", () => {
      // This rule only applies to lowercase <a>. React component links
      // like Next.js <Link> are a separate question.
      const violations = runRule(rule, `const X = <Link onClick={handle}>Go</Link>;`);
      expect(violations).toHaveLength(0);
    });

    it("a has fragment href (#anchor) and onClick", () => {
      // In-page fragment navigation — real navigation, stays silent.
      const violations = runRule(rule, `const X = <a href="#top" onClick={handle}>Top</a>;`);
      expect(violations).toHaveLength(0);
    });

    it("a has expression-form href={...} (opaque, assume real)", () => {
      // An expression-form href may resolve to anything at runtime;
      // static analysis can't prove it's a placeholder. Let the agent
      // investigate if the expression is suspicious.
      const violations = runRule(rule, `const X = <a href={url} onClick={handle}>Go</a>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires on placeholder href", () => {
    it("href is empty string with onClick", () => {
      const violations = runRule(rule, `const X = <a href="" onClick={handle}>Go</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("navigation/link-no-href");
    });

    it("href='#' with onClick (dropdown-style placeholder)", () => {
      const violations = runRule(rule, `const X = <a href="#" onClick={handle}>Menu</a>;`);
      expect(violations).toHaveLength(1);
    });

    it("href=' # ' (whitespace trimmed before comparison)", () => {
      const violations = runRule(rule, `const X = <a href=" # " onClick={handle}>X</a>;`);
      expect(violations).toHaveLength(1);
    });

    it("navigation-intent suggestion still routes through onClick body", () => {
      // href="#" doesn't affect the intent probe — that probe reads
      // the onClick expression, not the href. Placeholder href +
      // navigating handler still lands on the navigation suggestion.
      const violations = runRule(
        rule,
        `const X = <a href="#" onClick={() => navigate("/x")}>Go</a>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
    });
  });

  describe("context-aware fix suggestion", () => {
    it("navigation-intent: onClick calls navigate(...) → suggests real href", () => {
      const violations = runRule(
        rule,
        `const X = <a onClick={() => navigate("/dashboard")}>Go</a>;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
      expect(violations[0]?.suggestion).toContain('href="..."');
      expect(violations[0]?.suggestion).toContain("preventDefault");
    });

    it("navigation-intent: onClick calls history.push(...) → suggests real href", () => {
      const violations = runRule(rule, `const X = <a onClick={() => history.push("/x")}>Go</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
    });

    it("navigation-intent: onClick calls router.replace(...) → suggests real href", () => {
      const violations = runRule(rule, `const X = <a onClick={() => router.replace("/y")}>Go</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
    });

    it("mutation-intent: React setter pattern setOpen(...) → suggests <button>", () => {
      const violations = runRule(rule, `const X = <a onClick={() => setOpen(true)}>Open</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("mutation");
      expect(violations[0]?.suggestion).toContain(`<button type="button"`);
    });

    it("mutation-intent: onClick calls toggle(...) → suggests <button>", () => {
      const violations = runRule(rule, `const X = <a onClick={() => toggleMenu()}>Menu</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("mutation");
      expect(violations[0]?.suggestion).toContain(`<button type="button"`);
    });

    it("unknown-intent: empty arrow body → generic either-or suggestion", () => {
      const violations = runRule(rule, `const X = <a onClick={() => {}}>Click</a>;`);
      expect(violations).toHaveLength(1);
      const sugg = violations[0]?.suggestion ?? "";
      expect(sugg).toContain("decide the intent");
      expect(sugg).toContain("navigates");
      expect(sugg).toContain("action");
    });

    it("unknown-intent: bare identifier handler → generic either-or suggestion", () => {
      // The probe is text-level; a bare `handle` reference doesn't
      // name any navigation or mutation keyword, so unknown is correct.
      const violations = runRule(rule, `const X = <a onClick={handle}>Click</a>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("decide the intent");
    });

    it("HTML: onclick with window.location → navigation-intent", () => {
      const violations = runRule(rule, `<a onclick="window.location='/go'">Go</a>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("navigation");
    });
  });

  describe("rule metadata", () => {
    it("declares wcag22:2.1.1, wcag21:2.1.1, wcag22:4.1.2, wcag21:4.1.2", () => {
      expect(rule.satisfies).toContain("wcag22:2.1.1");
      expect(rule.satisfies).toContain("wcag21:2.1.1");
      expect(rule.satisfies).toContain("wcag22:4.1.2");
      expect(rule.satisfies).toContain("wcag21:4.1.2");
    });
  });
});
