import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/keyboard/handler-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule keyboard/handler-missing", () => {
  describe("JSX: fires when", () => {
    it("div has onClick without onKeyDown", () => {
      const v = runRule(rule, `const X = <div onClick={doThing}>Click</div>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("onClick");
    });

    it("span has onClick without keyboard handler", () => {
      const v = runRule(rule, `const X = <span onClick={doThing}>x</span>;`);
      expect(v).toHaveLength(1);
    });

    it("<a> without href and with onClick is flagged", () => {
      const v = runRule(rule, `const X = <a onClick={doThing}>click</a>;`);
      expect(v.length).toBeGreaterThan(0);
    });
  });

  describe("JSX: does NOT fire when", () => {
    it("button has onClick", () => {
      const v = runRule(rule, `const X = <button onClick={doThing}>Save</button>;`);
      expect(v).toHaveLength(0);
    });

    it("anchor with href has onClick", () => {
      const v = runRule(rule, `const X = <a href="/x" onClick={doThing}>link</a>;`);
      expect(v).toHaveLength(0);
    });

    it("div has both onClick and onKeyDown", () => {
      const v = runRule(rule, `const X = <div onClick={doThing} onKeyDown={doThing}>click</div>;`);
      expect(v).toHaveLength(0);
    });

    it("div has role=button and keyboard handler", () => {
      const v = runRule(
        rule,
        `const X = <div role="button" onClick={doThing} onKeyDown={doThing}>click</div>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("input has onClick (natively interactive)", () => {
      const v = runRule(rule, `const X = <input type="checkbox" onClick={doThing} />;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("HTML: fires when", () => {
    it("div has onclick attribute without keyboard handler", () => {
      const v = runRule(rule, `<div onclick="doThing()">click</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("button has onclick", () => {
      const v = runRule(rule, `<button onclick="doThing()">Save</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("div has onclick and onkeydown", () => {
      const v = runRule(rule, `<div onclick="doThing()" onkeydown="doThing()">click</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("suggestion quality", () => {
    it("suggests changing to <button> when no role is set", () => {
      const v = runRule(rule, `const X = <div onClick={doThing}>click</div>;`);
      expect(v[0]?.suggestion).toContain("<button");
    });

    it("mentions Enter and Space keys when role is already set", () => {
      const v = runRule(rule, `const X = <div role="button" onClick={doThing}>click</div>;`);
      expect(v[0]?.suggestion).toContain("Enter and Space");
    });
  });

  // ---------------------------------------------------------------------------
  // Attribute-interaction grammar (Bootstrap data-bs-* and predecessors)
  // ---------------------------------------------------------------------------

  describe("HTML attribute-interaction: fires when", () => {
    it("div has data-bs-toggle on bare div (Bootstrap 5 dropdown/modal)", () => {
      const v = runRule(rule, `<div data-bs-toggle="dropdown">Menu</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("data-bs-toggle");
      expect(v[0]?.message).toContain("dropdown");
    });

    it("span has data-bs-dismiss on bare span (Bootstrap 5 modal close)", () => {
      const v = runRule(rule, `<span data-bs-dismiss="modal">X</span>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("data-bs-dismiss");
    });

    it("div has data-bs-ride (Bootstrap carousel on non-focusable root)", () => {
      const v = runRule(rule, `<div data-bs-ride="carousel">...</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("data-bs-ride");
    });

    it("flags Bootstrap 4 legacy data-toggle attribute", () => {
      const v = runRule(rule, `<div data-toggle="modal">Open</div>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("data-toggle");
    });

    it("flags <a> without href but with data-bs-toggle (not focusable)", () => {
      const v = runRule(rule, `<a data-bs-toggle="dropdown">Menu</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("without href");
    });

    it("suggestion mentions keeping the attribute when converting to <button>", () => {
      const v = runRule(rule, `<div data-bs-toggle="modal">Open</div>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain("<button");
      expect(v[0]?.suggestion).toContain("data-bs-toggle");
    });
  });

  describe("HTML attribute-interaction: does NOT fire when", () => {
    it("button hosts data-bs-toggle (native focus + Enter/Space)", () => {
      const v = runRule(rule, `<button data-bs-toggle="modal">Open</button>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("anchor with href hosts data-bs-toggle (focusable, Enter activates)", () => {
      const v = runRule(rule, `<a href="/menu" data-bs-toggle="dropdown">Menu</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it('anchor with href="#" hosts data-bs-toggle (degenerate href, still focusable)', () => {
      // Edge case: href="#" is a placeholder URL but the element is
      // still in the Tab order and Enter activates it. Bootstrap uses
      // this shape throughout its own dropdown/nav examples.
      const v = runRule(rule, `<a href="#" data-bs-toggle="dropdown">Menu</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("element with data-bs-toggle also declares onkeydown", () => {
      const v = runRule(
        rule,
        `<div data-bs-toggle="modal" onkeydown="handle(event)" tabindex="0">Open</div>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("input hosts data-bs-toggle (natively interactive)", () => {
      const v = runRule(rule, `<input type="button" data-bs-toggle="modal" value="Open" />`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX attribute-interaction", () => {
    it("fires on bare div with data-bs-toggle in JSX", () => {
      const v = runRule(rule, `const X = <div data-bs-toggle="modal">Open</div>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("data-bs-toggle");
    });

    it("does NOT fire on <button> with data-bs-toggle in JSX", () => {
      const v = runRule(rule, `const X = <button data-bs-toggle="modal">Open</button>;`);
      expect(v).toHaveLength(0);
    });

    it("does NOT fire on PascalCase component (can't see internals)", () => {
      const v = runRule(rule, `const X = <MyToggle data-bs-toggle="modal">Open</MyToggle>;`);
      expect(v).toHaveLength(0);
    });
  });

  it("cites wcag22:2.1.1 and wcag21:2.1.1", () => {
    expect(rule.satisfies).toContain("wcag22:2.1.1");
    expect(rule.satisfies).toContain("wcag21:2.1.1");
  });
});
