/**
 * ConnectionManager - WebSocket 연결 및 네트워크 통신 관리
 * 
 * 주요 기능:
 * 1. WebSocket 연결 생성 및 관리
 * 2. 자동 재연결 (지수 백오프)
 * 3. 연결 품질 모니터링
 * 4. 메시지 큐잉 및 전송 보장
 * 5. Y.js WebSocket 프로바이더 통합
 * 
 * @class ConnectionManager
 */

import EventEmitter from 'eventemitter3';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

export class ConnectionManager extends EventEmitter {
  constructor(serverUrl, options = {}) {
    super();
    
    // 서버 설정
    this.serverUrl = serverUrl;
    this.options = {
      maxReconnectAttempts: 5,         // 최대 재연결 시도
      reconnectInterval: 1000,         // 초기 재연결 간격 (ms)
      maxReconnectInterval: 30000,     // 최대 재연결 간격 (ms)
      reconnectDecay: 1.5,             // 재연결 간격 증가율
      heartbeatInterval: 30000,        // 하트비트 간격 (ms)
      messageTimeout: 5000,            // 메시지 타임아웃 (ms)
      enableCompression: true,         // 메시지 압축 사용
      queueOfflineMessages: true,      // 오프라인 메시지 큐잉
      ...options
    };
    
    // 연결 상태
    this.connectionState = {
      status: 'disconnected',          // 'connecting', 'connected', 'reconnecting', 'disconnected'
      quality: 'unknown',              // 'excellent', 'good', 'fair', 'poor'
      latency: 0,                      // 평균 지연 시간 (ms)
      reconnectAttempts: 0,            // 재연결 시도 횟수
      lastConnectedAt: null,           // 마지막 연결 시간
      lastDisconnectedAt: null         // 마지막 연결 해제 시간
    };
    
    // 메시지 관리
    this.messageQueue = [];            // 오프라인 메시지 큐
    this.pendingMessages = new Map();  // 응답 대기 중인 메시지
    this.messageIdCounter = 0;         // 메시지 ID 카운터
    
    // 성능 메트릭
    this.metrics = {
      messagesSent: 0,
      messagesReceived: 0,
      bytesOut: 0,
      bytesIn: 0,
      latencySamples: [],
      connectionUptime: 0
    };
    
    // WebSocket 및 Y.js 프로바이더
    this.websocket = null;
    this.yjsProvider = null;
    this.pingInterval = null;
    this.metricsInterval = null;
  }
  
  /**
   * WebSocket 연결 초기화
   * @public
   * @param {Y.Doc} ydoc - Y.js 문서
   * @param {string} roomId - 협업 룸 ID
   * @returns {Promise<void>}
   */
  async connect(ydoc, roomId) {
    try {
      this._updateConnectionState('connecting');
      
      // ReconnectingWebSocket 생성
      this.websocket = new ReconnectingWebSocket(
        `${this.serverUrl}/collaboration/${roomId}`,
        [],
        {
          maxReconnectAttempts: this.options.maxReconnectAttempts,
          reconnectInterval: this.options.reconnectInterval,
          maxReconnectInterval: this.options.maxReconnectInterval,
          reconnectDecay: this.options.reconnectDecay
        }
      );
      
      // WebSocket 이벤트 핸들러 설정
      this._setupWebSocketHandlers();
      
      // Y.js WebSocket 프로바이더 생성
      this.yjsProvider = new WebsocketProvider(
        this.serverUrl,
        roomId,
        ydoc,
        {
          WebSocketPolyfill: ReconnectingWebSocket,
          awareness: this._createAwareness(ydoc),
          params: {
            auth: this.options.authToken
          }
        }
      );
      
      // 프로바이더 이벤트 핸들러 설정
      this._setupProviderHandlers();
      
      // 연결 완료 대기
      await this._waitForConnection();
      
      // 하트비트 시작
      this._startHeartbeat();
      
      // 메트릭 수집 시작
      this._startMetricsCollection();
      
      this.emit('connected', { roomId });
      
    } catch (error) {
      this._updateConnectionState('disconnected');
      this.emit('connectionError', { error });
      throw error;
    }
  }
  
  /**
   * WebSocket 이벤트 핸들러 설정
   * @private
   */
  _setupWebSocketHandlers() {
    // 연결 열림
    this.websocket.addEventListener('open', () => {
      this._updateConnectionState('connected');
      this.connectionState.lastConnectedAt = Date.now();
      this.connectionState.reconnectAttempts = 0;
      
      // 큐에 있는 메시지 전송
      this._flushMessageQueue();
      
      this.emit('websocketOpen');
    });
    
    // 연결 닫힘
    this.websocket.addEventListener('close', (event) => {
      this._updateConnectionState('disconnected');
      this.connectionState.lastDisconnectedAt = Date.now();
      
      this.emit('websocketClose', { code: event.code, reason: event.reason });
    });
    
    // 에러 발생
    this.websocket.addEventListener('error', (error) => {
      this.emit('websocketError', { error });
    });
    
    // 메시지 수신
    this.websocket.addEventListener('message', (event) => {
      this._handleMessage(event.data);
    });
  }
  
  /**
   * Y.js 프로바이더 이벤트 핸들러 설정
   * @private
   */
  _setupProviderHandlers() {
    // 동기화 상태 변경
    this.yjsProvider.on('sync', (isSynced) => {
      this.emit('syncStateChanged', { isSynced });
    });
    
    // 연결 상태 변경
    this.yjsProvider.on('status', ({ status }) => {
      if (status === 'connected') {
        this._updateConnectionState('connected');
      } else if (status === 'disconnected') {
        this._updateConnectionState('disconnected');
      }
    });
    
    // Awareness 업데이트
    this.yjsProvider.awareness.on('update', ({ added, updated, removed }) => {
      this.emit('awarenessUpdate', { added, updated, removed });
    });
  }
  
  /**
   * 연결 완료 대기
   * @private
   * @returns {Promise<void>}
   */
  _waitForConnection() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 30000);
      
      const checkConnection = () => {
        if (this.connectionState.status === 'connected') {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkConnection, 100);
        }
      };
      
      checkConnection();
    });
  }
  
  /**
   * 하트비트 시작
   * @private
   */
  _startHeartbeat() {
    this.pingInterval = setInterval(() => {
      if (this.connectionState.status === 'connected') {
        this._sendPing();
      }
    }, this.options.heartbeatInterval);
  }
  
  /**
   * Ping 전송 및 지연 시간 측정
   * @private
   */
  _sendPing() {
    const pingId = `ping-${Date.now()}`;
    const startTime = performance.now();
    
    this.sendMessage({
      type: 'ping',
      id: pingId,
      timestamp: Date.now()
    });
    
    // Pong 응답 대기
    this.once(`pong-${pingId}`, () => {
      const latency = performance.now() - startTime;
      this._updateLatency(latency);
    });
    
    // 타임아웃 처리
    setTimeout(() => {
      this.off(`pong-${pingId}`);
      this._updateConnectionQuality('poor');
    }, this.options.messageTimeout);
  }
  
  /**
   * 지연 시간 업데이트
   * @private
   * @param {number} latency 
   */
  _updateLatency(latency) {
    // 지연 시간 샘플 추가
    this.metrics.latencySamples.push(latency);
    
    // 최근 10개 샘플만 유지
    if (this.metrics.latencySamples.length > 10) {
      this.metrics.latencySamples.shift();
    }
    
    // 평균 지연 시간 계산
    const avgLatency = this.metrics.latencySamples.reduce((a, b) => a + b, 0) 
      / this.metrics.latencySamples.length;
    
    this.connectionState.latency = Math.round(avgLatency);
    
    // 연결 품질 업데이트
    if (avgLatency < 50) {
      this._updateConnectionQuality('excellent');
    } else if (avgLatency < 150) {
      this._updateConnectionQuality('good');
    } else if (avgLatency < 300) {
      this._updateConnectionQuality('fair');
    } else {
      this._updateConnectionQuality('poor');
    }
  }
  
  /**
   * 메시지 처리
   * @private
   * @param {string|ArrayBuffer} data 
   */
  _handleMessage(data) {
    try {
      // 바이너리 데이터 처리 (Y.js 업데이트)
      if (data instanceof ArrayBuffer) {
        this.metrics.bytesIn += data.byteLength;
        return;
      }
      
      // JSON 메시지 처리
      const message = JSON.parse(data);
      this.metrics.messagesReceived++;
      this.metrics.bytesIn += data.length;
      
      switch (message.type) {
        case 'pong':
          this.emit(`pong-${message.id}`);
          break;
          
        case 'error':
          this._handleErrorMessage(message);
          break;
          
        case 'notification':
          this.emit('notification', message.data);
          break;
          
        case 'collaboratorJoined':
          this.emit('collaboratorJoined', message.data);
          break;
          
        case 'collaboratorLeft':
          this.emit('collaboratorLeft', message.data);
          break;
          
        case 'conflictDetected':
          this.emit('conflictDetected', message.data);
          break;
          
        default:
          // 응답 대기 중인 메시지 처리
          if (message.id && this.pendingMessages.has(message.id)) {
            const { resolve } = this.pendingMessages.get(message.id);
            this.pendingMessages.delete(message.id);
            resolve(message);
          } else {
            this.emit('message', message);
          }
      }
    } catch (error) {
      console.error('Message handling error:', error);
    }
  }
  
  /**
   * 에러 메시지 처리
   * @private
   * @param {Object} message 
   */
  _handleErrorMessage(message) {
    const { code, description, context } = message.data;
    
    // 특정 에러 코드 처리
    switch (code) {
      case 'RATE_LIMIT_EXCEEDED':
        this._handleRateLimit();
        break;
        
      case 'INVALID_DOCUMENT':
        this.emit('documentError', { code, description });
        break;
        
      case 'UNAUTHORIZED':
        this.emit('authenticationError', { code, description });
        break;
        
      default:
        this.emit('serverError', { code, description, context });
    }
  }
  
  /**
   * 속도 제한 처리
   * @private
   */
  _handleRateLimit() {
    // 메시지 전송 일시 중단
    this.rateLimited = true;
    
    setTimeout(() => {
      this.rateLimited = false;
      this._flushMessageQueue();
    }, 60000); // 1분 후 재시도
    
    this.emit('rateLimitExceeded');
  }
  
  /**
   * 메시지 전송
   * @public
   * @param {Object} message 
   * @returns {Promise<Object>}
   */
  sendMessage(message) {
    return new Promise((resolve, reject) => {
      // 메시지 ID 할당
      if (!message.id) {
        message.id = `msg-${++this.messageIdCounter}`;
      }
      
      // 오프라인이거나 속도 제한 중인 경우 큐에 추가
      if (this.connectionState.status !== 'connected' || this.rateLimited) {
        if (this.options.queueOfflineMessages) {
          this.messageQueue.push({ message, resolve, reject });
          return;
        } else {
          reject(new Error('Not connected'));
          return;
        }
      }
      
      try {
        // 메시지 압축 (옵션)
        const data = this.options.enableCompression 
          ? this._compressMessage(message)
          : JSON.stringify(message);
          
        // 전송
        this.websocket.send(data);
        
        // 메트릭 업데이트
        this.metrics.messagesSent++;
        this.metrics.bytesOut += data.length;
        
        // 응답이 필요한 경우 대기 목록에 추가
        if (message.requiresResponse) {
          this.pendingMessages.set(message.id, { resolve, reject });
          
          // 타임아웃 설정
          setTimeout(() => {
            if (this.pendingMessages.has(message.id)) {
              this.pendingMessages.delete(message.id);
              reject(new Error('Message timeout'));
            }
          }, this.options.messageTimeout);
        } else {
          resolve({ sent: true });
        }
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * 메시지 압축
   * @private
   * @param {Object} message 
   * @returns {string}
   */
  _compressMessage(message) {
    // 간단한 압축 구현 (실제로는 더 효율적인 압축 알고리즘 사용)
    const json = JSON.stringify(message);
    
    // 작은 메시지는 압축하지 않음
    if (json.length < 1000) {
      return json;
    }
    
    // TODO: 실제 압축 구현
    return json;
  }
  
  /**
   * 메시지 큐 비우기
   * @private
   */
  _flushMessageQueue() {
    while (this.messageQueue.length > 0 && 
           this.connectionState.status === 'connected' && 
           !this.rateLimited) {
      const { message, resolve, reject } = this.messageQueue.shift();
      this.sendMessage(message).then(resolve).catch(reject);
    }
  }
  
  /**
   * 연결 상태 업데이트
   * @private
   * @param {string} status 
   */
  _updateConnectionState(status) {
    const previousStatus = this.connectionState.status;
    this.connectionState.status = status;
    
    if (previousStatus !== status) {
      this.emit('connectionStateChanged', { 
        previousStatus, 
        currentStatus: status 
      });
    }
  }
  
  /**
   * 연결 품질 업데이트
   * @private
   * @param {string} quality 
   */
  _updateConnectionQuality(quality) {
    const previousQuality = this.connectionState.quality;
    this.connectionState.quality = quality;
    
    if (previousQuality !== quality) {
      this.emit('connectionQualityChanged', { 
        previousQuality, 
        currentQuality: quality 
      });
    }
  }
  
  /**
   * Awareness 생성
   * @private
   * @param {Y.Doc} ydoc 
   * @returns {Object}
   */
  _createAwareness(ydoc) {
    const awareness = this.yjsProvider?.awareness || new Awareness(ydoc);
    
    // 로컬 사용자 정보 설정
    awareness.setLocalStateField('user', {
      id: this.options.userId,
      name: this.options.userName,
      color: this.options.userColor || this._generateUserColor()
    });
    
    return awareness;
  }
  
  /**
   * 사용자 색상 생성
   * @private
   * @returns {string}
   */
  _generateUserColor() {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
      '#FECA57', '#FF9FF3', '#54A0FF', '#48DBFB'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }
  
  /**
   * 메트릭 수집 시작
   * @private
   */
  _startMetricsCollection() {
    const startTime = Date.now();
    
    this.metricsInterval = setInterval(() => {
      if (this.connectionState.status === 'connected') {
        this.metrics.connectionUptime = Date.now() - startTime;
      }
      
      this.emit('metricsUpdate', { ...this.metrics });
    }, 5000); // 5초마다 메트릭 업데이트
  }
  
  /**
   * 연결 끊기
   * @public
   */
  disconnect() {
    // 하트비트 중지
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    // 메트릭 수집 중지
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    
    // Y.js 프로바이더 정리
    if (this.yjsProvider) {
      this.yjsProvider.destroy();
      this.yjsProvider = null;
    }
    
    // WebSocket 연결 종료
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
    
    // 상태 초기화
    this._updateConnectionState('disconnected');
    this.messageQueue = [];
    this.pendingMessages.clear();
    
    this.emit('disconnected');
  }
  
  /**
   * 재연결 시도
   * @public
   */
  reconnect() {
    if (this.connectionState.status === 'connected') {
      return;
    }
    
    this.connectionState.reconnectAttempts++;
    this._updateConnectionState('reconnecting');
    
    // WebSocket 재연결은 ReconnectingWebSocket이 자동으로 처리
    this.emit('reconnecting', { 
      attempt: this.connectionState.reconnectAttempts 
    });
  }
  
  /**
   * 연결 상태 가져오기
   * @public
   * @returns {Object}
   */
  getConnectionState() {
    return { ...this.connectionState };
  }
  
  /**
   * 메트릭 가져오기
   * @public
   * @returns {Object}
   */
  getMetrics() {
    return { ...this.metrics };
  }
  
  /**
   * 리소스 정리
   * @public
   */
  destroy() {
    this.disconnect();
    this.removeAllListeners();
  }
}