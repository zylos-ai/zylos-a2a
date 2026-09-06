import { randomUUID } from 'node:crypto';
import { requestJson } from './http-client.js';
import { extractText, newContextId, textMessage } from './protocol.js';
import { appendAudit, redactOutbound } from './security.js';
import { TaskStore } from './store.js';

function peerDefinition(config, target) {
  const configured = config.outbound.peers[target];
  let peer;
  if (configured && typeof configured === 'object') {
    if (!configured.url) throw new Error(`configured peer ${target} has no url`);
    peer = {
      name: target,
      url: String(configured.url),
      token: String(configured.token || ''),
      allowPrivate: configured.allow_private === true || config.outbound.allowPrivatePeers,
    };
  } else {
    peer = {
      name: target,
      url: String(target),
      token: '',
      allowPrivate: config.outbound.allowPrivatePeers,
    };
  }
  if (new URL(peer.url).protocol !== 'https:' && !peer.allowPrivate) {
    throw new Error(`peer ${peer.name} must use https unless private peers are explicitly enabled`);
  }
  return peer;
}

function cardUrl(base) {
  const url = new URL(base);
  if (url.pathname.endsWith('/.well-known/agent-card.json') || url.pathname.endsWith('/.well-known/agent.json')) return url.href;
  url.pathname = `${url.pathname.replace(/\/$/, '')}/.well-known/agent-card.json`;
  url.search = '';
  url.hash = '';
  return url.href;
}

function legacyCardUrl(base) {
  const url = new URL(cardUrl(base));
  url.pathname = url.pathname.replace(/agent-card\.json$/, 'agent.json');
  return url.href;
}

function rpcUrl(base) {
  const url = new URL(base);
  if (url.pathname.includes('/.well-known/')) url.pathname = url.pathname.split('/.well-known/')[0] || '/';
  return url.href;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchCard(config, peer) {
  const options = {
    headers: { 'A2A-Version': '1.0', ...authHeaders(peer.token) },
    timeoutMs: Math.min(config.outbound.timeoutMs, 30_000),
    allowPrivate: peer.allowPrivate,
  };
  try {
    return (await requestJson(cardUrl(peer.url), options)).json;
  } catch (error) {
    if (error.status !== 404) throw error;
    return (await requestJson(legacyCardUrl(peer.url), {
      ...options,
      headers: { ...options.headers, 'A2A-Version': '0.3' },
    })).json;
  }
}

function normalizeVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(value || '1.0'));
  return match ? `${Number(match[1])}.${Number(match[2])}` : '';
}

function selectRpcInterface(base, card) {
  const baseUrl = new URL(rpcUrl(base));
  const jsonRpcInterface = Array.isArray(card?.supportedInterfaces)
    ? card.supportedInterfaces.find((item) => item?.protocolBinding === 'JSONRPC' && item.url)
    : null;
  const candidate = jsonRpcInterface?.url || card?.url;
  const version = normalizeVersion(jsonRpcInterface?.protocolVersion || card?.protocolVersion || '1.0');
  if (!['0.3', '1.0'].includes(version)) throw new Error(`peer advertises unsupported A2A version: ${version || 'invalid'}`);
  if (!candidate) return { url: baseUrl.href, version };
  const advertised = new URL(candidate, baseUrl);
  return { url: advertised.origin === baseUrl.origin ? advertised.href : baseUrl.href, version };
}

export async function discoverPeer(config, target) {
  const peer = peerDefinition(config, target);
  return fetchCard(config, peer);
}

function unwrapResult(result) {
  return result?.task ?? result?.message ?? result;
}

export function taskReply(result) {
  const payload = unwrapResult(result);
  if (!payload || typeof payload !== 'object') return { text: '', contextId: '', state: '' };
  const artifactText = Array.isArray(payload.artifacts)
    ? payload.artifacts.map((artifact) => extractText({ parts: artifact.parts })).filter(Boolean).join('\n')
    : '';
  return {
    text: artifactText || extractText(payload.status?.message ?? payload),
    contextId: payload.contextId || '',
    state: payload.status?.state || '',
    taskId: payload.id || '',
    raw: payload,
  };
}

export async function callPeer(config, target, message, { contextId = '', store: suppliedStore } = {}) {
  const peer = peerDefinition(config, target);
  const safeMessage = redactOutbound(message);
  const effectiveContextId = contextId || newContextId();
  let card = null;
  try {
    card = await fetchCard(config, peer);
  } catch {
    // Discovery is best-effort for compatibility with peers that expose only JSON-RPC.
  }
  const selected = selectRpcInterface(peer.url, card);
  const canonical = selected.version === '1.0';
  const request = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: canonical ? 'SendMessage' : 'message/send',
    params: { message: textMessage('ROLE_USER', safeMessage, effectiveContextId) },
  };
  const store = suppliedStore ?? new TaskStore(config.paths.databasePath, { maxTasks: config.protocol.maxTasks });
  const shouldClose = !suppliedStore;
  store.appendMessage(peer.name, effectiveContextId, 'user', safeMessage);
  try {
    const response = await requestJson(selected.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': selected.version, ...authHeaders(peer.token) },
      body: JSON.stringify(request),
      timeoutMs: config.outbound.timeoutMs,
      allowPrivate: peer.allowPrivate,
    });
    if (response.json.error) throw new Error(`A2A ${response.json.error.code}: ${response.json.error.message}`);
    const reply = taskReply(response.json.result);
    reply.contextId ||= effectiveContextId;
    if (reply.text) store.appendMessage(peer.name, reply.contextId, 'agent', reply.text);
    appendAudit(config.paths.auditPath, {
      direction: 'outbound', peer: peer.name, taskId: reply.taskId, outcome: reply.state, summary: `${safeMessage.length} characters`,
    });
    return reply;
  } finally {
    if (shouldClose) store.close();
  }
}

function cardHasCapability(card, capability) {
  const needle = capability.toLowerCase();
  return (card.skills ?? []).some((skill) => [skill.id, skill.name, ...(skill.tags ?? [])]
    .filter(Boolean).some((value) => String(value).toLowerCase() === needle));
}

export async function orchestrate(config, capability, message, { mode = 'all' } = {}) {
  if (!['all', 'first', 'best'].includes(mode)) throw new Error('mode must be all, first, or best');
  const targets = Object.keys(config.outbound.peers);
  const discovered = await Promise.all(targets.map(async (target) => {
    try {
      const card = await discoverPeer(config, target);
      return cardHasCapability(card, capability) ? target : null;
    } catch {
      return null;
    }
  }));
  const matched = discovered.filter(Boolean);
  if (matched.length === 0) throw new Error(`no configured peers advertise capability: ${capability}`);
  if (mode === 'first') {
    return Promise.any(matched.map((target) => callPeer(config, target, message).then((reply) => ({ target, ...reply }))));
  }
  const results = await Promise.all(matched.map(async (target) => {
    try {
      return { target, ok: true, ...(await callPeer(config, target, message)) };
    } catch (error) {
      return { target, ok: false, error: error.message };
    }
  }));
  if (mode === 'best') {
    const successes = results.filter((result) => result.ok);
    return successes.sort((left, right) => right.text.length - left.text.length)[0] ?? results;
  }
  return results;
}
