/**
 * Kramdown IAL (Inline Attribute List) support for the markdown
 * parser. Extracted from `markdown.ts` so the main parser stays under
 * the file-size cap and so the tag-matching helpers (find matching
 * `<`, find matching open tag by name) live with the one pass that
 * uses them.
 *
 * IALs are kramdown's way to annotate a block with attributes without
 * falling all the way down to raw HTML:
 *
 *     <div>content</div>
 *     {: .note .warning}
 *
 * compiles (after pass 7) to a `<div class="note warning">content</div>`
 * the downstream HTML parser sees.
 *
 * Scope (pragmatic, not spec-complete):
 *   - `{: .class1 .class2 #id}` on its own line after a block element.
 *   - Only the `.class` tokens are translated into a `class=` attribute.
 *     `#id`, `key="value"`, `ref:name` forms are tolerated (scanned
 *     past) but not translated.
 *   - Uncovered shapes (inline IAL on same line as the block, IAL
 *     after a heading or list item, multi-line IAL) are stripped
 *     from the buffer so the residue parser doesn't see literal
 *     `{: … }` braces as stray text.
 */

export function applyKramdownIal(buf: string[]): void {
  // Two-phase: collect IAL matches + their target open-tag ranges
  // first (so buffer positions are stable during scanning), then
  // mutate. Mutations are applied from last source position to first
  // so earlier offsets stay valid for later applications.
  const matches = collectIalMatches(buf);
  // Blank every IAL line first — this is a length-preserving
  // operation so offsets for subsequent splices stay correct.
  for (const m of matches) {
    blankBufferRange(buf, m.ialStart, m.ialEnd);
  }
  // Splice classes into targets, last-first so earlier positions
  // remain valid for earlier matches' targets.
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const m = matches[i];
    if (!m || m.targetLt === null || m.targetGt === null) continue;
    applyClassToOpenTag(buf, m.targetLt, m.targetGt, m.classes);
  }
}

interface IalMatch {
  readonly ialStart: number;
  readonly ialEnd: number;
  readonly classes: readonly string[];
  readonly targetLt: number | null;
  readonly targetGt: number | null;
}

function collectIalMatches(buf: readonly string[]): readonly IalMatch[] {
  const matches: IalMatch[] = [];
  let p = 0;
  while (p < buf.length) {
    const lineEnd = findBufferLineEnd(buf, p);
    const line = buf.slice(p, lineEnd).join("");
    const classes = parseIalClasses(line);
    if (classes !== null) {
      const target = locatePriorOpenTag(buf, p);
      matches.push({
        ialStart: p,
        ialEnd: lineEnd,
        classes,
        targetLt: target?.lt ?? null,
        targetGt: target?.gt ?? null,
      });
    }
    p = lineEnd < buf.length ? lineEnd + 1 : lineEnd;
  }
  return matches;
}

/**
 * Parses a kramdown IAL line (`{: .foo .bar #id}` optionally preceded
 * by up to 3 spaces). Returns the class list, or null on no match.
 * Only `.class` tokens are extracted — `#id`, `key=value`, and
 * `ref:name` forms are tolerated but not translated.
 */
function parseIalClasses(line: string): string[] | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i += 1;
  if (line[i] !== "{" || line[i + 1] !== ":") return null;
  const endIdx = line.lastIndexOf("}");
  if (endIdx <= i + 1) return null;
  // Only accept when the rest of the line after `}` is whitespace.
  for (let j = endIdx + 1; j < line.length; j += 1) {
    const ch = line[j];
    if (ch !== " " && ch !== "\t" && ch !== "\r") return null;
  }
  const inner = line.slice(i + 2, endIdx).trim();
  const classes: string[] = [];
  for (const token of inner.split(/\s+/)) {
    if (token.startsWith(".") && token.length > 1) classes.push(token.slice(1));
  }
  return classes.length > 0 ? classes : null;
}

/**
 * Locates the opening tag an IAL line at `pos` should attach to.
 * Walks backwards across whitespace to find the preceding `>`. If it
 * terminates an opening tag, that tag is the target. If it
 * terminates a closing tag, the matching `<name ...>` open of the
 * same element name is the target (IALs attach to the preceding
 * block element as a whole). Returns null when no suitable tag is
 * found.
 */
function locatePriorOpenTag(
  buf: readonly string[],
  pos: number,
): { readonly lt: number; readonly gt: number } | null {
  const gt = findPrecedingCloseGt(buf, pos);
  if (gt === -1) return null;
  const lt = findMatchingLt(buf, gt);
  if (lt === -1) return null;
  if (buf[lt + 1] !== "/") return { lt, gt };
  // Closing tag — walk further back for the matching open of the
  // same element name.
  const tagName = readTagName(buf, lt + 2, gt);
  if (tagName === null) return null;
  return findMatchingOpenTag(buf, lt, tagName);
}

/**
 * Scans backwards from `pos` across only-whitespace characters,
 * returning the offset of the `>` that terminates the immediately
 * preceding tag, or -1 when there is non-whitespace non-`>` content
 * between the IAL and the prior block (which means the IAL has
 * nothing to attach to).
 */
function findPrecedingCloseGt(buf: readonly string[], pos: number): number {
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = buf[i];
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
    if (ch === ">") return i;
    return -1;
  }
  return -1;
}

/**
 * Splices `class="…"` into the opening tag spanning `[lt, gt]`. If
 * the tag already has `class=`, merges the new tokens into the
 * existing value. Self-closing `/>` is preserved.
 */
function applyClassToOpenTag(
  buf: string[],
  lt: number,
  gt: number,
  classes: readonly string[],
): void {
  const classAttr = `class="${classes.join(" ")}"`;
  const existing = findClassAttr(buf, lt, gt);
  if (existing === null) {
    // Insert `class="…"` right before `>` (or before `/` when self-closing).
    const insertAt = buf[gt - 1] === "/" ? gt - 1 : gt;
    const pad = buf[insertAt - 1] === " " ? "" : " ";
    const addition = `${pad}${classAttr}`.split("");
    buf.splice(insertAt, 0, ...addition);
    return;
  }
  const newValue = `${existing.value} ${classes.join(" ")}`;
  const replacement = `class="${newValue}"`.split("");
  buf.splice(existing.start, existing.end - existing.start, ...replacement);
}

/**
 * Reads a tag name starting at `from` up to `endExclusive`, stopping
 * at the first whitespace, `>` or `/`. Returns null when no
 * identifier characters appear.
 */
function readTagName(buf: readonly string[], from: number, endExclusive: number): string | null {
  let i = from;
  while (i < endExclusive) {
    const ch = buf[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === ">" || ch === "/") {
      break;
    }
    i += 1;
  }
  if (i === from) return null;
  return buf.slice(from, i).join("").toLowerCase();
}

/**
 * Walks backwards from just before the closing tag at `closingLt` to
 * find the matching opening `<tagName ...>`. Simple depth counter —
 * tracks balanced nested pairs of the same name. Returns the
 * `[lt, gt]` of the opening tag, or null if not found.
 */
function findMatchingOpenTag(
  buf: readonly string[],
  closingLt: number,
  tagName: string,
): { readonly lt: number; readonly gt: number } | null {
  let depth = 1;
  let i = closingLt - 1;
  while (i >= 0) {
    if (buf[i] !== ">") {
      i -= 1;
      continue;
    }
    const tag = readTagAt(buf, i);
    if (tag === null) return null;
    if (tag.name === tagName) {
      depth = tag.isClosing ? depth + 1 : depth - 1;
      if (!tag.isClosing && depth === 0) return { lt: tag.lt, gt: tag.gt };
    }
    i = tag.lt - 1;
  }
  return null;
}

/**
 * Parses the tag terminating at `gt` into its `<`-offset, name, and
 * closing-flag. Factored out so {@link findMatchingOpenTag}'s loop
 * stays flat.
 */
function readTagAt(
  buf: readonly string[],
  gt: number,
): {
  readonly lt: number;
  readonly gt: number;
  readonly name: string;
  readonly isClosing: boolean;
} | null {
  const lt = findMatchingLt(buf, gt);
  if (lt === -1) return null;
  const isClosing = buf[lt + 1] === "/";
  const nameStart = isClosing ? lt + 2 : lt + 1;
  const name = readTagName(buf, nameStart, gt);
  if (name === null) return null;
  return { lt, gt, name, isClosing };
}

function findMatchingLt(buf: readonly string[], gt: number): number {
  // Match `<name…>`; ignore `<` inside attribute string quotes.
  let inString: '"' | "'" | null = null;
  for (let i = gt - 1; i >= 0; i -= 1) {
    const ch = buf[i];
    if (inString !== null) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "<") return i;
    if (ch === "\n") return -1;
  }
  return -1;
}

interface ExistingClassAttr {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function findClassAttr(buf: readonly string[], lt: number, gt: number): ExistingClassAttr | null {
  // Search for `class=` within `[lt, gt]`, respecting attribute quoting.
  let i = lt + 1;
  while (i < gt) {
    if (matchesClassEq(buf, i)) {
      return readClassAttrValue(buf, i, gt);
    }
    i += 1;
  }
  return null;
}

function matchesClassEq(buf: readonly string[], i: number): boolean {
  return (
    buf[i] === "c" &&
    buf[i + 1] === "l" &&
    buf[i + 2] === "a" &&
    buf[i + 3] === "s" &&
    buf[i + 4] === "s" &&
    buf[i + 5] === "=" &&
    (buf[i + 6] === '"' || buf[i + 6] === "'")
  );
}

function readClassAttrValue(
  buf: readonly string[],
  start: number,
  gt: number,
): ExistingClassAttr | null {
  const quote = buf[start + 6] as '"' | "'";
  const valStart = start + 7;
  let valEnd = valStart;
  while (valEnd < gt && buf[valEnd] !== quote) valEnd += 1;
  if (valEnd >= gt) return null;
  return {
    start,
    end: valEnd + 1,
    value: buf.slice(valStart, valEnd).join(""),
  };
}

function findBufferLineEnd(buf: readonly string[], pos: number): number {
  let p = pos;
  while (p < buf.length && buf[p] !== "\n") p += 1;
  return p;
}

function blankBufferRange(buf: string[], start: number, end: number): void {
  const stop = Math.min(end, buf.length);
  for (let i = start; i < stop; i += 1) {
    const ch = buf[i];
    if (ch === "\n" || ch === "\r") continue;
    buf[i] = " ";
  }
}
