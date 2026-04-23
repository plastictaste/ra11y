/**
 * MCP session state — configuration defaults + AST cache for warm re-scans.
 *
 * Each MCP server connection holds one Session. The `configure` tool mutates
 * session defaults (standard, level, excludes) so subsequent calls don't
 * repeat params. Parsed files are cached by absolute path + mtime so the
 * scan→fix→rescan loop is sub-10ms on the second pass.
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { loadConfig } from "../config/index.ts";
import { parseInlineDisablesDetailed } from "../config/inline-disables.ts";
import { createBuiltinRegistry, type Registry } from "../engine/registry/registry.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import {
  parseAstro,
  parseCss,
  parseHtml,
  parseLess,
  parseMarkdown,
  parseMdx,
  parseScss,
  parseTsx,
} from "../input/parsers/index.ts";
import type { Ast } from "../types/ast.ts";
import type { LoadedConfig, RuleSetting } from "../types/config.ts";
import { LoggingState } from "./logging.ts";

/** Cached entry: AST + metadata keyed by absolute path. */
interface CacheEntry {
  readonly parsed: ParsedFile;
  readonly mtimeMs: number;
}

export interface SessionConfig {
  standard: string;
  level: "A" | "AA" | "AAA";
  exclude: readonly string[];
  /** Per-rule severity overrides. "off" disables the rule entirely. */
  rules: Record<string, RuleSetting>;
  /**
   * PascalCase components the session has verified wrap native interactive
   * elements. `keyboard/handler-missing` skips info notes on these.
   */
  nativeWrappers: readonly string[];
  /**
   * Wrapper → native-element map accumulated this session when
   * `sessionConfigure` receives the object form of `nativeWrappers`
   * (`{ Button: "button", Link: "a" }`). Empty `{}` when only the flat
   * string-array form has been supplied. Parallel to
   * `LoadedConfig.nativeWrapperElements` on the file-loaded side so the
   * two sources can be merged at scan time without ambiguity.
   */
  nativeWrapperElements: Readonly<Record<string, string>>;
  /**
   * Absolute project root the session wrappers are anchored to. Captured
   * the first time `sessionConfigure` registers wrappers (either flat
   * array or object form); pulled from the caller's `cwd` param when
   * passed, otherwise from `process.cwd()`. Tools that consult session
   * wrappers compare this against the current scan's resolved root and
   * surface a `session_wrappers_configured_for_different_cwd` warning
   * when they differ — session state is connection-wide today, so an
   * agent that switches targets mid-session would otherwise see the
   * stale wrappers silently apply. Remains `undefined` when no session
   * wrappers have been set.
   */
  nativeWrappersConfiguredCwd: string | undefined;
  /**
   * When true, tools that mutate user source (`apply_fix`) are permitted to
   * write to disk. Defaults to false: the host must opt-in via `configure`
   * (or the `--allow-write` CLI flag equivalent) before any on-disk edit
   * happens. Read-only tool calls ignore this flag entirely.
   */
  allowWrite: boolean;
}

/**
 * One host-declared project root. The MCP `roots` capability flows
 * from client → server — hosts list directories they consider the
 * active project, and we fall back onto the first root when the
 * caller omits `cwd` on scan-scoped tools. The `name` field is
 * advisory (some hosts don't populate it).
 */
export interface SessionRoot {
  readonly uri: string;
  readonly name?: string;
}

/**
 * Host-declared capabilities as seen in `initialize.params.capabilities`.
 * These are CLIENT capabilities (the reverse direction from the server's
 * own advertised capabilities) — their presence tells us which
 * server-initiated methods the host is willing to answer. We key off
 * `sampling` to decide whether `sampling/createMessage` is usable or
 * we must degrade to returning the prompt for the agent to run
 * directly.
 */
export interface HostCapabilities {
  readonly sampling: boolean;
  readonly roots: boolean;
  readonly elicitation: boolean;
}

/**
 * Server-to-host JSON-RPC request sender. Wired by `startMcpServer`
 * after it sets up the bidirectional read loop. Tools that need
 * sampling (or any future host-initiated call) retrieve this via
 * `session.sendRequest` and await the correlated response.
 *
 * `null` when no transport is attached — e.g. during unit tests that
 * exercise tool handlers without a running server. Callers must
 * handle that case explicitly rather than rely on a throwing stub.
 */
export type SendRequest = (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;

export class McpSession {
  readonly config: SessionConfig;
  readonly logging: LoggingState;
  /**
   * Aggregate of loaded rules, standards, and candidate finders for
   * this session. Constructed once from the shipped built-ins via
   * {@link createBuiltinRegistry}; downstream consumers (MCP tools,
   * helpers) read through `session.registry` instead of reaching for
   * the `BUILTIN_*` barrels directly. See ADR 0022.
   */
  readonly registry: Registry;
  private readonly cache: Map<string, CacheEntry> = new Map();
  /**
   * Session-scoped meta-cache for the opt-in `metaMode: "delta"` path.
   * Keyed on `sessionRef` (hash of tool name + signature-relevant
   * inputs) → the full `meta` object the caller last saw under that
   * signature. Populated and read exclusively from
   * `src/mcp/meta-cache.ts`'s helpers; tool handlers never touch it
   * directly. Per-signature replacement (not global purge): a key
   * whose inputs change gets a fresh `sessionRef` on the next call
   * and the prior entry becomes unreachable.
   */
  private readonly metaBySessionRef: Map<string, Record<string, unknown>> = new Map();
  private rootsList: readonly SessionRoot[] = [];
  private hostCaps: HostCapabilities = { sampling: false, roots: false, elicitation: false };
  /**
   * Server-to-host sender. Null until `startMcpServer` wires it to the
   * bidirectional stdio loop. Tools that need sampling check for null
   * first and fall back to returning the prompt.
   */
  sendRequest: SendRequest | null = null;

  /**
   * Constructs a session. The optional `registry` argument overrides
   * the default {@link createBuiltinRegistry} — the seam ADR 0022
   * reserved for the plugin path. Callers threading a plugin-composed
   * Registry (via `createRegistry({ rules, standards, finders })`)
   * pass it here so every tool that reads `session.registry` sees the
   * user-authored additions. Omitting the argument preserves the
   * existing built-ins-only behavior for every non-plugin consumer.
   */
  constructor(registry?: Registry) {
    this.config = {
      standard: "wcag22",
      level: "AA",
      exclude: [],
      rules: {},
      nativeWrappers: [],
      nativeWrapperElements: {},
      nativeWrappersConfiguredCwd: undefined,
      allowWrite: false,
    };
    this.logging = new LoggingState();
    this.registry = registry ?? createBuiltinRegistry();
  }

  /**
   * Record the capability object the host declared in
   * `initialize.params.capabilities`. Only presence matters per spec —
   * values are reserved for future extensions.
   */
  setHostCapabilities(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const obj = raw as Record<string, unknown>;
    this.hostCaps = {
      sampling: "sampling" in obj,
      roots: "roots" in obj,
      elicitation: "elicitation" in obj,
    };
  }

  /** Read-only view of host-declared capabilities from `initialize`. */
  get hostCapabilities(): HostCapabilities {
    return this.hostCaps;
  }

  /**
   * Replace the known set of host-declared roots. Called once from
   * `initialize` (we read `params.roots` defensively) and again on
   * `notifications/roots/list_changed`. Pure mutation — no scans
   * re-trigger; the next tool call picks them up.
   */
  setRoots(roots: readonly SessionRoot[]): void {
    this.rootsList = [...roots];
  }

  /**
   * Read-only view of currently declared roots. Empty when the host
   * did not advertise the `roots` capability or returned an empty
   * list. Tools degrade gracefully in that case.
   */
  get roots(): readonly SessionRoot[] {
    return this.rootsList;
  }

  /**
   * Absolute filesystem path of the first declared root, if any.
   * `scan_project` uses this as a default scan scope when the caller
   * has not passed `cwd` explicitly. URIs that aren't `file://` are
   * ignored (we can't scan a URL-only root).
   */
  firstRootPath(): string | null {
    for (const root of this.rootsList) {
      const p = fileUriToPath(root.uri);
      if (p !== null) return p;
    }
    return null;
  }

  /**
   * Loads the project's ra11y.config.ts for a given cwd.
   *
   * Not cached: an agent that creates the config file partway through a
   * session (after a "where do I put nativeWrappers?" answer) expects the
   * next scan to pick it up. A cache keyed by cwd silently returned stale
   * null results. The load is a handful of existsSync calls + one dynamic
   * import — trivially fast compared to a scan.
   */
  loadProjectConfig(cwd: string): Promise<LoadedConfig> {
    return loadConfig({ cwd });
  }

  /**
   * Merges session rule overrides with the project config's rules.
   * Session rules win — an explicit `configure({ rules })` call beats
   * the file. This is the same precedence the CLI uses.
   */
  effectiveRules(projectConfig: LoadedConfig): Record<string, RuleSetting> {
    return { ...projectConfig.rules, ...this.config.rules };
  }

  /** Update session defaults. Returns the new active config. */
  configure(opts: {
    standard?: string;
    level?: "A" | "AA" | "AAA";
    exclude?: readonly string[];
    rules?: Readonly<Record<string, RuleSetting>>;
    nativeWrappers?: readonly string[];
    /**
     * Wrapper → native-element map. Additive across calls: later
     * entries overwrite earlier entries for the same wrapper name,
     * mirroring the `rules` merge behavior so an agent can refine a
     * mapping mid-session without re-sending the full object.
     */
    nativeWrapperElements?: Readonly<Record<string, string>>;
    /**
     * Absolute directory the caller is configuring session wrappers
     * against. Captured into `nativeWrappersConfiguredCwd` the first
     * time wrappers are registered so subsequent tool calls against a
     * different resolved root can surface a cross-cwd mismatch
     * warning. Ignored when no wrapper-shaped field is also passed.
     */
    cwd?: string;
    allowWrite?: boolean;
  }): SessionConfig {
    if (opts.standard !== undefined) this.config.standard = opts.standard;
    if (opts.level !== undefined) this.config.level = opts.level;
    if (opts.exclude !== undefined) this.config.exclude = opts.exclude;
    if (opts.rules !== undefined) {
      // Merge: new overrides replace per key, existing keep.
      this.config.rules = { ...this.config.rules, ...opts.rules };
    }
    const hadWrappers =
      this.config.nativeWrappers.length > 0 ||
      Object.keys(this.config.nativeWrapperElements).length > 0;
    const isSettingWrappers =
      (opts.nativeWrappers !== undefined && opts.nativeWrappers.length > 0) ||
      (opts.nativeWrapperElements !== undefined &&
        Object.keys(opts.nativeWrapperElements).length > 0);
    if (opts.nativeWrappers !== undefined) {
      // Union with existing so repeated configure() calls accumulate.
      this.config.nativeWrappers = [
        ...new Set([...this.config.nativeWrappers, ...opts.nativeWrappers]),
      ];
    }
    if (opts.nativeWrapperElements !== undefined) {
      // Per-key merge: later `configure()` calls can refine the map
      // for a specific wrapper without having to restate every entry.
      // Also folds the declared names into `nativeWrappers` so the
      // silence-on-wrapper callers see them regardless of whether the
      // caller sent the array form or the object form.
      this.config.nativeWrapperElements = {
        ...this.config.nativeWrapperElements,
        ...opts.nativeWrapperElements,
      };
      this.config.nativeWrappers = [
        ...new Set([...this.config.nativeWrappers, ...Object.keys(opts.nativeWrapperElements)]),
      ];
    }
    if (isSettingWrappers && !hadWrappers) {
      // First call that actually lands wrappers — capture the anchor
      // cwd. Prefer the explicit param; fall back to process.cwd() so
      // a caller that forgot the param still gets a concrete anchor
      // (the mismatch warning then depends on the server's spawn
      // directory, which is honest about the configuration's provenance).
      this.config.nativeWrappersConfiguredCwd = resolveConfiguredCwd(opts.cwd);
    }
    if (opts.allowWrite !== undefined) this.config.allowWrite = opts.allowWrite;
    return {
      ...this.config,
      rules: { ...this.config.rules },
      nativeWrapperElements: { ...this.config.nativeWrapperElements },
    };
  }

  /**
   * True when session wrappers are registered AND the configured anchor
   * cwd differs from the caller's current resolved root. The comparison
   * uses `resolve(...)` on both sides so equivalent paths (e.g. trailing
   * slashes, relative forms) don't false-positive. Returns false when
   * no wrappers are set or no anchor was captured.
   *
   * Tools consult this from the scan-response assembly site and emit
   * `session_wrappers_configured_for_different_cwd` alongside the
   * regular warning codes — without it, an agent that configures
   * wrappers against one project and then scans another sees
   * `activeNativeWrappers` populated with stale names and no signal
   * that state is leaking across cwds.
   */
  sessionWrappersMismatchCwd(currentRoot: string): boolean {
    const anchor = this.config.nativeWrappersConfiguredCwd;
    if (anchor === undefined) return false;
    const hasWrappers =
      this.config.nativeWrappers.length > 0 ||
      Object.keys(this.config.nativeWrapperElements).length > 0;
    if (!hasWrappers) return false;
    return resolve(anchor) !== resolve(currentRoot);
  }

  /**
   * Parses a file, returning a cached result when the file hasn't changed.
   * Returns null for unsupported extensions.
   *
   * Relative paths resolve against `cwd` (or `process.cwd()` if omitted).
   * Callers can pass a `cwd` per scan so agents working in git worktrees
   * don't collide with the server's spawn-time working directory.
   */
  async parseFile(filePath: string, cwd?: string): Promise<ParsedFile | null> {
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd ?? process.cwd(), filePath);
    const info = await stat(abs);
    const cached = this.cache.get(abs);
    if (cached && cached.mtimeMs === info.mtimeMs) {
      return cached.parsed;
    }

    const source = await readFile(abs, "utf8");
    const ast = parseForExtension(abs, source);
    if (!ast) return null;

    const { disableMap, declarations } = parseInlineDisablesDetailed(source);
    const parsed: ParsedFile = {
      filePath,
      source,
      ast,
      disableMap,
      declarations,
    };

    this.cache.set(abs, { parsed, mtimeMs: info.mtimeMs });
    return parsed;
  }

  /** Invalidate all cached entries. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Number of cached files (for diagnostics). */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Read the previously-stored full `meta` object for a given
   * `sessionRef`. Returns `undefined` when no prior call under that
   * signature has been made — the meta-cache helper reads this to
   * decide whether to emit the full baseline or collapse to a delta.
   */
  getCachedMeta(sessionRef: string): Record<string, unknown> | undefined {
    return this.metaBySessionRef.get(sessionRef);
  }

  /**
   * Store the full `meta` object under a `sessionRef`. Called by the
   * meta-cache helper on every opted-in call so the baseline tracks
   * the latest state (a field that flapped between calls reconciles
   * against the most recent value, never a stale-first baseline).
   * Per-signature replacement — no cap needed for a stable input
   * signature; cross-signature entries accumulate for session
   * lifetime, which is bounded by the MCP connection.
   */
  putCachedMeta(sessionRef: string, meta: Record<string, unknown>): void {
    this.metaBySessionRef.set(sessionRef, meta);
  }

  /** Diagnostic count of cached meta baselines. */
  get metaCacheSize(): number {
    return this.metaBySessionRef.size;
  }
}

/**
 * Resolves a caller-supplied `cwd` (or `undefined`) to the absolute
 * path recorded as the session-wrapper anchor. Relative paths resolve
 * against `process.cwd()`; a missing value falls back to the server's
 * spawn directory so the anchor is always concrete (and honestly
 * surfaces a mismatch the first time a later tool call targets a
 * different root).
 */
function resolveConfiguredCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return process.cwd();
  return isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
}

/**
 * Convert an MCP root URI (`file://...`) to an absolute filesystem
 * path. Non-`file` schemes return null — we can't scan an HTTP URL.
 * Also tolerates hosts that drop the scheme and send bare absolute
 * paths, since that's the most common real-world mistake.
 */
function fileUriToPath(uri: string): string | null {
  if (uri.length === 0) return null;
  if (uri.startsWith("file://")) {
    const rest = uri.slice("file://".length);
    // file:///abs/path → /abs/path; file://host/path → reject (remote)
    if (rest.startsWith("/")) return decodeURIComponent(rest);
    return null;
  }
  if (isAbsolute(uri)) return uri;
  return null;
}
function parseForExtension(filePath: string, source: string): Ast | null {
  if (filePath.endsWith(".html") || filePath.endsWith(".htm")) {
    const r = parseHtml(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (filePath.endsWith(".css")) {
    const r = parseCss(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (filePath.endsWith(".scss")) {
    const r = parseScss(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (filePath.endsWith(".less")) {
    const r = parseLess(source);
    return { language: "css", root: r.root, errors: r.errors };
  }
  if (filePath.endsWith(".mdx")) {
    const r = parseMdx(source);
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  if (filePath.endsWith(".astro")) {
    const r = parseAstro(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  // `.md` / `.markdown` — ADR 0025 Option B. Strip markdown syntax
  // and feed the HTML residue (embedded tables, iframes, admonition
  // divs, `<img>` synthesized from `![alt](url)`) to parseHtml. Rules
  // see the same `language: "html"` AST shape they would from a plain
  // HTML file.
  if (filePath.endsWith(".md") || filePath.endsWith(".markdown")) {
    const r = parseMarkdown(source);
    return { language: "html", root: r.root, errors: r.errors };
  }
  if (
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".jsx") ||
    filePath.endsWith(".ts") ||
    filePath.endsWith(".js")
  ) {
    const r = parseTsx(source);
    return { language: "tsx", root: r.root, errors: r.errors };
  }
  return null;
}
