# CLAUDE.md: sotercare-backend

## What this repo is
The **core platform**: a NestJS 11 modular monolith deployed on ECS as two services from one codebase:
- `api`: REST + Socket.IO;
- `worker`: SQS consumers, re-push loop, escalations, rollups, outbox.

It owns:
- tenancy, roles and row-level security;
- facilities / wards / rooms / residents, staff, **shifts**, family accounts;
- gateways and bands;
- the **alert mirror**, cloud push and escalation;
- dashboards and metrics;
- the internal API for agents.

Specs: `b2b-plan/01`, `02`, `03`, `05`.

## Current stage
Only the starter README is here. Next, in order (Phase 0–3 in `b2b-plan/04`):
1. Bring in old `back-end` history from `phase-1/alert-reliability` (`642c642`, fast-forwards old `main`), leaving out `apps/ai-summary-service` and `contracts/`. Merge with `--allow-unrelated-histories`.
2. Collapse `api-gateway` + `auth-service` + `email-service` + `health-service` into modules. Remove the gRPC hops. Delete the empty `apps/back-end`.
3. Cognito auth, org → facility → ward → room → resident tenancy, row-level security + tenant-isolation tests, migrations only.
4. SQS ingest of `alert_record` / `telemetry` (idempotent on `recordId`), `record_ack` after commit, alert mirror, dashboard WebSocket.
5. Shifts (alerts go to everyone whose shift time is now; availability is display only), local credentials, shadows.
6. Cloud push through SNS → APNs/FCM, claim forwarding, manager and ward-head escalation.
7. Rollups, family incident API, internal agents API.

**Carry over** (see `README.md` Origin): the dispatch outbox, alert audit, migration pattern, tenant-isolation tests, internal-service guard, socket revocation, notification attempts, test support.
**Remove** the cloud alert writer that derives alerts from vitals. **Move** the moisture-episode state machine to the gateway.

## Connections
| Direction | Repo | Via | What |
|---|---|---|---|
| in | `sotercare-edge-gateway` | IoT Core → SQS | `alert-record`, `telemetry`, `band-status`, `heartbeat`, `ack` |
| out | `sotercare-edge-gateway` | IoT Core | `record_ack`, `cmd/claim`, named shadows `roster` / `bands` / `policy` / `keys`, IoT Jobs (OTA) |
| out | `sotercare-console` | REST `/v1` + Socket.IO | live floor, alert board, shifts, admin, agent outputs, review queue, "why" view |
| out | `sotercare-mobile` | REST `/v1` + Socket.IO + SNS push | alerts, claim / release / resolve, manager view, shifts, family history, local credential (`GET /me`) |
| out | `sotercare-agents` | core outbox → SQS, S3 Parquet, internal API `/internal/v1` | domain events, rollups, read tools (per-agent allow-list enforced here) |
| in | `sotercare-agents` | internal API | outputs, proposals, cover requests, case traces |
| uses | `sotercare-contracts` | npm | every payload type |
| deployed by | `sotercare-infra` | ECS, RDS, ElastiCache, SQS, SNS, Cognito | — |

## Rules
- **Never derive fall / SOS / moisture alerts from telemetry** (D-08). Alerts arrive only as gateway `alert_record`s
- Migrations only (`synchronize: false`); every table has `org_id`, plus row-level security
- Ack to the gateway only after the DB commit; idempotent on `recordId`
- No attendance tracking; connectivity is display only and purged after 48 h (D-17)
- Family endpoints return **resolved incidents only**, attributed to "care staff" (D-13)
- Enforce each agent's tool allow-list and scope on every internal API call; there is never an alerts endpoint for agents

## How the SoterCare B2B platform fits together

**Plan:** `D:\SoterCare\Github-B2B\b2b-plan\` (docs 01–07; not in a repo yet).
- `D-xx` refers to its decision log and `O-x` to its open items (`04-Repos-and-Roadmap.md` §5).
- `07-Old-Repo-Mapping.md` says which old code each repo starts from.

```
sotercare-pcb-designs ── board for ──► sotercare-firmware (thigh band, ~60 per facility)
band ── facility Wi-Fi, local link (transport: open item O-5) ──► sotercare-edge-gateway (1 per facility)
staff phones ◄── local MQTT over WSS (alerts, claims, presence) ── gateway
gateway ── AWS IoT Core → SQS (alert-record, telemetry, heartbeat) ──► sotercare-backend
backend ── record_ack, shadows (roster / bands / policy / keys), cmd/claim ──► gateway
backend ── REST + Socket.IO ──► sotercare-console, sotercare-mobile
backend ── SNS → APNs / FCM push ──► sotercare-mobile
backend ── outbox → SQS events, S3 Parquet export, internal API ──► sotercare-agents
agents ── outputs / proposals / case traces (internal API) ──► backend
sotercare-contracts ── schemas + generated types ──► firmware, gateway, backend, agents, console, mobile
sotercare-infra ── provisions and deploys ──► AWS (IoT Core, ECS, RDS, Cognito, SNS, S3, Bedrock)
sotercare-studio ── records ──► sotercare-iot-dataset ── trains ──► sotercare-ml ── models ──► firmware, gateway
sotercare-website (sotercare.com), sotercare-links (links.sotercare.com): standalone
```

**Platform rules (every repo):**
- **The gateway is the only real-time safety rule engine and claim arbiter** (D-08).
  - The cloud never derives fall / SOS / moisture alerts from telemetry.
  - Agents never create or change alerts.
- **Wellness product** (D-06): no "medical", "diagnosis" or clinical-threshold wording in code, UI or docs.
- **Every cross-repo message is defined in `sotercare-contracts`.** Pin a version and run contract tests. Never keep a local copy of a schema.
- **Tenancy:** every record carries `org_id` (and `facility_id` where relevant). The backend enforces row-level security.
- **AWS `ap-south-1`** (Mumbai). **Amazon Bedrock** is the only LLM provider (D-07).
- **Build from the old repos' work** (D-20). Keep git history when moving code in. Rewrite only what the B2B design changes.

**Git and commits:**
- Trunk-based, protected `main`, PRs with CI (lint, typecheck, tests, contract tests).
- Conventional commits (`feat:`, `fix:`, `docs:`…).
- **Never add `Co-Authored-By:` or any AI-attribution trailer to commits.**
- No secrets in git. Use env files that are git-ignored locally, and AWS Secrets Manager in the cloud.

