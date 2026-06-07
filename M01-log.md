# M01 — RAG System & LLM Agent: Error Audit + Redesign Plan

**Date:** 2026-06-07
**Scope:** `apps/ai-summary-service/` (Python RAG + LLM agents) and the AI-related
parts of `apps/api-gateway/` and `apps/health-service/`.
**Companion doc:** [`Old-RAG-and-LLM-agent.md`](./Old-RAG-and-LLM-agent.md) (architecture reference)

This log has two parts:

- **Part A — Errors & Issues Found** (verified against source, grouped by severity)
- **Part B — Recommendations for a Proper Implementation** (concrete redesign)

All findings cite `file:line`. Every claim below was checked against the actual
code and the TypeORM entity definitions, not assumed.

---

# Part A — Errors & Issues Found

## Severity legend

| Level | Meaning |
|-------|---------|
| 🔴 **Critical** | Breaks a core feature, data loss/corruption, or deploy failure |
| 🟠 **High** | Wrong/unsafe behavior in normal operation; reliability risk |
| 🟡 **Medium** | Correctness/maintainability defect; degraded quality |
| ⚪ **Low** | Code smell, hygiene, hardening |

---

## 🔴 Critical

### C1 — `pyproject.toml` does not declare the packages the code imports
**File:** `apps/ai-summary-service/pyproject.toml:7-15`

The manifest declares only:
```
flask, flask-cors, python-dotenv, openai, langchain, langchain-openai, langchain-core
```
But the code imports (and requires) at least:
```
grpcio, grpcio-tools, protobuf, psycopg2-binary, PyPDF2,
chromadb, langchain-chroma, langchain-community, langchain-text-splitters,
langchain-google-genai, langchain-anthropic, sentence-transformers
```
**Impact:** A clean install (`uv sync` / fresh container) starts a service that
**crashes on first import** of `prescription_rag.py` (chromadb), `llm_provider.py`
(langchain-google-genai / langchain-anthropic), `db_poller.py` (psycopg2), etc.
It only "works" today because the committed `venv/` was populated manually.
Also: `flask`/`flask-cors` are listed but **never used** (the service is gRPC), and
**no versions are pinned** → non-reproducible builds. There is no lockfile in use.

---

### C2 — Switching embedding provider silently corrupts the prescription vector store
**File:** `apps/ai-summary-service/src/core/prescription_rag.py:37-63`

The embedding backend is chosen at runtime from whichever key is present
(OpenAI → Gemini → local HuggingFace). Each produces **different-dimensioned
vectors**:

| Backend | Model | Dim |
|---------|-------|-----|
| OpenAI | text-embedding-ada-002 | 1536 |
| Gemini | text-embedding-004 | 768 |
| HuggingFace | all-MiniLM-L6-v2 | 384 |

The Chroma collection `"prescriptions"` is **persisted on disk** (line 59-63) with
whatever model first wrote it. If the active provider later changes — OpenAI quota
runs out, a key is rotated, env differs between environments — then:
- queries are embedded with a different dimensionality than the stored vectors →
  **dimension-mismatch error**, or
- even at matching dims, a *different model* produces vectors in a different space →
  **silently meaningless similarity results**.

There is no stored model/dimension metadata and no validation on startup.
**Impact:** prescription QA breaks or returns garbage after any provider change,
with no error surfaced to the user.

---

### C3 — The 6-hour routine reporter sends unbounded logs to the LLM
**File:** `apps/ai-summary-service/src/core/routine_reporter.py:80-110`

The on-demand path downsamples to ≤300 logs (`summary.controller.ts:118-123`), but
the routine reporter passes **every** log for each user straight into
`generate_ai_analysis` with no cap. Six hours of high-frequency sensor data easily
exceeds the model context window.

**Impact:** For active patients the LLM call fails on every provider, so
`generate_ai_analysis` returns `"All AI Agents failed to generate..."`
(`health_agent.py:71`), and that error string is persisted into `summary_history`.
The patients who generate the most data get the worst (or no) reports.

---

### C4 — Real-time anomaly alerts are detected but never delivered
**File:** `apps/ai-summary-service/src/core/db_poller.py:64-67`

The 24/7 poller runs `analyze_real_time_vitals` on every new row and, when an
anomaly (SOS, fall, temperature, hydration) is found, only does:
```python
logger.warning(f"[NURSE ALERT] ...")
```
There is **no** write to the `alert` table (`alert.entity.ts` exists and is unused
by this path), **no** push notification, **no** WebSocket emit, **no** DB update.

**Impact:** The flagship "24/7 AI Nurse" emergency detection is a no-op
end-to-end. An SOS or fall is written to a log file nobody watches. The most
safety-critical feature in the system does not actually alert anyone.

---

## 🟠 High

### H1 — Temperature 0.7 on every provider for clinical text
**File:** `apps/ai-summary-service/src/core/llm_provider.py:24, 32, 58, 67`

All four providers are constructed with `temperature=0.7`. For a *Clinical
Decision Support System* generating medical reports and health advice, high
temperature maximizes variability and hallucination risk.
**Impact:** Inconsistent, less factual medical output. Should be ~0.0–0.2.

---

### H2 — Emergency events can be sampled out of the daily summary
**File:** `apps/api-gateway/src/summary.controller.ts:118-123`

```ts
const step = Math.ceil(plainLogs.length / MAX_LOGS);
sampledLogs = plainLogs.filter((_, index) => index % step === 0);
```
Modulo downsampling keeps evenly spaced rows. A log carrying `sos=true` or
`fallAlert=true` that lands on a non-sampled index is **dropped** before the AI
ever sees it.
**Impact:** The day's only emergency can be silently excluded from the summary.
Anomaly rows must always be retained regardless of sampling.

---

### H3 — No timeouts or retries on LLM / embedding calls
**Files:** `llm_provider.py` (no `request_timeout` / `max_retries`),
`health_agent.py:60-61`, `prescription_rag.py:130-137`

LLM clients are built with no timeout. A hung provider blocks a gRPC worker
indefinitely; the pool is only 10 workers (`main.py:105`), so sustained hangs
**exhaust the pool and stall the whole service**. There is also no retry/backoff on
transient `429`/`5xx` — a single rate-limit immediately burns the provider and
falls through to the next (or to total failure).
**Impact:** Cascading stalls under load; avoidable failures on transient errors.

---

### H4 — Poller has no durable cursor → monitoring gaps on restart
**File:** `apps/ai-summary-service/src/core/db_poller.py:37`

```python
last_processed_timestamp = int(time.time() * 1000)  # Start from now
```
The watermark is reset to "now" at every startup and held only in memory. Any
vitals inserted while the service was down (deploy, crash, OOM) are **never
analyzed** for anomalies.
**Impact:** Silent gaps in 24/7 monitoring exactly around restarts/deploys.

---

### H5 — First routine report is delayed a full interval after every restart
**File:** `apps/ai-summary-service/src/core/routine_reporter.py:60-62`

```python
while True:
    time.sleep(report_interval)   # 6h sleep BEFORE first run
    ...
```
The thread sleeps 6 hours *before* producing the first report, and the timer
resets on every restart. With frequent deploys, the 6-hour report may **never
fire**.
**Impact:** Scheduled reports unreliable; not aligned to wall-clock.

---

### H6 — PHI stored unencrypted, on a fragile/ephemeral path
**Files:** `prescription_rag.py:32, 59-63`, `routine_reporter.py:26-41`

Prescription text (PHI) is embedded into a local Chroma directory at
`os.path.join(os.getcwd(), "chroma_db")`, and full medical narratives are stored in
`summary_history`. There is:
- no encryption at rest,
- no retention/deletion policy,
- `os.getcwd()` is launch-directory-dependent and typically **ephemeral inside
  containers** → embeddings are lost on redeploy (and re-corrupted per C2).

**Impact:** Health-data compliance/privacy exposure, plus likely data loss of the
prescription store on every container redeploy.

---

## 🟡 Medium

### M1 — `HealthyMessageRAG` (FAISS) is dead code
**File:** `apps/ai-summary-service/src/core/rag_service.py` (whole module)

`generate_ai_analysis` produces the "Personalized Health Messages" inline via
prompt section 5 (`health_agent.py:41-42`). Nothing calls `HealthyMessageRAG`. The
FAISS pipeline, the singleton, and the `sentence-transformers` dependency it pulls
in are unused.
**Impact:** Confusing, divergent second code path; maintenance burden.

---

### M2 — Inconsistent provider-fallback behavior across features
**Files:** `health_agent.py:57-68` (loops all), `prescription_rag.py:128-141`
(loops all), `main.py:55-63` SummarizeText (loops all), **but**
`rag_service.py:77` uses only `available_llms[0]` (no fallback).
**Impact:** Healthy-message generation fails hard when the first provider is down,
unlike everything else. No single source of truth for "call an LLM with fallback."

---

### M3 — Two divergent "vitals" schemas; one is dead/duplicated
**Files:** `apps/health-service/src/vital-sign.entity.ts` (table `vital_sign`,
the real one) vs `apps/api-gateway/src/database/entities/vital.entity.ts`
(table `vitals`).

`vital_sign`: `userId`, `temperature`, `ambientTemp`, `moisture`, `sos`,
`fallAlert`, `gaitLabel`, `thighnodeStatus`, `timestamp bigint`.
`vitals`: `deviceId`, `temperature`, `roomTemperature`, `moisture`,
`gaitAnalysis`, `thighnodeStatus`, `timestamp timestamptz` — **no** `userId`,
`sos`, `fallAlert`; different field names.

The Python services correctly read `vital_sign`. The api-gateway `Vital`/`vitals`
entity is a conflicting, apparently legacy duplicate.
**Impact:** Schema confusion; risk of code writing to or reading from the wrong
table; `roomTemperature`/`gaitAnalysis` vs `ambientTemp`/`gaitLabel` drift.

---

### M4 — Sensor payload sent to the LLM as Python `repr`, not JSON
**File:** `apps/ai-summary-service/src/core/health_agent.py:61`

```python
response = chain.invoke({"logs": str(logs_data)})
```
The prompt states the data is "JSON format" (line 23), but `str()` of a list of
dicts yields Python `repr` — single quotes, `True`/`False`/`None`.
**Impact:** Wastes tokens, contradicts the prompt, and can confuse stricter
JSON-expecting models. Use `json.dumps`.

---

### M5 — `recommendations` is a meaningless constant
**Files:** `main.py:35` (`recommendations="Generated based on analysis."`),
`summary.controller.ts:141` (persists it), `summary.proto:19`,
`summary-history.entity.ts`.
The actual recommendations live inside the markdown `summary`. The dedicated
field/column is dead, carrying a static string everywhere.
**Impact:** Misleading schema; a column/field that promises structured data but
never delivers it.

---

### M6 — LLM cache has no invalidation and no lock
**File:** `apps/ai-summary-service/src/core/llm_provider.py:11-17, 71`

`_cached_llms` is a process-global built once and never refreshed (key rotation
requires a full restart) and is populated without a lock (first-request race
double-builds; comment dismisses it).
**Impact:** Operational rigidity + a (benign-today) race.

---

### M7 — No retrieval tuning: default k, no score threshold, no per-document scope
**File:** `apps/ai-summary-service/src/core/prescription_rag.py:109`

`as_retriever(search_kwargs={'filter': {'user_id': ...}})` uses the default k (4)
with no similarity-score threshold. Low-relevance chunks are always returned,
undermining the "say you can't find it" instruction. Retrieval is scoped per
*user* but not per *document*, so multiple uploaded prescriptions blend together.
**Impact:** Noisier context, weaker grounding, cross-prescription contamination.

---

### M8 — No update/delete lifecycle for prescriptions
**File:** `apps/ai-summary-service/src/core/prescription_rag.py:79-97`

`upload_prescription` only **adds** chunks. Re-uploading an updated prescription
appends new chunks while old ones remain, so retrieval mixes stale and current
medication info. No versioning, replace, or delete.
**Impact:** Outdated prescriptions returned as if current — a clinical-safety
concern.

---

## ⚪ Low

| ID | File:line | Issue |
|----|-----------|-------|
| L1 | `health_agent.py:7,58,62,66` | Uses `print()` instead of `logging`; bypasses log config/levels. |
| L2 | `db_poller.py:54`, `routine_reporter.py:80` | `SELECT *` — fragile to schema change, fetches unused columns. |
| L3 | `db_poller.py` | 10s polling instead of `LISTEN/NOTIFY` or a queue — latency + load. |
| L4 | `health_agent.py:82` | `list(set(alerts))` drops ordering; critical alerts may not surface first. |
| L5 | `prescription_rag.py:127,140` | `last_error` computed but unused; final message discards the real error. |
| L6 | `main.py:117-135` | No signal handling / graceful shutdown; psycopg2 pools and gRPC not drained. |
| L7 | `main.py:112` | `add_insecure_port` — no TLS/auth between gateway and AI service. |
| L8 | `nurse_agent.py:42` | `moisture < 20` with self-admitted "assuming 0-100 scale"; sensor scale unverified → false/missed hydration alerts. |
| L9 | `nurse_agent.py:30-43` | Hardcoded clinical thresholds (32/40°C, 10°C, 20); no config, no per-patient baseline, no clinical sourcing. |
| L10 | `llm_provider.py:47-57` | `SafeGemini` patches only `invoke`; `ainvoke`/`stream`/`batch` unpatched. |
| L11 | `nurse_agent.py:12,17` | Relies on Python's `True == 1` quirk to read Postgres booleans; works but fragile/implicit. |

---

## Triage summary

| Priority | IDs |
|----------|-----|
| Fix first (blocks deploy / safety) | C1, C2, C3, C4 |
| Fix next (reliability / correctness) | H1, H2, H3, H4, H5, H6 |
| Then (quality / maintainability) | M1–M8 |
| Hardening backlog | L1–L11 |

---

# Part B — Recommendations for a Proper Implementation

The goal: a reliable, reproducible, safe RAG + agent layer. Recommendations are
ordered to map onto the triage above. Concrete code sketches are illustrative.

## B1 — Fix packaging & reproducibility (addresses C1)

- Declare **every** runtime import in `pyproject.toml` with **pinned** versions,
  and commit the lockfile (`uv.lock`). Remove unused `flask`/`flask-cors`.
- Stop committing `venv/`; add it to `.gitignore`. Build from the lockfile in CI
  and in the container image.
- Add a CI job that does a clean install + `python -c "import core.main"` (or a
  smoke import of each module) so missing deps fail the build, not production.

```toml
[project]
dependencies = [
  "grpcio==1.*", "grpcio-tools==1.*", "protobuf==5.*",
  "python-dotenv==1.*", "psycopg2-binary==2.9.*", "pypdf==4.*",
  "langchain==0.3.*", "langchain-core==0.3.*",
  "langchain-openai==0.2.*", "langchain-google-genai==2.*",
  "langchain-anthropic==0.2.*", "langchain-community==0.3.*",
  "langchain-chroma==0.1.*", "chromadb==0.5.*",
  "sentence-transformers==3.*",
]
```
(Pin to versions you actually test against; the above shows the shape.)

## B2 — Make the embedding strategy explicit and safe (addresses C2, M7, M8)

- **Pin one embedding model** via a dedicated env var (`EMBEDDING_PROVIDER`,
  `EMBEDDING_MODEL`), decoupled from which *chat* keys happen to be present. Do not
  let the embedder silently change between runs.
- **Persist model + dimension in collection metadata** and validate on startup;
  if they don't match, **fail fast** with a clear error (or migrate), never serve
  mismatched vectors.
- **Consolidate the vector store onto `pgvector`** in the existing Postgres rather
  than a local Chroma directory. You already run Postgres; this removes the
  fragile `os.getcwd()/chroma_db` path (C2/H6), gives you backups, encryption at
  rest, and survives redeploys. (If staying on Chroma, set an absolute,
  volume-mounted `CHROMA_DIR` env var.)
- **Retrieval tuning:** set `k` explicitly and add a similarity-score threshold
  (`search_type="similarity_score_threshold"`), or use MMR. Tag each chunk with a
  `document_id` + `uploaded_at` so you can scope/rank by document.
- **Lifecycle:** support replace/delete. On re-upload, delete prior chunks for that
  `document_id` (or supersede older `uploaded_at`) so stale meds aren't retrieved.

## B3 — Bound and route the data into the LLM (addresses C3, H2, M4)

- Extract **one shared "prepare logs" helper** used by *both* the gateway and the
  routine reporter, so downsampling rules can't diverge again.
- **Always retain anomaly rows** (`sos`, `fallAlert`, out-of-range temp) before
  downsampling; sample only the "normal" remainder. e.g.:
  ```ts
  const critical = logs.filter(isAnomalous);
  const normal   = logs.filter(l => !isAnomalous(l));
  const sampled  = [...critical, ...downsample(normal, MAX_LOGS - critical.length)]
                     .sort(byTimestamp);
  ```
- **Token-budget** the reporter: cap rows, or aggregate (min/max/avg per window)
  instead of raw rows. Pass data with `json.dumps(...)`, not `str(...)`.

## B4 — Make alerts actually fire (addresses C4)

- In the poller, when `analyze_real_time_vitals` returns alerts:
  1. **Persist** to the `alert` table (with severity, type, userId, vital row ref).
  2. **Notify** — emit over the existing WebSocket gateway and/or push
     notification to caregivers.
  3. **Dedupe/debounce** — add hysteresis so a sustained anomaly across many rows
     produces one alert (state per user+type), not a flood.
- Preserve **severity ordering** (CRITICAL first); replace `list(set(...))` in
  `health_agent.py` with an ordered, priority-sorted dedupe.

## B5 — Harden the LLM provider layer (addresses H1, H3, M2, M6, L10)

- **Lower temperature** to 0.0–0.2 for all medical generation.
- **Set `request_timeout` and `max_retries`** on every client; add a small
  **circuit breaker** so a dead provider is skipped quickly for a cooldown window.
- **Upgrade models:** `gpt-3.5-turbo` and `claude-3-opus-20240229` are outdated for
  medical reasoning and (opus) expensive/slow. Move to current cost-appropriate
  models (e.g. a small-but-capable default with a stronger fallback). Make model
  IDs configurable per provider via env.
- **One fallback helper** (`invoke_with_fallback(prompt) -> text`) used by
  health_agent, prescription QA, summarize, *and* health-message generation —
  eliminating M2.
- **Cache with a lock** and an optional TTL/refresh so key rotation doesn't require
  a restart. Patch `ainvoke`/`stream` on `SafeGemini` if async paths are adopted.

## B6 — Fix the schedulers (addresses H4, H5)

- **Poller cursor:** persist the last-processed `timestamp` (a small
  `monitor_state` row or a max() query at startup: `SELECT max(timestamp) FROM
  vital_sign`) so restarts don't skip rows. Consider `LISTEN/NOTIFY` to replace
  polling.
- **Routine reporter:** run **then** sleep, or align to wall-clock (e.g. a cron
  expression / next-6h-boundary), and make report generation **idempotent** per
  `(userId, window)` so a restart can't duplicate or skip a window.

## B7 — Structured, safe medical output (addresses M5, H1, safety)

- Return **structured output** (Pydantic schema / tool-calling) from the report
  call: `{ overview, temperature, movement, recommendations[], health_messages[] }`.
  Then `recommendations` becomes real data instead of a constant — fix the proto
  field and DB column accordingly (or drop the column if not used).
- Add a **medical disclaimer** to generated advice and keep a **human-in-the-loop**
  posture for anything safety-critical. Validate output against the schema; on
  parse failure, retry or fall back rather than persisting an error string.

## B8 — Data model & sensor correctness (addresses M3, L8, L9)

- **Unify the vitals schema.** Make `vital_sign` (health-service) the single source
  of truth and **remove the dead `vitals` entity** in api-gateway (or merge fields
  and migrate). Document the canonical field names.
- **Verify the moisture scale** against the hardware spec and set thresholds from
  that; make all thresholds **configurable** (env/DB) and ideally **per-patient
  baselines** rather than global magic numbers.
- Read Postgres booleans as booleans (`is True` / truthiness), not `== 1`.

## B9 — Security & compliance (addresses H6, L7)

- **Encrypt PHI at rest** (DB-level encryption / encrypted volume) and define a
  **retention + deletion** policy for prescriptions and `summary_history`.
- **Secure gRPC** with TLS and service auth (mTLS or a shared token) instead of
  `add_insecure_port`.
- Add an **access/audit log** for prescription read/query operations.

## B10 — Observability, ops & tests (addresses L1, L2, L6, and overall)

- Replace `print()` with structured `logging`; add metrics (LLM latency, fallback
  counts, retrieval hit rate, alert counts) and request tracing.
- Add **graceful shutdown**: handle SIGTERM, stop accepting gRPC, drain workers,
  close psycopg2 pools.
- Expose a **readiness probe** that reflects real state: embeddings initialized,
  DB reachable, at least one LLM provider configured.
- **Tests** (none exist today):
  - unit: `nurse_agent` thresholds (each alert branch), ordered dedupe, the shared
    downsampler (anomaly retention), embedding/dim validation.
  - integration: prescription upload→query with a mocked embedder/LLM; provider
    fallback; poller cursor resumption.
  - a small **RAG eval harness** asserting answers are grounded (refuses when info
    is absent).
- Replace `SELECT *` with explicit column lists.

## B11 — Remove or re-integrate dead code (addresses M1)

Decide on `HealthyMessageRAG`: either delete it (health messages are already
produced inline) or, if a separate retrieval-grounded message is wanted, route it
through the unified fallback helper (B5) and call it from `generate_ai_analysis`.
Don't leave two divergent code paths.

---

## Suggested execution order

1. **C1** packaging + lockfile + CI smoke import (unblocks reliable deploys).
2. **C2 / B2** pin embeddings, store dim metadata, move to pgvector (stops silent
   corruption + data loss).
3. **C4 / B4** wire alerts to DB + notifications (restores the core safety feature).
4. **C3 / H2 / B3** shared bounded downsampler with anomaly retention.
5. **H1/H3/H4/H5 / B5–B6** provider hardening + scheduler fixes.
6. **M & L / B7–B11** structured output, schema unification, security, tests,
   cleanup.

---

*End of M01 log.*
