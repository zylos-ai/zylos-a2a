#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { TaskStore } from '../src/store.js';

const config = loadConfig();
const store = new TaskStore(config.paths.databasePath, { maxTasks: config.protocol.maxTasks });
store.close();
console.log('[post-upgrade] A2A database schema is current');
