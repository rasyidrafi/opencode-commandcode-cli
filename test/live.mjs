import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const executable = process.env.OPENCODE_COMMANDCODE_CLI || "cmdc";
const model = process.env.OPENCODE_COMMANDCODE_TEST_MODEL || "deepseek/deepseek-v4-flash";

const { refreshCommandCodeModels } = await import("../dist/models.js");
const metadata = await refreshCommandCodeModels({ cwd: process.cwd(), executable });
assert.ok(metadata.length >= 1);
const flash = metadata.find((entry) => entry.id === "deepseek/deepseek-v4-flash");
assert.equal(flash?.contextWindow, 1_000_000);
assert.equal(flash?.maxOutput, 384_000);
assert.equal(flash?.cost.input, 0.22);
assert.equal(flash?.cost.output, 0.66);
assert.equal(flash?.cost.cache.read, 0.007);
const laguna = metadata.find((entry) => entry.id === "poolside/laguna-s-2.1-free");
assert.equal(laguna?.contextWindow, 256_000);
assert.equal(laguna?.maxOutput, 32_768);
assert.equal(laguna?.cost.input, 0);
assert.equal(metadata.find((entry) => entry.id === "meta/muse-spark-1.2")?.name, "Muse Spark 1.2");
assert.equal(metadata.find((entry) => entry.id === "meta/muse-spark-1.2-contributor")?.name, "Muse Spark 1.2 Contributor");
const luna = metadata.find((entry) => entry.id === "gpt-5.6-luna");
assert.equal(luna?.inputLimit, 922_000);
assert.equal(luna?.cost.cache.write, 0.25);

function run(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const cwd = await mkdtemp(join(tmpdir(), "opencode-commandcode-live-"));
const name = `opencode-cli-live-${Date.now()}`;
try {
  const first = await run(cwd, [
    "-p", "--output-format", "json", "--skip-onboarding", "--no-auto-update",
    "--max-turns", "3", "--name", name, "--model", model,
    "Reply with exactly CLI-ADAPTER-LIVE-OK and nothing else.",
  ]);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.match(first.stdout, /CLI-ADAPTER-LIVE-OK/);

  const second = await run(cwd, [
    "-p", "--output-format", "json", "--skip-onboarding", "--no-auto-update",
    "--max-turns", "3", "--resume", name, "--model", model,
    "Reply with exactly CLI-ADAPTER-RESUME-OK and nothing else.",
  ]);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /CLI-ADAPTER-RESUME-OK/);
  console.log(`ok - live CLI smoke passed with ${model}`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
