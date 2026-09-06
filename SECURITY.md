# Security Policy

## Supported versions

Security fixes are provided for the latest released version. Upgrade before
reporting an issue that is already resolved on `main`.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for `zylos-ai/zylos-a2a`. Do not
open a public issue with tokens, private Agent Cards, task content, callback
URLs, logs, or configuration files. Include the affected version, impact, and
the smallest safe reproduction you can provide.

## Deployment boundary

- Treat every A2A message and Agent Card as untrusted input.
- Prefer one inbound token per peer. Keep inbound and outbound tokens distinct.
- Keep the service on localhost behind a trusted TLS proxy, or on a controlled
  private network with explicit private-address allowances.
- Share the `card` command output when pairing; never share `config.json`.
- Review `audit.jsonl` before sharing it. The component records metadata only,
  but peer identifiers and task IDs may still be operationally sensitive.
- Running-task cancellation is not an execution interrupt until Zylos Core can
  provide an exact A2A-task-to-Runtime-turn handle.
- Push delivery is at least once across crashes. Receivers must deduplicate
  updates by task and update identity.
- C4 currently accepts task content and Runtime replies through process
  arguments. On a shared host, same-user process inspection can briefly observe
  those arguments; use a dedicated OS account until C4 provides a stdin or
  descriptor-based content interface.
- Rotate local audit logs, service logs, and credential-bearing upgrade backups
  according to the host retention policy; the component does not delete them
  automatically.
