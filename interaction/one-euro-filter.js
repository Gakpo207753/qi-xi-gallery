import { CONFIG } from './config.js';

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * Math.max(cutoff, 0.0001));
  return 1 / (1 + tau / Math.max(dt, 0.0001));
}

/**
 * One Euro filter used by the openness signal.
 * Timestamps are milliseconds, matching MediaPipe/performance.now().
 */
export class OneEuroFilter {
  constructor({
    minCutoff = CONFIG.gesture.oneEuro.minCutoff,
    beta = CONFIG.gesture.oneEuro.beta,
    dCutoff = CONFIG.gesture.oneEuro.dCutoff,
    frequency = 30,
  } = {}) {
    this._minCutoff = minCutoff;
    this._beta = beta;
    this._dCutoff = dCutoff;
    this._defaultDt = 1 / frequency;
    this.reset();
  }

  reset() {
    this._lastTime = null;
    this._lastRaw = null;
    this._filtered = null;
    this._filteredDerivative = 0;
  }

  filter(value, timestampMs) {
    if (!Number.isFinite(value)) return this._filtered;
    if (this._lastTime === null) {
      this._lastTime = timestampMs;
      this._lastRaw = value;
      this._filtered = value;
      return value;
    }

    const dt = Math.max((timestampMs - this._lastTime) / 1000, this._defaultDt * 0.25);
    this._lastTime = timestampMs;
    const rawDerivative = (value - this._lastRaw) / dt;
    this._lastRaw = value;
    this._filteredDerivative += alpha(this._dCutoff, dt) * (rawDerivative - this._filteredDerivative);
    const cutoff = this._minCutoff + this._beta * Math.abs(this._filteredDerivative);
    this._filtered += alpha(cutoff, dt) * (value - this._filtered);
    return this._filtered;
  }

  get value() {
    return this._filtered;
  }
}
