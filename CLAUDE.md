# CLAUDE.md: sotercare-backend

## What this repo is
The **core platform**: a NestJS 11 modular monolith on ECS (shared, stateless), deployed as two services from one codebase (`b2b-plan/02` §2–3):
- `api`: REST `/v1` (tenant pools), `/v1/ops` (ops pool), `/internal/v1` (agents and ARIA), Socket.IO;
- `worker`: SQS ingest, cloud push for gateway-timed rounds and escalations, rollups, domain-event outbox, billing timeline, tenant-timed triggers.

It owns:
- **Tenant routing** (D-31, D-57; `03` §3): the tenant comes from the token issuer (pool → tenant), never a claim; one per-tenant DB pool per request; the control DB; the per-tenant migration runner (D-56, `03` §5). **Per-tenant databases replace row-level security.**
- **Auth and accounts** (`04`): a Cognito pool per tenant + the ops pool; `name@tenantId` usernames; staff and family accounts **created by a manager with a temporary password** and a login slip, manager resets, account recovery (D-28, D-58–D-60). No self sign-up, no e-mail invites.
- Org → facility → ward → room → bed → resident; residents (each with a **`residentNo`**, e.g. `R-0012`, assigned at admission, D-99), alert bars, Pause, discharge (with a **per-family-account choice**: read-only period or deactivate now, D-101), settings, alert-policy versions + sign-off (`07` §3, §4.5, §8; `09`).
- **Instant pairing** (D-99, `05` §3): one-time band provisioning to the facility (sealed bundle; manager / org admin, or `platform_support` via ops), the **band pool** (`GET /bands?status=available`), assign / unassign / swap per resident and `identify` (`cmd/band`), each written to the `bands` shadow at once (**< 10 s** to applied on the gateway).
- **Medication records and reminders** (D-98, `21`): medications + schedules per resident (versioned, audited), **each created or changed only with a linked doctor's recommendation** (`doctorRecommendationId` required, 422 `doctor_recommendation_required`, D-111) and written to the append-only **medication log**, due doses 48 h ahead, ward **rounds**, reminder pushes on the `medication` channel (`medication_round_due` / `medication_overdue`, no names), dose marking + undo, PRN entries, `not_recorded` / `resident_away`, MAR view + PDF, the app's offline schedule (`GET /me/medication-schedule`), WS `dose.updated`; the internal `medication_counts` tool (counts only). Keeps working while suspended (D-64).
- **Medical records tab** (D-112, `21` §10): per-resident items (picture / file / reference / text; categories; versions, old ones kept), presigned S3 upload into the tenant prefix under the tenant KMS key, virus scan + thumbnails before anything is served, presigned downloads; ward heads / managers upload, staff view, family never. Only `care_plan` items reach the internal API (Care Plan Specialist) and `document.uploaded`.- Shifts, alert recipients, availability (display only), shift notifications (`08`).
- **Alert mirror:** SQS ingest of every gateway record (live and `backlog`), `record_ack` after commit (D-84); cloud push via SNS for the gateway's re-push and escalation records (only records fresher than 120 s); claim forwarding, with REST actions waiting ≤ 3 s for the gateway, else 202 provisional (D-85). **The gateway runs every timer**; the backend runs only provisional-claim timers and `gateway_offline` (D-81; `07` §5.2).
- **Shadows** `roster`, `bands`, `residents`, `policy`, `keys`, `service`; the local credential (Ed25519, `04` §5); band keys and sealed provisioning bundles (`06` §4, §6).
- Dashboards, metrics, the family API (`10` §6: real incident type, outcome and response time, false alarms as `checked_no_issue`, rates count `real` only, D-101), per-person family unlink / deactivate, and ARIA endpoints.
- **Family live view** (D-114, `10` §2.1): `GET /family/residents/{id}/live` and the Socket.IO room `family:{tenantId}:{residentId}` (joined by the backend after the link check; family sockets join nothing else), `family_live_status` derived from telemetry and alert records (activity, band worn, temperature relative to usual, "care staff are attending" while a sensor alert is claimed), ≤ 15 s; never unclaimed alerts or wet-pad state; `away` while paused, off while suspended; facility switch "Family live view" (default on).
- **Family ARIA chats are private** (D-113): no staff endpoint reads or exports them (not `/aria/history`, `/audit`, `/exports` or data-request exports); the audit stores metadata only (who, when, resident, length). The **family weekly brief auto-publishes Monday 08:00 with no hold** (D-51): there's no hold endpoint.
- The gateway registry keyed by the **serial-derived `gatewayId`** (`gw_` + serial), bound to one tenant at enrolment (D-100).
- **Billing and suspension** (`12`): invoices, PayHere checkout / recurring / webhooks, credit notes, the non-payment timeline.
- **Ops API** `/v1/ops` (`13`): **tenant provisioning** (starts the Step Functions job, retry / discard), onboarding, organisations, fleet, band stock, rollouts (IoT Jobs), billing overview, support grants, data requests.
- **Internal API** for agents and ARIA (`14` §7, `11` §8): per-case Ed25519 token, **each agent's tool allow-list checked on every call**, domain-event outbox, pseudonymised Parquet export.

Plan docs (`16` §3): 03, 04, 05 §2–5, 06 §4, 07, 08, 09, 10, 11 §4–5 + §8–9, 12, 13, 14, 15, 21, and `17` §3.1.

## Current stage / next work
Only the starter README and this file are here. Next (`18`):
1. **Day 0:** cut-over (`17` §3.1, §5): `git filter-repo` on old `back-end` `phase-1/alert-reliability` (`642c642`) without `apps/ai-summary-service` and `contracts`, then merge with `--allow-unrelated-histories`. Write `docs/spec.md` + `docs/plan.md` (`18` §11), RC vs follow-on marked.
2. **Two builder lanes in one SerenEdge project** (D-78, `18` §5.1):
   - **B1 devices and alerts** (critical path, `18` §5.2): skeleton, tenant routing, per-tenant migrations, auth, `GET /auth/tenant`, `GET /me`; seed tool (Day 3); `POST /v1/ops/tenants` (Day 4); SQS ingest + `record_ack`, alert mirror, WebSocket, residents (+ `residentNo`) + alert settings, bands + provisioning bundle + band keys, **band pool + assign / unassign / swap + identify (< 10 s to the gateway)**, shadow publisher (all six), local credential + `keys`, shifts, SNS push, claim forwarding, `gateway_offline`. Then the rest of `/v1/ops`; load tests.
   - **B2 people, money, AI** (from Day 3): staff / family accounts, station PIN, login slip, settings + policy sign-off, synth tool (Day 6); family API (D-101 incidents, per-account unlink / deactivate / discharge choice), **medications (`21`: records, dose generation, rounds, reminder pushes, mark / undo / PRN, MAR + PDF, offline schedule, `medication_counts`)**, **Medical records tab** (presigned upload, scan, versions) and the doctor's-recommendation check + medication log, the **family live view** (endpoint + family room), billing + PayHere + invoice PDFs + SES, suspension, internal API + allow-lists, domain-event outbox, Parquet export, ARIA endpoints, audit, exports.
3. Checkpoints that depend on this repo: Days 3, 5, 6, 8–12 (`18` §6). Stand-ins it ships: seed tool, synthetic history, PayHere webhook replayer, fake push provider (`18` §4). Follow-on: fixes from the external penetration test.

What to keep / adapt / drop from the old code: `README.md` Origin and `17` §3.1.

## Connections
| Direction | Repo | Via | What |
|---|---|---|---|
| in | `sotercare-edge-gateway` | IoT Core → SQS | `alert-record`, `band-status`, `cmd-res`, `url-req`, `telemetry`, `gait-events`, `logged-events`, `sensor-window`, `connectivity`, `heartbeat`, shadow reports; buffered / resync records on `backlog` (separate queue, never delays live) |
| out | `sotercare-edge-gateway` | IoT Core | `record_ack`, `cmd/claim`, `cmd/url`, `cmd/resync`, `cmd/band`, the six named shadows (S3 above 7 KB, D-83), IoT Jobs (OTA, gait model) |
| in/out | `sotercare-console` | REST `/v1` via its BFF + Socket.IO | live floor, alerts, residents, shifts, admin, billing, agent outputs, ARIA |
| in/out | `sotercare-mobile` | REST `/v1` + Socket.IO; SNS → APNs / FCM | `GET /me` (local credential, gateway address + fingerprint), alerts, provisioning bundles, family API, ARIA |
| in/out | `sotercare-ops-console` | REST `/v1/ops` (ops pool) | tenants, provisioning, onboarding, fleet, rollouts, billing, health, support, data requests |
| out/in | `sotercare-agents` | outbox → SQS, S3 Parquet, `/internal/v1`; calls the agents service API for ARIA | triggers; read tools; outputs, proposals, cover requests, case traces, ARIA messages |
| in | PayHere | `POST /webhooks/payhere` | verified, idempotent payment events |
| uses | `sotercare-contracts` | npm `@sotercare/contracts` (GitHub Packages) | every payload, shadow and API type |
| deployed by | `sotercare-infra` | ECS, control DB + per-tenant RDS, Cognito pools, SQS, SNS, SES, Step Functions | — |

## Rules
- **Never derive safety alerts from telemetry** (D-08). Only `gateway_offline` is raised in the cloud. A replayed backlog never re-alerts phones.
- **Tenant isolation** (`03` §3): tenant from the issuer only; no code path holds two tenant connections; Redis keys `t:{tenantId}:…`; WebSocket rooms joined server-side; the IoT tenant comes from the registry, never the payload. Cross-tenant tests in CI (`18` §9 scenario 6).
- Migrations only (`synchronize: false`), expand-only per release (D-56).
- `record_ack` only after the tenant-DB commit; idempotent on `recordId`; ack `suspended` while suspended (`12` §5).
- **Suspended:** AI and cloud record keeping stop; safety and access writes stay open; cloud alert push continues (D-64).
- No attendance tracking; availability purged after 48 h (D-17).
- Family endpoints: one linked resident per call (and per live room), resolved `real` incidents only, "care staff" (D-13, `10`). Family ARIA chats: no staff read or export path; audit metadata only (D-113).
- Internal API: check the `agent` claim against its allow-list on every call; return `tenant_suspended`; **never an alerts endpoint**; **no medication field except `medication_counts` counts** (D-49, D-98). Medication data never goes to Bedrock, Parquet exports, push text or the gateway. **Medical records: only `care_plan` items via `care_plan_document`** (D-112; contracts CI rule + a contract test).
- Staff-facing payloads carry the resident's name + `residentNo`, never `bandId` (D-99), except an unassigned band's alert (`bandLabel`).
- The last active manager can't be deactivated (D-60); org admins are managed only by `platform_admin` or other org admins (D-59).
- PayHere webhooks: verified, idempotent, forward-only (D-63). Timers and billing dates use an injectable clock.
- Logs carry IDs only: no names, notes, health values or tokens.

## How the SoterCare B2B platform fits together

**Plan:** `D:\SoterCare\Github-B2B\b2b-plan\` (v2: docs 01–22, one topic per file; 22 = design system, tokens in `sotercare-contracts/design/`).
- Start with `README.md`, `01-Product-and-Scope.md` and `02-System-Architecture.md`.
- Which docs this repo needs: `16-Repos-and-Ownership.md` §3.
- `D-xx` / `O-x` refer to `19-Decisions-and-Open-Items.md`, the decision log. **When docs disagree, 19 wins.**
- Old code to start from: `17-Old-Code-Carry-Over.md`.
- Build order and checkpoints: `18-Build-Plan-2-Weeks.md` ("Build Plan to 28 Nov"):
  - **Day 0 gate 18–19 Nov** (every repo's spec + plan, SerenEdge projects, cut-over), then dated daily checkpoints CP1–CP8 (20–27 Nov);
  - **development complete on 28 Nov 2026** (D-115): all 37 acceptance scenarios green on simulators, ESP32-C6 dev kits / Rev A boards and a Pi 5 gateway;
  - if a checkpoint slips, the **cut order** in 18 §10.2 applies (D-116); the safety core is never cut.

**SerenEdge (D-103):** no new repos. **Each repo is one SerenEdge project**, and projects are connected through SerenEdge's **linked knowledge bases**, so any project can ask another's.
- The **`sotercare-contracts` project is the hub:** its knowledge base holds the full b2b-plan, which is committed into `sotercare-contracts/docs/b2b-plan/` at the Day 0 gate.
- Every other project links the hub's knowledge base (and the projects it talks to), instead of copying plan text.

```
sotercare-pcb-designs ── Rev A board (Rev B = pilot band, D-102) ──► sotercare-firmware (thigh band)
band ── UDP + AES-CCM over facility Wi-Fi (06) ──► sotercare-edge-gateway (= nurse station, 1 per home)
staff phones ◄── local MQTT over WSS (alerts, claims, presence) ── gateway
gateway ── MQTT/TLS to AWS IoT Core → SQS (Wi-Fi or LTE) ──► sotercare-backend
backend ── record_ack, shadows (roster / bands / residents / policy / keys / service), cmd/claim ──► gateway
backend ── one RDS database per tenant (silo) + control DB
backend ── REST + Socket.IO ──► sotercare-console (facility), sotercare-mobile (Care staff / Family)
backend ── medication records, dose rounds, marks, MAR (21; not alerts, never via the gateway) ──► console, mobile
backend ── SNS → APNs / FCM push (alerts; medication round reminders) ──► sotercare-mobile
backend ── REST /v1/ops ──► sotercare-ops-console (SoterCare staff)
backend ── outbox → SQS events, S3 Parquet, internal API (medication: counts only) ──► sotercare-agents (agents + ARIA; GitHub `sotercare-iit`, D-125)
sotercare-contracts ── schemas + generated types; SerenEdge hub (b2b-plan) ──► firmware, gateway, backend, agents, consoles, mobile
sotercare-infra ── provisions AWS + per-tenant resources ──► all cloud parts
sotercare-studio ── records ──► sotercare-iot-dataset (data + model training) ── gait model ──► gateway
sotercare-website (sotercare.com), sotercare-links (links.sotercare.com): standalone
```

**Platform rules (every repo):**
- **The gateway is the only real-time safety rule engine and claim arbiter** (D-08).
  - The cloud never derives alerts from telemetry.
  - Agents never create or change alerts.
- **Wellness wording** (D-06): no "medical", "diagnosis", "fever" or clinical thresholds.
- **Medications are records and reminders only** (D-98, `21`): never advice; no agent, ARIA output or push text names a medication (D-49).
- **Staff screens show the resident's name + resident number (`residentNo`), never band IDs** (D-99); band IDs only in Devices admin.
- **Every cross-repo message is defined in `sotercare-contracts`.** Pin a version and run contract tests; never copy schemas.
- **Silo tenancy** (D-31): one tenant per request / case; never hold two tenants' data in one operation.
- **AWS `ap-south-1`**; **Bedrock** is the only LLM provider (D-07).
- **Translation-ready UI** (D-26): no hard-coded user-facing strings.
- **Build from the old repos' work** (D-20), keeping git history.

**Git and commits:**
- Protected `main`, PRs with CI (lint, typecheck, tests, contract tests against the pinned contracts version). SerenEdge tasks merge to `dev`; a release PR moves `dev` → `main` (O-23).
- Conventional commits (`feat:`, `fix:`, `docs:`…).
- **Never add `Co-Authored-By:` or any AI-attribution trailer to commits.**
- No secrets in git; AWS Secrets Manager in the cloud.
