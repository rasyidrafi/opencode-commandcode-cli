import { createHash } from "node:crypto";
import type { CliMappedEvent, RunCliOptions } from "./cli.js";
import { streamCommandCode } from "./cli.js";

type SessionEntry = {
  tail: Promise<void>;
  sessionId?: string;
  started: boolean;
  attemptedNameResume: boolean;
  lastUsedAt: number;
};

const sessions = new Map<string, SessionEntry>();

export function sessionKey(directory: string, openCodeSessionId: string | undefined, prompt: string): string {
  const seed = `${directory}\0${openCodeSessionId || prompt}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

export function stableSessionName(key: string): string {
  return `opencode-${key.slice(0, 24)}`;
}

export function sessionHasStarted(key: string): boolean {
  return sessions.get(key)?.started === true;
}

export function forgetSessions(): void {
  sessions.clear();
}

/** Serialize turns for one OpenCode conversation before using `--resume`. */
export async function* runInSession(
  key: string,
  options: Omit<RunCliOptions, "resumeSession" | "sessionName"> & { sessionName: string },
): AsyncGenerator<CliMappedEvent, void, unknown> {
  let entry = sessions.get(key);
  if (!entry) {
    entry = {
      tail: Promise.resolve(),
      started: false,
      attemptedNameResume: false,
      lastUsedAt: Date.now(),
    };
    sessions.set(key, entry);
  }

  const previous = entry.tail.catch(() => undefined);
  let release!: () => void;
  entry.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  entry.lastUsedAt = Date.now();

  try {
    await previous;
    const runOptions: RunCliOptions = {
      ...options,
      ...(entry.started && entry.sessionId
        ? { resumeSession: entry.sessionId }
        : { sessionName: options.sessionName }),
    };

    // The in-memory map disappears when OpenCode starts a new process, but
    // Command Code's headless sessions remain on disk. Try the deterministic
    // name once so `opencode --continue` can pick up the same CLI session.
    if (!entry.started && !entry.attemptedNameResume) {
      entry.attemptedNameResume = true;
      const buffered: CliMappedEvent[] = [];
      let firstVisible = false;
      let resumeFailed = false;
      for await (const event of streamCommandCode({ ...runOptions, resumeSession: options.sessionName, sessionName: undefined })) {
        if (event.kind === "error" && !firstVisible) {
          resumeFailed = true;
          break;
        }
        buffered.push(event);
        if (event.kind === "finish") {
          entry.started = true;
          if (event.sessionId) entry.sessionId = event.sessionId;
        }
        if (event.kind === "text" || event.kind === "reasoning" || event.kind === "activity" || event.kind === "finish") {
          firstVisible = true;
          for (const pending of buffered.splice(0)) yield pending;
        }
        if (firstVisible && event.kind === "finish") break;
      }
      if (!resumeFailed) {
        for (const pending of buffered) yield pending;
        // The resume stream was consumed completely above. A finish event has
        // already updated the session entry, so the turn is done.
        if (firstVisible) return;
      }
    }

    const freshOptions = entry.started && entry.sessionId
      ? runOptions
      : { ...runOptions, resumeSession: undefined, sessionName: options.sessionName };
    let completed = false;
    for await (const event of streamCommandCode(freshOptions)) {
      if (event.kind === "finish") {
        completed = true;
        entry.started = true;
        if (event.sessionId) entry.sessionId = event.sessionId;
      }
      yield event;
    }
    if (!completed) entry.started = false;
  } finally {
    entry.lastUsedAt = Date.now();
    release();
  }
}
