import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/semantics/empty-heading.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule semantics/empty-heading", () => {
  describe("HTML: fires when", () => {
    it("heading is completely empty", () => {
      const v = runRule(rule, `<h1></h1>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).toContain("<h1>");
    });

    it("heading contains only whitespace", () => {
      const v = runRule(rule, `<h2>   </h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("<h2>");
    });

    it("heading contains only a non-text child without alt (svg)", () => {
      const v = runRule(rule, `<h3><svg aria-hidden="true"></svg></h3>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("heading contains img without alt", () => {
      const v = runRule(rule, `<h2><img src="icon.png"></h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("heading contains img with empty alt", () => {
      const v = runRule(rule, `<h2><img src="icon.png" alt=""></h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("heading has text content", () => {
      const v = runRule(rule, `<h1>Welcome</h1>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("heading has aria-label", () => {
      const v = runRule(rule, `<h2 aria-label="Section title"></h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("heading has aria-labelledby", () => {
      const v = runRule(rule, `<h2 aria-labelledby="ref"></h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("heading contains img with alt text", () => {
      const v = runRule(rule, `<h2><img src="logo.png" alt="Company Logo"></h2>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("heading has deeply nested text", () => {
      const v = runRule(rule, `<h3><span><strong>Title</strong></span></h3>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: fires when", () => {
    it("heading is self-closing", () => {
      const v = runRule(rule, `const X = <h1 />;`);
      expect(v).toHaveLength(1);
    });

    it("heading is empty", () => {
      const v = runRule(rule, `const X = <h2></h2>;`);
      expect(v).toHaveLength(1);
    });

    it("heading contains only whitespace text", () => {
      const v = runRule(rule, `const X = <h3>   </h3>;`);
      expect(v).toHaveLength(1);
    });
  });

  describe("JSX: does NOT fire when", () => {
    it("heading has text content", () => {
      const v = runRule(rule, `const X = <h1>Welcome</h1>;`);
      expect(v).toHaveLength(0);
    });

    it("heading has aria-label", () => {
      const v = runRule(rule, `const X = <h2 aria-label="Section" />;`);
      expect(v).toHaveLength(0);
    });

    it("heading has expression child (runtime content)", () => {
      const v = runRule(rule, `const X = <h1>{title}</h1>;`);
      expect(v).toHaveLength(0);
    });

    it("heading wraps a PascalCase component (assumed accessible)", () => {
      const v = runRule(rule, `const X = <h2><Icon /></h2>;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: primitive component definition (info, not error)", () => {
    it("empty <h1> with spread props emits info, not error", () => {
      const v = runRule(rule, `const H1 = (props) => <h1 {...props} />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("info");
      expect(v[0]?.message).toContain("spread");
    });

    it("empty <h2> without spread stays an error", () => {
      const v = runRule(rule, `const X = <h2 />;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
    });

    it("<h3> with spread and children emits nothing (children resolve it)", () => {
      const v = runRule(rule, `const X = <h3 {...props}>{children}</h3>;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("flags multiple empty headings independently", () => {
      const v = runRule(rule, `<h1></h1><h2></h2><h3></h3>`, { filePath: "index.html" });
      expect(v).toHaveLength(3);
    });

    it("does not flag non-heading elements", () => {
      const v = runRule(rule, `<p></p><div></div>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("suggestion mentions replacing with styled element for visual-only headings", () => {
      const v = runRule(rule, `<h4></h4>`, { filePath: "index.html" });
      expect(v[0]?.suggestion).toContain("styled");
    });
  });

  // Conceded-uncertainty branch: when the heading's subtree visible-
  // text contribution came exclusively from stripped Liquid/Jinja/ERB
  // template directives — directly (`<h1>{{ page.title }}</h1>`) or
  // through a wrapping element (`<h2><a>{{ post.title }}</a></h2>`,
  // the canonical Jekyll post-list shape) — the static scanner has no
  // runtime evidence the heading is empty. Per AI-first consumer
  // doctrine ("Reason text and severity must agree" + "Heuristic
  // emission is the symmetric twin of heuristic suppression"), the
  // rule surfaces (don't suppress) but at `warning` (not `error`)
  // with a structured `couldBeWrongBecause` code and reason text
  // framing the rendered-output question.
  describe("HTML: template-directive-only content surfaces at conceded uncertainty", () => {
    it("surfaces at warning when sole child is a Liquid interpolation", () => {
      const v = runRule(rule, `<h1>{{ page.title }}</h1>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("interpolated");
      expect(v[0]?.couldBeWrongBecause).toEqual(["template_directive_interpolation_unresolved"]);
    });

    it("surfaces at warning when sole child is a Liquid tag", () => {
      const v = runRule(rule, `<h2>{% include title.html %}</h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("interpolated");
      expect(v[0]?.couldBeWrongBecause).toEqual(["template_directive_interpolation_unresolved"]);
    });

    it("surfaces at warning when sole child is an ERB expression", () => {
      const v = runRule(rule, `<h2><%= @post.title %></h2>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("interpolated");
      expect(v[0]?.couldBeWrongBecause).toEqual(["template_directive_interpolation_unresolved"]);
    });

    // Canonical wrapper case — Jekyll post-list shape. The heading
    // wraps a link whose body is a stripped Liquid expression; both
    // empty-heading and link-descriptive-text fire on this shape, and
    // empty-heading must use the conceded-uncertainty framing rather
    // than asserting "is empty" at error severity.
    it("surfaces at warning when content is wrapped in an inner element", () => {
      const v = runRule(
        rule,
        `<h2 itemprop="headline"><a href="{{ post.url }}">{{- post.title -}}</a></h2>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("interpolated");
      expect(v[0]?.couldBeWrongBecause).toEqual(["template_directive_interpolation_unresolved"]);
    });

    it("still fires at error on a plainly empty heading (no template directive)", () => {
      const v = runRule(rule, `<h1></h1>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.message).not.toContain("interpolated");
    });

    it("does not fire on mixed content where literal text sits alongside the directive", () => {
      // `htmlTextContent` strips the directive but the literal " static
      // text" remains, so `hasAccessibleContentHtml` already passes
      // before the predicate runs — no violation expected here.
      const v = runRule(rule, `<h4>{{ x }} static text</h4>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("surfaces at warning on a heading whose only child is an empty <svg> alongside a stripped directive", () => {
      // The svg is presentational (aria-hidden) so its absence-of-text
      // adds no evidence; the only visible-text contribution candidate
      // is the stripped directive. Per the conceded-uncertainty branch
      // the rule surfaces at warning rather than asserting "empty" at
      // error.
      const v = runRule(rule, `<h2><svg aria-hidden="true"></svg>{{ x }}</h2>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toEqual(["template_directive_interpolation_unresolved"]);
    });

    // Invariant: any finding whose reason concedes the rendered content
    // came from a stripped template directive must surface at `warning`
    // (the conceded-uncertainty severity) — not `error`. The previous
    // implementation layered a "the only rendered content was a
    // template expression … verify the expression resolves to non-empty
    // text at render time" suffix onto an `error` finding when a
    // descendant text node carried a stripped directive but the
    // narrower predicate didn't fire; that combination violates the
    // AI-first doctrine "Reason text and severity must agree." This
    // sweep across every template-directive shape the rule recognizes
    // pins the invariant so a future change to `hasAccessibleContentHtml`
    // (or the predicate above) cannot silently re-introduce the shape.
    it("never produces an error-severity finding with the conceded stripped-directive reason text", () => {
      const samples = [
        `<h1>{{ page.title }}</h1>`,
        `<h2>{% include title.html %}</h2>`,
        `<h3><%= @post.title %></h3>`,
        `<h4><a href="{{ post.url }}">{{- post.title -}}</a></h4>`,
        `<h2><svg aria-hidden="true"></svg>{{ x }}</h2>`,
        `<h2><img src="icon.png">{{ x }}</h2>`,
      ];
      for (const source of samples) {
        const v = runRule(rule, source, { filePath: "index.html" });
        for (const finding of v) {
          const concedes =
            finding.message.includes("template expression") ||
            finding.message.includes("interpolated") ||
            finding.message.includes("template directive") ||
            finding.message.includes("render time");
          if (concedes) {
            expect(finding.severity).toBe("warning");
          }
        }
      }
    });
  });

  // Conceded-uncertainty branch: when the file's sibling JS performs
  // a DOM-text mutation (`.innerHTML = …`, `.textContent = …`,
  // `.insertAdjacentHTML(…)`, etc.) AND references the empty heading
  // by id/class, the heading is most likely a skeleton-loader / SPA
  // placeholder filled at runtime. Per AI-first consumer doctrine
  // ("Reason text and severity must agree" + "Heuristic emission is
  // the symmetric twin of heuristic suppression"), the rule surfaces
  // (don't suppress) but at `warning` (not `error`) with a structured
  // `couldBeWrongBecause: ["runtime_innerhtml_population"]` code so
  // the agent reads the cited file and decides whether the runtime-
  // fill path always assigns non-empty text.
  describe("HTML: sibling-JS runtime-population content surfaces at conceded uncertainty", () => {
    it("surfaces at warning when sibling JS uses getElementById + .innerHTML on the heading id", () => {
      const source = `<h3 id="header"></h3>
<script>
  setTimeout(() => {
    document.getElementById("header").innerHTML = "Loaded title";
  }, 1000);
</script>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("skeleton-loader");
      expect(v[0]?.message).toContain('id="header"');
      expect(v[0]?.couldBeWrongBecause).toEqual(["runtime_innerhtml_population"]);
    });

    it("surfaces at warning when sibling JS uses querySelector + .textContent on the heading class", () => {
      const source = `<h2 class="skeleton-title"></h2>
<script>
  fetch("/api/title").then(r => r.text()).then(t => {
    document.querySelector(".skeleton-title").textContent = t;
  });
</script>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.message).toContain("skeleton-loader");
      expect(v[0]?.couldBeWrongBecause).toEqual(["runtime_innerhtml_population"]);
    });

    it("surfaces at warning when sibling JS uses bare-id global access (header.innerHTML)", () => {
      // Legacy HTML pattern: any element with an `id` is exposed as
      // a global var on `window`, so `header.innerHTML = …` is valid
      // sibling-JS evidence even without an explicit getElementById.
      const source = `<h1 id="header"></h1>
<script>
  setTimeout(() => { header.innerHTML = "Welcome"; }, 500);
</script>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toEqual(["runtime_innerhtml_population"]);
    });

    it("surfaces at warning when sibling JS uses insertAdjacentHTML on the heading", () => {
      const source = `<h2 id="status"></h2>
<script>
  document.getElementById("status").insertAdjacentHTML("beforeend", "<span>OK</span>");
</script>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toEqual(["runtime_innerhtml_population"]);
    });

    it("still fires at error when no sibling JS mutation pattern is present", () => {
      // The element has an `id` but the file has no DOM-text mutation
      // anywhere — the document-level gate fails, so the per-heading
      // check is never reached and the plainly-empty error path runs.
      const source = `<h1 id="header"></h1>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("still fires at error when sibling JS mutates a different element", () => {
      // Mutation pattern present, but the heading's id ("header") is
      // never referenced by the sibling JS (which targets "footer").
      // Per-heading gate fails — the runtime-population branch must not
      // fire on heading evidence that doesn't exist in this file.
      const source = `<h1 id="header"></h1>
<script>
  document.getElementById("footer").innerHTML = "bye";
</script>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("still fires at error when the heading has no id/class to reference", () => {
      // Mutation site present, but the heading carries neither an id
      // nor a class — sibling JS cannot reach this specific element,
      // so the runtime-population gate fails and the plainly-empty
      // path emits at error.
      const source = `<h1></h1>
<script>
  document.getElementById("other").innerHTML = "x";
</script>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("error");
      expect(v[0]?.couldBeWrongBecause).toBeUndefined();
    });

    it("template-directive branch wins when both conditions match (template directive checked first)", () => {
      // A heading whose only content is a Liquid expression AND whose
      // id is referenced by sibling JS innerHTML — both conceded-
      // uncertainty branches apply. The template-directive branch is
      // checked first (it's the lower-cost, narrower predicate); the
      // emit must be the template-directive shape, not the runtime-
      // population shape, so the agent gets the most specific axis.
      const source = `<h1 id="title">{{ page.title }}</h1>
<script>
  document.getElementById("title").innerHTML = "fallback";
</script>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toEqual(["template_directive_interpolation_unresolved"]);
    });

    it("does not fire when the heading is non-empty even with a runtime-mutation site present", () => {
      // The mutation site exists in the file, but the heading already
      // has visible text content — `hasAccessibleContentHtml` passes
      // and the rule never reaches either conceded-uncertainty branch.
      const source = `<h1 id="header">Hello</h1>
<script>
  document.getElementById("header").innerHTML = "Updated";
</script>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("matches when the heading's class is one of several class tokens", () => {
      const source = `<h2 class="placeholder skeleton-title hidden"></h2>
<script>
  document.querySelector(".skeleton-title").textContent = "Title";
</script>`;
      const v = runRule(rule, source, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
      expect(v[0]?.couldBeWrongBecause).toEqual(["runtime_innerhtml_population"]);
    });
  });

  describe("context-aware fix: preceding heading", () => {
    it("empty h3 after h2 inlines the h2's text and level", () => {
      const source = `<h2>Contact Information</h2>\n<h3></h3>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      const empty = violations.find((v) => v.location.line === 2);
      expect(empty?.suggestion).toContain("<h3>");
      expect(empty?.suggestion).toContain("<h2>Contact Information</h2>");
      expect(empty?.suggestion).toContain("line 1");
      expect(empty?.suggestion).toContain("Contact Information");
    });

    it("empty h2 after a sibling h2 mentions the sibling branch", () => {
      const source = `<h2>Overview</h2>\n<p>intro copy</p>\n<h2></h2>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      const empty = violations[0];
      expect(empty?.location.line).toBe(3);
      expect(empty?.suggestion).toContain("sibling");
      expect(empty?.suggestion).toContain("<h2>Overview</h2>");
    });

    it("empty h2 after an h4 flags the hierarchy break", () => {
      const source = `<h4>Details</h4>\n<h2></h2>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      const empty = violations.find((v) => v.location.line === 2);
      expect(empty?.suggestion).toContain("hierarchy");
      expect(empty?.suggestion).toContain("<h4>Details</h4>");
      expect(empty?.suggestion).toContain("semantics/heading-hierarchy");
    });

    it("empty heading at start of document uses the fallback branch", () => {
      const source = `<h1></h1>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations[0]?.suggestion).toContain("start of document");
      expect(violations[0]?.suggestion).toContain("navigation gap");
    });

    it("truncates very long preceding heading text in the fix", () => {
      const long = "A".repeat(120);
      const source = `<h2>${long}</h2>\n<h3></h3>`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      const empty = violations.find((v) => v.location.line === 2);
      // Inlined text should be truncated with an ellipsis, not pasted raw.
      expect(empty?.suggestion).not.toContain(long);
      expect(empty?.suggestion).toMatch(/…/);
    });

    it("JSX empty h3 after h2 inlines the preceding heading", () => {
      const source = `const Page = () => (<div><h2>Pricing</h2><h3></h3></div>);`;
      const violations = runRule(rule, source);
      const empty = violations[0];
      expect(empty?.suggestion).toContain("<h2>Pricing</h2>");
      expect(empty?.suggestion).toContain("<h3>");
    });
  });

  it("cites wcag22:2.4.6 and wcag21:2.4.6", () => {
    expect(rule.satisfies).toContain("wcag22:2.4.6");
    expect(rule.satisfies).toContain("wcag21:2.4.6");
  });
});
