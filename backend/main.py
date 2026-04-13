from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import json
import os
from pathlib import Path

app = FastAPI()

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # vite 기본포트
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 챗봇 답변을 저장할 파일 경로
CHAT_DIR = Path.home() / "Documents" / "local-live2d-chats"
CHAT_DIR.mkdir(exist_ok=True)

# 서버 실행 확인
@app.get("/health")
async def health():
    return {"status": "ok", "message": "Server is running"}

# 챗봇 답변 저장 API
@app.post("/api/save_chat")
async def save_chat(data: dict):
    """대화 이력을 파일에 저장"""
    chat_id = data.get("id", "chat_default")
    messages = data.get("messages", [])
    
    file_path = CHAT_DIR / f"{chat_id}.json"
    
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(messages, f, ensure_ascii=False, indent=2)
    
    return{
        "status": "success",
        "path": str(file_path),
        "count": len(messages)   
    }

# 대화 불러오기
@app.get("/api/get_chat/{chat_id}")
async def load_chat(chat_id: str):
    """저장된 대화 이력 불러오기"""
    file_path = CHAT_DIR / f"{chat_id}.json"
    
    if not file_path.exists():
        return {"messages": [], "status": "new"}
    
    with open(file_path, 'r', encoding='utf-8') as f:
        messages = json.load(f)
    
    return {"messages": messages, "status": "loaded"}

# 저장된 대화 목록
@app.get("/api/list_chats")
async def list_chats():
    """저장된 대화 목록 조회"""
    chats = []
    for file in CHAT_DIR.glob("*.json"):
        chats.append({
            "id": file.stem,
            "name": file.stem,
            "path": str(file)
        })
    return {"chats": chats}

# 챗봇 답변 삭제 API
@app.delete("/api/delete-chat/{chat_id}")
async def delete_chat(chat_id: str):
    """저장된 대화 삭제"""
    file_path = CHAT_DIR / f"{chat_id}.json"
    
    if file_path.exists():
        file_path.unlink()
        return {"status": "success", "message": f"{chat_id} 삭제됨"}
    
    return {"status": "error", "message": "파일을 찾을 수 없음"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)