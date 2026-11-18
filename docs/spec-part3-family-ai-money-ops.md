# sotercare-backend: full spec, Part 3 (family, AI, money and ops)

Part of the backend spec (rev 2, 19 Nov 2026). Part 1: [`spec.md`](spec.md) (§1–§15, shared rules). Part 2: [`spec-part2-people-and-care.md`](spec-part2-people-and-care.md) (§16–§25).

**Sources** (when they disagree, `b2b-plan/19` wins): `b2b-plan` 10 (family), 11 §3–§5, §9–§11 (agents, ARIA, budget), 12 (billing, suspension), 13 (ops), 04 §7 (ops pool, support access), 15 §3–4; `sotercare-contracts/docs/spec.md` §7.5, §7.9–§7.15, §7.18.

---

## 26. Family API and live view (`10`, D-101, D-113, D-114)
### 26.1 Scope rules (every family request)
- Family login only (`@LoginType('family')`). The `{id}` resident must have a link from this account: `active` → full view; `frozen` → read-only up to `frozenAsOf` (the last full day before the event), no ARIA, no live card, no weekly brief; none → 403 `forbidden`. Checked **on every request**, never cached across requests.
- **Never returned:** open or in-progress alerts (except the Live now `attending` flag), staff names or IDs (`attendedBy: "care_staff"` only), notes, care plans, Medical records, medications (except the opt-in on-time % card), insights, proposals, other residents, raw sensor data, `residentNo`, `bandId`. A response-shape test scans every family schema for these fields.
- Switched-off cards (`family_app` setting per `familyCardId`) are left out of `cards[]` and their endpoints answer 403 `feature_disabled`.
- **Suspended tenant:** history up to `readOnlyAsOf`, read-only; ARIA 402; the live card `state: suspended`.

### 26.2 Dashboard and incidents
- `GET /family/residents` → `family_resident[]` (facility name and phone, link state, switched-on cards).
- `GET /family/residents/{id}/dashboard?range=(7d|30d|12w)` → `family_dashboard` with each switched-on `dashboard_card`, built by **`FamilyFacts`** (one service, also behind the internal family-facts tool, §26.3):
  - `resolved_incidents`, `incident_rates`, `response_time` from the alert mirror: every resolved `sensorAlertType` alert (falls and SOS included, D-101); rates and medians count `verdict real` only; `false_alarm` appears as `familyOutcome: checked_no_issue`; device alerts excluded; response time = raise → `arrivedAt`, inferred arrivals excluded, median `null` under 3 incidents; `targetS` only when the facility sets one;
  - `activity`, `night_rest`, `wet_pad_care`, `wear_time`, `temperature` from rollups (relative temperature only, never °C);
  - `medicines_on_time` only if the `medication` setting enables it: weekly scheduled-dose count and on-time %, no names;
  - `weekly_brief`: the latest published `family_weekly_brief` output with `publishAt` ≤ now (§29.4);
  - **missing data is never "quiet":** days with wear < 50 % → `status not_worn`; Pause or no band → `away`; after leaving → `left`; rates, medians and usual ranges use worn days only; the first 14 days → `learning: true` and no usual range.
- `GET /family/residents/{id}/incidents?category=&from=&to=` → `family_incident[]` with the outcome mapping of `10` §2.

### 26.3 Internal family facts
`GET /internal/v1/family/residents/{id}/facts?weekStartDate=` (ARIA family and the family weekly brief; a family token's one resident, or a `family_weekly_brief` workflow token): the same `FamilyFacts` numbers for that week, plus `insufficientData` (worn < 4 of 7 days, learning, or paused) so the brief can use its fixed text.

### 26.4 Live now (D-114, contracts §7.18)
- **Derivation** in the worker (`FamilyLive`): on every `telemetry_batch` and every live `alert_record` for an assigned resident, compute `family_live_status` (activity mapping and the 10-min `resting` rule from contracts; `attending` = a `sensorAlertType` alert in `claimed` / `arrived`; `state` = `away` (Pause or no band) / `offline` (band offline past `bandOfflineS`) / `suspended` / `live`). Keep the latest per resident in Redis (`t:{tenantId}:famlive:{residentId}`, TTL 1 h); nothing is stored in the DB (no live history).
- **Delivery:** on change only, ≤ 1 per resident per 10 s, to `family:{tenantId}:{residentId}` as `family.live`. Target ≤ 15 s from the gateway's record (measured in tests with the fake IoT publisher). Backlog records never update it.
- `GET /family/residents/{id}/live` → the current status (from Redis, recomputed if missing); 403 `feature_disabled` when `live_now` is off; 403 `forbidden` unless the link is `active`; 200 `state: suspended` while suspended.
- **`family.watch {residentId}`** (Socket.IO ack): check family socket + active link + `live_now` on + not suspended → join that room, leave any other family room, ack `{ok: true, status}`; else `{ok: false, code}`. On unlink, deactivation, a frozen link, the card switched off or suspension → the backend removes the socket from the room at once (an event on the tenant's Redis channel that every API container listens to).

## 27. Family weekly e-mail (`10` §4)
- Off by default (`family_app.weeklyEmail`). **Needs contracts C-31** (applied with this spec): `family_account.email | null` and `weeklyEmailOptIn (bool)`, editable by the manager in the console; never used for login or reset (`04` §2).
- When the brief publishes (Monday 08:00 facility time, §29.4) and both switches are on: an SES e-mail (template `family-weekly-brief`, configuration set `sc-{env}`) with the brief text and an app link. No alert details, no staff names. Bounces / complaints (SES events) turn `weeklyEmailOptIn` off and are audited.

## 28. ARIA endpoints (`11` §5, `10` §3, D-113)
### 28.1 Flow
1. `POST /aria {chatId?, message}` (care staff) or `POST /family/residents/{id}/aria {chatId?, message}` (family, active link only).
2. Checks **before** any model call: login type and scope; the family switch (`family_app.aria`) → 403 `feature_disabled`; suspension → 402 `tenant_suspended`; **daily limit** (Redis counter `t:{tenantId}:aria:{userId}:{yyyymmdd}`; family 30, staff 200) → 429 `rate_limited` with `retryAfterS`; the AI budget state (§29.5: at ≥ 150 % → `aria_answer {replyKind: unavailable}` without a model call); message ≤ 2,000 characters.
3. Store the user message in `aria_messages` (chat owned by the caller; family chats flagged `audience family`).
4. Issue a **service token** (Part 1 §7) for the chat: staff → `audience {kind: staff, userId}`, the user's role and wards, `residentIds` = residents in those wards; family → `audience {kind: family, userId}`, exactly **one** `residentId`. Call `POST /agents/v1/aria/answer` (`aria_request`) with the backend's service token (contracts `agents.yaml`).
5. **Staff:** with `Accept: text/event-stream`, relay `aria_stream_event`s as they come; the final `done` carries the checked `aria_answer`. **Family: never streamed**; return the checked `aria_answer` only.
6. The agents service persists the assistant message through `POST /internal/v1/aria/messages` (sources, `residentIds` touched, `replyKind`); the backend checks it for medication names (§21.8) and links it to the chat.
- **Audit:** staff ARIA → metadata (who, when, residents); **family ARIA → metadata only: who, when, resident, message length** (D-113).

### 28.2 History and privacy
- `GET /aria/history?chatId=` → the caller's **own staff** chats only; `GET /family/residents/{id}/aria/history` → that family member's own chat for that resident only. **There is no other read path**: no staff endpoint, no audit text, no export, no support session, no data-request export includes family chats (tests assert each).
- Retention 90 days; erasure of a resident deletes messages tagged with them; deleting a family account deletes its chats (§24.4, §24.5).

## 29. Agent-output plumbing (completes Part 1 §11–§12)
### 29.1 Cover requests (`08` §4, `11` §4.3)
- `POST /internal/v1/cover-requests` (Roster Coordinator): candidates by **`staffKey`**; the backend resolves each to a user (the `staff_keys` table: HMAC of `userId` under a per-tenant key, `stf_` + 8 base32), checks they're active care staff, creates `cover_request`, and notifies them (`cover_request` notification + push). Expires at `expiresAt` (job) → `cover_request.expired`.
- `GET /cover-requests?mine=true`, `POST /cover-requests/{id}/answer {answer}` → `cover_request.replied` domain event. The **assignment** happens only when the manager approves a `cover_assignment` proposal (§29.2).

### 29.2 Proposals: apply on approve (contracts §7.10)
`POST /proposals/{id}/approve | edit | reject` (reviewer role per type; 402 while suspended). On approve / edit the backend applies the payload **as the approver**:
| Type | Applied |
|---|---|
| `incident_report` | stored as the alert's incident form (`incident_reports`), visible in the resident timeline; never auto-published |
| `draft_roster` | creates **draft** shifts (the manager publishes them, §20.1) |
| `cover_assignment` | assigns the shift to `userId` (a published-shift edit → `shift_changed`), closes the cover request `filled` |
| `band_reassignment` | **nothing** (D-132); the response returns the "Pair the band at the nurse station" message |
| `care_routine_change` | `alert_settings_patch` with `via: proposal` (§19.3 rules; Critical off still needs a manager) |
| `monthly_report` | published as an output visible to managers; the PDF via §24.2 |
| `resident_profile` | updates the resident's care-plan profile fields (`resident_profiles`) shown to staff |

- **Incident confirm / escalate:** `incident_report` starts with the resolver as reviewer; `incident_confirm` notification at the reviewer's shift end (§20.4); at `escalateAt` (24 h) a delayed job moves it to the ward head (`reviewerRole ward_head`, `escalatedAt`, `review_needed` notification). Cancelled on decision.
- Every decision → `proposal.decided` (WS + domain event) and audit.

### 29.3 Schedules (`schedule_event`, contracts §7.9)
From each facility's settings and time zone, one `ScheduleEmitter` in the worker (BullMQ repeatable jobs per tenant, rebuilt on settings change; skipped while suspended or when the matching `agents` output switch is off):
| `scheduleType` | When |
|---|---|
| `device_tasks` | every 15 min |
| `daily_care_log` | per ward, 23:30 |
| `morning_brief` | `agents.morningBriefTime` (07:30) |
| `weekly_roster` | Thursday 10:00 |
| `weekly_review_pack` | per ward, Friday 14:00 |
| `family_weekly_brief` | Sunday 20:00 (agents write it overnight; it publishes Monday 08:00) |
| `monthly_report` | the 1st, 06:00 |
| `wifi_deadzone_report` | Monday 06:00 |

Times other than those set in `09` are Arch defaults (§35).

### 29.4 Output visibility and publishing
- Outputs are served by role and ward (`11` §11); `family_weekly_brief` outputs are served to families only from `payload.publishAt` (Monday 08:00) and to ward heads / managers at once; **no hold endpoint** (D-51).
- `handover_ready` notification to incoming staff + ward head when a `handover` output publishes; `charging_rota`, `device_task` notifications to ward staff.
- **Translations:** outputs carry `translations[]`; the API serves the caller's language if present, else English with `translated: false`.

### 29.5 AI budget (`11` §9)
- Each `case_trace` and ARIA answer reports `costUsdMicros`; the backend sums per tenant per month (`ai_usage`), against a budget of **$0.42 × billable beds** (§30.1) plus any ops override (§31.5).
- Exposed to agents in `GET /internal/v1/facility` (`aiBudget {state ok|over_100|over_150, usedPct}`); at 80 % an ops alarm and an ops-console flag; at 100 % / 150 % the agents downgrade as `11` §9 says (their logic); ARIA at ≥ 150 % answers `unavailable` from the backend without a call (§28.1).

## 30. Billing and suspension (`12`, D-27, D-29)
### 30.1 Bed-days
- Nightly per tenant (and on any late `assignment_record` for a month whose invoice isn't issued): for each facility-time day, **billable bed-days = distinct residents with an assignment period overlapping that day** (from the mirror's `startedAt` / `endedAt`, gateway time), **capped at active beds**. Paused residents count. Stored in `billable_bed_days {date, count}` and copied to the control DB.
- A late record that changes an **issued** month → flagged to `platform_billing` (ops console) for a credit note; the issued invoice never changes.

### 30.2 Invoices (control DB)
- On the 1st (facility time) for the previous month, after go-live (§31.4): `amount = Σ days (bed-days × that day's price) ÷ days in month`, tax at the tenant's rate (0 now), rounded once, in the tenant currency (LKR or USD, minor units; no conversion). Number `SC-{yyyy}-{seq}` per environment. Due in 14 days (tenant setting).
- PDF (worker, `pdfmake`, with the daily breakdown) to `sc-{env}-billing/{tenantId}/{invoiceId}.pdf`; `GET /billing/invoices/{id}/pdf` → presigned GET.
- E-mails (SES) to the billing contact: invoice issued, due − 3 reminder, overdue daily, suspended, restored, payment received.

### 30.3 PayHere (`PaymentProvider`)
- Interface `createCheckout(invoice) | createRecurring(tenant) | charge(token, invoice) | handleWebhook(body) | queryStatus(orderId) | refund(payment, amount)`; `PayHereProvider` + `FakePaymentProvider` (tests, `local`, `dev`).
- **Checkout:** `POST /billing/invoices/{id}/checkout` → `checkout_session` (form fields incl. `hash` = MD5 per PayHere's spec over merchant ID, order ID, amount, currency and the MD5 of the merchant secret; the secret from Secrets Manager). Recurring: `POST /billing/payment-method` (preapproval) → token stored in `payment_methods` (provider token, last 4, expiry; no card data).
- **Webhook** `POST /v1/webhooks/payhere` (public, form-encoded): verify `md5sig`; `order_id` must be a known invoice; amount and currency must match → else 400 `webhook_invalid` (logged by IDs). The tenant comes **from the invoice**. Raw body stored. Idempotent on `(provider, payment_id, status)`; state only moves forward (`pending → succeeded|failed`, `succeeded → refunded|charged_back`).
- No webhook 15 min after a checkout → `queryStatus`. Automatic payment: charge on the invoice day, retry on day 3 and the due date, e-mail each time.
- Bank transfers: `POST /billing/bank-transfers` records a facility-reported transfer (`reportedByFacility`), holds suspension up to 3 days; `platform_billing` confirms (§31.5). Partial payments keep the invoice `open` with its balance.

### 30.4 State machine (hourly, facility time)
Driven by the **oldest unpaid invoice past due**:
| When | State | Effect |
|---|---|---|
| due − 3 days | `active` | reminder e-mail |
| due date | `active` | console banner |
| due + 1 … + 7 | `overdue` | daily banner + e-mail; `billing_overdue` notification to managers |
| due + 8, 00:00 | `suspended` | §30.5 |
| all past-due invoices paid | `active` | §30.6 |

- **Holds:** a checkout `pending` at PayHere or a reported bank transfer holds suspension up to 3 days (`holdUntil`). **Override:** `platform_billing` with a reason and expiry ≤ 30 days (§31.5). Never auto-close.
- Every state change: control DB `billing_state` + `billing_events`; tenant `service` (Part 1 §10 `service` shadow, `ws tenant.service`, `tenant.service_changed` domain event, the tenant cache cleared).

### 30.5 While suspended (`12` §5, contracts §7.13)
- **402 `tenant_suspended`** (`details {state, since, readOnlyAsOf}`) from exactly: `POST /aria`, `POST /family/residents/{id}/aria`, `POST /outputs/{id}/feedback`, proposal decisions, cover-request answers and every `/internal/v1` call. Implemented as one `@StopsWhenSuspended()` decorator; a test lists the decorated routes and compares them to this list.
- Ingest acks `suspended` and stores nothing **except alert and assignment records** (Part 1 §8); no telemetry, gait, logged events or sensor windows; `url_grant` for sensor-window uploads → `suspended`; `assignments` grants still `ok`.
- Domain events: only `tenant.service_changed`. Schedules stop. The family live card → `suspended`.
- **Everything else keeps working**, including alert actions, push, `gateway_offline`, residents, alert settings, accounts, shifts, settings, policy sign-off, medications, Medical records, family unlink, billing, audit, exports, data requests, support access.
- History reads return data up to `readOnlyAsOf` (= `since`).

### 30.6 Restoring
`active` → `service` shadow → the gateway drains its backlog (Part 1 §8, never pushes) → when its heartbeat shows `backlogDepth 0`, WS `tenant.service {restoredRecordsFrom, droppedRecords}` and a `service_restored` notification to managers. Agents resume from now; nothing is back-filled.

### 30.7 Facility billing endpoints
`GET /billing`, `/billing/invoices`, `/billing/payments`, `/billing/credit-notes`, `GET/PATCH /billing/details`, `DELETE /billing/payment-method` (facility manager, org admin; audited). They read the control DB through a billing service that takes the tenant from `TenantContext` only.

## 31. Ops API (`/v1/ops/*`, `13`, `04` §7)
### 31.1 Access
- Ops pool tokens only (Part 1 §7), MFA required (§16.1 rule applies), roles `platform_admin`, `platform_support`, `platform_billing` checked per route. In `prod`, WAF limits the path to the office / VPN list (infra).
- **Two-person rule:** discard, final delete, facility account recovery and ops MFA reset return 202 `approval`; a **different** ops user completes it with `POST /approvals/{id}/approve | reject` within 24 h (else `expired`). Same user → 403 `approval_required`.
- Every ops action → `platform_audit`; actions on a tenant also → that tenant's `audit.events` (`actorKind ops`).
- Ops users **never** read tenant health data except through a support session (§32).

### 31.2 Tenants and provisioning
- `GET /tenants`, `GET /tenants/{id}`, `GET /tenant-ids/{id}/availability` (format, not taken, not reserved).
- `POST /tenants` (`tenant_create`): creates the organisation if new, reserves the ID, stores authorised contacts, then: `local` / `dev` → `ProvisioningService` (Part 1 §6); `staging` / `prod` → **starts `sc-{env}-provision-tenant`** (infra) with `{tenantId, jobId, managers}` and returns 202 `{tenant, jobId}`. The workflow's Lambdas write step progress into `provisioning_jobs` (control DB); `GET /provisioning-jobs/{jobId}` is polled every 3 s by the ops console; `firstManagerLoginSlip` is returned **once**.
- `POST /provisioning-jobs/{jobId}/retry`; `POST /tenants/{id}/discard` (approval; `sc-{env}-close-tenant` in discard mode); `POST /tenants/{id}/closing {endDate}` and on the end date the closing steps of `13` §1 (status `closing`, certificate revoke, push endpoints deleted, AI stopped, logins limited to managers / org admins, full export without family chat content); `POST /tenants/{id}/delete` (approval, ≥ 90 days after the end) → the close workflow in delete mode.
- `POST /tenants/{id}/restore-db {pointInTime}` → sets `maintenance` (writes → 503 `tenant_maintenance`, ingest leaves messages in SQS), starts infra's `sc-{env}-restore-tenant` workflow, then repoints the tenant record, clears the cache, clears `maintenance` and sends `cmd/resync {since: pointInTime}` (scenario 28).
- `POST /tenants/{id}/active-gateway {gatewayId}`: the target must be enrolled to this tenant; re-wraps every band key to its wrapping key (band keys are stored in the tenant DB under the tenant KMS key), sets roles in `gateway_registry`, rewrites both units' `service` (`gatewayRole`, C-29) and `bands` shadows.
- `GET /tenants/{id}/quality` (wear time, false alarms per bed per week, median arrival, unclaimed escalations vs the pilot targets).

### 31.3 Organisations and org admins
`GET/POST /organisations`; `POST /organisations/{id}/org-admins {name, displayName, primaryTenantId}` → creates the account in that tenant's pool (MFA required at first login) + `org_memberships`, returns `{loginSlip}`.

### 31.4 Onboarding checklist
`GET /tenants/{id}/onboarding`, `PATCH /tenants/{id}/onboarding/{step}`. **Auto steps** are set by the backend: `tenant_provisioned` (job done), `gateway_enrolled` (an active gateway online), `bands_allocated` (every allocated band `available`), `layout_entered` (≥ 1 ward, room, bed), `manager_handed_over` (a manager signed in with MFA), `accounts_created` (≥ 2 managers, ≥ 1 ward head), `residents_ready` (every bed with a resident has a mirrored assignment and consent recorded), `policy_signed_off`. Manual: `site_survey`, `staff_trained`, `go_live` (sets `active`, billing starts the next day).

### 31.5 Billing (ops)
Plans and prices (`PUT /tenants/{id}/price`, effective the 1st of a month), invoices across tenants, `POST /invoices/{id}/payments` (confirm a reported transfer / record a partial payment), credit notes, refunds (through the provider or recorded as a bank refund; a credit note is issued), disputes (`disputed`, no auto-suspension; lost → reopened with a new due date), voids, `POST /tenants/{id}/billing-override {until ≤ 30 days, reason}`, AI budget override, `GET /revenue?month=`.

### 31.6 Account recovery (`04` §2)
`POST /tenants/{id}/account-recovery {kind, targetUserId?, contactName, verifiedBy}` (approval): on completion runs the matching §16.2 action in the tenant (or creates a new manager), returns `{loginSlip}` once to the approver, writes the tenant audit and shows the `account_recovery` notice to every manager for 7 days.

### 31.7 Fleet, stock and rollouts
- **Gateways:** `POST /gateways {gatewaySerial}` (registers `gw_` + serial), `POST /gateways/{id}/enrolment {tenantId}` → 8-character Crockford base32 code (24 h; 409 `gateway_bound`), `PUT /gateways/{id}/wrap-key`, `/revoke` (certificate revoked in IoT), `/release`. The **fleet-provisioning pre-provisioning hook** (Lambda deployed by infra, code here: `src/lambdas/fp-hook.ts`, built as a zip artifact) checks the code and serial, refuses a gateway bound to another tenant, stores the wrapping public key, sets standby unless the tenant has no active gateway (contracts §7.7).
- **Bands:** `POST /bands/import` (production file: serials + factory keys wrapped for the platform KMS key; stored encrypted in the control DB), `/allocate`, `/move`, `/return`, `GET /bands?tenantId=&status=`, and `POST /tenants/{id}/bands/{bandId}/provisioning-bundle` (`platform_support`, same as the facility endpoint).
- **Rollouts:** `GET /artifacts` (registry rows written by the release workflows), `POST /rollouts` (stages canary 1 gateway → 10 % → all), each stage creates an **IoT Job** on a target thing group (infra's `stage-*` groups) with the `ota_job` document; progress from Jobs execution status; **auto-pause** when, during a stage, job failures > 5 %, gateways going offline rise by > 2 points, or the false-alarm rate per bed per week rises > 20 % vs the 7 days before. `pause | resume`.

### 31.8 Usage, health, announcements
- `GET /usage?month=`: per tenant, AWS cost by the `sc:tenant` tag (Cost Explorer, daily cached) + shared cost split per bed + Bedrock cost from `ai_usage` + quality signals.
- `GET /health`: queue age / DLQ depth, ingest lag, push errors, API errors, DB health, failed jobs, orphans, migration status, DR copies, WAF blocks per pool, IoT tenant mismatches, quotas (CloudWatch reads, cached 60 s).
- `POST /announcements {tenantIds | all, severity, text, until}` → WS `announcement` to each tenant's `facility` room; `GET /v1/announcements` for consoles.
- `GET /data-requests?tenantId=` → the mirrored PDPA register (read-only).

## 32. Support access (`04` §7)
- Facility side: `GET/POST /support-access`, `DELETE /support-access/{grantId}` (facility manager / org admin; 1 h – 7 days, reason) → `support_grants` in the tenant DB, mirrored (who, until) to the control DB.
- Ops side: `POST /v1/ops/tenants/{id}/support-session` (`platform_support` / `platform_admin`, only inside an active grant, else 403 `support_grant_required`) → a short-lived (≤ 1 h, never past the grant) backend-signed **support token** for that tenant. The guard accepts it on **GET routes only** of `public.yaml` (no exports, account or setting changes) and **never** on family ARIA history, staff ARIA history or any chat content. Every call is audited in the tenant as the named ops person and shown to the facility.

## 33. Testing (Parts 2 and 3; Part 1 §14 still applies)
- **Unit + integration** (Jest, docker-compose Postgres + LocalStack, fake Cognito admin client, fake PayHere, fake Transcribe, fake GuardDuty events).
- **Required suites:** account lifecycle (create, rename, reset, deactivate → sign-out + endpoints + sockets + `jti` + roster); last manager; username denylist; MFA gate; org-admin facility switch; station PIN hash vector shared with the gateway; settings side effects; policy safety limits (every bound) and sign-off; residents (`residentNo` sequence, discharge rules + family choices, pause, transfer, legal hold, consent); alert-setting `until` revert; shifts (DST day, overnight, publish, schedulers); coverage gaps; availability segments + purge; notifications (never to family); medications (recommendation rules, new-recommendation rule, log in the same transaction, dose generation 48 h, rounds, reminders + recipients, mark / undo / correction / PRN, idempotent offline replays, MAR JSON + PDF); medication-name check on agent writes; Medical records (presign, complete checks, scan clean / infected / timeout, thumbnails, `document.uploaded` only for `care_plan`, linked 409); voice notes; audit insert-only + D-113 metadata only; exports never include family chats; erasure; retention jobs; metrics (caregiver groupBy managers only).
- Family: scope + link states + card switches + response-shape scan; `FamilyFacts` numbers vs a hand-computed fixture; live derivation + ≤ 10 s throttle + ≤ 15 s latency + room removal on unlink; ARIA (limits, switch, suspension, budget, family never streamed, history isolation); cover requests; proposals apply-on-approve per type + incident escalation; schedules in `Asia/Colombo`; budget states.
- Billing: bed-days (swap, same-bed same-day, cap, late record, paused), invoice maths and rounding, PayHere hash + webhook signature, idempotency, out-of-order states, query after 15 min, the hourly state machine with a fake clock (holds, override, restore), the 402 list.
- Ops: two-person rule, provisioning start + polling, restore-db sequence, active-gateway re-wrap, onboarding auto steps, rollouts auto-pause, support session limits.
- **Isolation suite** (scenario 6) extended to every route in Parts 2 and 3, including family and ops (a support token for tenant A on tenant B → 403).
- **Acceptance mapping:** scenarios 3, 4 (backend claim race), 5, 7, 8, 9, 12 (record names the person), 13, 16, 17 (backend limits + fixed replies routing), 19 (handover deadline: schedules + `degraded` outputs), 20, 22 (lockout: no backend dependency; alerts keep flowing), 23, 24, 26, 28, 30, 31, 32, 33 → named tests in the plan's Tasks 17–41.

## 34. Calls made in Parts 2 and 3 (check while reading)
1. PIN hash: PBKDF2-SHA256, 100,000 iterations, 16-byte salt (Pi 5 verification cost).
2. MFA enforcement by a guard check of `mfaEnrolled` (Cognito has no per-group "MFA required").
3. Username denylist (§16.1).
4. Pattern-generated shifts are drafts, 4 weeks ahead.
5. Data-request due date 30 days (PDPA default; legal review confirms).
6. The backend (not the agents) checks agent text for the tenant's medication names (§21.8), so names never leave it.
7. GuardDuty scan results reach the backend on `sc-{env}-scan-results` (infra adds the EventBridge rule; infra spec updated).
8. HEIC pictures get no thumbnail (no HEIC support in the prebuilt image library); served full-size.
9. Schedule times not set in `09` (§29.3 table).
10. Rollout auto-pause thresholds (§31.7).
11. Invoice numbering `SC-{yyyy}-{seq}`.
12. `restore-tenant` is an infra Step Functions workflow (infra spec updated); the backend sequences maintenance, repoint and resync.
13. Export kinds (§24.2): contracts' `export_job` wins if its enum differs.

## 35. Contract changes needed by this spec
- **C-31** (applied 19 Nov, additive): `family_account.email | null`, `weeklyEmailOptIn (bool, default false)` for the family weekly e-mail (§27).
- No other change: every endpoint and field above already exists in contracts rev 5 (+ C-28…C-30).
