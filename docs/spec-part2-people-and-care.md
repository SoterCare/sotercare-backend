# sotercare-backend: full spec, Part 2 (people and care)

Part of the backend spec (rev 2, 19 Nov 2026). Part 1 ([`spec.md`](spec.md)) holds §1–§15 and the rules every part follows (tenancy, `TenantContext`, the contracts pin, the IDs-only logs, `Clock`, `Idempotency-Key`). Part 3: [`spec-part3-family-ai-money-ops.md`](spec-part3-family-ai-money-ops.md).

**Sources** (when they disagree, `b2b-plan/19` wins): `b2b-plan` 04 (identity), 07 §3, §4.5, §8, §10 (alert bar, resident changes, policy, metrics), 08 (shifts), 09 (settings), 11 §6 (consent), 15 §3–4 (retention, data requests), 21 (medications, Medical records); `sotercare-contracts/docs/spec.md` §7.1 (enums), §7.5–§7.6 (WS, push), §7.8 (policy), §7.11 (`public.yaml`), §7.13 (errors), §7.16–§7.17.

**Where fields are defined:** every request and response body below is the contracts schema of the same name; this part says what the backend **does** with it.

---

## 16. Accounts and identity (`04` §1–§4, §7)
### 16.1 Cognito model
- **One pool per tenant** (Part 1 §6). Cognito `username` = the internal `userId` (`u_…`); the login name is the `preferred_username` alias (`name`), so a rename keeps history. Groups: `care_staff`, `family`. Attribute `custom:role` mirrors the tenant DB, which is authoritative.
- **Usernames:** `name` matches `^[a-z0-9._-]{2,32}$`, unique in the tenant, never reused after deactivation (`users.name` keeps a tombstone). A denylist refuses role-like names (`admin`, `manager`, `nurse`, `staff`, `test`, `support`, `root`, `user`, `ward`, `head`, `care`, `family`) → 422 `validation_failed`.
- **Login type** (`04` §3): `GET /me` with `X-Login-Type` checks the Cognito group → 403 `login_type_mismatch`; staff accounts never get family endpoints and vice versa (route-level `@LoginType()` guard).
- **Passwords:** Cognito policy ≥ 10 characters with letters and digits, history 5 (Essentials). The backend never sees a password except the temporary one it generates (16 characters, unambiguous alphabet), which goes only into the `login_slip` response and is never stored or logged.
- **MFA (TOTP):** pool MFA `OPTIONAL`. Facility managers and org admins must enrol: until `mfaEnrolled` (from `AdminGetUser`, cached 5 min), their tokens are accepted only on `GET /me` and the Cognito MFA setup flow; every other route → 403 `forbidden` with `details.reason mfa_required`. Ops users: §31.

### 16.2 Staff accounts (`/v1/staff`, facility manager or org admin)
- **Create** → `AdminCreateUser` (temporary password, `MessageAction SUPPRESS`, no e-mail), group `care_staff`, the `users` row (`status pending_first_login`), audit `staff_created`, response `{account, loginSlip}`. 409 `username_taken`.
- **Edit:** `displayName`, `name` (rename → `preferred_username`), `role`, `wardIds`. Demoting the last active facility manager → 409 `last_manager`. Each change → audit + `roster` shadow republish (Part 1 §10).
- **Reset password** → `AdminSetUserPassword` (temporary), `AdminUserGlobalSignOut`, **revoke the local credential** (`jti` → `keys.revoked`), notice `password_reset_by_manager` for the next `GET /me`, push `password_reset_by_manager` is **not** sent (the user is signed out). Returns a new `loginSlip`.
- **Reset MFA** → `AdminSetUserMFAPreference` off; the user re-enrols at next sign-in.
- **Deactivate** (`04` §2): status `deactivated`; Cognito `AdminDisableUser` + global sign-out; delete every SNS endpoint of the user (§20.6); drop sockets (Part 1 §12); revoke every unexpired local credential `jti`; republish `roster` (the user disappears from `staff[]`) and `keys`. **The gateway releases their claims** when the applied `roster` no longer lists them (kind `released_system`, `via: system`). Last active manager → 409 `last_manager`.
- **Clear station PIN:** `DELETE /staff/{id}/station-pin` (§17).
- **Org admins** (`04` §1): `GET/POST /org-admins` only for org admins (or ops, §31). Facility managers get 403 on any org-admin account.

### 16.3 Org admins across facilities (`04` §1)
- The org admin's account lives in the organisation's **primary** facility pool. Control DB `org_memberships {orgId, userId, primaryTenantId}`.
- A request with `X-Facility-Id`: the guard checks the token is from the primary pool, the user is an org admin of that organisation, and the facility's tenant belongs to it, then sets `TenantContext` to **that facility's tenant only**. Without the header, the primary facility. Audit rows in the target tenant name the actor `name@primary (org admin)` (`actorKind org_admin`).

### 16.4 Family accounts (`/v1/family-accounts`, facility manager or org admin)
- **Create** → group `family`, links to ≥ 1 resident (`family_links {userId, residentId, state active|frozen, frozenAsOf, removeAt}`), `{account, loginSlip}`. No local credential, ever. No push endpoint is created for family logins (§20.6).
- **Per person (D-101):** `POST /family-accounts/{id}/unlink {residentId, mode}`: `read_only` → link `frozen` with `frozenAsOf` = the last full day before now and `removeAt` = now + the family access period (`family_app` setting, default 30 days); `now` → link removed. **An account left with no active link is deactivated** (at once, or when its last frozen link is removed by the nightly job). `POST /family-accounts/{id}/deactivate` → all links removed, account disabled. Each choice audited `family_link_changed` / `family_account_deactivated`; the family socket is removed from the room at once (§26.4).
- **Discharge choices** are applied through the same code (§19.4).

### 16.5 `GET /me`, `PATCH /me`, notices
- `GET /me` → `me` (contracts §7.11): for care staff with `X-Login-Type: staff` and an `X-Installation-Id`, a **fresh local credential** (Part 1 §7; one per installation, the previous one for that installation is revoked) and `gateway {gatewayId, addrs, wssPort, certSha256}` from the latest heartbeat's `lan` block (a facility `devices_network` override wins for `addrs`).
- `notices[]`: `password_reset_by_manager` (until the user signs in once after it), `account_recovery` (shown to every manager for 7 days, §31.6).
- `PATCH /me {language}`; first-login password change is Cognito's `NEW_PASSWORD_REQUIRED` flow, after which `status → active`.

## 17. Station PIN and readiness (`07` §4.2, D-46)
- `PUT /me/station-pin {pin}` (care staff): stored as PBKDF2-SHA256 over `"{userId}:{pin}"` with a 16-byte random salt and **100,000 iterations** (the gateway verifies it offline on a Pi 5; contracts `roster.staff[].stationPin`). Weak PINs (`0000`, `1234`, four equal digits, straight runs) → 422 `validation_failed`. Republishes `roster`. `stationPinSet` in `me` and `staff_account`.
- `DELETE /me/station-pin`, and `DELETE /staff/{id}/station-pin` (facility manager, audited).
- **Readiness** (`07` §6): `POST /me/readiness` (`readiness`: notifications, critical / time-sensitive, DND override, battery exemption, on facility SSID, station PIN set, local push entitlement) → `staff_device_readiness` per installation; shown in `staff_account.readiness`, `ws_staff_availability.readiness` and the console's readiness view. Missing items at shift start → `alert_setup_needed` notification (§20.5).

## 18. Facility settings and the alert policy (`09`, `07` §8)
### 18.1 Settings groups
- `GET/PATCH /settings/{group}` for every `settingsGroup` (contracts §7.1). Stored in `facility_settings {group, version, value (jsonb), updatedBy, updatedAt}`; each PATCH validates the group's schema, writes a new version, writes `setting_change` rows per field (via `console | app`) and an audit row.
- Who: facility manager or org admin; `alert_policy` isn't edited here (§18.2); `billing` is read-only here (§30).
- **Side effects:**
  | Group | Effect |
  |---|---|
  | `facility` (time zone) | refused unless a new policy draft with the same `timeZone` is signed off in the same request flow (`09` §2): the PATCH returns 409 `conflict` `details.reason policy_required` and the console creates the draft; published shifts don't move (`08`) and are flagged for review |
  | `layout` | wards / rooms / beds are their own endpoints (§19.1); this group holds named ward heads |
  | `nurse_station`, `sensors`, `haptic`, `night`, `escalation` | the values the gateway needs are **policy** fields; changing them creates a policy draft (§18.2). Quiet hours per manager → `roster.staff[].quietHours` |
  | `devices_network` | a band Wi-Fi change bumps `bands.wifi.wifiGen` (the password wrapped to the gateway key, Part 1 §10); the rollout progress comes back in `gateway_info.wifiRollout`. LTE failover → `service.network.lteFailover` |
  | `shifts` | margin → `roster.shiftMarginMin`; reminder / roster-gap times → the schedulers (§20) |
  | `medication` | reminder lead / windows → the dose scheduler (§21.4); the family card → `family_app` cards |
  | `family_app`, `agents` | `tenant.settings_changed {groups}` domain event (agents re-read from the next trigger) |
  | `support_access`, `data`, `billing` | their own endpoints (§24, §30, §32) |

### 18.2 Alert policy versions (`07` §8, contracts §7.8)
- `alert_policies {policyVersion (int as string), status draft|active|superseded|discarded, policy jsonb, createdBy, createdAt, approvedBy, approvedAt}`. Version `"0"` = `policy/default.alert-policy.v1.json` from contracts, present from provisioning, `active` until the first sign-off.
- `POST /alert-policies` creates a **draft** from the active version + changes; validated against the schema **and the safety limits** (contracts §7.8, plus the cross-field rule `arrivalReminderS < stepInS`) → 422 `validation_failed` with each path.
- `POST /alert-policies/{v}/sign-off`: **facility manager or org admin with MFA**; the draft becomes `active`, the old one `superseded`; republish the `policy` shadow; audit `policy_signed_off`; the onboarding step `policy_signed_off` is marked done (§31.4). `discard` on a draft only.
- **The gateway runs the version it applied**; `GET /alert-policies` shows the gateway's applied version from the shadow reports (Part 1 §10).

## 19. Layout and residents (`09` §3, `07` §3, §4.5)
### 19.1 Layout
- `GET/POST/PATCH /wards`, `/rooms`, `/beds` (facility manager, org admin). A ward / room / bed with a current resident can't be archived (409 `conflict`). Labels unique per parent. Changes republish `roster` (rooms, wards) and `residents` (labels).
- **Bed count** for billing (§30.1) = active beds.

### 19.2 Residents
- `POST /residents` (admission; ward head, manager, org admin): allocates **`residentNo`** `R-` + 4 digits from a per-tenant sequence (5 digits after 9999), never reused (D-99). Alert bar = the policy's `alertBarDefaults`; Critical on. `status admitted`. Republishes `residents`. Consent is recorded separately (§19.6).
- `GET /residents`, `GET /residents?criticalOff=true`, `GET/PATCH /residents/{id}` (display name, notes for staff, bedtime / wake etc. go through alert settings). A resident's **band link** comes only from the mirror (Part 1 §9); POST / PATCH never set it.
- `GET /residents/{id}/timeline` (alerts, alert-setting changes, moves, pauses, assignments, Medical records uploads by title only, incidents; paged), `GET /residents/{id}/trends?range=` (rollups for the console charts, §25).

### 19.3 Alert settings (`07` §3)
- `GET/PATCH /residents/{id}/alert-settings` (`alert_settings_patch`): ward head or manager; **Critical off** only by a facility manager / org admin **with `reason`** (422 `reason_required`; a ward head → 403 `forbidden`); SOS stays active regardless (the gateway rule). Bedtime = wake → 422.
- Each field change → a `setting_change` row (`via console|app|proposal|system_revert`) + audit; republish `residents`; the response carries `gateway {desiredVersion, appliedVersion, appliedAt}`.
- **`until`:** a BullMQ delayed job at `until` writes the revert with `via: system_revert` (the gateway reverts on its own at the same time; the job keeps the cloud record in step). Cancelled if the field changes again first.
- `GET /residents/{id}/alert-settings/history` → `setting_change[]`.

### 19.4 Transfer, Pause, discharge (`07` §4.5)
- **Transfer** `POST /residents/{id}/transfer {bedId}`: the bed must be free; republish `residents`; emit `resident.moved`; the gateway updates open alerts (`updated`).
- **Pause (away)** `POST /residents/{id}/pause {reason, until}` / `DELETE`: ward head, manager, org admin; a delayed job ends it at `until`; republish `residents`; the dose generator marks doses in the pause `resident_away` (§21.3).
- **Discharge** `POST /residents/{id}/discharge {reason, at, familyAccess[]}`:
  1. refused while the mirror has an open critical / urgent / normal alert for the resident → 409 `discharge_blocked_open_alerts`;
  2. **one `familyAccess` entry per active linked family account** → else 422 `family_access_choice_required` with the missing `userIds`; each entry applied as §16.4;
  3. `status discharged | deceased | left`, `leftAt`; open device alerts are closed by the gateway when it applies `residents`;
  4. republish `residents` (the gateway ends the band assignment itself, Part 1 §9); emit `resident.left`;
  5. medications: future doses cancelled; reminders stop; nothing deleted (retention §24.5).
- `GET /residents/{id}/family-accounts` → `resident_family_link[]` for the dialog.

### 19.5 Legal hold
`POST/DELETE /residents/{id}/legal-hold {reason}` (facility manager, org admin): blocks erasure and the retention deletes for that resident (409 `legal_hold`), audited.

### 19.6 Consent (`11` §6, `15` §4)
`PUT /residents/{id}/consent {recordedAt, basis, trainingUse}` (facility manager): stored with `recordedBy`; `trainingUse` → `residents.trainingConsent` in the shadow (the gateway uploads sensor windows only when on). Withdrawal of consent to monitoring = discharge with reason `consent_withdrawn` (§24.4).

## 20. Shifts, availability and notifications (`08`)
### 20.1 Templates, patterns, shifts
- `shift_templates` (wall-clock times, optional ward), `roster_patterns` (weekly per staff member), `shifts {shiftId, userId, wardId, startsAt (UTC), endsAt (UTC), status draft|published|cancelled, templateId?, createdBy}`, `shift_changes` (history).
- Times: a template at a wall-clock time becomes UTC per date in the facility time zone (an overnight shift belongs to its start date; DST days give longer / shorter shifts). Published shifts are fixed instants.
- **Patterns** generate **draft** shifts 4 weeks ahead (nightly job); drafts never count for alerts.
- `POST /shifts`, `PATCH /shifts/{id}`, `POST /shifts/{id}/cancel`: facility manager / org admin (the manager app uses the same endpoints for quick edits). Overlapping shifts of one person in two wards → allowed with a warning in the response (`details.warnings[]`).
- `POST /shifts/publish {from, to, wardIds?}`: drafts → published; `roster_published` to each affected person; republish `roster`; `shift_changed` / `shift_cancelled` for edits of published shifts; `shift.cancelled` domain event for cancellations.
- `GET /shifts?…`, `GET /shifts/now` (per ward: on shift now ± margin, availability, open claims, next change; "nobody on shift" flag), `GET /shifts/upcoming` (7 days, headcount vs coverage), `GET /me/shifts`.
- **Who is on shift** (one function, `OnShift.at(t)`): published shifts covering `t` ± `shiftMarginMin`, active care-staff accounts only. Used by push recipients for the backend's own timers (Part 1 §8), medication reminders (§21.4) and `GET /shifts/now`. The **gateway** uses the `roster` shadow for alert recipients.

### 20.2 Coverage
- `GET/PUT /coverage-rules` (minimum staff per ward per template). A nightly and on-publish check compares published shifts to rules for the next 7 days → `coverage.gap {wardId, from, to, required, scheduled}` domain events (the Roster Coordinator's trigger) and a warning list in `GET /shifts/upcoming`. Planning only; never blocks.

### 20.3 Online availability (display only, `08` §3)
- Inputs: `POST /me/heartbeat` every 2 min (app), and the gateway's `connectivity_record` (`on_site` / `left_site`, Part 1 §8 telemetry queue).
- State per staff member, **only during their shift ± margin**: `on_site` (a local broker session), `online` (a heartbeat in the last 5 min without a local session), `offline`. Stored as `staff_connectivity_current` + `staff_connectivity_segments`; segments purged after **48 h**. `GET /staff/availability?date=` → `availability_segment[]`; WS `staff.availability` on change.
- Never acted on (D-17).

### 20.4 Schedulers
One `ShiftScheduler` in the worker computes, per tenant and per published shift, the instants below as BullMQ delayed jobs (idempotent job IDs `{kind}:{shiftId}`; recomputed when a shift or setting changes):
| Instant | Effect |
|---|---|
| start − reminder (60 min) | `shift_reminder` to that person |
| start − 60 min | `shift.starting` domain event (charging rota) |
| start | `alert_setup_needed` if the person's latest readiness is incomplete |
| end − handover minutes | `shift.ending` domain event (Part 1 §11) |
| end | `incident_confirm` reminders for proposals the person must confirm (§29.2) |

Plus a facility-level job: **roster gap** (`08` §4): 60 min before a period with no published shift at the facility, and when it starts → `roster_gap` to managers.

### 20.5 Notifications
- `staff_notifications {notificationId, userId, type (notificationType), textKey, textArgs, refType, refId, createdAt, readAt}`; `GET /me/notifications`, `POST /me/notifications/{id}/read`; WS `notification.created` to `user:{tenantId}:{userId}`.
- Every notification is also a `push_notification` (contracts §7.6, `updates` channel, normal priority) unless the user's notification settings turn that type off (`notification_settings` per user, all on by default; `shift_reminder` can't be turned off for staff with no other channel).
- **Never to family accounts** (D-13).

### 20.6 Push endpoints
Part 1 §10 (`POST /push-tokens`) applies; additionally a **family login never registers a push endpoint** (`POST /push-tokens` with a family token → 403 `forbidden`), and an account switch on the same installation deletes the old endpoint first.

## 21. Medications (`21` §1–§9, contracts §7.16, D-98, D-111)
**Records and reminders only, never advice:** nothing here checks, computes or suggests a dose.
### 21.1 Tables
`medications` (current version, the link to the recommendation), `medication_versions` (every version, immutable), `medication_schedules` (per version), `medication_log` (append-only; the DB user has `INSERT` only), `medication_doses`, `medication_rounds`, `dose_marks` (history rows).

### 21.2 Records
- `POST /residents/{id}/medications` and `PATCH /medications/{id}` require **`doctorRecommendationId`** (D-111): the item must be the **same resident's** Medical records item, category `doctor_recommendation`, current version `scanStatus clean` (reference / text items count as clean) → else 422 `doctor_recommendation_invalid` (`details.reason not_found|other_resident|wrong_category|not_clean`); missing → 422 `doctor_recommendation_required` (`missing`).
- A PATCH that changes `name`, `dose`, `form`, `route` or `schedule` must link a **different** item or a **newer version** of the linked one → else 422 `doctor_recommendation_required` (`new_recommendation_needed`). Other edits may keep the link. Every change: version + 1, a `medication_log` row **in the same transaction** with `changes[]` and the `doctor_recommendation_ref`, an audit row.
- `pause | resume | stop {reason}` keep the link and log it. A stopped medication is kept.
- The Medical records item's `linkedMedicationIds` is maintained here (§22.5 refuses moving a linked item out of `doctor_recommendation`).
- Rights: create / edit / pause / stop = ward head, facility manager, org admin; read = any care staff; family → 403.

### 21.3 Doses
- **Generation:** a worker job creates `medication_doses` for active regular schedules **48 h ahead** (wall-clock times in the facility time zone), on every schedule change (replacing only **future `due`** doses of that medication) and hourly. `every_n_days` counts from `anchorDate`.
- **Rounds:** doses due inside one on-time window (`± onTimeWindowMin` of a time) for one ward form a `medication_round {roundId, wardId, dueAt, window}`; counts are derived.
- **Status changes by the system:** `not_recorded` at due + `notRecordedAfterMin` (default 2 h); `resident_away` for doses due while the resident is paused; future doses cancelled on stop, resident discharge or pause of the medication.

### 21.4 Reminders (`21` §3; not alerts)
- **Recipients:** on-shift staff (§20.1 `OnShift`) whose shift ward is the round's ward; if none, everyone on shift; `medication_overdue` also to the ward's on-shift ward heads.
- Jobs per round: `medication_round_due` at `dueAt − leadMin`; `medication_overdue` at `dueAt + overdueAfterMin` if any dose is still `due`. Push `push_medication` (contracts §7.6: ward + resident count only, collapse `med-{roundId}`, Time Sensitive, `medication` channel). **Never via the gateway, never to family, never with names.**
- Rounds are re-checked when marks arrive; a fully marked round sends nothing more.

### 21.5 Marking, undo, PRN
- `POST /doses/{id}/mark` (`dose_mark`, `Idempotency-Key` **required**): allowed on `due`; on `not_recorded` only as a **correction** by ward head / manager / org admin with `reason`. `held` needs `heldReason` (and `reason` when `heldReason: other`). `markedAt` from the client is kept if within 24 h and not in the future, else server time + tag `clock_adjusted`. `onTime` from the window. A second mark → 409 `dose_already_marked` with `details {status, markedBy, markedAt}`. Same `Idempotency-Key` → the stored answer (offline queue replays).
- `POST /doses/{id}/undo` (`dose_undo`): the marker within **10 min** of `markedAt` without a reason; otherwise ward head / manager / org admin with a reason (422 `reason_required`); a caregiver after 10 min → 409 `undo_window_passed`. The dose returns to `due` (or `not_recorded` if past due + 2 h); history kept; audited `dose_undone` / `dose_corrected`.
- `POST /residents/{id}/prn-doses` (`prn_dose`): the medication must have a `prn` schedule; creates `{kind: prn, status: given}`; the response includes the previous `lastGivenAt`; never blocks.
- Each change → WS `dose.updated` (IDs and status only) to `facility` and `staff`.

### 21.6 Views
- `GET /medication-rounds?ward=&date=`, `GET /medication-rounds/{roundId}` (with `items[]`), `GET /residents/{id}/doses?from=&to=`, `GET /residents/{id}/medications?status=`, `GET /medications/{id}/history`, `GET /residents/{id}/medication-log?from=&to=`.
- **MAR** `GET /mar` (`mar_query`, ≤ 31 days; ward head, manager, org admin): JSON `mar_view` (`onTimePct` per ward and period, **no per-caregiver figure**) or `format=pdf` → a PDF rendered in the worker with `pdfmake` (A4 landscape, one resident per page group, the log in the period) to `{tenantId}/exports/mar/…`, 302 to a presigned GET (≤ 15 min). Audited `mar_exported`.
- `GET /me/medication-schedule?hours=24` (≤ 48) → `my_medication_schedule` for the wards the user is reminded for; the app's offline cache.

### 21.7 Suspension
Everything in §21 keeps working while suspended (D-104, contracts §7.13).

### 21.8 What leaves this module
- `medication_counts` (internal read tool, `coordinator` only, counts and IDs) is the **only** medication data agents get (Part 1 §11).
- **Medication-name check on agent text:** the backend holds the tenant's medication names, so it checks every `POST /internal/v1/outputs`, `/proposals`, `/aria/messages` body (title, body, translations, payload strings) against them (case-insensitive, word-boundary, plus the contracts generic medicine / dose pattern list) and refuses a match with 422 `validation_failed` (`details.reason medication_name`). Names never leave the backend (the agents' own Quality Gate keeps its generic list).
- Never in push text, Parquet, domain events, the gateway, family endpoints (except the opt-in `medicines_on_time` percentage card, §26.2) or logs.

## 22. Medical records (`21` §10, contracts §7.17, D-112)
### 22.1 Items and versions
`medical_records`, `medical_record_versions`, `medical_record_files {fileId, versionId, s3Key, contentType, sizeBytes, sha256, thumbnailKey?}`. Rights: create / new version / patch = ward head, facility manager, org admin; read = any care staff; family → 403. **Keeps working while suspended** (D-104).

### 22.2 Uploads (presigned, no multipart through the API)
1. `POST /residents/{id}/medical-records` (`medical_record_create`): `reference` / `text` → 201 `medical_record` (`scanStatus clean`); `picture` (1–20 files) / `file` (1 PDF) → 201 `medical_record_upload_grant`: one presigned PUT per file to `{tenantId}/medical-records/{residentId}/{medicalRecordId}/{versionId}/{fileId}`, signed with `Content-Type`, `x-amz-checksum-sha256` and SSE-KMS with the **tenant key**, ≤ 15 min. Types: JPEG, PNG, HEIC, PDF only; ≤ 20 MB each (422 otherwise).
2. The client PUTs, then `POST /medical-records/{id}/versions/{versionId}/complete`: the backend `HeadObject`s each file (size, type, checksum must match the create request) → `scanStatus pending`.
3. **Scan:** GuardDuty Malware Protection for S3 (infra) tags each object and emits a result event; infra routes it to the queue `sc-{env}-scan-results`; the worker sets the version `clean` when every file is clean, or `infected` (objects moved to `{tenantId}/quarantine/…`, never served; the uploader gets "File rejected" as a `staff_notification`). No result after 30 min → `scan_failed`, alarmed, not served.
4. **Thumbnails** for JPEG / PNG pictures (`sharp`, 320 px) after `clean`; HEIC gets `thumbnailAvailable: false` (served full-size only).
5. A version not completed within **24 h** is discarded with its objects (nightly job).
6. A `care_plan` item whose version turns `clean` → domain event `document.uploaded {medicalRecordId, versionId, residentId, category: "care_plan"}`. **No other category emits anything.**

### 22.3 Reading files
`GET /medical-records/{id}/file?version=&page=&thumbnail=` → 302 presigned GET (≤ 15 min, `Cache-Control: no-store`), 409 `file_not_ready` unless `clean`. Audited `medical_record_viewed` (first view per user per item per day).

### 22.4 New versions and edits
- `POST /medical-records/{id}/versions` (`medical_record_version_create`): same flow; the item's `currentVersionNo` moves on `clean` (references / text at once). Old versions stay.
- `PATCH /medical-records/{id}` (`medical_record_patch`): title, category, date, source; moving a `doctor_recommendation` that a non-stopped medication links to → 409 `medical_record_linked` with `details.medicationIds`. `source` must stay non-empty for `doctor_recommendation`.

### 22.5 AI boundary
The internal API serves **only `care_plan`** items as `care_plan_document` (Part 1 §11), only `clean` versions, files through `GET /internal/v1/care-plan-documents/{id}/file` (presigned ≤ 15 min, Care Plan Specialist only). A contract test seeds one item of every category and asserts only the `care_plan` one comes back.

## 23. Voice notes (alerts)
- `POST /alerts/{id}/voice-notes` → `upload_grant` (audio `audio/mp4` or `audio/aac`, ≤ 2 min, ≤ 5 MB) to `{tenantId}/voice-notes/{alertId}/{attachmentId}`; then the note is attached by the alert's `resolve` (`voiceNoteId`) or by `POST /alerts/{id}/voice-notes/{attachmentId}/complete`.
- **Transcription:** an Amazon Transcribe job (`en-US` / `en-GB`; Sinhala and Tamil aren't supported, O-37) writes the transcript next to the audio; for a language Transcribe can't handle, or confidence < 0.6, the note is stored "not transcribed". Agents never guess its content (`11` §4.5).
- Served to care staff by presigned GET; never to family; never in push. Retention: as the alert (7 years).

## 24. Audit, exports, data requests and retention (`04` §8, `15` §3–4)
### 24.1 Audit
- `audit.events` (`audit_event`), **insert-only** for the app user (Part 1 §5 kept code). Written for every action in `04` §8 and every audited action named in this spec, also while suspended. Actor kinds `user | org_admin | ops | system | agent | gateway`.
- **Family ARIA messages: metadata only** (who, when, resident, message length; D-113). A test asserts no audit row ever has message text.
- `GET /audit?from=&to=&action=&actorId=&targetType=` (facility manager, org admin) and export as CSV through §24.2.
- Ops actions on a tenant are also written to `platform_audit` (§31).

### 24.2 Exports
- `POST /exports {kind (facility_full|resident|audit|alerts|medications), residentId?, from?, to?}` → `export_job` (async; worker writes a ZIP of CSV / JSON (+ files for `resident` and `facility_full`) to `{tenantId}/exports/jobs/{exportId}.zip`); `GET /exports/{id}` → status + presigned GET (≤ 15 min) when done. Facility manager / org admin; audited.
- **Never included:** family ARIA chat content (D-113), raw LLM prompts. Medication exports only through `kind: medications` (care records, to the facility itself).

### 24.3 Data requests (PDPA, `15` §4)
- `GET/POST /data-requests`, `PATCH /data-requests/{id}` (`data_request`): the register; `dueAt` = received + 30 days (PDPA default, Arch call); mirrored to the control DB for the ops register (§31.7).
- Actions the manager runs from a request: **export** (`kind: resident` export), **correct** (normal edit endpoints, linked to the request), **erase** (§24.4), **withdraw consent** (discharge with `consent_withdrawn`).

### 24.4 Erasure (D-68)
`POST /residents/{id}/erase {dataRequestId}` (facility manager; 409 `legal_hold` under a hold): in one job, delete profile details beyond the ID, notes, voice notes, every Medical records item version and file, ARIA chats (staff and family) whose `residentIds` include the resident, case traces and prompts about them, telemetry summaries and sensor windows (and mark them out of future training exports); **keep** alert records, actions and audit until their retention ends, with the resident's display name replaced by `Resident {residentNo}` and the name visible to managers only via the audit. The data request records what was kept and why.

### 24.5 Retention jobs (`15` §3)
A nightly per-tenant job (skipping residents under legal hold):
| Data | Rule |
|---|---|
| `telemetry.samples_10s` | 90 days → 1-minute rollups kept 2 years |
| ARIA messages (staff + family) | 90 days |
| raw LLM prompts / responses in traces | 30 days (structured trace kept with its output) |
| availability segments | 48 h |
| sensor windows (S3) | 3 years |
| frozen family links | removed at `removeAt`; account deactivated when no active link is left |
| alerts, actions, audit, medication records, Medical records, care records | 7 years (after discharge where `15` §3 says so), then deleted |
| incomplete Medical records versions | 24 h |

## 25. Live view, trends and metrics (`07` §10, contracts §7.5)
- **`resident.status`** (WS, ≤ 1 per resident per 10 s): derived in the worker from `telemetry_batch` + the alert mirror + the assignment mirror (`bandAssigned` boolean only, never a `bandId`).
- `GET /live` → residents (`ws_resident_status`), open alerts, gateway status, on-shift availability: what the console's live floor and the app load after a reconnect.
- `GET /residents/{id}/trends?range=(7d|30d|12w)` → daily / weekly series from rollups (activity, night stand-ups, wet-pad episodes, wear time, relative temperature) for the console charts.
- `GET /metrics?metric=&from=&to=&groupBy=` → `metrics_series` (contracts §7.11): time to claim / arrival / resolve (median, p90), unclaimed escalations, step-ins, ward-head escalations, no-recipient alerts, false-alarm rate per bed per week, alerts per resident, stand-up attempts (alerted + logged). Computed from the alert mirror and logged events by SQL views, cached 5 min. `groupBy=caregiver` → **facility managers and org admins only** (403 otherwise; `15` §1). Inferred arrivals are excluded from arrival times.
