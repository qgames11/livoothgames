const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// ============================================================
// ★ [1] 환경변수 설정 (Supabase & Session ID)
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
// ★ 틱톡 로그인 세션 ID 추가 (옵션)
const tiktokSessionId = process.env.TIKTOK_SESSION_ID; 

console.log("---------------------------------------------------");
console.log("[DEBUG] 서버 환경변수 로드 상태:");
console.log("SUPABASE_URL:", !!supabaseUrl ? "OK" : "MISSING");
console.log("TIKTOK_SESSION_ID:", !!tiktokSessionId ? "OK (안정성 강화)" : "MISSING (익명 접속)");
console.log("---------------------------------------------------");

let supabase = null;

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        console.log("✅ Supabase 클라이언트 연결 성공");
    } catch (err) {
        console.error("❌ Supabase 연결 에러:", err.message);
    }
} else {
    console.warn("⚠️ [경고] SUPABASE 환경변수 누락. Railway 설정을 확인하세요.");
}

const activeConnections = {};

const GIFT_MAPPING = {
    "5670": { type: "soldier", power: 10 },
    "5671": { type: "tank", power: 100 },
    "5678": { type: "boss", power: 1000 }
};

io.on('connection', (socket) => {
    console.log(`[접속] 클라이언트 연결됨 (${socket.id})`);

    socket.on('set_channel', async (data) => {
        let tiktokId, apiKey;

        if (typeof data === 'object') {
            tiktokId = data.tiktokId;
            apiKey = data.apiKey;
        } else {
            tiktokId = data;
            apiKey = null;
        }

        if (!tiktokId) {
            socket.emit('auth_error', { msg: "TikTok ID가 필요합니다." });
            return;
        }

        console.log(`[요청] ${tiktokId} 연결 시도 (API Key: ${apiKey ? '***' : '없음'})`);

        // ========================================================
        // ★ API Key 기반 인증
        // ========================================================
        
        if (supabase) {
            if (!apiKey) {
                console.log(`>> [차단] API Key 누락`);
                socket.emit('auth_error', { msg: "API Key가 필요합니다." });
                return; 
            }

            try {
                // Step 1: API Key 검증
                const { data: keyData, error: keyError } = await supabase
                    .from('kv_store_b168a9f6')
                    .select('key')
                    .eq('value', apiKey)
                    .like('key', 'api_key:%')
                    .maybeSingle();

                if (keyError || !keyData) {
                    console.log(`>> [차단] 유효하지 않은 API Key: ${apiKey}`);
                    socket.emit('auth_error', { msg: "유효하지 않은 인증키입니다." });
                    setTimeout(() => socket.disconnect(), 1000);
                    return;
                }

                const userId = keyData.key.replace('api_key:', '');
                console.log(`>> [인증 성공] User ID: ${userId}`);

                // Step 2: 구독 만료일 확인
                const kvKey = `subscription:${userId}`;
                const { data: subDataRaw, error: subError } = await supabase
                    .from('kv_store_b168a9f6')
                    .select('value')
                    .eq('key', kvKey)
                    .single();

                let isSubscribed = false;
                let expireDateStr = "정보 없음";

                if (!subError && subDataRaw && subDataRaw.value) {
                    const subInfo = subDataRaw.value;
                    expireDateStr = subInfo.endDate;
                    
                    if (new Date(subInfo.endDate) > new Date()) {
                        isSubscribed = true;
                        console.log(`>> [구독 유효] 만료일: ${expireDateStr}`);
                    } else {
                        console.log(`>> [구독 만료] 만료일: ${expireDateStr}`);
                    }
                }

                if (!isSubscribed) {
                    socket.emit('auth_error', { 
                        msg: `구독이 만료되었습니다. (만료일: ${expireDateStr})` 
                    });
                    setTimeout(() => socket.disconnect(), 1000);
                    return;
                }

            } catch (error) {
                console.error('>> [오류] 인증 처리 예외:', error);
                socket.emit('auth_error', { msg: "인증 처리 중 오류 발생" });
                return;
            }
        } else {
            console.warn("⚠️ [경고] DB 연결 안됨. 개발 모드로 접속 허용.");
        }

        console.log(`>> [접속 허용] 방송 연결 시작: ${tiktokId}`);

        socket.join(tiktokId);
        
        if (activeConnections[tiktokId]) {
            console.log(`>> [알림] 이미 연결된 방송입니다.`);
            return;
        }
        
        startTikTokConnection(tiktokId);
    });

    socket.on('disconnect', () => {
        // console.log(`[연결 해제] ${socket.id}`);
    });
});

function startTikTokConnection(tiktokId) {
    // ★ Session ID 적용 (환경변수에 있으면 사용)
    let options = {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000
    };

    if (tiktokSessionId) {
        options.sessionId = tiktokSessionId;
        // console.log(`>> [Info] Session ID를 사용하여 접속합니다.`);
    }

    let connection = new WebcastPushConnection(tiktokId, options);

    connection.connect().then(state => {
        console.info(`[연결 성공] RoomID: ${state.roomId}`);
    }).catch(err => {
        console.error(`[연결 실패] ${tiktokId}:`, err);
        delete activeConnections[tiktokId];
    });

    connection.on('gift', data => {
        if (data.giftType === 1 && !data.repeatEnd) return;
        
        const giftId = data.giftId.toString();
        const coins = data.diamondCount * data.repeatCount;
        
        let gameData = {
            type: 'gift',
            user: data.uniqueId,
            giftName: data.giftName,
            iconUrl: data.giftPictureUrl,
            coins: coins,
            amount: data.repeatCount,
            unitType: 'none'
        };

        if (GIFT_MAPPING[giftId]) {
            gameData.unitType = GIFT_MAPPING[giftId].type;
        } else {
            if (coins >= 100) gameData.unitType = "boss";
            else if (coins >= 10) gameData.unitType = "tank";
            else gameData.unitType = "soldier";
        }

        io.to(tiktokId).emit('game_event', gameData);
    });

    connection.on('chat', data => {
        io.to(tiktokId).emit('chat', { user: data.uniqueId, msg: data.comment });
    });

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

    connection.on('streamEnd', () => {
        console.log(`[방송 종료] ${tiktokId}`);
        delete activeConnections[tiktokId];
    });

    activeConnections[tiktokId] = connection;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`★ Livooth Server Running on Port ${PORT}`);
});