import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';

// 1. 모델 경로 설정 (본인의 폴더명에 맞게 수정하세요)
const MODEL_URL = '/huohuo/huohuo.model3.json'; 
//IceGirl_Live2d/IceGIrl Live2D/IceGirl.model3.json

// pixi-live2d-display가 PIXI 전역 객체를 참조합니다.
(window as any).PIXI = PIXI;

async function init() {
    const appRoot = document.getElementById('app');
    if (!appRoot) {
        throw new Error('#app element not found');
    }

    // 2. PixiJS 앱 생성
    const app = new PIXI.Application({
        resizeTo: window,
        backgroundAlpha: 0,
        antialias: true,
    });
    appRoot.appendChild(app.view as HTMLCanvasElement);

    console.log('캐릭터 불러오는 중...');

    try {
        // 3. Live2D 모델 로드
        const model = await Live2DModel.from(MODEL_URL);
        app.stage.addChild(model);

        // 4. 모델 위치 및 크기 조절
        model.anchor.set(0.1, 0.1);
        const fitModelToScreen = () => {
            model.x = window.innerWidth / 2;
            model.y = window.innerHeight / 2;

            const sx = window.innerWidth / model.width;
            const sy = window.innerHeight / model.height;
            const scale = Math.min(sx, sy) * 0.6;
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