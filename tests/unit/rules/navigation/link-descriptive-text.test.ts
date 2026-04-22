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

  it("also cites wcag22:2.4.9 and wcag21:2.4.9 for duplicate-href detection", () => {
    expect(rule.satisfies).toContain("wcag22:2.4.9");
    expect(rule.satisfies).toContain("wcag21:2.4.9");
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

  describe("HTML duplicate same-href detection", () => {
    it("fires on two <a>Buy Now</a> both pointing at href='#'", () => {
      const v = runRule(rule, `<section><a href="#">Buy Now</a><a href="#">Buy Now</a></section>`, {
        filePath: "index.html",
      });
      // Both anchors flagged.
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(2);
      expect(dupFindings[0]?.message).toContain("Buy Now");
      expect(dupFindings[0]?.message).toContain(`href="#"`);
    });

    it("fires on three duplicates with count=3 in the message", () => {
      const v = runRule(
        rule,
        `<a href="/x">Sign up</a><a href="/x">Sign up</a><a href="/x">Sign up</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(3);
      expect(dupFindings[0]?.message).toContain("3 links");
    });

    it("partitions correctly: two same-href dups + one distinct-href sharing the name", () => {
      // Two <a href="/a">Buy Now</a> should group (and both fire); the
      // third <a href="/b">Buy Now</a> has a different href and stays silent.
      const v = runRule(
        rule,
        `<a href="/a">Buy Now</a><a href="/b">Buy Now</a><a href="/a">Buy Now</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(2);
      // Both surviving findings should reference href="/a" in the text.
      for (const f of dupFindings) expect(f.message).toContain(`href="/a"`);
    });

    it("normalizes whitespace and case when grouping", () => {
      const v = runRule(rule, `<a href="/x">  Buy   Now  </a><a href="/x">buy now</a>`, {
        filePath: "index.html",
      });
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("treats <img alt> as accessible name when grouping (img-only anchor)", () => {
      // An anchor with only a non-decorative <img> picks up the alt as its name.
      const v = runRule(
        rule,
        `<a href="/p"><img src="/a.png" alt="Buy Now"></a><a href="/p">Buy Now</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("does NOT fire on same-name-different-href (left to agent judgment)", () => {
      const v = runRule(
        rule,
        `<a href="/post1">Read more</a><a href="/post2">Read more</a><a href="/post3">Read more</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(0);
      // The existing generic-phrase path still fires per-anchor (3 times).
      expect(v.filter((x) => x.message.includes('"read more"'))).toHaveLength(3);
    });

    it("does NOT fire when an anchor lacks the href attribute entirely", () => {
      // `<a>Buy Now</a>` (no href) + `<a href="">Buy Now</a>` → only the
      // href-bearing one is grouped; a single entry never fires.
      const v = runRule(rule, `<a>Buy Now</a><a href="">Buy Now</a>`, { filePath: "index.html" });
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("does NOT fire when aria-labelledby points at different targets", () => {
      // aria-labelledby defers to the agent — grouping is skipped when
      // present. Both anchors share href and visible text, but the
      // override keeps them out of the duplicate-href pass.
      const v = runRule(
        rule,
        `<h2 id="a">Alpha</h2><h2 id="b">Beta</h2>` +
          `<a href="/x" aria-labelledby="a">Go</a>` +
          `<a href="/x" aria-labelledby="b">Go</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("uses aria-label as the grouping name when present", () => {
      const v = runRule(
        rule,
        `<a href="/x" aria-label="Account menu">X</a><a href="/x" aria-label="account menu">Y</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(2);
      expect(dupFindings[0]?.message).toContain("Account menu");
    });

    it("co-fires with the generic-phrase path on the same anchor", () => {
      // Both paths fire — agent sees both concerns. The generic-phrase
      // violation describes the out-of-context failure; the duplicate-
      // href violation describes the within-context indistinguishability.
      const v = runRule(rule, `<a href="/x">Read more</a><a href="/x">Read more</a>`, {
        filePath: "index.html",
      });
      const genericFindings = v.filter((x) => x.message.includes('"read more"'));
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(genericFindings).toHaveLength(2);
      expect(dupFindings).toHaveLength(2);
    });

    it("suggestion offers three concrete differentiation paths", () => {
      const v = runRule(rule, `<a href="#">Buy Now</a><a href="#">Buy Now</a>`, {
        filePath: "index.html",
      });
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings[0]?.suggestion).toContain("aria-label");
      expect(dupFindings[0]?.suggestion).toContain("merging");
      expect(dupFindings[0]?.suggestion).toContain("context");
    });
  });

  describe("JSX duplicate same-href detection", () => {
    it("fires on two <a href='#'>Buy Now</a> duplicates", () => {
      const v = runRule(
        rule,
        `const X = <section><a href="#">Buy Now</a><a href="#">Buy Now</a></section>;`,
      );
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("fires on <Link to='/x'>Buy Now</Link> duplicates", () => {
      const v = runRule(
        rule,
        `const X = <><Link to="/x">Buy Now</Link><Link to="/x">Buy Now</Link></>;`,
      );
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("skips anchors whose name depends on an expression child", () => {
      // Runtime label — scanner can't see it; grouping skips these.
      const v = runRule(rule, `const X = <><a href="/x">{label}</a><a href="/x">{label}</a></>;`);
      const dupFindings = v.filter((x) => x.message.includes("same accessible name"));
      expect(dupFindings).toHaveLength(0);
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
