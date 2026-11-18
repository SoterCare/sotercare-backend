# AI Nurse Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AI Summary feature with an AI Nurse chatbot ("Aria") that can answer questions about the patient via multi-turn conversation.

**Architecture:** Frontend sends `POST /nurse/chat { message, sessionId? }` → NestJS api-gateway → gRPC `Chat` RPC → Python ai-summary-service, which loads session history from DB, fetches live patient vitals/alerts, retrieves prescription context via pgvector RAG, calls LLM, saves history, and returns the nurse's reply and a session_id for the next turn.

**Tech Stack:** Python (psycopg2, LangChain, pgvector), gRPC (protobuf 5.x / grpcio 1.68), NestJS (TypeScript, `@nestjs/microservices`), PostgreSQL, Redis (not used by nurse — Redis lock logic removed)

## Global Constraints

- Python service lives in `apps/ai-summary-service/src/`; never import from `venv/`
- NestJS api-gateway lives in `apps/api-gateway/src/`
- Proto lives in `libs/common/src/proto/summary.proto`; Python stubs live in `apps/ai-summary-service/src/generated/`
- gRPC keepCase loader — all proto field names in Python match their snake_case proto names exactly
- DB columns are camelCase (TypeORM convention) and must be double-quoted in raw SQL
- `synchronize: true` in dev — TypeORM auto-creates tables; Python creates its own tables via `CREATE TABLE IF NOT EXISTS`
- No new npm or pip packages — use what is already in `requirements.txt` and `package.json`

---

## File Map

### Delete
- `apps/ai-summary-service/src/core/report_agent.py` — Agent 3 (scheduled reports, no longer needed)
- `apps/ai-summary-service/src/core/schemas.py` — HealthReport/TempStats, only used by report_agent
- `apps/api-gateway/src/summary/log-sampler.ts`
- `apps/api-gateway/src/summary/summary-history.entity.ts`
- `apps/api-gateway/src/summary/summary.controller.ts`
- `apps/api-gateway/src/summary/summary.service.ts`
- `apps/api-gateway/src/summary/summary.module.ts`

### Modify
- `libs/common/src/proto/summary.proto` — remove AnalyzeData + QueryPrescription, add Chat
- `apps/ai-summary-service/src/generated/summary_pb2.py` + `summary_pb2_grpc.py` — regenerated from proto
- `apps/ai-summary-service/src/core/utils.py` — add `invoke_chat_with_fallback`, remove `is_critical` + `prepare_logs`
- `apps/ai-summary-service/src/main.py` — remove AnalyzeData/QueryPrescription/scheduler, add Chat handler, call nurse_agent.ensure_schema on startup
- `apps/api-gateway/src/api-gateway.module.ts` — swap SummaryModule → NurseModule

### Create
- `apps/ai-summary-service/src/core/nurse_agent.py` — session management, patient context, chat logic
- `apps/api-gateway/src/nurse/nurse.service.ts` — gRPC client wrapper
- `apps/api-gateway/src/nurse/nurse.controller.ts` — HTTP endpoints
- `apps/api-gateway/src/nurse/nurse.module.ts` — NestJS module

---

## Task 1: Update proto — remove old RPCs, add Chat

**Files:**
- Modify: `libs/common/src/proto/summary.proto`

**Interfaces:**
- Produces: `Chat(ChatRequest) -> ChatResponse`, `UploadPrescription(UploadPrescriptionRequest) -> UploadPrescriptionResponse`

- [ ] **Step 1: Replace summary.proto**

Replace the entire contents of `libs/common/src/proto/summary.proto` with:

```proto
syntax = "proto3";
package summary;

service SummaryService {
  rpc Chat               (ChatRequest)               returns (ChatResponse);
  rpc UploadPrescription (UploadPrescriptionRequest) returns (UploadPrescriptionResponse);
}

message ChatRequest {
  int32  user_id    = 1;
  string message    = 2;
  string session_id = 3;
}

message ChatResponse {
  string reply      = 1;
  string session_id = 2;
}

message UploadPrescriptionRequest {
  int32  user_id   = 1;
  bytes  file_data = 2;
  string file_name = 3;
}

message UploadPrescriptionResponse {
  bool   success = 1;
  string message = 2;
  string doc_id  = 3;
}
```

- [ ] **Step 2: Regenerate Python gRPC stubs**

Run from the repo root (where `libs/` lives):

```bash
cd "D:/IIT Work/!SDGP/Github/back-end"
apps/ai-summary-service/venv/Scripts/python.exe -m grpc_tools.protoc \
  -I libs/common/src/proto \
  --python_out=apps/ai-summary-service/src/generated \
  --grpc_python_out=apps/ai-summary-service/src/generated \
  libs/common/src/proto/summary.proto
```

- [ ] **Step 3: Verify stubs contain Chat**

```bash
grep -n "Chat" apps/ai-summary-service/src/generated/summary_pb2_grpc.py
```

Expected: lines referencing `Chat` method stub.

- [ ] **Step 4: Commit**

```bash
git add libs/common/src/proto/summary.proto apps/ai-summary-service/src/generated/summary_pb2.py apps/ai-summary-service/src/generated/summary_pb2_grpc.py
git commit -m "feat: replace AnalyzeData/QueryPrescription RPCs with Chat in summary proto"
```

---

## Task 2: Add invoke_chat_with_fallback to utils.py, remove dead helpers

**Files:**
- Modify: `apps/ai-summary-service/src/core/utils.py`

**Interfaces:**
- Produces: `invoke_chat_with_fallback(messages: list[dict], temperature: float, max_tokens: int) -> str`
  - `messages` is a list of `{"role": "system"|"user"|"assistant", "content": str}`
- Removes: `is_critical(log)`, `prepare_logs(logs, max_logs)`

- [ ] **Step 1: Replace utils.py**

```python
import logging
import time

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Circuit-breaker state
# ---------------------------------------------------------------------------
_circuit_breaker: dict[str, float] = {}


def trip_circuit_breaker(name: str, cooldown_seconds: int = 120) -> None:
    _circuit_breaker[name] = time.time() + cooldown_seconds


def is_in_circuit_breaker_cooldown(name: str) -> bool:
    return time.time() < _circuit_breaker.get(name, 0)


def reset_circuit_breaker(name: str) -> None:
    _circuit_breaker.pop(name, None)


# ---------------------------------------------------------------------------
# LLM invocation — single prompt string
# ---------------------------------------------------------------------------

def invoke_with_fallback(
    prompt: str,
    temperature: float = 0.1,
    max_tokens: int = 600,
    timeout: int = 30,
) -> str:
    """Invoke a single-turn prompt against available LLMs in priority order."""
    from core.llm_provider import get_available_llms  # noqa: PLC0415

    errors: list[str] = []

    for name, llm in get_available_llms(temperature=temperature, max_tokens=max_tokens):
        if is_in_circuit_breaker_cooldown(name):
            logger.debug("Skipping LLM %s — circuit breaker open", name)
            continue
        try:
            response = llm.invoke(prompt)
            reset_circuit_breaker(name)
            return response.content
        except Exception as e:  # noqa: BLE001
            logger.warning("LLM %s failed: %s", name, e)
            trip_circuit_breaker(name, 120)
            errors.append(f"{name}: {e}")

    raise RuntimeError(f"All LLM providers failed: {'; '.join(errors)}")


# ---------------------------------------------------------------------------
# LLM invocation — multi-turn chat messages
# ---------------------------------------------------------------------------

def invoke_chat_with_fallback(
    messages: list[dict],
    temperature: float = 0.3,
    max_tokens: int = 800,
) -> str:
    """Invoke a multi-turn chat against available LLMs in priority order.

    Args:
        messages: List of {"role": "system"|"user"|"assistant", "content": str}
        temperature: Sampling temperature (higher = more creative)
        max_tokens: Maximum tokens in the reply

    Returns:
        The assistant's reply string.

    Raises:
        RuntimeError: If all providers fail.
    """
    from core.llm_provider import get_available_llms  # noqa: PLC0415
    from langchain_core.messages import SystemMessage, HumanMessage, AIMessage  # noqa: PLC0415

    lc_messages = []
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role == "system":
            lc_messages.append(SystemMessage(content=content))
        elif role == "user":
            lc_messages.append(HumanMessage(content=content))
        elif role == "assistant":
            lc_messages.append(AIMessage(content=content))

    errors: list[str] = []

    for name, llm in get_available_llms(temperature=temperature, max_tokens=max_tokens):
        if is_in_circuit_breaker_cooldown(name):
            logger.debug("Skipping LLM %s — circuit breaker open", name)
            continue
        try:
            response = llm.invoke(lc_messages)
            reset_circuit_breaker(name)
            return response.content
        except Exception as e:  # noqa: BLE001
            logger.warning("LLM %s failed: %s", name, e)
            trip_circuit_breaker(name, 120)
            errors.append(f"{name}: {e}")

    raise RuntimeError(f"All LLM providers failed: {'; '.join(errors)}")
```

- [ ] **Step 2: Commit**

```bash
git add apps/ai-summary-service/src/core/utils.py
git commit -m "feat: add invoke_chat_with_fallback, remove dead prepare_logs/is_critical helpers"
```

---

## Task 3: Create nurse_agent.py

**Files:**
- Create: `apps/ai-summary-service/src/core/nurse_agent.py`

**Interfaces:**
- Consumes: `invoke_chat_with_fallback` from `core.utils`, `embed_single` from `core.rag_agent`
- Produces:
  - `ensure_schema(conn) -> None`
  - `chat(conn, user_id: int, message: str, session_id: str) -> tuple[str, str]`
    — returns `(reply, session_id)`

- [ ] **Step 1: Create nurse_agent.py**

```python
"""
AI Nurse Agent ("Aria")

Handles multi-turn chat about a patient's health. Each turn:
1. Loads or creates a chat session from the `chat_sessions` table.
2. Fetches a live patient vitals/alerts snapshot from the DB.
3. Retrieves relevant prescription chunks via pgvector similarity search.
4. Builds a system prompt with all context.
5. Calls the LLM with full conversation history (trimmed to last 10 messages).
6. Saves updated history back to DB.
7. Returns the reply and session_id.
"""
import json
import logging
import time
import uuid

import psycopg2.extras

logger = logging.getLogger(__name__)

MAX_HISTORY_MESSAGES = 20  # keep last 10 turns (user+assistant = 2 per turn)

SYSTEM_PROMPT_TEMPLATE = """\
You are Aria, an AI nurse assistant helping caregivers monitor a patient remotely.
You have access to the patient's real-time health data and prescription information below.

{patient_context}

{prescription_context}

Guidelines:
- Be warm, professional, and concise (2-4 sentences unless more detail is asked for).
- Ground every answer in the data above — never invent values.
- Flag any reading outside normal range clearly (e.g. SpO2 < 95%, HR > 100 bpm, temp > 38°C).
- For emergencies always advise contacting a doctor or calling emergency services immediately.
- If a caregiver asks about something you have no data on, say so honestly.\
"""


# ---------------------------------------------------------------------------
# Schema bootstrap
# ---------------------------------------------------------------------------

def ensure_schema(conn) -> None:
    """Create chat_sessions table if it doesn't exist (idempotent)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id          SERIAL      PRIMARY KEY,
                session_id  TEXT        NOT NULL UNIQUE,
                user_id     INTEGER     NOT NULL,
                messages    JSONB       NOT NULL DEFAULT '[]',
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_sessions_user "
            "ON chat_sessions(user_id)"
        )
    conn.commit()
    logger.info("Nurse schema ensured (chat_sessions)")


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

def _get_or_create_session(conn, user_id: int, session_id: str) -> tuple[str, list]:
    """Return (session_id, message_history).

    If session_id is empty or not found for this user, a new UUID session is
    created and an empty history returned.
    """
    if session_id:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT messages FROM chat_sessions "
                "WHERE session_id = %s AND user_id = %s",
                (session_id, user_id),
            )
            row = cur.fetchone()
        if row:
            return session_id, row["messages"] or []

    # New session
    new_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO chat_sessions (session_id, user_id, messages) "
            "VALUES (%s, %s, %s::jsonb)",
            (new_id, user_id, json.dumps([])),
        )
    conn.commit()
    return new_id, []


def _save_session(conn, session_id: str, messages: list) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE chat_sessions "
            "SET messages = %s::jsonb, updated_at = NOW() "
            "WHERE session_id = %s",
            (json.dumps(messages), session_id),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Patient context — live vitals + alerts
# ---------------------------------------------------------------------------

def _fetch_patient_context(conn, user_id: int) -> str:
    """Build a text snapshot of the patient's last 24 h vitals and recent alerts."""
    now_ms    = int(time.time() * 1000)
    since_ms  = now_ms - 86_400_000  # 24 h ago in epoch ms

    # Aggregate vitals
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*)                                              AS readings,
                    ROUND(AVG("heartRate")::numeric,  1)                 AS avg_hr,
                    MIN("heartRate")                                      AS min_hr,
                    MAX("heartRate")                                      AS max_hr,
                    ROUND(AVG(spo2)::numeric,         1)                 AS avg_spo2,
                    MIN(spo2)                                             AS min_spo2,
                    ROUND(AVG(temperature)::numeric,  1)                 AS avg_temp,
                    MIN(temperature)                                      AS min_temp,
                    MAX(temperature)                                      AS max_temp,
                    SUM(CASE WHEN sos          = true THEN 1 ELSE 0 END) AS sos_count,
                    SUM(CASE WHEN "fallAlert"  = true THEN 1 ELSE 0 END) AS fall_count
                FROM vital_sign
                WHERE "userId" = %s AND CAST(timestamp AS BIGINT) >= %s
                """,
                (user_id, since_ms),
            )
            stats = dict(cur.fetchone() or {})
    except Exception:
        logger.warning("Failed to fetch vitals for user %s", user_id)
        try:
            conn.rollback()
        except Exception:
            pass
        stats = {}

    # Recent alerts
    alert_lines: list[str] = []
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT a.title, a.timestamp
                FROM   alerts  a
                JOIN   devices d ON d.id = a."deviceId"
                WHERE  d."userId" = %s
                  AND  a.timestamp >= NOW() - INTERVAL '24 hours'
                  AND  a."isFalseAlarm" = false
                ORDER  BY a.timestamp DESC
                LIMIT  5
                """,
                (user_id,),
            )
            for title, ts in cur.fetchall():
                ts_str = ts.strftime("%H:%M") if ts else ""
                alert_lines.append(f"  - {title}" + (f" at {ts_str}" if ts_str else ""))
    except Exception:
        logger.warning("Failed to fetch alerts for user %s", user_id)
        try:
            conn.rollback()
        except Exception:
            pass

    # Build text
    readings = int(stats.get("readings") or 0)
    lines = [f"Patient vitals — last 24 h ({readings} readings):"]

    if stats.get("avg_hr") is not None:
        lines.append(
            f"  Heart rate : avg {stats['avg_hr']} bpm, "
            f"range {stats['min_hr']}–{stats['max_hr']} bpm"
        )
    if stats.get("avg_spo2") is not None:
        lines.append(
            f"  SpO2       : avg {stats['avg_spo2']}%, lowest {stats['min_spo2']}%"
        )
    if stats.get("avg_temp") is not None:
        lines.append(
            f"  Temperature: avg {stats['avg_temp']}°C, "
            f"range {stats['min_temp']}–{stats['max_temp']}°C"
        )

    sos_count  = int(stats.get("sos_count")  or 0)
    fall_count = int(stats.get("fall_count") or 0)
    if sos_count:
        lines.append(f"  !! SOS alerts triggered: {sos_count}")
    if fall_count:
        lines.append(f"  !! Fall detections: {fall_count}")

    if not readings:
        lines.append("  (No readings recorded in the last 24 h)")

    if alert_lines:
        lines.append("\nRecent alerts (last 24 h):")
        lines.extend(alert_lines)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Prescription context — pgvector RAG
# ---------------------------------------------------------------------------

def _fetch_prescription_context(conn, user_id: int, question: str) -> str:
    """Retrieve the top-3 prescription chunks most relevant to the question."""
    try:
        from pgvector.psycopg2 import register_vector   # noqa: PLC0415
        from core.rag_agent import embed_single          # noqa: PLC0415

        register_vector(conn)
        q_emb = embed_single(question)

        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT chunk_text,
                       1 - (embedding <=> %s::vector) AS score
                FROM   embeddings
                WHERE  user_id  = %s
                  AND  doc_type = 'prescription'
                  AND  1 - (embedding <=> %s::vector) > 0.45
                ORDER  BY score DESC
                LIMIT  3
                """,
                (q_emb, user_id, q_emb),
            )
            rows = cur.fetchall()

        if not rows:
            return "Prescription information: none uploaded yet."

        chunks = "\n\n".join(row["chunk_text"] for row in rows)
        return f"Prescription information (from uploaded documents):\n{chunks}"

    except Exception as exc:
        logger.warning("Prescription RAG failed for user %s: %s", user_id, exc)
        try:
            conn.rollback()
        except Exception:
            pass
        return ""


# ---------------------------------------------------------------------------
# Main chat entry-point
# ---------------------------------------------------------------------------

def chat(conn, user_id: int, message: str, session_id: str) -> tuple[str, str]:
    """Process one chat turn and return (reply, session_id).

    Args:
        conn:       Active psycopg2 connection.
        user_id:    Authenticated user id (patient owner).
        message:    The caregiver's message.
        session_id: Existing session UUID, or '' to start a new session.

    Returns:
        Tuple of (assistant_reply, session_id).
    """
    from core.utils import invoke_chat_with_fallback  # noqa: PLC0415

    session_id, history = _get_or_create_session(conn, user_id, session_id)

    patient_context      = _fetch_patient_context(conn, user_id)
    prescription_context = _fetch_prescription_context(conn, user_id, message)

    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        patient_context=patient_context,
        prescription_context=prescription_context,
    )

    # Build LLM message list: system + trimmed history + new user message
    trimmed = history[-MAX_HISTORY_MESSAGES:]
    lc_messages = [{"role": "system", "content": system_prompt}]
    lc_messages.extend(trimmed)
    lc_messages.append({"role": "user", "content": message})

    reply = invoke_chat_with_fallback(lc_messages, temperature=0.3, max_tokens=800)

    # Persist updated history (cap at MAX_HISTORY_MESSAGES)
    new_history = history + [
        {"role": "user",      "content": message},
        {"role": "assistant", "content": reply},
    ]
    _save_session(conn, session_id, new_history[-MAX_HISTORY_MESSAGES:])

    return reply, session_id
```

- [ ] **Step 2: Commit**

```bash
git add apps/ai-summary-service/src/core/nurse_agent.py
git commit -m "feat: add nurse_agent — multi-turn AI Nurse chat with vitals/alerts/RAG context"
```

---

## Task 4: Update main.py — wire Chat, remove AnalyzeData + scheduler

**Files:**
- Modify: `apps/ai-summary-service/src/main.py`

**Interfaces:**
- Consumes: `nurse_agent.ensure_schema`, `nurse_agent.chat`, `rag_agent.upload_prescription`, `rag_agent.validate_embedding_config`
- Produces: gRPC `Chat` handler, gRPC `UploadPrescription` handler

- [ ] **Step 1: Replace main.py**

```python
"""
ai-summary-service — gRPC server entry point

Starts two concurrent components:
  - safety-guard thread  (Agent 1: real-time vital-sign monitoring)
  - gRPC server          (serves Chat, UploadPrescription)
"""
import os
import sys
import signal
import logging
import threading
import psycopg2
import psycopg2.pool
import psycopg2.extras
import grpc
from concurrent import futures
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

DATABASE_URL      = os.getenv("DATABASE_URL", "")
GRPC_PORT         = int(os.getenv("SUMMARY_GRPC_PORT", "50053"))
MAX_MESSAGE_MB    = int(os.getenv("SUMMARY_GRPC_MAX_MESSAGE_MB", "20"))
MAX_MESSAGE_BYTES = MAX_MESSAGE_MB * 1024 * 1024

sys.path.insert(0, os.path.dirname(__file__))

from generated import health_pb2, health_pb2_grpc  # noqa: E402

try:
    from generated import summary_pb2, summary_pb2_grpc
    _SUMMARY_PROTO_AVAILABLE = True
except ImportError:
    logger.warning("summary_pb2 not found — run grpc_tools.protoc to generate stubs")
    _SUMMARY_PROTO_AVAILABLE = False


# ---------------------------------------------------------------------------
# gRPC service implementation
# ---------------------------------------------------------------------------

class SummaryServicer:
    """gRPC handler for Chat and UploadPrescription."""

    def __init__(self, db_pool: psycopg2.pool.SimpleConnectionPool):
        self._pool = db_pool

    def _get_conn(self):
        conn = self._pool.getconn()
        conn.set_session(autocommit=False)
        return conn

    def _put_conn(self, conn):
        try:
            self._pool.putconn(conn)
        except Exception:
            pass

    def Chat(self, request, context):
        from core.nurse_agent import chat as nurse_chat  # noqa: PLC0415

        conn = self._get_conn()
        try:
            reply, session_id = nurse_chat(
                conn,
                user_id=int(request.user_id),
                message=str(request.message),
                session_id=str(request.session_id or ""),
            )
            if _SUMMARY_PROTO_AVAILABLE:
                return summary_pb2.ChatResponse(reply=reply, session_id=session_id)
            return type("R", (), {"reply": reply, "session_id": session_id})()
        except Exception as e:
            logger.exception("Chat failed")
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            if _SUMMARY_PROTO_AVAILABLE:
                return summary_pb2.ChatResponse()
            return None
        finally:
            self._put_conn(conn)

    def UploadPrescription(self, request, context):
        from core.rag_agent import upload_prescription, validate_embedding_config  # noqa: PLC0415

        conn = self._get_conn()
        try:
            validate_embedding_config(conn)
            doc_id = upload_prescription(
                conn,
                user_id=request.user_id,
                file_bytes=bytes(request.file_data),
                file_name=request.file_name,
            )
            if _SUMMARY_PROTO_AVAILABLE:
                return summary_pb2.UploadPrescriptionResponse(
                    success=True,
                    message="Prescription uploaded successfully",
                    doc_id=doc_id,
                )
            return type("R", (), {"success": True, "message": "ok", "doc_id": doc_id})()
        except Exception as e:
            logger.exception("UploadPrescription failed")
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            if _SUMMARY_PROTO_AVAILABLE:
                return summary_pb2.UploadPrescriptionResponse(success=False, message=str(e))
            return None
        finally:
            self._put_conn(conn)


# ---------------------------------------------------------------------------
# Thread starter
# ---------------------------------------------------------------------------

def start_safety_guard():
    from core.safety_guard import run_safety_guard  # noqa: PLC0415
    logger.info("Starting safety-guard thread")
    t = threading.Thread(target=run_safety_guard, name="safety-guard", daemon=True)
    t.start()
    return t


# ---------------------------------------------------------------------------
# Startup validation
# ---------------------------------------------------------------------------

def validate_startup(conn):
    from core.rag_agent import validate_embedding_config  # noqa: PLC0415
    from core.nurse_agent import ensure_schema            # noqa: PLC0415

    ensure_schema(conn)

    try:
        validate_embedding_config(conn)
        logger.info("Embedding config validated")
    except Exception as e:
        logger.warning("Embedding validation skipped (pgvector may be unavailable): %s", e)
        try:
            conn.rollback()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not DATABASE_URL:
        logger.error("DATABASE_URL is not set")
        sys.exit(1)

    try:
        pool = psycopg2.pool.SimpleConnectionPool(1, 5, DATABASE_URL)
    except Exception as e:
        logger.error("Failed to create DB connection pool: %s", e)
        sys.exit(1)

    conn = pool.getconn()
    try:
        validate_startup(conn)
    finally:
        pool.putconn(conn)

    start_safety_guard()

    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=10),
        options=[
            ("grpc.max_receive_message_length", MAX_MESSAGE_BYTES),
            ("grpc.max_send_message_length",    MAX_MESSAGE_BYTES),
        ],
    )

    servicer = SummaryServicer(db_pool=pool)

    if _SUMMARY_PROTO_AVAILABLE:
        summary_pb2_grpc.add_SummaryServiceServicer_to_server(servicer, server)
    else:
        logger.warning("Summary proto stubs not compiled — gRPC endpoints unavailable")

    server.add_insecure_port(f"[::]:{GRPC_PORT}")
    server.start()
    logger.info("gRPC server listening on port %d", GRPC_PORT)

    def _shutdown(signum, frame):
        logger.info("Shutting down (signal %d)...", signum)
        server.stop(grace=5)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT,  _shutdown)

    server.wait_for_termination()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Commit**

```bash
git add apps/ai-summary-service/src/main.py
git commit -m "feat: wire Chat gRPC handler, remove AnalyzeData/QueryPrescription/scheduler from main.py"
```

---

## Task 5: Delete old Python files

**Files:**
- Delete: `apps/ai-summary-service/src/core/report_agent.py`
- Delete: `apps/ai-summary-service/src/core/schemas.py`

- [ ] **Step 1: Delete files**

```bash
rm apps/ai-summary-service/src/core/report_agent.py
rm apps/ai-summary-service/src/core/schemas.py
```

- [ ] **Step 2: Commit**

```bash
git add -u apps/ai-summary-service/src/core/report_agent.py apps/ai-summary-service/src/core/schemas.py
git commit -m "chore: remove report_agent and schemas (replaced by nurse_agent)"
```

---

## Task 6: Create NestJS nurse module

**Files:**
- Create: `apps/api-gateway/src/nurse/nurse.service.ts`
- Create: `apps/api-gateway/src/nurse/nurse.controller.ts`
- Create: `apps/api-gateway/src/nurse/nurse.module.ts`

**Interfaces:**
- Produces:
  - `POST /nurse/chat` → `{ reply: string, sessionId: string }`
  - `POST /nurse/upload-prescription` (multipart/form-data `file`) → `{ success, message, docId }`

- [ ] **Step 1: Create nurse.service.ts**

```typescript
import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom, Observable, timeout } from 'rxjs';

interface NurseGrpcService {
  chat(data: {
    user_id: number;
    message: string;
    session_id: string;
  }): Observable<{ reply: string; session_id: string }>;
  uploadPrescription(data: {
    user_id: number;
    file_data: Buffer;
    file_name: string;
  }): Observable<{ success: boolean; message: string; doc_id: string }>;
}

const AI_GRPC_TIMEOUT_MS = 60_000;

@Injectable()
export class NurseService implements OnModuleInit {
  private readonly logger = new Logger(NurseService.name);
  private nurseGrpc: NurseGrpcService;

  constructor(@Inject('SUMMARY_SERVICE') private client: ClientGrpc) {}

  onModuleInit() {
    this.nurseGrpc = this.client.getService<NurseGrpcService>('SummaryService');
  }

  async chat(userId: number, message: string, sessionId: string): Promise<{ reply: string; session_id: string }> {
    this.logger.log(`[chat] userId=${userId} sessionId=${sessionId || 'new'}`);
    return lastValueFrom(
      this.nurseGrpc
        .chat({ user_id: userId, message, session_id: sessionId })
        .pipe(timeout(AI_GRPC_TIMEOUT_MS)),
    );
  }

  async uploadPrescription(
    userId: number,
    fileData: Buffer,
    fileName: string,
  ): Promise<{ success: boolean; message: string; doc_id: string }> {
    return lastValueFrom(
      this.nurseGrpc
        .uploadPrescription({ user_id: userId, file_data: fileData, file_name: fileName })
        .pipe(timeout(AI_GRPC_TIMEOUT_MS)),
    );
  }
}
```

Save to: `apps/api-gateway/src/nurse/nurse.service.ts`

- [ ] **Step 2: Create nurse.controller.ts**

```typescript
import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NurseService } from './nurse.service';

@Controller('nurse')
@UseGuards(JwtAuthGuard)
export class NurseController {
  private readonly logger = new Logger(NurseController.name);

  constructor(private readonly nurseService: NurseService) {}

  @Post('chat')
  async chat(
    @Body() body: { message: string; sessionId?: string },
    @Req() req: any,
  ) {
    if (!body.message?.trim()) {
      throw new BadRequestException('message is required');
    }
    const userId: number = req.user.userId;
    const result = await this.nurseService.chat(
      userId,
      body.message.trim(),
      body.sessionId ?? '',
    );
    return {
      reply: result.reply,
      sessionId: result.session_id,
    };
  }

  @Post('upload-prescription')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPrescription(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const userId: number = req.user.userId;
    const result = await this.nurseService.uploadPrescription(
      userId,
      file.buffer,
      file.originalname,
    );
    return {
      success: result.success,
      message: result.message,
      docId: result.doc_id,
    };
  }
}
```

Save to: `apps/api-gateway/src/nurse/nurse.controller.ts`

- [ ] **Step 3: Create nurse.module.ts**

```typescript
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import * as grpc from '@grpc/grpc-js';
import { NurseController } from './nurse.controller';
import { NurseService } from './nurse.service';

const grpcUrl = process.env.SUMMARY_GRPC_URL || 'localhost:50053';
const isRemote = !grpcUrl.startsWith('localhost') && !grpcUrl.startsWith('127.');
const credentials = isRemote
  ? grpc.credentials.createSsl()
  : grpc.credentials.createInsecure();

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'SUMMARY_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: grpcUrl,
          package: 'summary',
          protoPath: join(
            __dirname,
            '../../../../libs/common/src/proto/summary.proto',
          ),
          loader: { keepCase: true, defaults: true, json: true, arrays: true },
          credentials,
        },
      },
    ]),
  ],
  controllers: [NurseController],
  providers: [NurseService],
})
export class NurseModule {}
```

Save to: `apps/api-gateway/src/nurse/nurse.module.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/api-gateway/src/nurse/
git commit -m "feat: add NurseModule with POST /nurse/chat and POST /nurse/upload-prescription"
```

---

## Task 7: Swap SummaryModule → NurseModule in api-gateway.module.ts

**Files:**
- Modify: `apps/api-gateway/src/api-gateway.module.ts`

- [ ] **Step 1: Update imports and module array in api-gateway.module.ts**

Replace the two lines:
```typescript
import { SummaryModule } from './summary/summary.module';
```
and `SummaryModule,` in the `imports` array

with:
```typescript
import { NurseModule } from './nurse/nurse.module';
```
and `NurseModule,` in the imports array.

The complete diff is:
- Line 23: `import { SummaryModule } from './summary/summary.module';` → `import { NurseModule } from './nurse/nurse.module';`
- In `imports` array: `SummaryModule,` → `NurseModule,`

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "D:/IIT Work/!SDGP/Github/back-end"
npx tsc --project apps/api-gateway/tsconfig.app.json --noEmit
```

Expected: no errors (or only pre-existing errors unrelated to nurse module)

- [ ] **Step 3: Commit**

```bash
git add apps/api-gateway/src/api-gateway.module.ts
git commit -m "feat: replace SummaryModule with NurseModule in api-gateway"
```

---

## Task 8: Delete old NestJS summary files

**Files:**
- Delete: `apps/api-gateway/src/summary/log-sampler.ts`
- Delete: `apps/api-gateway/src/summary/summary-history.entity.ts`
- Delete: `apps/api-gateway/src/summary/summary.controller.ts`
- Delete: `apps/api-gateway/src/summary/summary.service.ts`
- Delete: `apps/api-gateway/src/summary/summary.module.ts`

Note: the `summary_history` Postgres table is left intact (data may be useful); we just stop managing it from NestJS.

- [ ] **Step 1: Delete files**

```bash
rm apps/api-gateway/src/summary/log-sampler.ts
rm apps/api-gateway/src/summary/summary-history.entity.ts
rm apps/api-gateway/src/summary/summary.controller.ts
rm apps/api-gateway/src/summary/summary.service.ts
rm apps/api-gateway/src/summary/summary.module.ts
rmdir apps/api-gateway/src/summary
```

- [ ] **Step 2: Verify TypeScript compiles after deletion**

```bash
npx tsc --project apps/api-gateway/tsconfig.app.json --noEmit
```

Expected: no errors about missing summary imports.

- [ ] **Step 3: Commit**

```bash
git add -u apps/api-gateway/src/summary/
git commit -m "chore: remove summary module (replaced by nurse module)"
```

---

## Spec Coverage Check

| Requirement | Task |
|---|---|
| Remove AI Summary generation endpoint | Tasks 4, 7, 8 |
| Remove scheduled report agent | Task 4, 5 |
| Add multi-turn chat endpoint `POST /nurse/chat` | Tasks 6, 7 |
| Chat includes live patient vitals context | Task 3 (nurse_agent._fetch_patient_context) |
| Chat includes prescription RAG context | Task 3 (nurse_agent._fetch_prescription_context) |
| Chat includes recent alerts | Task 3 (nurse_agent._fetch_patient_context) |
| Session persistence across turns | Task 3 (chat_sessions table) |
| Prescription upload still works at new path | Tasks 6, 1 |
| Safety Guard (Agent 1) unchanged | Task 4 (still started) |
| Proto updated for Chat RPC | Task 1 |
| Python stubs regenerated | Task 1 |

---

## Frontend Prompt

After the backend is complete, paste this to the frontend Claude Code session:

---

**Frontend Claude Code Prompt:**

```
We replaced the AI Summary feature with an AI Nurse chatbot called "Aria". 
Here's what changed on the backend:

REMOVED:
- POST /summary  (generate summary)
- POST /summary/query-prescription
- GET  /summary/usage

KEPT (new path):
- POST /nurse/upload-prescription  (multipart form-data, field name "file")
  Response: { success: boolean, message: string, docId: string }

NEW:
- POST /nurse/chat
  Request body:  { message: string, sessionId?: string }
  Response body: { reply: string, sessionId: string }
  - First call: omit sessionId (or send ""), get back a sessionId
  - Every subsequent call: send the sessionId back to continue the conversation
  - All calls require JWT Bearer token in Authorization header

The nurse ("Aria") already has access to the patient's vitals and prescriptions server-side — 
the frontend does NOT need to send any health data, just the text message.

WHAT TO BUILD:
Replace the AI Summary screen with an AI Nurse chat screen:

1. Chat UI — standard chat bubble layout:
   - Nurse messages on the left (avatar: nurse icon or "A" circle)
   - Caregiver messages on the right
   - Input bar at the bottom with Send button
   - Auto-scroll to latest message

2. Session management:
   - Store sessionId in component state (not localStorage — a new session is fine on app restart)
   - First message: POST /nurse/chat with no sessionId, then save the returned sessionId
   - All subsequent messages: include the saved sessionId

3. Welcome state:
   - When no messages yet, show: "Hi, I'm Aria, your AI nurse. Ask me anything about the patient."
   - Suggested starter questions (tappable chips):
     * "How is the patient doing today?"
     * "Any alerts in the last 24 hours?"
     * "What medications are they on?"

4. Loading state:
   - Show a typing indicator (three dots animation) while waiting for the reply

5. Error handling:
   - If the request fails, show an inline error message with a Retry button

6. Prescription upload:
   - Keep the existing prescription upload UI (just update the endpoint from 
     /summary/upload-prescription to /nurse/upload-prescription)

The JWT token is already handled by your existing auth interceptor/service — 
no changes needed there.
```

---
