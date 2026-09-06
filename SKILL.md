---
name: a2a
version: 0.1.0
description: A2A v1.0 inbound server, outbound peer client, and private agent pairing for Zylos
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-a2a
    entry: src/index.js
  data_dir: ~/zylos/components/a2a
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - tasks.sqlite
    - audit.jsonl
    - logs/
    - backups/

upgrade:
  repo: zylos-ai/zylos-a2a
  branch: main

config:
  optional:
    - name: BEARER_TOKEN
      description: Shared inbound bearer token; per-peer tokens should be configured directly in config.json
      sensitive: true

dependencies:
  - comm-bridge
---

# A2A

Use this skill when a user asks to connect or pair two Zylos agents, shares a
one-time A2A invitation, another agent must call Zylos through A2A v1.0, or
Zylos must discover, call, inspect, or orchestrate A2A peers.

## Conversation-first invariant

The human interface is natural-language conversation. When the user asks to
generate or accept an invitation, list or revoke a pairing, inspect history,
discover a peer, or call another agent, perform the corresponding local
operation yourself and return a concise human-readable result.

Never tell the user to run `node`, paste a shell command, or edit `config.json`
for a normal A2A operation. The commands below are internal implementation and
diagnostic tools for the agent. If a required setting is missing, explain the
missing outcome-level information and apply it yourself after the user supplies
it.

Map conversational intent as follows:

- "Create/generate an A2A invitation" → run `pair create`, then return the
  complete invitation only through the user's current private channel.
- A pasted invitation with an instruction to connect/accept/pair → pass the
  complete payload to `pair accept` on stdin, save the peer, verify it, and
  summarize the result without echoing the credential.
- "Show/list my A2A peers, connections, or invitations" → run `list` and/or
  `pair list`, then summarize without secrets.
- "Revoke/remove this invitation or pairing" → follow the runtime's destructive
  action confirmation policy, then run `pair revoke` for the resolved invitation.
- "Ask/call/send to <peer>" → resolve the configured peer and run `call`.
- "Continue <context> with <peer>" → run `call --context`.
- "Show A2A history" or "discover <peer>" → run `history` or `discover`.

Do not expose raw command syntax unless the user explicitly asks for developer
or troubleshooting instructions.

## Internal command reference

Messages should be sent on stdin so shell metacharacters remain data:

```bash
cat <<'A2AMSG' | node ~/zylos/.claude/skills/a2a/scripts/a2a.js call <configured-peer> --context <context-id>
message text
A2AMSG
```

Other operations:

```bash
node ~/zylos/.claude/skills/a2a/scripts/a2a.js card
node ~/zylos/.claude/skills/a2a/scripts/a2a.js discover <configured-peer-or-url>
node ~/zylos/.claude/skills/a2a/scripts/a2a.js list
node ~/zylos/.claude/skills/a2a/scripts/a2a.js history <context-id> --peer <peer>
cat <<'A2AMSG' | node ~/zylos/.claude/skills/a2a/scripts/a2a.js orchestrate <capability> --mode all
message text
A2AMSG
```

## Private pairing

Create a short-lived invitation only when the operator asks to establish a
peer relationship:

```bash
node ~/zylos/.claude/skills/a2a/scripts/a2a.js pair create --ttl 600
```

The complete output is a private, single-use bearer credential. Never post it
to a group, shared document, issue, log, or other public surface. Return it only
through the current private channel selected by the operator.

Accept an invitation only from stdin; never place it in command arguments:

```bash
cat <<'A2AINVITE' | node ~/zylos/.claude/skills/a2a/scripts/a2a.js pair accept --alias <peer-name>
complete invitation JSON
A2AINVITE
```

Use `--allow-private` only when the operator explicitly intends to connect to a
controlled private-network peer. `pair list` exposes no secrets. `pair revoke
<invitation-id>` revokes a pending invitation or the credential issued from a
bound one. One invitation establishes one-way access from the accepting agent
to the inviting agent; reverse access requires a separate private invitation.
The initial fixed `a2a:tasks` grant covers the existing peer-scoped task
methods; method-level grants are not implemented.

`card` prints only the local Agent Card and never includes configured auth
credentials. Review identity metadata before sharing because all identity fields
are public. Never share `config.json`, bearer tokens, peer tokens, or pairing
invitations in a group or shared surface. A pairing invitation may be returned
through the operator-selected private channel only.

`orchestrate` is experimental and explicit-only. Use it only when the user
clearly asks to contact multiple agents, compare several peers, or run a
fan-out. Never choose it automatically for an ordinary single-agent task;
resolve the requested target and use `call` instead.

Prefer configured peer names. Direct URLs are SSRF-checked and private
addresses are rejected unless the operator explicitly enables private peers.

## Inbound replies

C4 appends `reply via: a2a:task:<task-id>` to inbound tasks. Reply through that
exact path. A normal reply completes the task. Prefix a clarification request
with `[INPUT_REQUIRED]`; prefix a failure with `[A2A_FAILED]`.

Never claim cancellation succeeded from this component unless the task was
still queued. For an already-running task, the component records the request,
suppresses any late output, and returns `TaskNotCancelable` because current
Zylos Core exposes no exact per-task Runtime interruption handle.
