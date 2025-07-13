/**
 * PersistenceService - Y.js 문서 영속성 관리 서비스
 * 
 * 주요 기능:
 * 1. Y.js 문서 상태 저장 및 로드
 * 2. 증분 업데이트 관리
 * 3. 스냅샷 생성 및 관리
 * 4. 문서 압축 및 최적화
 * 5. 백업 및 복구
 * 
 * @class PersistenceService
 */

const Y = require('yjs');
const YjsDocument = require('../models/YjsDocument');
const CollaborationSession = require('../models/CollaborationSession');
const EventEmitter = require('eventemitter3');
const winston = require('winston');
const cron = require('node-cron');

class PersistenceService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      autoSaveInterval: 30000,          // 30초마다 자동 저장
      compressionThreshold: 500,        // 500개 업데이트마다 압축
      snapshotInterval: 3600000,        // 1시간마다 스냅샷
      maxUpdateHistory: 1000,           // 최대 업데이트 히스토리
      backupRetentionDays: 30,          // 백업 보관 기간
      enableAutoCompression: true,      // 자동 압축 활성화
      enablePeriodicBackup: true,       // 주기적 백업 활성화
      ...options
    };
    
    // 메모리 캐시 (성능 최적화)
    this.documentCache = new Map();
    this.pendingUpdates = new Map();
    
    // 배치 처리를 위한 큐
    this.saveQueue = new Set();
    this.compressionQueue = new Set();
    
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
        new winston.transports.File({ filename: 'persistence-service.log' })
      ]
    });
    
    // 초기화
    this._initialize();
  }
  
  /**
   * 서비스 초기화
   * @private
   */
  _initialize() {
    // 자동 저장 시작
    this._startAutoSave();
    
    // 주기적 압축 시작
    if (this.options.enableAutoCompression) {
      this._startAutoCompression();
    }
    
    // 주기적 백업 시작
    if (this.options.enablePeriodicBackup) {
      this._startPeriodicBackup();
    }
    
    this.logger.info('PersistenceService initialized');
  }
  
  /**
   * 문서 로드
   * @param {string} documentId - 문서 ID
   * @returns {Promise<Uint8Array|null>}
   */
  async loadDocument(documentId) {
    try {
      // 캐시에서 먼저 확인
      if (this.documentCache.has(documentId)) {
        this.logger.debug(`Loading document ${documentId} from cache`);
        return this.documentCache.get(documentId);
      }
      
      // DB에서 조회
      const yjsDoc = await YjsDocument.findOrCreate(documentId);
      
      if (yjsDoc.documentState && yjsDoc.documentState.length > 0) {
        // 캐시에 저장
        this.documentCache.set(documentId, yjsDoc.documentState);
        
        this.logger.info(`Loaded document ${documentId} from database`);
        this.emit('documentLoaded', { documentId, size: yjsDoc.documentState.length });
        
        return yjsDoc.documentState;
      }
      
      this.logger.info(`Document ${documentId} not found, will be created`);
      return null;
      
    } catch (error) {
      this.logger.error(`Error loading document ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 문서 저장
   * @param {string} documentId - 문서 ID
   * @param {Uint8Array} state - Y.js 문서 상태
   * @param {Object} metadata - 추가 메타데이터
   * @returns {Promise<void>}
   */
  async saveDocument(documentId, state, metadata = {}) {
    try {
      // 상태 벡터 계산
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      const stateVector = Y.encodeStateVector(doc);
      
      // 요소 수 계산 (BPMN 요소 맵에서)
      const elementsMap = doc.getMap('bpmn-elements');
      const elementCount = elementsMap.size;
      
      // DB에 저장
      const yjsDoc = await YjsDocument.findOrCreate(documentId);
      await yjsDoc.updateDocumentState(stateVector, state, elementCount);
      
      // 메타데이터 업데이트
      if (metadata.lastEditBy) {
        yjsDoc.metadata.lastEditBy = metadata.lastEditBy;
      }
      
      await yjsDoc.save();
      
      // 캐시 업데이트
      this.documentCache.set(documentId, state);
      
      this.logger.debug(`Saved document ${documentId}, size: ${state.length} bytes`);
      this.emit('documentSaved', { documentId, size: state.length, elementCount });
      
      // 압축 필요 여부 확인
      if (yjsDoc.updates.length >= this.options.compressionThreshold) {
        this.compressionQueue.add(documentId);
      }
      
    } catch (error) {
      this.logger.error(`Error saving document ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 증분 업데이트 저장
   * @param {string} documentId - 문서 ID
   * @param {Uint8Array} update - Y.js 업데이트
   * @param {string} clientId - 클라이언트 ID
   * @param {string} origin - 업데이트 원본
   * @returns {Promise<void>}
   */
  async saveUpdate(documentId, update, clientId, origin = 'unknown') {
    try {
      const yjsDoc = await YjsDocument.findOrCreate(documentId);
      await yjsDoc.addUpdate(update, clientId, origin);
      
      // 대기 중인 업데이트에 추가 (배치 처리용)
      if (!this.pendingUpdates.has(documentId)) {
        this.pendingUpdates.set(documentId, []);
      }
      this.pendingUpdates.get(documentId).push({
        update,
        clientId,
        origin,
        timestamp: Date.now()
      });
      
      this.logger.debug(`Saved update for document ${documentId} from client ${clientId}`);
      this.emit('updateSaved', { documentId, clientId, size: update.length });
      
    } catch (error) {
      this.logger.error(`Error saving update for document ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 특정 시점 이후 업데이트 조회
   * @param {string} documentId - 문서 ID
   * @param {Date} since - 기준 시점
   * @returns {Promise<Array>}
   */
  async getUpdatesSince(documentId, since) {
    try {
      const updates = await YjsDocument.getUpdatesSince(documentId, since);
      
      this.logger.debug(`Retrieved ${updates.length} updates for document ${documentId} since ${since}`);
      
      return updates.map(update => ({
        update: update.update,
        clientId: update.clientId,
        timestamp: update.timestamp,
        origin: update.origin
      }));
      
    } catch (error) {
      this.logger.error(`Error getting updates for document ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 스냅샷 생성
   * @param {string} documentId - 문서 ID
   * @param {string} userId - 생성자 사용자 ID
   * @param {string} description - 스냅샷 설명
   * @returns {Promise<Object>}
   */
  async createSnapshot(documentId, userId, description = '') {
    try {
      const yjsDoc = await YjsDocument.findOrCreate(documentId);
      
      if (!yjsDoc.documentState || yjsDoc.documentState.length === 0) {
        throw new Error('Cannot create snapshot: document state is empty');
      }
      
      await yjsDoc.createSnapshot(userId, description);
      
      this.logger.info(`Created snapshot for document ${documentId} by user ${userId}`);
      this.emit('snapshotCreated', { documentId, userId, description });
      
      return {
        snapshotId: yjsDoc.snapshots[yjsDoc.snapshots.length - 1].id,
        createdAt: new Date(),
        elementCount: yjsDoc.metadata.elementCount
      };
      
    } catch (error) {
      this.logger.error(`Error creating snapshot for document ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 스냅샷 복원
   * @param {string} documentId - 문서 ID
   * @param {string} snapshotId - 스냅샷 ID
   * @returns {Promise<Uint8Array>}
   */
  async restoreSnapshot(documentId, snapshotId) {
    try {
      const yjsDoc = await YjsDocument.findOne({ documentId });
      
      if (!yjsDoc) {
        throw new Error(`Document ${documentId} not found`);
      }
      
      const snapshot = yjsDoc.snapshots.find(s => s.id === snapshotId);
      
      if (!snapshot) {
        throw new Error(`Snapshot ${snapshotId} not found`);
      }
      
      // 스냅샷을 현재 상태로 복원
      await yjsDoc.updateDocumentState(
        snapshot.stateVector,
        snapshot.snapshot,
        snapshot.elementCount
      );
      
      // 캐시 업데이트
      this.documentCache.set(documentId, snapshot.snapshot);
      
      this.logger.info(`Restored snapshot ${snapshotId} for document ${documentId}`);
      this.emit('snapshotRestored', { documentId, snapshotId });
      
      return snapshot.snapshot;
      
    } catch (error) {
      this.logger.error(`Error restoring snapshot ${snapshotId} for document ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 문서 압축
   * @param {string} documentId - 문서 ID
   * @returns {Promise<Object>}
   */
  async compressDocument(documentId) {
    try {
      const yjsDoc = await YjsDocument.findOne({ documentId });
      
      if (!yjsDoc) {
        throw new Error(`Document ${documentId} not found`);
      }
      
      const beforeSize = yjsDoc.totalUpdateSize;
      const beforeCount = yjsDoc.updates.length;
      
      await yjsDoc.compressUpdates();
      
      const afterSize = yjsDoc.totalUpdateSize;
      const afterCount = yjsDoc.updates.length;
      
      const compressionStats = {
        beforeSize,
        afterSize,
        beforeCount,
        afterCount,
        compressionRatio: beforeSize > 0 ? afterSize / beforeSize : 0,
        spaceSaved: beforeSize - afterSize
      };
      
      this.logger.info(`Compressed document ${documentId}: ${beforeCount} -> ${afterCount} updates, ${beforeSize} -> ${afterSize} bytes`);
      this.emit('documentCompressed', { documentId, ...compressionStats });
      
      return compressionStats;
      
    } catch (error) {
      this.logger.error(`Error compressing document ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 문서 백업
   * @param {string} documentId - 문서 ID
   * @returns {Promise<Object>}
   */
  async backupDocument(documentId) {
    try {
      const yjsDoc = await YjsDocument.findOne({ documentId });
      
      if (!yjsDoc) {
        throw new Error(`Document ${documentId} not found`);
      }
      
      const backup = {
        documentId,
        stateVector: yjsDoc.stateVector,
        documentState: yjsDoc.documentState,
        metadata: yjsDoc.metadata,
        snapshots: yjsDoc.snapshots,
        backupDate: new Date(),
        version: '1.0'
      };
      
      // 백업 저장 (파일 시스템, S3, 또는 별도 DB)
      // 여기서는 로깅만 수행 (실제 구현에서는 저장 로직 추가)
      
      this.logger.info(`Created backup for document ${documentId}`);
      this.emit('documentBackedUp', { documentId, backupSize: backup.documentState.length });
      
      return backup;
      
    } catch (error) {
      this.logger.error(`Error backing up document ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 문서 통계 조회
   * @param {string} documentId - 문서 ID
   * @returns {Promise<Object>}
   */
  async getDocumentStats(documentId) {
    try {
      const yjsDoc = await YjsDocument.findOne({ documentId });
      
      if (!yjsDoc) {
        return null;
      }
      
      return {
        documentId,
        elementCount: yjsDoc.metadata.elementCount,
        totalUpdates: yjsDoc.metadata.totalUpdates,
        documentSize: yjsDoc.documentSize,
        totalUpdateSize: yjsDoc.totalUpdateSize,
        recentUpdatesCount: yjsDoc.recentUpdates.length,
        snapshotCount: yjsDoc.snapshots.length,
        lastEditAt: yjsDoc.metadata.lastEditAt,
        lastEditBy: yjsDoc.metadata.lastEditBy,
        compressionStats: yjsDoc.metadata.compressionStats,
        syncState: yjsDoc.syncState
      };
      
    } catch (error) {
      this.logger.error(`Error getting document stats for ${documentId}:`, error);
      throw error;
    }
  }
  
  /**
   * 전체 시스템 통계
   * @returns {Promise<Object>}
   */
  async getSystemStats() {
    try {
      const dbStats = await YjsDocument.getStatistics();
      
      const cacheStats = {
        cachedDocuments: this.documentCache.size,
        pendingUpdates: Array.from(this.pendingUpdates.values())
          .reduce((sum, updates) => sum + updates.length, 0),
        saveQueueSize: this.saveQueue.size,
        compressionQueueSize: this.compressionQueue.size
      };
      
      return {
        database: dbStats,
        cache: cacheStats,
        performance: {
          averageDocumentSize: dbStats.totalElements > 0 
            ? dbStats.totalElements / dbStats.totalDocuments 
            : 0
        }
      };
      
    } catch (error) {
      this.logger.error('Error getting system stats:', error);
      throw error;
    }
  }
  
  /**
   * 자동 저장 시작
   * @private
   */
  _startAutoSave() {
    setInterval(async () => {
      if (this.saveQueue.size === 0) return;
      
      const documentsToSave = Array.from(this.saveQueue);
      this.saveQueue.clear();
      
      for (const documentId of documentsToSave) {
        try {
          // 캐시된 상태가 있으면 저장
          if (this.documentCache.has(documentId)) {
            await this.saveDocument(documentId, this.documentCache.get(documentId));
          }
        } catch (error) {
          this.logger.error(`Auto-save failed for document ${documentId}:`, error);
        }
      }
      
    }, this.options.autoSaveInterval);
  }
  
  /**
   * 자동 압축 시작
   * @private
   */
  _startAutoCompression() {
    setInterval(async () => {
      if (this.compressionQueue.size === 0) return;
      
      const documentsToCompress = Array.from(this.compressionQueue);
      this.compressionQueue.clear();
      
      for (const documentId of documentsToCompress) {
        try {
          await this.compressDocument(documentId);
        } catch (error) {
          this.logger.error(`Auto-compression failed for document ${documentId}:`, error);
        }
      }
      
    }, 60000); // 1분마다 압축 작업 수행
  }
  
  /**
   * 주기적 백업 시작
   * @private
   */
  _startPeriodicBackup() {
    // 매일 오전 2시에 백업 수행
    cron.schedule('0 2 * * *', async () => {
      try {
        this.logger.info('Starting periodic backup...');
        
        // 활성 문서들의 백업 생성
        const activeSessions = await CollaborationSession.find({ isActive: true });
        const documentIds = [...new Set(activeSessions.map(s => s.documentId))];
        
        for (const documentId of documentIds) {
          try {
            await this.backupDocument(documentId.toString());
          } catch (error) {
            this.logger.error(`Backup failed for document ${documentId}:`, error);
          }
        }
        
        this.logger.info(`Periodic backup completed for ${documentIds.length} documents`);
        
      } catch (error) {
        this.logger.error('Periodic backup failed:', error);
      }
    });
  }
  
  /**
   * 문서를 저장 큐에 추가
   * @param {string} documentId - 문서 ID
   */
  queueForSave(documentId) {
    this.saveQueue.add(documentId);
  }
  
  /**
   * 캐시에서 문서 제거
   * @param {string} documentId - 문서 ID
   */
  evictFromCache(documentId) {
    this.documentCache.delete(documentId);
    this.pendingUpdates.delete(documentId);
    this.logger.debug(`Evicted document ${documentId} from cache`);
  }
  
  /**
   * 캐시 정리
   * @param {number} maxAge - 최대 캐시 보관 시간 (ms)
   */
  cleanupCache(maxAge = 3600000) { // 1시간
    const now = Date.now();
    
    for (const [documentId, _] of this.documentCache) {
      // 최근 업데이트가 없는 문서는 캐시에서 제거
      const pendingUpdates = this.pendingUpdates.get(documentId) || [];
      const lastUpdate = pendingUpdates.length > 0 
        ? Math.max(...pendingUpdates.map(u => u.timestamp))
        : 0;
        
      if (now - lastUpdate > maxAge) {
        this.evictFromCache(documentId);
      }
    }
  }
  
  /**
   * 서비스 종료
   */
  async shutdown() {
    this.logger.info('PersistenceService shutting down...');
    
    // 대기 중인 모든 저장 작업 완료
    const pendingDocuments = Array.from(this.saveQueue);
    
    for (const documentId of pendingDocuments) {
      try {
        if (this.documentCache.has(documentId)) {
          await this.saveDocument(documentId, this.documentCache.get(documentId));
        }
      } catch (error) {
        this.logger.error(`Error saving document ${documentId} during shutdown:`, error);
      }
    }
    
    // 대기 중인 압축 작업 완료
    const pendingCompressions = Array.from(this.compressionQueue);
    
    for (const documentId of pendingCompressions) {
      try {
        await this.compressDocument(documentId);
      } catch (error) {
        this.logger.error(`Error compressing document ${documentId} during shutdown:`, error);
      }
    }
    
    // 캐시 정리
    this.documentCache.clear();
    this.pendingUpdates.clear();
    this.saveQueue.clear();
    this.compressionQueue.clear();
    
    this.removeAllListeners();
    
    this.logger.info('PersistenceService shutdown complete');
  }
}

module.exports = PersistenceService;