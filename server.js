const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // 모든 클라이언트 접속 허용
        methods: ["GET", "POST"]
    }
});

// ============================================================
// ★ [1] Supabase 연결 설정 (Railway 변수 사용)
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("⚠️ [CRITICAL] SUPABASE_URL 또는 SUPABASE_KEY 환경변수가 없습니다. 인증이 불가능합니다.");
}

const supabase = createClient(supabaseUrl || "", supabaseKey || "");

// 활성 연결 관리
const activeConnections = {};

// ★ [선물 맵핑] 게임 밸런스 설정
const GIFT_MAPPING = {
    "5670": { type: "soldier", power: 10 }, // Rose -> Soldier
    "5671": { type: "tank", power: 100 },   // Doughnut -> Tank
    "5678": { type: "boss", power: 1000 }
};

io.on('connection', (socket) => {
    console.log(`[접속] 클라이언트 연결됨 (${socket.id})`);

    // ★ [2] 인증 및 채널 연결 요청 처리
    socket.on('set_channel', async (data) => {
        let tiktokId, apiKey;

        // 데이터 파싱 (객체 vs 문자열 호환성)
        if (typeof data === 'object') {
            tiktokId = data.tiktokId;
            apiKey = data.apiKey;
        } else {
            tiktokId = data; // 구버전 호환용 (인증 불가)
            apiKey = null;
        }

        if (!tiktokId) return;

        console.log(`[요청] ${tiktokId} 연결 시도 (API Key 검증 중...)`);

        // ========================================================
        // ★ [3] 2단계 보안 검사 (Table Lookup -> KV Check)
        // ========================================================
        
        if (!apiKey) {
            console.log(`>> [차단] API Key 누락`);
            socket.emit('auth_error', { msg: "API Key(구독 인증키)가 필요합니다." });
            return; 
        }

        // STEP A: subscriptions 테이블에서 API Key로 user_id 찾기
        const { data: subMap, error: dbError } = await supabase
            .from('subscriptions')
            .select('user_id') 
            .eq('api_key', apiKey)
            .single();

        if (dbError || !subMap || !subMap.user_id) {
            console.log(`>> [차단] 유효하지 않은 API Key: ${apiKey}`);
            socket.emit('auth_error', { msg: "유효하지 않은 인증키입니다." });
            socket.disconnect();
            return;
        }

        const userId = subMap.user_id;

        // STEP B: kv_store_b168a9f6 테이블에서 구독 정보(JSON) 조회
        // Key 패턴: "subscription:{userId}"
        const kvKey = `subscription:${userId}`;
        
        const { data: kvData, error: kvError } = await supabase
            .from('kv_store_b168a9f6')
            .select('value')
            .eq('key', kvKey)
            .single();

        let isSubscribed = false;
        let expireDateStr = "정보 없음";

        if (!kvError && kvData && kvData.value) {
            try {
                // Supabase의 JSONB 컬럼은 자동으로 객체로 변환됨
                const subData = kvData.value;
                expireDateStr = subData.endDate;
                
                // ★ 핵심 로직: 만료일(endDate) 체크
                const endDate = new Date(subData.endDate);
                const now = new Date();

                if (endDate > now) {
                    isSubscribed = true;
                    console.log(`>> [KV 확인] 구독 유효함 (User: ${userId}, 만료: ${expireDateStr})`);
                } else {
                    console.log(`>> [KV 확인] 구독 만료됨 (User: ${userId}, 만료: ${expireDateStr})`);
                }
            } catch (e) {
                console.error("KV 데이터 파싱 중 오류:", e);
            }
        } else {
            console.log(`>> [KV 확인] 구독 데이터 없음 (Key: ${kvKey})`);
        }

        // STEP C: 최종 판단
        if (!isSubscribed) {
            socket.emit('auth_error', { msg: `구독 기간이 만료되었습니다. (만료일: ${expireDateStr})` });
            // 보안을 위해 잠시 후 연결 종료
            setTimeout(() => socket.disconnect(), 1000);
            return;
        }

        console.log(`>> [인증 성공] 방송 연결 시작.`);

        // --- 여기서부터는 기존 연결 로직 ---
        socket.join(tiktokId);
        
        // 이미 서버가 해당 틱톡커와 연결되어 있다면 재사용
        if (activeConnections[tiktokId]) {
            console.log(`>> [최적화] 이미 [${tiktokId}] 방송에 연결되어 있습니다. 공유합니다.`);
            return;
        }

        // 새 틱톡 연결 시작
        startTikTokConnection(tiktokId);
    });
});

// 틱톡 연결 생성 및 이벤트 처리 함수
function startTikTokConnection(tiktokId) {
    let connection = new WebcastPushConnection(tiktokId, {
        processInitialData: false,      // 지난 데이터 무시
        enableExtendedGiftInfo: true,   // 이미지 가져오기
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000
    });

    connection.connect().then(state => {
        console.info(`[연결 성공] ${tiktokId} (RoomID: ${state.roomId})`);
    }).catch(err => {
        console.error(`[연결 실패] ${tiktokId}:`, err);
        // 실패 시 목록에서 삭제하여 재시도 가능하게 함
        delete activeConnections[tiktokId];
    });

    // --- 이벤트 라우팅 ---

    // 1. 선물 (Gift)
    connection.on('gift', data => {
        if (data.giftType === 1 && !data.repeatEnd) return;

        const giftId = data.giftId.toString();
        const coins = data.diamondCount * data.repeatCount;
        
        let gameData = {
            type: 'gift',
            user: data.uniqueId,
            profile: data.profilePictureUrl,
            giftName: data.giftName,
            iconUrl: data.giftPictureUrl,
            coins: coins,
            amount: data.repeatCount,
            unitType: 'none'
        };

        // 맵핑 확인
        if (GIFT_MAPPING[giftId]) {
            gameData.unitType = GIFT_MAPPING[giftId].type;
        } else {
            // 가격 기반 자동 분류
            if (coins >= 100) gameData.unitType = "boss";
            else if (coins >= 10) gameData.unitType = "tank";
            else gameData.unitType = "soldier";
        }

        // 해당 방(tiktokId)에 있는 클라이언트에게만 전송
        io.to(tiktokId).emit('game_event', gameData);
    });

    // 2. 채팅 (Chat)
    connection.on('chat', data => {
        io.to(tiktokId).emit('chat', { user: data.uniqueId, msg: data.comment });
    });

    // 3. 소셜 (Follow, Share, Like)
    connection.on('social', data => {
        let evt = null;
        if (data.displayType.includes('follow')) evt = 'follow';
        if (data.displayType.includes('share')) evt = 'share';
        if (evt) {
            io.to(tiktokId).emit('game_event', { type: evt, user: data.uniqueId });
        }
    });
    
    connection.on('like', data => {
         io.to(tiktokId).emit('game_event', { 
             type: 'like', 
             user: data.uniqueId, 
             count: data.likeCount, 
             total: data.totalLikeCount 
         });
    });

    // 4. 방송 종료 처리
    connection.on('streamEnd', () => {
        console.log(`[방송 종료] ${tiktokId}`);
        delete activeConnections[tiktokId];
    });

    // 활성 목록에 저장
    activeConnections[tiktokId] = connection;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`★ Livooth KV-Auth Server Running on Port ${PORT}`);
});