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

  describe("HTML: fires on generic-pronoun shapes (V1-RULE-LINK-DESCRIPTIVE-TEXT-MISSES-GENERIC-PRONOUNS)", () => {
    // Real-world repro: Bootstrap-tooltip pattern from a field report —
    // two adjacent `<a href="#" data-bs-toggle="tooltip">` inline links
    // labelled "This link" and "that link" stayed silent because the
    // GENERIC_PHRASES set covered "click here" / "read more" but not
    // the semantic generic-pronoun shape WCAG 2.4.4 calls out.
    it("'This link' (bare pronoun + noun, capitalized)", () => {
      const v = runRule(rule, `<a href="#" data-bs-toggle="tooltip">This link</a>`, {
        filePath: "modal.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("this link");
    });

    it("'that link' (lowercase pronoun + noun)", () => {
      const v = runRule(rule, `<a href="#" data-bs-toggle="tooltip">that link</a>`, {
        filePath: "modal.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("that link");
    });

    it("'the link'", () => {
      const v = runRule(rule, `<a href="/x">the link</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("'this page'", () => {
      const v = runRule(rule, `<a href="/x">This page</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("'that page'", () => {
      const v = runRule(rule, `<a href="/x">that page</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("'there' (bare adverb)", () => {
      const v = runRule(rule, `<a href="/x">there</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("'that' (bare pronoun)", () => {
      const v = runRule(rule, `<a href="/x">That</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("'the' (bare determiner)", () => {
      const v = runRule(rule, `<a href="/x">The</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("'info' (bare noun)", () => {
      const v = runRule(rule, `<a href="/x">Info</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });

    it("'more details'", () => {
      const v = runRule(rule, `<a href="/x">More details</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(1);
    });
  });

  describe("HTML: pronoun-shape does NOT over-fire on legitimate text", () => {
    // The phrase set is exact-match (after normalization) — surrounding
    // descriptive words break the match, leaving the agent to judge
    // contextualized cases via Read.
    it("'This link opens the dashboard' is descriptive enough", () => {
      const v = runRule(rule, `<a href="/dashboard">This link opens the dashboard</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("'that page about WCAG' is descriptive enough", () => {
      const v = runRule(rule, `<a href="/wcag">that page about WCAG</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("'Theme settings' is not a bare 'the'", () => {
      const v = runRule(rule, `<a href="/theme">Theme settings</a>`, { filePath: "index.html" });
      expect(v).toHaveLength(0);
    });

    it("'Information about pricing' is not a bare 'info'", () => {
      const v = runRule(rule, `<a href="/pricing">Information about pricing</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });
  });

  describe("JSX: generic-pronoun shapes also fire", () => {
    it("fires on <a href='#'>This link</a>", () => {
      const v = runRule(rule, `const X = <a href="#">This link</a>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("this link");
    });

    it("fires on <Link to='/x'>that page</Link>", () => {
      const v = runRule(rule, `const X = <Link to="/x">that page</Link>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("that page");
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

  it("also cites wcag22:2.4.9 and wcag21:2.4.9 for duplicate-name detection", () => {
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

  describe("HTML duplicate-name-different-href detection", () => {
    // V1-LINK-DESCRIPTIVE-TEXT-SAME-NAME-SAME-HREF: WCAG 2.4.4 only
    // forbids same accessible name pointing at *different* destinations.
    // Two links to the same destination are explicitly permitted by the
    // spec rationale (AT announces visited state on re-encounter).

    it("fires on three 'Read more' anchors pointing at different posts", () => {
      const v = runRule(
        rule,
        `<a href="/post1">Read more</a><a href="/post2">Read more</a><a href="/post3">Read more</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(3);
      expect(dupFindings[0]?.message).toContain("3 links");
      expect(dupFindings[0]?.message).toContain("Read more");
      expect(dupFindings[0]?.message).toContain("3 different destinations");
    });

    it("fires on two 'Buy Now' anchors with distinct hrefs", () => {
      const v = runRule(
        rule,
        `<a href="/checkout/basic">Buy Now</a><a href="/checkout/pro">Buy Now</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(2);
      expect(dupFindings[0]?.message).toContain(`"/checkout/basic"`);
      expect(dupFindings[0]?.message).toContain(`"/checkout/pro"`);
    });

    it("partitions correctly: same-name+same-href silent, same-name+different-href fires", () => {
      // Three anchors named "Buy Now": two point at /a (silent — same
      // destination is fine), one points at /b (joins the group of three
      // for the name "Buy Now"). The whole group fires because hrefs
      // differ across the group.
      const v = runRule(
        rule,
        `<a href="/a">Buy Now</a><a href="/b">Buy Now</a><a href="/a">Buy Now</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(3);
      // Surviving findings echo both /a and /b (sample of distinct hrefs).
      expect(dupFindings[0]?.message).toContain(`"/a"`);
      expect(dupFindings[0]?.message).toContain(`"/b"`);
    });

    it("normalizes whitespace and case when grouping (different hrefs)", () => {
      const v = runRule(rule, `<a href="/x">  Buy   Now  </a><a href="/y">buy now</a>`, {
        filePath: "index.html",
      });
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("treats <img alt> as accessible name when grouping (img-only anchor)", () => {
      // An anchor with only a non-decorative <img> picks up the alt as its name.
      const v = runRule(
        rule,
        `<a href="/p1"><img src="/a.png" alt="Buy Now"></a><a href="/p2">Buy Now</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("does NOT fire on same-name-same-href (spec rationale permits)", () => {
      // V1-LINK-DESCRIPTIVE-TEXT-SAME-NAME-SAME-HREF — the canonical
      // false positive. SSG docs trees commonly link the same anchor or
      // the same external URL multiple times under one repeated label;
      // this is fine — both pointers lead to the same destination, and
      // AT announces "visited" on re-encounter.
      const v = runRule(
        rule,
        `<a href="http://localhost:4000">Local server</a>` +
          `<a href="http://localhost:4000">Local server</a>`,
        { filePath: "docs.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("does NOT fire on three same-href same-name anchors", () => {
      const v = runRule(
        rule,
        `<a href="/signup">Sign up</a><a href="/signup">Sign up</a><a href="/signup">Sign up</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("does NOT fire when an anchor lacks the href attribute entirely", () => {
      // `<a>Buy Now</a>` (no href) is excluded; `<a href="">Buy Now</a>`
      // has an empty href that strips to "". Neither contributes; the
      // group has at most one href-bearing entry, never fires.
      const v = runRule(rule, `<a>Buy Now</a><a href="/cart">Buy Now</a>`, {
        filePath: "index.html",
      });
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("does NOT fire when aria-labelledby is present (defers to agent)", () => {
      // aria-labelledby references separate DOM nodes whose text this
      // rule does not chase cross-element. Grouping is skipped when
      // present, even when hrefs differ.
      const v = runRule(
        rule,
        `<h2 id="a">Alpha</h2><h2 id="b">Beta</h2>` +
          `<a href="/x" aria-labelledby="a">Go</a>` +
          `<a href="/y" aria-labelledby="b">Go</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("uses aria-label as the grouping name when present", () => {
      const v = runRule(
        rule,
        `<a href="/basic" aria-label="Account menu">X</a>` +
          `<a href="/pro" aria-label="account menu">Y</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(2);
      expect(dupFindings[0]?.message).toContain("Account menu");
    });

    it("co-fires with the generic-phrase path on the same anchor", () => {
      // Both paths fire — agent sees both concerns. The generic-phrase
      // violation describes the out-of-context failure; the duplicate-
      // name violation describes the within-context name/destination
      // mismatch across multiple anchors.
      const v = runRule(rule, `<a href="/post1">Read more</a><a href="/post2">Read more</a>`, {
        filePath: "index.html",
      });
      const genericFindings = v.filter((x) => x.message.includes('"read more"'));
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(genericFindings).toHaveLength(2);
      expect(dupFindings).toHaveLength(2);
    });

    it("suggestion offers three concrete differentiation paths", () => {
      const v = runRule(rule, `<a href="/basic">Buy Now</a><a href="/pro">Buy Now</a>`, {
        filePath: "index.html",
      });
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings[0]?.suggestion).toContain("aria-label");
      expect(dupFindings[0]?.suggestion).toContain("expanding");
      expect(dupFindings[0]?.suggestion).toContain("removing the duplicates");
    });
  });

  describe("HTML cross-landmark scope: same name + different hrefs across landmarks is silent", () => {
    // WCAG 2.4.4 permits a link's purpose to be established from "link
    // text together with its programmatically determined link context"
    // — landmarks ARE that context per ARIA-in-HTML. The screen-reader
    // links list groups by landmark, so a "Learn more" in <nav> and a
    // "Learn more" in <main> are distinguishable to the user even when
    // their hrefs differ. Same-name + different-href fires only when
    // both anchors share the SAME nearest landmark (or both are at the
    // document root with no landmark ancestor).

    it("does NOT fire when same-name + different-href anchors are split between <nav> and <main>", () => {
      const v = runRule(
        rule,
        `<nav aria-label="Site"><a href="/about">About us</a></nav>` +
          `<main><a href="/products/about">About us</a></main>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("does NOT fire when same-name + different-href anchors are split between <header> and <footer>", () => {
      const v = runRule(
        rule,
        `<header><a href="/contact">Contact</a></header>` +
          `<footer><a href="/contact-us">Contact</a></footer>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("does NOT fire when one anchor is in <nav> and the other is at document root", () => {
      // The document-root anchor has no landmark ancestor; its scope is
      // distinct from the <nav>'s scope, so the two never group.
      const v = runRule(
        rule,
        `<nav><a href="/help-nav">Help</a></nav>` + `<a href="/help-doc">Help</a>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("DOES fire when same-name + different-href anchors share the SAME <nav>", () => {
      // Within one landmark the user has no further programmatic
      // distinction between two same-named entries — the duplicate-
      // destination ambiguity is real.
      const v = runRule(
        rule,
        `<nav><a href="/post1">Read more</a><a href="/post2">Read more</a></nav>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("DOES fire when same-name + different-href anchors are both at the document root", () => {
      // Two anchors with no landmark ancestor share the implicit
      // "document" scope — they are not disambiguated by a landmark
      // boundary, and a screen-reader user lands on the same
      // unscoped name twice. This is the long-standing behavior the
      // landmark-scoping change preserves.
      const v = runRule(rule, `<a href="/a">Buy Now</a><a href="/b">Buy Now</a>`, {
        filePath: "index.html",
      });
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("treats role='navigation' the same as <nav> for scoping purposes", () => {
      // ARIA landmark roles establish landmark scope just like the
      // native tags do.
      const v = runRule(
        rule,
        `<div role="navigation"><a href="/nav-help">Help</a></div>` +
          `<div role="main"><a href="/main-help">Help</a></div>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("scopes by the NEAREST landmark — nested same-landmark groups still fire", () => {
      // Two <a> in the same <main>, even though one is in a deeper
      // <section>, share `<section>` as their nearest landmark
      // ancestor (`<section>` is in the LANDMARK_TAGS set). The
      // OTHER one is direct in <main>, scoped to <main>. Different
      // scopes → silent. This codifies the "nearest" semantics.
      const v = runRule(
        rule,
        `<main>` +
          `<a href="/main-direct">Read more</a>` +
          `<section><a href="/section-link">Read more</a></section>` +
          `</main>`,
        { filePath: "index.html" },
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });
  });

  describe("JSX cross-landmark scope: same name + different hrefs across landmarks is silent", () => {
    it("does NOT fire when same-name + different-href anchors are split between <nav> and <main>", () => {
      const v = runRule(
        rule,
        `const X = <div>` +
          `<nav><a href="/about-nav">About</a></nav>` +
          `<main><a href="/about-main">About</a></main>` +
          `</div>;`,
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("DOES fire when same-name + different-href anchors share the SAME <nav>", () => {
      const v = runRule(
        rule,
        `const X = <nav>` +
          `<a href="/post1">Read more</a>` +
          `<a href="/post2">Read more</a>` +
          `</nav>;`,
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("treats role='navigation' the same as <nav> for scoping in JSX", () => {
      const v = runRule(
        rule,
        `const X = <div>` +
          `<div role="navigation"><Link to="/help-nav">Help</Link></div>` +
          `<div role="main"><Link to="/help-main">Help</Link></div>` +
          `</div>;`,
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });
  });

  describe("JSX duplicate-name-different-href detection", () => {
    it("fires on two <a> with same name and different hrefs", () => {
      const v = runRule(
        rule,
        `const X = <section><a href="/a">Buy Now</a><a href="/b">Buy Now</a></section>;`,
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("fires on <Link to='…'>Buy Now</Link> with distinct destinations", () => {
      const v = runRule(
        rule,
        `const X = <><Link to="/basic">Buy Now</Link><Link to="/pro">Buy Now</Link></>;`,
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(2);
    });

    it("does NOT fire when same-name anchors share the same href", () => {
      const v = runRule(
        rule,
        `const X = <><a href="/cart">Buy Now</a><a href="/cart">Buy Now</a></>;`,
      );
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });

    it("skips anchors whose name depends on an expression child", () => {
      // Runtime label — scanner can't see it; grouping skips these.
      const v = runRule(rule, `const X = <><a href="/x">{label}</a><a href="/y">{label}</a></>;`);
      const dupFindings = v.filter((x) => x.message.includes("share the accessible name"));
      expect(dupFindings).toHaveLength(0);
    });
  });

  describe("title / aria-label that duplicates visible text is NOT an override", () => {
    // `title` and `aria-label` normally short-circuit this rule by
    // supplying a different accessible name than the body text. When
    // the override value is an exact (case-insensitive, trimmed)
    // duplicate of the visible text, it contributes nothing new — AT
    // announces the single name — so the generic-phrase path continues
    // to fire. See rule header comments on `hasAccessibleNameOverride*`.

    it("HTML: flags when title equals the visible generic text", () => {
      const v = runRule(rule, `<a href="/foo" title="Click here"><span>Click here</span></a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("click here");
    });

    it("HTML: flags when title equals visible text (no wrapper span)", () => {
      const v = runRule(rule, `<a href="/x" title="read more">read more</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("read more");
    });

    it("HTML: case-insensitive + whitespace-trimmed duplicate still flags", () => {
      const v = runRule(rule, `<a href="/x" title="  CLICK HERE  ">click here</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("HTML: body with trailing arrow vs plain title normalizes to match", () => {
      const v = runRule(rule, `<a href="/x" title="Click here">Click here →</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("HTML: flags when aria-label equals visible generic text", () => {
      const v = runRule(rule, `<a href="/x" aria-label="read more">read more</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(1);
    });

    it("HTML: does NOT flag when title adds context (different from body)", () => {
      // Title carries real additional info ("opens in new window") — the
      // override genuinely supplies name content the body doesn't, so
      // the generic-phrase path stays silent and lets the agent judge.
      const v = runRule(
        rule,
        `<a href="/api-docs.pdf" title="API reference (PDF, opens in new tab)">click here</a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("HTML: does NOT flag when aria-label adds context", () => {
      const v = runRule(
        rule,
        `<a href="/settings" aria-label="Open account settings">click here</a>`,
        { filePath: "index.html" },
      );
      expect(v).toHaveLength(0);
    });

    it("HTML: descriptive body text with duplicating title stays silent (not a generic phrase)", () => {
      // The duplicate-title-is-not-an-override behavior only affects
      // whether we fall through to the generic-phrase check — if the
      // body text isn't a generic phrase, nothing fires. The
      // `aria/duplicate-title-on-interactive` style of complaint is
      // out of scope for this rule.
      const v = runRule(rule, `<a href="/docs" title="Read the docs">Read the docs</a>`, {
        filePath: "index.html",
      });
      expect(v).toHaveLength(0);
    });

    it("HTML: empty-body icon-only link with non-matching title still silenced (existing contract)", () => {
      // Regression guard: visible text is empty (icon-only), title is
      // different → override returns true → icon-only path doesn't
      // fire. This preserves the pre-existing
      // `"the anchor has a title attribute"` behavior for icon-only
      // anchors.
      const v = runRule(
        rule,
        `<a href="/twitter" title="Twitter"><i class="fa fa-twitter"></i></a>`,
        {
          filePath: "index.html",
        },
      );
      expect(v).toHaveLength(0);
    });

    it("JSX: flags when title equals visible generic text", () => {
      const v = runRule(rule, `const X = <a href="/x" title="read more">read more</a>;`);
      expect(v).toHaveLength(1);
      expect(v[0]?.message).toContain("read more");
    });

    it("JSX: flags when aria-label equals visible generic text on <Link>", () => {
      const v = runRule(rule, `const X = <Link to="/x" aria-label="click here">click here</Link>;`);
      expect(v).toHaveLength(1);
    });

    it("JSX: does NOT flag when aria-label adds context (different from body)", () => {
      const v = runRule(
        rule,
        `const X = <Link to="/x" aria-label="Open settings">click here</Link>;`,
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
