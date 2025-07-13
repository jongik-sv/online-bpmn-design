/**
 * Logger - 클라이언트 로깅 유틸리티
 * 
 * 로그 레벨, 포맷팅, 원격 로깅 기능 제공
 * 
 * @class Logger
 */

export class Logger {
  constructor(namespace = 'App', options = {}) {
    this.namespace = namespace;
    this.options = {
      level: 'info',
      enableConsole: true,
      enableRemote: false,
      remoteUrl: null,
      maxLogHistory: 1000,
      ...options
    };
    
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    
    this.currentLevel = this.levels[this.options.level] || 1;
    this.logHistory = [];
  }
  
  debug(message, ...args) {
    this._log('debug', message, ...args);
  }
  
  info(message, ...args) {
    this._log('info', message, ...args);
  }
  
  warn(message, ...args) {
    this._log('warn', message, ...args);
  }
  
  error(message, ...args) {
    this._log('error', message, ...args);
  }
  
  _log(level, message, ...args) {
    if (this.levels[level] < this.currentLevel) return;
    
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      namespace: this.namespace,
      message,
      args
    };
    
    // 히스토리에 추가
    this.logHistory.push(logEntry);
    if (this.logHistory.length > this.options.maxLogHistory) {
      this.logHistory.shift();
    }
    
    // 콘솔 출력
    if (this.options.enableConsole) {
      const formatted = `[${timestamp}] ${level.toUpperCase()} [${this.namespace}] ${message}`;
      
      switch (level) {
        case 'debug':
          console.debug(formatted, ...args);
          break;
        case 'info':
          console.info(formatted, ...args);
          break;
        case 'warn':
          console.warn(formatted, ...args);
          break;
        case 'error':
          console.error(formatted, ...args);
          break;
      }
    }
    
    // 원격 로깅
    if (this.options.enableRemote && this.options.remoteUrl) {
      this._sendToRemote(logEntry);
    }
  }
  
  _sendToRemote(logEntry) {
    // 원격 로깅 구현 (선택사항)
    fetch(this.options.remoteUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(logEntry)
    }).catch(() => {
      // 원격 로깅 실패는 무시
    });
  }
  
  getHistory() {
    return [...this.logHistory];
  }
  
  clearHistory() {
    this.logHistory = [];
  }
}