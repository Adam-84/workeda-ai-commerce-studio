# Cloud Foundation Implementation Plan

> Execute with superpowers:executing-plans, with independent storage/worker tasks delegated under dispatching-parallel-agents. No production deployment.

**Goal:** prepare a central Archipel server usable from multiple devices without exposing the old local API.

**Architecture:** one Node 24 process, one persistent SQLite application database; separate control database for worker identities and leases. The existing HTTP application receives an explicit request authorizer only from the cloud entry point. Local startup remains loopback-only. All cloud AI requests go through a typed broker, never a shell command.

**Spec:** `docs/FINALISATION-2026-11-26.md` and the owner's 33-section finalisation request.

## Constraints and decisions

- Preserve eleven agents, Skills, Memory, Comms and all existing integrations. No data deletion or real migration.
- No Codex activation, new provider account, API charge, DNS edit, production exposure or main merge.
- Authentication for one owner: password hash configured outside Git, expiring HttpOnly/SameSite cookie, same-origin writes, bounded login attempts, logout/revoke. Restart invalidates sessions safely.
- Secrets and journals outside source. Backups are protected artifacts; source databases are opened read-only, restoration creates a new path and never overwrites.
- Jobs have fixed type `claude.text`, no tools, model allowlist configured by operator, per-worker token hash, heartbeat, exclusive lease, revocation and uncertain outcomes without automatic re-execution. Runner Codex is unavailable. Only simulated workers are exercised here.
- No worker available: Comms remains queued, Automation waits for explicit reconsideration; deterministic work continues.
- Local subscription remains available through the existing unmodified CLI path. Remote credentials require the owner's own official authentication; none are copied. Provider terms and costs documented from official pages.
- Docker daemon unavailable on this PC: prepare configuration and validate what is possible, do not claim a container runtime test.

## Tasks and acceptance

- [ ] Authentication: `src/cloud-auth.js`, `test/cloud-auth.test.js`, `public/login.html`, `public/login.js`. Exercise wrong/correct login, CSRF, expiration, logout, revocation, throttling, non-public status and no sensitive cache. Async scrypt, no plaintext password persistence.
- [ ] Worker broker: `src/worker-broker.js`, `src/worker-client.js`, `tools/workers.mjs`, `test/worker-broker.test.js`. `createWorkerBroker(db,{now})` exposes enroll/revoke/authenticate/heartbeat/claim/complete/enqueue/job/status; payload only provider/model/system/prompt/tools=[]/timeoutMs; idempotency key mandatory. `runWorkerOnce` uses a fixed injected runner and allowlisted models. Never execute an arbitrary command. Test concurrent claims, stale completions, revoked identity, timeout, denied tools and unknown model.
- [ ] Storage: `src/database-transfer.js`, `tools/database-transfer.mjs`, `test/database-transfer.test.js`. Preview tables/counts/schema and conflicts without row contents; SQLite consistent backup, integrity verification and restore to a new destination. Hash every artifact; real migration requires explicit human operation. Both PCs stay intact.
- [ ] Runtime: `src/cloud-server.js`, integration test, minimal dependency injection in `src/app.js`, `src/comm-run.js`, `src/studio.js`, `src/studio-automation.js`. Auth protects all routes and static app entry. UI worker/status dashboard gives unknown quotas honestly. Shutdown stops claim loops before database close.
- [ ] Deployment: Dockerfile, private compose binding, .dockerignore, Caddy example, install/backup/update/rollback docs and official hosting comparison. Scheduled snapshots, health checks, restart policy; secrets not baked into image. Tests use temporary databases.
- [ ] Full suite and branch review, commit/push/draft PR against verified Automation branch. Phase 11 starts on a distinct branch only after this base is verified.

## Review focus

Session bypass via legacy streaming route; unauthenticated static data; duplicate inference after lease expiry; worker permission change while job is held; secret/journal inclusion in image/backup; partial writes on failed restore; no-worker tasks consuming an AI quota; central startup accidentally importing old Git journals. Each is owned by the corresponding task above.
