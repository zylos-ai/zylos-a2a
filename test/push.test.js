import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { deliverTaskPush } from '../src/push.js';
import { STATES } from '../src/protocol.js';
import { TaskStore } from '../src/store.js';

test('terminal push is pinned, authenticated, and not redelivered after acknowledgement', async () => {
  let receivedBody = '';
  let receivedSignature = '';
  let receivedAuthorization = '';
  let receivedNotificationToken = '';
  const callback = http.createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', (chunk) => { receivedBody += chunk; });
    request.on('end', () => {
      receivedSignature = request.headers['x-a2a-signature'];
      receivedAuthorization = request.headers.authorization;
      receivedNotificationToken = request.headers['x-a2a-notification-token'];
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((resolve) => callback.listen(0, '127.0.0.1', resolve));
  const port = callback.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-push-'));
  const config = normalizeConfig({ push: { secret: 'push-secret', allow_private_callbacks: true } }, { dataDir });
  const store = new TaskStore(config.paths.databasePath);
  store.createTask({ id: 'task-3333333333333333', contextId: 'ctx-push', peer: 'alice', input: { text: 'work' }, maxTurns: 5 });
  store.setPushConfig('task-3333333333333333', 'alice', {
    url: `http://127.0.0.1:${port}/callback`,
    token: 'notification-token',
    authentication: { scheme: 'Bearer', credentials: 'callback-token' },
  });
  store.completeTask('task-3333333333333333', STATES.COMPLETED, 'done');
  try {
    assert.equal((await deliverTaskPush({ config, store, taskId: 'task-3333333333333333' })).delivered, true);
    const expected = crypto.createHmac('sha256', 'push-secret').update(receivedBody).digest('hex');
    assert.equal(receivedSignature, expected);
    assert.equal(receivedAuthorization, 'Bearer callback-token');
    assert.equal(receivedNotificationToken, 'notification-token');
    assert.equal(JSON.parse(receivedBody).statusUpdate.status.state, STATES.COMPLETED);
    assert.equal((await deliverTaskPush({ config, store, taskId: 'task-3333333333333333' })).reason, 'not-configured');
  } finally {
    store.close();
    await new Promise((resolve) => callback.close(resolve));
  }
});

test('failed push delivery is retried and remains pending after exhaustion', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-push-retry-'));
  const config = normalizeConfig({}, { dataDir });
  const store = new TaskStore(config.paths.databasePath);
  store.createTask({ id: 'task-4444444444444444', contextId: 'ctx-push', peer: 'alice', input: { text: 'work' }, maxTurns: 5 });
  const saved = store.setPushConfig('task-4444444444444444', 'alice', { url: 'https://callback.example.test/a2a' });
  store.completeTask('task-4444444444444444', STATES.COMPLETED, 'done');
  let attempts = 0;
  const result = await deliverTaskPush({
    config,
    store,
    taskId: 'task-4444444444444444',
    retryDelays: [0, 0],
    request: async () => {
      attempts += 1;
      throw new Error('temporary failure');
    },
  });
  assert.equal(attempts, 3);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(store.listTasksWithPendingPushes(), ['task-4444444444444444']);
  assert.equal(store.getPushConfig('task-4444444444444444', 'alice', saved.id).url, 'https://callback.example.test/a2a');
  store.close();
});
