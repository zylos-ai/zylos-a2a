#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataPaths } from '../src/config.js';

const paths = dataPaths();
const backupDir = `${paths.dataDir}/backups`;
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
fs.chmodSync(backupDir, 0o700);
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
if (fs.existsSync(paths.configPath)) {
  const destination = `${backupDir}/${path.basename(paths.configPath)}.${stamp}`;
  fs.copyFileSync(paths.configPath, destination);
  fs.chmodSync(destination, 0o600);
}
if (fs.existsSync(paths.databasePath)) {
  const destination = `${backupDir}/${path.basename(paths.databasePath)}.${stamp}`;
  const escapedDestination = destination.replaceAll("'", "''");
  const database = new DatabaseSync(paths.databasePath);
  try {
    database.exec(`VACUUM INTO '${escapedDestination}'`);
  } finally {
    database.close();
  }
  fs.chmodSync(destination, 0o600);
}
console.log('[pre-upgrade] A2A config and task database backed up');
