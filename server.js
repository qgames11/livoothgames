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
// ★ [1] 환경변수 디버깅 (로그 확인용)
// ============================================================
console.log("---------------------------------------------------");
console.log("[DEBUG] 현재 서버가 인식하는 환경변수 목록 확인:");
console.log("SUPABASE_URL 존재 여부:", !!process.env.SUPABASE_URL);
console.log("SUPABASE_KEY 존재 여부:", !!process.env.SUPABASE_KEY);
// 보안을 위해 값의 일부만 출력하거나 길이만 출력
if (process.env.SUPABASE_URL) console.log("URL 값:", process.env.SUPABASE_URL);
if (process.env.SUPABASE_KEY) console.log("KEY 길이:", process.env.SUPABASE_KEY.length);
console.log("---------------------------------------------------");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;

// 안전하게 연결 시도
if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        console.log("✅ Supabase 클라이언트 생성 성공!");
    } catch (err) {
        console.error("❌ Supabase 클라이언트 생성 에러:", err.message);
    }
} else {
    console.warn("⚠️ [경고] 변수가 로드되지 않았습니다. Railway에서 'Redeploy'를 해보세요.");
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

        if (!tiktokId) return;

        console.log(`[요청] ${tiktokId} 연결 시도`);

        // ========================================================
        // ★ [3] 2단계 보안 검사 (Supabase가 연결된 경우에만 실행)
        // ========================================================
        
        if (supabase) {
            if (!apiKey) {
                console.log(`>> [차단] API Key 누락`);
                socket.emit('auth_error', { msg: "API Key가 필요합니다." });
                return; 
            }

            // A. subscriptions 테이블 조회
            const { data: subMap, error: dbError } = await supabase
                .from('subscriptions')
                .select('user_id') 
                .eq('api_key', apiKey)
                .single();

            if (dbError || !subMap || !subMap.user_id) {
                console.log(`>> [차단] 유효하지 않은 Key: ${apiKey}`);
                socket.emit('auth_error', { msg: "유효하지 않은 인증키입니다." });
                socket.disconnect();
                return;
            }

            const userId = subMap.user_id;

            // B. KV Store (kv_store_b168a9f6) 조회
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
                    const subData = kvData.value;
                    expireDateStr = subData.endDate;
                    
                    if (new Date(subData.endDate) > new Date()) {
                        isSubscribed = true;
                        console.log(`>> [KV 확인] 구독 유효 (User: ${userId})`);
                    } else {
                        console.log(`>> [KV 확인] 구독 만료 (User: ${userId})`);
                    }
                } catch (e) {
                    console.error("KV 파싱 에러:", e);
                }
            }

            if (!isSubscribed) {
                socket.emit('auth_error', { msg: `구독이 만료되었습니다. (${expireDateStr})` });
                setTimeout(() => socket.disconnect(), 1000);
                return;
            }
        } else {
            // Supabase 변수가 없어서 연결 못 했을 때 (개발 중 편의 기능)
            console.log("⚠️ [경고] DB 연결 안됨. 인증 없이 접속 허용합니다.");
        }

        console.log(`>> [접속 허용] 방송 연결 시작.`);

        socket.join(tiktokId);
        if (activeConnections[tiktokId]) return;
        startTikTokConnection(tiktokId);
    });
});

function startTikTokConnection(tiktokId) {
    let connection = new WebcastPushConnection(tiktokId, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000
    });

    connection.connect().then(state => {
        console.info(`[연결 성공] ${tiktokId}`);
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

        if (GIFT_MAPPING[giftId]) gameData.unitType = GIFT_MAPPING[giftId].type;
        else {
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
        if (evt) io.to(tiktokId).emit('game_event', { type: evt, user: data.uniqueId });
    });
    
    connection.on('like', data => {
         io.to(tiktokId).emit('game_event', { 
             type: 'like', user: data.uniqueId, count: data.likeCount, total: data.totalLikeCount 
         });
    });

    connection.on('streamEnd', () => {
        delete activeConnections[tiktokId];
    });

    activeConnections[tiktokId] = connection;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`★ Livooth Server Running on Port ${PORT}`);
});