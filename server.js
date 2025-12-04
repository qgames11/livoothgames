const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

// CORS 설정
app.use(cors());

// Socket.io 설정
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

// TikTok Live 연결 관리
const tiktokConnections = new Map(); // userId -> TikTok connection
const userSockets = new Map();       // userId -> socket.io socket
const apiKeys = new Map();           // apiKey -> userId

console.log('🚀 Livooth WebSocket Server Starting...');

// ============================================
// 헬스 체크 엔드포인트
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Livooth Games WebSocket Server',
    connections: {
      tiktok: tiktokConnections.size,
      sockets: userSockets.size,
    },
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============================================
// Socket.io 연결 관리
// ============================================

io.on('connection', (socket) => {
  console.log('✅ New socket connection:', socket.id);

  // ============================================
  // TikTok 채널 설정
  // ============================================
  socket.on('set_channel', async (data) => {
    const { tiktokId, apiKey } = data;

    console.log('📥 set_channel received:', { tiktokId, apiKey: apiKey ? 'present' : 'missing' });

    if (!tiktokId || !apiKey) {
      socket.emit('auth_error', { msg: 'Missing tiktokId or apiKey' });
      return;
    }

    // TODO: Validate API key against your database
    // For now, we'll use it as a unique identifier
    const userId = apiKey; // In production, validate and get userId from database

    // Store socket for this user
    userSockets.set(userId, socket);
    apiKeys.set(apiKey, userId);
    socket.userId = userId;
    socket.tiktokId = tiktokId;

    console.log('✅ User associated:', { userId, tiktokId });

    // 기존 연결이 있으면 종료
    if (tiktokConnections.has(userId)) {
      console.log('🔄 Disconnecting existing TikTok connection for user:', userId);
      const oldConnection = tiktokConnections.get(userId);
      try {
        oldConnection.disconnect();
      } catch (err) {
        console.error('Error disconnecting old connection:', err);
      }
      tiktokConnections.delete(userId);
    }

    // TikTok Live 연결 시작
    try {
      await connectToTikTokLive(tiktokId, userId, socket);
    } catch (error) {
      console.error('❌ Failed to connect to TikTok Live:', error);
      socket.emit('auth_error', { 
        msg: 'Failed to connect to TikTok Live: ' + error.message 
      });
    }
  });

  // ============================================
  // 소켓 연결 해제
  // ============================================
  socket.on('disconnect', () => {
    console.log('🔌 Socket disconnected:', socket.id);

    if (socket.userId) {
      const userId = socket.userId;
      
      // Remove user socket
      if (userSockets.get(userId) === socket) {
        userSockets.delete(userId);
        console.log('👤 User socket removed:', userId);
      }

      // Disconnect TikTok Live connection
      if (tiktokConnections.has(userId)) {
        const connection = tiktokConnections.get(userId);
        try {
          connection.disconnect();
          console.log('🔌 TikTok Live connection closed for user:', userId);
        } catch (err) {
          console.error('Error disconnecting TikTok:', err);
        }
        tiktokConnections.delete(userId);
      }
    }
  });
});

// ============================================
// TikTok Live 연결 함수
// ============================================

async function connectToTikTokLive(tiktokUsername, userId, socket) {
  console.log('🔗 Connecting to TikTok Live:', tiktokUsername);

  // @ 제거
  const username = tiktokUsername.replace('@', '');

  // TikTok Live Connector 초기화
  const tiktokConnection = new WebcastPushConnection(username, {
    processInitialData: true,
    enableExtendedGiftInfo: true,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 1000,
  });

  // ============================================
  // TikTok 이벤트 리스너
  // ============================================

  // 연결 성공
  tiktokConnection.on('connected', (state) => {
    console.log('✅ TikTok Live connected:', username);
    console.log('📊 Stream info:', {
      roomId: state.roomId,
      uniqueId: state.uniqueId,
    });

    socket.emit('tiktok_connected', {
      username,
      roomId: state.roomId,
    });
  });

  // 연결 해제
  tiktokConnection.on('disconnected', () => {
    console.log('🔌 TikTok Live disconnected:', username);
    socket.emit('tiktok_disconnected', { username });
  });

  // 에러 처리
  tiktokConnection.on('error', (error) => {
    console.error('❌ TikTok Live error:', error);
    socket.emit('tiktok_error', { 
      msg: error.message || 'Unknown error' 
    });
  });

  // ============================================
  // 선물 이벤트
  // ============================================
  tiktokConnection.on('gift', (data) => {
    console.log('🎁 Gift received:', {
      username: data.uniqueId,
      giftName: data.giftName,
      count: data.repeatCount,
    });

    const eventData = {
      type: 'gift',
      username: data.uniqueId,
      giftName: data.giftName,
      giftId: data.giftId,
      count: data.repeatCount,
      diamondCount: data.diamondCount,
      timestamp: Date.now(),
    };

    socket.emit('game_event', eventData);
  });

  // ============================================
  // 좋아요 이벤트
  // ============================================
  tiktokConnection.on('like', (data) => {
    console.log('❤️ Like received:', {
      username: data.uniqueId,
      count: data.likeCount,
    });

    const eventData = {
      type: 'like',
      username: data.uniqueId,
      count: data.likeCount,
      totalLikes: data.totalLikeCount,
      timestamp: Date.now(),
    };

    socket.emit('game_event', eventData);
  });

  // ============================================
  // 공유 이벤트
  // ============================================
  tiktokConnection.on('share', (data) => {
    console.log('🔗 Share received:', {
      username: data.uniqueId,
    });

    const eventData = {
      type: 'share',
      username: data.uniqueId,
      timestamp: Date.now(),
    };

    socket.emit('game_event', eventData);
  });

  // ============================================
  // 팔로우 이벤트
  // ============================================
  tiktokConnection.on('follow', (data) => {
    console.log('👥 Follow received:', {
      username: data.uniqueId,
    });

    const eventData = {
      type: 'follow',
      username: data.uniqueId,
      timestamp: Date.now(),
    };

    socket.emit('game_event', eventData);
  });

  // ============================================
  // 채팅 메시지
  // ============================================
  tiktokConnection.on('chat', (data) => {
    console.log('💬 Chat received:', {
      username: data.uniqueId,
      message: data.comment,
    });

    const chatData = {
      username: data.uniqueId,
      message: data.comment,
      timestamp: Date.now(),
    };

    socket.emit('chat', chatData);
  });

  // ============================================
  // 스트림 종료
  // ============================================
  tiktokConnection.on('streamEnd', () => {
    console.log('📺 Stream ended:', username);
    socket.emit('stream_end', { username });
  });

  // ============================================
  // TikTok Live 연결 시작
  // ============================================

  try {
    await tiktokConnection.connect();
    
    // 연결 저장
    tiktokConnections.set(userId, tiktokConnection);
    
    console.log('✅ TikTok Live connection established for:', username);
  } catch (error) {
    console.error('❌ Failed to connect to TikTok Live:', error);
    throw error;
  }
}

// ============================================
// 서버 시작
// ============================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('🚀 Livooth WebSocket Server running on port:', PORT);
  console.log('🌐 Server URL: http://localhost:' + PORT);
  console.log('🎮 Ready to accept game connections!');
});

// ============================================
// 프로세스 종료 처리
// ============================================

process.on('SIGINT', () => {
  console.log('\n⚠️ Shutting down server...');
  
  // Disconnect all TikTok connections
  for (const [userId, connection] of tiktokConnections.entries()) {
    try {
      connection.disconnect();
      console.log('🔌 Disconnected TikTok connection for user:', userId);
    } catch (err) {
      console.error('Error disconnecting:', err);
    }
  }
  
  server.close(() => {
    console.log('👋 Server shut down successfully');
    process.exit(0);
  });
});