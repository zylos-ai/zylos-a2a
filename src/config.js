import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  server: {
    host: '127.0.0.1',
    port: 9900,
    public_url: '',
    request_timeout_ms: 300_000,
    max_body_bytes: 1_048_576,
  },
  identity: {
    name: 'Zylos',
    description: 'A persistent Zylos agent',
    provider_organization: 'Zylos',
    provider_url: '',
    skills: [],
  },
  auth: {
    bearer_token: '',
    peer_tokens: {},
    trusted_peers: [],
    rate_limit_per_minute: 60,
  },
  protocol: {
    max_tasks: 500,
    max_pingpong_turns: 5,
    context_history_messages: 20,
  },
  push: {
    secret: '',
    allow_private_callbacks: false,
  },
  outbound: {
    timeout_ms: 30_000,
    allow_private_peers: false,
    peers: {},
  },
});

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function publicUrl(value, label) {
  if (!value) return '';
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} must use http or https`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query parameters, or fragments`);
  }
  return url.href.replace(/\/$/, '');
}

export function dataPaths(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const dataDir = options.dataDir ?? path.join(homeDir, 'zylos/components/a2a');
  return {
    dataDir,
    configPath: options.configPath ?? path.join(dataDir, 'config.json'),
    databasePath: options.databasePath ?? path.join(dataDir, 'tasks.sqlite'),
    auditPath: options.auditPath ?? path.join(dataDir, 'audit.jsonl'),
    logsDir: path.join(dataDir, 'logs'),
  };
}

export function normalizeConfig(raw = {}, options = {}) {
  const server = object(raw.server);
  const identity = object(raw.identity);
  const auth = object(raw.auth);
  const protocol = object(raw.protocol);
  const push = object(raw.push);
  const outbound = object(raw.outbound);
  const peerTokens = object(auth.peer_tokens);
  const peers = object(outbound.peers);

  const config = {
    enabled: raw.enabled === true,
    server: {
      host: String(server.host || DEFAULT_CONFIG.server.host),
      port: boundedInteger(server.port, DEFAULT_CONFIG.server.port, 1, 65_535),
      publicUrl: publicUrl(server.public_url, 'server.public_url'),
      requestTimeoutMs: boundedInteger(server.request_timeout_ms, DEFAULT_CONFIG.server.request_timeout_ms, 1_000, 900_000),
      maxBodyBytes: boundedInteger(server.max_body_bytes, DEFAULT_CONFIG.server.max_body_bytes, 1_024, 10_485_760),
    },
    identity: {
      name: String(identity.name || DEFAULT_CONFIG.identity.name).slice(0, 128),
      description: String(identity.description || DEFAULT_CONFIG.identity.description).slice(0, 2_000),
      providerOrganization: String(identity.provider_organization || DEFAULT_CONFIG.identity.provider_organization).slice(0, 256),
      providerUrl: publicUrl(identity.provider_url, 'identity.provider_url'),
      skills: Array.isArray(identity.skills) ? identity.skills.filter((item) => item && typeof item === 'object').slice(0, 100) : [],
    },
    auth: {
      bearerToken: String(auth.bearer_token || ''),
      peerTokens: Object.fromEntries(Object.entries(peerTokens).map(([name, token]) => [String(name), String(token)]).filter(([name, token]) => name && token)),
      trustedPeers: new Set(Array.isArray(auth.trusted_peers) ? auth.trusted_peers.map(String) : []),
      rateLimitPerMinute: boundedInteger(auth.rate_limit_per_minute, DEFAULT_CONFIG.auth.rate_limit_per_minute, 1, 10_000),
    },
    protocol: {
      maxTasks: boundedInteger(protocol.max_tasks, DEFAULT_CONFIG.protocol.max_tasks, 10, 100_000),
      maxPingpongTurns: boundedInteger(protocol.max_pingpong_turns, DEFAULT_CONFIG.protocol.max_pingpong_turns, 1, 20),
      contextHistoryMessages: boundedInteger(protocol.context_history_messages, DEFAULT_CONFIG.protocol.context_history_messages, 0, 100),
    },
    push: {
      secret: String(push.secret || ''),
      allowPrivateCallbacks: push.allow_private_callbacks === true,
    },
    outbound: {
      timeoutMs: boundedInteger(outbound.timeout_ms, DEFAULT_CONFIG.outbound.timeout_ms, 1_000, 300_000),
      allowPrivatePeers: outbound.allow_private_peers === true,
      peers,
    },
    paths: dataPaths(options),
  };

  const hasAuth = config.auth.bearerToken || Object.keys(config.auth.peerTokens).length > 0;
  if (!hasAuth && !['127.0.0.1', '::1', 'localhost'].includes(config.server.host)) {
    config.server.host = '127.0.0.1';
  }
  return config;
}

export function loadConfig(options = {}) {
  const paths = dataPaths(options);
  if (!fs.existsSync(paths.configPath)) {
    throw new Error(`A2A config not found: ${paths.configPath}`);
  }
  return normalizeConfig(JSON.parse(fs.readFileSync(paths.configPath, 'utf8')), options);
}
