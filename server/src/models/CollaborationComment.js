/**
 * CollaborationComment Model - 협업 댓글
 * 
 * BPMN 다이어그램 요소에 대한 댓글 및 토론 기능을 제공
 * 실시간 협업 중 의사소통을 위한 스레드형 댓글 시스템
 * 
 * @module CollaborationComment
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * 댓글 답글 스키마
 */
const ReplySchema = new Schema({
  authorId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  authorName: {
    type: String,
    required: true
  },
  
  text: {
    type: String,
    required: true,
    maxlength: 2000
  },
  
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  },
  
  // 멘션된 사용자들
  mentions: [{
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    userName: {
      type: String
    }
  }],
  
  // 답글 상태
  isEdited: {
    type: Boolean,
    default: false
  },
  
  editHistory: [{
    text: String,
    editedAt: Date,
    editedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    }
  }]
}, { _id: true });

/**
 * 협업 댓글 스키마
 */
const CollaborationCommentSchema = new Schema({
  documentId: {
    type: Schema.Types.ObjectId,
    ref: 'Document',
    required: true,
    index: true
  },
  
  // BPMN 요소 ID (특정 요소에 대한 댓글인 경우)
  elementId: {
    type: String,
    default: null,
    index: true
  },
  
  // 일반 댓글인 경우 'general', 요소별 댓글인 경우 'element'
  commentType: {
    type: String,
    enum: ['general', 'element', 'annotation'],
    default: 'general',
    required: true
  },
  
  // 댓글 작성자
  authorId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  authorName: {
    type: String,
    required: true
  },
  
  // 댓글 내용
  text: {
    type: String,
    required: true,
    maxlength: 5000
  },
  
  // 댓글 위치 (캔버스 좌표)
  position: {
    x: {
      type: Number,
      required: true,
      default: 0
    },
    y: {
      type: Number,
      required: true,
      default: 0
    }
  },
  
  // 해결 상태
  isResolved: {
    type: Boolean,
    default: false,
    index: true
  },
  
  resolvedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  resolvedAt: {
    type: Date,
    default: null
  },
  
  // 우선순위 (선택사항)
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  
  // 카테고리/태그
  tags: [{
    type: String,
    maxlength: 50
  }],
  
  // 댓글 스레드 (답글들)
  replies: [ReplySchema],
  
  // 멘션된 사용자들
  mentions: [{
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    userName: {
      type: String
    },
    notified: {
      type: Boolean,
      default: false
    }
  }],
  
  // 첨부파일 (선택사항)
  attachments: [{
    fileName: String,
    fileUrl: String,
    fileSize: Number,
    mimeType: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // 편집 이력
  editHistory: [{
    text: String,
    editedAt: Date,
    editedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  
  // 메타데이터
  metadata: {
    // 댓글이 생성된 협업 세션 ID
    sessionId: {
      type: String,
      default: null
    },
    
    // 댓글 가시성
    visibility: {
      type: String,
      enum: ['public', 'private', 'team'],
      default: 'public'
    },
    
    // 댓글 상태
    status: {
      type: String,
      enum: ['active', 'archived', 'deleted'],
      default: 'active'
    },
    
    // 마지막 활동 시간 (답글 포함)
    lastActivityAt: {
      type: Date,
      default: Date.now
    },
    
    // 좋아요/반응
    reactions: [{
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User'
      },
      reaction: {
        type: String,
        enum: ['like', 'dislike', 'helpful', 'resolved', 'question']
      },
      createdAt: {
        type: Date,
        default: Date.now
      }
    }]
  }
}, {
  timestamps: true,
  collection: 'collaboration_comments'
});

/**
 * 인덱스 설정
 */
CollaborationCommentSchema.index({ documentId: 1, elementId: 1 });
CollaborationCommentSchema.index({ authorId: 1, createdAt: -1 });
CollaborationCommentSchema.index({ isResolved: 1, priority: 1 });
CollaborationCommentSchema.index({ 'metadata.lastActivityAt': -1 });
CollaborationCommentSchema.index({ 'mentions.userId': 1 });
CollaborationCommentSchema.index({ tags: 1 });

/**
 * 가상 속성 - 답글 수
 */
CollaborationCommentSchema.virtual('replyCount').get(function() {
  return this.replies.length;
});

/**
 * 가상 속성 - 총 반응 수
 */
CollaborationCommentSchema.virtual('totalReactions').get(function() {
  return this.metadata.reactions.length;
});

/**
 * 가상 속성 - 편집 여부
 */
CollaborationCommentSchema.virtual('isEdited').get(function() {
  return this.editHistory.length > 0;
});

/**
 * 메서드 - 답글 추가
 */
CollaborationCommentSchema.methods.addReply = async function(replyData) {
  const reply = {
    authorId: replyData.authorId,
    authorName: replyData.authorName,
    text: replyData.text,
    mentions: replyData.mentions || [],
    createdAt: new Date(),
    updatedAt: new Date()
  };
  
  this.replies.push(reply);
  this.metadata.lastActivityAt = new Date();
  
  return this.save();
};

/**
 * 메서드 - 댓글 해결
 */
CollaborationCommentSchema.methods.resolve = async function(userId) {
  this.isResolved = true;
  this.resolvedBy = userId;
  this.resolvedAt = new Date();
  this.metadata.lastActivityAt = new Date();
  
  return this.save();
};

/**
 * 메서드 - 댓글 해결 취소
 */
CollaborationCommentSchema.methods.unresolve = async function() {
  this.isResolved = false;
  this.resolvedBy = null;
  this.resolvedAt = null;
  this.metadata.lastActivityAt = new Date();
  
  return this.save();
};

/**
 * 메서드 - 댓글 편집
 */
CollaborationCommentSchema.methods.edit = async function(newText, userId) {
  // 편집 이력에 현재 텍스트 저장
  this.editHistory.push({
    text: this.text,
    editedAt: new Date(),
    editedBy: userId
  });
  
  this.text = newText;
  this.metadata.lastActivityAt = new Date();
  
  return this.save();
};

/**
 * 메서드 - 반응 추가/제거
 */
CollaborationCommentSchema.methods.toggleReaction = async function(userId, reaction) {
  const existingReactionIndex = this.metadata.reactions.findIndex(
    r => r.userId.toString() === userId.toString() && r.reaction === reaction
  );
  
  if (existingReactionIndex !== -1) {
    // 기존 반응 제거
    this.metadata.reactions.splice(existingReactionIndex, 1);
  } else {
    // 새 반응 추가
    this.metadata.reactions.push({
      userId: userId,
      reaction: reaction,
      createdAt: new Date()
    });
  }
  
  this.metadata.lastActivityAt = new Date();
  return this.save();
};

/**
 * 메서드 - 멘션 알림 처리
 */
CollaborationCommentSchema.methods.markMentionsAsNotified = async function() {
  this.mentions.forEach(mention => {
    mention.notified = true;
  });
  
  return this.save();
};

/**
 * 메서드 - 댓글 아카이브
 */
CollaborationCommentSchema.methods.archive = async function() {
  this.metadata.status = 'archived';
  return this.save();
};

/**
 * 메서드 - 댓글 삭제 (소프트 삭제)
 */
CollaborationCommentSchema.methods.softDelete = async function() {
  this.metadata.status = 'deleted';
  return this.save();
};

/**
 * 정적 메서드 - 문서의 미해결 댓글 찾기
 */
CollaborationCommentSchema.statics.findUnresolvedByDocument = async function(documentId) {
  return this.find({
    documentId: documentId,
    isResolved: false,
    'metadata.status': 'active'
  }).populate('authorId', 'name email avatar')
    .populate('resolvedBy', 'name email')
    .sort({ createdAt: -1 });
};

/**
 * 정적 메서드 - 요소별 댓글 찾기
 */
CollaborationCommentSchema.statics.findByElement = async function(documentId, elementId) {
  return this.find({
    documentId: documentId,
    elementId: elementId,
    'metadata.status': 'active'
  }).populate('authorId', 'name email avatar')
    .populate('resolvedBy', 'name email')
    .sort({ createdAt: -1 });
};

/**
 * 정적 메서드 - 사용자 멘션 댓글 찾기
 */
CollaborationCommentSchema.statics.findMentions = async function(userId, unreadOnly = false) {
  const query = {
    'mentions.userId': userId,
    'metadata.status': 'active'
  };
  
  if (unreadOnly) {
    query['mentions.notified'] = false;
  }
  
  return this.find(query)
    .populate('authorId', 'name email avatar')
    .populate('documentId', 'title')
    .sort({ 'metadata.lastActivityAt': -1 });
};

/**
 * 정적 메서드 - 우선순위별 댓글 통계
 */
CollaborationCommentSchema.statics.getStatsByPriority = async function(documentId) {
  const pipeline = [
    {
      $match: {
        documentId: mongoose.Types.ObjectId(documentId),
        'metadata.status': 'active'
      }
    },
    {
      $group: {
        _id: {
          priority: '$priority',
          resolved: '$isResolved'
        },
        count: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: '$_id.priority',
        total: { $sum: '$count' },
        resolved: {
          $sum: {
            $cond: [{ $eq: ['$_id.resolved', true] }, '$count', 0]
          }
        },
        unresolved: {
          $sum: {
            $cond: [{ $eq: ['$_id.resolved', false] }, '$count', 0]
          }
        }
      }
    }
  ];
  
  return this.aggregate(pipeline);
};

/**
 * 정적 메서드 - 활성 토론 찾기 (최근 활동 기준)
 */
CollaborationCommentSchema.statics.findActiveDiscussions = async function(documentId, hours = 24) {
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  return this.find({
    documentId: documentId,
    'metadata.lastActivityAt': { $gte: cutoffTime },
    'metadata.status': 'active'
  }).populate('authorId', 'name email avatar')
    .sort({ 'metadata.lastActivityAt': -1 });
};

/**
 * 정적 메서드 - 댓글 검색
 */
CollaborationCommentSchema.statics.searchComments = async function(documentId, searchTerm, options = {}) {
  const query = {
    documentId: documentId,
    'metadata.status': 'active',
    $or: [
      { text: { $regex: searchTerm, $options: 'i' } },
      { tags: { $in: [new RegExp(searchTerm, 'i')] } },
      { 'replies.text': { $regex: searchTerm, $options: 'i' } }
    ]
  };
  
  // 필터 추가
  if (options.priority) {
    query.priority = options.priority;
  }
  
  if (options.isResolved !== undefined) {
    query.isResolved = options.isResolved;
  }
  
  if (options.authorId) {
    query.authorId = options.authorId;
  }
  
  return this.find(query)
    .populate('authorId', 'name email avatar')
    .populate('resolvedBy', 'name email')
    .sort({ 'metadata.lastActivityAt': -1 })
    .limit(options.limit || 50);
};

/**
 * 정적 메서드 - 오래된 해결된 댓글 정리
 */
CollaborationCommentSchema.statics.cleanupResolvedComments = async function(daysOld = 90) {
  const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  
  return this.updateMany(
    {
      isResolved: true,
      resolvedAt: { $lt: cutoffDate }
    },
    {
      $set: { 'metadata.status': 'archived' }
    }
  );
};

/**
 * 미들웨어 - 저장 전 처리
 */
CollaborationCommentSchema.pre('save', function(next) {
  // 멘션 추출 (@username 형태)
  if (this.isModified('text')) {
    const mentionRegex = /@(\w+)/g;
    const mentions = [];
    let match;
    
    while ((match = mentionRegex.exec(this.text)) !== null) {
      mentions.push(match[1]);
    }
    
    // 중복 제거 및 기존 멘션과 병합
    const uniqueMentions = [...new Set(mentions)];
    // 실제 구현에서는 username으로 User 조회 필요
  }
  
  next();
});

/**
 * 미들웨어 - 저장 후 처리
 */
CollaborationCommentSchema.post('save', function(doc) {
  // 알림 발송 등의 후처리 작업
  if (doc.mentions && doc.mentions.length > 0) {
    // 멘션된 사용자들에게 알림 발송
    console.log(`Comment ${doc._id} has ${doc.mentions.length} mentions`);
  }
});

module.exports = mongoose.model('CollaborationComment', CollaborationCommentSchema);