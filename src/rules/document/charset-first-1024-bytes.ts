/**
 * Rule: document/charset-first-1024-bytes
 * Satisfies: wcag21:4.1.1, wcag22:1.3.1, wcag21:1.3.1
 * Spec: https://html.spec.whatwg.org/multipage/semantics.html#charset
 *       https://www.w3.org/TR/WCAG21/#parsing
 *       https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > The element containing the character encoding declaration must be
 * > serialized completely within the first 1024 bytes of the document.
 *
 * Source: https://html.spec.whatwg.org/multipage/semantics.html#charset
 *
 * Browsers sniff encoding from the first 1024 bytes. A late or missing
 * declaration means the prefix was already decoded under the wrong
 * assumption, so non-ASCII text — including the text screen readers
 * relay — can render as mojibake. Fires three distinct ways:
 *   - no charset meta anywhere
 *   - meta is present but not the first element child of <head>
 *   - meta is the first child but serialized past byte 1024 (a long
 *     prolog or comment block pushed it out of range)
 *
 * Both `<meta charset="…">` and the legacy
 * `<meta http-equiv="Content-Type" content="text/html; charset=…">`
 * form are accepted; both are subject to the same constraints.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  getHtmlAttribute,
  truncateForEcho,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, HtmlNode } from "../../types/ast.ts";

/** HTML spec cap — `<meta charset>` must be serialized within this many bytes. */
const CHARSET_BYTE_CAP = 1024;

const UTF8 = new TextEncoder();

export const rule = defineRule({
  id: "document/charset-first-1024-bytes",
  satisfies: ["wcag21:4.1.1", "wcag22:1.3.1", "wcag21:1.3.1"],
  severity: "error",
  scope: "document",
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "<meta charset> must be the first child of <head> and serialized within the first 1024 bytes. HTML §4.2.5.4 requires this so the UA can decode the rest of the document correctly; a late declaration means earlier bytes were already decoded under the wrong encoding.",
    rationale:
      "Browsers sniff the document's encoding from the first 1024 bytes. If the charset declaration arrives later — or is missing entirely — the prefix is decoded under a guessed encoding and text renders as mojibake. Screen readers read the same mis-rendered text, so the programmatic information in the document is corrupted. Parsing (WCAG 2.1 4.1.1) and Info and Relationships (WCAG 1.3.1) both fail.",
    goodExample: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Hello</title>
  </head>
</html>`,
    badExample: `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Hello</title>
    <meta charset="utf-8">
  </head>
</html>`,
    normativeQuote:
      "The element containing the character encoding declaration must be serialized completely within the first 1024 bytes of the document.",
    references: [
      "https://html.spec.whatwg.org/multipage/semantics.html#charset",
      "https://www.w3.org/TR/WCAG21/#parsing",
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    const head = findHead(doc);
    if (!head) {
      // Documents without a <head> are a different problem (covered by
      // other rules around document structure). Don't double-flag.
      return;
    }
    const source = ctx.source;

    const charsetMeta = findCharsetMeta(doc);
    if (!charsetMeta) {
      ctx.emit({
        severity: "error",
        location: {
          filePath: "",
          line: head.loc.start.line,
          column: head.loc.start.column,
        },
        message:
          '<head> has no character-encoding declaration — add <meta charset="utf-8"> as the first child of <head>.',
        suggestion:
          'Add `<meta charset="utf-8">` as the very first element inside <head>. Without it, browsers guess the encoding from the first 1024 bytes, and any non-ASCII text (including text read by screen readers) may be decoded as mojibake.',
      });
      return;
    }

    const firstElementChild = firstElementChildOf(head);
    if (firstElementChild !== charsetMeta) {
      const precededBy = describePreceding(head, charsetMeta);
      ctx.emit({
        severity: "error",
        location: {
          filePath: "",
          line: charsetMeta.loc.start.line,
          column: charsetMeta.loc.start.column,
        },
        message: `Character-encoding <meta> is not the first child of <head>${precededBy ? ` — it is preceded by ${precededBy}` : ""}.`,
        suggestion: `Move this <meta> so it is the first element child of <head>, ahead of ${precededBy || "any other elements"}. The HTML parser needs the encoding declaration before it finishes decoding the bytes that follow.`,
      });
      return;
    }

    const endByte = utf8ByteLengthUpTo(source, charsetMeta.range.end);
    if (endByte > CHARSET_BYTE_CAP) {
      const pushedBy = describePushers(doc, head);
      ctx.emit({
        severity: "error",
        location: {
          filePath: "",
          line: charsetMeta.loc.start.line,
          column: charsetMeta.loc.start.column,
        },
        message: `Character-encoding <meta> ends at byte ${endByte}, past the 1024-byte cap required by HTML §4.2.5.4.`,
        suggestion: `Shrink the content preceding this <meta> so its closing \`>\` lands within the first 1024 bytes${pushedBy ? ` (currently pushed down by ${pushedBy})` : ""}. Common fixes: shorten the DOCTYPE preamble, remove large comment blocks before <head>, or move long <link>/<script> tags to after the charset declaration.`,
      });
    }
  },
});

/** Returns the `<head>` element, or `null` if the document has none. */
function findHead(doc: HtmlDocument): HtmlElement | null {
  const heads = findHtmlElementsByTag(doc, "head");
  return heads[0] ?? null;
}

/**
 * Finds the charset-declaring <meta> in the document. Matches both
 *   <meta charset="utf-8">
 * and the legacy
 *   <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
 * forms. Returns the first match in document order; a well-formed
 * document has exactly one.
 */
function findCharsetMeta(doc: HtmlDocument): HtmlElement | null {
  for (const meta of findHtmlElementsByTag(doc, "meta")) {
    if (isCharsetMeta(meta)) return meta;
  }
  return null;
}

function isCharsetMeta(meta: HtmlElement): boolean {
  if (getHtmlAttribute(meta, "charset") !== null) return true;
  const httpEquiv = getHtmlAttribute(meta, "http-equiv")?.toLowerCase();
  if (httpEquiv !== "content-type") return false;
  const content = getHtmlAttribute(meta, "content") ?? "";
  return /charset\s*=/i.test(content);
}

/** First element-kind child of `head`, skipping text/comments. */
function firstElementChildOf(head: HtmlElement): HtmlElement | null {
  for (const child of head.children) {
    if (child.kind === "HtmlElement") return child;
  }
  return null;
}

/**
 * Short, honest description of what precedes the charset meta inside
 * <head>. Returns `null` if nothing precedes it (defensive — callers
 * only ask when the meta is *not* the first element child).
 */
function describePreceding(head: HtmlElement, charsetMeta: HtmlElement): string | null {
  const parts: string[] = [];
  for (const child of head.children) {
    if (child === charsetMeta) break;
    if (child.kind === "HtmlElement") {
      parts.push(`<${child.tagName.toLowerCase()}>`);
    } else if (child.kind === "HtmlComment") {
      parts.push("a comment");
    }
    if (parts.length >= 2) break;
  }
  if (parts.length === 0) return null;
  return parts.join(", ");
}

/**
 * Short description of what's between byte 0 and <head> that's eating
 * the 1024-byte budget. Useful when the meta is correctly placed but
 * still past the cap because the prolog is large.
 *
 * Scans document-level siblings first; if <head> is nested inside
 * <html> (the usual case), falls back to scanning <html>'s children
 * up to <head> so we can still report `<script>` / `<link>` blocks
 * that preceded <head> inside <html>.
 */
function describePushers(doc: HtmlDocument, head: HtmlElement): string | null {
  const pushers = collectPushersBefore(doc.children, head);
  if (pushers.length > 0) return pushers.join(" + ");
  const html = findHtmlElementsByTag(doc, "html")[0];
  if (!html) return null;
  const nested = collectPushersBefore(html.children, head);
  return nested.length === 0 ? null : nested.join(" + ");
}

/**
 * Walks `siblings` until it reaches `stopAt`, collecting up to three
 * short descriptions of the nodes it passed. Pure, no side effects.
 */
function collectPushersBefore(
  siblings: readonly HtmlNode[],
  stopAt: HtmlElement,
): readonly string[] {
  const out: string[] = [];
  for (const child of siblings) {
    if (child === stopAt) break;
    const label = describeTopLevelNode(child);
    if (label) out.push(label);
    if (out.length >= 3) break;
  }
  return out;
}

function describeTopLevelNode(node: HtmlNode): string | null {
  if (node.kind === "HtmlDoctype") {
    return `a ${truncateForEcho(node.value, 32) || "doctype"} declaration`;
  }
  if (node.kind === "HtmlComment") {
    return "a comment block";
  }
  if (node.kind === "HtmlElement") {
    return `<${node.tagName.toLowerCase()}>`;
  }
  return null;
}

/**
 * UTF-8 byte length of the prefix `source[0 .. charIndex]`. The HTML
 * spec's 1024 is a byte count on the wire, not a character count, so
 * we re-encode rather than using the JS string index directly. A
 * source containing multi-byte characters before the charset meta
 * (e.g. a BOM, or a non-ASCII comment) will have a larger byte count
 * than character count, and counting chars would under-report.
 */
function utf8ByteLengthUpTo(source: string, charIndex: number): number {
  if (charIndex <= 0) return 0;
  const safeIndex = Math.min(charIndex, source.length);
  return UTF8.encode(source.slice(0, safeIndex)).length;
}
