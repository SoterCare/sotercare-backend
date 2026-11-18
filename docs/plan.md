# sotercare-backend spec 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is sized for one SerenEdge task; lanes per `b2b-plan/18` §5.1.

**Goal:** Deliver the backend's Tier 2 core and its safety core:
- tenant routing, auth, ingest + alert mirror;
- the internal API for the agents;
- `/v1` agent outputs;
- shadows, local credential, push, claim forwarding, `gateway_offline`, the assignment mirror.

Usable on `dev` by 24 Nov (T2-1), accepted by 27 Nov (T2-2).

**Architecture:** A NestJS 11 modular monolith with two entry points (`api`, `worker`). There's one PostgreSQL database per tenant behind a `TenantRegistry`, plus a control DB. The tenant comes only from the token issuer, the gateway registry or the service token. Gateway records arrive by SQS and are acked after commit. Domain events leave through a transactional outbox.

**Tech Stack:** Node 22, TypeScript 5, NestJS 11, TypeORM 0.3, PostgreSQL 16, Redis 7 + BullMQ, Socket.IO 4, `jose`, AWS SDK v3 (SQS, SNS, S3, IoT data plane, Cognito IdP), `@sotercare/contracts`, Jest, docker compose (Postgres, Redis, LocalStack).

**Spec:** [`docs/spec.md`](spec.md) (rev 1). Read the spec section each task names.

## Global Constraints
- `synchronize: false`, migrations only, expand-only. Tenant migrations live in `migrations/tenant/`, control migrations in `migrations/control/`.
- **Tenant source:**
  - REST: issuer → pool → tenant;
  - ingest: `gateway_registry` by `gatewayId`;
  - internal API: the service token.

  **Never** a claim or a payload field. A query without `TenantContext` throws.
- `record_ack` only after the tenant-DB commit. Every record with `recordId` is acked: `committed | duplicate | rejected | suspended`.
- **Never derive safety alerts from telemetry.** `gateway_offline` is the only cloud alert. Backlog records never push or emit `alert.event`.
- **Never write a band assignment.** Cloud assign / unassign / swap → 409 `assign_via_gateway`.
- **Internal API:**
  - the `agent` claim is checked against `x-sc-agents` on every call;
  - no alerts endpoint;
  - no medication field;
  - Medical records only as `care_plan` documents.
- **Logs carry IDs only.** No names, notes, health values or tokens.
- Types come from `@sotercare/contracts` (exact pin, or `github:SoterCare/sotercare-contracts#<commit>` until v1.0.0 is published). No copied types.
- Every timer uses the injected `Clock`. Time zone per facility (`Asia/Colombo` in seed).
- Limits:
  - 5 connections per tenant per container, idle 60 s;
  - tenant cache 60 s;
  - claim wait 3 s;
  - push freshness 120 s;
  - `gateway_offline` 90 s, then every 10 min;
  - shadow offload > 7 KB;
  - presigned URLs ≤ 15 min;
  - service token TTL 15 min;
  - local credential 30 days.
- Run from the repo root: `docker compose up -d`, `npm test`, `npm run test:int`.
- **Commits have no `Co-Authored-By` or AI-attribution lines. Never force-push.**

## Review Focus
1. **Gateway re-sends the same record after a lost ack.** Expected: `duplicate` ack, no second alert event or push. Test: `ingest duplicate recordId acks duplicate and pushes nothing` (Task 5).
2. **Records arriving out of order** (seq 3 before seq 2; assignment `ended` before `started`). Expected: the mirror ends at the highest `seq` / `assignmentSeq`. Tests: `alert mirror keeps highest seq` (Task 5), `assignment mirror applies any order` (Task 12).
3. **A pool's JWKS can't be reached** (Cognito blip). Expected: cached keys keep working; an unknown `kid` → 401, never 500. Test: `guard uses cached jwks when fetch fails` (Task 3).
4. **The worker crashes between commit and ack.** Expected: no ack sent; the redelivered message acks `duplicate`. Test: `crash after commit before ack redelivers as duplicate` (Task 5).
5. **The service token is for tenant A, and the path holds a tenant B resident ID.** Expected: 403, and no query on tenant B's DB. Test: `internal guard refuses out-of-scope resident without touching other tenant` (Task 6).

---

### Task 0: Import the old code with history and restructure (Wed 19 Nov, B1)
Spec §3 (History), §5, §15.6.

**Files:**
- Delete:
  - `apps/ai-summary-service`, `contracts` (both removed by filter-repo);
  - `apps/back-end`, `apps/api-gateway/src/nurse`, `apps/api-gateway/src/realtime/alert-writer*`;
  - `3days-sample.json`, `dist/`, `Dockerfile`, `start.sh`, `docker-compose.yml` (the Koyeb version).
- Move: `apps/api-gateway/src/**` → `src/<module>/` per spec §5; keep `test/support/*`, `migrations` pattern, `scripts/ws-*.cjs`.
- Create: `package.json` (one app), `tsconfig.json`, `nest-cli.json`, `src/main.api.ts`, `src/main.worker.ts`, `docker-compose.yml` (Postgres 16, Redis 7, LocalStack: SQS, S3, SNS), `.env.example`, `.github/workflows/ci.yml`.

- [ ] **Step 1:** In a temp folder, clone the old `back-end` and reduce its history.
  ```bash
  git clone --no-local D:/SoterCare/Github/back-end old-backend && cd old-backend
  git checkout 642c642 -b import
  python -m git_filter_repo --force --invert-paths --path apps/ai-summary-service --path contracts --message-callback "import re; return re.sub(rb'(?im)^co-authored-by:.*\n?', b'', message)"
  git log --format=%B | grep -ci co-authored    # expect 0
  ```
- [ ] **Step 2:** Merge it into the new repo on a branch, then check it.
  ```bash
  cd D:/SoterCare/Github-B2B/sotercare-backend && git checkout -b import-old
  git pull ../old-backend import --allow-unrelated-histories --no-edit
  ```
  Expected: `README.md` and `CLAUDE.md` from the new repo are kept; resolve conflicts in favour of the new files.
- [ ] **Step 3:** Restructure and delete per the Files list (`git mv`). Make `npm ci && npm run build && npm test` pass with the kept specs (`migrations.pg.spec.ts`, `realtime.revocation.spec.ts`, notification attempts).
- [ ] **Step 4:** Run `npm run build && npm test && git log --format=%B | grep -ci co-authored`. Expected: build OK, tests PASS, count `0`.
- [ ] **Step 5:** Commit `chore: import old back-end with history and restructure into modular monolith`, then `git checkout main && git merge --ff-only import-old && git push origin main`. This is a normal push, never forced.

### Task 1: Core: config, clock, context, errors, idempotency, logging (Thu 20 Nov, B1)
Spec §3, §6 (request context), §14.

**Files:**
- Create: `src/core/{config,clock,context,errors,idempotency,logging,ids}.ts`, `src/core/core.module.ts`, `test/core/*.spec.ts`.
- Modify: `package.json` (add `@sotercare/contracts`, `jose`, the AWS SDK v3 clients, `bullmq`, `ioredis`).

**Interfaces:**
- Produces:
  - `Clock { now(): Date }` (`SystemClock`, `FakeClock.advance(ms)`);
  - `TenantContext.run(ctx, fn)`, `TenantContext.get(): {tenantId, actor, requestId}` (throws `NoTenantContext`);
  - `ApiError(status, code, message, details?)`, serialised `{error:{code,message,details}}`;
  - `IdempotencyInterceptor` (key + route + actor; same key + different body → 409 `idempotency_conflict`);
  - `logger` that drops fields named in `REDACT = ["name","displayName","note","text","token","password","residentName"]`;
  - `newId(prefix)` and `uuidv7()`.

- [ ] **Step 1:** Write the tests.
  - `context throws without tenant`.
  - `idempotency returns stored response for same key and body`.
  - `idempotency conflict on same key different body → 409 idempotency_conflict`.
  - `logger redacts names and tokens`: the logged JSON for `{displayName:"Anna", alertId:"a1"}` has no "Anna".
  - `error envelope shape`.
- [ ] **Step 2:** Run `npx jest test/core`. Expected: FAIL.
- [ ] **Step 3:** Implement. Idempotency rows live in the tenant DB table `idempotency_keys` (24 h TTL); the migration comes in Task 2.
- [ ] **Step 4:** Run `npx jest test/core`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): config, clock, tenant context, errors, idempotency, redacting logger`.

### Task 2: Control DB, TenantRegistry, migration runner, local provisioning (Sat 21 Nov, B1)
Spec §6.

**Files:**
- Create:
  - `src/tenancy/{control.entities,tenant-registry,tenant-cache,tenant-db,migration-runner,provisioning.service,ops-tenants.controller}.ts`;
  - `migrations/control/*`;
  - `migrations/tenant/0001-core.ts` (schemas `core`, `telemetry`, `agents`, role `agents_rw`, and the `idempotency_keys`, `audit`, `outbox` tables);
  - `test/tenancy/*.spec.ts`.

**Interfaces:**
- Produces:
  - `TenantRegistry.forTenant(tenantId): Promise<DataSource>`;
  - `TenantDb.get(): DataSource` (from the context);
  - `TenantCache.get(tenantId)`, `.invalidate(tenantId)`;
  - `MigrationRunner.runAll(): Promise<{migrated: string[], failed: string[], stopped: boolean}>`;
  - `ProvisioningService.create(tenantId): Promise<ProvisioningJob>`;
  - CLI `npm run tenant:create -- <tenantId>`, `npm run migrate:tenants`.

- [ ] **Step 1:** Write the tests (integration, Postgres).
  - `cross tenant access throws`: inside the context of `t1`, `forTenant("t2")` → `CrossTenantAccess`.
  - `pool cap 5 per tenant`.
  - `idle pool closed after 60s` (`FakeClock`).
  - `invalidate drops pool`.
  - `migration failure carries on and stops at 2`: 4 tenants, tenants 2 and 3 fail → `failed == ["t2","t3"]`, `stopped == true`, t4 untouched, t2 status `migration_failed`.
  - `provisioning is idempotent`: running `create("acme")` twice → one DB, the job steps all `done`.
  - `agents_rw cannot read core`: connecting as `agents_rw` and running `SELECT FROM core.residents` → permission denied.
- [ ] **Step 2:** Run `npm run test:int -- tenancy`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - The LRU is keyed by `tenantId`; on eviction, `DataSource.destroy()`.
  - The runner sets `SET lock_timeout = '5s'` and runs each tenant in a transaction.
  - Provisioning steps per spec §6.
- [ ] **Step 4:** Run `npm run test:int -- tenancy`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(tenancy): tenant registry, per-tenant migrations, local provisioning`.

### Task 3: Auth: Cognito guard, roles, `/auth/tenant`, `/me` (Sat 21 Nov, B1)
Spec §7.

**Files:**
- Create: `src/auth/{cognito.guard,roles.guard,roles,auth.controller,me.controller,users.entity}.ts`, `migrations/tenant/0002-users.ts`, `test/support/local-jwks-issuer.ts`, `test/auth/*.spec.ts`.

**Interfaces:**
- Consumes: `TenantCache`, `TenantContext`.
- Produces:
  - `@Roles(...roles)`;
  - `CognitoGuard`, which sets the context `{tenantId, actor:{userId, role, wardIds, facilityId}}`;
  - `LocalJwksIssuer.start()`, `.issue({tenantId, sub, role, ...}) → JWT` (the test pool per tenant);
  - `GET /v1/auth/tenant/:tenantId`;
  - `GET /v1/me` (the local credential is added in Task 10).

- [ ] **Step 1:** Write the tests.
  - `tenant from issuer not claim`: a token from pool `t1` with `custom:tenantId="t2"` → the context tenant is `t1`.
  - `ops token refused on tenant routes and tenant token refused on /v1/ops` → 403 `tenant_mismatch`.
  - `deactivated user 403 account_deactivated`.
  - `guard uses cached jwks when fetch fails`.
  - `unknown kid 401`.
  - `auth/tenant returns pool and client ids, 404 tenant_not_found, 410 tenant_closed`.
  - `org admin needs X-Facility-Id`.
- [ ] **Step 2:** Run `npx jest test/auth`. Expected: FAIL.
- [ ] **Step 3:** Implement with `jose.createRemoteJWKSet` per pool, cached in a map; issuer → pool ID → tenant from `TenantCache`.
- [ ] **Step 4:** Run `npx jest test/auth`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(auth): cognito guard with issuer-derived tenant, roles, auth/tenant, me`.

### Task 4: Org model and `seed:demo` (Sat 21 Nov, B1)
Spec §13, §9 (bands entity), §11 (read-side staff / shifts).

**Files:**
- Create:
  - `src/org/*` (entities: facilities, wards, rooms, beds, residents with `residentNo`, alert settings, pause, staff profile, shifts);
  - `src/devices/bands.entity.ts`;
  - `migrations/tenant/0003-org.ts`;
  - `tools/seed/demo.ts`;
  - `test/org/*.spec.ts`.

**Interfaces:**
- Produces:
  - `ResidentNumbers.next(facilityId)`: `R-` + 4 digits, unique per facility, never reused;
  - `npm run seed:demo` (idempotent; stable IDs);
  - `GET /v1/residents`, `GET /v1/residents/:id` (read only in this spec).

- [ ] **Step 1:** Write the tests.
  - `residentNo unique per facility and never reused after discharge`.
  - `seed demo is idempotent`: two runs → the same row counts (20 residents, 24 bands, gateway bound to `demo`).
  - `resident payload has residentNo and no bandId`.
- [ ] **Step 2:** Run `npm run test:int -- org`. Expected: FAIL.
- [ ] **Step 3:** Implement. Seed assignments are created by feeding synthetic `assignment_record`s through the Task 12 mirror service. Until Task 12 lands, the seed leaves bands unassigned; Task 12 updates the seed.
- [ ] **Step 4:** Run `npm run test:int -- org && npm run seed:demo`. Expected: PASS; the `demo` tenant is present.
- [ ] **Step 5:** Commit `feat(org): org model, residentNo, demo seed`.

### Task 5: Ingest, record_ack, alert mirror, telemetry and rollups (Sun 22 Nov, B1)
Spec §8.

**Files:**
- Create:
  - `src/ingest/{sqs.consumer,record-router,record-ack.publisher,gateway-records.entity,tenant-resolver}.ts`;
  - `src/alerts/{alert.entity,alert-event.entity,alert-mirror.service}.ts`;
  - `src/telemetry/{samples,rollup.job,band-status,gateway-status}.ts`;
  - `src/core/iot-publisher.ts` (`AwsIotPublisher`, `FakeIotPublisher`);
  - `migrations/tenant/0004-ingest.ts`;
  - `test/ingest/*.spec.ts`.

**Interfaces:**
- Consumes: `gateway_registry`, `TenantRegistry`, contracts record schemas.
- Produces:
  - `IotPublisher.publish(topic, payload)` and `.updateShadow(thing, name, desired)`;
  - `RecordRouter.handle(msg, queue: "alert-records"|"backlog"|"telemetry"): Promise<AckStatus|null>`;
  - `AlertMirror.apply(record): {alert, isLatest}`;
  - `RollupJob.run(tenantId, hour)`.

- [ ] **Step 1:** Write the tests.
  - `ack only after commit`.
  - `crash after commit before ack redelivers as duplicate`.
  - `ingest duplicate recordId acks duplicate and pushes nothing`.
  - `alert mirror keeps highest seq`: seqs 1, 3, 2 → current `seq == 3`.
  - `envelope tenantId ignored, registry wins`.
  - `unknown gateway rejected and alarmed`.
  - `suspended tenant acks suspended and keeps only alert and assignment records`.
  - `schema-invalid record acks rejected`.
  - `backlog never emits alert.event`.
  - `hourly rollup sums gait seconds`.
- [ ] **Step 2:** Run `npm run test:int -- ingest`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Long-poll consumers delete the SQS message after the ack publish.
  - The `gateway_records` insert, the effect and the outbox rows go in one transaction.
  - Validate payloads with the contracts JSON Schemas (Ajv).
- [ ] **Step 4:** Run `npm run test:int -- ingest`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ingest): sqs ingest, ack after commit, alert mirror, telemetry rollups`.

### Task 6: Service token and internal API guard (Sun 22 Nov, B3)
Spec §7 (service token), §11 (guard).

**Files:**
- Create: `src/auth/{signing-keys.service,service-token.issuer}.ts`, `src/internal-api/{internal.guard,allow-lists}.ts`, `tools/token-issue.ts`, `test/internal-api/guard.spec.ts`.

**Interfaces:**
- Produces:
  - `SigningKeys.current(purpose)` and `.publicKeys(purpose)`;
  - `ServiceTokenIssuer.issue({tenantId, caseId?, chatId?, agent, residentIds, wardIds, audience}): string`;
  - `InternalGuard`, which sets the context from the token;
  - `ALLOW_LISTS` loaded from contracts `internal.yaml` `x-sc-agents`;
  - `npm run token:issue -- --tenant demo --agent wellbeing --case c1`.

- [ ] **Step 1:** Write the tests (scenario 41).
  - `tool outside allow-list 403`.
  - `expired token 401`.
  - `internal guard refuses out-of-scope resident without touching other tenant`: the spy on `TenantRegistry.forTenant` is never called with tenant B.
  - `suspended tenant 402 tenant_suspended`.
  - `family token with two residentIds rejected at issue`.
  - `allow-lists match contracts`: every internal operation has a non-empty `x-sc-agents`.
- [ ] **Step 2:** Run `npx jest test/internal-api/guard`. Expected: FAIL.
- [ ] **Step 3:** Implement. EdDSA via `jose`. Private keys come from Secrets Manager (dev) or env (local).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(internal-api): ed25519 service tokens and allow-list guard`.

### Task 7: Internal read tools (Mon 23 Nov, B3)
Spec §11 (read tools).

**Files:**
- Create: `src/internal-api/reads/*.controller.ts` (one per area: facility and settings, residents, care-plan documents, pseudonyms, alerts aggregate, moisture, bands, metrics and coverage, shifts, staff availability), `test/internal-api/reads.spec.ts`.

**Interfaces:**
- Consumes: the guard, the org / telemetry / alerts entities.
- Produces: every Tier 2 operation ID in contracts `internal.yaml`, plus `getStaffAvailability` (spec §15.1). Responses are paged by cursor, ≤ 2,000 items.

- [ ] **Step 1:** Write the tests, on the seeded `demo` tenant, one per tool.
  - `operations alerts are aggregate only`: no `residentId` / `residentNo` in the body.
  - `care plan documents only for care_plan agent and category care_plan`: a non-`care_plan` item seeded → not returned; agent `wellbeing` → 403.
  - `rollups exclude names`.
  - `staff availability uses pseudonyms`.
  - `responses match contracts schemas` (Ajv over every tool).
- [ ] **Step 2:** Run `npm run test:int -- internal-api/reads`. Expected: FAIL.
- [ ] **Step 3:** Implement. Queries are read-only and pre-aggregated, and each controller maps rows to the contracts body.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(internal-api): tier 2 read tools`.

### Task 8: Internal writes (Mon 23 Nov, B3)
Spec §11 (writes).

**Files:**
- Create:
  - `src/outputs/{output.entity,proposal.entity,case-trace.entity,cover-request.entity}.ts`;
  - `src/internal-api/writes.controller.ts`;
  - `src/outputs/incident-escalation.job.ts`;
  - `migrations/tenant/0005-outputs.ts`;
  - `test/internal-api/writes.spec.ts`.

**Interfaces:**
- Produces:
  - `POST /internal/v1/outputs` (upsert by `dedupeKey`);
  - `PATCH /internal/v1/outputs/:id`;
  - `POST /internal/v1/proposals`;
  - `POST /internal/v1/cases/:id/trace`;
  - `OutputsEvents.emit(type, ids)` (WS + outbox).

- [ ] **Step 1:** Write the tests.
  - `outputs upsert by dedupeKey`.
  - `incident proposal starts with resolving caregiver and escalates to ward head after 24h` (`FakeClock`).
  - `decision cancels escalation`.
  - `no alerts endpoint exists`: a route scan finds no `/internal/v1/alerts` write.
  - `trace stored per case`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(internal-api): outputs, proposals and case traces`.

### Task 9: Outbox → SQS domain events and `schedule_event` (Tue 24 Nov, B3, T2-1)
Spec §11 (outbox).

**Files:**
- Create: `src/internal-api/{outbox.publisher,domain-events,schedule.service}.ts`, `test/internal-api/outbox.spec.ts`.
- Modify: the kept `alert-dispatch.service.ts` pattern, moved into `outbox.publisher.ts`.

**Interfaces:**
- Produces:
  - `Outbox.add(tx, event)`;
  - `OutboxPublisher.tick()` (`FOR UPDATE SKIP LOCKED`, batch 100);
  - `ScheduleService.tick(now)`, which emits `schedule_event` per facility (time zone);
  - the event types listed in spec §11.

- [ ] **Step 1:** Write the tests.
  - `outbox at least once with stable eventId`: a publish failure → retried with the same `eventId`.
  - `alert.resolved emitted on resolved record`.
  - `shift.ending at end minus handover minutes in Asia/Colombo`: a 22:00 shift with 15 min → 21:45 +05:30.
  - `device task schedule every 15 min`.
  - `document.uploaded only for care_plan`.
  - `two publishers never send the same row twice concurrently`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:int`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(internal-api): outbox domain events and schedule_event`.
- [ ] **Step 6 (T2-1 gate):** deploy to `dev`. Run the contracts internal-API contract tests and the iit internal-API adapter's contract tests against `dev`. Expected: green. Record the result in `18` §6.

### Task 10: Local credential, `keys` and the six shadows (Mon 23 Nov, B1, safety core)
Spec §7 (local credential), §10 (shadows).

**Files:**
- Create: `src/auth/local-credential.service.ts`, `src/shadows/{builders/*.ts,shadow.publisher,shadow-applied}.ts`, `migrations/tenant/0006-shadows.ts`, `test/shadows/*.spec.ts`, `test/auth/local-credential.spec.ts`.
- Modify: `src/auth/me.controller.ts` (credential + gateway address and fingerprint).

**Interfaces:**
- Produces:
  - `LocalCredential.issue(user, installationId)` and `.revoke(jti)`;
  - `ShadowPublisher.publish(tenantId, name)`, debounced 2 s;
  - one builder per shadow, returning the contracts shadow `content`.

- [ ] **Step 1:** Write the tests.
  - `local credential claims and 30 day ttl, never for family`.
  - `revoked jti appears in keys shadow until expiry`.
  - `key rotation publishes next key 24h early`.
  - `shadow versions strictly increase`.
  - `content over 7KB goes to S3 with contentRef`.
  - `publishes only to active gateway`.
  - `bands shadow has no assignment and keys wrapped to gateway key`.
  - `roster covers next 72h and republishes hourly`.
  - `shadow builders match contracts fixtures` (the demo fixtures in contracts `mocks/`).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Wrapping uses the contracts crypto helper.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(shadows): local credential, keys and six shadows`.

### Task 11: Alert actions, provisional claims, push, escalation, `gateway_offline` (Tue 24 Nov, B1, safety core)
Spec §8 (actions, `gateway_offline`), §10 (push).

**Files:**
- Create:
  - `src/alerts/{actions.controller,claim-forwarder,provisional-timers,gateway-offline.monitor}.ts`;
  - `src/notifications/{push-tokens.controller,sns.provider,push.rules,delivery}.ts`;
  - `test/alerts/*.spec.ts`, `test/notifications/*.spec.ts`.
- Modify: the kept `push-provider.ts`, fake provider and `notification-attempts.service.ts`.

**Interfaces:**
- Produces:
  - `ClaimForwarder.forward(alertId, action, actor, requestId): Promise<{status: 200|202|409, body}>`;
  - `PushRules.shouldPush(record, receivedAt, isLatest, queue): boolean`;
  - `GatewayOfflineMonitor.tick(now)`.

- [ ] **Step 1:** Write the tests.
  - `who-may check mirrors gateway`: a caregiver `take_over` → 403.
  - `claim answered within 3s returns 200`.
  - `no gateway answer returns 202 provisional and runs timers`.
  - `gateway record wins over provisional on requestedAt`.
  - `push only for cloud channel, under 120s, latest seq, live queue`.
  - `push payload has no names or residentNo`.
  - `resolved sends silent push`.
  - `escalation collapse id esc-alertId`.
  - `gateway_offline at 90s then every 10 min, resolved on heartbeat`.
  - `new account on same installation deletes old endpoint`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(alerts): claim forwarding, provisional timers, cloud push, gateway_offline`.

### Task 12: Bands, provisioning bundles and the assignment mirror (Tue 24 Nov, B1)
Spec §9.

**Files:**
- Create: `src/devices/{bands.controller,bundle.service,identify.service,assignment-mirror.service,assignments.controller,gateway.controller}.ts`, `migrations/tenant/0007-assignments.ts`, `test/devices/*.spec.ts`.
- Modify: `tools/seed/demo.ts` (assign 20 bands via synthetic records); the kept `ownership.service.ts` pattern, moved into the mirror.

**Interfaces:**
- Produces:
  - `AssignmentMirror.apply(record)`;
  - `AssignmentMirror.maxSeq(gatewayId)`;
  - `BundleService.create(bandId)`;
  - the REST routes in spec §9, including the 409 stubs.

- [ ] **Step 1:** Write the tests.
  - `assignment mirror applies any order`.
  - `swap pair applied together and emits band.swapped`.
  - `cloud assign unassign swap 409 assign_via_gateway`.
  - `heartbeat seq ahead triggers resync at most every 5 min`.
  - `url_request assignments grants latest open assignments`.
  - `bundle only for allocated band else 409 band_not_allocated`.
  - `bundle matches contracts sealed-bundle test vector`.
  - `lost republishes bands shadow`.
  - `resident band view never shows bandId to caregiver`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:int && npm run seed:demo`. Expected: PASS; 20 assignments in the mirror.
- [ ] **Step 5:** Commit `feat(devices): bands, provisioning bundles, read-only assignment mirror`.

### Task 13: `/v1` agent outputs and Socket.IO (Wed 25 Nov, B3 outputs + B1 realtime)
Spec §12.

**Files:**
- Create: `src/outputs/{outputs.controller,proposals.controller,traces.controller}.ts`, `src/realtime/{realtime.gateway,rooms,fanout}.ts`, `test/outputs/*.spec.ts`, `test/realtime/*.spec.ts`.
- Modify: the kept `user-socket.registry.ts` and revocation spec.

**Interfaces:**
- Produces:
  - `Fanout.toFacility(tenantId, event, payload)`, `.toStaff(...)`, `.toUser(...)`;
  - the REST routes in spec §12.

- [ ] **Step 1:** Write the tests.
  - `outputs filtered to caller wards`.
  - `proposal approve emits proposal.decided and outbox event`.
  - `band_reassignment approve changes nothing`.
  - `rooms joined server side only`: a client `join` request is ignored.
  - `family socket refused`.
  - `socket dropped on deactivation`.
  - `alert.event emitted on live record not backlog`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(outputs): v1 agent outputs and server-side socket rooms`.

### Task 14: Parquet export (Wed 25 Nov, B3)
Spec §11 (Parquet).

**Files:**
- Create: `src/internal-api/export.job.ts`, `test/internal-api/export.spec.ts`.
- Modify: `package.json` (Parquet writer: use DuckDB's Node API `COPY … TO … (FORMAT parquet)` unless it fails to build on Node 22 in CI; then a maintained pure-JS writer).

**Interfaces:**
- Produces: `ExportJob.run(tenantId, day)`, which writes the tables and columns in contracts `schemas/v1/exports/` to `s3://…/{tenantPrefix}/exports/{day}/`, then the outbox event `export.ready`.

- [ ] **Step 1:** Write the tests.
  - `export columns match contracts exports schema`.
  - `no names and no medication or medical records tables`.
  - `export.ready emitted once per day`.
  - `object key under tenant prefix`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(internal-api): pseudonymised parquet export`.

### Task 15: Seed import of the `sotercare-iit` generator output (Thu 26 Nov, B1)
Spec §13.

**Files:**
- Create: `tools/seed/import-iit.ts`, `test/seed/import-iit.spec.ts`, `test/fixtures/iit-seed-7/` (a small generated sample).

**Interfaces:**
- Consumes: the iit `samples/input/seed-N/` files (spec §6.2 of `sotercare-iit/docs/spec.md`).
- Produces: `npm run seed:import-iit -- --input <dir>`.

- [ ] **Step 1:** Write the tests.
  - `import maps residents staff shifts moves care plans alerts rollups`: the counts equal the CSV row counts.
  - `import is idempotent`.
  - `medication files and notes never imported`.
  - `internal rollups tool returns imported values`: `walkingMin` for R-0007 on day 20 equals the CSV.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Assignments go through synthetic `assignment_record`s into the mirror.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(seed): import sotercare-iit generator output for parity`.

### Task 16: Isolation, response-shape scans and the T2-2 acceptance (Thu 26 – Fri 27 Nov, X2 + B3)
Spec §2, §14.

**Files:**
- Create: `test/isolation/*.spec.ts`, `test/contract/{openapi,asyncapi,shape-scan}.spec.ts`, `docs/acceptance-t2.md`.

- [ ] **Step 1:** Write the tests.
  - `tenant A cannot read tenant B on any route`: iterate every registered REST, internal and WS route with tenant A credentials and tenant B IDs → 403 / 404, and no query on B (spy).
  - `no internal response has a medication field`: a key scan for `medication|dose|drug|prescription` except `medication_counts`.
  - `no medical records item except care_plan_document schema`.
  - `every response matches contracts openapi`.
  - `every published worker message matches asyncapi`.
- [ ] **Step 2:** Run `npm run test:int -- isolation contract`. Expected: FAIL until all routes conform; fix the owning module.
- [ ] **Step 3:** Fix every failure in the module that owns it.
- [ ] **Step 4:** Run the full suite and `18` §9 scenarios 6 (internal API, REST), 21, 41 and 25 (cloud side) on `dev` with the gateway simulator. Expected: green. Write the results to `docs/acceptance-t2.md`.
- [ ] **Step 5:** Commit `test: tenant isolation, response-shape scans, T2-2 acceptance`.
