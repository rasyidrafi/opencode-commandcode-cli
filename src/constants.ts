export const PROVIDER_ID = "commandcode";
export const PROVIDER_NAME = "Command Code CLI";
export const ANTHROPIC_NPM = "@ai-sdk/anthropic";
export const LOCAL_API_KEY = "opencode-commandcode-local";

export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash";
export const DEFAULT_CONTEXT_WINDOW = 256_000;
export const DEFAULT_MAX_OUTPUT = 32_768;

export const MODEL_HEADER = "x-opencode-commandcode-model";
export const EFFORT_HEADER = "x-opencode-commandcode-effort";
export const SESSION_HEADER = "x-opencode-commandcode-session";
export const DIRECTORY_HEADER = "x-opencode-commandcode-directory";
export const REQUEST_KIND_HEADER = "x-opencode-commandcode-request-kind";

export const DEFAULT_MAX_TURNS = 100;
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SSE_HEARTBEAT_MS = 5_000;

export const FALLBACK_MODEL_IDS = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "moonshotai/kimi-k2.7-code",
  "zai-org/glm-5.2",
  "qwen/qwen3.8-27b",
  "meituan/longcat-2.0:free",
  "poolside/laguna-s-2.1-free",
];

export function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function envNumber(name: string, fallback: number, minimum = 0): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}
