import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../scripts/a2a.js', import.meta.url));

test('card prints shareable connection information without credentials', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-cli-'));
  const dataDir = path.join(homeDir, 'zylos', 'components', 'a2a');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    server: { public_url: 'https://momo.example.test/a2a' },
    identity: { name: 'Momo', description: 'Product agent' },
    auth: {
      bearer_token: 'shared-secret',
      peer_tokens: { weekday: 'peer-secret' },
      trusted_peers: ['weekday'],
    },
    outbound: {
      peers: { weekday: { url: 'https://weekday.example.test', token: 'outbound-secret' } },
    },
  }));

  const result = spawnSync(process.execPath, [cliPath, 'card'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  });

  assert.equal(result.status, 0, result.stderr);
  const card = JSON.parse(result.stdout);
  assert.equal(card.name, 'Momo');
  assert.equal(card.supportedInterfaces[0].url, 'https://momo.example.test/a2a/');
  assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: { list: [] } } }]);
  assert.doesNotMatch(result.stdout, /shared-secret|peer-secret|outbound-secret/);
});

test('pair create, list, and revoke expose invitation state without stored secrets', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-pair-cli-'));
  const dataDir = path.join(homeDir, 'zylos', 'components', 'a2a');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    server: { public_url: 'https://agent.example.test/a2a' },
    identity: { name: 'Pairing agent' },
  }));
  const run = (...args) => spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  });

  const createdResult = run('pair', 'create', '--ttl', '60');
  assert.equal(createdResult.status, 0, createdResult.stderr);
  const created = JSON.parse(createdResult.stdout);
  assert.match(created.secret, /^[A-Za-z0-9_-]{40,128}$/);
  assert.ok(created.inviter.card.securitySchemes?.bearer);

  const listedResult = run('pair', 'list');
  assert.equal(listedResult.status, 0, listedResult.stderr);
  const listed = JSON.parse(listedResult.stdout);
  assert.equal(listed[0].id, created.invitationId);
  assert.equal(listed[0].status, 'pending');
  assert.equal(listedResult.stdout.includes(created.secret), false);

  const revokedResult = run('pair', 'revoke', created.invitationId);
  assert.equal(revokedResult.status, 0, revokedResult.stderr);
  assert.equal(JSON.parse(revokedResult.stdout).status, 'revoked');
});
