/**
 * Cross-parser invariant: parse-error reason text for the layout-tail
 * elision diagnostic must name the ELIDED side honestly.
 *
 * The HTML parser's stray-close recovery emits a recoverable
 * `ParseError` whose `message` string flows through to
 * `analysisCoverage.partialParseFiles[].reason` on every project-rooted
 * MCP tool surface. The earlier wording named the bare CLOSER tag as
 * "elided" — but the closer is what's literally present in source (it's
 * what we just diagnosed). The OPENING tag is what's actually elided,
 * supplied by an included Liquid partial or a parent Astro `<Layout>`
 * component.
 *
 * Per docs/kb/architecture/ai-first-consumer.md "Heuristic-mislabeled
 * meta sub-fields are dishonest", a `reason`-shaped sub-field that
 * inverts the routing direction the agent reads off it carries the
 * silent-miss failure mode that bullet was written to prevent — the
 * agent triages the file on a wrong premise (looks for the elided
 * closer's source upstream when the closer is right there in front of
 * it; misses that the open tag is what came from the include / parent
 * component).
 *
 * This test pins the direction with synthetic include-pattern fixtures
 * covering both the Liquid and Astro composition shapes. It asserts:
 *   - The bare CLOSER tag IS literally in the source on its last
 *     non-blank line (proving the closer is NOT what's elided).
 *   - The reason names `<tag> open` (elided side) — not `</tag>` as
 *     elided. The closer is named separately as the trigger.
 *
 * Coverage is intentionally bidirectional — both Liquid and Astro
 * paths through `strayClosingTagMessage`. A symmetric mistake on
 * either branch would fail this test on the next direction-flip
 * regression.
 */

import { describe, expect, it } from "bun:test";
import { parseAstro } from "../../src/input/parsers/astro.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";

/**
 * Returns the last non-blank line of the source — the line whose
 * presence in source proves the closer is NOT elided. Used to assert
 * that the file's actual content carries the closer the diagnostic
 * names, so a regression that re-inverts the direction fails on a
 * provable claim, not a string-equality coincidence.
 */
function lastNonBlankLine(source: string): string {
  const lines = source.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line.length > 0) return line;
  }
  return "";
}

describe("parse-error reason names the elided side, not the observed closer", () => {
  it("Liquid root-layout </html> tail — opener is elided, closer is in source", () => {
    // Canonical Jekyll `_layouts/default.html` shape: the opening
    // `<html>` is supplied by `top.html` via `{% include %}`; the
    // file's last line literally is `</html>`. The elided side is
    // therefore the OPENING `<html>` tag.
    const src = `{%- include top.html -%}

<main>content</main>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors.length).toBe(1);
    const reason = errors[0]?.message ?? "";

    // The closer IS present in source on the last non-blank line.
    expect(lastNonBlankLine(src)).toBe("</html>");

    // The reason names the OPENING tag as elided — `<html> open`.
    expect(reason).toContain("Elided layout-tail <html> open");

    // Reason mentions the bare closer as the trigger evidence.
    expect(reason).toContain("</html>");

    // The reason must NOT claim the closer is what's elided. The prior
    // wording read "Elided layout-tail </html>" which inverted the
    // direction — pinned negatively here so a regression fails loudly.
    expect(reason).not.toContain("Elided layout-tail </html>");
    expect(reason).not.toContain("Elided layout-tail </body>");
    expect(reason).not.toContain("Elided layout-tail </head>");

    // The Liquid include is named as the source of the elided open tag.
    expect(reason).toContain("Liquid");
    // The verb on the partial is "provides" (it provides the open),
    // not "closes" (which inverted what the partial actually does).
    expect(reason).not.toContain("partial closes");
  });

  it("Liquid root-layout </body> tail — same direction inversion", () => {
    // Variant: only `</body>` is the bare closer (no `</html>` in
    // source). The elided side is the OPENING `<body>` tag.
    const src = `{% include head.html %}
<main>x</main>
</body>
`;
    const { errors } = parseHtml(src);
    expect(errors.length).toBe(1);
    const reason = errors[0]?.message ?? "";

    expect(lastNonBlankLine(src)).toBe("</body>");
    expect(reason).toContain("Elided layout-tail <body> open");
    expect(reason).toContain("</body>");
    expect(reason).not.toContain("Elided layout-tail </body>");
    expect(reason).not.toContain("partial closes");
  });

  it("Astro closer-only partial </body> — opener is elided by the parent <Layout>", () => {
    // Canonical Astro `pages/foo.astro` shape: parent `<Layout>` opens
    // `<html>` / `<body>`; this file emits only the matching close
    // tags downstream. The elided side is the OPENING tag.
    const src = `---
import Footer from "./Footer.astro";
---
  <Footer />
</body>
`;
    const { errors } = parseAstro(src);
    const body = errors.find((e) => e.message.includes("</body>"));
    expect(body).toBeDefined();
    const reason = body?.message ?? "";

    expect(lastNonBlankLine(src)).toBe("</body>");
    expect(reason).toContain("Elided layout-tail <body> open");
    expect(reason).toContain("</body>");
    expect(reason).not.toContain("Elided layout-tail </body>");
    expect(reason).toContain("Astro");
    // The parent component is named as the source of the elided open.
    expect(reason).toContain("Layout");
  });

  it("Astro closer-only partial </body></html> — both opens are elided, both closers are in source", () => {
    // Both `</body>` and `</html>` close downstream while their opens
    // live in the parent `<Layout>`. Each diagnostic should name its
    // own opening tag as elided.
    const src = `---
import Footer from "./Footer.astro";
---
  <Footer />
</body>
</html>
`;
    const { errors } = parseAstro(src);
    const body = errors.find((e) => e.message.includes("</body>"));
    const html = errors.find((e) => e.message.includes("</html>"));
    const bodyReason = body?.message ?? "";
    const htmlReason = html?.message ?? "";

    // Both closers literally present in source.
    expect(src.includes("\n</body>\n")).toBe(true);
    expect(lastNonBlankLine(src)).toBe("</html>");

    expect(bodyReason).toContain("Elided layout-tail <body> open");
    expect(bodyReason).not.toContain("Elided layout-tail </body>");

    expect(htmlReason).toContain("Elided layout-tail <html> open");
    expect(htmlReason).not.toContain("Elided layout-tail </html>");
  });

  it("control: a file that legitimately closes its own root envelope keeps the stray-close wording", () => {
    // Negative control — the rename's exactly-one-closer gate (Liquid
    // branch) and per-tag matching-open gate (Astro branch) both
    // suppress the elision rename when the file is closing its OWN
    // root document. The wording falls through to "Stray </X> at top
    // level" — neither direction of the elision claim applies.
    const src = `{% include top.html %}
<main>content</main>
</body>
</html>
`;
    const { errors } = parseHtml(src);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    for (const e of errors) {
      expect(e.message).not.toContain("Elided layout-tail");
    }
  });

  it("control: a non-root closer like </div> never claims layout-tail elision", () => {
    // The layout-tail set is the closed `{html, body, head}` triple;
    // any other closer falls through to the standard stray-close
    // wording regardless of head shape. Pins the direction-honesty
    // claim to the rename's documented surface.
    const src = `{%- include top.html -%}
</div>
`;
    const { errors } = parseHtml(src);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toBe("Stray </div> at top level");
  });
});
