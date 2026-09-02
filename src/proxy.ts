import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_SSE_HEARTBEAT_MS,
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  LOCAL_API_KEY,
  MODEL_HEADER,
  PROVIDER_ID,
  REQUEST_KIND_HEADER,
  SESSION_HEADER,
  envBoolean,
  envNumber,
} from "./constants.js";
import { streamCommandCode, type CliMappedEvent, type CliUsage } from "./cli.js";
import { getCommandCodeCliModels, resolveCommandCodeCliModel, type CommandCodeCliModel } from "./models.js";
import { buildCommandCodePrompt, type OpenAIMessage } from "./prompt.js";
import { runInSession, sessionHasStarted, sessionKey, stableSessionName } from "./session.js";
import { addUsage, listUsage, toOpenAIUsage, totalUsage } from "./usage.js";
import { log } from "./log.js";

type AnthropicMessageRequest = {
  model?: unknown;
  messages?: unknown;
  system?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  [key: string]: unknown;
};

type Runtime = {
  directory: string;
  models: CommandCodeCliModel[];
};

type OrderedSegment = {
  kind: "text" | "thinking";
  text: string;
};

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

let server: ReturnType<typeof Bun.serve> | null = null;
let proxyPort: number | null = null;
let runtime: Runtime | null = null;
const workspaceRoots = new Set<string>();

function requestedPort(): number {
  const value = envNumber("OPENCODE_COMMANDCODE_CLI_PROXY_PORT", 0, 0);
  return value < 65_536 ? Math.floor(value) : 0;
}

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value || undefined;
}

function authorized(request: Request): boolean {
  const bearer = request.headers.get("authorization")?.trim();
  const apiKey = request.headers.get("x-api-key")?.trim();
  return bearer === `Bearer ${LOCAL_API_KEY}` || apiKey === LOCAL_API_KEY;
}

function withinWorkspace(directory: string): boolean {
  const candidate = resolve(directory);
  return [...workspaceRoots].some((root) => {
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
  });
}

async function readJson(request: Request): Promise<AnthropicMessageRequest> {
  const max = Math.floor(envNumber("OPENCODE_COMMANDCODE_CLI_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES, 1_024));
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error("The request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > max) throw new Error("The request body is too large");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The request body must be an object");
  return parsed as AnthropicMessageRequest;
}

function errorResponse(message: string, status = 502): Response {
  const lower = message.toLowerCase();
  const authentication = /not authenticated|authentication|login required|logged in/.test(lower);
  return Response.json(
    {
      type: "error",
      error: {
        type: authentication ? "authentication_error" : "api_error",
        message,
      },
    },
    { status: authentication ? 401 : status },
  );
}

function zeroUsage(): CliUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function zeroAnthropicUsage(): Record<string, number> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function completionId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

function stopReason(value: string): "end_turn" | "max_tokens" {
  return /max_turns|max[_-]?tokens|length/i.test(value) ? "max_tokens" : "end_turn";
}

function responseModel(bodyModel: unknown, selected: string): string {
  return typeof bodyModel === "string" && bodyModel ? bodyModel : selected;
}

function contentBlock(kind: "text" | "thinking", text = ""): Record<string, unknown> {
  return kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text };
}

function appendSegment(segments: OrderedSegment[], kind: OrderedSegment["kind"], text: string): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else segments.push({ kind, text });
}

type ProbedEvents = { events: AsyncIterable<CliMappedEvent> } | { error: Error };

async function probeFirstEvent(events: AsyncIterable<CliMappedEvent>): Promise<ProbedEvents> {
  const iterator = events[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (first.done) return { error: new Error("Command Code CLI ended without a response") };
    if (first.value.kind === "error") {
      await iterator.return?.();
      return { error: new Error(first.value.text) };
    }
    return { events: replayEvents(first.value, iterator) };
  } catch (error) {
    await iterator.return?.();
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function* replayEvents(
  first: CliMappedEvent,
  rest: AsyncIterator<CliMappedEvent>,
): AsyncGenerator<CliMappedEvent, void, unknown> {
  yield first;
  try {
    while (true) {
      const next = await rest.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await rest.return?.();
  }
}

async function handleMessages(request: Request, body: AnthropicMessageRequest): Promise<Response> {
  if (!runtime) return errorResponse("Command Code CLI proxy is not initialized", 500);
  const directory = resolve(readHeader(request, DIRECTORY_HEADER) || runtime.directory);
  if (!withinWorkspace(directory)) return errorResponse("The requested workspace is outside the plugin workspace", 403);

  if (!Array.isArray(body.messages)) throw new Error("`messages` must be an array");
  const messages = body.messages as OpenAIMessage[];
  const allMessages: OpenAIMessage[] = body.system === undefined
    ? messages
    : [{ role: "system", content: body.system }, ...messages];
  const model = resolveCommandCodeCliModel(
    readHeader(request, MODEL_HEADER) || (typeof body.model === "string" ? body.model : undefined),
  );
  const sessionId = readHeader(request, SESSION_HEADER);
  const titleRequest = readHeader(request, REQUEST_KIND_HEADER) === "title";
  const key = sessionKey(directory, sessionId, JSON.stringify(allMessages));
  const prompt = buildCommandCodePrompt(allMessages, { includeHistory: titleRequest || !sessionHasStarted(key) });
  const effort = readHeader(request, EFFORT_HEADER);
  const events: AsyncIterable<CliMappedEvent> = titleRequest
    ? streamCommandCode({
        cwd: directory,
        prompt,
        model,
        effort,
        noSession: true,
        yolo: false,
        maxTurns: 3,
        signal: request.signal,
      })
    : runInSession(key, {
        cwd: directory,
        prompt,
        model,
        effort,
        sessionName: stableSessionName(key),
        yolo: envBoolean("OPENCODE_COMMANDCODE_CLI_YOLO", true),
        maxTurns: envNumber("OPENCODE_COMMANDCODE_CLI_MAX_TURNS", 100, 1),
        signal: request.signal,
      });

  if (body.stream !== true) {
    const segments: OrderedSegment[] = [];
    let usage = zeroUsage();
    let finish = "end_turn";
    try {
      for await (const event of events) {
        if (event.kind === "text") appendSegment(segments, "text", event.text);
        else if (event.kind === "reasoning") appendSegment(segments, "thinking", event.text);
        else if (event.kind === "activity") segments.push({ kind: "thinking", text: event.text });
        else if (event.kind === "finish") {
          usage = event.usage;
          finish = stopReason(event.finishReason);
          if (!titleRequest) addUsage(key, usage);
        } else if (event.kind === "error") return errorResponse(event.text);
      }
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error));
    }
    return Response.json({
      id: completionId(),
      type: "message",
      role: "assistant",
      model: responseModel(body.model, model),
      content: segments.map((segment, index) => segment.kind === "text"
        ? { type: "text", text: segment.text }
        : { type: "thinking", thinking: segment.text, signature: `commandcode-${index}` }),
      stop_reason: finish,
      stop_sequence: null,
      // Deliberately zero. The real CLI usage never crosses the provider wire.
      usage: zeroAnthropicUsage(),
    });
  }

  const probed = await probeFirstEvent(events);
  if ("error" in probed) return errorResponse(probed.error.message);
  return streamAnthropic(probed.events, responseModel(body.model, model), key, titleRequest, request.signal);
}

function streamAnthropic(
  events: AsyncIterable<CliMappedEvent>,
  model: string,
  session: string,
  titleRequest: boolean,
  signal: AbortSignal,
): Response {
  const id = completionId();
  const encoder = new TextEncoder();
  let closed = false;
  let iterator: AsyncIterator<CliMappedEvent> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      iterator = events[Symbol.asyncIterator]();
      const send = (payload: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      let nextBlockIndex = 0;
      let active: { index: number; kind: "text" | "thinking" } | undefined;
      let finish: "end_turn" | "max_tokens" = "end_turn";

      const closeBlock = () => {
        if (!active) return;
        if (active.kind === "thinking") {
          send({
            type: "content_block_delta",
            index: active.index,
            delta: { type: "signature_delta", signature: `commandcode-${id}-${active.index}` },
          });
        }
        send({ type: "content_block_stop", index: active.index });
        active = undefined;
      };
      const openBlock = (kind: "text" | "thinking") => {
        if (active?.kind === kind) return;
        closeBlock();
        active = { index: nextBlockIndex++, kind };
        send({ type: "content_block_start", index: active.index, content_block: contentBlock(kind) });
      };
      const emitBlock = (kind: "text" | "thinking", text: string, separate = false) => {
        if (!text) return;
        if (separate) closeBlock();
        openBlock(kind);
        send({
          type: "content_block_delta",
          index: active!.index,
          delta: kind === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text },
        });
        if (separate) closeBlock();
      };

      const handleEvent = (event: CliMappedEvent): boolean => {
        if (event.kind === "text") emitBlock("text", event.text);
        else if (event.kind === "reasoning") emitBlock("thinking", event.text);
        else if (event.kind === "activity") emitBlock("thinking", event.text, true);
        else if (event.kind === "finish") {
          finish = stopReason(event.finishReason);
          if (!titleRequest) addUsage(session, event.usage);
        } else if (event.kind === "error") {
          closeBlock();
          send({ type: "error", error: { type: "api_error", message: event.text } });
          return true;
        }
        return false;
      };

      send({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: zeroAnthropicUsage(),
        },
      });
      heartbeat = setInterval(() => send({ type: "ping" }), DEFAULT_SSE_HEARTBEAT_MS);
      heartbeat.unref?.();

      try {
        if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
        let next = await iterator.next();
        if (!next.done && handleEvent(next.value)) return;
        while (!next.done) {
          if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
          next = await iterator.next();
          if (!next.done && handleEvent(next.value)) return;
        }
        closeBlock();
        send({ type: "message_delta", delta: { stop_reason: finish, stop_sequence: null }, usage: zeroAnthropicUsage() });
        send({ type: "message_stop" });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          closeBlock();
          send({ type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } });
        }
      } finally {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        await iterator?.return?.();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    async cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      await iterator?.return?.();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const protectedRoute =
    (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models" || url.pathname === "/v1/usage" || url.pathname === "/usage")) ||
    (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages"));
  if (protectedRoute && !authorized(request)) return errorResponse("Invalid local proxy API key", 401);
  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    return Response.json({ ok: true, provider: PROVIDER_ID, proxy: "loopback", port: proxyPort });
  }
  if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    return Response.json({ object: "list", data: (runtime?.models ?? getCommandCodeCliModels()).map((entry) => ({ id: entry.id, object: "model", owned_by: "command-code-cli" })) });
  }
  if (request.method === "GET" && (url.pathname === "/v1/usage" || url.pathname === "/usage")) {
    return Response.json({ provider: PROVIDER_ID, source: "command-code-cli", total: toOpenAIUsage(totalUsage()), sessions: listUsage() });
  }
  if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
    try {
      return await handleMessages(request, await readJson(request));
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 400);
    }
  }
  return new Response("Not Found", { status: 404 });
}

export async function startProxy(directory = process.cwd()): Promise<number> {
  workspaceRoots.add(resolve(directory));
  if (server && proxyPort) return proxyPort;
  runtime = { directory: resolve(directory), models: getCommandCodeCliModels() };
  server = Bun.serve({ hostname: "127.0.0.1", port: requestedPort(), idleTimeout: 0, fetch: handleRequest });
  proxyPort = server.port ?? null;
  if (!proxyPort) throw new Error("Command Code CLI proxy did not receive a port");
  log.info("Command Code CLI loopback proxy listening", { port: proxyPort });
  return proxyPort;
}

export async function stopProxy(directory?: string): Promise<void> {
  if (directory) workspaceRoots.delete(resolve(directory));
  else workspaceRoots.clear();
  if (workspaceRoots.size > 0) return;
  if (server) server.stop(true);
  server = null;
  proxyPort = null;
  runtime = null;
}

export function getProxyPort(): number | null {
  return proxyPort;
}

export function getProxyBaseUrl(): string {
  if (!proxyPort) throw new Error("Command Code CLI proxy is not running");
  return `http://127.0.0.1:${proxyPort}/v1`;
}

export function setRuntimeModels(models: CommandCodeCliModel[]): void {
  if (runtime) runtime.models = models;
}
