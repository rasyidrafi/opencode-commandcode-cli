#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
if (process.env.REVIEW_LOG) appendFileSync(process.env.REVIEW_LOG, JSON.stringify({ args, prompt }) + '\n');
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const resumed = args[args.indexOf('--resume') + 1];
if (args.includes('--resume') && process.env.REVIEW_RESUME_ERROR) {
  emit({ type: 'result', subtype: 'error', error: 'Authentication failed' });
  process.exitCode = 1;
} else if (args.includes('--resume') && resumed.startsWith('opencode-')) {
  emit({ type: 'result', subtype: 'error', error: `Error: No session "${resumed}" found to resume.` });
  process.exitCode = 1;
} else if (prompt === 'early-error') {
  emit({ type: 'run_error', error: 'Authentication failed' });
  process.exitCode = 1;
} else {
  emit({ type: 'run_start', sessionId: 'fixture-session' });
  if (prompt === 'hang') await new Promise(resolve => setTimeout(resolve, 30000));
  if (prompt === 'fail-after-start') {
    emit({ type: 'run_error', error: 'Connection failed after workspace action' });
    process.exitCode = 1;
  } else {
    emit({ type: 'text_delta', delta: prompt });
    emit({ type: 'run_end', result: { stopReason: 'end_turn', finalText: prompt } });
    if (prompt === 'late-exit-error') process.exitCode = 1;
  }
}
