import { describe, expect, test } from "bun:test";
import {
  extensionMatches,
  hasParseableExtension,
  isStorybookStoryFile,
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
