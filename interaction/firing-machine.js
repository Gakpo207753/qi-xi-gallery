import { CONFIG } from './config.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Pure firing-progress state machine.
 *
 * It owns the only authoritative progress value. It never touches the DOM,
 * Three.js, the camera and never creates a render loop.
 */
export class FiringMachine {
  constructor({ initialProgress = CONFIG.progress.initialProgress, config = CONFIG.progress } = {}) {
    this._config = config;
    this._progress = Number.isFinite(initialProgress)
      ? clamp(initialProgress, config.min, config.max)
      : config.min;
    this._target = null;
    this._locked = false;
    this._pinching = false;
    this._trackingAvailable = true;
    this._autoLockEnabled = false;
    this._freezeReasons = new Set();
    this._resumeGraceMs = 0;
    this._lockElapsedMs = 0;
  }

  get progress() {
    return this._progress;
  }

  get locked() {
    return this._locked;
  }

  get frozen() {
    return this._freezeReasons.size > 0;
  }

  get pinching() {
    return this._pinching;
  }

  get autoLockEnabled() {
    return this._autoLockEnabled;
  }

  get lockElapsedMs() {
    return this._lockElapsedMs;
  }

  setManualProgress(value) {
    if (this._locked || !Number.isFinite(value)) return false;
    this._progress = clamp(value, this._config.min, this._config.max);
    this._target = null;
    this._resumeGraceMs = 0;
    this._lockElapsedMs = 0;
    return true;
  }

  adjustManualProgress(delta) {
    if (this._locked || !Number.isFinite(delta)) return false;
    return this.setManualProgress(this._progress + delta);
  }

  advance(dtMs, rate = CONFIG.manual.advanceRate) {
    if (this._locked || !Number.isFinite(dtMs) || dtMs <= 0 || !Number.isFinite(rate) || rate <= 0) {
      return false;
    }
    const next = clamp(this._progress + (rate * dtMs) / 1000, this._config.min, this._config.max);
    const changed = next !== this._progress;
    this._progress = next;
    this._target = null;
    this._lockElapsedMs = 0;
    return changed;
  }

  setTarget(value) {
    if (!Number.isFinite(value)) return false;
    this._target = clamp(value, this._config.min, this._config.max);
    return true;
  }

  setPinching(pinching) {
    const next = Boolean(pinching);
    if (next === this._pinching) return;
    this._pinching = next;
    if (next) {
      this._freezeReasons.add('pinch');
      this._resumeGraceMs = 0;
      this._lockElapsedMs = 0;
    } else {
      this._freezeReasons.delete('pinch');
      if (!this.frozen) this._resumeGraceMs = this._config.pinchResumeGraceMs;
    }
  }

  setTrackingAvailable(available) {
    const next = Boolean(available);
    if (next === this._trackingAvailable) return;
    this._trackingAvailable = next;
    if (next) {
      this._freezeReasons.delete('tracking');
    } else {
      this._freezeReasons.add('tracking');
      this._resumeGraceMs = 0;
      this._lockElapsedMs = 0;
    }
  }

  setAutoLockEnabled(enabled) {
    this._autoLockEnabled = Boolean(enabled);
    if (!this._autoLockEnabled) this._lockElapsedMs = 0;
  }

  unlock() {
    if (!this._locked) return false;
    this._locked = false;
    this._lockElapsedMs = 0;
    return true;
  }

  requestLock() {
    if (this._locked) return { ok: false, reason: 'already-locked' };
    if (this._pinching) return { ok: false, reason: 'pinching' };
    if (this._progress <= this._config.lockThreshold) {
      return { ok: false, reason: 'below-threshold' };
    }
    this._locked = true;
    this._progress = this._config.max;
    this._target = this._config.max;
    this._lockElapsedMs = this._config.lockHoldMs;
    return { ok: true };
  }

  reset(initialProgress = this._config.min) {
    this._progress = Number.isFinite(initialProgress)
      ? clamp(initialProgress, this._config.min, this._config.max)
      : this._config.min;
    this._target = null;
    this._locked = false;
    this._resumeGraceMs = 0;
    this._lockElapsedMs = 0;
  }

  /**
   * Advance gesture targets, recovery grace and lock timing.
   * Returns flags so the owner can emit the minimum number of events.
   */
  tick(dtMs) {
    const result = { changed: false, locked: false };
    if (!Number.isFinite(dtMs) || dtMs <= 0) return result;
    if (this._locked) {
      this._lockElapsedMs = 0;
      return result;
    }

    const wasProgress = this._progress;
    if (!this.frozen) {
      let remainingMs = dtMs;

      if (this._resumeGraceMs > 0) {
        const consumed = Math.min(this._resumeGraceMs, remainingMs);
        this._resumeGraceMs -= consumed;
        remainingMs -= consumed;
      }

      if (remainingMs > 0 && this._target !== null) {
        const dtSec = remainingMs / 1000;
        const delta = (this._target - this._progress) * (1 - Math.exp(-this._config.damping * dtSec));
        const maxStep = (delta >= 0 ? this._config.maxForwardRate : this._config.maxReverseRate) * dtSec;
        const step = clamp(delta, -maxStep, maxStep);
        this._progress = clamp(this._progress + step, this._config.min, this._config.max);
      }
    }

    if (this._progress !== wasProgress) result.changed = true;

    const eligible = this._autoLockEnabled
      && !this.frozen
      && !this._pinching
      && this._trackingAvailable
      && this._progress > this._config.lockThreshold;

    if (eligible) {
      this._lockElapsedMs += dtMs;
      if (this._lockElapsedMs >= this._config.lockHoldMs) {
        this._locked = true;
        this._progress = this._config.max;
        this._target = this._config.max;
        this._lockElapsedMs = this._config.lockHoldMs;
        result.changed = true;
        result.locked = true;
      }
    } else {
      this._lockElapsedMs = 0;
    }

    return result;
  }
}
