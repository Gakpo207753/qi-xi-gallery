import { CONFIG } from './config.js';

const DEFAULT_ASSET_BASE = new URL('../assets/mediapipe/', import.meta.url).href;

export function mapCameraError(error) {
  const name = String(error?.name || '');
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'permission-denied';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'no-device';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'camera-busy';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'stream-failed';
  }
  if (name === 'AbortError') return 'aborted';
  return 'unknown';
}

function cameraError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Owns the camera stream, MediaPipe Hand Landmarker and the detection loop.
 *
 * It does not know about firing progress, ceramic visuals, Three.js or the
 * visual layout. It only emits camera status and ephemeral landmark frames.
 */
export class CameraSession {
  constructor({
    onEvent = () => {},
    assetBaseUrl = DEFAULT_ASSET_BASE,
    startTimeoutMs = CONFIG.camera.startTimeoutMs,
    detectionIntervalMs = CONFIG.camera.detectionIntervalMs,
    scope = globalThis,
  } = {}) {
    this._onEvent = onEvent;
    this._scope = scope;
    this._assetBaseUrl = String(assetBaseUrl).endsWith('/') ? String(assetBaseUrl) : `${assetBaseUrl}/`;
    this._bundleUrl = new URL(CONFIG.camera.bundlePath, this._assetBaseUrl).href;
    this._wasmUrl = new URL(CONFIG.camera.wasmPath, this._assetBaseUrl).href;
    this._modelUrl = new URL(CONFIG.camera.modelPath, this._assetBaseUrl).href;
    this._startTimeoutMs = startTimeoutMs;
    this._detectionIntervalMs = Number.isFinite(detectionIntervalMs) && detectionIntervalMs > 0
      ? detectionIntervalMs
      : CONFIG.camera.detectionIntervalMs;

    this._status = 'off';
    this._error = null;
    this._video = null;
    this._stream = null;
    this._landmarker = null;
    this._landmarkerPromise = null;
    this._startPromise = null;
    this._generation = 0;
    this._readyAt = null;
    this._detectionActive = false;
    this._frameHandle = null;
    this._frameTimer = 0;
    this._detectionMode = null;
    this._lastVideoTime = -1;
    this._lastDetectionAt = 0;
    this._consecutiveErrors = 0;
    this._destroyed = false;

    this._onVisibilityChange = () => {
      if (this._document?.visibilityState === 'hidden'
        && ['requesting', 'loading', 'ready'].includes(this._status)) {
        this.pause('hidden');
      }
    };
    this._onPageHide = () => this.stop();
    this._document = this._scope.document || null;
    if (this._document?.addEventListener) {
      this._document.addEventListener('visibilitychange', this._onVisibilityChange);
      this._document.addEventListener('pagehide', this._onPageHide);
    }
  }

  get status() {
    return this._status;
  }

  get error() {
    return this._error;
  }

  get readyAt() {
    return this._readyAt;
  }

  async start(videoElement) {
    if (this._destroyed) {
      return { ok: false, error: this._makeError('aborted', '摄像头会话已销毁') };
    }
    if (!videoElement || typeof videoElement !== 'object') {
      return { ok: false, error: this._makeError('stream-failed', '缺少视频预览元素') };
    }
    if (this._status === 'ready') return { ok: true };
    if (this._startPromise) return this._startPromise;

    this._video = videoElement;
    const promise = this._startWithTimeout();
    this._startPromise = promise;
    try {
      return await promise;
    } finally {
      if (this._startPromise === promise) this._startPromise = null;
    }
  }

  async resume() {
    if (this._status !== 'paused' || !this._video) {
      return { ok: false, error: this._makeError('invalid-state', '摄像头没有处于暂停状态') };
    }
    return this.start(this._video);
  }

  pause(reason = 'user') {
    if (this._destroyed) return;
    if (this._status === 'off' || this._status === 'error' || this._status === 'paused') return;
    this._generation += 1;
    this._stopDetection();
    this._releaseStream();
    this._readyAt = null;
    this._setStatus('paused', null, reason);
  }

  stop() {
    if (this._destroyed) return;
    this._generation += 1;
    this._stopDetection();
    this._releaseStream();
    this._readyAt = null;
    this._error = null;
    this._setStatus('off', null, 'stopped');
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._generation += 1;
    this._stopDetection();
    this._releaseStream();
    if (this._landmarker?.close) {
      try {
        await this._landmarker.close();
      } catch {
        // MediaPipe cleanup must not throw during page teardown.
      }
    }
    this._landmarker = null;
    this._landmarkerPromise = null;
    this._readyAt = null;
    this._status = 'off';
    this._error = null;
    if (this._document?.removeEventListener) {
      this._document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._document.removeEventListener('pagehide', this._onPageHide);
    }
    this._video = null;
    this._onEvent = () => {};
  }

  async _startWithTimeout() {
    const token = ++this._generation;
    this._setStatus('requesting');
    let timer = 0;
    const timeout = new Promise((resolve) => {
      timer = this._scope.setTimeout(() => resolve({ timedOut: true }), this._startTimeoutMs);
    });

    try {
      const result = await Promise.race([this._open(token), timeout]);
      if (result?.timedOut) {
        if (token !== this._generation) {
          return { ok: false, error: this._makeError('aborted', '摄像头启动已中止') };
        }
        this._generation += 1;
        this._stopDetection();
        this._releaseStream();
        return this._failure('timeout', '摄像头启动超时，已切换为手动模式');
      }
      return result;
    } finally {
      this._scope.clearTimeout(timer);
    }
  }

  async _open(token) {
    if (!this._scope.isSecureContext) {
      return this._failure('insecure-context', '摄像头需要 HTTPS 或 localhost');
    }
    const mediaDevices = this._scope.navigator?.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      return this._failure('unsupported', '当前浏览器不支持摄像头');
    }

    let stream;
    try {
      stream = await mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: CONFIG.camera.width },
          height: { ideal: CONFIG.camera.height },
        },
        audio: false,
      });
    } catch (error) {
      if (!this._isCurrent(token)) return this._abortedResult();
      return this._failure(mapCameraError(error), '无法打开摄像头');
    }

    if (!this._isCurrent(token)) {
      this._releaseStream(stream);
      return this._abortedResult();
    }

    this._stream = stream;
    const video = this._video;
    if (!video) {
      this._releaseStream(stream);
      return this._failure('stream-failed', '视频预览元素不可用');
    }

    try {
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = stream;
      await video.play();
    } catch (error) {
      this._releaseStream(stream);
      if (!this._isCurrent(token)) return this._abortedResult();
      return this._failure(mapCameraError(error), '摄像头画面无法播放');
    }

    if (!this._isCurrent(token)) {
      this._releaseStream(stream);
      return this._abortedResult();
    }

    this._setStatus('loading');
    try {
      await this._ensureLandmarker();
    } catch (error) {
      this._releaseStream(stream);
      if (!this._isCurrent(token)) return this._abortedResult();
      return this._failure(error.code || 'landmarker-init-failed', error.message || '手势识别初始化失败');
    }

    if (!this._isCurrent(token)) {
      this._releaseStream(stream);
      return this._abortedResult();
    }

    this._readyAt = this._now();
    this._setStatus('ready');
    this._startDetection();
    return { ok: true };
  }

  async _ensureLandmarker() {
    if (this._landmarker) return this._landmarker;
    if (this._landmarkerPromise) return this._landmarkerPromise;

    this._landmarkerPromise = this._loadLandmarker();
    try {
      this._landmarker = await this._landmarkerPromise;
      return this._landmarker;
    } finally {
      this._landmarkerPromise = null;
    }
  }

  async _loadLandmarker() {
    let vision;
    try {
      vision = await import(this._bundleUrl);
    } catch {
      throw cameraError('mediapipe-load-failed', 'MediaPipe 脚本加载失败');
    }

    let fileset;
    try {
      fileset = await vision.FilesetResolver.forVisionTasks(this._wasmUrl);
    } catch {
      throw cameraError('mediapipe-load-failed', 'MediaPipe WASM 加载失败');
    }

    const options = {
      baseOptions: {
        modelAssetPath: this._modelUrl,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };

    try {
      return await vision.HandLandmarker.createFromOptions(fileset, options);
    } catch {
      try {
        return await vision.HandLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: 'CPU' },
        });
      } catch {
        throw cameraError('landmarker-init-failed', 'MediaPipe 手部模型初始化失败');
      }
    }
  }

  _startDetection() {
    this._stopDetection();
    const video = this._video;
    if (!video || !this._landmarker) return;
    this._detectionActive = true;
    this._lastVideoTime = -1;
    this._lastDetectionAt = 0;
    this._consecutiveErrors = 0;

    const loop = (timestamp) => {
      if (!this._detectionActive || this._status !== 'ready') return;
      this._detectFrame(Number.isFinite(timestamp) ? timestamp : this._now());
      if (!this._detectionActive) return;
      this._scheduleFrame(loop);
    };

    this._scheduleFrame = (callback) => {
      if (!this._detectionActive || !this._video) return;
      if (typeof this._video.requestVideoFrameCallback === 'function') {
        this._detectionMode = 'rvfc';
        this._frameHandle = this._video.requestVideoFrameCallback((now) => callback(now));
        return;
      }
      this._detectionMode = 'timer';
      this._frameTimer = this._scope.setTimeout(() => callback(this._now()), this._detectionIntervalMs);
    };

    this._scheduleFrame(loop);
  }

  _stopDetection() {
    this._detectionActive = false;
    if (this._video?.cancelVideoFrameCallback && this._frameHandle !== null) {
      try {
        this._video.cancelVideoFrameCallback(this._frameHandle);
      } catch {
        // Ignore a video element that was detached by the visual layer.
      }
    }
    if (this._frameTimer) {
      this._scope.clearTimeout(this._frameTimer);
      this._frameTimer = 0;
    }
    this._frameHandle = null;
    this._detectionMode = null;
    this._scheduleFrame = null;
  }

  _detectFrame(timestamp) {
    const video = this._video;
    const landmarker = this._landmarker;
    if (!this._detectionActive || !video || !landmarker || this._status !== 'ready') return;
    if (video.readyState < 2 || video.currentTime === this._lastVideoTime) return;

    const now = this._now();
    if (now - this._lastDetectionAt < this._detectionIntervalMs) return;
    this._lastDetectionAt = now;
    this._lastVideoTime = video.currentTime;

    try {
      const result = landmarker.detectForVideo(video, timestamp);
      this._consecutiveErrors = 0;
      const hasHand = Boolean(result?.landmarks?.length);
      if (hasHand) {
        const handedness = result.handednesses?.[0]?.[0] || null;
        this._emit({
          type: 'hand',
          at: now,
          present: true,
          landmarks: result.landmarks[0],
          handedness: handedness?.categoryName || null,
          score: Number.isFinite(handedness?.score) ? handedness.score : null,
          videoWidth: video.videoWidth || 0,
          videoHeight: video.videoHeight || 0,
        });
      } else {
        this._emit({
          type: 'hand',
          at: now,
          present: false,
          landmarks: null,
          handedness: null,
          score: null,
          videoWidth: video.videoWidth || 0,
          videoHeight: video.videoHeight || 0,
        });
      }
    } catch {
      this._consecutiveErrors += 1;
      if (this._consecutiveErrors >= CONFIG.camera.maxConsecutiveDetectionErrors) {
        this._stopDetection();
        this._failure('landmarker-init-failed', '手部识别连续失败，已切换为手动模式');
      }
    }
  }

  _failure(code, message) {
    this._stopDetection();
    this._releaseStream();
    this._readyAt = null;
    const error = this._makeError(code, message);
    this._status = 'error';
    this._error = error;
    this._emit({ type: 'status', status: 'error', error, at: this._now() });
    return { ok: false, error };
  }

  _abortedResult() {
    return { ok: false, error: this._makeError('aborted', '摄像头启动已中止') };
  }

  _releaseStream(stream = this._stream) {
    if (!stream) return;
    stopTracks(stream);
    if (this._stream === stream) this._stream = null;
    if (this._video?.srcObject === stream) {
      try {
        this._video.pause();
      } catch {
        // A removed preview must not keep the session alive.
      }
      this._video.srcObject = null;
    }
  }

  _setStatus(status, error = null, reason = '') {
    this._status = status;
    this._error = error;
    this._emit({ type: 'status', status, error, reason, at: this._now() });
  }

  _isCurrent(token) {
    return !this._destroyed && token === this._generation;
  }

  _makeError(code, message) {
    return { code, message, at: this._now() };
  }

  _now() {
    return this._scope.performance?.now?.() ?? Date.now();
  }

  _emit(event) {
    try {
      this._onEvent(event);
    } catch {
      // Camera cleanup and detection must survive a broken visual subscriber.
    }
  }
}

function stopTracks(stream) {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // The browser may have already ended the stream.
  }
}
