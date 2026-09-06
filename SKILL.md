---
name: a2a
version: 0.2.0
description: A2A v1.0 inbound server and outbound peer client for Zylos
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

Use this skill when another agent must call Zylos through A2A v1.0, or when
Zylos must discover, call, inspect, or orchestrate A2A peers.

## Outbound commands

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

`card` prints only the local Agent Card and never includes configured auth
credentials. Review identity metadata before sharing because all identity fields
are public. Never share `config.json`, bearer tokens, or peer tokens in a chat
or group. The operator must place peer credentials privately in each instance's
runtime config.

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
