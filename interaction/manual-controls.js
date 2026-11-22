import { CONFIG } from './config.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function sliderValueToProgress(value, min = 0, max = 1) {
  const numeric = Number(value);
  const low = Number(min);
  const high = Number(max);
  if (!Number.isFinite(numeric) || !Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    return 0;
  }
  return clamp((numeric - low) / (high - low), 0, 1);
}

export function progressToSliderValue(progress, min = 0, max = 1) {
  const low = Number(min);
  const high = Number(max);
  const p = Number.isFinite(progress) ? clamp(progress, 0, 1) : 0;
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return p;
  return low + (high - low) * p;
}

export function progressDeltaForKey(key, shiftKey = false) {
  const step = shiftKey ? CONFIG.manual.fineStep : CONFIG.manual.step;
  if (key === 'ArrowUp' || key === 'ArrowRight') return step;
  if (key === 'ArrowDown' || key === 'ArrowLeft') return -step;
  return null;
}

export function rotationStepForKey(key, shiftKey = false) {
  const scale = shiftKey ? 0.5 : 1;
  if (key === 'ArrowLeft') return { yaw: -CONFIG.manual.keyYawStep * scale, pitch: 0 };
  if (key === 'ArrowRight') return { yaw: CONFIG.manual.keyYawStep * scale, pitch: 0 };
  if (key === 'ArrowUp') return { yaw: 0, pitch: -CONFIG.manual.keyPitchStep * scale };
  if (key === 'ArrowDown') return { yaw: 0, pitch: CONFIG.manual.keyPitchStep * scale };
  return null;
}

function isTextEntry(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = String(target.type || 'text').toLowerCase();
  return !['range', 'button', 'checkbox', 'radio', 'submit', 'reset', 'color'].includes(type);
}

function isInteractiveTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toUpperCase();
  return isTextEntry(target)
    || tag === 'BUTTON'
    || tag === 'A'
    || tag === 'INPUT'
    || tag === 'SELECT'
    || tag === 'TEXTAREA';
}

/**
 * Bind visual-owned DOM nodes to the manual API.
 *
 * This adapter accepts explicit references only. It never queries the DOM and
 * never changes CSS, layout or aria attributes owned by the visual layer.
 */
export function bindManualControls(system, refs = {}) {
  const {
    progressInput = null,
    rotationSurface = null,
    keyboardRoot = null,
    lockButton = null,
    replayButton = null,
  } = refs;

  const listeners = [];
  const subscribe = typeof system.subscribe === 'function';
  let detached = false;
  let dragging = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;
  let unsubscribe = () => {};

  const add = (target, type, handler, options) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  };

  const readSlider = () => {
    if (!progressInput) return 0;
    return sliderValueToProgress(progressInput.value, progressInput.min, progressInput.max);
  };

  const syncSlider = () => {
    if (!progressInput) return;
    if (typeof progressInput.min === 'undefined') progressInput.min = '0';
    if (typeof progressInput.max === 'undefined') progressInput.max = '1';
    progressInput.value = String(progressToSliderValue(system.getProgress(), progressInput.min, progressInput.max));
  };

  const stopAdvance = () => {
    system.stopManualAdvance();
  };

  if (progressInput) {
    add(progressInput, 'input', () => {
      if (!system.setProgress(readSlider())) syncSlider();
    });

    add(progressInput, 'keydown', (event) => {
      if (isTextEntry(event.target)) return;
      const delta = progressDeltaForKey(event.key, event.shiftKey);
      if (delta !== null) {
        event.preventDefault();
        system.adjustProgress(delta);
        syncSlider();
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        system.setProgress(event.key === 'Home' ? 0 : 1);
        syncSlider();
        return;
      }
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        system.startManualAdvance();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        system.requestLock();
        return;
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        system.reset();
      }
    });

    add(progressInput, 'keyup', (event) => {
      if (event.key === ' ' || event.key === 'Spacebar') stopAdvance();
    });

    add(progressInput, 'blur', stopAdvance);
  }

  if (rotationSurface) {
    const onPointerDown = (event) => {
      if (event.button !== 0 && typeof event.button !== 'undefined') return;
      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      if (typeof rotationSurface.setPointerCapture === 'function' && typeof pointerId === 'number') {
        try {
          rotationSurface.setPointerCapture(pointerId);
        } catch {
          // Synthetic or already-released pointers are harmless.
        }
      }
      if (typeof event.preventDefault === 'function') event.preventDefault();
    };

    const onPointerMove = (event) => {
      if (!dragging || (typeof pointerId === 'number' && event.pointerId !== pointerId)) return;
      const dx = Number(event.clientX) - lastX;
      const dy = Number(event.clientY) - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      system.applyManualRotation(
        dx * CONFIG.manual.pointerYawPerPx,
        dy * CONFIG.manual.pointerPitchPerPx,
      );
      if (typeof event.preventDefault === 'function') event.preventDefault();
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      if (typeof rotationSurface.releasePointerCapture === 'function' && typeof pointerId === 'number') {
        try {
          rotationSurface.releasePointerCapture(pointerId);
        } catch {
          // The pointer may already have been released by the browser.
        }
      }
      pointerId = null;
    };

    add(rotationSurface, 'pointerdown', onPointerDown);
    add(rotationSurface, 'pointermove', onPointerMove);
    add(rotationSurface, 'pointerup', onPointerUp);
    add(rotationSurface, 'pointercancel', onPointerUp);
    add(rotationSurface, 'keydown', (event) => {
      if (isTextEntry(event.target)) return;
      const step = rotationStepForKey(event.key, event.shiftKey);
      if (!step) return;
      event.preventDefault();
      system.applyManualRotation(step.yaw, step.pitch);
    });
  }

  if (keyboardRoot) {
    add(keyboardRoot, 'keydown', (event) => {
      if (event.defaultPrevented || isTextEntry(event.target)) return;
      if (event.key === ' ' || event.key === 'Spacebar') {
        if (isInteractiveTarget(event.target)) return;
        event.preventDefault();
        system.startManualAdvance();
        return;
      }
      if (event.key === 'Enter') {
        if (isInteractiveTarget(event.target)) return;
        event.preventDefault();
        system.requestLock();
        return;
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        system.reset();
      }
    });

    add(keyboardRoot, 'keyup', (event) => {
      if (event.key === ' ' || event.key === 'Spacebar') stopAdvance();
    });

    add(keyboardRoot, 'focusout', (event) => {
      if (!event.relatedTarget || !keyboardRoot.contains?.(event.relatedTarget)) stopAdvance();
    });
  }

  if (lockButton) {
    add(lockButton, 'click', () => system.requestLock());
  }

  if (replayButton) {
    add(replayButton, 'click', () => system.reset());
  }

  if (typeof globalThis.addEventListener === 'function') {
    add(globalThis, 'blur', stopAdvance);
  }

  if (subscribe) {
    unsubscribe = system.subscribe((event) => {
      if (event.type === 'progress' || event.type === 'statechange') syncSlider();
    });
  }
  syncSlider();

  return () => {
    if (detached) return;
    detached = true;
    stopAdvance();
    unsubscribe();
    for (const [target, type, handler, options] of listeners) {
      target.removeEventListener(type, handler, options);
    }
    listeners.length = 0;
    if (dragging) {
      dragging = false;
      if (rotationSurface && typeof rotationSurface.releasePointerCapture === 'function' && pointerId !== null) {
        try {
          rotationSurface.releasePointerCapture(pointerId);
        } catch {
          // Ignore synthetic pointer cleanup failures.
        }
      }
    }
  };
}
