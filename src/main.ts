import './style.css';
import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';

// 1. 모델 경로 설정 (본인의 폴더명에 맞게 수정하세요)
const MODEL_URL = '/huohuo/huohuo.model3.json'; 
//IceGirl_Live2d/IceGIrl Live2D/IceGirl.model3.json

const TARGET_MAX_FPS = 120;
const TARGET_MIN_FPS = 30;

// pixi-live2d-display가 PIXI 전역 객체를 참조합니다.
(window as any).PIXI = PIXI;

type ChatRole = 'user' | 'bot';

const BOT_REPLIES = [
    '좋아, 지금 분위기 정말 좋아요. 어떤 이야기부터 해볼까요?',
    '음, 그 아이디어 괜찮다. 더 구체적으로 풀어볼까요?',
    '알겠어. 핵심만 정리해서 바로 적용 가능한 형태로 답해볼게요.',
    '재밌네. 이번엔 조금 다른 방식으로도 시도해볼 수 있어요.',
    '좋아요. 지금 흐름 그대로 이어서 다음 단계로 가봅시다.'
];

function createUI(appRoot: HTMLElement) {
    appRoot.innerHTML = `
      <div class="vt-shell">
        <section id="stage" aria-label="Live2D character stage"></section>
        <aside class="chat-panel" aria-label="chat panel">
          <header class="chat-head">
            <p class="chip">LIVE CHAT</p>
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
}

function setupChat(messagesEl: HTMLUListElement, formEl: HTMLFormElement, inputEl: HTMLInputElement) {
    appendMessage(messagesEl, 'bot', '안녕! 오늘은 어떤 기능을 같이 만들어볼까?');

    formEl.addEventListener('submit', (event) => {
        event.preventDefault();
        const userText = inputEl.value.trim();
        if (!userText) {
            return;
        }

        appendMessage(messagesEl, 'user', userText);
        inputEl.value = '';

        const reply = BOT_REPLIES[Math.floor(Math.random() * BOT_REPLIES.length)];
        window.setTimeout(() => {
            appendMessage(messagesEl, 'bot', reply);
        }, 500);
    });
}

async function init() {
    const appRoot = document.getElementById('app');
    if (!appRoot) {
        throw new Error('#app element not found');
    }

    const { stageEl, messagesEl, formEl, inputEl } = createUI(appRoot);
    setupChat(messagesEl, formEl, inputEl);

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

        console.log('캐릭터 로드 완료!');

    } catch (error) {
        console.error('모델 로드 실패! 경로를 확인하세요:', error);
    }
}

init().catch((error) => {
    console.error('초기화 실패:', error);
});