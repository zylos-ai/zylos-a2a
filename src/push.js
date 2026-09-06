import { requestBody } from './http-client.js';
import { statusUpdate } from './protocol.js';
import { appendAudit, signPayload } from './security.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverTaskPush({
  config,
  store,
  taskId,
  request = requestBody,
  retryDelays = [100, 300],
}) {
  const claimed = store.claimPushConfigs(taskId);
  if (claimed.length === 0) return { delivered: false, deliveredCount: 0, failedCount: 0, reason: 'not-configured' };
  const task = store.getTask(taskId);
  if (!task) {
    for (const item of claimed) store.finishPushDelivery(item.id, false);
    return { delivered: false, deliveredCount: 0, failedCount: claimed.length, reason: 'task-not-found' };
  }
  const body = JSON.stringify(statusUpdate(task));
  const signature = signPayload(config.push.secret, body);
  let deliveredCount = 0;
  let failedCount = 0;
  for (const item of claimed) {
    const headers = { 'Content-Type': 'application/a2a+json' };
    if (signature) headers['X-A2A-Signature'] = signature;
    if (item.token) headers['X-A2A-Notification-Token'] = item.token;
    if (item.authentication?.scheme && item.authentication.credentials) {
      headers.Authorization = `${item.authentication.scheme} ${item.authentication.credentials}`;
    }
    let deliveryError = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        const response = await request(item.url, {
          method: 'POST',
          headers,
          body,
          timeoutMs: 10_000,
          maxResponseBytes: 65_536,
          allowPrivate: config.push.allowPrivateCallbacks,
        });
        if (response.status < 200 || response.status >= 300) throw new Error(`callback returned HTTP ${response.status}`);
        deliveryError = null;
        break;
      } catch (error) {
        deliveryError = error;
        if (attempt < retryDelays.length) await wait(retryDelays[attempt]);
      }
    }
    if (!deliveryError) {
      store.finishPushDelivery(item.id, true);
      deliveredCount += 1;
      appendAudit(config.paths.auditPath, {
        direction: 'push', peer: item.peer, taskId, outcome: 'delivered', summary: new URL(item.url).origin,
      });
    } else {
      store.finishPushDelivery(item.id, false);
      failedCount += 1;
      appendAudit(config.paths.auditPath, {
        direction: 'push', peer: item.peer, taskId, outcome: 'failed', summary: `${new URL(item.url).origin} delivery failed`,
      });
    }
  }
  return {
    delivered: deliveredCount > 0 && failedCount === 0,
    deliveredCount,
    failedCount,
    reason: failedCount > 0 ? 'one or more callbacks failed' : undefined,
  };
}
