import type { OllamaMessage } from './ollama';

// 백엔드에 현재 대화 이력을 저장합니다.
// chatId는 파일명처럼 동작하며, 동일 id로 저장하면 기존 파일을 덮어씁니다.
export async function saveChatToBackend(
  messages: OllamaMessage[],
    chatId: string = 'huohuo'
){
  try {
    // FastAPI /api/save_chat 엔드포인트에 JSON으로 전송
    const response = await fetch('http://localhost:8000/api/save_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: chatId,
        messages: messages
      })
    });

    if (!response.ok) {
      // HTTP 상태코드를 포함해 실패 원인 파악을 쉽게 합니다.
      throw new Error(`저장 실패 (${response.status})`);
    }

    // 성공 시 백엔드에서 반환한 저장 경로/개수 정보를 받습니다.
    const result = await response.json();
    console.log(`✅ 저장됨: ${result.path}`);
    return result;
  } catch (error) {
    // 저장 실패는 상위 로직에서 UI 메시지를 보여줄 수 있도록 다시 throw 합니다.
    console.error('저장 오류:', error);
    throw error;
  }
}

// 백엔드에서 chatId에 해당하는 대화 이력을 불러옵니다.
// 실패하면 빈 배열을 반환해 앱이 계속 동작하도록 합니다.
export async function loadChatFromBackend(chatId: string = 'huohuo'): Promise<OllamaMessage[]> {
  try {
    // FastAPI /api/get_chat/{chat_id} 엔드포인트 호출
    const response = await fetch(
      `http://localhost:8000/api/get_chat/${chatId}`
    );

    if (!response.ok) {
      throw new Error(`불러오기 실패 (${response.status})`);
    }

    // 저장된 messages 배열만 꺼내서 반환
    const result = await response.json();
    console.log(`✅ 불러옴: ${result.messages.length}개 메시지`);
    return result.messages;
  } catch (error) {
    // 로드 실패 시에도 UI를 띄우기 위해 빈 배열로 안전하게 처리
    console.error('불러오기 오류:', error);
    return [];
  }
}