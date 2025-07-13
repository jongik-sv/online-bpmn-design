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
    
    this._log('BpmnSyncManager initialized');
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
        return;
      }
      
      // 원격 변경 처리
      this._handleYjsChanges(event, transaction);
    });
    
    // 깊은 관찰자 설정 (중첩된 속성 변경 감지)
    yElements.observeDeep((events, transaction) => {
      if (transaction.origin === 'local') {
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
          this._syncShapeCreate(context);
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
          this._syncConnectionCreate(context);
          break;
          
        case 'connection.delete':
          this._syncConnectionDelete(context);
          break;
          
        case 'connection.updateWaypoints':
          this._syncConnectionWaypoints(context);
          break;
          
        case 'shape.append':
          // shape.create와 동일하게 처리
          this._syncShapeCreate(context);
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
    
    const elementData = this._extractElementData(shape);
    
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
      
      // businessObject 업데이트
      const yBusinessObject = yElement.get('businessObject') || new Y.Map();
      Object.entries(properties).forEach(([key, value]) => {
        yBusinessObject.set(key, value);
      });
      
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
    
    try {
      // 이벤트 중복 제거 (같은 요소에 대한 여러 변경을 하나로 통합)
      const processedElements = new Set();
      
      events.forEach(event => {
        if (event.target === this.yjsDocumentManager.getElementsMap()) {
          // 요소 레벨 변경 처리 (이미 _handleYjsChanges에서 처리됨)
          // 중복 처리 방지를 위해 생략
        } else if (event.path && event.path.length > 0) {
          // 중첩된 속성 변경 처리
          const elementId = event.path[0];
          if (typeof elementId === 'string' && !processedElements.has(elementId)) {
            processedElements.add(elementId);
            this._applyRemoteElementUpdate(elementId);
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
    if (!element) return;
    
    const yElement = this.yjsDocManager.getElement(elementId);
    if (!yElement) return;
    
    const updates = yElement.toJSON();
    
    // 위치/크기 업데이트
    if (updates.x !== undefined || updates.y !== undefined) {
      const delta = {
        x: (updates.x || element.x) - element.x,
        y: (updates.y || element.y) - element.y
      };
      
      if (delta.x !== 0 || delta.y !== 0) {
        this.modeling.moveElements([element], delta);
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
    
    // 속성 업데이트
    if (updates.businessObject) {
      const properties = updates.businessObject;
      this.modeling.updateProperties(element, properties);
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
    
    return {
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
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
    
    return {
      id: connection.id,
      type: connection.type,
      source: connection.source?.id,
      target: connection.target?.id,
      waypoints: connection.waypoints?.map(wp => ({ x: wp.x, y: wp.y })),
      businessObject: {
        id: businessObject.id,
        name: businessObject.name,
        $type: businessObject.$type,
        sourceRef: businessObject.sourceRef?.id,
        targetRef: businessObject.targetRef?.id
      }
    };
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
      
      // 모델링 서비스를 사용해서 캔버스에 추가
      const shape = this.modeling.createShape(
        element,
        { x: x || 100, y: y || 100 },
        parentElement
      );
      
      return shape;
      
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
    
    const sourceElement = this.elementRegistry.get(source);
    const targetElement = this.elementRegistry.get(target);
    
    if (!sourceElement || !targetElement) {
      this._log(`Cannot create connection ${elementId}: missing endpoints`);
      return;
    }
    
    const connection = this.modeling.createConnection(
      sourceElement,
      targetElement,
      {
        id: elementId,
        type: connectionData.type,
        waypoints: waypoints,
        businessObject: this._createBusinessObject(businessObject)
      },
      this.modeler.get('canvas').getRootElement()
    );
    
    return connection;
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
    this._log(`Sync error in ${context}: ${error.message}`, 'error');
    
    this.emit('syncError', {
      error,
      context,
      timestamp: Date.now()
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