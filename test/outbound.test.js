import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { callPeer, discoverPeer } from '../src/outbound.js';
import { STATES } from '../src/protocol.js';
import { TaskStore } from '../src/store.js';

test('discovery falls back to the legacy card and calls the advertised same-origin JSON-RPC interface', async () => {
  const requests = [];
  let baseUrl = '';
  const peerServer = http.createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers['a2a-version'] || ''}`);
    if (request.url === '/.well-known/agent-card.json') {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    if (request.url === '/.well-known/agent.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        name: 'legacy-peer',
        supportedInterfaces: [{ url: `${baseUrl}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        skills: [],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/rpc') {
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          task: {
            id: 'remote-task',
            contextId: rpc.params.message.contextId,
            status: { state: STATES.COMPLETED, message: { role: 'ROLE_AGENT', parts: [{ text: 'legacy success' }] } },
          },
        },
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => peerServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${peerServer.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-outbound-'));
  const config = normalizeConfig({
    outbound: {
      allow_private_peers: true,
      peers: { legacy: { url: baseUrl, allow_private: true } },
    },
  }, { dataDir });
  try {
    assert.equal((await discoverPeer(config, 'legacy')).name, 'legacy-peer');
    const reply = await callPeer(config, 'legacy', 'hello');
    assert.equal(reply.text, 'legacy success');
    assert.match(reply.contextId, /^ctx-/);
    assert.equal(requests.includes('GET /.well-known/agent-card.json 1.0'), true);
    assert.equal(requests.includes('GET /.well-known/agent.json 0.3'), true);
    assert.equal(requests.includes('POST /rpc 1.0'), true);
    const store = new TaskStore(config.paths.databasePath);
    assert.deepEqual(store.getHistory('legacy', reply.contextId, 10).map((item) => item.text), ['hello', 'legacy success']);
    store.close();
  } finally {
    await new Promise((resolve) => peerServer.close(resolve));
  }
});

test('a genuine v0.3 peer receives the legacy method and version header', async () => {
  let rpcMethod = '';
  let rpcVersion = '';
  const peerServer = http.createServer(async (request, response) => {
    if (request.url === '/.well-known/agent-card.json') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.url === '/.well-known/agent.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        name: 'v0.3-peer', protocolVersion: '0.3.0', url: baseUrl, preferredTransport: 'JSONRPC', skills: [],
      }));
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    rpcMethod = rpc.method;
    rpcVersion = request.headers['a2a-version'];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      jsonrpc: '2.0', id: rpc.id,
      result: {
        id: 'legacy-task', contextId: rpc.params.message.contextId,
        status: { state: STATES.COMPLETED, message: { role: 'ROLE_AGENT', parts: [{ text: 'legacy reply' }] } },
      },
    }));
  });
  await new Promise((resolve) => peerServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${peerServer.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-a2a-v03-'));
  const config = normalizeConfig({
    outbound: { allow_private_peers: true, peers: { legacy: { url: baseUrl, allow_private: true } } },
  }, { dataDir });
  try {
    const reply = await callPeer(config, 'legacy', 'hello');
    assert.equal(reply.text, 'legacy reply');
    assert.equal(rpcMethod, 'message/send');
    assert.equal(rpcVersion, '0.3');
  } finally {
    await new Promise((resolve) => peerServer.close(resolve));
  }
});
