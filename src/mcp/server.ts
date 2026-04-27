/**
 * MCP server — JSON-RPC 2.0 over stdio.
 *
 * Implements the Model Context Protocol for ra11y:
 *   - initialize / initialized
 *   - tools/list
 *   - tools/call
 *   - prompts/list
 *   - prompts/get
 *   - resources/list
 *   - resources/read
 *
 * Zero dependencies. Reads newline-delimited JSON from stdin, writes
 * JSON responses to stdout. Logs go to stderr via the logger.
 */

import { createInterface } from "node:readline";
import type { Registry } from "../engine/registry/registry.ts";
import { logger } from "../utils/logger.ts";
import { VERSION } from "../version.ts";
import { annotateBuildProvenance } from "./build-provenance.ts";
import {
  type CompletionArgument,
  type CompletionRef,
  complete,
  emptyCompletion,
} from "./completions.ts";
import {
  LOG_LEVELS,
  type LogEmitter,
  type LogLevel,
  type LogNotification,
  makeLogEmitter,
} from "./logging.ts";
import { createOutbound } from "./outbound.ts";
import { checksumForPrompt } from "./prompts/checksums.ts";
import { BUILTIN_PROMPTS } from "./prompts/index.ts";
import type { Prompt } from "./prompts/types.ts";
import {
  loadKbResources,
  RESOURCE_NOT_FOUND,
  ResourceError,
  readKbResource,
} from "./resources/index.ts";
import { McpSession, type SessionRoot } from "./session.ts";
import type { McpTool } from "./tools.ts";
import { MCP_TOOLS } from "./tools.ts";

// ─── JSON-RPC types ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** Narrow a bracket-indexed JSON value to a string, or undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Narrow a bracket-indexed JSON value to a plain object record, or undefined. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

// ─── JSON-RPC error codes ───────────────────────────────────────────────────

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ─── Protocol constants ─────────────────────────────────────────────────────

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "ra11y";
const SERVER_VERSION = VERSION;
const LOGGER_SCAN = "ra11y.scan";

const SERVER_INSTRUCTIONS = [
  "Workflow:",
  "  1. `scan_project` for a project-wide audit, or `scan` / `scan_file` / `--changed` for narrower passes.",
  "  2. If automated is clean, call `checklist` for the manual-review half (grounded candidates with file:line).",
  "  3. For each candidate, read the cited file and decide — don't post-hoc filter or downgrade candidates in your own output; the tool already prunes by likelyIrrelevant and uniquePerCriterion.",
  "  4. Dismiss by reading. Suppress at the source only when genuinely N/A via `<!-- ra11y-disable -->` / `{/* ra11y-disable */}` (accepts rule IDs like `keyboard/handler-missing` and criterion IDs like `wcag22:2.4.5`).",
  "",
  "Consumption tips: verbose `meta` fields (configSource, activeNativeWrappers, rulesEvaluated, filesByExtension) are scan-confidence telemetry — pass them through when explaining a result. `nextStep` on each response tells you the canonical next call.",
  "",
  "Field semantics worth remembering so responses can stay terse:",
  "  - `activeNativeWrappers`: tagged list of component names treated as native-element wrappers for the scan — rules that fire on bare `<div onClick>` skip instances of these components. Each entry is `{ name, source: 'config'|'autoDetect'|'session', confirmed? }`; `confirmed` is populated only for `source: 'autoDetect'` (true = the one-hop AST probe matched a native interactive root; false = the scanner considered the name but didn't trust it, so findings stay live). Configure via `ra11y.config.ts` `nativeWrappers`, `autoDetectWrappers: true` on scan_project, or the `sessionConfigure` tool.",
  "  - `limitations` (when present on a clean scan): runtime-only checks the static scanner can't perform; don't claim a11y conformance on the strength of this tool alone.",
].join("\n");

// ─── Tool index ─────────────────────────────────────────────────────────────

const TOOL_BY_NAME = new Map<string, McpTool>(MCP_TOOLS.map((t) => [t.def.name, t]));
const PROMPT_BY_NAME = new Map(BUILTIN_PROMPTS.map((p) => [p.name, p]));

// ─── Server ─────────────────────────────────────────────────────────────────

/**
 * Starts the MCP server on stdio. Resolves when stdin closes.
 *
 * @param registry - Optional {@link Registry} override. Defaults to
 *   {@link createBuiltinRegistry}; callers with a plugin-composed
 *   registry (e.g. a future `ra11y.config.ts` hook or the CLI
 *   `--plugin` flag) thread it here so `session.registry` carries
 *   the user-authored rules/standards/finders into every tool handler.
 */
export async function startMcpServer(registry?: Registry): Promise<void> {
  const session = new McpSession(registry);
  const emitLog: LogEmitter = makeLogEmitter(
    session.logging,
    (n: LogNotification) => writeNotification(n),
    () => process.cwd(),
  );

  const outbound = createOutbound(
    (line) => process.stdout.write(line),
    (id) => logger.debug(`MCP received response for unknown id: ${String(id)}`),
  );
  session.sendRequest = outbound.sendRequest;

  const rl = createInterface({ input: process.stdin, terminal: false });

  // Requests are dispatched serially (tests and stateful tool calls
  // rely on one-at-a-time ordering), but the read loop itself must
  // not block while a dispatch is pending — sampling-backed tools
  // issue outbound `sampling/createMessage` requests and expect the
  // host's reply to land on stdin *during* the tool call. A loop that
  // `await`s the current dispatch can never reach the next line to
  // route that reply, deadlocking the server.
  //
  // Solution: the read loop enqueues requests behind a serial chain
  // (`dispatchTail`) but stays responsive for inbound *responses*.
  // `tryRouteResponse` is synchronous and fires against the pending
  // outbound map immediately, unblocking the in-flight dispatch.
  let dispatchTail: Promise<unknown> = Promise.resolve();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: PARSE_ERROR, message: "Parse error" },
      });
      continue;
    }

    // Inbound *response* — correlates with a server-initiated request.
    // Must come before the request guard because responses have an
    // `id` without a `method`, which `isJsonRpcRequest` rightly rejects.
    if (outbound.tryRouteResponse(parsed)) continue;

    if (!isJsonRpcRequest(parsed)) {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: INVALID_REQUEST, message: "Invalid Request" },
      });
      continue;
    }

    const request = parsed;

    // Notifications (no id) don't get responses.
    if (request.id === undefined || request.id === null) {
      handleNotification(request, session);
      continue;
    }

    // Enqueue this request behind any pending dispatch. The loop itself
    // does not await — a sampling reply arriving later still reaches
    // `tryRouteResponse` above.
    dispatchTail = dispatchTail.then(() => dispatch(request, session, emitLog).then(writeResponse));
  }

  // Stdin closed — drain the dispatch chain so every request gets a
  // response before the server resolves. Errors are already converted
  // into JSON-RPC error envelopes by `dispatch`, so this never rejects.
  await dispatchTail;
}

/**
 * Notifications carry no id, so we never reply — but some of them
 * carry state the session needs. `notifications/roots/list_changed`
 * is the canonical example: the host flipped project boundaries and
 * we need to re-query. We also record `initialized` for diagnostics.
 */
function handleNotification(request: JsonRpcRequest, session: McpSession): void {
  if (request.method === "notifications/initialized") {
    logger.debug("MCP client sent initialized notification");
    return;
  }
  if (request.method === "notifications/roots/list_changed") {
    // Host is telling us roots changed; we can't synchronously query
    // them back (that requires the host to answer a request), so we
    // just log and let the next tool call re-read session.roots.
    // When an `initialize` result carries roots directly, that path
    // populates the list.
    logger.debug("MCP client changed roots list");
    return;
  }
  if (request.method === "notifications/roots") {
    // Non-spec but some hosts push `{ roots: [...] }` alongside the
    // list_changed notification to avoid a second round-trip. We
    // accept it defensively.
    const roots = extractRootsFromParams(request.params ?? {});
    if (roots !== null) session.setRoots(roots);
    return;
  }
}

/**
 * Parse the `roots` array an MCP client may send either in
 * `initialize.params` or on `notifications/roots`. The canonical
 * shape is `Array<{ uri: string, name?: string }>`. Anything else
 * returns null so the caller knows not to mutate session state.
 */
function extractRootsFromParams(params: Record<string, unknown>): SessionRoot[] | null {
  const raw = params["roots"];
  if (!Array.isArray(raw)) return null;
  const out: SessionRoot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as { uri?: unknown; name?: unknown };
    if (typeof r.uri !== "string" || r.uri.length === 0) continue;
    out.push({
      uri: r.uri,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
    });
  }
  return out;
}

async function handleToolsCall(
  id: string | number | null,
  rawParams: Record<string, unknown>,
  session: McpSession,
  emitLog: LogEmitter,
): Promise<JsonRpcResponse> {
  const toolName = asString(rawParams["name"]);
  if (toolName === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_PARAMS, message: "Missing or invalid tool name." },
    };
  }
  const handlerArgs = asRecord(rawParams["arguments"]) ?? {};
  const tool = TOOL_BY_NAME.get(toolName);
  if (!tool) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: METHOD_NOT_FOUND, message: `Unknown tool: ${toolName}` },
    };
  }
  // Scan-family tools get a pair of log-notification bookends so
  // hosts with `logging` enabled see start/finish telemetry without
  // us splattering log calls inside each rule. Gated by the session's
  // current log level — default `warning` keeps the channel silent
  // until the host explicitly opts in via `logging/setLevel`.
  const isScan = toolName === "scan" || toolName === "scan_project" || toolName === "scan_file";
  if (isScan) {
    emitLog("debug", `${toolName}: starting`, { tool: toolName }, LOGGER_SCAN);
  }
  const t0 = performance.now();
  const toolResult = await tool.handler(handlerArgs, session);
  if (isScan) {
    const elapsedMs = Math.round(performance.now() - t0);
    const counts = extractScanCounts(toolResult);
    emitLog(
      "info",
      `${toolName}: complete in ${elapsedMs}ms`,
      { tool: toolName, elapsedMs, ...counts },
      LOGGER_SCAN,
    );
  }
  // Build-provenance is the per-response signal that lets an agent
  // cross-check the exact build currently answering — version + commit
  // + bundle mtime. Runs unconditionally on every tool response (even
  // error envelopes) so "tool not found" failures still show which
  // ra11y version rejected the request. The systemic guard against
  // shipped-but-stale dist/ lives in scripts/check-mcp-dist-freshness.ts
  // (precommit + CI gate); the per-response runtime mtime warning was
  // removed as information-free noise — for installed end-users dist/
  // is immutable for the session lifetime, and the agent already has
  // bundleMtime here to verify against any expected version.
  const finalResult = annotateBuildProvenance(toolResult);
  return { jsonrpc: "2.0", id, result: finalResult };
}

/**
 * Pull counts out of a tool result's JSON text payload so the `info`
 * completion log line carries useful scalar telemetry without us
 * deserializing the whole response shape. Returns an empty object
 * on any parse failure — logging is telemetry, not correctness.
 */
// log telemetry derives the flat
// `violations` scalar from `plan.fixesByClass` (the wire surface
// dropped the composite headline). Telemetry keeps a flat number
// because it's a log line, not an agent-facing surface.
type ScanCountsParsed = {
  plan?: {
    notes?: number;
    fixesByClass?: Record<"mechanical" | "guidance" | "runtimeOnly" | "verifyInSource", number>;
  };
  meta?: { filesScanned?: number };
};
function extractScanCounts(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const text = (result as { content?: Array<{ text?: unknown }> }).content?.[0]?.text;
  if (typeof text !== "string") return {};
  try {
    const parsed = JSON.parse(text) as ScanCountsParsed;
    const out: Record<string, unknown> = {};
    const fbc = parsed.plan?.fixesByClass;
    if (fbc)
      out["violations"] = fbc.mechanical + fbc.guidance + fbc.runtimeOnly + fbc.verifyInSource;
    if (typeof parsed.plan?.notes === "number") out["notes"] = parsed.plan.notes;
    if (typeof parsed.meta?.filesScanned === "number")
      out["filesScanned"] = parsed.meta.filesScanned;
    return out;
  } catch {
    return {};
  }
}

async function dispatch(
  request: JsonRpcRequest,
  session: McpSession,
  emitLog: LogEmitter,
): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  try {
    return await route(request, id, session, emitLog);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`MCP dispatch error: ${message}`);
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INTERNAL_ERROR, message: `Internal error: ${message}` },
    };
  }
}

function route(
  request: JsonRpcRequest,
  id: string | number | null,
  session: McpSession,
  emitLog: LogEmitter,
): Promise<JsonRpcResponse> | JsonRpcResponse {
  if (request.method === "initialize") return initializeResponse(id, request.params ?? {}, session);
  if (request.method === "tools/list") return toolsListResponse(id);
  if (request.method === "tools/call") {
    return handleToolsCall(id, request.params ?? {}, session, emitLog);
  }
  if (request.method === "prompts/list") return promptsListResponse(id);
  if (request.method === "prompts/get") {
    return handlePromptsGet(id, request.params ?? {});
  }
  if (request.method === "resources/list") return handleResourcesList(id);
  if (request.method === "resources/read") {
    return handleResourcesRead(id, request.params ?? {});
  }
  if (request.method === "logging/setLevel") {
    return handleLoggingSetLevel(id, request.params ?? {}, session);
  }
  if (request.method === "completion/complete") {
    return handleCompletion(id, request.params ?? {}, session);
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: METHOD_NOT_FOUND, message: `Method not found: ${request.method}` },
  };
}

/**
 * `completion/complete` — dispatch to the completions module.
 * Unknown refs degrade to the empty-completion shape (spec contract)
 * rather than erroring; only malformed request shapes produce a
 * JSON-RPC error.
 */
async function handleCompletion(
  id: string | number | null,
  rawParams: Record<string, unknown>,
  session: McpSession,
): Promise<JsonRpcResponse> {
  const ref = rawParams["ref"];
  const argument = rawParams["argument"];
  if (!ref || typeof ref !== "object") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_PARAMS, message: "Missing or invalid `ref` on completion/complete." },
    };
  }
  if (!argument || typeof argument !== "object") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: INVALID_PARAMS,
        message: "Missing or invalid `argument` on completion/complete.",
      },
    };
  }
  const argShape = argument as { name?: unknown; value?: unknown };
  if (typeof argShape.name !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_PARAMS, message: "`argument.name` must be a string." },
    };
  }
  const refShape = ref as CompletionRef;
  const typed: CompletionArgument = {
    name: argShape.name,
    value: typeof argShape.value === "string" ? argShape.value : "",
  };
  if (typeof refShape.type !== "string") {
    // Non-string ref.type: empty-completion shape is the spec's
    // unknown-ref contract, so honor that instead of erroring.
    return { jsonrpc: "2.0", id, result: emptyCompletion() };
  }
  const result = await complete(refShape, typed, process.cwd(), session);
  return { jsonrpc: "2.0", id, result };
}

/**
 * `logging/setLevel` — host tunes the threshold. Unknown levels
 * return JSON-RPC invalid-params (not a tool error).
 */
function handleLoggingSetLevel(
  id: string | number | null,
  rawParams: Record<string, unknown>,
  session: McpSession,
): JsonRpcResponse {
  const level = rawParams["level"];
  if (typeof level !== "string" || !LOG_LEVELS.includes(level as LogLevel)) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: INVALID_PARAMS,
        message: `Invalid log level. Expected one of: ${LOG_LEVELS.join(", ")}.`,
      },
    };
  }
  session.logging.setLevel(level as LogLevel);
  // Spec: result is an empty object on success.
  return { jsonrpc: "2.0", id, result: {} };
}

function initializeResponse(
  id: string | number | null,
  rawParams: Record<string, unknown>,
  session: McpSession,
): JsonRpcResponse {
  // Host may declare `roots` up-front in `initialize.params.roots`
  // (some clients send them inline, others push via a notification
  // after handshake). Accept either path defensively so we have a
  // scan-scope hint before any tool call.
  const declaredRoots = extractRootsFromParams(rawParams);
  if (declaredRoots !== null) session.setRoots(declaredRoots);

  // Record which client capabilities the host declared. The presence
  // of `sampling` gates whether our sampling-backed tools call
  // `sampling/createMessage` or degrade to returning the prompt for
  // the agent to run inline.
  session.setHostCapabilities(rawParams["capabilities"]);

  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      // `listChanged: false` tells the host we won't emit
      // `notifications/prompts/list_changed` — prompt inventory is
      // baked in at build time. Tools ship the same guarantee.
      // Resources are file-backed (`docs/kb/**`), so changes do happen
      // at dev time; the flag still says `false` because we don't push
      // notifications to the host — agents call `resources/list` on
      // demand.
      capabilities: {
        tools: {},
        prompts: { listChanged: false },
        resources: { listChanged: false },
        // `logging: {}` opts us into `notifications/message` +
        // `logging/setLevel`. Default threshold is `warning` so hosts
        // that never tune stay silent; call `logging/setLevel` with
        // `info` to see scan start/finish telemetry.
        logging: {},
        // `completions: {}` opts into `completion/complete` — we
        // suggest criterion IDs for the ra11y/vpat-narrative prompt
        // and KB resource URIs for `ra11y-kb://` refs. Unknown
        // refs return the empty-completion shape per spec.
        completions: {},
      },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: SERVER_INSTRUCTIONS,
    },
  };
}

function toolsListResponse(id: string | number | null): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: MCP_TOOLS.map((t) => ({
        name: t.def.name,
        description: t.def.description,
        inputSchema: t.def.inputSchema,
        annotations: t.def.annotations,
      })),
    },
  };
}

/**
 * `_meta` is MCP's reserved namespace for server annotations. We
 * stamp each prompt with a stable short SHA so hosts that pin
 * behavior to a specific template version can detect drift without
 * rehashing the rendered text themselves.
 */
function promptListEntry(prompt: Prompt): Record<string, unknown> {
  const checksum = checksumForPrompt(prompt.name);
  const base: Record<string, unknown> = {
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments.map((a) => ({
      name: a.name,
      description: a.description,
      required: a.required,
    })),
  };
  if (checksum === undefined) return base;
  base["_meta"] = { checksum };
  return base;
}

function promptsListResponse(id: string | number | null): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: { prompts: BUILTIN_PROMPTS.map(promptListEntry) },
  };
}

function handlePromptsGet(
  id: string | number | null,
  rawParams: Record<string, unknown>,
): JsonRpcResponse {
  const name = asString(rawParams["name"]);
  if (name === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_PARAMS, message: "Missing or invalid prompt name." },
    };
  }
  const prompt = PROMPT_BY_NAME.get(name);
  if (!prompt) {
    // Spec parity with tools/call: unknown prompt → method-not-found
    // on the name, not invalid-params. Matches how clients (incl.
    // Claude Code) discriminate "registry miss" from "bad argument".
    return {
      jsonrpc: "2.0",
      id,
      error: { code: METHOD_NOT_FOUND, message: `Unknown prompt: ${name}` },
    };
  }
  const stringArgs = coercePromptArgs(asRecord(rawParams["arguments"]) ?? {});
  const messages = prompt.render(stringArgs);
  const checksum = checksumForPrompt(prompt.name);
  const result: Record<string, unknown> = {
    description: prompt.description,
    messages,
  };
  // Mirror the `_meta.checksum` annotation from `prompts/list` so a
  // host that calls `prompts/get` directly can still pin.
  if (checksum !== undefined) {
    result["_meta"] = { checksum };
  }
  return { jsonrpc: "2.0", id, result };
}

async function handleResourcesList(id: string | number | null): Promise<JsonRpcResponse> {
  const resources = await loadKbResources(process.cwd());
  return {
    jsonrpc: "2.0",
    id,
    result: { resources },
  };
}

async function handleResourcesRead(
  id: string | number | null,
  rawParams: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const uri = asString(rawParams["uri"]);
  if (uri === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_PARAMS, message: "Missing or invalid resource uri." },
    };
  }
  try {
    const content = await readKbResource(process.cwd(), uri);
    return {
      jsonrpc: "2.0",
      id,
      result: { contents: [content] },
    };
  } catch (err: unknown) {
    if (err instanceof ResourceError) {
      // Separate shape so agents can distinguish "scheme/path rejected"
      // (client bug) from "file genuinely missing" (stale inventory).
      const code = err.code === RESOURCE_NOT_FOUND ? RESOURCE_NOT_FOUND : INVALID_PARAMS;
      return {
        jsonrpc: "2.0",
        id,
        error: { code, message: err.message },
      };
    }
    throw err;
  }
}

/**
 * MCP prompt arguments are spec'd as `{ [name]: string }`. Hosts
 * occasionally pass numbers or booleans by mistake; coerce to string
 * so template rendering stays deterministic and non-string values
 * don't leak into substitution sites.
 */
function coercePromptArgs(raw: Record<string, unknown>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }
  return out;
}

// ─── I/O helpers ────────────────────────────────────────────────────────────

function writeResponse(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(`${json}\n`);
}

/**
 * Write a notification (id-less JSON-RPC message) to stdout. Shares
 * the response lane because MCP uses one stream for everything;
 * ordering relative to replies is controlled by the async loop.
 */
function writeNotification(notification: LogNotification): void {
  const json = JSON.stringify(notification);
  process.stdout.write(`${json}\n`);
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as { jsonrpc?: unknown; method?: unknown };
  return obj.jsonrpc === "2.0" && typeof obj.method === "string";
}
