import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { STATES } from '../src/protocol.js';
import { TaskStore } from '../src/store.js';

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-store-'));
  return { directory, databasePath: path.join(directory, 'tasks.sqlite') };
}

test('tasks and conversation history persist across store instances', () => {
  const fixture = temporaryDatabase();
  let store = new TaskStore(fixture.databasePath);
  store.createTask({ id: 'task-0000000000000001', contextId: 'ctx-1', peer: 'alice', input: { text: 'question' }, maxTurns: 5 });
  store.markWorking('task-0000000000000001', 'alice');
  store.completeTask('task-0000000000000001', STATES.COMPLETED, 'answer');
  store.close();

  store = new TaskStore(fixture.databasePath);
  assert.equal(store.getTask('task-0000000000000001', 'alice').outputText, 'answer');
  assert.deepEqual(store.getHistory('alice', 'ctx-1', 10).map((item) => item.text), ['question', 'answer']);
  assert.equal(fs.statSync(fixture.databasePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fixture.directory).mode & 0o777, 0o700);
  store.close();
});

test('task lookup is scoped to the authenticated peer', () => {
  const store = new TaskStore(':memory:');
  store.createTask({ id: 'task-0000000000000002', contextId: 'ctx-2', peer: 'alice', input: { text: 'private' }, maxTurns: 5 });
  assert.equal(store.getTask('task-0000000000000002', 'bob'), null);
  assert.equal(store.listTasks('bob').total, 0);
  store.close();
});

test('running cancellation is requested without falsely claiming interruption', () => {
  const store = new TaskStore(':memory:');
  store.createTask({ id: 'task-0000000000000003', contextId: 'ctx-3', peer: 'alice', input: { text: 'work' }, maxTurns: 5 });
  store.markWorking('task-0000000000000003', 'alice');
  const cancellation = store.requestCancellation('task-0000000000000003', 'alice');
  assert.equal(cancellation.outcome, 'requested');
  assert.equal(cancellation.task.state, STATES.WORKING);
  const completion = store.completeTask('task-0000000000000003', STATES.COMPLETED, 'late secret output');
  assert.equal(completion.task.state, STATES.CANCELED);
  assert.equal(completion.task.outputText, '');
  store.close();
});

test('queued cancellation prevents dispatch and resets the context turn counter', () => {
  const store = new TaskStore(':memory:');
  store.createTask({ id: 'task-0000000000000004', contextId: 'ctx-4', peer: 'alice', input: { text: 'work' }, maxTurns: 1 });
  assert.equal(store.requestCancellation('task-0000000000000004', 'alice').outcome, 'canceled');
  const next = store.createTask({ id: 'task-0000000000000005', contextId: 'ctx-4', peer: 'alice', input: { text: 'retry' }, maxTurns: 1 });
  assert.equal(next.state, STATES.SUBMITTED);
  store.close();
});

test('anti-loop limit rejects excess turns in one peer context', () => {
  const store = new TaskStore(':memory:');
  const first = store.createTask({ id: 'task-0000000000000006', contextId: 'ctx-5', peer: 'alice', input: { text: 'one' }, maxTurns: 1 });
  const second = store.createTask({ id: 'task-0000000000000007', contextId: 'ctx-5', peer: 'alice', input: { text: 'two' }, maxTurns: 1 });
  assert.equal(first.state, STATES.SUBMITTED);
  assert.equal(second.state, STATES.REJECTED);
  store.close();
});

test('task listing filters and paginates newest-first within peer scope', () => {
  const store = new TaskStore(':memory:');
  for (let index = 0; index < 3; index += 1) {
    const id = `task-${String(index).padStart(16, '0')}`;
    store.createTask({ id, contextId: index === 2 ? 'ctx-other' : 'ctx-page', peer: 'alice', input: { text: String(index) }, maxTurns: 5 });
    store.completeTask(id, index === 0 ? STATES.FAILED : STATES.COMPLETED, `reply-${index}`);
  }
  const first = store.listTasks('alice', { pageSize: 1 });
  assert.equal(first.total, 3);
  assert.equal(first.tasks.length, 1);
  assert.ok(first.nextPageToken);
  const second = store.listTasks('alice', { pageSize: 1, pageToken: first.nextPageToken });
  assert.equal(second.tasks.length, 1);
  assert.notEqual(second.tasks[0].id, first.tasks[0].id);
  const filtered = store.listTasks('alice', { contextId: 'ctx-page', state: STATES.COMPLETED });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.tasks[0].outputText, 'reply-1');
  store.close();
});

test('capacity evicts only terminal tasks without recoverable pushes', () => {
  const store = new TaskStore(':memory:', { maxTasks: 2 });
  store.createTask({ id: 'task-capacity-old', contextId: 'ctx-old', peer: 'alice', input: { text: 'old' }, maxTurns: 5 });
  store.completeTask('task-capacity-old', STATES.COMPLETED, 'done');
  store.createTask({ id: 'task-capacity-live', contextId: 'ctx-live', peer: 'alice', input: { text: 'live' }, maxTurns: 5 });
  store.markWorking('task-capacity-live', 'alice');
  store.createTask({ id: 'task-capacity-new', contextId: 'ctx-new', peer: 'alice', input: { text: 'new' }, maxTurns: 5 });
  assert.equal(store.getTask('task-capacity-old'), null);

  store.completeTask('task-capacity-new', STATES.COMPLETED, 'done');
  store.setPushConfig('task-capacity-new', 'alice', { url: 'https://callback.example.test/a2a' });
  assert.throws(
    () => store.createTask({ id: 'task-capacity-blocked', contextId: 'ctx-blocked', peer: 'alice', input: { text: 'blocked' }, maxTurns: 5 }),
    (error) => error.code === 'TASK_CAPACITY',
  );
  store.database.prepare('UPDATE push_configs SET delivery_attempts = 5 WHERE task_id = ?').run('task-capacity-new');
  assert.doesNotThrow(() => store.createTask({
    id: 'task-capacity-after-dead-letter', contextId: 'ctx-after', peer: 'alice', input: { text: 'after' }, maxTurns: 5,
  }));
  store.close();
});

test('interrupted task continuation reuses identity and resets push delivery', () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({
    id: 'task-continuation', contextId: 'ctx-continuation', peer: 'alice', input: { text: 'question', messageId: 'msg-question' }, maxTurns: 3,
  });
  store.markWorking(task.id, 'alice');
  store.completeTask(task.id, STATES.INPUT_REQUIRED, 'clarify');
  const push = store.setPushConfig(task.id, 'alice', { url: 'https://callback.example.test/a2a' });
  store.claimPushConfigs(task.id);
  store.finishPushDelivery(push.id, true);

  const result = store.continueTask(task.id, 'alice', { text: 'details', messageId: 'msg-details' }, 3);
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.task.id, task.id);
  assert.equal(result.task.state, STATES.SUBMITTED);
  assert.equal(store.claimPushConfigs(task.id).length, 1);
  const history = store.getHistory('alice', task.contextId, 10);
  assert.deepEqual(history.map((item) => item.text), ['question', 'clarify', 'details']);
  assert.equal(history[0].messageId, 'msg-question');
  assert.equal(history[2].messageId, 'msg-details');
  store.close();
});

test('legacy push schema migrates without dropping an uncertain delivery', () => {
  const fixture = temporaryDatabase();
  let store = new TaskStore(fixture.databasePath);
  store.createTask({ id: 'task-legacy-push', contextId: 'ctx-legacy-push', peer: 'alice', input: { text: 'work' }, maxTurns: 5 });
  store.completeTask('task-legacy-push', STATES.COMPLETED, 'done');
  store.close();

  const database = new DatabaseSync(fixture.databasePath);
  database.exec(`
    DROP TABLE push_configs;
    CREATE TABLE push_configs (
      config_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      peer TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
  `);
  database.prepare('INSERT INTO push_configs VALUES (?, ?, ?, ?, ?, ?)').run(
    'cfg-legacy', 'task-legacy-push', 'alice', 'https://callback.example.test/a2a',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z',
  );
  database.close();

  store = new TaskStore(fixture.databasePath);
  assert.equal(store.getPushConfig('task-legacy-push', 'alice', 'cfg-legacy').url, 'https://callback.example.test/a2a');
  assert.equal(store.releaseStalePushClaims('2026-01-02T00:00:00.000Z'), 1);
  assert.deepEqual(store.listTasksWithPendingPushes(), ['task-legacy-push']);
  assert.doesNotThrow(() => store.setPushConfig('task-legacy-push', 'alice', { url: 'https://second.example.test/a2a' }));
  store.close();
});

test('expiry is atomic and preserves another peer context with the same id', () => {
  const store = new TaskStore(':memory:');
  for (const peer of ['alice', 'bob']) {
    store.createTask({ id: `task-expire-${peer}`, contextId: 'ctx-shared', peer, input: { text: 'work' }, maxTurns: 1 });
    store.markWorking(`task-expire-${peer}`, peer);
  }
  store.database.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', 'task-expire-alice');
  assert.deepEqual(store.expireActiveTasks('2026-01-02T00:00:00.000Z'), ['task-expire-alice']);
  assert.equal(store.getTask('task-expire-alice').state, STATES.FAILED);
  assert.equal(store.getTask('task-expire-bob').state, STATES.WORKING);
  const bobNext = store.createTask({ id: 'task-expire-bob-next', contextId: 'ctx-shared', peer: 'bob', input: { text: 'again' }, maxTurns: 1 });
  assert.equal(bobNext.state, STATES.REJECTED);
  store.close();
});
