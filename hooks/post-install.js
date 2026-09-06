#!/usr/bin/env node
import fs from 'node:fs';
import { DEFAULT_CONFIG, dataPaths } from '../src/config.js';

const paths = dataPaths();
fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(paths.dataDir, 0o700);
fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(paths.configPath)) {
  fs.writeFileSync(paths.configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { mode: 0o600 });
  console.log('[post-install] Created localhost-only default config');
} else {
  console.log('[post-install] Existing config preserved');
}
console.log('[post-install] A2A data directories ready');
