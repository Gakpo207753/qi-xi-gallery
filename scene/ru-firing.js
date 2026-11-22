import * as THREE from 'three';
import { ceramics } from '../data/ceramics.js';

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / Math.max(b - a, 0.00001));
  return t * t * (3 - 2 * t);
};

const firing = ceramics.ru.firing;

export function getRuFiringStage(progress) {
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

function spurPositions(meshes, fallbackY) {
  const positions = [];
  for (const mesh of meshes) {
    const attr = mesh.geometry.attributes.position;
    if (!attr) continue;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    const center = box.getCenter(new THREE.Vector3());
    positions.push(center);
    if (positions.length === 5) break;
  }
  while (positions.length < 5) positions.push(new THREE.Vector3(10, fallbackY, 10));
  return positions;
}

export async function createRuFiring({
  renderer, scene, camera, group, model, stage, keyLight, rimLight, fillLight,
  initialProgress = 1, onProgressRequest = null, showPlay = true
}) {
  let mainMesh = null;
  let maxVertices = 0;
  const otherMeshes = [];
  model.traverse((object) => {
    if (!object.isMesh) return;
    const count = object.geometry.attributes.position?.count || 0;
    if (count > maxVertices) {
      maxVertices = count;
      mainMesh = object;
    } else {
      otherMeshes.push(object);
    }
  });
  if (!mainMesh) throw new Error('Ru firing: main mesh not found');

  const originalMaterial = mainMesh.material;
  mainMesh.geometry.computeBoundingBox();
  const box = mainMesh.geometry.boundingBox;
  const yMin = box.min.y;
  const yRange = Math.max(box.max.y - box.min.y, 0.0001);
  const spurs = spurPositions(otherMeshes, yMin);

  const loader = new THREE.TextureLoader();
  const [clayBase, clayNormal, clayOrm, rawNormal, cleanBase, cleanNormal] = await Promise.all([
    loadTexture(loader, '../assets/textures/firing/ru-clay-base.webp', true, renderer),
    loadTexture(loader, '../assets/textures/firing/ru-clay-normal.webp', false, renderer),
    loadTexture(loader, '../assets/textures/firing/ru-clay-orm.webp', false, renderer),
    loadTexture(loader, '../assets/textures/firing/ru-raw-normal.webp', false, renderer),
    loadTexture(loader, '../assets/textures/firing/ru-clean-base.webp', true, renderer),
    loadTexture(loader, '../assets/textures/firing/ru-clean-normal.webp', false, renderer)
  ]);

  for (const t of [clayBase, clayNormal, clayOrm]) t.repeat.set(0.75, 0.75);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    map: clayBase,
    normalMap: clayNormal,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: clayOrm,
    roughness: 1,
    metalness: 0,
    color: 0xffffff
  });

  const bodyBaseColor = new THREE.Color(0xf2eee6);
  bodyMaterial.color.copy(bodyBaseColor);
  const body = new THREE.Mesh(mainMesh.geometry, bodyMaterial);
  body.name = 'RuFiringBody';
  body.renderOrder = 0;
  body.position.copy(mainMesh.position);
  body.quaternion.copy(mainMesh.quaternion);
  body.scale.copy(mainMesh.scale);
  (mainMesh.parent || group).add(body);

  const finalNormal = originalMaterial.normalMap;
  const glazeMaterial = originalMaterial.clone();
  glazeMaterial.envMapIntensity = 0.9;
  glazeMaterial.normalScale = new THREE.Vector2(0.75, 0.75);
  glazeMaterial.clearcoat = 1;
  glazeMaterial.clearcoatRoughness = 0;
  glazeMaterial.customProgramCacheKey = () => 'ru-firing-v1';

  const uniforms = {
    uProgress: { value: 1 },
    uGlaze: { value: 1 },
    uGlazeLevel: { value: 1.1 },
    uMelt: { value: 1 },
    uCrackle: { value: 1 },
    uGloss: { value: 1 },
    uRawRough: { value: 0.68 },
    uWet: { value: 0 },
    uYMin: { value: yMin },
    uYRange: { value: yRange },
    uCleanBase: { value: cleanBase },
    uSpurs: { value: spurs }
  };

  glazeMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uProgress = uniforms.uProgress;
    shader.uniforms.uGlaze = uniforms.uGlaze;
    shader.uniforms.uGlazeLevel = uniforms.uGlazeLevel;
    shader.uniforms.uMelt = uniforms.uMelt;
    shader.uniforms.uCrackle = uniforms.uCrackle;
    shader.uniforms.uGloss = uniforms.uGloss;
    shader.uniforms.uRawRough = uniforms.uRawRough;
    shader.uniforms.uWet = uniforms.uWet;
    shader.uniforms.uYMin = uniforms.uYMin;
    shader.uniforms.uYRange = uniforms.uYRange;
    shader.uniforms.uCleanBase = uniforms.uCleanBase;
    shader.uniforms.uSpurs = uniforms.uSpurs;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vFireLocal;
varying vec3 vFireWorld;
varying vec3 vFireNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec3 fireOffset = position + normal * 0.00012;
  transformed = fireOffset;
  vFireLocal = position;
  vFireWorld = (modelMatrix * vec4(fireOffset, 1.0)).xyz;
  vFireNormal = normalize(mat3(modelMatrix) * normal);
}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uProgress;
uniform float uGlaze;
uniform float uGlazeLevel;
uniform float uMelt;
uniform float uCrackle;
uniform float uGloss;
uniform float uRawRough;
uniform float uWet;
uniform float uYMin;
uniform float uYRange;
uniform sampler2D uCleanBase;
uniform vec3 uSpurs[5];
varying vec3 vFireLocal;
varying vec3 vFireWorld;
varying vec3 vFireNormal;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
float fireY = clamp((vFireLocal.y - uYMin) / uYRange, 0.0, 1.0);
float fireWave = sin(vFireLocal.x * 31.0 + vFireLocal.z * 23.0) * 0.006 + sin(vFireLocal.z * 57.0 - vFireLocal.x * 41.0) * 0.003;
float fireTilt = (vFireLocal.x / 0.081) * 0.012;
float fireEdge = uGlazeLevel + fireTilt + fireWave;
if (fireY > fireEdge) discard;
float fireWetBand = (1.0 - smoothstep(0.0, 0.03, abs(fireY - fireEdge))) * uWet;
fireWetBand = max(fireWetBand, (1.0 - smoothstep(0.0, 0.016, abs(fireY - fireEdge))) * uWet);
for (int i = 0; i < 5; i++) {
  vec2 fireDelta = vFireLocal.xz - uSpurs[i].xz;
  if (vFireLocal.y < 0.028 && dot(fireDelta, fireDelta) < 2.9e-6) discard;
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
vec3 fireFired = diffuseColor.rgb;
vec3 fireClean = texture2D(uCleanBase, vMapUv).rgb;
vec3 fireRaw = mix(fireClean, vec3(0.36, 0.42, 0.36), 0.78);
vec3 fireWetColor = mix(fireRaw, vec3(0.19, 0.26, 0.21), fireWetBand * 1.0);
vec3 fireGlaze = mix(fireWetColor, fireFired, uMelt);
fireGlaze = mix(fireGlaze, fireFired, uCrackle);
fireGlaze = mix(fireClean, fireGlaze, uGlaze);
diffuseColor.rgb = fireGlaze;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(uRawRough, roughnessFactor, uMelt);
roughnessFactor = mix(roughnessFactor, 0.05, fireWetBand * 0.95);`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
vec3 fireView = normalize(cameraPosition - vFireWorld);
vec3 fireNormalWorld = normalize(vFireNormal);
vec3 fireLightDir = normalize(vec3(-0.45, 0.62, 0.64));
vec3 fireHalf = normalize(fireLightDir + fireView);
float fireSpec = pow(max(dot(fireNormalWorld, fireHalf), 0.0), 8.0) * 3.0 * uGloss;
float fireFresnel = pow(1.0 - max(dot(fireNormalWorld, fireView), 0.0), 3.0);
fireSpec *= (0.6 + 0.4 * fireFresnel);
gl_FragColor.rgb += vec3(1.0, 0.995, 0.985) * (fireSpec + 0.02 * uGloss);`);
  };

  mainMesh.material = glazeMaterial;
  mainMesh.renderOrder = 1;
  glazeMaterial.needsUpdate = true;

  const baseKeyColor = keyLight.color.clone();
  const baseRimColor = rimLight.color.clone();
  const baseKeyIntensity = keyLight.intensity;
  const baseRimIntensity = rimLight.intensity;
  const baseFillIntensity = fillLight.intensity;
  const baseEnvironmentIntensity = scene.environmentIntensity ?? 1;
  const warmLight = new THREE.Color(0xffbd88);

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
    keyLight.intensity = baseKeyIntensity * (1 - heat * 0.2);
    rimLight.color.copy(baseRimColor).lerp(warmLight, heat * 0.18);
    rimLight.intensity = baseRimIntensity * (1 - heat * 0.12);
    fillLight.intensity = baseFillIntensity * (1 - heat * 0.08);
    scene.environmentIntensity = baseEnvironmentIntensity * (1 - heat * 0.1);
  };

  let lastStageId = '';
  let lastAriaKey = '';
  const updateUi = () => {
    const stageInfo = getRuFiringStage(progress);
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
      playButton.textContent = playing ? '暂停演示' : '烧成演示';
      playButton.setAttribute('aria-pressed', String(playing));
    }
  };

  const setProgress = (next, render = true) => {
    if (disposed) return;
    progress = clamp01(next);
    uniforms.uProgress.value = progress;

    const dry = smoothstep(0.18, 0.34, progress);
    const glazeCover = smoothstep(0.33, 0.40, progress);
    const glazeLevel = smoothstep(0.34, 0.50, progress) * 1.08;
    const melt = smoothstep(0.70, 0.90, progress);
    const crackle = smoothstep(0.84, 0.97, progress);
    const heat = smoothstep(0.58, 0.78, progress) * (1 - smoothstep(0.88, 0.99, progress));
    const wet = progress > 0.34 && progress < 0.52
      ? Math.sin(Math.min(1, (progress - 0.34) / 0.18) * Math.PI) * 0.9
      : 0;

    uniforms.uGlaze.value = glazeCover;
    uniforms.uGlazeLevel.value = glazeLevel;
    uniforms.uMelt.value = melt;
    uniforms.uCrackle.value = crackle;
    uniforms.uWet.value = wet;
    uniforms.uGloss.value = Math.pow(melt, 0.8);

    glazeMaterial.clearcoat = 0.12 + melt * 0.88;
    glazeMaterial.clearcoatRoughness = (1 - melt) * 0.6;

    const desiredNormal = progress < 0.68 ? rawNormal : (progress < 0.84 ? cleanNormal : finalNormal);
    if (glazeMaterial.normalMap !== desiredNormal) {
      glazeMaterial.normalMap = desiredNormal;
      glazeMaterial.needsUpdate = true;
    }
    glazeMaterial.normalScale.setScalar(progress < 0.84 ? 0.55 : 0.75);

    bodyMaterial.roughness = 0.96 - dry * 0.04;
    bodyMaterial.color.copy(bodyBaseColor).multiplyScalar(1 - heat * 0.02);
    body.visible = progress < 0.54;
    mainMesh.visible = progress >= 0.33;

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
    version: 'qi-firing-v1',
    setProgress,
    getProgress: () => progress,
    getStage: () => getRuFiringStage(progress),
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
      rimLight.color.copy(baseRimColor);
      rimLight.intensity = baseRimIntensity;
      fillLight.intensity = baseFillIntensity;
      scene.environmentIntensity = baseEnvironmentIntensity;
      body.removeFromParent();
      bodyMaterial.map?.dispose();
      bodyMaterial.normalMap?.dispose();
      bodyMaterial.roughnessMap?.dispose();
      bodyMaterial.dispose();
      rawNormal.dispose();
      cleanBase.dispose();
      cleanNormal.dispose();
      glazeMaterial.dispose();
      if (stage.qiFiring === controller) stage.qiFiring = null;
      if (window.QIXI?.scenes?.ruFiring === controller) window.QIXI.scenes.ruFiring = null;
    }
  };

  stage.qiFiring = controller;
  window.QIXI = window.QIXI || {};
  window.QIXI.scenes = window.QIXI.scenes || {};
  window.QIXI.scenes.ruFiring = controller;

  return controller;
}
