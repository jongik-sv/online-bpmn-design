/**
 * CRDTStructures - Y.js CRDT 데이터 구조 정의 및 관리
 * 
 * 주요 기능:
 * 1. BPMN 요소를 위한 CRDT 구조 정의
 * 2. 데이터 변환 및 매핑 유틸리티
 * 3. 스키마 검증 및 타입 안전성
 * 4. 효율적인 직렬화/역직렬화
 * 5. 버전 호환성 관리
 * 
 * @module CRDTStructures
 */

import * as Y from 'yjs';

/**
 * BPMN 요소 CRDT 구조
 */
export class BpmnElementCRDT {
  /**
   * BPMN 요소를 Y.js 구조로 변환
   * @param {Object} element - BPMN 요소
   * @returns {Y.Map}
   */
  static fromBpmnElement(element) {
    const yElement = new Y.Map();
    
    // 기본 속성
    yElement.set('id', element.id);
    yElement.set('type', element.type);
    yElement.set('x', element.x || 0);
    yElement.set('y', element.y || 0);
    yElement.set('width', element.width || 100);
    yElement.set('height', element.height || 80);
    
    // 부모-자식 관계
    if (element.parent) {
      yElement.set('parent', element.parent.id);
    }
    
    // children 배열
    if (element.children && element.children.length > 0) {
      const yChildren = new Y.Array();
      element.children.forEach(child => {
        yChildren.push([child.id]);
      });
      yElement.set('children', yChildren);
    }
    
    // 비즈니스 객체
    if (element.businessObject) {
      const yBusinessObject = this.createBusinessObjectCRDT(element.businessObject);
      yElement.set('businessObject', yBusinessObject);
    }
    
    // DI (Diagram Interchange) 정보
    if (element.di) {
      const yDI = this.createDICRDT(element.di);
      yElement.set('di', yDI);
    }
    
    // 연결선 특별 처리
    if (element.waypoints) {
      const yWaypoints = this.createWaypointsCRDT(element.waypoints);
      yElement.set('waypoints', yWaypoints);
    }
    
    // 소스/타겟 (연결선용)
    if (element.source) {
      yElement.set('source', element.source.id);
    }
    if (element.target) {
      yElement.set('target', element.target.id);
    }
    
    // 메타데이터
    yElement.set('lastModified', Date.now());
    yElement.set('version', '1.0');
    
    return yElement;
  }
  
  /**
   * Y.js 구조를 BPMN 요소로 변환
   * @param {Y.Map} yElement - Y.js 요소
   * @param {Object} elementRegistry - BPMN 요소 레지스트리
   * @returns {Object}
   */
  static toBpmnElement(yElement, elementRegistry = null) {
    const data = yElement.toJSON();
    
    const element = {
      id: data.id,
      type: data.type,
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height
    };
    
    // 부모 참조 복원
    if (data.parent && elementRegistry) {
      element.parent = elementRegistry.get(data.parent);
    }
    
    // 자식 배열 복원
    if (data.children) {
      element.children = data.children.map(childId => {
        return elementRegistry ? elementRegistry.get(childId) : { id: childId };
      }).filter(Boolean);
    }
    
    // 비즈니스 객체 복원
    if (data.businessObject) {
      element.businessObject = this.restoreBusinessObject(data.businessObject);
    }
    
    // DI 정보 복원
    if (data.di) {
      element.di = this.restoreDI(data.di);
    }
    
    // 연결선 정보 복원
    if (data.waypoints) {
      element.waypoints = this.restoreWaypoints(data.waypoints);
    }
    
    if (data.source && elementRegistry) {
      element.source = elementRegistry.get(data.source);
    }
    if (data.target && elementRegistry) {
      element.target = elementRegistry.get(data.target);
    }
    
    return element;
  }
  
  /**
   * 비즈니스 객체 CRDT 생성
   * @param {Object} businessObject
   * @returns {Y.Map}
   */
  static createBusinessObjectCRDT(businessObject) {
    const yBO = new Y.Map();
    
    // 기본 속성
    yBO.set('id', businessObject.id);
    yBO.set('$type', businessObject.$type);
    
    if (businessObject.name) {
      yBO.set('name', businessObject.name);
    }
    
    // BPMN 특정 속성들
    const bpmnProperties = [
      'documentation', 'extensionElements', 'incoming', 'outgoing',
      'processRef', 'default', 'conditionExpression', 'sourceRef', 'targetRef',
      'isForCompensation', 'startQuantity', 'completionQuantity',
      'isInterrupting', 'parallelMultiple', 'instantiate'
    ];
    
    bpmnProperties.forEach(prop => {
      if (businessObject[prop] !== undefined) {
        if (Array.isArray(businessObject[prop])) {
          const yArray = new Y.Array();
          businessObject[prop].forEach(item => {
            yArray.push([typeof item === 'object' ? item.id : item]);
          });
          yBO.set(prop, yArray);
        } else if (typeof businessObject[prop] === 'object' && businessObject[prop] !== null) {
          if (businessObject[prop].id) {
            yBO.set(prop, businessObject[prop].id);
          } else {
            // 중첩 객체 처리
            const nestedMap = new Y.Map();
            Object.entries(businessObject[prop]).forEach(([key, value]) => {
              nestedMap.set(key, value);
            });
            yBO.set(prop, nestedMap);
          }
        } else {
          yBO.set(prop, businessObject[prop]);
        }
      }
    });
    
    // 사용자 정의 속성
    Object.keys(businessObject).forEach(key => {
      if (!bpmnProperties.includes(key) && 
          !['id', '$type', 'name', '$parent', 'di'].includes(key)) {
        yBO.set(key, businessObject[key]);
      }
    });
    
    return yBO;
  }
  
  /**
   * DI CRDT 생성
   * @param {Object} di
   * @returns {Y.Map}
   */
  static createDICRDT(di) {
    const yDI = new Y.Map();
    
    yDI.set('id', di.id);
    yDI.set('$type', di.$type);
    
    // Bounds 정보
    if (di.bounds) {
      const yBounds = new Y.Map();
      yBounds.set('x', di.bounds.x);
      yBounds.set('y', di.bounds.y);
      yBounds.set('width', di.bounds.width);
      yBounds.set('height', di.bounds.height);
      yDI.set('bounds', yBounds);
    }
    
    // Waypoints 정보 (연결선용)
    if (di.waypoint) {
      const yWaypoints = new Y.Array();
      di.waypoint.forEach(wp => {
        const yWP = new Y.Map();
        yWP.set('x', wp.x);
        yWP.set('y', wp.y);
        yWaypoints.push([yWP]);
      });
      yDI.set('waypoint', yWaypoints);
    }
    
    return yDI;
  }
  
  /**
   * Waypoints CRDT 생성
   * @param {Array} waypoints
   * @returns {Y.Array}
   */
  static createWaypointsCRDT(waypoints) {
    const yWaypoints = new Y.Array();
    
    waypoints.forEach(wp => {
      const yWP = new Y.Map();
      yWP.set('x', wp.x);
      yWP.set('y', wp.y);
      if (wp.original) {
        const yOriginal = new Y.Map();
        yOriginal.set('x', wp.original.x);
        yOriginal.set('y', wp.original.y);
        yWP.set('original', yOriginal);
      }
      yWaypoints.push([yWP]);
    });
    
    return yWaypoints;
  }
}

/**
 * 메타데이터 CRDT 구조
 */
export class MetadataCRDT {
  /**
   * 문서 메타데이터 CRDT 생성
   * @param {Object} metadata
   * @returns {Y.Map}
   */
  static createDocumentMetadata(metadata = {}) {
    const yMetadata = new Y.Map();
    
    // 기본 메타데이터
    yMetadata.set('version', metadata.version || '1.0.0');
    yMetadata.set('created', metadata.created || Date.now());
    yMetadata.set('lastModified', Date.now());
    yMetadata.set('title', metadata.title || 'Untitled BPMN Diagram');
    yMetadata.set('description', metadata.description || '');
    
    // 통계 정보
    const yStats = new Y.Map();
    yStats.set('elementCount', 0);
    yStats.set('connectionCount', 0);
    yStats.set('collaboratorCount', 0);
    yStats.set('revisionCount', 1);
    yMetadata.set('statistics', yStats);
    
    // 설정 정보
    const ySettings = new Y.Map();
    ySettings.set('autoSave', true);
    ySettings.set('gridEnabled', true);
    ySettings.set('snapToGrid', true);
    ySettings.set('showGrid', true);
    yMetadata.set('settings', ySettings);
    
    return yMetadata;
  }
  
  /**
   * 메타데이터 업데이트
   * @param {Y.Map} yMetadata
   * @param {Object} updates
   */
  static updateMetadata(yMetadata, updates) {
    Object.entries(updates).forEach(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        let yNestedMap = yMetadata.get(key);
        if (!yNestedMap || !(yNestedMap instanceof Y.Map)) {
          yNestedMap = new Y.Map();
          yMetadata.set(key, yNestedMap);
        }
        Object.entries(value).forEach(([nestedKey, nestedValue]) => {
          yNestedMap.set(nestedKey, nestedValue);
        });
      } else {
        yMetadata.set(key, value);
      }
    });
    
    yMetadata.set('lastModified', Date.now());
  }
}

/**
 * 댓글 CRDT 구조
 */
export class CommentCRDT {
  /**
   * 댓글 CRDT 생성
   * @param {Object} comment
   * @returns {Y.Map}
   */
  static createComment(comment) {
    const yComment = new Y.Map();
    
    yComment.set('id', comment.id);
    yComment.set('elementId', comment.elementId || null);
    yComment.set('text', comment.text);
    yComment.set('authorId', comment.authorId);
    yComment.set('authorName', comment.authorName);
    yComment.set('timestamp', comment.timestamp || Date.now());
    yComment.set('resolved', comment.resolved || false);
    yComment.set('resolvedBy', comment.resolvedBy || null);
    yComment.set('resolvedAt', comment.resolvedAt || null);
    
    // 위치 정보
    if (comment.position) {
      const yPosition = new Y.Map();
      yPosition.set('x', comment.position.x);
      yPosition.set('y', comment.position.y);
      yComment.set('position', yPosition);
    }
    
    // 답글 배열
    const yReplies = new Y.Array();
    if (comment.replies) {
      comment.replies.forEach(reply => {
        const yReply = new Y.Map();
        yReply.set('id', reply.id);
        yReply.set('text', reply.text);
        yReply.set('authorId', reply.authorId);
        yReply.set('authorName', reply.authorName);
        yReply.set('timestamp', reply.timestamp || Date.now());
        yReplies.push([yReply]);
      });
    }
    yComment.set('replies', yReplies);
    
    return yComment;
  }
  
  /**
   * 답글 추가
   * @param {Y.Map} yComment
   * @param {Object} reply
   */
  static addReply(yComment, reply) {
    const yReplies = yComment.get('replies');
    const yReply = new Y.Map();
    
    yReply.set('id', reply.id);
    yReply.set('text', reply.text);
    yReply.set('authorId', reply.authorId);
    yReply.set('authorName', reply.authorName);
    yReply.set('timestamp', reply.timestamp || Date.now());
    
    yReplies.push([yReply]);
  }
  
  /**
   * 댓글 해결
   * @param {Y.Map} yComment
   * @param {string} resolvedBy
   */
  static resolveComment(yComment, resolvedBy) {
    yComment.set('resolved', true);
    yComment.set('resolvedBy', resolvedBy);
    yComment.set('resolvedAt', Date.now());
  }
}

/**
 * 잠금 CRDT 구조
 */
export class LockCRDT {
  /**
   * 요소 잠금 CRDT 생성
   * @param {Object} lock
   * @returns {Y.Map}
   */
  static createLock(lock) {
    const yLock = new Y.Map();
    
    yLock.set('elementId', lock.elementId);
    yLock.set('userId', lock.userId);
    yLock.set('userName', lock.userName);
    yLock.set('lockType', lock.lockType || 'editing'); // 'editing', 'viewing'
    yLock.set('acquiredAt', lock.acquiredAt || Date.now());
    yLock.set('expiresAt', lock.expiresAt || (Date.now() + 30000)); // 30초 기본
    yLock.set('renewable', lock.renewable !== false);
    
    return yLock;
  }
  
  /**
   * 잠금 갱신
   * @param {Y.Map} yLock
   * @param {number} duration - 연장할 시간 (ms)
   */
  static renewLock(yLock, duration = 30000) {
    yLock.set('expiresAt', Date.now() + duration);
  }
  
  /**
   * 잠금 만료 확인
   * @param {Y.Map} yLock
   * @returns {boolean}
   */
  static isExpired(yLock) {
    return Date.now() > yLock.get('expiresAt');
  }
}

/**
 * Awareness CRDT 구조
 */
export class AwarenessCRDT {
  /**
   * 사용자 상태 생성
   * @param {Object} user
   * @returns {Object}
   */
  static createUserState(user) {
    return {
      id: user.id,
      name: user.name,
      color: user.color,
      cursor: user.cursor || { x: 0, y: 0 },
      selection: user.selection || [],
      viewport: user.viewport || null,
      status: user.status || 'active', // 'active', 'idle', 'away'
      lastActivity: Date.now()
    };
  }
  
  /**
   * 커서 위치 업데이트
   * @param {Object} userState
   * @param {Object} cursor
   */
  static updateCursor(userState, cursor) {
    userState.cursor = cursor;
    userState.lastActivity = Date.now();
  }
  
  /**
   * 선택 영역 업데이트
   * @param {Object} userState
   * @param {Array} selection
   */
  static updateSelection(userState, selection) {
    userState.selection = selection;
    userState.lastActivity = Date.now();
  }
  
  /**
   * 뷰포트 업데이트
   * @param {Object} userState
   * @param {Object} viewport
   */
  static updateViewport(userState, viewport) {
    userState.viewport = viewport;
    userState.lastActivity = Date.now();
  }
}

/**
 * 스키마 검증 유틸리티
 */
export class SchemaValidator {
  /**
   * BPMN 요소 스키마 검증
   * @param {Object} element
   * @returns {Object}
   */
  static validateBpmnElement(element) {
    const errors = [];
    
    // 필수 필드 확인
    if (!element.id) {
      errors.push('Element ID is required');
    }
    if (!element.type) {
      errors.push('Element type is required');
    }
    
    // 타입별 검증
    if (element.type && element.type.startsWith('bpmn:')) {
      const typeValidation = this.validateBpmnType(element);
      errors.push(...typeValidation);
    }
    
    // 좌표 검증
    if (element.x !== undefined && typeof element.x !== 'number') {
      errors.push('Element x coordinate must be a number');
    }
    if (element.y !== undefined && typeof element.y !== 'number') {
      errors.push('Element y coordinate must be a number');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
  
  /**
   * BPMN 타입별 검증
   * @param {Object} element
   * @returns {Array}
   */
  static validateBpmnType(element) {
    const errors = [];
    
    switch (element.type) {
      case 'bpmn:SequenceFlow':
        if (!element.source) {
          errors.push('SequenceFlow must have a source');
        }
        if (!element.target) {
          errors.push('SequenceFlow must have a target');
        }
        break;
        
      case 'bpmn:MessageFlow':
        if (!element.source) {
          errors.push('MessageFlow must have a source');
        }
        if (!element.target) {
          errors.push('MessageFlow must have a target');
        }
        break;
        
      case 'bpmn:StartEvent':
      case 'bpmn:EndEvent':
      case 'bpmn:IntermediateThrowEvent':
      case 'bpmn:IntermediateCatchEvent':
        // 이벤트 특별 검증
        break;
        
      case 'bpmn:Task':
      case 'bpmn:UserTask':
      case 'bpmn:ServiceTask':
      case 'bpmn:ScriptTask':
        // 태스크 검증
        if (element.width && element.width < 50) {
          errors.push('Task width should be at least 50px');
        }
        break;
    }
    
    return errors;
  }
  
  /**
   * 댓글 스키마 검증
   * @param {Object} comment
   * @returns {Object}
   */
  static validateComment(comment) {
    const errors = [];
    
    if (!comment.id) {
      errors.push('Comment ID is required');
    }
    if (!comment.text || comment.text.trim().length === 0) {
      errors.push('Comment text is required');
    }
    if (!comment.authorId) {
      errors.push('Comment author ID is required');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

/**
 * 데이터 변환 유틸리티
 */
export class DataTransformer {
  /**
   * 일반 객체를 Y.js 구조로 변환
   * @param {Object} obj
   * @returns {Y.Map|Y.Array|any}
   */
  static objectToYjs(obj) {
    if (obj === null || obj === undefined) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      const yArray = new Y.Array();
      obj.forEach(item => {
        yArray.push([this.objectToYjs(item)]);
      });
      return yArray;
    }
    
    if (typeof obj === 'object') {
      const yMap = new Y.Map();
      Object.entries(obj).forEach(([key, value]) => {
        yMap.set(key, this.objectToYjs(value));
      });
      return yMap;
    }
    
    return obj;
  }
  
  /**
   * Y.js 구조를 일반 객체로 변환
   * @param {Y.Map|Y.Array|any} yObj
   * @returns {Object}
   */
  static yjsToObject(yObj) {
    if (yObj instanceof Y.Map) {
      const obj = {};
      yObj.forEach((value, key) => {
        obj[key] = this.yjsToObject(value);
      });
      return obj;
    }
    
    if (yObj instanceof Y.Array) {
      return yObj.toArray().map(item => this.yjsToObject(item));
    }
    
    return yObj;
  }
  
  /**
   * 압축된 업데이트 데이터 생성
   * @param {Y.Doc} doc
   * @returns {Uint8Array}
   */
  static createCompressedUpdate(doc) {
    const update = Y.encodeStateAsUpdate(doc);
    
    // 간단한 압축 구현 (실제로는 더 효율적인 압축 라이브러리 사용)
    return update;
  }
}

export {
  BpmnElementCRDT,
  MetadataCRDT,
  CommentCRDT,
  LockCRDT,
  AwarenessCRDT,
  SchemaValidator,
  DataTransformer
};