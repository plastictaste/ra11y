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
      const violations = runRule(rule, `<input type="search" id="search-user-email" name="q">`, {
        filePath: "index.html",
      });
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

  // Label-purpose-rejection gate: when the trigger is type-derived
  // (`type=email`, `type=tel`, `type=password`, `type=url`) AND a label
  // was resolved on the input AND the label text contains zero
  // purpose-related token, the label is direct in-file contrary
  // evidence against the "appears-to-collect-user-info" predicate. The
  // rule suppresses emission rather than emit at `severity:warning` on
  // a label that semantically rejects the inference.
  //
  // See LABEL_PURPOSE_TOKENS in src/rules/forms/autocomplete-missing.ts
  // for the visible-language vocabulary corresponding to WCAG 2.1's 53
  // input-purpose tokens.
  describe("HTML: label-purpose-rejection gate (type-derived triggers)", () => {
    it("type=email with Latin-filler label — no fire (contrary evidence)", () => {
      // The canonical case from the field report: a `<input type=email>`
      // whose surrounding `<label>` carries Latin filler text. The
      // label is direct in-file rejection of the "user-info" inference;
      // emitting at warning would contradict the resolved evidence.
      const violations = runRule(
        rule,
        `<label for="x">Lorem ipsum dolor sit amet, consectetur adipiscing elit.</label>` +
          `<input id="x" type="email" name="email">`,
        { filePath: "filler.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("type=email with aria-label of Latin filler — no fire", () => {
      const violations = runRule(
        rule,
        `<input type="email" name="email" aria-label="Lorem ipsum dolor">`,
        { filePath: "filler.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("type=email with placeholder of Latin filler — no fire", () => {
      const violations = runRule(rule, `<input type="email" placeholder="Lorem ipsum">`, {
        filePath: "filler.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("type=email with no label resolved — still fires (no contrary evidence)", () => {
      // Backlog test case 3: when no label channel resolves at all,
      // there is no in-file contrary evidence; the rule continues to
      // surface so the agent reading the file (which has more context
      // than the scanner) can decide.
      const violations = runRule(rule, `<input type="email" name="email">`, {
        filePath: "no-label.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain(`autocomplete="email"`);
    });

    it("type=email with label containing a purpose token — still fires", () => {
      // Backlog test case 1: the label "Email address" contains the
      // "email" purpose token, so the rule's inference is corroborated
      // and emission stays.
      const violations = runRule(
        rule,
        `<label for="e">Email address</label><input id="e" type="email" name="email">`,
        { filePath: "labelled.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain(`autocomplete="email"`);
    });

    it("type=tel with Latin-filler label — no fire", () => {
      // Gate covers all type-derived matches, not just email.
      const violations = runRule(
        rule,
        `<label for="t">Lorem ipsum</label><input id="t" type="tel" name="phone">`,
        { filePath: "filler-tel.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("type=password with non-purpose label — no fire", () => {
      const violations = runRule(rule, `<input type="password" aria-label="Verification value">`, {
        filePath: "filler-pw.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("type=password with purpose-bearing label — still fires", () => {
      const violations = runRule(rule, `<input type="password" aria-label="Choose a password">`, {
        filePath: "labelled-pw.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("current-password");
    });

    it("name-derived match (type=text, name='firstName') is NOT gated by label", () => {
      // The gate scope is type-derived matches only — when the trigger
      // is the attribute name itself (the strong positive signal), a
      // non-purpose label is not contrary evidence (the input clearly
      // collects a first name regardless of how the label reads).
      const violations = runRule(
        rule,
        `<label for="fn">Lorem ipsum</label><input id="fn" type="text" name="firstName">`,
        { filePath: "name-trigger.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).toContain("given-name");
    });

    it("type=email with wrapping <label> containing a purpose token — still fires", () => {
      const violations = runRule(
        rule,
        `<label>Email address<input type="email" name="email"></label>`,
        { filePath: "wrapping.html" },
      );
      expect(violations).toHaveLength(1);
    });

    it("type=email with wrapping <label> of Latin filler — no fire", () => {
      const violations = runRule(
        rule,
        `<label>Lorem ipsum dolor<input type="email" name="email"></label>`,
        { filePath: "wrapping-filler.html" },
      );
      expect(violations).toHaveLength(0);
    });

    it("type=url with non-purpose label — no fire", () => {
      const violations = runRule(rule, `<input type="url" aria-label="Lorem ipsum">`, {
        filePath: "filler-url.html",
      });
      expect(violations).toHaveLength(0);
    });

    it("type=url with website label — still fires", () => {
      const violations = runRule(rule, `<input type="url" aria-label="Company website">`, {
        filePath: "labelled-url.html",
      });
      expect(violations).toHaveLength(1);
    });

    it("sibling cluster of type=email with non-purpose labels — no collapsed finding", () => {
      // Predicate-level rejection means the collapse helper sees zero
      // failing siblings under the parent, so no rollup finding ships.
      // Surface-don't-suppress doctrine is preserved: the agent reading
      // the file would reach the same conclusion the gate did (label
      // semantically rejects the inference).
      const source = `<form>
        <label for="a">Lorem ipsum</label><input id="a" type="email" placeholder="Lorem">
        <label for="b">Lorem ipsum</label><input id="b" type="email" placeholder="Lorem">
        <label for="c">Lorem ipsum</label><input id="c" type="email" placeholder="Lorem">
        <label for="d">Lorem ipsum</label><input id="d" type="email" placeholder="Lorem">
      </form>`;
      const violations = runRule(rule, source, { filePath: "filler-cluster.html" });
      expect(violations).toHaveLength(0);
    });
  });

  describe("JSX: label-purpose-rejection gate (type-derived triggers)", () => {
    it("type=email with aria-label of Latin filler — no fire", () => {
      const violations = runRule(
        rule,
        `const X = <input type="email" name="email" aria-label="Lorem ipsum dolor" />;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("type=email with placeholder of Latin filler — no fire", () => {
      const violations = runRule(
        rule,
        `const X = <input type="email" name="email" placeholder="Lorem ipsum" />;`,
      );
      expect(violations).toHaveLength(0);
    });

    it("type=email with no label resolved — still fires", () => {
      // ContactForm.tsx-style: type=email, no aria-label, no placeholder.
      // Resolution returns null and the gate stays inert.
      const violations = runRule(rule, `const X = <input type="email" name="email" />;`);
      expect(violations).toHaveLength(1);
    });

    it("type=email with purpose-token aria-label — still fires", () => {
      const violations = runRule(
        rule,
        `const X = <input type="email" name="email" aria-label="Your email" />;`,
      );
      expect(violations).toHaveLength(1);
    });

    it("name-derived JSX match is NOT gated by label", () => {
      const violations = runRule(
        rule,
        `const X = <input type="text" name="firstName" aria-label="Lorem ipsum" />;`,
      );
      expect(violations).toHaveLength(1);
    });
  });

  // Sibling-collapse: when ≥3 direct-child <input> siblings under one
  // parent share the same `(tagName, attributes-modulo-id)` fingerprint
  // and all fail the purpose-vs-autocomplete predicate, collapse the N
  // near-identical findings into ONE canonical finding carrying
  // `siblingInstances`. Mirrors `forms/labels-required` /
  // `forms/placeholder-as-label` — the line-text-keyed `findingId` recipe
  // collapses bytes-identical line text by design, so without collapse a
  // visually-grouped cluster of identical inputs ships N entries that
  // share one `findingId` (the silent-merge failure mode the helper was
  // introduced to fix).
  describe("HTML: sibling collapse", () => {
    it("collapses 4 identical type=email <input> siblings into one finding with siblingInstances", () => {
      // The canonical case from the backlog — 4 entries on identical
      // `<input type="email" placeholder="Email">` siblings shared one
      // `findingId` before the helper was applied here. After collapse,
      // ONE finding ships with the per-sibling trail enumerable on
      // `siblingInstances`.
      const source = `<form>
        <input type="email" placeholder="Email" id="e1">
        <input type="email" placeholder="Email" id="e2">
        <input type="email" placeholder="Email" id="e3">
        <input type="email" placeholder="Email" id="e4">
      </form>`;
      const violations = runRule(rule, source, { filePath: "signup.html" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.siblingInstances).toBeDefined();
      expect(violations[0]?.siblingInstances?.length).toBe(4);
      expect(violations[0]?.siblingInstances?.[0]?.id).toBe("e1");
      expect(violations[0]?.siblingInstances?.[3]?.id).toBe("e4");
      // Message names the rollup so an agent reading the message alone
      // knows it is one finding standing in for N siblings.
      expect(violations[0]?.message).toContain("siblingInstances");
      expect(violations[0]?.message).toContain("3 adjacent sibling");
      // The collapsed finding still names the resolved autocomplete
      // token so the agent gets the fix shape from one read.
      expect(violations[0]?.message).toContain(`autocomplete="email"`);
    });

    it("emits per-element when 2 sibling inputs share a fingerprint (below threshold)", () => {
      // Two siblings is below SIBLING_COLLAPSE_THRESHOLD = 3 — both
      // emit individually and neither carries `siblingInstances`. Each
      // finding's `findingId` is still distinct because the inputs
      // differ in their unique `id` attribute (which the line-text-keyed
      // recipe captures as part of the line bytes).
      const source = `<form>
        <input type="email" name="email" id="e1">
        <input type="email" name="email" id="e2">
      </form>`;
      const violations = runRule(rule, source, { filePath: "pair.html" });
      expect(violations).toHaveLength(2);
      expect(violations[0]?.siblingInstances).toBeUndefined();
      expect(violations[1]?.siblingInstances).toBeUndefined();
    });

    it("does not collapse siblings under different parents", () => {
      // Same fingerprint but two different parents — neither parent has
      // ≥3 failing siblings, so per-element emission stays.
      const source = `<form>
        <input type="email" name="email" id="a1">
        <input type="email" name="email" id="a2">
      </form>
      <form>
        <input type="email" name="email" id="b1">
        <input type="email" name="email" id="b2">
      </form>`;
      const violations = runRule(rule, source, { filePath: "two-forms.html" });
      expect(violations).toHaveLength(4);
      for (const finding of violations) {
        expect(finding.siblingInstances).toBeUndefined();
      }
    });

    it("findingIds across all surfaced findings stay unique post-collapse", () => {
      // The headline invariant the backlog item names. Per AI-first
      // doctrine "ambiguous field shapes are dishonest" — id collisions
      // are the worst case because downstream dedupe / suppression flows
      // silently merge them. After collapse, every emitted finding's id
      // must be distinct.
      const source = `<form>
        <input type="email" placeholder="Email" id="e1">
        <input type="email" placeholder="Email" id="e2">
        <input type="email" placeholder="Email" id="e3">
        <input type="email" placeholder="Email" id="e4">
        <input type="tel" name="phone" id="p1">
      </form>`;
      const violations = runRule(rule, source, { filePath: "signup.html" });
      const ids = violations.map((v) => v.findingId);
      expect(ids.length).toBe(new Set(ids).size);
    });
  });

  describe("JSX: sibling collapse", () => {
    it("collapses 4 identical type=email JSX <input> siblings into one finding", () => {
      const source = `const X = (
        <form>
          <input type="email" placeholder="Email" id="e1" />
          <input type="email" placeholder="Email" id="e2" />
          <input type="email" placeholder="Email" id="e3" />
          <input type="email" placeholder="Email" id="e4" />
        </form>
      );`;
      const violations = runRule(rule, source, { filePath: "signup.tsx" });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.siblingInstances?.length).toBe(4);
      expect(violations[0]?.siblingInstances?.[0]?.id).toBe("e1");
      expect(violations[0]?.siblingInstances?.[3]?.id).toBe("e4");
      expect(violations[0]?.message).toContain("siblingInstances");
    });
  });

  // The label interpolation lets the agent dismiss recipient-email
  // vs user-email cases (and similar) in one read without cracking
  // the rule definition open. Without a resolved label, every
  // `type="email"` input emits an identical reason — the agent
  // has to read each surrounding source to triage. With the label,
  // the agent can decide from the response shape alone.
  describe("label interpolation in reason text", () => {
    it("HTML: <label for> matching the input's id surfaces the label text", () => {
      const violations = runRule(
        rule,
        `<label for="recip">Recipient email</label><input id="recip" type="email" name="email">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Recipient email");
      // The recipient-hint clause is part of the dismissal payload
      // — agent reads "applies if this collects the user's own
      // email; if it collects someone else's, use autocomplete='off'"
      // and the labelled "Recipient email" makes the answer obvious.
      expect(violations[0]?.suggestion).toContain(`autocomplete="off"`);
    });

    it("HTML: aria-label surfaces verbatim and is preferred over placeholder", () => {
      const violations = runRule(
        rule,
        `<input type="email" name="email" aria-label="Your email" placeholder="you@example.com">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      // aria-label wins over placeholder for the surfaced label.
      expect(violations[0]?.message).toContain(`aria-label="Your email"`);
      // placeholder text contains `@` and digits — should not be
      // confused with the resolved label evidence.
      expect(violations[0]?.message).not.toContain("you@example.com");
    });

    it("HTML: wrapping <label> surfaces the label text", () => {
      const violations = runRule(
        rule,
        `<label>Email address<input type="email" name="email"></label>`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Email address");
    });

    it("HTML: placeholder surfaces as a fallback when no label/aria-label is present", () => {
      const violations = runRule(rule, `<input type="email" placeholder="Email address">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`placeholder="Email address"`);
    });

    it("HTML: unlabeled input emits no label clause but still fires", () => {
      const violations = runRule(rule, `<input type="email" name="email">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      // No label channel resolved — message must not invent a label.
      expect(violations[0]?.message).not.toContain("aria-label=");
      expect(violations[0]?.message).not.toContain("placeholder=");
      expect(violations[0]?.message).not.toContain("via <label for");
      expect(violations[0]?.message).not.toContain("wrapped by");
      // But it must still cite the type-trigger so the agent has
      // something to read.
      expect(violations[0]?.message).toContain(`type="email"`);
    });

    it("HTML: type=email recipient case — agent can dismiss in one read", () => {
      // The canonical case from the backlog — a recipient-email input
      // labelled "Recipient email" emits identical reason text to a
      // user's-own-email input under the unfixed rule. With label
      // interpolation, the agent reads the label + the suggestion's
      // `autocomplete="off"` hint and dismisses without cracking the
      // file open.
      const violations = runRule(
        rule,
        `<label for="r">Recipient email</label><input id="r" type="email" name="recipient">`,
        { filePath: "index.html" },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("Recipient email");
      expect(violations[0]?.suggestion).toContain(`autocomplete="off"`);
    });

    it("HTML: type=tel does NOT add the recipient-email hint clause", () => {
      // The recipient-email hint is scoped to email triggers — the
      // ambiguity it resolves is specific to "user's own email" vs
      // "someone else's email." For tel/url/etc., adding an "or use
      // autocomplete='off'" clause would be over-broad noise.
      const violations = runRule(rule, `<input type="tel" name="phone">`, {
        filePath: "index.html",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.suggestion).not.toContain(`autocomplete="off"`);
    });

    it("JSX: aria-label literal surfaces in the message", () => {
      const violations = runRule(
        rule,
        `const X = <input type="email" name="email" aria-label="Your email" />;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`aria-label="Your email"`);
    });

    it("JSX: placeholder literal surfaces when no aria-label is present", () => {
      const violations = runRule(
        rule,
        `const X = <input type="email" name="email" placeholder="Recipient email" />;`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(`placeholder="Recipient email"`);
    });

    it("HTML: long label is truncated for echo", () => {
      // Labels are user-authored strings that get echoed into the
      // reason — the same `truncateForEcho` cap that protects
      // forms/labels-required's suggestion path applies here so
      // pathological labels don't blow the per-finding token budget.
      const longLabel = "Recipient email ".repeat(20).trim();
      const source = `<label for="r">${longLabel}</label><input id="r" type="email" name="recipient">`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const msg = violations[0]?.message ?? "";
      // The full 320-char label exceeds the 200-char default cap and
      // is replaced by a truncated form ending in U+2026.
      expect(msg.includes(longLabel)).toBe(false);
      expect(msg).toContain("…");
    });
  });

  describe("fixPaths.primary.edit", () => {
    // Doctrine: a `fixClass: "mechanical"` rule must populate
    // `fixPaths.primary.edit` so `suggest_fix` returns `kind: "edit"`.
    // The expected autocomplete token is fully resolved at emit time
    // (from EXPECTED_BY_TYPE / NAME_HEURISTICS), so the insertion is
    // strictly "add one attribute with a known value."
    it("HTML input with type='email': primary.edit inserts autocomplete=\"email\" at the end of the attribute list", () => {
      const source = `<input type="email" name="email">`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const edit = violations[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.oldText).toBe(`<input type="email" name="email">`);
      expect(edit?.newText).toBe(`<input type="email" name="email" autocomplete="email">`);
      expect(source.includes(edit?.oldText ?? "")).toBe(true);
    });

    it("HTML input with type='password': primary.edit inserts autocomplete=\"current-password\"", () => {
      const source = `<input type="password" name="pw">`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const edit = violations[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.newText).toContain(`autocomplete="current-password"`);
    });

    it("HTML input inferring purpose from name: primary.edit inserts the inferred token", () => {
      const source = `<input type="text" name="firstName">`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const edit = violations[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.newText).toContain(`autocomplete="given-name"`);
    });

    it("HTML self-closing input: primary.edit preserves the self-close", () => {
      const source = `<input type="email" name="email" />`;
      const violations = runRule(rule, source, { filePath: "index.html" });
      expect(violations).toHaveLength(1);
      const edit = violations[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.newText).toBe(`<input type="email" name="email" autocomplete="email" />`);
    });

    it("JSX input: primary.edit uses React's camelCase autoComplete property name", () => {
      const source = `const X = <input type="email" name="email" />;`;
      const violations = runRule(rule, source);
      expect(violations).toHaveLength(1);
      const edit = violations[0]?.fixPaths?.primary.edit;
      expect(edit).toBeDefined();
      expect(edit?.newText).toContain(`autoComplete="email"`);
      // Never `autocomplete="..."` on JSX — React's DOM property layer
      // requires the camelCase form.
      expect(edit?.newText).not.toContain(` autocomplete="`);
    });
  });
});
