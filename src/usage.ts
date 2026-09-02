import type { CliUsage } from "./cli.js";

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cost_usd?: number;
};

type SessionUsage = {
  session: string;
  turns: number;
  usage: CliUsage;
};

const values = new Map<string, SessionUsage>();

function emptyUsage(): CliUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(session: string, usage: CliUsage): void {
  const current = values.get(session) ?? { session, turns: 0, usage: emptyUsage() };
  current.turns += 1;
  current.usage.inputTokens += usage.inputTokens;
  current.usage.outputTokens += usage.outputTokens;
  current.usage.cacheReadTokens += usage.cacheReadTokens;
  current.usage.cacheWriteTokens += usage.cacheWriteTokens;
  if (usage.costUsd !== undefined) current.usage.costUsd = (current.usage.costUsd ?? 0) + usage.costUsd;
  values.set(session, current);
}

export function resetUsage(): void {
  values.clear();
}

export function toOpenAIUsage(usage: CliUsage): OpenAIUsage {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    ...(usage.cacheReadTokens || usage.cacheWriteTokens
      ? {
          prompt_tokens_details: {
            ...(usage.cacheReadTokens ? { cached_tokens: usage.cacheReadTokens } : {}),
            ...(usage.cacheWriteTokens ? { cache_write_tokens: usage.cacheWriteTokens } : {}),
          },
        }
      : {}),
    ...(usage.costUsd !== undefined ? { cost_usd: usage.costUsd } : {}),
  };
}

export function totalUsage(): CliUsage {
  const total = emptyUsage();
  for (const entry of values.values()) {
    total.inputTokens += entry.usage.inputTokens;
    total.outputTokens += entry.usage.outputTokens;
    total.cacheReadTokens += entry.usage.cacheReadTokens;
    total.cacheWriteTokens += entry.usage.cacheWriteTokens;
    if (entry.usage.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + entry.usage.costUsd;
  }
  return total;
}

export function listUsage(): Array<Record<string, unknown>> {
  return [...values.values()].map((entry) => ({
    session: entry.session,
    turns: entry.turns,
    usage: toOpenAIUsage(entry.usage),
  }));
}
