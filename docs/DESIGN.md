# Design

## Purpose

The component ports the useful A2A v1.0 surface from Hermes without importing
Hermes Gateway, Profile, or in-memory task assumptions. It connects the
protocol to Zylos's existing communication and Runtime boundaries.

## Data flow

```text
A2A peer -> HTTP JSON-RPC -> auth/trust/rate limit -> durable task
         -> untrusted-input frame -> C4 channel `a2a`
         -> live Zylos Runtime -> C4 reply -> scripts/send.js
         -> durable completion -> HTTP/SSE response and optional signed push
```

The A2A `contextId` is persisted with each peer's messages. A bounded history
is included in the next C4 turn for that same authenticated peer and context,
so continuity survives Runtime compaction and component restarts without
creating a cloned agent.

## Module boundaries

- `protocol.js`: A2A wire objects, state names, method aliases, and JSON-RPC.
- `store.js`: SQLite task, context, history, push-config, pairing, and issued
  credential state.
- `security.js`: authentication, trust, rate limits, prompt isolation,
  outbound redaction, audit, signatures, and URL resolution policy.
- `c4.js`: shell-free inbound dispatch to the C4 receive interface.
- `server.js`: HTTP and SSE lifecycle; task ownership is enforced here.
- `http-client.js`, `outbound.js`, `push.js`: pinned-address outbound I/O with
  explicit timeouts and response limits.
- `scripts/send.js`: C4 outbound adapter that settles one exact task.

## Persistence and concurrency

SQLite uses WAL, foreign keys, a busy timeout, and `BEGIN IMMEDIATE` around
check-and-act state transitions. C4 replies run in a separate process, so HTTP
waiters poll the same durable database instead of relying on process-local
events. Completion and push claiming are idempotent.

Task rows and retained conversation messages are bounded. Submitted and working
tasks expire after the configured request timeout during recovery; interrupted
tasks expire after 24 hours so abandoned continuations cannot exhaust capacity.

## Security model

Agent Cards are public. Every operational route requires authentication when
tokens are configured. A task is visible only to the authenticated peer that
created it. Body-provided identity is ignored.

DNS results are checked before outbound calls and the selected address is
pinned into the HTTP connection, preventing a second DNS lookup from changing
the destination after SSRF validation. Redirects are not followed.

Pairing invitations are high-entropy, short-lived bearer capabilities stored
only as hashes. `BEGIN IMMEDIATE` makes the pending-to-bound transition and
credential issuance a single SQLite transaction, so concurrent redeemers
cannot both win. The bound identity, time, and revocation state are retained;
long-lived issued credentials are also hashed at rest. Pairing deliberately
establishes only one-way access. The initial permission profile is the explicit
fixed grant `a2a:tasks`, covering the existing peer-scoped task surface; scoped
grants are deferred.

## Honest cancellation

The store distinguishes queued cancellation from a running cancellation
request. Zylos Core currently exposes neither an exact Runtime turn handle nor
an interrupt API keyed by C4/A2A task ID. Therefore running `CancelTask` calls
do not transition to `TASK_STATE_CANCELED`; they return `TaskNotCancelable`
with `cancellationRequested: true`. If the Runtime later replies, `send.js`
suppresses that output and settles the task as canceled. A future core adapter
can replace this boundary when it can prove it is interrupting the exact task.

## Deliberate scope

This release implements JSON-RPC over HTTP only. gRPC, OAuth/OIDC, DID-based
identity, payments, tenant routing, and arbitrary file transfer are outside the
first component boundary. Agent Card skills are explicit configuration because
Zylos does not currently expose a stable live capability registry to components.

Organization-level discovery belongs to an Agent Directory above this
transport, after direct peering is proven. The initial deployment uses either
explicit configuration or a private single-use invitation, resolves one
requested peer, validates its Card, and calls it. Public Agent Cards may be
shared broadly; pairing invitations and bearer credentials may not.
`orchestrate` remains an explicit experiment for user-requested fan-out and is
the last delivery phase; ordinary routing must not invoke it automatically.
Before production fan-out, add concurrency and fan-out limits, budget policy,
per-peer grants, abortable requests, and rubric-based aggregation instead of
longest-text selection.
