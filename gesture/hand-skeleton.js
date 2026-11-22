const CONNECTIONS = [
  [0, 1], [0, 5], [0, 17],
  [5, 9], [9, 13], [13, 17],
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];

const TIPS = new Set([4, 8, 12, 16, 20]);
const FINGERTIPS = new Set([4, 8]);

/**
 * Local-only hand skeleton overlay for the Stage D test page. It draws the
 * ephemeral landmarks supplied by interaction.observeLandmarks() over the
 * mirrored camera preview. Nothing is stored or uploaded.
 */
export function createHandSkeleton({ canvas, video }) {
  const context = canvas.getContext('2d');
  let enabled = true;
  let lastWidth = 0;
  let lastHeight = 0;

  function resize() {
    const rect = video.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (width !== lastWidth || height !== lastHeight) {
      lastWidth = width;
      lastHeight = height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    return { width, height };
  }

  function point(landmark, width, height) {
    return {
      x: (1 - landmark.x) * width,
      y: landmark.y * height,
    };
  }

  function clear() {
    const { width, height } = resize();
    context.clearRect(0, 0, width, height);
  }

  function draw(frame) {
    if (!enabled || !frame?.present || !Array.isArray(frame.landmarks)) {
      clear();
      return;
    }
    const { width, height } = resize();
    context.clearRect(0, 0, width, height);
    const landmarks = frame.landmarks;
    if (landmarks.length < 21) return;

    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.shadowColor = 'rgba(15, 14, 12, .72)';
    context.shadowBlur = 3;
    context.strokeStyle = 'rgba(248, 244, 232, .95)';
    context.lineWidth = 1.8;
    for (const [from, to] of CONNECTIONS) {
      const a = landmarks[from];
      const b = landmarks[to];
      if (!a || !b) continue;
      const pa = point(a, width, height);
      const pb = point(b, width, height);
      context.beginPath();
      context.moveTo(pa.x, pa.y);
      context.lineTo(pb.x, pb.y);
      context.stroke();
    }

    const thumb = point(landmarks[4], width, height);
    const index = point(landmarks[8], width, height);
    context.setLineDash([4, 4]);
    context.strokeStyle = 'rgba(196, 120, 84, .9)';
    context.lineWidth = 1.2;
    context.beginPath();
    context.moveTo(thumb.x, thumb.y);
    context.lineTo(index.x, index.y);
    context.stroke();
    context.setLineDash([]);

    for (let indexPoint = 0; indexPoint < 21; indexPoint += 1) {
      const landmark = landmarks[indexPoint];
      if (!landmark) continue;
      const p = point(landmark, width, height);
      context.beginPath();
      const radius = FINGERTIPS.has(indexPoint) ? 4.2 : TIPS.has(indexPoint) ? 3.2 : 2.1;
      context.arc(p.x, p.y, radius, 0, Math.PI * 2);
      context.fillStyle = TIPS.has(indexPoint)
        ? 'rgba(196, 120, 84, .95)'
        : 'rgba(248, 244, 232, .92)';
      context.fill();
    }
    context.restore();
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled) clear();
  }

  return {
    draw,
    clear,
    setEnabled,
    get enabled() {
      return enabled;
    },
  };
}
