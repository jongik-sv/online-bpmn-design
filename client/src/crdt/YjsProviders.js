/**
 * YjsProviders - Y.js 프로바이더 설정 및 관리
 * 
 * 주요 기능:
 * 1. WebSocket 프로바이더 설정 및 관리
 * 2. IndexedDB 영속성 프로바이더
 * 3. WebRTC 프로바이더 (P2P 통신)
 * 4. 프로바이더 간 동기화 조정
 * 5. 연결 상태 관리 및 모니터링
 * 
 * @module YjsProviders
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import { Awareness } from 'y-protocols/awareness';
import EventEmitter from 'eventemitter3';

/**
 * 프로바이더 매니저 클래스
 */
export class ProviderManager extends EventEmitter {
  constructor(doc, options = {}) {
    super();
    
    this.doc = doc;
    this.options = {
      enableWebSocket: true,
      enableIndexedDB: true,
      enableWebRTC: false,
      websocketUrl: 'ws://localhost:3000',
      room: 'default-room',
      userId: 'anonymous',
      userName: 'Anonymous User',
      ...options
    };
    
    // 프로바이더 인스턴스들
    this.providers = {
      websocket: null,
      indexeddb: null,
      webrtc: null
    };
    
    // 연결 상태
    this.connectionStates = {
      websocket: 'disconnected',
      indexeddb: 'disconnected',
      webrtc: 'disconnected'
    };
    
    // 통계
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      syncEvents: 0,
      connectionAttempts: 0,
      lastSyncTime: null
    };
    
    this.isInitialized = false;
  }
  
  /**
   * 프로바이더 초기화
   * @public
   */
  async initialize() {
    if (this.isInitialized) {
      return;
    }
    
    try {
      // IndexedDB 프로바이더 (로컬 영속성)
      if (this.options.enableIndexedDB) {
        await this._initializeIndexedDB();
      } else {
        this.connectionStates.indexeddb = 'disabled';
        this.emit('providerDisabled', { type: 'indexeddb', reason: 'Disabled in configuration' });
      }
      
      // WebSocket 프로바이더 (서버 통신)
      if (this.options.enableWebSocket) {
        await this._initializeWebSocket();
      } else {
        this.connectionStates.websocket = 'disabled';
        this.emit('providerDisabled', { type: 'websocket', reason: 'Disabled in configuration' });
      }
      
      // WebRTC 프로바이더 (P2P 통신)
      if (this.options.enableWebRTC) {
        await this._initializeWebRTC();
      } else {
        this.connectionStates.webrtc = 'disabled';
        this.emit('providerDisabled', { type: 'webrtc', reason: 'Disabled in configuration' });
      }
      
      this.isInitialized = true;
      this.emit('initialized');
      
    } catch (error) {
      this.emit('error', { type: 'initialization', error });
      throw error;
    }
  }
  
  /**
   * IndexedDB 프로바이더 초기화
   * @private
   */
  async _initializeIndexedDB() {
    return new Promise((resolve, reject) => {
      try {
        // IndexedDB 비활성화 (메모리 누수 방지)
        console.warn('IndexedDB persistence disabled to prevent memory leaks');
        this.connectionStates.indexeddb = 'disabled';
        this.emit('providerDisabled', { type: 'indexeddb', reason: 'Memory leak prevention' });
        resolve();
        
        // 필요시 나중에 안전한 설정으로 재활성화 가능:
        /*
        this.providers.indexeddb = new IndexeddbPersistence(
          `bpmn-collaboration-${this.options.room}`,
          this.doc,
          {
            disableGC: true,  // 가비지 컬렉션 비활성화
            maxUpdates: 100   // 최대 업데이트 수 제한
          }
        );
        
        this.providers.indexeddb.on('synced', () => {
          this.connectionStates.indexeddb = 'connected';
          this.emit('providerConnected', { type: 'indexeddb' });
          resolve();
        });
        
        this.providers.indexeddb.on('error', (error) => {
          console.error('IndexedDB error:', error);
          this.connectionStates.indexeddb = 'error';
          this.emit('providerError', { type: 'indexeddb', error });
          reject(error);
        });
        */
        
      } catch (error) {
        console.error('IndexedDB initialization failed:', error);
        this.connectionStates.indexeddb = 'error';
        resolve(); // 에러여도 계속 진행
      }
    });
  }
  
  /**
   * WebSocket 프로바이더 초기화
   * @private
   */
  async _initializeWebSocket() {
    return new Promise((resolve, reject) => {
      try {
        this.providers.websocket = new WebsocketProvider(
          this.options.websocketUrl,
          this.options.room,
          this.doc,
          {
            connect: true,
            awareness: this._createAwareness(),
            params: {
              userId: this.options.userId,
              userName: this.options.userName
            },
            // 재연결 설정
            maxBackoffTime: 30000,
            disableBc: true,              // BroadcastChannel 비활성화 (무한 재귀 방지)
            // 추가 안전 설정
            resyncInterval: -1,           // 자동 재동기화 비활성화
            maxBackoffTime: 30000,
            bcTimeout: 0                  // BroadcastChannel 타임아웃 비활성화
          }
        );
        
        // 이벤트 핸들러 설정
        this._setupWebSocketHandlers(resolve, reject);
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * WebSocket 이벤트 핸들러 설정
   * @private
   */
  _setupWebSocketHandlers(resolve, reject) {
    const wsProvider = this.providers.websocket;
    
    // 연결 상태 변경
    wsProvider.on('status', ({ status }) => {
      this.connectionStates.websocket = status;
      
      if (status === 'connected') {
        this.emit('providerConnected', { type: 'websocket' });
        if (resolve) {
          resolve();
          resolve = null; // 한번만 호출
        }
      } else if (status === 'disconnected') {
        this.emit('providerDisconnected', { type: 'websocket' });
      }
    });
    
    // 동기화 상태
    wsProvider.on('sync', (isSynced) => {
      if (isSynced) {
        this.stats.syncEvents++;
        this.stats.lastSyncTime = Date.now();
        this.emit('providerSynced', { type: 'websocket' });
      }
    });
    
    // 연결 에러
    wsProvider.on('connection-error', (error) => {
      this.connectionStates.websocket = 'error';
      this.emit('providerError', { type: 'websocket', error });
      if (reject) {
        reject(error);
        reject = null;
      }
    });
    
    // Awareness 이벤트
    if (wsProvider.awareness) {
      wsProvider.awareness.on('change', ({ added, updated, removed }) => {
        this.emit('awarenessChange', { added, updated, removed });
      });
    }
    
    // 연결 시도 타임아웃
    setTimeout(() => {
      if (this.connectionStates.websocket !== 'connected' && reject) {
        reject(new Error('WebSocket connection timeout'));
        reject = null;
      }
    }, 15000);
  }
  
  /**
   * WebRTC 프로바이더 초기화
   * @private
   */
  async _initializeWebRTC() {
    return new Promise((resolve, reject) => {
      try {
        this.providers.webrtc = new WebrtcProvider(
          this.options.room,
          this.doc,
          {
            signaling: ['wss://signaling.yjs.dev'],
            password: this.options.webrtcPassword || null,
            awareness: this._createAwareness(),
            maxConns: 20,
            filterBcConns: true,
            peerOpts: {}
          }
        );
        
        // WebRTC 이벤트 핸들러
        this._setupWebRTCHandlers(resolve, reject);
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * WebRTC 이벤트 핸들러 설정
   * @private
   */
  _setupWebRTCHandlers(resolve, reject) {
    const rtcProvider = this.providers.webrtc;
    
    rtcProvider.on('status', ({ status }) => {
      this.connectionStates.webrtc = status;
      
      if (status === 'connected') {
        this.emit('providerConnected', { type: 'webrtc' });
        if (resolve) {
          resolve();
          resolve = null;
        }
      }
    });
    
    rtcProvider.on('peers', ({ added, removed }) => {
      this.emit('peersChanged', { added, removed });
    });
    
    // 타임아웃
    setTimeout(() => {
      if (this.connectionStates.webrtc !== 'connected' && resolve) {
        // WebRTC는 선택사항이므로 타임아웃을 에러로 처리하지 않음
        resolve();
        resolve = null;
      }
    }, 20000);
  }
  
  /**
   * Awareness 객체 생성
   * @private
   */
  _createAwareness() {
    const awareness = new Awareness(this.doc);
    
    // 로컬 사용자 정보 설정
    awareness.setLocalStateField('user', {
      id: this.options.userId,
      name: this.options.userName,
      color: this._generateUserColor(),
      cursor: { x: 0, y: 0 },
      selection: []
    });
    
    return awareness;
  }
  
  /**
   * 사용자 색상 생성
   * @private
   */
  _generateUserColor() {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
      '#FECA57', '#FF9FF3', '#54A0FF', '#48DBFB',
      '#FF6B9D', '#C44569', '#786FA6', '#F8B500'
    ];
    
    // 사용자 ID 기반으로 일관된 색상 선택
    const hash = this._hashString(this.options.userId);
    return colors[hash % colors.length];
  }
  
  /**
   * 문자열 해시 생성
   * @private
   */
  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 32비트 정수로 변환
    }
    return Math.abs(hash);
  }
  
  /**
   * 특정 프로바이더 재연결
   * @public
   */
  async reconnectProvider(type) {
    const provider = this.providers[type];
    if (!provider) {
      throw new Error(`Provider ${type} not initialized`);
    }
    
    this.stats.connectionAttempts++;
    
    switch (type) {
      case 'websocket':
        if (provider.shouldConnect && !provider.wsconnected) {
          provider.connect();
        }
        break;
        
      case 'webrtc':
        provider.connect();
        break;
        
      case 'indexeddb':
        // IndexedDB는 자동으로 관리됨
        break;
    }
  }
  
  /**
   * 모든 프로바이더 재연결
   * @public
   */
  async reconnectAll() {
    const promises = [];
    
    Object.keys(this.providers).forEach(type => {
      if (this.providers[type] && this.connectionStates[type] !== 'connected') {
        promises.push(this.reconnectProvider(type).catch(error => {
          console.warn(`Failed to reconnect ${type}:`, error);
        }));
      }
    });
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Awareness 상태 업데이트
   * @public
   */
  updateAwareness(updates) {
    Object.values(this.providers).forEach(provider => {
      if (provider && provider.awareness) {
        const currentState = provider.awareness.getLocalState();
        const newState = { ...currentState, ...updates };
        provider.awareness.setLocalState(newState);
      }
    });
  }
  
  /**
   * 사용자 커서 위치 업데이트
   * @public
   */
  updateCursor(cursor) {
    this.updateAwareness({ cursor });
  }
  
  /**
   * 사용자 선택 영역 업데이트
   * @public
   */
  updateSelection(selection) {
    this.updateAwareness({ selection });
  }
  
  /**
   * 연결 상태 확인
   * @public
   */
  getConnectionStates() {
    return { ...this.connectionStates };
  }
  
  /**
   * 연결된 사용자 목록 가져오기
   * @public
   */
  getConnectedUsers() {
    const users = new Map();
    
    Object.values(this.providers).forEach(provider => {
      if (provider && provider.awareness) {
        provider.awareness.getStates().forEach((state, clientId) => {
          if (state.user && !users.has(state.user.id)) {
            users.set(state.user.id, {
              ...state.user,
              clientId,
              provider: provider.constructor.name
            });
          }
        });
      }
    });
    
    return Array.from(users.values());
  }
  
  /**
   * 프로바이더 통계 가져오기
   * @public
   */
  getStats() {
    return {
      ...this.stats,
      connectionStates: this.getConnectionStates(),
      connectedUsers: this.getConnectedUsers().length,
      totalProviders: Object.keys(this.providers).length,
      activeProviders: Object.values(this.connectionStates).filter(
        state => state === 'connected'
      ).length
    };
  }
  
  /**
   * 문서 상태 강제 동기화
   * @public
   */
  forceSync() {
    Object.values(this.providers).forEach(provider => {
      if (provider && typeof provider.sync === 'function') {
        provider.sync();
      }
    });
  }
  
  /**
   * 프로바이더 연결 해제
   * @public
   */
  disconnect(type = null) {
    if (type) {
      // 특정 프로바이더 연결 해제
      const provider = this.providers[type];
      if (provider) {
        if (typeof provider.disconnect === 'function') {
          provider.disconnect();
        } else if (typeof provider.destroy === 'function') {
          provider.destroy();
        }
        this.connectionStates[type] = 'disconnected';
        this.emit('providerDisconnected', { type });
      }
    } else {
      // 모든 프로바이더 연결 해제
      Object.keys(this.providers).forEach(providerType => {
        this.disconnect(providerType);
      });
    }
  }
  
  /**
   * 리소스 정리
   * @public
   */
  destroy() {
    // 모든 프로바이더 정리
    Object.entries(this.providers).forEach(([type, provider]) => {
      if (provider) {
        try {
          if (typeof provider.destroy === 'function') {
            provider.destroy();
          } else if (typeof provider.disconnect === 'function') {
            provider.disconnect();
          }
        } catch (error) {
          console.warn(`Error destroying ${type} provider:`, error);
        }
      }
    });
    
    // 상태 초기화
    this.providers = {};
    this.connectionStates = {};
    this.isInitialized = false;
    
    // 이벤트 리스너 정리
    this.removeAllListeners();
    
    this.emit('destroyed');
  }
}

/**
 * 헬퍼 함수들
 */

/**
 * 기본 프로바이더 매니저 생성
 * @param {Y.Doc} doc
 * @param {Object} options
 * @returns {ProviderManager}
 */
export function createProviderManager(doc, options = {}) {
  return new ProviderManager(doc, options);
}

/**
 * WebSocket 전용 프로바이더 생성
 * @param {Y.Doc} doc
 * @param {string} url
 * @param {string} room
 * @param {Object} options
 * @returns {ProviderManager}
 */
export function createWebSocketProvider(doc, url, room, options = {}) {
  const manager = new ProviderManager(doc, {
    enableWebSocket: true,
    enableIndexedDB: false,
    enableWebRTC: false,
    websocketUrl: url,
    room: room,
    ...options
  });
  
  return manager;
}

/**
 * 오프라인 전용 프로바이더 생성 (IndexedDB만)
 * @param {Y.Doc} doc
 * @param {string} room
 * @param {Object} options
 * @returns {ProviderManager}
 */
export function createOfflineProvider(doc, room, options = {}) {
  const manager = new ProviderManager(doc, {
    enableWebSocket: false,
    enableIndexedDB: true,
    enableWebRTC: false,
    room: room,
    ...options
  });
  
  return manager;
}

/**
 * P2P 전용 프로바이더 생성 (WebRTC)
 * @param {Y.Doc} doc
 * @param {string} room
 * @param {Object} options
 * @returns {ProviderManager}
 */
export function createP2PProvider(doc, room, options = {}) {
  const manager = new ProviderManager(doc, {
    enableWebSocket: false,
    enableIndexedDB: true,
    enableWebRTC: true,
    room: room,
    ...options
  });
  
  return manager;
}

export { ProviderManager as default };