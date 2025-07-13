/**
 * CollaborationPanel - 협업 제어 패널 UI
 * 
 * 주요 기능:
 * 1. 협업 세션 제어 (시작/종료)
 * 2. 연결 상태 모니터링
 * 3. 설정 및 옵션 관리
 * 4. 성능 메트릭 표시
 * 5. 협업 모드 전환
 * 
 * @class CollaborationPanel
 */

import EventEmitter from 'eventemitter3';

export class CollaborationPanel extends EventEmitter {
  constructor(providerManager, performanceOptimizer, options = {}) {
    super();
    
    // 의존성 주입
    this.providerManager = providerManager;
    this.performanceOptimizer = performanceOptimizer;
    
    // 설정 옵션
    this.options = {
      position: 'bottom-left',       // 'top-left', 'top-right', 'bottom-left', 'bottom-right'
      collapsible: true,             // 접을 수 있는지 여부
      showMetrics: true,             // 성능 메트릭 표시
      showSettings: true,            // 설정 섹션 표시
      autoHide: false,               // 자동 숨김
      updateInterval: 1000,          // 메트릭 업데이트 간격 (ms)
      ...options
    };
    
    // 패널 상태
    this.isCollapsed = false;
    this.isVisible = true;
    this.collaborationMode = 'realtime'; // 'realtime', 'offline', 'review'
    
    // DOM 요소들
    this.container = null;
    this.statusSection = null;
    this.metricsSection = null;
    this.settingsSection = null;
    this.controlsSection = null;
    
    // 메트릭 업데이트 인터벌
    this.updateInterval = null;
    
    // 현재 상태
    this.currentStatus = {
      websocket: 'disconnected',
      indexeddb: 'disconnected',
      webrtc: 'disconnected',
      session: 'inactive'
    };
    
    // 초기화
    this._initialize();
  }
  
  /**
   * 협업 패널 초기화
   * @private
   */
  _initialize() {
    // DOM 요소 생성
    this._createPanelUI();
    
    // 이벤트 바인딩
    this._bindEvents();
    
    // 스타일 적용
    this._applyStyles();
    
    // 메트릭 업데이트 시작
    this._startMetricsUpdate();
    
    // CollaborationPanel initialized silently
  }
  
  /**
   * 패널 UI 생성
   * @private
   */
  _createPanelUI() {
    // 메인 컨테이너
    this.container = document.createElement('div');
    this.container.className = `collaboration-panel ${this.options.position}`;
    
    // 헤더
    const header = this._createHeader();
    this.container.appendChild(header);
    
    // 콘텐츠 컨테이너
    const content = document.createElement('div');
    content.className = 'panel-content';
    content.id = 'collaboration-content';
    
    // 상태 섹션
    this.statusSection = this._createStatusSection();
    content.appendChild(this.statusSection);
    
    // 제어 섹션
    this.controlsSection = this._createControlsSection();
    content.appendChild(this.controlsSection);
    
    // 메트릭 섹션
    if (this.options.showMetrics) {
      this.metricsSection = this._createMetricsSection();
      content.appendChild(this.metricsSection);
    }
    
    // 설정 섹션
    if (this.options.showSettings) {
      this.settingsSection = this._createSettingsSection();
      content.appendChild(this.settingsSection);
    }
    
    this.container.appendChild(content);
    
    // 페이지에 추가
    document.body.appendChild(this.container);
  }
  
  /**
   * 헤더 생성
   * @private
   */
  _createHeader() {
    const header = document.createElement('div');
    header.className = 'panel-header';
    header.innerHTML = `
      <div class="header-title">
        <span class="collaboration-icon">🤝</span>
        <span>Collaboration</span>
      </div>
      <div class="header-controls">
        ${this.options.collapsible ? '<button class="collapse-btn" title="Collapse">−</button>' : ''}
        <button class="close-btn" title="Close">×</button>
      </div>
    `;
    
    return header;
  }
  
  /**
   * 상태 섹션 생성
   * @private
   */
  _createStatusSection() {
    const section = document.createElement('div');
    section.className = 'status-section';
    section.innerHTML = `
      <h4>🌐 연결 상태</h4>
      <div class="status-grid">
        <div class="status-item">
          <span class="status-label">서버 연결:</span>
          <span class="status-indicator websocket" data-status="disconnected">●</span>
          <span class="status-text websocket">연결 안됨</span>
        </div>
        <div class="status-item">
          <span class="status-label">로컬 저장:</span>
          <span class="status-indicator indexeddb" data-status="disabled">●</span>
          <span class="status-text indexeddb">비활성화</span>
        </div>
        <div class="status-item">
          <span class="status-label">P2P 연결:</span>
          <span class="status-indicator webrtc" data-status="disabled">●</span>
          <span class="status-text webrtc">비활성화</span>
        </div>
      </div>
    `;
    
    return section;
  }
  
  /**
   * 제어 섹션 생성
   * @private
   */
  _createControlsSection() {
    const section = document.createElement('div');
    section.className = 'controls-section';
    section.innerHTML = `
      <h4>🎛️ 협업 제어</h4>
      <div class="controls-grid">
        <button class="control-btn primary" id="panel-start-collaboration">
          협업 시작
        </button>
        <button class="control-btn secondary" id="panel-stop-collaboration" disabled>
          협업 중지
        </button>
      </div>
      <div class="mode-selector">
        <label>Mode:</label>
        <select id="collaboration-mode">
          <option value="realtime">Real-time</option>
          <option value="offline">Offline</option>
          <option value="review">Review Only</option>
        </select>
      </div>
    `;
    
    return section;
  }
  
  /**
   * 메트릭 섹션 생성
   * @private
   */
  _createMetricsSection() {
    const section = document.createElement('div');
    section.className = 'metrics-section';
    section.innerHTML = `
      <h4>Performance Metrics</h4>
      <div class="metrics-grid">
        <div class="metric-item">
          <span class="metric-label">Latency:</span>
          <span class="metric-value" id="latency-value">- ms</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Frame Rate:</span>
          <span class="metric-value" id="framerate-value">- fps</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Memory:</span>
          <span class="metric-value" id="memory-value">- MB</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Quality:</span>
          <span class="metric-value" id="quality-value">High</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Users:</span>
          <span class="metric-value" id="users-value">0</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Sync Events:</span>
          <span class="metric-value" id="sync-value">0</span>
        </div>
      </div>
    `;
    
    return section;
  }
  
  /**
   * 설정 섹션 생성
   * @private
   */
  _createSettingsSection() {
    const section = document.createElement('div');
    section.className = 'settings-section';
    section.innerHTML = `
      <h4>Settings</h4>
      <div class="settings-grid">
        <div class="setting-item">
          <label class="setting-label">
            <input type="checkbox" id="enable-cursors" checked>
            Show User Cursors
          </label>
        </div>
        <div class="setting-item">
          <label class="setting-label">
            <input type="checkbox" id="enable-selections" checked>
            Show Selections
          </label>
        </div>
        <div class="setting-item">
          <label class="setting-label">
            <input type="checkbox" id="enable-auto-save" checked>
            Auto Save
          </label>
        </div>
        <div class="setting-item">
          <label class="setting-label">
            <input type="checkbox" id="enable-notifications" checked>
            Notifications
          </label>
        </div>
        <div class="setting-item">
          <label class="setting-label">Quality Mode:</label>
          <select id="quality-mode">
            <option value="auto">Auto</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
    `;
    
    return section;
  }
  
  /**
   * 이벤트 바인딩
   * @private
   */
  _bindEvents() {
    // 헤더 버튼 이벤트
    const collapseBtn = this.container.querySelector('.collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => this.toggleCollapse());
    }
    
    const closeBtn = this.container.querySelector('.close-btn');
    closeBtn.addEventListener('click', () => this.hide());
    
    // 제어 버튼 이벤트
    const startBtn = this.container.querySelector('#panel-start-collaboration');
    const stopBtn = this.container.querySelector('#panel-stop-collaboration');
    
    startBtn.addEventListener('click', () => this._startCollaboration());
    stopBtn.addEventListener('click', () => this._stopCollaboration());
    
    // 모드 선택기 이벤트
    const modeSelector = this.container.querySelector('#collaboration-mode');
    modeSelector.addEventListener('change', (e) => {
      this._changeCollaborationMode(e.target.value);
    });
    
    // 설정 이벤트
    this._bindSettingsEvents();
    
    // 프로바이더 이벤트
    this._bindProviderEvents();
    
    // 성능 옵티마이저 이벤트
    this._bindPerformanceEvents();
  }
  
  /**
   * 설정 이벤트 바인딩
   * @private
   */
  _bindSettingsEvents() {
    const settings = {
      'enable-cursors': (checked) => this.emit('settingChanged', { cursors: checked }),
      'enable-selections': (checked) => this.emit('settingChanged', { selections: checked }),
      'enable-auto-save': (checked) => this.emit('settingChanged', { autoSave: checked }),
      'enable-notifications': (checked) => this.emit('settingChanged', { notifications: checked })
    };
    
    Object.entries(settings).forEach(([id, handler]) => {
      const element = this.container.querySelector(`#${id}`);
      if (element) {
        element.addEventListener('change', (e) => handler(e.target.checked));
      }
    });
    
    // 품질 모드 선택기
    const qualityMode = this.container.querySelector('#quality-mode');
    if (qualityMode) {
      qualityMode.addEventListener('change', (e) => {
        this.emit('qualityModeChanged', e.target.value);
      });
    }
  }
  
  /**
   * 프로바이더 이벤트 바인딩
   * @private
   */
  _bindProviderEvents() {
    this.providerManager.on('providerConnected', ({ type }) => {
      this._updateConnectionStatus(type, 'connected');
    });
    
    this.providerManager.on('providerDisconnected', ({ type }) => {
      this._updateConnectionStatus(type, 'disconnected');
    });
    
    this.providerManager.on('providerError', ({ type, error }) => {
      this._updateConnectionStatus(type, 'error');
      this._showNotification(`${type} connection error: ${error.message}`, 'error');
    });
    
    this.providerManager.on('providerDisabled', ({ type, reason }) => {
      this._updateConnectionStatus(type, 'disabled');
      console.log(`${type} provider disabled: ${reason}`);
    });
  }
  
  /**
   * 성능 이벤트 바인딩
   * @private
   */
  _bindPerformanceEvents() {
    if (!this.performanceOptimizer) return;
    
    this.performanceOptimizer.on('qualityLevelChanged', ({ current, performance }) => {
      this._updateQualityMetric(current);
    });
    
    this.performanceOptimizer.on('performanceUpdate', (metrics) => {
      this._updatePerformanceMetrics(metrics);
    });
  }
  
  /**
   * 협업 시작
   * @private
   */
  async _startCollaboration() {
    try {
      const startBtn = this.container.querySelector('#panel-start-collaboration');
      const stopBtn = this.container.querySelector('#panel-stop-collaboration');
      
      startBtn.disabled = true;
      startBtn.textContent = '시작 중...';
      
      // 프로바이더 초기화 또는 재연결
      if (this.providerManager.isInitialized) {
        // 이미 초기화된 경우 재연결 시도
        console.log('Attempting to reconnect providers...');
        await this.providerManager.reconnectAll();
      } else {
        // 처음 초기화하는 경우
        console.log('Initializing providers...');
        await this.providerManager.initialize();
      }
      
      startBtn.textContent = '협업 중';
      startBtn.disabled = true;
      stopBtn.disabled = false;
      
      this.currentStatus.session = 'active';
      
      // 연결 상태 강제 업데이트
      this._forceUpdateConnectionStatus();
      
      this._showNotification('협업이 성공적으로 시작되었습니다', 'success');
      this.emit('collaborationStarted');
      
    } catch (error) {
      console.error('Collaboration start error:', error);
      
      const startBtn = this.container.querySelector('#panel-start-collaboration');
      startBtn.disabled = false;
      startBtn.textContent = '협업 시작';
      
      // 더 구체적인 에러 메시지 표시
      let errorMessage = '협업 시작 실패';
      if (error.message) {
        errorMessage += `: ${error.message}`;
      }
      
      this._showNotification(errorMessage, 'error');
      this.emit('collaborationError', error);
    }
  }
  
  /**
   * 협업 중지
   * @private
   */
  _stopCollaboration() {
    const startBtn = this.container.querySelector('#panel-start-collaboration');
    const stopBtn = this.container.querySelector('#panel-stop-collaboration');
    
    // 프로바이더 연결 해제
    this.providerManager.disconnect();
    
    startBtn.disabled = false;
    startBtn.textContent = '협업 시작';
    stopBtn.disabled = true;
    
    this.currentStatus.session = 'inactive';
    this._showNotification('협업이 중지되었습니다', 'info');
    this.emit('collaborationStopped');
  }
  
  /**
   * 협업 모드 변경
   * @private
   */
  _changeCollaborationMode(mode) {
    this.collaborationMode = mode;
    
    switch (mode) {
      case 'realtime':
        // 실시간 모드: 모든 프로바이더 활성화
        this.emit('modeChanged', { mode: 'realtime', enableAll: true });
        break;
        
      case 'offline':
        // 오프라인 모드: 로컬 저장소만 사용
        this.emit('modeChanged', { mode: 'offline', localOnly: true });
        break;
        
      case 'review':
        // 검토 모드: 읽기 전용
        this.emit('modeChanged', { mode: 'review', readOnly: true });
        break;
    }
    
    this._showNotification(`Switched to ${mode} mode`, 'info');
  }
  
  /**
   * 연결 상태 업데이트
   * @private
   */
  _updateConnectionStatus(type, status) {
    this.currentStatus[type] = status;
    
    const indicator = this.container.querySelector(`.status-indicator.${type}`);
    const text = this.container.querySelector(`.status-text.${type}`);
    
    if (indicator && text) {
      indicator.setAttribute('data-status', status);
      text.textContent = this._getStatusText(status);
    }
  }
  
  /**
   * 연결 상태 강제 업데이트
   * @private
   */
  _forceUpdateConnectionStatus() {
    // 프로바이더 상태 확인 및 UI 업데이트
    if (this.providerManager) {
      const providerStats = this.providerManager.getStats();
      
      // WebSocket 상태 확인
      if (this.providerManager.providers.websocket) {
        const wsStatus = this.providerManager.providers.websocket.shouldConnect ? 'connected' : 'disconnected';
        this._updateConnectionStatus('websocket', wsStatus);
      }
      
      // IndexedDB 상태 확인
      if (this.providerManager.providers.indexeddb) {
        this._updateConnectionStatus('indexeddb', 'connected');
      }
      
      // WebRTC 상태 확인
      if (this.providerManager.providers.webrtc) {
        this._updateConnectionStatus('webrtc', 'connected');
      }
    }
  }
  
  /**
   * 상태 텍스트 가져오기
   * @private
   */
  _getStatusText(status) {
    const statusTexts = {
      connected: '연결됨 ✓',
      disconnected: '연결 안됨',
      connecting: '연결 중...',
      error: '연결 오류 ✗',
      disabled: '비활성화',
      syncing: '동기화 중...',
      synced: '동기화됨 ✓'
    };
    
    return statusTexts[status] || status;
  }
  
  /**
   * 메트릭 업데이트 시작
   * @private
   */
  _startMetricsUpdate() {
    this.updateInterval = setInterval(() => {
      this._updateMetrics();
    }, this.options.updateInterval);
  }
  
  /**
   * 메트릭 업데이트
   * @private
   */
  _updateMetrics() {
    if (!this.options.showMetrics) return;
    
    // 프로바이더 통계
    const providerStats = this.providerManager.getStats();
    
    // 사용자 수
    const usersValue = this.container.querySelector('#users-value');
    if (usersValue) {
      usersValue.textContent = providerStats.connectedUsers.toString();
    }
    
    // 동기화 이벤트
    const syncValue = this.container.querySelector('#sync-value');
    if (syncValue) {
      syncValue.textContent = providerStats.syncEvents.toString();
    }
    
    // 성능 메트릭 (옵티마이저가 있는 경우)
    if (this.performanceOptimizer) {
      const perfMetrics = this.performanceOptimizer.getMetrics();
      this._updatePerformanceMetrics(perfMetrics.performanceState);
    }
  }
  
  /**
   * 성능 메트릭 업데이트
   * @private
   */
  _updatePerformanceMetrics(metrics) {
    const updates = {
      'latency-value': `${metrics.networkLatency || 0} ms`,
      'framerate-value': `${metrics.frameRate || 0} fps`,
      'memory-value': `${Math.round(metrics.memoryUsage || 0)} MB`,
      'quality-value': metrics.qualityLevel || 'Unknown'
    };
    
    Object.entries(updates).forEach(([id, value]) => {
      const element = this.container.querySelector(`#${id}`);
      if (element) {
        element.textContent = value;
      }
    });
  }
  
  /**
   * 품질 메트릭 업데이트
   * @private
   */
  _updateQualityMetric(quality) {
    const qualityValue = this.container.querySelector('#quality-value');
    if (qualityValue) {
      qualityValue.textContent = quality.charAt(0).toUpperCase() + quality.slice(1);
      qualityValue.className = `metric-value quality-${quality}`;
    }
  }
  
  /**
   * 알림 표시
   * @private
   */
  _showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    this.container.appendChild(notification);
    
    // 3초 후 제거
    setTimeout(() => {
      notification.remove();
    }, 3000);
    
    this.emit('notification', { message, type });
  }
  
  /**
   * 스타일 적용
   * @private
   */
  _applyStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .collaboration-panel {
        position: fixed;
        z-index: 1000;
        background: white;
        border: 1px solid #ddd;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.1);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        min-width: 300px;
        max-width: 400px;
      }
      
      .collaboration-panel.top-left { top: 20px; left: 20px; }
      .collaboration-panel.top-right { top: 20px; right: 20px; }
      .collaboration-panel.bottom-left { bottom: 20px; left: 20px; }
      .collaboration-panel.bottom-right { bottom: 20px; right: 20px; }
      
      .panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: #f8f9fa;
        border-bottom: 1px solid #eee;
        border-radius: 8px 8px 0 0;
      }
      
      .header-title {
        display: flex;
        align-items: center;
        font-weight: 600;
        color: #333;
      }
      
      .collaboration-icon {
        margin-right: 8px;
        font-size: 16px;
      }
      
      .header-controls {
        display: flex;
        gap: 8px;
      }
      
      .collapse-btn, .close-btn {
        background: none;
        border: none;
        font-size: 16px;
        cursor: pointer;
        color: #666;
        padding: 0;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .collapse-btn:hover, .close-btn:hover {
        color: #333;
      }
      
      .panel-content {
        padding: 16px;
        max-height: 500px;
        overflow-y: auto;
      }
      
      .panel-content.collapsed {
        display: none;
      }
      
      .status-section, .controls-section, .metrics-section, .settings-section {
        margin-bottom: 20px;
      }
      
      .status-section:last-child, .controls-section:last-child, 
      .metrics-section:last-child, .settings-section:last-child {
        margin-bottom: 0;
      }
      
      .status-section h4, .controls-section h4, 
      .metrics-section h4, .settings-section h4 {
        margin: 0 0 12px 0;
        font-size: 14px;
        font-weight: 600;
        color: #333;
      }
      
      .status-grid, .metrics-grid {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .status-item, .metric-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      
      .status-label, .metric-label {
        color: #666;
      }
      
      .status-indicator {
        font-size: 12px;
        margin: 0 8px;
      }
      
      .status-indicator[data-status="connected"] { color: #28a745; }
      .status-indicator[data-status="disconnected"] { color: #dc3545; }
      .status-indicator[data-status="connecting"] { color: #ffc107; }
      .status-indicator[data-status="error"] { color: #dc3545; }
      
      .status-text {
        font-weight: 500;
      }
      
      .metric-value {
        font-weight: 500;
        color: #333;
      }
      
      .metric-value.quality-high { color: #28a745; }
      .metric-value.quality-medium { color: #ffc107; }
      .metric-value.quality-low { color: #dc3545; }
      
      .controls-grid {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
      }
      
      .control-btn {
        flex: 1;
        padding: 8px 12px;
        border: 1px solid #ddd;
        border-radius: 4px;
        background: white;
        cursor: pointer;
        font-size: 14px;
        transition: all 0.2s ease;
      }
      
      .control-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      
      .control-btn.primary {
        background: #007bff;
        color: white;
        border-color: #007bff;
      }
      
      .control-btn.primary:hover:not(:disabled) {
        background: #0056b3;
      }
      
      .control-btn.secondary:hover:not(:disabled) {
        background: #f8f9fa;
      }
      
      .mode-selector {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .mode-selector label {
        color: #666;
        font-weight: 500;
      }
      
      .mode-selector select {
        flex: 1;
        padding: 6px 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        background: white;
      }
      
      .settings-grid {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      .setting-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      
      .setting-label {
        display: flex;
        align-items: center;
        cursor: pointer;
        color: #333;
      }
      
      .setting-label input[type="checkbox"] {
        margin-right: 8px;
      }
      
      .setting-item select {
        padding: 4px 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        background: white;
      }
      
      .notification {
        position: absolute;
        top: -40px;
        left: 0;
        right: 0;
        padding: 8px 12px;
        border-radius: 4px;
        color: white;
        font-size: 12px;
        text-align: center;
        animation: slideDown 0.3s ease;
      }
      
      .notification.success { background: #28a745; }
      .notification.error { background: #dc3545; }
      .notification.info { background: #17a2b8; }
      .notification.warning { background: #ffc107; color: #333; }
      
      @keyframes slideDown {
        from { transform: translateY(-10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    `;
    
    document.head.appendChild(style);
  }
  
  /**
   * 패널 접기/펼치기 토글
   * @public
   */
  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    const content = this.container.querySelector('.panel-content');
    const collapseBtn = this.container.querySelector('.collapse-btn');
    
    if (this.isCollapsed) {
      content.style.display = 'none';
      collapseBtn.textContent = '+';
    } else {
      content.style.display = 'block';
      collapseBtn.textContent = '−';
    }
    
    this.emit('collapsed', this.isCollapsed);
  }
  
  /**
   * 패널 표시/숨김
   * @public
   */
  toggle() {
    this.isVisible = !this.isVisible;
    this.container.style.display = this.isVisible ? 'block' : 'none';
    this.emit('visibility', this.isVisible);
  }
  
  /**
   * 패널 숨김
   * @public
   */
  hide() {
    this.isVisible = false;
    this.container.style.display = 'none';
    this.emit('hidden');
  }
  
  /**
   * 패널 표시
   * @public
   */
  show() {
    this.isVisible = true;
    this.container.style.display = 'block';
    this.emit('shown');
  }
  
  /**
   * 현재 상태 가져오기
   * @public
   */
  getCurrentStatus() {
    return { ...this.currentStatus };
  }
  
  /**
   * 리소스 정리
   * @public
   */
  destroy() {
    // 인터벌 정리
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    // DOM 요소 제거
    if (this.container) {
      this.container.remove();
    }
    
    // 이벤트 리스너 정리
    this.removeAllListeners();
    
    console.log('CollaborationPanel destroyed');
  }
}