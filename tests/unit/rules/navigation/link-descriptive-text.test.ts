import { describe, expect, it } from "bun:test";
import { rule } from "../../../../src/rules/navigation/link-descriptive-text.ts";
import { runRule } from "../../../helpers/run-rule.ts";

describe("rule navigation/link-descriptive-text", () => {
  describe("HTML: fires on generic phrases", () => {
    it("'click here'", () => {
      const v = runRule(rule, `<a href="/docs">click here</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
      expect(v[0]?.severity).toBe("warning");
    });

    it("'here'", () => {
      const v = runRule(rule, `<p>See <a href="/settings">here</a> for more.</p>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("'read more'", () => {
      const v = runRule(rule, `<a href="/x">Read more</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("'link'", () => {
      const v = runRule(rule, `<a href="/x">link</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("'click here →' (trailing punctuation stripped)", () => {
      const v = runRule(rule, `<a href="/x">Click here →</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: does NOT fire when", () => {
    it("the link text is descriptive", () => {
      const v = runRule(rule, `<a href="/docs/api">Read the API reference</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("aria-label overrides the generic visible text", () => {
      const v = runRule(rule, `<a href="/api" aria-label="API reference">click here</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("the element has no href (not a real link)", () => {
      const v = runRule(rule, `<a>click here</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("text is similar but not in the list (e.g., 'here we go')", () => {
      const v = runRule(rule, `<a href="/x">here we go</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: covers <a>, <Link>, <NavLink>", () => {
    it("fires on <a href='/x'>click here</a>", () => {
      const v = runRule(rule, `const X = <a href="/x">click here</a>;`);
      expect(v).toHaveLength(1);
    });

    it("fires on <Link to='/x'>read more</Link>", () => {
      const v = runRule(rule, `const X = <Link to="/x">read more</Link>;`);
      expect(v).toHaveLength(1);
    });

    it("fires on <NavLink to='/x'>here</NavLink>", () => {
      const v = runRule(rule, `const X = <NavLink to="/x">here</NavLink>;`);
      expect(v).toHaveLength(1);
    });

    it("does not fire when aria-label is set", () => {
      const v = runRule(rule, `const X = <Link to="/x" aria-label="Open settings">here</Link>;`);
      expect(v).toHaveLength(0);
    });

    it("does not fire on descriptive JSX link text", () => {
      const v = runRule(rule, `const X = <a href="/x">Open the settings panel</a>;`);
      expect(v).toHaveLength(0);
    });
  });

  describe("suggestion quality", () => {
    it("derives a destination hint from the href", () => {
      const v = runRule(rule, `<a href="/docs/api-reference">click here</a>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain("api reference");
    });

    it("handles query strings and hashes in the href", () => {
      const v = runRule(rule, `<a href="/docs/api?foo=bar#section">click here</a>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain("api");
    });
  });

  it("cites wcag22:2.4.4 and wcag21:2.4.4", () => {
    expect(rule.satisfies).toContain("wcag22:2.4.4");
    expect(rule.satisfies).toContain("wcag21:2.4.4");
  });

  it("also cites wcag22:4.1.2 and wcag21:4.1.2 for icon-only link detection", () => {
    expect(rule.satisfies).toContain("wcag22:4.1.2");
    expect(rule.satisfies).toContain("wcag21:4.1.2");
  });

  describe("HTML icon-only links (no accessible name)", () => {
    it("fires on <a><i class='fa fa-twitter'></i></a>", () => {
      const v = runRule(rule, `<a href="/twitter"><i class="fa fa-twitter"></i></a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no accessible name");
      expect(v[0]?.message).toContain("Font Awesome");
    });

    it("fires on <a><span class='material-icons'>home</span></a>", () => {
      // Material Icons uses ligature text inside the span — that text
      // is still rendered as a glyph, not announced as "home"; strip it.
      const v = runRule(rule, `<a href="/home"><span class="material-icons">home</span></a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("Material Icons");
    });

    it("fires on <a><i class='bi bi-search'></i></a>", () => {
      const v = runRule(rule, `<a href="/search"><i class="bi bi-search"></i></a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("Bootstrap Icons");
    });

    it("fires when only child has aria-hidden='true' and no other content", () => {
      const v = runRule(rule, `<a href="/x"><svg aria-hidden="true"><path d="M0 0"/></svg></a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("no accessible name");
    });

    it("fires on <a><img alt=''></a> (decorative image only)", () => {
      const v = runRule(rule, `<a href="/profile"><img src="/avatar.png" alt=""></a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain('<img alt="">');
    });

    it("suggestion echoes destination hint from href", () => {
      const v = runRule(rule, `<a href="/settings/profile"><i class="fa fa-user"></i></a>`, {
        filePath: "index.html",
      });
      expect(v[0]?.suggestion).toContain("profile");
    });
  });

  describe("HTML icon-only does NOT fire when", () => {
    it("icon sits alongside descriptive text", () => {
      const v = runRule(
        rule,
        `<a href="/twitter"><i class="fa fa-twitter" aria-hidden="true"></i> Twitter</a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("the anchor carries aria-label", () => {
      const v = runRule(
        rule,
        `<a href="/twitter" aria-label="Twitter profile"><i class="fa fa-twitter"></i></a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("the anchor carries aria-labelledby", () => {
      const v = runRule(
        rule,
        `<h2 id="twitter-heading">Twitter</h2><a href="/twitter" aria-labelledby="twitter-heading"><i class="fa fa-twitter"></i></a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("the anchor has a title attribute", () => {
      const v = runRule(
        rule,
        `<a href="/twitter" title="Twitter"><i class="fa fa-twitter"></i></a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("the child <img> has real alt text", () => {
      const v = runRule(rule, `<a href="/profile"><img src="/avatar.png" alt="View profile"></a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX icon-only links", () => {
    it("fires on <a><i className='fa fa-twitter' /></a>", () => {
      const v = runRule(rule, `const X = <a href="/twitter"><i className="fa fa-twitter" /></a>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("Font Awesome");
    });

    it("does not fire when an expression child is present", () => {
      // Runtime label — scanner can't see it; avoid false positive.
      const v = runRule(
        rule,
        `const X = <a href="/twitter"><i className="fa fa-twitter" />{label}</a>;`,
      );
      expect(v).toHaveLength(0);
    });

    it("does not fire on <Link to='/x'><i aria-hidden='true' /> Follow</Link>", () => {
      const v = runRule(
        rule,
        `const X = <Link to="/follow"><i className="fa fa-bell" aria-hidden="true" /> Follow</Link>;`,
      );
      expect(v).toHaveLength(0);
    });
  });

  describe("nativeWrapperElements mapping (Q2-WRAPMAP-RULES)", () => {
    it("opts in to the native `a` tag so mapped wrappers fire", () => {
      expect(rule.wrapperTreatsAsElement).toBe("a");
    });

    it("fires on a wrapper declared to render `<a>` via the mapping", () => {
      const v = runRule(rule, `const X = <MyRouterLink to="/x">click here</MyRouterLink>;`, {
        nativeWrapperElements: { MyRouterLink: "a" },
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("click here");
    });

    it("does not fire on a wrapper whose mapping targets a different tag", () => {
      const v = runRule(rule, `const X = <Chip to="/x">click here</Chip>;`, {
        nativeWrapperElements: { Chip: "button" },
      });
      expect(v).toHaveLength(0);
    });

    it("does not fire on a wrapper absent from the mapping", () => {
      const v = runRule(rule, `const X = <UnknownWidget to="/x">click here</UnknownWidget>;`);
      expect(v).toHaveLength(0);
    });
  });
});
