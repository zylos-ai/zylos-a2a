import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { requestJson } from './http-client.js';
import { buildAgentCard } from './protocol.js';
import { PAIRING_PERMISSIONS } from './store.js';

export const PAIRING_INVITATION_KIND = 'zylos-a2a-pairing-invitation';
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const INVITATION_ID_PATTERN = new RegExp(`^invite-${UUID_PATTERN}$`);
const AGENT_ID_PATTERN = new RegExp(`^agent-${UUID_PATTERN}$`);

function jsonRpcInterface(card) {
  const candidate = Array.isArray(card?.supportedInterfaces)
    ? card.supportedInterfaces.find((item) => item?.protocolBinding === 'JSONRPC' && item.url)
    : null;
  if (!candidate) throw new Error('pairing invitation has no JSON-RPC Agent Card interface');
  const url = new URL(candidate.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('pairing invitation has an invalid Agent Card URL');
  }
  return url;
}

function pairingUrl(card) {
  const url = jsonRpcInterface(card);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/pairing/redeem`;
  url.search = '';
  url.hash = '';
  return url.href;
}

function parseInvitation(value) {
  const invitation = typeof value === 'string' ? JSON.parse(value.trim()) : value;
  if (!invitation || typeof invitation !== 'object' || Array.isArray(invitation)) {
    throw new Error('pairing invitation must be a JSON object');
  }
  if (invitation.kind !== PAIRING_INVITATION_KIND || invitation.version !== 1) {
    throw new Error('pairing invitation format is not supported');
  }
  if (!INVITATION_ID_PATTERN.test(String(invitation.invitationId || ''))) {
    throw new Error('pairing invitation id is invalid');
  }
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(String(invitation.secret || ''))) {
    throw new Error('pairing invitation secret is invalid');
  }
  if (!AGENT_ID_PATTERN.test(String(invitation.inviter?.agentId || ''))) {
    throw new Error('pairing inviter identity is invalid');
  }
  if (Number.isNaN(Date.parse(invitation.expiresAt))) throw new Error('pairing invitation expiry is invalid');
  if (!Array.isArray(invitation.permissions)
    || invitation.permissions.length !== PAIRING_PERMISSIONS.length
    || !PAIRING_PERMISSIONS.every((permission) => invitation.permissions.includes(permission))) {
    throw new Error('pairing invitation permissions are not supported');
  }
  jsonRpcInterface(invitation.inviter?.card);
  return invitation;
}

function peerAlias(rawConfig, card, agentId, requestedAlias = '') {
  const base = String(requestedAlias || card.name || `agent-${agentId.slice(-8)}`).trim();
  if (!base || base.length > 128 || /[\u0000-\u001f\u007f]/.test(base)) throw new Error('peer alias is invalid');
  const peers = rawConfig.outbound?.peers ?? {};
  const url = jsonRpcInterface(card).href;
  const existing = Object.hasOwn(peers, base) ? peers[base] : null;
  if (!existing || existing.agent_id === agentId || (!existing.agent_id && existing.url === url)) return base;
  const suffix = `-${agentId.slice(-8)}`;
  const fallback = `${base.slice(0, 128 - suffix.length)}${suffix}`;
  const existingFallback = Object.hasOwn(peers, fallback) ? peers[fallback] : null;
  if (!existingFallback || existingFallback.agent_id === agentId) return fallback;
  throw new Error('peer alias already exists; choose a different --alias');
}

function storeOutboundPeer(configPath, card, agentId, token, requestedAlias, allowPrivate) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  raw.outbound ??= {};
  raw.outbound.peers ??= {};
  const alias = peerAlias(raw, card, agentId, requestedAlias);
  raw.outbound.peers[alias] = {
    url: jsonRpcInterface(card).href,
    token,
    agent_id: agentId,
    ...(allowPrivate ? { allow_private: true } : {}),
  };
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, configPath);
    fs.chmodSync(configPath, 0o600);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return alias;
}

async function verifyBoundCredential(card, token, allowPrivate, timeoutMs) {
  const requestId = randomUUID();
  const response = await requestJson(jsonRpcInterface(card), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'A2A-Version': '1.0',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'ListTasks',
      params: { pageSize: 1 },
    }),
    allowPrivate,
    timeoutMs,
  });
  if (response.json?.error) throw new Error(`paired credential was rejected: ${response.json.error.message}`);
  if (response.json?.jsonrpc !== '2.0' || response.json?.id !== requestId
    || !response.json.result || !Array.isArray(response.json.result.tasks)) {
    throw new Error('paired peer returned an invalid verification response');
  }
}

export function createPairingInvitation(config, store, { ttlSeconds = 600 } = {}) {
  if (!config.server.publicUrl) throw new Error('server.public_url must be configured before creating a pairing invitation');
  const created = store.createPairingInvitation({ ttlSeconds });
  return {
    kind: PAIRING_INVITATION_KIND,
    version: 1,
    invitationId: created.id,
    secret: created.secret,
    expiresAt: created.expiresAt,
    permissions: created.permissions,
    inviter: {
      agentId: store.getOrCreateAgentId(),
      card: buildAgentCard(config, { requireAuthentication: true }),
    },
  };
}

export async function acceptPairingInvitation(config, store, input, {
  alias = '', allowPrivate = false,
} = {}) {
  const invitation = parseInvitation(input);
  if (Date.parse(invitation.expiresAt) <= Date.now()) throw new Error('pairing invitation has expired');
  const localCard = buildAgentCard(config, { requireAuthentication: store.hasBoundPeers() });
  const response = await requestJson(pairingUrl(invitation.inviter.card), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invitationId: invitation.invitationId,
      secret: invitation.secret,
      peer: {
        agentId: store.getOrCreateAgentId(),
        name: config.identity.name,
        card: localCard,
      },
    }),
    allowPrivate,
    timeoutMs: config.outbound.timeoutMs,
  });
  const binding = response.json;
  const invitedUrl = jsonRpcInterface(invitation.inviter.card).href;
  if (binding?.agentId !== invitation.inviter.agentId
    || !/^[A-Za-z0-9_-]{40,128}$/.test(String(binding?.token || ''))
    || !binding?.card
    || jsonRpcInterface(binding.card).href !== invitedUrl) {
    throw new Error('pairing response did not match the invitation');
  }
  const configuredAlias = storeOutboundPeer(
    config.paths.configPath, binding.card, binding.agentId, binding.token, alias, allowPrivate,
  );
  try {
    await verifyBoundCredential(binding.card, binding.token, allowPrivate, config.outbound.timeoutMs);
  } catch {
    return {
      invitationId: invitation.invitationId,
      alias: configuredAlias,
      agentId: binding.agentId,
      name: binding.card.name,
      url: jsonRpcInterface(binding.card).href,
      verified: false,
      warning: 'peer was saved, but credential verification failed; retry a normal call before relying on it',
    };
  }
  return {
    invitationId: invitation.invitationId,
    alias: configuredAlias,
    agentId: binding.agentId,
    name: binding.card.name,
    url: jsonRpcInterface(binding.card).href,
    verified: true,
  };
}
