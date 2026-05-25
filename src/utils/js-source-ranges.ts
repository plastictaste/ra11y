/**
 * Minimal JS source-range scanner for regex-based detectors that operate
 * on raw source text. It marks comments and string/template literals so
 * callers can ignore matches that start inside non-executable text while
 * still allowing real code like `el.addEventListener("click", fn)`.
 */

export interface JsIgnoredRange {
  readonly start: number;
  readonly end: number;
}

export function collectJsIgnoredRanges(source: string): readonly JsIgnoredRange[] {
  const ranges: JsIgnoredRange[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const end = rangeEnd(source, i, c);
    if (end !== -1) {
      ranges.push({ start: i, end });
      i = end;
      continue;
    }
    i += 1;
  }
  return ranges;
}

export function isOffsetInJsIgnoredRange(
  ranges: readonly JsIgnoredRange[],
  offset: number,
): boolean {
  for (const range of ranges) {
    if (offset < range.start) return false;
    if (offset < range.end) return true;
  }
  return false;
}

export function regexHasExecutableMatch(
  pattern: RegExp,
  source: string,
  ranges: readonly JsIgnoredRange[],
): boolean {
  pattern.lastIndex = 0;
  let match = pattern.exec(source);
  while (match !== null) {
    if (!isOffsetInJsIgnoredRange(ranges, match.index)) return true;
    match = pattern.exec(source);
  }
  return false;
}

function rangeEnd(source: string, start: number, c: string | undefined): number {
  if (c === '"' || c === "'") return skipQuoted(source, start, c);
  if (c === "`") return skipTemplate(source, start);
  if (c === "/" && source[start + 1] === "/") return skipLineComment(source, start);
  if (c === "/" && source[start + 1] === "*") return skipBlockComment(source, start);
  if (c === "/" && isRegexLiteralStart(source, start)) return skipRegexLiteral(source, start);
  return -1;
}

function skipQuoted(source: string, start: number, quote: '"' | "'"): number {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

function skipTemplate(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    i += 1;
  }
  return source.length;
}

function skipLineComment(source: string, start: number): number {
  let i = start + 2;
  while (i < source.length && source[i] !== "\n") i += 1;
  return i;
}

function skipBlockComment(source: string, start: number): number {
  let i = start + 2;
  while (i < source.length) {
    if (source[i] === "*" && source[i + 1] === "/") return i + 2;
    i += 1;
  }
  return source.length;
}

function skipRegexLiteral(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[" && !inClass) {
      inClass = true;
      i += 1;
      continue;
    }
    if (c === "]" && inClass) {
      inClass = false;
      i += 1;
      continue;
    }
    if (c === "/" && !inClass) return skipRegexFlags(source, i + 1);
    if (c === "\n" || c === "\r") return start + 1;
    i += 1;
  }
  return start + 1;
}

function skipRegexFlags(source: string, start: number): number {
  let i = start;
  while (/[A-Za-z]/.test(source[i] ?? "")) i += 1;
  return i;
}

function isRegexLiteralStart(source: string, start: number): boolean {
  const prev = previousTokenChar(source, start);
  if (prev === null) return true;
  return REGEX_PREFIX_CHARS.has(prev);
}

const REGEX_PREFIX_CHARS: ReadonlySet<string> = new Set([
  "(",
  "{",
  "[",
  "=",
  ":",
  ",",
  ";",
  "!",
  "?",
  "&",
  "|",
  "+",
  "-",
  "*",
  "~",
  "^",
  "%",
  "<",
  ">",
]);

function previousTokenChar(source: string, start: number): string | null {
  let i = start - 1;
  while (i >= 0) {
    const c = source[i];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return c ?? null;
    i -= 1;
  }
  return null;
}
