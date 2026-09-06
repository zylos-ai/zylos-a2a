import http from 'node:http';
import { forwardTaskToC4 } from './c4.js';
import {
  ERRORS,
  PROTOCOL_VERSION,
  SETTLED_STATES,
  STATES,
  TERMINAL_STATES,
  artifactUpdate,
  buildAgentCard,
  buildLegacyAgentCard,
  buildTask,
  extractContextId,
  extractText,
  jsonRpcError,
  jsonRpcResult,
  methodInfo,
  newContextId,
  newTaskId,
  sendMessageResult,
  sseFrame,
  statusUpdate,
} from './protocol.js';
import { deliverTaskPush } from './push.js';
import { RateLimiter, appendAudit, authenticate, isTrusted, resolveSafeUrl } from './security.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const ROBOTS_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow' };
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const INVITATION_ID_PATTERN = new RegExp(`^invite-${UUID_PATTERN}$`);
const AGENT_ID_PATTERN = new RegExp(`^agent-${UUID_PATTERN}$`);
const PAIRING_HEADERS = { 'Cache-Control': 'no-store' };

function sendJson(response, status, body, headers = {}) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, ...ROBOTS_HEADERS, 'Content-Length': Buffer.byteLength(encoded), ...headers });
  response.end(encoded);
}

function parseIdentifier(value, label, fallback = '') {
  const string = String(value || fallback);
  if (!IDENTIFIER_PATTERN.test(string)) throw new RpcError(ERRORS.INVALID_PARAMS, `${label} is invalid`);
  return string;
}

function historyLength(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(0, Math.min(parsed, 100)) : null;
}

function timestamp(value, label) {
  if (value === undefined || value === null || value === '') return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new RpcError(ERRORS.INVALID_PARAMS, `${label} is invalid`);
  return parsed.toISOString();
}

function parsePushConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(ERRORS.INVALID_PARAMS, 'push notification config must be an object');
  }
  const url = String(value.url || '');
  if (!url) throw new RpcError(ERRORS.INVALID_PARAMS, 'push notification config url is required');
  const authentication = value.authentication;
  if (authentication !== undefined && (!authentication || typeof authentication !== 'object' || Array.isArray(authentication))) {
    throw new RpcError(ERRORS.INVALID_PARAMS, 'push notification authentication must be an object');
  }
  const scheme = String(authentication?.scheme || '');
  if (scheme && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(scheme)) {
    throw new RpcError(ERRORS.INVALID_PARAMS, 'push notification authentication scheme is invalid');
  }
  return {
    id: value.id ? parseIdentifier(value.id, 'id') : '',
    taskId: value.taskId ? parseIdentifier(value.taskId, 'taskId') : '',
    url,
    token: String(value.token || '').slice(0, 2_048),
    authentication: scheme ? {
      scheme,
      credentials: String(authentication.credentials || '').slice(0, 8_192),
    } : undefined,
  };
}

function requireSecureCallback(url, allowPrivateCallbacks) {
  if (new URL(url).protocol !== 'https:' && !allowPrivateCallbacks) {
    throw new RpcError(ERRORS.INVALID_PARAMS, 'push notification URL must use https unless private callbacks are explicitly enabled');
  }
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

async function readJson(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RpcError(ERRORS.INVALID_REQUEST, `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RpcError(ERRORS.PARSE, 'invalid JSON');
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSettled(store, taskId, timeoutMs, request, keepalive) {
  const deadline = Date.now() + timeoutMs;
  let nextKeepalive = Date.now() + 15_000;
  while (Date.now() < deadline && !request.aborted) {
    const task = store.getTask(taskId);
    if (!task || SETTLED_STATES.has(task.state)) return task;
    if (keepalive && Date.now() >= nextKeepalive) {
      keepalive();
      nextKeepalive = Date.now() + 15_000;
    }
    await wait(200);
  }
  return store.getTask(taskId);
}

async function waitForTerminal(store, taskId, timeoutMs, request, onUpdate, keepalive) {
  const deadline = Date.now() + timeoutMs;
  let previous = store.getTask(taskId);
  let nextKeepalive = Date.now() + 15_000;
  while (Date.now() < deadline && !request.aborted) {
    const task = store.getTask(taskId);
    if (!task || TERMINAL_STATES.has(task.state)) return task;
    if (previous && (task.updatedAt !== previous.updatedAt || task.state !== previous.state)) onUpdate(task);
    previous = task;
    if (keepalive && Date.now() >= nextKeepalive) {
      keepalive();
      nextKeepalive = Date.now() + 15_000;
    }
    await wait(200);
  }
  const current = store.getTask(taskId);
  if (current && !TERMINAL_STATES.has(current.state) && !request.aborted) {
    return store.completeTask(taskId, STATES.FAILED, '', 'Runtime reply timed out').task;
  }
  return current;
}

function normalizeProtocolVersion(value) {
  const raw = String(value || '0.3').trim() || '0.3';
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(raw);
  if (!match) throw new RpcError(ERRORS.VERSION_NOT_SUPPORTED, `A2A version not supported: ${raw}`);
  const normalized = `${Number(match[1])}.${Number(match[2])}`;
  if (!['0.3', PROTOCOL_VERSION].includes(normalized)) {
    throw new RpcError(ERRORS.VERSION_NOT_SUPPORTED, `A2A version not supported: ${raw}`);
  }
  return normalized;
}

export function createA2AServer({
  config,
  store,
  forwardTask = forwardTaskToC4,
  deliverPush = deliverTaskPush,
} = {}) {
  const limiter = new RateLimiter(config.auth.rateLimitPerMinute);
  const pairingIpLimiter = new RateLimiter(600, 10_000);
  const pairingInvitationLimiter = new RateLimiter(20, 10_000);
  const card = () => buildAgentCard(config, { requireAuthentication: store.hasBoundPeers() });

  async function handlePairingRedemption(request, response) {
    const clientIp = request.socket.remoteAddress || 'unknown';
    if (!pairingIpLimiter.allow(clientIp)) {
      return sendJson(response, 429, { error: 'pairing rate limit exceeded' }, {
        ...PAIRING_HEADERS, 'Retry-After': '60',
      });
    }
    const body = await readJson(request, Math.min(config.server.maxBodyBytes, 65_536));
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !INVITATION_ID_PATTERN.test(String(body.invitationId || ''))
      || !/^[A-Za-z0-9_-]{40,128}$/.test(String(body.secret || ''))) {
      throw new RpcError(ERRORS.INVALID_PARAMS, 'invalid pairing request');
    }
    if (!pairingInvitationLimiter.allow(`${clientIp}:${body.invitationId}`)) {
      return sendJson(response, 429, { error: 'pairing rate limit exceeded' }, {
        ...PAIRING_HEADERS, 'Retry-After': '60',
      });
    }
    const peer = body.peer;
    const peerCard = peer?.card;
    if (!peer || typeof peer !== 'object' || Array.isArray(peer)
      || !peerCard || typeof peerCard !== 'object' || Array.isArray(peerCard)) {
      throw new RpcError(ERRORS.INVALID_PARAMS, 'invalid pairing invitation or peer identity');
    }
    const peerId = String(peer.agentId || '');
    if (!AGENT_ID_PATTERN.test(peerId)) {
      throw new RpcError(ERRORS.INVALID_PARAMS, 'invalid pairing invitation or peer identity');
    }
    const peerName = String(peerCard.name || peer.name || '').trim().slice(0, 128);
    if (!peerName || /[\u0000-\u001f\u007f]/.test(peerName)) {
      throw new RpcError(ERRORS.INVALID_PARAMS, 'invalid pairing invitation or peer identity');
    }
    const peerInterface = Array.isArray(peerCard.supportedInterfaces)
      ? peerCard.supportedInterfaces.find(
        (item) => item?.protocolBinding === 'JSONRPC' && typeof item.url === 'string',
      )
      : null;
    if (!peerInterface) throw new RpcError(ERRORS.INVALID_PARAMS, 'invalid pairing invitation or peer identity');
    try {
      const peerUrl = new URL(peerInterface.url);
      if (!['http:', 'https:'].includes(peerUrl.protocol) || peerUrl.username || peerUrl.password) {
        throw new Error('invalid URL');
      }
    } catch {
      throw new RpcError(ERRORS.INVALID_PARAMS, 'invalid pairing invitation or peer identity');
    }
    const result = store.redeemPairingInvitation({
      id: String(body.invitationId || ''),
      secret: String(body.secret || ''),
      peerId,
      peerName,
      card: peerCard,
    });
    if (!result) throw new RpcError(ERRORS.INVALID_PARAMS, 'invalid, expired, or already bound pairing invitation');
    try {
      appendAudit(config.paths.auditPath, {
        direction: 'pairing',
        peer: peerId,
        taskId: result.invitation.id,
        outcome: 'bound',
        summary: 'one-time invitation bound',
      });
    } catch (error) {
      console.error(`A2A pairing audit failed: ${error.stack || error.message}`);
    }
    return sendJson(response, 200, {
      agentId: store.getOrCreateAgentId(),
      card: card(),
      token: result.token,
      boundAt: result.invitation.boundAt,
    }, PAIRING_HEADERS);
  }

  async function handlePairingRequest(request, response) {
    try {
      return await handlePairingRedemption(request, response);
    } catch (error) {
      if (!(error instanceof RpcError)) console.error(`A2A pairing failed: ${error.stack || error.message}`);
      return sendJson(
        response,
        error instanceof RpcError ? 400 : 500,
        { error: 'pairing request was rejected' },
        PAIRING_HEADERS,
      );
    }
  }

  async function prepareTask(params, peer, canonical) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new RpcError(ERRORS.INVALID_PARAMS, 'params must be an object');
    const message = params.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new RpcError(ERRORS.INVALID_PARAMS, 'message is required');
    }
    if (canonical && !String(message.messageId || '')) {
      throw new RpcError(ERRORS.INVALID_PARAMS, 'message.messageId is required');
    }
    const acceptedRoles = canonical ? ['ROLE_USER'] : ['ROLE_USER', 'user'];
    if ((canonical && !message.role) || (message.role && !acceptedRoles.includes(message.role))) {
      throw new RpcError(ERRORS.INVALID_PARAMS, 'message.role must identify the user');
    }
    const text = extractText(params);
    if (!text) throw new RpcError(ERRORS.INVALID_PARAMS, 'message.parts must contain supported content');
    if (text.length > 100_000) throw new RpcError(ERRORS.INVALID_PARAMS, 'message content exceeds 100000 characters');
    const requestedTaskId = message.taskId ? parseIdentifier(message.taskId, 'taskId') : '';
    const requestedContextId = extractContextId(params);
    let taskId = requestedTaskId || newTaskId();
    let contextId;
    let existingTask = null;
    if (requestedTaskId) {
      existingTask = store.getTask(requestedTaskId, peer);
      if (!existingTask) throw new RpcError(ERRORS.TASK_NOT_FOUND, `task not found: ${requestedTaskId}`);
      if (requestedContextId && parseIdentifier(requestedContextId, 'contextId') !== existingTask.contextId) {
        throw new RpcError(ERRORS.INVALID_PARAMS, 'message.contextId does not match message.taskId');
      }
      contextId = existingTask.contextId;
    } else {
      contextId = parseIdentifier(requestedContextId, 'contextId', newContextId());
    }
    const inline = params.configuration?.taskPushNotificationConfig
      ? parsePushConfig(params.configuration.taskPushNotificationConfig)
      : null;
    if (inline?.taskId) throw new RpcError(ERRORS.INVALID_PARAMS, 'inline push notification config taskId must be empty');
    if (inline) {
      requireSecureCallback(inline.url, config.push.allowPrivateCallbacks);
      try {
        const resolved = await resolveSafeUrl(inline.url, { allowPrivate: config.push.allowPrivateCallbacks });
        if (resolved.url.protocol === 'http:' && !resolved.isPrivate) {
          throw new Error('unencrypted HTTP is allowed only for explicitly enabled private destinations');
        }
      } catch (error) {
        throw new RpcError(ERRORS.INVALID_PARAMS, `unsafe push callback URL: ${error.message}`);
      }
      if (existingTask && store.listPushConfigs(taskId, peer).length >= 10) {
        throw new RpcError(ERRORS.RATE_LIMITED, 'push notification config limit reached (10)');
      }
      if (existingTask && inline.id && store.getPushConfig(taskId, peer, inline.id)) {
        throw new RpcError(ERRORS.INVALID_PARAMS, `push notification config already exists: ${inline.id}`);
      }
    }
    const history = store.getHistory(peer, contextId, config.protocol.contextHistoryMessages);
    const input = { text, messageId: String(message.messageId || '') };
    let task;
    if (existingTask) {
      const continuation = store.continueTask(taskId, peer, input, config.protocol.maxPingpongTurns);
      if (continuation.outcome === 'terminal') {
        throw new RpcError(ERRORS.UNSUPPORTED_OPERATION, `task ${taskId} is already ${continuation.task.state}`);
      }
      if (continuation.outcome === 'active') {
        throw new RpcError(ERRORS.UNSUPPORTED_OPERATION, `task ${taskId} cannot accept another message while ${continuation.task.state}`);
      }
      if (continuation.outcome === 'not-found') throw new RpcError(ERRORS.TASK_NOT_FOUND, `task not found: ${taskId}`);
      task = continuation.task;
    } else {
      try {
        task = store.createTask({
          id: taskId,
          contextId,
          peer,
          input,
          maxTurns: config.protocol.maxPingpongTurns,
        });
      } catch (error) {
        if (error.code === 'TASK_CAPACITY') throw new RpcError(ERRORS.RATE_LIMITED, error.message);
        throw error;
      }
    }
    appendAudit(config.paths.auditPath, {
      direction: 'inbound', peer, taskId, outcome: task.state, summary: `${text.length} characters`,
    });
    if (task.state === STATES.REJECTED) {
      await deliverPush({ config, store, taskId });
      return task;
    }

    if (inline) store.setPushConfig(taskId, peer, inline);
    task = store.markWorking(taskId, peer);
    if (!task) {
      task = store.getTask(taskId, peer);
      if (task && SETTLED_STATES.has(task.state)) await deliverPush({ config, store, taskId });
      return task;
    }
    try {
      await forwardTask({ task, history });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'A2A Runtime dispatch failed', taskId, error: error.message }));
      task = store.completeTask(taskId, STATES.FAILED, '', 'Runtime dispatch failed').task;
      await deliverPush({ config, store, taskId });
    }
    return task;
  }

  async function settleTask(task, request, keepalive) {
    if (SETTLED_STATES.has(task.state)) return task;
    const settled = await waitForSettled(store, task.id, config.server.requestTimeoutMs, request, keepalive);
    if (settled && !SETTLED_STATES.has(settled.state) && !request.aborted) {
      const failed = store.completeTask(task.id, STATES.FAILED, '', 'Runtime reply timed out').task;
      await deliverPush({ config, store, taskId: task.id });
      return failed;
    }
    return settled;
  }

  async function handleSend(id, params, peer, canonical, request, response) {
    let task = await prepareTask(params, peer, canonical);
    if (params.configuration?.returnImmediately !== true) {
      task = await settleTask(task, request);
    }
    if (!task || response.destroyed) return;
    sendJson(response, 200, jsonRpcResult(id, sendMessageResult(buildTask(task), canonical)));
  }

  function openSse(response) {
    response.writeHead(200, {
      ...ROBOTS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  }

  async function emitSettled(response, id, task) {
    if (task.outputText && task.state === STATES.COMPLETED) response.write(sseFrame(id, artifactUpdate(task)));
    response.write(sseFrame(id, statusUpdate(task)));
    response.write(': done\n\n');
    response.end();
  }

  async function handleStream(id, params, peer, canonical, request, response) {
    let task = await prepareTask(params, peer, canonical);
    openSse(response);
    response.write(sseFrame(id, { task: buildTask(task, { includeArtifacts: false }) }));
    if (!TERMINAL_STATES.has(task.state)) {
      task = await waitForTerminal(
        store,
        task.id,
        config.server.requestTimeoutMs,
        request,
        (updated) => response.write(sseFrame(id, statusUpdate(updated))),
        () => response.write(': keepalive\n\n'),
      );
    }
    if (task && !response.destroyed) await emitSettled(response, id, task);
  }

  async function handleSubscribe(id, params, peer, request, response) {
    const taskId = parseIdentifier(params?.taskId || params?.id, 'taskId');
    let task = store.getTask(taskId, peer);
    if (!task) throw new RpcError(ERRORS.TASK_NOT_FOUND, `task not found: ${taskId}`);
    if (TERMINAL_STATES.has(task.state)) {
      throw new RpcError(ERRORS.UNSUPPORTED_OPERATION, `cannot subscribe to settled task: ${taskId}`);
    }
    openSse(response);
    response.write(sseFrame(id, { task: buildTask(task, { includeArtifacts: false }) }));
    task = await waitForTerminal(
      store,
      task.id,
      config.server.requestTimeoutMs,
      request,
      (updated) => response.write(sseFrame(id, statusUpdate(updated))),
      () => response.write(': keepalive\n\n'),
    );
    if (task && !response.destroyed) await emitSettled(response, id, task);
  }

  async function handleRpc(body, peer, requestedVersion, request, response) {
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') throw new RpcError(ERRORS.INVALID_REQUEST, 'valid JSON-RPC 2.0 request required');
    const [operation, canonicalMethod] = methodInfo(body.method);
    if (!operation) throw new RpcError(ERRORS.METHOD_NOT_FOUND, `method not found: ${body.method}`);
    const canonical = requestedVersion === PROTOCOL_VERSION;
    if (canonical !== canonicalMethod) throw new RpcError(ERRORS.METHOD_NOT_FOUND, `method not found for A2A ${requestedVersion}: ${body.method}`);
    const params = body.params ?? {};
    if (operation === 'send') return handleSend(body.id, params, peer, canonical, request, response);
    if (operation === 'stream') return handleStream(body.id, params, peer, canonical, request, response);
    if (operation === 'subscribe') return handleSubscribe(body.id, params, peer, request, response);
    if (operation === 'extendedCard') {
      throw new RpcError(ERRORS.UNSUPPORTED_OPERATION, 'extended Agent Card is not configured');
    }

    if (operation === 'get') {
      const taskId = parseIdentifier(params.taskId || params.id, 'taskId');
      const task = store.getTask(taskId, peer);
      if (!task) throw new RpcError(ERRORS.TASK_NOT_FOUND, `task not found: ${taskId}`);
      const requestedHistory = historyLength(params.historyLength);
      const history = requestedHistory === null ? undefined : store.getHistory(peer, task.contextId, requestedHistory);
      return sendJson(response, 200, jsonRpcResult(body.id, buildTask(task, { history })));
    }
    if (operation === 'list') {
      let page;
      try {
        page = store.listTasks(peer, {
          contextId: params.contextId ? parseIdentifier(params.contextId, 'contextId') : '',
          state: params.status || params.state || '',
          pageSize: params.pageSize,
          pageToken: params.pageToken,
          statusTimestampAfter: timestamp(params.statusTimestampAfter, 'statusTimestampAfter'),
        });
      } catch (error) {
        if (error.code === 'INVALID_PAGE_TOKEN') throw new RpcError(ERRORS.INVALID_PARAMS, error.message);
        throw error;
      }
      const requestedHistory = historyLength(params.historyLength);
      return sendJson(response, 200, jsonRpcResult(body.id, {
        tasks: page.tasks.map((task) => buildTask(task, {
          includeArtifacts: params.includeArtifacts === true,
          history: requestedHistory === null ? undefined : store.getHistory(peer, task.contextId, requestedHistory),
        })),
        nextPageToken: page.nextPageToken,
        pageSize: Math.max(1, Math.min(Number(params.pageSize) || 50, 100)),
        totalSize: page.total,
      }));
    }
    if (operation === 'cancel') {
      const taskId = parseIdentifier(params.taskId || params.id, 'taskId');
      const result = store.requestCancellation(taskId, peer);
      if (result.outcome === 'not-found') throw new RpcError(ERRORS.TASK_NOT_FOUND, `task not found: ${taskId}`);
      if (result.outcome === 'canceled') return sendJson(response, 200, jsonRpcResult(body.id, buildTask(result.task)));
      const reason = result.outcome === 'requested'
        ? 'cancellation recorded, but exact Runtime interruption is unavailable'
        : `task ${taskId} is already ${result.task.state}`;
      throw new RpcError(ERRORS.TASK_NOT_CANCELABLE, reason, [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'TASK_NOT_CANCELABLE',
        domain: 'a2a-protocol.org',
        metadata: { cancellationRequested: String(result.outcome === 'requested') },
      }]);
    }
    if (operation === 'pushCreate') {
      const taskId = parseIdentifier(params.taskId, 'taskId');
      const pushConfig = parsePushConfig(canonical ? params : (params.pushNotificationConfig || params.config));
      requireSecureCallback(pushConfig.url, config.push.allowPrivateCallbacks);
      try {
        const resolved = await resolveSafeUrl(pushConfig.url, { allowPrivate: config.push.allowPrivateCallbacks });
        if (resolved.url.protocol === 'http:' && !resolved.isPrivate) {
          throw new Error('unencrypted HTTP is allowed only for explicitly enabled private destinations');
        }
      } catch (error) {
        throw new RpcError(ERRORS.INVALID_PARAMS, `unsafe push callback URL: ${error.message}`);
      }
      let push;
      try {
        push = store.setPushConfig(taskId, peer, pushConfig);
      } catch (error) {
        if (error.code === 'PUSH_CONFIG_CAPACITY') throw new RpcError(ERRORS.RATE_LIMITED, error.message);
        if (error.code === 'PUSH_CONFIG_EXISTS') throw new RpcError(ERRORS.INVALID_PARAMS, error.message);
        throw error;
      }
      if (!push) throw new RpcError(ERRORS.TASK_NOT_FOUND, `task not found: ${taskId}`);
      return sendJson(response, 200, jsonRpcResult(body.id, push));
    }
    if (operation === 'pushGet') {
      const taskId = parseIdentifier(params.taskId, 'taskId');
      const configId = parseIdentifier(params.id || params.configId, 'id');
      const push = store.getPushConfig(taskId, peer, configId);
      if (!push) throw new RpcError(ERRORS.TASK_NOT_FOUND, `push config not found for task: ${taskId}`);
      return sendJson(response, 200, jsonRpcResult(body.id, push));
    }
    if (operation === 'pushList') {
      const taskId = parseIdentifier(params.taskId, 'taskId');
      if (!store.getTask(taskId, peer)) throw new RpcError(ERRORS.TASK_NOT_FOUND, `task not found: ${taskId}`);
      return sendJson(response, 200, jsonRpcResult(body.id, { configs: store.listPushConfigs(taskId, peer), nextPageToken: '' }));
    }
    if (operation === 'pushDelete') {
      const taskId = parseIdentifier(params.taskId, 'taskId');
      const configId = parseIdentifier(params.id || params.configId, 'id');
      if (!store.getTask(taskId, peer)) throw new RpcError(ERRORS.TASK_NOT_FOUND, `task not found: ${taskId}`);
      store.deletePushConfig(taskId, peer, configId);
      return sendJson(response, 200, jsonRpcResult(body.id, {}));
    }
  }

  const server = http.createServer(async (request, response) => {
    let requestId = null;
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && ['/.well-known/agent-card.json', '/.well-known/agent.json'].includes(url.pathname)) {
        return sendJson(response, 200, url.pathname.endsWith('/agent.json') ? buildLegacyAgentCard(config) : card());
      }
      if (request.method === 'GET' && url.pathname === '/robots.txt') {
        const body = 'User-agent: *\nDisallow: /\n';
        response.writeHead(200, { ...ROBOTS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        return response.end(body);
      }
      if (request.method === 'POST' && url.pathname === '/pairing/redeem') {
        return handlePairingRequest(request, response);
      }

      const isProxied = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-prefix']
        .some((header) => request.headers[header] !== undefined);
      let boundCredentialPeer = '';
      const peer = authenticate(
        config,
        request.headers.authorization,
        request.socket.remoteAddress,
        isProxied,
        (token) => {
          boundCredentialPeer = store.authenticateBoundPeer(token);
          return boundCredentialPeer;
        },
      );
      if (!peer) return sendJson(response, 401, jsonRpcError(null, ERRORS.UNAUTHORIZED, 'unauthorized'), { 'WWW-Authenticate': 'Bearer' });
      if (!boundCredentialPeer && !isTrusted(config, peer)) {
        return sendJson(response, 403, jsonRpcError(null, ERRORS.UNTRUSTED_PEER, 'peer is not trusted'));
      }
      if (!limiter.allow(peer)) return sendJson(response, 429, jsonRpcError(null, ERRORS.RATE_LIMITED, 'rate limit exceeded'), { 'Retry-After': '60' });
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { ok: true, service: 'zylos-a2a' });
      }
      if (request.method !== 'POST' || url.pathname !== '/') return sendJson(response, 404, jsonRpcError(null, ERRORS.INVALID_REQUEST, 'not found'));
      const body = await readJson(request, config.server.maxBodyBytes);
      requestId = body?.id ?? null;
      const requestedVersion = normalizeProtocolVersion(request.headers['a2a-version']);
      await handleRpc(body, peer, requestedVersion, request, response);
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed) response.end();
        return;
      }
      const code = error instanceof RpcError ? error.code : ERRORS.INTERNAL;
      const message = error instanceof RpcError ? error.message : 'internal error';
      sendJson(response, 200, jsonRpcError(requestId, code, message, error.data));
    }
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));

  return {
    server,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.server.port, config.server.host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    stop() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
