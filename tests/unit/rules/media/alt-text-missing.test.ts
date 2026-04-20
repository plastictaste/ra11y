import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/media/alt-text-missing.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule media/alt-text-missing", () => {
  describe("HTML: fires a violation when", () => {
    it("img has no alt, aria-label, or aria-labelledby", () => {
      const violations = runRule(rule, `<p><img src="chart.png"></p>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-missing");
      expect(violations[0]?.severity).toBe("error");
      expect(violations[0]?.criteria).toContain("wcag22:1.1.1");
    });

    it("img has an empty aria-label (whitespace-only)", () => {
      const violations = runRule(rule, `<img src="x.png" aria-label="   ">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("<input type='image'> is missing alt", () => {
      const violations = runRule(rule, `<input type="image" src="submit.png">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("HTML: does not fire when", () => {
    it("img has a meaningful alt", () => {
      const violations = runRule(rule, `<img src="chart.png" alt="Q4 growth 12%">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("img is explicitly decorative via alt=''", () => {
      const violations = runRule(rule, `<img src="flourish.png" alt="">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("img is decorative via role='presentation'", () => {
      const violations = runRule(rule, `<img src="x.png" role="presentation">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("img has aria-label", () => {
      const violations = runRule(rule, `<img src="x.png" aria-label="logo">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("img is aria-hidden", () => {
      const violations = runRule(rule, `<img src="x.png" aria-hidden="true">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: fires a violation when", () => {
    it("img has no alt prop", () => {
      const violations = runRule(rule, `const X = <img src="chart.png" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-missing");
    });

    it("multiple offending imgs produce multiple violations", () => {
      const src = `const X = <div><img src="a.png" /><img src="b.png" /></div>;`;
      const violations = runRule(rule, src);
      expect(violations).toHaveLength(2);
    });

    it("img inside a component still fires", () => {
      const src = `const X = <Card><img src="thumb.png" /></Card>;`;
      const violations = runRule(rule, src);
      expect(violations).toHaveLength(1);
    });

    it("<input type='image'> without alt fires", () => {
      const violations = runRule(rule, `const X = <input type="image" src="submit.png" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-missing");
    });
  });

  describe("JSX: does not fire when", () => {
    it("img has a string alt", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt="Logo" />;`);
      expect(violations).toHaveLength(0);
    });

    it("img has an expression alt (runtime-computed)", () => {
      // Static analysis assumes the developer is computing a name at
      // runtime. False-negative but low-signal to flag.
      const violations = runRule(rule, `const X = <img src="x.png" alt={label} />;`);
      expect(violations).toHaveLength(0);
    });

    it("img has alt='' (explicitly decorative)", () => {
      const violations = runRule(rule, `const X = <img src="x.png" alt="" />;`);
      expect(violations).toHaveLength(0);
    });

    it("<input type='image'> with alt does not fire", () => {
      const violations = runRule(rule, `const X = <input type="image" alt="Submit" />;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("ignores non-img elements", () => {
      const violations = runRule(rule, `<div><p>no images here</p></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("suggests a file-name-derived subject in the suggestion", () => {
      const violations = runRule(rule, `<img src="/assets/revenue-chart-2026.png">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("revenue chart 2026");
    });

    it("suggestion is context-aware (mentions filename)", () => {
      const violations = runRule(rule, `<img src="logo.png">`, { filePath: "index.html" });
      expect(violations[0]?.message).toContain("logo.png");
    });
  });

  describe("rule metadata", () => {
    it("declares both wcag22:1.1.1 and wcag21:1.1.1", () => {
      expect(rule.satisfies).toContain("wcag22:1.1.1");
      expect(rule.satisfies).toContain("wcag21:1.1.1");
    });

    it("has a normativeQuote citing WCAG", () => {
      expect(rule.docs.normativeQuote).toBeDefined();
      expect(rule.docs.references[0]).toContain("WCAG22");
    });
  });

  describe("nativeWrapperElements mapping (Q2-WRAPMAP-RULES)", () => {
    it("opts in to the native `img` tag so mapped wrappers fire", () => {
      expect(rule.wrapperTreatsAsElement).toBe("img");
    });

    it("fires on a wrapper declared to render `<img>` via the mapping", () => {
      const violations = runRule(rule, `const X = <Avatar src="u.png" />;`, {
        nativeWrapperElements: { Avatar: "img" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-missing");
    });

    it("silences when the mapped wrapper call site supplies alt", () => {
      const violations = runRule(rule, `const X = <Avatar src="u.png" alt="User avatar" />;`, {
        nativeWrapperElements: { Avatar: "img" },
      });
      expect(violations).toHaveLength(0);
    });

    it("does not fire on a wrapper mapped to a non-image tag", () => {
      const violations = runRule(rule, `const X = <Card src="u.png" />;`, {
        nativeWrapperElements: { Card: "div" },
      });
      expect(violations).toHaveLength(0);
    });

    it("does not fire on an unmapped PascalCase component", () => {
      const violations = runRule(rule, `const X = <UnknownWrapper src="u.png" />;`);
      expect(violations).toHaveLength(0);
    });

    it("fires on a dotted compound wrapper name (Q2R2-COMPOUND) mapped to img", () => {
      // Flattened form of `{ Media: { Avatar: "img" } }` from the config
      // loader — the dotted key drives findJsxElementsByTag via
      // ctx.wrappersForElement, matching the <Media.Avatar> tag name.
      const violations = runRule(rule, `const X = <Media.Avatar src="u.png" />;`, {
        nativeWrapperElements: { "Media.Avatar": "img" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-missing");
    });

    it("silences the compound wrapper call site when alt is supplied", () => {
      const violations = runRule(
        rule,
        `const X = <Media.Avatar src="u.png" alt="User avatar" />;`,
        { nativeWrapperElements: { "Media.Avatar": "img" } },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("SVG <image> (HTML): fires when", () => {
    it("has no title child, aria-label, or aria-labelledby", () => {
      const violations = runRule(
        rule,
        `<svg width="40" height="40"><image href="icon.svg"/></svg>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-missing");
      expect(violations[0]?.message).toContain("SVG <image>");
    });

    it("the <title> child is empty (whitespace only)", () => {
      const violations = runRule(
        rule,
        `<svg><image href="icon.svg"><title>   </title></image></svg>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("SVG <image>");
    });
  });

  describe("SVG <image> (HTML): does not fire when", () => {
    it("has a <title> child with text", () => {
      const violations = runRule(
        rule,
        `<svg><image href="icon.svg"><title>Company logo</title></image></svg>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("has aria-label", () => {
      const violations = runRule(
        rule,
        `<svg><image href="icon.svg" aria-label="Company logo"/></svg>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("has aria-hidden='true' (decorative)", () => {
      const violations = runRule(
        rule,
        `<svg><image href="flourish.svg" aria-hidden="true"/></svg>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("SVG <image> (JSX): fires when", () => {
    it("<image> has no accessible name", () => {
      const violations = runRule(rule, `const X = <svg><image href="icon.svg"/></svg>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("SVG <image>");
    });

    it("suggests an SVG-appropriate fix (mentions <title>)", () => {
      const violations = runRule(rule, `const X = <svg><image href="company-logo.svg"/></svg>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("<title>");
    });
  });

  describe("SVG <image> (JSX): does not fire when", () => {
    it("<image> has a <title> child with text", () => {
      const violations = runRule(
        rule,
        `const X = <svg><image href="icon.svg"><title>Logo</title></image></svg>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("<image> has aria-labelledby", () => {
      const violations = runRule(
        rule,
        `const X = <svg><image href="icon.svg" aria-labelledby="caption"/></svg>;`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("role='img' (HTML): fires when", () => {
    it("<div role='img'> has no accessible name", () => {
      const violations = runRule(rule, `<div role="img"></div>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`role="img"`);
    });

    it("<span role='img'> with only text content but no aria-label still fires", () => {
      // Visible text children are not a reliable accessible-name
      // source for role="img" — WAI-ARIA requires aria-label /
      // aria-labelledby. Surface honestly; the agent can decide.
      const violations = runRule(rule, `<span role="img">🎉</span>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
    });
  });

  describe("role='img' (HTML): does not fire when", () => {
    it("has aria-label", () => {
      const violations = runRule(rule, `<div role="img" aria-label="Party popper emoji"></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("has aria-labelledby", () => {
      const violations = runRule(rule, `<div role="img" aria-labelledby="caption"></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("<svg role='img'> has a <title> child with text", () => {
      const violations = runRule(rule, `<svg role="img"><title>Revenue chart</title></svg>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("is aria-hidden", () => {
      const violations = runRule(rule, `<div role="img" aria-hidden="true"></div>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("role='img' (JSX): fires when", () => {
    it("<div role='img'> has no accessible name", () => {
      const violations = runRule(rule, `const X = <div role="img" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`role="img"`);
    });

    it("suggestion text names aria-label as the fix", () => {
      const violations = runRule(rule, `const X = <span role="img">🎉</span>;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("aria-label");
    });
  });

  describe("role='img' (JSX): does not fire when", () => {
    it("has aria-label", () => {
      const violations = runRule(
        rule,
        `const X = <div role="img" aria-label="Party popper">🎉</div>;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("<svg role='img'> has <title> child with text", () => {
      const violations = runRule(rule, `const X = <svg role="img"><title>Chart</title></svg>;`);
      expect(violations).toHaveLength(0);
    });
  });

  describe("<canvas> (HTML): fires when", () => {
    it("canvas has no fallback and no aria-label", () => {
      const violations = runRule(rule, `<canvas width="400" height="300"></canvas>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<canvas>");
    });

    it("canvas fallback is whitespace only", () => {
      const violations = runRule(rule, `<canvas>   </canvas>`, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
    });
  });

  describe("<canvas> (HTML): does not fire when", () => {
    it("has fallback text content", () => {
      const violations = runRule(rule, `<canvas>Live bar chart of revenue per month.</canvas>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("has a child element as fallback", () => {
      const violations = runRule(rule, `<canvas><p>Fallback</p></canvas>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("has aria-label", () => {
      const violations = runRule(rule, `<canvas aria-label="Revenue chart"></canvas>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("is aria-hidden", () => {
      const violations = runRule(rule, `<canvas aria-hidden="true"></canvas>`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("<canvas> (JSX): fires when", () => {
    it("canvas has no fallback and no aria-label", () => {
      const violations = runRule(rule, `const X = <canvas width={400} height={300} />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("<canvas>");
    });

    it("suggestion text names canvas fallback content", () => {
      const violations = runRule(rule, `const X = <canvas />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("fallback");
    });
  });

  describe("<canvas> (JSX): does not fire when", () => {
    it("has an expression child (runtime-computed fallback)", () => {
      const violations = runRule(rule, `const X = <canvas>{fallbackText}</canvas>;`);
      expect(violations).toHaveLength(0);
    });

    it("has aria-label", () => {
      const violations = runRule(rule, `const X = <canvas aria-label="Revenue chart" />;`);
      expect(violations).toHaveLength(0);
    });

    it("has a child element as fallback", () => {
      const violations = runRule(
        rule,
        `const X = <canvas><p>Bar chart of revenue per month.</p></canvas>;`,
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe("polymorphic as/asChild resolution (Q2R2-POLYMORPHIC)", () => {
    it('fires on <Box as="img" src=... /> with no alt', () => {
      const violations = runRule(rule, `const X = <Box as="img" src="u.png" />;`);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.ruleId).toBe("media/alt-text-missing");
    });

    it('does not fire when polymorphic `as="img"` call site supplies alt', () => {
      const violations = runRule(rule, `const X = <Box as="img" src="u.png" alt="User" />;`);
      expect(violations).toHaveLength(0);
    });

    it("fires on <Slot asChild><img src=... /></Slot> — polymorphic resolution plus inner <img>", () => {
      // Two surfaces: the inner <img> fires directly via the native-tag
      // channel, and the polymorphic <Slot asChild> call-site fires via
      // asChild resolution. Both are honest surface points for the agent
      // — AI-first doctrine prefers surfacing both over heuristic dedup.
      const violations = runRule(rule, `const X = <Slot asChild><img src="u.png" /></Slot>;`);
      expect(violations).toHaveLength(2);
      expect(violations[0]?.ruleId).toBe("media/alt-text-missing");
      expect(violations[1]?.ruleId).toBe("media/alt-text-missing");
    });

    it("does not re-dispatch when `as` is a non-literal expression (honest — agent reads)", () => {
      // `as={tagName}` is dynamic; polymorphic resolution stays off, so
      // the call site isn't treated as an <img> by this rule. The agent
      // reading the surrounding code is the correct arbiter.
      const violations = runRule(rule, `const X = <Box as={tagName} src="u.png" />;`);
      expect(violations).toHaveLength(0);
    });

    it('does not re-dispatch when `as="div"` resolves to a non-target tag', () => {
      const violations = runRule(rule, `const X = <Box as="div" src="u.png" />;`);
      expect(violations).toHaveLength(0);
    });

    it("does not re-dispatch when `as` is absent", () => {
      const violations = runRule(rule, `const X = <Box src="u.png" />;`);
      expect(violations).toHaveLength(0);
    });
  });
});
