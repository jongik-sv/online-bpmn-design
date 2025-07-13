/**
 * YjsDocument Model - Y.js 문서 상태 저장
 * 
 * Y.js 문서의 영속성을 위한 MongoDB 모델
 * 압축된 업데이트와 스냅샷을 저장하여 효율적인 동기화 제공
 * 
 * @module YjsDocument
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Y.js 업데이트 스키마
 */
const YjsUpdateSchema = new Schema({
  update: {
    type: Buffer,
    required: true
  },
  
  clock: {
    type: Number,
    required: true,
    default: 0
  },
  
  timestamp: {
    type: Date,
    default: Date.now,
    required: true
  },
  
  clientId: {
    type: String,
    required: true
  },
  
  origin: {
    type: String,
    default: 'unknown'
  }
}, { _id: false });

/**
 * Y.js 문서 스키마
 */
const YjsDocumentSchema = new Schema({
  documentId: {
    type: Schema.Types.ObjectId,
    ref: 'Document',
    required: true,
    unique: true,
    index: true
  },
  
  // Y.js 상태 벡터 (압축된 현재 상태)
  stateVector: {
    type: Buffer,
    required: true
  },
  
  // Y.js 문서 상태 (전체 업데이트)
  documentState: {
    type: Buffer,
    required: true
  },
  
  // 증분 업데이트 배열
  updates: [YjsUpdateSchema],
  
  // 메타데이터
  metadata: {
    version: {
      type: String,
      default: '1.0.0'
    },
    
    elementCount: {
      type: Number,
      default: 0
    },
    
    lastEditBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    
    lastEditAt: {
      type: Date,
      default: Date.now
    },
    
    totalUpdates: {
      type: Number,
      default: 0
    },
    
    compressedAt: {
      type: Date,
      default: null
    },
    
    // 압축 통계
    compressionStats: {
      originalSize: { type: Number, default: 0 },
      compressedSize: { type: Number, default: 0 },
      compressionRatio: { type: Number, default: 0 }
    }
  },
  
  // 스냅샷 히스토리 (성능을 위해 제한적으로 보관)
  snapshots: [{
    id: {
      type: String,
      required: true
    },
    
    snapshot: {
      type: Buffer,
      required: true
    },
    
    stateVector: {
      type: Buffer,
      required: true
    },
    
    elementCount: {
      type: Number,
      default: 0
    },
    
    createdAt: {
      type: Date,
      default: Date.now
    },
    
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    
    description: {
      type: String,
      default: ''
    }
  }],
  
  // 동기화 상태
  syncState: {
    isLocked: {
      type: Boolean,
      default: false
    },
    
    lockedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    
    lockAcquiredAt: {
      type: Date,
      default: null
    },
    
    lastSyncAt: {
      type: Date,
      default: Date.now
    },
    
    activeClients: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true,
  collection: 'yjs_documents'
});

/**
 * 인덱스 설정
 */
YjsDocumentSchema.index({ 'updates.timestamp': 1 });
YjsDocumentSchema.index({ 'metadata.lastEditAt': -1 });
YjsDocumentSchema.index({ 'snapshots.createdAt': -1 });
YjsDocumentSchema.index({ 'syncState.lastSyncAt': -1 });

/**
 * 가상 속성 - 최근 업데이트
 */
YjsDocumentSchema.virtual('recentUpdates').get(function() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return this.updates.filter(update => update.timestamp >= oneHourAgo);
});

/**
 * 가상 속성 - 문서 크기 (바이트)
 */
YjsDocumentSchema.virtual('documentSize').get(function() {
  return this.documentState ? this.documentState.length : 0;
});

/**
 * 가상 속성 - 총 업데이트 크기
 */
YjsDocumentSchema.virtual('totalUpdateSize').get(function() {
  return this.updates.reduce((total, update) => total + update.update.length, 0);
});

/**
 * 메서드 - 업데이트 추가
 */
YjsDocumentSchema.methods.addUpdate = async function(updateData, clientId, origin = 'unknown') {
  const update = {
    update: Buffer.from(updateData),
    clock: this.metadata.totalUpdates + 1,
    timestamp: new Date(),
    clientId: clientId,
    origin: origin
  };
  
  this.updates.push(update);
  this.metadata.totalUpdates++;
  this.metadata.lastEditAt = new Date();
  
  // 업데이트가 너무 많으면 압축 트리거
  if (this.updates.length > 1000) {
    await this.compressUpdates();
  }
  
  return this.save();
};

/**
 * 메서드 - 문서 상태 업데이트
 */
YjsDocumentSchema.methods.updateDocumentState = async function(stateVector, documentState, elementCount = 0) {
  this.stateVector = Buffer.from(stateVector);
  this.documentState = Buffer.from(documentState);
  this.metadata.elementCount = elementCount;
  this.metadata.lastEditAt = new Date();
  this.syncState.lastSyncAt = new Date();
  
  return this.save();
};

/**
 * 메서드 - 업데이트 압축
 */
YjsDocumentSchema.methods.compressUpdates = async function() {
  if (this.updates.length === 0) return;
  
  const originalSize = this.totalUpdateSize;
  
  // 오래된 업데이트들을 문서 상태에 병합하고 제거
  const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24시간 전
  const oldUpdates = this.updates.filter(update => update.timestamp < cutoffDate);
  const recentUpdates = this.updates.filter(update => update.timestamp >= cutoffDate);
  
  // 최근 업데이트만 유지
  this.updates = recentUpdates;
  
  const compressedSize = this.totalUpdateSize;
  
  // 압축 통계 업데이트
  this.metadata.compressionStats = {
    originalSize,
    compressedSize,
    compressionRatio: originalSize > 0 ? compressedSize / originalSize : 0
  };
  this.metadata.compressedAt = new Date();
  
  return this.save();
};

/**
 * 메서드 - 스냅샷 생성
 */
YjsDocumentSchema.methods.createSnapshot = async function(userId, description = '') {
  const snapshotId = new Date().toISOString();
  
  const snapshot = {
    id: snapshotId,
    snapshot: this.documentState,
    stateVector: this.stateVector,
    elementCount: this.metadata.elementCount,
    createdAt: new Date(),
    createdBy: userId,
    description: description
  };
  
  this.snapshots.push(snapshot);
  
  // 최대 10개의 스냅샷만 유지
  if (this.snapshots.length > 10) {
    this.snapshots.shift();
  }
  
  return this.save();
};

/**
 * 메서드 - 잠금 획득
 */
YjsDocumentSchema.methods.acquireLock = async function(userId) {
  if (this.syncState.isLocked) {
    // 잠금이 5분 이상 된 경우 자동 해제
    const lockTimeout = 5 * 60 * 1000; // 5분
    if (Date.now() - this.syncState.lockAcquiredAt.getTime() > lockTimeout) {
      await this.releaseLock();
    } else {
      throw new Error('Document is currently locked by another user');
    }
  }
  
  this.syncState.isLocked = true;
  this.syncState.lockedBy = userId;
  this.syncState.lockAcquiredAt = new Date();
  
  return this.save();
};

/**
 * 메서드 - 잠금 해제
 */
YjsDocumentSchema.methods.releaseLock = async function() {
  this.syncState.isLocked = false;
  this.syncState.lockedBy = null;
  this.syncState.lockAcquiredAt = null;
  
  return this.save();
};

/**
 * 메서드 - 클라이언트 수 업데이트
 */
YjsDocumentSchema.methods.updateActiveClients = async function(count) {
  this.syncState.activeClients = count;
  this.syncState.lastSyncAt = new Date();
  
  return this.save();
};

/**
 * 정적 메서드 - 문서 찾기 또는 생성
 */
YjsDocumentSchema.statics.findOrCreate = async function(documentId, initialState = null) {
  let yjsDoc = await this.findOne({ documentId });
  
  if (!yjsDoc) {
    // 초기 상태 설정
    const emptyStateVector = Buffer.alloc(0);
    const emptyDocumentState = initialState ? Buffer.from(initialState) : Buffer.alloc(0);
    
    yjsDoc = new this({
      documentId,
      stateVector: emptyStateVector,
      documentState: emptyDocumentState,
      updates: [],
      metadata: {
        version: '1.0.0',
        elementCount: 0,
        totalUpdates: 0
      }
    });
    
    await yjsDoc.save();
  }
  
  return yjsDoc;
};

/**
 * 정적 메서드 - 특정 시점 이후 업데이트 가져오기
 */
YjsDocumentSchema.statics.getUpdatesSince = async function(documentId, sinceTime) {
  const yjsDoc = await this.findOne({ documentId });
  if (!yjsDoc) return [];
  
  return yjsDoc.updates.filter(update => update.timestamp > sinceTime);
};

/**
 * 정적 메서드 - 오래된 문서 정리
 */
YjsDocumentSchema.statics.cleanupOldDocuments = async function(daysOld = 30) {
  const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  
  const result = await this.updateMany(
    {
      'metadata.lastEditAt': { $lt: cutoffDate },
      'syncState.activeClients': 0
    },
    {
      $set: {
        updates: [], // 오래된 업데이트 제거
        'metadata.compressedAt': new Date()
      }
    }
  );
  
  return result;
};

/**
 * 정적 메서드 - 압축이 필요한 문서 찾기
 */
YjsDocumentSchema.statics.findDocumentsNeedingCompression = async function(updateThreshold = 500) {
  return this.find({
    $expr: { $gte: [{ $size: '$updates' }, updateThreshold] }
  });
};

/**
 * 정적 메서드 - 통계 가져오기
 */
YjsDocumentSchema.statics.getStatistics = async function() {
  const pipeline = [
    {
      $group: {
        _id: null,
        totalDocuments: { $sum: 1 },
        totalElements: { $sum: '$metadata.elementCount' },
        totalUpdates: { $sum: '$metadata.totalUpdates' },
        avgElementsPerDoc: { $avg: '$metadata.elementCount' },
        avgUpdatesPerDoc: { $avg: '$metadata.totalUpdates' }
      }
    }
  ];
  
  const result = await this.aggregate(pipeline);
  return result[0] || {
    totalDocuments: 0,
    totalElements: 0,
    totalUpdates: 0,
    avgElementsPerDoc: 0,
    avgUpdatesPerDoc: 0
  };
};

/**
 * 미들웨어 - 저장 전 검증
 */
YjsDocumentSchema.pre('save', function(next) {
  // 메타데이터 자동 업데이트
  if (this.isModified('updates') || this.isModified('documentState')) {
    this.metadata.lastEditAt = new Date();
    this.syncState.lastSyncAt = new Date();
  }
  
  next();
});

/**
 * 미들웨어 - 업데이트 후 후처리
 */
YjsDocumentSchema.post('save', function(doc) {
  // 업데이트 이벤트 발생 (다른 시스템에서 활용 가능)
  if (doc.isModified('documentState')) {
    // 이벤트 발생 로직 (예: Redis pub/sub, WebSocket 알림 등)
    console.log(`YJS Document ${doc.documentId} updated at ${doc.metadata.lastEditAt}`);
  }
});

module.exports = mongoose.model('YjsDocument', YjsDocumentSchema);