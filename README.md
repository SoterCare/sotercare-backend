# sotercare-backend

The core SoterCare platform: a NestJS modular monolith on AWS ECS (`ap-south-1`), shared by every tenant and stateless, deployed as two services from one codebase:
- **`api`**: REST `/v1` (facility users), `/v1/ops` (SoterCare staff), `/internal/v1` (agents and ARIA), Socket.IO;
- **`worker`**: SQS ingest, cloud push for the gateway's re-push and escalation records, rollups, domain-event outbox, billing timeline, tenant-timed triggers.

Plan: `../b2b-plan/` (v2). Start with `02-System-Architecture.md`, `03-Tenancy-and-AWS.md`, `07-Alerting.md` and `14-Contracts.md`; the full list is in `16-Repos-and-Ownership.md` §3. Decisions: `19-Decisions-and-Open-Items.md`.

## Owns
- **Tenancy (silo, D-31):** one RDS database per facility plus a control DB. The tenant is derived from the token issuer, and each request uses that tenant's DB pool only (`03` §3). Per-tenant migrations with expand-only releases (`03` §5).
- **Identity (`04`):** a Cognito pool per tenant and an ops pool; `name@tenantId` usernames. Managers create staff and family accounts with a **temporary password** and print a login slip; managers reset passwords; account recovery through the authorised contact. Roles `caregiver`, `ward_head`, `facility_manager`, `org_admin`, `family`; org admins work one facility per request. Audit to `audit.events`.
- **Facility data:** wards, rooms, beds, residents (each with a short **`residentNo`**, e.g. `R-0012`, D-99); per-resident alert bar, bedtime / wake, pad type, Pause, discharge; facility settings and versioned alert policy with manager sign-off (`07` §3, §8; `09`).
- **Shifts (`08`):** templates, patterns, publish; recipients = everyone on a published shift now ± margin; availability for display only (purged after 48 h); shift notifications, roster-gap warning. No attendance tracking.
- **Alert mirror (`07`, `14` §4):** SQS ingest of every gateway record (live queues and a separate `backlog` queue), idempotent on `recordId`; `record_ack` **after commit**. The gateway runs every alert timer: the backend turns its re-push and escalation records into cloud push via SNS → APNs / FCM (collapse ID = `alertId`, fresh records only) and console banners. Cloud claim forwarding (`cmd/claim`, provisional after 3 s); provisional-claim timers and `gateway_offline` are the only cloud-run timers.
- **Gateway feeds:** the named shadows `roster`, `bands`, `residents`, `policy`, `keys`, `service`; the device-bound local credential (Ed25519, 30 days); band keys and provisioning bundles sealed under the band's factory key (`06` §4, §6); presigned URLs for sensor windows.
- **Band assignments: mirror only (D-99, D-132):** bands are provisioned to the facility once, then sit in a **band pool**. Pairing (assign / unassign / swap) happens **on the gateway** (nurse station or staff app on the facility Wi-Fi), which is authoritative; the backend ingests its `assignment_record`s, keeps the assignment periods (used for bed-days) and shows them read-only. Any cloud-side assignment attempt gets **409 `assign_via_gateway`**; the `bands` shadow carries keys, pool and lost state only. Staff payloads show name + `residentNo`, never band IDs.
- **Medications (D-98, D-111, `21`):** medication records and schedules per resident, each added or changed only with a linked **doctor's recommendation** (uploaded to the Medical records tab; `doctorRecommendationId` required) and recorded in the append-only **medication log**, dose rounds, reminder push on the `medication` channel (no names), dose marking with undo, PRN, MAR + PDF, the app's 24 h offline schedule, WS `dose.updated`; agents get counts only (`medication_counts`). Records and reminders, never advice.
- **Medical records tab (D-112, `21` §10):** pictures, PDFs, references and text per resident, with categories and versions; presigned S3 upload under the tenant KMS key, virus scan and thumbnails; ward heads / managers upload, staff view, family never. Only `care_plan` items reach agents.
- **Dashboards and family:** live floor, metrics, the family API (`10` §6; real incident data incl. false alarms as "checked, no issue", D-101), per-person family unlink / deactivate and the discharge choice, ARIA endpoints for staff and family.
  - **Family live view (D-114):** the "Live now" card's data (activity, band worn, temperature relative to usual, "care staff are attending" while an alert is claimed) by `GET /family/residents/{id}/live` and the Socket.IO room `family:{tenantId}:{residentId}`, joined server-side after the link check; ≤ 15 s; off while suspended.
  - **Family ARIA chats are private (D-113):** no manager, org admin or other staff role can read or export them; the audit keeps metadata only.
  - **Family weekly brief:** auto-published Monday 08:00, no ward-head hold (D-51).
- **Billing (`12`):** bed-day invoices, PayHere checkout and recurring payments, verified idempotent webhooks, credit notes, the non-payment timeline and **suspension / restore**; invoice PDFs; e-mail via SES.
- **Ops API (`13`):** tenant **provisioning** (starts the Step Functions job; retry / discard), onboarding checklist, organisations, gateways, band stock, rollouts via IoT Jobs, billing overview, support grants, data requests, platform health.
- **Internal API for `sotercare-agents` (`14` §7):** per-case or per-chat Ed25519 token; **each agent's tool allow-list is enforced on every call**; read tools, output / proposal / cover-request / trace / ARIA-message writes; domain events through the outbox; pseudonymised Parquet export to S3. There is never an alerts endpoint.
- **Build tools (`18` §4):** seed tool (tenant `demo`), synthetic history, PayHere webhook replayer, fake push provider.

## Does not own
- Real-time safety rules, claim arbitration or alert decisions: that's the gateway (D-08). **Never derive fall / SOS / moisture alerts from telemetry.**
- LLM calls: `sotercare-agents`.
- AWS resources: `sotercare-infra` (the backend calls the provisioning workflow it defines).

## Stack
NestJS 11 · TypeScript · PostgreSQL 16 (one RDS per tenant + control DB) with `pg_partman` · migrations only (`synchronize: false`) · Redis (ElastiCache) · BullMQ · Socket.IO + Redis adapter · AWS SDK v3 (SQS, IoT, SNS, Cognito, S3, SES, Step Functions) · `@sotercare/contracts`

## Build plan
Three builder lanes in one SerenEdge project, on the dated calendar in `18` §1.1 (tiers per D-133):
- **B1 devices and alerts:** tenant routing, auth, `GET /me`, seed tool, ingest + `record_ack`, alert mirror (Tier 2); WebSocket, residents + `residentNo`, bands + provisioning, the band assignment mirror (read-only), shadows, local credential, shifts, push, claim forwarding (Tier 3 safety core).
- **B2 care and people:** accounts, station PIN, settings + policy sign-off, synth tool, family API + per-account discharge + **family live view**, **medications** (with the doctor's recommendation and log), **Medical records tab**, audit, exports.
- **B3 internal API, money and ops:** internal API, triggers, `/v1` agent outputs, Parquet export (Tier 2); billing + PayHere + suspension, ARIA endpoints, `/v1/ops` (Tier 3).

Day 14 is a release candidate; the follow-on is in `18` §1.

## Origin: built from the old `back-end` (D-20)
- **Created from** `SoterCare/back-end` at `phase-1/alert-reliability` (`642c642`, fast-forwards `main`), split with `git filter-repo`, keeping history and leaving out `apps/ai-summary-service` and `contracts/`. Old `main` is tagged `b2c-final`.
- **Keep:** alert dispatch outbox (`FOR UPDATE SKIP LOCKED`), append-only alert audit, the migration pattern + migration tests, `synchronize: false`, JWT secret checks, socket registry + revocation, notification attempts, test support (in-memory DB, fake push provider, fixtures).
- **Adapt:**
  - `device-event` ingest → SQS `alert_record` ingest + `record_ack`;
  - ownership periods → `band_assignments`;
  - escalation / sender / push tokens → SNS → APNs / FCM;
  - `tenant-isolation.spec.ts` → tenant-routing tests (one tenant DB per request);
  - `internal-service.guard.ts` → internal API guard (token + allow-list);
  - pipeline status → staff readiness; timeline → console alert timeline;
  - migrations run per tenant DB;
  - `auth`, `email` and `health` services → modules (no gRPC).
- **Replace:** custom JWT and the B2C patient model → Cognito pool per tenant + tenant routing (no row-level security needed); vital sync over the gateway socket → IoT Core → SQS; the Koyeb container → ECS.
- **Drop:** the cloud alert writer that derives alerts from vitals (D-08), the `nurse/` chat proxy, the empty `apps/back-end` scaffold.
- **Moves to the gateway:** the moisture-episode state machine and its tests.
- Full list: `../b2b-plan/17-Old-Code-Carry-Over.md` §3.1.
