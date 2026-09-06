# AGENTS.md — zylos-a2a engineering conventions

This file binds every agent that develops, reviews, or releases this repository.

## Project conventions

- ESM only. `ecosystem.config.cjs` is the sole CommonJS exception required by PM2.
- Node.js 22.13+ because durable storage uses the built-in stable `node:sqlite` module.
- Code, comments, commits, pull requests, and documentation are in English.
- Runtime configuration and state belong in `~/zylos/components/a2a/`; repository code is disposable.
- Never report an A2A task canceled unless its work was prevented or an exact Runtime turn was interrupted.
- Never bypass peer authentication, task ownership checks, outbound redaction, or callback SSRF checks.

## Release process (hard gate)

Version bumps happen only in a dedicated release PR. Feature work adds source,
tests, and entries under `## [Unreleased]`. A release updates `package.json`,
`package-lock.json`, `SKILL.md`, and `CHANGELOG.md` together, then creates a
GitHub release tagged `vX.Y.Z` after merge.

`test/release-consistency.test.js` must remain able to fail under its negative
controls.

## Testing

- `npm test` runs `node --test` over `test/*.test.js`.
- Prefer behavior tests with real temporary SQLite databases and HTTP servers.
- Tests must cover invalid input, authorization scope, timeout, cancellation,
  persistence, SSRF rejection, and both canonical and legacy protocol names.
