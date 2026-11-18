# Backend Task Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Developers build this plan through SerenEdge tasks (key `SOTERCAR`), one task per section below.

**Goal:** Turn `docs/plan.md` (Tasks 0–41) into SerenEdge tasks for `sotercare-backend`, in the right order, without changing any product behaviour.

**Architecture:** The detailed steps, files, tests and dates stay in `docs/plan.md`. This plan is the SerenEdge layer on top. Each section below is one SerenEdge task that names its source plan task and spec sections, what it depends on, which test task covers it, and what a reviewer must check. A CI foundation task comes first.

**Tech Stack:** NestJS 11, TypeScript 5, TypeORM 0.3, PostgreSQL 16, Redis 7 + BullMQ, Socket.IO 4, AWS SDK v3, `@sotercare/contracts`, Jest, docker compose.

**Spec:** `docs/superpowers/specs/2026-11-19-backend-task-breakdown-design.md`, which points at `docs/spec.md`, `docs/spec-part2-people-and-care.md`, `docs/spec-part3-family-ai-money-ops.md` and `docs/plan.md`.

## Global Constraints

- One SerenEdge task is one pull request off `dev`, on `task/SOTERCAR-<n>-<slug>`. Commits are `SOTERCAR-<n>: summary`. No AI attribution anywhere.
- Tasks the Head chose to keep whole set `allowLarge: true`: t3, t5, t10, t11, t12, t17, t21, t26, t31, t34, t37, t41.
- Every task's global rules are the "Global Constraints" in `docs/plan.md` (tenant source, `record_ack` after commit, no alerts from telemetry, no band-assignment writes, internal-API and medication boundaries, IDs-only logs, injected `Clock`).
- The limits in `docs/plan.md` hold: 5 connections per tenant per container, claim wait 3 s, push freshness 120 s, `gateway_offline` at 90 s then every 10 min, presigned URLs ≤ 15 min, service token TTL 15 min, local credential 30 days.
- Migrations only (`synchronize: false`), expand-only. Types come only from `@sotercare/contracts`.
- Points pricing is off: tasks carry `estimateHours` only.
- No new frameworks or dependencies without asking.

## Review Focus

The ten failure modes listed in `docs/plan.md` ("Review Focus") stay in force. Each task section below names the one it owns:

1. Duplicate `recordId` after a lost ack → `duplicate` ack, no second push (t5).
2. Out-of-order records → mirror ends at the highest `seq` / `assignmentSeq` (t5, t12).
3. Cognito JWKS unreachable → cached keys work; unknown `kid` → 401, never 500 (t3).
4. Worker crash between commit and ack → redelivery acks `duplicate` (t5).
5. Service token for tenant A with a tenant B resident ID → 403, no query on B (t6).
6. Offline dose mark replay → idempotent; a different mark → 409 `dose_already_marked` (t26).
7. Family unlinked while watching Live now → removed from the room at once (t31).
8. PayHere out-of-order or duplicate webhooks → one payment, one restore (t35).
9. Suspended tenant edits still reach the gateway (t36).
10. Discharge omitting a linked family account → 422 `family_access_choice_required` (t21).

---

## Part 1: Tier 2 backend core and safety core

### Task 0: CI foundation
SerenEdge task: SOTERCAR-1 (t0).
Source: `docs/plan.md` Task 0 (CI part only; import and restructure are already in `main`).
Depends on: nothing. Every other task depends on it.
Delivers `.serenedge/ci.json`, a local CI command (lint, typecheck, unit, integration, build with a step marker per step), a GitHub workflow on pull requests into `main` only, `.serenedge/review.json` sensitive paths (auth, internal API guard, billing), and an `environment` KB entry on running CI locally.

### Task 1: Core config clock context errors idempotency logging
SerenEdge task: SOTERCAR-2 (t1).
Source: `docs/plan.md` Task 1; spec §3, §6, §14. Lane B1, Fri 20 Nov. Depends on: t0.
Delivers config, the injected `Clock`, `TenantContext`, the error model, idempotency keys and ID-only logging.

### Task 2: Control DB tenant registry and migration runner
SerenEdge task: SOTERCAR-3 (t2).
Source: Task 2; spec §6. Lane B1, Sat 21 Nov. Depends on: t1.
Delivers the control DB, `TenantRegistry` (per-tenant pool, 5 connections, 60 s cache), the per-tenant migration runner and local provisioning. Flags: migrations, infra.

### Task 3: Auth guard roles tenant and me
SerenEdge task: SOTERCAR-4 (t3).
Source: Task 3; spec §7. Lane B1, Sat 21 Nov. Depends on: t2. Owns Review Focus 3.
Delivers the Cognito guard (JWKS cache), roles, `GET /auth/tenant` and `GET /me`. `allowLarge`.

### Task 4: Org model and demo seed
SerenEdge task: SOTERCAR-5 (t4).
Source: Task 4; spec §13, §9 (bands entity), §11 (read side). Lane B1, Sat 21 Nov. Depends on: t3.
Delivers the org → facility → ward → room → bed → resident model and `seed:demo`.

### Task 5: Ingest record ack alert mirror telemetry rollups
SerenEdge task: SOTERCAR-6 (t5).
Source: Task 5; spec §8. Lane B1, Sun 22 Nov. Depends on: t2, t4. Owns Review Focus 1, 2 and 4.
Delivers SQS ingest (live and `backlog` queues), `record_ack` after commit, the alert mirror, telemetry and rollups. `allowLarge`.

### Task 6: Service token and internal API guard
SerenEdge task: SOTERCAR-7 (t6).
Source: Task 6; spec §7, §11. Lane B3, Sun 22 Nov. Depends on: t3. Owns Review Focus 5.
Delivers the Ed25519 per-case service token (TTL 15 min), the `agent` claim check against `x-sc-agents`, and `tenant_suspended`.

### Task 7: Internal read tools
SerenEdge task: SOTERCAR-8 (t7).
Source: Task 7; spec §11. Lane B3, Mon 23 Nov. Depends on: t6, t4.
Delivers the agents' read tools. No alerts endpoint, no medication field.

### Task 8: Internal writes
SerenEdge task: SOTERCAR-9 (t8).
Source: Task 8; spec §11. Lane B3, Mon 23 Nov. Depends on: t7.
Delivers the agents' write endpoints with the allow-list checked on every call.

### Task 9: Outbox to SQS domain events and schedule_event
SerenEdge task: SOTERCAR-10 (t9).
Source: Task 9; spec §11. Lane B3, Tue 24 Nov, milestone T2-1. Depends on: t8, t5.
Delivers the transactional outbox, SQS domain events and `schedule_event`.

### Task 10: Local credential keys and the six shadows
SerenEdge task: SOTERCAR-11 (t10).
Source: Task 10; spec §7, §10. Lane B1, Mon 23 Nov, safety core. Depends on: t4.
Delivers the Ed25519 local credential (30 days), the `keys` shadow and the six shadows (`roster`, `bands`, `residents`, `policy`, `keys`, `service`), with S3 offload above 7 KB. `allowLarge`.

### Task 11: Alert actions claims push escalation gateway_offline
SerenEdge task: SOTERCAR-12 (t11).
Source: Task 11; spec §8, §10. Lane B1, Tue 24 Nov, safety core. Depends on: t5, t10.
Delivers claim forwarding (3 s wait, else 202 provisional), SNS push for records fresher than 120 s, escalation and `gateway_offline` (90 s, then every 10 min). `allowLarge`.

### Task 12: Bands provisioning bundles and assignment mirror
SerenEdge task: SOTERCAR-13 (t12).
Source: Task 12; spec §9. Lane B1, Tue 24 Nov. Depends on: t5, t10. Owns Review Focus 2 (assignment side).
Delivers band stock, sealed provisioning bundles, band keys, `identify`, and the read-only assignment mirror with 409 `assign_via_gateway`. `allowLarge`.

### Task 13: v1 agent outputs and Socket.IO
SerenEdge task: SOTERCAR-14 (t13).
Source: Task 13; spec §12. Lane B3 outputs and B1 realtime, Wed 25 Nov. Depends on: t8, t9.
Delivers the `/v1` agent-output endpoints and the Socket.IO events. Rooms are joined server-side only.

### Task 14: Parquet export
SerenEdge task: SOTERCAR-15 (t14).
Source: Task 14; spec §11. Lane B3, Wed 25 Nov. Depends on: t7.
Delivers the pseudonymised Parquet export with no medication data.

### Task 15: Seed import of the iit generator output
SerenEdge task: SOTERCAR-16 (t15).
Source: Task 15; spec §13. Lane B1, Thu 26 Nov. Depends on: t4, t8.
Delivers the importer for the `sotercare-iit` generator output.

### Task 16: Part 1 isolation response scans and T2-2 acceptance
SerenEdge task: SOTERCAR-17 (t16).
Source: Task 16; spec §2, §14. Lane X2 + B3, Thu 26 – Fri 27 Nov, milestone T2-2. Type `test`. Depends on: t5–t15.
Delivers cross-tenant tests, response-shape scans and the T2-2 acceptance run. SerenEdge allows one tested task per test task, so `testedBy` links it to t6 (SOTERCAR-7) only; the other Part 1 tasks carry their own tests.

## Part 2: people and care

### Task 17: Staff accounts org admins MFA gate login type
SerenEdge task: SOTERCAR-18 (t17).
Source: Task 17; spec §16.1–§16.3. Lane B2, Sun 22 Nov. Depends on: t3. `allowLarge`.

### Task 18: Family accounts links and me notices
SerenEdge task: SOTERCAR-19 (t18).
Source: Task 18; spec §16.4–§16.5. Lane B2, Sun 22 Nov. Depends on: t17.

### Task 19: Station PIN and readiness
SerenEdge task: SOTERCAR-20 (t19).
Source: Task 19; spec §17. Lane B2, Mon 23 Nov. Depends on: t17.

### Task 20: Facility settings groups and side effects
SerenEdge task: SOTERCAR-21 (t20).
Source: Task 20; spec §18.1. Lane B2, Sun 22 Nov. Depends on: t3.

### Task 21: Layout residents alert settings pause transfer discharge hold consent
SerenEdge task: SOTERCAR-22 (t21).
Source: Task 21; spec §19. Lane B2, Mon 23 Nov. Depends on: t4, t20. Owns Review Focus 10. `allowLarge`.

### Task 22: Alert policy versions and sign-off
SerenEdge task: SOTERCAR-23 (t22).
Source: Task 22; spec §18.2. Lane B2, Mon 23 Nov. Depends on: t20.

### Task 23: Shift administration publishing coverage
SerenEdge task: SOTERCAR-24 (t23).
Source: Task 23; spec §20.1–§20.2. Lane B1, Mon 23 Nov. Depends on: t4.

### Task 24: Availability schedulers notifications
SerenEdge task: SOTERCAR-25 (t24).
Source: Task 24; spec §20.3–§20.6. Lane B1, Tue 24 Nov. Depends on: t23.

### Task 25: Medical records
SerenEdge task: SOTERCAR-26 (t25).
Source: Task 25; spec §22. Lane B2, Tue 24 Nov. Depends on: t21. Only `care_plan` items reach agents.

### Task 26: Medications records log doses marking
SerenEdge task: SOTERCAR-27 (t26).
Source: Task 26; spec §21.1–§21.3, §21.5, §21.7. Lane B2, Tue 24 Nov. Depends on: t21. Owns Review Focus 6. `allowLarge`.

### Task 27: Medication rounds reminders offline schedule MAR
SerenEdge task: SOTERCAR-28 (t27).
Source: Task 27; spec §21.4, §21.6. Lane B2, Wed 25 – Thu 26 Nov. Depends on: t26.

### Task 28: Medication boundary for agents
SerenEdge task: SOTERCAR-29 (t28).
Source: Task 28; spec §21.8. Lane B3, Wed 25 Nov. Depends on: t26, t7.

### Task 29: Voice notes
SerenEdge task: SOTERCAR-30 (t29).
Source: Task 29; spec §23. Lane B2, Thu 26 Nov. Depends on: t21.

### Task 30: Audit exports data requests erasure retention
SerenEdge task: SOTERCAR-31 (t30).
Source: Task 30; spec §24. Lane B2, Thu 26 Nov. Depends on: t21, t17. Family ARIA chats have no staff read path (D-113).

## Part 3: family, AI, money and ops

### Task 31: Family API FamilyFacts and Live now feed
SerenEdge task: SOTERCAR-32 (t31).
Source: Task 31; spec §26. Lane B2, Tue 24 – Wed 25 Nov. Depends on: t18, t5, t21. Owns Review Focus 7. `allowLarge`.

### Task 32: Live view resident status trends metrics
SerenEdge task: SOTERCAR-33 (t32).
Source: Task 32; spec §25. Lane B1, Wed 25 Nov. Depends on: t31.

### Task 33: Agent plumbing cover requests proposals schedules budget
SerenEdge task: SOTERCAR-34 (t33).
Source: Task 33; spec §29. Lane B3, Wed 25 Nov. Depends on: t8, t9.

### Task 34: Billing core bed-days invoices PDF e-mail
SerenEdge task: SOTERCAR-35 (t34).
Source: Task 34; spec §30.1–§30.2, §30.7. Lane B3, Thu 26 Nov. Depends on: t21, t12. `allowLarge`.

### Task 35: PayHere provider and payments
SerenEdge task: SOTERCAR-36 (t35).
Source: Task 35; spec §30.3. Lane B3, Thu 26 Nov. Depends on: t34. Owns Review Focus 8.

### Task 36: Suspension state machine and restore
SerenEdge task: SOTERCAR-37 (t36).
Source: Task 36; spec §30.4–§30.6. Lane B3, Thu 26 Nov, safety core. Depends on: t35, t10. Owns Review Focus 9.

### Task 37: Ops tenants provisioning approvals onboarding organisations recovery
SerenEdge task: SOTERCAR-38 (t37).
Source: Task 37; spec §31.1–§31.4, §31.6. Lane B3, Sun 22 – Thu 26 Nov. Depends on: t2, t3. `allowLarge`.

### Task 38: Ops fleet stock enrolment active gateway restore-db billing ops
SerenEdge task: SOTERCAR-39 (t38).
Source: Task 38; spec §31.2, §31.5, §31.7. Lane B3 + B1, Thu 26 Nov. Depends on: t37, t12.

### Task 39: Ops rollouts usage health announcements support access
SerenEdge task: SOTERCAR-40 (t39).
Source: Task 39; spec §31.7, §31.8, §32. Lane B3, Thu 26 – Fri 27 Nov. Depends on: t37.

### Task 40: ARIA endpoints and family weekly e-mail
SerenEdge task: SOTERCAR-41 (t40).
Source: Task 40; spec §27, §28. Lane B3, INT Mon 30 Nov – Tue 1 Dec, milestone INT. Depends on: t33, t31.

### Task 41: Part 2 and 3 isolation and acceptance
SerenEdge task: SOTERCAR-42 (t41).
Source: Task 41; spec §33. Lane X2 + B2 + B3, Fri 27 – Sat 28 Nov, milestone CP9. Type `test`. Depends on: t17–t40. SerenEdge allows one tested task per test task, so `testedBy` links it to t31 (SOTERCAR-32) only; the other Part 2 and 3 tasks carry their own tests. `allowLarge`.

---

## Self-review

- **Spec coverage:** Each spec goal maps to a section: CI foundation (t0), 41 mapped tasks, two acceptance test tasks (t16, t41), milestones T2-1 (t9), T2-2 (t16), CP9 (t41), INT (t40), and the security flags in the spec's "Security and manual work".
- **Placeholders:** none. Every section names its source plan task, spec sections, lane, date and real dependencies.
- **Consistency:** task IDs `t0`–`t41` match plan task numbers 0–41. `testedBy` targets are t16 (Part 1) and t41 (Parts 2 and 3).
- **Review Focus:** all ten failure modes have an owning task.
- **Proportion:** the detail stays in `docs/plan.md`; this plan adds only the SerenEdge mapping.

## Task analysis

Format per task: **Flags** (`securityFlags`), **Lane** (human or auto, and why), **Hours**, **Tested by**, **Manual** (owner, proof, env var), **KB seeds**.
Lane rule: a task goes to a human reviewer when it has manual work, a CI change or any flag. Auto Mode never claims a task with manual steps. Env vars are set per environment (`dev`, `prod`); region is `ap-south-1`. Secrets live in AWS Secrets Manager, never in git. All env var names and values below are my proposals; `devops` confirms them against `sotercare-infra`.

### Part 1

- **t0 CI foundation**: Flags infra. Lane human (CI change, manual). 6 h. Tested by: none, it is the test harness (`serenedge ci` passing on its own branch is the check). Manual: (1) `head`, `note`: protect `main` and `dev` on GitHub (PR required, CI required, no force push), 0.5 h. (2) `devops`, `secret`, `GH_PACKAGES_TOKEN`, account owner SerenEdge GitHub org: token with `read:packages` for `@sotercare/contracts`, 0.5 h. KB: `setup` "CI and GitHub Packages access"; `environment` "Run CI locally".
- **t1 Core**: no flags. Lane auto. 6 h. t16. No manual. KB: `glossary` "TenantContext", "Clock"; convention "IDs-only logs".
- **t2 Control DB, registry, migrations**: migrations, infra. Human. 10 h. t16. Manual: `devops`, `env`, `CONTROL_DB_URL`, account owner SerenEdge AWS, 0.5 h. KB: `glossary` "TenantRegistry"; `setup` "Control DB".
- **t3 Auth**: auth. Human. 12 h. t16. Manual: `devops`, `env`, `COGNITO_OPS_POOL_ID` and `COGNITO_REGION=ap-south-1`, 1 h (tenant pools come from the registry). KB: `interface` "Auth endpoints" (`## Endpoints`: `GET /auth/tenant`, `GET /me`).
- **t4 Org model and seed**: personal_data, migrations. Human. 8 h. t16. No manual. KB: `glossary` "Org hierarchy", "residentNo".
- **t5 Ingest and alert mirror**: infra, migrations. Human. 16 h. t16. Manual: `devops`, `env`, `SQS_LIVE_URL`, `SQS_BACKLOG_URL`, 0.5 h. KB: `glossary` "record_ack", "Alert mirror"; convention "no alerts from telemetry".
- **t6 Service token and guard**: auth, secrets, permissions. Human. 8 h. t16. Manual: `devops`, `secret`, `SERVICE_TOKEN_PRIVATE_KEY` (Ed25519), account owner SerenEdge AWS, 1 h. KB: `interface` "Internal API guard"; `setup` "Service token key".
- **t7 Internal read tools**: permissions, personal_data. Human. 8 h. t16. No manual. KB: `interface` "Internal read tools".
- **t8 Internal writes**: permissions, personal_data. Human. 8 h. t16. No manual. KB: `interface` "Internal write tools".
- **t9 Outbox and schedule_event**: infra. Human. 8 h. t16. Manual: `devops`, `env`, `OUTBOX_QUEUE_URL`, 0.5 h. KB: `glossary` "Domain-event outbox".
- **t10 Local credential and shadows**: secrets, auth, infra. Human. 14 h. t16. Manual: `devops`, `secret`, `LOCAL_CREDENTIAL_PRIVATE_KEY` (Ed25519), 1 h; `devops`, `env`, `SHADOW_BUCKET`, 0.5 h. KB: `glossary` "Shadows", "Local credential"; `setup` "Shadow bucket and keys".
- **t11 Alert actions, push, escalation**: infra, permissions. Human. 16 h. t16. Manual: (1) `head`, `note`: obtain the Apple APNs auth key and the Firebase FCM credential, 3 h. (2) `devops`, `env`, `SNS_APNS_PLATFORM_ARN`, `SNS_FCM_PLATFORM_ARN`, account owner SerenEdge AWS, 1 h. KB: `glossary` "gateway_offline", "Provisional claim"; `setup` "Push credentials".
- **t12 Bands, bundles, assignment mirror**: secrets, personal_data. Human. 16 h. t16. Manual: `devops`, `env`, `BAND_BUNDLE_KMS_KEY_ID`, 1 h. KB: `glossary` "Band assignment mirror"; convention "assign_via_gateway".
- **t13 v1 agent outputs and Socket.IO**: permissions, personal_data. Human. 8 h. t16. No manual. KB: `interface` "Agent outputs API".
- **t14 Parquet export**: personal_data, dependencies. Human. 8 h. t16. Manual: `devops`, `env`, `PARQUET_BUCKET`, 0.5 h. KB: `glossary` "Pseudonymised Parquet export".
- **t15 Seed import (iit)**: personal_data. Human. 6 h. t16. No manual. KB: none.
- **t16 Part 1 acceptance** (test): permissions, personal_data. Human (cross-tenant isolation). 12 h. Tests t1–t15. No manual. KB: `decision` "Backend task breakdown" (links the concepts above, names the spec path).

### Part 2

- **t17 Staff accounts, MFA**: auth, permissions, personal_data. Human. 14 h. t41. Manual: `devops`, `env`, `COGNITO_ADMIN_ROLE_ARN`, 0.5 h. KB: `glossary` "Staff accounts".
- **t18 Family accounts and links**: auth, personal_data. Human. 8 h. t41. No manual. KB: `glossary` "Family link".
- **t19 Station PIN**: auth, secrets. Human. 6 h. t41. No manual. KB: `glossary` "Station PIN".
- **t20 Facility settings**: permissions. Human. 6 h. t41. No manual. KB: `glossary` "Facility settings groups".
- **t21 Residents, discharge, consent**: personal_data, permissions, migrations. Human. 16 h. t41. No manual. KB: `glossary` "Discharge choice".
- **t22 Alert policy versions**: permissions. Human. 6 h. t41. No manual. KB: `glossary` "Alert policy version".
- **t23 Shifts**: permissions. Human. 8 h. t41. No manual. KB: `glossary` "Shift".
- **t24 Availability, notifications**: personal_data. Human. 8 h. t41. No manual. KB: convention "availability purged after 48 h".
- **t25 Medical records**: personal_data, infra, permissions. Human. 10 h. t41. Manual: `devops`, `env`, `MEDICAL_BUCKET`, `MEDICAL_KMS_KEY_ID`, virus-scan function ARN, 1.5 h. KB: `glossary` "Medical records tab"; `setup` "Medical records bucket".
- **t26 Medications**: personal_data, migrations. Human. 16 h. t41. No manual. KB: `glossary` "Medication log", "MAR".
- **t27 Rounds, reminders, MAR PDF**: personal_data, dependencies. Human. 10 h. t41. No manual. KB: `glossary` "Medication round".
- **t28 Medication boundary**: personal_data, permissions. Human. 6 h. t41. No manual. KB: convention "medication data never reaches agents".
- **t29 Voice notes**: personal_data, infra. Human. 8 h. t41. Manual: `devops`, `env`, `TRANSCRIBE_ROLE_ARN`, 0.5 h. KB: `glossary` "Voice note".
- **t30 Audit, exports, erasure**: personal_data, permissions. Human. 12 h. t41. No manual. KB: convention "family ARIA chats private (D-113)".

### Part 3

- **t31 Family API and Live now**: personal_data, permissions. Human. 16 h. t41. No manual. KB: `interface` "Family API"; `glossary` "FamilyFacts".
- **t32 Live view and metrics**: personal_data. Human. 8 h. t41. No manual. KB: `glossary` "resident.status".
- **t33 Agent plumbing**: permissions. Human. 8 h. t41. No manual. KB: `glossary` "Cover request".
- **t34 Billing core**: payments, dependencies, personal_data. Human. 14 h. t41. Manual: `devops`, `env`, `SES_FROM_ADDRESS`, plus SES domain verification DNS records (DKIM, SPF), 1 h and propagation. KB: `glossary` "Bed-days", "Invoice"; `setup` "SES sender domain".
- **t35 PayHere**: payments, secrets. Human. 10 h. t41. Manual: (1) `head`, `note`: create the PayHere merchant account, 2 h. (2) `head`, `secret`, `PAYHERE_MERCHANT_SECRET`, account owner SoterCare, 0.5 h. (3) `devops`, `env`, `PAYHERE_MERCHANT_ID` and webhook URL `https://<api-host>/webhooks/payhere` per environment, 0.5 h. KB: `interface` "PayHere webhook"; `setup` "PayHere account".
- **t36 Suspension and restore**: payments, permissions. Human. 10 h. t41. No manual. KB: `glossary` "Suspension timeline".
- **t37 Ops provisioning**: auth, permissions, infra. Human. 16 h. t41. Manual: `devops`, `env`, `PROVISIONING_STATE_MACHINE_ARN`, 0.5 h. KB: `interface` "Ops API tenants"; `glossary` "Two-person rule".
- **t38 Ops fleet and stock**: permissions, infra. Human. 10 h. t41. Manual: `devops`, `env`, `IOT_ENROLMENT_RULE_ARN`, 1 h. KB: `glossary` "Gateway registry".
- **t39 Ops rollouts and support access**: permissions, infra. Human. 10 h. t41. Manual: `devops`, `env`, `COST_EXPLORER_ROLE_ARN`, 0.5 h. KB: `glossary` "Support grant".
- **t40 ARIA endpoints**: personal_data, secrets. Human. 8 h. t41. Manual: `devops`, `secret`, `AGENTS_API_KEY`, and `env` `AGENTS_API_URL`, 0.5 h. KB: `interface` "ARIA endpoints".
- **t41 Part 2 and 3 acceptance** (test): permissions, personal_data. Human. 14 h. Tests t17–t40. No manual. KB: none.

### Totals and gaps

- Hours: about 400 in total. Every task is on the human lane (flag, manual step or CI change) except t1, which is auto-eligible.
- Tests: SerenEdge lets a test task verify only one task, so t16 verifies t6 and t41 verifies t31. The other 37 tasks have no linked test task; their own acceptance criteria include tests, and t16 and t41 run the isolation and acceptance suites for their parts. **t0 has no test task** because it is the CI harness. **t16 and t41 are themselves tests**, so nothing tests them.
- Manual steps: a set of `devops` and `head` steps across about 20 tasks. They match the spec's "Security and manual work".
