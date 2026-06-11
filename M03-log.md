# M03 — Full Backend System Reference (post-remediation)

**Date:** 2026-06-10
**Project:** SoterCare Backend (`back-end`)
**Branch:** `fix/m02-audit`
**Supersedes for current state:** [`M02-log.md`](./M02-log.md) (the pre-fix reference + audit)

This is the up-to-date "how everything connects" document. It mirrors M02's
structure but reflects the code **after** the M02 audit findings were fixed.
Section 16 is the remediation changelog mapping every finding → fix → file →
commit. Every claim was verified against the current source.

---

## 1. What this system is

SoterCare is a cloud backend for **24/7 elderly-care monitoring**. A wearable
device (thigh/wrist band + Raspberry Pi hub) measures vitals (temperature,
ambient temperature, moisture, gait, **SpO₂, heart rate**, SOS, fall) and pushes
them to the cloud. The backend authenticates users (passwordless email-OTP) and
devices (hashed device keys), ingests vitals (REST batch, Pi direct, live
WebSocket), persists to PostgreSQL, runs an AI layer (real-time Safety Guard +
prescription/history RAG + scheduled clinical reports), and serves the mobile
app (dashboard, timeline, alerts, devices, reports, summaries).

It is a **NestJS monorepo** of 4 TypeScript services + 1 Python gRPC service,
wired over **gRPC**, fronted by a single **HTTP/WebSocket API Gateway**.

> **What changed in M03:** heart_rate/SpO₂ now flow end-to-end into `vital_sign`;
> the Safety Guard attributes alerts to a real `device_id`; JWT/secret handling
> fails closed; OTP endpoints are throttled; schema auto-sync is disabled in
> production; and the Python↔Postgres column-naming mismatch (camelCase vs
> snake_case) that silently broke the AI layer is fixed.

---

## 2. Architecture at a glance

```
                          ┌──────────────────────────────────────────┐
   Mobile App  ──HTTP────▶│            API GATEWAY (NestJS)           │
   (REST + WS) ──WS──────▶│  HTTP/WS :3000 — only public surface      │
                          │  CORS + global ValidationPipe + throttle  │
                          └───┬───────────┬────────────┬─────────────┘
                              │ gRPC      │ gRPC        │ gRPC
                  AUTH_SERVICE│  HEALTH_  │  SUMMARY_   │
                              │  SERVICE  │  SERVICE    │
                  ┌───────────▼──┐ ┌──────▼──────┐ ┌────▼──────────────┐
                  │ auth-service │ │health-service│ │ ai-summary-service│
                  │   :50051     │ │   :50054     │ │  (Python) :50053  │
                  └──────┬───────┘ └──────┬───────┘ └────┬──────────────┘
                         │ gRPC           │              │ 3 bg threads:
                  EMAIL_SERVICE           │              │  • Safety Guard
                  ┌──────▼───────┐        │              │  • Report Sched.
                  │ email-service│        │              │  • gRPC server
                  │  :50052      │        │              │
                  │  (Resend)    │        ▼              ▼
                  └──────────────┘  ┌───────────────────────────────────┐
                                    │ PostgreSQL :5432 (+ pgvector)      │
                                    │ Redis      :6379 (OTP, throttle,   │
                                    │                    idempotency)    │
                                    └───────────────────────────────────┘
```

- The **API Gateway is the only externally exposed service**; all others are
  gRPC microservices.
- The Python AI service has no HTTP server; it is a gRPC server + two background
  threads, and calls back to the gateway only for the internal alert webhook.
- All NestJS services share one PostgreSQL database (`auth_db`). **Column names
  are camelCase** (TypeORM default naming) and the Python SQL now quotes them
  accordingly.

---

## 3. Services & ports

| Service | Language | Transport | Default URL / Port | Env override | Entry point |
|---|---|---|---|---|---|
| **api-gateway** | NestJS | HTTP + WebSocket | `0.0.0.0:3000` | `PORT` | `apps/api-gateway/src/main.ts` |
| **auth-service** | NestJS | gRPC (`auth`) | `0.0.0.0:50051` | `AUTH_GRPC_URL` | `apps/auth-service/src/main.ts` |
| **email-service** | NestJS | gRPC (`email`) | `0.0.0.0:50052` | `EMAIL_GRPC_URL` | `apps/email-service/src/main.ts` |
| **ai-summary-service** | Python | gRPC (`summary`) | `[::]:50053` | `SUMMARY_GRPC_PORT` | `apps/ai-summary-service/src/main.py` |
| **health-service** | NestJS | gRPC (`health`) | `0.0.0.0:50054` | `HEALTH_GRPC_URL` | `apps/health-service/src/main.ts` |
| **PostgreSQL** | — | TCP | `localhost:5432` (`auth_db`) | `DATABASE_URL` / `DB_*` | compose / managed |
| **Redis** | — | TCP | `localhost:6379` | `REDIS_URL` / `REDIS_*` | compose / managed |

### gRPC client wiring

| Caller | Client token | Proto / package | Target (env → default) | Defined in |
|---|---|---|---|---|
| api-gateway | `AUTH_SERVICE` | `auth` | `AUTH_SERVICE_URL` → `localhost:50051` | `api-gateway.module.ts` |
| api-gateway | `HEALTH_SERVICE` | `health` | `HEALTH_SERVICE_URL` → `localhost:50054` | `api-gateway.module.ts` |
| api-gateway (summary) | `SUMMARY_SERVICE` | `summary` | `SUMMARY_GRPC_URL` → `localhost:50053` | `summary/summary.module.ts` |
| auth-service | `EMAIL_SERVICE` | `email` | `EMAIL_SERVICE_URL` → `localhost:50052` | `auth-service.module.ts` |
| ai-summary-service | (HTTP webhook) | — | `GATEWAY_INTERNAL_URL` → `http://localhost:3000` | `safety_guard.py` |

`docker-compose.yml` now exposes **50054** as well, and sets the matching
`HEALTH_SERVICE_URL`/`HEALTH_GRPC_URL`.

---

## 4. HTTP REST API (api-gateway)

**Base URL:** `http://<host>:3000` · **Swagger UI:** `GET /api`
**Global middleware** (`apps/api-gateway/src/main.ts`):
- 50 MB body limit, gzip compression.
- **`app.enableCors({ origin: CORS_ORIGIN?.split(',') ?? true, credentials: true })`** (new).
- **Global `ValidationPipe({ transform: true })`** (new) — enforces DTO
  `class-validator` decorators and coerces payload types. `whitelist` is off by
  design (several DTOs are `@ApiProperty`-only).
- `HttpExceptionFilter` + `ResponseInterceptor` (wraps non-`success` returns as
  `{ success: true, data }`).
- `IdempotencyInterceptor` on selected controllers (24h Redis replay cache) —
  **removed from `/auth`** (was caching OTP-send responses).

**Auth:** JWT Bearer (`JwtAuthGuard`), decoded user `{ userId, email, name }`.

### 4.1 Auth — `/auth` (public; rate-limited via `AuthThrottleGuard`)
| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/auth/register` | `{ name, email }` | Start registration → OTP email (5-min TTL) |
| POST | `/auth/verify` | `{ email, otp }` | Verify reg OTP → creates user, returns `accessToken` + `user` |
| POST | `/auth/login` | `{ email }` | Start login → OTP email (user must exist) |
| POST | `/auth/login-verify` | `{ email, otp }` | Verify login OTP → `accessToken` + `user` |

Now protected by per-IP throttling and per-email OTP lockout (see §7).

### 4.2 User profile — `/user` (JWT)
`GET /user/profile` (adds `hasClaimedDevice`), `POST /user/update`,
`POST /user/email/initiate`, `POST /user/email/verify`.

### 4.3 Health logs (vitals) — `/logs`
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/logs/sync` | JWT | Mobile vitals push → HealthService. **Now forwards `heart_rate`/`spo2`.** |
| POST | `/logs/raspberry/sync` | Device key (fail-closed `RASPBERRY_API_KEY` + `x-device-key`) | Pi direct. **Now forwards `heart_rate`/`spo2` + resolved `device_id`; `toUnixMs` handles unix seconds.** |
| GET | `/logs/dates` | JWT | Dates with logs |
| GET | `/logs/range` | JWT | `?startDate=&endDate=` (ISO 8601) |

### 4.4 Sync (batch) — `POST /sync/raspberry-pi` (JWT)
Transactional multi-entity upsert, idempotent via `sync_history.idempotencyKey`.

### 4.5 Devices — `/devices`
Read (JWT): `GET /devices`, `GET /devices/:deviceId/status`.
IoT: `POST /devices/claim` (JWT), `POST /devices/unclaim` (JWT),
`POST /devices/register` (**fail-closed `DEVICE_BOOTSTRAP_KEY` via `x-admin-key`**).

### 4.6 Dashboard — `GET /dashboard/vitals/latest?deviceId=` (JWT)

### 4.7 Alerts — `/alerts` (JWT, except internal)
`GET /alerts/recent`, `GET /alerts/attended`, `PATCH /alerts/:id/attend`,
`PATCH /alerts/:id/false-alarm`, and
`POST /alerts/internal/alert-ready` (**fail-closed `INTERNAL_SERVICE_TOKEN` via
`x-internal-token`; the no-op `@UseGuards()` was removed**).

### 4.8 Timeline — `/timeline` (JWT)
`vitals`, `events`, `stats`, `date-options`, `dismissed`, `restore`, `dismiss`.

### 4.9 Reports — `/reports` (JWT)
`POST /reports/export`, `GET /reports/devices`.

### 4.10 Summary / AI — `/summary` (JWT)
| Method | Path | Notes |
|---|---|---|
| POST | `/summary` | Generate clinical report. **Now passes the authenticated `user_id` to `AnalyzeData`; throws `BadGateway` if the engine returns an empty/malformed report** (no more blank reports). Daily cache retained. |
| POST | `/summary/upload-prescription` | PDF → pgvector embed |
| POST | `/summary/query-prescription` | RAG Q&A over prescriptions |

### 4.11 Misc — `GET /` (hello), `GET /api` (Swagger).

---

## 5. WebSocket API (`/realtime`)

Socket.IO namespace `/realtime`, CORS `*`. Clients auth with JWT
(`handshake.auth.token`), devices auth with `device_auth` (`device_id` +
`device_key`, hashed-key verification). **JWT verification now requires a real
`JWT_SECRET`** (no `REMOVED-OLD-PUBLIC-FALLBACK` fallback).

| Event | Dir | Notes |
|---|---|---|
| `device_auth` | in | authenticates a device socket |
| `device_data` | in | live vitals → writes `vitals` timeline + alerts (AlertWriterService) + `vital_sign` (gRPC). **Now carries `heart_rate`/`spo2`/`device_id`.** |
| `device.logs.ingested` | out | `{ device_id, count, logs, ingested_at }` |
| `alert.new` | out | pushed by `/alerts/internal/alert-ready` → `pushLatestAlert` |

---

## 6. gRPC contracts (`libs/common/src/proto/`)

### 6.1 `auth.proto` (auth-service :50051)
`RegisterUser`, `VerifyRegistration`, `LoginInit`, `LoginVerify`,
`UpdateProfile`, `GetProfile`, `InitiateEmailUpdate`, `VerifyEmailUpdate`.
`User = { id, email, name, mobileNumber }`.

### 6.2 `health.proto` (health-service :50054)
`SyncLogs`, `GetLogDates`, `GetLogsByDateRange`.
`LogEntry = { id, temperature, ambient_temp, moisture, gait_label, sos,
thighnode_status, fall_alert, timestamp, heart_rate, spo2, `**`device_id`**` }`
— **`device_id` (field 12) added** so readings carry their physical device.

### 6.3 `summary.proto` (ai-summary-service :50053)
`AnalyzeData`, `UploadPrescription`, `QueryPrescription`.
`AnalyzeDataRequest = { data_json, format, `**`user_id`**` }` — **`user_id`
(field 3) added** for correct report attribution.

### 6.4 `email.proto` (email-service :50052)
`SendOtpEmail { email, otp, name? }`.

---

## 7. Authentication & authorization (post-fix)

### 7.1 User auth (passwordless email OTP)
Unchanged flow (register/verify/login/login-verify) with these hardenings:
- **JWT secret is required** — boot fails if `JWT_SECRET` is unset (no public
  fallback). Same secret across gateway, auth-service, and the WS gateway.
- **JWT lifetime** is `JWT_EXPIRES_IN` (default **7d**), down from 90d.
- **OTP brute-force protection (H7):**
  - Per-IP `AuthThrottleGuard` on `/auth/*` (`AUTH_THROTTLE_LIMIT` per
    `AUTH_THROTTLE_TTL` seconds; Redis-backed; fails open on Redis error).
  - Per-email lockout in auth-service: after `OTP_MAX_ATTEMPTS` (default 5) wrong
    codes, verification short-circuits to `false` for `OTP_LOCKOUT_SECONDS`
    (default 900). Successful verify clears the counters.
- Auth routes no longer use the idempotency cache (which previously suppressed
  re-sends of OTPs).

### 7.2 Device auth
Hashed device keys (`scrypt` salt:hash, constant-time compare). Claim requires
the device to be online within `IOT_ONLINE_TTL_SECONDS` when
`IOT_CLAIM_REQUIRE_ONLINE=true`.

### 7.3 Machine-auth endpoints — now **fail closed**
| Secret (env) | Endpoint | Behavior when unset |
|---|---|---|
| `RASPBERRY_API_KEY` | `POST /logs/raspberry/sync` | endpoint disabled (403) |
| `DEVICE_BOOTSTRAP_KEY` | `POST /devices/register` | endpoint disabled (400) |
| `INTERNAL_SERVICE_TOKEN` | `POST /alerts/internal/alert-ready` | endpoint disabled (401) |

(Previously a missing secret **bypassed** the check.)

---

## 8. Data ingestion paths

1. **Mobile REST** `POST /logs/sync` (JWT) → HealthService → `vital_sign`.
2. **Pi direct** `POST /logs/raspberry/sync` (device key) → resolves owner +
   device, replay-checks, → `vital_sign` (with device_id, hr, spo2), upserts
   dashboard `vitals`, emits WS.
3. **Live WS** `device_data` → `vitals` + alerts + `vital_sign`.
4. **Full batch** `POST /sync/raspberry-pi` (JWT) → transactional upsert,
   idempotent.

All four now propagate `heart_rate`/`spo2`; #2 and #3 also propagate `device_id`.
`vital_sign` has a **unique `(userId, timestamp)`** index and inserts use
**insert-or-ignore** to dedupe retries.

---

## 9. AI / ML layer (`apps/ai-summary-service`)

`src/main.py` runs three components:

### Agent 1 — Safety Guard (`core/safety_guard.py`)
Threshold-only (no LLM). Polls `vital_sign` every `POLL_INTERVAL_SECONDS` (10),
tracking a cursor in `monitor_state`. **Now:**
- Reads camelCase columns (quoted, aliased to snake) including `"deviceId"` —
  previously it queried non-existent snake columns and failed every poll.
- **Persists `heart_rate`/`spo2`** that finally have data, so the CRITICAL low-
  SpO₂ and HIGH heart-rate checks are live.
- Uses correct alert **types** (`spo2`, `heart_rate`) and **deterministic alert
  ids** (`prefix_deviceId_timestamp`) that collide with the gateway's
  AlertWriterService rows (no duplicates).
- **Skips readings with no `device_id`** instead of forging `device_id = user_id`
  (which violated the `alerts → devices` FK).

Thresholds (env-tunable): SpO₂<92 (CRITICAL), HR>120/<45 (HIGH),
temp>38.0/<35.5 (HIGH), moisture>80/<15 (MEDIUM), SOS/fall (CRITICAL). Cooldowns
5/15/30 min by severity.

### Agent 2 — Prescription & History RAG (`core/rag_agent.py`)
PDF → chunk → embed (Gemini `text-embedding-004`, dim 768, or OpenAI) → pgvector
`embeddings`. `UploadPrescription` / `QueryPrescription`; user-isolated.

### Agent 3 — Clinical Report (`core/report_agent.py`)
Structured `HealthReport` (Pydantic). Wall-clock scheduler every
`REPORT_INTERVAL_HOURS` (6) + on-demand `AnalyzeData`. **Now reads camelCase
`vital_sign` columns and writes camelCase `summary_history` columns** (quoted),
and attributes on-demand reports to the JWT `user_id`.

### LLM fallback (`core/llm_provider.py`)
Gemini → Claude → OpenAI → Grok (key-gated). `core/utils.invoke_with_fallback`.

### gRPC server
`SummaryServicer` over a psycopg2 pool; `AnalyzeData` uses `request.user_id`.

### Migrations (`src/migrations/`)
`001` hr/spo2 (snake), `002` monitor_state, `003` pgvector, `004` summary_history
windowing. **Note:** `001`/`004` add snake-case duplicate columns that the
TypeORM (camelCase) tables don't use; they are now harmless dead columns (see
§16 notes).

---

## 10. Database schema (PostgreSQL)

Tables (TypeORM, **camelCase columns**, table names snake-cased from the class).
`synchronize` is now **enabled only when `NODE_ENV !== 'production'`**.

- **`user`**: id, email (unique), name, mobileNumber?, createdAt.
- **`vital_sign`**: id, userId, **deviceId? (new)**, temperature, ambientTemp?,
  moisture?, sos?, fallAlert?, gaitLabel?, thighnodeStatus?, heartRate?, spo2?,
  timestamp (bigint), syncedAt. **Unique `(userId, timestamp)` (new)**.
- **`devices`**, **`device_statuses`**, **`vitals`** (unique `(deviceId,timestamp)`),
  **`alerts`**, **`recording_sessions`**, **`sync_history`**, **`iot_devices`**,
  **`summary_history`** — as in M02.
- **`alerts.type`** enum now includes **`spo2`** and **`heart_rate`** in addition
  to movement/fall/urine/temperature/moisture/help_call.
- Python-managed: `monitor_state`, `embeddings`, `embedding_config`.

---

## 11. Configuration / environment variables

A complete template lives in **`.env.example`** (new). Highlights & new vars:

| Var | Default | Notes |
|---|---|---|
| `NODE_ENV` | development | **`production` disables TypeORM synchronize** |
| `JWT_SECRET` | — | **required** (boot fails if unset) |
| `JWT_EXPIRES_IN` | `7d` | token lifetime (was hard-coded 90d) |
| `CORS_ORIGIN` | (unset → allow all) | comma-separated allowlist |
| `OTP_MAX_ATTEMPTS` / `OTP_LOCKOUT_SECONDS` | 5 / 900 | per-email OTP lockout |
| `AUTH_THROTTLE_LIMIT` / `AUTH_THROTTLE_TTL` | 10 / 60 | per-IP `/auth/*` throttle |
| `RASPBERRY_API_KEY` / `DEVICE_BOOTSTRAP_KEY` / `INTERNAL_SERVICE_TOKEN` | — | **fail closed when unset** |
| `IOT_MAX_CLOCK_SKEW_MS` / `IOT_ONLINE_TTL_SECONDS` / `IOT_CLAIM_REQUIRE_ONLINE` | 900000 / 300 / true | |
| DB/Redis/gRPC URLs, AI thresholds, embeddings, LLM keys | — | as in M02 / `.env.example` |

> `.env` is **gitignored and was never committed** (verified). Operators should
> still rotate any keys shared out-of-band.

---

## 12. How to run

### Local
```bash
npm install
# start Postgres + Redis (docker compose up postgres redis)
# set at least JWT_SECRET (see .env.example)
npm run start:all     # gateway + auth + email + health + ai (concurrently)
```
Build: `npm run build:api|auth|email|health`. Tests: `npx jest`.
Python stubs (deploy): `python -m grpc_tools.protoc -I libs/common/src/proto
--python_out … --grpc_python_out … health.proto summary.proto`.

### Docker
Single all-in-one image (`Dockerfile`) builds all 4 NestJS apps + the Python
service; `EXPOSE 3000 50051 50052 50053 50054 6379`; `CMD ["./start.sh"]`.
`start.sh` skips embedded Postgres/Redis when `DATABASE_URL`/`REDIS_URL` (managed)
are set. **Set `NODE_ENV=production` in prod** so schema auto-sync is off — run
migrations to manage schema.

### Deploy (Koyeb / managed)
Managed Postgres + Redis via `DATABASE_URL`/`REDIS_URL` (SSL auto). Public-expose
only `3000`. Set `JWT_SECRET`, the three machine-auth secrets, and the OTP/throttle
tunables.

---

## 13. Source map

| Concern | File(s) |
|---|---|
| HTTP bootstrap, CORS, ValidationPipe, Swagger | `apps/api-gateway/src/main.ts` |
| Gateway module (gRPC clients, DB sync gate, JWT) | `apps/api-gateway/src/api-gateway.module.ts` |
| Auth routes + throttle | `auth.controller.ts`, `common/guards/auth-throttle.guard.ts` |
| Vitals routes | `health.controller.ts`, `reports.controller.ts` |
| Feature modules | `{alerts,dashboard,devices,iot-device,realtime,summary,sync,timeline}/` |
| WebSocket | `realtime/realtime.gateway.ts`, `realtime/alert-writer.service.ts` |
| JWT | `auth/jwt.strategy.ts`, `common/guards/jwt-auth.guard.ts` |
| Auth microservice (+ OTP lockout) | `apps/auth-service/src/auth-service.{controller,service,module}.ts` |
| Health microservice | `apps/health-service/src/{health-service.service.ts,vital-sign.entity.ts}` |
| AI service | `apps/ai-summary-service/src/{main.py,core/*.py}` |
| Protos | `libs/common/src/proto/*.proto` |
| Entities | `apps/api-gateway/src/database/entities/`, `iot-device/`, `summary/` |
| Deploy | `Dockerfile`, `start.sh`, `docker-compose.yml`, `.env.example` |
| Tests (new) | `health-service.service.spec.ts`, `auth-throttle.guard.spec.ts`, `auth-service.otp-lockout.spec.ts` |

---

## 14. Verification status

- **Builds:** `nest build` passes for all 4 NestJS apps (api-gateway, auth-service,
  email-service, health-service).
- **Tests:** `npx jest` → **22/23 passing**. The single failure
  (`timeline.service.spec.ts`) is **pre-existing** — that file and its spec are
  byte-identical to `main` and unrelated to this branch.
- **Python:** edits to `safety_guard.py`, `report_agent.py`, `main.py` were
  verified by inspection only — the venv/DB aren't runnable in this environment.
  They need an integration test against a real Postgres before deploy (see §16
  caveats).

---

# 15. Branch / commit map

| Commit | Findings |
|---|---|
| `02a0d37` | C1, C2, M1, M2, M3, M5 — safety/AI data pipeline |
| `70f9352` | C3, H2, H5 — schema sync + JWT hardening |
| `80318da` | H1, H4, L1 — fail-closed auth + validation/CORS |
| `36bb5e2` | H3 — `.env.example` |
| `511199a` | H6, H7, M7, M8 — alert engine alignment + OTP throttling |
| `30a33d1` | M6, L4, L7, L8 — compose ports, PII logging, pinned deps, surfaced errors |
| `3db2414` | tests — C1/M5, H7 coverage |

---

# 16. Remediation changelog (every M02 finding)

| ID | Sev | Status | Fix summary | Key files |
|---|---|---|---|---|
| **C1** | 🔴 | ✅ Fixed | heart_rate/spo2 threaded through all 3 ingest mappers and persisted in health-service | `health.controller.ts`, `realtime.gateway.ts`, `health-service.service.ts`, `health.proto` |
| **C2** | 🔴 | ✅ Fixed | `device_id` added to `LogEntry` + `vital_sign`; guard reads it, skips device-less rows, no FK violation; Python SQL aligned to camelCase columns | `health.proto`, `vital-sign.entity.ts`, `safety_guard.py`, `report_agent.py`, ingest mappers |
| **C3** | 🔴 | ✅ Fixed | `synchronize: NODE_ENV !== 'production'` in all 3 TypeORM modules | `api-gateway.module.ts`, `auth-service.module.ts`, `health-service.module.ts` |
| **H1** | 🟠 | ✅ Fixed | three machine-auth endpoints fail closed when secret unset | `health.controller.ts`, `iot-device.controller.ts`, `alerts.controller.ts` |
| **H2** | 🟠 | ✅ Fixed | removed `'REMOVED-OLD-PUBLIC-FALLBACK'`; require `JWT_SECRET` (boot throws) | `api-gateway.module.ts`, `auth-service.module.ts`, `jwt.strategy.ts`, `realtime.gateway.ts` |
| **H3** | 🟠 | ✅ Resolved | `.env` was never committed (M02 finding corrected); added `.env.example` | `.env.example` |
| **H4** | 🟠 | ✅ Fixed | global `ValidationPipe({ transform })` + `enableCors()` | `main.ts` |
| **H5** | 🟠 | ✅ Fixed | JWT lifetime → `JWT_EXPIRES_IN` (default 7d) | `auth-service.module.ts` |
| **H6** | 🟠 | ✅ Fixed (targeted) | deterministic shared alert ids so the two engines dedupe instead of duplicating | `safety_guard.py`, `alert-writer.service.ts` (id scheme) |
| **H7** | 🟠 | ✅ Fixed | per-IP `AuthThrottleGuard` + per-email OTP lockout | `auth-throttle.guard.ts`, `auth.controller.ts`, `auth-service.service.ts` |
| **M1** | 🟡 | ✅ Fixed | unified `toUnixMs` (seconds→ms) on the raspberry path | `health.controller.ts` |
| **M2** | 🟡 | ✅ Fixed | unique `(userId,timestamp)` index + insert-or-ignore | `vital-sign.entity.ts`, `health-service.service.ts` |
| **M3** | 🟡 | ✅ Fixed | `AnalyzeData` uses authenticated `user_id` | `summary.proto`, `summary.controller.ts`, `summary.service.ts`, `main.py` |
| **M4** | 🟡 | ⚪ Documented | dual `vital_sign`/`vitals` tables kept (full consolidation was out of scope); both now carry consistent data | — |
| **M5** | 🟡 | ✅ Fixed | health-service returns `synced_count` (proto casing) | `health-service.service.ts` |
| **M6** | 🟡 | ✅ Fixed | compose exposes 50054 + correct service URLs | `docker-compose.yml` |
| **M7** | 🟡 | ✅ Fixed | `AlertType` gains `spo2`/`heart_rate`; guard uses them | `alert.entity.ts`, `safety_guard.py` |
| **M8** | 🟡 | ✅ Fixed | dropped `IdempotencyInterceptor` from auth controller | `auth.controller.ts` |
| **L1** | ⚪ | ✅ Fixed | removed no-op `@UseGuards()` on alert-ready | `alerts.controller.ts` |
| **L2** | ⚪ | ✅ Mitigated | OTP brute force addressed by H7 lockout (single-use covered by attempt cap) | `auth-service.service.ts` |
| **L3** | ⚪ | ✅ Fixed | `VitalDataDto` now exposes heartRate/spo2 (root-caused with C1) | `health.controller.ts` |
| **L4** | ⚪ | ✅ Fixed | PII `console.log` → `logger.debug` | `health.controller.ts` |
| **L5** | ⚪ | ⚪ Documented | daily report cache staleness left as-is (behavioral product decision) | — |
| **L6** | ⚪ | ⚪ Documented | response-envelope inconsistency left as-is (no churn) | — |
| **L7** | ⚪ | ✅ Fixed | `requirements.txt` pinned to exact versions (0.3.x line) | `requirements.txt` |
| **L8** | ⚪ | ✅ Fixed | `/summary` throws `BadGateway` on empty/malformed engine output | `summary.controller.ts` |

### Deeper issues found while fixing (beyond M02)
- **Python↔Postgres naming mismatch:** the Python SQL assumed snake_case columns,
  but TypeORM (no naming strategy) creates **camelCase** columns — so the Safety
  Guard and Report Agent queries referenced non-existent columns and failed every
  cycle. All Python SQL touching `vital_sign`, `alerts`, and `summary_history` now
  quotes the camelCase identifiers (aliased back to snake for downstream code).
  This is part of why C1/C2 appeared "never to fire."

### Caveats / follow-ups (not done by choice or environment)
- **Python not runtime-tested:** no venv/DB available here; the AI-layer SQL
  changes are verified by inspection and need an integration test before deploy.
- **Production schema:** with `synchronize` off in prod, the new `vital_sign.deviceId`
  column, the unique index, and the `spo2`/`heart_rate` enum values require a
  migration to be applied to existing prod databases.
- **Dev/prod dependency skew:** the local venv runs LangChain 1.x while
  `requirements.txt` (and the Docker build) pin the 0.3.x line; reconcile
  deliberately with testing.
- **`pre-existing` timeline test failure** is untouched and unrelated.
- **Full alert-engine / dual-vitals consolidation (H6/M4)** was intentionally
  scoped to targeted fixes per the agreed plan.

*M03 generated 2026-06-10 on branch `fix/m02-audit`. All current-state claims
verified against source; build and test results recorded in §14.*
