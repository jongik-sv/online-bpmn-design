/**
 * ConflictResolver - 협업 중 발생하는 충돌 해결
 * 
 * 주요 기능:
 * 1. 충돌 감지 및 분류
 * 2. 자동 충돌 해결 (CRDT 기반)
 * 3. 의미적 충돌 검증
 * 4. 사용자 개입이 필요한 충돌 처리
 * 5. 충돌 해결 기록 및 추적
 * 
 * @class ConflictResolver
 */

import EventEmitter from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import { throttle } from 'lodash';

export class ConflictResolver extends EventEmitter {
  constructor(bpmnModeler, yjsDocManager, clientId, options = {}) {
    super();
    
    // 의존성 주입
    this.modeler = bpmnModeler;
    this.yjsDocManager = yjsDocManager;
    this.clientId = clientId;
    
    // 설정 옵션
    this.options = {
      enableAutoResolution: true,       // 자동 충돌 해결 활성화
      semanticValidation: true,         // BPMN 의미 검증
      preserveBusinessLogic: true,      // 비즈니스 로직 보존
      conflictHistoryLimit: 100,        // 충돌 기록 제한
      userNotificationDelay: 500,       // 사용자 알림 지연 (ms)
      ...options
    };
    
    // 충돌 상태 관리
    this.activeConflicts = new Map();   // 현재 활성 충돌
    this.conflictHistory = [];          // 충돌 해결 기록
    this.resolutionStrategies = new Map(); // 충돌 해결 전략
    
    // BPMN 서비스
    this.elementRegistry = bpmnModeler.get('elementRegistry');
    this.modeling = bpmnModeler.get('modeling');
    this.bpmnFactory = bpmnModeler.get('bpmnFactory');
    this.rules = bpmnModeler.get('rules');
    
    // 초기화
    this._initialize();
  }
  
  /**
   * 충돌 해결기 초기화
   * @private
   */
  _initialize() {
    // 기본 해결 전략 등록
    this._registerDefaultStrategies();
    
    // Y.js 충돌 감지 설정
    this._setupConflictDetection();
    
    // BPMN 규칙 검증 설정
    this._setupSemanticValidation();
    
    console.log('ConflictResolver initialized');
  }
  
  /**
   * 기본 충돌 해결 전략 등록
   * @private
   */
  _registerDefaultStrategies() {
    // 위치 충돌 해결 전략
    this.registerStrategy('position', {
      name: 'Position Conflict Resolution',
      autoResolve: true,
      resolve: (conflict) => this._resolvePositionConflict(conflict)
    });
    
    // 속성 충돌 해결 전략
    this.registerStrategy('property', {
      name: 'Property Conflict Resolution',
      autoResolve: true,
      resolve: (conflict) => this._resolvePropertyConflict(conflict)
    });
    
    // 연결 충돌 해결 전략
    this.registerStrategy('connection', {
      name: 'Connection Conflict Resolution',
      autoResolve: false,
      resolve: (conflict) => this._resolveConnectionConflict(conflict)
    });
    
    // 삭제 충돌 해결 전략
    this.registerStrategy('deletion', {
      name: 'Deletion Conflict Resolution',
      autoResolve: false,
      resolve: (conflict) => this._resolveDeletionConflict(conflict)
    });
    
    // 구조적 충돌 해결 전략
    this.registerStrategy('structural', {
      name: 'Structural Conflict Resolution',
      autoResolve: false,
      resolve: (conflict) => this._resolveStructuralConflict(conflict)
    });
  }
  
  /**
   * Y.js 충돌 감지 설정
   * @private
   */
  _setupConflictDetection() {
    const yElements = this.yjsDocManager.getElementsMap();
    
    // 요소 변경 감지
    yElements.observeDeep((events, transaction) => {
      // 자신의 변경은 무시
      if (transaction.origin === this.clientId) return;
      
      events.forEach(event => {
        if (event.path.length > 0) {
          this._detectConflict(event, transaction);
        }
      });
    });
    
    // 문서 업데이트 감지 비활성화 (무한 재귀 방지)
    // 현재 문서 일관성 검사가 무한 루프를 유발하므로 비활성화
    /*
    this.yjsDocManager.doc.on('update', throttle((update, origin) => {
      if (origin !== 'local') {
        this._checkDocumentConsistency();
      }
    }, 5000)); // 5초마다 최대 1회만 실행
    */
  }
  
  /**
   * 충돌 감지
   * @private
   */
  _detectConflict(event, transaction) {
    const elementId = event.path[0];
    const yElement = this.yjsDocManager.getElement(elementId);
    
    if (!yElement) return;
    
    // 충돌 타입 결정
    const conflictType = this._determineConflictType(event, yElement);
    
    if (conflictType) {
      const conflict = {
        id: uuidv4(),
        type: conflictType,
        elementId: elementId,
        event: event,
        transaction: transaction,
        timestamp: Date.now(),
        localState: this._getLocalState(elementId),
        remoteState: yElement.toJSON(),
        severity: this._calculateSeverity(conflictType, event)
      };
      
      this._handleConflict(conflict);
    }
  }
  
  /**
   * 충돌 타입 결정
   * @private
   */
  _determineConflictType(event, yElement) {
    const { action, oldValue, newValue } = event.changes.delta?.[0] || {};
    
    // 동시 위치 변경
    if (event.path.includes('x') || event.path.includes('y')) {
      return 'position';
    }
    
    // 속성 충돌
    if (event.path.includes('businessObject')) {
      return 'property';
    }
    
    // 연결 충돌
    if (event.path.includes('source') || event.path.includes('target')) {
      return 'connection';
    }
    
    // 삭제 충돌
    if (action === 'delete' && this.elementRegistry.get(event.path[0])) {
      return 'deletion';
    }
    
    // 구조적 충돌
    if (event.path.includes('parent') || event.path.includes('children')) {
      return 'structural';
    }
    
    return null;
  }
  
  /**
   * 충돌 처리
   * @private
   */
  async _handleConflict(conflict) {
    // 활성 충돌에 추가
    this.activeConflicts.set(conflict.id, conflict);
    
    // 충돌 이벤트 발생
    this.emit('conflictDetected', conflict);
    
    // 해결 전략 가져오기
    const strategy = this.resolutionStrategies.get(conflict.type);
    
    if (strategy && strategy.autoResolve && this.options.enableAutoResolution) {
      // 자동 해결 시도
      try {
        const resolution = await strategy.resolve(conflict);
        this._applyResolution(conflict, resolution);
      } catch (error) {
        console.error('Auto-resolution failed:', error);
        this._notifyUserIntervention(conflict);
      }
    } else {
      // 사용자 개입 필요
      this._notifyUserIntervention(conflict);
    }
  }
  
  /**
   * 위치 충돌 해결
   * @private
   */
  _resolvePositionConflict(conflict) {
    const { localState, remoteState } = conflict;
    
    // CRDT 의미론에 따라 자동 병합
    // Y.js는 이미 위치를 자동으로 병합하므로 검증만 수행
    const resolution = {
      type: 'automatic',
      action: 'merge',
      result: {
        x: remoteState.x,
        y: remoteState.y
      },
      description: 'Position automatically merged by CRDT'
    };
    
    // 겹침 검사
    if (this._checkOverlap(conflict.elementId, remoteState.x, remoteState.y)) {
      resolution.warnings = ['Elements may overlap after merge'];
    }
    
    return resolution;
  }
  
  /**
   * 속성 충돌 해결
   * @private
   */
  _resolvePropertyConflict(conflict) {
    const { localState, remoteState } = conflict;
    
    // 비즈니스 로직 보존 확인
    if (this.options.preserveBusinessLogic) {
      const criticalProperties = ['processId', 'taskType', 'gateway'];
      const hasCriticalConflict = criticalProperties.some(prop => 
        localState.businessObject?.[prop] !== remoteState.businessObject?.[prop]
      );
      
      if (hasCriticalConflict) {
        throw new Error('Critical business property conflict requires manual resolution');
      }
    }
    
    // Last-writer-wins 적용
    return {
      type: 'automatic',
      action: 'accept-remote',
      result: remoteState.businessObject,
      description: 'Property conflict resolved using last-writer-wins'
    };
  }
  
  /**
   * 연결 충돌 해결
   * @private
   */
  _resolveConnectionConflict(conflict) {
    const { elementId, remoteState } = conflict;
    const connection = this.elementRegistry.get(elementId);
    
    if (!connection) {
      return {
        type: 'automatic',
        action: 'create',
        result: remoteState,
        description: 'Connection created from remote state'
      };
    }
    
    // 엔드포인트 유효성 검사
    const sourceExists = this.elementRegistry.get(remoteState.source);
    const targetExists = this.elementRegistry.get(remoteState.target);
    
    if (!sourceExists || !targetExists) {
      throw new Error('Connection endpoints missing - manual resolution required');
    }
    
    // BPMN 규칙 검증
    const canConnect = this.rules.allowed('connection.create', {
      source: sourceExists,
      target: targetExists,
      type: remoteState.type
    });
    
    if (!canConnect) {
      throw new Error('Invalid connection according to BPMN rules');
    }
    
    return {
      type: 'automatic',
      action: 'update',
      result: {
        source: remoteState.source,
        target: remoteState.target,
        waypoints: remoteState.waypoints
      },
      description: 'Connection updated with validated endpoints'
    };
  }
  
  /**
   * 삭제 충돌 해결
   * @private
   */
  _resolveDeletionConflict(conflict) {
    const { elementId, localState } = conflict;
    const element = this.elementRegistry.get(elementId);
    
    // 요소가 로컬에서 수정되었는지 확인
    const locallyModified = this._isLocallyModified(element, localState);
    
    if (locallyModified) {
      // 사용자 개입 필요
      throw new Error('Element modified locally but deleted remotely');
    }
    
    // 의존성 확인
    const dependencies = this._checkDependencies(elementId);
    
    if (dependencies.length > 0) {
      return {
        type: 'manual',
        action: 'defer',
        dependencies: dependencies,
        description: 'Deletion deferred due to dependencies'
      };
    }
    
    return {
      type: 'automatic',
      action: 'delete',
      result: null,
      description: 'Element deleted as per remote change'
    };
  }
  
  /**
   * 구조적 충돌 해결
   * @private
   */
  _resolveStructuralConflict(conflict) {
    const { elementId, remoteState } = conflict;
    
    // 부모 요소 확인
    const newParent = this.elementRegistry.get(remoteState.parent);
    
    if (!newParent) {
      throw new Error('Parent element not found');
    }
    
    // 순환 참조 검사
    if (this._wouldCreateCycle(elementId, remoteState.parent)) {
      throw new Error('Structural change would create circular reference');
    }
    
    // BPMN 구조 규칙 검증
    const element = this.elementRegistry.get(elementId);
    const canMove = this.rules.allowed('shape.move', {
      shape: element,
      target: newParent
    });
    
    if (!canMove) {
      throw new Error('Invalid structure according to BPMN rules');
    }
    
    return {
      type: 'automatic',
      action: 'restructure',
      result: {
        parent: remoteState.parent,
        children: remoteState.children
      },
      description: 'Structure updated according to remote changes'
    };
  }
  
  /**
   * 해결 적용
   * @private
   */
  _applyResolution(conflict, resolution) {
    try {
      // 해결 기록
      this._recordResolution(conflict, resolution);
      
      // 해결 적용
      switch (resolution.action) {
        case 'merge':
        case 'accept-remote':
          // 원격 상태 수락 (이미 Y.js에 적용됨)
          break;
          
        case 'accept-local':
          // 로컬 상태 유지
          this._revertToLocalState(conflict);
          break;
          
        case 'create':
          // 요소 생성
          this._createElement(conflict.elementId, resolution.result);
          break;
          
        case 'delete':
          // 요소 삭제
          this._deleteElement(conflict.elementId);
          break;
          
        case 'update':
          // 요소 업데이트
          this._updateElement(conflict.elementId, resolution.result);
          break;
          
        case 'restructure':
          // 구조 변경
          this._restructureElement(conflict.elementId, resolution.result);
          break;
          
        case 'defer':
          // 지연 처리
          this._deferResolution(conflict, resolution);
          return;
      }
      
      // 충돌 해결 완료
      this.activeConflicts.delete(conflict.id);
      this.emit('conflictResolved', { conflict, resolution });
      
    } catch (error) {
      console.error('Failed to apply resolution:', error);
      this._notifyUserIntervention(conflict, error.message);
    }
  }
  
  /**
   * 로컬 상태로 되돌리기
   * @private
   */
  _revertToLocalState(conflict) {
    const { elementId, localState } = conflict;
    
    this.yjsDocManager.doc.transact(() => {
      const yElement = this.yjsDocManager.getElement(elementId);
      
      Object.entries(localState).forEach(([key, value]) => {
        yElement.set(key, value);
      });
    }, 'local');
  }
  
  /**
   * 의미적 검증 설정
   * @private
   */
  _setupSemanticValidation() {
    if (!this.options.semanticValidation) return;
    
    // BPMN 규칙 검증 래퍼
    const originalAllowed = this.rules.allowed;
    
    this.rules.allowed = (action, context) => {
      const allowed = originalAllowed.call(this.rules, action, context);
      
      if (allowed && this._isInConflict(context)) {
        // 충돌 중인 요소에 대한 추가 검증
        return this._validateSemantics(action, context);
      }
      
      return allowed;
    };
  }
  
  /**
   * BPMN 의미 검증
   * @private
   */
  _validateSemantics(action, context) {
    switch (action) {
      case 'connection.create':
        return this._validateConnection(context);
        
      case 'shape.move':
        return this._validateMove(context);
        
      case 'shape.delete':
        return this._validateDelete(context);
        
      default:
        return true;
    }
  }
  
  /**
   * 연결 검증
   * @private
   */
  _validateConnection(context) {
    const { source, target, type } = context;
    
    // 게이트웨이 규칙
    if (source.type === 'bpmn:ExclusiveGateway') {
      const outgoing = source.outgoing || [];
      if (outgoing.length >= 2 && type === 'bpmn:SequenceFlow') {
        console.warn('Exclusive gateway should have conditions on outgoing flows');
      }
    }
    
    // 시작/종료 이벤트 규칙
    if (source.type === 'bpmn:EndEvent' || target.type === 'bpmn:StartEvent') {
      return false;
    }
    
    return true;
  }
  
  /**
   * 사용자 개입 알림
   * @private
   */
  _notifyUserIntervention(conflict, message) {
    setTimeout(() => {
      this.emit('userInterventionRequired', {
        conflict,
        message: message || 'Manual conflict resolution required',
        suggestions: this._generateSuggestions(conflict)
      });
    }, this.options.userNotificationDelay);
  }
  
  /**
   * 해결 제안 생성
   * @private
   */
  _generateSuggestions(conflict) {
    const suggestions = [];
    
    switch (conflict.type) {
      case 'deletion':
        suggestions.push({
          action: 'keep-local',
          label: 'Keep local version',
          description: 'Restore the deleted element'
        });
        suggestions.push({
          action: 'accept-deletion',
          label: 'Accept deletion',
          description: 'Remove the element permanently'
        });
        break;
        
      case 'property':
        suggestions.push({
          action: 'merge-manual',
          label: 'Merge manually',
          description: 'Choose properties from both versions'
        });
        suggestions.push({
          action: 'accept-remote',
          label: 'Accept remote changes',
          description: 'Use the incoming version'
        });
        suggestions.push({
          action: 'keep-local',
          label: 'Keep local changes',
          description: 'Reject the incoming changes'
        });
        break;
        
      case 'structural':
        suggestions.push({
          action: 'review-structure',
          label: 'Review structure',
          description: 'Examine the structural changes in detail'
        });
        break;
    }
    
    return suggestions;
  }
  
  /**
   * 수동 충돌 해결
   * @public
   */
  async resolveManually(conflictId, action, parameters = {}) {
    const conflict = this.activeConflicts.get(conflictId);
    
    if (!conflict) {
      throw new Error('Conflict not found');
    }
    
    let resolution;
    
    switch (action) {
      case 'keep-local':
        resolution = {
          type: 'manual',
          action: 'accept-local',
          result: conflict.localState,
          description: 'User chose to keep local version'
        };
        break;
        
      case 'accept-remote':
        resolution = {
          type: 'manual',
          action: 'accept-remote',
          result: conflict.remoteState,
          description: 'User chose to accept remote version'
        };
        break;
        
      case 'merge-manual':
        resolution = {
          type: 'manual',
          action: 'merge',
          result: parameters.mergedState,
          description: 'User manually merged changes'
        };
        break;
        
      case 'accept-deletion':
        resolution = {
          type: 'manual',
          action: 'delete',
          result: null,
          description: 'User accepted deletion'
        };
        break;
        
      default:
        throw new Error('Unknown resolution action');
    }
    
    this._applyResolution(conflict, resolution);
  }
  
  /**
   * 충돌 해결 기록
   * @private
   */
  _recordResolution(conflict, resolution) {
    const record = {
      conflictId: conflict.id,
      elementId: conflict.elementId,
      type: conflict.type,
      resolution: resolution,
      timestamp: Date.now(),
      userId: this.options.userId
    };
    
    this.conflictHistory.push(record);
    
    // 기록 제한 적용
    if (this.conflictHistory.length > this.options.conflictHistoryLimit) {
      this.conflictHistory.shift();
    }
    
    // 서버에 기록 전송 (선택적)
    this.emit('resolutionRecorded', record);
  }
  
  /**
   * 헬퍼 메서드들
   */
  
  _getLocalState(elementId) {
    const element = this.elementRegistry.get(elementId);
    if (!element) return null;
    
    return {
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      businessObject: element.businessObject
    };
  }
  
  _calculateSeverity(conflictType, event) {
    const severityMap = {
      'position': 'low',
      'property': 'medium',
      'connection': 'medium',
      'deletion': 'high',
      'structural': 'high'
    };
    
    return severityMap[conflictType] || 'medium';
  }
  
  _checkOverlap(elementId, x, y) {
    const element = this.elementRegistry.get(elementId);
    if (!element) return false;
    
    const bounds = {
      x: x,
      y: y,
      width: element.width || 100,
      height: element.height || 80
    };
    
    return this.elementRegistry.getAll().some(other => {
      if (other.id === elementId || !other.x) return false;
      
      const otherBounds = {
        x: other.x,
        y: other.y,
        width: other.width || 100,
        height: other.height || 80
      };
      
      return this._boundsIntersect(bounds, otherBounds);
    });
  }
  
  _boundsIntersect(a, b) {
    return !(a.x + a.width < b.x || 
             b.x + b.width < a.x || 
             a.y + a.height < b.y || 
             b.y + b.height < a.y);
  }
  
  _isLocallyModified(element, originalState) {
    if (!element || !originalState) return false;
    
    return element.x !== originalState.x ||
           element.y !== originalState.y ||
           JSON.stringify(element.businessObject) !== JSON.stringify(originalState.businessObject);
  }
  
  _checkDependencies(elementId) {
    const dependencies = [];
    
    this.elementRegistry.getAll().forEach(element => {
      // 연결 의존성
      if (element.source?.id === elementId || element.target?.id === elementId) {
        dependencies.push({
          type: 'connection',
          elementId: element.id,
          dependencyType: element.source?.id === elementId ? 'source' : 'target'
        });
      }
      
      // 부모-자식 의존성
      if (element.parent?.id === elementId) {
        dependencies.push({
          type: 'child',
          elementId: element.id
        });
      }
    });
    
    return dependencies;
  }
  
  _wouldCreateCycle(elementId, newParentId) {
    let current = newParentId;
    
    while (current) {
      if (current === elementId) return true;
      
      const parent = this.elementRegistry.get(current)?.parent;
      current = parent?.id;
    }
    
    return false;
  }
  
  _isInConflict(context) {
    return Array.from(this.activeConflicts.values()).some(conflict => {
      return context.shape?.id === conflict.elementId ||
             context.source?.id === conflict.elementId ||
             context.target?.id === conflict.elementId;
    });
  }
  
  /**
   * 충돌 해결 전략 등록
   * @public
   */
  registerStrategy(type, strategy) {
    this.resolutionStrategies.set(type, strategy);
  }
  
  /**
   * 활성 충돌 가져오기
   * @public
   */
  getActiveConflicts() {
    return Array.from(this.activeConflicts.values());
  }
  
  /**
   * 충돌 기록 가져오기
   * @public
   */
  getConflictHistory() {
    return [...this.conflictHistory];
  }
  
  /**
   * 문서 일관성 검사
   * @private
   */
  _checkDocumentConsistency() {
    try {
      // Y.js 문서의 현재 상태 검사
      const elements = this.yjsDocManager.getElementsMap();
      const elementIds = Array.from(elements.keys());
      
      // BPMN.js 모델과 Y.js 문서 간 일관성 검사
      const bpmnElements = this.elementRegistry.getAll();
      const bpmnElementIds = bpmnElements.map(el => el.id);
      
      // 누락되거나 불일치하는 요소 검사
      const inconsistencies = this._findInconsistencies(elementIds, bpmnElementIds);
      
      if (inconsistencies.length > 0) {
        this._handleInconsistencies(inconsistencies);
      }
      
      // 문서 무결성 검사
      this._validateDocumentIntegrity();
      
    } catch (error) {
      console.error('Document consistency check failed:', error);
      this.emit('consistencyError', { error: error.message });
    }
  }

  /**
   * 불일치 요소 찾기
   * @private
   * @param {Array} yjsElementIds - Y.js 문서의 요소 ID들
   * @param {Array} bpmnElementIds - BPMN.js 모델의 요소 ID들
   * @returns {Array} 불일치 요소들
   */
  _findInconsistencies(yjsElementIds, bpmnElementIds) {
    const inconsistencies = [];
    
    // Y.js에는 있지만 BPMN.js에는 없는 요소들
    const missingInBpmn = yjsElementIds.filter(id => !bpmnElementIds.includes(id));
    missingInBpmn.forEach(id => {
      inconsistencies.push({
        type: 'missing_in_bpmn',
        elementId: id,
        severity: 'high'
      });
    });
    
    // BPMN.js에는 있지만 Y.js에는 없는 요소들
    const missingInYjs = bpmnElementIds.filter(id => !yjsElementIds.includes(id));
    missingInYjs.forEach(id => {
      inconsistencies.push({
        type: 'missing_in_yjs',
        elementId: id,
        severity: 'medium'
      });
    });
    
    return inconsistencies;
  }

  /**
   * 불일치 처리
   * @private
   * @param {Array} inconsistencies - 불일치 항목들
   */
  _handleInconsistencies(inconsistencies) {
    inconsistencies.forEach(inconsistency => {
      const conflictId = `consistency_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const conflict = {
        id: conflictId,
        type: 'consistency',
        subtype: inconsistency.type,
        elementId: inconsistency.elementId,
        severity: inconsistency.severity,
        timestamp: Date.now(),
        description: this._getInconsistencyDescription(inconsistency),
        autoResolvable: inconsistency.severity !== 'high'
      };
      
      this.activeConflicts.set(conflictId, conflict);
      this.emit('conflictDetected', conflict);
      
      // 자동 해결 시도
      if (conflict.autoResolvable && this.options.enableAutoResolution) {
        this._autoResolveInconsistency(conflict);
      }
    });
  }

  /**
   * 불일치 설명 생성
   * @private
   * @param {Object} inconsistency - 불일치 항목
   * @returns {string} 불일치 설명
   */
  _getInconsistencyDescription(inconsistency) {
    switch (inconsistency.type) {
      case 'missing_in_bpmn':
        return `Element ${inconsistency.elementId} exists in Y.js document but not in BPMN model`;
      case 'missing_in_yjs':
        return `Element ${inconsistency.elementId} exists in BPMN model but not in Y.js document`;
      default:
        return `Unknown inconsistency type: ${inconsistency.type}`;
    }
  }

  /**
   * 불일치 자동 해결
   * @private
   * @param {Object} conflict - 충돌 객체
   */
  _autoResolveInconsistency(conflict) {
    try {
      switch (conflict.subtype) {
        case 'missing_in_yjs':
          this._syncElementToYjs(conflict.elementId);
          break;
        case 'missing_in_bpmn':
          this._syncElementToBpmn(conflict.elementId);
          break;
      }
      
      // 해결 완료
      this._resolveConflict(conflict.id, {
        type: 'auto',
        strategy: 'sync',
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('Failed to auto-resolve inconsistency:', error);
      conflict.autoResolvable = false;
    }
  }

  /**
   * 요소를 Y.js로 동기화
   * @private
   * @param {string} elementId - 요소 ID
   */
  _syncElementToYjs(elementId) {
    const element = this.elementRegistry.get(elementId);
    if (!element) return;
    
    // BpmnSyncManager를 통해 동기화 수행
    // 이는 실제 구현에서 BpmnSyncManager 인스턴스에 접근해야 함
    this.emit('syncElementToYjs', { elementId, element });
  }

  /**
   * 요소를 BPMN.js로 동기화
   * @private
   * @param {string} elementId - 요소 ID
   */
  _syncElementToBpmn(elementId) {
    const yElement = this.yjsDocManager.getElement(elementId);
    if (!yElement) return;
    
    // BpmnSyncManager를 통해 동기화 수행
    this.emit('syncElementToBpmn', { elementId, yElement });
  }

  /**
   * 문서 무결성 검증
   * @private
   */
  _validateDocumentIntegrity() {
    try {
      // BPMN XML 유효성 검사
      const modeling = this.modeler.get('modeling');
      const canvas = this.modeler.get('canvas');
      const rootElement = canvas.getRootElement();
      
      if (!rootElement) {
        throw new Error('No root element found in BPMN model');
      }
      
      // 기본 BPMN 구조 검증
      const elements = this.elementRegistry.getAll();
      const processes = elements.filter(el => el.type === 'bpmn:Process');
      
      if (processes.length === 0) {
        console.warn('No BPMN processes found in the model');
      }
      
      // Y.js 문서 상태 검증
      const yjsElements = this.yjsDocManager.getElementsMap();
      if (yjsElements.size === 0) {
        console.warn('No elements found in Y.js document');
      }
      
    } catch (error) {
      console.error('Document integrity validation failed:', error);
      this.emit('integrityError', { error: error.message });
    }
  }

  /**
   * 충돌 해결
   * @private
   * @param {string} conflictId - 충돌 ID
   * @param {Object} resolution - 해결 방법
   */
  _resolveConflict(conflictId, resolution) {
    const conflict = this.activeConflicts.get(conflictId);
    if (!conflict) {
      this.logger.warn(`Conflict ${conflictId} not found`);
      return;
    }
    
    // 충돌 해결 기록
    const resolvedConflict = {
      ...conflict,
      resolved: true,
      resolution: resolution,
      resolvedAt: Date.now()
    };
    
    // 활성 충돌에서 제거
    this.activeConflicts.delete(conflictId);
    
    // 히스토리에 추가
    this.conflictHistory.push(resolvedConflict);
    
    // 히스토리 크기 제한 (최대 100개)
    if (this.conflictHistory.length > 100) {
      this.conflictHistory.shift();
    }
    
    // 해결 이벤트 발생
    this.emit('conflictResolved', { conflict: resolvedConflict, resolution });
    
    this.logger.info(`Conflict ${conflictId} resolved with strategy: ${resolution.strategy}`);
  }

  /**
   * 리소스 정리
   * @public
   */
  destroy() {
    this.activeConflicts.clear();
    this.resolutionStrategies.clear();
    this.conflictHistory = [];
    this.removeAllListeners();
  }
}
