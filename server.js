# 🚀 Railway 서버 업데이트 가이드

## Railway 서버 코드 수정

기존 Railway 서버 코드에서 `subscriptions` 테이블 대신 **KV Store만 사용**하도록 수정합니다.

### 📝 수정된 서버 코드

```javascript
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
```

---

## 🔧 Railway 환경변수 설정

Railway 대시보드에서 다음 환경변수를 설정해주세요:

```bash
SUPABASE_URL=https://osxvjqlrzizwvuorjodg.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zeHZqcWxyeml6d3Z1b3Jqb2RnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTY5ODU3MjgwMCwiZXhwIjoyMDE0MTQ4ODAwfQ.YOUR_SERVICE_ROLE_KEY
```

> ⚠️ **중요**: `SUPABASE_KEY`는 반드시 **Service Role Key**를 사용해야 합니다! (Anon Key 아님)

---

## ✅ 테스트 체크리스트

### 1. Railway 서버 배포
- [ ] 코드 수정 완료
- [ ] 환경변수 설정 완료
- [ ] Railway 배포 완료
- [ ] 서버 로그에서 "Supabase 클라이언트 생성 성공" 확인

### 2. 프론트엔드 설정
- [ ] `/utils/websocket.ts`에서 Railway URL 업데이트
  ```typescript
  const railwayUrl = 'https://your-app-name.railway.app';
  ```

### 3. 연결 테스트
1. Livooth Games 웹사이트에 로그인
2. 구독 활성화 (결제 또는 관리자 페이지에서)
3. 게임 라이브러리에서 "틱톡 연결" 버튼 클릭
4. TikTok ID 입력 (예: @username)
5. "연결" 버튼 클릭
6. 상태가 "연결됨"으로 변경되는지 확인

### 4. 게임 테스트
1. 연결 후 게임 플레이
2. TikTok Live 시작
3. 선물 보내기, 채팅, 좋아요 등 테스트
4. 게임에서 이벤트 수신 확인

---

## 🔍 디버깅 가이드

### Railway 서버 로그 확인
```bash
# Railway CLI 설치 (선택사항)
npm install -g @railway/cli

# 로그 확인
railway logs
```

### 브라우저 콘솔 확인
```javascript
// 연결 상태 확인
console.log(tiktokWebSocket.isConnected());

// TikTok ID 확인
console.log(tiktokWebSocket.getTikTokId());
```

### 주요 에러 메시지

| 에러 메시지 | 원인 | 해결 방법 |
|------------|------|----------|
| "API Key가 필요합니다" | API Key 전송 안됨 | 프론트엔드 코드 확인 |
| "유효하지 않은 인증키" | API Key 불일치 | 로그아웃 후 재로그인 |
| "구독이 필요합니다" | 구독 만료 | 관리자 페이지에서 구독 연장 |
| "인증 시스템 오류" | Supabase 연결 실패 | Railway 환경변수 확인 |

---

## 📊 데이터 구조

### KV Store 키 구조
```
api_key:{userId}  →  "lvt_{userId}_{randomUUID}"
subscription:{userId}  →  { endDate, startDate, status, ... }
```

### Socket.io 이벤트
```javascript
// 클라이언트 → 서버
socket.emit('set_channel', {
  tiktokId: '@username',
  apiKey: 'lvt_...'
});

// 서버 → 클라이언트
socket.on('game_event', (data) => {
  // data.type: 'gift', 'follow', 'share', 'like'
  // data.user: TikTok username
  // data.coins: gift coins (if type='gift')
});

socket.on('chat', (data) => {
  // data.user: username
  // data.msg: message
});

socket.on('auth_error', (data) => {
  // data.msg: error message
});