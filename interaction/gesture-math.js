import { CONFIG } from './config.js';

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function distance(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function angleDegrees(a, b, c) {
  if (!a || !b || !c) return 0;
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const denom = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (denom === 0) return 0;
  const cosine = clamp((abx * cbx + aby * cby) / denom, -1, 1);
  return (Math.acos(cosine) * 180) / Math.PI;
}

export function hasFullHand(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return false;
  for (let index = 0; index < 21; index += 1) {
    const point = landmarks[index];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  }
  return true;
}

export function computePalmScale(landmarks) {
  if (!hasFullHand(landmarks)) return 0;
  return Math.max(distance(landmarks[0], landmarks[9]), CONFIG.gesture.palmScaleMin);
}

function normalize(value, min, max) {
  if (!Number.isFinite(value) || max <= min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

// Progress describes the palm, not the pinch. Index and thumb are reserved
// for the thumb-index pinch; middle/ring/pinky determine whether the palm is open.
const FINGERS = [
  { mcp: 9, pip: 10, dip: 11, tip: 12 },
  { mcp: 13, pip: 14, dip: 15, tip: 16 },
  { mcp: 17, pip: 18, dip: 19, tip: 20 },
];

/**
 * Compute the contract openness value from 21 normalized MediaPipe landmarks.
 * This function is pure and has no DOM, camera or Three.js dependency.
 */
export function computeOpenness(landmarks) {
  if (!hasFullHand(landmarks)) return null;
  const palmScale = computePalmScale(landmarks);
  if (!Number.isFinite(palmScale) || palmScale <= 0) return null;
  const wrist = landmarks[0];
  const limits = CONFIG.gesture.openness;
  const fingerScores = [];
  const tipDistanceScores = [];

  for (const finger of FINGERS) {
    const mcp = landmarks[finger.mcp];
    const pip = landmarks[finger.pip];
    const dip = landmarks[finger.dip];
    const tip = landmarks[finger.tip];
    const angle = (
      angleDegrees(mcp, pip, dip)
      + angleDegrees(pip, dip, tip)
    ) / 2;
    const angleScore = normalize(angle, limits.fingerAngleMin, limits.fingerAngleMax);
    const tipRatio = distance(tip, wrist) / palmScale;
    const distanceScore = normalize(tipRatio, limits.tipDistanceMin, limits.tipDistanceMax);
    fingerScores.push((angleScore + distanceScore) / 2);
    tipDistanceScores.push(distanceScore);
  }

  const thumbTip = landmarks[4];
  const thumbIp = landmarks[3];
  const thumbMcp = landmarks[2];
  const indexMcp = landmarks[5];
  const thumbAngle = angleDegrees(thumbMcp, thumbIp, thumbTip);
  const thumbAngleScore = normalize(thumbAngle, limits.fingerAngleMin, limits.fingerAngleMax);
  const thumbDistance = distance(thumbTip, indexMcp) / palmScale;
  const thumbDistanceScore = normalize(
    thumbDistance,
    limits.thumbDistanceMin,
    limits.thumbDistanceMax,
  );
  const thumbScore = (thumbAngleScore + thumbDistanceScore) / 2;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

  const fingerAndTipWeight = limits.weights.finger + limits.weights.tip;
  const raw = (
    limits.weights.finger * mean(fingerScores)
    + limits.weights.tip * mean(tipDistanceScores)
  ) / fingerAndTipWeight;

  return {
    raw: clamp(raw, 0, 1),
    palmScale,
    fingerScores,
    tipDistanceScores,
    thumbScore,
  };
}

export function computePinch(landmarks) {
  if (!hasFullHand(landmarks)) return null;
  const palmScale = computePalmScale(landmarks);
  if (!Number.isFinite(palmScale) || palmScale <= 0) return null;
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  return {
    ratio: distance(thumbTip, indexTip) / palmScale,
    center: {
      x: (thumbTip.x + indexTip.x) / 2,
      y: (thumbTip.y + indexTip.y) / 2,
    },
    palmScale,
    indexReach: distance(indexTip, landmarks[0]) / palmScale,
    indexExtension: (
      distance(indexTip, landmarks[0]) - distance(landmarks[5], landmarks[0])
    ) / palmScale,
  };
}

export function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function rotationFromPinch(dx, dy, videoWidth, videoHeight) {
  const width = Number.isFinite(videoWidth) && videoWidth > 0 ? videoWidth : 640;
  const height = Number.isFinite(videoHeight) && videoHeight > 0 ? videoHeight : 480;
  const minDimension = Math.min(width, height);
  return {
    yaw: (dx * width) / minDimension * CONFIG.gesture.yawPerNorm,
    pitch: (dy * height) / minDimension * CONFIG.gesture.pitchPerNorm,
  };
}
