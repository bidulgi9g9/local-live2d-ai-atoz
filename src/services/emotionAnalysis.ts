export type Emotion = 'happy' | 'curious' | 'sad' | 'angry' | 'surprised' | 'neutral';
const KOBERT_TIMEOUT_MS = 1200;

// 감정 분석 결과 타입
export interface EmotionAnalysisResult {
    emotion: Emotion;
    confidence: number;
    all_scores: Record<Emotion, number>;
}

/**
 * KoBERT를 사용해서 텍스트의 감정을 분석
 * 
 * 예시:
 * const result = await analyzeEmotionWithKoBERT("안녕하세요! 반가워요!");
 * console.log(result.emotion);  // "happy"
 * console.log(result.confidence);  // 0.87
 */
export async function analyzeEmotionWithKoBERT(
    text: string
): Promise<EmotionAnalysisResult | null> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), KOBERT_TIMEOUT_MS);

    try {
        console.log(`🤖 KoBERT 감정 분석 시작: "${text}"`);
        
        // 1️⃣ 백엔드에 요청
        const response = await fetch(
            'http://localhost:8000/api/analyze_emotion',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                signal: controller.signal,
                body: JSON.stringify({
                    text: text
                })
            }
        );
        
        // 2️⃣ 응답 확인
        if (!response.ok) {
            throw new Error(`감정 분석 실패: HTTP ${response.status}`);
        }
        
        // 3️⃣ 결과 파싱
        const result = await response.json();
        
        // 4️⃣ 로그 출력
        console.log(`✅ KoBERT 감정 분석 완료`);
        console.log(`🎯 감정: ${result.emotion}`);
        console.log(`💪 신뢰도: ${result.confidence}`);
        console.log(`📊 상세:`, result.all_scores);
        
        return result;
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            console.warn(`⏱️ KoBERT 감정 분석 타임아웃 (${KOBERT_TIMEOUT_MS}ms)`);
            return null;
        }

        console.error('❌ KoBERT 감정 분석 오류:', error);

        // 네트워크/백엔드 실패 시 호출부에서 폴백 감정 로직을 사용합니다.
        return null;
    } finally {
        window.clearTimeout(timeoutId);
    }
}