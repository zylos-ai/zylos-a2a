import { createHash, randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = '1.0';

export const STATES = Object.freeze({
  SUBMITTED: 'TASK_STATE_SUBMITTED',
  WORKING: 'TASK_STATE_WORKING',
  INPUT_REQUIRED: 'TASK_STATE_INPUT_REQUIRED',
  AUTH_REQUIRED: 'TASK_STATE_AUTH_REQUIRED',
  COMPLETED: 'TASK_STATE_COMPLETED',
  FAILED: 'TASK_STATE_FAILED',
  CANCELED: 'TASK_STATE_CANCELED',
  REJECTED: 'TASK_STATE_REJECTED',
});

export const TERMINAL_STATES = new Set([
  STATES.COMPLETED,
  STATES.FAILED,
  STATES.CANCELED,
  STATES.REJECTED,
]);

export const SETTLED_STATES = new Set([
  ...TERMINAL_STATES,
  STATES.INPUT_REQUIRED,
  STATES.AUTH_REQUIRED,
]);

export const ERRORS = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  UNAUTHORIZED: -32050,
  RATE_LIMITED: -32051,
  UNTRUSTED_PEER: -32052,
  VERSION_NOT_SUPPORTED: -32009,
});

const METHOD_MAP = new Map([
  ['SendMessage', ['send', true]],
  ['message/send', ['send', false]],
  ['SendStreamingMessage', ['stream', true]],
  ['message/stream', ['stream', false]],
  ['GetTask', ['get', true]],
  ['tasks/get', ['get', false]],
  ['ListTasks', ['list', true]],
  ['tasks/list', ['list', false]],
  ['CancelTask', ['cancel', true]],
  ['tasks/cancel', ['cancel', false]],
  ['SubscribeToTask', ['subscribe', true]],
  ['tasks/subscribe', ['subscribe', false]],
  ['CreateTaskPushNotificationConfig', ['pushCreate', true]],
  ['tasks/pushNotificationConfig/create', ['pushCreate', false]],
  ['tasks/pushNotificationConfig/set', ['pushCreate', false]],
  ['tasks/pushNotification/set', ['pushCreate', false]],
  ['GetTaskPushNotificationConfig', ['pushGet', true]],
  ['tasks/pushNotificationConfig/get', ['pushGet', false]],
  ['ListTaskPushNotificationConfigs', ['pushList', true]],
  ['tasks/pushNotificationConfig/list', ['pushList', false]],
  ['DeleteTaskPushNotificationConfig', ['pushDelete', true]],
  ['tasks/pushNotificationConfig/delete', ['pushDelete', false]],
  ['GetExtendedAgentCard', ['extendedCard', true]],
]);

const A2A_ERROR_REASONS = new Map([
  [ERRORS.TASK_NOT_FOUND, 'TASK_NOT_FOUND'],
  [ERRORS.TASK_NOT_CANCELABLE, 'TASK_NOT_CANCELABLE'],
  [ERRORS.PUSH_NOT_SUPPORTED, 'PUSH_NOTIFICATION_NOT_SUPPORTED'],
  [ERRORS.UNSUPPORTED_OPERATION, 'UNSUPPORTED_OPERATION'],
  [ERRORS.VERSION_NOT_SUPPORTED, 'VERSION_NOT_SUPPORTED'],
]);

export function methodInfo(method) {
  return METHOD_MAP.get(method) ?? ['', false];
}

export function nowIso() {
  return new Date().toISOString();
}

export function newTaskId() {
  return `task-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function newContextId() {
  return `ctx-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function textPart(text) {
  return { text, mediaType: 'text/plain' };
}

function stableId(prefix, ...values) {
  return `${prefix}-${createHash('sha256').update(values.join('\0')).digest('hex').slice(0, 24)}`;
}

export function textMessage(role, text, contextId = '', messageId = '') {
  const message = {
    role,
    parts: [textPart(text)],
    messageId: messageId || randomUUID().replaceAll('-', ''),
  };
  if (contextId) message.contextId = contextId;
  return message;
}

export function extractText(messageOrParams) {
  const source = messageOrParams?.message ?? messageOrParams ?? {};
  const parts = Array.isArray(source.parts) ? source.parts : [];
  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') {
      chunks.push(part.text);
      continue;
    }
    if (typeof part.url === 'string' && part.url) {
      const label = part.filename ? `[file: ${part.filename}]` : '[file]';
      const media = part.mediaType ? ` (${part.mediaType})` : '';
      chunks.push(`${label} ${part.url}${media}`);
      continue;
    }
    if (part.file && typeof part.file.fileWithUri === 'string') {
      const label = part.file.name ? `[file: ${part.file.name}]` : '[file]';
      chunks.push(`${label} ${part.file.fileWithUri}`);
      continue;
    }
    if (typeof part.raw === 'string') {
      const label = part.filename ? `[file: ${part.filename}]` : '[file]';
      chunks.push(`${label} ${part.raw.length} base64 characters`);
      continue;
    }
    if (Object.hasOwn(part, 'data')) {
      chunks.push(`[data (${part.mediaType ?? 'application/json'})]\n${JSON.stringify(part.data)}`);
    }
  }
  return chunks.join('\n').trim();
}

export function extractContextId(params) {
  return String(params?.message?.contextId ?? params?.contextId ?? '');
}

export function buildTask(record, { includeArtifacts = true, history } = {}) {
  const task = {
    id: record.id,
    contextId: record.contextId,
    status: {
      state: record.state,
      timestamp: record.updatedAt,
    },
  };
  const output = record.outputText || record.statusText || '';
  if (output) {
    task.status.message = textMessage(
      'ROLE_AGENT', output, record.contextId, stableId('msg', record.id, record.updatedAt, record.state),
    );
    if (includeArtifacts && record.state === STATES.COMPLETED) {
      task.artifacts = [{
        artifactId: stableId('artifact', record.id),
        parts: [textPart(output)],
      }];
    }
  }
  if (history !== undefined) {
    task.history = history.map((item) => textMessage(
      item.role === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER',
      item.text,
      record.contextId,
      item.messageId,
    ));
  }
  return task;
}

export function statusUpdate(record) {
  const status = { state: record.state, timestamp: record.updatedAt };
  const text = record.outputText || record.statusText || '';
  if (text) {
    status.message = textMessage(
      'ROLE_AGENT', text, record.contextId, stableId('msg', record.id, record.updatedAt, record.state),
    );
  }
  return { statusUpdate: { taskId: record.id, contextId: record.contextId, status } };
}

export function artifactUpdate(record) {
  return {
    artifactUpdate: {
      taskId: record.id,
      contextId: record.contextId,
      artifact: {
        artifactId: stableId('artifact', record.id),
        parts: [textPart(record.outputText)],
      },
    },
  };
}

export function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  const reason = A2A_ERROR_REASONS.get(code);
  if (data !== undefined) {
    error.data = data;
  } else if (reason) {
    error.data = [{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason,
      domain: 'a2a-protocol.org',
    }];
  }
  return { jsonrpc: '2.0', id: id ?? null, error };
}

export function sendMessageResult(task, canonical) {
  return canonical ? { task } : task;
}

export function buildAgentCard(config, { requireAuthentication = false } = {}) {
  const baseUrl = config.server.publicUrl || `http://${config.server.host}:${config.server.port}`;
  const url = `${baseUrl.replace(/\/$/, '')}/`;
  const card = {
    name: config.identity.name,
    description: config.identity.description,
    version: '1.0.0',
    provider: {
      organization: config.identity.providerOrganization,
      url: config.identity.providerUrl || url,
    },
    supportedInterfaces: [{
      url,
      protocolBinding: 'JSONRPC',
      protocolVersion: PROTOCOL_VERSION,
    }],
    capabilities: {
      streaming: true,
      pushNotifications: true,
      extendedAgentCard: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: config.identity.skills.length > 0 ? config.identity.skills : [{
      id: 'general',
      name: 'general',
      description: 'General-purpose Zylos agent',
      tags: ['general'],
    }],
  };
  if (requireAuthentication || config.auth.bearerToken || Object.keys(config.auth.peerTokens).length > 0) {
    card.securitySchemes = {
      bearer: {
        httpAuthSecurityScheme: {
          description: 'Bearer token issued for this A2A peer',
          scheme: 'Bearer',
        },
      },
    };
    card.securityRequirements = [{ schemes: { bearer: { list: [] } } }];
  }
  return card;
}

export function buildLegacyAgentCard(config) {
  const card = buildAgentCard(config);
  const url = card.supportedInterfaces[0].url;
  const legacy = {
    ...card,
    protocolVersion: '0.3.0',
    url,
    preferredTransport: 'JSONRPC',
  };
  delete legacy.securityRequirements;
  if (legacy.securitySchemes) {
    legacy.securitySchemes = { bearer: { type: 'http', scheme: 'bearer' } };
    legacy.security = [{ bearer: [] }];
  }
  return legacy;
}

export function sseFrame(id, result) {
  return `data: ${JSON.stringify(jsonRpcResult(id, result))}\n\n`;
}
