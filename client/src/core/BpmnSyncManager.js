/**
 * BpmnSyncManager - BPMN.js와 Y.js 간 양방향 동기화 관리자
 * 
 * 주요 기능:
 * 1. BPMN.js 이벤트를 Y.js 업데이트로 변환
 * 2. Y.js 변경사항을 BPMN.js 모델에 적용
 * 3. 동기화 루프 방지
 * 4. 성능 최적화 (디바운싱, 배치 처리)
 * 
 * @class BpmnSyncManager
 */

import { debounce } from 'lodash';
import EventEmitter from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import * as Y from 'yjs';

export class BpmnSyncManager extends EventEmitter {
  constructor(modeler, yjsDocumentManager, options = {}) {
    super();
    
    // 의존성 주입
    this.modeler = modeler;
    this.yjsDocManager = yjsDocumentManager;
    
    // 고유 클라이언트 ID 생성 (Y.js origin 구분용)
    this.clientId = 'client-' + Math.random().toString(36).substr(2, 9);
    console.log(`[ORIGIN] BpmnSyncManager initialized with clientId: ${this.clientId}`);
    
    // 설정 옵션
    this.options = {
      debounceDelay: 1000,           // 디바운스 지연 시간 (ms) - 1초로 증가
      batchUpdateInterval: 500,      // 배치 업데이트 간격 (ms) - 0.5초로 증가
      enableLogging: true,           // 로깅 활성화
      maxRetries: 3,                 // 최대 재시도 횟수
      ...options
    };
    
    // 상태 관리
    this.isApplyingRemoteChanges = false;  // 원격 변경 적용 중 플래그
    this.pendingLocalChanges = new Map();   // 대기 중인 로컬 변경사항
    this.isRealtimeSyncEnabled = true;      // 실시간 동기화 활성화 플래그
    this.syncTransactionId = null;          // 현재 동기화 트랜잭션 ID
    this.processingCommands = new Set();    // 현재 처리 중인 명령어들 (재귀 방지)
    this.syncCallDepth = 0;                 // 동기화 호출 깊이
    this.lastErrorTime = 0;                 // 마지막 에러 시간
    this.errorCooldown = 1000;              // 에러 쿨다운 (1초)
    this._isAppendingShape = false;         // shape.append 처리 중 플래그
    this._isUpdatingWaypoints = false;      // waypoints 업데이트 중 플래그
    this.isInitialSync = true;              // 초기 동기화 중 플래그
    this.initialSyncTimeout = null;         // 초기 동기화 타임아웃
    
    // 위치 추적 관련 상태
    this.pendingDropPosition = null;        // 대기 중인 드롭 위치 정보
    this.lastMousePosition = null;          // 마지막 마우스 위치
    this.dragStartPosition = null;          // 드래그 시작 위치
    this.isTracking = false;                // 위치 추적 활성화 플래그
    
    // BPMN.js 서비스 참조
    this.elementRegistry = modeler.get('elementRegistry');
    this.modeling = modeler.get('modeling');
    this.eventBus = modeler.get('eventBus');
    this.commandStack = modeler.get('commandStack');
    
    // 초기화
    this._initialize();
    
    // 초기 동기화 타이머 시작
    this._detectInitialSyncCompletion();
  }
  
  /**
   * 동기화 매니저 초기화
   * @private
   */
  _initialize() {
    // BPMN.js 이벤트 리스너 설정
    this._setupBpmnListeners();
    
    // Y.js 변경 관찰자 설정
    this._setupYjsObservers();
    
    // 배치 업데이트 프로세서 시작
    this._startBatchUpdateProcessor();
    
    // BpmnSyncManager initialized silently
  }
  
  /**
   * BPMN.js 이벤트 리스너 설정
   * @private
   */
  _setupBpmnListeners() {
    // 커맨드 스택 이벤트 (모든 모델링 작업 캡처)
    this.eventBus.on('commandStack.execute', this._handleBpmnCommand.bind(this));
    this.eventBus.on('commandStack.revert', this._handleBpmnCommand.bind(this));
    
    // 요소 변경 이벤트 (배치 업데이트)
    this.eventBus.on('elements.changed', debounce(
      this._handleElementsChanged.bind(this),
      this.options.debounceDelay
    ));
    
    // 선택 변경 이벤트 (사용자 인식)
    this.eventBus.on('selection.changed', this._handleSelectionChanged.bind(this));
    
    // 다이어그램 임포트 이벤트
    this.eventBus.on('import.done', this._handleImportDone.bind(this));
    
    // 위치 추적을 위한 추가 이벤트 리스너
    this.eventBus.on('create.start', this._handleCreateStart.bind(this));
    this.eventBus.on('create.move', this._handleCreateMove.bind(this));
    this.eventBus.on('create.end', this._handleCreateEnd.bind(this));
    this.eventBus.on('drag.start', this._handleDragStart.bind(this));
    this.eventBus.on('drag.move', this._handleDragMove.bind(this));
    this.eventBus.on('drag.end', this._handleDragEnd.bind(this));
    
    // 마우스 이벤트 직접 캡처 (더 정확한 위치 추적)
    this._setupMouseTracking();
  }
  
  /**
   * Y.js 변경 관찰자 설정
   * @private
   */
  _setupYjsObservers() {
    const yElements = this.yjsDocManager.getElementsMap();
    
    // Y.Map 변경 관찰
    yElements.observe((event, transaction) => {
      // 자신의 변경은 무시 (동기화 루프 방지)
      if (transaction.origin === this.clientId) {
        this._log(`Ignoring own Y.js transaction (origin: ${transaction.origin})`, 'debug');
        return;
      }
      
      // 이미 원격 변경 적용 중이면 무시
      if (this.isApplyingRemoteChanges) {
        this._log(`Ignoring Y.js changes - already applying remote changes`, 'debug');
        return;
      }
      
      console.log(`[ORIGIN] Processing remote Y.js change (origin: ${transaction.origin})`);
      // 원격 변경 처리
      this._handleYjsChanges(event, transaction);
    });
    
    // 깊은 관찰자 설정 (중첩된 속성 변경 감지) - 스로틀링 및 초기 동기화 최적화
    const throttledDeepChangeHandler = this._throttle((events, transaction) => {
      if (transaction.origin === this.clientId) {
        this._log(`Ignoring own Y.js deep transaction (origin: ${transaction.origin})`, 'debug');
        return;
      }
      
      // 이미 원격 변경 적용 중이면 무시
      if (this.isApplyingRemoteChanges) {
        this._log(`Ignoring Y.js deep changes - already applying remote changes`, 'debug');
        return;
      }
      
      // 초기 동기화 중이면 배치 처리로 최적화
      if (this.isInitialSync) {
        console.log(`[INITIAL_SYNC] Batching ${events.length} initial deep changes`);
        this._batchInitialDeepChanges(events, transaction);
        return;
      }
      
      // 중요한 변경사항만 필터링
      const significantEvents = events.filter(event => {
        // 위치, 크기, 타입 변경 등 중요한 속성만 처리
        const path = event.path || [];
        const lastKey = path[path.length - 1];
        return ['x', 'y', 'width', 'height', 'type', 'businessObject'].includes(lastKey);
      });
      
      if (significantEvents.length === 0) {
        this._log('No significant deep changes to process', 'debug');
        return;
      }
      
      console.log(`[ORIGIN] Processing ${significantEvents.length} significant Y.js deep changes (origin: ${transaction.origin})`);
      this._handleYjsDeepChanges(significantEvents, transaction);
    }, this.isInitialSync ? 1000 : 200); // 초기 동기화시 더 긴 스로틀링
    
    yElements.observeDeep(throttledDeepChangeHandler);
    
    // 초기 동기화 완료 감지
    this._detectInitialSyncCompletion();
  }
  
  /**
   * BPMN.js 커맨드 처리
   * @private
   */
  _handleBpmnCommand(event) {
    console.log(`[FUNC] _handleBpmnCommand(${event.command})`);
    console.log(`[EVENT_DEBUG] Command: ${event.command}, Context:`, event.context);
    console.log(`[EVENT_DEBUG] Element ID: ${event.context?.shape?.id || event.context?.connection?.id || 'unknown'}`);
    console.log(`[EVENT_DEBUG] Call stack depth: ${this.syncCallDepth}`);
    console.log(`[EVENT_DEBUG] isApplyingRemoteChanges: ${this.isApplyingRemoteChanges}`);
    // debugger;
    
    if (this.isApplyingRemoteChanges) {
      console.log(`[EVENT_DEBUG] Ignoring command during remote changes: ${event.command}`);
      return;
    }
    if (!this.isRealtimeSyncEnabled) {
      console.log(`[EVENT_DEBUG] Ignoring command - sync disabled: ${event.command}`);
      return;
    }
    
    this.syncCallDepth++;
    if (this.syncCallDepth > 10) {
      this.syncCallDepth--;
      return;
    }
    
    const { command, context } = event;
    const commandKey = `${command}-${context.shape?.id || context.connection?.id || 'unknown'}`;
    
    // 이미 처리 중인 명령어인지 확인
    if (this.processingCommands.has(commandKey)) {
      this._log(`Command ${commandKey} already processing, skipping`, 'debug');
      this.syncCallDepth--;
      return;
    }
    
    this.processingCommands.add(commandKey);
    
    try {
      // 트랜잭션 시작
      this.syncTransactionId = uuidv4();
      
      // 기본 컨텍스트 검증
      if (!context) {
        console.warn(`[BPMN] No context provided for command: ${command}`);
        return;
      }
      
      // 커맨드에 따른 Y.js 업데이트 생성
      switch (command) {
        case 'shape.create':
          console.log(`[EVENT_DEBUG] shape.create - isAppendingShape: ${this._isAppendingShape}`);
          console.log(`[EVENT_DEBUG] shape.create - element: ${context.shape?.id}, position:`, context.position);
          
          if (!this._isAppendingShape) {
            const hasValidParent = context.shape && context.shape.parent && 
                                 context.shape.parent.id && 
                                 context.shape.parent.id !== '__implicitroot';
            const hasContextPosition = context.position && context.position.x !== undefined && context.position.y !== undefined;
            const isLikelyAppendOperation = hasValidParent && hasContextPosition;
            
            console.log(`[EVENT_DEBUG] shape.create - hasValidParent: ${hasValidParent}, hasContextPosition: ${hasContextPosition}`);
            console.log(`[EVENT_DEBUG] shape.create - isLikelyAppendOperation: ${isLikelyAppendOperation}`);
            
            if (!isLikelyAppendOperation) {
              console.log(`[EVENT_DEBUG] Processing shape.create for ${context.shape?.id}`);
              this._syncShapeCreate(context);
            } else {
              console.log(`[EVENT_DEBUG] Skipping shape.create (likely append operation) for ${context.shape?.id}`);
            }
          } else {
            console.log(`[EVENT_DEBUG] Skipping shape.create (currently appending) for ${context.shape?.id}`);
          }
          break;
          
        case 'shape.delete':
          this._syncShapeDelete(context);
          break;
          
        case 'shape.move':
          console.log(`[EVENT_DEBUG] shape.move - isUpdatingWaypoints: ${this._isUpdatingWaypoints}`);
          
          // waypoints 업데이트 중이면 shape.move 무시
          if (this._isUpdatingWaypoints) {
            console.log(`[POSITION] Blocking shape.move during waypoints update`);
            break;
          }
          
          if (context && (context.shapes || context.shape)) {
            this._syncShapeMove(context);
          } else {
            console.warn(`[POSITION] Invalid move context - no shapes found:`, context);
          }
          break;
          
        case 'shape.resize':
          this._syncShapeResize(context);
          break;
          
        case 'element.updateProperties':
          this._syncUpdateProperties(context);
          break;
          
        case 'connection.create':
          console.log(`[EVENT_DEBUG] connection.create - isAppendingShape: ${this._isAppendingShape}`);
          // 연결 생성은 항상 동기화 (원격에 연결선 표시를 위해)
          this._syncConnectionCreate(context);
          break;
          
        case 'connection.delete':
          this._syncConnectionDelete(context);
          break;
          
        case 'connection.updateWaypoints':
          console.log(`[EVENT_DEBUG] connection.updateWaypoints - connection: ${context.connection?.id}`);
          console.log(`[EVENT_DEBUG] isApplyingRemoteChanges: ${this.isApplyingRemoteChanges}`);
          
          // 원격 변경 적용 중이면 waypoints 업데이트 차단 (위치 문제 방지)
          if (this.isApplyingRemoteChanges) {
            console.log(`[WAYPOINTS] Blocking waypoints update during remote changes to prevent position shifts`);
            return;
          }
          
          // 로컬 변경의 waypoints 업데이트는 허용 (연결선 모양 동기화)
          console.log(`[WAYPOINTS] Processing local waypoints update for ${context.connection?.id}`);
          this._syncConnectionWaypoints(context);
          
        case 'shape.append':
          console.log(`[EVENT_DEBUG] shape.append - element: ${context.shape?.id}`);
          this._isAppendingShape = true;
          try {
            this._syncShapeAppend(context);
          } finally {
            this._isAppendingShape = false;
            console.log(`[EVENT_DEBUG] shape.append completed for ${context.shape?.id}`);
          }
          break;
          
        case 'lane.updateRefs':
        case 'shape.replaced':
        case 'element.updateModdleProperties':
          // 이러한 명령어는 동기화하지 않음 (내부 처리용)
          this._log(`Skipping internal command: ${command}`, 'debug');
          break;
          
        default:
          this._log(`Unhandled command: ${command}`, 'debug');
      }
      
    } catch (error) {
      this._handleSyncError(error, 'BPMN command sync');
    } finally {
      this.syncTransactionId = null;
      this.processingCommands.delete(commandKey);
      this.syncCallDepth--;
    }
  }
  
  /**
   * 요소 생성 동기화
   * @private
   */
  _syncShapeCreate(context) {
    console.log(`[FUNC] _syncShapeCreate(${context})`);
    // debugger;
    
    const { shape, position } = context;
    const existingElement = this.yjsDocManager.getElement(shape.id);
    if (existingElement) return;
    
    const elementData = this._extractElementData(shape, position);
    
    try {
      // 안전한 Y.js 트랜잭션 실행
      const success = this._safeYjsTransaction(() => {
        const yElements = this.yjsDocManager.getElementsMap();
        
        // 다시 한 번 확인 (race condition 방지)
        if (yElements.has(shape.id)) {
          this._log(`Element ${shape.id} was added during transaction, skipping`, 'debug');
          return false;
        }
        
        const yElement = new Y.Map();
        
        // 요소 데이터 설정
        Object.entries(elementData).forEach(([key, value]) => {
          if (value !== undefined) {
            yElement.set(key, value);
          }
        });
        
        yElements.set(shape.id, yElement);
        this._log(`Element ${shape.id} added to Y.js document`, 'debug');
        return true;
      });
      
      if (!success) {
        this._log(`Failed to sync shape create for ${shape.id}`, 'warn');
        return;
      }
      
      this.emit('elementCreated', { elementId: shape.id, data: elementData });
      
    } catch (error) {
      this._handleSyncError(error, `Shape create sync for ${shape.id}`);
    }
  }
  
  /**
   * 요소 삭제 동기화
   * @private
   */
  _syncShapeDelete(context) {
    console.log(`[FUNC] _syncShapeDelete(${context.shape?.id})`);    
    // debugger;

    const { shape } = context;
    
    this.yjsDocManager.doc.transact(() => {
      const yElements = this.yjsDocManager.getElementsMap();
      yElements.delete(shape.id);
    }, this.clientId);
    
    this.emit('elementDeleted', { elementId: shape.id });
  }
  
  /**
   * Shape append 동기화 (요소 생성 + 자동 연결)
   * @private
   */
  _syncShapeAppend(context) {
    console.log(`[FUNC] _syncShapeAppend(${context})`);
    // debugger;

    
    const { shape, source, connection } = context;
    const bestPosition = this._getBestPosition(context, shape.id);
    
    if (bestPosition) {
      shape.x = bestPosition.x;
      shape.y = bestPosition.y;
    } else if (shape.x === undefined || shape.y === undefined) {
      if (source && source.x !== undefined && source.y !== undefined) {
        shape.x = source.x + 150;
        shape.y = source.y;
      } else {
        shape.x = 240;
        shape.y = 60;
      }
    }
    
    try {
      const existingElement = this.yjsDocManager.getElement(shape.id);
      if (existingElement) {
        this.yjsDocManager.doc.transact(() => {
          const yElements = this.yjsDocManager.getElementsMap();
          yElements.delete(shape.id);
        }, this.clientId);
      }
      
      this.yjsDocManager.doc.transact(() => {
        const yElements = this.yjsDocManager.getElementsMap();
        const elementData = this._extractElementData(shape);
        const yElement = new Y.Map();
        
        Object.entries(elementData).forEach(([key, value]) => {
          if (value !== undefined) {
            yElement.set(key, value);
          }
        });
        
        yElements.set(shape.id, yElement);
      }, this.clientId);
      
      // 2. 연결이 생성된 경우 연결도 동기화
      if (connection) {
        this._log(`Connection found: ${connection.id}, source: ${connection.source?.id}, target: ${connection.target?.id}`, 'debug');
        
        // connection source/target이 없는 경우 shape.append 컨텍스트에서 추론
        if (!connection.source || !connection.target) {
          console.log(`[CONNECTION] Fixing missing connection endpoints for ${connection.id}`);
          console.log(`[CONNECTION] Original connection: source=${connection.source?.id}, target=${connection.target?.id}`);
          console.log(`[CONNECTION] Available context: source=${source?.id}, shape=${shape?.id}`);
          
          // shape.append에서는 source가 기존 요소, target이 새로 생성된 shape
          if (source && shape) {
            connection.source = source;
            connection.target = shape;
            
            // businessObject에도 참조 설정
            if (connection.businessObject) {
              connection.businessObject.sourceRef = source.businessObject;
              connection.businessObject.targetRef = shape.businessObject;
            }
            
            console.log(`[CONNECTION] Fixed connection: ${connection.id} from ${source.id} to ${shape.id}`);
          }
        } else {
          console.log(`[CONNECTION] Connection already has endpoints: ${connection.id} from ${connection.source?.id} to ${connection.target?.id}`);
        }
        
        // connection에 source/target 정보가 있는지 확인
        if (connection.source && connection.target) {
          // source와 target이 실제 shape 객체가 아닌 경우 ID로 찾기
          const sourceElement = typeof connection.source === 'string' ? 
            this.elementRegistry.get(connection.source) : connection.source;
          const targetElement = typeof connection.target === 'string' ? 
            this.elementRegistry.get(connection.target) : connection.target;
          
          if (sourceElement && targetElement) {
            // 올바른 connection 객체 생성
            const correctedConnection = {
              ...connection,
              source: sourceElement,
              target: targetElement
            };
            this._syncConnectionCreate({ connection: correctedConnection });
            this._log(`Auto-connection created: ${connection.id} from ${sourceElement.id} to ${targetElement.id}`, 'info');
          } else {
            this._log(`Connection ${connection.id} elements not found in registry`, 'warn');
          }
        } else {
          this._log(`Connection ${connection.id} missing source/target, skipping sync`, 'warn');
        }
      } else {
        this._log(`No connection in shape append context - this is normal for shape.append`, 'debug');
        // connection은 별도의 connection.create 이벤트에서 처리됨
        console.log(`[CONNECTION] Connection will be handled by separate connection.create event`);
      }
      
    } catch (error) {
      this._handleSyncError(error, `Shape append sync for ${shape.id}`);
    }
  }
  
  /**
   * 요소 이동 동기화
   * @private
   */
  _syncShapeMove(context) {
    console.log(`[FUNC] _syncShapeMove(${context})`);
    // debugger;

    let { shapes, delta, shape } = context;
    
    // 단일 shape을 배열로 변환
    if (!shapes && shape) {
      shapes = [shape];
    }
    
    // shapes가 배열인지 확인
    if (!shapes || !Array.isArray(shapes)) {
      console.warn(`[POSITION] Invalid shapes in move context:`, shapes);
      console.warn(`[POSITION] Full move context:`, context);
      return;
    }
    
    console.log(`[POSITION] Moving ${shapes.length} shapes with delta dx=${delta?.x}, dy=${delta?.y}`);
    
    // 배치 업데이트를 위해 변경사항 수집
    shapes.forEach(shape => {
      if (shape && shape.id) {
        console.log(`[POSITION] Recording move for ${shape.id}: x=${shape.x}, y=${shape.y}`);
        this.pendingLocalChanges.set(shape.id, {
          type: 'move',
          x: shape.x,
          y: shape.y,
          timestamp: Date.now()
        });
      } else {
        console.warn(`[POSITION] Invalid shape in move operation:`, shape);
      }
    });
  }
  
  /**
   * 요소 크기 조정 동기화
   * @private
   */
  _syncShapeResize(context) {
    const { shape, newBounds } = context;
    
    this.pendingLocalChanges.set(shape.id, {
      type: 'resize',
      x: newBounds.x,
      y: newBounds.y,
      width: newBounds.width,
      height: newBounds.height,
      timestamp: Date.now()
    });
  }
  
  /**
   * 속성 업데이트 동기화
   * @private
   */
  _syncUpdateProperties(context) {
    console.log(`[FUNC] _syncUpdateProperties(${context.shape?.id})`);    
    // debugger;

    const { element, properties } = context;
    
    this.yjsDocManager.doc.transact(() => {
      const yElement = this.yjsDocManager.getElement(element.id);
      if (!yElement) return;
      
      // businessObject 업데이트 (안전하게 처리)
      let yBusinessObject = yElement.get('businessObject');
      
      // Y.Map이 아닌 경우 새로 생성
      if (!yBusinessObject || typeof yBusinessObject.set !== 'function') {
        yBusinessObject = new Y.Map();
        
        // 기존 데이터가 있다면 복사
        const existingBusinessObject = yElement.get('businessObject');
        if (existingBusinessObject && typeof existingBusinessObject === 'object' && existingBusinessObject !== null) {
          try {
            Object.entries(existingBusinessObject).forEach(([key, value]) => {
              if (typeof value !== 'function' && value !== null && value !== undefined) {
                yBusinessObject.set(key, value);
              }
            });
          } catch (copyError) {
            console.warn(`[SYNC] Failed to copy existing business object:`, copyError);
          }
        }
      }
      
      // 새로운 속성 추가 (안전하게)
      if (properties && typeof properties === 'object' && properties !== null) {
        try {
          Object.entries(properties).forEach(([key, value]) => {
            if (typeof value !== 'function' && value !== undefined && value !== null) {
              yBusinessObject.set(key, value);
            }
          });
        } catch (propertiesError) {
          console.warn(`[SYNC] Failed to process properties:`, propertiesError);
        }
      }
      
      yElement.set('businessObject', yBusinessObject);
    }, this.clientId);
  }
  
  /**
   * 연결 생성 동기화
   * @private
   */
  _syncConnectionCreate(context) {
    const { connection } = context;    
    console.log(`[FUNC] _syncConnectionCreate(${connection})`);
    // debugger;


    const connectionData = this._extractConnectionData(connection);
    
    // source/target이 누락된 경우 연결 동기화 중단
    if (!connectionData.source || !connectionData.target) {
      console.log(`[CONNECTION] Skipping connection sync for ${connection.id}: missing source/target (source: ${connectionData.source}, target: ${connectionData.target})`);
      return;
    }
    
    console.log(`[CONNECTION] Syncing connection create: ${connection.id} from ${connectionData.source} to ${connectionData.target}`);
    
    // debugger;
    this.yjsDocManager.doc.transact(() => {
      const yElements = this.yjsDocManager.getElementsMap();
      const yConnection = new Y.Map();
      
      Object.entries(connectionData).forEach(([key, value]) => {
        if (value !== undefined) {
          yConnection.set(key, value);
        }
      });
      
      yElements.set(connection.id, yConnection);
    }, this.clientId);
  }
  
  /**
   * 연결 삭제 동기화
   * @private
   */
  _syncConnectionDelete(context) {
    console.log(`[FUNC] _syncConnectionDelete(${context})`);
    // debugger;    

    const { connection } = context;
    
    this.yjsDocManager.doc.transact(() => {
      const yElements = this.yjsDocManager.getElementsMap();
      yElements.delete(connection.id);
    }, this.clientId);
    
    this.emit('connectionDeleted', { connectionId: connection.id });
  }
  
  /**
   * 연결 waypoints 업데이트 동기화
   * @private
   */
  _syncConnectionWaypoints(context) {
    console.log(`[FUNC] _syncConnectionWaypoints(${context})`);
    
    const { connection } = context;
    
    // waypoints 데이터만 동기화 (요소 위치에는 영향 주지 않음)
    console.log(`[WAYPOINTS] Syncing waypoints for connection ${connection.id}`);
    
    this.yjsDocManager.doc.transact(() => {
      const yElements = this.yjsDocManager.getElementsMap();
      const yConnection = yElements.get(connection.id);
      
      if (yConnection) {
        const waypoints = connection.waypoints.map(wp => ({ x: wp.x, y: wp.y }));
        yConnection.set('waypoints', waypoints);
        console.log(`[WAYPOINTS] Updated waypoints for ${connection.id}:`, waypoints);
      } else {
        console.log(`[WAYPOINTS] Connection ${connection.id} not found in Y.js document`);
      }
    }, this.clientId);
    
    this.emit('connectionWaypointsUpdated', { 
      connectionId: connection.id, 
      waypoints: connection.waypoints 
    });
  }
  
  /**
   * 요소 변경 이벤트 처리 (배치 업데이트)
   * @private
   */
  _handleElementsChanged(event) {
    // console.log(`[FUNC] _handleElementsChanged(${event})`);   
    // 원격 변경 적용 중이면 무시
    if (this.isApplyingRemoteChanges) {
      console.log(`[ELEMENTS_CHANGED] Ignoring - applying remote changes`);
      return;
    }
    
    // waypoints 업데이트 중이면 무시 (위치 변경 방지)
    if (this._isUpdatingWaypoints) {
      console.log(`[ELEMENTS_CHANGED] Blocking elements.changed during waypoints update`);
      return;
    }
    
    // shape.append 중이면 무시 (위치 변경 방지)
    if (this._isAppendingShape) {
      console.log(`[ELEMENTS_CHANGED] Blocking elements.changed during shape.append`);
      return;
    }
    
    const { elements } = event;
    
    // 변경된 요소들을 배치 업데이트에 추가
    elements.forEach(element => {
      if (element.type === 'label') return; // 라벨은 제외
      
      this.pendingLocalChanges.set(element.id, {
        type: 'update',
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        timestamp: Date.now()
      });
    });
    
    this.emit('elementsChanged', { elementIds: elements.map(e => e.id) });
  }
  
  /**
   * 스로틀링 유틸리티 함수
   * @private
   */
  _throttle(func, delay) {
    let timeoutId;
    let lastExecTime = 0;
    
    return function(...args) {
      const currentTime = Date.now();
      
      if (currentTime - lastExecTime > delay) {
        func.apply(this, args);
        lastExecTime = currentTime;
      } else {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          func.apply(this, args);
          lastExecTime = Date.now();
        }, delay - (currentTime - lastExecTime));
      }
    }.bind(this);
  }
  
  /**
   * 초기 동기화 완료 감지
   * @private
   */
  _detectInitialSyncCompletion() {
    // 3초 후 초기 동기화 완료로 간주
    this.initialSyncTimeout = setTimeout(() => {
      this.isInitialSync = false;
      console.log('[INITIAL_SYNC] Initial synchronization completed');
    }, 3000);
  }
  
  /**
   * 초기 동기화 중 깊은 변경사항 배치 처리
   * @private
   */
  _batchInitialDeepChanges(events, transaction) {
    // 초기 동기화 중에는 UI 업데이트를 최소화하고 데이터만 동기화
    const elementUpdates = new Map();
    
    events.forEach(event => {
      const path = event.path || [];
      if (path.length > 0) {
        const elementId = path[0];
        if (!elementUpdates.has(elementId)) {
          elementUpdates.set(elementId, []);
        }
        elementUpdates.get(elementId).push(event);
      }
    });
    
    // 배치로 처리하여 성능 최적화
    if (elementUpdates.size > 0) {
      console.log(`[INITIAL_SYNC] Batch processing ${elementUpdates.size} elements`);
      // 실제 처리는 기존 함수 재사용하되 UI 업데이트는 최소화
      this._handleYjsDeepChanges(events, transaction);
    }
  }
  
  /**
   * Y.js 깊은 변경사항 처리
   * @private
   */
  _handleYjsDeepChanges(events, transaction) {
    console.log(`[FUNC] _handleYjsDeepChanges(${events.length} events)`);     
    // debugger;  

    // 자신의 변경인 경우 무시 (동기화 루프 방지)
    if (transaction.origin === this.clientId) {
      return;
    }
    
    // 이미 원격 변경 적용 중인 경우 무시 (중첩 방지)
    if (this.isApplyingRemoteChanges) {
      this._log('Skipping deep changes: already applying remote changes', 'debug');
      return;
    }
    
    // 동기화 루프 방지
    this.isApplyingRemoteChanges = true;
    
    // 명령 스택이 실행 중인지 확인
    const commandStack = this.modeler.get('commandStack');
    if (commandStack._currentExecution) {
      // 명령 실행 중이면 지연 처리
      setTimeout(() => {
        this._handleYjsDeepChanges(events, transaction);
      }, 50);
      this.isApplyingRemoteChanges = false;
      return;
    }
    
    try {
      // 이벤트 중복 제거 (같은 요소에 대한 여러 변경을 하나로 통합)
      const processedElements = new Set();
      
      events.forEach(event => {
        if (event.target === this.yjsDocManager.getElementsMap()) {
          // 요소 레벨 변경 처리 (이미 _handleYjsChanges에서 처리됨)
          // 중복 처리 방지를 위해 생략
        } else if (event.path && event.path.length > 0) {
          // 중첩된 속성 변경 처리
          const elementId = event.path[0];
          if (typeof elementId === 'string' && !processedElements.has(elementId)) {
            processedElements.add(elementId);
            
            // 지연 처리로 명령 스택 충돌 방지
            setTimeout(() => {
              if (!this.isApplyingRemoteChanges) {
                this.isApplyingRemoteChanges = true;
                try {
                  this._applyRemoteElementUpdate(elementId);
                } finally {
                  this.isApplyingRemoteChanges = false;
                }
              }
            }, 10);
          }
        }
      });
    } catch (error) {
      this._handleSyncError(error, 'Y.js deep change application');
    } finally {
      this.isApplyingRemoteChanges = false;
    }
  }
  
  /**
   * Y.js 변경사항을 BPMN.js에 적용
   * @private
   */
  _handleYjsChanges(event, transaction) {
    console.log(`[FUNC] _handleYjsChanges(${event.changes.keys.size} changes, origin: ${transaction.origin})`);
    // debugger;  

    if (transaction.origin === this.clientId) return;
    this.isApplyingRemoteChanges = true;
    
    try {
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'add') {
          this._applyRemoteElementCreate(key);
        } else if (change.action === 'delete') {
          this._applyRemoteElementDelete(key);
        } else if (change.action === 'update') {
          this._applyRemoteElementUpdate(key);
        }
      });
    } catch (error) {
      this._handleSyncError(error, 'Y.js change application');
    } finally {
      this.isApplyingRemoteChanges = false;
    }
  }
  
  /**
   * 원격 요소 생성 적용
   * @private
   */
  _applyRemoteElementCreate(elementId) {
    console.log(`[FUNC] _applyRemoteElementCreate(${elementId})`);
    // debugger;  

    
    const yElement = this.yjsDocManager.getElement(elementId);
    if (!yElement) return;
    
    const elementData = yElement.toJSON();
    const elementType = elementData.type;
    
    if (this.elementRegistry.get(elementId)) return;
    
    if (this._isConnectionType(elementType)) {
      this._createRemoteConnection(elementId, elementData);
    } else {
      this._createRemoteShape(elementId, elementData);
    }
  }
  
  /**
   * 원격 요소 삭제 적용
   * @private
   */
  _applyRemoteElementDelete(elementId) {
    const element = this.elementRegistry.get(elementId);
    if (!element) return;
    
    this.modeling.removeElements([element]);
  }
  
  /**
   * 원격 요소 업데이트 적용
   * @private
   */
  _applyRemoteElementUpdate(elementId) {
    console.log(`[FUNC] _applyRemoteElementUpdate(${elementId})`);
    // debugger;  

    
    const element = this.elementRegistry.get(elementId);
    if (!element) return;
    
    const yElement = this.yjsDocManager.getElement(elementId);
    if (!yElement) return;
    
    const updates = yElement.toJSON();
    
    // 위치 업데이트 제거 - 이미 생성시 정확한 위치가 전달되므로 불필요
    console.log(`[POSITION] Skipping position update for ${elementId} - position should be correct from creation`);
    
    // 크기 업데이트
    if (updates.width !== undefined || updates.height !== undefined) {
      this.modeling.resizeShape(element, {
        x: element.x,
        y: element.y,
        width: updates.width || element.width,
        height: updates.height || element.height
      });
    }
    
    // 속성 업데이트 (안전하게 처리)
    if (updates.businessObject && typeof updates.businessObject === 'object') {
      try {
        // Y.js 객체가 아닌 일반 객체로 변환
        const properties = {};
        if (updates.businessObject && typeof updates.businessObject === 'object' && updates.businessObject !== null) {
          Object.entries(updates.businessObject).forEach(([key, value]) => {
            if (key !== '$type' && value !== undefined && value !== null) {
              // Y.js Map 객체인 경우 일반 객체로 변환
              if (value && typeof value === 'object' && typeof value.toJSON === 'function') {
                properties[key] = value.toJSON();
              } else if (typeof value !== 'function') {
                properties[key] = value;
              }
            }
          });
        }
        
        console.log(`[UPDATE] Applying business object properties to ${elementId}:`, Object.keys(properties));
        
        if (Object.keys(properties).length > 0) {
          this.modeling.updateProperties(element, properties);
        }
      } catch (updateError) {
        console.error(`[UPDATE] Failed to update business object properties for ${elementId}:`, updateError);
      }
    }
    
    // 연결 waypoints 업데이트
    if (updates.waypoints && element.waypoints) {
      this.modeling.updateWaypoints(element, updates.waypoints);
    }
  }
  
  /**
   * 배치 업데이트 프로세서 시작
   * @private
   */
  _startBatchUpdateProcessor() {
    console.log(`[FUNC] _startBatchUpdateProcessor()`);
    // debugger;  

    this.batchUpdateInterval = setInterval(() => {
      if (this.pendingLocalChanges.size === 0) return;
      
      // 원격 변경 적용 중이면 배치 업데이트 지연
      if (this.isApplyingRemoteChanges) {
        this._log('Delaying batch update: remote changes being applied', 'debug');
        return;
      }
      
      try {
        // 대기 중인 변경사항을 Y.js 트랜잭션으로 처리
        this.yjsDocManager.doc.transact(() => {
          this.pendingLocalChanges.forEach((change, elementId) => {
            const yElement = this.yjsDocManager.getElement(elementId);
            if (!yElement) return;
            
            // 변경 타입에 따른 업데이트
            switch (change.type) {
              case 'move':
              case 'update':
                if (change.x !== undefined) yElement.set('x', change.x);
                if (change.y !== undefined) yElement.set('y', change.y);
                break;
                
              case 'resize':
                if (change.x !== undefined) yElement.set('x', change.x);
                if (change.y !== undefined) yElement.set('y', change.y);
                if (change.width !== undefined) yElement.set('width', change.width);
                if (change.height !== undefined) yElement.set('height', change.height);
                break;
            }
          });
        }, this.clientId);
        
        // 처리된 변경사항 클리어
        this.pendingLocalChanges.clear();
        
      } catch (error) {
        this._handleSyncError(error, 'Batch update processing');
      }
      
    }, this.options.batchUpdateInterval);
  }
  
  /**
   * 요소 데이터 추출
   * @private
   */
  _extractElementData(element, overridePosition = null) {
    console.log(`[FUNC] _extractElementData(${element}, override: ${!!overridePosition})`);
    // debugger;  

    
    const businessObject = element.businessObject || {};
    const di = element.di || {};
    
    let x = element.x;
    let y = element.y;
    
    if (overridePosition && overridePosition.x !== undefined && overridePosition.y !== undefined) {
      x = overridePosition.x;
      y = overridePosition.y;
    }
    
    const isValidX = typeof x === 'number' && !isNaN(x);
    const isValidY = typeof y === 'number' && !isNaN(y);
    
    if (!isValidX) x = 100;
    if (!isValidY) y = 100;
    
    return {
      id: element.id,
      type: element.type,
      x: x,
      y: y,
      width: element.width || 100,
      height: element.height || 80,
      parent: element.parent?.id,
      businessObject: {
        id: businessObject.id,
        name: businessObject.name,
        $type: businessObject.$type,
        ...this._extractCustomProperties(businessObject)
      },
      di: {
        id: di.id,
        $type: di.$type
      }
    };
  }
  
  /**
   * 연결 데이터 추출
   * @private
   */
  _extractConnectionData(connection) {
    console.log(`[FUNC] _extractConnectionData(${connection})`);
    // debugger;  

    const businessObject = connection.businessObject || {};
    
    // source/target 정보를 더 안전하게 추출
    let sourceId = connection.source?.id;
    let targetId = connection.target?.id;
    
    // businessObject에서도 참조 확인
    if (!sourceId && businessObject.sourceRef) {
      sourceId = businessObject.sourceRef.id || businessObject.sourceRef;
    }
    if (!targetId && businessObject.targetRef) {
      targetId = businessObject.targetRef.id || businessObject.targetRef;
    }
    
    const connectionData = {
      id: connection.id,
      type: connection.type,
      source: sourceId,
      target: targetId,
      waypoints: connection.waypoints?.map(wp => ({ x: wp.x, y: wp.y })),
      businessObject: {
        id: businessObject.id,
        name: businessObject.name,
        $type: businessObject.$type,
        sourceRef: businessObject.sourceRef?.id || businessObject.sourceRef,
        targetRef: businessObject.targetRef?.id || businessObject.targetRef
      }
    };
    
    // 디버깅을 위한 로그
    console.log(`[CONNECTION] Extracted connection data: ${connection.id} from ${sourceId} to ${targetId}`);
    console.log(`[CONNECTION] Raw connection properties: source=${connection.source?.id}, target=${connection.target?.id}`);
    console.log(`[CONNECTION] BusinessObject refs: sourceRef=${businessObject.sourceRef?.id || businessObject.sourceRef}, targetRef=${businessObject.targetRef?.id || businessObject.targetRef}`);
    
    if (!connectionData.source || !connectionData.target) {
      this._log(`Connection data missing endpoints: source=${connectionData.source}, target=${connectionData.target}`, 'warn');
      this._log(`Original connection: source=${connection.source?.id}, target=${connection.target?.id}`, 'debug');
    }
    
    return connectionData;
  }
  
  /**
   * 사용자 정의 속성 추출
   * @private
   */
  _extractCustomProperties(businessObject) {
    const customProps = {};
    const standardProps = ['id', 'name', '$type', 'di', '$parent'];
    
    Object.keys(businessObject).forEach(key => {
      if (!standardProps.includes(key) && !key.startsWith('$')) {
        customProps[key] = businessObject[key];
      }
    });
    
    return customProps;
  }
  
  /**
   * 연결 타입 확인
   * @private
   */
  _isConnectionType(type) {
    return ['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association']
      .includes(type);
  }
  
  /**
   * 원격 도형 생성
   * @private
   */
  _createRemoteShape(elementId, elementData) {
    console.log(`[FUNC] _createRemoteShape(elementId : ${elementId}, elementData: ${elementData})`);  
    // debugger;  

    const { type, x, y, width, height, parent, businessObject } = elementData;
    
    // 요소가 이미 존재하는지 다시 한 번 확인
    if (this.elementRegistry.get(elementId)) {
      this._log(`Element ${elementId} already exists, aborting remote shape creation`, 'debug');
      return null;
    }
    
    try {
      // BPMN 팩토리를 사용해서 비즈니스 객체 생성
      const bpmnFactory = this.modeler.get('bpmnFactory');
      const elementFactory = this.modeler.get('elementFactory');
      
      // 더 간단하고 안전한 비즈니스 객체 생성
      let safeType = type;
      if (!safeType || !safeType.startsWith('bpmn:')) {
        safeType = 'bpmn:Task';
      }
      
      console.log(`[POSITION] Creating businessObject for type: ${safeType}`);
      const bpmnBusinessObject = bpmnFactory.create(safeType, {
        id: elementId,
        name: businessObject?.name || ''
      });
      
      console.log(`[POSITION] BusinessObject created:`, bpmnBusinessObject);
      
      // BusinessObject 유효성 검증
      if (!bpmnBusinessObject || !bpmnBusinessObject.$type) {
        console.error(`[POSITION] Invalid businessObject created for ${elementId}`);
        throw new Error(`Failed to create valid businessObject for ${elementId}`);
      }
      
      // Y.js에서 최신 위치 정보 먼저 확인 (BPMN.js 공식 방식 적용 전에)
      const latestYElement = this.yjsDocManager.getElement(elementId);
      const latestData = latestYElement ? latestYElement.toJSON() : elementData;
      
      // 더 강화된 위치 정보 결정 로직
      let finalX = 100, finalY = 100; // 기본값
      
      // 1순위: 최신 Y.js 데이터에서 유효한 위치
      if (latestData.x !== undefined && latestData.y !== undefined && 
          typeof latestData.x === 'number' && typeof latestData.y === 'number' &&
          !isNaN(latestData.x) && !isNaN(latestData.y)) {
        finalX = latestData.x;
        finalY = latestData.y;
        console.log(`[POSITION] 📥 Remote using Y.js position for ${elementId}: x=${finalX}, y=${finalY}`);
      }
      // 2순위: 전달받은 elementData에서 유효한 위치
      else if (x !== undefined && y !== undefined && 
               typeof x === 'number' && typeof y === 'number' &&
               !isNaN(x) && !isNaN(y)) {
        finalX = x;
        finalY = y;
        console.log(`[POSITION] Using elementData position for ${elementId}: x=${finalX}, y=${finalY}`);
      }
      // 3순위: 기본값 사용 (하지만 경고 출력)
      else {
        console.warn(`[POSITION] No valid position found for ${elementId}, using default: x=${finalX}, y=${finalY}`);
        console.warn(`[POSITION] Debug - latestData:`, latestData);
        console.warn(`[POSITION] Debug - original x=${x}, y=${y}`);
      }

      // ElementFactory로 기본 shape 생성 (위치 포함) - 이미 위에서 선언됨
      const baseShape = elementFactory.createShape({
        id: elementId,
        type: type,
        businessObject: bpmnBusinessObject,
        x: finalX,
        y: finalY,
        width: width || (type.includes('Event') ? 36 : type.includes('Gateway') ? 50 : 100),
        height: height || (type.includes('Event') ? 36 : type.includes('Gateway') ? 50 : 80)
      });
      
      console.log(`[POSITION] ElementFactory created baseShape:`, baseShape);
      
      // 부모 요소 결정
      const parentElement = parent ? 
        this.elementRegistry.get(parent) : 
        this.modeler.get('canvas').getRootElement();
      
      // 원격 변경 적용 중 플래그 설정 (무한 루프 방지)
      this.isApplyingRemoteChanges = true;
      
      try {
        // BPMN.js ElementFactory + Modeling 조합으로 안전한 생성
        console.log(`[POSITION] Creating shape with ElementFactory + Modeling: ${elementId} at x=${finalX}, y=${finalY}`);
        
        const shape = this.modeling.createShape(
          baseShape,      // 🎯 ElementFactory로 생성된 완전한 shape
          { x: finalX, y: finalY },  // 🎯 위치 명시적 지정
          parentElement   
        );
        
        return shape;
      } finally {
        // 플래그 해제
        this.isApplyingRemoteChanges = false;
      }
      
    } catch (error) {
      console.error('Failed to create remote shape:', error);
      this._log(`Failed to create remote shape ${elementId}: ${error.message}`, 'error');
      return null;
    }
  }
  
  /**
   * 원격 연결 생성
   * @private
   */
  _createRemoteConnection(elementId, connectionData) {
    console.log(`[FUNC] _createRemoteConnection(elementId : ${elementId}, connectionData: ${connectionData})`);      
    // debugger;  

    const { source, target, waypoints, businessObject } = connectionData;
    
    // source, target이 undefined인 경우 로그 출력 후 리턴
    if (!source || !target) {
      this._log(`Cannot create connection ${elementId}: source or target is undefined (source: ${source}, target: ${target})`, 'error');
      return null;
    }
    
    const sourceElement = this.elementRegistry.get(source);
    const targetElement = this.elementRegistry.get(target);
    
    if (!sourceElement || !targetElement) {
      this._log(`Cannot create connection ${elementId}: missing endpoints (source: ${source}, target: ${target})`);
      
      // 지연 재시도 제거 - waypoints 업데이트 방지
      this._log(`Failed to create connection ${elementId}: missing endpoints (source: ${source}, target: ${target}) - no retry to prevent waypoints issues`, 'warn');
      return;
    }
    
    // 원격 변경 적용 중 플래그 설정 (무한 루프 방지)
    this.isApplyingRemoteChanges = true;
    
    try {
      // 연결을 위한 비즈니스 객체 생성 (참조 설정 포함)
      const bpmnFactory = this.modeler.get('bpmnFactory');
      const connectionBusinessObject = bpmnFactory.create(connectionData.type || 'bpmn:SequenceFlow', {
        id: elementId,
        name: businessObject?.name || '',
        sourceRef: sourceElement.businessObject,
        targetRef: targetElement.businessObject
      });
      
      console.log(`[CONNECTION] Creating connection ${elementId} with proper business object refs`);
      
      const connection = this.modeling.createConnection(
        sourceElement,
        targetElement,
        {
          id: elementId,
          type: connectionData.type,
          businessObject: connectionBusinessObject
        },
        this.modeler.get('canvas').getRootElement()
      );
      
      // waypoints가 있는 경우 연결 생성 후 설정 (이벤트 발생 방지)
      if (waypoints && waypoints.length > 0) {
        try {
          // 연결 객체에 직접 waypoints 설정
          connection.waypoints = waypoints;
          
          // DI (Diagram Interchange)에도 waypoints 설정
          if (connection.di) {
            connection.di.waypoint = waypoints.map(wp => ({ x: wp.x, y: wp.y }));
          }
          
          console.log(`[CONNECTION] Set waypoints for ${elementId} without triggering events:`, waypoints);
        } catch (waypointError) {
          console.error(`[CONNECTION] Failed to set waypoints for ${elementId}:`, waypointError);
        }
      }
      
      console.log(`[CONNECTION] Created remote connection ${elementId}`);
      
      return connection;
    } finally {
      // 플래그 해제
      this.isApplyingRemoteChanges = false;
    }
  }
  
  /**
   * 비즈니스 객체 생성
   * @private
   */
  _createBusinessObject(data) {
    console.log(`[FUNC] _createBusinessObject(data : ${data})`);      
    // debugger;  

    try {
      const bpmnFactory = this.modeler.get('bpmnFactory');
      
      // 안전한 타입 확인
      let elementType = data.$type || 'bpmn:Task';
      
      // 유효한 BPMN 타입인지 확인
      const validTypes = [
        'bpmn:Task', 'bpmn:UserTask', 'bpmn:ServiceTask', 'bpmn:ManualTask',
        'bpmn:StartEvent', 'bpmn:EndEvent', 'bpmn:IntermediateThrowEvent',
        'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:InclusiveGateway',
        'bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association'
      ];
      
      if (!validTypes.includes(elementType)) {
        this._log(`Invalid BPMN type ${elementType}, defaulting to bpmn:Task`, 'warn');
        elementType = 'bpmn:Task';
      }
      
      // 기본 속성으로 비즈니스 객체 생성
      const businessObject = bpmnFactory.create(elementType, {
        id: data.id || `element_${Date.now()}`,
        name: data.name || ''
      });
      
      // 사용자 정의 속성 설정 (안전하게)
      Object.entries(data).forEach(([key, value]) => {
        if (!['$type', 'id', 'name'].includes(key) && value !== undefined) {
          try {
            businessObject[key] = value;
          } catch (propError) {
            this._log(`Failed to set property ${key}: ${propError.message}`, 'warn');
          }
        }
      });
      
      return businessObject;
      
    } catch (error) {
      this._log(`Failed to create business object: ${error.message}`, 'error');
      
      // 폴백: 기본 Task 생성
      const bpmnFactory = this.modeler.get('bpmnFactory');
      return bpmnFactory.create('bpmn:Task', {
        id: data.id || `fallback_${Date.now()}`,
        name: data.name || 'Untitled Task'
      });
    }
  }
  
  /**
   * 선택 변경 처리 (사용자 인식)
   * @private
   */
  _handleSelectionChanged(event) {
    console.log(`[FUNC] _handleSelectionChanged(event : ${event}), this.isApplyingRemoteChanges : ${this.isApplyingRemoteChanges}`);      
    // // debugger;  

    // 원격 변경 적용 중이면 무시 (동기화 루프 방지)
    if (this.isApplyingRemoteChanges) {
      return;
    }
    
    const { newSelection } = event;
    const selectedIds = newSelection.map(el => el.id);
    
    // Y.js awareness 업데이트 (선택 변경은 awareness만 업데이트하고 문서 변경은 하지 않음)
    try {
      this.yjsDocManager.updateAwareness({
        selectedElements: selectedIds,
        cursor: this._getCurrentCursorPosition(),
        timestamp: Date.now()
      });
    } catch (error) {
      this._log(`Awareness update failed: ${error.message}`, 'warn');
    }
    
    this.emit('selectionChanged', { selectedIds });
  }
  
  /**
   * 다이어그램 임포트 완료 처리
   * @private
   */
  _handleImportDone(event) {
    const { elements } = event;
    
    // 전체 다이어그램을 Y.js에 동기화
    this.yjsDocManager.doc.transact(() => {
      const yElements = this.yjsDocManager.getElementsMap();
      
      elements.forEach(element => {
        if (element.type === 'label') return; // 라벨은 별도 처리
        
        const elementData = element.waypoints 
          ? this._extractConnectionData(element)
          : this._extractElementData(element);
          
        const yElement = new Y.Map();
        Object.entries(elementData).forEach(([key, value]) => {
          if (value !== undefined) {
            yElement.set(key, value);
          }
        });
        
        yElements.set(element.id, yElement);
      });
    }, this.clientId);
    
    this.emit('diagramImported', { elementCount: elements.length });
  }
  
  /**
   * 현재 커서 위치 가져오기
   * @private
   */
  _getCurrentCursorPosition() {
    // Canvas 이벤트에서 마우스 위치 추적
    const canvas = this.modeler.get('canvas');
    const container = canvas.getContainer();
    
    return {
      x: this.lastMouseX || 0,
      y: this.lastMouseY || 0,
      viewport: canvas.viewbox()
    };
  }
  
  /**
   * 에러 처리
   * @private
   */
  _handleSyncError(error, context) {
    const now = Date.now();
    
    // 에러 쿨다운 체크 (너무 많은 에러 로그 방지)
    if (now - this.lastErrorTime < this.errorCooldown) {
      return; // 쿨다운 중이면 무시
    }
    
    this.lastErrorTime = now;
    
    this._log(`Sync error in ${context}: ${error.message}`, 'error');
    
    // 에러 타입에 따른 특별 처리
    if (error.message && error.message.includes('getElementsMap')) {
      this._log('Y.js document manager state error detected - skipping to prevent loops', 'warn');
      return; // getElementsMap 에러는 무한 루프를 방지하기 위해 조기 리턴
    }
    
    this.emit('syncError', {
      error,
      context,
      timestamp: now
    });
    
    // 복구 시도
    if (this.options.maxRetries > 0) {
      this._attemptRecovery(context);
    }
  }
  
  /**
   * 복구 시도
   * @private
   */
  _attemptRecovery(context) {
    // 간단한 복구 로직
    setTimeout(() => {
      this._log(`Attempting recovery for ${context}`);
      
      // 전체 상태 재동기화
      this.resyncFullDiagram();
    }, 1000);
  }
  
  /**
   * 전체 다이어그램 재동기화
   * @public
   */
  resyncFullDiagram() {
    const elements = this.elementRegistry.getAll();
    const event = { elements };
    
    this._handleImportDone(event);
  }
  
  /**
   * 로깅 유틸리티
   * @private
   */
  _log(message, level = 'info') {
    if (!this.options.enableLogging) return;
    
    const timestamp = new Date().toISOString();
    console[level](`[BpmnSyncManager ${timestamp}] ${message}`);
  }
  
  /**
   * 안전한 Y.js 트랜잭션 실행
   * @private
   * @param {Function} callback - 트랜잭션 내에서 실행할 함수
   * @returns {boolean} 성공 여부
   */
  _safeYjsTransaction(callback) {
    console.log(`[FUNC] _safeYjsTransaction(callback : ${callback})`);         
    // debugger;  

    try {
      // 트랜잭션 깊이 추적
      if (!this.transactionDepth) {
        this.transactionDepth = 0;
      }
      
      this.transactionDepth++;
      
      // 최대 깊이 제한
      if (this.transactionDepth > 5) {
        this._log(`Transaction depth limit exceeded (${this.transactionDepth})`, 'warn');
        this.transactionDepth--;
        return false;
      }
      
      let result = false;
      
      // Y.js 트랜잭션 실행
      this.yjsDocManager.doc.transact(() => {
        result = callback();
      }, this.clientId);
      
      this.transactionDepth--;
      return result !== false;
      
    } catch (error) {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      this._log(`Safe transaction failed: ${error.message}`, 'error');
      return false;
    }
  }
  
  /**
   * 마우스 추적 설정
   * @private
   */
  _setupMouseTracking() {
    const canvas = this.modeler.get('canvas');
    const container = canvas.getContainer();
    
    if (container) {
      container.addEventListener('mousemove', this._handleMouseMove.bind(this));
      container.addEventListener('mousedown', this._handleMouseDown.bind(this));
      container.addEventListener('mouseup', this._handleMouseUp.bind(this));
    }
  }
  
  /**
   * 마우스 이동 핸들러
   * @private
   */
  _handleMouseMove(event) {
    const canvas = this.modeler.get('canvas');
    const rect = canvas.getContainer().getBoundingClientRect();
    const viewbox = canvas.viewbox();
    
    // 캔버스 좌표계로 변환
    const x = viewbox.x + (event.clientX - rect.left) * viewbox.width / rect.width;
    const y = viewbox.y + (event.clientY - rect.top) * viewbox.height / rect.height;
    
    this.lastMousePosition = { x, y };
    
    if (this.isTracking) {
      this.pendingDropPosition = { x, y };
      console.log(`[POSITION_TRACK] Mouse position updated: x=${x}, y=${y}`);
    }
  }
  
  /**
   * 마우스 다운 핸들러
   * @private
   */
  _handleMouseDown(event) {
    this.dragStartPosition = this.lastMousePosition ? { ...this.lastMousePosition } : null;
    console.log(`[POSITION_TRACK] Mouse down at:`, this.dragStartPosition);
  }
  
  /**
   * 마우스 업 핸들러
   * @private
   */
  _handleMouseUp(event) {
    // 드래그가 끝났을 때 위치 정보를 확정
    if (this.isTracking && this.lastMousePosition) {
      this.pendingDropPosition = { ...this.lastMousePosition };
      console.log(`[POSITION_TRACK] Final drop position:`, this.pendingDropPosition);
    }
  }
  
  /**
   * Create 시작 이벤트 핸들러
   * @private
   */
  _handleCreateStart(event) {
    this.isTracking = true;
    this.pendingDropPosition = null;
    console.log(`[POSITION_TRACK] Create started, enabling position tracking`);
  }
  
  /**
   * Create 이동 이벤트 핸들러
   * @private
   */
  _handleCreateMove(event) {
    if (event.context && event.context.x !== undefined && event.context.y !== undefined) {
      this.pendingDropPosition = { x: event.context.x, y: event.context.y };
      console.log(`[POSITION_TRACK] Create move position: x=${event.context.x}, y=${event.context.y}`);
    }
  }
  
  /**
   * Create 종료 이벤트 핸들러
   * @private
   */
  _handleCreateEnd(event) {
    if (event.context && event.context.x !== undefined && event.context.y !== undefined) {
      this.pendingDropPosition = { x: event.context.x, y: event.context.y };
      console.log(`[POSITION_TRACK] Create end position: x=${event.context.x}, y=${event.context.y}`);
    }
    
    // 짧은 지연 후 추적 비활성화 (shape.append가 처리될 시간을 줌)
    setTimeout(() => {
      this.isTracking = false;
      console.log(`[POSITION_TRACK] Position tracking disabled`);
    }, 50);
  }
  
  /**
   * 드래그 시작 이벤트 핸들러
   * @private
   */
  _handleDragStart(event) {
    this.isTracking = true;
    console.log(`[POSITION_TRACK] Drag started, enabling position tracking`);
  }
  
  /**
   * 드래그 이동 이벤트 핸들러
   * @private
   */
  _handleDragMove(event) {
    if (event.x !== undefined && event.y !== undefined) {
      this.pendingDropPosition = { x: event.x, y: event.y };
      console.log(`[POSITION_TRACK] Drag move position: x=${event.x}, y=${event.y}`);
    }
  }
  
  /**
   * 드래그 종료 이벤트 핸들러
   * @private
   */
  _handleDragEnd(event) {
    if (event.x !== undefined && event.y !== undefined) {
      this.pendingDropPosition = { x: event.x, y: event.y };
      console.log(`[POSITION_TRACK] Drag end position: x=${event.x}, y=${event.y}`);
    }
    
    // 짧은 지연 후 추적 비활성화
    setTimeout(() => {
      this.isTracking = false;
      this.pendingDropPosition = null;
      console.log(`[POSITION_TRACK] Position tracking disabled`);
    }, 50);
  }
  
  /**
   * AwarenessUI 연결 (app.js에서 호출됨)
   * @public
   */
  setAwarenessUI(awarenessUI) {
    this.awarenessUI = awarenessUI;
    console.log(`[POSITION_TRACK] AwarenessUI connected to BpmnSyncManager`);
  }
  
  /**
   * 최적 위치 정보 가져오기
   * @private
   */
  _getBestPosition(context, elementId) {
    console.log(`[FUNC] _getBestPosition(context : ${context}, elementId : ${elementId})`);         
    // debugger;  

    // console.log(`[POSITION_TRACK] Getting best position for ${elementId}`);
    // console.log(`[POSITION_TRACK] - pendingDropPosition:`, this.pendingDropPosition);
    // console.log(`[POSITION_TRACK] - context.position:`, context.position);
    // console.log(`[POSITION_TRACK] - context.target:`, context.target);
    // console.log(`[POSITION_TRACK] - awarenessUI.localCursor:`, this.awarenessUI?.localCursor);
    // console.log(`[POSITION_TRACK] - lastMousePosition:`, this.lastMousePosition);
    
    // 우선순위대로 위치 정보 선택
    if (this.pendingDropPosition && this.pendingDropPosition.x !== undefined && this.pendingDropPosition.y !== undefined) {
      console.log(`[POSITION_TRACK] Using pendingDropPosition: x=${this.pendingDropPosition.x}, y=${this.pendingDropPosition.y}`);
      return this.pendingDropPosition;
    }
    
    if (context.position && context.position.x !== undefined && context.position.y !== undefined) {
      console.log(`[POSITION_TRACK] Using context.position: x=${context.position.x}, y=${context.position.y}`);
      return context.position;
    }
    
    if (context.target && context.target.x !== undefined && context.target.y !== undefined) {
      console.log(`[POSITION_TRACK] Using context.target: x=${context.target.x}, y=${context.target.y}`);
      return context.target;
    }
    
    if (this.awarenessUI && this.awarenessUI.localCursor && 
        this.awarenessUI.localCursor.x !== undefined && this.awarenessUI.localCursor.y !== undefined) {
      console.log(`[POSITION_TRACK] Using awarenessUI.localCursor: x=${this.awarenessUI.localCursor.x}, y=${this.awarenessUI.localCursor.y}`);
      return this.awarenessUI.localCursor;
    }
    
    if (this.lastMousePosition && this.lastMousePosition.x !== undefined && this.lastMousePosition.y !== undefined) {
      console.log(`[POSITION_TRACK] Using lastMousePosition: x=${this.lastMousePosition.x}, y=${this.lastMousePosition.y}`);
      return this.lastMousePosition;
    }
    
    console.log(`[POSITION_TRACK] No reliable position found, returning null`);
    return null;
  }

  /**
   * 리소스 정리
   * @public
   */
  destroy() {
    // 기본 이벤트 리스너 정리
    this.eventBus.off('commandStack.execute', this._handleBpmnCommand);
    this.eventBus.off('commandStack.revert', this._handleBpmnCommand);
    this.eventBus.off('elements.changed', this._handleElementsChanged);
    this.eventBus.off('selection.changed', this._handleSelectionChanged);
    this.eventBus.off('import.done', this._handleImportDone);
    
    // 위치 추적 이벤트 리스너 정리
    this.eventBus.off('create.start', this._handleCreateStart);
    this.eventBus.off('create.move', this._handleCreateMove);
    this.eventBus.off('create.end', this._handleCreateEnd);
    this.eventBus.off('drag.start', this._handleDragStart);
    this.eventBus.off('drag.move', this._handleDragMove);
    this.eventBus.off('drag.end', this._handleDragEnd);
    
    // 마우스 이벤트 리스너 정리
    const canvas = this.modeler.get('canvas');
    const container = canvas.getContainer();
    if (container) {
      container.removeEventListener('mousemove', this._handleMouseMove);
      container.removeEventListener('mousedown', this._handleMouseDown);
      container.removeEventListener('mouseup', this._handleMouseUp);
    }
    
    // 배치 프로세서 정리
    if (this.batchUpdateInterval) {
      clearInterval(this.batchUpdateInterval);
    }
    
    // 이벤트 에미터 정리
    this.removeAllListeners();
    
    this._log('BpmnSyncManager destroyed');
  }
}