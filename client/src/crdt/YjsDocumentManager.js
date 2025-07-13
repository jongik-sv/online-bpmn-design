/**
 * YjsDocumentManager - Y.js 문서 및 CRDT 상태 관리
 * 
 * 주요 기능:
 * 1. Y.js 문서 생성 및 관리
 * 2. CRDT 데이터 구조 초기화
 * 3. Awareness 상태 관리 (사용자 커서, 선택 등)
 * 4. 문서 영속성 및 복구
 * 5. 업데이트 압축 및 최적화
 * 
 * @class YjsDocumentManager
 */

import * as Y from 'yjs';
// import { IndexeddbPersistence } from 'y-indexeddb'; // 비활성화됨
import EventEmitter from 'eventemitter3';

export class YjsDocumentManager extends EventEmitter {
  constructor(documentId, options = {}) {
    super();
    
    // 문서 ID 및 옵션
    this.documentId = documentId;
    this.options = {
      enablePersistence: false,         // IndexedDB 영속성 비활성화 (메모리 누수 방지)
      gcEnabled: true,                  // 가비지 컬렉션 활성화
      compressionThreshold: 500,        // 압축 임계값 낮춤 (업데이트 수)
      snapshotInterval: 300000,         // 스냅샷 간격 5분으로 늘림 (ms)
      ...options
    };
    
    // Y.js 문서 생성 (안전한 설정)
    this.doc = new Y.Doc({
      gc: false,                    // 가비지 컬렉션 비활성화 (무한 재귀 방지)
      guid: this.documentId,
      meta: null,                   // 메타데이터 비활성화
      autoLoad: false,              // 자동 로드 비활성화
      shouldLoad: false             // 로드 방지
    });
    
    // 핵심 CRDT 구조
    this.structures = {
      elements: null,         // Y.Map - BPMN 요소들
      metadata: null,         // Y.Map - 문서 메타데이터
      comments: null,         // Y.Array - 협업 댓글
      awareness: null,        // Awareness 상태
      locks: null,           // Y.Map - 요소 잠금 상태
      versions: null         // Y.Array - 버전 히스토리
    };
    
    // 상태 관리
    this.isInitialized = false;
    this.updateCount = 0;
    this.lastSnapshot = null;
    
    // 초기화
    this._initialize();
  }
  
  /**
   * 문서 관리자 초기화
   * @private
   */
  async _initialize() {
    try {
      // CRDT 구조 초기화
      this._initializeCRDTStructures();
      
      // 영속성 설정 비활성화 (IndexedDB 무한 재귀 방지)
      // if (this.options.enablePersistence) {
      //   await this._setupPersistence();
      // }
      
      // 문서 관찰자 설정
      this._setupDocumentObservers();
      
      // 스냅샷 스케줄러 비활성화 (성능 개선)
      // if (this.options.snapshotInterval > 0) {
      //   this._startSnapshotScheduler();
      // }
      
      this.isInitialized = true;
      this.emit('initialized', { documentId: this.documentId });
      
    } catch (error) {
      this.emit('error', { type: 'initialization', error });
      throw error;
    }
  }
  
  /**
   * CRDT 구조 초기화
   * @private
   */
  _initializeCRDTStructures() {
    // BPMN 요소 맵
    this.structures.elements = this.doc.getMap('bpmn-elements');
    
    // 문서 메타데이터
    this.structures.metadata = this.doc.getMap('document-metadata');
    this._initializeMetadata();
    
    // 협업 댓글
    this.structures.comments = this.doc.getArray('collaboration-comments');
    
    // 요소 잠금 상태
    this.structures.locks = this.doc.getMap('element-locks');
    
    // 버전 히스토리
    this.structures.versions = this.doc.getArray('version-history');
    
    // Awareness 설정 (별도 초기화 필요)
    this.structures.awareness = null; // WebsocketProvider에서 설정
  }
  
  /**
   * 메타데이터 초기화
   * @private
   */
  _initializeMetadata() {
    // 메타데이터 초기화 비활성화 (무한 루프 방지)
    // Y.js 업데이트 루프를 방지하기 위해 메타데이터 설정을 생략
    console.log('Metadata initialization skipped to prevent update loops');
    
    /*
    const metadata = this.structures.metadata;
    
    if (!metadata.has('created')) {
      this.doc.transact(() => {
        metadata.set('created', Date.now());
        metadata.set('lastModified', Date.now());
        metadata.set('version', '1.0.0');
        metadata.set('collaboratorCount', 0);
        metadata.set('elementCount', 0);
      });
    }
    */
  }
  
  /**
   * IndexedDB 영속성 설정 (비활성화됨)
   * @private
   */
  async _setupPersistence() {
    // IndexedDB 무한 재귀 방지를 위해 완전히 비활성화
    console.warn('Persistence disabled to prevent IndexedDB infinite recursion');
    return Promise.resolve();
    
    /*
    return new Promise((resolve, reject) => {
      try {
        this.persistence = new IndexeddbPersistence(
          `bpmn-collab-${this.documentId}`,
          this.doc
        );
        
        this.persistence.on('synced', () => {
          this.emit('persistenceSynced');
          resolve();
        });
        
      } catch (error) {
        reject(error);
      }
    });
    */
  }
  
  /**
   * 문서 관찰자 설정
   * @private
   */
  _setupDocumentObservers() {
    // 무한 재귀 방지 변수
    this.isProcessingUpdate = false;
    this.lastUpdateTime = 0;
    this.updateCount = 0;
    
    // Y.js 업데이트 리스너 일시 비활성화 (무한 루프 완전 차단)
    // 실시간 동기화는 WebSocket을 통해서만 수행
    console.log('Y.js document update listeners disabled to prevent infinite loops');
    
    /*
    // 업데이트 카운터 (안전장치 포함)
    this.doc.on('update', (update, origin) => {
      // 무한 재귀 방지
      if (this.isProcessingUpdate) {
        console.warn('Update already processing, skipping to prevent recursion');
        return;
      }
      
      // 너무 빠른 연속 업데이트 방지 (디바운싱)
      const now = Date.now();
      if (now - this.lastUpdateTime < 100) {
        // 콘솔 로그도 제거하여 성능 향상
        return;
      }
      this.lastUpdateTime = now;
      
      this.isProcessingUpdate = true;
      
      try {
        this.updateCount++;
        
        // 압축 체크 (더 보수적으로)
        if (this.updateCount % (this.options.compressionThreshold * 2) === 0) {
          // 압축은 비활성화 (무한 재귀 위험)
          // this._compressUpdates();
        }
        
        // 메타데이터 업데이트 비활성화 (무한 루프 방지)
        // Y.js 문서 업데이트 중에 다시 Y.js를 업데이트하면 무한 루프 발생
        // 메타데이터 업데이트는 완전히 비활성화
        
        this.emit('documentUpdate', { update, origin, updateCount: this.updateCount });
        
      } catch (error) {
        console.error('Document update processing failed:', error);
      } finally {
        this.isProcessingUpdate = false;
      }
    });
    */
    
    // 하위 문서 이벤트 비활성화 (무한 루프 방지)
    // this.doc.on('subdocs', ({ added, removed, loaded }) => {
    //   this.emit('subdocsChanged', { added, removed, loaded });
    // });
  }
  
  /**
   * 스냅샷 스케줄러 시작
   * @private
   */
  _startSnapshotScheduler() {
    this.snapshotInterval = setInterval(() => {
      this._createSnapshot();
    }, this.options.snapshotInterval);
  }
  
  /**
   * 스냅샷 생성
   * @private
   */
  _createSnapshot() {
    try {
      const snapshot = Y.snapshot(this.doc);
      const timestamp = Date.now();
      
      // 로컬 메모리에만 저장 (Y.js 문서에 추가하지 않음)
      const snapshotData = {
        snapshot: Y.encodeSnapshot(snapshot),
        timestamp,
        elementCount: this.structures.elements.size,
        updateCount: this.updateCount
      };
      
      // 로컬 버전 히스토리에 추가 (transact 사용하지 않음)
      if (!this.versionHistory) {
        this.versionHistory = [];
      }
      this.versionHistory.push(snapshotData);
      
      // 최대 10개의 스냅샷만 유지
      if (this.versionHistory.length > 10) {
        this.versionHistory.shift();
      }
      
      this.lastSnapshot = { snapshot, timestamp };
      this.emit('snapshotCreated', { timestamp });
      
    } catch (error) {
      console.error('Failed to create snapshot:', error);
    }
  }
  
  /**
   * 업데이트 압축
   * @private
   */
  _compressUpdates() {
    // 문서 상태 벡터 가져오기
    const stateVector = Y.encodeStateVector(this.doc);
    
    // 가비지 컬렉션 임시 활성화
    if (!this.options.gcEnabled) {
      this.doc.gc = true;
      this.doc.transact(() => {
        // 강제 GC 트리거
      });
      this.doc.gc = false;
    }
    
    this.emit('updatesCompressed', { 
      updateCount: this.updateCount,
      stateVectorSize: stateVector.length 
    });
  }
  
  /**
   * 요소 맵 가져오기
   * @public
   * @returns {Y.Map}
   */
  getElementsMap() {
    return this.structures.elements;
  }
  
  /**
   * 특정 요소 가져오기
   * @public
   * @param {string} elementId 
   * @returns {Y.Map|null}
   */
  getElement(elementId) {
    return this.structures.elements.get(elementId);
  }
  
  /**
   * 요소 생성
   * @public
   * @param {string} elementId 
   * @param {Object} elementData 
   * @returns {Y.Map}
   */
  createElement(elementId, elementData) {
    return this.doc.transact(() => {
      const yElement = new Y.Map();
      
      // 데이터 설정
      Object.entries(elementData).forEach(([key, value]) => {
        if (typeof value === 'object' && value !== null) {
          // 중첩 객체는 Y.Map으로 변환
          const nestedMap = new Y.Map();
          Object.entries(value).forEach(([k, v]) => {
            nestedMap.set(k, v);
          });
          yElement.set(key, nestedMap);
        } else {
          yElement.set(key, value);
        }
      });
      
      // 요소 추가
      this.structures.elements.set(elementId, yElement);
      
      return yElement;
    }, 'local');
  }
  
  /**
   * 요소 업데이트
   * @public
   * @param {string} elementId 
   * @param {Object} updates 
   */
  updateElement(elementId, updates) {
    const yElement = this.getElement(elementId);
    if (!yElement) {
      throw new Error(`Element ${elementId} not found`);
    }
    
    this.doc.transact(() => {
      Object.entries(updates).forEach(([key, value]) => {
        yElement.set(key, value);
      });
    }, 'local');
  }
  
  /**
   * 요소 삭제
   * @public
   * @param {string} elementId 
   */
  deleteElement(elementId) {
    this.doc.transact(() => {
      this.structures.elements.delete(elementId);
    }, 'local');
  }
  
  /**
   * 요소 잠금 획득
   * @public
   * @param {string} elementId 
   * @param {string} userId 
   * @param {string} lockType 
   * @returns {boolean}
   */
  acquireLock(elementId, userId, lockType = 'editing') {
    const existingLock = this.structures.locks.get(elementId);
    
    // 이미 다른 사용자가 잠금을 보유하고 있는지 확인
    if (existingLock && existingLock.userId !== userId) {
      const lockExpired = Date.now() > existingLock.expiresAt;
      if (!lockExpired) {
        return false;
      }
    }
    
    // 잠금 설정
    this.doc.transact(() => {
      this.structures.locks.set(elementId, {
        userId,
        lockType,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 30000 // 30초 만료
      });
    });
    
    return true;
  }
  
  /**
   * 요소 잠금 해제
   * @public
   * @param {string} elementId 
   * @param {string} userId 
   */
  releaseLock(elementId, userId) {
    const lock = this.structures.locks.get(elementId);
    
    if (lock && lock.userId === userId) {
      this.doc.transact(() => {
        this.structures.locks.delete(elementId);
      });
    }
  }
  
  /**
   * 댓글 추가
   * @public
   * @param {Object} comment 
   */
  addComment(comment) {
    this.doc.transact(() => {
      this.structures.comments.push([{
        id: comment.id || Y.createID(),
        elementId: comment.elementId,
        text: comment.text,
        authorId: comment.authorId,
        timestamp: Date.now(),
        resolved: false,
        replies: []
      }]);
    });
  }
  
  /**
   * Awareness 업데이트
   * @public
   * @param {Object} awarenessData 
   */
  updateAwareness(awarenessData) {
    if (!this.structures.awareness) {
      console.warn('Awareness not initialized. Set WebsocketProvider first.');
      return;
    }
    
    this.structures.awareness.setLocalState(awarenessData);
  }
  
  /**
   * Awareness 프로바이더 설정
   * @public
   * @param {Object} awareness 
   */
  setAwarenessProvider(awareness) {
    this.structures.awareness = awareness;
    
    // Awareness 변경 관찰
    awareness.on('change', changes => {
      this.emit('awarenessChanged', { changes });
    });
  }
  
  /**
   * 문서 상태 내보내기
   * @public
   * @returns {Uint8Array}
   */
  exportState() {
    return Y.encodeStateAsUpdate(this.doc);
  }
  
  /**
   * 문서 상태 가져오기
   * @public
   * @param {Uint8Array} state 
   */
  importState(state) {
    Y.applyUpdate(this.doc, state);
  }
  
  /**
   * 특정 버전으로 복원
   * @public
   * @param {number} versionIndex 
   */
  restoreVersion(versionIndex) {
    const version = this.structures.versions.get(versionIndex);
    if (!version) {
      throw new Error(`Version ${versionIndex} not found`);
    }
    
    const snapshot = Y.decodeSnapshot(version.snapshot);
    const currentState = Y.encodeStateAsUpdate(this.doc);
    
    // 새 문서 생성하여 스냅샷 적용
    const restoredDoc = Y.createDocFromSnapshot(snapshot);
    
    // 현재 문서를 새 문서 상태로 업데이트
    const update = Y.encodeStateAsUpdate(restoredDoc);
    Y.applyUpdate(this.doc, update);
    
    // 복원 이벤트 발생
    this.emit('versionRestored', { 
      versionIndex, 
      previousState: currentState 
    });
  }
  
  /**
   * 리소스 정리
   * @public
   */
  destroy() {
    // 스냅샷 스케줄러 정지
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
    }
    
    // 영속성 정리
    if (this.persistence) {
      this.persistence.destroy();
    }
    
    // 문서 정리
    this.doc.destroy();
    
    // 이벤트 리스너 정리
    this.removeAllListeners();
    
    this.emit('destroyed');
  }
}