const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ★ 핵심: 접속된 틱톡 연결들을 관리하는 대장부
// { "bts_official": 연결객체, "ishowspeed": 연결객체 ... }
const activeConnections = {};

io.on('connection', (socket) => {
    console.log(`[클라이언트 접속] 소켓ID: ${socket.id}`);

    // 1. 클라이언트(게임)가 "나 누구랑 연결해줘"라고 요청하면 실행
    socket.on('set_channel', (tiktokId) => {
        if (!tiktokId) return;

        console.log(`[요청] 클라이언트(${socket.id})가 [${tiktokId}] 방송 연결을 요청함.`);
        
        // 소켓을 해당 크리에이터의 '방(Room)'에 입장시킴
        socket.join(tiktokId);

        // 이미 서버가 그 틱톡커와 연결되어 있다면? -> 또 연결할 필요 없음
        if (activeConnections[tiktokId]) {
            console.log(`>> [중복 방지] 이미 [${tiktokId}] 방송에 연결되어 있습니다. 데이터만 공유합니다.`);
            return;
        }

        // 2. 새로운 틱톡커라면 -> 새로 연결 시작!
        startTikTokConnection(tiktokId);
    });
});

// ★ 틱톡 연결을 생성하고 관리하는 함수
function startTikTokConnection(tiktokId) {
    let connection = new WebcastPushConnection(tiktokId, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000
    });

    connection.connect().then(state => {
        console.info(`[연결 성공] ${tiktokId} (RoomID: ${state.roomId})`);
    }).catch(err => {
        console.error(`[연결 실패] ${tiktokId}:`, err);
        // 실패 시 목록에서 삭제 (재시도 가능하게)
        delete activeConnections[tiktokId];
    });

    // 이벤트 리스너 등록
    
    // (1) 선물
    connection.on('gift', data => {
        if (data.giftType === 1 && !data.repeatEnd) return;

        const processedData = {
            type: 'gift',
            user: data.uniqueId,
            giftName: data.giftName,
            coins: data.diamondCount * data.repeatCount,
            iconUrl: data.giftPictureUrl
        };

        // ★ 중요: 이 틱톡커(tiktokId) 방에 있는 사람들에게만 전송!
        io.to(tiktokId).emit('game_event', processedData);
    });

    // (2) 채팅
    connection.on('chat', data => {
        io.to(tiktokId).emit('chat', { user: data.uniqueId, msg: data.comment });
    });

    // ... 필요한 다른 이벤트들도 같은 방식으로 추가 (like, social 등)

    // 연결 목록에 저장
    activeConnections[tiktokId] = connection;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`★ Livooth 멀티 채널 서버 가동 중 (포트: ${PORT})`);
});