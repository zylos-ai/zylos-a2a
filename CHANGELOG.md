# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.2.0] - 2026-09-06

### Added

- Added official repository metadata, package boundaries, bilingual operator
  documentation, security reporting guidance, and a Node 22/24 CI gate.
- Added cursor-based task pagination, same-task continuation from interrupted
  states, multiple push configurations, and durable recovery regressions.

### Changed

- Defined `orchestrate` as an explicit-only experimental fan-out; normal MVP
  routing uses a manually configured peer followed by single-peer discovery
  and call. Agent Directory work follows proven direct peering.
- Added a read-only `card` command for safely sharing the local Agent Card
  without exposing inbound or outbound credentials.
- Disabled fresh installations until explicitly configured, raised the Node.js
  floor to 22.13, and bounded task, message, and push-configuration retention.

### Security

- Audit entries now record message length instead of task content, and push
  delivery entries omit callback paths and query strings.
- Added strict v1 Agent Card security declarations, proxy-aware unauthenticated
  rejection, callback-provided authentication, bounded C4 payloads, durable
  push retries, and SQLite-consistent upgrade backups.
- Closed cancellation/dispatch and recovery races, standardized A2A error
  details, enforced encrypted public transport, stabilized wire identifiers,
  and prevented local Runtime diagnostics from reaching remote peers.

## [0.1.0] - 2026-08-22

### Added

- A2A v1.0 JSON-RPC, Agent Card, task, SSE, and push-config surfaces.
- Durable SQLite tasks, peer-scoped context history, and cancellation requests.
- C4 inbound bridge and task-specific outbound send adapter.
- Authenticated peer identity, trust policy, rate limiting, prompt isolation,
  redaction, audit, signed push delivery, and SSRF protection.
- Outbound discover, call, list, history, and orchestration CLI commands.
