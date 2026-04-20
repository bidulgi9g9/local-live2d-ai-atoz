from datetime import datetime, timezone
from pathlib import Path
import json
import re
import sqlite3
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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
DB_PATH = BASE_DIR / "memory.db"

VALID_ROLES = ("user", "assistant")
VALID_ROLES_SQL = ", ".join(f"'{role}'" for role in VALID_ROLES)
TOPIC_OVERLAP_WEIGHT = 2
EXACT_MATCH_BONUS = 2
MAX_SEARCH_CANDIDATES = 1000

TOKEN_RE = re.compile(r"[A-Za-z0-9가-힣]+")
TOPIC_KEYWORDS: dict[str, list[str]] = {
    "날씨": ["날씨", "비", "눈", "기온", "온도", "봄", "여름", "가을", "겨울"],
    "게임": ["게임", "플레이", "레벨", "퀘스트", "캐릭터"],
    "일상": ["오늘", "아침", "점심", "저녁", "집", "학교", "회사", "친구"],
    "감정": ["행복", "슬픔", "화나", "기쁨", "걱정", "우울", "감정"],
    "학습": ["공부", "학습", "숙제", "시험", "수업", "코드", "개발"],
    "건강": ["건강", "운동", "병원", "약", "몸", "피곤"],
}


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
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


def tokenize(text: str) -> set[str]:
    return {token.lower() for token in TOKEN_RE.findall(text) if len(token) > 1}


def infer_topics(text: str) -> list[str]:
    lower_text = text.lower()
    detected_topics: list[str] = []

    for topic, keywords in TOPIC_KEYWORDS.items():
        if any(keyword in lower_text for keyword in keywords):
            detected_topics.append(topic)

    if not detected_topics:
        detected_topics.append("일반")

    return detected_topics


def upsert_message_topics(conn: sqlite3.Connection, message_id: int, topics: list[str]) -> None:
    conn.executemany(
        "INSERT INTO message_topics(message_id, topic) VALUES(?, ?)",
        [(message_id, topic) for topic in topics],
    )


def normalize_iso_timestamp(value: str | None) -> str:
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
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def score_memory(query: str, query_tokens: set[str], query_topics: set[str], memory: dict[str, Any]) -> float:
    content = memory["content"]
    content_tokens = tokenize(content)
    memory_topics = set(memory["topics"])

    token_overlap = len(query_tokens & content_tokens)
    topic_overlap = len(query_topics & memory_topics)

    score = float(token_overlap + (topic_overlap * TOPIC_OVERLAP_WEIGHT))
    if query.lower() in content.lower():
        score += EXACT_MATCH_BONUS

    return score


init_db()


# 서버 상태 확인용 헬스 체크 엔드포인트
@app.get("/health")
async def health():
    return {"status": "ok", "message": "Server is running"}


@app.post("/api/save_message")
async def save_message(data: dict):
    """메시지 저장 + 주제 태그 자동 분류"""
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

    topics = infer_topics(content)

    with get_db_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO messages(role, content, timestamp) VALUES(?, ?, ?)",
            (role, content, timestamp),
        )
        if cursor.lastrowid is None:
            return {"status": "error", "message": "메시지 저장 ID 생성 실패"}
        message_id = int(cursor.lastrowid)
        upsert_message_topics(conn, message_id, topics)

    return {
        "status": "success",
        "id": message_id,
        "role": role,
        "topics": topics,
        "timestamp": timestamp,
    }


@app.get("/api/search_memory")
async def search_memory(query: str, limit: int = 10):
    """쿼리와 의미적으로 유사한 메모리를 상위 N개 반환"""
    safe_limit = max(1, min(limit, 50))
    safe_query = query.strip()

    if not safe_query:
        return {"memories": [], "query_topics": []}

    query_tokens = tokenize(safe_query)
    query_topics = set(infer_topics(safe_query))

    with get_db_connection() as conn:
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


if __name__ == "__main__":
    # 직접 실행 시 uvicorn 서버 시작
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
