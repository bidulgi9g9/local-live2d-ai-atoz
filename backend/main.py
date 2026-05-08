from datetime import datetime, timezone
from pathlib import Path
import json
import re
import sqlite3
from typing import Any
from emotion_analyzer import analyzer

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import requests

# FastAPI 앱 인스턴스 생성
app = FastAPI()

# CORS 설정
# 프론트엔드(Vite dev server)에서 브라우저로 API 호출할 수 있게 허용합니다.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # vite 기본포트
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 챗봇 대화 이력을 저장할 폴더 경로
# 사용자 문서 폴더 아래 local-live2d-chats 디렉터리를 사용합니다.
CHAT_DIR = Path.home() / "Documents" / "local-live2d-chats"
CHAT_DIR.mkdir(parents=True, exist_ok=True)

BASE_DIR = Path(__file__).resolve().parent
# 백엔드 실행 파일 기준으로 SQLite DB를 둘 위치를 정합니다.
DB_PATH = BASE_DIR / "memory.db"

# 저장 가능한 역할 값은 user/assistant만 허용합니다.
VALID_ROLES = ("user", "assistant")
VALID_ROLES_SQL = ", ".join(f"'{role}'" for role in VALID_ROLES)
# 검색 점수 계산에서 토픽 일치와 완전 일치에 주는 가중치입니다.
TOPIC_OVERLAP_WEIGHT = 2
EXACT_MATCH_BONUS = 2
# 검색할 때 한 번에 읽어올 후보 메모리의 최대 수입니다.
MAX_SEARCH_CANDIDATES = 1000
NAME_QUERY_BONUS = 10
PROFILE_QUERY_BONUS = 18
PROFILE_MEMORY_BONUS = 6
RECENT_FALLBACK_SCORE = 0.1

# 단어를 잘라서 비교하기 위한 토큰 추출 정규식입니다.
TOKEN_RE = re.compile(r"[A-Za-z0-9가-힣]+")
# 키워드 기반으로 대화 주제를 대략 분류합니다.
TOPIC_KEYWORDS: dict[str, list[str]] = {
    "날씨": ["날씨", "비", "눈", "기온", "온도", "봄", "여름", "가을", "겨울"],
    "게임": ["게임", "플레이", "레벨", "퀘스트", "캐릭터"],
    "영화": ["영화", "장르", "배우", "감독", "넷플릭스", "극장", "시네마"],
    "음식": ["음식", "먹", "요리", "맛집", "식당", "메뉴", "배고", "밥"],
    "일상": ["오늘", "아침", "점심", "저녁", "집", "학교", "회사", "친구"],
    "감정": ["행복", "슬픔", "화나", "기쁨", "걱정", "우울", "감정"],
    "학습": ["공부", "학습", "숙제", "시험", "수업", "코드", "개발"],
    "건강": ["건강", "운동", "병원", "약", "몸", "피곤"],
}

# Ollama로 주제를 추론할 때 사용할 기본 주소와 모델 이름입니다.
OLLAMA_CHAT_URL = "http://localhost:11434/api/chat"
OLLAMA_TOPIC_MODEL = "gemma4:e4b"

NAME_PATTERNS = [
    re.compile(r"(?:내|제)\s*이름은\s*([A-Za-z0-9가-힣_]{2,20})(?:이야|입니다|예요)?"),
    re.compile(r"(?:난|저는)\s*([A-Za-z0-9가-힣_]{2,20})\s*(?:이야|입니다|예요)"),
]
NAME_QUERY_PATTERN = re.compile(r"이름")

PROFILE_VALUE_PATTERNS: dict[str, list[re.Pattern[str]]] = {
    "age": [
        re.compile(r"(?:내|제)\s*나이는\s*(\d{1,3})\s*살"),
        re.compile(r"(\d{1,3})\s*살\s*(?:이야|입니다|예요)"),
    ],
    "job": [
        re.compile(r"(?:내|제)\s*직업은\s*([A-Za-z0-9가-힣\s]{2,30})"),
        re.compile(r"(?:나는|저는)\s*([A-Za-z0-9가-힣\s]{2,30})\s*(?:이야|입니다|예요)"),
    ],
    "favorite": [
        re.compile(r"(?:내|내가|제가)\s*좋아하는\s*([A-Za-z0-9가-힣\s]{1,20})\s*은\s*([A-Za-z0-9가-힣\s]{1,30})"),
        re.compile(r"(?:나는|저는)\s*([A-Za-z0-9가-힣\s]{1,30})\s*을\s*좋아해"),
    ],
    "dislike": [
        re.compile(r"(?:내|내가|제가)\s*싫어하는\s*([A-Za-z0-9가-힣\s]{1,20})\s*은\s*([A-Za-z0-9가-힣\s]{1,30})"),
        re.compile(r"(?:나는|저는)\s*([A-Za-z0-9가-힣\s]{1,30})\s*을\s*싫어해"),
    ],
    "goal": [
        re.compile(r"(?:내|저의)\s*목표는\s*([A-Za-z0-9가-힣\s]{2,40})"),
    ],
}

PROFILE_QUERY_PATTERNS: dict[str, re.Pattern[str]] = {
    "name": re.compile(r"이름|성함"),
    "age": re.compile(r"나이|몇\s*살"),
    "job": re.compile(r"직업|무슨\s*일"),
    "favorite": re.compile(r"좋아하|취향|선호"),
    "dislike": re.compile(r"싫어하|비선호|꺼리"),
    "goal": re.compile(r"목표|계획|바라는\s*것"),
}

PROFILE_MEMORY_TEMPLATES: dict[str, str] = {
    "name": "사용자 이름은 {value}입니다.",
    "age": "사용자 나이는 {value}입니다.",
    "job": "사용자 직업은 {value}입니다.",
    "favorite": "사용자 선호 정보: {value}",
    "dislike": "사용자 비선호 정보: {value}",
    "goal": "사용자 목표: {value}",
}


def get_db_connection() -> sqlite3.Connection:
    # SQLite 연결을 만들고, 조회 결과를 컬럼명으로 접근할 수 있게 설정합니다.
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    # 필요한 테이블과 인덱스가 없으면 자동으로 생성합니다.
    with get_db_connection() as conn:
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL CHECK(role IN ({VALID_ROLES_SQL})),
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS message_topics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                topic TEXT NOT NULL,
                FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_message_topics_topic ON message_topics(topic)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_profile (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                source_message_id INTEGER,
                FOREIGN KEY(source_message_id) REFERENCES messages(id) ON DELETE SET NULL
            )
            """
        )


def extract_user_name(content: str) -> str | None:
    # 사용자 메시지에서 이름 소개 패턴을 찾아 이름 문자열만 뽑습니다.
    for pattern in NAME_PATTERNS:
        match = pattern.search(content)
        if match:
            return normalize_topic_name(match.group(1))
    return None


def clean_statement_suffix(value: str) -> str:
    # 진술형 어미를 제거해 프로필 값이 핵심 내용만 남도록 정리합니다.
    normalized = normalize_topic_name(value)
    normalized = re.sub(r"(입니다|이에요|예요|이야|야)$", "", normalized)
    normalized = re.sub(r"[.!?]+$", "", normalized)
    return normalize_topic_name(normalized)


def extract_profile_updates(content: str) -> dict[str, str]:
    # 사용자 문장에서 프로필 슬롯(name/age/job/favorite/dislike/goal)을 추출합니다.
    updates: dict[str, str] = {}

    extracted_name = extract_user_name(content)
    if extracted_name:
        updates["name"] = clean_statement_suffix(extracted_name)

    for key, patterns in PROFILE_VALUE_PATTERNS.items():
        for pattern in patterns:
            match = pattern.search(content)
            if not match:
                continue

            if key in ("favorite", "dislike") and len(match.groups()) >= 2:
                slot = clean_statement_suffix(match.group(1))
                value = clean_statement_suffix(match.group(2))
                if slot and value:
                    updates[key] = f"{slot}: {value}"
            else:
                value = clean_statement_suffix(match.group(1))
                if value:
                    updates[key] = value
            break

    return updates


def upsert_profile_value(
    conn: sqlite3.Connection,
    key: str,
    value: str,
    timestamp: str,
    source_message_id: int,
) -> None:
    # 같은 키가 이미 있으면 최신 값으로 갱신하고, 없으면 새로 저장합니다.
    conn.execute(
        """
        INSERT INTO user_profile(key, value, updated_at, source_message_id)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value=excluded.value,
            updated_at=excluded.updated_at,
            source_message_id=excluded.source_message_id
        """,
        (key, value, timestamp, source_message_id),
    )


def maybe_update_user_profile(
    conn: sqlite3.Connection,
    role: str,
    content: str,
    timestamp: str,
    message_id: int,
) -> None:
    # user 메시지에서 프로필 정보를 감지하면 user_profile에 반영합니다.
    if role != "user":
        return

    profile_updates = extract_profile_updates(content)
    for key, value in profile_updates.items():
        upsert_profile_value(conn, key, value, timestamp, message_id)


def get_profile_value(conn: sqlite3.Connection, key: str) -> str | None:
    # 저장된 단일 프로필 값을 조회합니다.
    row = conn.execute(
        "SELECT value FROM user_profile WHERE key = ?",
        (key,),
    ).fetchone()
    if not row:
        return None
    return normalize_topic_name(row["value"])


def get_profile_map(conn: sqlite3.Connection) -> dict[str, str]:
    # 현재 저장된 전체 프로필 값을 key-value로 반환합니다.
    rows = conn.execute(
        "SELECT key, value FROM user_profile"
    ).fetchall()
    return {
        normalize_topic_name(row["key"]): normalize_topic_name(row["value"])
        for row in rows
        if row["key"] and row["value"]
    }


def detect_profile_query_keys(query: str) -> set[str]:
    # 질의 문장이 어떤 프로필 슬롯을 묻는지 추론합니다.
    detected: set[str] = set()
    for key, pattern in PROFILE_QUERY_PATTERNS.items():
        if pattern.search(query):
            detected.add(key)

    if "나" in query and ("뭐" in query or "기억" in query):
        detected.update(PROFILE_QUERY_PATTERNS.keys())

    return detected


def build_profile_memories(query: str, profile_map: dict[str, str]) -> list[dict[str, Any]]:
    # 프로필 관련 질문이면 슬롯별 사실 메모리를 높은 점수로 구성합니다.
    requested_keys = detect_profile_query_keys(query)
    if not requested_keys:
        return []

    if len(requested_keys) > 1:
        candidate_keys = [key for key in PROFILE_MEMORY_TEMPLATES.keys() if key in profile_map]
    else:
        requested_key = next(iter(requested_keys))
        candidate_keys = [requested_key] if requested_key in profile_map else []

    profile_memories: list[dict[str, Any]] = []
    for key in candidate_keys:
        template = PROFILE_MEMORY_TEMPLATES.get(key)
        value = profile_map.get(key)
        if not template or not value:
            continue

        profile_memories.append(
            {
                "id": 0,
                "role": "assistant",
                "content": template.format(value=value),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "topics": ["프로필", key],
                "score": float(PROFILE_QUERY_BONUS + EXACT_MATCH_BONUS),
            }
        )

    return profile_memories


def tokenize(text: str) -> set[str]:
    # 텍스트를 소문자 토큰 집합으로 바꿔 검색 시 겹치는 단어를 계산합니다.
    return {token.lower() for token in TOKEN_RE.findall(text) if len(token) > 1}


def normalize_topic_name(topic: str) -> str:
    # 모델 응답이나 키워드에서 들어온 주제 문자열을 저장하기 쉬운 형태로 정리합니다.
    normalized = topic.strip().strip('"').strip("'")
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def dedupe_topics(topics: list[str]) -> list[str]:
    # 같은 주제가 중복 저장되지 않도록 순서를 유지한 채 한 번만 남깁니다.
    unique_topics: list[str] = []
    seen: set[str] = set()

    for topic in topics:
        normalized = normalize_topic_name(topic)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_topics.append(normalized)

    return unique_topics


def get_known_topics(conn: sqlite3.Connection) -> set[str]:
    # 이미 저장된 주제를 읽어와서 다음 분류 때 참고할 수 있게 합니다.
    rows = conn.execute(
        "SELECT DISTINCT topic FROM message_topics WHERE topic != '일반'"
    ).fetchall()
    return {normalize_topic_name(row["topic"]) for row in rows if row["topic"]}


def get_recent_memories(conn: sqlite3.Connection, limit: int) -> list[dict[str, Any]]:
    # 최신 대화 메시지를 시간순으로 가져와 UI 복원/검색 fallback에 사용합니다.
    rows = conn.execute(
        """
        SELECT
            m.id,
            m.role,
            m.content,
            m.timestamp,
            COALESCE(GROUP_CONCAT(mt.topic, ','), '') AS topics
        FROM messages m
        LEFT JOIN message_topics mt ON mt.message_id = m.id
        GROUP BY m.id
        ORDER BY m.timestamp DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()

    memories: list[dict[str, Any]] = []
    for row in rows:
        memories.append(
            {
                "id": row["id"],
                "role": row["role"],
                "content": row["content"],
                "timestamp": row["timestamp"],
                "topics": [topic for topic in row["topics"].split(",") if topic],
            }
        )

    memories.sort(key=lambda item: parse_timestamp_for_sort(item["timestamp"]))
    return memories


def extract_topics(text: str, known_topics: set[str] | None = None) -> list[str]:
    # 1차 분류는 로컬 키워드와 과거에 학습된 주제 이름만으로 빠르게 처리합니다.
    lower_text = text.lower()
    detected_topics: list[str] = []

    for topic, keywords in TOPIC_KEYWORDS.items():
        if any(keyword in lower_text for keyword in keywords):
            detected_topics.append(topic)

    if known_topics:
        for topic in sorted(known_topics):
            normalized_topic = normalize_topic_name(topic)
            if normalized_topic and normalized_topic != "일반" and normalized_topic.lower() in lower_text:
                detected_topics.append(normalized_topic)

    return dedupe_topics(detected_topics)


def parse_ollama_topic_response(content: str) -> list[str]:
    # Ollama가 JSON 또는 평문으로 돌려줘도 주제 배열로 복원합니다.
    cleaned = content.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)

    raw_topics: Any
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, dict):
        raw_topics = parsed.get("topics")
    elif isinstance(parsed, list):
        raw_topics = parsed
    elif isinstance(parsed, str):
        raw_topics = [parsed]
    else:
        raw_topics = [part for part in re.split(r"[,/\n|]+", cleaned) if part.strip()]

    if isinstance(raw_topics, str):
        raw_topics = [raw_topics]

    if not isinstance(raw_topics, list):
        return []

    return dedupe_topics([str(topic) for topic in raw_topics])


def ask_ollama_for_topic(text: str, known_topics: set[str]) -> list[str]:
    # 키워드로 못 찾은 경우에만 Ollama에게 주제를 추론하게 합니다.
    topic_hints = sorted({normalize_topic_name(topic) for topic in known_topics if normalize_topic_name(topic)})
    system_prompt = [
        "You are a topic classifier for chat messages.",
        "Return only JSON like {\"topics\": [\"topic1\", \"topic2\"]}.",
        "Use short Korean noun phrases only.",
        "Prefer the candidate topics if they fit the text.",
        "If nothing fits, return an empty topics array.",
    ]
    if topic_hints:
        system_prompt.append(f"Candidate topics: {', '.join(topic_hints)}")

    try:
        response = requests.post(
            OLLAMA_CHAT_URL,
            json={
                "model": OLLAMA_TOPIC_MODEL,
                "messages": [
                    {"role": "system", "content": " ".join(system_prompt)},
                    {"role": "user", "content": text},
                ],
                "stream": False,
            },
            timeout=15,
        )
        response.raise_for_status()

        data = response.json()
        content = (data.get("message") or {}).get("content", "").strip()
        if not content:
            return []

        return parse_ollama_topic_response(content)
    except Exception as error:
        # Ollama가 잠깐 실패해도 저장 흐름 전체는 멈추지 않게 합니다.
        print(f"[topic-classifier] Ollama topic lookup failed: {error}")
        return []


def classify_topics(text: str, conn: sqlite3.Connection, allow_learning: bool = True) -> tuple[list[str], bool, str]:
    # 1차 키워드 분류 후, 필요하면 Ollama fallback으로 동적 주제를 얻습니다.
    known_topics = get_known_topics(conn)
    extracted_topics = extract_topics(text, known_topics)
    source = "keyword"

    if extracted_topics:
        topics = extracted_topics
    else:
        topics = ask_ollama_for_topic(text, known_topics) if allow_learning else []
        source = "ollama" if topics else "fallback"

    if not topics:
        topics = ["일반"]

    topics = dedupe_topics(topics)
    learned = any(
        topic != "일반" and topic not in TOPIC_KEYWORDS and topic not in known_topics
        for topic in topics
    )

    return topics, learned, source


def upsert_message_topics(conn: sqlite3.Connection, message_id: int, topics: list[str]) -> None:
    # 하나의 메시지에 대해 추론된 주제들을 연결 테이블에 저장합니다.
    conn.executemany(
        "INSERT INTO message_topics(message_id, topic) VALUES(?, ?)",
        [(message_id, topic) for topic in topics],
    )


def normalize_iso_timestamp(value: str | None) -> str:
    # 들어온 timestamp를 ISO 8601 형태로 통일하고, 없으면 현재 시각을 씁니다.
    if not value:
        return datetime.now(timezone.utc).isoformat()

    normalized = value.strip()
    if not normalized:
        return datetime.now(timezone.utc).isoformat()

    parse_target = normalized.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(parse_target)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def parse_timestamp_for_sort(value: str) -> datetime:
    # 문자열 timestamp를 정렬용 datetime으로 바꾸고, 실패하면 가장 오래된 값으로 처리합니다.
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def score_memory(query: str, query_tokens: set[str], query_topics: set[str], memory: dict[str, Any]) -> float:
    # 검색어와 메모리의 단어/주제 겹침 정도를 점수로 계산합니다.
    content = memory["content"]
    content_tokens = tokenize(content)
    memory_topics = set(memory["topics"])

    token_overlap = len(query_tokens & content_tokens)
    topic_overlap = len(query_topics & memory_topics)

    score = float(token_overlap + (topic_overlap * TOPIC_OVERLAP_WEIGHT))
    if query.lower() in content.lower():
        score += EXACT_MATCH_BONUS

    # 이름 관련 질문은 이름이 들어간 메모리를 더 강하게 우선시합니다.
    if NAME_QUERY_PATTERN.search(query) and NAME_QUERY_PATTERN.search(content):
        score += NAME_QUERY_BONUS

    if "프로필" in memory_topics:
        score += PROFILE_MEMORY_BONUS

    return score


init_db()


# 서버 상태 확인용 헬스 체크 엔드포인트
@app.get("/health")
async def health():
    # 서버가 살아 있는지 확인하는 가장 단순한 헬스 체크입니다.
    return {"status": "ok", "message": "Server is running"}


@app.post("/api/save_message")
async def save_message(data: dict):
    """메시지 저장 + 주제 태그 자동 분류"""
    # 프론트에서 받은 메시지를 검증한 뒤 SQLite에 저장합니다.
    role = data.get("role")
    content = (data.get("content") or "").strip()
    try:
        timestamp = normalize_iso_timestamp(data.get("timestamp"))
    except ValueError:
        return {"status": "error", "message": "timestamp는 ISO 8601 형식이어야 합니다."}

    if role not in VALID_ROLES:
        return {"status": "error", "message": "role은 user 또는 assistant 여야 합니다."}

    if not content:
        return {"status": "error", "message": "content가 비어 있습니다."}

    with get_db_connection() as conn:
        topics, learned, topic_source = classify_topics(content, conn, allow_learning=True)
        cursor = conn.execute(
            "INSERT INTO messages(role, content, timestamp) VALUES(?, ?, ?)",
            (role, content, timestamp),
        )
        if cursor.lastrowid is None:
            return {"status": "error", "message": "메시지 저장 ID 생성 실패"}
        message_id = int(cursor.lastrowid)
        upsert_message_topics(conn, message_id, topics)
        maybe_update_user_profile(conn, role, content, timestamp, message_id)

    return {
        "status": "saved",
        "id": message_id,
        "role": role,
        "topics": topics,
        "learned": learned,
        "topic_source": topic_source,
        "timestamp": timestamp,
    }


@app.get("/api/recent_messages")
async def recent_messages(limit: int = 30):
    """최신 저장 메시지를 시간순으로 반환"""
    safe_limit = max(1, min(limit, 200))

    with get_db_connection() as conn:
        memories = get_recent_memories(conn, safe_limit)

    return {
        "messages": memories,
        "count": len(memories),
    }


@app.get("/api/search_memory")
async def search_memory(query: str, limit: int = 10):
    """쿼리와 의미적으로 유사한 메모리를 상위 N개 반환"""
    # 검색어를 기준으로 최근 메모리들을 읽고 점수 순으로 정렬합니다.
    safe_limit = max(1, min(limit, 50))
    safe_query = query.strip()

    if not safe_query:
        return {"memories": [], "query_topics": []}

    query_tokens = tokenize(safe_query)

    with get_db_connection() as conn:
        known_topics = get_known_topics(conn)
        query_topics = set(extract_topics(safe_query, known_topics))
        if not query_topics:
            query_topics = set(ask_ollama_for_topic(safe_query, known_topics))

        profile_map = get_profile_map(conn)
        profile_memories = build_profile_memories(safe_query, profile_map)

        rows = conn.execute(
            """
            SELECT
                m.id,
                m.role,
                m.content,
                m.timestamp,
                COALESCE(GROUP_CONCAT(mt.topic, ','), '') AS topics
            FROM messages m
            LEFT JOIN message_topics mt ON mt.message_id = m.id
            GROUP BY m.id
            ORDER BY m.timestamp DESC
            LIMIT ?
            """,
            (MAX_SEARCH_CANDIDATES,),
        ).fetchall()

        # 관련도 검색이 빈약한 경우를 대비해 최근 대화도 후보로 함께 준비합니다.
        recent_memories = get_recent_memories(conn, safe_limit * 3)

    scored_memories: list[dict[str, Any]] = []
    for row in rows:
        topics = [topic for topic in row["topics"].split(",") if topic]
        memory = {
            "id": row["id"],
            "role": row["role"],
            "content": row["content"],
            "timestamp": row["timestamp"],
            "topics": topics,
        }
        score = score_memory(safe_query, query_tokens, query_topics, memory)
        if score > 0:
            memory["score"] = score
            scored_memories.append(memory)

    scored_memories.extend(profile_memories)

    existing_ids = {item["id"] for item in scored_memories if item["id"]}
    for memory in reversed(recent_memories):
        if memory["id"] in existing_ids:
            continue
        memory["score"] = RECENT_FALLBACK_SCORE
        scored_memories.append(memory)
        existing_ids.add(memory["id"])
        if len(scored_memories) >= safe_limit * 2:
            break

    scored_memories.sort(
        key=lambda item: (item["score"], parse_timestamp_for_sort(item["timestamp"])),
        reverse=True,
    )

    return {
        "memories": scored_memories[:safe_limit],
        "query_topics": sorted(query_topics),
    }


@app.get("/api/list_topics")
async def list_topics():
    """저장된 주제 목록 조회"""
    # 지금까지 저장된 주제와 메시지 수를 집계해서 돌려줍니다.
    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT topic, COUNT(*) AS message_count
            FROM message_topics
            GROUP BY topic
            ORDER BY message_count DESC, topic ASC
            """
        ).fetchall()

    topics = [{"name": row["topic"], "message_count": row["message_count"]} for row in rows]
    return {"topics": topics}


# 대화 저장 API
# 요청 예시: {"id": "huohuo", "messages": [...]} 
@app.post("/api/save_chat")
async def save_chat(data: dict):
    """대화 이력을 파일에 저장 (레거시 호환)"""
    # id가 없으면 기본 파일명(chat_default)을 사용
    chat_id = data.get("id", "chat_default")
    messages = data.get("messages", [])

    # chat_id.json 파일로 저장
    file_path = CHAT_DIR / f"{chat_id}.json"

    # UTF-8로 저장하고, ensure_ascii=False로 한글 깨짐 방지
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(messages, f, ensure_ascii=False, indent=2)

    # 저장 결과 메타데이터 반환
    return {
        "status": "success",
        "path": str(file_path),
        "count": len(messages)
    }


# 대화 불러오기 API
@app.get("/api/get_chat/{chat_id}")
async def load_chat(chat_id: str):
    """저장된 대화 이력 불러오기 (레거시 호환)"""
    file_path = CHAT_DIR / f"{chat_id}.json"

    # 파일이 없으면 새 대화로 간주해 빈 배열 반환
    if not file_path.exists():
        return {"messages": [], "status": "new"}

    # 저장된 JSON 배열 로드
    with open(file_path, 'r', encoding='utf-8') as f:
        messages = json.load(f)

    return {"messages": messages, "status": "loaded"}


# 저장된 대화 목록 조회 API
@app.get("/api/list_chats")
async def list_chats():
    """저장된 대화 목록 조회 (레거시 호환)"""
    chats = []
    # 저장 폴더의 모든 json 파일을 순회해 id/name/path 구성
    for file in CHAT_DIR.glob("*.json"):
        chats.append({
            "id": file.stem,
            "name": file.stem,
            "path": str(file)
        })
    return {"chats": chats}


# 대화 삭제 API
@app.delete("/api/delete-chat/{chat_id}")
async def delete_chat(chat_id: str):
    """저장된 대화 삭제 (레거시 호환)"""
    file_path = CHAT_DIR / f"{chat_id}.json"

    # 파일이 존재하면 삭제
    if file_path.exists():
        file_path.unlink()
        return {"status": "success", "message": f"{chat_id} 삭제됨"}

    return {"status": "error", "message": "파일을 찾을 수 없음"}

@app.post("/api/analyze_emotion")
async def analyze_emotion(data: dict):
    """
    KoBERT를 사용한 감정 분석
    
    요청 예시:
    {
        "text": "안녕하세요! 정말 반가워요!"
    }
    
    응답 예시:
    {
        "emotion": "happy",
        "confidence": 0.87,
        "all_scores": {
            "happy": 0.87,
            "curious": 0.45,
            "sad": 0.12,
            "angry": 0.10,
            "surprised": 0.38,
            "neutral": 0.42
        }
    }
    """
    
    text = data.get("text", "")
    
    # 텍스트가 없으면 neutral 반환
    if not text:
        return {
            "emotion": "neutral",
            "confidence": 0.5,
            "all_scores": {
                "happy": 0.0,
                "curious": 0.0,
                "sad": 0.0,
                "angry": 0.0,
                "surprised": 0.0,
                "neutral": 1.0
            }
        }
    
    # KoBERT로 분석
    result = analyzer.analyze_emotion(text)
    
    return result

if __name__ == "__main__":
    # 직접 실행 시 uvicorn 서버 시작
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
