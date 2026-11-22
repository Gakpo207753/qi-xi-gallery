import { CONFIG, INTERFACE_VERSION } from './config.js';
import { CameraSession } from './camera-session.js';
import { FiringMachine } from './firing-machine.js';
import { GestureEngine } from './gesture-engine.js';
import { bindManualControls } from './manual-controls.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function defaultClock() {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

function readCapabilities() {
  const mediaDevices = Boolean(
    globalThis.navigator?.mediaDevices?.getUserMedia,
  );
  const requestVideoFrameCallback = typeof globalThis.HTMLVideoElement !== 'undefined'
    && typeof globalThis.HTMLVideoElement.prototype?.requestVideoFrameCallback === 'function';
  return Object.freeze({
    secureContext: globalThis.isSecureContext === true,
    mediaDevices,
    requestVideoFrameCallback,
  });
}

/**
 * Headless interaction system. It owns the only progress state.
 *
 * It does not create a renderer, scene, camera, DOM node, camera stream or
 * render loop. Visual integration reads getProgress()/consumeRotation() and
 * subscribes to coarse state changes.
 */
export class InteractionSystem {
  constructor({
    workId,
    initialProgress = CONFIG.progress.initialProgress,
    autoTick = true,
    clock = defaultClock,
    cameraAssetBaseUrl = undefined,
    cameraSessionFactory = null,
  } = {}) {
    if (typeof workId !== 'string' || workId.trim() === '') {
      throw new TypeError('createInteractionSystem requires a non-empty workId');
    }

    this._workId = workId;
    this._clock = typeof clock === 'function' ? clock : defaultClock;
    this._machine = new FiringMachine({ initialProgress });
    this._inputMode = 'manual';
    this._cameraStatus = 'off';
    this._cameraError = null;
    this._calibrationStatus = 'idle';
    this._handPresent = false;
    this._pinching = false;
    this._rotating = false;
    this._trackingLostSince = null;
    this._manualAdvancing = false;
    this._hasInteracted = initialProgress > CONFIG.progress.min;
    this._camera = null;
    this._cameraAssetBaseUrl = cameraAssetBaseUrl;
    this._cameraSessionFactory = typeof cameraSessionFactory === 'function' ? cameraSessionFactory : null;
    this._cameraReadyAt = null;
    this._lastHandAt = null;
    this._gesture = new GestureEngine();
    this._calibrationStep = null;
    this._calibrationStepStartedAt = null;
    this._calibrationSamples = [];
    this._calibrationTimeoutAt = null;
    this._calibrationOpenMax = null;
    this._calibrationClosedMin = null;
    this._unlockCloseStartedAt = null;
    this._rotation = { yaw: 0, pitch: 0 };
    this._listeners = new Set();
    this._landmarkObservers = new Set();
    this._cleanups = new Set();
    this._revision = 0;
    this._lastSignature = null;
    this._lastProgressAt = -Infinity;
    this._destroyed = false;
    this._autoTick = Boolean(autoTick);
    this._raf = 0;
    this._lastTickAt = null;
    this._capabilities = readCapabilities();

    if (this._autoTick) this._startTicker();
  }

  get interfaceVersion() {
    return INTERFACE_VERSION;
  }

  get progress() {
    return this._machine.progress;
  }

  get locked() {
    return this._machine.locked;
  }

  getState() {
    const interactionState = this._computeInteractionState();
    return {
      schemaVersion: 1,
      interfaceVersion: INTERFACE_VERSION,
      revision: this._revision,
      workId: this._workId,
      progress: this._machine.progress,
      locked: this._machine.locked,
      inputMode: this._inputMode,
      interactionState,
      cameraStatus: this._cameraStatus,
      cameraError: this._cameraError,
      calibrationStatus: this._calibrationStatus,
      handPresent: this._handPresent,
      pinching: this._pinching,
      rotating: this._rotating,
      trackingLostSince: this._trackingLostSince,
      manualAdvancing: this._manualAdvancing,
      capabilities: this._capabilities,
    };
  }

  getProgress() {
    return this._machine.progress;
  }

  consumeRotation() {
    const rotation = {
      yaw: this._rotation.yaw,
      pitch: this._rotation.pitch,
    };
    this._rotation.yaw = 0;
    this._rotation.pitch = 0;
    return rotation;
  }

  subscribe(listener) {
    if (typeof listener !== 'function' || this._destroyed) return () => {};
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Ephemeral landmark observer for local visual overlays (for example a hand
   * skeleton). Frames are never stored, persisted or uploaded. Returning the
   * unsubscribe function stops future frames immediately.
   */
  observeLandmarks(listener) {
    if (typeof listener !== 'function' || this._destroyed) return () => {};
    this._landmarkObservers.add(listener);
    return () => {
      this._landmarkObservers.delete(listener);
    };
  }

  step(dtMs) {
    if (this._destroyed || !Number.isFinite(dtMs)) return;
    const clamped = clamp(dtMs, 0, CONFIG.progress.maxTickMs);
    this._tick(clamped);
  }

  setProgress(value) {
    if (!this._canUseManualInput() || !Number.isFinite(value)) return false;
    const accepted = this._machine.setManualProgress(value);
    if (!accepted) return false;
    this._hasInteracted = true;
    this._manualAdvancing = false;
    this._emitStateIfChanged('manual-progress');
    this._emitProgress('manual');
    return true;
  }

  adjustProgress(delta) {
    if (!this._canUseManualInput() || !Number.isFinite(delta)) return false;
    return this.setProgress(this._machine.progress + delta);
  }

  startManualAdvance() {
    if (!this._canUseManualInput() || this._machine.progress >= CONFIG.progress.max) return false;
    this._manualAdvancing = true;
    this._hasInteracted = true;
    this._emitStateIfChanged('manual-advance-start');
    return true;
  }

  stopManualAdvance() {
    if (this._destroyed || !this._manualAdvancing) return false;
    this._manualAdvancing = false;
    this._emitStateIfChanged('manual-advance-stop');
    return true;
  }

  applyManualRotation(yaw, pitch) {
    if (this._destroyed || this._inputMode !== 'manual') return false;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;
    this._addRotation(
      clamp(yaw, -CONFIG.manual.maxRotationStep, CONFIG.manual.maxRotationStep),
      clamp(pitch, -CONFIG.manual.maxRotationStep, CONFIG.manual.maxRotationStep),
    );
    if (!this._hasInteracted) {
      this._hasInteracted = true;
      this._emitStateIfChanged('manual-rotation');
    }
    return true;
  }

  requestLock() {
    if (this._destroyed) return { ok: false, reason: 'destroyed' };
    if (this._inputMode !== 'manual') return { ok: false, reason: 'manual-only' };
    const result = this._machine.requestLock();
    if (!result.ok) return result;
    this._manualAdvancing = false;
    this._hasInteracted = true;
    this._emitProgress('manual', true);
    this._emitStateIfChanged('lock');
    return result;
  }

  reset() {
    if (this._destroyed) return;
    this._machine.reset();
    this._machine.setPinching(false);
    this._manualAdvancing = false;
    this._pinching = false;
    this._rotating = false;
    this._unlockCloseStartedAt = null;
    this._gesture.resetPinch();
    this._gesture.resetOrientation();
    this._rotation.yaw = 0;
    this._rotation.pitch = 0;
    this._hasInteracted = true;
    this._emit({ type: 'rotationreset', at: this._now() });
    this._emitProgress('manual', true);
    this._emitStateIfChanged('reset');
  }

  async startCamera({ videoElement } = {}) {
    if (this._destroyed) {
      return { ok: false, error: this._makeError('aborted', '交互系统已销毁') };
    }
    const session = this._getCameraSession();
    if (session.status === 'ready') {
      if (this._cameraStatus !== 'ready') {
        this._handleCameraEvent({ type: 'status', status: 'ready', at: this._now() });
      }
      return { ok: true };
    }
    if (session.status !== 'requesting' && session.status !== 'loading') {
      this._cameraStatus = 'requesting';
      this._cameraError = null;
      this._inputMode = 'manual';
      this._emitStateIfChanged('camera-requesting');
    }

    let result;
    try {
      result = await session.start(videoElement);
    } catch {
      result = { ok: false, error: this._makeError('unknown', '摄像头启动失败') };
    }
    return this._finishCameraStart(result);
  }

  pauseCamera() {
    if (this._destroyed) return;
    if (this._camera) {
      this._camera.pause('user');
      return;
    }
    this._handleCameraEvent({ type: 'status', status: 'paused', at: this._now() });
  }

  async resumeCamera() {
    if (this._destroyed) {
      return { ok: false, error: this._makeError('aborted', '交互系统已销毁') };
    }
    if (!this._camera) {
      return { ok: false, error: this._makeError('invalid-state', '摄像头尚未启动') };
    }
    if (this._camera.status === 'ready') return { ok: true };
    if (this._camera.status !== 'paused') {
      return { ok: false, error: this._makeError('invalid-state', '摄像头没有处于暂停状态') };
    }
    this._cameraStatus = 'requesting';
    this._cameraError = null;
    this._inputMode = 'manual';
    this._emitStateIfChanged('camera-resuming');
    let result;
    try {
      result = await this._camera.resume();
    } catch {
      result = { ok: false, error: this._makeError('unknown', '摄像头恢复失败') };
    }
    return this._finishCameraStart(result);
  }

  stopCamera() {
    if (this._destroyed) return;
    if (this._camera) {
      this._camera.stop();
      return;
    }
    this._handleCameraEvent({ type: 'status', status: 'off', at: this._now() });
  }

  skipCalibration() {
    if (this._destroyed) return false;
    if (this._calibrationStatus !== 'open' && this._calibrationStatus !== 'closed') return false;
    this._finishCalibration('skipped');
    return true;
  }

  attachManualControls(refs) {
    if (this._destroyed) return () => {};
    const detach = bindManualControls(this, refs);
    this._cleanups.add(detach);
    return () => {
      detach();
      this._cleanups.delete(detach);
    };
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._raf && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this._raf);
    }
    this._raf = 0;
    const camera = this._camera;
    this._camera = null;
    if (camera) {
      try {
        await camera.destroy();
      } catch {
        // Camera teardown must never prevent the remaining cleanup.
      }
    }
    for (const cleanup of this._cleanups) {
      try {
        cleanup();
      } catch {
        // Cleanup must never prevent the camera or listeners from being released.
      }
    }
    this._cleanups.clear();
    this._stopCameraResources();
    this._rotation.yaw = 0;
    this._rotation.pitch = 0;
    this._emitStateIfChanged('destroyed', true);
    this._listeners.clear();
    this._landmarkObservers.clear();
  }

  _getCameraSession() {
    if (!this._camera) {
      const onEvent = (event) => this._handleCameraEvent(event);
      this._camera = this._cameraSessionFactory
        ? this._cameraSessionFactory(onEvent)
        : new CameraSession({ onEvent, assetBaseUrl: this._cameraAssetBaseUrl });
    }
    return this._camera;
  }

  _finishCameraStart(result) {
    if (this._destroyed) return result;
    if (result?.ok && this._cameraStatus !== 'ready' && this._cameraStatus !== 'paused') {
      this._handleCameraEvent({ type: 'status', status: 'ready', at: this._now() });
    }
    if (!result?.ok && !['error', 'paused', 'off'].includes(this._cameraStatus)) {
      const error = result?.error || this._makeError('unknown', '摄像头启动失败');
      this._cameraStatus = 'error';
      this._cameraError = error;
      this._inputMode = 'manual';
      this._clearCameraHand();
      this._emit({ type: 'error', at: error.at, error });
      this._emitStateIfChanged('camera-error');
    }
    return result;
  }

  _handleCameraEvent(event) {
    if (this._destroyed || !event) return;

    if (event.type === 'hand') {
      if (this._cameraStatus !== 'ready') return;
      const at = Number.isFinite(event.at) ? event.at : this._now();
      this._emitLandmarks({
        present: Boolean(event.present),
        landmarks: event.landmarks || null,
        handedness: event.handedness || null,
        score: Number.isFinite(event.score) ? event.score : null,
        videoWidth: event.videoWidth || 0,
        videoHeight: event.videoHeight || 0,
        at,
      });
      const wasPresent = this._handPresent;
      const wasLost = this._trackingLostSince !== null;
      const wasPinching = this._pinching;
      this._handPresent = Boolean(event.present);

      if (this._handPresent) {
        this._lastHandAt = at;
        this._trackingLostSince = null;
        this._machine.setTrackingAvailable(true);

        if (event.landmarks) {
          if (this._calibrationStatus === 'open' || this._calibrationStatus === 'closed') {
            const measurement = this._gesture.process({
              landmarks: event.landmarks,
              score: event.score,
              videoWidth: event.videoWidth,
              videoHeight: event.videoHeight,
              at,
            });
            if (measurement.valid && Number.isFinite(measurement.rawOpenness)) {
              this._collectCalibration(measurement.rawOpenness, at);
            }
          } else if (
            this._calibrationStatus === 'done'
            || this._calibrationStatus === 'skipped'
            || this._calibrationStatus === 'failed'
          ) {
            const result = this._gesture.process({
              landmarks: event.landmarks,
              score: event.score,
              videoWidth: event.videoWidth,
              videoHeight: event.videoHeight,
              at,
            });
            if (result.valid) this._applyGestureResult(result, at);
          }
        }
      } else {
        this._gesture.resetPinch();
        this._unlockCloseStartedAt = null;
        if (this._pinching) {
          this._pinching = false;
          this._rotating = false;
          this._machine.setPinching(false);
        }
      }

      if (
        wasPresent !== this._handPresent
        || (this._handPresent && wasLost)
        || wasPinching !== this._pinching
      ) {
        this._emitStateIfChanged(this._handPresent ? 'hand-frame' : 'hand-missing');
      }
      return;
    }

    if (event.type !== 'status') return;
    const status = event.status;
    const at = Number.isFinite(event.at) ? event.at : this._now();

    if (status === 'ready') {
      this._cameraStatus = 'ready';
      this._cameraError = null;
      this._inputMode = 'camera';
      this._gesture.resetSession();
      this._resetCalibration('open', at);
      this._clearCameraHand();
      this._unlockCloseStartedAt = null;
      this._cameraReadyAt = at;
      this._hasInteracted = true;
      this._machine.setAutoLockEnabled(false);
      this._machine.setPinching(false);
      this._machine.setTrackingAvailable(true);
      this._emitStateIfChanged('camera-ready');
      return;
    }

    if (status === 'error') {
      this._cameraStatus = 'error';
      this._cameraError = event.error || this._makeError('unknown', '摄像头启动失败');
      this._inputMode = 'manual';
      this._resetCalibration('idle', at);
      this._clearCameraHand();
      this._machine.setAutoLockEnabled(false);
      this._machine.setTrackingAvailable(true);
      this._emit({ type: 'error', at: this._cameraError.at, error: this._cameraError });
      this._emitStateIfChanged('camera-error');
      return;
    }

    this._cameraStatus = status;
    this._cameraError = null;
    this._inputMode = 'manual';
    this._resetCalibration('idle', at);
    this._clearCameraHand();
    this._machine.setAutoLockEnabled(false);
    this._machine.setTrackingAvailable(true);
    this._emitStateIfChanged(`camera-${status}`);
  }

  _clearCameraHand() {
    this._handPresent = false;
    this._pinching = false;
    this._rotating = false;
    this._lastHandAt = null;
    this._cameraReadyAt = null;
    this._trackingLostSince = null;
    this._gesture.resetPinch();
    this._machine.setPinching(false);
    this._unlockCloseStartedAt = null;
    this._emitLandmarks({
      present: false,
      landmarks: null,
      handedness: null,
      score: null,
      videoWidth: 0,
      videoHeight: 0,
      at: this._now(),
    });
  }

  _updateTracking(now) {
    if (this._cameraStatus !== 'ready') {
      if (this._trackingLostSince !== null) {
        this._trackingLostSince = null;
        this._machine.setTrackingAvailable(true);
        this._emitStateIfChanged('tracking-reset');
      }
      return;
    }
    const anchor = this._lastHandAt ?? this._cameraReadyAt;
    if (anchor === null) return;
    const handIsFresh = this._handPresent && now - anchor < CONFIG.camera.handLostMs;
    if (handIsFresh) {
      if (this._trackingLostSince !== null) {
        this._trackingLostSince = null;
        this._machine.setTrackingAvailable(true);
        this._emitStateIfChanged('hand-found');
      }
      return;
    }

    if (now - anchor >= CONFIG.camera.handLostMs) {
      if (this._trackingLostSince === null) {
        this._trackingLostSince = now;
        this._handPresent = false;
        this._pinching = false;
        this._rotating = false;
        this._unlockCloseStartedAt = null;
        this._gesture.resetPinch();
        this._machine.setPinching(false);
        this._machine.setTrackingAvailable(false);
        this._emitLandmarks({
          present: false,
          landmarks: null,
          handedness: null,
          score: null,
          videoWidth: 0,
          videoHeight: 0,
          at: now,
        });
        this._emitStateIfChanged('tracking-lost');
      }
    } else if (this._trackingLostSince !== null) {
      this._trackingLostSince = null;
      this._machine.setTrackingAvailable(true);
      this._emitStateIfChanged('hand-found');
    }
  }

  _resetCalibration(status, at) {
    this._calibrationStatus = status;
    this._calibrationStep = status === 'open' ? 'open' : null;
    this._calibrationSamples = [];
    this._calibrationStepStartedAt = null;
    this._calibrationOpenMax = null;
    this._calibrationClosedMin = null;
    this._calibrationTimeoutAt = status === 'open'
      ? at + CONFIG.gesture.calibration.timeoutMs
      : null;
  }

  _collectCalibration(raw, at) {
    if (this._calibrationStatus !== 'open' && this._calibrationStatus !== 'closed') return;
    if (!Number.isFinite(raw)) return;
    if (this._calibrationStepStartedAt === null) this._calibrationStepStartedAt = at;
    this._calibrationSamples.push(raw);
    if (this._calibrationSamples.length > 240) this._calibrationSamples.shift();

    const elapsed = at - this._calibrationStepStartedAt;
    if (
      elapsed < CONFIG.gesture.calibration.holdMs
      || this._calibrationSamples.length < CONFIG.gesture.calibration.minSamples
    ) {
      return;
    }

    if (this._calibrationStep === 'open') {
      this._calibrationOpenMax = Math.max(...this._calibrationSamples);
      this._calibrationStep = 'closed';
      this._calibrationStatus = 'closed';
      this._calibrationSamples = [];
      this._calibrationStepStartedAt = null;
      this._calibrationTimeoutAt = at + CONFIG.gesture.calibration.timeoutMs;
      this._emitStateIfChanged('calibration-open-done');
      return;
    }

    this._calibrationClosedMin = Math.min(...this._calibrationSamples);
    if (
      this._calibrationOpenMax !== null
      && this._calibrationOpenMax - this._calibrationClosedMin >= CONFIG.gesture.calibration.minRange
    ) {
      this._finishCalibration('done', {
        openMax: this._calibrationOpenMax,
        closedMin: this._calibrationClosedMin,
      });
    } else {
      this._finishCalibration('failed');
    }
  }

  _finishCalibration(status, ranges = null) {
    let finalStatus = status;
    if (status === 'done') {
      const accepted = ranges && this._gesture.setCalibration(ranges);
      if (!accepted) finalStatus = 'failed';
    }
    if (finalStatus !== 'done') {
      this._gesture.setCalibration({
        openMax: CONFIG.gesture.fallbackOpenMax,
        closedMin: CONFIG.gesture.fallbackClosedMin,
      });
      // Calibration is intentionally off in the main interface. Estimate the
      // user's actual open/closed range silently so a fully open hand reaches 1.
      this._gesture.enableAutoRange();
    }

    this._calibrationStatus = finalStatus;
    this._calibrationStep = null;
    this._calibrationSamples = [];
    this._calibrationStepStartedAt = null;
    this._calibrationTimeoutAt = null;
    this._unlockCloseStartedAt = null;
    this._gesture.resetPinch();
    this._machine.setPinching(false);

    if (this._cameraStatus === 'ready') {
      this._machine.setAutoLockEnabled(true);
      this._machine.setTrackingAvailable(this._trackingLostSince === null);
      this._hasInteracted = true;
    }

    this._emitStateIfChanged(`calibration-${finalStatus}`);
  }

  _updateCalibration(now) {
    if (
      (this._calibrationStatus === 'open' || this._calibrationStatus === 'closed')
      && this._calibrationTimeoutAt !== null
      && now >= this._calibrationTimeoutAt
    ) {
      this._finishCalibration('failed');
    }
  }

  _applyGestureResult(result, at) {
    this._machine.setTarget(result.target);
    if (result.pinching !== this._pinching) {
      this._pinching = Boolean(result.pinching);
      this._rotating = this._pinching;
      this._machine.setPinching(this._pinching);
    }
    if (result.pinching && result.rotation) {
      this._addRotation(result.rotation.yaw, result.rotation.pitch);
    }

    if (this._machine.locked) {
      const closed = !result.pinching
        && Number.isFinite(result.rawNormalized)
        && result.rawNormalized <= CONFIG.gesture.unlockCloseThreshold;
      if (closed) {
        if (this._unlockCloseStartedAt === null) this._unlockCloseStartedAt = at;
        if (at - this._unlockCloseStartedAt >= CONFIG.gesture.unlockHoldMs) {
          this._machine.unlock();
          this._unlockCloseStartedAt = null;
          this._emitStateIfChanged('unlock-by-close');
        }
      } else {
        this._unlockCloseStartedAt = null;
      }
    } else {
      this._unlockCloseStartedAt = null;
    }

    this._hasInteracted = true;
  }

  _addRotation(yaw, pitch) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    this._rotation.yaw = clamp(
      this._rotation.yaw + yaw,
      -CONFIG.manual.rotationBufferMax,
      CONFIG.manual.rotationBufferMax,
    );
    this._rotation.pitch = clamp(
      this._rotation.pitch + pitch,
      -CONFIG.manual.rotationBufferMax,
      CONFIG.manual.rotationBufferMax,
    );
  }

  _canUseManualInput() {
    return !this._destroyed
      && this._inputMode === 'manual'
      && !this._machine.locked;
  }

  _computeInteractionState() {
    if (this._calibrationStatus === 'open' || this._calibrationStatus === 'closed') {
      return 'calibrating';
    }
    if (this._cameraStatus === 'ready' && this._trackingLostSince !== null) {
      return 'tracking-lost';
    }
    if (this._machine.locked) return 'locked';
    if (this._rotating || this._pinching) return 'rotating';
    if (this._cameraStatus === 'requesting' || this._cameraStatus === 'loading') {
      return 'permission';
    }
    if (this._hasInteracted || this._manualAdvancing || this._machine.progress > CONFIG.progress.min) {
      return 'active';
    }
    return 'idle';
  }

  _signature() {
    return [
      this._machine.locked,
      this._inputMode,
      this._computeInteractionState(),
      this._cameraStatus,
      this._cameraError?.code ?? '',
      this._calibrationStatus,
      this._handPresent,
      this._pinching,
      this._rotating,
      this._manualAdvancing,
      this._trackingLostSince !== null,
    ].join('|');
  }

  _emit(event) {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // A broken visual subscriber must not break tracking or camera cleanup.
      }
    }
  }

  _emitLandmarks(frame) {
    if (this._landmarkObservers.size === 0) return;
    for (const listener of this._landmarkObservers) {
      try {
        listener(frame);
      } catch {
        // The skeleton overlay is local and must never break gesture tracking.
      }
    }
  }

  _emitProgress(source, force = false) {
    const now = this._now();
    if (!force && now - this._lastProgressAt < CONFIG.progress.progressEventIntervalMs) {
      return;
    }
    this._lastProgressAt = now;
    this._emit({
      type: 'progress',
      at: now,
      progress: this._machine.progress,
      source,
    });
  }

  _emitStateIfChanged(reason, force = false) {
    const signature = this._signature();
    if (!force && signature === this._lastSignature) return;
    this._lastSignature = signature;
    this._revision += 1;
    this._emit({
      type: 'statechange',
      at: this._now(),
      revision: this._revision,
      state: this.getState(),
      reason,
    });
  }

  _tick(dtMs) {
    if (this._destroyed || dtMs <= 0) return;

    const now = this._now();
    this._updateCalibration(now);
    this._updateTracking(now);

    let changed = false;
    if (this._manualAdvancing && this._canUseManualInput()) {
      if (this._machine.advance(dtMs, CONFIG.manual.advanceRate)) changed = true;
      if (this._machine.progress >= CONFIG.progress.max) {
        this._manualAdvancing = false;
        changed = true;
      }
    }

    const result = this._machine.tick(dtMs);
    if (result.changed) changed = true;
    if (result.locked) {
      this._manualAdvancing = false;
      this._emitProgress('manual', true);
    }

    if (changed) {
      this._hasInteracted = true;
      if (!result.locked) this._emitProgress('advance');
    }
    if (changed || result.locked) {
      this._emitStateIfChanged(result.locked ? 'lock' : 'progress');
    }
  }

  _startTicker() {
    if (typeof globalThis.requestAnimationFrame !== 'function') return;
    const loop = (timestamp) => {
      if (this._destroyed) return;
      const now = Number.isFinite(timestamp) ? timestamp : this._now();
      const dt = this._lastTickAt === null ? 0 : now - this._lastTickAt;
      this._lastTickAt = now;
      this._tick(clamp(dt, 0, CONFIG.progress.maxTickMs));
      this._raf = globalThis.requestAnimationFrame(loop);
    };
    this._raf = globalThis.requestAnimationFrame(loop);
  }

  _now() {
    const value = this._clock();
    return Number.isFinite(value) ? value : Date.now();
  }

  _makeError(code, message) {
    return { code, message, at: this._now() };
  }

  _stopCameraResources() {
    this._cameraStatus = 'off';
    this._cameraError = null;
    this._inputMode = 'manual';
    this._calibrationStatus = 'idle';
    this._calibrationStep = null;
    this._calibrationSamples = [];
    this._calibrationStepStartedAt = null;
    this._calibrationTimeoutAt = null;
    this._calibrationOpenMax = null;
    this._calibrationClosedMin = null;
    this._unlockCloseStartedAt = null;
    this._handPresent = false;
    this._pinching = false;
    this._rotating = false;
    this._trackingLostSince = null;
    this._cameraReadyAt = null;
    this._lastHandAt = null;
    this._machine.setAutoLockEnabled(false);
    this._machine.setPinching(false);
    this._gesture.resetSession();
  }
}
