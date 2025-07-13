/**
 * CollaborationSession Model - 실시간 협업 세션 관리
 * 
 * 주요 기능:
 * 1. 협업 세션 생성 및 관리
 * 2. 참가자 추적 및 상태 관리
 * 3. 세션 메타데이터 저장
 * 4. 활성 세션 조회 및 정리
 * 
 * @module CollaborationSession
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * 참가자 스키마
 */
const ParticipantSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  joinedAt: {
    type: Date,
    default: Date.now,
    required: true
  },
  
  lastSeenAt: {
    type: Date,
    default: Date.now,
    required: true
  },
  
  status: {
    type: String,
    enum: ['online', 'away', 'offline'],
    default: 'online',
    required: true
  },
  
  cursor: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  },
  
  color: {
    type: String,
    required: true,
    match: /^#[0-9A-F]{6}$/i  // HEX 색상 코드 검증
  },
  
  // 사용자 역할 (옵션)
  role: {
    type: String,
    enum: ['viewer', 'editor', 'owner'],
    default: 'editor'
  },
  
  // 사용자 활동 메트릭
  metrics: {
    editsCount: { type: Number, default: 0 },
    messagesCount: { type: Number, default: 0 },
    totalActiveTime: { type: Number, default: 0 } // 밀리초
  }
}, { _id: false });

/**
 * 협업 세션 스키마
 */
const CollaborationSessionSchema = new Schema({
  documentId: {
    type: Schema.Types.ObjectId,
    ref: 'Document',
    required: true,
    index: true
  },
  
  workspaceId: {
    type: Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true
  },
  
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  
  participants: [ParticipantSchema],
  
  // 세션 설정
  settings: {
    maxParticipants: {
      type: Number,
      default: 50
    },
    
    allowAnonymous: {
      type: Boolean,
      default: false
    },
    
    autoSaveInterval: {
      type: Number,
      default: 30000  // 30초
    },
    
    idleTimeout: {
      type: Number,
      default: 1800000  // 30분
    }
  },
  
  // 세션 통계
  statistics: {
    totalParticipants: {
      type: Number,
      default: 0
    },
    
    peakParticipants: {
      type: Number,
      default: 0
    },
    
    totalEdits: {
      type: Number,
      default: 0
    },
    
    totalMessages: {
      type: Number,
      default: 0
    },
    
    conflictsResolved: {
      type: Number,
      default: 0
    }
  },
  
  // 세션 메타데이터
  metadata: {
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    
    lastActivityAt: {
      type: Date,
      default: Date.now
    },
    
    endedAt: {
      type: Date,
      default: null
    },
    
    endReason: {
      type: String,
      enum: ['manual', 'timeout', 'error', 'maintenance'],
      default: null
    }
  }
}, {
  timestamps: true,
  collection: 'collaboration_sessions'
});

/**
 * 인덱스 설정
 */
CollaborationSessionSchema.index({ 'participants.userId': 1 });
CollaborationSessionSchema.index({ createdAt: 1 });
CollaborationSessionSchema.index({ 'metadata.lastActivityAt': 1 });

/**
 * 가상 속성 - 현재 온라인 참가자 수
 */
CollaborationSessionSchema.virtual('onlineCount').get(function() {
  return this.participants.filter(p => p.status === 'online').length;
});

/**
 * 가상 속성 - 세션 지속 시간
 */
CollaborationSessionSchema.virtual('duration').get(function() {
  const endTime = this.metadata.endedAt || new Date();
  return endTime - this.createdAt;
});

/**
 * 메서드 - 참가자 추가
 */
CollaborationSessionSchema.methods.addParticipant = async function(userId, userInfo) {
  // 이미 참가 중인지 확인
  const existingIndex = this.participants.findIndex(
    p => p.userId.toString() === userId.toString()
  );
  
  if (existingIndex !== -1) {
    // 기존 참가자 상태 업데이트
    this.participants[existingIndex].status = 'online';
    this.participants[existingIndex].lastSeenAt = new Date();
  } else {
    // 최대 참가자 수 확인
    if (this.participants.length >= this.settings.maxParticipants) {
      throw new Error('Session is full');
    }
    
    // 새 참가자 추가
    this.participants.push({
      userId,
      color: userInfo.color || this._generateUserColor(),
      role: userInfo.role || 'editor'
    });
    
    // 통계 업데이트
    this.statistics.totalParticipants++;
    if (this.onlineCount > this.statistics.peakParticipants) {
      this.statistics.peakParticipants = this.onlineCount;
    }
  }
  
  this.metadata.lastActivityAt = new Date();
  return this.save();
};

/**
 * 메서드 - 참가자 제거
 */
CollaborationSessionSchema.methods.removeParticipant = async function(userId) {
  const participantIndex = this.participants.findIndex(
    p => p.userId.toString() === userId.toString()
  );
  
  if (participantIndex !== -1) {
    this.participants[participantIndex].status = 'offline';
    this.participants[participantIndex].lastSeenAt = new Date();
  }
  
  // 모든 참가자가 오프라인인 경우 세션 종료 고려
  if (this.onlineCount === 0) {
    this.isActive = false;
    this.metadata.endedAt = new Date();
    this.metadata.endReason = 'timeout';
  }
  
  this.metadata.lastActivityAt = new Date();
  return this.save();
};

/**
 * 메서드 - 참가자 상태 업데이트
 */
CollaborationSessionSchema.methods.updateParticipantStatus = async function(userId, status) {
  const participant = this.participants.find(
    p => p.userId.toString() === userId.toString()
  );
  
  if (participant) {
    participant.status = status;
    participant.lastSeenAt = new Date();
    this.metadata.lastActivityAt = new Date();
    return this.save();
  }
  
  return null;
};

/**
 * 메서드 - 커서 위치 업데이트
 */
CollaborationSessionSchema.methods.updateCursor = async function(userId, cursor) {
  const participant = this.participants.find(
    p => p.userId.toString() === userId.toString()
  );
  
  if (participant) {
    participant.cursor = cursor;
    participant.lastSeenAt = new Date();
    // 커서 업데이트는 자주 발생하므로 save 호출 최소화
    return this;
  }
  
  return null;
};

/**
 * 메서드 - 활동 메트릭 업데이트
 */
CollaborationSessionSchema.methods.updateMetrics = async function(type, userId) {
  const participant = this.participants.find(
    p => p.userId.toString() === userId.toString()
  );
  
  if (participant) {
    switch (type) {
      case 'edit':
        participant.metrics.editsCount++;
        this.statistics.totalEdits++;
        break;
      case 'message':
        participant.metrics.messagesCount++;
        this.statistics.totalMessages++;
        break;
      case 'conflict':
        this.statistics.conflictsResolved++;
        break;
    }
    
    this.metadata.lastActivityAt = new Date();
    return this.save();
  }
  
  return null;
};

/**
 * 메서드 - 세션 종료
 */
CollaborationSessionSchema.methods.endSession = async function(reason = 'manual') {
  this.isActive = false;
  this.metadata.endedAt = new Date();
  this.metadata.endReason = reason;
  
  // 모든 참가자를 오프라인으로 설정
  this.participants.forEach(p => {
    p.status = 'offline';
  });
  
  return this.save();
};

/**
 * 정적 메서드 - 활성 세션 찾기
 */
CollaborationSessionSchema.statics.findActiveSession = async function(documentId) {
  return this.findOne({
    documentId,
    isActive: true
  }).populate('participants.userId', 'name email avatar');
};

/**
 * 정적 메서드 - 사용자의 활성 세션 찾기
 */
CollaborationSessionSchema.statics.findUserActiveSessions = async function(userId) {
  return this.find({
    isActive: true,
    'participants.userId': userId,
    'participants.status': 'online'
  });
};

/**
 * 정적 메서드 - 오래된 세션 정리
 */
CollaborationSessionSchema.statics.cleanupInactiveSessions = async function(inactiveThreshold = 3600000) {
  const threshold = new Date(Date.now() - inactiveThreshold);
  
  return this.updateMany(
    {
      isActive: true,
      'metadata.lastActivityAt': { $lt: threshold }
    },
    {
      $set: {
        isActive: false,
        'metadata.endedAt': new Date(),
        'metadata.endReason': 'timeout'
      }
    }
  );
};

/**
 * 헬퍼 메서드 - 사용자 색상 생성
 * @private
 */
CollaborationSessionSchema.methods._generateUserColor = function() {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#FECA57', '#FF9FF3', '#54A0FF', '#48DBFB',
    '#FF6B9D', '#C44569', '#786FA6', '#F8B500'
  ];
  
  // 이미 사용 중인 색상 제외
  const usedColors = this.participants.map(p => p.color);
  const availableColors = colors.filter(c => !usedColors.includes(c));
  
  if (availableColors.length > 0) {
    return availableColors[Math.floor(Math.random() * availableColors.length)];
  }
  
  // 모든 색상이 사용 중이면 랜덤 색상 생성
  return '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
};

/**
 * 미들웨어 - 저장 전 유효성 검사
 */
CollaborationSessionSchema.pre('save', function(next) {
  // 참가자 수 제한 확인
  if (this.participants.length > this.settings.maxParticipants) {
    return next(new Error('Maximum participants exceeded'));
  }
  
  // 세션 ID 생성 (새 문서인 경우)
  if (this.isNew && !this.sessionId) {
    this.sessionId = `session-${this.documentId}-${Date.now()}`;
  }
  
  next();
});

/**
 * 미들웨어 - 업데이트 시 타임스탬프 갱신
 */
CollaborationSessionSchema.pre('findOneAndUpdate', function(next) {
  this.set({ updatedAt: new Date() });
  next();
});

module.exports = mongoose.model('CollaborationSession', CollaborationSessionSchema);