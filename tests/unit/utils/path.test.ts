import { describe, expect, test } from "bun:test";
import { dirname, join, relative, resolve } from "node:path";
import {
  extensionMatches,
  hasParseableExtension,
  isStorybookStoryFile,
  isTestFilePath,
  posixDirname,
  posixJoin,
  posixRelative,
  posixResolve,
  toPosix,
} from "../../../src/utils/path.ts";

describe("extensionMatches", () => {
  test("empty allowList matches any extension", () => {
    expect(extensionMatches(".tsx", [])).toBe(true);
    expect(extensionMatches(".xyz", [])).toBe(true);
  });

  test("exact match wins", () => {
    expect(extensionMatches(".tsx", [".tsx", ".jsx"])).toBe(true);
    expect(extensionMatches(".html", [".html", ".htm"])).toBe(true);
  });

  test(".jsx in allowList aliases .js — Next.js style repos have JSX inside .js", () => {
    expect(extensionMatches(".js", [".tsx", ".jsx"])).toBe(true);
    expect(extensionMatches(".js", [".html", ".htm", ".tsx", ".jsx"])).toBe(true);
  });

  test(".tsx in allowList aliases .ts", () => {
    expect(extensionMatches(".ts", [".tsx", ".jsx"])).toBe(true);
    expect(extensionMatches(".ts", [".tsx"])).toBe(true);
  });

  test("no alias when the JSX extension is absent from allowList", () => {
    expect(extensionMatches(".js", [".html", ".htm"])).toBe(false);
    expect(extensionMatches(".ts", [".css"])).toBe(false);
  });

  test("rules that already list .js/.ts explicitly are unaffected", () => {
    expect(extensionMatches(".js", [".tsx", ".jsx", ".ts", ".js"])).toBe(true);
    expect(extensionMatches(".ts", [".tsx", ".jsx", ".ts", ".js"])).toBe(true);
  });

  test("non-JSX extensions don't alias", () => {
    expect(extensionMatches(".css", [".tsx", ".jsx"])).toBe(false);
    expect(extensionMatches(".html", [".tsx", ".jsx"])).toBe(false);
  });

  test(".erb aliases into .html/.htm — ERB templates route through parseHtml", () => {
    // ERB (`.html.erb`, `.erb`) is Ruby's embedded-template syntax;
    // the HTML parser's `stripTemplateDirectives` pass already handles
    // `<%= … %>` / `<% … %>` / `<%# … %>`, so aliasing to `.html`
    // makes every HTML-scoped rule apply. Mirrors the `.astro →
    // .html/.htm` + `.svg → .html/.htm` alias rows.
    expect(extensionMatches(".erb", [".html", ".htm"])).toBe(true);
    expect(extensionMatches(".erb", [".html"])).toBe(true);
    expect(extensionMatches(".erb", [".htm"])).toBe(true);
    // `.erb` does NOT alias into CSS or TSX — rules scoped to those
    // extensions must not mis-fire on ERB templates.
    expect(extensionMatches(".erb", [".css"])).toBe(false);
    expect(extensionMatches(".erb", [".tsx", ".jsx"])).toBe(false);
  });

  test(".xhtml aliases into .html/.htm — XHTML is XML-serialized HTML", () => {
    // XHTML 1.x docs ship with an `<?xml ... ?>` prologue, mandatory
    // `xmlns` on `<html>`, and self-closing tags. The HTML parser
    // tolerates the prologue and self-closers, so every HTML-scoped
    // rule applies without a dedicated XHTML adapter.
    expect(extensionMatches(".xhtml", [".html", ".htm"])).toBe(true);
    expect(extensionMatches(".xhtml", [".html"])).toBe(true);
    expect(extensionMatches(".xhtml", [".htm"])).toBe(true);
    // Not a CSS / TSX shape.
    expect(extensionMatches(".xhtml", [".css"])).toBe(false);
    expect(extensionMatches(".xhtml", [".tsx", ".jsx"])).toBe(false);
  });

  test(".mkdn aliases into .html/.htm — common alternate Markdown extension", () => {
    // `.mkdn` is a long-standing alternate Markdown extension (Vim,
    // older static-site generators); routing it through the same
    // markdown adapter as `.md` / `.markdown` avoids dropping
    // otherwise-valid Markdown input.
    expect(extensionMatches(".mkdn", [".html", ".htm"])).toBe(true);
    expect(extensionMatches(".mkdn", [".html"])).toBe(true);
    expect(extensionMatches(".mkdn", [".htm"])).toBe(true);
    expect(extensionMatches(".mkdn", [".css"])).toBe(false);
    expect(extensionMatches(".mkdn", [".tsx", ".jsx"])).toBe(false);
  });

  test(".php / .phtml alias into .html/.htm — PHP server pages route through parsePhp", () => {
    // The {@link parsePhp} adapter blanks `<?php … ?>` / `<?= … ?>` /
    // `<? … ?>` islands and feeds the HTML residue to parseHtml, so
    // every HTML-scoped rule applies. Mirrors the `.erb → .html/.htm`
    // alias row.
    expect(extensionMatches(".php", [".html", ".htm"])).toBe(true);
    expect(extensionMatches(".php", [".html"])).toBe(true);
    expect(extensionMatches(".phtml", [".html", ".htm"])).toBe(true);
    expect(extensionMatches(".phtml", [".htm"])).toBe(true);
    // `.php` does NOT alias into CSS or TSX — rules scoped to those
    // extensions must not mis-fire on PHP server pages.
    expect(extensionMatches(".php", [".css"])).toBe(false);
    expect(extensionMatches(".php", [".tsx", ".jsx"])).toBe(false);
    expect(extensionMatches(".phtml", [".css"])).toBe(false);
  });
});

describe("hasParseableExtension", () => {
  test(".erb is parseable — Rails views, Middleman, Jekyll *.md.erb scaffolds", () => {
    expect(hasParseableExtension("app/views/layouts/application.html.erb")).toBe(true);
    expect(hasParseableExtension("partial.erb")).toBe(true);
    expect(hasParseableExtension("lib/theme_template/index.html.erb")).toBe(true);
  });

  test("the known-parseable extensions still return true alongside .erb", () => {
    // Spot-check the alias-table extensions to keep this test honest
    // about .erb joining the set rather than replacing anything.
    expect(hasParseableExtension("x.html")).toBe(true);
    expect(hasParseableExtension("x.tsx")).toBe(true);
    expect(hasParseableExtension("x.css")).toBe(true);
    expect(hasParseableExtension("x.scss")).toBe(true);
    expect(hasParseableExtension("x.less")).toBe(true);
    expect(hasParseableExtension("x.md")).toBe(true);
    expect(hasParseableExtension("x.svg")).toBe(true);
  });

  test(".xhtml is parseable — XML-serialized HTML routes through parseHtml", () => {
    // `.xhtml` is rejected as `file-unsupported` if missing from the
    // allow-list while sibling `.html` is accepted; both are equivalent
    // input shapes. See `src/utils/path.ts::EXTENSION_ALIASES`.
    expect(hasParseableExtension("page.xhtml")).toBe(true);
    expect(hasParseableExtension("docs/index.xhtml")).toBe(true);
  });

  test(".php / .phtml are parseable — PHP server pages route through parsePhp", () => {
    // PHP server pages (Laravel views, WordPress themes, hand-rolled
    // `.phtml` scaffolds) carry HTML markup outside their PHP islands.
    // Rejecting them while accepting `.html` silently drops valid input.
    expect(hasParseableExtension("resources/views/welcome.blade.php")).toBe(true);
    expect(hasParseableExtension("templates/header.phtml")).toBe(true);
    expect(hasParseableExtension("index.php")).toBe(true);
  });

  test(".mkdn is parseable — alternate Markdown extension routes through parseMarkdown", () => {
    // `.mkdn` is a common alternate Markdown extension (Vim, older
    // static-site generators); rejecting it while accepting `.markdown`
    // silently drops valid input.
    expect(hasParseableExtension("README.mkdn")).toBe(true);
    expect(hasParseableExtension("docs/intro.mkdn")).toBe(true);
  });

  test("unknown extensions are still rejected", () => {
    expect(hasParseableExtension("x.rb")).toBe(false);
    expect(hasParseableExtension("x.svelte")).toBe(false);
    expect(hasParseableExtension("x.vue")).toBe(false);
  });
});

describe("isStorybookStoryFile", () => {
  test("matches .stories and .story with every supported JSX/TS extension", () => {
    expect(isStorybookStoryFile("Button.stories.tsx")).toBe(true);
    expect(isStorybookStoryFile("Button.stories.jsx")).toBe(true);
    expect(isStorybookStoryFile("Button.stories.ts")).toBe(true);
    expect(isStorybookStoryFile("Button.stories.js")).toBe(true);
    expect(isStorybookStoryFile("Button.story.tsx")).toBe(true);
    expect(isStorybookStoryFile("Button.story.js")).toBe(true);
  });

  test("matches on absolute paths and nested POSIX paths", () => {
    expect(isStorybookStoryFile("/repo/src/components/Button.stories.tsx")).toBe(true);
    expect(isStorybookStoryFile("src/ui/icons/Icon.stories.tsx")).toBe(true);
  });

  test("matches on Windows-style backslash paths", () => {
    expect(isStorybookStoryFile("C:\\repo\\src\\Button.stories.tsx")).toBe(true);
  });

  test("does not match regular TSX files", () => {
    expect(isStorybookStoryFile("Button.tsx")).toBe(false);
    expect(isStorybookStoryFile("src/Button.test.tsx")).toBe(false);
    expect(isStorybookStoryFile("src/Button.spec.tsx")).toBe(false);
  });

  test("does not match non-JSX extensions even with the .stories marker", () => {
    expect(isStorybookStoryFile("Button.stories.md")).toBe(false);
    expect(isStorybookStoryFile("stories.css")).toBe(false);
  });

  test("is case-sensitive on the .stories / .story marker", () => {
    expect(isStorybookStoryFile("Button.Stories.tsx")).toBe(false);
  });
});

describe("isTestFilePath", () => {
  test("matches .test and .spec on every supported JSX/TS extension", () => {
    expect(isTestFilePath("Button.test.tsx")).toBe(true);
    expect(isTestFilePath("Button.test.jsx")).toBe(true);
    expect(isTestFilePath("Button.test.ts")).toBe(true);
    expect(isTestFilePath("Button.test.js")).toBe(true);
    expect(isTestFilePath("Button.spec.tsx")).toBe(true);
    expect(isTestFilePath("Button.spec.js")).toBe(true);
  });

  test("matches absolute and nested POSIX paths", () => {
    expect(isTestFilePath("/repo/src/Button.test.tsx")).toBe(true);
    expect(isTestFilePath("src/components/Button.spec.ts")).toBe(true);
  });

  test("matches Windows-style backslash paths", () => {
    expect(isTestFilePath("C:\\repo\\src\\Button.test.tsx")).toBe(true);
    expect(isTestFilePath("src\\__tests__\\Button.js")).toBe(true);
  });

  test("matches __tests__ / __mocks__ / tests as path segments", () => {
    expect(isTestFilePath("src/__tests__/Button.js")).toBe(true);
    expect(isTestFilePath("src/__mocks__/Button.ts")).toBe(true);
    expect(isTestFilePath("tests/keyboard/foo.tsx")).toBe(true);
    expect(isTestFilePath("packages/ui/src/__tests__/foo.test.tsx")).toBe(true);
  });

  test("does not match plain source files", () => {
    expect(isTestFilePath("Button.tsx")).toBe(false);
    expect(isTestFilePath("src/components/Button.tsx")).toBe(false);
    expect(isTestFilePath("app.js")).toBe(false);
    expect(isTestFilePath("index.html")).toBe(false);
  });

  test("does not match story files (those have their own predicate)", () => {
    expect(isTestFilePath("Button.stories.tsx")).toBe(false);
  });

  test("does not match non-JSX/TS extensions with .test/.spec markers", () => {
    expect(isTestFilePath("foo.test.md")).toBe(false);
    expect(isTestFilePath("README.spec.css")).toBe(false);
  });

  test("requires `tests` to be a complete path segment, not a substring", () => {
    // `integrationtests.ts` at the root has no `tests/` segment.
    expect(isTestFilePath("integrationtests.tsx")).toBe(false);
    expect(isTestFilePath("src/integrationtests.tsx")).toBe(false);
    // `mytests/` is also not a segment match — only the literal `tests` segment matches.
    expect(isTestFilePath("src/mytests/foo.ts")).toBe(false);
  });
});

describe("toPosix", () => {
  test("converts backslashes to forward slashes", () => {
    expect(toPosix("src\\app\\page.tsx")).toBe("src/app/page.tsx");
    expect(toPosix("C:\\repo\\src\\Button.tsx")).toBe("C:/repo/src/Button.tsx");
  });

  test("idempotent on POSIX paths", () => {
    expect(toPosix("src/app/page.tsx")).toBe("src/app/page.tsx");
    expect(toPosix("/repo/src/Button.tsx")).toBe("/repo/src/Button.tsx");
    expect(toPosix("./relative/file.ts")).toBe("./relative/file.ts");
  });

  test("handles mixed separators", () => {
    expect(toPosix("src\\app/page.tsx")).toBe("src/app/page.tsx");
    expect(toPosix("src/app\\page.tsx")).toBe("src/app/page.tsx");
  });

  test("handles edge cases", () => {
    expect(toPosix("")).toBe("");
    expect(toPosix("a")).toBe("a");
    expect(toPosix("\\")).toBe("/");
    expect(toPosix("\\\\")).toBe("//");
  });
});

describe("posixJoin", () => {
  test("returns POSIX path on POSIX-only systems (matches native semantics)", () => {
    // `node:path` `join` already produces POSIX on POSIX hosts; the
    // wrapper is a no-op there. The added value is the Windows path —
    // since we can't rely on the host OS in tests, we instead pin that
    // the wrapper's output equals `toPosix(join(...))` for any input.
    expect(posixJoin("src", "app", "page.tsx")).toBe(toPosix(join("src", "app", "page.tsx")));
    expect(posixJoin("/repo", "src")).toBe(toPosix(join("/repo", "src")));
  });

  test("collapses .. segments like native join", () => {
    expect(posixJoin("src", "app", "..", "page.tsx")).toBe("src/page.tsx");
  });

  test("output never contains a backslash regardless of input", () => {
    expect(posixJoin("src\\foo", "bar")).not.toContain("\\");
    expect(posixJoin("a", "b\\c", "d")).not.toContain("\\");
  });
});

describe("posixResolve", () => {
  test("returns POSIX absolute path with no backslashes", () => {
    expect(posixResolve("src", "app")).not.toContain("\\");
    expect(posixResolve("/repo", "src")).toBe("/repo/src");
  });

  test("matches toPosix(resolve(...)) semantics", () => {
    expect(posixResolve("src", "app")).toBe(toPosix(resolve("src", "app")));
    expect(posixResolve("/repo")).toBe(toPosix(resolve("/repo")));
  });
});

describe("posixRelative", () => {
  test("returns POSIX-shaped relative path", () => {
    expect(posixRelative("/repo/src", "/repo/src/app/page.tsx")).toBe("app/page.tsx");
    expect(posixRelative("/repo", "/repo/src/app")).toBe("src/app");
  });

  test("matches toPosix(relative(...)) semantics", () => {
    expect(posixRelative("/repo/src", "/repo/src/app/page.tsx")).toBe(
      toPosix(relative("/repo/src", "/repo/src/app/page.tsx")),
    );
  });

  test("output never contains a backslash", () => {
    expect(posixRelative("/repo/src", "/repo/src/a/b/c.ts")).not.toContain("\\");
  });
});

describe("posixDirname", () => {
  test("returns POSIX-shaped parent directory", () => {
    expect(posixDirname("src/app/page.tsx")).toBe("src/app");
    expect(posixDirname("/repo/src/app/page.tsx")).toBe("/repo/src/app");
  });

  test("matches toPosix(dirname(...)) semantics", () => {
    expect(posixDirname("src/app/page.tsx")).toBe(toPosix(dirname("src/app/page.tsx")));
  });

  test("output never contains a backslash even on backslash input", () => {
    // `node:path` `dirname` on POSIX treats backslashes as part of the
    // basename, so the wrapper's normalization is what produces the
    // POSIX shape. Pinning the no-backslash invariant rather than the
    // exact return string keeps the test cross-platform-honest.
    expect(posixDirname("src\\app\\page.tsx")).not.toContain("\\");
  });
});
