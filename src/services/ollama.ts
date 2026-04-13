export interface OllamaMessage {
  // 사용자 입력 또는 모델 응답 본문
  role: 'user' | 'assistant';
  content: string;
}

// Ollama /api/chat에 보낼 요청 메시지 타입
// system 역할을 추가해 응답 형식을 강제합니다.
interface OllamaRequestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Ollama /api/chat 응답에서 실제 사용되는 최소 필드
interface OllamaChatResponse {
  model: string;
  message?: {
    role: string;
    content: string;
  };
  done: boolean;
}

// 대화 이력(chatHistory)을 Ollama에 보내고,
// 모델의 최종 텍스트 응답(message.content)만 반환합니다.
export async function askOllama(chatHistory: OllamaMessage[]): Promise<string> {
  try {
    // 모델이 항상 감정 태그를 붙여 답하도록 시스템 프롬프트를 강제합니다.
    const systemPrompt = [
      'You are a Live2D chat assistant.',
      'Every response MUST start with exactly one leading emotion tag from this list only:',
      '(happy) (curious) (sad) (angry) (surprised) (neutral).',
      'Format: (emotion) your reply text',
      'Choose the most fitting emotion from context. Do not overuse (neutral).',
      'Use (neutral) only when no clear emotional tone exists.',
      'Do not use any other tag name.',
      'Do not output more than one leading tag.'
    ].join(' ');

    // 요청 메시지의 맨 앞에 system 프롬프트를 삽입하고
    // 뒤에 기존 대화 이력을 이어 붙입니다.
    const requestMessages: OllamaRequestMessage[] = [
      { role: 'system', content: systemPrompt },
      ...chatHistory,
    ];

    // Ollama /api/chat 호출
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemma4:e4b',
        messages: requestMessages,
        stream: false,
      }),
    });

    // HTTP 에러 처리
    if (!response.ok) {
      throw new Error(`Ollama 오류: ${response.statusText}`);
    }

    // JSON 응답 파싱 후 실제 텍스트만 추출
    const data: OllamaChatResponse = await response.json();
    const content = data.message?.content?.trim();
    if (!content) {
      throw new Error('Ollama 응답에 message.content가 없습니다.');
    }

    return content;
  } catch (error) {
    // 호출 실패는 상위 로직에서 사용자 안내 메시지를 보여줄 수 있도록 재던집니다.
    console.error('Ollama 요청 실패:', error);
    throw error;
  }
}