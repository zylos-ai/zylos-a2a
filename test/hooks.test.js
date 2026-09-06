import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { TaskStore } from '../src/store.js';

test('pre-upgrade creates a consistent SQLite backup while the store is open', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-hook-'));
  const dataDir = path.join(homeDir, 'zylos/components/a2a');
  const databasePath = path.join(dataDir, 'tasks.sqlite');
  const store = new TaskStore(databasePath);
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, '{"enabled":true}\n', { mode: 0o644 });
  store.createTask({
    id: 'task-cccccccccccccccc',
    contextId: 'ctx-backup',
    peer: 'alice',
    input: { text: 'committed in WAL' },
    maxTurns: 5,
  });

  const hook = path.resolve('hooks/pre-upgrade.js');
  const result = spawnSync(process.execPath, [hook], {
    env: { ...process.env, HOME: homeDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const backupDir = path.join(dataDir, 'backups');
  const backupName = fs.readdirSync(backupDir).find((name) => name.startsWith('tasks.sqlite.'));
  const configBackupName = fs.readdirSync(backupDir).find((name) => name.startsWith('config.json.'));
  assert.ok(backupName);
  assert.ok(configBackupName);
  const backup = new TaskStore(path.join(backupDir, backupName));
  assert.equal(backup.getTask('task-cccccccccccccccc', 'alice').input.text, 'committed in WAL');
  assert.equal(fs.statSync(path.join(backupDir, backupName)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(backupDir, configBackupName)).mode & 0o777, 0o600);
  backup.close();
  store.close();
});

test('fresh install stays disabled until configure receives a bearer token', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-install-'));
  const postInstall = spawnSync(process.execPath, [path.resolve('hooks/post-install.js')], {
    env: { ...process.env, HOME: homeDir }, encoding: 'utf8',
  });
  assert.equal(postInstall.status, 0, postInstall.stderr);
  const configPath = path.join(homeDir, 'zylos/components/a2a/config.json');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).enabled, false);

  const configured = spawnSync(process.execPath, [path.resolve('hooks/configure.js')], {
    env: { ...process.env, HOME: homeDir },
    input: JSON.stringify({ BEARER_TOKEN: 'test-token' }),
    encoding: 'utf8',
  });
  assert.equal(configured.status, 0, configured.stderr);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.enabled, true);
  assert.equal(config.auth.bearer_token, 'test-token');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});
