# SoterCare AI — RAG System Start Guide

## What Is This System

The AI layer is a Python gRPC service (`apps/ai-summary-service`) made of three agents that run concurrently inside the same process:

| Agent | File | What it does | When it runs |
|-------|------|--------------|--------------|
| **Agent 1 — Safety Guard** | `safety_guard.py` | Polls `vital_sign` every 10 s, fires alerts for threshold breaches (SpO2, HR, temperature, fall, SOS) | Automatically, loop forever |
| **Agent 2 — RAG** | `rag_agent.py` | Embeds prescription PDFs and past reports in pgvector; retrieves relevant history for report generation and answers prescription questions | On gRPC calls |
| **Agent 3 — Report** | `report_agent.py` | Generates structured `HealthReport` JSON via LLM; scheduled every 6 h and on-demand | Every 00/06/12/18 UTC + on-demand REST call |

---

## Architecture — Data Flow

```
Mobile / Raspberry Pi
        │
        ▼
  POST /health/sync            ← NestJS api-gateway (port 3000)
        │ gRPC
        ▼
  health-service               ← writes vital_sign table (PostgreSQL)
        │
        ├──[every 10 s]── Agent 1 Safety Guard
        │                       │ threshold breach?
        │                       ▼
        │                 INSERT into alert table
        │                 POST /internal/alerts  → WebSocket push
        │
        └──[every 6 h]─── Agent 3 Report Scheduler
                                │
                         SELECT vital_sign (6-h window)
                                │
                         Agent 2 RAG: get_historical_context()
                                │   (cosine search over past summaries)
                                ▼
                         LLM prompt → HealthReport JSON
                                │
                         INSERT into summary_history
                         Agent 2 RAG: index_summary()  ← embeds new report for future retrieval

On-demand report:
  POST /summary  (JWT)
        │ gRPC AnalyzeData
        ▼
  Agent 3 generate_report() → same LLM flow above

Prescription upload:
  POST /summary/upload-prescription  (JWT, multipart PDF)
        │ gRPC UploadPrescription
        ▼
  Agent 2: extract text → chunk → embed → INSERT into embeddings

Prescription Q&A:
  POST /summary/query-prescription  (JWT, { "question": "..." })
        │ gRPC QueryPrescription
        ▼
  Agent 2: embed question → cosine search → LLM answer
```

---

## Environment Variables — What You MUST Set

### Required (service won't start without these)

| Variable | Where to set | What it does |
|---|---|---|
| `DATABASE_URL` | Koyeb env vars | PostgreSQL connection string (with SSL). All agents read from here. |
| `JWT_SECRET` | Koyeb env vars | Signs/verifies all JWTs. api-gateway and auth-service both crash at boot without it. |

### Required for AI to work (at least one LLM key)

The system tries providers in this order: **Gemini → Claude → OpenAI → Grok**. It trips a circuit breaker on failure and falls to the next.

| Variable | Provider | Model default |
|---|---|---|
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Google Gemini | `gemini-2.0-flash` |
| `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY` | Anthropic Claude | `claude-haiku-4-5-20251001` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o-mini` |
| `GROK_API_KEY` | xAI Grok | `grok-3-fast` |

You only need **one**. If none are set, every LLM call fails silently (reports return a fallback error object).

### Required for prescription RAG (embeddings)

| Variable | Default | Notes |
|---|---|---|
| `EMBEDDING_PROVIDER` | `gemini` | `"gemini"` or `"openai"` |
| `EMBEDDING_MODEL` | `models/text-embedding-004` | Gemini embedding model |
| `EMBEDDING_DIM` | `768` | Vector dimension — **must match the model** |

If `EMBEDDING_PROVIDER=gemini`, the embedding key is reused from `GEMINI_API_KEY` / `GOOGLE_API_KEY`.  
If `EMBEDDING_PROVIDER=openai`, it uses `OPENAI_API_KEY`.

> **CRITICAL:** Once you upload the first prescription, never change `EMBEDDING_MODEL` or `EMBEDDING_DIM` without deleting all rows in the `embeddings` table and re-uploading everything. A dimension mismatch causes a hard crash on the next upload.

### Optional / tuning

| Variable | Default | What it controls |
|---|---|---|
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini LLM model |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude LLM model |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI LLM model |
| `GROK_MODEL` | `grok-3-fast` | Grok LLM model |
| `REPORT_INTERVAL_HOURS` | `6` | How often batch reports run (must divide 24) |
| `MAX_LOGS_PER_REPORT` | `200` | Max vital-sign rows fed into one LLM prompt |
| `POLL_INTERVAL_SECONDS` | `10` | Safety Guard poll frequency |
| `LOOKBACK_SECONDS` | `300` | How far back Safety Guard looks on first start |
| `SPO2_LOW` | `92` | SpO2 alert threshold (%) |
| `HR_HIGH` | `120` | Heart rate upper alert (BPM) |
| `HR_LOW` | `45` | Heart rate lower alert (BPM) |
| `TEMP_FEVER` | `38.0` | Fever threshold (°C) |
| `TEMP_LOW` | `35.5` | Hypothermia threshold (°C) |
| `INTERNAL_SERVICE_TOKEN` | *(empty)* | Bearer token Safety Guard sends when posting alerts to api-gateway |
| `GATEWAY_INTERNAL_URL` | `http://localhost:3000` | Where Safety Guard posts alert notifications |
| `SUMMARY_GRPC_PORT` | `50053` | Port the Python gRPC server listens on |

---

## Database Setup — What Is Needed

### Tables managed automatically (no migration needed)

These are created by `CREATE TABLE IF NOT EXISTS` on every cold boot:

| Table | Created by | Purpose |
|---|---|---|
| `embedding_config` | `rag_agent.ensure_schema()` | Stores which embedding model/dim is in use |
| `embeddings` | `rag_agent.ensure_schema()` | pgvector chunks for prescriptions and historical summaries |
| `monitor_state` | `safety_guard.ensure_schema()` | Single-row cursor tracking last-processed vital_sign timestamp |

### Tables managed by TypeORM (NestJS)

These are created when any NestJS service boots with `NODE_ENV != production` (i.e. on first local dev run or if `synchronize` is enabled). In production they must already exist.

| Table | Owner service | Key columns |
|---|---|---|
| `vital_sign` | health-service | `"userId"`, `"heartRate"`, `spo2`, `temperature`, `"deviceId"`, `timestamp` |
| `alert` | api-gateway | `id`, `type`, `severity`, `"userId"`, `"deviceId"`, `"isDismissed"` |
| `summary_history` | api-gateway | `id`, `"userId"`, `summary` (JSON), `"hasCritical"`, `"windowStart"`, `"reportType"` |
| `user` | auth-service | `id`, `email`, `password`, `role` |
| `iot_device` | api-gateway | `id`, `"deviceId"`, `"userId"` |

### pgvector extension

Must be enabled in your PostgreSQL database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Most managed Postgres providers (Neon, Supabase, Railway, Aiven) support pgvector but require you to run this command manually once. **The service auto-runs this** via `ensure_schema()` on boot — as long as the DB user has `CREATE EXTENSION` permission. If it doesn't, run the command manually in your DB console first.

---

## How to Trigger Each Feature

### 1. On-demand health report

**Requires:** `DATABASE_URL`, `JWT_SECRET`, at least one LLM key set in env.

```http
POST /summary
Authorization: Bearer <user_jwt>
Content-Type: application/json

{
  "logs": [
    { "heartRate": 72, "spo2": 97, "temperature": 36.5, "timestamp": 1718000000000 },
    { "heartRate": 85, "spo2": 95, "temperature": 37.1, "timestamp": 1718000300000 }
  ]
}
```

Returns cached today's report if one already exists (no LLM call). Otherwise calls `AnalyzeData` gRPC → LLM → saves to `summary_history`.

**Response:**
```json
{
  "cached": false,
  "report": {
    "overview": "...",
    "heart_rate_analysis": "...",
    "spo2_analysis": "...",
    "recommendations": ["..."],
    "has_critical": false
  },
  "hasCritical": false,
  "recommendations": ["..."]
}
```

---

### 2. Upload a prescription PDF (feeds the RAG)

**Requires:** `GEMINI_API_KEY` (or `OPENAI_API_KEY` if `EMBEDDING_PROVIDER=openai`).

```http
POST /summary/upload-prescription
Authorization: Bearer <user_jwt>
Content-Type: multipart/form-data

file: <PDF file>
```

Internally:
1. PDF bytes → extract text (pypdf)
2. Split into 800-char overlapping chunks
3. Each chunk embedded via Gemini / OpenAI
4. Stored in `embeddings` table (pgvector)

**Response:**
```json
{ "success": true, "message": "Prescription uploaded successfully", "docId": "a1b2c3d4e5f60718" }
```

After upload, every subsequent report for this user will automatically include relevant prescription context.

---

### 3. Ask a question about a prescription

**Requires:** Same embedding key + one LLM key.

```http
POST /summary/query-prescription
Authorization: Bearer <user_jwt>
Content-Type: application/json

{ "question": "What is the dosage for Metformin?" }
```

Internally:
1. Embeds the question
2. Cosine similarity search (threshold 0.60) over the user's `prescription` chunks
3. Top-5 matching chunks fed into LLM prompt
4. Returns clinical answer

**Response:**
```json
{ "success": true, "answer": "Based on your prescription, Metformin is prescribed at 500mg twice daily with meals." }
```

---

### 4. Scheduled batch reports (automatic)

Runs at **00:00, 06:00, 12:00, 18:00 UTC** without any trigger.

The `run_report_scheduler` thread wakes at the next boundary, fetches all `vital_sign` rows for the current 6-hour window, groups by user, generates a report per user, saves to `summary_history`, and indexes it for RAG retrieval.

**Idempotent** — if a report for a user+window already exists it is skipped.

---

### 5. Safety Guard (automatic)

Starts immediately on service boot. No trigger needed.

Every 10 s it:
1. Reads `vital_sign` rows newer than its last cursor
2. Evaluates each row against thresholds
3. Writes triggered alerts to `alert` table with deterministic IDs (`{type}_{deviceId}_{timestamp}`)
4. POSTs to `GATEWAY_INTERNAL_URL/internal/alerts` with `INTERNAL_SERVICE_TOKEN` so the gateway can push a WebSocket event

Per-alert-type cooldowns prevent duplicate alerts:
- Critical (SpO2, SOS, fall): 5 minutes
- High (HR, temperature): 15 minutes
- Medium (moisture): 30 minutes

---

## Minimum Koyeb Environment Variables to Go Live

```
DATABASE_URL         = postgresql://user:pass@host/dbname?sslmode=require
JWT_SECRET           = <random 64-char hex string>
GEMINI_API_KEY       = <your Google AI Studio key>
INTERNAL_SERVICE_TOKEN = <any shared secret string>
NODE_ENV             = production
```

That gives you: working auth, safety alerts, on-demand reports, and scheduled reports.  
To also enable prescription RAG: `GEMINI_API_KEY` already covers embeddings (default provider is `gemini`).

---

## Verification After Deploy

Check these in the Koyeb runtime logs:

| Log line | Means |
|---|---|
| `Safety-guard schema ensured (monitor_state)` | Agent 1 ready |
| `RAG schema ensured (embedding_config, embeddings)` | Agent 2 ready |
| `Embedding config bootstrapped: model=..., dim=768` | First boot — embedding config row created |
| `Safety guard starting, cursor=...` | Agent 1 polling |
| `Next scheduled report at ..., sleeping ...s` | Agent 3 scheduler running |
| `gRPC server listening on port 50053` | gRPC server up |
| `[Nest] ... ApiGateway ...` | api-gateway up (port 3000) |

If you see `All LLM providers failed` in the logs, no API key is set.  
If you see `UndefinedTable: relation "vital_sign"`, TypeORM hasn't run migrations yet — deploy once in non-production mode to let it create the schema, then switch back.
