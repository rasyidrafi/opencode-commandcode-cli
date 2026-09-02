import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandCodeCliConfigVariants,
  commandCodeCliModelVariants,
  fallbackCommandCodeCliModels,
  parseCommandCodeModelReference,
  parseCliModelList,
  parseOfficialPricingPage,
  resolveCommandCodeCliModel,
} from "../dist/models.js";
import { streamCommandCode } from "../dist/cli.js";
import { buildCommandCodePrompt } from "../dist/prompt.js";

test("parses the official CLI model list", () => {
  const models = parseCliModelList([
    "Available models  ·  2 models",
    "Open Source",
    "deepseek/deepseek-v4-flash             fast reasoning",
    "Anthropic",
    "claude-sonnet-5                         recommended",
    "Pass the full id, or just the short name after the last \"/\":",
  ].join("\n"));
  assert.deepEqual(models.map((model) => model.id), [
    "deepseek/deepseek-v4-flash",
    "claude-sonnet-5",
  ]);
});

test("parses Command Code effort metadata", () => {
  const efforts = parseCommandCodeModelReference([
    "| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | 1M | high, max | rates | Go |",
    "| `meta/muse-spark-1.2-contributor` | Muse Spark 1.2 Contributor | 1M | — | rates | Go |",
  ].join("\n"));
  assert.deepEqual(efforts["deepseek/deepseek-v4-flash"], ["high", "max"]);
  assert.deepEqual(efforts["meta/muse-spark-1.2-contributor"], []);
  assert.deepEqual(
    Object.keys(commandCodeCliModelVariants({ reasoningEfforts: efforts["meta/muse-spark-1.2-contributor"] })),
    [],
  );
  assert.deepEqual(
    Object.keys(commandCodeCliModelVariants({ reasoningEfforts: efforts["deepseek/deepseek-v4-flash"] })),
    ["high", "max"],
  );
  assert.deepEqual(commandCodeCliConfigVariants({ reasoningEfforts: [] }), {
    none: { disabled: true },
    minimal: { disabled: true },
    low: { disabled: true },
    medium: { disabled: true },
    high: { disabled: true },
    xhigh: { disabled: true },
    max: { disabled: true },
    thinking: { disabled: true },
  });
});

test("keeps LongCat 2.0 Free in the fallback catalog", () => {
  assert.ok(fallbackCommandCodeCliModels().some((model) => model.id === "meituan/longcat-2.0:free"));
});

test("resolves provider-qualified and short model ids", () => {
  assert.equal(
    resolveCommandCodeCliModel("commandcode-cli/deepseek/deepseek-v4-flash"),
    "deepseek/deepseek-v4-flash",
  );
  assert.equal(resolveCommandCodeCliModel("deepseek-v4-flash"), "deepseek/deepseek-v4-flash");
});

test("parses official pricing records without rounding decimal rates", () => {
  const records = parseOfficialPricingPage([
    String.raw`\"id\":\"deepseek-v4-flash\",\"name\":\"DeepSeek V4 Flash\",\"category\":\"opensource\",\"inputCost\":0.22,\"outputCost\":0.66,\"cacheReadCost\":0.007`,
    String.raw`\"id\":\"laguna-s-2.1-free\",\"name\":\"Laguna S 2.1\",\"category\":\"opensource\",\"contextWindow\":256000,\"tiers\":[{\"rates\":{\"input\":0,\"output\":0,\"cacheRead\":0}}]`,
  ].join(","));
  assert.equal(records[0].input, 0.22);
  assert.equal(records[0].output, 0.66);
  assert.equal(records[0].cacheRead, 0.007);
  assert.equal(records[1].contextWindow, 256000);
});

test("builds a quoted prompt for the CLI", () => {
  const prompt = buildCommandCodePrompt([
    { role: "system", content: "Use short answers." },
    { role: "user", content: "Remember ORBIT." },
    { role: "assistant", content: "I will remember it." },
    { role: "user", content: "What was the word?" },
  ]);
  assert.match(prompt, /<opencode-system>/);
  assert.match(prompt, /<opencode-history>/);
  assert.match(prompt, /Remember ORBIT/);
  assert.match(prompt, /<current-user-message>/);
});

test("reports activity for mapped events, not blank or non-JSON lines", async () => {
  if (process.platform === "win32") return;

  const directory = await mkdtemp(join(tmpdir(), "opencode-commandcode-cli-test-"));
  const executable = join(directory, "fake-cmdc.mjs");
  await writeFile(executable, `#!/usr/bin/env node
const error = process.argv.at(-1) === "error";
process.stdout.write("\\nnot-json\\n{}\\n");
if (error) {
  process.stdout.write(JSON.stringify({ type: "run_error", error: "fake failure" }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "thinking_delta", delta: "thinking" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text_delta", delta: "answer" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "tool_running", toolCallId: "tool-1", toolName: "shell" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "run_end", result: { stopReason: "stop", finalText: "answer" } }));
}
`);
  await chmod(executable, 0o755);

  try {
    const normalActivity = [];
    const normalEvents = [];
    for await (const event of streamCommandCode({
      cwd: directory,
      prompt: "normal",
      executable,
      onActivity: () => normalActivity.push("activity"),
    })) normalEvents.push(event);
    assert.deepEqual(normalEvents.map((event) => event.kind), ["reasoning", "text", "activity", "finish"]);
    assert.equal(normalActivity.length, normalEvents.length);

    const errorActivity = [];
    const errorEvents = [];
    for await (const event of streamCommandCode({
      cwd: directory,
      prompt: "error",
      executable,
      onActivity: () => errorActivity.push("activity"),
    })) errorEvents.push(event);
    assert.deepEqual(errorEvents.map((event) => event.kind), ["error"]);
    assert.equal(errorActivity.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

console.log("ok - smoke tests passed");
