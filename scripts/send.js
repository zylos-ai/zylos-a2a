#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { deliverTaskPush } from '../src/push.js';
import { STATES } from '../src/protocol.js';
import { appendAudit, redactOutbound } from '../src/security.js';
import { TaskStore } from '../src/store.js';

const [endpoint, ...messageParts] = process.argv.slice(2);
const match = /^task:(task-[a-f0-9]{16})$/i.exec(endpoint || '');
if (!match || messageParts.length === 0) {
  console.error('Usage: node scripts/send.js task:<task-id> "<message>"');
  process.exit(1);
}

const config = loadConfig();
const store = new TaskStore(config.paths.databasePath, { maxTasks: config.protocol.maxTasks });
const taskId = match[1];
const original = messageParts.join(' ');
const task = store.getTask(taskId);
if (!task) {
  store.close();
  console.error(`A2A task not found: ${taskId}`);
  process.exit(1);
}

let state = STATES.COMPLETED;
let output = redactOutbound(original).trim();
let status = '';
if (/^\[INPUT_REQUIRED\]/i.test(output)) {
  state = STATES.INPUT_REQUIRED;
  output = output.replace(/^\[INPUT_REQUIRED\]\s*/i, '');
} else if (/^\[A2A_FAILED\]/i.test(output)) {
  state = STATES.FAILED;
  status = output.replace(/^\[A2A_FAILED\]\s*/i, '') || 'Runtime reported failure';
  output = '';
} else if (/^\s*\[SKIP\]\s*$/i.test(output)) {
  state = STATES.FAILED;
  status = 'Runtime did not produce an A2A response';
  output = '';
}

const result = store.completeTask(taskId, state, output, status);
if (result.changed) {
  appendAudit(config.paths.auditPath, {
    direction: 'outbound',
    peer: task.peer,
    taskId,
    outcome: result.task.state,
    summary: `${original.length} characters`,
  });
  await deliverTaskPush({ config, store, taskId });
  console.log(`A2A task ${taskId} completed as ${result.task.state}`);
} else {
  console.log(`A2A task ${taskId} was already settled as ${result.task?.state || 'unknown'}`);
}
store.close();
