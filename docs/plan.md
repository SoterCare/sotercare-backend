# sotercare-backend Implementation Plan (full spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is sized for one SerenEdge task; lanes per `b2b-plan/18` §5.1.

**Goal:** Deliver the whole backend:
- **Tasks 0–16 (Part 1):** tenant routing, auth, ingest + alert mirror, the internal API for the agents, `/v1` agent outputs, and the safety core (shadows, local credential, push, claim forwarding, `gateway_offline`, the assignment mirror). Usable on `dev` by 24 Nov (T2-1), accepted by 27 Nov (T2-2).
- **Tasks 17–41 (Parts 2 and 3):** accounts, settings and policy, residents, shifts, medications, Medical records, voice notes, audit / exports / PDPA, metrics, the family API and live view, ARIA, the rest of the agent plumbing, billing and suspension, the ops API and support access. Dated to the B2 / B3 / B1 lane columns of `b2b-plan/18` §5.1 (22–28 Nov); ARIA endpoints in the INT week (30 Nov – 4 Dec, `18` §5.1).
- **Tasks 42–47 (Part 4, added 20 Nov):** synthetic history (`tools/synth`), the ops routes for contracts 1.2.0 (G1–G8), load-test support and the legacy contracts cleanup.

**Architecture:** A NestJS 11 modular monolith with two entry points (`api`, `worker`). There's one PostgreSQL database per tenant behind a `TenantRegistry`, plus a control DB. The tenant comes only from the token issuer, the gateway registry or the service token. Gateway records arrive by SQS and are acked after commit. Domain events leave through a transactional outbox.

**Tech Stack:** Node 22, TypeScript 5, NestJS 11, TypeORM 0.3, PostgreSQL 16, Redis 7 + BullMQ, Socket.IO 4, `jose`, AWS SDK v3 (SQS, SNS, SES, S3, IoT data plane, IoT, Cognito IdP, Step Functions, Transcribe, Cost Explorer, CloudWatch), `@sotercare/contracts`, `pdfmake`, `sharp`, Jest, docker compose (from `sotercare-infra/local`).

**Spec:** rev 2 in three parts: [`spec.md`](spec.md) (§1–§15), [`spec-part2-people-and-care.md`](spec-part2-people-and-care.md) (§16–§25), [`spec-part3-family-ai-money-ops.md`](spec-part3-family-ai-money-ops.md) (§26–§35). Read the sections each task names.

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
- **Parts 2 and 3:**
  - family endpoints check the resident link **on every request**; no family response carries staff names, `residentNo`, `bandId`, notes, medications (except the opt-in on-time %), Medical records or open alerts;
  - **family ARIA chats have exactly one read path** (the family member's own history) and are audited as metadata only (D-113);
  - medication data never reaches push text, agents (except `medication_counts`), Parquet, domain events, the gateway or logs; every agent write is checked for the tenant's medication names (spec §21.8);
  - Medical records reach agents only as `care_plan_document`; files are served only when `scanStatus clean`, by presigned GET ≤ 15 min;
  - 402 `tenant_suspended` only on the routes in spec §30.5 (one decorator); everything else keeps working while suspended;
  - money in minor units, one currency per invoice, no conversion; webhooks idempotent and forward-only; the tenant comes from the invoice;
  - ops actions under the two-person rule return 202 `approval`; ops never read health data outside a support session.
- **Commits have no `Co-Authored-By` or AI-attribution lines. Never force-push.**

## Review Focus
1. **Gateway re-sends the same record after a lost ack.** Expected: `duplicate` ack, no second alert event or push. Test: `ingest duplicate recordId acks duplicate and pushes nothing` (Task 5).
2. **Records arriving out of order** (seq 3 before seq 2; assignment `ended` before `started`). Expected: the mirror ends at the highest `seq` / `assignmentSeq`. Tests: `alert mirror keeps highest seq` (Task 5), `assignment mirror applies any order` (Task 12).
3. **A pool's JWKS can't be reached** (Cognito blip). Expected: cached keys keep working; an unknown `kid` → 401, never 500. Test: `guard uses cached jwks when fetch fails` (Task 3).
4. **The worker crashes between commit and ack.** Expected: no ack sent; the redelivered message acks `duplicate`. Test: `crash after commit before ack redelivers as duplicate` (Task 5).
5. **The service token is for tenant A, and the path holds a tenant B resident ID.** Expected: 403, and no query on tenant B's DB. Test: `internal guard refuses out-of-scope resident without touching other tenant` (Task 6).
6. **An offline phone replays a dose mark after someone else marked the dose.** Expected: the replay with the same `Idempotency-Key` gets its stored answer; a different mark → 409 `dose_already_marked` with who and when; no double entry in the MAR. Test: `offline mark replay is idempotent and second mark conflicts` (Task 26).
7. **A family member is unlinked while their phone is watching the Live now card.** Expected: removed from the room at once (no further `family.live`), next REST call 403. Test: `unlink removes family socket from live room immediately` (Task 31).
8. **PayHere sends `succeeded`, then a late `pending`, then the same `succeeded` again.** Expected: one payment `succeeded`, the invoice paid once, the tenant restored once. Test: `webhook out of order and duplicate leaves state correct` (Task 35, scenario 23).
9. **A suspended tenant's manager publishes shifts and deactivates a carer.** Expected: both work; the `roster` and `keys` shadows go out; the agents' calls get 402. Test: `suspended tenant edits still reach the gateway` (Task 36, scenario 24).
10. **A discharge while a family account is linked and the request omits that account.** Expected: 422 `family_access_choice_required` naming it; nothing changes. Test: `discharge requires a choice per linked family account` (Task 21).

---

### Task 0: Import the old code with history and restructure (Thu 19 Nov, B1)
Spec §3 (History), §5, §15.6.

**Files:**
- Delete:
  - `apps/ai-summary-service`, `contracts` (both removed by filter-repo);
  - `apps/back-end`, `apps/api-gateway/src/nurse`, `apps/api-gateway/src/realtime/alert-writer*`;
  - `3days-sample.json`, `dist/`, `Dockerfile`, `start.sh`, `docker-compose.yml` (the Koyeb version).
- Move: `apps/api-gateway/src/**` → `src/<module>/` per spec §5; keep `test/support/*`, `migrations` pattern, `scripts/ws-*.cjs`.
- Create: `package.json` (one app), `tsconfig.json`, `nest-cli.json`, `src/main.api.ts`, `src/main.worker.ts`, `docker-compose.yml` that `include`s `../sotercare-infra/local/compose.yaml` (Postgres 16, Redis 7, LocalStack queues and buckets: one source, infra plan Task 1; queue names `sc-local-*`), `.env.example` (copied from infra's `.env.local.example`), `.github/workflows/ci.yml`.

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

### Task 1: Core: config, clock, context, errors, idempotency, logging (Fri 20 Nov, B1)
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
  - `service shadow carries gatewayRole per gateway thing`: the active unit gets `active`, any other enrolled unit `standby` (contracts C-29).
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
  - `ws ticket is single use expires in 60 s and joins the same rooms` (contracts C-33).
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

---

## Part 2: people and care (Tasks 17–30)

### Task 17: Staff accounts, org admins, MFA gate, login type (Sun 22 Nov, B2)
Spec §16.1–§16.3.

**Files:**
- Create: `src/accounts/{accounts.module,staff.controller,staff.service,cognito-admin.client,username.rules,mfa.guard,login-type.guard,org-admin.service}.ts`, `migrations/tenant/*-users-accounts.ts`, `migrations/control/*-org-memberships.ts`, `test/accounts/*.spec.ts`.

**Interfaces:**
- Consumes: `TenantContext`, the Cognito guard (Task 3), `ShadowPublisher.request('roster'|'keys')` (Task 10), `RevocationRegistry` (Task 13), `PushService.deleteEndpointsFor(userId)` (Task 11).
- Produces: `StaffService.create(input) -> {account, loginSlip}`, `.update`, `.resetPassword -> loginSlip`, `.resetMfa`, `.deactivate`; a `CognitoAdmin` interface (+ `FakeCognitoAdmin`); `@LoginType('staff'|'family')`, `MfaGuard`; `OrgAdminGuard` handling `X-Facility-Id`.

- [ ] **Step 1:** Write the tests.
  - `create staff returns login slip once and stores no password`.
  - `username denylist and pattern refused`: `admin`, `Anna`, `a` → 422.
  - `rename keeps userId and history`.
  - `deactivate signs out, deletes endpoints, drops sockets, revokes jti, republishes roster and keys`.
  - `cannot deactivate or demote last active manager` → 409 `last_manager`.
  - `manager without mfa gets 403 mfa_required except on me`.
  - `login type mismatch on me` → 403 `login_type_mismatch`.
  - `org admin acts only on facilities of own organisation`: another org's facility → 403; the audit row names `name@primary (org admin)`.
  - `facility manager cannot touch org admin accounts` → 403.
- [ ] **Step 2:** Run `npx jest test/accounts`. Expected: FAIL.
- [ ] **Step 3:** Implement per §16; the temporary password uses `crypto.randomInt` over an unambiguous alphabet.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): staff accounts, org admins, MFA gate and login type`.

### Task 18: Family accounts, links and `/me` notices (Sun 22 Nov, B2)
Spec §16.4–§16.5.

**Files:**
- Create: `src/accounts/{family-accounts.controller,family-accounts.service,family-links.job}.ts`, `src/auth/me.notices.ts`, `test/accounts/family*.spec.ts`.

**Interfaces:**
- Produces: `FamilyLinks.unlink(userId, residentId, mode)`, `.deactivateAccount(userId)`, `.activeLink(userId, residentId) -> Link | null` (Task 31); the event `family.link_changed {userId, residentId}` on the tenant Redis channel.

- [ ] **Step 1:** Write the tests: `family create links residents and never issues local credential`, `unlink read_only freezes with removeAt from setting`, `unlink now removes and deactivates when no active link left`, `account linked to another active resident keeps that access`, `nightly job removes frozen links at removeAt`, `password reset notice shown once on me`.
  - `me gateway includes staffSsids from devices_network setting` (contracts C-32); `family account email and weeklyEmailOptIn stored and returned` (C-31).
- [ ] **Step 2:** Run `npx jest test/accounts/family`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): family accounts with per-person links and notices`.

### Task 19: Station PIN and readiness (Mon 23 Nov, B2; cross-cutting row 24 Nov)
Spec §17.

**Files:**
- Create: `src/accounts/{station-pin.service,readiness.controller}.ts`, `test/accounts/pin.spec.ts`, `test/fixtures/pin-vector.json` (shared with the gateway lane).

- [ ] **Step 1:** Write the tests: `pin hash matches shared vector` (`"u_…:4821"`, the salt, 100,000 iterations → the vector's `hashB64`), `weak pins refused`, `set pin republishes roster`, `manager clears pin and it is audited`, `readiness stored per installation and shown on staff account`.
- [ ] **Step 2:** Run `npx jest test/accounts/pin`. Expected: FAIL.
- [ ] **Step 3:** Implement with `crypto.pbkdf2`; send the vector to G3 (the station's PIN check).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(accounts): station PIN hashing and readiness`.

### Task 20: Facility settings groups and side effects (Sun 22 Nov, B2)
Spec §18.1.

**Files:**
- Create: `src/settings/{settings.module,settings.controller,settings.service,side-effects}.ts`, `migrations/tenant/*-facility-settings.ts`, `test/settings/*.spec.ts`.

**Interfaces:**
- Produces: `Settings.get(group)`, `Settings.patch(group, patch, actor, via)`; emits `tenant.settings_changed`; calls `ShadowPublisher` and the schedulers' `reschedule(tenantId)`.

- [ ] **Step 1:** Write the tests: `each group validates against its schema`, `wifi change bumps wifiGen in bands shadow`, `lte failover goes to service shadow`, `shift margin goes to roster`, `family_app and agents changes emit tenant.settings_changed`, `time zone change requires policy`, `every field change writes setting_change and audit`.
  - `devices_network staffSsids reaches me.gateway` (C-32).
- [ ] **Step 2:** Run `npx jest test/settings`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(settings): facility settings groups with gateway and agent side effects`.

### Task 21: Layout, residents, alert settings, Pause, transfer, discharge, legal hold, consent (Mon 23 Nov, B2)
Spec §19.

**Files:**
- Create: `src/org/{layout.controller,residents.controller,residents.service,alert-settings.service,discharge.service,setting-revert.job}.ts`, `migrations/tenant/*-residents-admin.ts`, `test/org/*.spec.ts`.

**Interfaces:**
- Consumes: `FamilyLinks` (Task 18), the alert mirror (Task 5), `ShadowPublisher`, `DomainEvents.emit`.
- Produces: `Residents.admit(input)` (allocates `residentNo`), `.transfer`, `.pause`, `.discharge`; `AlertSettings.patch(residentId, patch, actor, via)` (Task 33's `care_routine_change`).

- [ ] **Step 1:** Write the tests.
  - `residentNo allocated in sequence and never reused`.
  - `critical off needs manager and reason`: ward head → 403; manager without reason → 422 `reason_required`.
  - `until revert job writes system_revert and is cancelled by a newer change`.
  - `transfer emits resident.moved and republishes residents`.
  - `discharge blocked by open sensor alert` → 409.
  - `discharge requires a choice per linked family account` → 422 naming the user; nothing changes.
  - `discharge applies read_only and deactivate_now per account and emits resident.left`.
  - `legal hold blocks erasure`; `consent trainingUse goes to residents shadow`.
- [ ] **Step 2:** Run `npx jest test/org`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenarios 5 and 16 (backend side) with gw-sim.
- [ ] **Step 5:** Commit `feat(org): residents admin, alert settings, pause, transfer, discharge, legal hold, consent`.

### Task 22: Alert policy versions and sign-off (Mon 23 Nov, B2; CP5)
Spec §18.2.

**Files:**
- Create: `src/settings/{alert-policy.controller,alert-policy.service,policy-limits}.ts`, `test/settings/policy*.spec.ts`.

- [ ] **Step 1:** Write the tests: `version 0 active from provisioning`, `draft outside each safety limit refused with path` (one case per limit row of contracts §7.8, plus `arrivalReminderS >= stepInS`), `sign off needs manager with mfa`, `sign off supersedes old and republishes policy shadow`, `discard only drafts`, `gateway applied version shown from shadow report`.
- [ ] **Step 2:** Run `npx jest test/settings/policy`. Expected: FAIL.
- [ ] **Step 3:** Implement; the limits come from the contracts schema bounds plus the cross-field rule.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(settings): alert policy drafts, safety limits and sign-off`.

### Task 23: Shift administration, publishing and coverage (Mon 23 Nov, B1)
Spec §20.1–§20.2.

**Files:**
- Create: `src/shifts/{shifts.module,templates.controller,patterns.service,shifts.controller,shifts.service,on-shift,coverage.service}.ts`, `migrations/tenant/*-shifts-admin.ts`, `test/shifts/*.spec.ts`.

**Interfaces:**
- Produces: `OnShift.at(t, {wardId?}) -> userId[]` (Tasks 24, 27, 33), `Shifts.publish(from, to, wardIds)`.

- [ ] **Step 1:** Write the tests: `template becomes utc per date incl dst day` (`Europe/London` change day → a 9 h shift), `overnight shift belongs to start date`, `patterns generate drafts 4 weeks ahead and drafts never count`, `publish notifies affected staff and republishes roster`, `cancel published emits shift.cancelled`, `overlapping wards allowed with warning`, `coverage gap emits coverage.gap`, `on shift uses margin`.
- [ ] **Step 2:** Run `npx jest test/shifts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(shifts): templates, patterns, publishing, coverage and on-shift`.

### Task 24: Availability, shift schedulers and notifications (Tue 24 Nov, B1)
Spec §20.3–§20.6.

**Files:**
- Create: `src/shifts/{availability.service,shift-scheduler,roster-gap.job}.ts`, `src/notifications/{inbox.controller,notify.service,notification-settings}.ts`, `test/shifts/schedulers.spec.ts`, `test/notifications/*.spec.ts`.

**Interfaces:**
- Produces: `Notify.send(userIds, type, textArgs, ref)` (inbox + WS + `push_notification`, never family), used by every later task.

- [ ] **Step 1:** Write the tests: `availability only during shift and purged after 48h`, `on_site from connectivity_record`, `shift reminder 60 min before`, `shift.starting and shift.ending events at the right times in Asia/Colombo`, `alert_setup_needed when readiness incomplete`, `roster_gap to managers before and at an uncovered period`, `notification never goes to a family account`, `family login cannot register push token`.
- [ ] **Step 2:** Run `npx jest test/shifts/schedulers test/notifications`. Expected: FAIL.
- [ ] **Step 3:** Implement with BullMQ delayed jobs keyed `{kind}:{shiftId}`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: availability, shift schedulers and the notification service`.

### Task 25: Medical records (Tue 24 Nov, B2; CP5)
Spec §22.

**Files:**
- Create: `src/records/{records.module,records.controller,records.service,upload-grant,scan-results.consumer,thumbnails,expire.job}.ts`, `migrations/tenant/*-medical-records.ts`, `test/records/*.spec.ts`.

**Interfaces:**
- Produces: `MedicalRecords.getRecommendation(residentId, medicalRecordId) -> {ok, ref} | {error}` (Task 26); the internal `care_plan_document` reads (Task 7) move to this module.

- [ ] **Step 1:** Write the tests: `reference and text are clean at once`, `picture grant signs content type checksum and tenant key`, `complete rejects size or checksum mismatch`, `scan clean serves file and makes thumbnail`, `scan infected quarantines and notifies uploader`, `no scan result after 30 min is scan_failed`, `incomplete version discarded after 24h`, `care_plan clean emits document.uploaded and other categories emit nothing`, `moving linked recommendation is 409 medical_record_linked`, `family gets 403`, `works while suspended`, `internal api returns only care_plan items` (one item per category seeded).
- [ ] **Step 2:** Run `npx jest test/records`. Expected: FAIL.
- [ ] **Step 3:** Implement; the scan consumer reads `sc-{env}-scan-results` (locally a test publisher writes GuardDuty-shaped events).
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenario 31 (backend side).
- [ ] **Step 5:** Commit `feat(records): Medical records tab with presigned uploads, scanning and versions`.

### Task 26: Medications: records, log, doses, marking (Tue 24 Nov, B2; CP5)
Spec §21.1–§21.3, §21.5, §21.7.

**Files:**
- Create: `src/medications/{medications.module,medications.controller,medications.service,log.repo,dose-generator,doses.controller,marking.service}.ts`, `migrations/tenant/*-medications.ts` (the log table `INSERT`-only for the app user), `test/medications/*.spec.ts`.

**Interfaces:**
- Consumes: `MedicalRecords.getRecommendation` (Task 25), `OnShift` (Task 23).
- Produces: `DoseGenerator.run(tenantId, now)`, `Marking.mark(doseId, body, idemKey, actor)`, `.undo`, `.prn`; WS `dose.updated`.

- [ ] **Step 1:** Write the tests.
  - `create needs doctorRecommendationId` → 422 `doctor_recommendation_required`; `other resident or wrong category or not clean` → 422 `doctor_recommendation_invalid` with the reason.
  - `dose or schedule change needs new recommendation version` → 422 `new_recommendation_needed`; an instructions-only edit keeps the link.
  - `every change writes log in same transaction` (a forced failure after the log insert rolls back both).
  - `doses generated 48h ahead and schedule edit replaces only future due`.
  - `every_n_days counts from anchorDate`; `paused resident gives resident_away`.
  - `offline mark replay is idempotent and second mark conflicts`.
  - `held needs heldReason`; `correction on not_recorded needs senior role and reason`.
  - `undo within 10 min by marker`, `caregiver after 10 min is undo_window_passed`, `senior undo needs reason`.
  - `prn returns lastGivenAt and never blocks`.
  - `dose.updated carries ids and status only`.
- [ ] **Step 2:** Run `npx jest test/medications`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenario 30 (saved with a recommendation, refused without).
- [ ] **Step 5:** Commit `feat(medications): records with recommendation link, log, doses and marking`.

### Task 27: Medication rounds, reminders, offline schedule and MAR (Wed 25 – Thu 26 Nov, B2)
Spec §21.4, §21.6.

**Files:**
- Create: `src/medications/{rounds.service,reminders.scheduler,my-schedule.controller,mar.controller,mar.pdf}.ts`, `test/medications/{rounds,reminders,mar}.spec.ts`.

- [ ] **Step 1:** Write the tests: `doses in one window form one round per ward`, `round_due at due minus lead to on-shift ward staff or everyone`, `overdue adds ward head and replaces round_due collapse id`, `not_recorded at due plus 2h`, `push text has ward and count only`, `fully marked round sends nothing more`, `my schedule returns 24h of reminded wards`, `mar json has no per caregiver figure`, `mar pdf is a presigned redirect and audited`.
- [ ] **Step 2:** Run `npx jest test/medications/rounds test/medications/reminders test/medications/mar`. Expected: FAIL.
- [ ] **Step 3:** Implement (`pdfmake`, A4 landscape).
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenario 26 (backend side).
- [ ] **Step 5:** Commit `feat(medications): rounds, reminders, offline schedule and MAR`.

### Task 28: Medication boundary for agents (Wed 25 Nov, B3)
Spec §21.8.

**Files:**
- Create: `src/internal-api/{medication-counts.controller,medication-name.check}.ts`, `test/internal-api/medication*.spec.ts`.

- [ ] **Step 1:** Write the tests: `medication counts has integers and ids only`, `coordinator only` (other agents → 403), `agent output naming a tenant medication is refused` (422 `validation_failed`, `details.reason medication_name`), `generic dose pattern refused` ("500 mg", "twice daily"), `word boundary avoids false match` (a medication "Iron" vs the word "ironing").
- [ ] **Step 2:** Run `npx jest test/internal-api/medication`. Expected: FAIL.
- [ ] **Step 3:** Implement; the check runs in the internal write controllers (outputs, proposals, ARIA messages).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(internal-api): medication counts tool and medication-name check on agent writes`.

### Task 29: Voice notes (Thu 26 Nov, B2)
Spec §23.

**Files:**
- Create: `src/alerts/{voice-notes.controller,transcribe.job}.ts`, `test/alerts/voice-notes.spec.ts`.

- [ ] **Step 1:** Write the tests: `grant limits type size and length`, `transcript stored for english`, `unsupported language or low confidence is not transcribed`, `family cannot fetch voice note`.
- [ ] **Step 2:** Run `npx jest test/alerts/voice-notes`. Expected: FAIL.
- [ ] **Step 3:** Implement behind a `Transcriber` interface (`TranscribeTranscriber`, `FakeTranscriber`).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(alerts): voice notes with transcription`.

### Task 30: Audit, exports, data requests, erasure and retention (Thu 26 Nov, B2)
Spec §24.

**Files:**
- Create: `src/privacy/{audit.controller,exports.service,exports.worker,data-requests.controller,erasure.job,retention.job}.ts`, `test/privacy/*.spec.ts`.

- [ ] **Step 1:** Write the tests: `audit is insert only for app user`, `family aria audit row has length but no text`, `exports never include family aria content` (seed a family chat; unzip every export kind; search for the text), `data request due in 30 days and mirrored to control db`, `erasure deletes listed data and pseudonymises kept alert records`, `legal hold blocks erasure and retention`, `retention job applies every row of the table`.
- [ ] **Step 2:** Run `npx jest test/privacy`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(privacy): audit view, exports, data requests, erasure and retention`.

## Part 3: family, AI, money and ops (Tasks 31–41)

### Task 31: Family API, `FamilyFacts` and the Live now feed (Tue 24 – Wed 25 Nov, B2; CP6)
Spec §26.

**Files:**
- Create: `src/family/{family.module,family.controller,family-scope.guard,family-facts.service,dashboard.builder,family-live.service,family-watch.gateway}.ts`, `src/internal-api/family-facts.controller.ts`, `test/family/*.spec.ts`.

**Interfaces:**
- Consumes: `FamilyLinks.activeLink` (Task 18), rollups (Task 5), the alert mirror, settings (`family_app`, `medication`).
- Produces: `FamilyFacts.week(residentId, weekStart)`, `FamilyLive.onTelemetry / onAlertRecord`, WS `family.live`.

- [ ] **Step 1:** Write the tests.
  - `family endpoints check link on every request` (frozen → read-only to `frozenAsOf`; none → 403).
  - `family responses never carry forbidden fields` (a schema scan for staff names, `residentNo`, `bandId`, notes, medications, open alerts).
  - `false alarm shown as checked_no_issue and rates count real only`.
  - `response time median null under 3 and inferred arrivals excluded`.
  - `days under 50 percent wear are not_worn and paused days are away`.
  - `switched off card is absent and its endpoint 403 feature_disabled`.
  - `family facts numbers match hand computed fixture`.
  - `live status mapping and resting after 10 min`.
  - `live updates at most every 10 s and within 15 s of the record`.
  - `unlink removes family socket from live room immediately`.
  - `suspended tenant live state suspended and watch refused`.
- [ ] **Step 2:** Run `npx jest test/family`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenarios 7 and 32 (backend side).
- [ ] **Step 5:** Commit `feat(family): family API, facts and the Live now feed`.

### Task 32: Live view, `resident.status`, trends and metrics (Wed 25 Nov, B1)
Spec §25.

**Files:**
- Create: `src/live/{live.controller,resident-status.service}.ts`, `src/metrics/{metrics.controller,metrics.views.sql,trends.controller}.ts`, `test/metrics/*.spec.ts`.

- [ ] **Step 1:** Write the tests: `resident.status never carries bandId and is throttled to 10 s`, `live returns residents open alerts gateway and on shift`, `time to arrival excludes inferred arrivals`, `false alarm rate per bed per week`, `caregiver groupBy is managers only`.
- [ ] **Step 2:** Run `npx jest test/metrics`. Expected: FAIL.
- [ ] **Step 3:** Implement (SQL views, 5-min cache).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: live view, resident status, trends and metrics`.

### Task 33: Agent plumbing: cover requests, proposals, schedules, visibility, AI budget (Wed 25 Nov, B3)
Spec §29.

**Files:**
- Create: `src/outputs/{cover-requests.service,staff-keys,proposal-apply,incident-escalation.job,visibility,ai-budget.service}.ts`, extend `src/internal-api/schedule-emitter.ts` (Task 9), `test/outputs/*.spec.ts`.

- [ ] **Step 1:** Write the tests: `staff key resolves to active care staff only`, `cover request notifies candidates and expires`, `answer emits cover_request.replied`, one `approve applies <type>` test per proposal type (and `band_reassignment applies nothing`), `incident confirm at reviewer shift end and escalates to ward head at 24h`, `full schedule set fires at facility times and stops when suspended or switched off`, `family weekly brief visible to families only from publishAt`, `ai budget states at 80 100 150 percent`.
- [ ] **Step 2:** Run `npx jest test/outputs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenario 19 (schedules + degraded outputs, with the iit lane).
- [ ] **Step 5:** Commit `feat(outputs): cover requests, proposal application, schedules and AI budget`.

### Task 34: Billing core: bed-days, invoices, PDF, e-mail (Thu 26 Nov, B3)
Spec §30.1–§30.2, §30.7.

**Files:**
- Create: `src/billing/{billing.module,bed-days.job,invoices.service,invoice.pdf,billing.controller,mailer}.ts`, `migrations/control/*-billing.ts`, `test/billing/{bed-days,invoices}.spec.ts`.

- [ ] **Step 1:** Write the tests: `bed day counts distinct residents capped at beds` (a swap counts once; a discharge + admission in one bed on one day counts once; paused counts), `late record recomputes an open month and flags an issued one`, `invoice amount sums daily price over days in month and rounds once`, `currency fixed per invoice`, `pdf to billing bucket and presigned`, `emails sent for issued reminder overdue suspended restored`.
- [ ] **Step 2:** Run `npx jest test/billing/bed-days test/billing/invoices`. Expected: FAIL.
- [ ] **Step 3:** Implement (SES behind a `Mailer` interface with a fake).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(billing): bed-days, invoices, PDFs and billing e-mail`.

### Task 35: PayHere provider and payments (Thu 26 Nov, B3; scenario 23)
Spec §30.3.

**Files:**
- Create: `src/billing/{payment-provider,payhere.provider,fake.provider,webhook.controller,payments.service,status-poll.job}.ts`, `test/billing/payhere.spec.ts`.

- [ ] **Step 1:** Write the tests: `checkout hash matches PayHere test vector`, `webhook md5sig verified and wrong amount or currency rejected`, `tenant taken from invoice not webhook`, `webhook out of order and duplicate leaves state correct`, `no webhook after 15 min queries status`, `autopay retries day 3 and due date`, `partial payment keeps invoice open with balance`, `bank transfer report holds suspension 3 days`.
- [ ] **Step 2:** Run `npx jest test/billing/payhere`. Expected: FAIL.
- [ ] **Step 3:** Implement; the merchant secret from Secrets Manager (local: the fake provider only).
- [ ] **Step 4:** Run the same command. Expected: PASS. PayHere sandbox payment + recurring on `dev` (CP7).
- [ ] **Step 5:** Commit `feat(billing): PayHere checkout, recurring, webhooks and payments`.

### Task 36: Suspension state machine and restore (Thu 26 Nov, B3; scenarios 8, 24; CP7)
Spec §30.4–§30.6.

**Files:**
- Create: `src/billing/{billing-state.job,stops-when-suspended.decorator,restore.service}.ts`, `test/billing/suspension.spec.ts`.

- [ ] **Step 1:** Write the tests: `state machine with fake clock` (due − 3, due, +1…+7, +8 00:00 facility time), `hold and override delay suspension`, `402 only on the listed routes` (enumerate decorated routes vs spec §30.5), `ingest stores only alert and assignment records while suspended`, `suspended tenant edits still reach the gateway`, `restore notifies with restored from and dropped counts after backlog drains`.
- [ ] **Step 2:** Run `npx jest test/billing/suspension`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenario 8 clock-shifted on `dev` with gw-sim.
- [ ] **Step 5:** Commit `feat(billing): non-payment timeline, suspension effects and restore`.

### Task 37: Ops: tenants, provisioning, approvals, onboarding, organisations, recovery (Sun 22 – Thu 26 Nov, B3)
Spec §31.1–§31.4, §31.6.

**Files:**
- Create: `src/ops/{ops.module,ops-auth.guard,approvals.service,tenants.controller,provisioning.starter,onboarding.service,organisations.controller,account-recovery.service,platform-audit}.ts`, `test/ops/*.spec.ts`.

- [ ] **Step 1:** Write the tests: `tenant tokens refused on ops routes`, `two person rule` (same user → 403 `approval_required`; expires after 24 h), `create tenant starts workflow in staging mode and provisioning service in dev mode` (a `ProvisioningStarter` interface), `job polling returns first manager slip once`, `onboarding auto steps set by events`, `go live sets active and billing start`, `org admin created in primary pool with mfa required`, `account recovery runs after approval and shows notice 7 days`.
- [ ] **Step 2:** Run `npx jest test/ops`. Expected: FAIL.
- [ ] **Step 3:** Implement; `POST /tenants` first (22 Nov, so O1 can create a tenant), the rest by 26 Nov.
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenarios 9 (onboarding to go-live) and 20 (provisioning failure, with infra).
- [ ] **Step 5:** Commit `feat(ops): tenants, provisioning, approvals, onboarding, organisations, recovery`.

### Task 38: Ops: fleet, stock, enrolment hook, active gateway, restore-db, billing ops (Thu 26 Nov, B3 + B1)
Spec §31.2 (restore-db, active gateway), §31.5, §31.7 (fleet).

**Files:**
- Create: `src/ops/{gateways.controller,bands-stock.controller,active-gateway.service,restore-db.service,billing-ops.controller}.ts`, `src/lambdas/fp-hook.ts` (+ a `build:fp-hook` zip script), `test/ops/{fleet,restore,billing-ops}.spec.ts`.

- [ ] **Step 1:** Write the tests: `enrolment code 8 crockford chars 24h and gateway_bound`, `fp hook refuses serial mismatch and other tenant and stores wrap key`, `band import stores factory keys encrypted`, `allocate move return`, `active gateway rewraps every band key and rewrites service and bands shadows`, `restore db sets maintenance repoints clears and sends resync`, `credit note refund dispute void override`.
- [ ] **Step 2:** Run `npx jest test/ops/fleet test/ops/restore test/ops/billing-ops`. Expected: FAIL.
- [ ] **Step 3:** Implement; the release workflow publishes the hook zip to `sc-{env}-artifacts/lambdas/` (infra Task 13).
- [ ] **Step 4:** Run the same command. Expected: PASS. Restore-drill support for scenario 28 (with I2).
- [ ] **Step 5:** Commit `feat(ops): fleet, band stock, enrolment hook, active gateway, restore and billing ops`.

### Task 39: Ops: rollouts, usage, health, announcements; support access (Thu 26 – Fri 27 Nov, B3)
Spec §31.7 (rollouts), §31.8, §32.

**Files:**
- Create: `src/ops/{rollouts.service,rollout-guard.job,usage.service,health.service,announcements.controller}.ts`, `src/support/{support-grants.controller,support-session.service,support.guard}.ts`, `test/ops/{rollouts,usage}.spec.ts`, `test/support/*.spec.ts`.

- [ ] **Step 1:** Write the tests: `rollout stages create jobs on stage groups`, `auto pause on failure offline or false alarm rise`, `usage combines tagged cost and ai usage`, `announcement reaches facility rooms`, `support session only inside grant`, `support token is get only and never reads aria history`, `every support call audited in tenant`.
- [ ] **Step 2:** Run `npx jest test/ops/rollouts test/ops/usage test/support`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenario 27 (backend side, with G1 / F2).
- [ ] **Step 5:** Commit `feat(ops): rollouts with auto-pause, usage, health, announcements and support access`.

### Task 40: ARIA endpoints and the family weekly e-mail (INT: Mon 30 Nov – Tue 1 Dec, B3)
Spec §27, §28.

**Files:**
- Create: `src/aria/{aria.module,aria.controller,family-aria.controller,aria.service,aria-limits,agents.client}.ts`, `src/internal-api/aria-messages.controller.ts`, `src/family/weekly-email.service.ts`, `test/aria/*.spec.ts`.

- [ ] **Step 1:** Write the tests: `limits 30 family and 200 staff per day`, `family switch off is feature_disabled`, `suspended is 402`, `budget over 150 answers unavailable without calling agents`, `family answers never streamed`, `staff stream relays events and ends with checked answer`, `family token has exactly one resident`, `history returns only own chats and no staff route reads family chats`, `family aria audit metadata only`, `weekly email only with both switches and stops on bounce`.
- [ ] **Step 2:** Run `npx jest test/aria`. Expected: FAIL.
- [ ] **Step 3:** Implement against the contracts `agents.yaml` mock until the agents service is live (INT).
- [ ] **Step 4:** Run the same command. Expected: PASS. Scenario 17 (backend side) with the iit adapter in INT.
- [ ] **Step 5:** Commit `feat(aria): staff and family ARIA endpoints, limits, privacy and the weekly e-mail`.

### Task 41: Isolation and acceptance for Parts 2 and 3 (Fri 27 – Sat 28 Nov, X2 + B2 + B3)
Spec §33.

**Files:**
- Modify: `test/isolation/*.spec.ts` (every new route), `test/contract/shape-scan.spec.ts` (family, medication and records scans); create `docs/acceptance-parts-2-3.md`.

- [ ] **Step 1:** Extend the tests: every route added in Tasks 17–40 (and their WS events) in the isolation suite (tenant A credentials on tenant B IDs → 403 / 404, no B query), `support token for tenant A on tenant B refused`, the family forbidden-field scan over every family schema, and the D-113 scan (no family chat text reachable from any staff, ops, audit or export path).
- [ ] **Step 2:** Run `npm run test:int -- isolation contract`. Expected: FAIL until every route conforms.
- [ ] **Step 3:** Fix in the owning module.
- [ ] **Step 4:** Run the full suite and the backend side of `18` §9 scenarios 3, 4, 5, 7, 8, 9, 12, 13, 16, 17, 19, 20, 22, 23, 24, 26, 28, 30, 31, 32, 33 on `staging`. Record the results in `docs/acceptance-parts-2-3.md`; anything failing is filed and, if safety, carried over in `b2b-plan/19`.
- [ ] **Step 5:** Commit `test: isolation and acceptance for parts 2 and 3`.

---

## Part 4: gap tasks (Tasks 42–47, added 20 Nov)
Tasks the first plan missed: the synthetic-history stand-in (`b2b-plan/18` §4, §7), the ops endpoints the ops console needs from contracts 1.2.0, the backend side of the CP8 load test, and the legacy contracts copy left by the cut-over. SerenEdge keys: Task 42 = SCBE-43 … Task 47 = SCBE-48 (Task n = SCBE-(n+1), as for Tasks 0–41).

### Task 42: Synthetic history tool `tools/synth` (Sun 22 Nov, B2)
Spec §13 (seed), §8 (ingest, rollups); `b2b-plan/18` §4 (stand-in "Synthetic history (30 days; Parquet export)", ready 22 Nov) and §7.

**Files:**
- Create: `tools/synth/{index,generators,rng}.ts`, `test/synth/*.spec.ts`, `test/fixtures/synth/ranges.json` (expected value ranges).
- Modify: `package.json` (script `synth` only, no new dependency), `README.md` (one line: run after `seed:demo`).

**Interfaces:**
- Consumes: `seed:demo` (Task 4: residents, bands, staff, shifts), `RecordRouter.handle(msg, "backlog")`, `AlertMirror`, `RollupJob` (Task 5), the injected `Clock`.
- Produces: `npm run synth -- --tenant demo --days 30 --seed 7`: 30 days ending at today (`Asia/Colombo`) of hourly telemetry rollups, band and gateway status, alerts with verdicts (`real` / `checked_no_issue`) and moisture episodes (built as contracts `alert_record`s through the mirror on the `backlog` queue, so nothing pushes), and shift history. Stable uuid v5 IDs from `(seed, tenant, kind, index)`; a small seeded PRNG (`mulberry32`) in `rng.ts`.

- [ ] **Step 1:** Write the tests.
  - `same seed same rows`: two runs with seed 7 give identical rows; seed 8 differs.
  - `synth rerun is idempotent`: row counts unchanged.
  - `synth alerts never push or emit`: no push, no `alert.event`, no outbox row.
  - `synth values inside fixture ranges`: false-alarm rate, response times, walking minutes inside `ranges.json` (charts are never flat or absurd).
  - `synth refuses staging and prod`: exits before any DB connection; any tenant other than `demo` needs `--allow-tenant` (local / dev only).
  - `synth writes no names notes or free text`.
- [ ] **Step 2:** Run `npm run test:int -- synth`. Expected: FAIL.
- [ ] **Step 3:** Implement. Synthetic only: residents and staff come from `seed:demo`; no text fields are generated.
- [ ] **Step 4:** Run `npm run test:int -- synth && npm run seed:demo && npm run synth -- --tenant demo --days 30 --seed 7`. Expected: PASS; console charts and the family dashboard have 30 days of data (CP3 / CP6).
- [ ] **Step 5:** Commit `SCBE-43: synthetic 30-day history for tenant demo`.

### Task 43: Synthetic history: medication marks and Parquet export (Wed 25 Nov, B2; CP6)
Spec §21 (medications), §11 (Parquet).

**Files:**
- Create: `tools/synth/medication.ts`, `test/synth/{medication,parquet}.spec.ts`.
- Modify: `tools/synth/index.ts` (flags `--with-medication`, `--parquet`).

**Interfaces:**
- Consumes: the Task 26 medication and dose services, `ExportJob.run(tenantId, day)` (Task 14).
- Produces: synthetic schedules for the demo residents with placeholder names (`Med A` … `Med F`), each linked to a synthetic doctor's recommendation record (D-111); 30 days of marks (`taken`, `not_recorded`, `resident_away`) for the MAR and the family opt-in on-time %; one Parquet export per synthetic day under the `demo` tenant prefix.

- [ ] **Step 1:** Write the tests: `synth medication marks are deterministic by seed`, `synth medication creates no push text events or outbox rows`, `synthetic parquet matches contracts export columns and has no medication`, `synthetic parquet has no medical records or name columns`.
- [ ] **Step 2:** Run `npm run test:int -- synth`. Expected: FAIL.
- [ ] **Step 3:** Implement; medication rows go only through the medication services, never into Parquet (D-49, D-98).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `SCBE-44: synthetic medication marks and parquet export`.

### Task 44: Ops routes for contracts 1.2.0: approvals list, ops MFA reset, platform audit, AI budget override (Thu 26 Nov, B3)
Spec §31.1, §31.5, §29.5. Extends Tasks 37 and 33. The ops console's gap list G1, G2, G3, G7 (consumed by SCOPS-22..24); paths and operationIds from contracts 1.2.0 `openapi/ops.yaml` (not on contracts `dev` yet on 20 Nov; tracked in the backend issue "Ops routes for contracts 1.2.0 (G1–G8)"). Lands before the 26 Nov 20:00 feature freeze.

**Files:**
- Create: `src/ops/{approvals.controller,ops-users.controller,platform-audit.controller,ai-budget-override.controller}.ts`, `test/ops/{approvals-list,ops-mfa-reset,platform-audit,ai-budget-override}.spec.ts`.
- Modify: `package.json`, `package-lock.json` (`@sotercare/contracts` exactly `1.2.0`), `src/ops/approvals.service.ts`, `src/agents/ai-budget.ts` (Task 33).

**Interfaces:**
- G1 `GET /v1/ops/approvals?status=pending` (paged; expired approvals are not pending).
- G2 ops-user MFA reset → 202 `approval`; a **different** ops user approves within 24 h (same user → 403 `approval_required`), then the ops-pool MFA is reset.
- G3 `GET /v1/ops/audit?actor=&action=&tenantId=&from=&to=` over `platform_audit`; rows carry IDs only.
- G7 `POST /v1/ops/tenants/{id}/ai-budget-override` (amount, until, reason) → reflected in `GET /internal/v1/facility` `aiBudget`.

- [ ] **Step 1:** Bump `@sotercare/contracts` to exactly `1.2.0` (or `github:SoterCare/sotercare-contracts#<commit>` until the tag exists, per Global Constraints). Commit `SCBE-45: pin contracts 1.2.0`.
- [ ] **Step 2:** Write the tests: `approvals list shows pending only`, `same ops user cannot approve own mfa reset → 403 approval_required`, `mfa reset runs after second approval`, `platform audit filters and returns ids only`, `ai budget override reflected in internal facility`, `tenant tokens refused on new ops routes`, `new ops routes match contracts 1.2.0 ops.yaml`.
- [ ] **Step 3:** Run `npx jest test/ops`. Expected: FAIL.
- [ ] **Step 4:** Implement; every action → `platform_audit`, tenant actions also → the tenant `audit.events` (`actorKind ops`).
- [ ] **Step 5:** Run the same command. Expected: PASS. Commit `SCBE-45: ops approvals list, ops mfa reset, platform audit, ai budget override`.

### Task 45: Ops routes for contracts 1.2.0: announcements, rollouts list, invoice detail, job status (Thu 26 Nov, B3)
Spec §31.2, §31.5, §31.7, §31.8. Extends Tasks 38 and 39. Gap list G4, G5, G6, G8; contracts pinned by Task 44. Lands before the feature freeze; if Task 39 slips to 27 Nov, G4 and G5 land with it.

**Files:**
- Create: `src/ops/jobs-status.controller.ts`, `test/ops/{announcements-list,rollouts-list,invoice-detail,job-status}.spec.ts`.
- Modify: `src/ops/{announcements.controller,rollouts.service,billing-ops.controller,restore-db.service}.ts`.

**Interfaces:**
- G4 `GET /v1/ops/announcements` + end early (sets `until = now`, WS removal to each tenant's `facility` room).
- G5 `GET /v1/ops/rollouts` (stage, status; filter by status).
- G6 `GET /v1/ops/invoices/{id}` (lines, daily bed-days, payments, credit notes, minor units) + the invoice PDF (presigned GET ≤ 15 min) + dispute resolve (`won` / `lost`; lost reopens with a new due date, §31.5).
- G8 restore-db job status and closing export status by `jobId` (unknown → 404).

- [ ] **Step 1:** Write the tests: `announcements list and end early`, `rollouts list filters by status`, `invoice detail has lines bed-days payments and credit notes matching ops.yaml`, `invoice pdf presigned under 15 min`, `dispute lost reopens with new due date`, `restore and closing job status by jobId`, `new ops routes match contracts 1.2.0 ops.yaml`, `tenant tokens refused`.
- [ ] **Step 2:** Run `npx jest test/ops`. Expected: FAIL.
- [ ] **Step 3:** Implement; billing routes need `platform_billing` or `platform_admin`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `SCBE-46: ops announcements, rollouts list, invoice detail and job status`.

### Task 46: Load-test support and fixes (Thu 26 – Fri 27 Nov, B1 with X2; CP8)
Spec §6 (pools), §8, §11, §12; `b2b-plan/18` §6 CP8 (3 tenants × 60 bands, 25 phones each) and §7 ("Load test: X2 + B1, 27 Nov, k6 + band-sim"). The k6 scenario itself is in `sotercare-infra` `e2e/`; this task is what the backend owns.

**Files:**
- Create: `tools/seed/load.ts`, `tools/load/tokens.ts`, `test/load/seed-load.spec.ts`, `docs/load-test-2026-11-27.md`.
- Modify: `package.json` (script `seed:load`), `.gitignore` (the token file), `src/tenancy/tenant-db.ts` (pool-usage log event, IDs only); fixes in the owning modules.

**Interfaces:**
- `npm run seed:load -- --tenants 3 --bands 60 --phones 25`: tenants `load1`…`load3`, each 60 beds, residents and bands (assigned via synthetic `assignment_record`s), 25 staff; idempotent; refuses `prod`.
- `tools/load/tokens.ts`: per-user tokens (local JWKS issuer in `local` / `dev`, Cognito test users in `staging`) written to a git-ignored file k6 reads.

**Acceptance (measured on the run):**
- every SOS / fall alert record acked `committed` exactly once; no lost and no duplicate push (push log vs record log);
- DB connections ≤ 5 per tenant per container (`pg_stat_activity` sampled every 10 s);
- p95 < 500 ms for `GET /v1/alerts`, `GET /v1/residents` and alert actions (excluding the 3 s claim wait), 0 5xx. The spec states no latency figure; this is a call made here, and the measured p50 / p95 / p99 are recorded;
- SQS live queue age < 60 s; backlog never delays live.

- [ ] **Step 1:** Write the test `seed load creates 3 tenants with 60 assigned bands and 25 staff each, idempotent`.
- [ ] **Step 2:** Run `npm run test:int -- load`. Expected: FAIL.
- [ ] **Step 3:** Implement the seed, the token helper and the pool gauge. Document the rate-limit and pool settings in `docs/load-test-2026-11-27.md`.
- [ ] **Step 4:** With X2, run the k6 scenario on `staging` (manual step on the SerenEdge task). Fix each finding in its owning module with a regression test. Record results against the acceptance list above.
- [ ] **Step 5:** Commit `SCBE-47: load-test seed, tokens and fixes`.

### Task 47: Delete the legacy contracts copy (Sat 21 Nov, B1)
`sotercare-contracts` CLAUDE.md: after consumers pin the package, delete the old `contracts/v1` copies. The cut-over left `config/alert-policy.v1.json`, `scripts/contracts-checksums.cjs`, specs reading `../contracts/v1` (`contracts.spec.ts`, `push.unit.spec.ts`, `device-event.contract.spec.ts`, `device-event.pg.spec.ts`) and "Mirrors contracts/v1" DTO comments. Depends on Task 1 (pins `@sotercare/contracts`).

**Files:**
- Delete: `config/alert-policy.v1.json`, `scripts/contracts-checksums.cjs`, the specs above (or rewrite them against the package schemas).
- Modify: the alert-policy loader (reads `@sotercare/contracts` `policy/default.alert-policy.v1.json`), the DTO comments.
- Create: `test/core/no-legacy-contracts.spec.ts`.

- [ ] **Step 1:** Write the test `no source file references contracts/v1 or config/alert-policy.v1.json`.
- [ ] **Step 2:** Run `npx jest test/core/no-legacy-contracts`. Expected: FAIL.
- [ ] **Step 3:** Delete and repoint as above.
- [ ] **Step 4:** Run `npm test`. Expected: PASS; the loaded default policy equals the contracts file byte for byte.
- [ ] **Step 5:** Commit `SCBE-48: delete the legacy contracts copy`.
