import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function section(document, heading, nextHeading) {
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const end = document.indexOf(nextHeading, start + heading.length);
  assert.notEqual(end, -1, `missing section boundary: ${nextHeading}`);
  return document.slice(start, end);
}

test('the skill requires agents to execute A2A operations for the user', () => {
  const skill = read('SKILL.md');

  assert.match(skill, /^description: .*private agent pairing/m);
  assert.match(skill, /shares a\none-time A2A invitation/);
  assert.match(skill, /^## Conversation-first invariant$/m);
  assert.match(skill, /Never tell the user to run `node`, paste a shell command, or edit `config\.json`/);
  assert.match(skill, /A pasted invitation[\s\S]*`pair accept` on stdin/);
  assert.match(skill, /Do not expose raw command syntax unless the user explicitly asks/);
});

test('English user workflow is conversational and keeps Node.js in the developer section', () => {
  const readme = read('README.md');
  const userWorkflow = section(readme, '## Use A2A through conversation', '## Advanced operator configuration');
  const developerStart = readme.indexOf('## Developer and troubleshooting CLI');

  assert.match(userWorkflow, /> Create a one-time A2A invitation/);
  assert.match(userWorkflow, /> Accept this A2A invitation/);
  assert.doesNotMatch(userWorkflow, /```(?:bash|sh)|node ~\//);
  assert.ok(developerStart > 0);
  assert.ok(readme.indexOf('node ~/') > developerStart);
});

test('Chinese user workflow is conversational and keeps Node.js in the developer section', () => {
  const readme = read('README.zh-CN.md');
  const userWorkflow = section(readme, '## 通过对话使用 A2A', '## 高级运维配置');
  const developerStart = readme.indexOf('## 开发与排障 CLI');

  assert.match(userWorkflow, /> 生成一份 10 分钟内有效的一次性 A2A 邀请。/);
  assert.match(userWorkflow, /> 接受这份 A2A 邀请/);
  assert.doesNotMatch(userWorkflow, /```(?:bash|sh)|node ~\//);
  assert.ok(developerStart > 0);
  assert.ok(readme.indexOf('node ~/') > developerStart);
});
