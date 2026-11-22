import * as THREE from 'three';
import { ceramics } from '../data/ceramics.js';

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / Math.max(b - a, 0.00001));
  return t * t * (3 - 2 * t);
};

const firing = ceramics.jun.firing;

export function getJunFiringStage(progress) {
  const p = clamp01(progress);
  return firing.stages.find((s) => p <= s.end) || firing.stages[firing.stages.length - 1];
}

async function loadTexture(loader, path, srgb, renderer) {
  const texture = await loader.loadAsync(new URL(path, import.meta.url).href);
  texture.flipY = false;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

/**
 * Jun firing / kiln-transformation controller.
 *
 * The eight calibrated final materials are preserved. This layer only adds a
 * shared clay body, an opaque raw glaze, and a reduction-driven development
 * mask that hands every fragment back to its own final texture at p=1.
 */
export async function createJunFiring({
  renderer, scene, camera, group, model, stage,
  keyLight, topLight, fillLight, initialProgress = 1,
  onProgressRequest = null, showPlay = true
}) {
  const meshes = [];
  model.traverse((object) => {
    if (object.isMesh && object.material && !Array.isArray(object.material)) meshes.push(object);
  });
  if (!meshes.length) throw new Error('Jun firing: no meshes found');

  const bounds = new THREE.Box3();
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) bounds.union(mesh.geometry.boundingBox);
  }
  const yMin = bounds.min.y;
  const yRange = Math.max(bounds.max.y - bounds.min.y, 0.0001);

  const loader = new THREE.TextureLoader();
  const [clayBase, clayNormal, clayOrm] = await Promise.all([
    loadTexture(loader, '../assets/textures/firing/ru-clay-base.webp', true, renderer),
    loadTexture(loader, '../assets/textures/firing/ru-clay-normal.webp', false, renderer),
    loadTexture(loader, '../assets/textures/firing/ru-clay-orm.webp', false, renderer)
  ]);
  for (const t of [clayBase, clayNormal, clayOrm]) t.repeat.set(0.75, 0.75);

  const bodyMaterial = new THREE.MeshStandardMaterial({
    map: clayBase,
    normalMap: clayNormal,
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughnessMap: clayOrm,
    roughness: 0.98,
    metalness: 0,
    color: 0xffffff
  });
  const bodyBaseColor = new THREE.Color(0xe2d9c9);
  bodyMaterial.color.copy(bodyBaseColor);

  const bodyMeshes = [];
  for (const mesh of meshes) {
    const body = new THREE.Mesh(mesh.geometry, bodyMaterial);
    body.name = 'JunFiringBody';
    body.renderOrder = 0;
    body.position.copy(mesh.position);
    body.quaternion.copy(mesh.quaternion);
    body.scale.copy(mesh.scale);
    (mesh.parent || group).add(body);
    bodyMeshes.push(body);
  }

  const uniforms = {
    uProgress: { value: 1 },
    uGlazeLevel: { value: 1.1 },
    uRawRough: { value: 0.72 },
    uWet: { value: 0 },
    uHeat: { value: 0 },
    uYMin: { value: yMin },
    uYRange: { value: yRange }
  };

  const layers = meshes.map((mesh) => {
    const finalMaterial = mesh.material;
    const firingMaterial = finalMaterial.clone();
    firingMaterial.envMapIntensity = finalMaterial.envMapIntensity ?? 1;
    firingMaterial.customProgramCacheKey = () => 'jun-firing-v1';

    const finalRoughness = Number.isFinite(finalMaterial.roughness) ? finalMaterial.roughness : 0.7;
    const finalClearcoat = Number.isFinite(finalMaterial.clearcoat) ? finalMaterial.clearcoat : 0.4;
    const finalClearcoatRoughness = Number.isFinite(finalMaterial.clearcoatRoughness) ? finalMaterial.clearcoatRoughness : 0.3;

    firingMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uProgress = uniforms.uProgress;
      shader.uniforms.uGlazeLevel = uniforms.uGlazeLevel;
      shader.uniforms.uRawRough = uniforms.uRawRough;
      shader.uniforms.uWet = uniforms.uWet;
      shader.uniforms.uHeat = uniforms.uHeat;
      shader.uniforms.uYMin = uniforms.uYMin;
      shader.uniforms.uYRange = uniforms.uYRange;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
varying vec3 vJunLocal;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec3 junOffset = position + normal * 0.00016;
  transformed = junOffset;
  vJunLocal = position;
}`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uProgress;
uniform float uGlazeLevel;
uniform float uRawRough;
uniform float uWet;
uniform float uHeat;
uniform float uYMin;
uniform float uYRange;
varying vec3 vJunLocal;
float junHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float junNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(junHash(i + vec3(0,0,0)), junHash(i + vec3(1,0,0)), f.x),
        mix(junHash(i + vec3(0,1,0)), junHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(junHash(i + vec3(0,0,1)), junHash(i + vec3(1,0,1)), f.x),
        mix(junHash(i + vec3(0,1,1)), junHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
float junY = clamp((vJunLocal.y - uYMin) / uYRange, 0.0, 1.0);
float junEdge = uGlazeLevel
  + sin(vJunLocal.x * 31.0 + vJunLocal.z * 23.0) * 0.006
  + sin(vJunLocal.z * 57.0 - vJunLocal.x * 41.0) * 0.003
  + (vJunLocal.x / 0.48) * 0.010;
if (junY > junEdge) discard;
float junWet = (1.0 - smoothstep(0.0, 0.03, abs(junY - junEdge))) * uWet;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
vec3 junFinal = diffuseColor.rgb;
float junCloud = junNoise(vJunLocal * 37.0) * 0.65
  + junNoise(vJunLocal * 91.0 + vec3(7.1, 3.7, 5.3)) * 0.35;
float junPool = junNoise(vJunLocal * 9.0 + vec3(4.2, 1.1, 7.3));
float junRedBias = smoothstep(-0.02, 0.16, junFinal.r - junFinal.b);
float junBloom = smoothstep(0.64, 0.74, uProgress) * (1.0 - smoothstep(0.84, 0.96, uProgress));
float junLocalP = clamp(uProgress + (junCloud - 0.5) * 0.07 + (junRedBias - 0.5) * 0.028, 0.0, 1.0);
float junDevelop = smoothstep(0.60, 0.84, junLocalP);
junDevelop = max(junDevelop, smoothstep(0.84, 0.96, uProgress));
vec3 junRaw = mix(vec3(0.35, 0.40, 0.36), vec3(0.41, 0.38, 0.43), junPool * 0.65 + junCloud * 0.2);
vec3 junColor = mix(junRaw, junFinal, junDevelop);
junColor = mix(junColor, vec3(0.22, 0.06, 0.07), junRedBias * junBloom * 0.65);
junColor = mix(junColor, vec3(0.23, 0.28, 0.24), junWet * 0.55);
diffuseColor.rgb = junColor;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(uRawRough, roughnessFactor, junDevelop);
roughnessFactor = mix(roughnessFactor, 0.18, junWet * 0.55);`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
float junHeat = uHeat * (0.72 + 0.28 * junNoise(vJunLocal * 24.0 + vec3(2.3, 8.1, 4.7)));
gl_FragColor.rgb += vec3(0.10, 0.028, 0.005) * junHeat;`);
    };

    mesh.material = firingMaterial;
    mesh.renderOrder = 1;
    firingMaterial.needsUpdate = true;

    return {
      mesh,
      finalMaterial,
      firingMaterial,
      finalRoughness,
      finalClearcoat,
      finalClearcoatRoughness
    };
  });

  const baseKeyColor = keyLight.color.clone();
  const baseTopColor = topLight.color.clone();
  const baseFillColor = fillLight.color.clone();
  const baseKeyIntensity = keyLight.intensity;
  const baseTopIntensity = topLight.intensity;
  const baseFillIntensity = fillLight.intensity;
  const baseEnvironmentIntensity = scene.environmentIntensity ?? 1;
  const warmLight = new THREE.Color(0xffb27a);

  const ui = stage.closest('.kiln-stage')?.querySelector('[data-firing-ui]')
    || stage.closest('.model-reserve')?.querySelector('[data-firing-ui]');
  const range = ui?.querySelector('[data-firing-range]');
  const stageLabel = ui?.querySelector('[data-firing-stage]');
  const playButton = ui?.querySelector('[data-firing-play]');

  let progress = clamp01(initialProgress);
  let playing = false;
  let raf = 0;
  let startedAt = 0;
  let startedProgress = 0;
  let disposed = false;

  const setLights = (heat) => {
    keyLight.color.copy(baseKeyColor).lerp(warmLight, heat * 0.35);
    keyLight.intensity = baseKeyIntensity * (1 - heat * 0.18);
    topLight.color.copy(baseTopColor).lerp(warmLight, heat * 0.16);
    topLight.intensity = baseTopIntensity * (1 - heat * 0.10);
    fillLight.intensity = baseFillIntensity * (1 - heat * 0.08);
    scene.environmentIntensity = baseEnvironmentIntensity * (1 - heat * 0.10);
  };

  let lastStageId = '';
  let lastAriaKey = '';
  const updateUi = () => {
    const stageInfo = getJunFiringStage(progress);
    if (range) range.value = progress.toFixed(3);
    if (stageLabel && stageInfo.id !== lastStageId) {
      stageLabel.textContent = stageInfo.label;
      lastStageId = stageInfo.id;
    }
    const ariaKey = `${stageInfo.id}:${Math.round(progress * 100)}`;
    if (range && ariaKey !== lastAriaKey) {
      range.setAttribute('aria-valuetext', `${stageInfo.label}，${progress.toFixed(2)}`);
      lastAriaKey = ariaKey;
    }
    if (playButton) {
      playButton.textContent = playing ? '暂停演示' : '窑变演示';
      playButton.setAttribute('aria-pressed', String(playing));
    }
  };

  const setProgress = (next, render = true) => {
    if (disposed) return;
    progress = clamp01(next);
    uniforms.uProgress.value = progress;

    const dry = smoothstep(0.16, 0.30, progress);
    const level = smoothstep(0.30, 0.48, progress) * 1.1;
    const melt = smoothstep(0.50, 0.70, progress);
    const heat = smoothstep(0.52, 0.62, progress) * (1 - smoothstep(0.66, 0.76, progress));
    const wet = progress > 0.30 && progress < 0.50
      ? Math.sin(Math.min(1, (progress - 0.30) / 0.20) * Math.PI) * 0.9
      : 0;

    uniforms.uGlazeLevel.value = level;
    uniforms.uWet.value = wet;
    uniforms.uHeat.value = heat;

    for (const layer of layers) {
      layer.firingMaterial.clearcoat = 0.10 + (layer.finalClearcoat - 0.10) * melt;
      layer.firingMaterial.clearcoatRoughness = (1 - melt) * 0.55 + layer.finalClearcoatRoughness * melt;
      layer.mesh.visible = progress >= 0.28;
    }

    bodyMaterial.roughness = 0.98 - dry * 0.03;
    bodyMaterial.color.copy(bodyBaseColor).multiplyScalar(1 - heat * 0.02);
    for (const body of bodyMeshes) body.visible = progress < 0.52;

    setLights(heat);
    updateUi();
    if (render) renderer.render(scene, camera);
  };

  const tick = (now) => {
    if (!playing || disposed) return;
    const t = Math.min(1, (now - startedAt) / Math.max(1, firing.duration * 1000));
    setProgress(startedProgress + (1 - startedProgress) * t);
    if (t < 1) {
      raf = requestAnimationFrame(tick);
    } else {
      playing = false;
      updateUi();
    }
  };

  const stop = () => {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(raf);
    updateUi();
  };

  const play = () => {
    if (playing) {
      stop();
      return;
    }
    if (progress >= 0.999) setProgress(0);
    startedProgress = progress;
    startedAt = performance.now();
    playing = true;
    updateUi();
    raf = requestAnimationFrame(tick);
  };

  const onRange = () => {
    stop();
    const value = Number(range.value);
    const accepted = onProgressRequest ? onProgressRequest(value) : true;
    if (accepted !== false) setProgress(value, false);
  };
  const onPlay = () => play();

  if (range) range.addEventListener('input', onRange);
  if (playButton) {
    if (showPlay) playButton.addEventListener('click', onPlay);
    else playButton.hidden = true;
  }
  if (ui) ui.hidden = false;

  setProgress(progress);

  const controller = {
    version: 'qi-jun-firing-v1',
    setProgress,
    getProgress: () => progress,
    getStage: () => getJunFiringStage(progress),
    setQuality: () => {},
    setReducedMotion: () => {},
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      playing = false;
      if (range) range.removeEventListener('input', onRange);
      if (playButton) playButton.removeEventListener('click', onPlay);
      keyLight.color.copy(baseKeyColor);
      keyLight.intensity = baseKeyIntensity;
      topLight.color.copy(baseTopColor);
      topLight.intensity = baseTopIntensity;
      fillLight.color.copy(baseFillColor);
      fillLight.intensity = baseFillIntensity;
      scene.environmentIntensity = baseEnvironmentIntensity;
      for (const layer of layers) {
        layer.mesh.material = layer.finalMaterial;
        layer.firingMaterial.dispose();
      }
      for (const body of bodyMeshes) body.removeFromParent();
      bodyMaterial.map?.dispose();
      bodyMaterial.normalMap?.dispose();
      bodyMaterial.roughnessMap?.dispose();
      bodyMaterial.dispose();
      if (stage.qiFiring === controller) stage.qiFiring = null;
      if (window.QIXI?.scenes?.junFiring === controller) window.QIXI.scenes.junFiring = null;
    }
  };

  stage.qiFiring = controller;
  window.QIXI = window.QIXI || {};
  window.QIXI.scenes = window.QIXI.scenes || {};
  window.QIXI.scenes.junFiring = controller;

  return controller;
}
