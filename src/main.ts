import './style.css';
import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import { askOllama, type OllamaMessage } from './services/ollama';
import { loadChatFromBackend, saveChatToBackend } from './services/chatStorage';

// 메시지 이력 저장
let messages: OllamaMessage[] = [];

// 1. 모델 경로 설정 (본인의 폴더명에 맞게 수정하세요)
const MODEL_URL = '/huohuo/huohuo.model3.json'; 
//IceGirl_Live2d/IceGIrl Live2D/IceGirl.model3.json

const TARGET_MAX_FPS = 120;
const TARGET_MIN_FPS = 30;

// pixi-live2d-display가 PIXI 전역 객체를 참조합니다.
(window as any).PIXI = PIXI;

type ChatRole = 'user' | 'bot';
type Emotion = 'happy' | 'curious' | 'sad' | 'angry' | 'surprised' | 'neutral';
type ShotMode = 'full' | 'upper';
const EMOTION_TAGS: Emotion[] = ['happy', 'curious', 'sad', 'angry', 'surprised', 'neutral'];

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

let lastReactionAt = 0;
let lastUserInteractionAt = 0;
let lastConversationAt = 0;
let resetToDefaultTimer: number | null = null;
let idleMotionTimer: number | null = null;
let lastIdleMotionGroup = 'idle';
let nextWanderAt = Date.now() + 12000;
let wanderUntil = 0;

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function scheduleNextWander(baseTimeMs: number) {
    nextWanderAt = baseTimeMs + randomInt(WANDER_MIN_INTERVAL_MS, WANDER_MAX_INTERVAL_MS);
}

function setModelGaze(model: Live2DModel, x: number, y: number, instant = false) {
    const controller = (model as any).internalModel?.focusController;
    if (controller?.focus) {
        controller.focus(x, y, instant);
    }
}

function stopAllModelMotions(model: Live2DModel) {
    const motionManager = (model as any).internalModel?.motionManager;
    motionManager?.stopAllMotions?.();
}

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

function detectEmotion(text: string): Emotion {
    if (EMOTION_KEYWORDS.angry.test(text)) return 'angry';
    if (EMOTION_KEYWORDS.sad.test(text)) return 'sad';
    if (EMOTION_KEYWORDS.surprised.test(text)) return 'surprised';
    if (EMOTION_KEYWORDS.happy.test(text)) return 'happy';
    if (EMOTION_KEYWORDS.curious.test(text)) return 'curious';
    return 'neutral';
}

function detectForcedEmotionFromUserText(text: string): Emotion | null {
    for (const emotion of EMOTION_TAGS) {
        if (USER_EMOTION_COMMANDS[emotion].test(text)) {
            return emotion;
        }
    }
    return null;
}

function parseEmotionTaggedReply(rawReply: string): { emotion: Emotion | null; visibleReply: string } {
    const match = rawReply.match(/^\s*\((happy|curious|sad|angry|surprised|neutral)\)\s*/i);
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

async function triggerModelReaction(
    model: Live2DModel,
    baseScale: number,
    userText: string,
    reply: string,
    forcedEmotion?: Emotion | null
) {
    const forcedByUserCommand = detectForcedEmotionFromUserText(userText);
    const inferredEmotion = detectEmotion(`${userText} ${reply}`);
    const emotion = forcedByUserCommand ?? forcedEmotion ?? inferredEmotion;

    const now = Date.now();
    if (now - lastReactionAt < 450) {
        return;
    }
    lastReactionAt = now;

    const expressionByEmotion: Partial<Record<Emotion, string>> = {
        happy: 'qizi1',
        curious: 'qizi2',
        angry: 'angry',
        sad: 'cry',
        surprised: 'baozhen',
    };
    const motionByEmotion: Partial<Record<Emotion, string>> = {
        happy: 'linghun',
        curious: 'haoqi',
        sad: 'keshui',
        angry: 'zhentou',
        surprised: 'yaotou',
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
        }
    } catch (reactionError) {
        console.debug('Live2D expression/motion trigger skipped:', reactionError);
    }

    console.log('[reaction]', { emotion, forcedByUserCommand, forcedEmotion, inferredEmotion });

    // Fallback visual reaction so the model always feels responsive.
    animateReaction(model, baseScale, emotion);
    scheduleReturnToDefault(model);
}

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

function appendMessage(messagesEl: HTMLUListElement, role: ChatRole, text: string) {
    const li = document.createElement('li');
    li.className = `message ${role}`;
    li.textContent = text;
    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    return li;
}

async function setupChat(
    messagesEl: HTMLUListElement,
    formEl: HTMLFormElement,
    inputEl: HTMLInputElement,
    onAssistantReply?: (args: { userText: string; reply: string; emotion: Emotion | null }) => void | Promise<void>
) {
    // Keep conversation memory, but start UI from a clean chat window on reload.
    messages = await loadChatFromBackend('huohuo');

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
            // 전체 이력과 함께 요청
            const rawReply = await askOllama(messages);
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
                await saveChatToBackend(messages, 'huohuo');
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

function setupChatToggle(shellEl: HTMLElement, chatPanelEl: HTMLElement, toggleEl: HTMLButtonElement) {
    toggleEl.addEventListener('click', () => {
        const collapsed = chatPanelEl.classList.toggle('is-collapsed');
        shellEl.classList.toggle('chat-collapsed', collapsed);
        toggleEl.textContent = collapsed ? '채팅 펼치기' : '채팅 접기';
        toggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
}

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

    // High refresh displays can render above 60 FPS when ticker caps are raised.
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

        // Auto gaze: gently scan around without following mouse.
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

        onAssistantReply = async ({ userText, reply, emotion }) => {
            await triggerModelReaction(model, baseModelScale, userText, reply, emotion);
        };

        startIdleMotionLoop(model);

        console.log('캐릭터 로드 완료!');

    } catch (error) {
        console.error('모델 로드 실패! 경로를 확인하세요:', error);
    }
}

init().catch((error) => {
    console.error('초기화 실패:', error);
});