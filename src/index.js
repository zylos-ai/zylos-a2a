#!/usr/bin/env node
import { loadConfig } from './config.js';
import { deliverTaskPush } from './push.js';
import { createA2AServer } from './server.js';
import { TaskStore } from './store.js';

const config = loadConfig();
if (!config.enabled) {
  console.log(JSON.stringify({ level: 'info', message: 'A2A component is disabled' }));
  process.exit(0);
}

const store = new TaskStore(config.paths.databasePath, { maxTasks: config.protocol.maxTasks });
const service = createA2AServer({ config, store });
const address = await service.start();
console.log(JSON.stringify({ level: 'info', message: 'A2A server started', host: address.address, port: address.port }));

let recovering = false;
async function recoverDurableWork() {
  if (recovering) return;
  recovering = true;
  try {
    const activeCutoff = new Date(Date.now() - config.server.requestTimeoutMs).toISOString();
    const interruptedCutoff = new Date(Date.now() - 86_400_000).toISOString();
    const expired = store.expireActiveTasks(activeCutoff, interruptedCutoff);
    const claimCutoff = new Date(Date.now() - 60_000).toISOString();
    store.releaseStalePushClaims(claimCutoff);
    const taskIds = new Set([...expired, ...store.listTasksWithPendingPushes()]);
    for (const taskId of taskIds) await deliverTaskPush({ config, store, taskId });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'A2A recovery failed', error: error.message }));
  } finally {
    recovering = false;
  }
}

await recoverDurableWork();
const recoveryTimer = setInterval(recoverDurableWork, 60_000);
recoveryTimer.unref();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({ level: 'info', message: 'A2A server stopping', signal }));
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref();
  try {
    clearInterval(recoveryTimer);
    await service.stop();
    store.close();
    clearTimeout(forceTimer);
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'A2A shutdown failed', error: error.message }));
    process.exit(1);
  }
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
