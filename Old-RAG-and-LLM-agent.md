# Old RAG System & LLM Agent — Architecture Reference

> This document maps every file that participates in the RAG pipeline and the AI
> summary feature as they existed on the `main` branch. Use it as a baseline when
> redesigning or replacing these components.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [File Index — RAG & AI Code](#2-file-index--rag--ai-code)
3. [RAG System — Prescription QA (ChromaDB)](#3-rag-system--prescription-qa-chromadb)
4. [RAG System — Healthy Message Generation (FAISS)](#4-rag-system--healthy-message-generation-faiss)
5. [LLM Provider Orchestrator](#5-llm-provider-orchestrator)
6. [AI Summary Feature — How It Works End to End](#6-ai-summary-feature--how-it-works-end-to-end)
7. [Real-Time Nurse Agent (No LLM)](#7-real-time-nurse-agent-no-llm)
8. [Background Threads](#8-background-threads)
9. [gRPC Service Layer](#9-grpc-service-layer)
10. [API Gateway (TypeScript/NestJS)](#10-api-gateway-typescriptnestjs)
11. [Proto Contract](#11-proto-contract)
12. [Data Flow Diagrams](#12-data-flow-diagrams)
13. [Environment Variables](#13-environment-variables)

---

## 1. System Overview

The AI backend is split into two runtimes connected via gRPC:

| Runtime | Language | Port | Responsibility |
|---------|----------|------|----------------|
| **AI Summary Service** | Python | 50053 | Embeddings, RAG, LLM calls, background monitoring |
| **API Gateway** | TypeScript / NestJS | 3000 | HTTP REST, auth, gRPC proxy to Python |

The Python service runs **three concurrent threads** at startup:
- **Main thread** — gRPC server (handles incoming calls)
- **DB Poller thread** — polls PostgreSQL every 10 s for new vitals → threshold alerts
- **Routine Reporter thread** — wakes every 6 hours → LLM-generated clinical reports

---

## 2. File Index — RAG & AI Code

### Python — AI Summary Service (`apps/ai-summary-service/src/`)

| File | Role |
|------|------|
| `main.py` | Entry point; starts gRPC server + 2 background threads; global `PrescriptionRAG` singleton |
| `core/prescription_rag.py` | **ChromaDB RAG** — PDF ingestion, embedding, user-scoped retrieval, QA chain |
| `core/rag_service.py` | **FAISS RAG** — ephemeral in-memory vector store; generates personalized health tips from the LLM report |
| `core/llm_provider.py` | Multi-provider LLM factory with singleton caching and ordered fallback |
| `core/health_agent.py` | Main AI report generator; calls LLM with sensor data; merges nurse alerts |
| `core/nurse_agent.py` | Real-time threshold-based anomaly detector (no LLM) |
| `core/db_poller.py` | Background thread — polls `vital_sign` table, calls nurse agent on new rows |
| `core/routine_reporter.py` | Background thread — every 6 h fetches logs, calls health agent, stores report in DB |

### TypeScript — API Gateway (`apps/api-gateway/src/`)

| File | Role |
|------|------|
| `summary.controller.ts` | REST endpoints for `/summary`, `/summary/history`, `/summary/upload_prescription`, `/summary/query_prescription` |
| `reports.controller.ts` | REST endpoint `/reports/export` — date-range logs + AI analysis |
| `health.controller.ts` | REST endpoints for log sync and retrieval |
| `database/entities/summary-history.entity.ts` | TypeORM entity for the `summary_history` table |

### Proto

| File | Role |
|------|------|
| `libs/common/src/proto/summary.proto` | Contract between NestJS and Python gRPC service |

---

## 3. RAG System — Prescription QA (ChromaDB)

**File:** `apps/ai-summary-service/src/core/prescription_rag.py`

### What it does

Lets a user upload a PDF prescription (Sri Lankan "Beheth Thundu") and later ask
natural-language questions about it. Answers are grounded strictly in that user's
own uploaded documents — not hallucinated.

### Initialization (`__init__`)

Embedding backend is chosen at startup based on which API keys are present:

```
OPENAI_API_KEY set?  → OpenAI  text-embedding-ada-002
else GEMINI_API_KEY? → Gemini  models/text-embedding-004
else                 → Local   HuggingFace all-MiniLM-L6-v2
```

ChromaDB is opened (or created) at `<cwd>/chroma_db/` using collection name
`"prescriptions"`. This directory persists across restarts — embeddings are not
recomputed on every boot.

### Upload flow (`upload_prescription`)

```
PDF bytes (via gRPC)
  → PyPDF2.PdfReader  — extract raw text from every page
  → RecursiveCharacterTextSplitter(chunk_size=1000, overlap=100)
  → List[Document] with metadata {"user_id": "<id>", "source": "prescription"}
  → Chroma.add_documents()  — embeds chunks and persists to disk
```

### Query flow (`query_prescription`)

```
user question (string)
  → Chroma.as_retriever(filter={"user_id": str(user_id)})
      — similarity search only within THIS user's chunks
  → Retrieved chunks → format_docs() → context string
  → ChatPromptTemplate:
      system: "clinical assistant — answer from context only; if absent say so"
      human:  <question>
  → LLM (tries providers in order until one succeeds)
  → StrOutputParser() → answer string → back via gRPC
```

### Key design decisions

- **User isolation** — every chunk is tagged with `user_id`; the retriever filter
  ensures no cross-user data leakage.
- **Provider fallback** — if the first LLM (e.g. OpenAI) fails, the chain retries
  with the next available provider. This keeps the QA working even if one API is
  down.
- **Persistence** — ChromaDB writes to disk; prescription embeddings survive
  service restarts without re-upload.

---

## 4. RAG System — Healthy Message Generation (FAISS)

**File:** `apps/ai-summary-service/src/core/rag_service.py`

### What it does

Takes the markdown medical report already produced by the health agent and uses a
small, local RAG pipeline to ask a focused question against it, producing 2–3
friendly "Healthy Message" notifications for caregivers or the patient.

> **Note:** As of the latest `health_agent.py`, the personalized health messages
> are generated inline inside the single LLM call (section 5 of the prompt
> template). The `HealthyMessageRAG` class exists but `generate_ai_analysis` no
> longer calls it — the section below describes the class as written.

### Singleton pattern

```python
_healthy_message_rag = None

def get_healthy_message_rag():
    global _healthy_message_rag
    if _healthy_message_rag is None:
        _healthy_message_rag = HealthyMessageRAG()  # loads HuggingFace model once
    return _healthy_message_rag
```

The HuggingFace `all-MiniLM-L6-v2` model is heavy to load; the singleton prevents
reloading on every report cycle.

### Pipeline (`generate_healthy_messages`)

```
medical_report (markdown string)
  → Document(page_content=report)
  → RecursiveCharacterTextSplitter(chunk_size=500, overlap=50)
  → FAISS.from_documents(splits, HuggingFaceEmbeddings)   ← ephemeral, in-memory
  → retriever = vectorstore.as_retriever()
  → fixed question: "What personalized health advice do you have for me today
                     based on my vitals?"
  → ChatPromptTemplate:
      system: "SoterCare Nurse — 2–3 friendly personalized tips based on context"
      human: <fixed question>
  → LLM (first available provider only — no fallback loop)
  → StrOutputParser() → friendly message string
```

### Key design decisions

- **FAISS vs ChromaDB** — FAISS is used here because the vector store is throwaway
  (rebuilt per report); no persistence needed. ChromaDB is used for prescriptions
  because those must survive restarts.
- **Graceful degradation** — if `sentence-transformers` is not installed, the class
  logs a warning and returns a generic fallback string instead of crashing.

---

## 5. LLM Provider Orchestrator

**File:** `apps/ai-summary-service/src/core/llm_provider.py`

### What it does

Single function `get_available_llms()` returns an ordered list of `(name, llm)`
tuples for every provider whose API key is set at startup. All other modules
iterate this list and try providers in sequence until one succeeds.

### Provider priority order

| Priority | Provider | Model | Env Key | SDK |
|----------|----------|-------|---------|-----|
| 1 | ChatGPT (OpenAI) | gpt-3.5-turbo | `OPENAI_API_KEY` | `langchain_openai.ChatOpenAI` |
| 2 | Grok (xAI) | grok-4-1-fast | `GROK_API_KEY` | `langchain_openai.ChatOpenAI` with custom base_url |
| 3 | Gemini (Google) | gemini-2.0-flash (or `GEMINI_MODEL`) | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `langchain_google_genai.ChatGoogleGenerativeAI` |
| 4 | Claude (Anthropic) | claude-3-opus-20240229 | `CLAUDE_API_KEY` / `ANTHROPIC_API_KEY` | `langchain_anthropic.ChatAnthropic` |

### Caching

```python
_cached_llms = None   # module-level singleton

def get_available_llms():
    global _cached_llms
    if _cached_llms is not None:
        return _cached_llms
    # ... build list ...
    _cached_llms = llms
    return llms
```

LLM client objects are built **once** at first call and reused for the service
lifetime. Re-building them on every request would re-read env vars and
re-authenticate needlessly.

### SafeGemini wrapper

Gemini's `ChatGoogleGenerativeAI.invoke` does not accept a raw `PromptValue`
object. A thin subclass converts it to a plain string before passing it up:

```python
class SafeGemini(ChatGoogleGenerativeAI):
    def invoke(self, input, config=None, **kwargs):
        if isinstance(input, PromptValue):
            safe_input = input.to_string()
        elif isinstance(input, dict) and "text" in input:
            safe_input = input["text"]
        else:
            safe_input = str(input)
        return super().invoke(safe_input, config=config, **kwargs)
```

---

## 6. AI Summary Feature — How It Works End to End

**Files involved:**
- `apps/ai-summary-service/src/core/health_agent.py`
- `apps/ai-summary-service/src/core/nurse_agent.py`
- `apps/ai-summary-service/src/core/routine_reporter.py`
- `apps/ai-summary-service/src/core/db_poller.py`
- `apps/ai-summary-service/src/main.py`
- `apps/api-gateway/src/summary.controller.ts`
- `apps/api-gateway/src/database/entities/summary-history.entity.ts`

### Two entry paths for summary generation

#### Path A — On-demand via HTTP (`POST /summary`)

```
Client HTTP POST /summary
  → JwtAuthGuard extracts userId
  → SummaryController.getDailySummary()
      1. Check summary_history for any row with userId + createdAt >= today 00:00
         → If found: return cached summary immediately (no LLM call)
      2. gRPC call to HealthService.getLogsByDateRange(today)
         → returns raw vital_sign rows for today
      3. Map rows to plain objects {temperature, ambientTemp, moisture,
                                    gaitLabel, sos, fallAlert, timestamp}
      4. Downsample to max 300 logs if more exist
         (step = ceil(total / 300), keep every N-th log)
      5. gRPC call to SummaryService.AnalyzeData({data_json, format:"markdown"})
         → Python health_agent.generate_ai_analysis(logs)
      6. Save result to summary_history (userId, summary, recommendations)
      7. Return saved entity to client
```

#### Path B — Automatic 6-hour cycle (background thread)

```
routine_reporter.start_routine_reporter()          ← daemon thread
  → time.sleep(21600)  [6 hours]
  → SQL: SELECT * FROM vital_sign
         WHERE timestamp >= (now - 6h) AND timestamp <= now
  → Group rows by userId
  → For each user:
      generate_ai_analysis(logs)
        → LLM call (see below)
      INSERT INTO summary_history (id, userId, summary)
```

### Inside `generate_ai_analysis` (`health_agent.py`)

```
logs_data (list of dicts with sensor fields)
  │
  ├─ Step 1: Build LLM prompt
  │    PromptTemplate with variables: {logs}
  │    System role: "SoterCare AI — Clinical Decision Support System"
  │    Output spec: 200-250 word markdown report with 5 sections:
  │      1. Daily Overview
  │      2. Temperature & Environment
  │      3. Movement & Activity
  │      4. Key Recommendations
  │      5. Personalized Health Messages (nurse voice, 2-3 tips)
  │
  ├─ Step 2: Try LLM providers in order
  │    for name, llm in get_available_llms():
  │        chain = prompt | llm
  │        response = chain.invoke({"logs": str(logs_data)})
  │        if success → report_content = response.content; break
  │        else       → log warning, try next provider
  │
  ├─ Step 3: Run threshold-based nurse agent on same logs
  │    for each log in logs_data:
  │        alerts += analyze_real_time_vitals(log)
  │    deduplicate(alerts)
  │
  └─ Step 4: Assemble final output
       "# SoterCare 24/7 AI Nurse Analysis\n"
       "## Real-Time Nurse Alerts ...\n"
       <bullet list of alerts or "No immediate critical alerts">
       "---\n"
       <LLM markdown report>
```

### LLM prompt template (full)

```
You are SoterCare AI, a Clinical Decision Support System analyzing sensor data
for elderly patient monitoring.

TASK: Generate a concise, highly readable medical report based on the hardware
sensor data provided. Keep the entire report brief and to the point.

DATA KEYS:
- 'temperature':  Skin Temperature (Normal: 32-37°C)
- 'ambientTemp':  Room Temperature
- 'moisture':     Hydration/Sweat level
- 'gaitLabel':    Patient Movement Activity ("walking", "sitting", "standing")
- 'sos' / 'fallAlert': Boolean triggers for emergencies.

PATIENT SENSOR DATA (JSON format):
{logs}

REPORT STRUCTURE:
### 1. Daily Overview
[2-sentence executive summary; note any emergencies]

### 2. Temperature & Environment
- Briefly note average Skin Temp and Room Temp; note fever risks.

### 3. Movement & Activity
- Summarize mobility from gaitLabel states; note any falls.

### 4. Key Recommendations
- [Bullet 1]
- [Bullet 2]

### 5. Personalized Health Messages
[Switch voice to 'SoterCare Nurse'. Write 2-3 short, friendly, personalized
pieces of advice directly to the caregiver or patient. If anomalies, gently
remind them to follow instructions.]

*Limit entire response to 200-250 words. Do not hallucinate missing data.*
```

### `summary_history` database table

```
Table: summary_history
  id          UUID        PK  (generated in Python with uuid.uuid4())
  userId      int         FK → user, indexed
  summary     text        full markdown report
  recommendations text   (set to static string "Generated based on analysis.")
  createdAt   timestamptz auto-set by TypeORM CreateDateColumn
```

---

## 7. Real-Time Nurse Agent (No LLM)

**File:** `apps/ai-summary-service/src/core/nurse_agent.py`

Pure threshold logic — no LLM, no network calls. Called on every new vital
reading by the DB poller, and on every log in the batch by `health_agent`.

### Alert checks (in order)

| # | Check | Condition | Alert message |
|---|-------|-----------|---------------|
| 1 | SOS button | `sos == 1` | `EMERGENCY (CRITICAL): SOS Button Activated` |
| 2 | Fall detection | `fallAlert == 1` or `True` | `FALL ALERT (CRITICAL): Hardware fall detection triggered` |
| 3 | Skin temperature | `temp < 32.0` or `temp > 40.0` | `WARNING: Unusual skin temperature detected ({temp}°C)` |
| 4 | Temp discrepancy | `abs(skin_temp - env_temp) > 10.0` | `ALERT: High discrepancy ({diff}°C) between skin and environment` |
| 5 | Hydration | `moisture < 20` (0-100 scale) | `HYDRATION WARNING: moisture very low ({moisture})` |

Field aliases handled: `temperature` / `temp`, `ambientTemp` / `ambient_temp`,
`fallAlert` / `fall_alert`.

---

## 8. Background Threads

### DB Poller (`core/db_poller.py`)

```
startup → last_processed_timestamp = now (ms)
loop every POLL_INTERVAL_SECONDS (default 10):
    SELECT * FROM vital_sign
    WHERE CAST(timestamp AS BIGINT) > last_processed_timestamp
    ORDER BY timestamp ASC

    for each row:
        alerts = analyze_real_time_vitals(row)
        if alerts: logger.warning(alerts)
        update last_processed_timestamp

on psycopg2.OperationalError:
    close pool
    retry with exponential backoff (doubles each time, capped at 300 s)
```

Connection pool: `psycopg2.pool.SimpleConnectionPool(1, 10, db_url)`

### Routine Reporter (`core/routine_reporter.py`)

```
startup → time.sleep(ROUTINE_REPORT_INTERVAL_SECONDS = 21600)
loop every 6 hours:
    SELECT * FROM vital_sign
    WHERE timestamp >= (now - interval) AND timestamp <= now

    group by userId
    for each userId:
        clean_log = {ts, temp, ambientTemp, moisture, gaitLabel,
                     sos, fallAlert, thighnodeStatus}
        report_markdown = generate_ai_analysis(user_logs)
        INSERT INTO summary_history (id, userId, summary)

on psycopg2.OperationalError:
    close pool
    retry with exponential backoff (doubles, capped at 3600 s)
```

Connection pool: `psycopg2.pool.SimpleConnectionPool(1, 5, db_url)`

Both threads connect using `DATABASE_URL` env var if set (managed providers like
Neon/Supabase/Koyeb), falling back to individual `DB_*` vars for self-hosted
Postgres. `DB_SSL=true` appends `?sslmode=require`.

---

## 9. gRPC Service Layer

**File:** `apps/ai-summary-service/src/main.py`

### Server config

```python
grpc.server(
    futures.ThreadPoolExecutor(max_workers=10),
    options=[
        ("grpc.max_receive_message_length", max_msg_bytes),  # default 20 MB
        ("grpc.max_send_message_length",    max_msg_bytes),
    ],
)
```

Port: `SUMMARY_GRPC_PORT` env var, default `50053`.

### Service methods

| gRPC Method | Python handler | What it does |
|-------------|---------------|--------------|
| `AnalyzeData` | `SummaryService.AnalyzeData` | Parses `data_json` → calls `generate_ai_analysis` → returns markdown + static recommendations string |
| `UploadPrescription` | `SummaryService.UploadPrescription` | Validates `.pdf` extension → wraps bytes in `io.BytesIO` → calls `rag_service.upload_prescription` |
| `QueryPrescription` | `SummaryService.QueryPrescription` | Calls `rag_service.query_prescription(user_id, question)` → returns answer |
| `SummarizeText` | `SummaryService.SummarizeText` | Generic text summarization via any available LLM |

`PrescriptionRAG` is instantiated **once** at module load as `rag_service` (global
singleton) so ChromaDB is opened only once.

---

## 10. API Gateway (TypeScript/NestJS)

### `apps/api-gateway/src/summary.controller.ts`

| Endpoint | Method | Auth | What it does |
|----------|--------|------|--------------|
| `POST /summary` | `getDailySummary` | JWT | Cache-check today's report → fetch logs → downsample → gRPC AnalyzeData → save + return |
| `GET /summary/history` | `getSummaryHistory` | JWT | Returns last 30 summary_history rows for userId |
| `POST /summary/text` | `summarizeTextLegacy` | JWT | Passes body.text to gRPC SummarizeText |
| `POST /summary/upload_prescription` | `uploadPrescription` | JWT | Reads multipart PDF → gRPC UploadPrescription with userId from JWT (never client-supplied) |
| `POST /summary/query_prescription` | `queryPrescription` | JWT | Sends question + userId (from JWT) to gRPC QueryPrescription |

Security note: `userId` for prescription operations is always taken from the
verified JWT token, never from the request body — prevents a user reading another
user's prescriptions.

Log downsampling logic:
```typescript
const MAX_LOGS = 300;
if (plainLogs.length > MAX_LOGS) {
    const step = Math.ceil(plainLogs.length / MAX_LOGS);
    sampledLogs = plainLogs.filter((_, index) => index % step === 0);
}
```

### `apps/api-gateway/src/reports.controller.ts`

`POST /reports/export` — fetches logs for a date range via `HealthService.getLogsByDateRange`,
then runs `SummaryService.AnalyzeData` on them. Returns logs + AI summary + recommendations.

### `apps/api-gateway/src/database/entities/summary-history.entity.ts`

TypeORM entity backing the `summary_history` table (id UUID, userId int, summary
text, recommendations text, createdAt timestamptz).

---

## 11. Proto Contract

**File:** `libs/common/src/proto/summary.proto`

```protobuf
syntax = "proto3";
package summary;

service SummaryService {
  rpc AnalyzeData          (AnalyzeDataRequest)          returns (AnalyzeDataResponse);
  rpc UploadPrescription   (UploadPrescriptionRequest)   returns (UploadPrescriptionResponse);
  rpc QueryPrescription    (QueryPrescriptionRequest)    returns (QueryPrescriptionResponse);
  rpc SummarizeText        (SummarizeTextRequest)        returns (SummarizeTextResponse);
}

message AnalyzeDataRequest    { string data_json = 1; string format = 2; }
message AnalyzeDataResponse   { string summary = 1; string recommendations = 2; }
message UploadPrescriptionRequest { int32 user_id = 1; bytes file_data = 2; string file_name = 3; }
message UploadPrescriptionResponse { bool success = 1; string message = 2; }
message QueryPrescriptionRequest  { int32 user_id = 1; string question = 2; }
message QueryPrescriptionResponse { bool success = 1; string answer = 2; }
message SummarizeTextRequest  { string text = 1; }
message SummarizeTextResponse { string summary = 1; }
```

---

## 12. Data Flow Diagrams

### Prescription Upload & Query

```
Client
  │  POST /summary/upload_prescription  (multipart PDF)
  ▼
summary.controller.ts
  │  gRPC UploadPrescription { user_id, file_data, file_name }
  ▼
main.py  SummaryService.UploadPrescription
  │  io.BytesIO(file_data)
  ▼
prescription_rag.py  PrescriptionRAG.upload_prescription(user_id, pdf_file)
  ├─ PyPDF2.PdfReader → raw text
  ├─ RecursiveCharacterTextSplitter(1000, 100) → chunks
  ├─ metadata = { user_id, source:"prescription" }
  └─ Chroma.add_documents(docs)  →  chroma_db/  (disk)

  ──────────────────────────────────────────

Client
  │  POST /summary/query_prescription  { question }
  ▼
summary.controller.ts
  │  gRPC QueryPrescription { user_id, question }
  ▼
main.py  SummaryService.QueryPrescription
  ▼
prescription_rag.py  PrescriptionRAG.query_prescription(user_id, question)
  ├─ Chroma.as_retriever(filter={user_id:str})
  ├─ similarity search → relevant chunks
  ├─ ChatPromptTemplate (clinical assistant)
  └─ LLM fallback chain → answer string
  ▼
gRPC QueryPrescriptionResponse  →  HTTP response
```

### On-Demand AI Summary

```
Client
  │  POST /summary
  ▼
summary.controller.ts
  ├─ Query summary_history (today, userId)
  │    → hit?  return cached summary
  │    → miss? continue ↓
  ├─ gRPC HealthService.getLogsByDateRange(today)
  ├─ Downsample to ≤300 logs
  ├─ gRPC SummaryService.AnalyzeData(data_json)
  │    ▼
  │  main.py → health_agent.generate_ai_analysis(logs)
  │    ├─ PromptTemplate.invoke({logs}) → LLM (fallback)
  │    │    → markdown report (200-250 words, 5 sections)
  │    ├─ nurse_agent.analyze_real_time_vitals(each_log)
  │    │    → threshold alerts list
  │    └─ merge → final markdown string
  │    ▼
  │  AnalyzeDataResponse { summary, recommendations }
  ├─ summaryHistoryRepo.save({ userId, summary, recommendations })
  └─ return saved entity
```

### Automatic 6-Hour Report

```
routine_reporter  (daemon thread, wakes every 6 h)
  ├─ SELECT vital_sign WHERE timestamp in last 6 h
  ├─ group by userId
  └─ for each userId:
       generate_ai_analysis(logs)
         └─ same LLM + nurse agent pipeline as above
       INSERT INTO summary_history (id, userId, summary)
                                   ↑
          same table /summary/history endpoint reads
```

### Real-Time Alert Monitoring

```
db_poller  (daemon thread, polls every 10 s)
  ├─ SELECT vital_sign WHERE timestamp > last_seen
  └─ for each new row:
       nurse_agent.analyze_real_time_vitals(row)
         ├─ sos == 1?           → EMERGENCY alert
         ├─ fallAlert == 1?     → FALL ALERT
         ├─ temp < 32 or > 40? → temperature warning
         ├─ |skin-env| > 10?   → discrepancy alert
         └─ moisture < 20?     → hydration warning
       logger.warning(alerts)   ← no LLM involved
```

---

## 13. Environment Variables

```bash
# ── LLM Providers (at least one required) ──────────────────────────
OPENAI_API_KEY=sk-...
GROK_API_KEY=...
GEMINI_API_KEY=AIza...       # or GOOGLE_API_KEY
GEMINI_MODEL=gemini-2.0-flash  # optional, this is the default
CLAUDE_API_KEY=...           # or ANTHROPIC_API_KEY

# ── Database ────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@host:5432/db   # managed providers (Neon, Supabase)
# If DATABASE_URL is not set, individual vars are used:
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASS=postgres
DB_NAME=auth_db
DB_SSL=false    # set true for managed Postgres (appends ?sslmode=require)

# ── gRPC ────────────────────────────────────────────────────────────
SUMMARY_GRPC_PORT=50053
SUMMARY_GRPC_MAX_MESSAGE_MB=20   # max payload size for PDF uploads
HEALTH_SERVICE_URL=localhost:50054

# ── Background Thread Intervals ─────────────────────────────────────
POLL_INTERVAL_SECONDS=10           # DB poller frequency
ROUTINE_REPORT_INTERVAL_SECONDS=21600  # 6 hours
```

---

## Python Dependencies (AI Summary Service)

```
grpcio
grpcio-tools
protobuf
python-dotenv
PyPDF2
langchain
langchain-core
langchain-openai
langchain-google-genai
langchain-anthropic
langchain-community
langchain-chroma
langchain-text-splitters
chromadb
sentence-transformers   # for HuggingFace local embeddings
psycopg2-binary
```
