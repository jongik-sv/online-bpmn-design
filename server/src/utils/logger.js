/**
 * Logger - 서버 로깅 유틸리티
 * 
 * Winston 기반 구조화된 로깅
 * 
 * @class Logger
 */

const winston = require('winston');
const path = require('path');

// 로그 레벨 정의
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

// 로그 색상 정의
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue'
};

winston.addColors(colors);

// 기본 로거 설정
const createLogger = (namespace = 'App') => {
  // 로그 디렉토리 생성
  const logDir = path.join(__dirname, '../../logs');
  
  return winston.createLogger({
    levels,
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { 
      service: namespace,
      pid: process.pid
    },
    transports: [
      // 콘솔 출력
      new winston.transports.Console({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple(),
          winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
            return `${timestamp} [${service}] ${level}: ${message} ${metaStr}`;
          })
        )
      }),
      
      // 에러 로그 파일
      new winston.transports.File({
        filename: path.join(logDir, 'error.log'),
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5
      }),
      
      // 전체 로그 파일
      new winston.transports.File({
        filename: path.join(logDir, 'combined.log'),
        maxsize: 5242880, // 5MB
        maxFiles: 5
      })
    ],
    
    // 예외 처리
    exceptionHandlers: [
      new winston.transports.File({ 
        filename: path.join(logDir, 'exceptions.log') 
      })
    ],
    
    // Promise rejection 처리
    rejectionHandlers: [
      new winston.transports.File({ 
        filename: path.join(logDir, 'rejections.log') 
      })
    ]
  });
};

// Logger 클래스
class Logger {
  constructor(namespace = 'App') {
    this.logger = createLogger(namespace);
    this.namespace = namespace;
  }
  
  debug(message, ...args) {
    this.logger.debug(message, ...args);
  }
  
  info(message, ...args) {
    this.logger.info(message, ...args);
  }
  
  warn(message, ...args) {
    this.logger.warn(message, ...args);
  }
  
  error(message, ...args) {
    this.logger.error(message, ...args);
  }
  
  // 성능 측정
  startTimer(label) {
    return this.logger.startTimer();
  }
  
  // HTTP 요청 로깅
  logRequest(req, res, responseTime) {
    this.info('HTTP Request', {
      method: req.method,
      url: req.url,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`
    });
  }
  
  // 데이터베이스 쿼리 로깅
  logQuery(operation, collection, query, duration) {
    this.debug('Database Query', {
      operation,
      collection,
      query: JSON.stringify(query),
      duration: `${duration}ms`
    });
  }
  
  // WebSocket 이벤트 로깅
  logWebSocket(event, clientId, data) {
    this.debug('WebSocket Event', {
      event,
      clientId,
      data: typeof data === 'object' ? JSON.stringify(data) : data
    });
  }
  
  // Y.js 동기화 로깅
  logSync(documentId, clientId, updateSize, operation) {
    this.debug('Y.js Sync', {
      documentId,
      clientId,
      updateSize,
      operation
    });
  }
  
  // 협업 세션 로깅
  logSession(sessionId, action, participantCount, metadata = {}) {
    this.info('Collaboration Session', {
      sessionId,
      action,
      participantCount,
      ...metadata
    });
  }
}

// 로그 디렉토리 생성 (필요한 경우)
const fs = require('fs');
const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

module.exports = { Logger };