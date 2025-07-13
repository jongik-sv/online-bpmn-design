# BPMN 실시간 협업 편집기

Y.js CRDT 기반의 실시간 협업 BPMN 다이어그램 편집기입니다.

## 🚀 주요 기능

- **실시간 협업**: 여러 사용자가 동시에 BPMN 다이어그램을 편집
- **충돌 해결**: 자동 충돌 감지 및 해결 메커니즘
- **사용자 인식**: 실시간 커서, 선택 영역, 사용자 목록 표시
- **성능 최적화**: 적응형 품질 조정 및 메모리 관리
- **영속성**: MongoDB 기반 문서 저장 및 버전 관리
- **확장성**: 50+ 동시 사용자 지원

## 🏗️ 시스템 아키텍처

```
┌─────────────────┐    WebSocket    ┌─────────────────┐
│   Client Side   │ ←──────────────→ │   Server Side   │
│                 │                 │                 │
│ • BPMN.js       │                 │ • Express       │
│ • Y.js CRDT     │                 │ • WebSocket     │
│ • UI Components │                 │ • MongoDB       │
│ • Sync Manager  │                 │ • Services      │
└─────────────────┘                 └─────────────────┘
```

## 📦 설치 및 실행

### 사전 요구사항

- Node.js 18+
- MongoDB 4.4+
- npm 또는 yarn

### 서버 실행

```bash
# 서버 디렉토리로 이동
cd server

# 의존성 설치
npm install

# 환경 변수 설정
cp .env.example .env
# .env 파일에서 MongoDB URL 등을 설정

# 서버 시작 (개발 모드)
npm run dev

# 또는 프로덕션 모드
npm start
```

### 클라이언트 실행

```bash
# 클라이언트 디렉토리로 이동
cd client

# 의존성 설치
npm install

# 개발 서버 시작
npm start

# 또는 빌드 후 서빙
npm run build
npm run serve
```

서버가 `http://localhost:3000`에서, 클라이언트가 `http://localhost:3001`에서 실행됩니다.

## 🎯 사용 방법

### 기본 사용법

1. 브라우저에서 `http://localhost:3001` 접속
2. 사용자 이름 입력
3. "협업 시작" 버튼 클릭
4. BPMN 요소를 드래그앤드롭으로 추가
5. 다른 브라우저에서 같은 URL 접속하여 실시간 협업 확인

### 협업 기능

- **실시간 편집**: 여러 사용자가 동시에 다이어그램 편집
- **사용자 커서**: 다른 사용자의 마우스 커서 실시간 표시
- **선택 표시**: 다른 사용자가 선택한 요소 하이라이트
- **충돌 해결**: 동시 편집 시 자동 충돌 해결

### API 사용법

```javascript
// 편집기 초기화
const editor = new BpmnCollaborationEditor({
  container: '#canvas',
  documentId: 'my-document',
  userId: 'user123',
  userName: 'John Doe',
  serverUrl: 'ws://localhost:3000'
});

// 협업 시작
await editor.startCollaboration();

// 다이어그램 로드
await editor.loadDiagram(xmlString);

// 다이어그램 내보내기
const xml = await editor.exportDiagram();
const svg = await editor.exportSVG();
```

## 🔧 개발 환경 설정

### 환경 변수

**서버 (.env)**
```env
PORT=3000
MONGODB_URL=mongodb://localhost:27017/bpmn_collaboration
JWT_SECRET=your-secret-key
CORS_ORIGIN=http://localhost:3001
LOG_LEVEL=info
```

**클라이언트**
- Webpack Dev Server가 자동으로 프록시 설정
- 개발 시 별도 설정 불필요

### 디렉토리 구조

```
online_bpmn_design/
├── client/                     # 클라이언트 애플리케이션
│   ├── src/
│   │   ├── core/              # 핵심 동기화 모듈
│   │   ├── crdt/              # Y.js CRDT 관련
│   │   ├── ui/                # UI 컴포넌트
│   │   ├── utils/             # 유틸리티
│   │   └── app.js             # 메인 애플리케이션
│   ├── public/
│   │   └── index.html         # HTML 템플릿
│   └── webpack.config.js      # Webpack 설정
│
├── server/                     # 서버 애플리케이션
│   ├── src/
│   │   ├── models/            # MongoDB 모델
│   │   ├── services/          # 비즈니스 로직
│   │   ├── websocket/         # WebSocket 서버
│   │   └── server.js          # 메인 서버
│   └── package.json
│
└── doc/                        # 설계 문서
    └── comprehensive_design_document.md
```

## 🧪 테스트

```bash
# 서버 테스트
cd server
npm test

# 클라이언트 테스트
cd client
npm test
```

## 📊 모니터링

### 성능 메트릭 확인

```bash
# 시스템 통계 API
curl http://localhost:3000/api/stats

# 특정 세션 정보
curl http://localhost:3000/api/sessions?documentId=your-doc-id
```

### 로그 확인

- 서버 로그: `server/logs/server.log`
- 클라이언트 로그: 브라우저 개발자 도구 콘솔

## 🔒 보안 고려사항

- JWT 토큰 기반 인증 (선택적)
- CORS 설정
- Rate Limiting
- Input 검증 및 Sanitization

## 🚀 배포

### Docker 배포 (향후 지원 예정)

```bash
docker-compose up -d
```

### 수동 배포

1. 서버 빌드 및 배포
2. 클라이언트 빌드
3. 정적 파일 서빙 설정
4. MongoDB 연결 설정
5. 환경 변수 설정

## 📝 라이선스

MIT License

## 🤝 기여

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📞 지원

문제가 있거나 질문이 있으시면 Issue를 생성해 주세요.

---

*이 프로젝트는 BPMN.js와 Y.js를 기반으로 구축된 실시간 협업 편집기입니다.*