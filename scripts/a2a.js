#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { callPeer, discoverPeer, orchestrate } from '../src/outbound.js';
import { acceptPairingInvitation, createPairingInvitation } from '../src/pairing.js';
import { buildAgentCard } from '../src/protocol.js';
import { TaskStore } from '../src/store.js';

function usage() {
  console.error(`Usage:
  a2a.js card
  a2a.js discover <peer-or-url>
  a2a.js call <peer-or-url> [--context <id>] [message]
  a2a.js list
  a2a.js history <context-id> [--peer <peer>] [--limit <n>]
  a2a.js orchestrate <capability> [--mode all|first|best] [message]
  a2a.js pair create [--ttl <seconds>]
  a2a.js pair accept [--alias <name>] [--allow-private]
  a2a.js pair list
  a2a.js pair revoke <invitation-id>

For call/orchestrate, omit message to read it from stdin.
Pairing invitations are private credentials. Pass invitations to pair accept on stdin.`);
}

async function readStdin() {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  return value.trimEnd();
}

function takeOption(args, name, fallback = '') {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

const args = process.argv.slice(2);
const command = args.shift();
if (!command) {
  usage();
  process.exit(1);
}

const config = loadConfig();
let store;
try {
  let result;
  if (command === 'card') {
    if (args.length !== 0) throw new Error('card does not accept arguments');
    store = new TaskStore(config.paths.databasePath, { maxTasks: config.protocol.maxTasks });
    result = buildAgentCard(config, { requireAuthentication: store.hasBoundPeers() });
  } else if (command === 'discover') {
    if (args.length !== 1) throw new Error('discover requires one peer or URL');
    result = await discoverPeer(config, args[0]);
  } else if (command === 'call') {
    const target = args.shift();
    if (!target) throw new Error('call requires a peer or URL');
    const contextId = takeOption(args, '--context');
    const message = args.length > 0 ? args.join(' ') : await readStdin();
    if (!message) throw new Error('call requires a message on stdin or the command line');
    result = await callPeer(config, target, message, { contextId });
  } else if (command === 'list') {
    store = new TaskStore(config.paths.databasePath, { maxTasks: config.protocol.maxTasks });
    result = {
      peers: Object.fromEntries(Object.entries(config.outbound.peers).map(([name, peer]) => [name, { url: peer.url }])),
      contexts: store.listContexts(),
    };
  } else if (command === 'history') {
    const contextId = args.shift();
    if (!contextId) throw new Error('history requires a context id');
    const peer = takeOption(args, '--peer');
    const limit = Number(takeOption(args, '--limit', '20'));
    if (args.length > 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid history options');
    store = new TaskStore(config.paths.databasePath, { maxTasks: config.protocol.maxTasks });
    result = store.getHistory(peer, contextId, limit);
  } else if (command === 'orchestrate') {
    const capability = args.shift();
    if (!capability) throw new Error('orchestrate requires a capability');
    const mode = takeOption(args, '--mode', 'all');
    const message = args.length > 0 ? args.join(' ') : await readStdin();
    if (!message) throw new Error('orchestrate requires a message on stdin or the command line');
    result = await orchestrate(config, capability, message, { mode });
  } else if (command === 'pair') {
    const operation = args.shift();
    store = new TaskStore(config.paths.databasePath, { maxTasks: config.protocol.maxTasks });
    if (operation === 'create') {
      const ttlSeconds = Number(takeOption(args, '--ttl', '600'));
      if (args.length > 0 || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3_600) {
        throw new Error('pair create --ttl must be an integer from 60 to 3600 seconds');
      }
      result = createPairingInvitation(config, store, { ttlSeconds });
    } else if (operation === 'accept') {
      const alias = takeOption(args, '--alias');
      const allowPrivate = takeFlag(args, '--allow-private');
      if (args.length > 0) throw new Error('invalid pair accept options');
      if (process.stdin.isTTY) throw new Error('pair accept requires invitation JSON on stdin');
      const invitation = await readStdin();
      if (!invitation) throw new Error('pair accept requires invitation JSON on stdin');
      result = await acceptPairingInvitation(config, store, invitation, { alias, allowPrivate });
    } else if (operation === 'list') {
      if (args.length > 0) throw new Error('pair list does not accept arguments');
      result = store.listPairingInvitations();
    } else if (operation === 'revoke') {
      if (args.length !== 1) throw new Error('pair revoke requires one invitation id');
      result = store.revokePairingInvitation(args[0]);
      if (!result) throw new Error('pairing invitation not found');
    } else {
      throw new Error('pair requires create, accept, list, or revoke');
    }
  } else {
    throw new Error(`unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`A2A command failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  store?.close();
}
