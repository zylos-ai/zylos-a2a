#!/usr/bin/env node
import fs from 'node:fs';
import { DEFAULT_CONFIG, dataPaths } from '../src/config.js';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const collected = input.trim() ? JSON.parse(input) : {};
const paths = dataPaths();
fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(paths.dataDir, 0o700);
const existing = fs.existsSync(paths.configPath)
  ? JSON.parse(fs.readFileSync(paths.configPath, 'utf8'))
  : structuredClone(DEFAULT_CONFIG);
if (collected.BEARER_TOKEN) {
  existing.auth ??= {};
  existing.auth.bearer_token = String(collected.BEARER_TOKEN);
  existing.enabled = true;
}
const temporaryPath = `${paths.configPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryPath, paths.configPath);
console.log('[configure] A2A configuration stored');
