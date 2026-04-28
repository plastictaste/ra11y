/**
 * In-house PHP parser — v0.1.x minimal adapter.
 *
 * A `.php` / `.phtml` file is a PHP server page: an HTML document with
 * embedded PHP islands delimited by `<?php … ?>` (long form), `<?= … ?>`
 * (short echo), or `<? … ?>` (short tags). The HTML markup outside the
 * islands carries the same a11y-relevant surface as a plain `.html`
 * file — DOCTYPE, `<html>`, landmarks, anchors, headings, form labels —
 * and it's exactly that surface a11y rules need to see. A faithful PHP
 * compiler would resolve includes, evaluate the islands, and splice
 * their output into the residue; doing any of that zero-dep is out of
 * reach.
 *
 * But the authoring surface a11y rules care about — `<img alt>`, `<a>`
 * text, headings, landmarks, `<button>` labels, contrast from inline
 * `<style>` — lives in the HTML region. So the minimum viable shape is:
 * strip the PHP islands, hand the HTML residue to `parseHtml`, return an
 * `HtmlParseResult`.
 *
 * Strategy (same adapter pattern as `parseAstro`): pre-transform the
 * PHP source into HTML-equivalent source, then delegate. The output is
 * an `HtmlParseResult` with exactly the AST shape the HTML parser emits,
 * so downstream rules need zero changes.
 *
 * Transform pass: walk the source, locate every `<?php … ?>` /
 * `<?= … ?>` / `<? … ?>` span, blank each span with whitespace of
 * equal length (preserving newlines and carriage returns) so downstream
 * line/column numbers match the original source. The HTML parser then
 * sees a stream of literal text where PHP used to be — same recovery
 * shape it already runs on Liquid/Jinja/ERB residue inside `.html.erb`
 * files.
 *
 * Why a dedicated adapter rather than letting `stripTemplateDirectives`
 * handle it inline (the way ERB is handled)? Two reasons:
 *
 *   1. Position-independence. ERB `<%= … %>` only appears inside text
 *      nodes — `stripTemplateDirectives` is invoked per text node and
 *      handles the span there. PHP `<?php … ?>` blocks routinely span
 *      across structural HTML boundaries: between tags
 *      (`<?php if (…): ?> <ul> <?php endif; ?>`), inside attribute
 *      positions (`<input type="<?= $type ?>" />`), and across the
 *      DOCTYPE / `<html>` / `<body>` envelope. Stripping at the
 *      text-node layer would leave the parser to swallow `<?php` as a
 *      tag opener and corrupt every downstream tree.
 *   2. Telemetry. The `php_islands_stripped` warning fires when this
 *      adapter found at least one PHP block, so an agent reading the
 *      response sees the parser-level evidence that PHP residue was
 *      processed (rather than dropping the file at discovery — the
 *      historical behavior before `.php` joined PARSEABLE_EXTENSIONS).
 *
 * Handled island shapes (in detection order):
 *
 *   - `<?php … ?>` — canonical long-form opener. Body may span multiple
 *     lines and contain `?>` only inside string literals; the simple
 *     "first `?>` after the opener" closer handles every real-world PHP
 *     page well enough — string-literal `?>` is rare in HTML-output
 *     PHP and at worst leaves a tiny tail of literal text after the
 *     close marker, which the HTML parser tolerates.
 *   - `<?= … ?>` — short echo. Same closer. Common in template-style
 *     PHP for inline interpolation (`<title><?= $title ?></title>`).
 *   - `<? … ?>` — short tag. Same closer. Disabled by `short_open_tag`
 *     in many php.ini configurations but historically widespread; we
 *     strip it for parity with the long form. NOT confused with the
 *     XHTML `<?xml ... ?>` prologue: the XML prologue uses `<?xml`
 *     which the long-form `<?php` and short-echo `<?=` cannot match,
 *     and the short-tag predicate explicitly excludes `<?xml` (the
 *     only file shape where `<?` opens something that isn't a PHP
 *     island).
 *
 * Like every ra11y parser: never throws. Returns a partial tree plus
 * `ParseError[]` — the only parser-level error this adapter can emit
 * is an unterminated PHP block (no `?>` before EOF), flagged
 * `recoverable: true`. The remainder past the unclosed opener is
 * blanked too, so downstream rules see the structurally-valid HTML
 * prefix instead of mis-parsing PHP source as tag soup.
 *
 * Out of scope (honest pass-through):
 *   - PHP expression evaluation (`<?= htmlspecialchars($x) ?>` blanks
 *     to whitespace; the rendered string is unobservable).
 *   - PHP include / require resolution (the included file's HTML never
 *     reaches this scan; `additionalPaths` or a wider scope handles it).
 *   - Heredoc / nowdoc strings inside PHP blocks — they're inside the
 *     PHP island so they get blanked along with everything else.
 *   - PHP-only files (no HTML at all) — they parse to an empty HTML
 *     tree, which is honest. Any included files are scoped through
 *     additional paths.
 */

import type { ParseError } from "../../types/ast.ts";
import { type HtmlParseResult, parseHtml } from "./html.ts";

/**
 * Output of {@link parsePhp}: an {@link HtmlParseResult} (root + errors)
 * augmented with a parser-level signal that at least one PHP island was
 * stripped from the source. Callers feed `phpIslandsStripped` into the
 * scan-confidence telemetry channel so the `php_islands_stripped`
 * warning code can fire when it's true.
 */
export interface PhpParseResult extends HtmlParseResult {
  /**
   * True when the adapter found and blanked at least one PHP island
   * (`<?php … ?>`, `<?= … ?>`, or `<? … ?>`) in the source. False when
   * the input was pure HTML with no PHP residue at all (legitimate for
   * `.phtml` files that happen to ship without any embedded PHP).
   */
  readonly phpIslandsStripped: boolean;
}

export function parsePhp(source: string): PhpParseResult {
  const errors: ParseError[] = [];
  const buf = source.split("");
  const stripped = stripPhpIslands(source, buf, errors);
  const transformed = buf.join("");
  const html = parseHtml(transformed);
  return {
    root: html.root,
    errors: [...errors, ...html.errors],
    phpIslandsStripped: stripped,
  };
}

export type { HtmlParseResult } from "./html.ts";

// ---------------------------------------------------------------------------
// PHP-island stripping
// ---------------------------------------------------------------------------

/**
 * Walk the source, find every PHP island, blank each one with
 * whitespace (preserving newlines / carriage returns so line numbers
 * stay aligned). Returns true when at least one island was stripped so
 * the caller can plumb the `php_islands_stripped` warning. Records a
 * recoverable {@link ParseError} on every unterminated island and blanks
 * the source from the unclosed opener through EOF — a subsequent stray
 * `<?php` left intact would otherwise be misread as tag soup.
 */
function stripPhpIslands(source: string, buf: string[], errors: ParseError[]): boolean {
  let stripped = false;
  let i = 0;
  while (i < source.length) {
    const open = findOpenerAt(source, i);
    if (open === null) {
      i += 1;
      continue;
    }
    const closeIdx = source.indexOf("?>", open.bodyStart);
    if (closeIdx === -1) {
      const { line, column } = positionAt(source, open.start);
      errors.push({
        message: "Unterminated PHP island (missing closing `?>`)",
        position: { line, column, offset: open.start },
        recoverable: true,
      });
      blankRange(source, buf, open.start, source.length);
      return true;
    }
    const endExclusive = closeIdx + 2;
    blankRange(source, buf, open.start, endExclusive);
    stripped = true;
    i = endExclusive;
  }
  return stripped;
}

interface PhpOpener {
  /** Inclusive index of the leading `<` of the opener. */
  readonly start: number;
  /** Exclusive index of the byte where the closer search begins. */
  readonly bodyStart: number;
}

/**
 * Returns the opener record when `source[i]` starts a PHP island, or
 * `null` when it does not. Detection order matches the comment block in
 * {@link parsePhp}:
 *
 *   - `<?php` (5 bytes; case-insensitive — PHP itself accepts both
 *     `<?PHP` and `<?Php`) — body starts after the 5 opener bytes.
 *   - `<?=` (3 bytes) — body starts after the 3 opener bytes.
 *   - `<?` short tag (2 bytes) — body starts after the 2 opener bytes,
 *     EXCEPT when followed by `xml` (the XHTML prologue), `<?XML`, or
 *     `<?Xml` — those are NOT PHP islands and must flow to the HTML
 *     parser unchanged so the existing `.xhtml` alias keeps working.
 */
function findOpenerAt(source: string, i: number): PhpOpener | null {
  if (source.charCodeAt(i) !== 0x3c) return null; // `<`
  if (source.charCodeAt(i + 1) !== 0x3f) return null; // `?`
  if (matchesCaseInsensitive(source, i + 2, "php")) {
    return { start: i, bodyStart: i + 5 };
  }
  if (source.charCodeAt(i + 2) === 0x3d) {
    return { start: i, bodyStart: i + 3 };
  }
  // Short tag `<?`. Reject the XHTML prologue `<?xml` (case-insensitive).
  if (matchesCaseInsensitive(source, i + 2, "xml")) return null;
  return { start: i, bodyStart: i + 2 };
}

/**
 * True when `source[start … start + needle.length)` matches `needle`
 * case-insensitively. Used to recognize `<?php`, `<?PHP`, `<?Php`, and
 * to reject `<?xml` / `<?XML` short-tag false positives.
 */
function matchesCaseInsensitive(source: string, start: number, needle: string): boolean {
  if (start + needle.length > source.length) return false;
  for (let k = 0; k < needle.length; k += 1) {
    const a = source.charCodeAt(start + k);
    const b = needle.charCodeAt(k);
    // ASCII letter case-fold: bit 0x20 distinguishes lowercase from
    // uppercase for letters in 'A'-'Z' / 'a'-'z'. needle is lowercase
    // ASCII; tolerate uppercase / mixed-case in source.
    if (a !== b && (a | 0x20) !== b) return false;
  }
  return true;
}

/**
 * Replaces `[start, end)` in `buf` with whitespace, preserving `\n`
 * and `\r` so line numbers stay aligned. `buf` is a parallel array to
 * `source`; the source stays available for lookups while the buffer
 * accumulates the transform.
 */
function blankRange(source: string, buf: string[], start: number, end: number): void {
  const stop = Math.min(end, source.length);
  for (let i = start; i < stop; i += 1) {
    const ch = source[i];
    buf[i] = ch === "\n" ? "\n" : ch === "\r" ? "\r" : " ";
  }
}

/**
 * 1-based (line, column) of `offset` in `source`. Used to anchor the
 * unterminated-island parse error at the opener for agent triage.
 */
function positionAt(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
