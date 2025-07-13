/**
 * SessionService - 협업 세션 관리 서비스
 * 
 * 주요 기능:
 * 1. 협업 세션 생성, 관리, 종료
 * 2. 참가자 추가/제거 및 상태 관리
 * 3. 세션 메트릭 수집 및 통계
 * 4. 비활성 세션 정리
 * 5. 세션 권한 관리
 * 
 * @class SessionService
 */

const CollaborationSession = require('../models/CollaborationSession');
const CollaborationComment = require('../models/CollaborationComment');
const EventEmitter = require('eventemitter3');
const winston = require('winston');

class SessionService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxSessionDuration: 24 * 60 * 60 * 1000,  // 24시간
      inactiveTimeout: 30 * 60 * 1000,          // 30분
      maxParticipants: 50,                      // 최대 참가자 수
      cleanupInterval: 5 * 60 * 1000,           // 5분마다 정리
      ...options
    };
    
    // 활성 세션 캐시 (성능 최적화)
    this.activeSessionsCache = new Map();
    
    // 로거 설정
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'session-service.log' })
      ]
    });
    
    // 정리 작업 시작
    this._startCleanupJob();
  }
  
  /**
   * 협업 세션 생성
   * @param {string} documentId - 문서 ID
   * @param {string} workspaceId - 워크스페이스 ID
   * @param {string} createdBy - 생성자 사용자 ID
   * @param {Object} options - 세션 옵션
   * @returns {Promise<Object>}
   */
  async createSession(documentId, workspaceId, createdBy, options = {}) {
    try {
      // 기존 활성 세션 확인
      const existingSession = await CollaborationSession.findActiveSession(documentId);
      
      if (existingSession) {
        this.logger.info(`Reusing existing session for document ${documentId}`);
        return existingSession;
      }
      
      // 새 세션 생성
      const sessionId = `session-${documentId}-${Date.now()}`;
      
      const session = new CollaborationSession({
        documentId,
        workspaceId,
        sessionId,
        isActive: true,
        participants: [],
        settings: {
          maxParticipants: options.maxParticipants || this.options.maxParticipants,
          allowAnonymous: options.allowAnonymous || false,
          autoSaveInterval: options.autoSaveInterval || 30000,
          idleTimeout: options.idleTimeout || this.options.inactiveTimeout
        },
        metadata: {
          createdBy,
          lastActivityAt: new Date()
        }
      });
      
      await session.save();
      
      // 캐시에 추가
      this.activeSessionsCache.set(sessionId, session);
      
      this.logger.info(`Created new collaboration session: ${sessionId}`);
      this.emit('sessionCreated', { session, createdBy });
      
      return session;
      
    } catch (error) {
      this.logger.error('Error creating collaboration session:', error);
      throw error;
    }
  }
  
  /**
   * 세션에 참가자 추가
   * @param {string} sessionId - 세션 ID
   * @param {string} userId - 사용자 ID
   * @param {Object} userInfo - 사용자 정보
   * @returns {Promise<Object>}
   */
  async addParticipant(sessionId, userId, userInfo = {}) {
    try {
      const session = await this._getSession(sessionId);
      
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      
      // 참가자 추가
      await session.addParticipant(userId, userInfo);
      
      // 캐시 업데이트
      this.activeSessionsCache.set(sessionId, session);
      
      this.logger.info(`User ${userId} joined session ${sessionId}`);
      this.emit('participantJoined', { 
        sessionId, 
        userId, 
        userInfo, 
        participantCount: session.participants.length 
      });
      
      return session;
      
    } catch (error) {
      this.logger.error(`Error adding participant to session ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * 세션에서 참가자 제거
   * @param {string} sessionId - 세션 ID
   * @param {string} userId - 사용자 ID
   * @returns {Promise<Object>}
   */
  async removeParticipant(sessionId, userId) {
    try {
      const session = await this._getSession(sessionId);
      
      if (!session) {
        this.logger.warn(`Attempted to remove participant from non-existent session: ${sessionId}`);
        return null;
      }
      
      // 참가자 제거
      await session.removeParticipant(userId);
      
      // 캐시 업데이트
      this.activeSessionsCache.set(sessionId, session);
      
      this.logger.info(`User ${userId} left session ${sessionId}`);
      this.emit('participantLeft', { 
        sessionId, 
        userId, 
        participantCount: session.participants.length,
        isSessionEmpty: session.onlineCount === 0
      });
      
      return session;
      
    } catch (error) {
      this.logger.error(`Error removing participant from session ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * 참가자 상태 업데이트
   * @param {string} sessionId - 세션 ID
   * @param {string} userId - 사용자 ID
   * @param {string} status - 상태 ('online', 'away', 'offline')
   * @returns {Promise<Object>}
   */
  async updateParticipantStatus(sessionId, userId, status) {
    try {
      const session = await this._getSession(sessionId);
      
      if (!session) return null;
      
      await session.updateParticipantStatus(userId, status);
      
      // 캐시 업데이트
      this.activeSessionsCache.set(sessionId, session);
      
      this.emit('participantStatusChanged', { sessionId, userId, status });
      
      return session;
      
    } catch (error) {
      this.logger.error(`Error updating participant status in session ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * 커서 위치 업데이트
   * @param {string} sessionId - 세션 ID
   * @param {string} userId - 사용자 ID
   * @param {Object} cursor - 커서 위치 {x, y}
   * @returns {Promise<Object>}
   */
  async updateCursor(sessionId, userId, cursor) {
    try {
      const session = await this._getSession(sessionId);
      
      if (!session) return null;
      
      const result = await session.updateCursor(userId, cursor);
      
      // 커서 업데이트는 빈번하므로 캐시만 업데이트 (DB 저장은 배치로)
      if (this.activeSessionsCache.has(sessionId)) {
        const cachedSession = this.activeSessionsCache.get(sessionId);
        const participant = cachedSession.participants.find(p => p.userId.toString() === userId);
        if (participant) {
          participant.cursor = cursor;
          participant.lastSeenAt = new Date();
        }
      }
      
      this.emit('cursorUpdated', { sessionId, userId, cursor });
      
      return result;
      
    } catch (error) {
      this.logger.error(`Error updating cursor in session ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * 활동 메트릭 업데이트
   * @param {string} sessionId - 세션 ID
   * @param {string} type - 활동 타입 ('edit', 'message', 'conflict')
   * @param {string} userId - 사용자 ID
   * @returns {Promise<Object>}
   */
  async updateMetrics(sessionId, type, userId) {
    try {
      const session = await this._getSession(sessionId);
      
      if (!session) return null;
      
      await session.updateMetrics(type, userId);
      
      // 캐시 업데이트
      this.activeSessionsCache.set(sessionId, session);
      
      this.emit('metricsUpdated', { sessionId, type, userId });
      
      return session;
      
    } catch (error) {
      this.logger.error(`Error updating metrics in session ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * 세션 종료
   * @param {string} sessionId - 세션 ID
   * @param {string} reason - 종료 이유
   * @returns {Promise<Object>}
   */
  async endSession(sessionId, reason = 'manual') {
    try {
      const session = await this._getSession(sessionId);
      
      if (!session) {
        this.logger.warn(`Attempted to end non-existent session: ${sessionId}`);
        return null;
      }
      
      await session.endSession(reason);
      
      // 캐시에서 제거
      this.activeSessionsCache.delete(sessionId);
      
      this.logger.info(`Session ${sessionId} ended. Reason: ${reason}`);
      this.emit('sessionEnded', { sessionId, reason, duration: session.duration });
      
      return session;
      
    } catch (error) {
      this.logger.error(`Error ending session ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * 세션 정보 조회
   * @param {string} sessionId - 세션 ID
   * @returns {Promise<Object>}
   */
  async getSession(sessionId) {
    try {
      return await this._getSession(sessionId);
    } catch (error) {
      this.logger.error(`Error getting session ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * 문서의 활성 세션 조회
   * @param {string} documentId - 문서 ID
   * @returns {Promise<Object>}
   */
  async getActiveSessionByDocument(documentId) {
    try {
      return await CollaborationSession.findActiveSession(documentId);
    } catch (error) {
      this.logger.error(`Error getting active session for document ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 사용자의 활성 세션 목록 조회
   * @param {string} userId - 사용자 ID
   * @returns {Promise<Array>}
   */
  async getUserActiveSessions(userId) {
    try {
      return await CollaborationSession.findUserActiveSessions(userId);
    } catch (error) {
      this.logger.error(`Error getting user active sessions for ${userId}:`, error);
      throw error;
    }
  }
  
  /**
   * 세션 통계 조회
   * @param {string} sessionId - 세션 ID
   * @returns {Promise<Object>}
   */
  async getSessionStats(sessionId) {
    try {
      const session = await this._getSession(sessionId);
      
      if (!session) return null;
      
      // 추가 통계 계산
      const comments = await CollaborationComment.find({ 
        documentId: session.documentId,
        'metadata.sessionId': sessionId 
      });
      
      const stats = {
        sessionInfo: {
          id: session.sessionId,
          documentId: session.documentId,
          duration: session.duration,
          isActive: session.isActive
        },
        participants: {
          total: session.statistics.totalParticipants,
          peak: session.statistics.peakParticipants,
          current: session.onlineCount
        },
        activity: {
          totalEdits: session.statistics.totalEdits,
          totalMessages: session.statistics.totalMessages,
          conflictsResolved: session.statistics.conflictsResolved,
          comments: comments.length
        },
        performance: {
          averageEditTime: this._calculateAverageEditTime(session),
          activeTimePerUser: this._calculateActiveTimePerUser(session)
        }
      };
      
      return stats;
      
    } catch (error) {
      this.logger.error(`Error getting session stats for ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * 비활성 세션 정리
   * @returns {Promise<number>}
   */
  async cleanupInactiveSessions() {
    try {
      const result = await CollaborationSession.cleanupInactiveSessions(
        this.options.inactiveTimeout
      );
      
      // 캐시에서도 정리
      for (const [sessionId, session] of this.activeSessionsCache) {
        if (!session.isActive || 
            Date.now() - session.metadata.lastActivityAt.getTime() > this.options.inactiveTimeout) {
          this.activeSessionsCache.delete(sessionId);
        }
      }
      
      this.logger.info(`Cleaned up ${result.modifiedCount} inactive sessions`);
      this.emit('sessionsCleanedUp', { count: result.modifiedCount });
      
      return result.modifiedCount;
      
    } catch (error) {
      this.logger.error('Error cleaning up inactive sessions:', error);
      throw error;
    }
  }
  
  /**
   * 전체 세션 통계
   * @returns {Promise<Object>}
   */
  async getGlobalStats() {
    try {
      const activeSessions = await CollaborationSession.find({ isActive: true });
      const totalParticipants = activeSessions.reduce((sum, session) => 
        sum + session.onlineCount, 0);
      
      const stats = {
        activeSessions: activeSessions.length,
        totalParticipants,
        averageParticipantsPerSession: activeSessions.length > 0 
          ? totalParticipants / activeSessions.length 
          : 0,
        topSessions: activeSessions
          .sort((a, b) => b.onlineCount - a.onlineCount)
          .slice(0, 10)
          .map(session => ({
            sessionId: session.sessionId,
            documentId: session.documentId,
            participants: session.onlineCount,
            duration: session.duration
          }))
      };
      
      return stats;
      
    } catch (error) {
      this.logger.error('Error getting global session stats:', error);
      throw error;
    }
  }
  
  /**
   * 세션 캐시에서 조회 (성능 최적화)
   * @param {string} sessionId - 세션 ID
   * @returns {Promise<Object>}
   * @private
   */
  async _getSession(sessionId) {
    // 캐시에서 먼저 확인
    if (this.activeSessionsCache.has(sessionId)) {
      const cachedSession = this.activeSessionsCache.get(sessionId);
      
      // 캐시된 세션이 너무 오래된 경우 DB에서 다시 조회
      const cacheAge = Date.now() - cachedSession.metadata.lastActivityAt.getTime();
      if (cacheAge < 5 * 60 * 1000) { // 5분 이내
        return cachedSession;
      }
    }
    
    // DB에서 조회
    const session = await CollaborationSession.findOne({ 
      sessionId, 
      isActive: true 
    }).populate('participants.userId', 'name email avatar');
    
    if (session) {
      this.activeSessionsCache.set(sessionId, session);
    }
    
    return session;
  }
  
  /**
   * 평균 편집 시간 계산
   * @param {Object} session - 세션 객체
   * @returns {number}
   * @private
   */
  _calculateAverageEditTime(session) {
    const totalTime = session.participants.reduce((sum, participant) => 
      sum + (participant.metrics.totalActiveTime || 0), 0);
    const totalEdits = session.statistics.totalEdits;
    
    return totalEdits > 0 ? totalTime / totalEdits : 0;
  }
  
  /**
   * 사용자별 활성 시간 계산
   * @param {Object} session - 세션 객체
   * @returns {Array}
   * @private
   */
  _calculateActiveTimePerUser(session) {
    return session.participants.map(participant => ({
      userId: participant.userId,
      activeTime: participant.metrics.totalActiveTime || 0,
      editsCount: participant.metrics.editsCount || 0,
      messagesCount: participant.metrics.messagesCount || 0
    }));
  }
  
  /**
   * 정리 작업 시작
   * @private
   */
  _startCleanupJob() {
    setInterval(async () => {
      try {
        await this.cleanupInactiveSessions();
      } catch (error) {
        this.logger.error('Error in cleanup job:', error);
      }
    }, this.options.cleanupInterval);
  }
  
  /**
   * 서비스 종료
   */
  async shutdown() {
    this.logger.info('SessionService shutting down...');
    
    // 모든 활성 세션 종료
    const activeSessions = Array.from(this.activeSessionsCache.keys());
    
    for (const sessionId of activeSessions) {
      try {
        await this.endSession(sessionId, 'server_shutdown');
      } catch (error) {
        this.logger.error(`Error ending session ${sessionId} during shutdown:`, error);
      }
    }
    
    this.activeSessionsCache.clear();
    this.removeAllListeners();
    
    this.logger.info('SessionService shutdown complete');
  }
}

module.exports = SessionService;