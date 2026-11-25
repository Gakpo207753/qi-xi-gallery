import { createHandSkeleton } from './hand-skeleton.js';

// Calibration is intentionally off in the final interface. Camera-ready
// sessions use the accepted default open/close range; skeleton is always on.
const CALIBRATION_ENABLED = false;

const ERROR_TEXT = {
  'permission-denied': '摄像头权限被拒绝。',
  'no-device': '没有检测到摄像头。',
  'insecure-context': '摄像头需要 HTTPS 或 localhost。',
  'camera-busy': '摄像头可能被其他应用占用。',
  unsupported: '当前浏览器不支持摄像头。',
  timeout: '摄像头没有在 8 秒内准备好。',
  'stream-failed': '摄像头画面无法播放。',
  'mediapipe-load-failed': '手部识别脚本或 WASM 加载失败。',
  'model-load-failed': '手部识别模型加载失败。',
  'landmarker-init-failed': '手部识别初始化失败。',
  aborted: '摄像头启动已中止。',
  unknown: '摄像头启动失败。',
};

export function mountGestureControls({ system, onEnable }) {
  const page = document.querySelector('.kiln-page');
  const host = page?.querySelector('.kiln-info');
  if (!page || !host) return { dispose() {} };

  const panel = document.createElement('section');
  panel.className = 'gesture-controls';
  panel.setAttribute('aria-label', '手势控制');
  panel.innerHTML = `
    <header class="gc-head">
      <span class="gc-meta">本地处理 · 不上传</span>
    </header>
    <button class="gc-preview" type="button" data-gc-camera aria-label="启用手势">
      <video muted playsinline aria-label="手势摄像头预览"></video>
      <canvas aria-hidden="true"></canvas>
      <span class="gc-empty">点击启用手势</span>
    </button>
    <p class="gc-status" data-gc-status role="status" aria-live="polite">点击上方画面启用手势。</p>
  `;
  host.prepend(panel);
  page.classList.add('is-gesture-enabled');

  const previewButton = panel.querySelector('[data-gc-camera]');
  const video = panel.querySelector('video');
  const canvas = panel.querySelector('canvas');
  const statusText = panel.querySelector('[data-gc-status]');
  const emptyText = panel.querySelector('.gc-empty');
  const skeleton = createHandSkeleton({ canvas, video });
  let busy = false;

  const render = (snapshot) => {
    const ready = snapshot.cameraStatus === 'ready';
    const paused = snapshot.cameraStatus === 'paused';
    const preparing = snapshot.cameraStatus === 'requesting' || snapshot.cameraStatus === 'loading';
    panel.classList.toggle('is-ready', ready);

    if (ready) {
      if (snapshot.calibrationStatus === 'open' || snapshot.calibrationStatus === 'closed') {
        if (CALIBRATION_ENABLED) {
          statusText.textContent = snapshot.calibrationStatus === 'open'
            ? '校准 ①：张开手掌约 1.2 秒。'
            : '校准 ②：轻轻握拳约 1.2 秒。';
        } else if (system.skipCalibration()) {
          return;
        }
      }
      if (snapshot.trackingLostSince !== null) statusText.textContent = '手部丢失；进度保持，请把手放回画面。';
      else if (snapshot.pinching) statusText.textContent = '捏合中：旋转优先，进度冻结。';
      else if (snapshot.locked) statusText.textContent = '已定器：握拳约 0.3 秒可解锁回退。';
      else statusText.textContent = '识别中：张开推进，握拳回退；捏合旋转。';
      emptyText.textContent = '';
    } else if (paused) {
      statusText.textContent = '摄像头已暂停。点击画面继续。';
      emptyText.textContent = '点击继续';
    } else if (snapshot.cameraStatus === 'error') {
      const message = ERROR_TEXT[snapshot.cameraError?.code] || '摄像头未启用。';
      statusText.textContent = `${message}（${snapshot.cameraError?.code || 'error'}）点击画面重试。`;
      emptyText.textContent = '点击重试';
    } else if (preparing) {
      statusText.textContent = '正在准备摄像头…';
      emptyText.textContent = '正在准备…';
    } else {
      statusText.textContent = '点击上方画面启用手势。';
      emptyText.textContent = '点击启用手势';
    }

    previewButton.disabled = busy || preparing;
    previewButton.setAttribute('aria-label', ready ? '关闭摄像头' : paused ? '继续摄像头' : '启用手势');
    previewButton.setAttribute('aria-pressed', String(ready || paused));
    if (!ready && !paused) skeleton.clear();
  };

  const startOrPause = async () => {
    if (busy) return;
    const status = system.getState().cameraStatus;
    if (status === 'ready') {
      // The frame itself is the only switch: a second click closes the camera.
      system.stopCamera();
      render(system.getState());
      return;
    }
    if (typeof onEnable === 'function') onEnable();
    busy = true;
    render(system.getState());
    try {
      if (status === 'paused') await system.resumeCamera();
      else await system.startCamera({ videoElement: video });
    } finally {
      busy = false;
      render(system.getState());
    }
  };

  previewButton.addEventListener('click', startOrPause);

  const unsubscribe = system.subscribe((event) => {
    if (event.type === 'statechange') render(event.state);
    if (event.type === 'error') render(system.getState());
  });
  const unobserve = system.observeLandmarks((frame) => skeleton.draw(frame));

  const dispose = () => {
    unsubscribe();
    unobserve();
    system.stopCamera();
    panel.remove();
    page.classList.remove('is-gesture-enabled');
    document.body.removeAttribute('data-gesture-preview');
  };

  render(system.getState());
  return { dispose };
}
