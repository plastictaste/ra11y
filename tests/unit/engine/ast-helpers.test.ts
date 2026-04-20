import { describe, expect, it } from "bun:test";
import { describeJsxExpressionIntent } from "../../../src/engine/ast-helpers.ts";

/**
 * Unit tests for the AST helper primitives. Focused on the pieces that
 * shape fix-suggestion branches — the rest of the module is exercised
 * transitively by rule tests and the `describeNodeShape` suite.
 */

describe("describeJsxExpressionIntent", () => {
  describe("returns 'navigation' when", () => {
    it("the expression calls navigate(...)", () => {
      expect(describeJsxExpressionIntent(`() => navigate("/dashboard")`)).toBe("navigation");
    });

    it("the expression calls history.push(...)", () => {
      expect(describeJsxExpressionIntent(`() => history.push("/x")`)).toBe("navigation");
    });

    it("the expression calls router.replace(...)", () => {
      expect(describeJsxExpressionIntent(`() => router.replace("/y")`)).toBe("navigation");
    });

    it("the expression references window.location", () => {
      expect(describeJsxExpressionIntent(`() => { window.location = "/go"; }`)).toBe("navigation");
    });

    it("the expression names redirect as an identifier", () => {
      expect(describeJsxExpressionIntent(`() => redirect("/signin")`)).toBe("navigation");
    });
  });

  describe("returns 'mutation' when", () => {
    it("the expression calls a React setter (setOpen)", () => {
      expect(describeJsxExpressionIntent(`() => setOpen(true)`)).toBe("mutation");
    });

    it("the expression calls toggleMenu() (camelCase verb prefix)", () => {
      expect(describeJsxExpressionIntent(`() => toggleMenu()`)).toBe("mutation");
    });

    it("the expression calls a bare toggle()", () => {
      expect(describeJsxExpressionIntent(`() => toggle()`)).toBe("mutation");
    });

    it("the expression calls dispatch(...)", () => {
      expect(describeJsxExpressionIntent(`() => dispatch({ type: "OPEN" })`)).toBe("mutation");
    });
  });

  describe("returns 'unknown' when", () => {
    it("the expression is null", () => {
      expect(describeJsxExpressionIntent(null)).toBe("unknown");
    });

    it("the expression is empty or whitespace", () => {
      expect(describeJsxExpressionIntent("")).toBe("unknown");
      expect(describeJsxExpressionIntent("   ")).toBe("unknown");
    });

    it("the expression is a bare identifier with no keyword match", () => {
      expect(describeJsxExpressionIntent(`handle`)).toBe("unknown");
      expect(describeJsxExpressionIntent(`() => handle(e)`)).toBe("unknown");
    });

    it("the expression body is empty", () => {
      expect(describeJsxExpressionIntent(`() => {}`)).toBe("unknown");
    });

    it("settings (not a setter) is present but no other signal", () => {
      // The React setter regex requires `set` + Capital + `(` — the
      // substring `settings` must not match.
      expect(describeJsxExpressionIntent(`() => { const x = settings.foo; }`)).toBe("unknown");
    });
  });

  describe("ordering: navigation wins ties", () => {
    it("router.push(...) is navigation, not mutation via push(", () => {
      // `.push(` is a navigation method-call signal; standalone `push(`
      // never fires because the probe requires the member-access form.
      expect(describeJsxExpressionIntent(`() => router.push("/x")`)).toBe("navigation");
    });

    it("mixed signal: a navigation keyword beats a mutation keyword", () => {
      // If an expression somehow references both, navigation takes
      // precedence so the agent hears "this is a link" rather than
      // "this is a button."
      expect(describeJsxExpressionIntent(`() => { setOpen(false); navigate("/x"); }`)).toBe(
        "navigation",
      );
    });
  });
});
