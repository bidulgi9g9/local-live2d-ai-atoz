export interface OllamaMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface OllamaRequestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  model: string;
  message?: {
    role: string;
    content: string;
  };
  done: boolean;
}

export async function askOllama(chatHistory: OllamaMessage[]): Promise<string> {
  try {
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

    const requestMessages: OllamaRequestMessage[] = [
      { role: 'system', content: systemPrompt },
      ...chatHistory,
    ];

    // /api/chat uses a messages array and returns message.content
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

    // ✅ 에러 처리
    if (!response.ok) {
      throw new Error(`Ollama 오류: ${response.statusText}`);
    }

    const data: OllamaChatResponse = await response.json();
    const content = data.message?.content?.trim();
    if (!content) {
      throw new Error('Ollama 응답에 message.content가 없습니다.');
    }

    return content;
  } catch (error) {
    console.error('Ollama 요청 실패:', error);
    throw error;
  }
}