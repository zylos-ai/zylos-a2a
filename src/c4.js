import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { wrapInbound } from './security.js';

const MAX_C4_ARGUMENT_BYTES = 110_000;

export function c4ReceivePath(homeDir = os.homedir()) {
  return path.join(homeDir, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
}

export function buildC4Content(task, history = []) {
  const currentOnly = wrapInbound(task.peer, task.id, task.contextId, task.input.text, []);
  if (Buffer.byteLength(currentOnly) > MAX_C4_ARGUMENT_BYTES) {
    throw new Error(`framed task exceeds ${MAX_C4_ARGUMENT_BYTES} bytes`);
  }

  const selected = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = [history[index], ...selected];
    const content = wrapInbound(task.peer, task.id, task.contextId, task.input.text, candidate);
    if (Buffer.byteLength(content) <= MAX_C4_ARGUMENT_BYTES) selected.unshift(history[index]);
  }
  return wrapInbound(task.peer, task.id, task.contextId, task.input.text, selected);
}

export function forwardTaskToC4({ task, history, receivePath = c4ReceivePath(), timeoutMs = 15_000 }) {
  const content = buildC4Content(task, history);
  const endpoint = `task:${task.id}`;
  const args = [receivePath, '--channel', 'a2a', '--endpoint', endpoint, '--json', '--content', content];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`C4 receive terminated by ${signal}`));
      if (code !== 0) return reject(new Error(`C4 receive failed (${code}): ${stderr.trim().slice(0, 500)}`));
      try {
        const response = JSON.parse(stdout.trim());
        if (response.ok === false) return reject(new Error(response.error?.message || 'C4 rejected task'));
        resolve(response);
      } catch {
        reject(new Error('C4 receive returned invalid JSON'));
      }
    });
  });
}
