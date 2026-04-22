/**
 * Candidate finder: review/multiple-ways
 * Criteria: wcag22:2.4.5, wcag21:2.4.5, section508:2.4.5, en301549:9.2.4.5
 * Spec: https://www.w3.org/TR/WCAG22/#multiple-ways
 *
 * Flags likely root-layout files that expose none of four common
 * "multiple ways" signals: a search mechanism, a sitemap link, a
 * navigation landmark with multiple direct links, or a breadcrumb.
 * WCAG 2.4.5 is page-set level, so this finder uses root-layout files
 * as the narrowest static proxy.
 *
 * Review finder - biased toward false positives. Output is a checklist
 * of files to verify, not a list of failures.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import type { FileContext, Language } from "../../types/rule.ts";

const CRITERION_IDS = [
  "wcag22:2.4.5",
  "wcag21:2.4.5",
  "section508:2.4.5",
  "en301549:9.2.4.5",
] as const;

const ROOT_LAYOUT_FILE_RE = /(?:^|[\\/])(?:layout|_app|app|root)\.[jt]sx?$/i;
const SITEMAP_RE = /site-?map/i;
const BREADCRUMB_RE = /breadcrumb/i;
const DIRECT_NAV_LINK_MIN = 3;

export const finder = defineCandidateFinder({
  id: "review/multiple-ways",
  criterionIds: [...CRITERION_IDS],
  scope: "document",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx", ".ts", ".js"] },
  // 2.4.5 is page-set level. One question for the whole project, not
  // one per root-layout file — multi-root projects (e.g. a Jinja
  // shell serving a React SPA) otherwise get the same prompt three or
  // four times.
  uniquePerCriterion: true,
  docs: {
    description:
      "Finds likely root-layout files that show no search, sitemap, breadcrumb, or multi-link navigation signal, which may mean users only have one way to locate pages.",
    reviewPrompt:
      "Verify the page set offers more than one way to locate pages, such as search, a sitemap, a breadcrumb trail, or a substantial navigation menu. This check uses a root-layout proxy, so if the alternative mechanism is injected elsewhere, confirm it still reaches users consistently.",
    references: [
      "https://www.w3.org/TR/WCAG22/#multiple-ways",
      "https://www.w3.org/WAI/WCAG22/Understanding/multiple-ways.html",
    ],
  },
  afterFile(ctx) {
    if (ctx.language === "html") {
      return findHtmlCandidates(ctx, ctx.ast as HtmlDocument);
    }
    if (!isJsLike(ctx.language)) return;
    return findJsxCandidates(ctx, ctx.ast as TsxModule);
  },
});

function findHtmlCandidates(ctx: FileContext, root: HtmlDocument): readonly ReviewCandidate[] {
  if (!looksLikeHtmlRootLayout(root, ctx.filePath)) return [];
  if (hasHtmlMultipleWaysSignal(root)) return [];
  const location = firstHtmlLocation(root);
  // SPA index shells (Vite/CRA/React Router root) carry no navigation
  // signal because the nav lives in JS. Annotate the candidate so the
  // agent redirects its review to the router config instead of trying
  // to fix "missing nav" in the index HTML.
  //
  // Standalone single-page HTML files (hobby sites, form-only pages,
  // a single prototype) also carry no multi-page signal by definition
  // — SC 2.4.5 scopes to "sets of Web pages", so the criterion may
  // not apply at all. The deterministic in-file signal is the absence
  // of any anchor whose href targets a sibling HTML page. Per
  // AI-first doctrine we never suppress on a heuristic — the
  // candidate stays in the primary list; the reason string picks up
  // additive context so the agent can dismiss a genuinely standalone
  // file in one read. SPA shells get their own annotation (emptier
  // evidence: no outbound links AND a mount-div + module-script pair)
  // and take precedence over the generic single-page hint.
  const annotation = pickHtmlAnnotation(root);
  const signals = summarizeHtmlSignals(root);
  return candidatesForAllCriteria(
    ctx.filePath,
    location.line,
    location.column,
    signals,
    annotation,
  );
}

function pickHtmlAnnotation(root: HtmlDocument): string | null {
  if (looksLikeSpaShell(root)) return SPA_SHELL_HINT;
  if (!hasSiblingHtmlPageLink(root)) return SINGLE_PAGE_SCOPE_HINT;
  return null;
}

function findJsxCandidates(ctx: FileContext, root: TsxModule): readonly ReviewCandidate[] {
  if (!looksLikeJsxRootLayout(root, ctx.filePath)) return [];
  if (hasJsxMultipleWaysSignal(root)) return [];
  const location = firstJsxLocation(root);
  const signals = summarizeJsxSignals(root);
  return candidatesForAllCriteria(ctx.filePath, location.line, location.column, signals);
}

function isJsLike(language: Language): boolean {
  return language === "tsx" || language === "jsx" || language === "ts" || language === "js";
}

function looksLikeHtmlRootLayout(root: HtmlDocument, filePath: string): boolean {
  if (matchesRootLayoutFile(filePath)) return true;
  const first = firstHtmlElement(root);
  return first?.tagName.toLowerCase() === "html";
}

function looksLikeJsxRootLayout(root: TsxModule, filePath: string): boolean {
  if (matchesRootLayoutFile(filePath)) return true;
  const first = root.jsxElements[0];
  if (!first) return false;
  return first.tagName === "html" || first.tagName === "RootLayout" || first.tagName === "Layout";
}

function matchesRootLayoutFile(filePath: string): boolean {
  return ROOT_LAYOUT_FILE_RE.test(filePath);
}

function hasHtmlMultipleWaysSignal(root: HtmlDocument): boolean {
  return (
    hasHtmlSearchSignal(root) ||
    hasHtmlSitemapSignal(root) ||
    hasHtmlNavigationSignal(root) ||
    hasHtmlBreadcrumbSignal(root)
  );
}

function hasJsxMultipleWaysSignal(root: TsxModule): boolean {
  return (
    hasJsxSearchSignal(root) ||
    hasJsxSitemapSignal(root) ||
    hasJsxNavigationSignal(root) ||
    hasJsxBreadcrumbSignal(root)
  );
}

function hasHtmlSearchSignal(root: HtmlDocument): boolean {
  for (const el of walkHtmlElements(root)) {
    if (isHtmlSearchInput(el) || isHtmlSearchForm(el)) return true;
  }
  return false;
}

function hasJsxSearchSignal(root: TsxModule): boolean {
  for (const el of walkJsxElements(root)) {
    if (isJsxSearchInput(el) || isJsxSearchForm(el)) return true;
  }
  return false;
}

function hasHtmlSitemapSignal(root: HtmlDocument): boolean {
  for (const el of walkHtmlElements(root)) {
    if (hasSitemapTarget(getHtmlAttribute(el, "href"))) return true;
    if (hasSitemapTarget(getHtmlAttribute(el, "to"))) return true;
    if (hasSitemapTarget(getHtmlAttribute(el, "path"))) return true;
  }
  return false;
}

function hasJsxSitemapSignal(root: TsxModule): boolean {
  for (const el of walkJsxElements(root)) {
    if (hasSitemapTarget(getJsxAttributeString(el, "href"))) return true;
    if (hasSitemapTarget(getJsxAttributeString(el, "to"))) return true;
    if (hasSitemapTarget(getJsxAttributeString(el, "path"))) return true;
  }
  return false;
}

function hasHtmlNavigationSignal(root: HtmlDocument): boolean {
  for (const el of walkHtmlElements(root)) {
    if (isHtmlNavigationContainer(el) && countDirectHtmlAnchors(el) >= DIRECT_NAV_LINK_MIN) {
      return true;
    }
  }
  return false;
}

function hasJsxNavigationSignal(root: TsxModule): boolean {
  for (const el of walkJsxElements(root)) {
    if (isJsxNavigationContainer(el) && countDirectJsxAnchors(el) >= DIRECT_NAV_LINK_MIN) {
      return true;
    }
  }
  return false;
}

function hasHtmlBreadcrumbSignal(root: HtmlDocument): boolean {
  for (const el of walkHtmlElements(root)) {
    if (normalizeLower(getHtmlAttribute(el, "aria-label")) === "breadcrumb") return true;
  }
  return false;
}

function hasJsxBreadcrumbSignal(root: TsxModule): boolean {
  for (const el of walkJsxElements(root)) {
    if (BREADCRUMB_RE.test(el.tagName)) return true;
    if (normalizeLower(getJsxAttributeString(el, "aria-label")) === "breadcrumb") return true;
  }
  return false;
}

function isHtmlSearchInput(el: HtmlElement): boolean {
  return (
    el.tagName.toLowerCase() === "input" &&
    normalizeLower(getHtmlAttribute(el, "type")) === "search"
  );
}

function isHtmlSearchForm(el: HtmlElement): boolean {
  return (
    el.tagName.toLowerCase() === "form" && normalizeLower(getHtmlAttribute(el, "role")) === "search"
  );
}

function isJsxSearchInput(el: JsxElement): boolean {
  return el.tagName === "input" && normalizeLower(getJsxAttributeString(el, "type")) === "search";
}

function isJsxSearchForm(el: JsxElement): boolean {
  return el.tagName === "form" && normalizeLower(getJsxAttributeString(el, "role")) === "search";
}

function hasSitemapTarget(value: string | null): boolean {
  return value !== null && SITEMAP_RE.test(value);
}

function isHtmlNavigationContainer(el: HtmlElement): boolean {
  return (
    el.tagName.toLowerCase() === "nav" ||
    normalizeLower(getHtmlAttribute(el, "role")) === "navigation"
  );
}

function isJsxNavigationContainer(el: JsxElement): boolean {
  return el.tagName === "nav" || normalizeLower(getJsxAttributeString(el, "role")) === "navigation";
}

function countDirectHtmlAnchors(el: HtmlElement): number {
  let count = 0;
  for (const child of el.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() === "a") count += 1;
  }
  return count;
}

function countDirectJsxAnchors(el: JsxElement): number {
  let count = 0;
  for (const child of el.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName === "a") count += 1;
  }
  return count;
}

function firstHtmlElement(root: HtmlDocument): HtmlElement | null {
  for (const child of root.children) {
    if (child.kind === "HtmlElement") return child;
  }
  return null;
}

function firstHtmlLocation(root: HtmlDocument): { line: number; column: number } {
  const first = firstHtmlElement(root);
  if (!first) return { line: 1, column: 1 };
  return { line: first.loc.start.line, column: first.loc.start.column };
}

function firstJsxLocation(root: TsxModule): { line: number; column: number } {
  const first = root.jsxElements[0];
  if (!first) return { line: 1, column: 1 };
  return { line: first.loc.start.line, column: first.loc.start.column };
}

function normalizeLower(value: string | null): string | null {
  return value?.trim().toLowerCase() ?? null;
}

function candidatesForAllCriteria(
  filePath: string,
  line: number,
  column: number,
  signals: SignalSummary,
  annotation: string | null = null,
): readonly ReviewCandidate[] {
  // Base prose stays stable; counted signals get appended so the
  // agent can dismiss a test-harness or empty shell without reopening
  // the file. Per AI-first doctrine, the numbers are additive context
  // — not a suppression threshold.
  const base =
    "Likely root layout has no search, sitemap, breadcrumb, or 3-link navigation signal; verify users have more than one way to locate pages";
  const counts = formatSignalSummary(signals);
  const withCounts = `${base} (${counts})`;
  const reason = annotation === null ? withCounts : `${withCounts} — ${annotation}`;
  // Confidence "low": the finder infers the root-layout role from
  // filename/root-tag heuristics, and the "no multiple-ways signal"
  // determination rides on a small set of structural proxies
  // (search input, sitemap href, breadcrumb aria-label, ≥3 direct
  // nav anchors) that legitimate layouts can route through other
  // files. Biased toward false positives — the candidate is a prompt
  // to verify, not a failure claim.
  return CRITERION_IDS.map((criterionId) => ({
    criterionId,
    location: { filePath, line, column },
    reason,
    confidence: "low" as const,
  }));
}

interface SignalSummary {
  readonly navCount: number;
  readonly linkCount: number;
  readonly hasSearch: boolean;
  readonly hasBreadcrumb: boolean;
  readonly hasSitemapLink: boolean;
}

function summarizeHtmlSignals(root: HtmlDocument): SignalSummary {
  let navCount = 0;
  let linkCount = 0;
  let hasSearch = false;
  let hasBreadcrumb = false;
  let hasSitemapLink = false;
  for (const el of walkHtmlElements(root)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "nav") navCount += 1;
    if (tag === "a") linkCount += 1;
    if (!hasSearch && isHtmlSearchElement(el)) hasSearch = true;
    if (!hasBreadcrumb && isHtmlBreadcrumbElement(el)) hasBreadcrumb = true;
    if (!hasSitemapLink && isHtmlSitemapLink(el)) hasSitemapLink = true;
  }
  return { navCount, linkCount, hasSearch, hasBreadcrumb, hasSitemapLink };
}

function summarizeJsxSignals(root: TsxModule): SignalSummary {
  let navCount = 0;
  let linkCount = 0;
  let hasSearch = false;
  let hasBreadcrumb = false;
  let hasSitemapLink = false;
  for (const el of walkJsxElements(root)) {
    if (el.tagName === "nav") navCount += 1;
    if (el.tagName === "a") linkCount += 1;
    if (!hasSearch && isJsxSearchElement(el)) hasSearch = true;
    if (!hasBreadcrumb && isJsxBreadcrumbElement(el)) hasBreadcrumb = true;
    if (!hasSitemapLink && isJsxSitemapLink(el)) hasSitemapLink = true;
  }
  return { navCount, linkCount, hasSearch, hasBreadcrumb, hasSitemapLink };
}

function isHtmlSearchElement(el: HtmlElement): boolean {
  return isHtmlSearchInput(el) || isHtmlSearchForm(el);
}

function isHtmlBreadcrumbElement(el: HtmlElement): boolean {
  return normalizeLower(getHtmlAttribute(el, "aria-label")) === "breadcrumb";
}

function isHtmlSitemapLink(el: HtmlElement): boolean {
  return (
    hasSitemapTarget(getHtmlAttribute(el, "href")) ||
    hasSitemapTarget(getHtmlAttribute(el, "to")) ||
    hasSitemapTarget(getHtmlAttribute(el, "path"))
  );
}

function isJsxSearchElement(el: JsxElement): boolean {
  return isJsxSearchInput(el) || isJsxSearchForm(el);
}

function isJsxBreadcrumbElement(el: JsxElement): boolean {
  return (
    BREADCRUMB_RE.test(el.tagName) ||
    normalizeLower(getJsxAttributeString(el, "aria-label")) === "breadcrumb"
  );
}

function isJsxSitemapLink(el: JsxElement): boolean {
  return (
    hasSitemapTarget(getJsxAttributeString(el, "href")) ||
    hasSitemapTarget(getJsxAttributeString(el, "to")) ||
    hasSitemapTarget(getJsxAttributeString(el, "path"))
  );
}

function formatSignalSummary(s: SignalSummary): string {
  return [
    `${s.navCount} <nav>`,
    `${s.linkCount} <a>`,
    s.hasSearch ? "has <input type='search'>" : "no <input type='search'>",
    s.hasBreadcrumb ? "has breadcrumb" : "no breadcrumb",
    s.hasSitemapLink ? "has sitemap link" : "no sitemap link",
  ].join(", ");
}

const SPA_SHELL_HINT =
  "this HTML looks like an SPA index shell (root mount div + module bundle script); navigation likely lives in the client-side router config, not this file";

const SINGLE_PAGE_SCOPE_HINT =
  "no anchors target a sibling HTML page from this file — SC 2.4.5 applies to sets of Web pages, so if this is a standalone single-page file or SPA, the criterion may not apply; verify whether the scanned file is part of a multi-page set";

const HTML_PAGE_HREF_RE = /\.html?(?:$|[?#])/i;
const NON_NAVIGABLE_SCHEME_RE = /^(?:mailto:|tel:|sms:|javascript:|data:|blob:|about:)/i;

/**
 * Does any anchor in the file link to what looks like a sibling HTML
 * page? A positive signal means the file participates in a multi-page
 * set (the classic `<a href="about.html">` chain) and the generic
 * single-page-scope hint does not apply. Fragment-only (`#id`),
 * mailto/tel/javascript, and external URLs (http(s)://) do not count
 * — only same-origin paths ending in `.html`/`.htm`. The check is
 * intentionally narrow: we want a *deterministic* yes/no, not a
 * heuristic about "probably another page on this site." If the author
 * links to routes without an extension (`/about`, `/pricing`), the
 * finder falls back to the single-page hint — which is honest, since
 * from the HTML alone we can't tell whether `/about` is a sibling
 * static file or a client-side route.
 */
function hasSiblingHtmlPageLink(root: HtmlDocument): boolean {
  for (const el of walkHtmlElements(root)) {
    if (el.tagName.toLowerCase() !== "a") continue;
    const href = getHtmlAttribute(el, "href");
    if (!isSiblingHtmlPageHref(href)) continue;
    return true;
  }
  return false;
}

function isSiblingHtmlPageHref(href: string | null): boolean {
  if (href === null) return false;
  const trimmed = href.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("#")) return false;
  if (NON_NAVIGABLE_SCHEME_RE.test(trimmed)) return false;
  // External URLs (http(s)://, //cdn...) point to some other domain's
  // page set, not ours. A single-page file might legitimately link
  // out to external docs without becoming "multi-page."
  if (/^(?:https?:)?\/\//i.test(trimmed)) return false;
  return HTML_PAGE_HREF_RE.test(trimmed);
}

const SPA_MOUNT_ID_RE = /^(?:root|app|__next|___gatsby|main|mount)$/;

/**
 * Structural signals that this HTML is the index shell for a
 * client-rendered SPA (Vite/CRA/Next pages-router/Gatsby). Two markers
 * together — an empty or near-empty mount `<div id="...">` and a
 * module script loading a JS bundle — are a reliable structural
 * classifier. No filename heuristics; the decision is made from HTML
 * content only so templates named `index.html` that actually contain
 * server-rendered content don't get annotated.
 */
function looksLikeSpaShell(root: HtmlDocument): boolean {
  let hasMountDiv = false;
  let hasModuleScript = false;
  for (const el of walkHtmlElements(root)) {
    if (!hasMountDiv && isSpaMountDiv(el)) hasMountDiv = true;
    if (!hasModuleScript && isModuleBundleScript(el)) hasModuleScript = true;
    if (hasMountDiv && hasModuleScript) return true;
  }
  return false;
}

function isSpaMountDiv(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "div") return false;
  const id = normalizeLower(getHtmlAttribute(el, "id"));
  if (id === null || !SPA_MOUNT_ID_RE.test(id)) return false;
  // A root div with substantial children is probably a real rendered
  // page that just happens to use id="app", not an SPA shell.
  return hasOnlyTrivialContent(el);
}

function hasOnlyTrivialContent(el: HtmlElement): boolean {
  for (const child of el.children) {
    if (child.kind !== "HtmlElement") continue;
    const tag = child.tagName.toLowerCase();
    // Noscript fallback and inline comments are common even in SPA
    // shells; anything else means the page has real content.
    if (tag !== "noscript") return false;
  }
  return true;
}

function isModuleBundleScript(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "script") return false;
  const type = normalizeLower(getHtmlAttribute(el, "type"));
  const src = getHtmlAttribute(el, "src");
  // Vite emits `type="module"` with an `/src/...` or `/assets/...`
  // src. CRA/Gatsby emit non-module chunk scripts; covered by a
  // wider /static/js/ or /build/ src pattern below.
  if (type === "module" && src !== null) return true;
  if (src === null) return false;
  return /\/(?:assets|static\/js|build|_next)\//.test(src);
}
