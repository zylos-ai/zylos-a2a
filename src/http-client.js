import http from 'node:http';
import https from 'node:https';
import { resolveSafeUrl } from './security.js';

export async function requestBody(value, {
  method = 'GET',
  headers = {},
  body = '',
  timeoutMs = 30_000,
  maxResponseBytes = 2_097_152,
  allowPrivate = false,
} = {}) {
  const resolved = await resolveSafeUrl(value, { allowPrivate });
  if (resolved.url.protocol === 'http:' && !resolved.isPrivate) {
    throw new Error('unencrypted HTTP is allowed only for explicitly enabled private destinations');
  }
  const transport = resolved.url.protocol === 'https:' ? https : http;
  const requestHeaders = { ...headers };
  if (body && requestHeaders['Content-Length'] === undefined) {
    requestHeaders['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: resolved.url.protocol,
      hostname: resolved.url.hostname,
      port: resolved.url.port || undefined,
      path: `${resolved.url.pathname}${resolved.url.search}`,
      method,
      headers: requestHeaders,
      servername: resolved.url.hostname,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
        else callback(null, resolved.address, resolved.family);
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          response.destroy(new Error(`response exceeded ${maxResponseBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 300 && response.statusCode < 400) {
          reject(new Error('HTTP redirects are not followed'));
          return;
        }
        resolve({ status: response.statusCode, headers: response.headers, body: responseBody });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function requestJson(value, options = {}) {
  const response = await requestBody(value, options);
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`HTTP ${response.status}: ${response.body.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  try {
    return { ...response, json: JSON.parse(response.body) };
  } catch {
    throw new Error('response was not valid JSON');
  }
}
