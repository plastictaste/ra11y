/**
 * Canonical "what was scanned" envelope for MCP tool responses.
 *
 * Before this shape landed, the scan-family tools emitted three different
 * keys for the same concept — `scannedRoot` (project), `scannedPaths`
 * (directory/path list), `scannedFile` (single file). That forced every
 * consumer (agents, formatters, cross-tool invariants) to branch on
 * which key was populated to answer the single question "what did the
 * tool look at?". Per CLAUDE.md §1 invariant 12 ("Ambiguous field shapes
 * are dishonest") and the AI-first consumer doctrine, optional fields
 * should be present-when-meaningful and the shape should be one question
 * → one place to look.
 *
 * Target shape (applied uniformly across scan_project, scan, scan_file,
 * scan_diff, detect_native_wrappers, propose_config, propose_baseline):
 *
 * ```
 * scanned: {
 *   mode: "project" | "dir" | "file",
 *   root?: string,     // only when mode === "project"
 *   paths?: string[],  // only when mode === "dir"
 *   file?: string,     // only when mode === "file"
 * }
 * ```
 *
 * `mode` is always present. The other three fields are conditionally
 * spread at assembly sites — never sentinel-empty.
 */

export type ScanEnvelopeMode = "project" | "dir" | "file";

/**
 * Canonical "what was scanned" envelope. Only the field matching `mode`
 * is populated; the others are absent.
 */
export interface ScannedEnvelope {
  readonly mode: ScanEnvelopeMode;
  readonly root?: string;
  readonly paths?: readonly string[];
  readonly file?: string;
}

/** Build a `scanned` envelope for project-mode scans (single root). */
export function scannedProject(root: string): ScannedEnvelope {
  return { mode: "project", root };
}

/** Build a `scanned` envelope for directory-mode scans (explicit path list). */
export function scannedDir(paths: readonly string[]): ScannedEnvelope {
  return { mode: "dir", paths };
}

/** Build a `scanned` envelope for single-file scans. */
export function scannedFile(file: string): ScannedEnvelope {
  return { mode: "file", file };
}
