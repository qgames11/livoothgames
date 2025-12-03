const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

// 1. 서버 기본 설정
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // 모든 게임 클라이언트 접속 허용
        methods: ["GET", "POST"]
    }
});

// ==========================================
// ★ [설정 구역] 여기에 연결할 틱톡 아이디 입력
// ==========================================
const TIKTOK_USERNAME = "ishowspeed"; // 예시: 현재 방송 중인 아무나, 나중엔 본인 아이디

// ★ [선물 맵핑] 특정 선물이 오면 어떤 유닛을 소환할지 설정
const GIFT_MAPPING = {
    // 예: 선물ID "5670" (장미) -> 보병 소환
    "5670": { type: "soldier", power: 10 }, 
    // 예: 선물ID "5671" (도넛) -> 탱크 소환
    "5671": { type: "tank", power: 100 }
};

// 2. 틱톡 연결 옵션 (안정성 강화)
const tiktokOptions = {
    processInitialData: false,      // 서버 켜기 전 데이터 무시
    enableExtendedGiftInfo: true,   // 선물 이미지 정보 가져오기
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 2000  // 2초마다 연결 상태 확인
};

let tiktokConnection = new WebcastPushConnection(TIKTOK_USERNAME, tiktokOptions);

// 3. 틱톡 라이브 연결 시도
console.log(`[시스템] ${TIKTOK_USERNAME}님의 방송에 연결을 시도합니다...`);

tiktokConnection.connect().then(state => {
    console.info(`[연결 성공] 방 ID: ${state.roomId}`);
}).catch(err => {
    console.error(`[연결 실패] ${TIKTOK_USERNAME}님이 방송 중이 아니거나 오류가 발생했습니다.`, err);
});

// ==========================================
// 4. 이벤트 처리 (틱톡 -> 게임)
// ==========================================

// (1) 선물 (Gift) - 핵심 로직
tiktokConnection.on('gift', data => {
    // 콤보 중간 생략 (마지막 콤보나 단일 선물만 처리)
    if (data.giftType === 1 && !data.repeatEnd) return;

    const giftId = data.giftId.toString();
    const coins = data.diamondCount * data.repeatCount;
    const userName = data.uniqueId;
    const userProfile = data.profilePictureUrl;

    console.log(`[선물] ${userName}: ${data.giftName} (코인: ${coins})`);

    let gameData = {
        type: 'gift',
        user: userName,
        profile: userProfile,
        giftName: data.giftName,
        iconUrl: data.giftPictureUrl,
        coins: coins,
        amount: data.repeatCount,
        action: 'spawn_unit', // 기본 액션
        unitType: 'none'      // 유닛 종류
    };

    // A. 맵핑된 선물인지 확인
    if (GIFT_MAPPING[giftId]) {
        gameData.unitType = GIFT_MAPPING[giftId].type;
        console.log(`>> [특수 효과] 지정된 선물: ${gameData.unitType}`);
    } 
    // B. 맵핑 안 된 선물은 가격으로 자동 분류
    else {
        if (coins >= 100) gameData.unitType = "boss";
        else if (coins >= 10) gameData.unitType = "tank";
        else if (coins >= 1) gameData.unitType = "soldier";
        console.log(`>> [일반 효과] 가격 비례: ${gameData.unitType}`);
    }

    // 게임으로 전송
    io.emit('game_event', gameData);
});

// (2) 소셜 이벤트 (팔로우, 공유)
tiktokConnection.on('social', data => {
    let eventType = null;
    if (data.displayType.includes('follow')) eventType = 'follow';
    if (data.displayType.includes('share')) eventType = 'share';

    if (eventType) {
        console.log(`[소셜] ${data.uniqueId}님이 ${eventType} 했습니다.`);
        io.emit('game_event', {
            type: eventType,
            user: data.uniqueId
        });
    }
});

// (3) 채팅 (Chat)
tiktokConnection.on('chat', data => {
    io.emit('chat', {
        user: data.uniqueId,
        msg: data.comment
    });
});

// (4) 좋아요 (Like)
tiktokConnection.on('like', data => {
    io.emit('game_event', {
        type: 'like',
        user: data.uniqueId,
        count: data.likeCount,
        total: data.totalLikeCount
    });
});

// 5. 클라이언트 접속 확인
io.on('connection', (socket) => {
    console.log('[게임] 클라이언트 접속됨 ID:', socket.id);
});

// 6. 서버 시작 (클라우드 포트 사용)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('--------------------------------------------------');
    console.log(`★ Livooth 게임 서버 가동 중 (포트: ${PORT})`);
    console.log('--------------------------------------------------');
});