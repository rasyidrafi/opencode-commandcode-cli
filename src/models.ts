import { accessSync, constants as fsConstants, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { runCliText } from "./cli.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  DEFAULT_MODEL_ID,
  FALLBACK_MODEL_IDS,
} from "./constants.js";
import { log } from "./log.js";

export type ModelCost = {
  input: number;
  output: number;
  cache: { read: number; write: number };
};

export type CommandCodeCliModel = {
  id: string;
  name: string;
  description?: string;
  family?: string;
  contextWindow: number;
  inputLimit?: number;
  maxOutput: number;
  reasoning: boolean;
  /** Exact Command Code CLI effort levels. Empty means reasoning is not adjustable. */
  reasoningEfforts?: string[];
  vision: boolean;
  attachment: boolean;
  toolCall: boolean;
  structuredOutput: boolean;
  temperature: boolean;
  modalities: { input: string[]; output: string[] };
  cost: ModelCost;
  releaseDate?: string;
  lastUpdated?: string;
};

type ModelsDevRecord = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  family?: unknown;
  attachment?: unknown;
  reasoning?: unknown;
  reasoning_options?: unknown;
  tool_call?: unknown;
  structured_output?: unknown;
  temperature?: unknown;
  modalities?: unknown;
  limit?: unknown;
  release_date?: unknown;
  last_updated?: unknown;
};

const COMMAND_CODE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const COMMAND_CODE_MODEL_REFERENCE = "dist/bundled/command-code-knowledge/reference/models.md";
const OPENCODE_GENERATED_VARIANTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "thinking"] as const;

type OfficialPricingRecord = {
  id: string;
  name: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextWindow?: number;
  vision?: boolean;
  reasoning?: boolean;
};

const CATALOG_TTL_MS = 30 * 60 * 1000;
const MODELS_DEV_URL = "https://models.dev/models.json";
const COMMAND_CODE_PRICING_URL = "https://commandcode.ai/docs/resources/pricing-limits";

let cachedModels: CommandCodeCliModel[] | null = null;
let cachedAt = 0;
let refreshInFlight: Promise<CommandCodeCliModel[]> | null = null;

function displayName(id: string): string {
  const short = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return short
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => COMMAND_CODE_EFFORTS.has(item));
  return [...new Set(efforts)];
}

function executableCandidates(executable: string): string[] {
  const value = executable.trim();
  if (!value) return [];
  if (isAbsolute(value) || value.includes("/") || value.includes("\\")) return [value];

  const result: string[] = [];
  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    result.push(join(directory, value));
    if (process.platform === "win32") {
      for (const extension of (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")) {
        result.push(join(directory, `${value}${extension}`));
      }
    }
  }
  return result;
}

function commandCodeReferencePath(executable: string): string | undefined {
  for (const candidate of executableCandidates(executable)) {
    try {
      accessSync(candidate, fsConstants.F_OK);
      let current = dirname(realpathSync(candidate));
      for (let depth = 0; depth < 8; depth += 1) {
        const paths = [
          join(current, COMMAND_CODE_MODEL_REFERENCE),
          join(current, "bundled/command-code-knowledge/reference/models.md"),
        ];
        for (const path of paths) {
          try {
            accessSync(path, fsConstants.R_OK);
            return path;
          } catch {
            // Keep walking up from wrappers, bin directories, and package dist directories.
          }
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch {
      // The configured executable may be a shell alias or an unavailable path.
    }
  }
  return undefined;
}

/** Parse the Command Code CLI's generated model reference, including effort support. */
export function parseCommandCodeModelReference(markdown: string): Record<string, string[]> {
  const models: Record<string, string[]> = {};
  for (const rawLine of markdown.split(/\r?\n/)) {
    const cells = rawLine.split("|").map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const idCell = cells[1];
    const effortCell = cells[4];
    if (!idCell || !effortCell || !idCell.startsWith("`") || !idCell.endsWith("`")) continue;
    const id = idCell.slice(1, -1).trim();
    if (!id || id.toLowerCase() === "id") continue;

    const efforts = effortCell === "—" || effortCell === "-"
      ? []
      : normalizeEfforts(effortCell.split(",")) ?? [];
    models[id.toLowerCase()] = efforts;
  }
  return models;
}

function loadCommandCodeEffortCatalog(executable?: string): Record<string, string[]> | undefined {
  const configured = executable?.trim() || process.env.OPENCODE_COMMANDCODE_CLI?.trim() || "cmdc";
  const path = commandCodeReferencePath(configured);
  if (!path) return undefined;
  try {
    return parseCommandCodeModelReference(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function modelsDevReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const effort = value.find((item) => recordValue(item)?.type === "effort");
  if (!effort) return undefined;
  return normalizeEfforts(recordValue(effort)?.values) ?? [];
}

function zeroCost(): ModelCost {
  return { input: 0, output: 0, cache: { read: 0, write: 0 } };
}

function fallbackModel(id: string, description?: string): CommandCodeCliModel {
  return {
    id,
    name: displayName(id),
    ...(description ? { description } : {}),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutput: DEFAULT_MAX_OUTPUT,
    reasoning: true,
    vision: /vision|multimodal|kimi-k2\.7-code/i.test(`${id} ${description ?? ""}`),
    attachment: false,
    toolCall: true,
    structuredOutput: false,
    temperature: false,
    modalities: { input: ["text"], output: ["text"] },
    cost: zeroCost(),
  };
}

export function fallbackCommandCodeCliModels(): CommandCodeCliModel[] {
  return FALLBACK_MODEL_IDS.map((id) => fallbackModel(id));
}

/** Parse the human-readable output of the official `cmdc --list-models`. */
export function parseCliModelList(output: string): CommandCodeCliModel[] {
  const models: CommandCodeCliModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    // Do not use `\s` here. It includes newlines and can turn section headers
    // into fake models when the CLI changes its blank-line formatting.
    const match = /^(\S+)[ \t]{2,}(.+?)[ \t]*$/.exec(line);
    if (!match) continue;
    const id = match[1].trim();
    const description = match[2].trim();
    if (!id || id === "Available" || id === "Pass" || id === "Docs:") continue;
    if (!/^[A-Za-z0-9._:/-]+$/.test(id)) continue;
    if (id.toLowerCase() === "models") continue;
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    models.push(fallbackModel(id, description));
  }
  return models;
}

function escapedNumber(segment: string, field: string): number | undefined {
  const pattern = new RegExp(`\\\\?"${field}\\\\?"[ \\t]*:[ \\t]*([0-9]+(?:\\.[0-9]+)?)`);
  return numberValue(pattern.exec(segment)?.[1]);
}

function escapedBoolean(segment: string, field: string): boolean | undefined {
  const pattern = new RegExp(`\\\\?"${field}\\\\?"[ \\t]*:[ \\t]*(true|false)`);
  const value = pattern.exec(segment)?.[1];
  return value === undefined ? undefined : value === "true";
}

/**
 * Extract the pricing records embedded in the official pricing documentation.
 * The page is rendered from these records, so this avoids maintaining a second
 * hand-written price table while still using Command Code's discounted rates.
 */
export function parseOfficialPricingPage(html: string): OfficialPricingRecord[] {
  const starts = [...html.matchAll(/\\?"id\\?":\\?"([^"\\]+)\\?",\\?"name\\?":\\?"([^"\\]+)\\?"/g)];
  const records: OfficialPricingRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index];
    const next = starts[index + 1];
    const segment = html.slice(match.index ?? 0, next?.index ?? html.length);
    if (!/\\?"category\\?":/.test(segment)) continue;
    const id = match[1];
    if (seen.has(id)) continue;

    const input = escapedNumber(segment, "inputCost") ?? escapedNumber(segment, "input");
    const output = escapedNumber(segment, "outputCost") ?? escapedNumber(segment, "output");
    const cacheRead = escapedNumber(segment, "cacheReadCost") ?? escapedNumber(segment, "cacheRead");
    const cacheWrite = escapedNumber(segment, "cacheWriteCost") ?? escapedNumber(segment, "cacheWrite");
    const contextWindow = escapedNumber(segment, "contextWindow");
    const vision = escapedBoolean(segment, "vision");
    const reasoning = escapedBoolean(segment, "reasoning");
    if (input === undefined && output === undefined && contextWindow === undefined) continue;
    seen.add(id);
    records.push({
      id,
      name: match[2],
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(vision !== undefined ? { vision } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    });
  }
  return records;
}

function officialCandidates(id: string): string[] {
  const short = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const candidates = [short, id];
  if (short === "hy3-paid" || short === "hy3") candidates.push("hy3-paid");
  if (short.endsWith("-free")) candidates.push(short.slice(0, -5));
  return [...new Set(candidates)];
}

function modelsDevCandidates(id: string): string[] {
  const short = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const provider = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
  const providerAliases: Record<string, string[]> = {
    "z-ai": ["zhipuai"],
    "zai-org": ["zhipuai"],
    qwen: ["alibaba"],
    minimaxai: ["minimax"],
  };
  const providers = [provider, ...(providerAliases[provider] ?? [])].filter(Boolean);
  const ids = [id, ...providers.map((name) => `${name}/${short}`)];
  if (short.endsWith("-free")) {
    const base = short.slice(0, -5);
    ids.push(...providers.map((name) => `${name}/${base}`));
  }
  if (short.endsWith("-paid")) {
    const base = short.slice(0, -5);
    ids.push(...providers.map((name) => `${name}/${base}`));
  }
  if (short.endsWith("-fast")) {
    const base = short.slice(0, -5);
    ids.push(...providers.map((name) => `${name}/${base}`));
  }
  if (short.endsWith("-contributor")) {
    const base = short.slice(0, -12);
    ids.push(...providers.map((name) => `${name}/${base}`));
  }
  return [...new Set(ids)];
}

function findOfficialPrice(id: string, pricing: OfficialPricingRecord[]): OfficialPricingRecord | undefined {
  const byKey = new Map(pricing.map((entry) => [normalizeKey(entry.id), entry]));
  for (const candidate of officialCandidates(id)) {
    const exact = byKey.get(normalizeKey(candidate));
    if (exact) return exact;
  }
  const short = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const aliases = [
    normalizeKey(short),
    normalizeKey(short.replace(/-preview$/i, "")),
    normalizeKey(short.replace(/-550b-a55b$/i, "")),
  ];
  return pricing.find((entry) => aliases.includes(normalizeKey(entry.id)));
}

function findModelsDev(id: string, metadata: Record<string, ModelsDevRecord>): ModelsDevRecord | undefined {
  const byKey = new Map(Object.entries(metadata).map(([key, value]) => [key.toLowerCase(), value]));
  for (const candidate of modelsDevCandidates(id)) {
    const exact = byKey.get(candidate.toLowerCase());
    if (exact) return exact;
  }
  const shortKey = normalizeKey(id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id).replace(/free$/, "");
  for (const [key, value] of Object.entries(metadata)) {
    const keyShort = normalizeKey(key.slice(key.lastIndexOf("/") + 1));
    if (keyShort === shortKey) return value;
  }
  return undefined;
}

function findModelsDevExact(id: string, metadata: Record<string, ModelsDevRecord>): ModelsDevRecord | undefined {
  const byKey = new Map(Object.entries(metadata).map(([key, value]) => [key.toLowerCase(), value]));
  return byKey.get(id.toLowerCase());
}

function metadataModel(
  base: CommandCodeCliModel,
  metadata: ModelsDevRecord | undefined,
  official: OfficialPricingRecord | undefined,
  reasoningEfforts: string[] | undefined,
): CommandCodeCliModel {
  const modalities = recordValue(metadata?.modalities);
  const inputModalities = Array.isArray(modalities?.input)
    ? modalities.input.filter((value): value is string => typeof value === "string")
    : official?.vision ? ["text", "image"] : base.modalities.input;
  const outputModalities = Array.isArray(modalities?.output)
    ? modalities.output.filter((value): value is string => typeof value === "string")
    : base.modalities.output;
  const limits = recordValue(metadata?.limit);
  // Command Code's published serving limit wins over the provider-agnostic
  // model limit when the two differ (Laguna is currently the notable case).
  const contextWindow = official?.contextWindow ?? numberValue(limits?.context) ?? base.contextWindow;
  const maxOutput = numberValue(limits?.output) ?? base.maxOutput;
  const inputLimit = numberValue(limits?.input);
  const cost: ModelCost = {
    input: official?.input ?? 0,
    output: official?.output ?? 0,
    cache: { read: official?.cacheRead ?? 0, write: official?.cacheWrite ?? 0 },
  };
  return {
    ...base,
    // Command Code's own model table is the display-name authority. Models.dev
    // can intentionally collapse a serving variant into its base model, which
    // is what previously made both Muse Spark entries display the same name.
    ...(official?.name ? { name: official.name } : typeof metadata?.name === "string" ? { name: metadata.name } : {}),
    ...(typeof metadata?.description === "string" ? { description: metadata.description } : base.description ? {} : official?.name ? { description: official.name } : {}),
    ...(typeof metadata?.family === "string" ? { family: metadata.family } : {}),
    contextWindow,
    ...(inputLimit !== undefined ? { inputLimit } : {}),
    maxOutput,
    reasoning: booleanValue(metadata?.reasoning, official?.reasoning ?? base.reasoning),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    vision: inputModalities.includes("image"),
    attachment: booleanValue(metadata?.attachment, inputModalities.some((value) => value !== "text")),
    toolCall: booleanValue(metadata?.tool_call, base.toolCall),
    structuredOutput: booleanValue(metadata?.structured_output, base.structuredOutput),
    temperature: booleanValue(metadata?.temperature, base.temperature),
    modalities: { input: inputModalities, output: outputModalities },
    cost,
    ...(typeof metadata?.release_date === "string" ? { releaseDate: metadata.release_date } : {}),
    ...(typeof metadata?.last_updated === "string" ? { lastUpdated: metadata.last_updated } : {}),
  };
}

export async function refreshCommandCodeCliModels(options: {
  cwd?: string;
  executable?: string;
  runText?: typeof runCliText;
  fetchFn?: typeof fetch;
} = {}): Promise<CommandCodeCliModel[]> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const fetchFn = options.fetchFn ?? fetch;
      const commandCodeEfforts = loadCommandCodeEffortCatalog(options.executable);
      const [cliResult, modelsDevResult, officialResult] = await Promise.all([
        (options.runText ?? runCliText)(
          ["--list-models", "--no-auto-update"],
          { cwd: options.cwd ?? process.cwd(), executable: options.executable },
        ),
        fetchFn(MODELS_DEV_URL),
        fetchFn(COMMAND_CODE_PRICING_URL),
      ]);
      if (cliResult.code !== 0) throw new Error(cliResult.stderr.trim() || `CLI exited with code ${cliResult.code ?? "unknown"}`);
      const listed = parseCliModelList(cliResult.stdout);
      if (!listed.length) throw new Error("CLI model list contained no models");

      const modelsDevPayload: unknown = modelsDevResult.ok ? await modelsDevResult.json() : {};
      const officialHtml = officialResult.ok ? await officialResult.text() : "";
      const modelsDev = recordValue(modelsDevPayload) as Record<string, ModelsDevRecord> | undefined;
      const pricing = parseOfficialPricingPage(officialHtml);
      const merged = listed.map((entry) => metadataModel(
        entry,
        modelsDev ? findModelsDev(entry.id, modelsDev) : undefined,
        findOfficialPrice(entry.id, pricing),
        commandCodeEfforts?.[entry.id.toLowerCase()] ?? modelsDevReasoningEfforts(
          modelsDev ? findModelsDevExact(entry.id, modelsDev)?.reasoning_options : undefined,
        ),
      ));
      cachedModels = merged;
      cachedAt = Date.now();
      log.info("loaded Command Code CLI models with external metadata", {
        count: merged.length,
        modelsDev: Object.keys(modelsDev ?? {}).length,
        effortCatalog: commandCodeEfforts ? Object.keys(commandCodeEfforts).length : 0,
        priced: merged.filter((entry) => entry.cost.input > 0 || entry.cost.output > 0 || entry.cost.cache.read > 0).length,
      });
      return merged;
    } catch (error) {
      if (cachedModels) {
        log.warn("Command Code CLI model refresh failed; keeping cached catalog", error instanceof Error ? error.message : error);
        return cachedModels;
      }
      cachedModels = fallbackCommandCodeCliModels();
      cachedAt = Date.now();
      log.warn("Command Code CLI metadata unavailable; using fallback", error instanceof Error ? error.message : error);
      return cachedModels;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export function invalidateCommandCodeCliModelCache(): void {
  cachedModels = null;
  cachedAt = 0;
}

export function getCommandCodeCliModels(): CommandCodeCliModel[] {
  if (!cachedModels) cachedModels = fallbackCommandCodeCliModels();
  if (Date.now() - cachedAt >= CATALOG_TTL_MS && !refreshInFlight) void refreshCommandCodeCliModels();
  return cachedModels;
}

export function resolveCommandCodeCliModel(modelId: string | undefined): string {
  const raw = (modelId ?? DEFAULT_MODEL_ID)
    .replace(/^commandcode-cli\//i, "")
    .replace(/^command-code-cli\//i, "")
    .trim();
  if (!raw) return DEFAULT_MODEL_ID;
  const models = getCommandCodeCliModels();
  const exact = models.find((entry) => entry.id.toLowerCase() === raw.toLowerCase());
  if (exact) return exact.id;
  if (!raw.includes("/")) {
    const suffix = models.find((entry) => entry.id.toLowerCase().endsWith(`/${raw.toLowerCase()}`));
    if (suffix) return suffix.id;
  }
  return raw;
}

export function findCommandCodeCliModel(modelId: string | undefined): CommandCodeCliModel {
  const resolved = resolveCommandCodeCliModel(modelId);
  return getCommandCodeCliModels().find(
    (entry) => entry.id.toLowerCase() === resolved.toLowerCase(),
  ) ?? fallbackModel(resolved);
}

/** Build the explicit OpenCode variant map from Command Code's effort list. */
export function commandCodeCliModelVariants(model: CommandCodeCliModel): Record<string, Record<string, unknown>> {
  return Object.fromEntries((model.reasoningEfforts ?? []).map((effort) => [effort, {}]));
}

/**
 * Add disabled tombstones for OpenCode's built-in variants. Config-defined
 * models are merged with provider defaults before OpenCode applies its own
 * filtering, so an empty map alone cannot suppress an inferred variant.
 */
export function commandCodeCliConfigVariants(model: CommandCodeCliModel): Record<string, Record<string, unknown>> {
  const supported = commandCodeCliModelVariants(model);
  const disabled = Object.fromEntries(
    OPENCODE_GENERATED_VARIANTS
      .filter((id) => !(id in supported))
      .map((id) => [id, { disabled: true }]),
  );
  return { ...disabled, ...supported };
}
