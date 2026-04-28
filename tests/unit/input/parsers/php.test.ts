import { describe, expect, it } from "bun:test";
import { parsePhp } from "../../../../src/input/parsers/php.ts";
import type { HtmlElement, HtmlNode } from "../../../../src/types/ast.ts";

/**
 * Walk the HTML tree collecting every element matching `tagName`
 * (case-sensitive). Mirrors the helper shape used in `astro.test.ts`
 * so PHP tests read the same way as the sibling adapter tests.
 */
function findAllElements(nodes: readonly HtmlNode[], tagName: string): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  walk(nodes, (node) => {
    if (node.kind === "HtmlElement" && node.tagName === tagName) out.push(node);
  });
  return out;
}

function findFirstElement(nodes: readonly HtmlNode[], tagName: string): HtmlElement | undefined {
  let found: HtmlElement | undefined;
  walk(nodes, (node) => {
    if (found) return;
    if (node.kind === "HtmlElement" && node.tagName === tagName) found = node;
  });
  return found;
}

function walk(nodes: readonly HtmlNode[], visit: (n: HtmlNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === "HtmlElement") walk(node.children, visit);
  }
}

function getAttr(el: HtmlElement, name: string): string | null | undefined {
  const attr = el.attributes.find((a) => a.name === name);
  if (!attr) return undefined;
  return attr.value;
}

describe("parsePhp — empty + trivial", () => {
  it("parses empty source without error", () => {
    const { root, errors, phpIslandsStripped } = parsePhp("");
    expect(root.kind).toBe("HtmlDocument");
    expect(root.children).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(phpIslandsStripped).toBe(false);
  });

  it("never throws on random garbage", () => {
    const garbage = "<?php<<<>>>{expr<? <img <\n";
    expect(() => parsePhp(garbage)).not.toThrow();
  });

  it("parses an HTML-only `.php` file identically to parseHtml", () => {
    // A `.php` file that happens to ship without any embedded PHP at
    // all. The adapter must not flip `phpIslandsStripped` and the
    // tree must be exactly the parseHtml output.
    const src = `<main><img src="/a.png" alt="cat" /></main>\n`;
    const { root, errors, phpIslandsStripped } = parsePhp(src);
    expect(errors).toHaveLength(0);
    expect(phpIslandsStripped).toBe(false);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(getAttr(img!, "alt")).toBe("cat");
  });
});

describe("parsePhp — pure HTML embedded in PHP block delimiters", () => {
  it("blanks a leading `<?php …?>` header preserving downstream HTML", () => {
    // Canonical PHP page shape: PHP header sets variables, HTML
    // document follows. The header is blanked; the HTML residue
    // parses exactly like a plain `.html` file.
    const src = `<?php $title = "Welcome"; $body_class = "home"; ?>
<!DOCTYPE html>
<html lang="en">
<head><title>Example</title></head>
<body class="home">
  <main><img src="/hero.png" alt="hero banner" /></main>
</body>
</html>
`;
    const { root, errors, phpIslandsStripped } = parsePhp(src);
    expect(errors).toHaveLength(0);
    expect(phpIslandsStripped).toBe(true);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(getAttr(img!, "alt")).toBe("hero banner");
    const main = findFirstElement(root.children, "main");
    expect(main).toBeDefined();
  });
});

describe("parsePhp — PHP block in middle of a `<body>`", () => {
  it("strips a control-flow PHP block between sibling elements without corrupting the surrounding tree", () => {
    const src = `<!DOCTYPE html>
<html lang="en">
<body>
  <header><h1>Site</h1></header>
  <?php if ($logged_in): ?>
  <nav><a href="/account">Account</a></nav>
  <?php else: ?>
  <nav><a href="/login">Sign in</a></nav>
  <?php endif; ?>
  <main><img alt="hero" src="/hero.png" /></main>
</body>
</html>
`;
    const { root, errors, phpIslandsStripped } = parsePhp(src);
    expect(errors).toHaveLength(0);
    expect(phpIslandsStripped).toBe(true);
    // Both `<nav>` siblings parse — the PHP control flow can't
    // statically resolve which branch wins, so we keep both for
    // a11y rules to inspect.
    const navs = findAllElements(root.children, "nav");
    expect(navs).toHaveLength(2);
    const main = findFirstElement(root.children, "main");
    expect(main).toBeDefined();
    const img = findFirstElement(root.children, "img");
    expect(getAttr(img!, "alt")).toBe("hero");
  });
});

describe("parsePhp — `<?= … ?>` short-echo form", () => {
  it("strips short-echo islands inside attributes and text content", () => {
    // Common templating shape: short-echo for inline interpolation.
    // Both attribute-position and text-position cases must blank
    // cleanly so the surrounding HTML element parses normally.
    const src = `<!DOCTYPE html>
<html>
<head><title><?= $title ?></title></head>
<body>
  <input type="<?= $input_type ?>" name="email" />
  <p>Welcome, <?= $name ?>!</p>
</body>
</html>
`;
    const { root, errors, phpIslandsStripped } = parsePhp(src);
    expect(errors).toHaveLength(0);
    expect(phpIslandsStripped).toBe(true);
    const input = findFirstElement(root.children, "input");
    expect(input).toBeDefined();
    // The blanked short-echo leaves `type=""` (with whitespace inside
    // the quotes); the input parses with both attributes intact.
    expect(getAttr(input!, "name")).toBe("email");
    const title = findFirstElement(root.children, "title");
    expect(title).toBeDefined();
  });

  it("strips short tag `<? … ?>` (PHP short_open_tag form) but leaves XHTML `<?xml … ?>` prologue alone", () => {
    // Short tag (`<?`) is historically widespread; we strip it for
    // parity with the long form. The `<?xml` prologue must NOT be
    // mistaken for a short tag — it's the XHTML XML declaration the
    // existing `.xhtml` alias depends on.
    const shortTagSrc = `<? echo $foo; ?>
<main>hi</main>
`;
    const xmlPrologSrc = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>hi</body>
</html>
`;
    const shortTagResult = parsePhp(shortTagSrc);
    expect(shortTagResult.errors).toHaveLength(0);
    expect(shortTagResult.phpIslandsStripped).toBe(true);
    const main = findFirstElement(shortTagResult.root.children, "main");
    expect(main).toBeDefined();
    // XHTML prologue: must NOT be classified as a PHP island.
    const xmlResult = parsePhp(xmlPrologSrc);
    expect(xmlResult.phpIslandsStripped).toBe(false);
  });
});

describe("parsePhp — line/column offset preservation", () => {
  it("keeps element line numbers aligned after stripping a multi-line PHP header", () => {
    // Anchor element on a fixed line, confirm post-strip the parser
    // still reports that line. The PHP header spans 5 lines (lines
    // 1..5). The `<main>` opens on line 6 in the original source;
    // after blanking, it must still report line 6.
    const src = `<?php
$title = "Welcome";
$nav = ["home", "about"];
$year = 2026;
?>
<main>hi</main>
`;
    const { root, phpIslandsStripped } = parsePhp(src);
    expect(phpIslandsStripped).toBe(true);
    const main = findFirstElement(root.children, "main");
    expect(main).toBeDefined();
    expect(main?.loc.start.line).toBe(6);
  });

  it("keeps line numbers aligned with multiple inline PHP blocks across the document", () => {
    // The `<img>` is on line 8 of the original source. Two PHP
    // blocks sit between the doctype and the body, plus a short-echo
    // inside the header. Line numbers must survive every blanking.
    const src = `<?php $a = 1; ?>
<?php $b = 2; ?>
<!DOCTYPE html>
<html>
<head><title><?= $title ?></title></head>
<body>
<header>x</header>
<img alt="line8" src="/x.png" />
</body>
</html>
`;
    const { root } = parsePhp(src);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(img?.loc.start.line).toBe(8);
  });
});

describe("parsePhp — error recovery", () => {
  it("emits a recoverable parseError on an unterminated PHP block AND blanks through EOF so downstream tags don't trip the HTML parser", () => {
    // No closing `?>` before EOF. The adapter records a recoverable
    // error and blanks from the unclosed opener through EOF — without
    // that, a stray `<?php` left intact would be misread as tag soup
    // by the HTML tokenizer.
    const src = `<main>
  <?php
  if ($x) {
    echo "<unclosed";
`;
    const { errors, phpIslandsStripped } = parsePhp(src);
    expect(phpIslandsStripped).toBe(true);
    const recoverables = errors.filter((e) => e.recoverable);
    expect(recoverables.length).toBeGreaterThan(0);
    expect(recoverables[0]?.message).toMatch(/unterminated.*php/i);
  });

  it("survives unterminated short tags too", () => {
    expect(() => parsePhp("<? echo $x;\n")).not.toThrow();
  });
});

describe("parsePhp — case-insensitive opener", () => {
  it("recognizes `<?PHP` and `<?Php` (PHP itself is case-insensitive)", () => {
    const src = `<?PHP $x = 1; ?>
<?Php $y = 2; ?>
<main>ok</main>
`;
    const { root, phpIslandsStripped } = parsePhp(src);
    expect(phpIslandsStripped).toBe(true);
    const main = findFirstElement(root.children, "main");
    expect(main).toBeDefined();
  });
});

describe("parsePhp — combined real-world page (DOCTYPE + body + nav + anchors)", () => {
  it("handles a representative PHP page: DOCTYPE, head, nav with anchors, footer", () => {
    // Sanitized shape from the bulk-catalog field report — PHP server
    // pages routinely carry full document envelopes with embedded
    // anchors, headings, and form elements that a11y rules need to
    // see. The adapter must surface all of them after island
    // stripping.
    const src = `<?php
session_start();
$user = $_SESSION["user"] ?? null;
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title><?= htmlspecialchars($page_title) ?></title>
</head>
<body>
  <header>
    <nav aria-label="primary">
      <a href="/">Home</a>
      <a href="/products">Products</a>
      <?php if ($user): ?>
        <a href="/account">Account</a>
      <?php else: ?>
        <a href="/login">Sign in</a>
      <?php endif; ?>
    </nav>
  </header>
  <main>
    <h1>Welcome</h1>
    <img src="/hero.png" alt="hero banner" />
  </main>
  <footer>
    <small>(c) <?= date("Y") ?></small>
  </footer>
</body>
</html>
`;
    const { root, errors, phpIslandsStripped } = parsePhp(src);
    expect(errors).toHaveLength(0);
    expect(phpIslandsStripped).toBe(true);
    // All the meaningful elements are reachable.
    expect(findFirstElement(root.children, "html")).toBeDefined();
    expect(findFirstElement(root.children, "title")).toBeDefined();
    expect(findFirstElement(root.children, "nav")).toBeDefined();
    expect(findFirstElement(root.children, "main")).toBeDefined();
    expect(findFirstElement(root.children, "h1")).toBeDefined();
    expect(findFirstElement(root.children, "footer")).toBeDefined();
    // The cross-rule coverage the backlog item cares about: anchors
    // and the hero image surface to a11y rules.
    const anchors = findAllElements(root.children, "a");
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    const img = findFirstElement(root.children, "img");
    expect(img).toBeDefined();
    expect(getAttr(img!, "alt")).toBe("hero banner");
  });
});

describe("parsePhp — never throws", () => {
  it("survives unterminated tags", () => {
    expect(() => parsePhp("<div\n")).not.toThrow();
  });

  it("survives nested PHP openers (no recursive parsing)", () => {
    // `<?php` inside another `<?php` block is invalid PHP, but our
    // strip is greedy on the first `?>`. The trailing fragment is
    // tolerated by the HTML parser as text.
    expect(() => parsePhp("<?php $x = '<?php'; ?>\n<main>ok</main>")).not.toThrow();
  });

  it("survives a CRLF-only document", () => {
    expect(() => parsePhp("<?php\r\n$x = 1;\r\n?>\r\n<main>ok</main>\r\n")).not.toThrow();
  });
});
