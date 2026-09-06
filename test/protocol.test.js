import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STATES,
  buildAgentCard,
  buildTask,
  extractContextId,
  extractText,
  methodInfo,
} from '../src/protocol.js';

test('canonical and legacy method names map to the same operations', () => {
  assert.deepEqual(methodInfo('SendMessage'), ['send', true]);
  assert.deepEqual(methodInfo('message/send'), ['send', false]);
  assert.deepEqual(methodInfo('SubscribeToTask'), ['subscribe', true]);
  assert.deepEqual(methodInfo('missing'), ['', false]);
});

test('extractText supports v1 text, file, raw, and data parts', () => {
  const text = extractText({ parts: [
    { text: 'hello', mediaType: 'text/plain' },
    { url: 'https://example.test/file', filename: 'a.txt', mediaType: 'text/plain' },
    { raw: 'YWJj', filename: 'b.bin' },
    { data: { answer: 42 }, mediaType: 'application/json' },
  ] });
  assert.match(text, /hello/);
  assert.match(text, /a\.txt.*example\.test/);
  assert.match(text, /4 base64 characters/);
  assert.match(text, /"answer":42/);
});

test('contextId prefers the v1 message member', () => {
  assert.equal(extractContextId({ contextId: 'legacy', message: { contextId: 'v1' } }), 'v1');
});

test('completed tasks carry v1 status and artifacts without non-proto timestamps', () => {
  const record = {
    id: 'task-123', contextId: 'ctx-123', state: STATES.COMPLETED,
    outputText: 'done', statusText: '', updatedAt: '2026-08-22T00:00:00.000Z',
  };
  const task = buildTask(record);
  assert.equal(task.status.state, STATES.COMPLETED);
  assert.equal(task.artifacts[0].parts[0].text, 'done');
  assert.equal(buildTask(record).artifacts[0].artifactId, task.artifacts[0].artifactId);
  assert.equal(buildTask(record).status.message.messageId, task.status.message.messageId);
  assert.equal(Object.hasOwn(task, 'createdAt'), false);
});

test('Agent Card advertises only the implemented JSON-RPC binding', () => {
  const card = buildAgentCard({
    server: { publicUrl: '', host: '127.0.0.1', port: 9900 },
    identity: { name: 'Zylos', description: 'agent', providerOrganization: 'Zylos', providerUrl: '', skills: [] },
    auth: { bearerToken: 'secret', peerTokens: {} },
  });
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(card.supportedInterfaces[0].url, 'http://127.0.0.1:9900/');
  assert.equal(card.url, undefined);
  assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: { list: [] } } }]);
  assert.equal(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme, 'Bearer');
  assert.equal(card.capabilities.streaming, true);
});
