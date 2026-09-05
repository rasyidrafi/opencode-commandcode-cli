import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { log } from "./log.js";
import {
  DEFAULT_MAX_TURNS,
  envBoolean,
  envNumber,
} from "./constants.js";

export type CliUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
};

export type CliMappedEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "activity"; text: string }
  | { kind: "finish"; finishReason: string; usage: CliUsage; sessionId?: string }
  | { kind: "error"; text: string };

export type RunCliOptions = {
  cwd: string;
  prompt: string;
  model?: string;
  effort?: string;
  sessionName?: string;
  resumeSession?: string;
  noSession?: boolean;
  yolo?: boolean;
  plan?: boolean;
  onSession?: (id: string) => Promise<void>;
  maxTurns?: number;
  signal?: AbortSignal;
  executable?: string;
  onActivity?: () => void;
};

const MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;

function defaultExecutable(): string {
  if (process.platform === "win32") return "cmdc";
  // `cmdc` is the safe cross-platform alias. Linux/macOS also expose `cmd`.
  return "cmdc";
}

export function commandCodeExecutable(): string {
  return process.env.OPENCODE_COMMANDCODE_CLI?.trim() || defaultExecutable();
}

function spawnOptions(cwd: string): SpawnOptions {
  return {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: false,
  };
}

/** Resolve npm's Windows shim without executing a command shell. */
export function cliInvocation(executable: string, args: string[], platform = process.platform): { command: string; args: string[] } {
  if (platform !== "win32") return { command: executable, args };
  const candidates = isAbsolute(executable) || /[/\\]/.test(executable)
    ? [resolve(executable)]
    : (process.env.PATH ?? "").split(";").filter(Boolean).map(dir => join(dir, executable));
  for (const candidate of candidates) {
    if (/\.(mjs|cjs|js)$/i.test(candidate) && existsSync(candidate)) return { command: "node.exe", args: [candidate, ...args] };
    if (/\.exe$/i.test(candidate) && existsSync(candidate)) return { command: candidate, args };
    if (!/\.[^/\\]+$/.test(candidate) && existsSync(candidate + ".exe")) return { command: candidate + ".exe", args };
    if (!/^(cmdc|cmd|command-code)(\.cmd|\.bat)?$/i.test(basename(candidate))) continue;
    const packageDir = join(dirname(candidate), "node_modules", "command-code");
    try {
      const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.cmdc ?? pkg.bin?.["command-code"] ?? pkg.bin?.cmd;
      if (typeof bin === "string") {
        const entry = resolve(packageDir, bin);
        if (existsSync(entry)) return { command: "node.exe", args: [entry, ...args] };
      }
    } catch { /* Try the next PATH directory. */ }
  }
  throw new Error("Cannot resolve Command Code without a shell. Set OPENCODE_COMMANDCODE_CLI to its .js/.mjs entrypoint or a native .exe.");
}

function spawnCli(executable: string, args: string[], cwd: string) {
  const invocation = cliInvocation(executable, args);
  const child = spawn(invocation.command, invocation.args, spawnOptions(cwd)) as ChildProcessWithoutNullStreams;
  let failure: Error | undefined;
  // Attach before any await; ENOENT is emitted asynchronously, not thrown by spawn.
  child.on("error", error => { failure = error; });
  child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") failure = error; });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  return { child, closed, failure: () => failure };
}

function terminate(child: ChildProcessWithoutNullStreams, force = false): void {
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

function abortError(): DOMException {
  return new DOMException("Command Code CLI request aborted", "AbortError");
}

function textFromError(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value ?? "Command Code CLI failed");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function parseUsage(value: unknown): CliUsage {
  if (!value || typeof value !== "object") {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
  const record = value as Record<string, unknown>;
  const rawCost = record.costUsd ?? record.cost_usd;
  const cost = typeof rawCost === "number"
    ? rawCost
    : typeof rawCost === "string"
      ? Number(rawCost)
      : NaN;
  return {
    inputTokens: numberValue(record.inputTokens ?? record.input_tokens),
    outputTokens: numberValue(record.outputTokens ?? record.output_tokens),
    cacheReadTokens: numberValue(record.cacheReadTokens ?? record.cache_read_tokens),
    cacheWriteTokens: numberValue(record.cacheWriteTokens ?? record.cache_write_tokens),
    ...(Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
  };
}

function missingSuffix(seen: string, complete: string): string {
  if (!complete) return "";
  if (!seen) return complete;
  if (complete === seen) return "";
  if (complete.startsWith(seen)) return complete.slice(seen.length);
  // Some CLI releases report a normalized final message. Do not duplicate it.
  if (seen.endsWith(complete)) return "";
  return complete;
}

function cliArguments(options: RunCliOptions): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--skip-onboarding",
    "--no-auto-update",
    "--max-turns",
    String(Math.max(1, Math.floor(options.maxTurns ?? envNumber("OPENCODE_COMMANDCODE_MAX_TURNS", DEFAULT_MAX_TURNS, 1)))),
  ];
  if (options.resumeSession) args.push("--resume", options.resumeSession);
  else if (options.sessionName && !options.noSession) args.push("--name", options.sessionName);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.plan) args.push("--plan");
  else {
    args.push("--permission-mode", "standard");
    if (options.yolo ?? envBoolean("OPENCODE_COMMANDCODE_YOLO", true)) args.push("--yolo");
  }
  if (options.noSession) args.push("--no-session");
  // The prompt is sent through stdin to avoid OS argument limits.
  return args;
}

function mapRawFrame(
  frame: Record<string, unknown>,
  state: {
    sessionId?: string;
    text: string;
    reasoning: string;
    activityIds: Set<string>;
    finished: boolean;
    sawError: boolean;
    lastUsage: CliUsage;
  },
): CliMappedEvent[] {
  const type = typeof frame.type === "string" ? frame.type : "";
  if (type === "event") {
    const event = frame.event;
    if (!event || typeof event !== "object") return [];
    return mapRawFrame(event as Record<string, unknown>, state);
  }

  if (type === "result") {
    if (state.finished) return [];
    const subtype = typeof frame.subtype === "string" ? frame.subtype : "";
    const finalText = typeof frame.finalText === "string" ? frame.finalText : "";
    const events: CliMappedEvent[] = [];
    if (subtype !== "success") {
      state.sawError = true;
      events.push({ kind: "error", text: textFromError(frame.error || "Command Code CLI returned an error") });
    } else {
      const suffix = missingSuffix(state.text, finalText);
      if (suffix) {
        state.text += suffix;
        events.push({ kind: "text", text: suffix });
      }
      state.finished = true;
      events.push({
        kind: "finish",
        finishReason: typeof frame.stopReason === "string" ? frame.stopReason : "stop",
        usage: parseUsage(frame.usage),
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      });
    }
    return events;
  }

  if (type === "run_start" && typeof frame.sessionId === "string") {
    state.sessionId = frame.sessionId;
    return [];
  }

  if (type === "thinking_delta" && typeof frame.delta === "string") {
    state.reasoning += frame.delta;
    return frame.delta ? [{ kind: "reasoning", text: frame.delta }] : [];
  }

  if (type === "thinking_end" && typeof frame.text === "string") {
    const suffix = missingSuffix(state.reasoning, frame.text);
    state.reasoning += suffix;
    return suffix ? [{ kind: "reasoning", text: suffix }] : [];
  }

  if (type === "text_delta" && typeof frame.delta === "string") {
    state.text += frame.delta;
    return frame.delta ? [{ kind: "text", text: frame.delta }] : [];
  }

  if (type === "tool_running") {
    const id = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
    const name = typeof frame.toolName === "string" && frame.toolName
      ? frame.toolName
      : "tool";
    // `tool_queued` and `tool_completed` are transport lifecycle events, not
    // user-visible reasoning. Emit only the running edge. Prefer the call id
    // so two sequential calls to the same tool remain separate blocks.
    const key = id || `name:${name}`;
    if (state.activityIds.has(key)) return [];
    state.activityIds.add(key);
    return [{ kind: "activity", text: `[Command Code tool: Running ${name}]\n` }];
  }

  if (type === "run_error") {
    state.sawError = true;
    return [{ kind: "error", text: textFromError(frame.error || "Command Code CLI failed") }];
  }

  if (type === "model_request_end") {
    state.lastUsage = parseUsage(frame.usage);
    return [];
  }

  if (type === "run_end") {
    const result = frame.result;
    if (!result || typeof result !== "object") return [];
    const resultRecord = result as Record<string, unknown>;
    const stopReason = typeof resultRecord.stopReason === "string"
      ? resultRecord.stopReason
      : "";
    if (stopReason === "run_error" || stopReason === "error") {
      state.sawError = true;
      return state.finished
        ? []
        : [{ kind: "error", text: textFromError(resultRecord.error || "Command Code CLI failed") }];
    }
    if (state.finished) return [];
    const finalText = typeof resultRecord.finalText === "string" ? resultRecord.finalText : "";
    const suffix = missingSuffix(state.text, finalText);
    const events: CliMappedEvent[] = [];
    if (suffix) {
      state.text += suffix;
      events.push({ kind: "text", text: suffix });
    }
    state.finished = true;
    events.push({
      kind: "finish",
      finishReason: stopReason || "stop",
      usage: parseUsage(resultRecord.usage ?? state.lastUsage),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    });
    return events;
  }

  return [];
}

/**
 * Run the official Command Code CLI and translate its documented JSON event
 * stream into provider-friendly text, reasoning, activity, and finish events.
 */
export async function* streamCommandCode(
  options: RunCliOptions,
): AsyncGenerator<CliMappedEvent, void, unknown> {
  if (options.signal?.aborted) throw abortError();

  const notifyActivity = (event: CliMappedEvent): CliMappedEvent => {
    options.onActivity?.();
    return event;
  };

  const executable = options.executable || commandCodeExecutable();
  let processState: ReturnType<typeof spawnCli>;
  try {
    processState = spawnCli(executable, cliArguments(options), options.cwd);
  } catch (error) {
    yield notifyActivity({ kind: "error", text: `Could not start ${executable}: ${textFromError(error)}` });
    return;
  }

  const { child, closed } = processState;
  child.stdout.setEncoding("utf8");
  child.stdin.end(options.prompt);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    if (stderr.length >= MAX_STDERR_BYTES) return;
    stderr += (typeof chunk === "string" ? chunk : chunk.toString("utf8"))
      .slice(0, MAX_STDERR_BYTES - stderr.length);
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    terminate(child, true);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const state = {
    sessionId: undefined as string | undefined,
    text: "",
    reasoning: "",
    activityIds: new Set<string>(),
    finished: false,
    sawError: false,
    lastUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    } satisfies CliUsage,
  };

  let buffer = "";
  let exitCode: number | null = null;
  let pendingFinish: Extract<CliMappedEvent, { kind: "finish" }> | undefined;
  const map = async (parsed: Record<string, unknown>) => {
    const raw = parsed.type === "event" ? parsed.event as Record<string, unknown> : parsed;
    if (raw && typeof raw.sessionId === "string" && raw.sessionId !== state.sessionId) {
      state.sessionId = raw.sessionId;
      await options.onSession?.(raw.sessionId);
    }
    return mapRawFrame(parsed, state);
  };
  try {
    for await (const chunk of child.stdout) {
      if (aborted || options.signal?.aborted) throw abortError();
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (Buffer.byteLength(buffer, "utf8") > MAX_STDOUT_LINE_BYTES) {
            buffer = "";
            yield notifyActivity({ kind: "error", text: "Command Code CLI emitted an oversized JSON line" });
            state.sawError = true;
          }
          break;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        for (const event of await map(parsed as Record<string, unknown>)) {
          if (event.kind === "finish") pendingFinish = event;
          else yield notifyActivity(event);
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      let parsed: unknown;
      try { parsed = JSON.parse(tail); } catch { /* Partial JSON is not an event. */ }
      if (parsed && typeof parsed === "object") {
        for (const event of await map(parsed as Record<string, unknown>)) {
          if (event.kind === "finish") pendingFinish = event;
          else yield notifyActivity(event);
        }
      }
    }
    exitCode = await closed;
    if (aborted) throw abortError();
    if (processState.failure()) throw processState.failure();
  } catch (error) {
    if (aborted || options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw abortError();
    }
    state.sawError = true;
    yield notifyActivity({ kind: "error", text: `Command Code CLI stream failed: ${textFromError(error)}` });
    terminate(child, true);
    await closed;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) terminate(child, true);
    await closed;
  }

  if (pendingFinish && !state.sawError && (exitCode === 0 || exitCode === 8)) yield notifyActivity(pendingFinish);
  else if (!state.sawError) {
    const detail = stderr.trim();
    yield notifyActivity({
      kind: "error",
      text: exitCode === 0
        ? "Command Code CLI ended without a result"
        : `Command Code CLI exited with code ${exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}`,
    });
  }
  log.info("Command Code CLI process finished", { exitCode, sessionId: state.sessionId });
}

export async function runCliText(
  args: string[],
  options: { cwd: string; executable?: string; signal?: AbortSignal } ,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw abortError();
  const processState = spawnCli(options.executable || commandCodeExecutable(), args, options.cwd);
  const { child, closed } = processState;
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const onAbort = () => terminate(child, true);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const code = await closed;
    if (options.signal?.aborted) throw abortError();
    if (processState.failure()) throw processState.failure();
    return { code, stdout, stderr };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
