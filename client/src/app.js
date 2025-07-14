/**
 * BPMN Collaboration Editor - Client Application Entry Point
 * 
 * 메인 클라이언트 애플리케이션
 * BPMN.js와 Y.js를 통합한 실시간 협업 다이어그램 편집기
 * 
 * @author Claude AI Assistant
 * @version 1.0.0
 */

import BpmnModeler from 'bpmn-js/lib/Modeler';
import * as Y from 'yjs';

// 핵심 모듈들
import { BpmnSyncManager } from './core/BpmnSyncManager.js';
import { ConflictResolver } from './core/ConflictResolver.js';
import { ConnectionManager } from './core/connection-manager.js';
import { PerformanceOptimizer } from './core/PerformanceOptimizer.js';

// CRDT 모듈들
import { YjsDocumentManager } from './crdt/YjsDocumentManager.js';
import { ProviderManager } from './crdt/YjsProviders.js';

// UI 컴포넌트들
import { AwarenessUI } from './ui/AwarenessUI.js';
import { CollaborationPanel } from './ui/CollaborationPanel.js';

// 유틸리티들
import { Logger } from './utils/Logger.js';

/**
 * BPMN 협업 편집기 메인 클래스
 */
class BpmnCollaborationEditor {
  constructor(options = {}) {
    // 설정 옵션
    this.options = {
      container: '#canvas',
      serverUrl: 'ws://localhost:3000',
      documentId: null,
      userId: 'anonymous',
      userName: 'Anonymous User',
      enableCollaboration: true,
      enablePerformanceOptimization: true,
      enableConflictResolution: true,
      autoSave: true,
      ...options
    };
    
    // 검증
    if (!this.options.documentId) {
      throw new Error('Document ID is required');
    }
    
    // 컴포넌트 인스턴스들
    this.modeler = null;
    this.yjsDoc = null;
    this.yjsDocumentManager = null;
    this.providerManager = null;
    this.bpmnSyncManager = null;
    this.conflictResolver = null;
    this.performanceOptimizer = null;
    this.awarenessUI = null;
    this.collaborationPanel = null;
    
    // 상태
    this.isInitialized = false;
    this.isCollaborationActive = false;
    
    // 로거 설정
    this.logger = new Logger('BpmnCollaborationEditor');
    
    // 초기화
    this._initialize();
  }
  
  /**
   * 애플리케이션 초기화
   * @private
   */
  async _initialize() {
    try {
      this.logger.info('Initializing BPMN Collaboration Editor...');
      
      // 1. BPMN.js 모델러 초기화
      await this._initializeBpmnModeler();
      
      // 2. Y.js 문서 및 CRDT 초기화
      if (this.options.enableCollaboration) {
        await this._initializeCollaboration();
      }
      
      // 3. 성능 최적화 초기화
      if (this.options.enablePerformanceOptimization) {
        await this._initializePerformanceOptimization();
      }
      
      // 4. UI 컴포넌트 초기화
      await this._initializeUI();
      
      // 5. 이벤트 바인딩
      this._bindEvents();
      
      this.isInitialized = true;
      this.logger.info('BPMN Collaboration Editor initialized successfully');
      
      // 초기화 완료 이벤트
      this._emit('initialized');
      
    } catch (error) {
      this.logger.error('Failed to initialize BPMN Collaboration Editor:', error);
      throw error;
    }
  }
  
  /**
   * BPMN.js 모델러 초기화
   * @private
   */
  async _initializeBpmnModeler() {
    const container = document.querySelector(this.options.container);
    
    if (!container) {
      throw new Error(`Container element '${this.options.container}' not found`);
    }
    
    this.modeler = new BpmnModeler({
      container: container,
      keyboard: {
        bindTo: document
      },
      propertiesPanel: {
        parent: '#properties-panel'
      }
    });
    
    // 기본 Start Event가 있는 다이어그램으로 시작
    const emptyDiagram = `<?xml version="1.0" encoding="UTF-8"?>
      <bpmn2:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                         xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
                         xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                         xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                         xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                         id="diagram_${this.options.documentId}"
                         targetNamespace="http://bpmn.io/schema/bpmn">
        <bpmn2:process id="Process_1" isExecutable="false">
          <bpmn2:startEvent id="StartEvent_1" />
        </bpmn2:process>
        <bpmndi:BPMNDiagram id="BPMNDiagram_1">
          <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
            <bpmndi:BPMNShape id="_BPMNShape_StartEvent_2" bpmnElement="StartEvent_1">
              <dc:Bounds x="152" y="82" width="36" height="36" />
            </bpmndi:BPMNShape>
          </bpmndi:BPMNPlane>
        </bpmndi:BPMNDiagram>
      </bpmn2:definitions>`;
    
    try {
      const result = await this.modeler.importXML(emptyDiagram);
      if (result.warnings.length > 0) {
        this.logger.warn('BPMN import warnings:', result.warnings);
      }
      this.logger.info('BPMN modeler initialized successfully');
    } catch (error) {
      this.logger.error('Failed to import BPMN diagram:', error);
      throw error;
    }
  }
  
  /**
   * 협업 기능 초기화
   * @private
   */
  async _initializeCollaboration() {
    // Y.js 문서 관리자 초기화
    this.yjsDocumentManager = new YjsDocumentManager(this.options.documentId, {
      enablePersistence: true
    });
    
    await this.yjsDocumentManager._initialize();
    
    // Y.js 문서는 문서 관리자에서 가져오기
    this.yjsDoc = this.yjsDocumentManager.doc;
    
    // 프로바이더 관리자 초기화
    this.providerManager = new ProviderManager(this.yjsDoc, {
      enableWebSocket: true,
      enableIndexedDB: false,  // 메모리 누수 방지를 위해 비활성화
      enableWebRTC: false,
      websocketUrl: this.options.serverUrl,
      room: this.options.documentId,
      userId: this.options.userId,
      userName: this.options.userName
    });
    
    await this.providerManager.initialize();
    
    // WebSocket Provider의 Awareness를 문서 관리자에 설정
    if (this.providerManager.providers.websocket && this.providerManager.providers.websocket.awareness) {
      this.yjsDocumentManager.setAwarenessProvider(this.providerManager.providers.websocket.awareness);
    }
    
    // BPMN 동기화 관리자 초기화
    this.bpmnSyncManager = new BpmnSyncManager(
      this.modeler,
      this.yjsDocumentManager,
      {
        enableLogging: true
      }
    );
    
    // 충돌 해결기 임시 비활성화 (무한 재귀 방지)
    // ConflictResolver가 Y.js 무한 루프를 유발하므로 일시적으로 비활성화
    /*
    if (this.options.enableConflictResolution) {
      this.conflictResolver = new ConflictResolver(
        this.modeler,
        this.yjsDocumentManager,
        {
          enableAutoResolution: true,
          semanticValidation: true
        }
      );
    }
    */
    
    this.isCollaborationActive = true;
    this.logger.info('Collaboration features initialized');
  }
  
  /**
   * 성능 최적화 초기화
   * @private
   */
  async _initializePerformanceOptimization() {
    this.performanceOptimizer = new PerformanceOptimizer(this.modeler, {
      enableRenderOptimization: true,
      enableMemoryManagement: true,
      enableNetworkOptimization: true,
      enableAdaptiveQuality: true
    });
    
    this.logger.info('Performance optimization initialized');
  }
  
  /**
   * UI 컴포넌트 초기화
   * @private
   */
  async _initializeUI() {
    const canvas = this.modeler.get('canvas');
    
    // Awareness UI 초기화
    if (this.isCollaborationActive) {
      this.awarenessUI = new AwarenessUI(canvas, this.providerManager, {
        showCursors: true,
        showSelections: true,
        showUserList: true,
        showActivityFeed: true
      });
      
      // BpmnSyncManager에 AwarenessUI 연결 (위치 추적 개선을 위해)
      if (this.bpmnSyncManager) {
        this.bpmnSyncManager.setAwarenessUI(this.awarenessUI);
      }
    }
    
    // 협업 제어 패널 초기화
    if (this.isCollaborationActive) {
      this.collaborationPanel = new CollaborationPanel(
        this.providerManager,
        this.performanceOptimizer,
        {
          position: 'bottom-left',
          showMetrics: true,
          showSettings: true
        }
      );
    }
    
    this.logger.info('UI components initialized');
  }
  
  /**
   * 이벤트 바인딩
   * @private
   */
  _bindEvents() {
    // BPMN 모델러 이벤트
    const eventBus = this.modeler.get('eventBus');
    
    eventBus.on('import.done', () => {
      this.logger.info('BPMN diagram imported');
      this._emit('diagramImported');
    });
    
    eventBus.on('commandStack.changed', () => {
      this._emit('diagramChanged');
    });
    
    // 협업 이벤트
    if (this.isCollaborationActive) {
      this.providerManager.on('providerConnected', ({ type }) => {
        this.logger.info(`Connected to ${type} provider`);
        this._emit('collaborationConnected', { type });
      });
      
      this.providerManager.on('providerDisconnected', ({ type }) => {
        this.logger.warn(`Disconnected from ${type} provider`);
        this._emit('collaborationDisconnected', { type });
      });
      
      // ConflictResolver 이벤트 비활성화 (임시)
      /*
      if (this.conflictResolver) {
        this.conflictResolver.on('conflictDetected', (conflict) => {
          this.logger.warn('Conflict detected:', conflict);
          this._emit('conflictDetected', conflict);
        });
        
        this.conflictResolver.on('conflictResolved', ({ conflict, resolution }) => {
          this.logger.info('Conflict resolved:', { conflict: conflict.id, resolution: resolution.type });
          this._emit('conflictResolved', { conflict, resolution });
        });
      }
      */
    }
    
    // 성능 이벤트
    if (this.performanceOptimizer) {
      this.performanceOptimizer.on('qualityLevelChanged', ({ current, previous }) => {
        this.logger.info(`Quality level changed: ${previous} -> ${current}`);
        this._emit('qualityChanged', { current, previous });
      });
    }
    
    // UI 이벤트
    if (this.collaborationPanel) {
      this.collaborationPanel.on('collaborationStarted', () => {
        this._emit('collaborationStarted');
      });
      
      this.collaborationPanel.on('collaborationStopped', () => {
        this._emit('collaborationStopped');
      });
    }
    
    // 글로벌 에러 핸들링
    window.addEventListener('error', (event) => {
      this.logger.error('Global error:', event.error);
      this._emit('error', event.error);
    });
    
    window.addEventListener('unhandledrejection', (event) => {
      this.logger.error('Unhandled promise rejection:', event.reason);
      this._emit('error', event.reason);
    });
  }
  
  /**
   * BPMN XML 로드
   * @param {string} xml - BPMN XML 문자열
   * @returns {Promise<void>}
   */
  async loadDiagram(xml) {
    try {
      await this.modeler.importXML(xml);
      this.logger.info('Diagram loaded successfully');
      this._emit('diagramLoaded');
    } catch (error) {
      this.logger.error('Failed to load diagram:', error);
      throw error;
    }
  }
  
  /**
   * BPMN XML 내보내기
   * @returns {Promise<string>}
   */
  async exportDiagram() {
    try {
      const { xml } = await this.modeler.saveXML({ format: true });
      this.logger.info('Diagram exported successfully');
      return xml;
    } catch (error) {
      this.logger.error('Failed to export diagram:', error);
      throw error;
    }
  }
  
  /**
   * 다이어그램 SVG 내보내기
   * @returns {Promise<string>}
   */
  async exportSVG() {
    try {
      const { svg } = await this.modeler.saveSVG();
      this.logger.info('SVG exported successfully');
      return svg;
    } catch (error) {
      this.logger.error('Failed to export SVG:', error);
      throw error;
    }
  }
  
  /**
   * 협업 시작
   * @returns {Promise<void>}
   */
  async startCollaboration() {
    if (!this.isCollaborationActive) {
      throw new Error('Collaboration is not enabled');
    }
    
    try {
      await this.providerManager.initialize();
      this.logger.info('Collaboration started');
      this._emit('collaborationStarted');
    } catch (error) {
      this.logger.error('Failed to start collaboration:', error);
      throw error;
    }
  }
  
  /**
   * 협업 중지
   * @returns {Promise<void>}
   */
  async stopCollaboration() {
    if (!this.isCollaborationActive) {
      return;
    }
    
    try {
      this.providerManager.disconnect();
      this.logger.info('Collaboration stopped');
      this._emit('collaborationStopped');
    } catch (error) {
      this.logger.error('Failed to stop collaboration:', error);
      throw error;
    }
  }
  
  /**
   * 연결된 사용자 목록 조회
   * @returns {Array}
   */
  getConnectedUsers() {
    if (!this.isCollaborationActive || !this.awarenessUI) {
      return [];
    }
    
    return this.awarenessUI.getConnectedUsers();
  }
  
  /**
   * 성능 메트릭 조회
   * @returns {Object}
   */
  getPerformanceMetrics() {
    if (!this.performanceOptimizer) {
      return null;
    }
    
    return this.performanceOptimizer.getMetrics();
  }
  
  /**
   * 이벤트 발생
   * @param {string} event - 이벤트 이름
   * @param {*} data - 이벤트 데이터
   * @private
   */
  _emit(event, data = null) {
    const customEvent = new CustomEvent(`bpmn:${event}`, {
      detail: data
    });
    document.dispatchEvent(customEvent);
  }
  
  /**
   * 이벤트 리스너 등록
   * @param {string} event - 이벤트 이름
   * @param {Function} callback - 콜백 함수
   */
  on(event, callback) {
    document.addEventListener(`bpmn:${event}`, (e) => {
      callback(e.detail);
    });
  }
  
  /**
   * 이벤트 리스너 제거
   * @param {string} event - 이벤트 이름
   * @param {Function} callback - 콜백 함수
   */
  off(event, callback) {
    document.removeEventListener(`bpmn:${event}`, callback);
  }
  
  /**
   * 애플리케이션 종료
   */
  async destroy() {
    this.logger.info('Destroying BPMN Collaboration Editor...');
    
    try {
      // 협업 중지
      if (this.isCollaborationActive) {
        await this.stopCollaboration();
      }
      
      // 컴포넌트 정리
      if (this.collaborationPanel) {
        this.collaborationPanel.destroy();
      }
      
      if (this.awarenessUI) {
        this.awarenessUI.destroy();
      }
      
      if (this.performanceOptimizer) {
        this.performanceOptimizer.destroy();
      }
      
      // ConflictResolver 정리 (임시 비활성화)
      /*
      if (this.conflictResolver) {
        this.conflictResolver.destroy();
      }
      */
      
      if (this.bpmnSyncManager) {
        this.bpmnSyncManager.destroy();
      }
      
      if (this.providerManager) {
        this.providerManager.destroy();
      }
      
      if (this.yjsDocumentManager) {
        this.yjsDocumentManager.destroy();
      }
      
      // BPMN 모델러 정리
      if (this.modeler) {
        this.modeler.destroy();
      }
      
      this.logger.info('BPMN Collaboration Editor destroyed successfully');
      
    } catch (error) {
      this.logger.error('Error during destruction:', error);
      throw error;
    }
  }
}

// 전역으로 클래스 노출 (HTML에서 직접 사용 가능)
window.BpmnCollaborationEditor = BpmnCollaborationEditor;

// ES6 모듈로도 내보내기
export default BpmnCollaborationEditor;