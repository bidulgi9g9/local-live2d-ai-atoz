from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import json
import os
from pathlib import Path

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
CHAT_DIR.mkdir(exist_ok=True)

# 서버 상태 확인용 헬스 체크 엔드포인트
@app.get("/health")
async def health():
    return {"status": "ok", "message": "Server is running"}

# 대화 저장 API
# 요청 예시: {"id": "huohuo", "messages": [...]}
@app.post("/api/save_chat")
async def save_chat(data: dict):
    """대화 이력을 파일에 저장"""
    # id가 없으면 기본 파일명(chat_default)을 사용
    chat_id = data.get("id", "chat_default")
    messages = data.get("messages", [])
    
    # chat_id.json 파일로 저장
    file_path = CHAT_DIR / f"{chat_id}.json"
    
    # UTF-8로 저장하고, ensure_ascii=False로 한글 깨짐 방지
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(messages, f, ensure_ascii=False, indent=2)
    
    # 저장 결과 메타데이터 반환
    return{
        "status": "success",
        "path": str(file_path),
        "count": len(messages)   
    }

# 대화 불러오기 API
@app.get("/api/get_chat/{chat_id}")
async def load_chat(chat_id: str):
    """저장된 대화 이력 불러오기"""
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
    """저장된 대화 목록 조회"""
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
    """저장된 대화 삭제"""
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