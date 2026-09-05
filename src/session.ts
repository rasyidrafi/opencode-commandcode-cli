import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamCommandCode, type CliMappedEvent, type RunCliOptions } from "./cli.js";
import { buildCommandCodePrompt, type OpenAIMessage } from "./prompt.js";

const tails = new Map<string, Promise<void>>();
type SessionRecord = {
  version: 1;
  sessionId?: string;
  requests: Record<string, "started" | "completed">;
  cachedRequest?: string;
  events?: CliMappedEvent[];
};

export function sessionKey(directory: string, openCodeSessionId: string | undefined, _prompt?: string): string {
  return createHash("sha256").update(`${directory}\0${openCodeSessionId || randomUUID()}`).digest("hex").slice(0, 40);
}
export function stableSessionName(key: string): string { return `opencode-${key.slice(0, 24)}`; }

async function save(file: string, record: SessionRecord): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** Serialize locally, lock across processes, and persist before starting workspace actions. */
export async function* runInSession(
  key: string,
  options: Omit<RunCliOptions, "resumeSession" | "sessionName"> & {
    sessionName: string;
    messages?: OpenAIMessage[];
    requestId?: string;
  },
): AsyncGenerator<CliMappedEvent, void, unknown> {
  if (!/^[a-f0-9]{40}$/.test(key)) throw new Error("Invalid Command Code session key");
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  tails.set(key, tail);
  let locked = false;
  const directory = process.env.OPENCODE_COMMANDCODE_DATA_DIR || join(homedir(), ".local", "share", "opencode-commandcode");
  const file = join(directory, `${key}.json`);
  const lock = `${file}.lock`;
  try {
    await previous;
    if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await mkdir(lock, { mode: 0o700 }); locked = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`Command Code session is locked by another request. If its process crashed, remove ${lock} after confirming it is no longer running.`);
    }
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { mode: 0o600 });
    let record: SessionRecord = { version: 1, requests: {} };
    let newMapping = true;
    try {
      record = JSON.parse(await readFile(file, "utf8"));
      if (record.version !== 1 || !record.requests || typeof record.requests !== "object" || Array.isArray(record.requests)) throw new Error("Invalid Command Code session mapping");
      newMapping = false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const request = createHash("sha256").update(options.requestId || JSON.stringify([options.messages ?? options.prompt, options.model, options.effort, options.plan])).digest("hex");
    if (record.requests[request]) {
      if (record.requests[request] === "completed" && record.cachedRequest === request && record.events) { yield* record.events; return; }
      throw new Error("This request already started in Command Code. Send a new message to continue; replay could repeat workspace changes.");
    }
    // Validate input before recording a request as having reached the CLI.
    const resumedPrompt = options.messages ? buildCommandCodePrompt(options.messages, { includeHistory: false }) : options.prompt;
    const freshPrompt = newMapping && options.messages ? buildCommandCodePrompt(options.messages, { includeHistory: true }) : options.prompt;
    record.requests[request] = "started";
    delete record.events;
    delete record.cachedRequest;
    await save(file, record);
    const baseOptions: RunCliOptions = {
      ...options,
      onSession: async id => {
        record.sessionId = id;
        await save(file, record);
        await options.onSession?.(id);
      },
    };
    // A missing legacy session name is the only error that permits a fresh run.
    // Existing mappings never fall back, even if the CLI transcript was deleted.
    let missingLegacy = false;
    let visible = false;
    const events: CliMappedEvent[] = [];
    let bytes = 0;

    const run = async function* (fresh: boolean) {
      for await (const event of streamCommandCode({
        ...baseOptions, prompt: fresh ? freshPrompt : resumedPrompt,
        resumeSession: fresh ? undefined : record.sessionId || options.sessionName,
        sessionName: fresh ? options.sessionName : undefined,
      })) {
        if (!fresh && newMapping && !visible && !record.sessionId && event.kind === "error" && /^Error: No session ".+" found to resume\.$/.test(event.text)) {
          missingLegacy = true;
          continue;
        }
        visible = true;
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (bytes <= 2_000_000) events.push(event);
        if (event.kind === "finish") {
          record.requests[request] = "completed";
          if (bytes <= 2_000_000) { record.cachedRequest = request; record.events = events; }
          await save(file, record);
        }
        yield event;
      }
    };
    yield* run(false);
    if (missingLegacy && !visible) yield* run(true);
  } finally {
    try { if (locked) await rm(lock, { recursive: true, force: true }); }
    finally { release(); if (tails.get(key) === tail) tails.delete(key); }
  }
}
