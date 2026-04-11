// Helpers for emitting hook responses. Exit 0 with a JSON body on stdout
// means the hook succeeded and Claude should parse the body for control
// fields. Exit 2 is the blocking path: stderr becomes the message fed
// back to Claude. Any other code is a non-blocking error.

import type { HookOutput } from "./types.ts";

export function ok(output: HookOutput = {}): never {
  if (Object.keys(output).length > 0) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
  process.exit(0);
}

// Block the current event (only meaningful on blockable events —
// PreToolUse, UserPromptSubmit, Stop, SubagentStop, etc.).
export function block(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

// Non-blocking failure — stderr surfaces but the action proceeds.
export function nonBlockingError(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
