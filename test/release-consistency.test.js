import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseSkillVersion(skillMd) {
  const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/);
  return frontmatter?.[1].match(/^version:\s*(\S+)\s*$/m)?.[1] ?? null;
}

function parseChangelogVersion(changelogMd) {
  return changelogMd.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1] ?? null;
}

function realFaces() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lockJson = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  return {
    package: packageJson.version,
    lockRoot: lockJson.version,
    lockPackage: lockJson.packages?.['']?.version,
    skill: parseSkillVersion(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')),
    changelog: parseChangelogVersion(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')),
  };
}

function mismatches(faces) {
  return Object.entries(faces).filter(([, version]) => version !== faces.package);
}

test('all release version faces agree', () => {
  assert.deepEqual(mismatches(realFaces()), []);
});

test('negative control catches a stale SKILL version', () => {
  const faces = realFaces();
  faces.skill = '0.0.0-stale';
  assert.deepEqual(mismatches(faces).map(([name]) => name), ['skill']);
});

test('negative control catches both stale lockfile faces', () => {
  const faces = realFaces();
  faces.lockRoot = '0.0.1-stale';
  faces.lockPackage = '0.0.2-stale';
  assert.deepEqual(mismatches(faces).map(([name]) => name), ['lockRoot', 'lockPackage']);
});

test('negative control catches a missing changelog release', () => {
  const faces = realFaces();
  faces.changelog = null;
  assert.deepEqual(mismatches(faces).map(([name]) => name), ['changelog']);
});

test('an Unreleased section does not hide the latest released version', () => {
  assert.equal(parseChangelogVersion('# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n'), '1.2.3');
});
