# Old RAG Removal Log

**Date:** 2026-06-07
**Performed by:** Claude Code (automated cleanup)
**Reason:** Full removal of the old RAG/LLM implementation to allow a clean
re-implementation. Every file deleted or modified is preserved verbatim here.

See [`M01-log.md`](./M01-log.md) for the full error audit that motivated this removal.
See [`Old-RAG-and-LLM-agent.md`](./Old-RAG-and-LLM-agent.md) for the original architecture reference.

---

## Summary of Changes

### Files Deleted

| File | Type | Reason |
|------|------|--------|
| `apps/ai-summary-service/src/core/prescription_rag.py` | Python | ChromaDB RAG pipeline |
| `apps/ai-summary-service/src/core/rag_service.py` | Python | FAISS RAG pipeline (also dead code) |
| `apps/ai-summary-service/src/core/llm_provider.py` | Python | Multi-provider LLM factory |
| `apps/ai-summary-service/src/core/health_agent.py` | Python | LLM report generator |
| `apps/ai-summary-service/src/core/nurse_agent.py` | Python | Threshold anomaly detector |
| `apps/ai-summary-service/src/core/db_poller.py` | Python | 24/7 DB polling thread |
| `apps/ai-summary-service/src/core/routine_reporter.py` | Python | 6-hour scheduled reporter |
| `apps/ai-summary-service/src/main.py` | Python | gRPC entry point for AI service |
| `apps/ai-summary-service/src/generated/summary_pb2.py` | Python (generated) | Summary gRPC stubs |
| `apps/ai-summary-service/src/generated/summary_pb2_grpc.py` | Python (generated) | Summary gRPC service stubs |
| `apps/api-gateway/src/summary.controller.ts` | TypeScript | REST endpoints for summary/RAG |
| `apps/api-gateway/src/database/entities/summary-history.entity.ts` | TypeScript | DB entity for AI report storage |
| `libs/common/src/proto/summary.proto` | Protobuf | gRPC contract for AI summary service |

### Files Modified

| File | Change |
|------|--------|
| `apps/api-gateway/src/api-gateway.module.ts` | Removed `SummaryController`, `SUMMARY_SERVICE` gRPC client, `SummaryHistory` entity |
| `apps/api-gateway/src/database/entities/index.ts` | Removed `summary-history.entity` export |
| `apps/api-gateway/src/reports.controller.ts` | Removed AI analysis call (`SummaryService`); export endpoint now returns logs only |

### Files Kept (not RAG/LLM specific)

| File | Reason kept |
|------|-------------|
| `apps/ai-summary-service/src/generated/health_pb2.py` | Health service gRPC stubs — needed by future AI service |
| `apps/ai-summary-service/src/generated/health_pb2_grpc.py` | Health service gRPC stubs — needed by future AI service |
| `apps/ai-summary-service/pyproject.toml` | Scaffold kept; will be rewritten for new service |

---

## Preserved File Contents

### 1. `apps/ai-summary-service/src/core/prescription_rag.py`

```python
import os
import logging
from pathlib import Path
from dotenv import load_dotenv
from PyPDF2 import PdfReader
from langchain_openai import OpenAIEmbeddings
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_chroma import Chroma
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnablePassthrough
from core.llm_provider import get_available_llms

logger = logging.getLogger(__name__)


def _ensure_env_loaded() -> None:
    candidates = [
        Path.cwd() / ".env",
        Path(__file__).resolve().parents[2] / ".env",
        Path(__file__).resolve().parents[4] / ".env",
    ]
    for env_path in candidates:
        if env_path.exists():
            load_dotenv(dotenv_path=env_path, override=True)

class PrescriptionRAG:
    def __init__(self):
        _ensure_env_loaded()
        self.openai_key = (os.getenv("OPENAI_API_KEY") or "").strip()
        self.gemini_key = (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip()
        self.persist_directory = os.path.join(os.getcwd(), "chroma_db")

        self.embeddings = None
        self.vectorstore = None

        try:
            if self.openai_key:
                self.embeddings = OpenAIEmbeddings(model="text-embedding-ada-002", api_key=self.openai_key)
                logger.info("Prescription RAG embeddings: OpenAI")
            elif self.gemini_key:
                from langchain_google_genai import GoogleGenerativeAIEmbeddings
                self.embeddings = GoogleGenerativeAIEmbeddings(
                    model="models/text-embedding-004", google_api_key=self.gemini_key
                )
                logger.info("Prescription RAG embeddings: Gemini (text-embedding-004)")
            else:
                try:
                    self.embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
                    logger.info("Prescription RAG embeddings: local HuggingFace (no cloud key set)")
                except ImportError:
                    logger.info("Prescription RAG: no embedding backend available. Local RAG disabled.")
                    return

            self.vectorstore = Chroma(
                collection_name="prescriptions",
                embedding_function=self.embeddings,
                persist_directory=self.persist_directory
            )
            logger.info(f"Initialized Local ChromaDB at {self.persist_directory}")
        except Exception as e:
            logger.warning(f"Prescription RAG initialization failed: {e}")

    def extract_text_from_pdf(self, file_path_or_bytes):
        """Extracts text from a loaded PDF file."""
        text = ""
        try:
            reader = PdfReader(file_path_or_bytes)
            for page in reader.pages:
                text += page.extract_text() + "\n"
        except Exception as e:
            logger.error(f"Failed to read PDF: {e}")
        return text

    def upload_prescription(self, user_id, pdf_file):
        """Extracts text from the PDF and upserts it into the local ChromaDB with the user_id as metadata."""
        if not self.vectorstore:
            return False, "RAG system not initialized (missing API keys)."
        
        text = self.extract_text_from_pdf(pdf_file)
        if not text.strip():
            return False, "Could not extract text from the provided PDF."

        logger.info(f"Upserting prescription for user {user_id} into ChromaDB...")
        metadata = {"user_id": str(user_id), "source": "prescription"}
        
        from langchain_text_splitters import RecursiveCharacterTextSplitter
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
        docs = text_splitter.create_documents([text], metadatas=[metadata])
        
        self.vectorstore.add_documents(docs)
        return True, "Prescription successfully saved and embedded in local ChromaDB."

    def query_prescription(self, user_id, question):
        """Answers RAG questions based only on the prescriptions belonging to that user_id."""
        if not self.vectorstore:
            return "RAG system not initialized."

        providers = get_available_llms()
        if not providers:
            return "No AI provider configured for prescription QA (set GEMINI, OPENAI, GROK, or CLAUDE key)."

        retriever = self.vectorstore.as_retriever(search_kwargs={'filter': {'user_id': str(user_id)}})

        system_prompt = (
            "You are an intelligent clinical assistant analyzing a patient's prescription (Beheth Thundu). "
            "Use the provided prescription context to answer the user's question accurately. "
            "If the answer is not in the prescription context, strictly say 'I cannot find this information in the uploaded prescriptions.'\n\n"
            "Context:\n{context}"
        )

        prompt = ChatPromptTemplate.from_messages([
            ("system", system_prompt),
            ("human", "{input}"),
        ])

        def format_docs(docs):
            return "\n\n".join(doc.page_content for doc in docs)

        last_error = None
        for provider_name, llm in providers:
            logger.info(f"Prescription QA using provider: {provider_name}")
            rag_chain = (
                {"context": retriever | format_docs, "input": RunnablePassthrough()}
                | prompt
                | llm
                | StrOutputParser()
            )
            try:
                return rag_chain.invoke(question)
            except Exception as e:
                logger.error(f"Chroma RAG QA failed with {provider_name}: {e}")
                last_error = e
                continue

        return "Sorry, I encountered an error checking the prescription."
```

---

### 2. `apps/ai-summary-service/src/core/rag_service.py`

```python
import logging
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnablePassthrough
from langchain_core.documents import Document

from core.llm_provider import get_available_llms

logger = logging.getLogger(__name__)

_healthy_message_rag = None


def get_healthy_message_rag():
    """Returns a shared HealthyMessageRAG instance, creating it on first use."""
    global _healthy_message_rag
    if _healthy_message_rag is None:
        _healthy_message_rag = HealthyMessageRAG()
    return _healthy_message_rag


class HealthyMessageRAG:
    def __init__(self):
        self.embeddings = None
        self.vectorstore = None
        self.retriever = None
        try:
            self.embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
        except Exception as e:
            logging.warning(
                f"HealthyMessageRAG: local embeddings unavailable ({e}). "
                "Install 'sentence-transformers' to enable healthy-message generation."
            )

    def initialize_knowledge_base(self, medical_report: str):
        logging.info("Initializing RAG with the latest Medical Report")
        docs = [Document(page_content=medical_report, metadata={"source": "medical_report"})]
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
        splits = text_splitter.split_documents(docs)
        self.vectorstore = FAISS.from_documents(splits, self.embeddings)
        self.retriever = self.vectorstore.as_retriever()

    def generate_healthy_messages(self, medical_report: str) -> str:
        if not medical_report or medical_report.startswith("Error"):
            return "Unable to generate specific health advice due to missing report."

        if not self.embeddings:
            return "General Advice: Maintain regular vital checks and ensure proper hydration."

        self.initialize_knowledge_base(medical_report)

        available_llms = get_available_llms()
        if not available_llms:
            return "General Advice: Maintain regular vital checks and ensure proper hydration."

        provider_name, llm = available_llms[0]
        logging.info(f"Using {provider_name} for RAG generation")

        system_prompt = (
            "You are a compassionate, experienced senior nurse named SoterCare Nurse. "
            "You are speaking directly to a caregiver or elderly patient through an app notification. "
            "Use the provided context (which is their latest clinical medical report) to generate "
            "2-3 short, friendly, personalized pieces of advice ('Healthy Messages'). "
            "Address them kindly. If there are anomalies, gently remind them to follow instructions."
            "\n\nContext:\n{context}"
        )

        prompt = ChatPromptTemplate.from_messages([
            ("system", system_prompt),
            ("human", "{input}"),
        ])

        def format_docs(docs):
            return "\n\n".join(doc.page_content for doc in docs)

        rag_chain = (
            {"context": self.retriever | format_docs, "input": RunnablePassthrough()}
            | prompt
            | llm
            | StrOutputParser()
        )

        try:
            return rag_chain.invoke("What personalized health advice do you have for me today based on my vitals?")
        except Exception as e:
            logging.error(f"RAG formulation failed: {str(e)}")
            return "General Advice: Maintain regular vital checks and ensure proper hydration."
```

---

### 3. `apps/ai-summary-service/src/core/llm_provider.py`

```python
import os
import logging
from langchain_openai import ChatOpenAI
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_anthropic import ChatAnthropic


_cached_llms = None


def get_available_llms():
    global _cached_llms
    if _cached_llms is not None:
        return _cached_llms

    llms = []

    # 1. ChatGPT (OpenAI)
    if os.getenv("OPENAI_API_KEY"):
        try:
            llms.append(("ChatGPT (OpenAI)", ChatOpenAI(model="gpt-3.5-turbo", temperature=0.7)))
        except Exception as e:
            logging.warning(f"Failed to init OpenAI: {e}")

    # 2. Grok (xAI) - Compatible with OpenAI SDK
    if os.getenv("GROK_API_KEY"):
        try:
            llms.append(("Grok (xAI)", ChatOpenAI(
                model="grok-4-1-fast",
                temperature=0.7,
                api_key=os.getenv("GROK_API_KEY"),
                base_url="https://api.x.ai/v1"
            )))
        except Exception as e:
            logging.warning(f"Failed to init Grok: {e}")

    # 3. Gemini (Google)
    if os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"):
        try:
            key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
            gemini_model = os.getenv("GEMINI_MODEL") or "gemini-2.0-flash"
            class SafeGemini(ChatGoogleGenerativeAI):
                def invoke(self, input, config=None, **kwargs):
                    from langchain_core.prompt_values import PromptValue
                    if isinstance(input, PromptValue):
                        safe_input = input.to_string()
                    elif isinstance(input, dict) and "text" in input:
                        safe_input = input["text"]
                    else:
                        safe_input = str(input)
                    return super().invoke(safe_input, config=config, **kwargs)
            llms.append(("Gemini (Google)", SafeGemini(model=gemini_model, google_api_key=key, temperature=0.7)))
            logging.info(f"Initialized Gemini provider with model: {gemini_model}")
        except Exception as e:
            logging.warning(f"Failed to init Gemini: {e}")

    # 4. Claude (Anthropic)
    if os.getenv("CLAUDE_API_KEY") or os.getenv("ANTHROPIC_API_KEY"):
        try:
            key = os.getenv("CLAUDE_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
            llms.append(("Claude (Anthropic)", ChatAnthropic(model="claude-3-opus-20240229", api_key=key, temperature=0.7)))
        except Exception as e:
            logging.warning(f"Failed to init Claude: {e}")

    _cached_llms = llms
    return llms
```

---

### 4. `apps/ai-summary-service/src/core/health_agent.py`

```python
from langchain_core.prompts import PromptTemplate 

from core.nurse_agent import analyze_real_time_vitals
from core.llm_provider import get_available_llms

def generate_ai_analysis(logs_data):
    print(f"AI Service: Analyzing {len(logs_data)} logs with Multi-Agent Fallback...")
    
    template = """
    You are SoterCare AI, a Clinical Decision Support System analyzing sensor data for elderly patient monitoring.
    
    **TASK**: Generate a concise, highly readable medical report based on the hardware sensor data provided. Keep the entire report brief and to the point.
    
    **DATA KEYS**:
    - 'temperature': Skin Temperature (Normal: 32-37°C)
    - 'ambientTemp': Room Temperature
    - 'moisture': Hydration/Sweat level
    - 'gaitLabel': Patient Movement Activity ("walking", "sitting", "standing")
    - 'sos' / 'fallAlert': Boolean triggers for emergencies.
    
    **PATIENT SENSOR DATA** (JSON format):
    {logs}
    
    **REPORT STRUCTURE**:
    
    ### 1. Daily Overview
    [Write a 2-sentence executive summary of the patient's stability, noting any emergencies]
    
    ### 2. Temperature & Environment
    - Briefly note the average Skin Temperature and Room Temperature based on the 'temperature' and 'ambientTemp' arrays. Note any fever risks.
    
    ### 3. Movement & Activity
    - Summarize the patient's mobility state based purely on the 'gaitLabel' states (e.g. "Patient was mostly walking and sitting"). Note any falls.
    
    ### 4. Key Recommendations
    - [Bullet point 1 actionable advice]
    - [Bullet point 2 actionable advice]

    ### 5. Personalized Health Messages
    [Now switch voice: you are 'SoterCare Nurse', a compassionate, experienced senior nurse speaking directly to the caregiver or elderly patient through an app notification. Based on the data above, write 2-3 short, friendly, personalized pieces of advice. Address them kindly. If there are anomalies, gently remind them to follow instructions.]

    *Limit the entire response to 200-250 words. Do not hallucinate data that isn't in the JSON. If a value is missing, ignore it.*
    """
    
    prompt = PromptTemplate(input_variables=["logs"], template=template)
    providers = get_available_llms()
    
    if not providers:
        return "Error: No AI Providers configured in .env (OPENAI, GROK, GEMINI, CLAUDE)."

    last_error = None
    report_content = None
    for name, llm in providers:
        print(f"Trying Provider: {name}...")
        try:
            chain = prompt | llm
            response = chain.invoke({"logs": str(logs_data)})
            print(f"Success with {name}!")
            report_content = response.content
            break
        except Exception as e:
            print(f"Failed with {name}: {str(e)}")
            last_error = e
            continue
            
    if not report_content:
        report_content = f"All AI Agents failed to generate the medical report. Last Error: {str(last_error)}"

    nurse_alerts = []
    if isinstance(logs_data, list):
        for log in logs_data:
            nurse_alerts.extend(analyze_real_time_vitals(log))
    elif isinstance(logs_data, dict):
        nurse_alerts.extend(analyze_real_time_vitals(logs_data))
    
    nurse_alerts = list(set(nurse_alerts))
    alerts_text = "\n".join([f"- {alert}" for alert in nurse_alerts]) if nurse_alerts else "- No immediate critical alerts. Vitals and sensors are stable."

    final_output = f"""# SoterCare 24/7 AI Nurse Analysis

##  Real-Time Nurse Alerts (Sensor & Health Anomalies)
{alerts_text}

---
{report_content}
"""
    return final_output
```

---

### 5. `apps/ai-summary-service/src/core/nurse_agent.py`

```python
import logging

def analyze_real_time_vitals(data_point):
    """
    Analyzes incoming sensor data for immediate physical anomalies.
    Returns a list of alert strings (if any).
    """
    alerts = []
    
    if data_point.get('sos') == 1:
        alerts.append("EMERGENCY (CRITICAL): SOS Button Activated by the Elder! Immediate assistance required.")

    fall_alert = data_point.get('fallAlert') or data_point.get('fall_alert')
    if fall_alert == 1 or fall_alert is True:
        alerts.append("FALL ALERT (CRITICAL): Hardware fall detection triggered! Please check the patient immediately.")

    skin_temp = data_point.get('temperature')
    if skin_temp is None:
        skin_temp = data_point.get('temp')
    env_temp = data_point.get('ambientTemp')
    if env_temp is None:
        env_temp = data_point.get('ambient_temp')
    
    if skin_temp is not None:
        if skin_temp < 32.0 or skin_temp > 40.0:
            alerts.append(f"WARNING: Unusual skin temperature detected ({skin_temp}°C).")
        elif env_temp is not None:
            temp_diff = abs(skin_temp - env_temp)
            if temp_diff > 10.0:
                 alerts.append(f"ALERT: High discrepancy ({temp_diff:.1f}°C) between skin temperature ({skin_temp}°C) and environment ({env_temp}°C).")

    moisture = data_point.get('moisture')
    if moisture is not None:
        if moisture < 20: 
            alerts.append(f"HYDRATION WARNING: Elder's localized moisture/sweat level is very low ({moisture}). Please verify hydration levels.")

    return alerts
```

---

### 6. `apps/ai-summary-service/src/core/db_poller.py`

```python
import os
import time
import json
import logging
import psycopg2
from psycopg2.extras import DictCursor
from core.nurse_agent import analyze_real_time_vitals

import psycopg2.pool

logger = logging.getLogger(__name__)

def _build_database_url():
    host = os.getenv("DB_HOST", "127.0.0.1")
    port = os.getenv("DB_PORT", "5432")
    user = os.getenv("DB_USER", "postgres")
    password = os.getenv("DB_PASS", "postgres")
    name = os.getenv("DB_NAME", "auth_db")
    url = f"postgresql://{user}:{password}@{host}:{port}/{name}"
    if os.getenv("DB_SSL", "false").lower() == "true":
        url += "?sslmode=require"
    return url

def start_continuous_monitoring():
    db_url = os.getenv("DATABASE_URL") or _build_database_url()
    logger.info(f"24/7 Polling Agent connecting to DB at {db_url.split('@')[-1]}")

    poll_interval = int(os.getenv("POLL_INTERVAL_SECONDS", 10))
    logger.info(f"Starting 24/7 AI Nurse Agent... Polling every {poll_interval} seconds.")
    
    last_processed_timestamp = int(time.time() * 1000)
    db_pool = None
    retry_delay = poll_interval

    while True:
        try:
            if not db_pool:
                db_pool = psycopg2.pool.SimpleConnectionPool(1, 10, db_url)
                logger.info("Database connection pool established for 24/7 Poller.")
                retry_delay = poll_interval

            conn = db_pool.getconn()
            try:
                with conn.cursor(cursor_factory=DictCursor) as cursor:
                    query = "SELECT * FROM vital_sign WHERE CAST(timestamp AS BIGINT) > %s ORDER BY timestamp ASC"
                    cursor.execute(query, (last_processed_timestamp,))
                    new_logs = cursor.fetchall()

                    for row in new_logs:
                        data_point = dict(row)
                        alerts = analyze_real_time_vitals(data_point)
                        
                        if alerts:
                            logger.warning(f"[NURSE ALERT] Found anomalies for User ID {data_point.get('userId')}:")
                            for alert in alerts:
                                logger.warning(f"  -> {alert}")

                        current_ts = int(row['timestamp'])
                        if current_ts > last_processed_timestamp:
                            last_processed_timestamp = current_ts
            finally:
                db_pool.putconn(conn)
            
            time.sleep(poll_interval)

        except psycopg2.OperationalError as e:
            logger.error(f"Database connection error in 24/7 Poller: {e}")
            if db_pool:
                db_pool.closeall()
                db_pool = None
            logger.info(f"Retrying connection in {retry_delay} seconds...")
            time.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 300)

        except Exception as e:
            logger.error(f"24/7 Agent Polling Unexpected Error: {e}")
            time.sleep(poll_interval)
```

---

### 7. `apps/ai-summary-service/src/core/routine_reporter.py`

```python
import os
import time
import uuid
import logging
import psycopg2
from psycopg2.extras import DictCursor
from core.health_agent import generate_ai_analysis

import psycopg2.pool

logger = logging.getLogger(__name__)

def _build_database_url():
    host = os.getenv("DB_HOST", "127.0.0.1")
    port = os.getenv("DB_PORT", "5432")
    user = os.getenv("DB_USER", "postgres")
    password = os.getenv("DB_PASS", "postgres")
    name = os.getenv("DB_NAME", "auth_db")
    url = f"postgresql://{user}:{password}@{host}:{port}/{name}"
    if os.getenv("DB_SSL", "false").lower() == "true":
        url += "?sslmode=require"
    return url

def _store_report(conn, user_id, report_markdown):
    try:
        with conn.cursor() as wcur:
            wcur.execute(
                'INSERT INTO summary_history (id, "userId", summary) VALUES (%s, %s, %s)',
                (str(uuid.uuid4()), int(user_id), report_markdown),
            )
        conn.commit()
    except Exception as e:
        conn.rollback()
        logger.error(f"Failed to store 6-hour report for user {user_id}: {e}")


def start_routine_reporter():
    db_url = os.getenv("DATABASE_URL") or _build_database_url()
    logger.info(f"6-Hour Routine Reporter connecting to DB at {db_url.split('@')[-1]}")

    report_interval = int(os.getenv("ROUTINE_REPORT_INTERVAL_SECONDS", 21600))
    logger.info(f"Starting 6-Hour Routine Nursing Reporter... Running every {report_interval} seconds.")
    
    db_pool = None
    retry_delay = 60

    while True:
        time.sleep(report_interval)
        logger.info("Executing scheduled 6-Hour Routine Nursing Checkup...")
        try:
            if not db_pool:
                db_pool = psycopg2.pool.SimpleConnectionPool(1, 5, db_url)
                logger.info("Database connection pool established for 6-Hour Reporter.")
                retry_delay = 60

            conn = db_pool.getconn()
            try:
                with conn.cursor(cursor_factory=DictCursor) as cursor:
                    now_ms = int(time.time() * 1000)
                    six_hours_ago_ms = now_ms - (report_interval * 1000)
                    query = "SELECT * FROM vital_sign WHERE CAST(timestamp AS BIGINT) >= %s AND CAST(timestamp AS BIGINT) <= %s ORDER BY timestamp ASC"
                    cursor.execute(query, (six_hours_ago_ms, now_ms))
                    recent_logs = cursor.fetchall()

                    if not recent_logs:
                        logger.info("No sensor logs found in the last 6 hours. Skipping report.")
                    else:
                        user_logs = {}
                        for row in recent_logs:
                            data_point = dict(row)
                            u_id = data_point.get('userId')
                            if u_id not in user_logs:
                                user_logs[u_id] = []
                            clean_log = {
                                "ts": data_point.get('timestamp'),
                                "temp": data_point.get('temperature'),
                                "ambientTemp": data_point.get('ambientTemp'),
                                "moisture": data_point.get('moisture'),
                                "gaitLabel": data_point.get('gaitLabel'),
                                "sos": data_point.get('sos'),
                                "fallAlert": data_point.get('fallAlert'),
                                "thighnodeStatus": data_point.get('thighnodeStatus')
                            }
                            user_logs[u_id].append(clean_log)
                        
                        for user_id, logs in user_logs.items():
                            logger.info(f"Generating 6-Hour Markdown Report for User ID {user_id} using {len(logs)} logs.")
                            report_markdown = generate_ai_analysis(logs)
                            _store_report(conn, user_id, report_markdown)
                            logger.info(f"Stored 6-hour nursing report for user {user_id} in summary_history.")
            finally:
                db_pool.putconn(conn)

        except psycopg2.OperationalError as e:
            logger.error(f"Database connection error in 6-Hour Reporter: {e}")
            if db_pool:
                db_pool.closeall()
                db_pool = None
            logger.info(f"Retrying connection in {retry_delay} seconds...")
            time.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 3600)

        except Exception as e:
            logger.error(f"6-Hour Routine Reporter Unexpected Error: {e}")
```

---

### 8. `apps/ai-summary-service/src/main.py`

```python
import os
import json
import logging
import threading
from concurrent import futures
import grpc
import io
from generated import summary_pb2
from generated import summary_pb2_grpc
from dotenv import load_dotenv

from core.health_agent import generate_ai_analysis
from core.prescription_rag import PrescriptionRAG
from core.routine_reporter import start_routine_reporter
from core.db_poller import start_continuous_monitoring

load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

rag_service = PrescriptionRAG()


class SummaryService(summary_pb2_grpc.SummaryServiceServicer):
    def AnalyzeData(self, request, context):
        try:
            logging.info(f"Received AnalyzeData request.")
            data = json.loads(request.data_json)
            summary_text = generate_ai_analysis(data)
            return summary_pb2.AnalyzeDataResponse(
                summary=summary_text,
                recommendations="Generated based on analysis." 
            )
        except Exception as e:
            logging.error(f"Error in AnalyzeData: {str(e)}")
            context.set_details(str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            return summary_pb2.AnalyzeDataResponse()

    def SummarizeText(self, request, context):
        try:
            logging.info("Received SummarizeText request")
            from core.llm_provider import get_available_llms
            from langchain_core.prompts import PromptTemplate
            from langchain_core.output_parsers import StrOutputParser
            providers = get_available_llms()
            if not providers:
                return summary_pb2.SummarizeTextResponse(summary="Error: No AI Providers configured.")
                
            prompt = PromptTemplate(input_variables=["text"], template="Please provide a concise summary of the following text:\n\n{text}")
            
            for name, llm in providers:
                logging.info(f"SummarizeText trying Provider: {name}...")
                try:
                    chain = prompt | llm | StrOutputParser()
                    content = chain.invoke({"text": request.text})
                    return summary_pb2.SummarizeTextResponse(summary=content)
                except Exception as e:
                    logging.warning(f"SummarizeText failed with {name}: {str(e)}")
                    continue
                    
            return summary_pb2.SummarizeTextResponse(summary="Summarization failed across all providers.")
        except Exception as e:
            logging.error(f"Error in SummarizeText: {str(e)}")
            context.set_details(str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            return summary_pb2.SummarizeTextResponse(summary=str(e))

    def UploadPrescription(self, request, context):
        try:
            logging.info(f"Received UploadPrescription for user {request.user_id}")
            if not request.file_name.endswith('.pdf'):
                return summary_pb2.UploadPrescriptionResponse(success=False, message="Only PDF files are supported.")
            file_obj = io.BytesIO(request.file_data)
            success, message = rag_service.upload_prescription(request.user_id, file_obj)
            return summary_pb2.UploadPrescriptionResponse(success=success, message=message)
        except Exception as e:
            logging.error(f"Error in UploadPrescription: {str(e)}")
            context.set_details(str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            return summary_pb2.UploadPrescriptionResponse(success=False, message=str(e))

    def QueryPrescription(self, request, context):
        try:
            logging.info(f"Received QueryPrescription for user {request.user_id}")
            answer = rag_service.query_prescription(request.user_id, request.question)
            return summary_pb2.QueryPrescriptionResponse(success=True, answer=answer)
        except Exception as e:
            logging.error(f"Error in QueryPrescription: {str(e)}")
            context.set_details(str(e))
            context.set_code(grpc.StatusCode.INTERNAL)
            return summary_pb2.QueryPrescriptionResponse(success=False, answer=str(e))

def serve_grpc():
    port = os.getenv("SUMMARY_GRPC_PORT", "50053")
    max_msg_bytes = int(os.getenv("SUMMARY_GRPC_MAX_MESSAGE_MB", "20")) * 1024 * 1024
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=10),
        options=[
            ("grpc.max_receive_message_length", max_msg_bytes),
            ("grpc.max_send_message_length", max_msg_bytes),
        ],
    )
    summary_pb2_grpc.add_SummaryServiceServicer_to_server(SummaryService(), server)
    server.add_insecure_port(f'[::]:{port}')
    logging.info(f"AI Summary Service (gRPC) started on port {port}")
    server.start()
    server.wait_for_termination()

def serve():
    poller_thread = threading.Thread(target=start_continuous_monitoring, daemon=True)
    poller_thread.start()
    logging.info("Dispatched 24/7 DB Polling Thread.")
    
    reporter_thread = threading.Thread(target=start_routine_reporter, daemon=True)
    reporter_thread.start()
    logging.info("Dispatched 6-Hour Routine Nursing Reporter Thread.")
    
    serve_grpc()

if __name__ == '__main__':
    serve()
```

---

### 9. `apps/api-gateway/src/summary.controller.ts`

```typescript
import { Body, Controller, Get, Inject, OnModuleInit, Post, UseInterceptors, UseGuards, UploadedFile, Req } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom } from 'rxjs';
import { ApiTags, ApiOperation, ApiBody, ApiProperty, ApiBearerAuth } from '@nestjs/swagger';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SummaryHistory } from './database/entities';

class SummarizeDto {
    @ApiProperty({ example: 'Long text to summarize...' })
    text: string;
}

class UploadPrescriptionDto {
    @ApiProperty({ type: 'string', format: 'binary' })
    file: any;
}

class QueryPrescriptionDto {
    @ApiProperty({ example: 'What medications are prescribed?' })
    question: string;
}

interface SummaryService {
    summarizeText(data: { text: string }): Observable<{ summary: string }>;
    uploadPrescription(data: { userId: number; fileData: Buffer; fileName: string }): Observable<{ success: boolean; message: string }>;
    queryPrescription(data: { userId: number; question: string }): Observable<{ success: boolean; answer: string }>;
    analyzeData(data: { data_json: string; format: string }): Observable<{ summary: string; recommendations: string }>;
}

interface HealthService {
    getLogsByDateRange(data: { user_id: number; start_date: string; end_date: string }): Observable<any>;
}

type UploadedPrescriptionFile = {
    buffer: Buffer;
    originalname: string;
};

@ApiTags('summary')
@ApiBearerAuth()
@Controller('summary')
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class SummaryController implements OnModuleInit {
    private summaryService: SummaryService;
    private healthService: HealthService;

    constructor(
        @Inject('SUMMARY_SERVICE') private summaryClient: ClientGrpc,
        @Inject('HEALTH_SERVICE') private healthClient: ClientGrpc,
        @InjectRepository(SummaryHistory) private summaryHistoryRepo: Repository<SummaryHistory>,
    ) { }

    onModuleInit() {
        this.summaryService = this.summaryClient.getService<SummaryService>('SummaryService');
        this.healthService = this.healthClient.getService<HealthService>('HealthService');
    }

    @Post()
    @ApiOperation({ summary: 'Generate or retrieve daily summary of vitals using AI' })
    async getDailySummary(@Req() req: any) {
        const userId = req.user.userId;

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const existingSummary = await this.summaryHistoryRepo
            .createQueryBuilder('summary')
            .where('summary.userId = :userId', { userId })
            .andWhere('summary.createdAt >= :startOfDay', { startOfDay })
            .orderBy('summary.createdAt', 'DESC')
            .getOne();

        if (existingSummary) {
            return {
                success: true,
                message: "Retrieved already generated summary for today.",
                data: existingSummary
            };
        }

        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const logsResponse = await lastValueFrom(this.healthService.getLogsByDateRange({
            user_id: userId,
            start_date: startOfDay.toISOString(),
            end_date: endOfDay.toISOString()
        }));

        const logs = logsResponse.logs || [];

        if (logs.length === 0) {
            return {
                success: false,
                message: 'No vital sign data available for today to summarize.'
            };
        }

        const plainLogs = logs.map(log => ({
            temperature: log.temperature,
            ambientTemp: log.ambient_temp ?? log.ambientTemp,
            moisture: log.moisture,
            gaitLabel: log.gait_label ?? log.gaitLabel,
            sos: log.sos,
            fallAlert: log.fall_alert ?? log.fallAlert,
            timestamp: log.timestamp
        }));

        const MAX_LOGS = 300;
        let sampledLogs = plainLogs;
        if (plainLogs.length > MAX_LOGS) {
            const step = Math.ceil(plainLogs.length / MAX_LOGS);
            sampledLogs = plainLogs.filter((_, index) => index % step === 0);
        }

        let aiAnalysis;
        try {
            aiAnalysis = await lastValueFrom(this.summaryService.analyzeData({
                data_json: JSON.stringify(sampledLogs),
                format: 'markdown'
            }));
        } catch (e) {
            console.error('AI Analysis failed:', e);
            return { success: false, message: 'AI Analysis failed to generate' };
        }

        const newSummary = this.summaryHistoryRepo.create({
            userId,
            summary: aiAnalysis.summary,
            recommendations: aiAnalysis.recommendations
        });
        
        await this.summaryHistoryRepo.save(newSummary);

        return {
            success: true,
            data: newSummary
        };
    }

    @Get('history')
    @ApiOperation({ summary: 'Get history of generated daily summaries' })
    async getSummaryHistory(@Req() req: any) {
        const userId = req.user.userId;
        const history = await this.summaryHistoryRepo.find({
            where: { userId },
            order: { createdAt: 'DESC' },
            take: 30
        });
        return { success: true, data: history };
    }

    @Post('text')
    @ApiOperation({ summary: 'Summarize text using Python AI Service (Legacy)' })
    @ApiBody({ type: SummarizeDto })
    async summarizeTextLegacy(@Body() body: SummarizeDto) {
        return lastValueFrom(this.summaryService.summarizeText(body));
    }

    @Post('upload_prescription')
    @ApiOperation({ summary: 'Upload a prescription PDF for analysis' })
    @UseInterceptors(FileInterceptor('file'))
    async uploadPrescription(
        @UploadedFile() file: UploadedPrescriptionFile,
        @Req() req: any,
    ) {
        return lastValueFrom(
            this.summaryService.uploadPrescription({
                userId: req.user.userId,
                fileData: file.buffer,
                fileName: file.originalname,
            })
        );
    }

    @Post('query_prescription')
    @ApiOperation({ summary: 'Query the uploaded prescription using RAG' })
    @ApiBody({ type: QueryPrescriptionDto })
    async queryPrescription(@Body() body: QueryPrescriptionDto, @Req() req: any) {
        return lastValueFrom(
            this.summaryService.queryPrescription({
                userId: req.user.userId,
                question: body.question,
            })
        );
    }
}
```

---

### 10. `apps/api-gateway/src/database/entities/summary-history.entity.ts`

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';

@Entity({ name: 'summary_history' })
export class SummaryHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'text' })
  summary: string;

  @Column({ type: 'text', nullable: true })
  recommendations: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

---

### 11. `libs/common/src/proto/summary.proto`

```protobuf
syntax = "proto3";

package summary;

service SummaryService {
  rpc AnalyzeData (AnalyzeDataRequest) returns (AnalyzeDataResponse);
  rpc UploadPrescription (UploadPrescriptionRequest) returns (UploadPrescriptionResponse);
  rpc QueryPrescription (QueryPrescriptionRequest) returns (QueryPrescriptionResponse);
  rpc SummarizeText (SummarizeTextRequest) returns (SummarizeTextResponse);
}

message AnalyzeDataRequest {
  string data_json = 1;
  string format = 2;
}

message AnalyzeDataResponse {
  string summary = 1;
  string recommendations = 2;
}

message UploadPrescriptionRequest {
  int32 user_id = 1;
  bytes file_data = 2;
  string file_name = 3;
}

message UploadPrescriptionResponse {
  bool success = 1;
  string message = 2;
}

message QueryPrescriptionRequest {
  int32 user_id = 1;
  string question = 2;
}

message QueryPrescriptionResponse {
  bool success = 1;
  string answer = 2;
}

message SummarizeTextRequest {
  string text = 1;
}

message SummarizeTextResponse {
  string summary = 1;
}
```

---

### 12. Original `apps/api-gateway/src/api-gateway.module.ts` (before modification)

See the "Modified files" section for the diff; the original is the version in git history
at the point of this removal commit.

**Lines removed:**
- `import { SummaryController } from './summary.controller';` (line 12)
- `import { Alert, Vital, SummaryHistory } from './database/entities';` → reduced to `Alert, Vital`
- `SummaryController` from the `controllers` array (line 125)
- The entire `SUMMARY_SERVICE` `ClientsModule.register` block (lines 84–99)
- `SummaryHistory` from `TypeOrmModule.forFeature([Vital, Alert, SummaryHistory])` (line 72)

---

### 13. Original `apps/api-gateway/src/database/entities/index.ts` (before modification)

```typescript
export * from './alert.entity';
export * from './device-status.entity';
export * from './device.entity';
export * from './recording-session.entity';
export * from './sync-history.entity';
export * from './vital.entity';
export * from './summary-history.entity';   // ← line removed
```

---

### 14. `apps/api-gateway/src/reports.controller.ts` AI section (removed block)

The `SummaryService` interface, `@Inject('SUMMARY_SERVICE')` constructor injection,
`onModuleInit` subscription, and the AI analysis try/catch block inside `exportReport`
were all removed. The endpoint now returns logs only, with a static placeholder for
the `report` field so the response shape is preserved.

---

## Notes for New Implementation

- `apps/ai-summary-service/src/generated/health_pb2.py` and `health_pb2_grpc.py`
  are **not deleted** — the new AI service will need these to call the health
  service gRPC endpoint.
- `apps/ai-summary-service/pyproject.toml` is **not deleted** but its content is
  incorrect (Flask references, missing deps, no lockfile). Rewrite it for the new
  service.
- The `summary_history` **database table still exists** (TypeORM `synchronize: true`
  will not drop it). If the new implementation will use a different schema, run an
  explicit migration to drop or alter it.
- The `chroma_db/` directory (if present on disk) can be deleted manually; it is no
  longer referenced by any code.
- A new `summary.proto` will need to be created for whatever gRPC interface the new
  service exposes, and the api-gateway module updated to register it.
