/**
 * AwarenessUI - 실시간 사용자 인식 UI 컴포넌트
 * 
 * 주요 기능:
 * 1. 실시간 사용자 커서 표시
 * 2. 사용자 선택 영역 하이라이트
 * 3. 사용자 목록 및 상태 표시
 * 4. 사용자 아바타 및 정보
 * 5. 실시간 활동 피드백
 * 
 * @class AwarenessUI
 */

import EventEmitter from 'eventemitter3';

export class AwarenessUI extends EventEmitter {
  constructor(canvas, providerManager, options = {}) {
    super();
    
    // 의존성 주입
    this.canvas = canvas;
    this.providerManager = providerManager;
    
    // 설정 옵션
    this.options = {
      showCursors: true,
      showSelections: true,
      showUserList: true,
      showActivityFeed: true,
      cursorUpdateThrottle: 50,    // 50ms
      fadeOutDelay: 3000,          // 3초
      maxActivityItems: 20,        // 최대 활동 기록
      ...options
    };
    
    // UI 상태
    this.userCursors = new Map();        // userId -> cursor element
    this.userSelections = new Map();     // userId -> selection elements
    this.connectedUsers = new Map();     // userId -> user info
    this.activityFeed = [];              // 활동 기록
    
    // DOM 요소들
    this.container = null;
    this.userListPanel = null;
    this.activityPanel = null;
    this.cursorContainer = null;
    
    // 상태
    this.isVisible = true;
    this.currentUser = null;
    this.localCursor = { x: 0, y: 0 };
    this.localUserId = null;
    this.lastMouseMoveTime = 0;
    
    // 초기화
    this._initialize();
  }
  
  /**
   * Awareness UI 초기화
   * @private
   */
  _initialize() {
    // DOM 요소 생성
    this._createUIElements();
    
    // 프로바이더 이벤트 바인딩
    this._bindProviderEvents();
    
    // 마우스 이벤트 바인딩
    this._bindMouseEvents();
    
    // 스타일 적용
    this._applyStyles();
    
    console.log('AwarenessUI initialized');
  }
  
  /**
   * UI 요소 생성
   * @private
   */
  _createUIElements() {
    // 메인 컨테이너
    this.container = document.createElement('div');
    this.container.className = 'awareness-ui';
    
    // 커서 컨테이너 (캔버스 오버레이)
    this.cursorContainer = document.createElement('div');
    this.cursorContainer.className = 'awareness-cursors';
    
    // 사용자 목록 패널
    if (this.options.showUserList) {
      this.userListPanel = this._createUserListPanel();
      this.container.appendChild(this.userListPanel);
    }
    
    // 활동 피드 패널
    if (this.options.showActivityFeed) {
      this.activityPanel = this._createActivityPanel();
      this.container.appendChild(this.activityPanel);
    }
    
    // 캔버스 컨테이너에 추가
    const canvasContainer = this.canvas.getContainer().parentElement;
    canvasContainer.appendChild(this.container);
    canvasContainer.appendChild(this.cursorContainer);
  }
  
  /**
   * 사용자 목록 패널 생성
   * @private
   */
  _createUserListPanel() {
    const panel = document.createElement('div');
    panel.className = 'user-list-panel';
    panel.innerHTML = `
      <div class="panel-header">
        <h3>Connected Users</h3>
        <button class="toggle-btn" data-target="user-list">−</button>
      </div>
      <div class="panel-content" id="user-list">
        <div class="user-list"></div>
      </div>
    `;
    
    // 토글 버튼 이벤트
    const toggleBtn = panel.querySelector('.toggle-btn');
    toggleBtn.addEventListener('click', () => {
      this._togglePanel('user-list');
    });
    
    return panel;
  }
  
  /**
   * 활동 피드 패널 생성
   * @private
   */
  _createActivityPanel() {
    const panel = document.createElement('div');
    panel.className = 'activity-panel';
    panel.innerHTML = `
      <div class="panel-header">
        <h3>Recent Activity</h3>
        <button class="toggle-btn" data-target="activity-feed">−</button>
      </div>
      <div class="panel-content" id="activity-feed">
        <div class="activity-list"></div>
      </div>
    `;
    
    // 토글 버튼 이벤트
    const toggleBtn = panel.querySelector('.toggle-btn');
    toggleBtn.addEventListener('click', () => {
      this._togglePanel('activity-feed');
    });
    
    return panel;
  }
  
  /**
   * 프로바이더 이벤트 바인딩
   * @private
   */
  _bindProviderEvents() {
    // Awareness 변경 이벤트
    this.providerManager.on('awarenessChange', ({ added, updated, removed }) => {
      this._handleAwarenessChange({ added, updated, removed });
    });
    
    // 프로바이더 연결 이벤트
    this.providerManager.on('providerConnected', ({ type }) => {
      this._addActivity('system', `Connected to ${type} provider`);
    });
    
    this.providerManager.on('providerDisconnected', ({ type }) => {
      this._addActivity('system', `Disconnected from ${type} provider`);
    });
  }
  
  /**
   * 마우스 이벤트 바인딩
   * @private
   */
  _bindMouseEvents() {
    const canvasElement = this.canvas.getContainer();
    
    // 마우스 이동 추적 (쓰로틀링)
    let lastCursorUpdate = 0;
    canvasElement.addEventListener('mousemove', (event) => {
      const now = Date.now();
      if (now - lastCursorUpdate > this.options.cursorUpdateThrottle) {
        this._updateLocalCursor(event);
        lastCursorUpdate = now;
      }
    });
    
    // 마우스 나가기
    canvasElement.addEventListener('mouseleave', () => {
      this._hideLocalCursor();
    });
    
    // 클릭 이벤트
    canvasElement.addEventListener('click', (event) => {
      this._handleCanvasClick(event);
    });
  }
  
  /**
   * Awareness 변경 처리
   * @private
   */
  _handleAwarenessChange({ added, updated, removed }) {
    // 새로 추가된 사용자
    added.forEach(clientId => {
      this._handleUserAdded(clientId);
    });
    
    // 업데이트된 사용자
    updated.forEach(clientId => {
      this._handleUserUpdated(clientId);
    });
    
    // 제거된 사용자
    removed.forEach(clientId => {
      this._handleUserRemoved(clientId);
    });
    
    // 사용자 목록 업데이트
    this._updateUserList();
  }
  
  /**
   * 사용자 추가 처리
   * @private
   */
  _handleUserAdded(clientId) {
    const userState = this._getUserState(clientId);
    if (!userState || !userState.user) return;
    
    const user = userState.user;
    this.connectedUsers.set(user.id, {
      ...user,
      clientId,
      joinedAt: Date.now()
    });
    
    // 커서 생성
    if (this.options.showCursors) {
      this._createUserCursor(user.id, user);
    }
    
    // 활동 기록
    this._addActivity('join', `${user.name} joined the session`, user);
    
    this.emit('userJoined', { user, clientId });
  }
  
  /**
   * 사용자 업데이트 처리
   * @private
   */
  _handleUserUpdated(clientId) {
    const userState = this._getUserState(clientId);
    if (!userState || !userState.user) return;
    
    const user = userState.user;
    const existingUser = this.connectedUsers.get(user.id);
    
    if (existingUser) {
      // 사용자 정보 업데이트
      this.connectedUsers.set(user.id, {
        ...existingUser,
        ...user,
        lastActivity: Date.now()
      });
      
      // 커서 위치 업데이트
      if (this.options.showCursors && userState.cursor) {
        this._updateUserCursor(user.id, userState.cursor, user);
      }
      
      // 선택 영역 업데이트
      if (this.options.showSelections && userState.selection) {
        this._updateUserSelection(user.id, userState.selection, user);
      }
      
      this.emit('userUpdated', { user, clientId });
    }
  }
  
  /**
   * 사용자 제거 처리
   * @private
   */
  _handleUserRemoved(clientId) {
    // clientId로 사용자 찾기
    let userId = null;
    for (const [id, user] of this.connectedUsers) {
      if (user.clientId === clientId) {
        userId = id;
        break;
      }
    }
    
    if (userId) {
      const user = this.connectedUsers.get(userId);
      this.connectedUsers.delete(userId);
      
      // UI 요소 제거
      this._removeUserCursor(userId);
      this._removeUserSelection(userId);
      
      // 활동 기록
      this._addActivity('leave', `${user.name} left the session`, user);
      
      this.emit('userLeft', { user, clientId });
    }
  }
  
  /**
   * 사용자 커서 생성
   * @private
   */
  _createUserCursor(userId, user) {
    const cursor = document.createElement('div');
    cursor.className = 'user-cursor';
    cursor.style.borderColor = user.color;
    cursor.innerHTML = `
      <div class="cursor-pointer" style="background-color: ${user.color}"></div>
      <div class="cursor-label" style="background-color: ${user.color}">
        ${user.name}
      </div>
    `;
    
    this.userCursors.set(userId, cursor);
    this.cursorContainer.appendChild(cursor);
  }
  
  /**
   * 사용자 커서 업데이트
   * @private
   */
  _updateUserCursor(userId, cursor, user) {
    const cursorElement = this.userCursors.get(userId);
    if (!cursorElement) return;
    
    // 뷰포트 좌표로 변환
    const viewbox = this.canvas.viewbox();
    const container = this.canvas.getContainer();
    const rect = container.getBoundingClientRect();
    
    const x = ((cursor.x - viewbox.x) * rect.width / viewbox.width);
    const y = ((cursor.y - viewbox.y) * rect.height / viewbox.height);
    
    // 커서 위치 업데이트
    cursorElement.style.transform = `translate(${x}px, ${y}px)`;
    cursorElement.style.opacity = '1';
    
    // 페이드아웃 타이머 설정
    clearTimeout(cursorElement.fadeTimer);
    cursorElement.fadeTimer = setTimeout(() => {
      cursorElement.style.opacity = '0.3';
    }, this.options.fadeOutDelay);
  }
  
  /**
   * 사용자 선택 영역 업데이트
   * @private
   */
  _updateUserSelection(userId, selection, user) {
    // 기존 선택 영역 제거
    this._removeUserSelection(userId);
    
    if (!selection || selection.length === 0) return;
    
    const selectionElements = [];
    
    selection.forEach(elementId => {
      const element = this.canvas.getGraphics(elementId);
      if (element) {
        const overlay = document.createElement('div');
        overlay.className = 'user-selection-overlay';
        overlay.style.borderColor = user.color;
        overlay.style.backgroundColor = user.color + '20'; // 투명도 20%
        
        // 요소 위치에 맞춰 오버레이 배치
        this._positionSelectionOverlay(overlay, element);
        
        selectionElements.push(overlay);
        this.cursorContainer.appendChild(overlay);
      }
    });
    
    if (selectionElements.length > 0) {
      this.userSelections.set(userId, selectionElements);
    }
  }
  
  /**
   * 선택 오버레이 위치 설정
   * @private
   */
  _positionSelectionOverlay(overlay, element) {
    const bbox = element.getBBox();
    const viewbox = this.canvas.viewbox();
    const container = this.canvas.getContainer();
    const rect = container.getBoundingClientRect();
    
    const x = ((bbox.x - viewbox.x) * rect.width / viewbox.width);
    const y = ((bbox.y - viewbox.y) * rect.height / viewbox.height);
    const width = (bbox.width * rect.width / viewbox.width);
    const height = (bbox.height * rect.height / viewbox.height);
    
    overlay.style.left = x + 'px';
    overlay.style.top = y + 'px';
    overlay.style.width = width + 'px';
    overlay.style.height = height + 'px';
  }
  
  /**
   * 로컬 커서 업데이트
   * @private
   */
  _updateLocalCursor(event) {
    const rect = this.canvas.getContainer().getBoundingClientRect();
    const viewbox = this.canvas.viewbox();
    
    const x = viewbox.x + (event.clientX - rect.left) * viewbox.width / rect.width;
    const y = viewbox.y + (event.clientY - rect.top) * viewbox.height / rect.height;
    
    this.providerManager.updateCursor({ x, y });
  }
  
  /**
   * 사용자 목록 업데이트
   * @private
   */
  _updateUserList() {
    if (!this.userListPanel) return;
    
    const userList = this.userListPanel.querySelector('.user-list');
    userList.innerHTML = '';
    
    this.connectedUsers.forEach((user, userId) => {
      const userItem = document.createElement('div');
      userItem.className = 'user-item';
      userItem.innerHTML = `
        <div class="user-avatar" style="background-color: ${user.color}">
          ${user.name.charAt(0).toUpperCase()}
        </div>
        <div class="user-info">
          <div class="user-name">${user.name}</div>
          <div class="user-status">${this._getUserStatus(user)}</div>
        </div>
        <div class="user-indicator" style="background-color: ${user.color}"></div>
      `;
      
      userList.appendChild(userItem);
    });
    
    // 연결된 사용자 수 업데이트
    const header = this.userListPanel.querySelector('h3');
    header.textContent = `Connected Users (${this.connectedUsers.size})`;
  }
  
  /**
   * 사용자 상태 텍스트 생성
   * @private
   */
  _getUserStatus(user) {
    const now = Date.now();
    const timeDiff = now - (user.lastActivity || user.joinedAt);
    
    if (timeDiff < 30000) { // 30초 이내
      return 'Active';
    } else if (timeDiff < 300000) { // 5분 이내
      return 'Idle';
    } else {
      return 'Away';
    }
  }
  
  /**
   * 활동 기록 추가
   * @private
   */
  _addActivity(type, message, user = null) {
    const activity = {
      id: Date.now(),
      type,
      message,
      user,
      timestamp: Date.now()
    };
    
    this.activityFeed.unshift(activity);
    
    // 최대 개수 제한
    if (this.activityFeed.length > this.options.maxActivityItems) {
      this.activityFeed.pop();
    }
    
    // UI 업데이트
    this._updateActivityFeed();
    
    this.emit('activityAdded', activity);
  }
  
  /**
   * 활동 피드 업데이트
   * @private
   */
  _updateActivityFeed() {
    if (!this.activityPanel) return;
    
    const activityList = this.activityPanel.querySelector('.activity-list');
    activityList.innerHTML = '';
    
    this.activityFeed.forEach(activity => {
      const activityItem = document.createElement('div');
      activityItem.className = `activity-item activity-${activity.type}`;
      
      const timeStr = this._formatTime(activity.timestamp);
      
      activityItem.innerHTML = `
        <div class="activity-icon">
          ${this._getActivityIcon(activity.type)}
        </div>
        <div class="activity-content">
          <div class="activity-message">${activity.message}</div>
          <div class="activity-time">${timeStr}</div>
        </div>
      `;
      
      activityList.appendChild(activityItem);
    });
  }
  
  /**
   * 활동 아이콘 가져오기
   * @private
   */
  _getActivityIcon(type) {
    const icons = {
      join: '👋',
      leave: '👋',
      edit: '✏️',
      comment: '💬',
      system: '⚙️'
    };
    
    return icons[type] || '•';
  }
  
  /**
   * 시간 포맷팅
   * @private
   */
  _formatTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    
    if (diff < 60000) { // 1분 이내
      return 'just now';
    } else if (diff < 3600000) { // 1시간 이내
      return `${Math.floor(diff / 60000)}m ago`;
    } else {
      return new Date(timestamp).toLocaleTimeString();
    }
  }
  
  /**
   * 사용자 상태 가져오기
   * @private
   */
  _getUserState(clientId) {
    // 모든 프로바이더에서 awareness 상태 확인
    const providers = this.providerManager.providers;
    
    for (const provider of Object.values(providers)) {
      if (provider && provider.awareness) {
        const state = provider.awareness.getStates().get(clientId);
        if (state) return state;
      }
    }
    
    return null;
  }
  
  /**
   * 패널 토글
   * @private
   */
  _togglePanel(panelId) {
    const panel = document.getElementById(panelId);
    const toggleBtn = this.container.querySelector(`[data-target="${panelId}"]`);
    
    if (panel.style.display === 'none') {
      panel.style.display = 'block';
      toggleBtn.textContent = '−';
    } else {
      panel.style.display = 'none';
      toggleBtn.textContent = '+';
    }
  }
  
  /**
   * 사용자 커서 제거
   * @private
   */
  _removeUserCursor(userId) {
    const cursor = this.userCursors.get(userId);
    if (cursor) {
      cursor.remove();
      this.userCursors.delete(userId);
    }
  }
  
  /**
   * 사용자 선택 영역 제거
   * @private
   */
  _removeUserSelection(userId) {
    const selections = this.userSelections.get(userId);
    if (selections) {
      selections.forEach(overlay => overlay.remove());
      this.userSelections.delete(userId);
    }
  }
  
  /**
   * 스타일 적용
   * @private
   */
  _applyStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .awareness-ui {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 1000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
      }
      
      .user-list-panel, .activity-panel {
        background: white;
        border: 1px solid #ddd;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        margin-bottom: 12px;
        min-width: 280px;
      }
      
      .panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid #eee;
        background: #f9f9f9;
        border-radius: 8px 8px 0 0;
      }
      
      .panel-header h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: #333;
      }
      
      .toggle-btn {
        background: none;
        border: none;
        font-size: 16px;
        cursor: pointer;
        color: #666;
        padding: 0;
        width: 20px;
        text-align: center;
      }
      
      .panel-content {
        padding: 12px;
        max-height: 300px;
        overflow-y: auto;
      }
      
      .user-item {
        display: flex;
        align-items: center;
        padding: 8px 0;
        border-bottom: 1px solid #f0f0f0;
      }
      
      .user-item:last-child {
        border-bottom: none;
      }
      
      .user-avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: bold;
        margin-right: 12px;
      }
      
      .user-info {
        flex: 1;
      }
      
      .user-name {
        font-weight: 500;
        color: #333;
      }
      
      .user-status {
        font-size: 12px;
        color: #666;
        margin-top: 2px;
      }
      
      .user-indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      
      .activity-item {
        display: flex;
        align-items: flex-start;
        padding: 8px 0;
        border-bottom: 1px solid #f0f0f0;
      }
      
      .activity-item:last-child {
        border-bottom: none;
      }
      
      .activity-icon {
        margin-right: 12px;
        font-size: 16px;
      }
      
      .activity-content {
        flex: 1;
      }
      
      .activity-message {
        color: #333;
        margin-bottom: 2px;
      }
      
      .activity-time {
        font-size: 12px;
        color: #666;
      }
      
      .awareness-cursors {
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
        z-index: 999;
      }
      
      .user-cursor {
        position: absolute;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }
      
      .cursor-pointer {
        width: 0;
        height: 0;
        border-left: 8px solid;
        border-top: 8px solid transparent;
        border-bottom: 8px solid transparent;
      }
      
      .cursor-label {
        position: absolute;
        top: -8px;
        left: 12px;
        padding: 4px 8px;
        border-radius: 4px;
        color: white;
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      
      .user-selection-overlay {
        position: absolute;
        border: 2px solid;
        border-radius: 4px;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }
    `;
    
    document.head.appendChild(style);
  }
  
  /**
   * UI 표시/숨김 토글
   * @public
   */
  toggle() {
    this.isVisible = !this.isVisible;
    this.container.style.display = this.isVisible ? 'block' : 'none';
  }
  
  /**
   * 연결된 사용자 목록 가져오기
   * @public
   */
  getConnectedUsers() {
    return Array.from(this.connectedUsers.values());
  }
  
  /**
   * 리소스 정리
   * @public
   */
  destroy() {
    // DOM 요소 제거
    if (this.container) {
      this.container.remove();
    }
    if (this.cursorContainer) {
      this.cursorContainer.remove();
    }
    
    // 맵 정리
    this.userCursors.clear();
    this.userSelections.clear();
    this.connectedUsers.clear();
    
    // 이벤트 리스너 정리
    this.removeAllListeners();
    
    console.log('AwarenessUI destroyed');
  }

  /**
   * 캔버스 클릭 이벤트 처리
   * @private
   * @param {MouseEvent} event - 마우스 이벤트
   */
  _handleCanvasClick(event) {
    // 캔버스 상의 클릭 위치 계산
    const rect = event.target.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    
    // 로컬 사용자의 커서 위치 업데이트
    this.localCursor = { x, y };
    
    // 다른 사용자들에게 커서 위치 브로드캐스트
    if (this.providerManager && this.providerManager.awareness) {
      const awarenessState = this.providerManager.awareness.getLocalState();
      this.providerManager.awareness.setLocalStateField('cursor', {
        x,
        y,
        timestamp: Date.now()
      });
    }
    
    // 클릭 이벤트 발생
    this.emit('cursorMoved', { x, y, userId: this.localUserId });
  }

  /**
   * 마우스 이동 이벤트 처리
   * @private
   * @param {MouseEvent} event - 마우스 이벤트
   */
  _handleCanvasMouseMove(event) {
    // 스로틀링을 위한 체크
    const now = Date.now();
    if (now - this.lastMouseMoveTime < 50) { // 50ms 스로틀링
      return;
    }
    this.lastMouseMoveTime = now;
    
    // 캔버스 상의 마우스 위치 계산
    const rect = event.target.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    
    // 로컬 사용자의 커서 위치 업데이트
    this.localCursor = { x, y };
    
    // 다른 사용자들에게 커서 위치 브로드캐스트
    if (this.providerManager && this.providerManager.awareness) {
      this.providerManager.awareness.setLocalStateField('cursor', {
        x,
        y,
        timestamp: now
      });
    }
  }

  /**
   * 로컬 커서 숨기기
   * @private
   */
  _hideLocalCursor() {
    // 로컬 사용자의 커서를 다른 사용자들에게서 숨김
    if (this.providerManager && this.providerManager.awareness) {
      this.providerManager.awareness.setLocalStateField('cursor', null);
    }
    
    // 로컬 커서 상태 업데이트
    this.localCursor = null;
    
    // 커서 숨김 이벤트 발생
    this.emit('cursorHidden', { userId: this.localUserId });
  }

  /**
   * 로컬 커서 보이기
   * @private
   */
  _showLocalCursor() {
    // 현재 마우스 위치가 있다면 커서 표시
    if (this.localCursor) {
      if (this.providerManager && this.providerManager.awareness) {
        this.providerManager.awareness.setLocalStateField('cursor', {
          ...this.localCursor,
          timestamp: Date.now()
        });
      }
      
      // 커서 표시 이벤트 발생
      this.emit('cursorShown', { 
        userId: this.localUserId, 
        cursor: this.localCursor 
      });
    }
  }

  /**
   * 사용자 ID 설정
   * @public
   * @param {string} userId - 사용자 ID
   */
  setLocalUserId(userId) {
    this.localUserId = userId;
  }

  /**
   * 현재 사용자 정보 설정
   * @public
   * @param {Object} userInfo - 사용자 정보
   */
  setCurrentUser(userInfo) {
    this.currentUser = userInfo;
    this.localUserId = userInfo.id;
  }
}