import { CONFIG } from './config.js';
import { OneEuroFilter } from './one-euro-filter.js';
import {
  clamp,
  computeOpenness,
  computePinch,
  rotationFromPinch,
  smoothstep,
} from './gesture-math.js';

const ZERO_ROTATION = Object.freeze({ yaw: 0, pitch: 0 });

/**
 * Pure gesture engine: landmarks in, target progress + rotation/state out.
 * It owns no camera, DOM, Three.js or progress state.
 */
export class GestureEngine {
  constructor() {
    this._filter = new OneEuroFilter();
    this.resetSession();
  }

  resetSession() {
    this._calibrated = false;
    this._openMax = CONFIG.gesture.fallbackOpenMax;
    this._closedMin = CONFIG.gesture.fallbackClosedMin;
    this._autoRange = false;
    this._observedMin = null;
    this._observedMax = null;
    this._autoRangeFrames = 0;
    this._filter.reset();
    this._pinching = false;
    this._pinchCandidateFrames = 0;
    this._pinchCandidateMisses = 0;
    this._pinchCandidateStart = 0;
    this._pinchCandidatePalm = 0;
    this._pinchExitFrames = 0;
    this._lastPinchCenter = null;
    this._lastFrameAt = null;
    this._orientation = { yaw: 0, pitch: 0 };
  }

  setCalibration({ openMax, closedMin }) {
    if (!Number.isFinite(openMax) || !Number.isFinite(closedMin)) return false;
    if (openMax <= closedMin) return false;
    if (openMax - closedMin < CONFIG.gesture.calibration.minRange) return false;
    this._openMax = openMax;
    this._closedMin = closedMin;
    this._calibrated = true;
    this._autoRange = false;
    this._filter.reset();
    this.resetPinch();
    return true;
  }

  enableAutoRange() {
    this._autoRange = true;
    this._observedMin = null;
    this._observedMax = null;
    this._autoRangeFrames = 0;
  }

  get calibrated() {
    return this._calibrated;
  }

  get pinching() {
    return this._pinching;
  }

  get orientation() {
    return { ...this._orientation };
  }

  resetPinch() {
    this._pinching = false;
    this._pinchCandidateFrames = 0;
    this._pinchCandidateMisses = 0;
    this._pinchCandidateStart = 0;
    this._pinchCandidatePalm = 0;
    this._pinchExitFrames = 0;
    this._lastPinchCenter = null;
  }

  resetOrientation() {
    this._orientation.yaw = 0;
    this._orientation.pitch = 0;
    this._lastFrameAt = null;
  }

  _updateAutoRange(raw) {
    if (!this._autoRange || !Number.isFinite(raw)) return;
    if (this._observedMin === null) {
      this._observedMin = raw;
      this._observedMax = raw;
    } else {
      this._observedMin = Math.min(this._observedMin, raw);
      this._observedMax = Math.max(this._observedMax, raw);
    }
    this._autoRangeFrames += 1;
    const observedSpan = this._observedMax - this._observedMin;
    if (this._autoRangeFrames < 8 || observedSpan < CONFIG.gesture.calibration.minRange) return;

    const margin = observedSpan * 0.05;
    const targetMin = Math.max(0, this._observedMin - margin);
    const targetMax = Math.min(1, this._observedMax + margin);
    const alpha = 0.25;
    this._closedMin += (targetMin - this._closedMin) * alpha;
    this._openMax += (targetMax - this._openMax) * alpha;
    if (this._openMax - this._closedMin < CONFIG.gesture.calibration.minRange) {
      const middle = (this._openMax + this._closedMin) / 2;
      this._closedMin = Math.max(0, middle - CONFIG.gesture.calibration.minRange / 2);
      this._openMax = this._closedMin + CONFIG.gesture.calibration.minRange;
    }
  }

  process(frame) {
    const {
      landmarks,
      score = null,
      videoWidth = 640,
      videoHeight = 480,
      at,
    } = frame || {};
    const openness = computeOpenness(landmarks);
    const pinch = computePinch(landmarks);
    if (!openness || !pinch || !Number.isFinite(at)) {
      this._resetCandidate();
      return {
        valid: false,
        calibrated: this._calibrated,
        rawOpenness: null,
        normalized: null,
        target: 0,
        pinching: this._pinching,
        rotation: ZERO_ROTATION,
        confidence: 0,
        pinchRatio: null,
      };
    }

    const confidence = Number.isFinite(score) ? clamp(score, 0, 1) : 1;
    if (confidence < CONFIG.gesture.minConfidence) {
      this._resetCandidate();
      return {
        valid: false,
        calibrated: this._calibrated,
        rawOpenness: openness.raw,
        normalized: null,
        target: 0,
        pinching: this._pinching,
        rotation: ZERO_ROTATION,
        confidence,
        pinchRatio: pinch.ratio,
      };
    }

    if (!this._calibrated) {
      return {
        valid: true,
        calibrated: false,
        rawOpenness: openness.raw,
        normalized: null,
        target: 0,
        pinching: false,
        rotation: ZERO_ROTATION,
        confidence,
        pinchRatio: pinch.ratio,
        palmScale: pinch.palmScale,
      };
    }

    const range = Math.max(this._openMax - this._closedMin, CONFIG.gesture.calibration.minRange);
    const filteredRaw = this._filter.filter(openness.raw, at);
    this._updateAutoRange(filteredRaw);
    // Use the filtered openness continuously. The old soft-deadband quantized
    // this value, which made the progress bar advance in visible steps while
    // the skeleton stayed smooth. One Euro already removes landmark jitter.
    const normalized = clamp((filteredRaw - this._closedMin) / range, 0, 1);
    const rawNormalized = clamp((openness.raw - this._closedMin) / range, 0, 1);
    const target = smoothstep(
      CONFIG.gesture.smoothstepMin,
      CONFIG.gesture.smoothstepMax,
      normalized,
    );

    const wasPinching = this._pinching;
    this._updatePinch(pinch, confidence, at, normalized);
    const rotation = this._updateRotation(pinch.center, videoWidth, videoHeight, at);

    this._lastFrameAt = at;

    return {
      valid: true,
      calibrated: true,
      rawOpenness: openness.raw,
      filteredOpenness: filteredRaw,
      normalized,
      rawNormalized,
      target,
      pinching: this._pinching,
      rotation,
      confidence,
      pinchRatio: pinch.ratio,
      palmScale: pinch.palmScale,
      enteredPinch: !wasPinching && this._pinching,
      exitedPinch: wasPinching && !this._pinching,
    };
  }

  _updatePinch(pinch, confidence, at, palmOpenness) {
    const enter = CONFIG.gesture.pinchEnterRatio;
    const exit = CONFIG.gesture.pinchExitRatio;
    const margin = CONFIG.gesture.pinchBoundsMargin;
    const inFrame = pinch.center.x >= margin
      && pinch.center.x <= 1 - margin
      && pinch.center.y >= margin
      && pinch.center.y <= 1 - margin;

    if (this._pinching) {
      if (pinch.ratio > exit) {
        this._pinchExitFrames += 1;
        if (this._pinchExitFrames >= CONFIG.gesture.pinchExitFrames) {
          this.resetPinch();
        }
      } else {
        this._pinchExitFrames = 0;
      }
      return;
    }

    const stablePalm = this._pinchCandidatePalm > 0
      ? Math.abs(pinch.palmScale - this._pinchCandidatePalm) / this._pinchCandidatePalm <= CONFIG.gesture.maxPalmScaleChange
      : true;

    // Index/thumb distance identifies the pinch. A closed fist can also bring
    // those tips together, so the palm's middle/ring/pinky extension is used
    // as the independent open-palm guard.
    const palmOpenEnough = Number.isFinite(palmOpenness)
      && palmOpenness >= CONFIG.gesture.pinchMinPalmOpenness;

    if (
      pinch.ratio < enter
      && confidence >= CONFIG.gesture.pinchConfidence
      && inFrame
      && stablePalm
      && palmOpenEnough
    ) {
      if (this._pinchCandidateFrames === 0) {
        this._pinchCandidateStart = at;
        this._pinchCandidatePalm = pinch.palmScale;
      }
      this._pinchCandidateFrames += 1;
      this._pinchCandidateMisses = 0;
      if (
        this._pinchCandidateFrames >= CONFIG.gesture.pinchEnterFrames
        && at - this._pinchCandidateStart >= CONFIG.gesture.pinchMinDurationMs
      ) {
        this._pinching = true;
        this._pinchCandidateFrames = 0;
        this._pinchCandidateMisses = 0;
        this._pinchExitFrames = 0;
        this._lastPinchCenter = { ...pinch.center };
      }
    } else if (
      this._pinchCandidateFrames > 0
      && this._pinchCandidateMisses < CONFIG.gesture.pinchMaxMisses
    ) {
      // Tolerate a single low-confidence/jitter frame without losing the
      // deliberate pinch entirely.
      this._pinchCandidateMisses += 1;
    } else {
      this._resetCandidate();
    }
  }

  _updateRotation(center, videoWidth, videoHeight, at) {
    if (!this._pinching || !this._lastPinchCenter) {
      this._lastPinchCenter = this._pinching ? { ...center } : null;
      return ZERO_ROTATION;
    }

    const rawDt = this._lastFrameAt === null ? 1 / 30 : (at - this._lastFrameAt) / 1000;
    const dt = clamp(rawDt, 0, 0.1);
    const dx = center.x - this._lastPinchCenter.x;
    const dy = center.y - this._lastPinchCenter.y;
    const mapped = rotationFromPinch(dx, dy, videoWidth, videoHeight);
    const maxStep = CONFIG.rotation.maxYawSpeed * dt;
    const yaw = clamp(mapped.yaw, -maxStep, maxStep);
    const pitch = clamp(mapped.pitch, -maxStep, maxStep);

    const previousYaw = this._orientation.yaw;
    const previousPitch = this._orientation.pitch;
    this._orientation.yaw += yaw;
    this._orientation.pitch = clamp(
      this._orientation.pitch + pitch,
      CONFIG.rotation.pitchMin,
      CONFIG.rotation.pitchMax,
    );
    this._lastPinchCenter = { ...center };

    return {
      yaw: this._orientation.yaw - previousYaw,
      pitch: this._orientation.pitch - previousPitch,
    };
  }

  _resetCandidate() {
    this._pinchCandidateFrames = 0;
    this._pinchCandidateMisses = 0;
    this._pinchCandidateStart = 0;
    this._pinchCandidatePalm = 0;
  }
}
