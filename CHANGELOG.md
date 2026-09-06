# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [0.1.2] - 2026-09-06

### Fixed

- Allowed an HTTP `server.public_url` for controlled private-network A2A
  deployments instead of rejecting every non-loopback HTTP address.

## [0.1.1] - 2026-09-06

### Changed

- Made natural-language conversation the required human interface for pairing,
  peer management, discovery, history, and calls. Node.js commands are now
  documented only as internal agent and developer diagnostics.

## [0.1.0] - 2026-09-06

### Added

- Added the A2A v1.0 JSON-RPC, Agent Card, task, SSE, and push-configuration
  surfaces, with compatible legacy method names.
- Added durable SQLite tasks, peer-scoped context history, cancellation
  requests, cursor pagination, same-task continuation, multiple push
  configurations, and recovery behavior.
- Added the C4 inbound bridge, task-specific outbound reply adapter, and
  discover, call, card, list, history, and explicit experimental orchestration
  commands.
- Added short-lived, single-use private pairing invitations. The first
  successful redeemer is atomically bound, receives a hashed-at-rest per-peer
  credential under an explicit fixed `a2a:tasks` grant, saves it automatically,
  and verifies the connection.
- Added `pair create`, `pair accept`, `pair list`, and `pair revoke` commands;
  invitation acceptance is stdin-only and bound invitation listings contain no
  secrets.
- Added official package metadata, bilingual operator documentation, private
  vulnerability reporting guidance, consistent SQLite upgrade backups, and a
  Node 22/24 CI gate.

### Changed

- Defined `orchestrate` as explicit-only experimental fan-out; ordinary routing
  discovers and calls one operator-selected peer.
- Disabled fresh installations until explicitly configured, required Node.js
  22.13 or later, and bounded task, message, push-configuration, C4 payload, and
  rate-limiter retention.

### Security

- Added authenticated peer identity, trust policy, task ownership, prompt
  isolation, outbound redaction, metadata-only audit, signed push delivery,
  callback authentication, and DNS-pinned SSRF protection.
- Added bounded unauthenticated redemption rate limiting, strict pairing input
  and response validation, generic redemption failures, replay/expiry/revocation
  enforcement, credential provenance checks, and retained bound audit state.
- Added strict Agent Card security declarations, encrypted public transport,
  proxy-aware fail-closed authentication, generic Runtime diagnostics, honest
  cancellation reporting, and cancellation/dispatch and recovery race fixes.
