# sotercare-backend: full spec, Part 1 (platform core and safety)

Status: **approved design** (rev 2, 19 Nov 2026: the product owner asked for the **whole backend in one spec**, so the modules rev 1 left for a "spec 2" are now Parts 2 and 3). Plan: [`plan.md`](plan.md) (Tasks 0–41).

The spec has three parts, numbered continuously:
| Part | File | Sections |
|---|---|---|
| **1. Platform core and safety** | this file | §1–§15: tenancy, auth, ingest + alert mirror, bands + assignment mirror, shadows, push, internal API, agent outputs, seed, testing |
| **2. People and care** | [`spec-part2-people-and-care.md`](spec-part2-people-and-care.md) | §16–§25: accounts and identity, station PIN and readiness, settings and alert policy, layout and residents, shifts / availability / notifications, medications, Medical records, voice notes, audit / exports / data requests / retention, live view and metrics |
| **3. Family, AI, money and ops** | [`spec-part3-family-ai-money-ops.md`](spec-part3-family-ai-money-ops.md) | §26–§35: family API and live view, family e-mail, ARIA, the rest of the agent-output plumbing, billing and suspension, the ops API, support access, testing, open items |

Plan order follows the tiers (`b2b-plan/18` §0): the Tier 2 core (Part 1) is dated first, then the safety core, then Parts 2 and 3.

**Sources** (when they disagree, `b2b-plan/19` wins):
- `b2b-plan`: 03 (tenancy), 04 §5–6 (local credential, roles), 05 §3 and §7 (bands, pairing, replacement), 07 §2 and §5 (timers, cloud push), 11 §8, 14 §1–8 (every interface);
- `sotercare-contracts/docs/spec.md` §7: every field;
- `17` §3.1: the old code;
- this repo's `CLAUDE.md`: rules.

## 1. Intent
The backend is the platform's cloud core: one database per care home behind one shared, stateless service. In this first spec it has two jobs:
1. **The seam for the agents:** the internal API that `sotercare-iit`'s internal-API adapter calls (D-129, `18` §0.4), plus the `/v1` endpoints the console and app use to show agent outputs. It's usable on `dev` by **24 Nov (T2-1)** and accepted by **27 Nov (T2-2)**; live integration runs 30 Nov – 4 Dec.
2. **The cloud half of safety:**
   - mirroring every gateway record;
   - publishing the six shadows the gateway runs on;
   - the gateway's local credential;
   - cloud push and escalation delivery;
   - claim forwarding;
   - `gateway_offline`.

   These are never cut (D-116). If capacity is short they're late, not simplified.
3. **Everything else the apps and consoles need** (Parts 2 and 3): accounts, settings and policy sign-off, residents, shifts, medications and Medical records, the family API and live view, ARIA, billing and suspension, and the ops console's `/v1/ops`.

## 2. Goals, non-goals, anti-goals
**Goals:** everything in §5–§35, and these acceptance scenarios (`18` §9) green on `dev` / `staging`:
- **6:** tenant isolation, for the internal API, REST and the WebSocket rooms in this spec;
- **21:** migration failure;
- **41:** internal API guard;
- **25:** pairing mirror, cloud side;
- **the safety path:** a gateway record → mirror → push → ack;
- **Parts 2 and 3** (backend side): 3, 4, 5, 7, 8, 9, 12, 13, 16, 17, 19, 20, 22, 23, 24, 26, 28, 30, 31, 32, 33 (mapped to tasks in §33).

**Non-goals:**
- AWS resources and the Step Functions workflows themselves (`sotercare-infra`); the backend starts them and records their progress (§31);
- the agents, ARIA's answers and the detectors (`sotercare-iit`); the backend is their data, token and delivery layer (§11, §28, §29);
- card payments beyond PayHere (a `PaymentProvider` interface leaves room for Stripe, §30);
- languages other than English at launch (translation-ready keys only, `09` §6).

**Anti-goals (a failure even if it works):**
- the cloud deriving a safety alert from telemetry (D-08; only `gateway_offline`);
- a request holding two tenant connections;
- a tenant taken from a token claim or a payload;
- the cloud writing a band assignment (D-132);
- a medication field or non-`care_plan` Medical records item on any internal response (D-49, D-112);
- a name, note, health value or token in a log;
- `record_ack` before commit;
- copied contract types instead of `@sotercare/contracts`;
- a co-author / AI-attribution line in history.

## 3. Constraints
- **Stack:** Node 22 LTS, TypeScript 5, **NestJS 11**, **TypeORM 0.3** (`synchronize: false`, migrations only), PostgreSQL 16, Socket.IO 4, Redis 7 + BullMQ, Jest.
- **Libraries:**
  - AWS SDK v3: SQS, SNS, S3 + presigner, IoT data plane, IoT, Cognito IdP, Secrets Manager;
  - `jose` for every JWT (Cognito RS256 via per-pool JWKS, Ed25519 local credential and service token);
  - a Parquet writer chosen in Task 14.
- **Two entry points, one codebase:** `api` (REST `/v1`, `/v1/ops` for provisioning only here, `/internal/v1`, Socket.IO) and `worker` (SQS consumers, outbox publisher, timers, shadow publisher, exports).
- **Contracts:** every payload, shadow, API body and enum comes from `@sotercare/contracts` (pinned exact version). If v1.0.0 isn't on GitHub Packages by 21 Nov, depend on `github:SoterCare/sotercare-contracts#<commit>` until it is; never copy types. Contract tests run in CI against the pinned version; the OpenAPI and AsyncAPI documents are validated against the real responses (Task 16).
- **Region:** `ap-south-1`.
- **Environments:**
  - `local`: docker compose with Postgres, Redis and LocalStack (SQS, S3, SNS) from `sotercare-infra/local`; the local JWKS issuer; the fake IoT publisher and fake push provider;
  - `test`: the same, plus in-process fakes;
  - `dev`: the AWS account, real Cognito, IoT Core, SNS.
- **Clock:** one injectable `Clock` for every timer and date.
- **Request limits:** body ≤ 1 MB (presigned uploads bypass); internal API responses pre-aggregated (≤ 2,000 items, cursor paging).
- **History (D-20):** the old `back-end` code is imported **with history**, co-author trailers stripped, and **no force-push** to `sotercare-backend`.

## 4. Approaches considered
| Question | Options | Chosen |
|---|---|---|
| Tenant data access | per-tenant TypeORM `DataSource` registry (LRU) · one pool with `search_path` per schema · RDS Proxy | **DataSource registry**: matches silo tenancy (D-31) and `03` §3 (max 5 connections per tenant per container, idle 60 s, no RDS Proxy) |
| Code layout | keep the old microservices (gRPC auth / email / health) · one modular monolith | **Modular monolith** (`17` §3.1): the old services become modules |
| JWT verification | `aws-jwt-verify` · `jose` with per-pool remote JWKS | **`jose`**: one library for Cognito, local credential and service tokens; the local JWKS issuer works in tests unchanged |
| Local IoT Core | LocalStack Pro · a fake publisher + direct SQS injection locally, real IoT Core in `dev` | **Fake + `dev`**: LocalStack community has no IoT; the gateway simulator runs against `dev` IoT Core (`18` §4) |

## 5. Code layout (after the import, Task 0)
```
src/
  main.api.ts  main.worker.ts
  core/        config, clock, request context (AsyncLocalStorage), errors (14 §5 envelope), idempotency, logging (IDs only), ids (prefixed + UUIDv7)
  tenancy/     control DB entities, TenantRegistry, tenant cache, migration runner, provisioning service
  auth/        Cognito guard, roles, /auth/tenant, /me, local credential + signing keys, service tokens
  org/         facilities, wards, rooms, beds, residents (residentNo), alert settings, pause, staff + shifts (read side)
  devices/     bands, provisioning bundles, band keys, identify, lost, assignment mirror, gateway registry views
  ingest/      SQS consumers, record router, record_ack, gateway records table
  alerts/      alert mirror, timeline, actions + claim forwarding, provisional timers, gateway_offline
  notifications/ push tokens, SNS sender, fake provider, delivery attempts, escalation delivery
  shadows/     builders for the six shadows, publisher, S3 offload, applied versions
  telemetry/   telemetry, gait events, band status, hourly / daily rollups, moisture episodes (mirror)
  realtime/    Socket.IO gateway, server-side rooms, event fan-out, revocation
  internal-api/ guard, read tools, writes, outbox + domain events, schedule_event, Parquet export
  outputs/     agent outputs, proposals, cover requests (read), traces: /v1 endpoints + WS
migrations/control/  migrations/tenant/
tools/seed/  tools/dev-bridge/ (optional)
test/support/  (kept from the old repo: in-memory helpers, fake push, fixtures) + local JWKS issuer
```

**Kept / adapted / dropped from the old code**, exactly as `17` §3.1:
- **Kept:** `alert-dispatch.service.ts` (outbox, `FOR UPDATE SKIP LOCKED`), the append-only audit, the migrations pattern + `migrations.pg.spec.ts`, `typeorm-options.ts`, `jwt-secret.ts` checks, `user-socket.registry.ts` + revocation spec, `notification-attempts.service.ts`, `test/support/*`, `scripts/ws-*.cjs`.
- **Adapted:**
  - device events → SQS ingest;
  - ownership periods → `band_assignments`;
  - escalation / sender / push tokens → SNS;
  - `internal-service.guard.ts` → the internal API guard;
  - pipeline status → readiness;
  - the timeline;
  - tenant-isolation spec → tenant-routing tests.
- **Dropped:** `alert-writer.service.ts` and its spec, `nurse/`, `apps/back-end`, `3days-sample.json`, `dist/`, Koyeb files, the gRPC microservice wiring, the custom JWT login, the B2C patient model and `device-scope.ts`.

## 6. Tenancy and data
**Control DB** tables:
- `tenants`: `tenantId`, status `provisioning | provisioning_failed | onboarding | active | maintenance | closing | closed`, `poolId`, `clientIds`, `dbEndpoint`, `dbSecretArn`, `kmsKeyArn`, `s3Prefix`, `service {state, since, suspendsAt}`, `schemaVersion`, `migrationStatus`;
- `gateway_registry`: `gatewayId`, `tenantId | null`, `facilityId`, `role active | standby`, `wrappingPublicKey`, `boundAt`, `revokedAt`;
- `provisioning_jobs` + steps;
- `signing_keys`: `kid`, `alg`, purpose `local_credential | service_token`, `notBefore`, `notAfter`, private key reference.

**Tenant DB** schemas:
- `core`: org, residents, bands, assignments, alerts, records, shifts, outputs, outbox, audit;
- `telemetry`: daily partitions;
- `agents`: empty here. It's granted to the `agents_rw` role only, which has no rights on `core` and `telemetry` (11 §8).

**`TenantRegistry`:**
- `forTenant(tenantId) -> DataSource`;
- an LRU of DataSources, max 5 connections per tenant per container, idle close 60 s;
- credentials from the tenant's secret (local: env);
- tenant records cached 60 s, and `invalidate(tenantId)` on any status / endpoint change.

**Request context:**
- `TenantContext` (AsyncLocalStorage) holds `{tenantId, actor, requestId}`;
- it's set only by the auth guard, the internal API guard or a queue consumer;
- `TenantDb.get()` throws `NoTenantContext` without it;
- a second `forTenant` in the same context with another tenant throws `CrossTenantAccess`.

**Migration runner** (`npm run migrate:tenants`):
- applies the release's expand migrations to every non-`closed` tenant, one at a time, each in a transaction with `lock_timeout 5s`;
- records `schemaVersion`;
- on failure marks the tenant `migration_failed`, alarms (log event `migration_failed`), carries on, and stops after 2 failures (scenario 21).

**Provisioning (local / dev only in this spec):** `ProvisioningService.create(tenantId)` runs idempotent steps recorded in `provisioning_jobs`:
1. reserve the tenant ID;
2. create the DB (local: `CREATE DATABASE`; dev: an existing dev RDS);
3. run the migrations + reference data;
4. create the Cognito pool + clients (dev) or register with the local JWKS issuer (local);
5. create two `facility_manager` accounts.

It's exposed as the CLI `tenant:create` and, in `local` / `dev`, behind `POST /v1/ops/tenants` (ops pool). In `staging` / `prod` the same endpoint starts infra's provisioning workflow (§31.2); KMS / RDS creation is `sotercare-infra`'s job.

## 7. Auth
- **Cognito guard:** verifies signature, expiry, `token_use` and `client_id` against the pool the issuer names. The JWKS is cached per pool. **The tenant comes from issuer → pool → tenant**, never a claim.
  - Ops-pool tokens are accepted only on `/v1/ops/*`.
  - The role comes from the `custom:role` attribute mirrored in the tenant DB `users` table, which is authoritative. A deactivated user → 403 `account_deactivated`.
- **Roles** (04 §6): `caregiver`, `ward_head`, `facility_manager`, `org_admin`, `family`; ops: `platform_admin`, `platform_support`. An org admin sends `X-Facility-Id`.
- `GET /v1/auth/tenant/{tenantId}` (public, rate-limited): `{poolId, clientIds, region}`, or 404 `tenant_not_found` / 410 `tenant_closed`.
- `GET /v1/me` returns role, wards, login type, notices, and, for care staff with `X-Login-Type: care_staff`, the local credential + the gateway's local address and certificate fingerprint.
- **Local credential** (04 §5):
  - an Ed25519 JWT valid 30 days, bound to `installationId`;
  - claims `sub, tenantId, facilityId, wardIds, role, displayName, jti`;
  - issued at care-staff login; never to family;
  - revoked on deactivation, manager password reset or sign-out. The `jti` goes to the `keys` shadow until it expires.
  - **Key rotation** every 90 days: the new key is published in `keys` ≥ 24 h before use, and the old key is kept until its last token expires.
- **Service token** (14 §7):
  - an Ed25519 JWT with `tenantId, caseId | chatId, agent, residentIds[], wardIds[], audience {kind: staff | family, userId?}`, TTL 15 min;
  - a family token carries exactly one `residentId`;
  - issued by `ServiceTokenIssuer.issue(...)`, used by the backend when it dispatches a case or chat, and by the `token:issue` dev CLI for INT;
  - verified only by the internal API guard.

## 8. Ingest and the alert mirror (worker)
- **Queues** (14 §4): SQS FIFO `alert-records` (group = `gatewayId`), SQS `backlog`, SQS `telemetry`. Each is a long-poll consumer with visibility 60 s. Batches are processed in order within a FIFO group.
- **Tenant:** comes from `gateway_registry` by `gatewayId`, from the topic or the IoT block. **The envelope `tenantId` is ignored.**
  - Unknown, unbound or revoked gateway → ack `rejected` + alarm.
  - A registry tenant differing from the IoT-Rule hint → `rejected` + alarm.
- **Records:** every record with a `recordId` is written to `gateway_records` (unique `recordId`), and then its typed effect is applied **in the same transaction**:

| Record | Effect |
|---|---|
| `alert_record` | upsert `alerts` (highest `seq` is current, any order) + append `alert_events` |
| `assignment_record` | §9 mirror |
| `band_health_change` | `band_status` |
| `cmd-res` | resolve the waiting action / identify |
| `url_request` | answer `cmd/url` with an `url_grant` |

- **Ack:** `record_ack {recordId, status}` is published to `sc/v1/gw/{gatewayId}/ack` **only after commit**:
  - `committed`;
  - `duplicate` (unique violation on `recordId`);
  - `rejected` (schema-invalid, or the tenant check failed; logged with IDs only);
  - `suspended` (`service.state = suspended`, nothing written except alert and assignment records, 12 §5).
- **Telemetry queue** (not acked, 14 §4): `telemetry_batch` → `telemetry.samples_10s` (daily partitions, kept 72 h raw + rollups). It also carries:
  - gait events;
  - logged events;
  - sensor-window refs;
  - connectivity;
  - heartbeats → `gateway_status` (+ the `gateway_offline` monitor), including the `assignmentSeq` check (§9);
  - shadow reports → `shadow_applied`, WS `gateway.shadow_applied`.

  An hourly rollup job writes `telemetry.rollups_hourly` and `rollups_daily`, which the internal read tools serve.
- **Backlog:** the same handling, and **never** triggers push or WebSocket alert events. It updates the mirror silently.
- **Alert actions** (`POST /v1/alerts/{id}/{action}`, `Idempotency-Key`):
  - the backend runs the same "who may" check as the gateway (14 §3), then publishes `claim_command` on `cmd/claim`;
  - it waits ≤ 3 s for the matching `cmd-res` / `alert_record`: 200 with the result, or 409 `claimed_by_other` / `invalid_state`;
  - if nothing arrives, it returns **202 provisional**: an `alerts.provisionalClaim` row, and the cloud runs the claimed-alert timers from `requestedAt` until the gateway's record arrives (07 §5.2). The gateway's record always wins, compared on `requestedAt` (14 §1).
- **`gateway_offline`** (the only cloud alert):
  - raised after no heartbeat for 90 s;
  - pushed to managers at once and every 10 min until a heartbeat arrives;
  - console banner via WS `alert.escalated`;
  - resolved automatically on the next heartbeat.

## 9. Bands and the assignment mirror (D-99, D-132)
- **Bands:**
  - `bands` (`bandId` = serial, `bandLabel` = last 4 digits, pool state `active | lost`, `keyGen`, `lastBootId`);
  - `POST /v1/bands/{bandId}/provisioning-bundle`: facility manager / org admin. It seals the bundle with the band's factory key using the contracts crypto helpers and fixtures. 409 `band_not_allocated` unless the band is allocated to this tenant;
  - `/reset-bundle`, `/rekey`;
  - `/identify`: `cmd/band`, waits ≤ 3 s;
  - `/lost`: sets `lost` and re-publishes `bands`; the gateway ends the assignment itself;
  - `GET /v1/bands`, `GET /v1/gateway`.
- **The mirror:** `assignment_record` → `band_assignments` periods (`assignmentId`, `bandId`, `residentId`, `startedAt`, `endedAt`, `via`, `actorUserId`, `reason`, `assignmentSeq`).
  - The highest `assignmentSeq` per band wins, so records apply correctly in any order.
  - A swap is an `ended` + `started` pair, applied together.
  - Each change emits WS `band.assignment`, the domain event `band.swapped` (on swap, and on `started` for a resident who had another band) and an audit row.
- **Read-only REST:** `GET /v1/bands?status=available`, `GET /v1/residents/{id}/band` (with `syncedAt`), `GET /v1/band-assignments?…`.
  - `POST /v1/residents/{id}/band`, `DELETE /v1/residents/{id}/band`, `POST /v1/residents/{id}/band/swap` → **409 `assign_via_gateway`** with the message "Pair the band at the nurse station or in the app on the facility Wi-Fi".
- **Resync:** a heartbeat `assignmentSeq` > the mirror's max for that gateway → `cmd/resync {streams: [assignment_record], since}`, at most once per 5 min per gateway.
- **Replacement gateway:** `url_request {purpose: assignments}` → an S3 JSON of the latest `assignment_record` per open assignment, granted for ≤ 15 min.
- **Staff payloads never carry `bandId`.** The exception is an unassigned-band alert, which carries `bandLabel`.

## 10. Shadows, local credential keys, push (safety core)
- **Shadows:** `ShadowBuilder` per shadow (`roster`, `bands`, `residents`, `policy`, `keys`, `service`) builds `content` from the tenant DB exactly per the contracts shadow schemas (`roster` = shifts for the next 72 h). Shadows are per gateway thing: `service.gatewayRole` is `active` for the facility's active unit and `standby` for any other (C-29), and an active-gateway switch rewrites both units' `service` (and `bands`) shadows.
  - **The publisher** bumps a strictly increasing `version`, computes `sha256`, and puts content > 7 KB in S3 (`contentRef`, fetched via `url-req`). It calls `UpdateThingShadow` (named shadow, `desired`) for the facility's **active** gateway only. `bands` keys are wrapped to that gateway's public key.
  - **Triggers:** any change to the source rows (debounced 2 s), hourly for `roster` (the 72 h window moves), and on gateway activation.
  - The applied version comes from the shadow reports.
- **Push:**
  - `POST /v1/push-tokens` and `DELETE /v1/push-tokens/{installationId}` manage one SNS endpoint per installation; a different account on the same phone deletes the old endpoint first.
  - The sender is a `PushProvider` interface with `SnsPushProvider` and `FakePushProvider` (kept from the old repo).
  - **Cloud push is sent only for an `alert_record` that:**
    - has `cloud` in its `channels`;
    - was received ≤ 120 s after its `ts`;
    - is still the alert's latest `seq`;
    - came on the live queue, never `backlog`.
  - **Recipients:** the record's `recipientUserIds` (escalation kinds go to managers / ward heads per the record).
  - **Payload** (14 §9): room + type text only, data `{alertId, seq, kind, type, priority, tenantId, round}`, collapse ID `alertId` (`esc-{alertId}` for manager escalation). A claim, take-over or step-in sends a quiet replacement; `resolved` sends a silent push.
  - **Delivery attempts** are recorded (`notification_attempts`). **Never in push:** names, `residentNo`, `bandId`, notes, verdicts, health values.

## 11. Internal API (`/internal/v1`, agents and ARIA)
- **Guard** (scenario 41), on every call:
  1. verify the Ed25519 service token, its expiry and audience;
  2. **the `agent` claim must be in the operation's `x-sc-agents` list** (read from the pinned contracts `internal.yaml` at boot), else 403 `forbidden`;
  3. route to the token's tenant only;
  4. every `residentId` / `wardId` in the path or query must be in the token's scope, else 403 `forbidden`;
  5. a suspended tenant → 402 `tenant_suspended`;
  6. a family token may only touch its one `residentId`.
- **Read tools** (operation IDs and bodies exactly as contracts `internal.yaml`; Tier 2 set):
  - facility; settings;
  - resident rollups (hour / day), timeline (moves, care-plan uploads, alerts as type and time, assignments), profile, incidents;
  - `care_plan` documents (Care Plan Specialist only, category fixed);
  - pseudonym resolve;
  - alerts (aggregate-only for `operations`); moisture episodes;
  - band health / telemetry summaries / assignments;
  - metrics / coverage; shifts;
  - **staff availability** (staff pseudonyms, role, wards, shifts this week, night eligibility). This is a contracts addition needed by the Roster Coordinator, §15.

  - **`medication_counts`** (counts only, `coordinator`, §21.8) and **family facts** (`GET /family/residents/{id}/facts`, the family-card facts for ARIA family and the weekly brief, §26.3).
- **No medication field** in any response except `medication_counts` (none here). **No Medical records item except through the care-plan document schema.** Both are checked by a response-shape test over every operation (Task 16), in addition to the contracts CI rule.
- **Writes:**
  - `POST /outputs`: upsert by `dedupeKey`;
  - `PATCH /outputs/{id}`: close device tasks;
  - `POST /proposals`: incident reports start with the resolving caregiver and escalate to the ward head after 24 h (a BullMQ delayed job);
  - `POST /cases/{id}/trace`;
  - **no alerts endpoint**.

  Each write emits WS `output.published` / `output.updated` / `proposal.created` and a domain event.
- **Outbox → SQS `domain-events`:**
  - the `outbox` table is written in the same transaction as the change; the publisher uses `FOR UPDATE SKIP LOCKED` (the kept `alert-dispatch` pattern) and delivers at least once with `eventId`;
  - events in this spec: `alert.resolved`, `shift.starting`, `shift.ending`, `shift.cancelled`, `coverage.gap`, `band.swapped`, `resident.moved`, `resident.left`, `document.uploaded` (`care_plan` only), `proposal.decided`, `export.ready`;
  - **`schedule_event`** comes from each facility's settings and time zone: `shift.ending` at shift end − handover minutes, the 15-min device tasks and the daily care log first (T2-1); the full set (morning brief, weekly roster, weekly review pack, family weekly brief, monthly report, Wi-Fi dead-zone report) in §29.3.
- **Parquet export:** a nightly per-tenant pseudonymised export of the tables and columns in contracts `schemas/v1/exports/` to the tenant S3 prefix, then `export.ready`. Medication and Medical records tables are never exported.

## 12. `/v1` agent outputs and realtime
- **REST:**
  - `GET /v1/outputs?type=`; `POST /v1/outputs/{id}/feedback` (`useful | not_useful`);
  - `GET /v1/proposals?queue=mine`; `POST /v1/proposals/{id}/approve | edit | reject`, which writes the decision and emits `proposal.decided`. Approving a `band_reassignment` changes nothing and returns the 409 `assign_via_gateway` message as guidance;
  - `GET /v1/cases/{id}/trace` (ward head / manager);
  - `GET /v1/cover-requests` (read).

  Responses are filtered to the caller's wards.
- **Socket.IO:**
  - **Auth:** `auth.token` (a Cognito access token) or `auth.ticket` from `POST /v1/ws-tickets` (contracts C-33: Redis `t:{tenantId}:wsticket:{ticket}` → `{userId, facilityId}`, TTL 60 s, deleted on first use; the console BFF uses it).
  - **Rooms** `facility:{tenantId}`, `staff:{tenantId}`, `user:{tenantId}:{userId}`, joined **server-side only** from the verified token; family sockets join only `family:{tenantId}:{residentId}` after `family.watch` (§26.4).
  - **Events in Part 1:** `alert.event`, `alert.escalated`, `band.status`, `band.assignment`, `gateway.status`, `gateway.shadow_applied`, `tenant.service`, `roster.updated`, `output.published`, `output.updated`, `proposal.created`, `proposal.decided`.
  - **Revocation:** sockets are dropped on sign-out / deactivation (the kept revocation registry).
  - Parts 2 and 3 add `resident.status`, `staff.availability`, `notification.created`, `announcement`, `dose.updated` and `family.live` (contracts §7.5).

## 13. Seed tool (`tools/seed`)
- **`seed:demo`** creates tenant `demo`:
  - wards A and B, rooms and beds;
  - 20 residents with `residentNo`;
  - 24 bands, 20 of them assigned via synthetic `assignment_record`s, so the mirror is built the real way;
  - staff in every role, with shifts for 7 days;
  - a signed-off default policy;
  - `care_plan` items;
  - an active gateway `gw_0000000000000001` bound to `demo`;
  - `service.state = active`.
- **`seed:import-iit --input <sotercare-iit samples/input/seed-N>`** (26 Nov) maps the iit generator files into `demo`, so both adapters see the same scenario (INT parity, scenario 42):
  - residents, staff, shifts, moves, care plans and alerts;
  - band health into band status / telemetry rollups;
  - hourly rollups into `rollups_hourly`.

  Notes are skipped; medication files are never imported.
- **Re-running is idempotent:** it uses stable IDs from the input.

## 14. Testing
- **Unit tests:** Jest. **Integration tests** run against docker-compose Postgres + LocalStack with the local JWKS issuer, the fake IoT publisher and the fake push provider. There's no real AWS in CI.
- **Required suites:**
  - tenant routing and context: no context throws, a cross-tenant access throws;
  - migration runner (scenario 21);
  - the Cognito guard (issuer → tenant, ops-pool separation, a forged `tenantId` claim ignored);
  - local credential and key rotation;
  - service token + guard (scenario 41, every rule);
  - ingest: ack only after commit (kill between write and ack → no ack, redelivery → `duplicate`), any-order `seq`, the registry tenant over the envelope, backlog never pushing;
  - assignment mirror: any order, swap pair, 409s, resync trigger;
  - shadows: versions, sha256, the 7 KB offload, active gateway only;
  - push rules (120 s, latest `seq`, live only, payload contains no name or `residentNo`);
  - claim forwarding (≤ 3 s / 202 provisional);
  - `gateway_offline` at 90 s and every 10 min;
  - outbox at-least-once; `schedule_event` times in `Asia/Colombo`;
  - internal reads / writes; response-shape scans (medication, Medical records);
  - `/v1` outputs and proposals; WS server-side rooms;
  - **isolation suite** (scenario 6): two seeded tenants; every REST, internal and WS route in this spec, with tenant A credentials, can't read tenant B.
- **Contract tests:** request / response bodies validated against the pinned contracts schemas; the AsyncAPI messages the worker publishes are validated too.

## 15. Open items and calls (check while reading)
1. **`staff_availability`** (D-139, contracts C-28): `GET /internal/v1/staff/availability`, Roster Coordinator only, pseudonymous `staffKey`; the backend resolves `staffKey` → user only when creating cover requests.
2. **Agents' pseudonyms:** the internal API returns `residentNo` (and `residentId`), never names. The pseudonym-resolve tool maps both ways for the backend's own render. Call: `residentNo` is the agents' resident key, as in the iit file adapter.
3. **Family sockets** join only their resident's family room (§26).
4. **Escalation of incident proposals after 24 h** uses a BullMQ delayed job keyed on the proposal, cancelled on decision.
5. **`POST /v1/ops/tenants`:** in `local` / `dev` it runs `ProvisioningService` (§6); in `staging` / `prod` it starts the infra provisioning workflow and tracks it (§31).
6. **Old code import (Task 0)** uses `git filter-repo` on a fresh clone of the old `back-end` at `642c642`, keeping history, with trailers stripped by `--message-callback`. It's merged with `--allow-unrelated-histories` into `sotercare-backend` `main` on a branch, then fast-forwarded. **No force-push.**
