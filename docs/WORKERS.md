# Private Claude workers

The cloud process stores worker identities and jobs in a separate `control.db`.
An operator configures `ARCHIPEL_WORKER_MODELS` explicitly; an empty allowlist
disables enrollment and AI jobs. A model name is configuration, not a claim that
the account has access to it. Quota is reported as unknown. No Codex runner exists.

## Enrollment and revocation

Run the operator CLI on the central host. These commands only change identities;
they never invoke a provider. For example, after configuring the same server
model allowlist in the environment:

```sh
node tools/workers.mjs enroll --db /private/data/control.db --name laptop --models sonnet --token-file /private/laptop-worker-token
node tools/workers.mjs status --db /private/data/control.db
node tools/workers.mjs revoke --db /private/data/control.db --id WORKER_ID
node tools/workers.mjs release --db /private/data/control.db --id WORKER_ID --process-stopped
```

`--token-file` creates a new file exclusively with owner-only POSIX permissions.
On Windows, restrict its directory ACL to the operator. `--print-token` is an
explicit alternative for a private terminal, never shared logs. Enrollment emits
the token only once; the database stores its SHA-256 hash. Each worker has its own
token. Revocation rejects subsequent authentication and fences running jobs. A
lost token must be revoked and replaced. Keep tokens, databases, journals and
backups outside source control and container images.

## Execution contract

`runWorkerOnce({baseUrl, token, models, runner})` in `src/worker-client.js` sends a
heartbeat, claims at most one job, renews the lease while running and submits the
result. `models` is an independent local allowlist. The default runner is the
existing `runClaude`; the only job type is `claude.text`. Inputs are bounded
`provider`, `model`, `system`, `prompt`, empty `tools`, and `timeoutMs` (at most five
minutes). Commands, tools and extra payload fields are rejected. The runner gets
fixed argument fields, never shell commands. Worker transport requires HTTPS,
except loopback HTTP simulations, and refuses redirects before forwarding tokens.

Use the worker machine's own official Claude authentication. Never copy provider
credentials between machines. Real provider execution consumes account usage;
this implementation is validated exclusively with simulated runners.

## Running a worker

Nothing starts a worker automatically. Read "Provider terms" below first, then run
it yourself on the machine that holds your Claude login, and stop it with Ctrl+C:

```sh
node tools/worker.mjs --server http://127.0.0.1:4319 --token-file /private/laptop-worker-token --models sonnet,opus
```

`--once` handles at most one job and exits. The loop retries a failed poll after a
longer pause, never a job, and exits when the server rejects the identity.

A lost heartbeat does not abandon a running job. When the report cannot be delivered
(network failure, timeout, 408, 429 or 5xx), the worker keeps its lease alive and
sends the same report again until the job's time limit; the job itself never runs
twice. An explicit refusal from the server ends the attempts. A failed job shows the
reason reported by the worker, unless it looks like it contains a secret.

A mission whose model no connected worker offers stays queued and consumes no
attempt. A worker that has not sent a heartbeat for 60 seconds, is revoked or holds
an uncertain job counts as unavailable; the operations status reports it as
`blocked` in the last case, and the worker itself prints that it is blocked. To
recover it, check that the earlier process has stopped, then run `release` with
`--process-stopped` on the central host. Revoke the identity instead if its token
may be compromised.

## Provider terms (read on 26 November 2026)

- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance):
  subscription limits assume ordinary, individual use; developers building products
  or services should use API key authentication; third parties may not route
  requests through subscription credentials for their users or collect their tokens.
  An end user may sign in to the unmodified Claude Code binary with their own
  subscription.
- [Claude Code authentication](https://code.claude.com/docs/en/authentication):
  `claude setup-token` covers scripts and environments without a browser.

Neither page names this case: one owner's self-hosted application sending prompts to
the unmodified `claude -p` on that owner's own machine. Archipel stores no Claude
credential, but this repository does not establish that the use is permitted. Confirm
it with Anthropic, or use a paid API key after approving its cost, before relying on
unattended workers. The page [Codex authentication](https://learn.chatgpt.com/docs/auth)
was read only as a summary; Codex stays disabled regardless.

The wire protocol uses `Authorization: Bearer WORKER_TOKEN` and JSON POSTs:

- `/worker/heartbeat`: `{}` or `{jobId, leaseToken}` while holding a job.
- `/worker/claim`: `{}`; returns a job with `leaseToken` and `heartbeatIntervalMs`,
  or `null` when no eligible job exists, with `blocked: true` while the identity is
  held by an uncertain job.
- `/worker/jobs/:id/complete`: `{leaseToken, result}`, where result contains
  `status` (`done` or `failed`), `output` or `error`, and nullable `usage`/`costUsd`.

Usage and cost are provider-reported observations, not independently verified
billing. Missing values remain unknown; they are never replaced with a zero cost.

## Uncertain outcomes

Claims are exclusive across database connections, with one active job per worker.
Heartbeat cannot extend the absolute job timeout. A missed lease, timeout or
revocation makes a running job `uncertain`; it is never automatically reassigned
or retried. Late or incorrect lease tokens cannot change its result. An uncertain
job also blocks new claims for that identity because its original process may
still be executing. Stop and inspect that process before releasing the identity.
Release leaves the job `uncertain`: nothing is replayed and a late report stays
refused. Revocation prevents new accepted work but cannot remotely terminate an
already executing provider request.

An idempotency key identifies one immutable payload and result. Reusing the key
returns the existing job; it cannot replace its prompt or restart execution.
An operator must deliberately create a new key after reviewing an uncertain
outcome. With no eligible worker, a job remains queued without a provider call.
The central runtime's `cancel(id)` and `cancelAll()` stop queued work as
`cancelled` and fence already running work as `uncertain`; they cannot terminate
the worker's provider process.

## Validation

`node --test test/worker-broker.test.js` uses temporary SQLite databases and local
HTTP servers with simulated runners. It covers persistence, individual token
revocation, typed admission, exclusive claims, immutable idempotency keys, stale
results, bounded leases, worker heartbeat and redirect protection. No live AI is
required or called.
