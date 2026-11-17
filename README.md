# sotercare-backend

The core SoterCare platform: a NestJS modular monolith, deployed on AWS ECS (`ap-south-1`) as two services from one codebase:
- **`api`**: REST + Socket.IO;
- **`worker`**: SQS consumers, re-push loop, escalation views, rollups, domain-event outbox.

See `../b2b-plan/01-Target-Architecture.md`, `../b2b-plan/02-Alert-Lifecycle-and-Notifications.md` and `../b2b-plan/03-Contracts-v1.md`.

## Owns
- Tenancy and RBAC (Cognito groups: `org_admin`, `facility_manager`, `ward_head`, `caregiver`, `family`), with PostgreSQL row-level security on `org_id`
- Facilities, wards, rooms, residents; staff memberships; staff device readiness
- **Shifts** (see `../b2b-plan/05-Staff-Shifts-and-Check-in.md`):
  - shift templates, roster patterns, shifts (draft/publish, manager-only edits, change audit);
  - alert recipients = **everyone whose shift time is now** (connectivity not checked);
  - **online availability** (gateway connectivity records + app heartbeats) for display only; segments purged after 48 h;
  - coverage rules (planning warnings);
  - shift notifications (roster published/changed, reminder, alert setup needed, handover ready);
  - in-app inbox.
  - **No attendance tracking.**
- **Family accounts**: invite (`AdminCreateUser`), link to residents, revoke. Family API returns **resolved incidents only**, attributed to "care staff"
- Gateways (IoT things, certificates), bands, band ↔ resident assignment periods
- Ingest from SQS (`alert-records`, `telemetry`), idempotent on `recordId`; publishes `record_ack` **after commit**
- Alert mirror (`alerts`, `alert_actions`, `alert_deliveries`), **cloud claim forwarding** (`cmd/claim`) and provisional-claim reconciliation
- Cloud re-push loop to on-shift staff (SNS mobile push → APNs/FCM, collapse id = `alertId`), quiet replacement on claim/resolve
- Escalations:
  - unclaimed → facility manager: **mobile app push** (not shift-gated; respects on-call / quiet hours) + dashboard WebSocket banner;
  - claimed-unresolved → ward head (push).
- Manager overview API for the app (open / claimed / overdue alerts, staff on shift, device health)
- `gateway_offline` detection from heartbeats
- Shadow publishing (`roster`, `bands`, `policy`, `keys`), device-bound local credential issuing (Ed25519, 30 days, revocable), IoT Jobs for OTA
- Dashboard feeds and metrics rollups; reports and exports
- **Internal API for `sotercare-agents`** (see `../b2b-plan/03-Contracts-v1.md` §8 and `../b2b-plan/06-Agentic-Design.md`):
  - facility-scoped token per case; **enforces each agent's tool allow-list** (the `agent` claim) and scope on every call;
  - Ops-facing endpoints return aggregates only, with no resident health detail;
  - domain events to Case Intake through the outbox (`alert.resolved`, `shift.ending`, `document.uploaded`, `shift.cancelled`, `coverage.gap`, `resident.moved`, `band.swapped`, `cover_request.replied`).
- **For the agent layer:**
  - hourly and nightly rollups per resident, ward and band;
  - **pseudonymised Parquet export to S3** for the detector pipeline;
  - agent **outputs** (auto-published: handovers, insights, review packs, briefs, ops notes, device tasks) with useful / not-useful feedback;
  - **proposals** for harsh or *uncertain* outputs (incident reports, draft rosters, cover assignments, band reassignments, care-routine changes, monthly reports, resident profiles, unresolved disagreements) with approve / edit / reject and a per-reviewer **review queue**;
  - **case traces** for the "why" view;
  - roster cover requests to staff (in-app);
  - normal-priority push channel for agent outputs.
- The Layer 1 code outputs (charging rota, daily care logs) come from `sotercare-agents`' code layer and are stored as outputs too.

## Does not own
- Real-time safety rule evaluation (that's the gateway). **Never derive fall/SOS/moisture alerts from telemetry.**
- LLM calls (`sotercare-agents`)

## Stack
NestJS 11 · TypeScript · PostgreSQL 16 (RDS) with `pg_partman` · migrations only (`synchronize: false`) · Redis (ElastiCache) · BullMQ · Socket.IO + Redis adapter · AWS SDK v3 (SQS, IoT, SNS, Cognito, S3) · `@sotercare/contracts`

## First milestones
1. Repo skeleton, CI, Docker image (non-root, healthcheck), migrations baseline, row-level security policies + tenant-isolation test suite
2. Cognito auth guard, roles, `/me`, staff and family admin endpoints
3. SQS ingest + `record_ack`, alerts mirror, dashboard WebSocket
4. Shifts dashboard API (alerts to everyone on shift) + availability display + local credentials + `roster`/`keys` shadows
5. Cloud push, claim forwarding, escalations
6. Metrics rollups, family incident API, internal agents API

## Origin: built from the old `back-end` (D-20)
- **Created from** `SoterCare/back-end` at `phase-1/alert-reliability` (`642c642`, fast-forwards `main`). Split with `git filter-repo`, keeping history and leaving out `apps/ai-summary-service` and `contracts/`. Old `main` is tagged `b2c-final`
- **Keep:** alert dispatch outbox (`FOR UPDATE SKIP LOCKED`), append-only alert audit, migrations `1760500000001…006` pattern + migration tests, `synchronize: false` options, tenant-isolation tests, internal-service guard, JWT secret checks, socket registry + revocation, notification attempts, test support (in-memory DB, fake push provider, fixtures)
- **Adapt:**
  - `device-event` ingest becomes SQS `alert_record` ingest + `record_ack`;
  - ownership periods become `band_assignments`;
  - escalation / sender / push tokens move to SNS → APNs/FCM;
  - pipeline status becomes staff readiness;
  - `auth`, `email` and `health` services become modules (no gRPC)
- **Replace:** custom JWT and the B2C patient model become Cognito with org/facility tenancy + row-level security; vital-sync over the gateway socket becomes IoT Core → SQS; Koyeb container becomes ECS
- **Drop:** the cloud alert writer that derives alerts from vitals (D-08), the `nurse/` chat proxy, the empty `apps/back-end` scaffold
- **Moves to the gateway:** the moisture-episode state machine and its tests
- Full file list: `../b2b-plan/07-Old-Repo-Mapping.md` §3.1
