# New RAG & AI Agent System — Implementation Plan

**Date:** 2026-06-10  
**Based on:** Analysis of `Old-RAG-and-LLM-agent.md`, `M01-log.md`, `3days-sample.json`,  
`vital-sign.entity.ts`, `vital.entity.ts`, `alert.entity.ts`, and all existing service code.

---

## 1. Why the Old System Broke (Root Cause Diagnosis)

Before designing the new system, the exact failure modes need to be understood so
they are not repeated.

| # | What Broke | Why It Broke | Fix Approach |
|---|-----------|-------------|--------------|
| C1 | Service crashed on fresh deploy | `pyproject.toml` missing ~10 required packages; committed `venv/` masked this | Proper `pyproject.toml` with pinned versions |
| C2 | Prescription QA returned garbage silently | Chroma written with one embedding model (1536-dim), queried with another (768-dim) after provider change | Pin one embedding backend; store dim metadata; validate on startup |
| C3 | 6-hour reports failed for active patients | Routine reporter passed ALL vitals to LLM with no token budget | Smart downsampling shared between both paths |
| C4 | Real-time alerts never reached anyone | Poller detected anomalies but only `logger.warning()`'d them — nothing wrote to `alerts` table, nothing emitted via WebSocket | Wire poller to `alerts` DB + WebSocket |
| H2 | SOS/fall events dropped from summaries | Modulo downsampler could delete the only critical log in a day | Critical events always kept; sample only normal rows |
| H4 | Monitoring gaps after restarts | Poller cursor in memory only; reset to "now" on every restart | Persist cursor in DB |

**The single most important lesson:** the architecture was sound; the implementation
missed every connection between detection → storage → delivery. The nurse agent ran
correctly but its output went nowhere.

---

## 2. What the Device Actually Sends

From `3days-sample.json` (3 days of real device data, ~864 readings/day at 5-min intervals):

```json
{
  "id": 1,
  "userId": 1,
  "data": {
    "heartRate": 75,
    "spo2": 97,
    "temperature": 36.5,
    "timestamp": 1769098956502
  },
  "timestamp": "2026-01-22T21:52:36.502080"
}
```

**Current data fields from the wearable device:**

| Field | Type | Unit | Normal Range | Notes |
|-------|------|------|-------------|-------|
| `heartRate` | int | BPM | 60–100 | Resting; lower at night (~55–70 in sample) |
| `spo2` | int | % | 95–100 | Below 92 = emergency |
| `temperature` | float | °C | 36.0–37.5 | Clear circadian pattern in sample (low at night, rising through day) |
| `timestamp` | bigint ms | — | — | Unix epoch milliseconds |

**Additional fields in `vital_sign` table (from `thigh node` / other sensors):**

| Field | Type | Notes |
|-------|------|-------|
| `ambientTemp` | float | Room/environmental temperature |
| `moisture` | float | Sweat/hydration proxy (0–100 scale, hardware spec needed) |
| `sos` | boolean | Manual SOS button press |
| `fallAlert` | boolean | Hardware accelerometer fall detection |
| `gaitLabel` | text | `"walking"` / `"sitting"` / `"standing"` |
| `thighnodeStatus` | text | Thigh-node connectivity / status string |

> **Schema gap:** `heartRate` and `spo2` appear in the device payload but are NOT
> in `vital_sign.entity.ts`. These are the most clinically valuable fields (SpO2 is
> the primary COVID/respiratory emergency indicator). **Phase 1 must add these columns.**

**Observed patterns in 3 days of sample data:**
- Readings every 5 minutes → ~288 readings/day, ~864 per sync window
- Clear circadian pattern: HR 55–70 at night, 75–95 in morning activity, temp 36.2 → 37.4 during the day
- Data is clean and well-structured — the sensor is reliable
- No SOS/fall events in the sample → the happy path

---

## 3. New Architecture Overview

The new system uses **three purpose-built agents**, each with a single well-defined
responsibility. They run concurrently as threads inside the same Python gRPC service.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ai-summary-service  (Python, port 50053)          │
│                                                                       │
│  ┌──────────────────┐  ┌─────────────────────┐  ┌────────────────┐  │
│  │  Agent 1         │  │  Agent 2             │  │  Agent 3       │  │
│  │  Safety Guard    │  │  Prescription &      │  │  Clinical      │  │
│  │  (no LLM)        │  │  History RAG         │  │  Report Agent  │  │
│  │                  │  │  (pgvector + LLM)    │  │  (LLM)         │  │
│  │  - polls DB      │  │                      │  │                │  │
│  │  - writes alerts │  │  - PDF upload/query  │  │  - on-demand   │  │
│  │  - emits via WS  │  │  - indexes summaries │  │  - scheduled   │  │
│  │  - durable cursor│  │  - retrieves context │  │  - structured  │  │
│  └──────────────────┘  └─────────────────────┘  └────────────────┘  │
│                                    │                      │           │
│                          ┌─────────▼──────────┐          │           │
│                          │  pgvector store     │◄─────────┘           │
│                          │  (Postgres ext)     │                      │
│                          └────────────────────┘                      │
│                                                                       │
│  ┌────────────────────────────────────────────────────┐              │
│  │  Shared: LLMProvider, invoke_with_fallback(),       │              │
│  │          prepare_logs(), structured output schema   │              │
│  └────────────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
         │ gRPC                              │ direct DB (psycopg2)
         ▼                                   ▼
   api-gateway (NestJS)               PostgreSQL (shared)
         │                             ├── vital_sign
         │ WebSocket                   ├── alerts
         ▼                             ├── summary_history
   frontend clients                   └── pgvector embeddings
```

---

## 4. Agent 1 — Real-Time Safety Guard

**File:** `apps/ai-summary-service/src/core/safety_guard.py`  
**Thread name:** `safety-guard`  
**No LLM involved.** Pure threshold logic with DB writes and WebSocket notify.

### 4.1 What it Does

Monitors the `vital_sign` table for new readings. When an anomaly is detected,
it writes to the `alerts` table and notifies the gateway via a lightweight HTTP
call (which the gateway forwards over WebSocket to connected clients).

### 4.2 Alert Thresholds

All thresholds must be configurable via environment variables:

| Check | Condition | Alert Type | Severity | Default Threshold |
|-------|-----------|------------|---------|------------------|
| SOS button | `sos == True` | `help_call` | CRITICAL | — |
| Fall detection | `fallAlert == True` | `fall` | CRITICAL | — |
| Low SpO2 | `spo2 < SPO2_LOW` | `temperature` | CRITICAL | 92% |
| High heart rate | `heartRate > HR_HIGH` | `movement` | HIGH | 120 BPM |
| Low heart rate | `heartRate < HR_LOW` | `movement` | HIGH | 45 BPM |
| Fever | `temperature > TEMP_FEVER` | `temperature` | HIGH | 38.0°C |
| Hypothermia | `temperature < TEMP_LOW` | `temperature` | HIGH | 35.5°C |
| High moisture | `moisture > MOISTURE_HIGH` | `moisture` | MEDIUM | 80 |
| Low moisture | `moisture < MOISTURE_LOW` | `moisture` | MEDIUM | 15 |

> Previous system used 32°C as the low threshold — this is too low (normal skin temp
> is 32–35°C; core hypothermia starts at 35°C). Corrected above.

### 4.3 Durable Cursor

```python
# On startup: read from DB, not memory
def get_cursor(conn) -> int:
    row = conn.execute(
        "SELECT last_timestamp FROM monitor_state WHERE id = 1"
    ).fetchone()
    if row:
        return row["last_timestamp"]
    # First run: start from now - LOOKBACK_SECONDS to catch anything missed
    lookback = int(time.time() * 1000) - (LOOKBACK_SECONDS * 1000)
    return lookback

# After processing each row: persist cursor
def save_cursor(conn, ts: int):
    conn.execute(
        "INSERT INTO monitor_state (id, last_timestamp) VALUES (1, %s) "
        "ON CONFLICT (id) DO UPDATE SET last_timestamp = EXCLUDED.last_timestamp",
        (ts,)
    )
```

### 4.4 Deduplication / Hysteresis

A sustained anomaly across many rows must fire ONE alert, not hundreds.

```python
# In-memory per-user state: {(userId, alert_type): expires_at_ms}
_alert_cooldown: dict[tuple, int] = {}

def is_in_cooldown(userId: int, alert_type: str) -> bool:
    key = (userId, alert_type)
    expires = _alert_cooldown.get(key, 0)
    return time.time() * 1000 < expires

def set_cooldown(userId: int, alert_type: str, duration_ms: int):
    _alert_cooldown[(userId, alert_type)] = time.time() * 1000 + duration_ms
```

Cooldown durations (configurable):
- CRITICAL (SOS, fall, low SpO2): 5 minutes
- HIGH (HR, fever, hypothermia): 15 minutes
- MEDIUM (moisture): 30 minutes

### 4.5 Alert Delivery

When an anomaly fires (not in cooldown):

1. **Write to `alerts` table** via direct psycopg2 INSERT — same table the
   NestJS API reads from. The gateway's `AlertWriterService` already handles the
   TypeORM side; the Python service can write directly with the correct schema.
   
2. **HTTP notify the gateway** — a simple `POST /internal/alert-ready?deviceId=X`
   to tell NestJS to push the latest alert via WebSocket. This avoids a direct
   Redis dependency in Python; the gateway already has the WebSocket infrastructure.

```python
# alerts table insert (matches alert.entity.ts exactly)
INSERT INTO alerts (id, device_id, type, title, timestamp, is_dismissed,
                    is_attended, is_false_alarm, sync_slot, created_at)
VALUES (%s, %s, %s, %s, %s, false, false, false, 'realtime', NOW())
```

### 4.6 Thread Loop

```python
def run_safety_guard():
    conn_pool = create_pool(DATABASE_URL)
    cursor = get_cursor(conn_pool)

    while True:
        try:
            new_rows = fetch_new_vitals(conn_pool, since=cursor)
            for row in new_rows:
                alerts = check_thresholds(row)  # pure function, no state
                for alert in alerts:
                    if not is_in_cooldown(row["userId"], alert.type):
                        write_alert(conn_pool, row, alert)
                        notify_gateway(row["deviceId"])
                        set_cooldown(row["userId"], alert.type, alert.cooldown_ms)
                cursor = max(cursor, int(row["timestamp"]))
            save_cursor(conn_pool, cursor)
        except psycopg2.OperationalError:
            reconnect_with_backoff(conn_pool)
        time.sleep(POLL_INTERVAL_SECONDS)  # default 10s
```

---

## 5. Agent 2 — Prescription & History RAG

**File:** `apps/ai-summary-service/src/core/rag_agent.py`  
**Thread:** runs only when called via gRPC (not a background thread)  
**Storage:** `pgvector` extension in the existing Postgres database

### 5.1 Why pgvector, Not ChromaDB

ChromaDB on local disk fails in containers (path is ephemeral, lost on redeploy).
`pgvector` runs as a Postgres extension — same DB already in use, backed up,
encrypted if the DB is, and survives redeploys. No separate service, no new dep.

```sql
-- One-time migration
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE embeddings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     INTEGER NOT NULL,
    doc_type    TEXT NOT NULL,      -- 'prescription' | 'summary'
    doc_id      TEXT NOT NULL,      -- prescription file hash or summary id
    chunk_idx   INTEGER NOT NULL,
    chunk_text  TEXT NOT NULL,
    embedding   VECTOR(768),        -- dimension fixed at startup
    model_id    TEXT NOT NULL,      -- e.g. 'models/text-embedding-004'
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON embeddings USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
CREATE INDEX ON embeddings (user_id, doc_type, doc_id);
```

### 5.2 Embedding Configuration

The embedding backend is chosen **once at startup** from an explicit env var,
NOT inferred from which LLM keys are present.

```python
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "gemini")
EMBEDDING_MODEL    = os.getenv("EMBEDDING_MODEL", "models/text-embedding-004")
EMBEDDING_DIM      = int(os.getenv("EMBEDDING_DIM", "768"))
```

On startup, the service reads the model metadata from a `embedding_config` table.
If the stored model doesn't match the configured one, it **refuses to start** with
a clear error message rather than silently returning wrong results.

```python
def validate_embedding_config(conn):
    row = conn.execute(
        "SELECT model_id, dim FROM embedding_config WHERE id = 1"
    ).fetchone()
    if row is None:
        # First run — write the config
        conn.execute(
            "INSERT INTO embedding_config VALUES (1, %s, %s)",
            (EMBEDDING_MODEL, EMBEDDING_DIM)
        )
        return
    if row["model_id"] != EMBEDDING_MODEL or row["dim"] != EMBEDDING_DIM:
        raise RuntimeError(
            f"Embedding mismatch: stored={row['model_id']}({row['dim']}d), "
            f"configured={EMBEDDING_MODEL}({EMBEDDING_DIM}d). "
            "Re-embed all documents or revert EMBEDDING_MODEL."
        )
```

### 5.3 Prescription Upload

```python
def upload_prescription(user_id: int, file_bytes: bytes, file_name: str) -> str:
    doc_id = hashlib.sha256(file_bytes).hexdigest()[:16]

    # Delete all existing chunks for this user+doc_id (re-upload replaces, not appends)
    delete_chunks(user_id=user_id, doc_id=doc_id, doc_type="prescription")

    text = extract_pdf_text(file_bytes)  # pypdf, not PyPDF2 (deprecated)
    chunks = split_text(text, chunk_size=800, overlap=80)

    embeddings = embed_batch(chunks)  # batched API call, not one-by-one

    insert_chunks(
        user_id=user_id,
        doc_type="prescription",
        doc_id=doc_id,
        chunks=chunks,
        embeddings=embeddings,
    )
    return doc_id
```

### 5.4 Prescription Query

```python
def query_prescription(user_id: int, question: str) -> str:
    q_embedding = embed_single(question)

    # Retrieval: cosine similarity, user-scoped, prescription-scoped only,
    # with score threshold to avoid low-relevance chunks
    rows = conn.execute("""
        SELECT chunk_text, 1 - (embedding <=> %s::vector) AS score
        FROM embeddings
        WHERE user_id = %s AND doc_type = 'prescription'
          AND 1 - (embedding <=> %s::vector) > 0.60
        ORDER BY score DESC
        LIMIT 5
    """, (q_embedding, user_id, q_embedding)).fetchall()

    if not rows:
        return "No relevant prescription information found for that question."

    context = "\n\n".join(row["chunk_text"] for row in rows)

    prompt = f"""You are a clinical assistant. Answer the question using ONLY the
prescription context below. If the answer is not in the context, say so explicitly.
Do not guess or hallucinate medication details.

PRESCRIPTION CONTEXT:
{context}

QUESTION: {question}"""

    return invoke_with_fallback(prompt, temperature=0.1)
```

### 5.5 Historical Context Indexing

After every successful clinical report (Agent 3), the report is also embedded and
stored in `pgvector` with `doc_type='summary'`. This enables Agent 3 on subsequent
runs to retrieve relevant past patterns.

```python
def index_summary(user_id: int, summary_id: str, summary_text: str):
    # Embed the whole summary as a few larger chunks (context window is big enough)
    chunks = split_text(summary_text, chunk_size=1200, overlap=100)
    embeddings = embed_batch(chunks)
    insert_chunks(
        user_id=user_id,
        doc_type="summary",
        doc_id=summary_id,
        chunks=chunks,
        embeddings=embeddings,
    )
```

### 5.6 Retrieve Historical Context for Report Generation

```python
def get_historical_context(user_id: int, current_vitals_summary: str) -> str:
    """Returns relevant past patterns to include in the report prompt."""
    q_embedding = embed_single(current_vitals_summary)

    rows = conn.execute("""
        SELECT chunk_text, 1 - (embedding <=> %s::vector) AS score
        FROM embeddings
        WHERE user_id = %s AND doc_type = 'summary'
          AND created_at < NOW() - INTERVAL '1 hour'  -- not today's report
          AND 1 - (embedding <=> %s::vector) > 0.55
        ORDER BY score DESC
        LIMIT 3
    """, (q_embedding, user_id, q_embedding)).fetchall()

    if not rows:
        return ""
    return "\n\n".join(row["chunk_text"] for row in rows)
```

---

## 6. Agent 3 — Clinical Report Agent

**File:** `apps/ai-summary-service/src/core/report_agent.py`  
**Thread name:** `report-scheduler`  
**Called via:** gRPC `AnalyzeData` (on-demand) AND background scheduler  

### 6.1 Structured Output Schema

The report returns **structured data**, not raw markdown. This fixes M5 (the dead
`recommendations` constant field) and makes the frontend able to render each section
independently.

```python
from pydantic import BaseModel
from typing import List

class HealthReport(BaseModel):
    overview: str               # 2-sentence executive summary
    temperature_analysis: str   # skin + room temp, fever/hypo flags
    heart_rate_analysis: str    # HR trends, bradycardia/tachycardia flags
    spo2_analysis: str          # oxygen saturation summary
    mobility_analysis: str      # gait patterns, fall/SOS events
    recommendations: List[str]  # 2–4 concrete bullet-point recommendations
    health_messages: List[str]  # 2–3 friendly nurse-voice messages for caregiver
    critical_events: List[str]  # any SOS/fall/critical thresholds crossed (deduplicated)
    has_critical: bool          # true if any critical_events present
```

This is returned by the gRPC call and persisted as JSON in `summary_history.summary`.
The `recommendations` column now contains real data.

### 6.2 Smart Log Downsampling

The key fix for H2 (emergency events sampled out) and C3 (unbounded LLM input).

```python
def prepare_logs(logs: list[dict], max_logs: int = 200) -> list[dict]:
    """
    Always retains critical rows. Samples normal rows to fit budget.
    Returns chronologically sorted list.
    """
    critical = [l for l in logs if is_critical(l)]
    normal   = [l for l in logs if not is_critical(l)]

    budget = max_logs - len(critical)
    if budget <= 0:
        # All rows are critical — take all of them
        sampled = critical
    elif len(normal) <= budget:
        sampled = critical + normal
    else:
        step = max(1, len(normal) // budget)
        sampled = critical + normal[::step]

    return sorted(sampled, key=lambda r: int(r["timestamp"]))

def is_critical(log: dict) -> bool:
    return (
        log.get("sos") is True or
        log.get("fallAlert") is True or
        (log.get("spo2") is not None and log["spo2"] < 92) or
        (log.get("heartRate") is not None and (log["heartRate"] > 120 or log["heartRate"] < 45)) or
        (log.get("temperature") is not None and (log["temperature"] > 38.0 or log["temperature"] < 35.5))
    )
```

### 6.3 Report Generation with RAG Context

```python
def generate_report(user_id: int, logs: list[dict]) -> HealthReport:
    prepared = prepare_logs(logs, max_logs=200)

    # Compute quick stats for RAG retrieval query
    stats_summary = compute_stats_summary(prepared)  # "avg HR 78, avg temp 36.8, ..."

    # Retrieve relevant historical context (Agent 2)
    history_ctx = rag_agent.get_historical_context(user_id, stats_summary)

    # Build the prompt
    history_section = f"\n\nRELEVANT HISTORICAL CONTEXT (past reports for this patient):\n{history_ctx}" if history_ctx else ""

    prompt = f"""You are SoterCare AI, a Clinical Decision Support System for elderly
patient monitoring. Analyze the sensor data and produce a structured health report.

CRITICAL: Base your analysis ONLY on the data provided. Do not invent values.
If a field is absent from the data, omit that analysis section.
Temperature values are body/skin temperature in °C (normal 36.0–37.5).

DATA FIELDS:
- heartRate: Heart rate in BPM (normal adult resting: 60–100)
- spo2: Blood oxygen saturation % (normal: 95–100; below 92 = emergency)
- temperature: Skin/body temperature in °C
- ambientTemp: Room temperature in °C
- moisture: Sweat/hydration level (0–100 scale)
- gaitLabel: Movement state ("walking", "sitting", "standing")
- sos: SOS button pressed (boolean)
- fallAlert: Hardware fall detected (boolean)

PATIENT SENSOR DATA (JSON, {len(prepared)} readings):
{json.dumps(prepared)}
{history_section}

Respond with ONLY a JSON object matching this schema exactly:
{{
  "overview": "...",
  "temperature_analysis": "...",
  "heart_rate_analysis": "...",
  "spo2_analysis": "...",
  "mobility_analysis": "...",
  "recommendations": ["...", "..."],
  "health_messages": ["...", "..."],
  "critical_events": [],
  "has_critical": false
}}"""

    raw = invoke_with_fallback(prompt, temperature=0.1, max_tokens=600)

    try:
        data = json.loads(raw)
        return HealthReport(**data)
    except (json.JSONDecodeError, ValidationError):
        # Retry once with an explicit repair prompt, then return a minimal fallback
        return retry_or_fallback(prompt, raw)
```

### 6.4 Wall-Clock Scheduler

Fixes H5 (first report delayed a full interval after every restart).

```python
def run_report_scheduler():
    while True:
        now = datetime.utcnow()
        # Next 6-hour boundary: 00:00, 06:00, 12:00, 18:00 UTC
        next_run = next_boundary(now, interval_hours=6)
        wait_secs = (next_run - now).total_seconds()
        logger.info(f"Next report at {next_run.isoformat()}, sleeping {wait_secs:.0f}s")
        time.sleep(wait_secs)

        try:
            run_all_user_reports()
        except Exception as e:
            logger.exception("Report cycle failed", exc_info=e)

def next_boundary(now: datetime, interval_hours: int) -> datetime:
    """Returns the next wall-clock boundary after `now`."""
    today = now.replace(minute=0, second=0, microsecond=0)
    for h in range(0, 24, interval_hours):
        boundary = today.replace(hour=h)
        if boundary > now:
            return boundary
    # Past last boundary today → first boundary tomorrow
    return (today + timedelta(days=1)).replace(hour=0)
```

### 6.5 Idempotency

To prevent duplicate reports on restart:

```python
def run_all_user_reports():
    window_start = last_boundary(interval_hours=6)
    window_end   = datetime.utcnow()

    rows = fetch_vitals_window(window_start, window_end)  # grouped by userId
    for user_id, logs in group_by_user(rows):
        # Check if report for this user+window already exists
        exists = conn.execute(
            "SELECT 1 FROM summary_history "
            "WHERE user_id = %s AND window_start = %s",
            (user_id, window_start)
        ).fetchone()
        if exists:
            continue

        report = generate_report(user_id, logs)
        summary_id = save_report(user_id, report, window_start)
        rag_agent.index_summary(user_id, summary_id, report.model_dump_json())
```

---

## 7. Shared Infrastructure

### 7.1 `invoke_with_fallback` — Single LLM Call Point

All three agents (when they need an LLM) call this one function.

```python
def invoke_with_fallback(
    prompt: str,
    temperature: float = 0.1,
    max_tokens: int = 600,
    timeout: int = 30,
) -> str:
    """
    Tries each available LLM in priority order.
    Raises RuntimeError if all providers fail.
    """
    errors = []
    for name, llm in get_available_llms():
        if is_in_circuit_breaker_cooldown(name):
            continue
        try:
            response = llm.invoke(
                prompt,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout,
            )
            reset_circuit_breaker(name)
            return response.content
        except Exception as e:
            logger.warning(f"LLM {name} failed: {e}")
            trip_circuit_breaker(name, cooldown_seconds=120)
            errors.append(f"{name}: {e}")

    raise RuntimeError(f"All LLM providers failed: {'; '.join(errors)}")
```

**Temperature is always passed explicitly** — never left at provider default.
For medical reports: `temperature=0.1`. For health messages: `temperature=0.2`.
For prescription QA: `temperature=0.0`.

### 7.2 LLM Provider Priority (updated models)

| Priority | Provider | Model | Env Key |
|----------|----------|-------|---------|
| 1 | Gemini | `gemini-2.0-flash` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| 2 | Claude | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` |
| 3 | OpenAI | `gpt-4o-mini` | `OPENAI_API_KEY` |
| 4 | Grok | `grok-3-fast` | `GROK_API_KEY` |

> Changed from old system: Gemini first (free tier generous, fast), modern model
> IDs, Claude Haiku over Opus (50x cheaper, adequate for this task), GPT-4o-mini
> over GPT-3.5. All model IDs configurable via env.

### 7.3 Circuit Breaker

```python
# Per-provider: {name: cooldown_expires_at}
_circuit_breaker: dict[str, float] = {}

def trip_circuit_breaker(name: str, cooldown_seconds: int = 120):
    _circuit_breaker[name] = time.time() + cooldown_seconds

def is_in_circuit_breaker_cooldown(name: str) -> bool:
    expires = _circuit_breaker.get(name, 0)
    return time.time() < expires

def reset_circuit_breaker(name: str):
    _circuit_breaker.pop(name, None)
```

---

## 8. Database Schema Changes

### 8.1 Add heartRate and spo2 to vital_sign

```sql
-- Migration: add missing sensor fields
ALTER TABLE vital_sign
    ADD COLUMN IF NOT EXISTS heart_rate    INTEGER,
    ADD COLUMN IF NOT EXISTS spo2          INTEGER;
```

TypeORM entity update (`apps/health-service/src/vital-sign.entity.ts`):
```typescript
@Column({ type: 'int', nullable: true })
heartRate: number | null;

@Column({ type: 'int', nullable: true })
spo2: number | null;
```

### 8.2 monitor_state (durable cursor for Agent 1)

```sql
CREATE TABLE IF NOT EXISTS monitor_state (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    last_timestamp  BIGINT NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### 8.3 embedding_config (embedding model lock)

```sql
CREATE TABLE IF NOT EXISTS embedding_config (
    id       INTEGER PRIMARY KEY DEFAULT 1,
    model_id TEXT NOT NULL,
    dim      INTEGER NOT NULL,
    set_at   TIMESTAMPTZ DEFAULT NOW()
);
```

### 8.4 embeddings (pgvector store, replaces chroma_db/)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS embeddings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     INTEGER NOT NULL,
    doc_type    TEXT NOT NULL CHECK (doc_type IN ('prescription', 'summary')),
    doc_id      TEXT NOT NULL,
    chunk_idx   INTEGER NOT NULL,
    chunk_text  TEXT NOT NULL,
    embedding   VECTOR(768),
    model_id    TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON embeddings (user_id, doc_type);
CREATE INDEX ON embeddings (user_id, doc_id);
```

### 8.5 summary_history changes

```sql
-- Add window tracking for idempotency
ALTER TABLE summary_history
    ADD COLUMN IF NOT EXISTS window_start  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS report_type   TEXT DEFAULT 'on_demand'
                                           CHECK (report_type IN ('on_demand', 'scheduled'));

CREATE UNIQUE INDEX ON summary_history (user_id, window_start)
    WHERE window_start IS NOT NULL;
```

---

## 9. Updated Proto Contract

```protobuf
syntax = "proto3";
package summary;

service SummaryService {
  rpc AnalyzeData          (AnalyzeDataRequest)          returns (AnalyzeDataResponse);
  rpc UploadPrescription   (UploadPrescriptionRequest)   returns (UploadPrescriptionResponse);
  rpc QueryPrescription    (QueryPrescriptionRequest)    returns (QueryPrescriptionResponse);
}

message AnalyzeDataRequest {
  string data_json = 1;
  string format    = 2;  // always "json" in new system
}

message AnalyzeDataResponse {
  string report_json       = 1;  // JSON-serialized HealthReport schema
  bool   has_critical      = 2;
  string overview          = 3;  // quick access for mobile notifications
  repeated string recommendations = 4;  // real data now, not a constant
}

message UploadPrescriptionRequest {
  int32  user_id   = 1;
  bytes  file_data = 2;
  string file_name = 3;
}

message UploadPrescriptionResponse {
  bool   success = 1;
  string message = 2;
  string doc_id  = 3;  // hash for reference/delete
}

message QueryPrescriptionRequest {
  int32  user_id  = 1;
  string question = 2;
}

message QueryPrescriptionResponse {
  bool   success = 1;
  string answer  = 2;
}
```

---

## 10. File Structure

```
apps/ai-summary-service/src/
├── main.py                      # gRPC server + thread startup
├── core/
│   ├── safety_guard.py          # Agent 1: real-time threshold + DB writes
│   ├── rag_agent.py             # Agent 2: pgvector upload/query/index
│   ├── report_agent.py          # Agent 3: structured report generation
│   ├── llm_provider.py          # updated: circuit breaker, new models, low temp
│   ├── schemas.py               # Pydantic: HealthReport, AlertRecord
│   └── utils.py                 # prepare_logs(), invoke_with_fallback(), etc.
├── migrations/
│   ├── 001_add_heartrate_spo2.sql
│   ├── 002_add_monitor_state.sql
│   ├── 003_add_pgvector.sql
│   └── 004_update_summary_history.sql
├── generated/
│   ├── health_pb2.py
│   └── health_pb2_grpc.py
└── pyproject.toml               # all deps pinned, no flask
```

---

## 11. Updated `pyproject.toml`

```toml
[project]
name = "ai-summary-service"
version = "2.0.0"
requires-python = ">=3.11"

dependencies = [
    "grpcio==1.68.*",
    "grpcio-tools==1.68.*",
    "protobuf==5.*",
    "python-dotenv==1.*",
    "psycopg2-binary==2.9.*",
    "pypdf==4.*",                         # replaces deprecated PyPDF2
    "pgvector==0.3.*",                    # psycopg2 vector type adapter
    "langchain==0.3.*",
    "langchain-core==0.3.*",
    "langchain-openai==0.2.*",
    "langchain-google-genai==2.*",
    "langchain-anthropic==0.3.*",
    "langchain-community==0.3.*",
    "langchain-text-splitters==0.3.*",
    "pydantic==2.*",
    "requests==2.*",                      # for notify_gateway() HTTP call
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

> `chromadb`, `langchain-chroma`, `sentence-transformers`, `flask`, `flask-cors`,
> `scikit-learn`, `pandas` are all removed. `pypdf` replaces deprecated `PyPDF2`.
> Embedding is handled by the langchain Google/OpenAI clients directly.

---

## 12. Environment Variables

```bash
# ── LLM Providers (at least one required) ──────────────────────────
GEMINI_API_KEY=AIza...              # preferred
GEMINI_MODEL=gemini-2.0-flash       # override model
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-haiku-4-5-20251001
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
GROK_API_KEY=...
GROK_MODEL=grok-3-fast

# ── Embedding (explicit, never auto-detected) ───────────────────────
EMBEDDING_PROVIDER=gemini           # 'gemini' | 'openai'
EMBEDDING_MODEL=models/text-embedding-004
EMBEDDING_DIM=768

# ── Database ────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@host:5432/db

# ── Safety Guard (Agent 1) ──────────────────────────────────────────
POLL_INTERVAL_SECONDS=10
LOOKBACK_SECONDS=300                # on startup, catch last 5 min

# Alert thresholds (all optional, these are defaults)
SPO2_LOW=92
HR_HIGH=120
HR_LOW=45
TEMP_FEVER=38.0
TEMP_LOW=35.5
MOISTURE_HIGH=80
MOISTURE_LOW=15

# Gateway notify endpoint (Agent 1 → NestJS WebSocket delivery)
GATEWAY_INTERNAL_URL=http://localhost:3000

# ── Report Agent (Agent 3) ──────────────────────────────────────────
REPORT_INTERVAL_HOURS=6
MAX_LOGS_PER_REPORT=200

# ── gRPC ────────────────────────────────────────────────────────────
SUMMARY_GRPC_PORT=50053
SUMMARY_GRPC_MAX_MESSAGE_MB=20
```

---

## 13. API Gateway Changes (NestJS)

### 13.1 Internal Alert Notify Endpoint

Agent 1 (Python) calls this when writing a new alert. The gateway pushes via WebSocket.

```typescript
// apps/api-gateway/src/alerts/alerts.controller.ts  (add route)
@Post('internal/alert-ready')
@UseGuards(InternalServiceGuard)   // validates X-Internal-Token header
async alertReady(@Body() body: { deviceId: string }) {
  await this.alertsService.pushLatestAlert(body.deviceId);
}
```

### 13.2 AnalyzeData Response Handling

The new response is JSON, not markdown. Parse and store accordingly.

```typescript
// summary.controller.ts  — updated
const grpcResponse = await this.summaryService.analyzeData({
  data_json: JSON.stringify(sampledLogs),
  format: 'json',
});

const report = JSON.parse(grpcResponse.reportJson);  // HealthReport

await this.summaryHistoryRepo.save({
  userId,
  summary: grpcResponse.reportJson,        // full structured JSON
  recommendations: report.recommendations.join('\n'),  // now real data
  hasCritical: grpcResponse.hasCritical,
});
```

### 13.3 Downsampling (apply shared logic)

The TypeScript downsampler must match the Python one exactly — both must retain
critical events before sampling normal rows.

```typescript
// apps/api-gateway/src/summary/log-sampler.ts
export function prepareLogs(logs: VitalLog[], maxLogs = 200): VitalLog[] {
  const critical = logs.filter(isCritical);
  const normal   = logs.filter(l => !isCritical(l));
  const budget   = maxLogs - critical.length;
  const sampled  = budget >= normal.length
    ? normal
    : normal.filter((_, i) => i % Math.ceil(normal.length / budget) === 0);
  return [...critical, ...sampled].sort((a, b) =>
    Number(a.timestamp) - Number(b.timestamp)
  );
}

function isCritical(log: VitalLog): boolean {
  return (
    log.sos === true ||
    log.fallAlert === true ||
    (log.spo2 !== null && log.spo2 < 92) ||
    (log.heartRate !== null && (log.heartRate > 120 || log.heartRate < 45)) ||
    (log.temperature !== null && (log.temperature > 38.0 || log.temperature < 35.5))
  );
}
```

---

## 14. Implementation Order

Execute strictly in this order. Each phase is independently deployable.

### Phase 1 — Foundation (unblocks everything else)

1. Run migrations 001–004 (add heartRate/spo2, monitor_state, pgvector, summary changes)
2. Update `vital-sign.entity.ts` with heartRate/spo2 columns
3. Update `pyproject.toml` — remove dead deps, pin all versions, remove committed `venv/`
4. Create `schemas.py` with `HealthReport` Pydantic model
5. Create `utils.py` with `prepare_logs()` and `invoke_with_fallback()`
6. Update `llm_provider.py`: new models, circuit breaker, `temperature` param

**Verify:** `python -c "from core.utils import prepare_logs, invoke_with_fallback"` passes on clean install.

### Phase 2 — Agent 1 (Safety Guard)

7. Implement `safety_guard.py` with durable cursor and `monitor_state` table
8. Implement threshold checks with configurable env vars
9. Implement cooldown/hysteresis state
10. Wire alert writes to `alerts` table (direct psycopg2 INSERT)
11. Add `POST /internal/alert-ready` to NestJS `alerts.controller.ts`
12. Implement `notify_gateway()` in `safety_guard.py`
13. Start `safety-guard` thread in `main.py`

**Verify:** Write a vital_sign row with `sos=true` → alert appears in `alerts` table within 15s → WebSocket client receives push.

### Phase 3 — Agent 2 (RAG)

14. Enable pgvector extension in Postgres
15. Run migration 003 (embeddings table + config)
16. Implement `rag_agent.py`: `upload_prescription`, `query_prescription`, `index_summary`, `get_historical_context`
17. Implement `validate_embedding_config()` startup check
18. Update `main.py` gRPC handlers to call new `rag_agent.py` functions
19. Update `UploadPrescriptionResponse` proto to include `doc_id`

**Verify:** Upload a PDF → query it → get a grounded answer; upload same PDF again → old chunks replaced, not doubled; change `EMBEDDING_MODEL` env → service refuses to start with clear error.

### Phase 4 — Agent 3 (Report)

20. Implement `report_agent.py`: `generate_report()`, `run_all_user_reports()`, `run_report_scheduler()`
21. Apply `prepare_logs()` in both NestJS gateway and Python scheduler (not just one)
22. Update NestJS `summary.controller.ts` to parse JSON response and store structured data
23. Update NestJS `prepareLogs` to use `isCritical` logic
24. Start `report-scheduler` thread in `main.py`

**Verify:** Trigger `POST /summary` with a day's logs → response includes `recommendations` array with real content; include a log with `spo2=88` → it appears in `critical_events`; repeat same trigger within same day → cached response returned without LLM call.

### Phase 5 — Cleanup

25. Delete `rag_service.py` (dead FAISS code)
26. Delete `nurse_agent.py` (replaced by `safety_guard.py`)
27. Delete `health_agent.py` (replaced by `report_agent.py`)
28. Delete `db_poller.py` (replaced by `safety_guard.py`)
29. Delete `routine_reporter.py` (replaced by `report_agent.py`)
30. Remove `summary.controller.ts` legacy `SummarizeText` endpoint (unused)
31. Add `INTERNAL_SERVICE_TOKEN` guard to `/internal/alert-ready`

---

## 15. Data Flow Diagrams

### Real-Time Alert Flow (Agent 1)

```
vital_sign table (new row inserted by sync)
  │
  ▼  [every 10s poll]
safety_guard.py
  ├─ fetch_new_vitals(cursor)
  ├─ check_thresholds(row)  ─────────────────► no alert → update cursor
  │       ↓ alert found
  ├─ is_in_cooldown? ──────────────────────── yes → skip
  │       ↓ not in cooldown
  ├─ write_alert(conn, row, alert)
  │       ↓
  │   INSERT INTO alerts (...)
  ├─ notify_gateway(deviceId)
  │       ↓ HTTP POST /internal/alert-ready
  │   api-gateway → RealtimeGateway.emitToUser()
  │       ↓ WebSocket
  │   Mobile/web client receives push notification
  └─ set_cooldown(userId, alert_type)
```

### Prescription QA Flow (Agent 2)

```
Client  POST /summary/upload_prescription  (PDF file)
  │
  ▼
summary.controller.ts  →  gRPC UploadPrescription
  │
  ▼
rag_agent.upload_prescription(user_id, pdf_bytes)
  ├─ validate_embedding_config()
  ├─ delete_chunks(user_id, doc_id)           ← replaces old version
  ├─ extract_pdf_text() → chunks
  ├─ embed_batch(chunks)                      ← Gemini/OpenAI API
  └─ INSERT INTO embeddings (...)             ← pgvector, Postgres

───────────────────────────────────────────────────────

Client  POST /summary/query_prescription  { question }
  │
  ▼
rag_agent.query_prescription(user_id, question)
  ├─ embed_single(question)
  ├─ SELECT chunk_text FROM embeddings
  │  WHERE user_id=? AND doc_type='prescription'
  │  AND score > 0.60 ORDER BY score DESC LIMIT 5
  ├─ build_prompt(context, question)
  └─ invoke_with_fallback(prompt, temperature=0.0)
              ↓
         answer string → HTTP response
```

### On-Demand Report Flow (Agent 3)

```
Client  POST /summary
  │
  ▼
summary.controller.ts
  ├─ check cache (summary_history today?) ──► hit → return cached
  │       ↓ miss
  ├─ fetch logs via gRPC HealthService.getLogsByDateRange
  ├─ prepareLogs(logs, 200)              ← critical-first sampling
  └─ gRPC SummaryService.AnalyzeData(logs_json)
            │
            ▼
    report_agent.generate_report(user_id, logs)
      ├─ compute_stats_summary(logs)
      ├─ rag_agent.get_historical_context(user_id, stats)  ← pgvector search
      ├─ build_prompt(logs, history_ctx)
      ├─ invoke_with_fallback(prompt, temperature=0.1)
      ├─ HealthReport(**json.loads(response))
      └─ rag_agent.index_summary(user_id, summary_id, report)
            │
            ▼
      AnalyzeDataResponse { report_json, has_critical, overview, recommendations }
            │
            ▼
    summary.controller.ts
      ├─ save to summary_history
      └─ return to client
```

---

## 16. What This System Does NOT Do

These are out of scope for this plan and should be tracked separately:

- **mTLS between gRPC services** — gRPC is still `add_insecure_port`; securing this
  is a deployment/infrastructure concern, not a feature concern.
- **Per-patient threshold baselines** — thresholds are global env vars. Personalizing
  them requires a user-profile store which doesn't exist yet.
- **PDF encryption / retention policies** — PHI compliance is out of scope here.
- **`heartRate`/`spo2` in the sync protocol** — the new fields are added to the entity,
  but whether the IoT device sync batch actually sends them depends on the hardware
  firmware and the Raspberry Pi sync script. That is hardware-side work.

---

*End of New-RAG-Plan.md*
