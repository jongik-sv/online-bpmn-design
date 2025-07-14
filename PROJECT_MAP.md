# BPMN 실시간 협업 에디터 - 완전 프로젝트 맵

> AI Agent 전용 참고 문서 - 디버깅 및 개발 작업 시 활용

## 🏗️ 전체 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────────┐
│                        클라이언트 (포트 3001)                       │
├─────────────────────────────────────────────────────────────────┤
│  BPMN.js Modeler  ←→  BpmnSyncManager  ←→  Y.js CRDT            │
│       ↓                      ↓                   ↓               │
│  EventBus         ←→  YjsDocumentManager ←→  ProviderManager     │
│       ↓                      ↓                   ↓               │
│  UI Components    ←→  AwarenessUI       ←→  WebSocket Provider   │
└─────────────────────────────────────────────────────────────────┘
                                 ↓ WebSocket
┌─────────────────────────────────────────────────────────────────┐
│                        서버 (포트 3000)                          │
├─────────────────────────────────────────────────────────────────┤
│  Express API     ←→  SessionService     ←→  MongoDB             │
│       ↓                      ↓                   ↓               │
│  WebSocket       ←→  PersistenceService ←→  Y.js Documents       │
│       ↓                      ↓                   ↓               │
│  CollaborationServer  ←→  NotificationService ←→  Comments        │
└─────────────────────────────────────────────────────────────────┘
```

## 📁 디렉토리 구조 및 파일 역할

### 클라이언트 (/client/src)

```
client/src/
├── app.js                     # 🎯 메인 애플리케이션 진입점
│   ├── BpmnCollaborationEditor class
│   ├── _initialize() → 전체 시스템 초기화
│   ├── _initializeBpmnModeler() → BPMN.js 설정
│   ├── _initializeCollaboration() → 협업 기능 초기화
│   └── startCollaboration(documentId) → 협업 시작
│
├── core/                      # 🔧 핵심 동기화 및 성능 관리
│   ├── BpmnSyncManager.js     # ⭐ 핵심 동기화 매니저
│   │   ├── _handleBpmnCommand(event) → BPMN.js 이벤트 처리
│   │   ├── _syncShapeCreate(context) → 요소 생성 동기화
│   │   ├── _syncShapeAppend(context) → 태스크 추가 + 연결 동기화 ⚠️ 위치 문제
│   │   ├── _syncShapeMove(context) → 요소 이동 동기화
│   │   ├── _handleYjsChanges(event, transaction) → Y.js → BPMN.js 동기화
│   │   └── _applyRemoteElementCreate() → 원격 요소 생성 적용
│   │
│   ├── ConflictResolver.js    # 🚫 현재 비활성화 (무한 루프 방지)
│   │
│   ├── PerformanceOptimizer.js # 🚀 성능 최적화
│   │   ├── _adjustQualityLevel() → 적응형 품질 조정
│   │   ├── _processBatchRender() → 배치 렌더링
│   │   └── _performMemoryCleanup() → 메모리 정리
│   │
│   └── connection-manager.js  # 🌐 WebSocket 연결 관리
│       ├── connect(ydoc, roomId) → Y.js 연결 초기화
│       ├── _setupWebSocketHandlers() → 이벤트 핸들러
│       └── sendMessage(message) → 메시지 송신
│
├── crdt/                      # 📄 Y.js CRDT 데이터 구조
│   ├── YjsDocumentManager.js  # ⭐ Y.js 문서 생명주기 관리
│   │   ├── getElementsMap() → BPMN 요소 Y.Map 반환
│   │   ├── createElement(id, data) → Y.js 요소 생성
│   │   └── updateElement(id, updates) → 요소 업데이트
│   │
│   ├── YjsProviders.js        # 🔗 프로바이더 통합 관리
│   │   ├── _initializeWebSocket() → WebSocket 프로바이더
│   │   ├── updateCursor(cursor) → 커서 브로드캐스트
│   │   └── reconnectProvider(type) → 재연결 처리
│   │
│   └── CRDTStructures.js      # 📊 CRDT 데이터 변환
│       ├── BpmnElementCRDT.fromBpmnElement() → BPMN → Y.js
│       └── BpmnElementCRDT.toBpmnElement() → Y.js → BPMN
│
├── ui/                        # 🖥️ 사용자 인터페이스
│   ├── AwarenessUI.js         # 👥 실시간 사용자 인식
│   │   ├── _createUserCursor() → 사용자 커서 생성
│   │   ├── _updateLocalCursor(event) → 로컬 커서 업데이트
│   │   └── localCursor → 현재 마우스 위치 (위치 문제 관련)
│   │
│   └── CollaborationPanel.js  # 🎛️ 협업 제어 패널
│       ├── _startCollaboration() → 협업 시작
│       └── _updateConnectionStatus() → 상태 업데이트
│
└── utils/
    └── Logger.js              # 📝 로깅 유틸리티
```

### 서버 (/server/src)

```
server/src/
├── server.js                  # 🎯 메인 서버 진입점
│   ├── BpmnCollaborationServer class
│   ├── start() → 서버 시작
│   ├── _connectMongoDB() → 데이터베이스 연결
│   └── _setupRoutes() → API 라우트 설정
│
├── models/                    # 🗃️ MongoDB 스키마
│   ├── CollaborationSession.js # 협업 세션 모델
│   │   └── { documentId, participants[], settings, statistics }
│   │
│   ├── CollaborationComment.js # 댓글 모델
│   │   └── { elementId, text, position{x,y}, authorId, replies[] }
│   │
│   └── YjsDocument.js         # Y.js 문서 상태
│       └── { stateVector, documentState, updates[], snapshots[] }
│
├── services/                  # 🔧 비즈니스 로직
│   ├── SessionService.js      # 세션 관리
│   │   ├── createSession() → 새 세션 생성
│   │   ├── addParticipant() → 참가자 추가
│   │   └── updateCursor() → 커서 위치 업데이트
│   │
│   ├── PersistenceService.js  # Y.js 영속성
│   │   ├── loadDocument() → 문서 로드
│   │   ├── saveDocument() → 문서 저장
│   │   └── createSnapshot() → 스냅샷 생성
│   │
│   └── NotificationService.js # 실시간 알림
│       ├── broadcastNotification() → 알림 브로드캐스트
│       └── getUserNotifications() → 사용자 알림 조회
│
├── websocket/
│   └── collaboration-server.js # 🌐 WebSocket 서버
│       ├── _handleConnection() → 연결 처리
│       ├── _handleSyncMessage() → Y.js 동기화
│       ├── _handleAwarenessMessage() → 사용자 인식
│       └── _broadcastToRoom() → 룸 브로드캐스트
│
└── utils/
    └── logger.js              # 📝 Winston 로거
```

## 🔄 핵심 동기화 플로우

### 1. 태스크 생성 플로우 (위치 문제 발생 지점)

```
사용자 클릭 → BPMN.js Palette
                ↓
        shape.append 이벤트 발생
                ↓
    BpmnSyncManager._handleBpmnCommand()
                ↓
        _syncShapeAppend(context) ⚠️ 위치 처리 문제
                ↓ 
        Y.js 트랜잭션 생성
                ↓
        WebSocket → 서버 → 다른 클라이언트
                ↓
        원격 클라이언트 _handleYjsChanges()
                ↓
        _applyRemoteElementCreate() → BPMN.js 캔버스
```

### 2. Y.js CRDT 동기화 메커니즘

```
클라이언트 A                    서버                     클라이언트 B
    ↓                          ↓                         ↓
Y.Map.set(elementId, data) → WebSocket Provider → Y.Map 업데이트
    ↓                          ↓                         ↓
로컬 변경 감지             State Vector 관리        원격 변경 감지
    ↓                          ↓                         ↓
_handleBpmnCommand()        MongoDB 저장           _handleYjsChanges()
    ↓                          ↓                         ↓
BPMN.js 업데이트           PersistenceService      BPMN.js 적용
```

### 3. Awareness (사용자 인식) 플로우

```
마우스 이동 → AwarenessUI._updateLocalCursor()
                ↓
        Y.js Awareness 업데이트
                ↓
        ProviderManager.updateCursor()
                ↓
        WebSocket 브로드캐스트
                ↓
        원격 클라이언트 커서 업데이트
```

## 🎯 위치 문제 관련 핵심 파일 및 함수

### 문제 발생 지점
**파일**: `client/src/core/BpmnSyncManager.js:366-398`
**함수**: `_syncShapeAppend(context)`
**문제**: shape.append에서 실제 사용자 클릭 위치가 context에 전달되지 않음

### 관련 함수들
1. **BpmnSyncManager.js:173-201** `'shape.create'` 케이스 처리
2. **BpmnSyncManager.js:283-320** `_syncShapeCreate(context)`
3. **BpmnSyncManager.js:1200-1246** `_createRemoteShape()` - 원격 요소 생성
4. **AwarenessUI.js:439-440, 892-893** 마우스 위치 계산 로직

### 디버깅 포인트
```javascript
// 위치 정보 확인이 필요한 지점들
context.position     // BPMN.js에서 전달하는 위치 정보
context.target       // 타겟 위치 정보
context.shape.x/y    // 생성된 요소의 위치
awarenessUI.localCursor  // 현재 마우스 위치
```

## 📡 API 엔드포인트

### REST API
```
GET /health                           # 서버 상태
GET /api/sessions                     # 세션 조회
POST /api/sessions                    # 세션 생성
DELETE /api/sessions/:sessionId       # 세션 종료
GET /api/documents/:documentId        # 문서 상태
POST /api/documents/:documentId/snapshots  # 스냅샷 생성
GET /api/documents/:documentId/comments     # 댓글 조회
POST /api/documents/:documentId/comments    # 댓글 생성
GET /api/stats                        # 시스템 통계
```

### WebSocket 메시지 타입
```javascript
const messageType = {
  SYNC: 0,           // Y.js 동기화
  AWARENESS: 1,      // 사용자 인식 (커서, 선택)
  AUTH: 2,           // 인증
  CUSTOM: 3,         // 사용자 정의 (댓글, 잠금)
  ERROR: 4,          // 에러
  NOTIFICATION: 5    // 알림
}
```

## 🗃️ 데이터베이스 스키마

### MongoDB 컬렉션
```javascript
// collaboration_sessions
{
  documentId: ObjectId,
  participants: [{
    userId: ObjectId,
    username: String,
    isOnline: Boolean,
    cursor: { x: Number, y: Number },
    color: String,
    lastActivityAt: Date
  }],
  settings: {
    maxParticipants: Number,
    autoSaveInterval: Number,
    allowComments: Boolean
  }
}

// yjs_documents  
{
  documentId: ObjectId,
  stateVector: Buffer,      // Y.js 상태 벡터
  documentState: Buffer,    // 압축된 문서 상태
  updates: [{
    timestamp: Date,
    update: Buffer,         // Y.js 업데이트 데이터
    clientId: String
  }]
}

// collaboration_comments
{
  documentId: ObjectId,
  elementId: String,        // BPMN 요소 ID
  text: String,
  position: { x: Number, y: Number },
  authorId: ObjectId,
  isResolved: Boolean,
  replies: [...]
}
```

## ⚙️ 환경 설정

### 클라이언트 (포트 3001)
```bash
cd client && npm start
```

### 서버 (포트 3000)
```bash
cd server && npm run dev
```

### MongoDB 연결
- 주소: `210.1.1.40:27017`
- 데이터베이스: 환경변수 또는 기본값

## 🚨 알려진 이슈

### 1. 태스크 위치 문제 (현재 디버깅 중)
- **증상**: 원격 UI에서 태스크가 잘못된 위치에 생성됨
- **원인**: `_syncShapeAppend()에서 사용자 클릭 위치 손실
- **관련 파일**: `BpmnSyncManager.js:366-398`

### 2. ConflictResolver 비활성화
- **이유**: 무한 루프 발생
- **상태**: 임시 비활성화
- **파일**: `ConflictResolver.js`

### 3. IndexedDB 프로바이더 비활성화
- **이유**: 메모리 누수 방지
- **영향**: 오프라인 기능 제한

## 🛠️ 디버깅 명령어

### 개발 명령어
```bash
# 클라이언트
npm run lint      # ESLint 검사
npm test         # Jest 테스트
npm run build    # 프로덕션 빌드

# 서버
npm run dev      # nodemon 개발 서버
npm run lint     # ESLint 검사
npm test         # Jest 테스트
```

### 로그 활성화
```javascript
// 클라이언트에서 상세 로그 확인
localStorage.setItem('bpmn-debug', 'true');

// 서버 로그 레벨 설정
process.env.LOG_LEVEL = 'debug';
```

## 🔍 핵심 클래스 및 메서드 참조

### BpmnSyncManager (클라이언트 핵심)
```javascript
class BpmnSyncManager {
  // 이벤트 처리
  _handleBpmnCommand(event)           // BPMN.js → Y.js
  _handleYjsChanges(event, transaction) // Y.js → BPMN.js
  
  // 동기화 메서드
  _syncShapeCreate(context)           // 요소 생성
  _syncShapeAppend(context) ⚠️        // 요소 추가 (위치 문제)
  _syncShapeMove(context)             // 요소 이동
  _syncShapeDelete(context)           // 요소 삭제
  
  // 원격 적용
  _applyRemoteElementCreate(elementId) // 원격 요소 생성
  _createRemoteShape(elementId, data)  // 원격 Shape 생성
  _createRemoteConnection(elementId, data) // 원격 Connection 생성
}
```

### CollaborationServer (서버 핵심)
```javascript
class CollaborationServer {
  // 연결 관리
  _handleConnection(socket)           // 새 연결 처리
  _joinRoom(socket, roomId)          // 룸 참가
  _leaveRoom(socket, roomId)         // 룸 나가기
  
  // 메시지 처리
  _handleSyncMessage(socket, message) // Y.js 동기화
  _handleAwarenessMessage(socket, message) // 사용자 인식
  _handleCustomMessage(socket, message)    // 사용자 정의
  
  // 브로드캐스팅
  _broadcastToRoom(roomId, message)   // 룸 내 브로드캐스트
}
```

이 프로젝트 맵은 AI Agent가 BPMN 실시간 협업 에디터의 구조를 완전히 이해하고, 효과적으로 디버깅 및 개발 작업을 수행할 수 있도록 설계되었습니다.