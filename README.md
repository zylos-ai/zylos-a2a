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

## Use A2A through conversation

Normal A2A work is conversation-first. A person should not need to run a
Node.js command or edit `config.json`. Tell the Zylos agent what outcome you
want; the agent uses this component's local tools internally and returns a
human-readable result.

### Pair two agents

In a private conversation with agent A, say for example:

> Create a one-time A2A invitation valid for 10 minutes.

Agent A returns a private invitation. Send the complete invitation to agent B
through a private channel, then say:

> Accept this A2A invitation and save the peer as agent-a.

Agent B accepts the invitation, saves the issued credential, and verifies the
connection. One invitation grants B access to A only. If A also needs access
to B, ask B to create a second invitation and give it privately to A.

Invitations are short-lived bearer credentials. Never post one in a group,
shared document, issue, or log. If an acceptance response is lost, ask agent A
to revoke the bound invitation and create a new one; a consumed invitation
cannot be retried.

### Call and manage peers

Continue in natural language, for example:

> Show my current A2A peers and pairing invitations.

> Ask research-agent to summarize its current capabilities.

> Continue context 8a4e with research-agent and ask for the final result.

> Revoke invitation 91c… and the credential it issued.

The agent resolves the intent, runs the local operation internally, and
summarizes the result without exposing stored credentials. Revocation follows
the normal confirmation policy for destructive actions. Multi-agent fan-out is
experimental and runs only when the person explicitly asks to contact several
agents.

Version 0.1.0 records one fixed `a2a:tasks` permission, covering the existing
peer-scoped A2A task methods. Scoped grants are deliberately outside this first
pairing flow.

## Advanced operator configuration

Manual configuration is optional and intended for operators or developers.
Normal users can ask their agent to apply the same settings.

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

## Developer and troubleshooting CLI

The commands in this section are implementation and diagnostic interfaces for
agents and developers. They are not steps that a normal user must run. When an
agent accepts an invitation, it must pass the payload on stdin so the secret
never appears in process arguments.

Create and accept a private invitation:

```bash
node ~/zylos/.claude/skills/a2a/scripts/a2a.js pair create --ttl 600

node ~/zylos/.claude/skills/a2a/scripts/a2a.js pair accept --alias agent-a <<'A2AINVITE'
paste the complete invitation JSON here
A2AINVITE
```

Add `--allow-private` to `pair accept` only for a controlled private-network
destination; that allowance is saved only on the paired Peer. `pair list`
shows invitation state without secrets. `pair revoke <invitation-id>` revokes a
pending invitation or the credential issued from a bound invitation.

The local Agent Card never includes configured authentication credentials.
Review identity metadata before sharing it because every identity field is
public:

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
The `orchestrate` command is experimental and must be invoked explicitly;
ordinary calls never fan out.

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
