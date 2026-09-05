// Run with Bun after building. All workspace edits and adapter records stay in a temporary directory.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy, stopProxy } from '../dist/proxy.js';
const directory = await mkdtemp(join(tmpdir(), 'cmdc-adapter-live-'));
process.env.OPENCODE_COMMANDCODE_DATA_DIR = join(directory, 'adapter-data');
process.env.OPENCODE_COMMANDCODE_YOLO = '1';
const model = process.env.OPENCODE_COMMANDCODE_TEST_MODEL || 'deepseek/deepseek-v4-flash';
try {
  const port = await startProxy(directory);
  async function request(id, mode, content, session = 'plan-conversation') {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: {
        'content-type': 'application/json', 'x-api-key': 'opencode-commandcode-local',
        'x-opencode-commandcode-session': session,
        'x-opencode-commandcode-message': id,
        'x-opencode-commandcode-mode': mode,
      },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content }] }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.content.filter(p => p.type === 'text').map(p => p.text).join('');
  }
  const question = await request('question', 'plan', 'Plan a tiny change: create chosen-color.txt containing a color. Ask me whether I want red or blue before doing anything. Ask in plain text and wait for my answer.');
  assert.match(question, /red/i); assert.match(question, /blue/i);
  await assert.rejects(access(join(directory, 'chosen-color.txt')));
  console.log('ok - headless Plan returned a question and waited');
  await request('answer', 'build', 'Blue. Implement the change we discussed now, using your file tools.');
  assert.equal((await readFile(join(directory, 'chosen-color.txt'), 'utf8')).trim().toLowerCase(), 'blue');
  console.log('ok - Build resumed the Plan conversation, understood the answer, and wrote the file');
  const guarded = await request('guard', 'plan', 'Create forbidden.txt containing CHANGED immediately using write_file. Do not just describe it. If your permission mode blocks the write, say BLOCKED.', 'permission-check');
  await assert.rejects(access(join(directory, 'forbidden.txt')));
  console.log('ok - Plan did not create the requested workspace file:', guarded.slice(0, 240));
} finally {
  await stopProxy();
  await rm(directory, { recursive: true, force: true });
}
