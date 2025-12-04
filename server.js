/**
 * Livooth Interactive Game SDK v3.2.0 (Flexible Data)
 * (c) 2025 Livooth Agency
 *
 * [핵심 변경 사항]
 * - SDK 내부의 유닛 등급 분류(soldier/tank 등) 로직 삭제
 * - 개발자가 직접 코인 수량과 선물을 판단하도록 Raw Data 전달
 */

class Livooth {
    static init(options = {}) {
        const instance = new Livooth(options);
        if (options.autoConnect !== false) {
            instance._tryAutoConnect();
        }
        return instance;
    }

    constructor(options = {}) {
        this.SERVER_URL = "https://livoothgames-production.up.railway.app";
        this.socket = null;
        this.debug = options.debug || false;
        this.urlParams = new URLSearchParams(window.location.search);
        this.recentEvents = new Map();
        this.DEDUP_TIME = 500; 

        this.callbacks = {
            onConnect: [], onDisconnect: [], onError: [],
            onGift: [], onChat: [], onLike: [], onSocial: [],
            onGameState: [], onConnected: [], onVerified: []
        };

        if (this.debug) console.log("[Livooth SDK] 🔍 Initializing v3.2.0 (Flexible)");
    }

    _tryAutoConnect() {
        const tiktokId = this.urlParams.get('tiktokId');
        const apiKey = this.urlParams.get('apiKey');
        if (tiktokId && apiKey) this.connect(tiktokId, apiKey);
    }

    _checkDependencies() {
        if (typeof io === 'undefined') throw new Error("[Livooth SDK] 'socket.io-client' missing.");
    }

    // 중복 방지 로직 (유지)
    _isDuplicate(data) {
        const uniqueKey = [
            data.type,
            data.user || data.username,
            data.giftName || data.msg || '',
            data.amount || 0,
            data.coins || 0
        ].join('_');

        const now = Date.now();
        if (this.recentEvents.has(uniqueKey)) {
            if (now - this.recentEvents.get(uniqueKey) < this.DEDUP_TIME) return true; 
        }
        this.recentEvents.set(uniqueKey, now);
        if (this.recentEvents.size > 200) { /* GC Logic */ }
        return false;
    }

    connect(tiktokId, apiKey) {
        this._checkDependencies();

        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
        }

        if (!tiktokId || !apiKey) {
            this._trigger('onError', { code: 'MISSING_PARAMS', msg: 'ID/Key required.' });
            return;
        }

        this.socket = io(this.SERVER_URL, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            forceNew: true
        });

        this.socket.on('connect', () => {
            if (this.debug) console.log("[Livooth] Connected.");
            this.socket.emit('set_channel', { tiktokId, apiKey });
            this._trigger('onConnect');
            this._trigger('onConnected');
        });

        this.socket.on('auth_error', (data) => {
            this._trigger('onError', { code: 'AUTH_FAILED', msg: data.msg });
        });

        this.socket.on('game_event', (data) => {
            if (this._isDuplicate(data)) return;
            if (this.debug) console.log("[Event]", data);
            
            // 데이터 표준화
            if (data.user && !data.username) data.username = data.user;

            // ★ 수정됨: SDK가 임의로 유닛 타입을 결정하지 않음.
            // 모든 판단은 개발자에게 위임.
            
            switch (data.type) {
                case 'gift':
                    this._trigger('onGift', data);
                    break;
                case 'like':
                    this._trigger('onLike', data);
                    break;
                case 'follow':
                case 'share':
                    this._trigger('onSocial', data); // type: 'follow' or 'share'
                    break;
            }
        });

        this.socket.on('chat', (data) => {
            if (data.user && !data.username) data.username = data.user;
            if (data.msg && !data.message) data.message = data.msg;
            this._trigger('onChat', data);
        });

        this.socket.on('disconnect', (r) => this._trigger('onDisconnect', r));
        this.socket.on('connect_error', (e) => this._trigger('onError', { msg: e.message }));
    }

    disconnect() {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.disconnect();
            this.socket = null;
        }
    }

    onGift(cb) { this._addListener('onGift', cb); }
    onChat(cb) { this._addListener('onChat', cb); }
    onLike(cb) { this._addListener('onLike', cb); }
    onShare(cb) { this._addListener('onShare', cb); }
    onFollow(cb) { this._addListener('onFollow', cb); }
    onSocial(cb) { this._addListener('onSocial', cb); }
    onConnected(cb) { this._addListener('onConnected', cb); }
    onError(cb) { this._addListener('onError', cb); }
    on(e, cb) { this._addListener(e, cb); }

    _addListener(event, cb) {
        if (!this.callbacks[event]) this.callbacks[event] = [];
        this.callbacks[event].push(cb);
    }

    _trigger(event, data) {
        if (this.callbacks[event]) {
            this.callbacks[event].forEach(cb => {
                try { cb(data); } catch (e) { console.error(e); }
            });
        }
    }
}

if (typeof window !== 'undefined') window.Livooth = Livooth;
if (typeof module !== 'undefined') module.exports = Livooth;