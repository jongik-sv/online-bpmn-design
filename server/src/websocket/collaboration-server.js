/**
 * CollaborationServer - WebSocket 기반 실시간 협업 서버
 * 
 * 주요 기능:
 * 1. WebSocket 연결 관리
 * 2. Y.js 동기화 처리
 * 3. 메시지 라우팅 및 브로드캐스팅
 * 4. 인증 및 권한 관리
 * 5. 에러 처리 및 복구
 * 
 * @class CollaborationServer
 */

const WebSocket = require('ws');
const Y = require('yjs');
const { setupWSConnection } = require('y-websocket/bin/utils');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const winston = require('winston');

// 모델 및 서비스
const CollaborationSession = require('../models/CollaborationSession');
const YjsDocument = require('../models/YjsDocument');
const SessionService = require('../services/SessionService');
const PersistenceService = require('../services/PersistenceService');
const { NotificationService } = require('../services/NotificationService');

// Y.js 유틸리티
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');

// 메시지 타입 정의
const messageType = {
  SYNC: 0,
  AWARENESS: 1,
  AUTH: 2,
  CUSTOM: 3,
  ERROR: 4,
  NOTIFICATION: 5
};

class CollaborationServer {
  constructor(server, options = {}) {
    // 서버 설정
    this.wss = new WebSocket.Server({
      server,
      // Y.js는 URL 뒤에 room 이름을 추가하므로 동적 경로 처리
      verifyClient: (info) => {
        const pathname = new URL(info.req.url, 'http://localhost').pathname;
        return pathname.startsWith('/collaboration');
      },
      ...options.websocket
    });
    
    // 옵션 설정
    this.options = {
      heartbeatInterval: 30000,        // 30초
      persistenceInterval: 30000,      // 30초
      cleanupInterval: 300000,         // 5분
      maxMessageSize: 10 * 1024 * 1024, // 10MB
      authRequired: true,              // 인증 필요 여부
      ...options
    };
    
    // 상태 관리
    this.rooms = new Map();             // roomId -> Room
    this.connections = new Map();       // ws -> Connection
    this.documents = new Map();         // documentId -> Y.Doc
    
    // 서비스 초기화
    this.sessionService = new SessionService();
    this.persistenceService = new PersistenceService();
    this.notificationService = new NotificationService();
    
    // 로거 설정
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'collaboration.log' })
      ]
    });
    
    // 서버 초기화
    this._initialize();
  }
  
  /**
   * 서버 초기화
   * @private
   */
  _initialize() {
    // WebSocket 이벤트 핸들러 설정
    this.wss.on('connection', this._handleConnection.bind(this));
    
    // 정기 작업 시작
    this._startHeartbeat();
    this._startPersistence();
    this._startCleanup();
    
    this.logger.info('CollaborationServer initialized');
  }
  
  /**
   * 새 연결 처리
   * @private
   */
  async _handleConnection(ws, request) {
    try {
      // Y.js의 내장 WebSocket 처리 사용
      setupWSConnection(ws, request, {
        // 연결 설정 옵션
        gc: true
      });
      
      // 연결 로깅
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname;
      const documentId = pathname.replace('/collaboration/', '') || 'default';
      
      this.logger.info(`New WebSocket connection for document: ${documentId}`);
      
    } catch (error) {
      this.logger.error('Connection handling error:', error.message);
      ws.close();
    }
  }
  
  /**
   * 메시지 처리
   * @private
   */
  async _handleMessage(ws, message) {
    const connection = this.connections.get(ws);
    if (!connection) return;
    
    try {
      // 메시지 크기 확인
      if (message.length > this.options.maxMessageSize) {
        throw new Error('Message too large');
      }
      
      // 활동 시간 업데이트
      connection.lastActivity = Date.now();
      
      // 메시지 파싱
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);
      
      switch (messageType) {
        case messageType.SYNC:
          await this._handleSyncMessage(ws, decoder);
          break;
          
        case messageType.AWARENESS:
          await this._handleAwarenessMessage(ws, decoder);
          break;
          
        case messageType.AUTH:
          await this._handleAuthMessage(ws, decoder);
          break;
          
        case messageType.CUSTOM:
          await this._handleCustomMessage(ws, decoder);
          break;
          
        default:
          throw new Error(`Unknown message type: ${messageType}`);
      }
      
    } catch (error) {
      this.logger.error('Message handling error:', error);
      this._sendError(ws, error.message);
    }
  }
  
  /**
   * 동기화 메시지 처리
   * @private
   */
  async _handleSyncMessage(ws, decoder) {
    const connection = this.connections.get(ws);
    if (!connection.isAuthenticated) {
      throw new Error('Not authenticated');
    }
    
    const room = this.rooms.get(connection.roomId);
    if (!room) {
      throw new Error('Room not found');
    }
    
    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      decoding.createEncoder(),
      room.doc,
      connection
    );
    
    // 동기화 상태 업데이트
    if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
      // 클라이언트가 동기화됨
      connection.isSynced = true;
      
      // 다른 클라이언트에게 브로드캐스트
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageType.SYNC);
      syncProtocol.writeSyncStep1(encoder, room.doc);
      
      this._broadcastToRoom(connection.roomId, encoding.toUint8Array(encoder), ws);
      
      // 세션 통계 업데이트
      await this.sessionService.updateMetrics(connection.roomId, 'edit', connection.user.id);
    }
  }
  
  /**
   * Awareness 메시지 처리
   * @private
   */
  async _handleAwarenessMessage(ws, decoder) {
    const connection = this.connections.get(ws);
    if (!connection.isAuthenticated) {
      throw new Error('Not authenticated');
    }
    
    const room = this.rooms.get(connection.roomId);
    if (!room) {
      throw new Error('Room not found');
    }
    
    // Awareness 업데이트 적용
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(
      room.awareness,
      update,
      connection
    );
    
    // 다른 클라이언트에게 브로드캐스트
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageType.AWARENESS);
    encoding.writeVarUint8Array(encoder, update);
    
    this._broadcastToRoom(connection.roomId, encoding.toUint8Array(encoder), ws);
  }
  
  /**
   * 인증 메시지 처리
   * @private
   */
  async _handleAuthMessage(ws, decoder) {
    const connection = this.connections.get(ws);
    const data = JSON.parse(decoding.readVarString(decoder));
    
    try {
      // JWT 토큰 검증
      const decoded = jwt.verify(data.token, process.env.JWT_SECRET);
      
      // 사용자 정보 설정
      connection.user = {
        id: decoded.userId,
        name: decoded.name,
        email: decoded.email
      };
      
      // 룸 참가
      const { roomId, documentId } = data;
      await this._joinRoom(ws, roomId, documentId);
      
      // 인증 성공 응답
      this._sendMessage(ws, messageType.AUTH, {
        type: 'auth-success',
        user: connection.user,
        roomId: roomId
      });
      
      connection.isAuthenticated = true;
      
      this.logger.info(`User ${connection.user.id} authenticated`);
      
    } catch (error) {
      this.logger.error('Authentication error:', error);
      this._sendError(ws, 'Authentication failed');
      ws.close(1008, 'Authentication failed');
    }
  }
  
  /**
   * 사용자 정의 메시지 처리
   * @private
   */
  async _handleCustomMessage(ws, decoder) {
    const connection = this.connections.get(ws);
    if (!connection.isAuthenticated) {
      throw new Error('Not authenticated');
    }
    
    const data = JSON.parse(decoding.readVarString(decoder));
    
    switch (data.type) {
      case 'ping':
        this._sendMessage(ws, messageType.CUSTOM, {
          type: 'pong',
          id: data.id,
          timestamp: Date.now()
        });
        break;
        
      case 'cursor':
        // 커서 위치 업데이트
        await this.sessionService.updateCursor(
          connection.roomId,
          connection.user.id,
          data.cursor
        );
        break;
        
      case 'comment':
        // 댓글 처리
        await this._handleComment(connection, data);
        break;
        
      case 'lock':
        // 요소 잠금 처리
        await this._handleLock(connection, data);
        break;
        
      default:
        // 다른 클라이언트에게 전달
        this._broadcastToRoom(
          connection.roomId,
          message,
          ws
        );
    }
  }
  
  /**
   * 룸 참가
   * @private
   */
  async _joinRoom(ws, roomId, documentId) {
    const connection = this.connections.get(ws);
    
    // 기존 룸에서 나가기
    if (connection.roomId) {
      await this._leaveRoom(ws);
    }
    
    // 룸 가져오기 또는 생성
    let room = this.rooms.get(roomId);
    if (!room) {
      room = await this._createRoom(roomId, documentId);
    }
    
    // 연결 추가
    room.connections.add(ws);
    connection.roomId = roomId;
    connection.documentId = documentId;
    
    // 세션에 참가자 추가
    await this.sessionService.addParticipant(
      roomId,
      connection.user.id,
      {
        color: this._generateUserColor(),
        role: 'editor'
      }
    );
    
    // 초기 동기화
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageType.SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    ws.send(encoding.toUint8Array(encoder));
    
    // Awareness 초기화
    const awarenessStates = room.awareness.getStates();
    if (awarenessStates.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageType.AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          room.awareness,
          Array.from(awarenessStates.keys())
        )
      );
      ws.send(encoding.toUint8Array(encoder));
    }
    
    // 다른 참가자에게 알림
    this._broadcastNotification(roomId, {
      type: 'collaboratorJoined',
      data: {
        user: connection.user,
        timestamp: Date.now()
      }
    }, ws);
    
    this.logger.info(`User ${connection.user.id} joined room ${roomId}`);
  }
  
  /**
   * 룸 생성
   * @private
   */
  async _createRoom(roomId, documentId) {
    // Y.js 문서 생성 또는 로드
    const doc = new Y.Doc();
    
    // 기존 상태 로드
    const persistedState = await this.persistenceService.loadDocument(documentId);
    if (persistedState) {
      Y.applyUpdate(doc, persistedState);
    }
    
    // Awareness 생성
    const awareness = new awarenessProtocol.Awareness(doc);
    
    // 룸 객체 생성
    const room = {
      id: roomId,
      documentId: documentId,
      doc: doc,
      awareness: awareness,
      connections: new Set(),
      createdAt: Date.now()
    };
    
    // 문서 변경 관찰
    doc.on('update', (update, origin) => {
      // 변경사항 브로드캐스트
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageType.SYNC);
      encoding.writeVarUint8Array(encoder, update);
      
      this._broadcastToRoom(roomId, encoding.toUint8Array(encoder), origin);
    });
    
    // Awareness 변경 관찰
    awareness.on('update', ({ added, updated, removed }) => {
      const changedClients = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageType.AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
      );
      
      this._broadcastToRoom(roomId, encoding.toUint8Array(encoder));
    });
    
    this.rooms.set(roomId, room);
    this.documents.set(documentId, doc);
    
    // 세션 생성
    await this.sessionService.createSession(roomId, documentId);
    
    return room;
  }
  
  /**
   * 룸에서 나가기
   * @private
   */
  async _leaveRoom(ws) {
    const connection = this.connections.get(ws);
    if (!connection || !connection.roomId) return;
    
    const room = this.rooms.get(connection.roomId);
    if (!room) return;
    
    // 연결 제거
    room.connections.delete(ws);
    
    // 세션에서 참가자 제거
    await this.sessionService.removeParticipant(
      connection.roomId,
      connection.user.id
    );
    
    // Awareness 정리
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      [connection.user.id],
      null
    );
    
    // 다른 참가자에게 알림
    this._broadcastNotification(connection.roomId, {
      type: 'collaboratorLeft',
      data: {
        user: connection.user,
        timestamp: Date.now()
      }
    }, ws);
    
    // 룸이 비어있으면 정리
    if (room.connections.size === 0) {
      await this._cleanupRoom(connection.roomId);
    }
    
    connection.roomId = null;
    connection.documentId = null;
  }
  
  /**
   * 연결 종료 처리
   * @private
   */
  async _handleDisconnect(ws) {
    const connection = this.connections.get(ws);
    if (!connection) return;
    
    try {
      // 룸에서 나가기
      await this._leaveRoom(ws);
      
      // 연결 정리
      this.connections.delete(ws);
      
      this.logger.info(`Connection closed: ${connection.id}`);
      
    } catch (error) {
      this.logger.error('Disconnect handling error:', error);
    }
  }
  
  /**
   * 에러 처리
   * @private
   */
  _handleError(ws, error) {
    const connection = this.connections.get(ws);
    this.logger.error(`WebSocket error for ${connection?.id}:`, error);
  }
  
  /**
   * Pong 처리
   * @private
   */
  _handlePong(ws) {
    const connection = this.connections.get(ws);
    if (connection) {
      connection.lastActivity = Date.now();
    }
  }
  
  /**
   * 메시지 전송
   * @private
   */
  _sendMessage(ws, type, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, type);
    encoding.writeVarString(encoder, JSON.stringify(data));
    
    ws.send(encoding.toUint8Array(encoder));
  }
  
  /**
   * 에러 메시지 전송
   * @private
   */
  _sendError(ws, message) {
    this._sendMessage(ws, messageType.ERROR, {
      error: message,
      timestamp: Date.now()
    });
  }
  
  /**
   * 룸에 브로드캐스트
   * @private
   */
  _broadcastToRoom(roomId, message, exclude = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    room.connections.forEach(ws => {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
  
  /**
   * 알림 브로드캐스트
   * @private
   */
  _broadcastNotification(roomId, notification, exclude = null) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageType.NOTIFICATION);
    encoding.writeVarString(encoder, JSON.stringify(notification));
    
    this._broadcastToRoom(roomId, encoding.toUint8Array(encoder), exclude);
  }
  
  /**
   * 하트비트 시작
   * @private
   */
  _startHeartbeat() {
    setInterval(() => {
      this.wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      });
    }, this.options.heartbeatInterval);
  }
  
  /**
   * 영속성 작업 시작
   * @private
   */
  _startPersistence() {
    setInterval(async () => {
      for (const [documentId, doc] of this.documents) {
        try {
          await this.persistenceService.saveDocument(
            documentId,
            Y.encodeStateAsUpdate(doc)
          );
        } catch (error) {
          this.logger.error(`Persistence error for ${documentId}:`, error);
        }
      }
    }, this.options.persistenceInterval);
  }
  
  /**
   * 정리 작업 시작
   * @private
   */
  _startCleanup() {
    setInterval(async () => {
      // 비활성 연결 정리
      const now = Date.now();
      const timeout = 5 * 60 * 1000; // 5분
      
      for (const [ws, connection] of this.connections) {
        if (now - connection.lastActivity > timeout) {
          this.logger.info(`Closing inactive connection: ${connection.id}`);
          ws.close(1000, 'Inactive');
        }
      }
      
      // 비활성 세션 정리
      await this.sessionService.cleanupInactiveSessions();
      
    }, this.options.cleanupInterval);
  }
  
  /**
   * 룸 정리
   * @private
   */
  async _cleanupRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    // 문서 저장
    await this.persistenceService.saveDocument(
      room.documentId,
      Y.encodeStateAsUpdate(room.doc)
    );
    
    // 세션 종료
    await this.sessionService.endSession(roomId);
    
    // 메모리에서 제거
    this.rooms.delete(roomId);
    this.documents.delete(room.documentId);
    
    this.logger.info(`Room ${roomId} cleaned up`);
  }
  
  /**
   * 사용자 색상 생성
   * @private
   */
  _generateUserColor() {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
      '#FECA57', '#FF9FF3', '#54A0FF', '#48DBFB'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }
  
  /**
   * 서버 종료
   * @public
   */
  async shutdown() {
    this.logger.info('Shutting down collaboration server...');
    
    // 모든 연결 종료
    for (const ws of this.wss.clients) {
      ws.close(1001, 'Server shutdown');
    }
    
    // 모든 문서 저장
    for (const [documentId, doc] of this.documents) {
      await this.persistenceService.saveDocument(
        documentId,
        Y.encodeStateAsUpdate(doc)
      );
    }
    
    // WebSocket 서버 종료
    this.wss.close();
    
    this.logger.info('Collaboration server shut down');
  }
}

module.exports = CollaborationServer;