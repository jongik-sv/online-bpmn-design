/**
 * NotificationService - 실시간 알림 관리
 * 
 * 주요 기능:
 * 1. 실시간 사용자 알림
 * 2. 시스템 이벤트 브로드캐스트
 * 3. 개인화된 알림 전송
 * 4. 알림 히스토리 관리
 * 
 * @class NotificationService
 */

const EventEmitter = require('eventemitter3');
const { Logger } = require('../utils/logger');

class NotificationService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enablePersistence: true,
      maxHistoryPerUser: 100,
      defaultTTL: 24 * 60 * 60 * 1000, // 24 hours
      ...options
    };
    
    this.logger = new Logger('NotificationService');
    this.notifications = new Map(); // userId -> notifications[]
    this.connections = new Map(); // userId -> websocket connection
    
    this.logger.info('NotificationService initialized');
  }
  
  /**
   * 사용자 연결 등록
   * @param {string} userId 
   * @param {WebSocket} connection 
   */
  registerConnection(userId, connection) {
    this.connections.set(userId, connection);
    
    connection.on('close', () => {
      this.connections.delete(userId);
      this.logger.debug(`User ${userId} connection removed`);
    });
    
    this.logger.debug(`User ${userId} connection registered`);
  }
  
  /**
   * 개별 사용자에게 알림 전송
   * @param {string} userId 
   * @param {Object} notification 
   */
  sendToUser(userId, notification) {
    const enrichedNotification = {
      id: this._generateId(),
      timestamp: new Date().toISOString(),
      read: false,
      ...notification
    };
    
    // 히스토리에 저장
    if (this.options.enablePersistence) {
      this._addToHistory(userId, enrichedNotification);
    }
    
    // 실시간 전송
    const connection = this.connections.get(userId);
    if (connection && connection.readyState === 1) { // WebSocket.OPEN
      try {
        connection.send(JSON.stringify({
          type: 'notification',
          data: enrichedNotification
        }));
        
        this.logger.debug(`Notification sent to user ${userId}:`, notification);
      } catch (error) {
        this.logger.error(`Failed to send notification to user ${userId}:`, error);
      }
    }
    
    this.emit('notificationSent', { userId, notification: enrichedNotification });
  }
  
  /**
   * 여러 사용자에게 알림 전송
   * @param {string[]} userIds 
   * @param {Object} notification 
   */
  sendToUsers(userIds, notification) {
    userIds.forEach(userId => {
      this.sendToUser(userId, notification);
    });
  }
  
  /**
   * 모든 연결된 사용자에게 브로드캐스트
   * @param {Object} notification 
   */
  broadcast(notification) {
    const userIds = Array.from(this.connections.keys());
    this.sendToUsers(userIds, notification);
    
    this.logger.info(`Broadcast notification sent to ${userIds.length} users`);
  }
  
  /**
   * 특정 세션/문서의 참가자들에게 알림 전송
   * @param {string} documentId 
   * @param {string[]} participantIds 
   * @param {Object} notification 
   */
  sendToSession(documentId, participantIds, notification) {
    const sessionNotification = {
      ...notification,
      documentId,
      scope: 'session'
    };
    
    this.sendToUsers(participantIds, sessionNotification);
    this.logger.debug(`Session notification sent to document ${documentId}`);
  }
  
  /**
   * 사용자 알림 히스토리 조회
   * @param {string} userId 
   * @param {Object} options 
   * @returns {Array}
   */
  getUserNotifications(userId, options = {}) {
    const { 
      limit = 50, 
      offset = 0, 
      unreadOnly = false 
    } = options;
    
    let notifications = this.notifications.get(userId) || [];
    
    if (unreadOnly) {
      notifications = notifications.filter(n => !n.read);
    }
    
    return notifications
      .slice(offset, offset + limit)
      .reverse(); // 최신순
  }
  
  /**
   * 알림 읽음 처리
   * @param {string} userId 
   * @param {string} notificationId 
   */
  markAsRead(userId, notificationId) {
    const notifications = this.notifications.get(userId);
    if (!notifications) return;
    
    const notification = notifications.find(n => n.id === notificationId);
    if (notification) {
      notification.read = true;
      notification.readAt = new Date().toISOString();
      
      this.emit('notificationRead', { userId, notificationId });
      this.logger.debug(`Notification ${notificationId} marked as read for user ${userId}`);
    }
  }
  
  /**
   * 모든 알림 읽음 처리
   * @param {string} userId 
   */
  markAllAsRead(userId) {
    const notifications = this.notifications.get(userId);
    if (!notifications) return;
    
    let markedCount = 0;
    notifications.forEach(notification => {
      if (!notification.read) {
        notification.read = true;
        notification.readAt = new Date().toISOString();
        markedCount++;
      }
    });
    
    if (markedCount > 0) {
      this.emit('allNotificationsRead', { userId, count: markedCount });
      this.logger.debug(`${markedCount} notifications marked as read for user ${userId}`);
    }
  }
  
  /**
   * 알림 삭제
   * @param {string} userId 
   * @param {string} notificationId 
   */
  deleteNotification(userId, notificationId) {
    const notifications = this.notifications.get(userId);
    if (!notifications) return;
    
    const index = notifications.findIndex(n => n.id === notificationId);
    if (index !== -1) {
      notifications.splice(index, 1);
      this.emit('notificationDeleted', { userId, notificationId });
      this.logger.debug(`Notification ${notificationId} deleted for user ${userId}`);
    }
  }
  
  /**
   * 읽은 알림 자동 정리
   * @param {number} olderThanMs 
   */
  cleanupOldNotifications(olderThanMs = this.options.defaultTTL) {
    const cutoffTime = Date.now() - olderThanMs;
    let totalCleaned = 0;
    
    for (const [userId, notifications] of this.notifications.entries()) {
      const originalLength = notifications.length;
      
      // 읽은 알림 중 오래된 것들 제거
      this.notifications.set(userId, notifications.filter(notification => {
        if (notification.read) {
          const notificationTime = new Date(notification.timestamp).getTime();
          return notificationTime > cutoffTime;
        }
        return true; // 읽지 않은 알림은 유지
      }));
      
      const cleaned = originalLength - this.notifications.get(userId).length;
      totalCleaned += cleaned;
    }
    
    if (totalCleaned > 0) {
      this.logger.info(`Cleaned up ${totalCleaned} old notifications`);
    }
  }
  
  /**
   * 사용자별 읽지 않은 알림 수 조회
   * @param {string} userId 
   * @returns {number}
   */
  getUnreadCount(userId) {
    const notifications = this.notifications.get(userId) || [];
    return notifications.filter(n => !n.read).length;
  }
  
  /**
   * 히스토리에 알림 추가
   * @private
   */
  _addToHistory(userId, notification) {
    if (!this.notifications.has(userId)) {
      this.notifications.set(userId, []);
    }
    
    const userNotifications = this.notifications.get(userId);
    userNotifications.push(notification);
    
    // 최대 개수 제한
    if (userNotifications.length > this.options.maxHistoryPerUser) {
      userNotifications.shift();
    }
  }
  
  /**
   * 고유 ID 생성
   * @private
   */
  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
  
  /**
   * 서비스 통계 조회
   * @returns {Object}
   */
  getStats() {
    const activeConnections = this.connections.size;
    const totalNotifications = Array.from(this.notifications.values())
      .reduce((sum, notifications) => sum + notifications.length, 0);
    const unreadNotifications = Array.from(this.notifications.values())
      .reduce((sum, notifications) => 
        sum + notifications.filter(n => !n.read).length, 0);
    
    return {
      activeConnections,
      totalNotifications,
      unreadNotifications,
      usersWithNotifications: this.notifications.size
    };
  }
  
  /**
   * 서비스 종료
   */
  destroy() {
    // 모든 연결 정리
    for (const connection of this.connections.values()) {
      if (connection.readyState === 1) {
        connection.close();
      }
    }
    
    this.connections.clear();
    this.notifications.clear();
    this.removeAllListeners();
    
    this.logger.info('NotificationService destroyed');
  }
}

module.exports = { NotificationService };