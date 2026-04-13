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

const EMOTION_KEYWORDS: Record<Emotion, RegExp> = {
    happy: /(좋|고마|축하|행복|기쁘|최고|love|great|awesome|nice|thanks)/i,
    curious: /(궁금|왜|어떻게|설명|질문|what|how|why|\?)/i,
    sad: /(슬프|우울|눈물|힘들|미안|sorry|sad|depress|cry)/i,
    angry: /(화나|짜증|열받|분노|angry|mad|annoy)/i,
    surprised: /(헉|와|놀라|대박|진짜|omg|wow|surpris)/i,
    neutral: /$^/
};

function detectEmotion(text: string): Emotion {
    if (EMOTION_KEYWORDS.angry.test(text)) return 'angry';
    if (EMOTION_KEYWORDS.sad.test(text)) return 'sad';
    if (EMOTION_KEYWORDS.surprised.test(text)) return 'surprised';
    if (EMOTION_KEYWORDS.happy.test(text)) return 'happy';
    if (EMOTION_KEYWORDS.curious.test(text)) return 'curious';
    return 'neutral';
}

function animateReaction(model: Live2DModel, baseScale: number, emotion: Emotion) {
    const durationMs = 520;
    const start = performance.now();
    const initialRotation = model.rotation;
    const ampByEmotion: Record<Emotion, number> = {
        happy: 0.06,
        curious: 0.04,
        sad: 0.025,
        angry: 0.08,
        surprised: 0.1,
        neutral: 0.03,
    };
    const scaleBoostByEmotion: Record<Emotion, number> = {
        happy: 0.05,
        curious: 0.03,
        sad: -0.01,
        angry: 0.04,
        surprised: 0.07,
        neutral: 0.02,
    };

    const amplitude = ampByEmotion[emotion];
    const scaleBoost = scaleBoostByEmotion[emotion];

    const tick = (now: number) => {
        const t = Math.min((now - start) / durationMs, 1);
        const easeOut = 1 - Math.pow(1 - t, 3);
        const swing = Math.sin(t * Math.PI * 2.4) * (1 - easeOut);

        model.rotation = initialRotation + swing * amplitude;
        model.scale.set(baseScale * (1 + scaleBoost * (1 - easeOut)));

        if (t < 1) {
            requestAnimationFrame(tick);
        } else {
            model.rotation = initialRotation;
            model.scale.set(baseScale);
        }
    };

    requestAnimationFrame(tick);
}

async function triggerModelReaction(model: Live2DModel, baseScale: number, reply: string) {
    const emotion = detectEmotion(reply);
    const expressionByEmotion: Partial<Record<Emotion, string>> = {
        angry: 'angry',
        sad: 'cry',
        surprised: 'baozhen',
    };
    const motionByEmotion: Partial<Record<Emotion, string>> = {
        happy: 'qizi',
        curious: 'haoqi',
        sad: 'keshui',
        angry: 'zhentou',
        surprised: 'yaotou',
    };

    try {
        const expressionId = expressionByEmotion[emotion];
        if (expressionId) {
            await model.expression(expressionId);
        }

        const motionGroup = motionByEmotion[emotion];
        if (motionGroup) {
            await model.motion(motionGroup);
        }
    } catch (reactionError) {
        console.debug('Live2D expression/motion trigger skipped:', reactionError);
    }

    // Fallback visual reaction so the model always feels responsive.
    animateReaction(model, baseScale, emotion);
}

function createUI(appRoot: HTMLElement) {
    appRoot.innerHTML = `
      <div class="vt-shell">
        <section id="stage" aria-label="Live2D character stage"></section>
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
    onAssistantReply?: (reply: string) => void | Promise<void>
) {
    // Keep conversation memory, but start UI from a clean chat window on reload.
    messages = await loadChatFromBackend('huohuo');

    formEl.addEventListener('submit', async (event) => {
        event.preventDefault();
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
            const reply = await askOllama(messages);
            loadingEl.remove();
            appendMessage(messagesEl, 'bot', reply);

            if (onAssistantReply) {
                await onAssistantReply(reply);
            }

            messages.push({
                role: 'assistant',
                content: reply
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

    const { shellEl, chatPanelEl, toggleEl, stageEl, messagesEl, formEl, inputEl } = createUI(appRoot);
    setupChatToggle(shellEl, chatPanelEl, toggleEl);
    let onAssistantReply: (reply: string) => void | Promise<void> = () => {};
    await setupChat(messagesEl, formEl, inputEl, async (reply) => {
        await onAssistantReply(reply);
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
        let baseModelScale = 1;

        // 4. 모델 위치 및 크기 조절
        model.anchor.set(0.5, 0.5);
        const fitModelToScreen = () => {
            const width = stageEl.clientWidth;
            const height = stageEl.clientHeight;
            model.x = width / 2;
            model.y = height / 2;

            const sx = width / model.width;
            const sy = height / model.height;
            const scale = Math.min(sx, sy) * 1;
            baseModelScale = scale;
            model.scale.set(scale);
        };

        fitModelToScreen();
        window.addEventListener('resize', fitModelToScreen);

        // 마우스 시선 추적 기능 추가
        app.ticker.add(() => {
            const interaction = (app.renderer.plugins as any).interaction;
            if (!interaction) return;

            model.focus(interaction.mouse.global.x, interaction.mouse.global.y);
        });

        onAssistantReply = async (reply) => {
            await triggerModelReaction(model, baseModelScale, reply);
        };

        console.log('캐릭터 로드 완료!');

    } catch (error) {
        console.error('모델 로드 실패! 경로를 확인하세요:', error);
    }
}

init().catch((error) => {
    console.error('초기화 실패:', error);
});