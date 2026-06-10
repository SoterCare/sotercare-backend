# M02 — Full Backend System Reference

**Date:** 2026-06-10
**Project:** SoterCare Backend (`back-end`)
**Scope:** The entire repository — every service, API, endpoint, gRPC contract,
WebSocket channel, database entity, auth flow, IoT/device flow, AI pipeline,
configuration, and deployment path.

This is the master "how everything connects" document. Every claim below was
verified directly against the source (file paths cited). Companion docs:
[`M01-log.md`](./M01-log.md) (RAG/LLM audit), [`New-RAG-Plan.md`](./New-RAG-Plan.md),
[`README.md`](./README.md).

---

## 1. What this system is

SoterCare is a cloud backend for **24/7 elderly-care monitoring**. A wearable
device (thigh band / wrist band + Raspberry Pi hub) measures vitals
(temperature, ambient temperature, moisture, gait, SpO₂, heart rate, SOS, fall
detection) and pushes them to the cloud. The backend:

1. Authenticates users (passwordless, email-OTP) and devices (hashed device keys).
2. Ingests vitals via REST batch sync, Raspberry-Pi direct sync, or live WebSocket.
3. Persists vitals, alerts, devices, and sync history to PostgreSQL.
4. Runs an **AI layer** (Python): a real-time threshold Safety Guard, a
   prescription/history RAG agent (pgvector), and a scheduled clinical-report agent.
5. Serves a mobile app: dashboard, timeline, alerts, devices, reports, summaries.

It is a **NestJS monorepo** of 4 TypeScript services + 1 Python gRPC service,
wired together over **gRPC**, fronted by a single **HTTP/WebSocket API Gateway**.

---

## 2. Architecture at a glance

```
                          ┌──────────────────────────────────────────┐
   Mobile App  ──HTTP────▶│            API GATEWAY (NestJS)           │
   (REST + WS) ──WS──────▶│  HTTP/WS :3000  — the only public surface │
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
                  │   :50052     │        │              │
                  │  (Resend)    │        │              │
                  └──────────────┘        │              │
                                          ▼              ▼
                  ┌───────────────────────────────────────────────────┐
                  │   PostgreSQL  :5432   (+ pgvector for embeddings)  │
                  │   Redis       :6379   (OTP, idempotency cache)     │
                  └───────────────────────────────────────────────────┘
```

**Key design notes**

- The **API Gateway is the only externally exposed service**. All other NestJS
  apps are gRPC microservices with no HTTP surface.
- The Python AI service has **no HTTP** — it is a gRPC server (`SummaryService`)
  plus two background threads. It reaches back to the gateway over HTTP only for
  the internal "alert-ready" webhook.
- All services share **one PostgreSQL database** (`auth_db`). Tables are
  auto-created by TypeORM (`synchronize: true`) and by SQL migrations for the
  Python side.

---

## 3. Services & ports

| Service | Language | Transport | Default URL / Port | Env override | Entry point |
|---|---|---|---|---|---|
| **api-gateway** | NestJS | HTTP + WebSocket | `0.0.0.0:3000` | `PORT` | `apps/api-gateway/src/main.ts` |
| **auth-service** | NestJS | gRPC (`auth`) | `0.0.0.0:50051` | `AUTH_GRPC_URL` | `apps/auth-service/src/main.ts` |
| **email-service** | NestJS | gRPC (`email`) | `0.0.0.0:50052` | `EMAIL_GRPC_URL` | `apps/email-service/src/main.ts` |
| **ai-summary-service** | Python | gRPC (`summary`) | `[::]:50053` | `SUMMARY_GRPC_PORT` | `apps/ai-summary-service/src/main.py` |
| **health-service** | NestJS | gRPC (`health`) | `0.0.0.0:50054` | `HEALTH_GRPC_URL` | `apps/health-service/src/main.ts` |
| **PostgreSQL** | — | TCP | `localhost:5432` (`auth_db`) | `DATABASE_URL` / `DB_*` | docker-compose / managed |
| **Redis** | — | TCP | `localhost:6379` | `REDIS_URL` / `REDIS_*` | docker-compose / managed |

> `apps/back-end` is a leftover Nest scaffold (default `app.controller`/`app.module`)
> and is **not** part of the runtime flow. The real root app is `api-gateway`.

### gRPC client wiring (who calls whom)

| Caller | Client token | Proto / package | Target URL (env, default) | Defined in |
|---|---|---|---|---|
| api-gateway | `AUTH_SERVICE` | `auth.proto` / `auth` | `AUTH_SERVICE_URL` → `localhost:50051` | `apps/api-gateway/src/api-gateway.module.ts` |
| api-gateway | `HEALTH_SERVICE` | `health.proto` / `health` | `HEALTH_SERVICE_URL` → `localhost:50054` | `api-gateway.module.ts` |
| api-gateway (summary mod.) | `SUMMARY_SERVICE` | `summary.proto` / `summary` | `SUMMARY_GRPC_URL` → `localhost:50053` | `apps/api-gateway/src/summary/summary.module.ts` |
| auth-service | `EMAIL_SERVICE` | `email.proto` / `email` | `EMAIL_SERVICE_URL` → `localhost:50052` | `apps/auth-service/src/auth-service.module.ts` |
| ai-summary-service | (HTTP webhook) | — | `GATEWAY_INTERNAL_URL` → `http://localhost:3000` | `safety_guard.py` |

The health-service gRPC client and server both set 100 MB max message size and
`loader: { keepCase, defaults, json, arrays }` so large vitals batches survive.

---

## 4. HTTP REST API (api-gateway)

**Base URL:** `http://<host>:3000`
**Swagger/OpenAPI UI:** `GET /api` (title "SoterCare Backend API", Bearer auth enabled)
**Global behavior** (`apps/api-gateway/src/main.ts`):
- Body limit 50 MB (JSON + urlencoded), gzip compression.
- `HttpExceptionFilter` (global) normalizes errors.
- `ResponseInterceptor` (global): if a handler returns an object already
  containing `success`, it passes through; otherwise it wraps as
  `{ success: true, data: <return> }`.
- `IdempotencyInterceptor` (on selected controllers): for `POST`/`PUT` with an
  `Idempotency-Key` header, caches the response in Redis for 24 h and replays it
  on repeat keys.

**Auth model:** JWT Bearer. Protected routes use `@UseGuards(JwtAuthGuard)`
(Passport `jwt` strategy). The decoded request user is `{ userId, email, name }`
(`apps/api-gateway/src/auth/jwt.strategy.ts`). `@CurrentUser()` extracts it.

### 4.1 Auth — `/auth` (public, no JWT) · `auth.controller.ts`

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/auth/register` | `{ name, email }` | Start registration → emails OTP (5-min TTL) |
| POST | `/auth/verify` | `{ email, otp }` | Verify reg OTP → creates user, returns `accessToken` + `user` |
| POST | `/auth/login` | `{ email }` | Start login → emails OTP (user must exist) |
| POST | `/auth/login-verify` | `{ email, otp }` | Verify login OTP → returns `accessToken` + `user` |

Idempotency interceptor active. Proxies straight to `AuthService` gRPC.

### 4.2 User profile — `/user` (JWT required) · `user.controller.ts`

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/user/profile` | — | Current profile; appends `hasClaimedDevice` (computed from devices) |
| POST | `/user/update` | `{ name, mobileNumber }` | Update name/mobile (email immutable here) |
| POST | `/user/email/initiate` | `{ newEmail }` | Send OTP to a new email for change |
| POST | `/user/email/verify` | `{ newEmail, otp }` | Confirm OTP → email updated |

### 4.3 Health logs (vitals sync/read) — `/logs` · `health.controller.ts`

| Method | Path | Auth | Body / Query | Purpose |
|---|---|---|---|---|
| POST | `/logs/sync` | JWT | `{ logs: [{ id, data:{…}, timestamp }] }` | Mobile app pushes vitals; maps camelCase→snake_case, forwards to HealthService |
| POST | `/logs/raspberry/sync` | Device key headers | `{ device_id, logs:[…] }` | Pi pushes vitals directly (see §7). Headers: `x-raspberry-key` (gateway key) and/or `x-device-key`. Validates clock skew, resolves owner, upserts latest vital, emits `device.logs.ingested` WS event |
| GET | `/logs/dates` | JWT | — | Dates (`YYYY-MM-DD`) that have logs for the user |
| GET | `/logs/range` | JWT | `?startDate=&endDate=` (ISO 8601) | Vitals in a date range |

Replay protection: timestamps outside `IOT_MAX_CLOCK_SKEW_MS` (default 15 min)
are rejected on the raspberry route.

### 4.4 Sync (batch from Pi gateway via mobile) — `/sync` (JWT) · `sync.controller.ts`

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/sync/raspberry-pi` | `SyncBatchDto` | Ingest a full sync batch (devices, statuses, vitals, alerts, recordings) in one DB transaction. Idempotent by `source_slot_syncedAt` key written to `sync_history` |

`SyncService.processRaspberryPiSync` (`sync/sync.service.ts`) dedupes on
`idempotencyKey`, then upserts all entity types inside a single
`dataSource.transaction` and records an `upsertSummary` count.

### 4.5 Devices — `/devices` · two controllers

**Read (JWT)** — `devices/devices.controller.ts`:

| Method | Path | Query | Purpose |
|---|---|---|---|
| GET | `/devices` | `?includeStatus=&fields=minimal` | List the user's devices (optionally with status) |
| GET | `/devices/:deviceId/status` | — | Inferred online/offline + latest status snapshot |

**IoT claim/registration** — `iot-device/iot-device.controller.ts`:

| Method | Path | Auth | Body | Purpose |
|---|---|---|---|---|
| POST | `/devices/claim` | JWT | `{ device_id }` | Claim a registered (online) device to the current user |
| POST | `/devices/unclaim` | JWT | `{ device_id }` | Release a device the user owns |
| POST | `/devices/register` | `x-admin-key` (`DEVICE_BOOTSTRAP_KEY`) | `{ device_id, device_key }` | Bootstrap/admin registration; stores a salted scrypt hash of the device key |

> Note: both controllers use `@Controller('devices')`. Routes are distinct so
> there is no collision (`/devices`, `/devices/:id/status` vs `/devices/claim`,
> `/devices/unclaim`, `/devices/register`).

### 4.6 Dashboard — `/dashboard` (JWT) · `dashboard/dashboard.controller.ts`

| Method | Path | Query | Purpose |
|---|---|---|---|
| GET | `/dashboard/vitals/latest` | `?deviceId=` (required) | Latest synced vitals snapshot for a device (null + message if none yet) |

### 4.7 Alerts — `/alerts` (JWT, except internal) · `alerts/alerts.controller.ts`

| Method | Path | Auth | Query / Body | Purpose |
|---|---|---|---|---|
| GET | `/alerts/recent` | JWT | `?deviceId=&limit=20` | Recent non-dismissed alerts |
| GET | `/alerts/attended` | JWT | `?deviceId=&limit=50` | Alerts the user confirmed/attended |
| PATCH | `/alerts/:id/attend` | JWT | — | Mark alert attended (valid) |
| PATCH | `/alerts/:id/false-alarm` | JWT | — | Mark alert false alarm + dismiss |
| POST | `/alerts/internal/alert-ready` | `x-internal-token` (`INTERNAL_SERVICE_TOKEN`) | `{ deviceId }` | **Internal webhook** from the Python Safety Guard → pushes latest alert over WS |

### 4.8 Timeline — `/timeline` (JWT) · `timeline/timeline.controller.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/timeline/vitals` | Aggregated vitals timeline points |
| GET | `/timeline/events` | Timeline events derived from alerts |
| GET | `/timeline/stats` | Aggregate alert counts for a period |
| GET | `/timeline/date-options` | Dates that have vitals data |
| GET | `/timeline/dismissed` | Dismissed alerts (recycle-bin view) |
| POST | `/timeline/restore` | Restore a dismissed alert |
| POST | `/timeline/dismiss` | Dismiss an active alert |

Query DTOs live under `timeline/dto/`.

### 4.9 Reports — `/reports` (JWT) · `reports.controller.ts`

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/reports/export` | `ExportReportDto` (device, startDate, endDate, metrics, format…) | Returns logs + meta for a date range (PDF generation is client-side; `report`/`recommendations` returned null) |
| GET | `/reports/devices` | — | Minimal device list for report dropdowns |

### 4.10 Summary / AI — `/summary` (JWT) · `summary/summary.controller.ts`

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/summary` | `{ logs: [...] }` | Generate a clinical report. **Caches one report per user per day** (returns cached if today's exists). Samples logs to ≤200, calls `SummaryService.AnalyzeData` over gRPC, persists to `summary_history` |
| POST | `/summary/upload-prescription` | multipart `file` | Upload a prescription PDF → `SummaryService.UploadPrescription` → embedded into pgvector |
| POST | `/summary/query-prescription` | `{ question }` | Ask a question over the user's prescriptions (RAG) → `SummaryService.QueryPrescription` |

### 4.11 Misc

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Hello string health check (`api-gateway.controller.ts`) |
| GET | `/api` | Swagger UI |

---

## 5. WebSocket API (realtime) · `realtime/realtime.gateway.ts`

- **Namespace:** `/realtime` (Socket.IO), CORS `*`.
- **Auth (clients):** JWT in `handshake.auth.token` or `Authorization: Bearer`.
  Verified with `JWT_SECRET`; the socket is mapped to `userId`.
- **Auth (devices):** via the `device_auth` event using `device_id` + `device_key`
  (hashed-key verification, same as REST).

### Inbound events (client/device → server)

| Event | Payload | Behavior |
|---|---|---|
| `device_auth` | `{ device_id, device_key, timestamp? }` | Authenticates a device socket, resolves owner, returns `{ success, device_id, owner_id }` |
| `device_data` | `{ device_id?, device_key?, logs?[], payload?, realtime_only? }` | Ingest live vitals. Auto-auths if not yet authed. Applies clock-skew replay protection. Persists to `vitals` (timeline), writes sensor alerts via `AlertWriterService`, upserts latest vital, syncs to HealthService gRPC (unless `realtime_only`), then emits `device.logs.ingested` to the owner |

### Outbound events (server → client)

| Event | Emitted from | Payload |
|---|---|---|
| `device.logs.ingested` | `device_data` handler & `/logs/raspberry/sync` | `{ device_id, count, logs, ingested_at }` |
| (latest alert push) | `/alerts/internal/alert-ready` → `AlertsService.pushLatestAlert` | latest alert for the device's owner |

The gateway keeps in-memory maps: `userId → socketIds` and `deviceId → socketId`.
`emitToUser(userId, event, data)` fans out to all of a user's sockets.

---

## 6. gRPC service contracts (`libs/common/src/proto/`)

### 6.1 `auth.proto` — package `auth`, service `AuthService` (auth-service :50051)

| RPC | Request | Response |
|---|---|---|
| `RegisterUser` | `{ name, email }` | `AuthResponse{ success, message }` |
| `VerifyRegistration` | `{ email, otp }` | `{ success, message, accessToken, user }` |
| `LoginInit` | `{ email }` | `AuthResponse` |
| `LoginVerify` | `{ email, otp }` | `LoginResponse{ success, message, accessToken, user }` |
| `UpdateProfile` | `{ id, name, email, mobileNumber }` | `AuthResponse` |
| `GetProfile` | `{ id }` | `GetProfileResponse{ success, message, user }` |
| `InitiateEmailUpdate` | `{ userId, newEmail }` | `AuthResponse` |
| `VerifyEmailUpdate` | `{ userId, newEmail, otp }` | `AuthResponse` |

`User = { id, email, name, mobileNumber }`. Implemented in
`apps/auth-service/src/auth-service.controller.ts`.

### 6.2 `health.proto` — package `health`, service `HealthService` (health-service :50054)

| RPC | Request | Response |
|---|---|---|
| `SyncLogs` | `{ user_id, logs:[LogEntry] }` | `{ success, message, synced_count }` |
| `GetLogDates` | `{ user_id }` | `{ dates:[string] }` (YYYY-MM-DD) |
| `GetLogsByDateRange` | `{ user_id, start_date, end_date }` | `{ logs:[LogEntry] }` |

`LogEntry = { id, temperature, ambient_temp, moisture, gait_label, sos,
thighnode_status, fall_alert, timestamp(int64), heart_rate, spo2 }`.
Implemented in `apps/health-service/src/health-service.controller.ts`.

### 6.3 `summary.proto` — package `summary`, service `SummaryService` (ai-summary-service :50053)

| RPC | Request | Response |
|---|---|---|
| `AnalyzeData` | `{ data_json, format }` | `{ report_json, has_critical, overview, recommendations[] }` |
| `UploadPrescription` | `{ user_id, file_data(bytes), file_name }` | `{ success, message, doc_id }` |
| `QueryPrescription` | `{ user_id, question }` | `{ success, answer }` |

Implemented by `SummaryServicer` in `apps/ai-summary-service/src/main.py`.

### 6.4 `email.proto` — package `email`, service `EmailService` (email-service :50052)

| RPC | Request | Response |
|---|---|---|
| `SendOtpEmail` | `{ email, otp, name? }` | `{ success, message }` |

Implemented in `apps/email-service/src/email-service.controller.ts` (uses Resend).

---

## 7. Authentication & authorization

### 7.1 User auth (passwordless email OTP)

1. **Register:** `POST /auth/register` → auth-service generates a 6-digit OTP
   (`crypto.randomInt`), stores `temp_reg:<email>` = `{name, otp}` in Redis with
   **300 s TTL**, and calls email-service to send it (5 s timeout cap).
2. **Verify:** `POST /auth/verify` → checks Redis OTP, creates the `User` row,
   issues a **JWT signed with `JWT_SECRET`, `expiresIn: '90d'`**. Payload:
   `{ userId, sub, email, name }`.
3. **Login:** `POST /auth/login` (user must exist) stores `login:<email>` OTP →
   `POST /auth/login-verify` validates and returns a fresh JWT.
4. **Email change:** `/user/email/initiate` stores `email_update:<userId>:<newEmail>`
   OTP (300 s) and emails it; `/user/email/verify` confirms and updates.

JWT is validated on protected routes by Passport (`JwtStrategy`,
`secretOrKey = JWT_SECRET || 'REMOVED-OLD-PUBLIC-FALLBACK'`, `ignoreExpiration: false`).
The same secret is used by the WebSocket gateway and JwtModule across services.

### 7.2 Device auth (hashed device keys) · `iot-device/iot-device.service.ts`

- **Register:** `registerDevice(deviceId, rawKey)` stores `deviceKeyHash` =
  `scrypt(rawKey, salt, 64)` as `salt:hash` (`randomBytes(16)` salt).
- **Verify:** `authenticateAndResolveOwner(deviceId, rawKey)` re-derives scrypt
  and compares with `timingSafeEqual` (constant-time). Updates `lastSeen`,
  requires the device to be claimed, and ensures a dashboard `devices` row exists.
- **Claim:** requires the device to be **online** (`lastSeen` within
  `IOT_ONLINE_TTL_SECONDS`, default 300) when `IOT_CLAIM_REQUIRE_ONLINE=true`.

### 7.3 Service-to-service / machine auth

| Secret (env) | Used by | Guards |
|---|---|---|
| `RASPBERRY_API_KEY` | `x-raspberry-key` header on `/logs/raspberry/sync` | Gateway-level Pi key |
| `x-device-key` header | per-device key on `/logs/raspberry/sync` & `device_auth` | Device identity |
| `DEVICE_BOOTSTRAP_KEY` | `x-admin-key` on `/devices/register` | Admin/bootstrap |
| `INTERNAL_SERVICE_TOKEN` | `x-internal-token` on `/alerts/internal/alert-ready` | Python → gateway webhook |

---

## 8. Data ingestion paths (3 ways vitals enter the system)

1. **Mobile REST batch** — `POST /logs/sync` (JWT). App-collected logs forwarded
   to HealthService → written to `vital_sign`.
2. **Raspberry Pi direct** — `POST /logs/raspberry/sync` (device key). Resolves
   owner, replay-checks timestamps, forwards to HealthService, upserts dashboard
   `vitals`, emits WS `device.logs.ingested`.
3. **Live WebSocket** — `device_data` event on `/realtime`. Lowest latency:
   writes timeline `vitals`, fires sensor alerts immediately, syncs to
   HealthService (unless `realtime_only`), emits WS update.
4. **Full batch (mobile-relayed Pi gateway)** — `POST /sync/raspberry-pi` (JWT).
   Transactional multi-entity upsert with idempotency in `sync_history`.

---

## 9. AI / ML layer (`apps/ai-summary-service`, Python gRPC)

Single process started by `src/main.py`, running **three concurrent components**:

### Agent 1 — Safety Guard (`core/safety_guard.py`)
- Pure-threshold, **no LLM**. Polls `vital_sign` every `POLL_INTERVAL_SECONDS`
  (default 10), tracking a cursor in the `monitor_state` table (id=1).
- Evaluates each new row against env-tunable thresholds:

  | Vital | Trigger | Severity | Cooldown |
  |---|---|---|---|
  | `sos` true | help_call | CRITICAL | 5 min |
  | `fall_alert` true | fall | CRITICAL | 5 min |
  | `spo2 < SPO2_LOW` (92) | low SpO₂ | CRITICAL | 5 min |
  | `heart_rate > HR_HIGH` (120) / `< HR_LOW` (45) | movement | HIGH | 15 min |
  | `temperature > TEMP_FEVER` (38.0) / `< TEMP_LOW` (35.5) | temperature | HIGH | 15 min |
  | `moisture > MOISTURE_HIGH` (80) / `< MOISTURE_LOW` (15) | moisture | MEDIUM | 30 min |

- Writes alerts directly to the `alerts` table (psycopg2), enforces per
  `(user_id, alert_type)` cooldown, then POSTs to
  `GATEWAY_INTERNAL_URL/alerts/internal/alert-ready` (with `X-Internal-Token`)
  so the gateway pushes a WS event. Reconnects on DB loss; never crashes the loop.

### Agent 2 — Prescription & History RAG (`core/rag_agent.py`)
- PDF ingest (`pypdf`) → chunk → embed → store in **pgvector** `embeddings` table.
- Embeddings provider configurable: `EMBEDDING_PROVIDER` (default `gemini`,
  model `models/text-embedding-004`, dim 768) or `openai`. Module-level singleton.
- `UploadPrescription`, `QueryPrescription` RPCs; user isolation by `user_id`.
- Also indexes periodic health summaries so Agent 3 can retrieve trend context.

### Agent 3 — Clinical Report Agent (`core/report_agent.py`)
- Generates structured `HealthReport` (Pydantic, `core/schemas.py`).
- Runs on a **wall-clock scheduler** every `REPORT_INTERVAL_HOURS` (default 6)
  and on-demand via the `AnalyzeData` RPC.
- Samples to `MAX_LOGS_PER_REPORT` (200), remaps DB snake_case → camelCase,
  retrieves RAG context, calls the LLM via fallback, saves to `summary_history`.

### LLM provider fallback (`core/llm_provider.py`)
Ordered, key-gated: **Gemini → Claude → OpenAI → Grok**. Models via env
(`GEMINI_MODEL=gemini-2.0-flash`, `CLAUDE_MODEL=claude-haiku-4-5-20251001`,
`OPENAI_MODEL=gpt-4o-mini`, `GROK_MODEL=grok-3-fast`). Only providers with a key
set are constructed; `invoke_with_fallback` (in `core/utils.py`) tries each in order.

### gRPC server
`SummaryServicer` uses a psycopg2 `SimpleConnectionPool(1,5, DATABASE_URL)`,
max message size `SUMMARY_GRPC_MAX_MESSAGE_MB` (20). Summary proto stubs are
generated at deploy time (`grpc_tools.protoc`); the service degrades gracefully
if `summary_pb2` is missing. Startup validates embedding config before serving.

### SQL migrations (`src/migrations/`)
`001_add_heartrate_spo2.sql`, `002_add_monitor_state.sql`,
`003_add_pgvector.sql`, `004_update_summary_history.sql`.

---

## 10. Database schema (PostgreSQL, TypeORM `synchronize: true`)

All NestJS services connect to the same database. `autoLoadEntities: true` (gateway)
or explicit entity lists; SSL auto-enabled whenever `DATABASE_URL` is set.

### Owned by auth-service
- **`user`** (`User`): `id` PK, `email` (unique), `name`, `mobileNumber` (nullable), `createdAt`.

### Owned by health-service
- **`vital_sign`** (`VitalSign`): `id` PK, `userId`, `temperature`, `ambientTemp?`,
  `moisture?`, `sos?`, `fallAlert?`, `gaitLabel?`, `thighnodeStatus?`, `heartRate?`,
  `spo2?`, `timestamp`(bigint as string), `syncedAt`. Index `(userId, timestamp)`.
  *This is the table the Python Safety Guard & Report Agent poll.*

### Owned by api-gateway (`database/entities/` + feature modules)
- **`devices`** (`Device`): `id` PK, `userId`(idx), `name`, `type`(enum
  thigh_band|wrist_band|hub), `lastSeenAt`, `lastSyncSlot`, `syncSource`
  (default `mobile_sync`), timestamps.
- **`device_statuses`** (`DeviceStatus`): `id` PK, `deviceId`→Device, `battery?`,
  `signalRssi?`, `connectedAt?`, `bands`(jsonb), `receivedAt`, `createdAt`.
  Index `(deviceId, receivedAt)`.
- **`vitals`** (`Vital`): `id` PK, `deviceId`→Device, `timestamp`, `temperature?`,
  `roomTemperature?`, `moisture?`, `gaitAnalysis?`, `thighnodeStatus?`, `syncSlot`,
  `createdAt`. **Unique** `(deviceId, timestamp)`. *Dashboard/timeline source.*
- **`alerts`** (`Alert`): `id`(string) PK, `deviceId`→Device, `type`(enum
  movement|fall|urine|temperature|moisture|help_call), `title`, `timestamp`,
  `isDismissed`, `isAttended`, `isFalseAlarm`, `dismissedAt?`, `syncSlot`,
  `createdAt`. Indexes `(deviceId,timestamp)`, `(deviceId,isDismissed)`.
- **`recording_sessions`** (`RecordingSession`): `recordingId` PK, `deviceId`→Device,
  `createdAt`, `syncedAt`.
- **`sync_history`** (`SyncHistory`): `id` PK, `userId`, `source`, `slot`,
  `syncedAt`, `gatewayHost`, `receivedAt`, `upsertSummary`(jsonb counts),
  `idempotencyKey`(unique).
- **`iot_devices`** (`IotDevice`): `deviceId` PK, `deviceKeyHash`, `ownerId?`,
  `isPaired`, `lastSeen?`(idx), timestamps. *Device identity/claim source.*
- **`summary_history`** (`SummaryHistory`): `id` PK, `userId`, `summary`(text json),
  `recommendations`(text), `hasCritical`, `windowStart?`, `reportType`
  (default `on_demand`), `createdAt`. Index `(userId, windowStart)`.

### Python-managed
- **`monitor_state`**: `id=1` row holding `last_timestamp` cursor + `updated_at`.
- **`embeddings`**: pgvector store for prescription/summary chunks (migration 003).

> Note (carried from M01): there are **two vitals tables** — `vital_sign`
> (health-service, what AI polls) and `vitals` (gateway dashboard/timeline). The
> ingest paths write to both; keep this in mind when querying.

---

## 11. Configuration / environment variables

### Core infra
| Var | Default | Used by |
|---|---|---|
| `PORT` | 3000 | api-gateway HTTP |
| `DATABASE_URL` | — | All; if set, overrides `DB_*` and enables SSL |
| `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME` | `localhost/5432/postgres/postgres/auth_db` | TypeORM fallback |
| `DB_SSL` | false | Force SSL without a URL |
| `REDIS_URL` | — | Preferred (supports `rediss://`) |
| `REDIS_HOST/REDIS_PORT` | `localhost/6379` | Redis fallback |
| `JWT_SECRET` | `REMOVED-OLD-PUBLIC-FALLBACK` | JWT sign/verify (gateway, auth, WS) — **set in prod** |

### gRPC URLs
| Var | Default |
|---|---|
| `AUTH_GRPC_URL` / `AUTH_SERVICE_URL` | `0.0.0.0:50051` / `localhost:50051` |
| `EMAIL_GRPC_URL` / `EMAIL_SERVICE_URL` | `0.0.0.0:50052` / `localhost:50052` |
| `SUMMARY_GRPC_PORT` / `SUMMARY_GRPC_URL` | `50053` / `localhost:50053` |
| `HEALTH_GRPC_URL` / `HEALTH_SERVICE_URL` | `0.0.0.0:50054` / `localhost:50054` |

### Device / ingest
| Var | Default | Meaning |
|---|---|---|
| `RASPBERRY_API_KEY` | (set in `.env`) | Gateway-level Pi key |
| `DEVICE_BOOTSTRAP_KEY` | — | Admin device registration |
| `INTERNAL_SERVICE_TOKEN` | — | Python→gateway webhook token |
| `IOT_MAX_CLOCK_SKEW_MS` | 900000 (15 min) | Replay window |
| `IOT_ONLINE_TTL_SECONDS` | 300 | "Online" window for claim |
| `IOT_CLAIM_REQUIRE_ONLINE` | true | Require online to claim |

### AI service
| Var | Default |
|---|---|
| `SPO2_LOW / HR_HIGH / HR_LOW / TEMP_FEVER / TEMP_LOW / MOISTURE_HIGH / MOISTURE_LOW` | 92 / 120 / 45 / 38.0 / 35.5 / 80 / 15 |
| `POLL_INTERVAL_SECONDS / LOOKBACK_SECONDS` | 10 / 300 |
| `REPORT_INTERVAL_HOURS / MAX_LOGS_PER_REPORT` | 6 / 200 |
| `EMBEDDING_PROVIDER / EMBEDDING_MODEL / EMBEDDING_DIM` | gemini / models/text-embedding-004 / 768 |
| `GATEWAY_INTERNAL_URL` | http://localhost:3000 |
| `SUMMARY_GRPC_MAX_MESSAGE_MB` | 20 |

### Third-party keys (LLM + email)
`OPENAI_API_KEY`, `GROK_API_KEY`, `GEMINI_API_KEY`, `CLAUDE_API_KEY`/`ANTHROPIC_API_KEY`,
`RESEND_API_KEY`. Optional model overrides: `GEMINI_MODEL`, `CLAUDE_MODEL`,
`OPENAI_MODEL`, `GROK_MODEL`.

> ⚠️ The committed `.env` contains live-looking `GEMINI_API_KEY`,
> `RASPBERRY_API_KEY`, and `RESEND_API_KEY` values. Rotate these and keep `.env`
> out of source control for production.

---

## 12. How to run

### 12.1 Local (Node + Python, all services)

```bash
npm install
# Start Postgres + Redis (e.g. via docker compose up postgres redis)
npm run start:all      # api-gateway + auth + email + health + ai (concurrently)
```

Individual dev watchers: `npm run start:dev <app>` where `<app>` ∈
`api-gateway | auth-service | email-service | health-service`.
AI only: `npm run start:ai-service` (uses the venv).

Production build + run:
```bash
npm run build:api && npm run build:auth && npm run build:email && npm run build:health
npm run start:prod:all   # node dist/* for each + python src/main.py
```

The Python service needs generated stubs:
```bash
cd apps/ai-summary-service
python -m grpc_tools.protoc -I../../libs/common/src/proto \
  --python_out=src/generated --grpc_python_out=src/generated \
  ../../libs/common/src/proto/health.proto ../../libs/common/src/proto/summary.proto
```

### 12.2 Docker (single all-in-one image)

`Dockerfile` builds a **single `node:20-bookworm` image** containing all 4 Node
services + the Python AI service, and (optionally) embedded Postgres + Redis:

- Installs Node deps, then Python deps in `/opt/venv` from `requirements.txt`.
- Builds all 4 NestJS apps, generates Python gRPC stubs, fixes relative imports.
- `EXPOSE 3000 50051 50052 50053 50054 6379`; `CMD ["./start.sh"]`.

`start.sh` logic:
- If `DATABASE_URL` (or a non-local `DB_HOST`) is set → **skip embedded Postgres**
  (use managed DB so data persists). Same for `REDIS_URL`/`REDIS_HOST` → Redis.
- Otherwise it boots embedded Redis + Postgres, creates the `postgres` user and
  `auth_db`, waits for readiness, then runs `npm run start:prod:all`.

`docker-compose.yml` is the **local dev** path: separate `postgres:15` and
`redis:7` containers + the gateway image, mapping `3000`, `50051–50053`.

### 12.3 Deployment (Koyeb / managed)

Designed for Koyeb with **managed Postgres + Redis** (Neon/Supabase style). Set
`DATABASE_URL` and `REDIS_URL` (SSL auto-enabled) so the ephemeral container does
not shadow real data. The single image runs everything; only `3000` needs public
exposure.

### 12.4 Useful scripts
- `npm run seed:sync-data` → `scripts/seed-sync-data.ts`
- `npm run simulate:raspberry` → `scripts/simulate-raspberry-sync.js`
- `3days-sample.json` → sample device payload for testing.

---

## 13. Request lifecycle examples

**A) New user → first vitals**
1. `POST /auth/register {name,email}` → OTP email.
2. `POST /auth/verify {email,otp}` → `accessToken`.
3. `POST /devices/register {device_id,device_key}` (admin) once per device.
4. `POST /devices/claim {device_id}` (JWT) — device must be online.
5. Device connects WS `/realtime` → `device_auth` → streams `device_data`.
6. Safety Guard sees new `vital_sign` rows → writes `alerts` → webhooks gateway →
   WS push to the user. Dashboard reads `GET /dashboard/vitals/latest`.

**B) On-demand clinical report**
`POST /summary {logs}` → cache check (`summary_history` today) → sample ≤200 →
gRPC `AnalyzeData` → Report Agent (RAG context + LLM fallback) → persist + return.

**C) Prescription Q&A**
`POST /summary/upload-prescription` (PDF) → embed into pgvector →
`POST /summary/query-prescription {question}` → similarity search + LLM answer.

---

## 14. Source map (where to look)

| Concern | File(s) |
|---|---|
| HTTP bootstrap, Swagger, global filters | `apps/api-gateway/src/main.ts` |
| Gateway module + gRPC clients + DB/JWT | `apps/api-gateway/src/api-gateway.module.ts` |
| Auth routes | `apps/api-gateway/src/auth.controller.ts`, `user.controller.ts` |
| Vitals routes | `apps/api-gateway/src/health.controller.ts`, `reports.controller.ts` |
| Feature modules | `apps/api-gateway/src/{alerts,dashboard,devices,iot-device,realtime,summary,sync,timeline}/` |
| WebSocket | `apps/api-gateway/src/realtime/realtime.gateway.ts` |
| JWT | `apps/api-gateway/src/auth/jwt.strategy.ts`, `common/guards/jwt-auth.guard.ts` |
| Interceptors | `apps/api-gateway/src/common/interceptors/{response,idempotency}.interceptor.ts` |
| Auth microservice | `apps/auth-service/src/auth-service.{controller,service,module}.ts` |
| Email microservice | `apps/email-service/src/email-service.controller.ts` |
| Health microservice | `apps/health-service/src/health-service.controller.ts`, `vital-sign.entity.ts` |
| AI service | `apps/ai-summary-service/src/main.py`, `core/{safety_guard,rag_agent,report_agent,llm_provider,utils,schemas}.py` |
| Proto contracts | `libs/common/src/proto/{auth,health,summary,email}.proto` |
| DB entities | `apps/api-gateway/src/database/entities/`, `iot-device/iot-device.entity.ts`, `summary/summary-history.entity.ts` |
| Deploy | `Dockerfile`, `start.sh`, `docker-compose.yml` |

---

*Generated 2026-06-10 by full static analysis of the repository. Every endpoint,
contract, and connection detail above was read from source, not inferred.*

---

# 15. Issues & Errors Audit (appended 2026-06-10)

A full pass over the repository for correctness bugs, security gaps, and design
defects. Every finding is verified against source and cited as `file:line`.
Severity legend (same as M01):

| Level | Meaning |
|-------|---------|
| 🔴 **Critical** | Breaks a core feature, data loss/corruption, or deploy failure |
| 🟠 **High** | Wrong/unsafe behavior in normal operation; security/reliability risk |
| 🟡 **Medium** | Correctness/maintainability defect; degraded quality |
| ⚪ **Low** | Code smell, hygiene, hardening |

## 🔴 Critical

### C1 — Heart rate & SpO₂ are never persisted → the headline safety alerts can never fire
The proto `LogEntry` carries `heart_rate` and `spo2` (`health.proto:17-18`), but
**no ingestion path ever sets them**, and the health-service ignores them when
building the row:
- `apps/health-service/src/health-service.service.ts:18-31` — `syncLogs` maps
  temperature/ambientTemp/moisture/sos/fall/gait/thighnode but **never `heartRate`
  or `spo2`**, so `vital_sign.heart_rate` / `vital_sign.spo2` stay NULL forever.
- Gateway mappers also omit them: `health.controller.ts:197-207` (`/logs/sync`),
  `health.controller.ts:252-271` (`/logs/raspberry/sync`), and the WS
  `NormalizedGrpcLog` in `realtime.gateway.ts:40-50`.

**Impact:** The Safety Guard's CRITICAL low-SpO₂ check (`spo2 < 92`) and the HIGH
heart-rate checks (`safety_guard.py:117-140`) read columns that are always NULL,
so those branches are dead. The most clinically important alerts in a 24/7 care
product cannot trigger from real data.

### C2 — Safety Guard writes alerts with `device_id = user_id` → FK violation / invisible alerts
`vital_sign` has **no `device_id` column** (`VitalSign` entity, `vital-sign.entity.ts`
— only `userId`). In the guard, `write_alert` does
`device_id = str(row.get("device_id") or row["user_id"])`
(`safety_guard.py:207`), and the SELECT never fetches a device id
(`safety_guard.py:273-289`). So every guard alert is inserted with
`alerts.device_id = "<user_id>"`.

But `alerts.device_id` is a **FK to `devices.id`** (`alert.entity.ts` `@ManyToOne(() => Device)`),
and real `devices.id` values are device strings (e.g. `dev_001`, `IoT Device …`),
never the numeric user id. With `synchronize: true` the FK is enforced, so the
INSERT raises a foreign-key error, is swallowed by the loop, and the alert is
**never stored**. Even if the FK were absent, the alert is unreachable: the read
APIs filter `deviceId IN (user's devices)` (`alerts.service.ts:43-51`) and
`pushLatestAlert` looks the device up by id and bails when not found
(`alerts.service.ts:131-137`). **The dedicated real-time alert agent delivers
nothing to users.**

### C3 — `synchronize: true` in production on a shared database
Both `api-gateway.module.ts:53` and `auth-service.module.ts` (`synchronize: true`)
auto-alter the schema on every boot, against the **same** `auth_db`. TypeORM
schema-sync can drop/retype columns and is explicitly unsafe for production
(risk of silent data loss). Two services syncing the same DB at startup can also
race and fight over the schema. Use migrations and set `synchronize: false`.

## 🟠 High

### H1 — Machine-auth endpoints are open when their secret env var is unset
The guard pattern `if (SECRET && provided !== SECRET) throw` means **no env var ⇒
no auth**:
- `health.controller.ts:228-231` — `/logs/raspberry/sync` (`RASPBERRY_API_KEY`)
- `iot-device.controller.ts:66-69` — `/devices/register` (`DEVICE_BOOTSTRAP_KEY`)
- `alerts.controller.ts:90-92` — `/alerts/internal/alert-ready` (`INTERNAL_SERVICE_TOKEN`)

If any of these is not configured (and none has a default), the endpoint is
publicly callable — anyone can register/seed devices or inject alert pushes.
Fail closed instead (reject when the secret is missing).

### H2 — Hardcoded JWT secret fallback `'REMOVED-OLD-PUBLIC-FALLBACK'`
If `JWT_SECRET` is unset, the system signs and verifies with a public,
source-committed secret, letting anyone forge tokens for any `userId`:
`jwt.strategy.ts:12`, `api-gateway.module.ts:60`, `auth-service.module.ts`
(`JwtModule.register`), `realtime.gateway.ts:163`. Require the env var; never
ship a usable default.

### H3 — Live secrets committed to `.env`
`.env` contains real-looking `GEMINI_API_KEY`, `RASPBERRY_API_KEY`, and
`RESEND_API_KEY` values and is tracked in git. Rotate all three, remove from
history, and `.gitignore` the file.

### H4 — No global input validation and no CORS configuration
`apps/api-gateway/src/main.ts` never calls `app.useGlobalPipes(new ValidationPipe(...))`
or `app.enableCors(...)` (confirmed: zero matches across `apps/`). Consequently
the only DTOs with `class-validator` decorators (`iot-device/dto/claim-device.dto.ts`,
`register-device.dto.ts`) are **not enforced**, and every other DTO (e.g.
`SyncBatchDto`) is Swagger-only with no runtime validation. Bodies are accepted
unchecked; malformed input reaches the DB/transaction layer.

### H5 — 90-day JWTs with no refresh or revocation
`auth-service.module.ts` signs with `expiresIn: '90d'`. A leaked token is valid
for three months with no way to revoke it. Shorten lifetime + add refresh tokens
or a revocation list.

### H6 — Two divergent alerting engines produce inconsistent/duplicate alerts
Alerts are generated in two unrelated places with different rules:
- TS `AlertWriterService` (realtime path): moisture alert at **`moisture >= 25`**,
  title `"Moisture Detected"`, id `prefix_deviceId_ts`, only SOS/fall/moisture/gait
  (`alert-writer.service.ts:63-117`).
- Python Safety Guard: moisture alert at **`> 80` or `< 15`**, titles like
  `"High moisture: X"`, random UUID ids, plus temp/HR/SpO₂
  (`safety_guard.py:94-175`).

Thresholds, titles, id schemes, and `type` mappings disagree, so the same event
yields different (or duplicate, or no) alerts depending on path. Consolidate into
one rule engine.

### H7 — OTP endpoints have no rate limiting or attempt throttling
`/auth/register`, `/auth/login`, `/auth/login-verify`, `/auth/verify` have no
throttle. The OTP is a 6-digit code (`auth-service.service.ts:19-22`) valid for
5 minutes, and `verifyTempOtp` does not count failed attempts
(`auth-service.service.ts:32-43`). That allows OTP brute force (~10⁶ space within
the window) and email-bombing. Add `@nestjs/throttler` + per-email attempt caps.

## 🟡 Medium

### M1 — Inconsistent timestamp normalization breaks raspberry replay protection
`realtime.gateway.ts:122-139` `toUnixMs` upconverts unix **seconds → ms**, but
`health.controller.ts:160-176` `toUnixMs` does **not**. A Pi that sends seconds
to `/logs/raspberry/sync` yields a value ~1.7×10⁹ while `now` is ~1.7×10¹²,
so `Math.abs(now - ts) > maxClockSkew` is always true → every batch is rejected
as a replay (`health.controller.ts:254-258`). Share one normalizer.

### M2 — Vitals ingestion is not idempotent / not deduplicated
`health-service.service.ts:33` does a plain `save(entities)` with no unique key on
`vital_sign`, and `/logs/sync` + `/logs/raspberry/sync` have no idempotency key.
Client retries (common on flaky device links) create duplicate vital rows, which
then inflate Safety Guard processing and report stats. Only `/sync/raspberry-pi`
is idempotent (`sync.service.ts:33-51`).

### M3 — On-demand report `user_id` resolves to 0 (no isolation)
`main.py:81` derives `user_id` from `logs[0]["user_id"]`, but the `/summary`
payload sends raw app logs without a `user_id` (`summary.controller.ts:49-50`),
so `user_id = 0`. Reports are generated and saved (`save_report(conn, 0, …)`)
unattributed, and `summary_history` rows on the gateway are keyed by the real
JWT user while the Python copy is keyed by 0 — they diverge.

### M4 — Dual vitals schema (`vital_sign` vs `vitals`)
The same readings are written to two tables with different shapes: health-service
`vital_sign` (what the AI polls) and gateway `vitals` (dashboard/timeline). Paths
write to both independently, so they can drift; queries must know which one to
trust. (Also flagged in M01.) Pick one source of truth.

### M5 — gRPC response field casing mismatch (`syncedCount` vs `synced_count`)
`health-service.service.ts:38` returns `syncedCount`, but the proto field is
`synced_count` with `keepCase: true` (`health.proto:30`, loader in
`health-service/src/main.ts:15-20`). The wire field never matches, so
`synced_count` is always absent/0 in the API response.

### M6 — Compose/port wiring is inconsistent with actual ports
`docker-compose.yml:33-43` exposes `50051-50053` and sets
`AUTH_SERVICE_URL=localhost:50051`, but **health-service runs on 50054**
(`health-service/src/main.ts:14`) and is neither exposed nor pointed at here;
the gateway's `HEALTH_SERVICE_URL` default (`localhost:50054`) only works because
everything is co-located in one container via `start.sh`. The compose file is
misleading for anyone running pieces separately.

### M7 — SpO₂/HR alerts are filed under the wrong `type`
`safety_guard.py:117-140` records low-SpO₂ as `type="temperature"` and HR
anomalies as `type="movement"` because the `AlertType` enum has no spo2/heart_rate
members (`alert.entity.ts`). The UI cannot distinguish a fever from hypoxemia, or
a fall-style movement from tachycardia. Extend the enum.

### M8 — Idempotency cache poisons OTP flows
`IdempotencyInterceptor` caches any POST response for **24 h** keyed by
`Idempotency-Key` (`idempotency.interceptor.ts:50-58`) and is applied to
`/auth/*`. A client reusing a key (common on mobile retry libraries) gets a stale
`"OTP sent"` **without a new OTP being generated/sent**, silently breaking
re-request. Exclude auth/OTP routes from idempotency caching.

## ⚪ Low

- **L1** — `@UseGuards()` with no arguments on `/alerts/internal/alert-ready`
  (`alerts.controller.ts:85`) is a no-op and misleadingly implies protection;
  the real check is the manual token compare. Remove it.
- **L2** — `verifyTempOtp` doesn't invalidate the OTP on success
  (`auth-service.service.ts:38-42`); it stays replayable until `createUser`
  deletes the key. Tie verification to single-use.
- **L3** — `VitalDataDto` (`health.controller.ts:39-63`) omits `heartRate`/`spo2`,
  so the mobile contract can't even express them (root cause shared with C1).
- **L4** — `console.log` prints `userId` (PII) on every sync
  (`health.controller.ts:209-210`), unlike the health-service which keeps it at
  `debug`. Use the logger at debug level.
- **L5** — `/summary` returns "today's" cached report regardless of newly synced
  data (`summary.controller.ts:33-47`); a deteriorating patient sees a stale
  morning report all day. Invalidate on new critical vitals.
- **L6** — Response shape is inconsistent: some handlers return `{ success, data }`
  explicitly while others rely on `ResponseInterceptor` wrapping
  (`response.interceptor.ts`), so clients see two envelope styles across endpoints.
- **L7** — `requirements.txt` pins to floating ranges (`grpcio==1.68.*`,
  `langchain==0.3.*`, …); builds are not reproducible. Pin exact versions + lock.
- **L8** — `analyzeData` swallows JSON parse errors into an empty report
  (`summary.controller.ts:53-58`) and the Python side returns an empty response on
  failure (`main.py:101-107`), so clients can't distinguish "no data" from "engine
  error".

## Suggested fix priority

1. **C1 + C2** together — wire `heart_rate`/`spo2` end-to-end **and** give
   `vital_sign` a real `device_id`, or have the guard join to a device. Without
   both, the safety-alert pipeline is non-functional.
2. **C3, H1, H2, H3** — production-safety/security must-haves before any deploy.
3. **H4, H5, H7, M8** — input validation, token lifetime, OTP throttling, auth
   idempotency.
4. **H6 + M4/M7** — collapse the two alert engines and the two vitals tables onto
   one model; fix alert typing.
5. Remaining Medium/Low as hygiene.

*Audit appended 2026-06-10. All findings verified against source at the cited
lines.*
