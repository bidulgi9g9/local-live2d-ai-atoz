import type { OllamaMessage } from './ollama';

// 백엔드 API 주소는 환경변수로 바꾸고, 없으면 로컬 FastAPI를 사용합니다.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

// 검색 결과에 저장 메타데이터를 붙여서 프론트에서 다시 문맥으로 만들 수 있게 합니다.
export interface MemoryMessage extends OllamaMessage {
  id: number;
  timestamp: string;
  topics: string[];
  score?: number;
}

// 검색 API 응답 모양만 따로 정의해서 타입 안전성을 유지합니다.
interface SearchMemoryResponse {
  memories: MemoryMessage[];
}

interface RecentMessagesResponse {
  messages: MemoryMessage[];
}

// 한 메시지를 백엔드 SQLite 메모리로 저장합니다.
export async function saveMessageToMemory(message: OllamaMessage): Promise<void> {
  const response = await fetch(`${API_BASE}/api/save_message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`메모리 저장 실패 (${response.status})`);
  }

  const result = await response.json();
  if (result.status !== 'success' && result.status !== 'saved') {
    throw new Error(result.message ?? '메모리 저장 실패');
  }
}

// 현재 입력과 관련 있는 과거 메모리만 검색해 가져옵니다.
export async function searchRelevantMemories(query: string, limit: number = 10): Promise<MemoryMessage[]> {
  const encodedQuery = encodeURIComponent(query);
  const response = await fetch(`${API_BASE}/api/search_memory?query=${encodedQuery}&limit=${limit}`);

  if (!response.ok) {
    throw new Error(`메모리 검색 실패 (${response.status})`);
  }

  const result: SearchMemoryResponse = await response.json();
  return result.memories ?? [];
}

// 최근 저장 메시지를 시간순으로 가져와 앱 시작 시 대화창을 복원합니다.
export async function getRecentMessages(limit: number = 30): Promise<MemoryMessage[]> {
  const response = await fetch(`${API_BASE}/api/recent_messages?limit=${limit}`);

  if (!response.ok) {
    throw new Error(`최근 메시지 조회 실패 (${response.status})`);
  }

  const result: RecentMessagesResponse = await response.json();
  return result.messages ?? [];
}

// 저장된 주제별 집계 정보를 가져옵니다.
export async function listTopics(): Promise<Array<{ name: string; message_count: number }>> {
  const response = await fetch(`${API_BASE}/api/list_topics`);

  if (!response.ok) {
    throw new Error(`주제 목록 조회 실패 (${response.status})`);
  }

  const result = await response.json();
  return result.topics ?? [];
}

// 검색된 메모리와 현재 사용자의 입력을 합쳐 Ollama에 보낼 대화 문맥을 만듭니다.
export function buildMemoryContext(userText: string, memories: MemoryMessage[]): OllamaMessage[] {
  const uniqueMap = new Map<string, OllamaMessage>();

  // 오래된 메모리부터 넣어 순서를 유지하고, 중복은 제거합니다.
  for (const memory of [...memories].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const key = `${memory.role}:${memory.content}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, { role: memory.role, content: memory.content });
    }
  }

  // 현재 질문은 항상 마지막에 넣어서 최신 입력이 우선되게 합니다.
  uniqueMap.set(`user:${userText}`, { role: 'user', content: userText });

  return [...uniqueMap.values()];
}
