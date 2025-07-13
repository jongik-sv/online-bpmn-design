/**
 * PerformanceOptimizer - 협업 성능 최적화 관리자
 * 
 * 주요 기능:
 * 1. 렌더링 최적화 (배치 DOM 업데이트)
 * 2. 메모리 관리 (가비지 컬렉션)
 * 3. 네트워크 최적화 (업데이트 압축)
 * 4. 성능 메트릭 수집 및 모니터링
 * 5. 적응형 품질 조정
 * 
 * @class PerformanceOptimizer
 */

import EventEmitter from 'eventemitter3';
import { debounce, throttle } from 'lodash';
import { Logger } from '../utils/Logger.js';

export class PerformanceOptimizer extends EventEmitter {
  constructor(modeler, options = {}) {
    super();
    
    // 의존성 주입
    this.modeler = modeler;
    
    // 설정 옵션
    this.options = {
      enableRenderOptimization: true,    // 렌더링 최적화
      enableMemoryManagement: true,      // 메모리 관리
      enableNetworkOptimization: true,   // 네트워크 최적화
      enableAdaptiveQuality: true,       // 적응형 품질
      
      // 임계값 설정
      renderBatchSize: 50,               // 렌더링 배치 크기
      memoryThreshold: 100,               // 100MB 메모리 임계값
      networkLatencyThreshold: 200,      // 200ms 네트워크 지연 임계값
      frameRateTarget: 60,               // 목표 FPS
      
      // 인터벌 설정
      performanceCheckInterval: 10000,   // 성능 체크 간격 (10초)
      memoryCleanupInterval: 60000,      // 메모리 정리 간격 (60초)
      metricCollectionInterval: 5000,    // 메트릭 수집 간격 (5초)
      
      ...options
    };
    
    // 성능 상태
    this.performanceState = {
      renderingMode: 'high',             // 'high', 'medium', 'low'
      memoryUsage: 0,                    // 메모리 사용량 (MB)
      frameRate: 0,                      // 현재 FPS
      networkLatency: 0,                 // 네트워크 지연 시간
      cpuUsage: 0,                       // CPU 사용률
      qualityLevel: 'high'               // 전체 품질 수준
    };
    
    // 렌더링 최적화
    this.renderQueue = [];               // 렌더링 대기열
    this.isRenderingBatch = false;       // 배치 렌더링 중 플래그
    this.lastRenderTime = 0;             // 마지막 렌더링 시간
    
    // 메모리 관리
    this.memorySnapshots = [];           // 메모리 스냅샷
    this.objectPools = new Map();        // 객체 풀
    
    // 성능 메트릭
    this.metrics = {
      renderTime: [],                    // 렌더링 시간 기록
      updateCount: 0,                    // 업데이트 횟수
      batchedUpdates: 0,                 // 배치된 업데이트 수
      memoryReclaimed: 0,                // 회수된 메모리량
      networkOptimizations: 0            // 네트워크 최적화 횟수
    };
    
    // BPMN.js 서비스 참조
    this.canvas = modeler.get('canvas');
    this.elementRegistry = modeler.get('elementRegistry');
    this.eventBus = modeler.get('eventBus');
    
    // 로거 초기화
    this.logger = new Logger('PerformanceOptimizer');
    
    // 초기화
    this._initialize();
  }
  
  /**
   * 성능 최적화기 초기화
   * @private
   */
  _initialize() {
    // 렌더링 최적화 설정
    if (this.options.enableRenderOptimization) {
      this._setupRenderOptimization();
    }
    
    // 메모리 관리 설정
    if (this.options.enableMemoryManagement) {
      this._setupMemoryManagement();
    }
    
    // 네트워크 최적화 설정
    if (this.options.enableNetworkOptimization) {
      this._setupNetworkOptimization();
    }
    
    // 적응형 품질 설정
    if (this.options.enableAdaptiveQuality) {
      this._setupAdaptiveQuality();
    }
    
    // 성능 모니터링 시작
    this._startPerformanceMonitoring();
    
    // PerformanceOptimizer initialized silently
  }
  
  /**
   * 렌더링 최적화 설정
   * @private
   */
  _setupRenderOptimization() {
    // 원본 렌더링 메서드 래핑
    this._wrapCanvasRenderMethods();
    
    // 배치 렌더링 프로세서
    this.processBatchRender = debounce(() => {
      this._processBatchRender();
    }, 16); // ~60 FPS
    
    // 뷰포트 기반 렌더링
    this._setupViewportOptimization();
  }
  
  /**
   * Canvas 렌더링 메서드 래핑
   * @private
   */
  _wrapCanvasRenderMethods() {
    const originalAddMarker = this.canvas.addMarker;
    const originalRemoveMarker = this.canvas.removeMarker;
    const originalUpdateRoot = this.canvas.updateRoot;
    
    // addMarker 래핑
    this.canvas.addMarker = (element, marker) => {
      this._queueRenderOperation('addMarker', { element, marker });
    };
    
    // removeMarker 래핑
    this.canvas.removeMarker = (element, marker) => {
      this._queueRenderOperation('removeMarker', { element, marker });
    };
    
    // updateRoot 래핑
    this.canvas.updateRoot = (element) => {
      this._queueRenderOperation('updateRoot', { element });
    };
    
    // 원본 메서드 저장
    this._originalMethods = {
      addMarker: originalAddMarker,
      removeMarker: originalRemoveMarker,
      updateRoot: originalUpdateRoot
    };
  }
  
  /**
   * 렌더링 작업 큐에 추가
   * @private
   */
  _queueRenderOperation(operation, params) {
    this.renderQueue.push({
      operation,
      params,
      timestamp: performance.now()
    });
    
    this.processBatchRender();
  }
  
  /**
   * 배치 렌더링 처리
   * @private
   */
  _processBatchRender() {
    if (this.isRenderingBatch || this.renderQueue.length === 0) {
      return;
    }
    
    this.isRenderingBatch = true;
    const startTime = performance.now();
    
    // 배치 크기만큼 처리
    const batchSize = Math.min(this.renderQueue.length, this.options.renderBatchSize);
    const batch = this.renderQueue.splice(0, batchSize);
    
    // 작업 타입별로 그룹화
    const groupedOps = this._groupOperations(batch);
    
    // 그룹별로 최적화된 실행
    this._executeBatchOperations(groupedOps);
    
    // 성능 메트릭 업데이트
    const renderTime = performance.now() - startTime;
    this.metrics.renderTime.push(renderTime);
    this.metrics.batchedUpdates += batch.length;
    
    // 메트릭 히스토리 제한
    if (this.metrics.renderTime.length > 100) {
      this.metrics.renderTime.shift();
    }
    
    this.isRenderingBatch = false;
    this.lastRenderTime = performance.now();
    
    // 남은 작업이 있으면 계속 처리
    if (this.renderQueue.length > 0) {
      this.processBatchRender();
    }
  }
  
  /**
   * 작업 그룹화
   * @private
   */
  _groupOperations(batch) {
    const grouped = {
      addMarker: [],
      removeMarker: [],
      updateRoot: []
    };
    
    batch.forEach(op => {
      if (grouped[op.operation]) {
        grouped[op.operation].push(op.params);
      }
    });
    
    return grouped;
  }
  
  /**
   * 배치 작업 실행
   * @private
   */
  _executeBatchOperations(groupedOps) {
    // DOM 업데이트 시작
    const container = this.canvas.getContainer();
    if (container) {
      container.style.willChange = 'transform';
    }
    
    // 각 작업 타입별 처리
    Object.entries(groupedOps).forEach(([operation, paramsList]) => {
      if (paramsList.length === 0) return;
      
      switch (operation) {
        case 'addMarker':
          this._batchAddMarkers(paramsList);
          break;
        case 'removeMarker':
          this._batchRemoveMarkers(paramsList);
          break;
        case 'updateRoot':
          this._batchUpdateRoots(paramsList);
          break;
      }
    });
    
    // DOM 업데이트 완료
    if (container) {
      container.style.willChange = 'auto';
    }
  }
  
  /**
   * 마커 일괄 추가
   * @private
   */
  _batchAddMarkers(paramsList) {
    paramsList.forEach(params => {
      try {
        // params가 배열인지 확인
        if (Array.isArray(params)) {
          this.canvas.addMarker(...params);
        } else {
          // 단일 매개변수인 경우
          this.canvas.addMarker(params);
        }
      } catch (error) {
        this.logger.warn('Failed to add marker:', error);
      }
    });
  }
  
  /**
   * 마커 일괄 제거
   * @private
   */
  _batchRemoveMarkers(paramsList) {
    paramsList.forEach(params => {
      try {
        // params가 배열인지 확인
        if (Array.isArray(params)) {
          this.canvas.removeMarker(...params);
        } else {
          // 단일 매개변수인 경우
          this.canvas.removeMarker(params);
        }
      } catch (error) {
        this.logger.warn('Failed to remove marker:', error);
      }
    });
  }
  
  /**
   * 루트 업데이트 일괄 처리
   * @private
   */
  _batchUpdateRoots(paramsList) {
    paramsList.forEach(params => {
      try {
        // params가 배열인지 확인
        if (Array.isArray(params)) {
          this.canvas.updateRoot(...params);
        } else {
          // 단일 매개변수인 경우
          this.canvas.updateRoot(params);
        }
      } catch (error) {
        this.logger.warn('Failed to update root:', error);
      }
    });
  }

  /**
   * 뷰포트 최적화 설정
   * @private
   */
  _setupViewportOptimization() {
    // 뷰포트 변경 감지 - EventBus 사용
    this.eventBus.on('canvas.viewbox.changed', throttle(() => {
      this._updateViewportOptimization();
    }, 100));
  }
  
  /**
   * 뷰포트 최적화 업데이트
   * @private
   */
  _updateViewportOptimization() {
    const viewbox = this.canvas.viewbox();
    const visibleElements = this._getVisibleElements(viewbox);
    
    // 보이지 않는 요소들의 렌더링 비활성화
    this.elementRegistry.getAll().forEach(element => {
      const gfx = this.elementRegistry.getGraphics(element);
      if (gfx) {
        if (visibleElements.has(element.id)) {
          gfx.style.visibility = 'visible';
        } else {
          gfx.style.visibility = 'hidden';
        }
      }
    });
  }
  
  /**
   * 보이는 요소들 가져오기
   * @private
   */
  _getVisibleElements(viewbox) {
    const visible = new Set();
    
    this.elementRegistry.getAll().forEach(element => {
      if (this._isElementVisible(element, viewbox)) {
        visible.add(element.id);
      }
    });
    
    return visible;
  }
  
  /**
   * 요소 가시성 확인
   * @private
   */
  _isElementVisible(element, viewbox) {
    if (!element.x || !element.y) return true; // 연결선 등
    
    const margin = 50; // 여백
    
    return element.x + element.width >= viewbox.x - margin &&
           element.x <= viewbox.x + viewbox.width + margin &&
           element.y + element.height >= viewbox.y - margin &&
           element.y <= viewbox.y + viewbox.height + margin;
  }
  
  /**
   * 메모리 관리 설정
   * @private
   */
  _setupMemoryManagement() {
    // 정기적인 메모리 정리
    setInterval(() => {
      this._performMemoryCleanup();
    }, this.options.memoryCleanupInterval);
    
    // 객체 풀 초기화
    this._initializeObjectPools();
    
    // 메모리 사용량 모니터링
    this._startMemoryMonitoring();
  }
  
  /**
   * 메모리 정리 수행
   * @private
   */
  _performMemoryCleanup() {
    const beforeCleanup = this._getMemoryUsage();
    
    // 이벤트 리스너 정리
    this._cleanupEventListeners();
    
    // DOM 요소 정리
    this._cleanupDOMElements();
    
    // 객체 풀 정리
    this._cleanupObjectPools();
    
    // 가비지 컬렉션 힌트
    if (window.gc) {
      window.gc();
    }
    
    const afterCleanup = this._getMemoryUsage();
    const reclaimed = beforeCleanup - afterCleanup;
    
    if (reclaimed > 0) {
      this.metrics.memoryReclaimed += reclaimed;
      this.emit('memoryReclaimed', { amount: reclaimed });
    }
  }
  
  /**
   * 메모리 사용량 추정
   * @private
   */
  _getMemoryUsage() {
    if (performance.memory) {
      return performance.memory.usedJSHeapSize / (1024 * 1024); // MB
    }
    
    // 대략적인 추정
    const elementCount = this.elementRegistry.getAll().length;
    return elementCount * 0.001; // 요소당 1KB 추정
  }
  
  /**
   * 네트워크 최적화 설정
   * @private
   */
  _setupNetworkOptimization() {
    // 업데이트 압축
    this._setupUpdateCompression();
    
    // 배치 전송
    this._setupBatchTransmission();
    
    // 우선순위 큐
    this._setupPriorityQueue();
  }
  
  /**
   * 적응형 품질 설정
   * @private
   */
  _setupAdaptiveQuality() {
    // 성능 임계값 모니터링
    setInterval(() => {
      this._adjustQualityLevel();
    }, this.options.performanceCheckInterval);
  }
  
  /**
   * 품질 수준 조정
   * @private
   */
  _adjustQualityLevel() {
    const currentPerf = this._assessCurrentPerformance();
    
    let newQualityLevel = this.performanceState.qualityLevel;
    
    if (currentPerf.score < 0.3) {
      newQualityLevel = 'low';
    } else if (currentPerf.score < 0.7) {
      newQualityLevel = 'medium';
    } else {
      newQualityLevel = 'high';
    }
    
    if (newQualityLevel !== this.performanceState.qualityLevel) {
      this._applyQualityLevel(newQualityLevel);
      this.emit('qualityLevelChanged', {
        previous: this.performanceState.qualityLevel,
        current: newQualityLevel,
        performance: currentPerf
      });
    }
  }
  
  /**
   * 현재 성능 평가
   * @private
   */
  _assessCurrentPerformance() {
    const frameRate = this.performanceState.frameRate;
    const memoryUsage = this.performanceState.memoryUsage;
    const networkLatency = this.performanceState.networkLatency;
    
    // 점수 계산 (0-1)
    const frameScore = Math.min(frameRate / this.options.frameRateTarget, 1);
    const memoryScore = Math.max(0, 1 - (memoryUsage / this.options.memoryThreshold));
    const networkScore = Math.max(0, 1 - (networkLatency / this.options.networkLatencyThreshold));
    
    const score = (frameScore + memoryScore + networkScore) / 3;
    
    return {
      score,
      frameRate,
      memoryUsage,
      networkLatency
    };
  }
  
  /**
   * 품질 수준 적용
   * @private
   */
  _applyQualityLevel(level) {
    this.performanceState.qualityLevel = level;
    
    switch (level) {
      case 'low':
        this.options.renderBatchSize = 20;
        this.performanceState.renderingMode = 'low';
        // 애니메이션 비활성화
        this._disableAnimations();
        break;
        
      case 'medium':
        this.options.renderBatchSize = 35;
        this.performanceState.renderingMode = 'medium';
        // 일부 효과 비활성화
        this._reducedEffects();
        break;
        
      case 'high':
        this.options.renderBatchSize = 50;
        this.performanceState.renderingMode = 'high';
        // 모든 효과 활성화
        this._enableAllEffects();
        break;
    }
  }
  
  /**
   * 성능 모니터링 시작
   * @private
   */
  _startPerformanceMonitoring() {
    let frameCount = 0;
    let lastFrameTime = performance.now();
    
    const measureFrame = () => {
      frameCount++;
      const now = performance.now();
      
      // 1초마다 FPS 계산
      if (now - lastFrameTime >= 1000) {
        this.performanceState.frameRate = frameCount;
        frameCount = 0;
        lastFrameTime = now;
        
        // 메모리 사용량 업데이트
        this.performanceState.memoryUsage = this._getMemoryUsage();
        
        // 메트릭 업데이트
        this.emit('performanceUpdate', { ...this.performanceState });
      }
      
      requestAnimationFrame(measureFrame);
    };
    
    requestAnimationFrame(measureFrame);
  }
  
  /**
   * 애니메이션 비활성화
   * @private
   */
  _disableAnimations() {
    const style = document.createElement('style');
    style.id = 'performance-optimization-low';
    style.textContent = `
      .djs-element * {
        transition: none !important;
        animation: none !important;
      }
    `;
    document.head.appendChild(style);
  }
  
  /**
   * 모든 효과 활성화
   * @private
   */
  _enableAllEffects() {
    const style = document.getElementById('performance-optimization-low');
    if (style) {
      style.remove();
    }
  }
  
  /**
   * 네트워크 지연 시간 업데이트
   * @public
   */
  updateNetworkLatency(latency) {
    this.performanceState.networkLatency = latency;
  }
  
  /**
   * 성능 메트릭 가져오기
   * @public
   */
  getMetrics() {
    return {
      ...this.metrics,
      performanceState: { ...this.performanceState },
      averageRenderTime: this.metrics.renderTime.length > 0 
        ? this.metrics.renderTime.reduce((a, b) => a + b, 0) / this.metrics.renderTime.length
        : 0
    };
  }
  
  /**
   * 성능 최적화 수동 트리거
   * @public
   */
  optimize() {
    this._performMemoryCleanup();
    this._adjustQualityLevel();
    this.emit('optimizationTriggered');
  }
  
  /**
   * 일부 효과 비활성화 (medium 품질)
   * @private
   */
  _reducedEffects() {
    // 그림자 효과 비활성화
    const container = this.canvas.getContainer();
    if (container) {
      container.style.filter = 'none';
      
      // 투명도 애니메이션 비활성화
      const elements = container.querySelectorAll('.djs-element');
      elements.forEach(el => {
        el.style.transition = 'none';
      });
    }
    
    this.logger.debug('Reduced effects applied for medium performance mode');
  }
  
  /**
   * 모든 효과 활성화 (high 품질)
   * @private
   */
  _enableAllEffects() {
    // 모든 시각 효과 활성화
    const container = this.canvas.getContainer();
    if (container) {
      container.style.filter = '';
      
      const elements = container.querySelectorAll('.djs-element');
      elements.forEach(el => {
        el.style.transition = '';
      });
    }
    
    this.logger.debug('All effects enabled for high performance mode');
  }
  
  /**
   * 애니메이션 비활성화 (low 품질)
   * @private
   */
  _disableAnimations() {
    // CSS 애니메이션 비활성화
    const style = document.createElement('style');
    style.textContent = `
      .djs-element * {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
      }
    `;
    document.head.appendChild(style);
    
    this.logger.debug('Animations disabled for low performance mode');
  }

  /**
   * 리소스 정리
   * @public
   */
  destroy() {
    // 인터벌 정리
    if (this.performanceCheckInterval) {
      clearInterval(this.performanceCheckInterval);
    }
    if (this.memoryCleanupInterval) {
      clearInterval(this.memoryCleanupInterval);
    }
    
    // 원본 메서드 복원
    if (this._originalMethods) {
      Object.assign(this.canvas, this._originalMethods);
    }
    
    // 이벤트 리스너 정리
    this.removeAllListeners();
    
    console.log('PerformanceOptimizer destroyed');
  }

  /**
   * 객체 풀 초기화
   * @private
   */
  _initializeObjectPools() {
    // 재사용 가능한 객체 풀 생성
    this.objectPools = {
      points: [],
      bounds: [],
      connections: [],
      events: []
    };
    
    // 풀 크기 제한
    this.poolLimits = {
      points: 100,
      bounds: 50,
      connections: 30,
      events: 20
    };
    
    this.logger.debug('Object pools initialized');
  }

  /**
   * 메모리 모니터링 시작
   * @private
   */
  _startMemoryMonitoring() {
    if (!this.options.enableMemoryManagement) return;
    
    this.memoryMonitoringInterval = setInterval(() => {
      const usage = this._getMemoryUsage();
      this.metrics.memoryUsage = usage;
      
      // 메모리 사용량이 임계값을 초과하면 정리
      if (usage > this.options.memoryThreshold) {
        this._performMemoryCleanup();
      }
    }, 30000); // 30초마다 체크
    
    this.logger.debug('Memory monitoring started');
  }

  /**
   * 메모리 사용량 조회
   * @private
   * @returns {number} 메모리 사용량 (MB)
   */
  _getMemoryUsage() {
    if (performance.memory) {
      return Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
    }
    return 0;
  }

  /**
   * 이벤트 리스너 정리
   * @private
   */
  _cleanupEventListeners() {
    // EventBus 리스너 정리
    if (this.eventBus) {
      this.eventBus.off('canvas.viewbox.changed');
      this.eventBus.off('commandStack.execute');
      this.eventBus.off('elements.changed');
    }
    
    this.logger.debug('Event listeners cleaned up');
  }

  /**
   * DOM 요소 정리
   * @private
   */
  _cleanupDOMElements() {
    // 캐시된 DOM 참조 정리
    const container = this.canvas.getContainer();
    if (container) {
      // 스타일 속성 초기화
      container.style.willChange = '';
      container.style.filter = '';
      
      // 요소별 스타일 초기화
      const elements = container.querySelectorAll('.djs-element');
      elements.forEach(el => {
        el.style.transition = '';
        el.style.opacity = '';
      });
    }
    
    this.logger.debug('DOM elements cleaned up');
  }

  /**
   * 객체 풀 정리
   * @private
   */
  _cleanupObjectPools() {
    if (this.objectPools) {
      // 각 풀의 객체들을 정리
      Object.keys(this.objectPools).forEach(poolName => {
        this.objectPools[poolName].length = 0;
      });
      
      this.objectPools = null;
    }
    
    this.logger.debug('Object pools cleaned up');
  }

  /**
   * 네트워크 최적화 설정
   * @private
   */
  _setupNetworkOptimization() {
    // 업데이트 압축
    this._setupUpdateCompression();
    
    // 배치 전송
    this._setupBatchTransmission();
    
    // 우선순위 큐
    this._setupPriorityQueue();
    
    this.logger.debug('Network optimization setup completed');
  }

  /**
   * 업데이트 압축 설정
   * @private
   */
  _setupUpdateCompression() {
    // 압축 설정 초기화
    this.compressionOptions = {
      enabled: true,
      threshold: 1024,      // 1KB 이상일 때 압축
      algorithm: 'gzip'     // 압축 알고리즘
    };
    
    // 압축 통계
    this.compressionStats = {
      originalSize: 0,
      compressedSize: 0,
      compressionRatio: 0
    };
    
    this.logger.debug('Update compression setup completed');
  }

  /**
   * 배치 전송 설정
   * @private
   */
  _setupBatchTransmission() {
    // 배치 전송 설정
    this.batchConfig = {
      maxBatchSize: 10,     // 최대 배치 크기
      batchTimeout: 100,    // 배치 타임아웃 (ms)
      priorityLevels: 3     // 우선순위 레벨 수
    };
    
    // 전송 큐
    this.transmissionQueue = [];
    this.pendingBatches = new Map();
    
    // 배치 전송 타이머
    this.batchTimer = null;
    
    this.logger.debug('Batch transmission setup completed');
  }

  /**
   * 우선순위 큐 설정
   * @private
   */
  _setupPriorityQueue() {
    // 우선순위 큐 초기화
    this.priorityQueues = {
      high: [],     // 높은 우선순위 (실시간 업데이트)
      medium: [],   // 중간 우선순위 (일반 업데이트)
      low: []       // 낮은 우선순위 (배경 업데이트)
    };
    
    // 우선순위 가중치
    this.priorityWeights = {
      high: 3,
      medium: 2,
      low: 1
    };
    
    this.logger.debug('Priority queue setup completed');
  }

  /**
   * 적응형 품질 설정
   * @private
   */
  _setupAdaptiveQuality() {
    // 품질 레벨 정의
    this.qualityLevels = {
      high: {
        renderQuality: 'high',
        effectsEnabled: true,
        antiAliasing: true,
        shadowsEnabled: true
      },
      medium: {
        renderQuality: 'medium',
        effectsEnabled: true,
        antiAliasing: false,
        shadowsEnabled: false
      },
      low: {
        renderQuality: 'low',
        effectsEnabled: false,
        antiAliasing: false,
        shadowsEnabled: false
      }
    };
    
    // 성능 임계값
    this.performanceThresholds = {
      frameRate: {
        high: 50,    // 50 FPS 이상
        medium: 30,  // 30-50 FPS
        low: 15      // 15-30 FPS
      },
      memory: {
        high: 50,    // 50MB 미만
        medium: 100, // 50-100MB
        low: 150     // 100-150MB
      }
    };
    
    // 적응형 품질 모니터링 시작
    this._startAdaptiveQualityMonitoring();
    
    this.logger.debug('Adaptive quality setup completed');
  }

  /**
   * 적응형 품질 모니터링 시작
   * @private
   */
  _startAdaptiveQualityMonitoring() {
    this.qualityMonitoringInterval = setInterval(() => {
      this._evaluatePerformance();
      this._adjustQualityLevel();
    }, this.options.performanceCheckInterval);
    
    this.logger.debug('Adaptive quality monitoring started');
  }

  /**
   * 성능 평가
   * @private
   */
  _evaluatePerformance() {
    // 현재 성능 메트릭 수집
    const currentMetrics = {
      frameRate: this._calculateFrameRate(),
      memoryUsage: this._getMemoryUsage(),
      renderTime: this._getAverageRenderTime()
    };
    
    // 성능 상태 업데이트
    Object.assign(this.performanceState, currentMetrics);
    
    // 성능 이벤트 발생
    this.emit('performanceEvaluated', currentMetrics);
  }

  /**
   * 품질 레벨 조정
   * @private
   */
  _adjustQualityLevel() {
    const { frameRate, memoryUsage } = this.performanceState;
    let newQualityLevel = 'high';
    
    // 프레임 레이트 기반 품질 조정
    if (frameRate < this.performanceThresholds.frameRate.low) {
      newQualityLevel = 'low';
    } else if (frameRate < this.performanceThresholds.frameRate.medium) {
      newQualityLevel = 'medium';
    }
    
    // 메모리 사용량 기반 품질 조정
    if (memoryUsage > this.performanceThresholds.memory.low) {
      newQualityLevel = 'low';
    } else if (memoryUsage > this.performanceThresholds.memory.medium) {
      if (newQualityLevel === 'high') {
        newQualityLevel = 'medium';
      }
    }
    
    // 품질 레벨 변경
    if (newQualityLevel !== this.performanceState.qualityLevel) {
      this._setQualityLevel(newQualityLevel);
    }
  }

  /**
   * 프레임 레이트 계산
   * @private
   * @returns {number} 현재 FPS
   */
  _calculateFrameRate() {
    if (this.metrics.renderTime.length < 2) {
      return 60; // 기본값
    }
    
    const recentRenderTimes = this.metrics.renderTime.slice(-10);
    const averageRenderTime = recentRenderTimes.reduce((a, b) => a + b, 0) / recentRenderTimes.length;
    
    return Math.round(1000 / averageRenderTime);
  }

  /**
   * 평균 렌더링 시간 계산
   * @private
   * @returns {number} 평균 렌더링 시간 (ms)
   */
  _getAverageRenderTime() {
    if (this.metrics.renderTime.length === 0) {
      return 16; // 60 FPS 기준 기본값
    }
    
    const recentTimes = this.metrics.renderTime.slice(-50);
    return recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length;
  }

  /**
   * 품질 레벨 설정
   * @private
   * @param {string} level - 품질 레벨 ('high', 'medium', 'low')
   */
  _setQualityLevel(level) {
    const previousLevel = this.performanceState.qualityLevel;
    this.performanceState.qualityLevel = level;
    
    // 품질에 따른 최적화 적용
    switch (level) {
      case 'high':
        this._enableAllEffects();
        break;
      case 'medium':
        this._reducedEffects();
        break;
      case 'low':
        this._minimalEffects();
        break;
    }
    
    this.logger.info(`Quality level changed from ${previousLevel} to ${level}`);
    this.emit('qualityLevelChanged', { current: level, previous: previousLevel });
  }

  /**
   * 최소 효과 모드 (low 품질)
   * @private
   */
  _minimalEffects() {
    const container = this.canvas.getContainer();
    if (container) {
      // 모든 시각 효과 비활성화
      container.style.filter = 'none';
      container.style.transform = 'none';
      
      // 요소별 최소 스타일
      const elements = container.querySelectorAll('.djs-element');
      elements.forEach(el => {
        el.style.transition = 'none';
        el.style.opacity = '1';
        el.style.filter = 'none';
      });
    }
    
    this.logger.debug('Minimal effects applied for low performance mode');
  }
}