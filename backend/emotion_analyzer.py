from kobert_transformers import get_kobert_model, get_tokenizer
import torch
from typing import Dict
import re

class EmotionAnalyzer:
    """KoBERT를 사용한 감정 분석기"""
    
    def __init__(self):
        print("🔄 KoBERT 모델 로딩 중... (처음 로드는 시간 걸림)")
        self.tokenizer = get_tokenizer()
        self.model = get_kobert_model()
        self.model.eval()
        print("✅ KoBERT 로드 완료!")
        
        # 감정별 참조 문장들 (각 감정을 대표하는 문장)
        self.emotion_references = {
            "happy": [
                "기쁨",
                "행복합니다",
                "좋아요",
                "감사합니다",
                "최고에요",
                "웃음이 나와요",
                "정말 좋네요",
                "멋진데요",
                "반가워요",
                "즐거워요"
            ],
            "sad": [
                "슬픈",
                "우울합니다",
                "힘들어요",
                "외로워요",
                "눈물이 나와요",
                "절망적이에요",
                "힘드네요",
                "슬프네요",
                "괴로워요",
                "안타까워요"
            ],
            "angry": [
                "화났어요",
                "짜증나요",
                "열받아요",
                "분노해요",
                "화나네요",
                "싫어요",
                "분한데",
                "빡쳐요",
                "열이 받힌다",
                "버럭"
            ],
            "curious": [
                "궁금해요",
                "어떻게",
                "왜",
                "알려줘요",
                "설명해줘요",
                "뭔가요",
                "어떤데",
                "어떨까",
                "뭐하는거야",
                "궁금하네"
            ],
            "surprised": [
                "놀랐어요",
                "오마이갓",
                "대박",
                "진짜요",
                "헐",
                "깜짝이야",
                "정말요",
                "어라",
                "오",
                "와"
            ],
            "neutral": [
                "네",
                "알겠습니다",
                "그렇군요",
                "좋습니다",
                "알았어요",
                "보겠습니다",
                "맞습니다",
                "그래요",
                "네 맞아요",
                "음"
            ]
        }

        # 의미 유사도만으로 쏠릴 때를 보정하기 위한 간단한 키워드 prior
        self.keyword_patterns = {
            "happy": re.compile(r"좋|행복|기쁘|반갑|감사|최고|웃", re.IGNORECASE),
            "sad": re.compile(r"슬프|우울|눈물|힘들|외롭|절망|괴로", re.IGNORECASE),
            "angry": re.compile(r"화나|짜증|열받|분노|빡치|싫", re.IGNORECASE),
            "curious": re.compile(r"궁금|왜|어떻게|뭐야|설명|알려", re.IGNORECASE),
            "surprised": re.compile(r"놀라|헐|대박|오마이갓|깜짝|충격|실화|세상에", re.IGNORECASE),
            "neutral": re.compile(r"그냥|보통|무난|알겠|네|응", re.IGNORECASE),
        }

        # 요청마다 참조 문장을 다시 임베딩하지 않도록 시작 시 1회 캐시합니다.
        self.reference_embeddings = self._build_reference_embeddings()

    def _build_reference_embeddings(self) -> Dict[str, list[torch.Tensor]]:
        cached: Dict[str, list[torch.Tensor]] = {}
        for emotion, reference_texts in self.emotion_references.items():
            vectors: list[torch.Tensor] = []
            for ref_text in reference_texts:
                ref_embedding = self.get_embedding(ref_text)
                if ref_embedding is not None:
                    vectors.append(ref_embedding)
            cached[emotion] = vectors

        print("✅ 참조 문장 임베딩 캐시 완료")
        return cached
    
    def get_embedding(self, text: str) -> torch.Tensor:
        """
        텍스트를 768차원 벡터로 변환
        
        예: "좋아요" → [0.123, -0.456, ..., 0.789] (768개 숫자)
        """
        try:
            # 1. 텍스트를 토큰으로 변환
            inputs = self.tokenizer.encode_plus(
                text,
                add_special_tokens=True,  # [CLS], [SEP] 추가
                max_length=128,            # 최대 길이
                padding='max_length',      # 짧으면 패딩
                truncation=True,           # 길면 자르기
                return_tensors='pt'        # PyTorch 텐서로
            )
            
            # 2. 모델에 입력
            with torch.no_grad():  # 그래디언트 계산 안함 (추론만)
                outputs = self.model(**inputs)
                # 모델 출력 타입에 따라 CLS 임베딩을 안정적으로 추출
                if hasattr(outputs, "last_hidden_state"):
                    cls_embedding = outputs.last_hidden_state[:, 0, :]
                else:
                    cls_embedding = outputs[0][:, 0, :]
                embedding = torch.nn.functional.normalize(cls_embedding, p=2, dim=1)
            
            return embedding
        
        except Exception as e:
            print(f"❌ 임베딩 생성 오류: {e}")
            return None

    def _keyword_score(self, text: str, emotion: str) -> float:
        pattern = self.keyword_patterns.get(emotion)
        if not pattern:
            return 0.0

        hits = len(pattern.findall(text))
        # 0.0 ~ 1.0 범위로 완만하게 스케일링
        return min(1.0, hits / 2.0)
    
    def analyze_emotion(self, text: str) -> Dict:
        """
        텍스트의 감정을 분석하고 반환
        
        입력: "안녕하세요! 반가워요!"
        
        반환:
        {
            "emotion": "happy",
            "confidence": 0.87,
            "all_scores": {
                "happy": 0.87,
                "curious": 0.45,
                "sad": 0.12,
                "angry": 0.10,
                "surprised": 0.38,
                "neutral": 0.42
            }
        }
        """
        
        print(f"\n📊 감정 분석 시작")
        print(f"📝 텍스트: '{text}'")
        
        # 1️⃣ 입력 텍스트를 벡터로 변환
        text_embedding = self.get_embedding(text)
        if text_embedding is None:
            print("❌ 임베딩 실패, neutral 반환")
            return {"emotion": "neutral", "confidence": 0.5}
        
        print(f"✅ 입력 텍스트 임베딩 완료")
        
        # 2️⃣ 각 감정별로 유사도 계산
        semantic_scores = {}
        keyword_scores = {}
        similarities = {}
        
        for emotion in self.emotion_references:
            emotion_scores = []

            # 캐시된 참조 임베딩과만 비교합니다.
            for ref_embedding in self.reference_embeddings.get(emotion, []):
                # 🎯 코사인 유사도 계산 (0 ~ 1)
                # 유사도 1.0 = 같은 의미
                # 유사도 0.0 = 다른 의미
                similarity = torch.nn.functional.cosine_similarity(
                    text_embedding,
                    ref_embedding
                ).item()

                emotion_scores.append(similarity)
            
            # 각 감정의 평균 점수 계산
            if emotion_scores:
                avg_cos = sum(emotion_scores) / len(emotion_scores)
                semantic_score = (avg_cos + 1.0) / 2.0  # -1~1 -> 0~1
                keyword_score = self._keyword_score(text, emotion)
                semantic_scores[emotion] = semantic_score
                keyword_scores[emotion] = keyword_score
            else:
                semantic_scores[emotion] = 0.0
                keyword_scores[emotion] = self._keyword_score(text, emotion)

        semantic_values = list(semantic_scores.values())
        semantic_range = (max(semantic_values) - min(semantic_values)) if semantic_values else 0.0
        semantic_weight = 0.75
        keyword_weight = 0.25
        # KoBERT 점수 분산이 너무 작으면(거의 비슷하면) 키워드를 더 신뢰합니다.
        if semantic_range < 0.08:
            semantic_weight = 0.35
            keyword_weight = 0.65

        for emotion in self.emotion_references:
            similarities[emotion] = (
                (semantic_scores.get(emotion, 0.0) * semantic_weight)
                + (keyword_scores.get(emotion, 0.0) * keyword_weight)
            )
        
        print(f"✅ 모든 감정 유사도 계산 완료")
        
        # 3️⃣ 가장 높은 유사도의 감정 선택
        best_emotion = max(similarities, key=similarities.get)
        confidence = similarities[best_emotion]
        
        # 로그 출력
        print(f"\n🎯 분석 결과:")
        print(f"  감정: {best_emotion}")
        print(f"  신뢰도: {confidence:.2f}")
        print(f"\n📈 상세 점수:")
        for emotion, score in sorted(similarities.items(), key=lambda x: x[1], reverse=True):
            print(f"  - {emotion}: {score:.2f}")
        
        return {
            "emotion": best_emotion,
            "confidence": round(confidence, 2),
            "all_scores": {k: round(v, 2) for k, v in similarities.items()}
        }


# 🌍 전역 인스턴스 (앱 시작 시 한 번 로드)
print("=" * 50)
print("KoBERT 감정 분석기 초기화 중...")
print("=" * 50)
analyzer = EmotionAnalyzer()
print("=" * 50)