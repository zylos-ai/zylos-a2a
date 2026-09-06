# zylos-a2a

A bidirectional A2A v1.0 communication component for Zylos.

[中文](./README.zh-CN.md) · [Design](./docs/DESIGN.md) · [Security](./SECURITY.md)

`zylos-a2a` exposes a Zylos agent through the A2A JSON-RPC binding and lets
that agent discover and call configured peers. Inbound tasks enter the current
Zylos Runtime through C4, while task state, context history, and push settings
remain durable in SQLite.

## Capabilities

- Canonical A2A v1.0 and legacy method aliases for send, stream, subscribe,
  get, list, cancel, and push-notification configuration operations.
- Agent Card discovery at `/.well-known/agent-card.json` with legacy fallback.
- Peer-scoped authentication, trust, rate limits, task ownership, and context
  history.
- Short-lived, single-use private invitations that bind the first accepting
  agent and issue a durable per-peer credential automatically.
- DNS-pinned outbound requests, redirect rejection, SSRF protection, output
  redaction, callback authentication, optional HMAC signatures, and
  metadata-only audit records.
- Explicit single-peer calls and an opt-in experimental fan-out command.

The component intentionally has no automatic directory, peer selection, or
cross-organization trust. Operators explicitly pair or configure each trusted
peer.

## Requirements

- Zylos 0.7.1 or later.
- Node.js 22.13 or later (`node:sqlite` is used for durable storage without an experimental flag).
- A trusted TLS reverse proxy or private network when exposing the service
  beyond localhost.

## Install

Until the component is listed in the Zylos Registry:

```bash
zylos add zylos-ai/zylos-a2a
```

After registry acceptance, the short name is enough:

```bash
zylos add a2a
```

The installer creates `~/zylos/components/a2a/config.json` with mode `0600`.
The component is disabled and bound to localhost by default; enable it only
after reviewing the identity fields and configuring the intended trust policy.
Runtime data is preserved across upgrades.

## Configure peers

The example below shows reciprocal trust with one peer. Use distinct random
tokens in each direction and exchange them only through a private channel.

```json
{
  "enabled": true,
  "server": {
    "host": "127.0.0.1",
    "port": 9900,
    "public_url": "https://agent.example.com/a2a"
  },
  "identity": {
    "name": "My Zylos Agent",
    "description": "A persistent Zylos agent",
    "skills": []
  },
  "auth": {
    "bearer_token": "",
    "peer_tokens": {
      "research-agent": "replace-with-the-token-that-peer-will-present"
    },
    "trusted_peers": ["research-agent"],
    "rate_limit_per_minute": 60
  },
  "outbound": {
    "peers": {
      "research-agent": {
        "url": "https://research.example.com/a2a",
        "token": "replace-with-the-token-issued-by-that-peer"
      }
    }
  }
}
```

Keep `server.host` on localhost when a reverse proxy terminates TLS. Set
`server.public_url` to the externally reachable A2A root. Direct private-IP
peers and private push callbacks stay blocked unless their explicit
`allow_private` controls are enabled for a controlled network.

## Pair with one private copy

On agent A, create a short-lived invitation after configuring
`server.public_url`:

```bash
node ~/zylos/.claude/skills/a2a/scripts/a2a.js pair create --ttl 600
```

The JSON output is a private bearer credential. Send the complete output to
agent B through a private channel only. On B, pass the invitation on stdin so
the secret never appears in process arguments:

```bash
node ~/zylos/.claude/skills/a2a/scripts/a2a.js pair accept --alias agent-a <<'A2AINVITE'
paste the complete invitation JSON here
A2AINVITE
```

B submits its stable local identity, A atomically binds the first successful
redeemer, and B saves the issued credential in its mode-`0600` config before
verifying it. The invitation remains visible as bound audit state but cannot be
replayed. `pair list` shows invitation state without secrets; `pair revoke
<invitation-id>` revokes a pending invitation or the credential issued from a
bound invitation.

Version 0.1.0 records one fixed `a2a:tasks` permission, covering the existing
peer-scoped A2A task methods. Scoped grants are deliberately outside this first
pairing flow. If the redemption response is lost before B saves it, A will show
the invitation as bound; revoke it and create a new invitation rather than
retrying the consumed secret.

One invitation grants B access to A only. Create a second invitation on B if A
also needs access to B. Add `--allow-private` to `pair accept` only for a
controlled private-network destination; that allowance is saved only on the
paired Peer.

## Verify a connection

The local Agent Card never includes configured authentication credentials.
Review identity metadata before sharing it because every identity field is public:

```bash
node ~/zylos/.claude/skills/a2a/scripts/a2a.js card
```

Discover and call a configured peer:

```bash
node ~/zylos/.claude/skills/a2a/scripts/a2a.js discover research-agent

node ~/zylos/.claude/skills/a2a/scripts/a2a.js call research-agent <<'A2AMSG'
Summarize your current capabilities.
A2AMSG
```

Continue an existing conversation with `--context <context-id>`. Use `list`
and `history` to inspect local task state, and `pair list` for pairing state.
The `orchestrate` command is
experimental and must be invoked explicitly; ordinary calls never fan out.

## Cancellation semantics

A queued task can be canceled before dispatch. Once work is running, current
Zylos Core exposes no exact Runtime turn handle keyed by the A2A task ID.
`CancelTask` therefore records the request, returns `TaskNotCancelable`, and
suppresses late output. It never reports that running work was interrupted
when it was not.

## Development

```bash
npm ci
npm run check
```

The test suite uses real temporary SQLite databases and HTTP servers. Release
versions in `package.json`, `package-lock.json`, `SKILL.md`, and `CHANGELOG.md`
must remain synchronized.

## License

[MIT](./LICENSE)
