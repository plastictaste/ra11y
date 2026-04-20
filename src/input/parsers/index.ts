/**
 * Parser barrel — one entry point per input language. The scanner
 * dispatches to these based on file extension.
 */

export { parseAstro } from "./astro.ts";
export type { CssParseResult } from "./css.ts";
export { parseCss } from "./css.ts";
export type { HtmlParseResult } from "./html.ts";
export { parseHtml } from "./html.ts";
export { parseMdx } from "./mdx.ts";
export { parseScss } from "./scss.ts";
export type { TailwindToken } from "./tailwind.ts";
export { parseTailwind } from "./tailwind.ts";
export type { TsxParseResult } from "./tsx.ts";
export { parseTsx } from "./tsx.ts";
