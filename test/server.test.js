import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { STATES } from '../src/protocol.js';
import { createA2AServer } from '../src/server.js';
import { TaskStore } from '../src/store.js';
import { callPeer } from '../src/outbound.js';

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-server-'));
  const config = normalizeConfig({
    server: { host: '127.0.0.1', port: 9900, request_timeout_ms: 2_000 },
    auth: { peer_tokens: { alice: 'alice-token', bob: 'bob-token' }, trusted_peers: ['alice', 'bob'] },
  }, { dataDir });
  config.server.port = 0;
  const store = new TaskStore(config.paths.databasePath);
  return { config, store };
}

async function rpc(port, token, method, params = {}, id = 'rpc-1', version = '1.0') {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'A2A-Version': version },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { response, body: await response.json() };
}

function userMessage(text, extra = {}) {
  return { role: 'ROLE_USER', messageId: `msg-${text.replaceAll(/\W/g, '-')}`, parts: [{ text }], ...extra };
}

test('canonical SendMessage flows through durable task completion', async () => {
  const { config, store } = fixture();
  const service = createA2AServer({
    config,
    store,
    forwardTask: async ({ task }) => {
      setTimeout(() => store.completeTask(task.id, STATES.COMPLETED, 'runtime reply'), 20);
      return { ok: true };
    },
    deliverPush: async () => ({ delivered: false }),
  });
  const address = await service.start();
  try {
    const cardResponse = await fetch(`http://127.0.0.1:${address.port}/.well-known/agent-card.json`);
    const card = await cardResponse.json();
    assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
    assert.equal(cardResponse.headers.get('x-robots-tag'), 'noindex, nofollow');

    const { body } = await rpc(address.port, 'alice-token', 'SendMessage', {
      message: userMessage('hello', { contextId: 'ctx-integration' }),
    });
    assert.equal(body.result.task.status.state, STATES.COMPLETED);
    assert.equal(body.result.task.artifacts[0].parts[0].text, 'runtime reply');
    assert.deepEqual(store.getHistory('alice', 'ctx-integration', 10).map((item) => item.text), ['hello', 'runtime reply']);

    const withHistory = await rpc(address.port, 'alice-token', 'GetTask', {
      taskId: body.result.task.id,
      historyLength: 2,
    });
    assert.deepEqual(withHistory.body.result.history.map((message) => message.parts[0].text), ['hello', 'runtime reply']);

    const audit = fs.readFileSync(config.paths.auditPath, 'utf8');
    assert.doesNotMatch(audit, /hello|runtime reply/);
    assert.match(audit, /5 characters/);

    const hidden = await rpc(address.port, 'bob-token', 'GetTask', { taskId: body.result.task.id });
    assert.equal(hidden.body.error.code, -32001);
  } finally {
    await service.stop();
    store.close();
  }
});

test('legacy message/send returns a bare Task', async () => {
  const { config, store } = fixture();
  const service = createA2AServer({
    config,
    store,
    forwardTask: async ({ task }) => {
      store.completeTask(task.id, STATES.COMPLETED, 'legacy reply');
      return { ok: true };
    },
    deliverPush: async () => ({ delivered: false }),
  });
  const address = await service.start();
  try {
    const { body } = await rpc(address.port, 'alice-token', 'message/send', {
      message: { role: 'ROLE_USER', parts: [{ text: 'legacy' }] },
    }, 'rpc-1', '0.3');
    assert.equal(body.result.status.state, STATES.COMPLETED);
    assert.equal(Object.hasOwn(body.result, 'task'), false);
  } finally {
    await service.stop();
    store.close();
  }
});

test('returnImmediately responds with the accepted task before Runtime completion', async () => {
  const { config, store } = fixture();
  const service = createA2AServer({
    config,
    store,
    forwardTask: async () => ({ ok: true }),
    deliverPush: async () => ({ delivered: false }),
  });
  const address = await service.start();
  try {
    const { body } = await rpc(address.port, 'alice-token', 'SendMessage', {
      message: userMessage('background work'),
      configuration: { returnImmediately: true },
    });
    assert.equal(body.result.task.status.state, STATES.WORKING);
  } finally {
    await service.stop();
    store.close();
  }
});

test('SubscribeToTask emits the current Task first and rejects terminal tasks', async () => {
  const { config, store } = fixture();
  const task = store.createTask({
    id: 'task-dddddddddddddddd', contextId: 'ctx-subscribe', peer: 'alice', input: { text: 'work' }, maxTurns: 5,
  });
  store.markWorking(task.id, 'alice');
  const service = createA2AServer({ config, store, deliverPush: async () => ({ delivered: false }) });
  const address = await service.start();
  try {
    setTimeout(() => store.completeTask(task.id, STATES.COMPLETED, 'done'), 20);
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alice-token', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'subscribe-1', method: 'SubscribeToTask', params: { id: task.id } }),
    });
    const frames = (await response.text()).split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    assert.equal(frames[0].result.task.id, task.id);
    assert.equal(frames.at(-1).result.statusUpdate.status.state, STATES.COMPLETED);

    const terminal = await rpc(address.port, 'alice-token', 'SubscribeToTask', { id: task.id }, 'subscribe-2');
    assert.equal(terminal.body.error.code, -32004);
  } finally {
    await service.stop();
    store.close();
  }
});

test('running CancelTask records intent and returns TaskNotCancelable', async () => {
  const { config, store } = fixture();
  const task = store.createTask({
    id: 'task-1111111111111111', contextId: 'ctx-cancel', peer: 'alice', input: { text: 'long work' }, maxTurns: 5,
  });
  store.markWorking(task.id, 'alice');
  const service = createA2AServer({ config, store, forwardTask: async () => ({ ok: true }) });
  const address = await service.start();
  try {
    const { body } = await rpc(address.port, 'alice-token', 'CancelTask', { taskId: task.id });
    assert.equal(body.error.code, -32002);
    assert.equal(body.error.data[0]['@type'], 'type.googleapis.com/google.rpc.ErrorInfo');
    assert.equal(body.error.data[0].metadata.cancellationRequested, 'true');
    assert.equal(store.getTask(task.id, 'alice').state, STATES.WORKING);
  } finally {
    await service.stop();
    store.close();
  }
});

test('unauthenticated operational requests fail closed', async () => {
  const { config, store } = fixture();
  const service = createA2AServer({ config, store });
  const address = await service.start();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, -32050);
  } finally {
    await service.stop();
    store.close();
  }
});

test('localhost-only mode rejects requests forwarded by a reverse proxy', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-proxy-'));
  const config = normalizeConfig({}, { dataDir });
  config.server.port = 0;
  const store = new TaskStore(config.paths.databasePath);
  const service = createA2AServer({ config, store });
  const address = await service.start();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.5', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'proxy-1', method: 'ListTasks', params: {} }),
    });
    assert.equal(response.status, 401);
  } finally {
    await service.stop();
    store.close();
  }
});

test('unsupported A2A versions are rejected explicitly', async () => {
  const { config, store } = fixture();
  const service = createA2AServer({ config, store });
  const address = await service.start();
  try {
    const { body } = await rpc(address.port, 'alice-token', 'ListTasks', {}, 'version-1', '2.0');
    assert.equal(body.error.code, -32009);
  } finally {
    await service.stop();
    store.close();
  }
});

test('streaming emits JSON-RPC-wrapped SSE task, status, artifact, and completion frames', async () => {
  const { config, store } = fixture();
  const service = createA2AServer({
    config,
    store,
    forwardTask: async ({ task }) => {
      setTimeout(() => store.completeTask(task.id, STATES.COMPLETED, 'streamed reply'), 10);
      return { ok: true };
    },
    deliverPush: async () => ({ delivered: false }),
  });
  const address = await service.start();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alice-token', 'A2A-Version': '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'stream-1', method: 'SendStreamingMessage',
        params: { message: userMessage('stream') },
      }),
    });
    const body = await response.text();
    const frames = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    assert.equal(frames.every((frame) => frame.jsonrpc === '2.0' && frame.id === 'stream-1'), true);
    assert.equal(frames.some((frame) => frame.result.task), true);
    assert.equal(frames.some((frame) => frame.result.artifactUpdate?.artifact.parts[0].text === 'streamed reply'), true);
    assert.equal(frames.at(-1).result.statusUpdate.status.state, STATES.COMPLETED);
    assert.match(body, /: done/);
  } finally {
    await service.stop();
    store.close();
  }
});

test('push config rejects private callback URLs and preserves the JSON-RPC id', async () => {
  const { config, store } = fixture();
  const task = store.createTask({
    id: 'task-2222222222222222', contextId: 'ctx-push', peer: 'alice', input: { text: 'work' }, maxTurns: 5,
  });
  const service = createA2AServer({ config, store });
  const address = await service.start();
  try {
    const { body } = await rpc(address.port, 'alice-token', 'CreateTaskPushNotificationConfig', {
      taskId: task.id,
      url: 'http://127.0.0.1:9000/callback',
    }, 'push-unsafe');
    assert.equal(body.id, 'push-unsafe');
    assert.equal(body.error.code, -32602);
    assert.match(body.error.message, /must use https|unsafe push callback URL/);
  } finally {
    await service.stop();
    store.close();
  }
});

test('outbound call uses the canonical protocol and redacts credentials', async () => {
  const { config, store } = fixture();
  let receivedText = '';
  const service = createA2AServer({
    config,
    store,
    forwardTask: async ({ task }) => {
      receivedText = task.input.text;
      store.completeTask(task.id, STATES.COMPLETED, 'peer reply');
      return { ok: true };
    },
    deliverPush: async () => ({ delivered: false }),
  });
  const address = await service.start();
  try {
    config.outbound.allowPrivatePeers = true;
    config.outbound.peers.local = { url: `http://127.0.0.1:${address.port}`, token: 'alice-token', allow_private: true };
    const result = await callPeer(config, 'local', 'use sk-abcdefghijklmnopqrstuvwxyz', { contextId: 'ctx-outbound' });
    assert.equal(result.text, 'peer reply');
    assert.equal(result.contextId, 'ctx-outbound');
    assert.equal(receivedText.includes('abcdefghijklmnopqrstuvwxyz'), false);
    assert.deepEqual(store.getHistory('local', 'ctx-outbound', 10).map((item) => item.text), [
      'use sk-[redacted]',
      'peer reply',
    ]);
    const audit = fs.readFileSync(config.paths.auditPath, 'utf8');
    assert.doesNotMatch(audit, /peer reply|abcdefghijklmnopqrstuvwxyz/);
  } finally {
    await service.stop();
    store.close();
  }
});

test('a queued cancellation wins the dispatch claim race', async () => {
  const { config, store } = fixture();
  let forwards = 0;
  let pushes = 0;
  const markWorking = store.markWorking.bind(store);
  store.markWorking = (taskId, peer) => {
    store.requestCancellation(taskId, peer);
    return markWorking(taskId, peer);
  };
  const service = createA2AServer({
    config,
    store,
    forwardTask: async () => { forwards += 1; },
    deliverPush: async () => { pushes += 1; return { delivered: false }; },
  });
  const address = await service.start();
  try {
    const { body } = await rpc(address.port, 'alice-token', 'SendMessage', {
      message: userMessage('cancel before dispatch'),
      configuration: { returnImmediately: true },
    });
    assert.equal(body.result.task.status.state, STATES.CANCELED);
    assert.equal(forwards, 0);
    assert.equal(pushes, 1);
  } finally {
    await service.stop();
    store.close();
  }
});

test('an interrupted task continues under the same task and context ids', async () => {
  const { config, store } = fixture();
  let turn = 0;
  const service = createA2AServer({
    config,
    store,
    forwardTask: async ({ task }) => {
      turn += 1;
      store.completeTask(task.id, turn === 1 ? STATES.INPUT_REQUIRED : STATES.COMPLETED, turn === 1 ? 'need details' : 'finished');
    },
    deliverPush: async () => ({ delivered: false }),
  });
  const address = await service.start();
  try {
    const first = await rpc(address.port, 'alice-token', 'SendMessage', { message: userMessage('start') });
    const task = first.body.result.task;
    assert.equal(task.status.state, STATES.INPUT_REQUIRED);
    const second = await rpc(address.port, 'alice-token', 'SendMessage', {
      message: userMessage('details', { taskId: task.id, contextId: task.contextId }),
    });
    assert.equal(second.body.result.task.id, task.id);
    assert.equal(second.body.result.task.contextId, task.contextId);
    assert.equal(second.body.result.task.status.state, STATES.COMPLETED);
    assert.deepEqual(store.getHistory('alice', task.contextId, 10).map((item) => item.text), [
      'start', 'need details', 'details', 'finished',
    ]);
  } finally {
    await service.stop();
    store.close();
  }
});

test('Runtime dispatch failures do not expose local diagnostics to the peer', async () => {
  const { config, store } = fixture();
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (value) => logged.push(value);
  const service = createA2AServer({
    config,
    store,
    forwardTask: async () => { throw new Error('/private/runtime/path secret stderr'); },
    deliverPush: async () => ({ delivered: false }),
  });
  const address = await service.start();
  try {
    const { body } = await rpc(address.port, 'alice-token', 'SendMessage', { message: userMessage('work') });
    const wire = JSON.stringify(body);
    assert.equal(body.result.task.status.state, STATES.FAILED);
    assert.match(wire, /Runtime dispatch failed/);
    assert.doesNotMatch(wire, /private\/runtime|secret stderr/);
    assert.match(logged.join('\n'), /private\/runtime\/path/);
  } finally {
    console.error = originalConsoleError;
    await service.stop();
    store.close();
  }
});

test('version negotiation uses major-minor semantics and matching method names', async () => {
  const { config, store } = fixture();
  const service = createA2AServer({
    config,
    store,
    forwardTask: async ({ task }) => store.completeTask(task.id, STATES.COMPLETED, 'ok'),
    deliverPush: async () => ({ delivered: false }),
  });
  const address = await service.start();
  try {
    const patchVersion = await rpc(address.port, 'alice-token', 'SendMessage', { message: userMessage('patch') }, 'patch', '1.0.1');
    assert.equal(patchVersion.body.result.task.status.state, STATES.COMPLETED);
    const mismatch = await rpc(address.port, 'alice-token', 'message/send', {
      message: { role: 'user', parts: [{ text: 'wrong method' }] },
    }, 'mismatch', '1.0');
    assert.equal(mismatch.body.error.code, -32601);
  } finally {
    await service.stop();
    store.close();
  }
});

test('push config CRUD supports multiple configs and idempotent deletion', async () => {
  const { config, store } = fixture();
  config.push.allowPrivateCallbacks = true;
  const task = store.createTask({
    id: 'task-push-crud', contextId: 'ctx-push-crud', peer: 'alice', input: { text: 'work' }, maxTurns: 5,
  });
  const service = createA2AServer({ config, store });
  const address = await service.start();
  try {
    for (const id of ['cfg-one', 'cfg-two']) {
      const created = await rpc(address.port, 'alice-token', 'CreateTaskPushNotificationConfig', {
        taskId: task.id,
        id,
        url: `http://127.0.0.1:9/${id}`,
        token: `${id}-token`,
        authentication: { scheme: 'Bearer', credentials: `${id}-credential` },
      }, `create-${id}`);
      assert.equal(created.body.result.id, id);
    }
    const listed = await rpc(address.port, 'alice-token', 'ListTaskPushNotificationConfigs', { taskId: task.id });
    assert.deepEqual(listed.body.result.configs.map((item) => item.id), ['cfg-one', 'cfg-two']);
    const fetched = await rpc(address.port, 'alice-token', 'GetTaskPushNotificationConfig', { taskId: task.id, id: 'cfg-two' });
    assert.equal(fetched.body.result.authentication.credentials, 'cfg-two-credential');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deleted = await rpc(address.port, 'alice-token', 'DeleteTaskPushNotificationConfig', { taskId: task.id, id: 'cfg-one' });
      assert.deepEqual(deleted.body.result, {});
    }
    assert.deepEqual(store.listPushConfigs(task.id, 'alice').map((item) => item.id), ['cfg-two']);
  } finally {
    await service.stop();
    store.close();
  }
});
