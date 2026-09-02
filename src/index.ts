import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { runCliText } from "./cli.js";
import {
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  LOCAL_API_KEY,
  MODEL_HEADER,
  ANTHROPIC_NPM,
  PROVIDER_ID,
  PROVIDER_NAME,
  REQUEST_KIND_HEADER,
  SESSION_HEADER,
} from "./constants.js";
import {
  fallbackCommandCodeCliModels,
  findCommandCodeCliModel,
  getCommandCodeCliModels,
  refreshCommandCodeCliModels,
  type CommandCodeCliModel,
} from "./models.js";
import { getProxyBaseUrl, setRuntimeModels, startProxy, stopProxy } from "./proxy.js";
import { log } from "./log.js";

function providerModel(model: CommandCodeCliModel, baseURL: string): Record<string, unknown> {
  return {
    id: model.id,
    providerID: PROVIDER_ID,
    api: { id: model.id, url: baseURL, npm: ANTHROPIC_NPM },
    name: model.name,
    family: model.id.includes("/") ? model.id.slice(0, model.id.indexOf("/")) : undefined,
    capabilities: {
      temperature: false,
      reasoning: model.reasoning,
      attachment: false,
      // Command Code, not OpenCode, executes the tools in this adapter.
      toolcall: false,
      // Media metadata is retained below, but this argv bridge currently
      // forwards text only and therefore must not advertise media input.
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    modalities: model.modalities,
    cost: model.cost,
    limit: {
      context: model.contextWindow,
      ...(model.inputLimit !== undefined ? { input: model.inputLimit } : {}),
      output: model.maxOutput,
    },
    status: "active",
    // Usage is intentionally hidden from OpenCode. Command Code owns context
    // accounting and compaction inside its resumed CLI session.
    options: { includeUsage: false },
    headers: {},
    release_date: "",
    variants: {},
  };
}

function configModel(model: CommandCodeCliModel): Record<string, unknown> {
  return {
    name: model.name,
    reasoning: model.reasoning,
    interleaved: true,
    temperature: false,
    tool_call: false,
    attachment: false,
    modalities: model.modalities,
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: {
      context: model.contextWindow,
      ...(model.inputLimit !== undefined ? { input: model.inputLimit } : {}),
      output: model.maxOutput,
    },
    options: { includeUsage: false },
  };
}

function ensureProviderConfig(config: Record<string, any>, models: CommandCodeCliModel[]): void {
  if (!config.provider || typeof config.provider !== "object") config.provider = {};
  const existing = config.provider[PROVIDER_ID] && typeof config.provider[PROVIDER_ID] === "object"
    ? config.provider[PROVIDER_ID]
    : {};
  const existingOptions = existing.options && typeof existing.options === "object" ? existing.options : {};
  const existingModels = existing.models && typeof existing.models === "object" ? existing.models : {};
  const baseURL = getProxyBaseUrl();
  config.provider[PROVIDER_ID] = {
    ...existing,
    name: typeof existing.name === "string" && existing.name.trim() ? existing.name : PROVIDER_NAME,
    npm: ANTHROPIC_NPM,
    options: {
      ...existingOptions,
      baseURL,
      apiKey: LOCAL_API_KEY,
      includeUsage: false,
    },
    models: {
      ...Object.fromEntries(models.map((entry) => [entry.id, configModel(entry)])),
      ...existingModels,
    },
  };
}

async function installLocalProviderMarker(input: PluginInput): Promise<void> {
  const client = input.client as unknown as { auth?: { set?: (options: unknown) => Promise<unknown> } } | undefined;
  if (!client?.auth || typeof client.auth.set !== "function") return;
  try {
    await client.auth.set({
      path: { id: PROVIDER_ID },
      query: { directory: input.directory },
      body: { type: "api", key: LOCAL_API_KEY },
    });
  } catch (error) {
    log.warn("could not persist the local Command Code CLI provider marker", error instanceof Error ? error.message : error);
  }
}

async function cliIsAuthenticated(directory: string): Promise<boolean> {
  const result = await runCliText(["status"], { cwd: directory });
  return result.code === 0;
}

export const CommandCodeCliPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  try {
    await startProxy(input.directory);
  } catch (error) {
    log.warn("could not start the Command Code CLI proxy during plugin initialization", error instanceof Error ? error.message : error);
  }

  return {
    async config(config) {
      await startProxy(input.directory);
      await installLocalProviderMarker(input);
      const models = await refreshCommandCodeCliModels({ cwd: input.directory });
      setRuntimeModels(models);
      ensureProviderConfig(config as Record<string, any>, models);
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      const messageModel = hookInput.message.model as { variant?: unknown } | undefined;
      const variant = typeof messageModel?.variant === "string" ? messageModel.variant : undefined;
      output.headers[MODEL_HEADER] = hookInput.model.id;
      if (variant) output.headers[EFFORT_HEADER] = variant;
      output.headers[DIRECTORY_HEADER] = input.directory;
      if (hookInput.sessionID) output.headers[SESSION_HEADER] = hookInput.sessionID;
      if (hookInput.agent === "title") output.headers[REQUEST_KIND_HEADER] = "title";
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      // The official CLI owns model-specific thinking and temperature settings.
      delete output.options.reasoningEffort;
      delete output.options.temperature;
    },

    "experimental.provider.small_model": async (hookInput, output) => {
      if (hookInput.provider.id !== PROVIDER_ID) return;
      const preferred = getCommandCodeCliModels().find((entry) => /flash|haiku|mini/i.test(entry.id));
      const fallback = preferred ?? fallbackCommandCodeCliModels()[0];
      output.model = hookInput.provider.models[fallback.id] ?? Object.values(hookInput.provider.models)[0];
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        const models = await refreshCommandCodeCliModels({ cwd: input.directory });
        setRuntimeModels(models);
        const baseURL = getProxyBaseUrl();
        const entries = Object.fromEntries(models.map((entry) => [entry.id, providerModel(entry, baseURL)]));
        provider.models = entries as any;
        return entries as any;
      },
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Use the authenticated Command Code CLI",
          async authorize() {
            try {
              if (!(await cliIsAuthenticated(input.directory))) return { type: "failed" as const };
              return {
                type: "success" as const,
                provider: PROVIDER_ID,
                key: LOCAL_API_KEY,
                metadata: { instructions: "OpenCode will run the already-authenticated Command Code CLI." },
              };
            } catch (error) {
              log.warn("Command Code CLI authentication check failed", error instanceof Error ? error.message : error);
              return { type: "failed" as const };
            }
          },
        },
      ],
    },

    async dispose() {
      await stopProxy(input.directory);
    },
  };
};

export { getProxyBaseUrl, getProxyPort, startProxy, stopProxy } from "./proxy.js";
export {
  getCommandCodeCliModels,
  refreshCommandCodeCliModels,
  invalidateCommandCodeCliModelCache,
  parseCliModelList,
  parseOfficialPricingPage,
} from "./models.js";
export { buildCommandCodePrompt } from "./prompt.js";
export { LOCAL_API_KEY, PROVIDER_ID } from "./constants.js";

export default CommandCodeCliPlugin;
