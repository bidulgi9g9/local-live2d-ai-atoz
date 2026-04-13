import type { OllamaMessage } from './ollama';

export async function saveChatToBackend(
  messages: OllamaMessage[],
    chatId: string = 'huohuo'
){
  try {
    const response = await fetch('http://localhost:8000/api/save_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: chatId,
        messages: messages
      })
    });

    if (!response.ok) {
      throw new Error(`저장 실패 (${response.status})`);
    }

    const result = await response.json();
    console.log(`✅ 저장됨: ${result.path}`);
    return result;
  } catch (error) {
    console.error('저장 오류:', error);
    throw error;
  }
}

export async function loadChatFromBackend(chatId: string = 'huohuo'): Promise<OllamaMessage[]> {
  try {
    const response = await fetch(
      `http://localhost:8000/api/get_chat/${chatId}`
    );

    if (!response.ok) {
      throw new Error(`불러오기 실패 (${response.status})`);
    }

    const result = await response.json();
    console.log(`✅ 불러옴: ${result.messages.length}개 메시지`);
    return result.messages;
  } catch (error) {
    console.error('불러오기 오류:', error);
    return [];
  }
}