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
// ★ 환경변수 설정
// ============================================================
console.log("---------------------------------------------------");
console.log("[DEBUG] 현재 서버가 인식하는 환경변수 목록 확인:");
console.log("SUPABASE_URL 존재 여부:", !!process.env.SUPABASE_URL);
console.log("SUPABASE_KEY 존재 여부:", !!process.env.SUPABASE_KEY);
if (process.env.SUPABASE_URL) console.log("URL 값:", process.env.SUPABASE_URL);
if (process.env.SUPABASE_KEY) console.log("KEY 길이:", process.env.SUPABASE_KEY.length);
console.log("---------------------------------------------------");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;

// Supabase 연결 시도
if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        console.log("✅ Supabase 클라이언트 생성 성공!");
    } catch (err) {
        console.error("❌ Supabase 클라이언트 생성 에러:", err.message);
    }
} else {
    console.warn("⚠️ [경고] 환경변수가 로드되지 않았습니다. Railway에서 'Redeploy'를 해보세요.");
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
            console.log(`>> [차단] TikTok ID 누락`);
            socket.emit('auth_error', { msg: "TikTok ID가 필요합니다." });
            return;
        }

        console.log(`[요청] ${tiktokId} 연결 시도`);

        // ========================================================
        // ★ API Key 기반 인증 (KV Store만 사용)
        // ========================================================
        
        if (supabase) {
            if (!apiKey) {
                console.log(`>> [차단] API Key 누락`);
                socket.emit('auth_error', { msg: "API Key가 필요합니다." });
                return; 
            }

            try {
                // Step 1: API Key로 User ID 찾기
                console.log(`>> [인증] API Key 검증 중...`);
                
                // KV Store에서 모든 API Key 조회
                const { data: allApiKeys, error: apiKeysError } = await supabase
                    .from('kv_store_b168a9f6')
                    .select('key, value')
                    .like('key', 'api_key:%');

                if (apiKeysError) {
                    console.error('>> [오류] API Key 조회 실패:', apiKeysError);
                    socket.emit('auth_error', { msg: "인증 시스템 오류" });
                    socket.disconnect();
                    return;
                }

                // API Key 매칭
                let userId = null;
                for (const item of allApiKeys || []) {
                    if (item.value === apiKey) {
                        userId = item.key.replace('api_key:', '');
                        break;
                    }
                }

                if (!userId) {
                    console.log(`>> [차단] 유효하지 않은 API Key`);
                    socket.emit('auth_error', { msg: "유효하지 않은 인증키입니다." });
                    socket.disconnect();
                    return;
                }

                console.log(`>> [인증 성공] User ID: ${userId}`);

                // Step 2: 구독 상태 확인 (KV Store)
                const kvKey = `subscription:${userId}`;
                const { data: kvData, error: kvError } = await supabase
                    .from('kv_store_b168a9f6')
                    .select('value')
                    .eq('key', kvKey)
                    .single();

                let isSubscribed = false;
                let expireDateStr = "정보 없음";

                if (!kvError && kvData && kvData.value) {
                    const subData = kvData.value;
                    expireDateStr = subData.endDate;
                    
                    if (new Date(subData.endDate) > new Date()) {
                        isSubscribed = true;
                        console.log(`>> [구독 확인] 구독 유효 (만료일: ${expireDateStr})`);
                    } else {
                        console.log(`>> [구독 만료] 만료일: ${expireDateStr}`);
                    }
                } else {
                    console.log(`>> [구독 없음] 사용자 ${userId}에 대한 구독 정보 없음`);
                }

                if (!isSubscribed) {
                    socket.emit('auth_error', { 
                        msg: `구독이 필요합니다. ${expireDateStr !== "정보 없음" ? `(만료: ${expireDateStr})` : ''}` 
                    });
                    setTimeout(() => socket.disconnect(), 1000);
                    return;
                }

            } catch (error) {
                console.error('>> [오류] 인증 처리 중 에러:', error);
                socket.emit('auth_error', { msg: "인증 처리 중 오류가 발생했습니다." });
                socket.disconnect();
                return;
            }
        } else {
            // Supabase 연결 안됨 (개발 환경)
            console.log("⚠️ [경고] DB 연결 안됨. 인증 없이 접속 허용합니다.");
        }

        console.log(`>> [접속 허용] TikTok Live 연결 시작: ${tiktokId}`);

        socket.join(tiktokId);
        
        // 이미 연결된 경우 중복 연결 방지
        if (activeConnections[tiktokId]) {
            console.log(`>> [알림] ${tiktokId}는 이미 연결되어 있습니다.`);
            return;
        }
        
        startTikTokConnection(tiktokId);
    });

    socket.on('disconnect', () => {
        console.log(`[연결 해제] 클라이언트 (${socket.id})`);
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
        console.info(`[연결 성공] TikTok Live: ${tiktokId}`);
    }).catch(err => {
        console.error(`[연결 실패] ${tiktokId}:`, err);
        delete activeConnections[tiktokId];
    });

    // Gift 이벤트
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

        // Gift ID 매핑
        if (GIFT_MAPPING[giftId]) {
            gameData.unitType = GIFT_MAPPING[giftId].type;
        } else {
            // 코인 기반 매핑
            if (coins >= 100) gameData.unitType = "boss";
            else if (coins >= 10) gameData.unitType = "tank";
            else gameData.unitType = "soldier";
        }

        console.log(`[Gift] ${data.uniqueId} -> ${gameData.unitType} (${coins} coins)`);
        io.to(tiktokId).emit('game_event', gameData);
    });

    // Chat 이벤트
    connection.on('chat', data => {
        console.log(`[Chat] ${data.uniqueId}: ${data.comment}`);
        io.to(tiktokId).emit('chat', { 
            user: data.uniqueId, 
            msg: data.comment 
        });
    });

    // Social 이벤트 (Follow, Share)
    connection.on('social', data => {
        let evt = null;
        if (data.displayType.includes('follow')) evt = 'follow';
        if (data.displayType.includes('share')) evt = 'share';
        
        if (evt) {
            console.log(`[Social] ${data.uniqueId} -> ${evt}`);
            io.to(tiktokId).emit('game_event', { 
                type: evt, 
                user: data.uniqueId 
            });
        }
    });
    
    // Like 이벤트
    connection.on('like', data => {
        console.log(`[Like] ${data.uniqueId} (count: ${data.likeCount})`);
        io.to(tiktokId).emit('game_event', { 
            type: 'like', 
            user: data.uniqueId, 
            count: data.likeCount, 
            total: data.totalLikeCount 
        });
    });

    // Stream End 이벤트
    connection.on('streamEnd', () => {
        console.log(`[방송 종료] ${tiktokId}`);
        delete activeConnections[tiktokId];
    });

    activeConnections[tiktokId] = connection;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`★ Livooth TikTok WebSocket Server Running on Port ${PORT}`);
    console.log(`★ Socket.io enabled with CORS: *`);
    console.log(`★ KV Store authentication: ${supabase ? 'ENABLED' : 'DISABLED (Dev Mode)'}`);
});