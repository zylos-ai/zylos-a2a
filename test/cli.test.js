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
