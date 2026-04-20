import type { OllamaMessage } from './ollama';

const API_BASE = 'http://localhost:8000';

export interface MemoryMessage extends OllamaMessage {
  id: number;
  timestamp: string;
  topics: string[];
  score?: number;
}

interface SearchMemoryResponse {
  memories: MemoryMessage[];
}

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
  if (result.status !== 'success') {
    throw new Error(result.message ?? '메모리 저장 실패');
  }
}

export async function searchRelevantMemories(query: string, limit: number = 10): Promise<MemoryMessage[]> {
  const encodedQuery = encodeURIComponent(query);
  const response = await fetch(`${API_BASE}/api/search_memory?query=${encodedQuery}&limit=${limit}`);

  if (!response.ok) {
    throw new Error(`메모리 검색 실패 (${response.status})`);
  }

  const result: SearchMemoryResponse = await response.json();
  return result.memories ?? [];
}

export async function listTopics(): Promise<Array<{ name: string; message_count: number }>> {
  const response = await fetch(`${API_BASE}/api/list_topics`);

  if (!response.ok) {
    throw new Error(`주제 목록 조회 실패 (${response.status})`);
  }

  const result = await response.json();
  return result.topics ?? [];
}

export function buildMemoryContext(userText: string, memories: MemoryMessage[]): OllamaMessage[] {
  const uniqueMap = new Map<string, OllamaMessage>();

  for (const memory of [...memories].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const key = `${memory.role}:${memory.content}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, { role: memory.role, content: memory.content });
    }
  }

  uniqueMap.set(`user:${userText}`, { role: 'user', content: userText });

  return [...uniqueMap.values()];
}
