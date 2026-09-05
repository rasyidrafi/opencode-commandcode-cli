import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { streamCommandCode, runCliText, cliInvocation } from '../dist/cli.js';
import { buildCommandCodePrompt } from '../dist/prompt.js';
import { runInSession, sessionKey, stableSessionName } from '../dist/session.js';
import { refreshCommandCodeModels, invalidateCommandCodeModelCache } from '../dist/models.js';
const executable = resolve('test/fixtures/review-cli.mjs');
const collect = async stream => { const result = []; for await (const event of stream) result.push(event); return result; };
const options = { cwd: process.cwd(), executable, yolo: false };

test('missing executable is a mapped error, and catalog command rejects normally', async () => {
  const missing = join(tmpdir(), 'missing-cmdc-' + Date.now());
  const events = await collect(streamCommandCode({ ...options, executable: missing, prompt: 'hello' }));
  assert.equal(events.at(-1).kind, 'error');
  assert.match(events.at(-1).text, /ENOENT/);
  await assert.rejects(runCliText([], { cwd: process.cwd(), executable: missing }), /ENOENT/);
});

test('stdin preserves large prompts and shell characters; plan overrides yolo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cmdc-args-'));
  process.env.REVIEW_LOG = join(directory, 'args.jsonl');
  try {
    const prompt = '漢字 $HOME $(echo bad) `echo bad` & | > "\n'.repeat(6000);
    const events = await collect(streamCommandCode({ ...options, prompt, plan: true, yolo: true }));
    assert.equal(events.filter(e => e.kind === 'text').map(e => e.text).join(''), prompt);
    const call = JSON.parse((await readFile(process.env.REVIEW_LOG, 'utf8')).trim());
    assert.ok(call.args.includes('--plan'));
    assert.ok(!call.args.includes('--yolo'));
    assert.ok(!call.args.includes(prompt));
    assert.equal(call.prompt, prompt);
  } finally { delete process.env.REVIEW_LOG; await rm(directory, { recursive: true, force: true }); }
});

test('Windows npm package entrypoint resolves without running its shim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cmdc-windows-'));
  try {
    const pkg = join(directory, 'node_modules', 'command-code');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ bin: { cmdc: 'cli.mjs' } }));
    await writeFile(join(pkg, 'cli.mjs'), '');
    const invocation = cliInvocation(join(directory, 'cmdc.cmd'), ['--model', 'x&echo BAD'], 'win32');
    assert.equal(invocation.command, 'node.exe');
    assert.deepEqual(invocation.args, [join(pkg, 'cli.mjs'), '--model', 'x&echo BAD']);
    assert.throws(() => cliInvocation(join(directory, 'unresolved', 'cmdc.cmd'), [], 'win32'), /without a shell/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('late nonzero exit cannot be reported as successful completion', async () => {
  const events = await collect(streamCommandCode({ ...options, prompt: 'late-exit-error' }));
  assert.ok(!events.some(e => e.kind === 'finish'));
  assert.equal(events.at(-1).kind, 'error');
});

test('abort terminates a waiting CLI', async () => {
  const signal = AbortSignal.timeout(250);
  await assert.rejects(collect(streamCommandCode({ ...options, prompt: 'hang', signal })), { name: 'AbortError' });
});

test('system instructions survive beyond previous 40k limit; history truncation is explicit', () => {
  const system = 'S'.repeat(50000) + ' KEEP THIS RULE';
  const prompt = buildCommandCodePrompt([{ role: 'system', content: system }, { role: 'assistant', content: 'X'.repeat(110000) + 'RECENT' }, { role: 'user', content: 'hello' }]);
  assert.ok(prompt.includes(system));
  assert.match(prompt, /earlier history truncated/);
  assert.match(prompt, /RECENT/);
});

test('document transport forms decode text and reject binary/malformed data', () => {
  const render = part => buildCommandCodePrompt([{ role: 'user', content: [part] }]);
  for (const part of [
    { type: 'document', source: { type: 'base64', media_type: 'text/plain', data: Buffer.from('hello漢字').toString('base64') } },
    { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello漢字' } },
    { type: 'file', file: { file_data: 'data:text/plain;base64,' + Buffer.from('hello漢字').toString('base64') } },
  ]) assert.match(render(part), /hello漢字/);
  assert.throws(() => render({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' } }), /Unsupported document type/);
  assert.throws(() => render({ type: 'document', source: { type: 'base64', media_type: 'text/plain', data: '%%%bad' } }), /Invalid base64/);
  assert.throws(() => render({ type: 'document', source: { type: 'url', url: 'https://example.com' } }), /inline text/);
});

test('metadata network and JSON errors retain CLI-discovered models', async () => {
  for (const mode of ['network', 'json']) {
    invalidateCommandCodeModelCache();
    const models = await refreshCommandCodeModels({
      runText: async () => ({ code: 0, stdout: 'custom/review-model    Review model\n', stderr: '' }),
      fetchFn: async (_url, init) => {
        assert.ok(init.signal instanceof AbortSignal);
        if (mode === 'network') throw new Error('offline');
        return new Response('invalid json');
      },
    });
    assert.deepEqual(models.map(m => m.id), ['custom/review-model']);
  }
});

test('sessions persist resume, deduplicate retries, and refuse interrupted replay or locks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cmdc-session-'));
  process.env.OPENCODE_COMMANDCODE_DATA_DIR = directory;
  process.env.REVIEW_LOG = join(directory, 'calls.jsonl');
  const key = sessionKey(directory, 'host-session');
  const base = { ...options, sessionName: stableSessionName(key) };
  const calls = async () => (await readFile(process.env.REVIEW_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  try {
    const messages = [{ role: 'user', content: 'historical message' }, { role: 'assistant', content: 'prior answer' }, { role: 'user', content: 'current message' }];
    const first = await collect(runInSession(key, { ...base, requestId: 'one', prompt: '', messages }));
    assert.equal(first.at(-1).kind, 'finish');
    assert.equal((await calls()).length, 2);
    assert.match((await calls())[1].prompt, /historical message/);
    const stored = JSON.parse(await readFile(join(directory, key + '.json'), 'utf8'));
    assert.equal(stored.sessionId, 'fixture-session');
    const retry = await collect(runInSession(key, { ...base, requestId: 'one', prompt: '', messages }));
    assert.deepEqual(retry, first);
    assert.equal((await calls()).length, 2);
    await collect(runInSession(key, { ...base, requestId: 'two', prompt: '', messages }));
    assert.equal((await calls()).at(-1).args.includes('fixture-session'), true);
    assert.ok(!(await calls()).at(-1).prompt.includes('historical message'));
    await collect(runInSession(key, { ...base, requestId: 'three', prompt: 'fail-after-start' }));
    await assert.rejects(collect(runInSession(key, { ...base, requestId: 'three', prompt: 'fail-after-start' })), /already started/);
    const before = (await calls()).length;
    const error = await collect(runInSession(key, { ...base, requestId: 'four', prompt: 'early-error' }));
    assert.equal(error.at(-1).kind, 'error');
    assert.equal((await calls()).length, before + 1);
    await mkdir(join(directory, key + '.json.lock'));
    await assert.rejects(collect(runInSession(key, { ...base, requestId: 'five', prompt: 'hi' })), /locked/);
  } finally {
    delete process.env.OPENCODE_COMMANDCODE_DATA_DIR; delete process.env.REVIEW_LOG;
    await rm(directory, { recursive: true, force: true });
  }
});


test('first resume authentication failure never launches a fresh run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cmdc-auth-'));
  process.env.OPENCODE_COMMANDCODE_DATA_DIR = directory;
  process.env.REVIEW_LOG = join(directory, 'calls.jsonl');
  process.env.REVIEW_RESUME_ERROR = '1';
  try {
    const key = sessionKey(directory, 'auth');
    const events = await collect(runInSession(key, { ...options, sessionName: stableSessionName(key), prompt: 'hello' }));
    assert.equal(events.at(-1).kind, 'error');
    assert.match(events.at(-1).text, /Authentication/);
    assert.equal((await readFile(process.env.REVIEW_LOG, 'utf8')).trim().split('\n').length, 1);
  } finally {
    delete process.env.REVIEW_RESUME_ERROR; delete process.env.REVIEW_LOG; delete process.env.OPENCODE_COMMANDCODE_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a second Node process cannot enter an active session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cmdc-process-lock-'));
  process.env.OPENCODE_COMMANDCODE_DATA_DIR = directory;
  const key = sessionKey(directory, 'concurrent');
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const active = collect(runInSession(key, { ...options, sessionName: stableSessionName(key), prompt: 'hang', signal: controller.signal, onSession: async () => started() }));
  // Attach the rejection handler before aborting.
  const stopped = assert.rejects(active, { name: 'AbortError' });
  try {
    await ready;
    const script = `import {runInSession} from ${JSON.stringify(new URL('../dist/session.js', import.meta.url).href)};
      try { for await (const e of runInSession(${JSON.stringify(key)}, ${JSON.stringify({ ...options, sessionName: stableSessionName(key), prompt: 'second' })})) {} process.exitCode=1; }
      catch(e) { console.log(e.message); process.exitCode=e.message.includes('locked')?0:2; }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0); assert.match(stdout, /locked/);
  } finally {
    controller.abort(); await stopped;
    delete process.env.OPENCODE_COMMANDCODE_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});
