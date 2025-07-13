/**
 * BPMN Collaboration Server - Main Server Entry Point
 * 
 * Express + WebSocket 기반 BPMN 협업 서버
 * Y.js 동기화, 세션 관리, 영속성 제공
 * 
 * @author Claude AI Assistant
 * @version 1.0.0
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const winston = require('winston');
require('dotenv').config();

// 협업 서버 및 서비스
const CollaborationServer = require('./websocket/collaboration-server');
const SessionService = require('./services/SessionService');
const PersistenceService = require('./services/PersistenceService');

// 모델들
const CollaborationSession = require('./models/CollaborationSession');
const YjsDocument = require('./models/YjsDocument');
const CollaborationComment = require('./models/CollaborationComment');

/**
 * BPMN 협업 서버 메인 클래스
 */
class BpmnCollaborationServer {
  constructor(options = {}) {
    this.options = {
      port: process.env.PORT || 3000,
      mongoUrl: process.env.MONGODB_URL || 'mongodb://localhost:27017/bpmn_collaboration',
      corsOrigin: process.env.CORS_ORIGIN || '*',
      jwtSecret: process.env.JWT_SECRET || 'your-secret-key',
      enableRateLimit: process.env.ENABLE_RATE_LIMIT !== 'false',
      enableLogging: process.env.ENABLE_LOGGING !== 'false',
      logLevel: process.env.LOG_LEVEL || 'info',
      ...options
    };
    
    // Express 앱
    this.app = express();
    this.server = null;
    
    // 서비스들
    this.collaborationServer = null;
    this.sessionService = null;
    this.persistenceService = null;
    
    // 로거 설정
    this.logger = winston.createLogger({
      level: this.options.logLevel,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.colorize(),
        winston.format.simple()
      ),
      transports: [
        new winston.transports.Console(),
        ...(this.options.enableLogging ? [
          new winston.transports.File({ 
            filename: 'logs/server.log',
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5
          })
        ] : [])
      ]
    });
    
    // 상태
    this.isInitialized = false;
    this.isShuttingDown = false;
  }
  
  /**
   * 서버 초기화 및 시작
   */
  async start() {
    try {
      this.logger.info('Starting BPMN Collaboration Server...');
      
      // 1. MongoDB 연결
      await this._connectMongoDB();
      
      // 2. Express 미들웨어 설정
      this._setupMiddleware();
      
      // 3. API 라우트 설정
      this._setupRoutes();
      
      // 4. 서비스 초기화
      await this._initializeServices();
      
      // 5. HTTP 서버 생성
      this.server = http.createServer(this.app);
      
      // 6. WebSocket 협업 서버 초기화
      this._initializeCollaborationServer();
      
      // 7. 에러 핸들링 설정
      this._setupErrorHandling();
      
      // 8. 서버 시작
      await this._startServer();
      
      this.isInitialized = true;
      this.logger.info(`🚀 BPMN Collaboration Server started on port ${this.options.port}`);
      
    } catch (error) {
      this.logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }
  
  /**
   * MongoDB 연결
   * @private
   */
  async _connectMongoDB() {
    try {
      await mongoose.connect(this.options.mongoUrl);
      
      this.logger.info('📦 Connected to MongoDB');
      
      // 연결 이벤트 처리
      mongoose.connection.on('error', (error) => {
        this.logger.error('MongoDB connection error:', error);
      });
      
      mongoose.connection.on('disconnected', () => {
        this.logger.warn('MongoDB disconnected');
      });
      
    } catch (error) {
      this.logger.error('MongoDB connection failed:', error);
      throw error;
    }
  }
  
  /**
   * Express 미들웨어 설정
   * @private
   */
  _setupMiddleware() {
    // 보안 헤더
    this.app.use(helmet({
      contentSecurityPolicy: false, // WebSocket 허용을 위해 비활성화
    }));
    
    // CORS 설정
    this.app.use(cors({
      origin: this.options.corsOrigin,
      credentials: true
    }));
    
    // 압축
    this.app.use(compression());
    
    // JSON 파싱
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // 속도 제한
    if (this.options.enableRateLimit) {
      const limiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15분
        max: 1000, // 요청 한도
        message: 'Too many requests from this IP',
        standardHeaders: true,
        legacyHeaders: false
      });
      
      this.app.use(limiter);
    }
    
    // 요청 로깅
    this.app.use((req, res, next) => {
      this.logger.debug(`${req.method} ${req.path} from ${req.ip}`);
      next();
    });
  }
  
  /**
   * API 라우트 설정
   * @private
   */
  _setupRoutes() {
    // 헬스 체크
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.env.npm_package_version || '1.0.0'
      });
    });
    
    // 세션 관리 API
    this.app.get('/api/sessions', async (req, res) => {
      try {
        const { documentId, userId } = req.query;
        
        if (documentId) {
          const session = await this.sessionService.getActiveSessionByDocument(documentId);
          res.json(session);
        } else if (userId) {
          const sessions = await this.sessionService.getUserActiveSessions(userId);
          res.json(sessions);
        } else {
          const stats = await this.sessionService.getGlobalStats();
          res.json(stats);
        }
      } catch (error) {
        this.logger.error('Session API error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    this.app.post('/api/sessions', async (req, res) => {
      try {
        const { documentId, workspaceId, createdBy, options } = req.body;
        
        const session = await this.sessionService.createSession(
          documentId,
          workspaceId,
          createdBy,
          options
        );
        
        res.status(201).json(session);
      } catch (error) {
        this.logger.error('Session creation error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    this.app.delete('/api/sessions/:sessionId', async (req, res) => {
      try {
        const { sessionId } = req.params;
        const { reason } = req.body;
        
        await this.sessionService.endSession(sessionId, reason);
        res.status(204).send();
      } catch (error) {
        this.logger.error('Session deletion error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // 문서 관리 API
    this.app.get('/api/documents/:documentId', async (req, res) => {
      try {
        const { documentId } = req.params;
        
        const documentState = await this.persistenceService.loadDocument(documentId);
        const stats = await this.persistenceService.getDocumentStats(documentId);
        
        res.json({
          documentId,
          state: documentState ? Array.from(documentState) : null,
          stats
        });
      } catch (error) {
        this.logger.error('Document API error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    this.app.post('/api/documents/:documentId/snapshots', async (req, res) => {
      try {
        const { documentId } = req.params;
        const { userId, description } = req.body;
        
        const snapshot = await this.persistenceService.createSnapshot(
          documentId,
          userId,
          description
        );
        
        res.status(201).json(snapshot);
      } catch (error) {
        this.logger.error('Snapshot creation error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // 댓글 API
    this.app.get('/api/documents/:documentId/comments', async (req, res) => {
      try {
        const { documentId } = req.params;
        const { elementId, resolved, search } = req.query;
        
        let comments;
        
        if (search) {
          comments = await CollaborationComment.searchComments(documentId, search);
        } else if (elementId) {
          comments = await CollaborationComment.findByElement(documentId, elementId);
        } else if (resolved !== undefined) {
          const isResolved = resolved === 'true';
          comments = await CollaborationComment.find({
            documentId,
            isResolved,
            'metadata.status': 'active'
          }).populate('authorId', 'name email avatar');
        } else {
          comments = await CollaborationComment.find({
            documentId,
            'metadata.status': 'active'
          }).populate('authorId', 'name email avatar').sort({ createdAt: -1 });
        }
        
        res.json(comments);
      } catch (error) {
        this.logger.error('Comments API error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    this.app.post('/api/documents/:documentId/comments', async (req, res) => {
      try {
        const { documentId } = req.params;
        const commentData = { ...req.body, documentId };
        
        const comment = new CollaborationComment(commentData);
        await comment.save();
        
        await comment.populate('authorId', 'name email avatar');
        
        res.status(201).json(comment);
      } catch (error) {
        this.logger.error('Comment creation error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // 통계 API
    this.app.get('/api/stats', async (req, res) => {
      try {
        const systemStats = await this.persistenceService.getSystemStats();
        const sessionStats = await this.sessionService.getGlobalStats();
        
        res.json({
          system: systemStats,
          sessions: sessionStats,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        this.logger.error('Stats API error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // 404 핸들러
    this.app.use('*', (req, res) => {
      res.status(404).json({ error: 'Route not found' });
    });
  }
  
  /**
   * 서비스 초기화
   * @private
   */
  async _initializeServices() {
    // 세션 서비스 초기화
    this.sessionService = new SessionService({
      maxSessionDuration: 24 * 60 * 60 * 1000,
      inactiveTimeout: 30 * 60 * 1000,
      maxParticipants: 50
    });
    
    // 영속성 서비스 초기화
    this.persistenceService = new PersistenceService({
      autoSaveInterval: 30000,
      compressionThreshold: 500,
      enableAutoCompression: true,
      enablePeriodicBackup: true
    });
    
    this.logger.info('🔧 Services initialized');
  }
  
  /**
   * WebSocket 협업 서버 초기화
   * @private
   */
  _initializeCollaborationServer() {
    this.collaborationServer = new CollaborationServer(this.server, {
      websocket: {
        path: '/collaboration'
      },
      heartbeatInterval: 30000,
      persistenceInterval: 30000,
      authRequired: false // 개발 환경에서는 인증 비활성화
    });
    
    this.logger.info('🤝 Collaboration server initialized');
  }
  
  /**
   * 에러 핸들링 설정
   * @private
   */
  _setupErrorHandling() {
    // Express 에러 핸들러
    this.app.use((error, req, res, next) => {
      this.logger.error('Express error:', error);
      
      res.status(error.status || 500).json({
        error: process.env.NODE_ENV === 'production' 
          ? 'Internal server error' 
          : error.message,
        timestamp: new Date().toISOString()
      });
    });
    
    // 처리되지 않은 Promise 거부
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled Promise Rejection:', reason);
    });
    
    // 처리되지 않은 예외
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught Exception:', error);
      this._gracefulShutdown(1);
    });
    
    // 종료 신호 처리
    process.on('SIGTERM', () => {
      this.logger.info('SIGTERM received, shutting down gracefully');
      this._gracefulShutdown(0);
    });
    
    process.on('SIGINT', () => {
      this.logger.info('SIGINT received, shutting down gracefully');
      this._gracefulShutdown(0);
    });
  }
  
  /**
   * HTTP 서버 시작
   * @private
   */
  async _startServer() {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, () => {
        resolve();
      });
    });
  }
  
  /**
   * 우아한 종료
   * @private
   */
  async _gracefulShutdown(exitCode = 0) {
    if (this.isShuttingDown) return;
    
    this.isShuttingDown = true;
    this.logger.info('Graceful shutdown initiated...');
    
    try {
      // 새로운 연결 거부
      if (this.server) {
        this.server.close();
      }
      
      // 협업 서버 종료
      if (this.collaborationServer) {
        await this.collaborationServer.shutdown();
      }
      
      // 서비스 종료
      if (this.sessionService) {
        await this.sessionService.shutdown();
      }
      
      if (this.persistenceService) {
        await this.persistenceService.shutdown();
      }
      
      // MongoDB 연결 종료
      await mongoose.connection.close();
      
      this.logger.info('Graceful shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during shutdown:', error);
    } finally {
      process.exit(exitCode);
    }
  }
  
  /**
   * 서비스 초기화
   * @private
   */
  _initializeServices() {
    // 세션 서비스
    this.sessionService = new SessionService({
      maxConcurrentSessions: 100,
      sessionTimeout: 30000
    });
    
    // 영속성 서비스
    this.persistenceService = new PersistenceService({
      enableCompression: true,
      autoSaveInterval: 30000
    });
    
    this.logger.info('Services initialized');
  }
  
  /**
   * Graceful shutdown 설정
   * @private
   */
  _setupGracefulShutdown() {
    // SIGTERM, SIGINT 핸들러
    process.on('SIGTERM', () => this._gracefulShutdown(0));
    process.on('SIGINT', () => this._gracefulShutdown(0));
    
    // 예외 처리
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught Exception:', error);
      this._gracefulShutdown(1);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      this._gracefulShutdown(1);
    });
  }

  /**
   * 서버 시작
   */
  async start() {
    try {
      this.logger.info('Starting BPMN Collaboration Server...');
      
      // MongoDB 연결
      await this._connectMongoDB();
      
      // 서비스 초기화
      this._initializeServices();
      
      // 라우트 설정
      this._setupRoutes();
      
      // HTTP 서버 시작
      this.server = this.app.listen(this.options.port, () => {
        this.logger.info(`🚀 Server running on port ${this.options.port}`);
        this.logger.info(`📡 WebSocket server available at ws://localhost:${this.options.port}/collaboration`);
      });
      
      // WebSocket 협업 서버 초기화
      this.collaborationServer = new CollaborationServer(this.server, {
        sessionService: this.sessionService,
        persistenceService: this.persistenceService,
        logger: this.logger
      });
      
      // Graceful shutdown 설정
      this._setupGracefulShutdown();
      
      this.logger.info('✅ BPMN Collaboration Server started successfully');
      
    } catch (error) {
      this.logger.error('Failed to start server:', error);
      throw error;
    }
  }

  /**
   * 서버 중지
   */
  async stop() {
    await this._gracefulShutdown(0);
  }
}

// 서버 인스턴스 생성 및 시작
const server = new BpmnCollaborationServer();

if (require.main === module) {
  server.start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = BpmnCollaborationServer;