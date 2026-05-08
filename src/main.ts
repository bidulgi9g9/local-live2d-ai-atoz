import './style.css';
import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import { askOllama, type OllamaMessage } from './services/ollama';
import { buildMemoryContext, getRecentMessages, saveMessageToMemory, searchRelevantMemories } from './services/smartMemory';
import { analyzeEmotionWithKoBERT, type Emotion as KoBERTEmotion } from './services/emotionAnalysis'; 

// 메모리 상 대화 이력입니다.
// 1) UI 렌더 및 현재 세션 추적
// 2) 관련 메모리 검색 실패 시 최소 문맥 폴백
let messages: OllamaMessage[] = [];

// 1. 모델 경로 설정 (본인의 폴더명에 맞게 수정하세요)
const MODEL_URL = '/huohuo/huohuo.model3.json'; 
//IceGirl_Live2d/IceGIrl Live2D/IceGirl.model3.json

const TARGET_MAX_FPS = 120;
const TARGET_MIN_FPS = 30;

// pixi-live2d-display가 PIXI 전역 객체를 참조합니다.
(window as any).PIXI = PIXI;

type ChatRole = 'user' | 'bot';
type Emotion = KoBERTEmotion;
type ShotMode = 'full' | 'upper';
const EMOTION_TAGS: Emotion[] = ['happy', 'curious', 'sad', 'angry', 'surprised', 'neutral'];

// 반응/대기모션/시선 동작에 대한 시간 및 강도 설정값
const REACTION_RESET_MS = 2600;
const IDLE_MIN_INTERVAL_MS = 9000;
const IDLE_MAX_INTERVAL_MS = 16000;
const IDLE_BLOCK_AFTER_USER_MS = 6500;
const IDLE_BLOCK_AFTER_REACTION_MS = 5000;
const CHAT_FRONT_VIEW_MS = 6000;
const FRONT_GAZE_MODEL_X = 0;
const FRONT_GAZE_MODEL_Y = 0;
const WANDER_GAZE_MODEL_X = 0.18;
const WANDER_GAZE_MODEL_Y = 0.12;
const IDLE_MOTION_GROUPS = ['idle', 'haoqi', 'qizi', 'linghun', 'yaotou'];
const WANDER_MIN_INTERVAL_MS = 10000;
const WANDER_MAX_INTERVAL_MS = 18000;
const WANDER_MIN_DURATION_MS = 1800;
const WANDER_MAX_DURATION_MS = 3200;
const FALLBACK_CONTEXT_SIZE = 6;

let lastReactionAt = 0;
let lastUserInteractionAt = 0;
let lastConversationAt = 0;
let resetToDefaultTimer: number | null = null;
let idleMotionTimer: number | null = null;
let lastIdleMotionGroup = 'idle';
let nextWanderAt = Date.now() + 12000;
let wanderUntil = 0;

// [min, max] 범위의 정수 난수 반환
function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 다음 두리번(짧은 시선 이동) 시작 시점을 예약
function scheduleNextWander(baseTimeMs: number) {
    nextWanderAt = baseTimeMs + randomInt(WANDER_MIN_INTERVAL_MS, WANDER_MAX_INTERVAL_MS);
}

// Live2D 내부 좌표계(-1 ~ 1)로 시선 적용
// 화면 픽셀 좌표를 직접 쓰지 않아 모델별 중심 오차를 줄일 수 있습니다.
function setModelGaze(model: Live2DModel, x: number, y: number, instant = false) {
    const controller = (model as any).internalModel?.focusController;
    if (controller?.focus) {
        controller.focus(x, y, instant);
    }
}

// 새 모션 시작 전에 현재 모션 큐를 정리합니다.
// 모션 겹침(손/소품 잔상) 현상을 줄이는 목적입니다.
function stopAllModelMotions(model: Live2DModel) {
    const motionManager = (model as any).internalModel?.motionManager;
    motionManager?.stopAllMotions?.();
}

// 감정 태그가 없을 때 사용하는 키워드 기반 보조 감정 추론
const EMOTION_KEYWORDS: Record<Emotion, RegExp> = {
    happy: /(좋|고마|축하|행복|기쁘|최고|love|great|awesome|nice|thanks|웃)/i,
    curious: /(궁금|왜|어떻게|설명|질문|알려|what|how|why|explain|tell me)/i,
    sad: /(슬프|우울|눈물|힘들|미안|sorry|sad|depress|cry)/i,
    angry: /(화나|화난|짜증|열받|분노|angry|mad|annoy|빡치)/i,
    surprised: /(헉|와|놀라|대박|진짜|omg|wow|surpris|!{2,})/i,
    neutral: /$^/
};

const USER_EMOTION_COMMANDS: Record<Emotion, RegExp> = {
    happy: /(기쁜표정|웃는표정|행복한표정|happy)/i,
    curious: /(궁금한표정|의문표정|curious)/i,
    sad: /(슬픈표정|우는표정|sad|cry)/i,
    angry: /(화난표정|화난|성난표정|분노표정|angry|mad)/i,
    surprised: /(놀란표정|깜짝표정|surprised|wow)/i,
    neutral: /(무표정|기본표정|neutral)/i,
};

// 간단한 텍스트 감정 분류기(우선순위 순서대로 검사)
function detectEmotion(text: string): Emotion {
    if (EMOTION_KEYWORDS.angry.test(text)) return 'angry';
    if (EMOTION_KEYWORDS.sad.test(text)) return 'sad';
    if (EMOTION_KEYWORDS.surprised.test(text)) return 'surprised';
    if (EMOTION_KEYWORDS.happy.test(text)) return 'happy';
    if (EMOTION_KEYWORDS.curious.test(text)) return 'curious';
    return 'neutral';
}

// "화난표정", "슬픈표정" 같은 사용자 명령형 감정을 감지합니다.
// 감지되면 이 감정이 최우선으로 적용됩니다.
function detectForcedEmotionFromUserText(text: string): Emotion | null {
    for (const emotion of EMOTION_TAGS) {
        if (USER_EMOTION_COMMANDS[emotion].test(text)) {
            return emotion;
        }
    }
    return null;
}

// LLM 응답 문자열에서 감정 태그를 파싱합니다.
// 예: "(happy) 오늘 정말 좋아요" -> emotion=happy, visibleReply="오늘 정말 좋아요"
function parseEmotionTaggedReply(rawReply: string): { emotion: Emotion | null; visibleReply: string } {
    const match = rawReply.match(/[\(\（](happy|curious|sad|angry|surprised|neutral)[\)\）]/i);
    if (!match) {
        return { emotion: null, visibleReply: rawReply.trim() };
    }

    const taggedEmotion = match[1].toLowerCase() as Emotion;
    const visibleReply = rawReply.replace(match[0], '').trim();
    return {
        emotion: EMOTION_TAGS.includes(taggedEmotion) ? taggedEmotion : null,
        visibleReply: visibleReply || '...'
    };
}

// 표정/모션 적용이 실패해도 최소한 반응이 보이도록
// 회전/스케일/위치 펄스 애니메이션을 실행합니다.
function animateReaction(model: Live2DModel, baseScale: number, emotion: Emotion) {
    const durationMs = 700;
    const start = performance.now();
    const initialRotation = model.rotation;
    const initialX = model.x;
    const initialY = model.y;
    const ampByEmotion: Record<Emotion, number> = {
        happy: 0.1,
        curious: 0.08,
        sad: 0.05,
        angry: 0.14,
        surprised: 0.18,
        neutral: 0.06,
    };
    const scaleBoostByEmotion: Record<Emotion, number> = {
        happy: 0.08,
        curious: 0.06,
        sad: -0.01,
        angry: 0.07,
        surprised: 0.1,
        neutral: 0.04,
    };
    const moveByEmotion: Record<Emotion, number> = {
        happy: 16,
        curious: 12,
        sad: 8,
        angry: 22,
        surprised: 28,
        neutral: 10,
    };

    const amplitude = ampByEmotion[emotion];
    const scaleBoost = scaleBoostByEmotion[emotion];
    const move = moveByEmotion[emotion];

    const tick = (now: number) => {
        const t = Math.min((now - start) / durationMs, 1);
        const easeOut = 1 - Math.pow(1 - t, 3);
        const swing = Math.sin(t * Math.PI * 3) * (1 - easeOut);
        const bob = Math.sin(t * Math.PI) * (1 - easeOut);

        model.rotation = initialRotation + swing * amplitude;
        model.scale.set(baseScale * (1 + scaleBoost * (1 - easeOut)));
        model.x = initialX + swing * move;
        model.y = initialY - bob * move;

        if (t < 1) {
            requestAnimationFrame(tick);
        } else {
            model.rotation = initialRotation;
            model.scale.set(baseScale);
            model.x = initialX;
            model.y = initialY;
        }
    };

    requestAnimationFrame(tick);
}

// 감정 반응 후 일정 시간이 지나면 기본 상태로 복귀시킵니다.
// 강한 표정/모션이 오래 고정되는 것을 방지합니다.
function scheduleReturnToDefault(model: Live2DModel) {
    if (resetToDefaultTimer !== null) {
        window.clearTimeout(resetToDefaultTimer);
    }

    resetToDefaultTimer = window.setTimeout(async () => {
        try {
            stopAllModelMotions(model);
            const expressionManager = (model as any).internalModel?.motionManager?.expressionManager;
            expressionManager?.resetExpression?.();
            await model.motion('idle');
            lastIdleMotionGroup = 'idle';
        } catch (error) {
            console.debug('default reset skipped:', error);
        }
    }, REACTION_RESET_MS);
}

// 백그라운드 대기모션 스케줄러
// 유저 입력/감정 반응 직후에는 잠시 차단하고,
// 그 외 시간에는 랜덤 간격으로 대기모션을 실행합니다.
function startIdleMotionLoop(model: Live2DModel) {
    const scheduleNext = () => {
        const delay = Math.floor(Math.random() * (IDLE_MAX_INTERVAL_MS - IDLE_MIN_INTERVAL_MS + 1)) + IDLE_MIN_INTERVAL_MS;
        idleMotionTimer = window.setTimeout(async () => {
            scheduleNext();

            const now = Date.now();
            if (now - lastUserInteractionAt < IDLE_BLOCK_AFTER_USER_MS) {
                return;
            }
            if (now - lastReactionAt < IDLE_BLOCK_AFTER_REACTION_MS) {
                return;
            }

            try {
                const candidates = IDLE_MOTION_GROUPS.filter((group) => group !== lastIdleMotionGroup);
                const pool = candidates.length > 0 ? candidates : IDLE_MOTION_GROUPS;
                const group = pool[Math.floor(Math.random() * pool.length)];
                stopAllModelMotions(model);
                await model.motion(group);
                lastIdleMotionGroup = group;
            } catch (error) {
                console.debug('idle motion skipped:', error);
            }
        }, delay);
    };

    if (idleMotionTimer !== null) {
        window.clearTimeout(idleMotionTimer);
    }
    scheduleNext();
}

// 감정 반응 핵심 파이프라인
// 1) 감정 결정(사용자 명령 > 태그 감정 > 문맥 추론)
// 2) 표정 + 모션 적용
// 3) 보조 시각 반응(펄스) 실행
// 4) 기본 상태 복귀 타이머 예약
async function triggerModelReaction(
    model: Live2DModel,
    baseScale: number,
    userText: string,
    reply: string,
    forcedEmotion?: Emotion | null
) {
    const forcedByUserCommand = detectForcedEmotionFromUserText(userText);
    const taggedEmotion = forcedEmotion && forcedEmotion !== 'neutral' ? forcedEmotion : null;
    const kobertResult = await analyzeEmotionWithKoBERT(`${userText}\n${reply}`);
    const kobertEmotion: Emotion | null = kobertResult ? kobertResult.emotion : null;
    const inferredEmotion = detectEmotion(`${userText} ${reply}`);
    const emotion = forcedByUserCommand
        ?? kobertEmotion
        ?? taggedEmotion
        ?? inferredEmotion;

    const now = Date.now();
    if (now - lastReactionAt < 450) {
        return;
    }
    lastReactionAt = now;

    const expressionByEmotion: Partial<Record<Emotion, string>> = {
        happy: 'baozhen',
        curious: 'qizi2',
        angry: 'angry',
        sad: 'cry',
        surprised: 'white eyes',
    };
    const motionByEmotion: Partial<Record<Emotion, string>> = {
        happy: 'zhentou',
        curious: 'haoqi',
        sad: 'yaotou',
        angry: 'zhentou',
        surprised: 'keshui',
    };

    try {
        stopAllModelMotions(model);

        const expressionId = expressionByEmotion[emotion];
        if (expressionId) {
            await model.expression(expressionId);
        }

        const motionGroup = motionByEmotion[emotion];
        const shouldPlayMotion = emotion !== 'neutral';
        if (motionGroup && shouldPlayMotion) {
            await model.motion(motionGroup);
            lastIdleMotionGroup = motionGroup;
        }
    } catch (reactionError) {
        console.debug('Live2D expression/motion trigger skipped:', reactionError);
    }

    console.log('[reaction]', {
        emotion,
        forcedByUserCommand,
        forcedEmotion,
        kobertEmotion,
        kobertConfidence: kobertResult?.confidence,
        inferredEmotion,
    });

    // Fallback visual reaction so the model always feels responsive.
    animateReaction(model, baseScale, emotion);
    scheduleReturnToDefault(model);
}

// 앱 레이아웃(무대 + 채팅 패널)을 문자열 템플릿으로 생성합니다.
function createUI(appRoot: HTMLElement) {
    appRoot.innerHTML = `
      <div class="vt-shell">
                <section id="stage" aria-label="Live2D character stage">
                    <div class="stage-controls">
                        <button id="shot-toggle" class="shot-toggle" type="button">상반신 확대</button>
                    </div>
                </section>
        <aside class="chat-panel" aria-label="chat panel">
          <header class="chat-head">
                        <div class="chat-head-row">
                            <p class="chip">LIVE CHAT</p>
                            <button id="chat-toggle" class="chat-toggle" type="button" aria-expanded="true" aria-controls="messages chat-form">채팅 접기</button>
                        </div>
                        <h1>Huohuo Companion</h1>
            <p class="sub">모델에게 말을 걸어보세요. 짧게 입력해도 자연스럽게 이어집니다.</p>
          </header>

          <ul id="messages" class="messages" aria-live="polite"></ul>

          <form id="chat-form" class="chat-form">
            <input id="chat-input" type="text" maxlength="300" placeholder="메시지를 입력하세요" autocomplete="off" />
            <button type="submit">전송</button>
          </form>
        </aside>
      </div>
    `;

    return {
        shellEl: appRoot.querySelector('.vt-shell') as HTMLElement,
        chatPanelEl: appRoot.querySelector('.chat-panel') as HTMLElement,
        toggleEl: appRoot.querySelector('#chat-toggle') as HTMLButtonElement,
        shotToggleEl: appRoot.querySelector('#shot-toggle') as HTMLButtonElement,
        stageEl: appRoot.querySelector('#stage') as HTMLElement,
        messagesEl: appRoot.querySelector('#messages') as HTMLUListElement,
        formEl: appRoot.querySelector('#chat-form') as HTMLFormElement,
        inputEl: appRoot.querySelector('#chat-input') as HTMLInputElement,
    };
}

// 채팅 말풍선 1개를 렌더링하고, 항상 최신 메시지가 보이도록 스크롤을 하단으로 이동합니다.
function appendMessage(messagesEl: HTMLUListElement, role: ChatRole, text: string) {
    const li = document.createElement('li');
    li.className = `message ${role}`;
    li.textContent = text;
    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    return li;
}

// 채팅 흐름 초기화
// - 저장된 이력 로드(메모리)
// - submit 이벤트 처리
// - LLM 호출
// - 감정 태그 파싱
// - 화면 렌더 + 저장
async function setupChat(
    messagesEl: HTMLUListElement,
    formEl: HTMLFormElement,
    inputEl: HTMLInputElement,
    onAssistantReply?: (args: { userText: string; reply: string; emotion: Emotion | null }) => void | Promise<void>
) {
    // 앱 시작 시 DB의 최근 대화를 불러와 화면과 메모리 이력을 복원합니다.
    messages = [];
    try {
        const recentMessages = await getRecentMessages(40);
        for (const message of recentMessages) {
            const role: ChatRole = message.role === 'assistant' ? 'bot' : 'user';
            appendMessage(messagesEl, role, message.content);
            messages.push({ role: message.role, content: message.content });
        }
    } catch (error) {
        console.warn('최근 대화 복원 실패:', error);
    }

    formEl.addEventListener('submit', async (event) => {
        event.preventDefault();
        lastUserInteractionAt = Date.now();
        lastConversationAt = Date.now();
        const userText = inputEl.value.trim();
        if (!userText) {
            return;
        }

        appendMessage(messagesEl, 'user', userText);
        inputEl.value = '';

        // 메시지 이력 업데이트
        messages.push({
            role: 'user',
            content: userText,
        });

        const loadingEl = appendMessage(messagesEl, 'bot', '생각 중...');

        try {
            // 사용자 입력과 관련된 메모리만 검색해 문맥으로 사용합니다.
            const relatedMemories = await searchRelevantMemories(userText, 10);
            const contextMessages = relatedMemories.length > 0
                ? buildMemoryContext(userText, relatedMemories)
                : messages.slice(-FALLBACK_CONTEXT_SIZE);
            const rawReply = await askOllama(contextMessages);
            const { emotion, visibleReply } = parseEmotionTaggedReply(rawReply);
            loadingEl.remove();
            appendMessage(messagesEl, 'bot', visibleReply);
            lastConversationAt = Date.now();

            if (onAssistantReply) {
                await onAssistantReply({ userText, reply: visibleReply, emotion });
            }

            messages.push({
                role: 'assistant',
                content: visibleReply
            });

            try {
                // 사용자 메시지와 봇 답변을 각각 저장해서 다음 검색 때 재사용합니다.
                await saveMessageToMemory({ role: 'user', content: userText });
                await saveMessageToMemory({ role: 'assistant', content: visibleReply });
            } catch (saveError) {
                console.error('대화 저장 실패:', saveError);
                appendMessage(messagesEl, 'bot', '답변은 완료됐지만 저장에 실패했어요.');
            }
        } catch (error) {
            loadingEl.remove();
            appendMessage(messagesEl, 'bot', '죄송해요, 답변을 가져오는 데 문제가 생겼어요.');
            console.error('Ollama API 호출 실패:', error);
        }

    });
}

// 우측 채팅 패널 접기/펼치기 토글
function setupChatToggle(shellEl: HTMLElement, chatPanelEl: HTMLElement, toggleEl: HTMLButtonElement) {
    toggleEl.addEventListener('click', () => {
        const collapsed = chatPanelEl.classList.toggle('is-collapsed');
        shellEl.classList.toggle('chat-collapsed', collapsed);
        toggleEl.textContent = collapsed ? '채팅 펼치기' : '채팅 접기';
        toggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
}

// 앱 부트스트랩(시작 진입점)
// 1) UI 생성
// 2) 채팅 핸들러 초기화
// 3) PIXI + Live2D 모델 초기화
// 4) 시선/감정반응/샷전환/대기모션 연결
async function init() {
    const appRoot = document.getElementById('app');
    if (!appRoot) {
        throw new Error('#app element not found');
    }

    const { shellEl, chatPanelEl, toggleEl, shotToggleEl, stageEl, messagesEl, formEl, inputEl } = createUI(appRoot);
    setupChatToggle(shellEl, chatPanelEl, toggleEl);
    let onAssistantReply: (args: { userText: string; reply: string; emotion: Emotion | null }) => void | Promise<void> = () => {};
    await setupChat(messagesEl, formEl, inputEl, async (args) => {
        await onAssistantReply(args);
    });

    // 2. PixiJS 앱 생성
    const app = new PIXI.Application({
        resizeTo: stageEl,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio, 1.5),
        powerPreference: 'high-performance',
    });

    // 고주사율 디스플레이에서 60fps 이상 렌더링 가능하도록 티커 상한 설정
    app.ticker.maxFPS = TARGET_MAX_FPS;
    app.ticker.minFPS = TARGET_MIN_FPS;

    stageEl.appendChild(app.view as HTMLCanvasElement);

    console.log('캐릭터 불러오는 중...');

    try {
        // 3. Live2D 모델 로드
        const model = await Live2DModel.from(MODEL_URL);
        app.stage.addChild(model);
        let shotMode: ShotMode = 'full';
        let baseModelScale = 1;
        const modelBaseWidth = model.width;
        const modelBaseHeight = model.height;

        // 4. 모델 위치 및 크기 조절
        // 로드 직후의 원본 width/height를 기준으로 계산해
        // 샷 전환(전신/상반신) 시 스케일 누적 오류를 방지합니다.
        model.anchor.set(0.5, 0.5);
        const fitModelToScreen = () => {
            const width = stageEl.clientWidth;
            const height = stageEl.clientHeight;
            model.x = width / 2;

            const sx = width / modelBaseWidth;
            const sy = height / modelBaseHeight;
            const frameScale = shotMode === 'upper' ? 2.2 : 1;
            const scale = Math.min(sx, sy) * frameScale;
            baseModelScale = scale;
            model.scale.set(scale);

            const frameYRatio = shotMode === 'upper' ? 1.1 : 0.5;
            model.y = height * frameYRatio;
        };

        shotToggleEl.addEventListener('click', () => {
            shotMode = shotMode === 'full' ? 'upper' : 'full';
            shotToggleEl.textContent = shotMode === 'full' ? '상반신 확대' : '전신 보기';
            fitModelToScreen();
        });

        fitModelToScreen();
        window.addEventListener('resize', fitModelToScreen);

        // 자동 시선 상태 머신
        // - 대화 중: 정면 고정
        // - 대화 외: 기본 정면 + 가끔 짧게 두리번
        app.ticker.add(() => {
            const t = performance.now() / 1000;
            const nowMs = Date.now();

            const chattingNow = nowMs - lastConversationAt < CHAT_FRONT_VIEW_MS;
            if (chattingNow) {
                setModelGaze(model, FRONT_GAZE_MODEL_X, FRONT_GAZE_MODEL_Y);
                wanderUntil = 0;
                scheduleNextWander(nowMs);
                return;
            }

            if (wanderUntil === 0 && nowMs >= nextWanderAt) {
                wanderUntil = nowMs + randomInt(WANDER_MIN_DURATION_MS, WANDER_MAX_DURATION_MS);
                scheduleNextWander(wanderUntil);
            }

            if (wanderUntil !== 0 && nowMs <= wanderUntil) {
                const gazeX = FRONT_GAZE_MODEL_X + Math.sin(t * 0.75) * WANDER_GAZE_MODEL_X + Math.sin(t * 1.9) * WANDER_GAZE_MODEL_X * 0.35;
                const gazeY = FRONT_GAZE_MODEL_Y + Math.cos(t * 0.82) * WANDER_GAZE_MODEL_Y;
                setModelGaze(model, gazeX, gazeY);
                return;
            }

            if (wanderUntil !== 0 && nowMs > wanderUntil) {
                wanderUntil = 0;
            }

            setModelGaze(model, FRONT_GAZE_MODEL_X, FRONT_GAZE_MODEL_Y);
        });

        // 어시스턴트 응답이 오면 모델 감정 반응을 실행합니다.
        onAssistantReply = async ({ userText, reply, emotion }) => {
            await triggerModelReaction(model, baseModelScale, userText, reply, emotion);
        };

        // 주기적 대기모션 루프 시작
        startIdleMotionLoop(model);

        console.log('캐릭터 로드 완료!');

    } catch (error) {
        console.error('모델 로드 실패! 경로를 확인하세요:', error);
    }
}

init().catch((error) => {
    console.error('초기화 실패:', error);
});
