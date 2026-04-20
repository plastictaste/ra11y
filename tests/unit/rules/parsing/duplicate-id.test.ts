import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/parsing/duplicate-id.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule parsing/duplicate-id", () => {
  it("fires when two elements share an id", () => {
    const v = runRule(rule, `<div id="main"></div><div id="main"></div>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe("error");
    expect(v[0]?.message).toContain("main");
  });

  it("reports one violation per additional occurrence", () => {
    const v = runRule(rule, `<div id="x"></div><div id="x"></div><div id="x"></div>`, {
      filePath: "index.html",
    });
    // First is seed; second and third are reported.
    expect(v).toHaveLength(2);
  });

  it("reports the line of the FIRST occurrence in the message", () => {
    const v = runRule(rule, `<div id="foo"></div>\n<p>filler</p>\n<div id="foo"></div>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("line 1");
  });

  it("does not fire when all ids are unique", () => {
    const v = runRule(rule, `<div id="a"></div><div id="b"></div><div id="c"></div>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(0);
  });

  it("does not fire when there are no ids at all", () => {
    const v = runRule(rule, `<p>hello</p><p>world</p>`, { filePath: "index.html" });
    expect(v).toHaveLength(0);
  });

  it("ignores empty id attributes", () => {
    const v = runRule(rule, `<div id=""></div><div id=""></div>`, { filePath: "index.html" });
    expect(v).toHaveLength(0);
  });

  it("catches duplicates across different element types", () => {
    const v = runRule(rule, `<h1 id="main"></h1><main id="main"></main>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
  });

  it("catches duplicates inside nested structures", () => {
    const v = runRule(
      rule,
      `<section><div id="target"></div></section><article><span id="target"></span></article>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
  });

  it("suggestion mentions aria-labelledby and label[for] impact", () => {
    const v = runRule(rule, `<div id="dup"></div><div id="dup"></div>`, {
      filePath: "index.html",
    });
    expect(v[0]?.suggestion).toContain("aria-labelledby");
  });

  it("suggestion inlines the first occurrence's tag+line and proposes a numeric suffix", () => {
    const v = runRule(
      rule,
      `<main id="mainContent"></main>\n<p>filler</p>\n<section id="mainContent"></section>`,
      { filePath: "index.html" },
    );
    expect(v).toHaveLength(1);
    const suggestion = v[0]?.suggestion ?? "";
    // First occurrence: <main> on line 1.
    expect(suggestion).toContain("<main>");
    expect(suggestion).toContain("line 1");
    // Current (duplicate) occurrence tag.
    expect(suggestion).toContain("<section>");
    // Concrete rename candidate with numeric suffix 2.
    expect(suggestion).toContain(`id="mainContent2"`);
    // Mentions all four reference hooks that silently resolve to the first match.
    expect(suggestion).toContain("aria-labelledby");
    expect(suggestion).toContain("aria-controls");
    expect(suggestion).toContain("label[for]");
  });

  it("three-way duplicate suggests the next free numeric suffix (id3 not id2)", () => {
    const v = runRule(rule, `<div id="panel"></div><div id="panel"></div><div id="panel"></div>`, {
      filePath: "index.html",
    });
    // Two violations (second and third occurrence).
    expect(v).toHaveLength(2);
    // Both duplicates should skip "panel" (taken by the seed) and also
    // "panel2" is *not* present in the document — so the suggestion for
    // both is "panel2". But when a user manually renames both, they need
    // distinct names; surfacing "panel2" for both is the honest answer
    // (it's the next free slot from the document's current state).
    expect(v[0]?.suggestion).toContain(`id="panel2"`);
    expect(v[1]?.suggestion).toContain(`id="panel2"`);
  });

  it("three-way duplicate where panel2 is already taken suggests panel3", () => {
    const v = runRule(rule, `<div id="panel"></div><div id="panel2"></div><div id="panel"></div>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    // panel2 is taken by the sibling, so the next free suffix is panel3.
    expect(v[0]?.suggestion).toContain(`id="panel3"`);
    expect(v[0]?.suggestion).not.toContain(`id="panel2"`);
  });

  it("id ending in a digit strips trailing digits before numbering (section2 → section3)", () => {
    const v = runRule(rule, `<div id="section2"></div><div id="section2"></div>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    // Must propose section3, not section22.
    expect(v[0]?.suggestion).toContain(`id="section3"`);
    expect(v[0]?.suggestion).not.toContain(`id="section22"`);
  });

  it("id ending in multi-digit suffix increments correctly (item42 → item43)", () => {
    const v = runRule(rule, `<li id="item42"></li><li id="item42"></li>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.suggestion).toContain(`id="item43"`);
  });

  it("message cites both the first and duplicate element's tag and line", () => {
    const v = runRule(rule, `<main id="x"></main>\n<article id="x"></article>`, {
      filePath: "index.html",
    });
    expect(v).toHaveLength(1);
    const message = v[0]?.message ?? "";
    expect(message).toContain("<main>");
    expect(message).toContain("line 1");
    expect(message).toContain("<article>");
    expect(message).toContain("line 2");
  });

  it("cites wcag21:4.1.1 (live in 2.1) but not wcag22:4.1.1 (obsolete)", () => {
    expect(rule.satisfies).toContain("wcag21:4.1.1");
    expect(rule.satisfies).not.toContain("wcag22:4.1.1");
  });

  it("maps to WCAG 2.2 via 4.1.2 Name, Role, Value", () => {
    expect(rule.satisfies).toContain("wcag22:4.1.2");
    expect(rule.satisfies).toContain("wcag21:4.1.2");
  });
});
