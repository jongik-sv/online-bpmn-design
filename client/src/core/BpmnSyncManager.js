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
    
    // 설정 옵션
    this.options = {
      debounceDelay: 300,           // 디바운스 지연 시간 (ms)
      batchUpdateInterval: 100,      // 배치 업데이트 간격 (ms)
      enableLogging: true,           // 로깅 활성화
      maxRetries: 3,                 // 최대 재시도 횟수
      ...options
    };
    
    // 상태 관리
    this.isApplyingRemoteChanges = false;  // 원격 변경 적용 중 플래그
    this.pendingLocalChanges = new Map();   // 대기 중인 로컬 변경사항
    this.syncTransactionId = null;          // 현재 동기화 트랜잭션 ID
    this.processingCommands = new Set();    // 현재 처리 중인 명령어들 (재귀 방지)
    this.syncCallDepth = 0;                 // 동기화 호출 깊이
    this.lastErrorTime = 0;                 // 마지막 에러 시간
    this.errorCooldown = 1000;              // 에러 쿨다운 (1초)
    this._isAppendingShape = false;         // shape.append 처리 중 플래그
    
    // BPMN.js 서비스 참조
    this.elementRegistry = modeler.get('elementRegistry');
    this.modeling = modeler.get('modeling');
    this.eventBus = modeler.get('eventBus');
    this.commandStack = modeler.get('commandStack');
    
    // 초기화
    this._initialize();
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
  }
  
  /**
   * Y.js 변경 관찰자 설정
   * @private
   */
  _setupYjsObservers() {
    const yElements = this.yjsDocManager.getElementsMap();
    
    // Y.Map 변경 관찰
    yElements.observe((event, transaction) => {
      // 로컬 변경은 무시 (동기화 루프 방지)
      if (transaction.origin === 'local') {
        this._log(`Ignoring local Y.js transaction`, 'debug');
        return;
      }
      
      // 이미 원격 변경 적용 중이면 무시
      if (this.isApplyingRemoteChanges) {
        this._log(`Ignoring Y.js changes - already applying remote changes`, 'debug');
        return;
      }
      
      // 원격 변경 처리
      this._handleYjsChanges(event, transaction);
    });
    
    // 깊은 관찰자 설정 (중첩된 속성 변경 감지)
    yElements.observeDeep((events, transaction) => {
      if (transaction.origin === 'local') {
        this._log(`Ignoring local Y.js deep transaction`, 'debug');
        return;
      }
      
      // 이미 원격 변경 적용 중이면 무시
      if (this.isApplyingRemoteChanges) {
        this._log(`Ignoring Y.js deep changes - already applying remote changes`, 'debug');
        return;
      }
      
      this._handleYjsDeepChanges(events, transaction);
    });
  }
  
  /**
   * BPMN.js 커맨드 처리
   * @private
   */
  _handleBpmnCommand(event) {
    // 원격 변경 적용 중이면 무시
    if (this.isApplyingRemoteChanges) {
      this._log(`Skipping BPMN command ${event.command} - applying remote changes`, 'debug');
      return;
    }
    
    // 재귀 호출 방지
    this.syncCallDepth++;
    if (this.syncCallDepth > 10) {
      this._log(`Max sync call depth exceeded (${this.syncCallDepth}), aborting`, 'warn');
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
      
      // 커맨드에 따른 Y.js 업데이트 생성
      switch (command) {
        case 'shape.create':
          // shape.append가 호출될 예정이면 무시 (중복 방지)
          if (!this._isAppendingShape) {
            // shape.append의 일부일 수 있는지 확인 (undefined 좌표나 기본 위치인 경우)
            // parent가 있고 좌표가 undefined인 경우는 거의 확실히 shape.append의 일부
            const hasParent = context.shape && context.shape.parent;
            const hasUndefinedCoords = context.shape && (context.shape.x === undefined || context.shape.y === undefined);
            const isLikelyAppendOperation = hasParent && hasUndefinedCoords;
            
            if (isLikelyAppendOperation) {
              console.log(`[POSITION] Detected potential shape.append operation for ${context.shape.id} (x=${context.shape.x}, y=${context.shape.y}) - delaying sync`);
              
              // 짧은 지연 후 shape.append가 없으면 sync 수행
              setTimeout(() => {
                if (!this._isAppendingShape) {
                  console.log(`[POSITION] No shape.append detected, proceeding with delayed shape.create for ${context.shape.id}`);
                  this._syncShapeCreate(context);
                } else {
                  console.log(`[POSITION] Shape.append in progress, skipping delayed shape.create for ${context.shape.id}`);
                }
              }, 20); // 20ms 지연으로 shape.append 이벤트를 기다림
            } else {
              console.log(`[POSITION] Direct shape.create - proceeding immediately (parent=${!!hasParent}, coords=${context.shape?.x},${context.shape?.y})`);
              this._syncShapeCreate(context);
            }
          } else {
            console.log(`[POSITION] Skipping shape.create during append for ${context.shape?.id} - will be handled by shape.append`);
          }
          break;
          
        case 'shape.delete':
          this._syncShapeDelete(context);
          break;
          
        case 'shape.move':
          this._syncShapeMove(context);
          break;
          
        case 'shape.resize':
          this._syncShapeResize(context);
          break;
          
        case 'element.updateProperties':
          this._syncUpdateProperties(context);
          break;
          
        case 'connection.create':
          // shape.append에서 생성된 연결이 아닌 경우만 처리
          if (!this._isAppendingShape) {
            this._syncConnectionCreate(context);
          } else {
            // shape.append의 일부이지만 connection 정보가 완전하지 않을 수 있으므로 
            // 짧은 지연 후 다시 시도
            console.log(`[CONNECTION] Deferring connection.create during shape.append: ${context.connection?.id}`);
            setTimeout(() => {
              const { connection } = context;
              if (connection && connection.source && connection.target) {
                console.log(`[CONNECTION] Retrying deferred connection create: ${connection.id}`);
                this._syncConnectionCreate(context);
              }
            }, 50);
          }
          break;
          
        case 'connection.delete':
          this._syncConnectionDelete(context);
          break;
          
        case 'connection.updateWaypoints':
          this._syncConnectionWaypoints(context);
          break;
          
        case 'shape.append':
          // shape.append는 요소 생성 + 연결 생성을 포함
          // 먼저 플래그 설정하여 shape.create 이벤트 차단
          this._isAppendingShape = true;
          console.log(`[POSITION] Starting shape.append for ${context.shape?.id}, blocking individual shape.create`);
          
          try {
            this._syncShapeAppend(context);
          } finally {
            this._isAppendingShape = false;
            console.log(`[POSITION] Completed shape.append for ${context.shape?.id}, re-enabling shape.create`);
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
    const { shape } = context;
    
    // 이미 Y.js에 존재하는 요소인지 확인 (중복 생성 방지)
    const existingElement = this.yjsDocManager.getElement(shape.id);
    if (existingElement) {
      this._log(`Element ${shape.id} already exists in Y.js, skipping sync`, 'debug');
      return;
    }
    
    console.log(`[POSITION] Local shape created: ${shape.id} at x=${shape.x}, y=${shape.y}`);
    
    // shape.append에서 호출된 경우 실제 shape 좌표를 확인
    if (this._isAppendingShape && (shape.x === undefined || shape.x === 100)) {
      console.log(`[POSITION] Shape create during append - coordinates may be temporary`);
    }
    
    // 기본 위치 (100, 100)인 경우 shape.append의 올바른 위치를 기다릴 수 있도록 추가 검증
    if (shape.x === 100 && shape.y === 100 && shape.parent) {
      console.log(`[POSITION] Warning: Creating shape with default position (100,100). This may be updated by shape.append.`);
    }
    
    const elementData = this._extractElementData(shape);
    console.log(`[POSITION] Extracted element data: ${shape.id} at x=${elementData.x}, y=${elementData.y}`);
    
    this._log(`Syncing shape create: ${shape.id} (${shape.type})`, 'info');
    
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
    const { shape } = context;
    
    this.yjsDocManager.doc.transact(() => {
      const yElements = this.yjsDocManager.getElementsMap();
      yElements.delete(shape.id);
    }, 'local');
    
    this.emit('elementDeleted', { elementId: shape.id });
  }
  
  /**
   * Shape append 동기화 (요소 생성 + 자동 연결)
   * @private
   */
  _syncShapeAppend(context) {
    const { shape, source, connection } = context;
    
    // 위치 정보가 누락된 경우 기본값 설정
    if (shape.x === undefined || shape.y === undefined) {
      // source 요소 기준으로 위치 계산
      if (source && source.x !== undefined && source.y !== undefined) {
        shape.x = source.x + 150; // source 오른쪽에 배치
        shape.y = source.y;
        console.log(`[POSITION] Fixed undefined position for ${shape.id}: x=${shape.x}, y=${shape.y} (calculated from source)`);
      } else {
        // 기본 위치 설정
        shape.x = 240;
        shape.y = 60;
        console.log(`[POSITION] Fixed undefined position for ${shape.id}: x=${shape.x}, y=${shape.y} (default)`);
      }
    }
    
    console.log(`[POSITION] Shape append: ${shape.id} at x=${shape.x}, y=${shape.y} from source ${source?.id}`);
    this._log(`Syncing shape append: ${shape.id} from ${source?.id}`, 'info');
    this._log(`Shape append context:`, 'debug', context);
    
    try {
      // 이미 Y.js에 추가된 요소가 있는지 확인하고 위치 업데이트
      const existingElement = this.yjsDocManager.getElement(shape.id);
      if (existingElement) {
        // 기존 요소의 위치를 올바른 위치로 업데이트
        console.log(`[POSITION] Updating existing element ${shape.id} position to x=${shape.x}, y=${shape.y}`);
        
        // 즉시 Y.js 트랜잭션으로 위치 업데이트
        this.yjsDocManager.doc.transact(() => {
          const yElement = this.yjsDocManager.getElement(shape.id);
          if (yElement) {
            yElement.set('x', shape.x);
            yElement.set('y', shape.y);
            console.log(`[POSITION] Y.js position updated: ${shape.id} to x=${shape.x}, y=${shape.y}`);
            
            // 업데이트 후 검증
            const verifyData = yElement.toJSON();
            console.log(`[POSITION] Y.js verification: ${shape.id} stored as x=${verifyData.x}, y=${verifyData.y}`);
          }
        }, 'position-update'); // 다른 origin 사용하여 명확한 구분
      } else {
        // 1. 새로운 shape 동기화와 위치 설정을 한 번에 처리
        console.log(`[POSITION] Creating new element ${shape.id} at x=${shape.x}, y=${shape.y}`);
        
        // 하나의 트랜잭션으로 요소 생성 + 위치 설정
        this.yjsDocManager.doc.transact(() => {
          const yElements = this.yjsDocManager.getElementsMap();
          
          // 이미 존재하는지 확인
          if (yElements.has(shape.id)) {
            console.log(`[POSITION] Element ${shape.id} already exists, updating position only`);
            const yElement = yElements.get(shape.id);
            yElement.set('x', shape.x);
            yElement.set('y', shape.y);
          } else {
            // 새로운 요소 생성
            const elementData = this._extractElementData(shape);
            
            // 올바른 위치 정보로 덮어쓰기
            elementData.x = shape.x;
            elementData.y = shape.y;
            
            const yElement = new Y.Map();
            Object.entries(elementData).forEach(([key, value]) => {
              if (value !== undefined) {
                yElement.set(key, value);
              }
            });
            
            yElements.set(shape.id, yElement);
            console.log(`[POSITION] Created element ${shape.id} with correct position x=${shape.x}, y=${shape.y}`);
            
            // 트랜잭션 완료 후 검증
            const storedElement = yElements.get(shape.id);
            const storedData = storedElement.toJSON();
            console.log(`[POSITION] Y.js storage verification: ${shape.id} stored as x=${storedData.x}, y=${storedData.y}`);
          }
        }, 'shape-append-create');
      }
      
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
        this._log(`No connection in shape append context`, 'debug');
        
        // connection이 없는 경우 자동으로 연결 생성 시도
        // shape.append는 일반적으로 연결을 포함하므로 누락된 경우 생성
        if (source && shape) {
          console.log(`[CONNECTION] No connection found in context, will check for auto-created connection later`);
          
          // 짧은 지연 후 연결이 생성되었는지 확인
          setTimeout(() => {
            // 최근 생성된 연결 중에서 source와 target이 일치하는 것 찾기
            const canvas = this.modeler.get('canvas');
            const rootElement = canvas.getRootElement();
            
            if (rootElement && rootElement.children) {
              const recentConnection = rootElement.children.find(child => 
                child.type && child.type.includes('Flow') &&
                child.source && child.target &&
                child.source.id === source.id && 
                child.target.id === shape.id
              );
              
              if (recentConnection) {
                console.log(`[CONNECTION] Found auto-created connection: ${recentConnection.id}`);
                this._syncConnectionCreate({ connection: recentConnection });
              } else {
                console.log(`[CONNECTION] No auto-created connection found for ${source.id} -> ${shape.id}`);
              }
            }
          }, 100);
        }
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
    const { shapes, delta } = context;
    
    // 배치 업데이트를 위해 변경사항 수집
    shapes.forEach(shape => {
      this.pendingLocalChanges.set(shape.id, {
        type: 'move',
        x: shape.x,
        y: shape.y,
        timestamp: Date.now()
      });
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
    }, 'local');
  }
  
  /**
   * 연결 생성 동기화
   * @private
   */
  _syncConnectionCreate(context) {
    const { connection } = context;
    const connectionData = this._extractConnectionData(connection);
    
    // source/target이 누락된 경우 연결 동기화 중단
    if (!connectionData.source || !connectionData.target) {
      console.log(`[CONNECTION] Skipping connection sync for ${connection.id}: missing source/target (source: ${connectionData.source}, target: ${connectionData.target})`);
      return;
    }
    
    console.log(`[CONNECTION] Syncing connection create: ${connection.id} from ${connectionData.source} to ${connectionData.target}`);
    
    this.yjsDocManager.doc.transact(() => {
      const yElements = this.yjsDocManager.getElementsMap();
      const yConnection = new Y.Map();
      
      Object.entries(connectionData).forEach(([key, value]) => {
        if (value !== undefined) {
          yConnection.set(key, value);
        }
      });
      
      yElements.set(connection.id, yConnection);
    }, 'local');
  }
  
  /**
   * 연결 삭제 동기화
   * @private
   */
  _syncConnectionDelete(context) {
    const { connection } = context;
    
    this.yjsDocManager.doc.transact(() => {
      const yElements = this.yjsDocManager.getElementsMap();
      yElements.delete(connection.id);
    }, 'local');
    
    this.emit('connectionDeleted', { connectionId: connection.id });
  }
  
  /**
   * 연결 waypoints 업데이트 동기화
   * @private
   */
  _syncConnectionWaypoints(context) {
    const { connection } = context;
    
    this.yjsDocManager.doc.transact(() => {
      const yElements = this.yjsDocManager.getElementsMap();
      const yConnection = yElements.get(connection.id);
      
      if (yConnection) {
        const waypoints = connection.waypoints.map(wp => ({ x: wp.x, y: wp.y }));
        yConnection.set('waypoints', waypoints);
      }
    }, 'local');
    
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
    // 원격 변경 적용 중이면 무시
    if (this.isApplyingRemoteChanges) {
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
   * Y.js 깊은 변경사항 처리
   * @private
   */
  _handleYjsDeepChanges(events, transaction) {
    // 로컬 변경인 경우 무시 (동기화 루프 방지)
    if (transaction.origin === 'local') {
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
    // 동기화 루프 방지
    this.isApplyingRemoteChanges = true;
    
    this._log(`Handling Y.js changes: ${event.changes.keys.size} key changes`, 'info');
    
    try {
      event.changes.keys.forEach((change, key) => {
        this._log(`Y.js change: ${change.action} for element ${key}`, 'debug');
        
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
    const yElement = this.yjsDocManager.getElement(elementId);
    if (!yElement) {
      this._log(`Remote element ${elementId} not found in Y.js document`, 'warn');
      return;
    }
    
    const elementData = yElement.toJSON();
    const elementType = elementData.type;
    
    this._log(`Applying remote element create: ${elementId} (${elementType})`, 'info');
    
    // 이미 존재하는 요소인지 확인
    if (this.elementRegistry.get(elementId)) {
      this._log(`Element ${elementId} already exists in BPMN model`, 'debug');
      return;
    }
    
    // 요소 타입에 따른 생성
    if (this._isConnectionType(elementType)) {
      this._createRemoteConnection(elementId, elementData);
    } else {
      const createdShape = this._createRemoteShape(elementId, elementData);
      if (createdShape) {
        this._log(`Successfully created remote shape: ${elementId}`, 'debug');
      }
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
    const element = this.elementRegistry.get(elementId);
    if (!element) {
      console.log(`[POSITION] Remote update: element ${elementId} not found in registry`);
      return;
    }
    
    const yElement = this.yjsDocManager.getElement(elementId);
    if (!yElement) {
      console.log(`[POSITION] Remote update: element ${elementId} not found in Y.js`);
      return;
    }
    
    const updates = yElement.toJSON();
    console.log(`[POSITION] Remote update for ${elementId}: x=${updates.x}, y=${updates.y} (current: x=${element.x}, y=${element.y})`);
    
    // 위치/크기 업데이트 (더 엄격한 비교)
    if (updates.x !== undefined || updates.y !== undefined) {
      const currentX = Math.round(element.x || 0);
      const currentY = Math.round(element.y || 0);
      const newX = Math.round(updates.x || element.x || 0);
      const newY = Math.round(updates.y || element.y || 0);
      
      const delta = {
        x: newX - currentX,
        y: newY - currentY
      };
      
      console.log(`[POSITION] Position delta for ${elementId}: dx=${delta.x}, dy=${delta.y} (current: ${currentX},${currentY} -> new: ${newX},${newY})`);
      
      // 실제 위치 변화가 있을 때만 업데이트 (1픽셀 이상 차이)
      if (Math.abs(delta.x) >= 1 || Math.abs(delta.y) >= 1) {
        console.log(`[POSITION] Applying position update to ${elementId}`);
        
        try {
          // 안전한 위치 업데이트 - GraphicsFactory를 통한 직접 업데이트
          this.isApplyingRemoteChanges = true;
          
          // 요소 좌표 직접 업데이트
          element.x = updates.x;
          element.y = updates.y;
          
          // DI (Diagram Interchange) 업데이트
          if (element.di && element.di.bounds) {
            element.di.bounds.x = updates.x;
            element.di.bounds.y = updates.y;
          }
          
          // SVG 그래픽스 직접 업데이트 (리렌더링 우회)
          const canvas = this.modeler.get('canvas');
          const graphicsFactory = this.modeler.get('graphicsFactory');
          const elementRegistry = this.modeler.get('elementRegistry');
          
          // 요소 등록 업데이트
          elementRegistry._elements[elementId].element = element;
          
          // SVG 그래픽 위치 업데이트
          const gfx = canvas.getGraphics(element);
          if (gfx) {
            gfx.setAttribute('transform', `translate(${updates.x}, ${updates.y})`);
          }
          
          console.log(`[POSITION] Direct graphics update applied to ${elementId} at x=${updates.x}, y=${updates.y}`);
          
        } catch (error) {
          console.error(`[POSITION] Error applying direct graphics update to ${elementId}:`, error);
          
          // 최후의 폴백: 요소 재생성
          console.log(`[POSITION] Attempting element recreation for ${elementId}`);
          try {
            // 간단한 좌표 업데이트만 수행
            element.x = updates.x;
            element.y = updates.y;
            
            if (element.di && element.di.bounds) {
              element.di.bounds.x = updates.x;
              element.di.bounds.y = updates.y;
            }
            
            console.log(`[POSITION] Coordinate-only update applied to ${elementId}`);
          } catch (finalError) {
            console.error(`[POSITION] All position update methods failed for ${elementId}:`, finalError);
          }
        } finally {
          this.isApplyingRemoteChanges = false;
        }
      } else {
        console.log(`[POSITION] No position change needed for ${elementId}`);
      }
    }
    
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
        }, 'local');
        
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
  _extractElementData(element) {
    const businessObject = element.businessObject || {};
    const di = element.di || {};
    
    // 위치 정보 검증 및 기본값 설정
    let x = element.x;
    let y = element.y;
    
    if (typeof x !== 'number' || isNaN(x)) {
      x = 100; // 기본 x 좌표
      console.log(`[POSITION] Fixed invalid x coordinate for ${element.id}: ${element.x} -> ${x}`);
    }
    
    if (typeof y !== 'number' || isNaN(y)) {
      y = 100; // 기본 y 좌표  
      console.log(`[POSITION] Fixed invalid y coordinate for ${element.id}: ${element.y} -> ${y}`);
    }
    
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
      
      // 비즈니스 객체 생성
      const bpmnBusinessObject = this._createBusinessObject(businessObject);
      
      // 요소 생성을 위한 속성 정의
      const elementAttrs = {
        id: elementId,
        type: type,
        businessObject: bpmnBusinessObject,
        width: width || 100,
        height: height || 80
      };
      
      // BPMN 요소 타입에 따른 기본 크기 설정
      if (type === 'bpmn:Task' || type === 'bpmn:UserTask' || type === 'bpmn:ServiceTask') {
        elementAttrs.width = width || 100;
        elementAttrs.height = height || 80;
      } else if (type === 'bpmn:StartEvent' || type === 'bpmn:EndEvent') {
        elementAttrs.width = width || 36;
        elementAttrs.height = height || 36;
      } else if (type === 'bpmn:Gateway' || type === 'bpmn:ExclusiveGateway') {
        elementAttrs.width = width || 50;
        elementAttrs.height = height || 50;
      }
      
      // ElementFactory를 사용해서 요소 생성
      const element = elementFactory.createShape(elementAttrs);
      
      // 부모 요소 결정
      const parentElement = parent ? 
        this.elementRegistry.get(parent) : 
        this.modeler.get('canvas').getRootElement();
      
      // Y.js에서 최신 위치 정보 다시 확인
      const latestYElement = this.yjsDocManager.getElement(elementId);
      const latestData = latestYElement ? latestYElement.toJSON() : elementData;
      
      // 최신 위치 정보 사용
      let position = { 
        x: typeof latestData.x === 'number' ? latestData.x : (typeof x === 'number' ? x : 100), 
        y: typeof latestData.y === 'number' ? latestData.y : (typeof y === 'number' ? y : 100)
      };
      
      // 위치 정보 로그 (디버깅용)
      console.log(`[POSITION] Creating remote shape ${elementId} at position: x=${position.x}, y=${position.y}`);
      console.log(`[POSITION] Original data: x=${x}, y=${y}, Latest data: x=${latestData.x}, y=${latestData.y}`);
      
      // 원격 변경 적용 중 플래그 설정 (무한 루프 방지)
      this.isApplyingRemoteChanges = true;
      
      try {
        // 모델링 서비스를 사용해서 캔버스에 추가
        const shape = this.modeling.createShape(
          element,
          position,
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
      
      // 짧은 지연 후 재시도 (요소가 아직 생성되지 않았을 수 있음)
      setTimeout(() => {
        const retrySource = this.elementRegistry.get(source);
        const retryTarget = this.elementRegistry.get(target);
        
        if (retrySource && retryTarget) {
          this._log(`Retrying connection creation for ${elementId}`);
          this._createRemoteConnection(elementId, connectionData);
        } else {
          this._log(`Failed to create connection ${elementId} after retry: still missing endpoints`, 'warn');
        }
      }, 100);
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
          waypoints: waypoints,
          businessObject: connectionBusinessObject
        },
        this.modeler.get('canvas').getRootElement()
      );
      
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
    }, 'local');
    
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
      }, 'local');
      
      this.transactionDepth--;
      return result !== false;
      
    } catch (error) {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      this._log(`Safe transaction failed: ${error.message}`, 'error');
      return false;
    }
  }
  
  /**
   * 리소스 정리
   * @public
   */
  destroy() {
    // 이벤트 리스너 정리
    this.eventBus.off('commandStack.execute', this._handleBpmnCommand);
    this.eventBus.off('commandStack.revert', this._handleBpmnCommand);
    this.eventBus.off('elements.changed', this._handleElementsChanged);
    this.eventBus.off('selection.changed', this._handleSelectionChanged);
    this.eventBus.off('import.done', this._handleImportDone);
    
    // 배치 프로세서 정리
    if (this.batchUpdateInterval) {
      clearInterval(this.batchUpdateInterval);
    }
    
    // 이벤트 에미터 정리
    this.removeAllListeners();
    
    this._log('BpmnSyncManager destroyed');
  }
}