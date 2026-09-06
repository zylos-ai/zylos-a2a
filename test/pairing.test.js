import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { acceptPairingInvitation, createPairingInvitation } from '../src/pairing.js';
import { createA2AServer } from '../src/server.js';
import { TaskStore } from '../src/store.js';

function temporaryData(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zylos-a2a-${name}-`));
}

function peerCard(name, url = 'https://peer.example.test/a2a/') {
  return {
    name,
    supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url }],
  };
}

test('a pairing invitation binds once, retains audit state, and stores only credential hashes', () => {
  const dataDir = temporaryData('pairing-store');
  const store = new TaskStore(path.join(dataDir, 'tasks.sqlite'));
  const invitation = store.createPairingInvitation({ ttlSeconds: 60, currentMs: 1_000_000 });
  const peerId = 'agent-11111111-1111-4111-8111-111111111111';
  const first = store.redeemPairingInvitation({
    id: invitation.id,
    secret: invitation.secret,
    peerId,
    peerName: 'Receiver',
    card: peerCard('Receiver'),
  }, 1_001_000);

  assert.ok(first.token);
  assert.equal(store.authenticateBoundPeer(first.token), peerId);
  assert.deepEqual(store.getPairingInvitation(invitation.id), {
    id: invitation.id,
    status: 'bound',
    createdAt: new Date(1_000_000).toISOString(),
    expiresAt: new Date(1_060_000).toISOString(),
    permissions: ['a2a:tasks'],
    boundPeerId: peerId,
    boundPeerName: 'Receiver',
    boundAt: new Date(1_001_000).toISOString(),
    revokedAt: null,
  });
  assert.equal(store.redeemPairingInvitation({
    id: invitation.id,
    secret: invitation.secret,
    peerId: 'agent-22222222-2222-4222-8222-222222222222',
    peerName: 'Replay',
    card: peerCard('Replay'),
  }, 1_002_000), null);

  const persisted = fs.readFileSync(path.join(dataDir, 'tasks.sqlite'));
  assert.equal(persisted.includes(invitation.secret), false);
  assert.equal(persisted.includes(first.token), false);
  assert.doesNotMatch(JSON.stringify(store.listPairingInvitations()), /secret|token/i);
  store.close();
});

test('expired and revoked pairing invitations are rejected without losing their state', () => {
  const store = new TaskStore(':memory:');
  const peerId = 'agent-33333333-3333-4333-8333-333333333333';
  const expired = store.createPairingInvitation({ ttlSeconds: 60, currentMs: 2_000_000 });
  assert.equal(store.redeemPairingInvitation({
    id: expired.id, secret: expired.secret, peerId, peerName: 'Expired', card: peerCard('Expired'),
  }, 2_060_000), null);
  assert.equal(store.getPairingInvitation(expired.id).status, 'expired');

  const listedExpired = store.createPairingInvitation({ ttlSeconds: 60, currentMs: 4_000_000 });
  assert.equal(store.listPairingInvitations(4_060_000).find((item) => item.id === listedExpired.id).status, 'expired');

  const revokeBase = Date.now();
  const revoked = store.createPairingInvitation({ ttlSeconds: 60, currentMs: revokeBase });
  assert.equal(store.revokePairingInvitation(revoked.id).status, 'revoked');
  assert.equal(store.redeemPairingInvitation({
    id: revoked.id, secret: revoked.secret, peerId, peerName: 'Revoked', card: peerCard('Revoked'),
  }, revokeBase + 1_000), null);
  assert.equal(store.getPairingInvitation(revoked.id).status, 'revoked');
  store.close();
});

test('revoking a bound invitation disables its issued credential but retains the binding', () => {
  const store = new TaskStore(':memory:');
  const invitation = store.createPairingInvitation();
  const peerId = 'agent-44444444-4444-4444-8444-444444444444';
  const binding = store.redeemPairingInvitation({
    id: invitation.id,
    secret: invitation.secret,
    peerId,
    peerName: 'Receiver',
    card: peerCard('Receiver'),
  });
  const revoked = store.revokePairingInvitation(invitation.id);
  assert.equal(revoked.status, 'bound');
  assert.equal(revoked.boundPeerId, peerId);
  assert.ok(revoked.revokedAt);
  assert.equal(store.authenticateBoundPeer(binding.token), '');
  store.close();
});

test('concurrent redemption binds one peer, rejects the other generically, and authenticates the winner', async () => {
  const dataDir = temporaryData('pairing-server');
  const config = normalizeConfig({ server: { host: '127.0.0.1', port: 9900 } }, { dataDir });
  config.server.port = 0;
  const store = new TaskStore(config.paths.databasePath);
  const service = createA2AServer({ config, store });
  const address = await service.start();
  try {
    config.server.publicUrl = `http://127.0.0.1:${address.port}`;
    const invitation = createPairingInvitation(config, store);
    assert.ok(invitation.inviter.card.securitySchemes?.bearer);
    assert.doesNotMatch(JSON.stringify(invitation.inviter.card), /bearer[_-]?token|peer[_-]?tokens/i);

    const redemptionBody = {
      invitationId: invitation.invitationId,
      secret: invitation.secret,
      peer: {
        agentId: 'agent-55555555-5555-4555-8555-555555555555',
        card: peerCard('Receiver'),
      },
    };
    const redeem = (body) => fetch(`http://127.0.0.1:${address.port}/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const contender = structuredClone(redemptionBody);
    contender.peer.agentId = 'agent-88888888-8888-4888-8888-888888888888';
    contender.peer.card.name = 'Contender';
    const responses = await Promise.all([redeem(redemptionBody), redeem(contender)]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
    assert.deepEqual(bodies.find((_body, index) => responses[index].status === 400), {
      error: 'pairing request was rejected',
    });
    const first = bodies.find((_body, index) => responses[index].status === 200);
    assert.ok(first.token);
    assert.equal(responses.find((response) => response.status === 200).headers.get('cache-control'), 'no-store');

    const authenticated = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${first.token}`,
        'A2A-Version': '1.0',
        'X-Forwarded-For': '203.0.113.10',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'list-after-pairing', method: 'ListTasks', params: {} }),
    });
    assert.equal(authenticated.status, 200);
    assert.deepEqual((await authenticated.json()).result.tasks, []);
    const audit = fs.readFileSync(config.paths.auditPath, 'utf8');
    assert.doesNotMatch(audit, new RegExp(invitation.secret));
    assert.doesNotMatch(audit, new RegExp(first.token));
  } finally {
    await service.stop();
    store.close();
  }
});

test('malformed peer cards are generic client errors', async () => {
  const dataDir = temporaryData('pairing-malformed-card');
  const config = normalizeConfig({ server: { host: '127.0.0.1', port: 9900 } }, { dataDir });
  config.server.port = 0;
  const store = new TaskStore(config.paths.databasePath);
  const invitation = store.createPairingInvitation();
  const service = createA2AServer({ config, store });
  const address = await service.start();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invitationId: invitation.id,
        secret: invitation.secret,
        peer: {
          agentId: 'agent-99999999-9999-4999-8999-999999999999',
          card: { name: 'Malformed', supportedInterfaces: {} },
        },
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'pairing request was rejected' });
  } finally {
    await service.stop();
    store.close();
  }
});

test('invalid invitation ids behind one proxy cannot exhaust a valid invitation bucket', async () => {
  const dataDir = temporaryData('pairing-proxy-limit');
  const config = normalizeConfig({ server: { host: '127.0.0.1', port: 9900 } }, { dataDir });
  config.server.port = 0;
  const store = new TaskStore(config.paths.databasePath);
  const invitation = store.createPairingInvitation();
  const service = createA2AServer({ config, store });
  const address = await service.start();
  const redeem = (invitationId, secret) => fetch(`http://127.0.0.1:${address.port}/pairing/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
    body: JSON.stringify({
      invitationId,
      secret,
      peer: {
        agentId: 'agent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        card: peerCard('Proxy peer'),
      },
    }),
  });
  try {
    const invalid = await Promise.all(Array.from({ length: 20 }, (_value, index) => redeem(`invalid-${index}`, 'x')));
    assert.equal(invalid.every((response) => response.status === 400), true);
    assert.equal((await redeem(invitation.id, invitation.secret)).status, 200);
  } finally {
    await service.stop();
    store.close();
  }
});

test('static peer-name collisions cannot inherit bound-credential trust', async () => {
  const dataDir = temporaryData('pairing-provenance');
  const peerId = 'agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const config = normalizeConfig({
    server: { host: '127.0.0.1', port: 9900 },
    auth: { peer_tokens: { [peerId]: 'static-token' }, trusted_peers: ['different-peer'] },
  }, { dataDir });
  config.server.port = 0;
  const store = new TaskStore(config.paths.databasePath);
  const invitation = store.createPairingInvitation();
  const binding = store.redeemPairingInvitation({
    id: invitation.id,
    secret: invitation.secret,
    peerId,
    peerName: 'Bound peer',
    card: peerCard('Bound peer'),
  });
  const service = createA2AServer({ config, store });
  const address = await service.start();
  const listTasks = (token) => fetch(`http://127.0.0.1:${address.port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: token, method: 'ListTasks', params: {} }),
  });
  try {
    assert.equal((await listTasks('static-token')).status, 403);
    assert.equal((await listTasks(binding.token)).status, 200);
  } finally {
    await service.stop();
    store.close();
  }
});

test('accept imports the peer with mode 0600 and verifies the credential', async () => {
  const inviterData = temporaryData('pairing-inviter');
  const receiverData = temporaryData('pairing-receiver');
  const inviterConfig = normalizeConfig({ server: { host: '127.0.0.1', port: 9900 } }, { dataDir: inviterData });
  inviterConfig.server.port = 0;
  const inviterStore = new TaskStore(inviterConfig.paths.databasePath);
  const service = createA2AServer({ config: inviterConfig, store: inviterStore });
  const address = await service.start();
  try {
    inviterConfig.server.publicUrl = `http://127.0.0.1:${address.port}`;
    const invitation = createPairingInvitation(inviterConfig, inviterStore);
    const receiverRawConfig = {
      enabled: false,
      server: { host: '127.0.0.1', port: 9901, public_url: 'http://127.0.0.1:9901' },
      identity: { name: 'Receiver' },
      outbound: { allow_private_peers: false, peers: {} },
    };
    fs.writeFileSync(path.join(receiverData, 'config.json'), `${JSON.stringify(receiverRawConfig, null, 2)}\n`);
    const receiverConfig = normalizeConfig(receiverRawConfig, { dataDir: receiverData });
    const receiverStore = new TaskStore(receiverConfig.paths.databasePath);
    try {
      const result = await acceptPairingInvitation(receiverConfig, receiverStore, invitation, {
        alias: 'inviter', allowPrivate: true,
      });
      assert.equal(result.alias, 'inviter');
      assert.equal(result.verified, true);
      assert.equal(Object.hasOwn(result, 'token'), false);
      assert.equal(JSON.stringify(result).includes(invitation.secret), false);
      const saved = JSON.parse(fs.readFileSync(receiverConfig.paths.configPath, 'utf8'));
      assert.equal(saved.outbound.peers.inviter.agent_id, invitation.inviter.agentId);
      assert.ok(saved.outbound.peers.inviter.token);
      assert.equal(saved.outbound.peers.inviter.allow_private, true);
      assert.equal(fs.statSync(receiverConfig.paths.configPath).mode & 0o777, 0o600);
    } finally {
      receiverStore.close();
    }
  } finally {
    await service.stop();
    inviterStore.close();
  }
});

test('accept retains the issued credential when verification cannot be completed', async () => {
  const receiverData = temporaryData('pairing-unverified');
  const inviterAgentId = 'agent-66666666-6666-4666-8666-666666666666';
  const issuedToken = 'issued-token-kept-after-verification-failure';
  const fakePeer = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before responding.
    }
    const card = peerCard('Unverified inviter', `http://127.0.0.1:${fakePeer.address().port}/`);
    const body = request.url === '/pairing/redeem'
      ? { agentId: inviterAgentId, card, token: issuedToken, boundAt: new Date().toISOString() }
      : { jsonrpc: '2.0', id: 'remote-error', error: { code: -32050, message: issuedToken } };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => fakePeer.listen(0, '127.0.0.1', resolve));
  try {
    const rawConfig = {
      server: { host: '127.0.0.1', port: 9901, public_url: 'http://127.0.0.1:9901' },
      identity: { name: 'Receiver' },
      outbound: { peers: {} },
    };
    fs.writeFileSync(path.join(receiverData, 'config.json'), `${JSON.stringify(rawConfig, null, 2)}\n`);
    const config = normalizeConfig(rawConfig, { dataDir: receiverData });
    const store = new TaskStore(config.paths.databasePath);
    try {
      const inviterCard = peerCard('Unverified inviter', `http://127.0.0.1:${fakePeer.address().port}/`);
      const result = await acceptPairingInvitation(config, store, {
        kind: 'zylos-a2a-pairing-invitation',
        version: 1,
        invitationId: 'invite-77777777-7777-4777-8777-777777777777',
        secret: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        permissions: ['a2a:tasks'],
        inviter: { agentId: inviterAgentId, card: inviterCard },
      }, { alias: 'unverified', allowPrivate: true });
      assert.equal(result.verified, false);
      assert.match(result.warning, /peer was saved/);
      assert.doesNotMatch(result.warning, new RegExp(issuedToken));
      assert.equal(JSON.stringify(result).includes('remote-error'), false);
      const saved = JSON.parse(fs.readFileSync(config.paths.configPath, 'utf8'));
      assert.equal(saved.outbound.peers.unverified.token, issuedToken);
      assert.equal(saved.outbound.peers.unverified.allow_private, true);
    } finally {
      store.close();
    }
  } finally {
    await new Promise((resolve, reject) => fakePeer.close((error) => error ? reject(error) : resolve()));
  }
});
