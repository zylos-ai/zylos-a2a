import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SETTLED_STATES, STATES, TERMINAL_STATES, nowIso } from './protocol.js';

const ACTIVE_STATES = [STATES.SUBMITTED, STATES.WORKING];
const CONTEXT_TTL_MS = 3_600_000;
const INVITATION_TTL_SECONDS = 600;
export const PAIRING_PERMISSIONS = Object.freeze(['a2a:tasks']);
const PUSH_TABLE_SQL = `
  CREATE TABLE push_configs (
    config_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    peer TEXT NOT NULL,
    url TEXT NOT NULL,
    token TEXT NOT NULL DEFAULT '',
    auth_scheme TEXT NOT NULL DEFAULT '',
    auth_credentials TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    delivered_at TEXT,
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
  )`;

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    contextId: row.context_id,
    peer: row.peer,
    state: row.state,
    input: JSON.parse(row.input_json),
    outputText: row.output_text,
    statusText: row.status_text,
    cancellationRequested: Boolean(row.cancellation_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPushConfig(row, { includeCredentials = true } = {}) {
  if (!row) return null;
  const config = {
    id: row.config_id,
    taskId: row.task_id,
    url: row.url,
  };
  if (row.token) config.token = row.token;
  if (row.auth_scheme) {
    config.authentication = { scheme: row.auth_scheme };
    if (includeCredentials && row.auth_credentials) {
      config.authentication.credentials = row.auth_credentials;
    }
  }
  return config;
}

function secretHash(value) {
  return createHash('sha256').update(String(value)).digest();
}

function secretMatches(value, expectedHex) {
  const actual = secretHash(value);
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function mapPairingInvitation(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    permissions: JSON.parse(row.permissions_json),
    boundPeerId: row.bound_peer_id,
    boundPeerName: row.bound_peer_name,
    boundAt: row.bound_at,
    revokedAt: row.revoked_at,
  };
}

function encodePageToken(row) {
  return Buffer.from(JSON.stringify([row.updated_at, row.id])).toString('base64url');
}

function decodePageToken(value) {
  if (!value) return null;
  try {
    const [updatedAt, id, ...rest] = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (rest.length > 0 || typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt)) || typeof id !== 'string' || !id) {
      throw new Error('invalid cursor values');
    }
    return { updatedAt, id };
  } catch {
    const error = new Error('pageToken is invalid');
    error.code = 'INVALID_PAGE_TOKEN';
    throw error;
  }
}

export class TaskStore {
  constructor(databasePath, { maxTasks = 500 } = {}) {
    if (databasePath !== ':memory:') {
      const databaseDir = path.dirname(databasePath);
      fs.mkdirSync(databaseDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(databaseDir, 0o700);
    }
    this.database = new DatabaseSync(databasePath);
    this.maxTasks = maxTasks;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        peer TEXT NOT NULL,
        state TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_text TEXT NOT NULL DEFAULT '',
        status_text TEXT NOT NULL DEFAULT '',
        cancellation_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_peer_updated ON tasks(peer, updated_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_peer_context ON tasks(peer, context_id, updated_at);
      CREATE TABLE IF NOT EXISTS context_turns (
        peer TEXT NOT NULL,
        context_id TEXT NOT NULL,
        turn_count INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (peer, context_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL DEFAULT '',
        context_id TEXT NOT NULL,
        peer TEXT NOT NULL,
        role TEXT NOT NULL,
        task_id TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS messages_context ON messages(peer, context_id, id DESC);
      CREATE TABLE IF NOT EXISTS component_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing_invitations (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        bound_peer_id TEXT NOT NULL DEFAULT '',
        bound_peer_name TEXT NOT NULL DEFAULT '',
        bound_card_json TEXT NOT NULL DEFAULT '',
        bound_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS pairing_invitations_status_expires
        ON pairing_invitations(status, expires_at);
      CREATE TABLE IF NOT EXISTS peer_credentials (
        peer_id TEXT PRIMARY KEY,
        peer_name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        card_json TEXT NOT NULL,
        invitation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);
    const messageColumns = new Set(this.database.prepare('PRAGMA table_info(messages)').all().map((row) => row.name));
    if (!messageColumns.has('message_id')) {
      this.database.exec("ALTER TABLE messages ADD COLUMN message_id TEXT NOT NULL DEFAULT ''");
    }
    this.ensurePushConfigSchema();
    if (databasePath !== ':memory:') {
      for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
      }
    }
  }

  ensurePushConfigSchema() {
    const table = this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'push_configs'").get();
    if (!table) {
      this.database.exec(`${PUSH_TABLE_SQL}; CREATE INDEX push_configs_task ON push_configs(task_id, peer);`);
      return;
    }
    const columns = new Set(this.database.prepare('PRAGMA table_info(push_configs)').all().map((row) => row.name));
    const isLegacy = /task_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(table.sql)
      || !['token', 'auth_scheme', 'auth_credentials', 'delivered_at', 'delivery_attempts'].every((name) => columns.has(name));
    if (!isLegacy) {
      this.database.exec('CREATE INDEX IF NOT EXISTS push_configs_task ON push_configs(task_id, peer)');
      return;
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        ALTER TABLE push_configs RENAME TO push_configs_legacy;
        ${PUSH_TABLE_SQL};
        INSERT INTO push_configs (
          config_id, task_id, peer, url, created_at, claimed_at
        )
        SELECT config_id, task_id, peer, url, created_at, claimed_at
        FROM push_configs_legacy;
        DROP TABLE push_configs_legacy;
        CREATE INDEX push_configs_task ON push_configs(task_id, peer);
        COMMIT;
      `);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getOrCreateAgentId() {
    const existing = this.database.prepare("SELECT value FROM component_metadata WHERE key = 'agent_id'").get();
    if (existing) return existing.value;
    const agentId = `agent-${randomUUID()}`;
    this.database.prepare("INSERT OR IGNORE INTO component_metadata (key, value) VALUES ('agent_id', ?)").run(agentId);
    return this.database.prepare("SELECT value FROM component_metadata WHERE key = 'agent_id'").get().value;
  }

  createPairingInvitation({ ttlSeconds = INVITATION_TTL_SECONDS, currentMs = Date.now() } = {}) {
    const ttl = Math.max(60, Math.min(Number(ttlSeconds) || INVITATION_TTL_SECONDS, 3_600));
    const id = `invite-${randomUUID()}`;
    const secret = randomBytes(32).toString('base64url');
    const createdAt = new Date(currentMs).toISOString();
    const expiresAt = new Date(currentMs + ttl * 1_000).toISOString();
    this.database.prepare(`
      INSERT INTO pairing_invitations (id, secret_hash, status, created_at, expires_at, permissions_json)
      VALUES (?, ?, 'pending', ?, ?, ?)
    `).run(id, secretHash(secret).toString('hex'), createdAt, expiresAt, JSON.stringify(PAIRING_PERMISSIONS));
    return {
      id, secret, status: 'pending', createdAt, expiresAt, permissions: [...PAIRING_PERMISSIONS],
    };
  }

  redeemPairingInvitation({ id, secret, peerId, peerName, card }, currentMs = Date.now()) {
    const timestamp = new Date(currentMs).toISOString();
    const peerToken = randomBytes(32).toString('base64url');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const invitation = this.database.prepare('SELECT * FROM pairing_invitations WHERE id = ?').get(id);
      if (!invitation || invitation.status !== 'pending' || !secretMatches(secret, invitation.secret_hash)) {
        this.database.exec('COMMIT');
        return null;
      }
      if (Date.parse(invitation.expires_at) <= currentMs) {
        this.database.prepare("UPDATE pairing_invitations SET status = 'expired' WHERE id = ? AND status = 'pending'").run(id);
        this.database.exec('COMMIT');
        return null;
      }
      const cardJson = JSON.stringify(card);
      const credential = this.database.prepare(`
        INSERT INTO peer_credentials (
          peer_id, peer_name, token_hash, card_json, invitation_id, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(peer_id) DO UPDATE SET
          peer_name = excluded.peer_name,
          token_hash = excluded.token_hash,
          card_json = excluded.card_json,
          invitation_id = excluded.invitation_id,
          created_at = excluded.created_at,
          revoked_at = NULL
        WHERE peer_credentials.revoked_at IS NOT NULL
      `).run(peerId, peerName, secretHash(peerToken).toString('hex'), cardJson, id, timestamp);
      if (credential.changes !== 1) {
        this.database.exec('COMMIT');
        return null;
      }
      const updated = this.database.prepare(`
        UPDATE pairing_invitations
        SET status = 'bound', bound_peer_id = ?, bound_peer_name = ?, bound_card_json = ?, bound_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(peerId, peerName, cardJson, timestamp, id);
      if (updated.changes !== 1) throw new Error('pairing invitation changed during binding');
      this.database.exec('COMMIT');
      return { invitation: this.getPairingInvitation(id), token: peerToken };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  authenticateBoundPeer(token) {
    if (!token) return '';
    const row = this.database.prepare('SELECT peer_id FROM peer_credentials WHERE token_hash = ? AND revoked_at IS NULL')
      .get(secretHash(token).toString('hex'));
    return row?.peer_id || '';
  }

  isBoundPeer(peerId) {
    return Boolean(this.database.prepare('SELECT 1 FROM peer_credentials WHERE peer_id = ? AND revoked_at IS NULL').get(peerId));
  }

  hasBoundPeers() {
    return Boolean(this.database.prepare('SELECT 1 FROM peer_credentials WHERE revoked_at IS NULL LIMIT 1').get());
  }

  getPairingInvitation(id) {
    return mapPairingInvitation(this.database.prepare('SELECT * FROM pairing_invitations WHERE id = ?').get(id));
  }

  expirePairingInvitations(currentMs = Date.now()) {
    const timestamp = new Date(currentMs).toISOString();
    return this.database.prepare(`
      UPDATE pairing_invitations
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= ?
    `).run(timestamp).changes;
  }

  listPairingInvitations(currentMs = Date.now()) {
    this.expirePairingInvitations(currentMs);
    return this.database.prepare('SELECT * FROM pairing_invitations ORDER BY created_at DESC, id DESC').all()
      .map(mapPairingInvitation);
  }

  revokePairingInvitation(id) {
    const timestamp = nowIso();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE pairing_invitations
        SET status = 'expired'
        WHERE id = ? AND status = 'pending' AND expires_at <= ?
      `).run(id, timestamp);
      const invitation = this.database.prepare('SELECT * FROM pairing_invitations WHERE id = ?').get(id);
      if (!invitation) {
        this.database.exec('COMMIT');
        return null;
      }
      if (invitation.status === 'pending') {
        this.database.prepare("UPDATE pairing_invitations SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'pending'")
          .run(timestamp, id);
      } else if (invitation.status === 'bound' && !invitation.revoked_at) {
        this.database.prepare('UPDATE pairing_invitations SET revoked_at = ? WHERE id = ?').run(timestamp, id);
        this.database.prepare('UPDATE peer_credentials SET revoked_at = ? WHERE invitation_id = ? AND revoked_at IS NULL')
          .run(timestamp, id);
      }
      this.database.exec('COMMIT');
      return this.getPairingInvitation(id);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  createTask({ id, contextId, peer, input, maxTurns }) {
    const timestamp = nowIso();
    const currentMs = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM context_turns WHERE updated_at_ms < ?').run(currentMs - CONTEXT_TTL_MS);
      this.trimTasksToLimit(this.maxTasks - 1);
      const retained = this.database.prepare('SELECT COUNT(*) AS total FROM tasks').get().total;
      if (retained >= this.maxTasks) {
        const error = new Error(`active task capacity reached (${this.maxTasks})`);
        error.code = 'TASK_CAPACITY';
        throw error;
      }
      const context = this.database.prepare('SELECT turn_count, updated_at_ms FROM context_turns WHERE peer = ? AND context_id = ?').get(peer, contextId);
      const previousTurns = context && currentMs - context.updated_at_ms <= CONTEXT_TTL_MS ? context.turn_count : 0;
      const isRejected = previousTurns >= maxTurns;
      const state = isRejected ? STATES.REJECTED : STATES.SUBMITTED;
      const statusText = isRejected ? `context turn limit exceeded (${maxTurns})` : '';
      this.database.prepare(`
        INSERT INTO tasks (id, context_id, peer, state, input_json, status_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, contextId, peer, state, JSON.stringify(input), statusText, timestamp, timestamp);
      if (!isRejected) {
        this.database.prepare(`
          INSERT INTO context_turns (peer, context_id, turn_count, updated_at_ms)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(peer, context_id) DO UPDATE SET turn_count = excluded.turn_count, updated_at_ms = excluded.updated_at_ms
        `).run(peer, contextId, previousTurns + 1, currentMs);
        this.database.prepare('INSERT INTO messages (message_id, context_id, peer, role, task_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(input.messageId || `msg-${randomUUID()}`, contextId, peer, 'user', id, input.text, timestamp);
        this.trimMessages();
      }
      this.database.exec('COMMIT');
      return this.getTask(id, peer);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  continueTask(id, peer, input, maxTurns) {
    const timestamp = nowIso();
    const currentMs = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM context_turns WHERE updated_at_ms < ?').run(currentMs - CONTEXT_TTL_MS);
      const current = this.getTask(id, peer);
      if (!current) {
        this.database.exec('COMMIT');
        return { outcome: 'not-found', task: null };
      }
      if (TERMINAL_STATES.has(current.state)) {
        this.database.exec('COMMIT');
        return { outcome: 'terminal', task: current };
      }
      if (![STATES.INPUT_REQUIRED, STATES.AUTH_REQUIRED].includes(current.state)) {
        this.database.exec('COMMIT');
        return { outcome: 'active', task: current };
      }

      const context = this.database.prepare('SELECT turn_count, updated_at_ms FROM context_turns WHERE peer = ? AND context_id = ?')
        .get(peer, current.contextId);
      const previousTurns = context && currentMs - context.updated_at_ms <= CONTEXT_TTL_MS ? context.turn_count : 0;
      if (previousTurns >= maxTurns) {
        this.database.prepare(`
          UPDATE tasks
          SET state = ?, input_json = ?, output_text = '', status_text = ?, cancellation_requested = 0, updated_at = ?
          WHERE id = ? AND peer = ? AND state IN (?, ?)
        `).run(
          STATES.REJECTED,
          JSON.stringify(input),
          `context turn limit exceeded (${maxTurns})`,
          timestamp,
          id,
          peer,
          STATES.INPUT_REQUIRED,
          STATES.AUTH_REQUIRED,
        );
        this.database.prepare(`
          UPDATE push_configs
          SET claimed_at = NULL, delivered_at = NULL, delivery_attempts = 0
          WHERE task_id = ? AND peer = ?
        `).run(id, peer);
        this.database.exec('COMMIT');
        return { outcome: 'rejected', task: this.getTask(id, peer) };
      }

      const updated = this.database.prepare(`
        UPDATE tasks
        SET state = ?, input_json = ?, output_text = '', status_text = '', cancellation_requested = 0, updated_at = ?
        WHERE id = ? AND peer = ? AND state IN (?, ?)
      `).run(
        STATES.SUBMITTED,
        JSON.stringify(input),
        timestamp,
        id,
        peer,
        STATES.INPUT_REQUIRED,
        STATES.AUTH_REQUIRED,
      );
      if (updated.changes === 0) throw new Error('task state changed during continuation');
      this.database.prepare(`
        INSERT INTO context_turns (peer, context_id, turn_count, updated_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(peer, context_id) DO UPDATE SET turn_count = excluded.turn_count, updated_at_ms = excluded.updated_at_ms
      `).run(peer, current.contextId, previousTurns + 1, currentMs);
      this.database.prepare('INSERT INTO messages (message_id, context_id, peer, role, task_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.messageId || `msg-${randomUUID()}`, current.contextId, peer, 'user', id, input.text, timestamp);
      this.database.prepare(`
        UPDATE push_configs
        SET claimed_at = NULL, delivered_at = NULL, delivery_attempts = 0
        WHERE task_id = ? AND peer = ?
      `).run(id, peer);
      this.trimMessages();
      this.database.exec('COMMIT');
      return { outcome: 'accepted', task: this.getTask(id, peer) };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getTask(id, peer = '') {
    const row = peer
      ? this.database.prepare('SELECT * FROM tasks WHERE id = ? AND peer = ?').get(id, peer)
      : this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return mapTask(row);
  }

  listTasks(peer, {
    contextId = '', state = '', pageSize = 50, pageToken = '', statusTimestampAfter = '',
  } = {}) {
    const limit = Math.max(1, Math.min(Number(pageSize) || 50, 100));
    const where = ['peer = ?'];
    const args = [peer];
    if (contextId) {
      where.push('context_id = ?');
      args.push(contextId);
    }
    if (state) {
      where.push('state = ?');
      args.push(state);
    }
    if (statusTimestampAfter) {
      where.push('updated_at >= ?');
      args.push(statusTimestampAfter);
    }
    const totalClause = where.join(' AND ');
    const total = this.database.prepare(`SELECT COUNT(*) AS total FROM tasks WHERE ${totalClause}`).get(...args).total;
    const cursor = decodePageToken(pageToken);
    if (cursor) {
      where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      args.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = this.database.prepare(`
      SELECT * FROM tasks WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(...args, limit + 1);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      tasks: pageRows.map(mapTask),
      total,
      nextPageToken: hasMore ? encodePageToken(pageRows.at(-1)) : '',
    };
  }

  markWorking(id, peer) {
    const timestamp = nowIso();
    const result = this.database.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND peer = ? AND state = ?')
      .run(STATES.WORKING, timestamp, id, peer, STATES.SUBMITTED);
    return result.changes > 0 ? this.getTask(id, peer) : null;
  }

  completeTask(id, requestedState, outputText = '', statusText = '') {
    if (!SETTLED_STATES.has(requestedState)) throw new Error(`invalid settled state: ${requestedState}`);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getTask(id);
      if (!current || SETTLED_STATES.has(current.state)) {
        this.database.exec('COMMIT');
        return { changed: false, task: current };
      }
      const state = current.cancellationRequested ? STATES.CANCELED : requestedState;
      const safeOutput = state === STATES.CANCELED ? '' : outputText;
      const safeStatus = state === STATES.CANCELED ? 'cancellation requested; late Runtime output suppressed' : statusText;
      const timestamp = nowIso();
      this.database.prepare(`
        UPDATE tasks SET state = ?, output_text = ?, status_text = ?, updated_at = ?
        WHERE id = ? AND state IN (?, ?)
      `).run(state, safeOutput, safeStatus, timestamp, id, ...ACTIVE_STATES);
      if (safeOutput) {
        this.database.prepare('INSERT INTO messages (message_id, context_id, peer, role, task_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(`msg-${randomUUID()}`, current.contextId, current.peer, 'agent', id, safeOutput, timestamp);
      }
      if (state === STATES.CANCELED) {
        this.database.prepare('DELETE FROM context_turns WHERE peer = ? AND context_id = ?').run(current.peer, current.contextId);
      }
      this.trimTasksToLimit(this.maxTasks);
      this.trimMessages();
      this.database.exec('COMMIT');
      return { changed: true, task: this.getTask(id) };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  requestCancellation(id, peer) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getTask(id, peer);
      if (!current) {
        this.database.exec('COMMIT');
        return { outcome: 'not-found', task: null };
      }
      if (SETTLED_STATES.has(current.state)) {
        this.database.exec('COMMIT');
        return { outcome: 'settled', task: current };
      }
      const timestamp = nowIso();
      if (current.state === STATES.SUBMITTED) {
        this.database.prepare('UPDATE tasks SET state = ?, status_text = ?, updated_at = ? WHERE id = ? AND peer = ? AND state = ?')
          .run(STATES.CANCELED, 'canceled before Runtime dispatch', timestamp, id, peer, STATES.SUBMITTED);
        this.database.prepare('DELETE FROM context_turns WHERE peer = ? AND context_id = ?').run(peer, current.contextId);
        this.database.exec('COMMIT');
        return { outcome: 'canceled', task: this.getTask(id, peer) };
      }
      this.database.prepare('UPDATE tasks SET cancellation_requested = 1, status_text = ?, updated_at = ? WHERE id = ? AND peer = ? AND state = ?')
        .run('cancellation requested; exact Runtime interruption is unavailable', timestamp, id, peer, STATES.WORKING);
      this.database.exec('COMMIT');
      return { outcome: 'requested', task: this.getTask(id, peer) };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getHistory(peer, contextId, limit = 20) {
    const boundedLimit = Math.max(0, Math.min(Number(limit) || 0, 100));
    const rows = peer
      ? this.database.prepare(`
          SELECT id, message_id, role, task_id, text, created_at FROM messages
          WHERE peer = ? AND context_id = ? ORDER BY id DESC LIMIT ?
        `).all(peer, contextId, boundedLimit)
      : this.database.prepare(`
          SELECT id, message_id, role, task_id, text, created_at FROM messages
          WHERE context_id = ? ORDER BY id DESC LIMIT ?
        `).all(contextId, boundedLimit);
    return rows.reverse().map((row) => ({
      messageId: row.message_id || `msg-${row.id}`,
      role: row.role,
      taskId: row.task_id,
      text: row.text,
      createdAt: row.created_at,
    }));
  }

  appendMessage(peer, contextId, role, text, taskId = null) {
    if (!['user', 'agent'].includes(role)) throw new Error(`invalid message role: ${role}`);
    const timestamp = nowIso();
    const messageId = `msg-${randomUUID()}`;
    this.database.prepare('INSERT INTO messages (message_id, context_id, peer, role, task_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(messageId, contextId, peer, role, taskId, text, timestamp);
    this.trimMessages();
    return { messageId, peer, contextId, role, taskId, text, createdAt: timestamp };
  }

  listContexts(limit = 50) {
    return this.database.prepare(`
      SELECT peer, context_id AS contextId, COUNT(*) AS messages, MAX(created_at) AS updatedAt
      FROM messages GROUP BY peer, context_id ORDER BY updatedAt DESC LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || 50, 100)));
  }

  setPushConfig(taskId, peer, value) {
    if (!this.getTask(taskId, peer)) return null;
    const existingCount = this.database.prepare('SELECT COUNT(*) AS total FROM push_configs WHERE task_id = ? AND peer = ?')
      .get(taskId, peer).total;
    if (existingCount >= 10) {
      const error = new Error('push notification config limit reached (10)');
      error.code = 'PUSH_CONFIG_CAPACITY';
      throw error;
    }
    if (typeof value === 'string') value = { url: value };
    const configId = value.id || `cfg-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    if (this.getPushConfig(taskId, peer, configId)) {
      const error = new Error(`push notification config already exists: ${configId}`);
      error.code = 'PUSH_CONFIG_EXISTS';
      throw error;
    }
    const createdAt = nowIso();
    const authentication = value.authentication && typeof value.authentication === 'object'
      ? value.authentication
      : {};
    this.database.prepare(`
      INSERT INTO push_configs (
        config_id, task_id, peer, url, token, auth_scheme, auth_credentials,
        created_at, claimed_at, delivered_at, delivery_attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
    `).run(
      configId,
      taskId,
      peer,
      value.url,
      String(value.token || ''),
      String(authentication.scheme || ''),
      String(authentication.credentials || ''),
      createdAt,
    );
    return this.getPushConfig(taskId, peer, configId);
  }

  getPushConfig(taskId, peer, configId = '') {
    if (!configId) return null;
    const row = this.database.prepare('SELECT * FROM push_configs WHERE task_id = ? AND peer = ? AND config_id = ?')
      .get(taskId, peer, configId);
    return mapPushConfig(row);
  }

  listPushConfigs(taskId, peer) {
    return this.database.prepare('SELECT * FROM push_configs WHERE task_id = ? AND peer = ? ORDER BY created_at, config_id')
      .all(taskId, peer)
      .map((row) => mapPushConfig(row));
  }

  deletePushConfig(taskId, peer, configId = '') {
    const result = configId
      ? this.database.prepare('DELETE FROM push_configs WHERE task_id = ? AND peer = ? AND config_id = ?').run(taskId, peer, configId)
      : this.database.prepare('DELETE FROM push_configs WHERE task_id = ? AND peer = ?').run(taskId, peer);
    return result.changes > 0;
  }

  claimPushConfigs(taskId) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database.prepare(`
        SELECT * FROM push_configs
        WHERE task_id = ? AND claimed_at IS NULL AND delivered_at IS NULL AND delivery_attempts < 5
      `)
        .all(taskId);
      if (rows.length === 0) {
        this.database.exec('COMMIT');
        return [];
      }
      const claimedAt = nowIso();
      this.database.prepare(`
        UPDATE push_configs SET claimed_at = ?
        WHERE task_id = ? AND claimed_at IS NULL AND delivered_at IS NULL AND delivery_attempts < 5
      `)
        .run(claimedAt, taskId);
      this.database.exec('COMMIT');
      return rows.map((row) => ({ ...mapPushConfig(row), peer: row.peer }));
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  finishPushDelivery(configId, delivered) {
    const deliveredAt = delivered ? nowIso() : null;
    this.database.prepare(`
      UPDATE push_configs
      SET claimed_at = NULL, delivered_at = ?, delivery_attempts = delivery_attempts + ?
      WHERE config_id = ?
    `).run(deliveredAt, delivered ? 0 : 1, configId);
  }

  releaseStalePushClaims(cutoffIso) {
    return this.database.prepare(`
      UPDATE push_configs SET claimed_at = NULL
      WHERE delivered_at IS NULL AND claimed_at IS NOT NULL AND claimed_at < ?
    `).run(cutoffIso).changes;
  }

  listTasksWithPendingPushes() {
    return this.database.prepare(`
      SELECT DISTINCT tasks.id
      FROM tasks JOIN push_configs ON push_configs.task_id = tasks.id
      WHERE tasks.state IN (?, ?, ?, ?, ?, ?)
        AND push_configs.delivered_at IS NULL
        AND push_configs.claimed_at IS NULL
        AND push_configs.delivery_attempts < 5
    `).all(...SETTLED_STATES).map((row) => row.id);
  }

  expireActiveTasks(cutoffIso, interruptedCutoffIso = cutoffIso) {
    const timestamp = nowIso();
    const rows = this.database.prepare(`
      UPDATE tasks
      SET state = ?, status_text = ?, updated_at = ?
      WHERE (state IN (?, ?) AND updated_at < ?)
         OR (state IN (?, ?) AND updated_at < ?)
      RETURNING id, peer, context_id
    `).all(
      STATES.FAILED,
      'task expired during component recovery',
      timestamp,
      ...ACTIVE_STATES,
      cutoffIso,
      STATES.INPUT_REQUIRED,
      STATES.AUTH_REQUIRED,
      interruptedCutoffIso,
    );
    for (const row of rows) {
      this.database.prepare('DELETE FROM context_turns WHERE peer = ? AND context_id = ?').run(row.peer, row.context_id);
    }
    return rows.map((row) => row.id);
  }

  trimTasksToLimit(limit) {
    const total = this.database.prepare('SELECT COUNT(*) AS total FROM tasks').get().total;
    const overflow = Math.max(0, total - Math.max(0, limit));
    if (overflow === 0) return;
    this.database.prepare(`
      DELETE FROM tasks WHERE id IN (
        SELECT id FROM tasks
        WHERE state IN (?, ?, ?, ?)
          AND NOT EXISTS (
            SELECT 1 FROM push_configs
            WHERE push_configs.task_id = tasks.id
              AND push_configs.delivered_at IS NULL
              AND push_configs.delivery_attempts < 5
          )
        ORDER BY updated_at, id LIMIT ?
      )
    `).run(...TERMINAL_STATES, overflow);
  }

  trimMessages() {
    const limit = this.maxTasks * 2;
    this.database.prepare(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages ORDER BY id DESC LIMIT -1 OFFSET ?
      )
    `).run(limit);
  }

  close() {
    this.database.close();
  }
}
