// Reads the hook payload from stdin. Bun supports top-level await and
// reads stdin via Bun.stdin. We fall back to Node's process.stdin so these
// scripts can be run with `node --experimental-strip-types` too — useful
// when diagnosing a failing hook from a non-Bun shell.

import type { CommonHookInput } from "./types.ts";

export async function readHookInput<T extends CommonHookInput>(): Promise<T> {
  // Prefer Bun.stdin if available — single awaited read, fastest path.
  const bunGlobal = (globalThis as { Bun?: { stdin?: { text(): Promise<string> } } }).Bun;
  if (bunGlobal?.stdin) {
    const text = await bunGlobal.stdin.text();
    return parseOrThrow<T>(text);
  }

  // Node fallback.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return parseOrThrow<T>(text);
}

function parseOrThrow<T>(text: string): T {
  if (!text.trim()) {
    throw new Error("hook stdin was empty");
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`hook stdin is not valid JSON: ${message}`);
  }
}
