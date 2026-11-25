import { ceramics } from './data/ceramics.js';
import { createInteractionSystem } from './interaction/index.js';
import { mountGestureControls } from './gesture/gesture-controls.js?v=20261120-smooth1';

const app = document.querySelector('#app');
const body = document.body;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let raf = 0;
let transitionTimer = 0;
let motionBound = false;
let currentRoute = null;
let scrollRaf = 0;
let scrollBehaviorBackup = null;
let interaction = null;
let gestureControls = null;
const HIGH_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 1.75);
const ACTIVE_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 1.25);

function disposeInteraction() {
  gestureControls?.dispose();
  gestureControls = null;
  if (interaction) {
    interaction.destroy();
    interaction = null;
  }
}

function requestManualProgress(value) {
  if (!interaction) return false;
  const status = interaction.getState().cameraStatus;
  if (status === 'ready' || status === 'paused') interaction.stopCamera();
  return interaction.setProgress(value);
}

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

const TIMELINE_STAGE_INDEX = { clay: 0, dry: 1, glaze: 2, kiln: 3, reduction: 4, cool: 4 };
let lastTimelineKey = '';
let timelineCachePage = null;
let timelineCacheSteps = [];
let gestureIntro = null;

function beginGestureIntro() {
  if (!interaction || gestureIntro) return;
  const from = Number(interaction.getProgress?.() ?? 0);
  if (!Number.isFinite(from) || from <= 0.001) return;
  gestureIntro = { from, start: performance.now(), duration: 1500 };
  // Reset the input value while the camera is still in manual mode. The
  // firing controller is eased separately so camera start-up and the visual
  // reset cannot fight each other.
  interaction.setProgress?.(0);
}

function sampleGestureIntro(now = performance.now()) {
  if (!gestureIntro) return null;
  const t = Math.min(1, Math.max(0, (now - gestureIntro.start) / gestureIntro.duration));
  const eased = t * t * (3 - 2 * t);
  const value = gestureIntro.from * (1 - eased);
  if (t >= 1) {
    gestureIntro = null;
    return 0;
  }
  return value;
}

function syncFiringTimeline(progress) {
  const page = document.querySelector('.kiln-page');
  if (!page) return;
  if (timelineCachePage !== page) {
    timelineCachePage = page;
    timelineCacheSteps = [...page.querySelectorAll('.timeline-step')];
  }
  const steps = timelineCacheSteps;
  if (!steps.length) return;
  const firingStages = ceramics[page.dataset.palette]?.firing?.stages;
  if (!firingStages) return;
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  const stage = firingStages.find((item) => p <= item.end) || firingStages[firingStages.length - 1];
  const index = TIMELINE_STAGE_INDEX[stage.id]
    ?? Math.min(steps.length - 1, Math.floor(p * steps.length));
  const key = `${page.dataset.palette}:${steps.length}:${index}`;
  if (key === lastTimelineKey) return;
  lastTimelineKey = key;
  steps.forEach((step, i) => {
    step.classList.toggle('active', i === index);
    step.classList.toggle('is-past', i < index);
    if (i === index) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
}

// Direct presentation: interaction owns progress. Writing its value straight to
// the firing controller avoids a second, smoothed writer fighting the range input.
function syncFiringProgress(interaction, state, lastProgress) {
  if (!interaction || !state.firing) return lastProgress;
  const progress = interaction.getProgress();
  if (!Number.isFinite(progress)) return lastProgress;
  if (Math.abs(progress - lastProgress) > 1e-6) {
    state.firing.setProgress(progress, false);
    return progress;
  }
  return lastProgress;
}

const prefetchedAssets = new Set();
const DETAIL_ASSETS = {
  ru: [
    'assets/models/ru-lotus.glb',
    'assets/textures/firing/ru-clay-base.webp',
    'assets/textures/firing/ru-clay-normal.webp',
    'assets/textures/firing/ru-clay-orm.webp',
    'assets/textures/firing/ru-raw-normal.webp',
    'assets/textures/firing/ru-clean-base.webp',
    'assets/textures/firing/ru-clean-normal.webp'
  ],
  jun: [
    'assets/models/jun-calibrated.glb',
    'assets/textures/firing/ru-clay-base.webp',
    'assets/textures/firing/ru-clay-normal.webp',
    'assets/textures/firing/ru-clay-orm.webp'
  ]
};

const CAMERA_METADATA_ASSETS = [
  'assets/mediapipe/vision_bundle.mjs',
  'assets/mediapipe/hand_landmarker.task'
];

function canPrefetch() {
  const connection = navigator.connection;
  return navigator.onLine !== false
    && !connection?.saveData
    && !['slow-2g', '2g'].includes(connection?.effectiveType);
}

function prefetchAsset(url) {
  if (!url || !canPrefetch() || prefetchedAssets.has(url)) return;
  prefetchedAssets.add(url);
  try {
    fetch(url, { cache: 'force-cache', credentials: 'same-origin', priority: 'low' }).catch(() => {});
  } catch {
    // A failed prefetch must never affect navigation or rendering.
  }
}

function prefetchDetailAssets(id) {
  const assets = DETAIL_ASSETS[id];
  if (!assets) return;
  assets.forEach(prefetchAsset);
}

function prefetchCameraMetadata() {
  CAMERA_METADATA_ASSETS.forEach(prefetchAsset);
}

function scheduleIdle(task, timeout = 3500) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(task, { timeout });
  else setTimeout(task, 1800);
}

function bindDetailPrefetch() {
  const items = [...document.querySelectorAll('.archive-item')];
  if (!items.length) return;
  const warm = (event) => {
    const item = event.currentTarget;
    const href = item.getAttribute('href') || '';
    const id = href.match(/#kiln\/(ru|jun)/)?.[1];
    if (id) prefetchDetailAssets(id);
  };
  items.forEach((item) => {
    item.addEventListener('pointerenter', warm, { once: true });
    item.addEventListener('focusin', warm, { once: true });
    item.addEventListener('touchstart', warm, { once: true, passive: true });
  });
  // Warm the small Ru model on home idle; Jun stays intent-triggered because
  // its calibrated model is 35 MB and must not compete with the first paint.
  scheduleIdle(() => prefetchDetailAssets('ru'), 4500);
}

function hoistDetailChrome(stage) {
  const grid = stage.closest('.kiln-stage');
  if (!grid) return;
  const firing = stage.closest('.model-reserve')?.querySelector('[data-firing-ui]');
  if (firing && firing.parentElement !== grid) grid.appendChild(firing);
  const description = grid.querySelector('.kiln-info .info-panel');
  if (description && description.parentElement !== grid) {
    description.classList.add('kiln-description');
    grid.appendChild(description);
  }
  const disclaimer = stage.closest('.model-reserve')?.querySelector('.model-disclaimer');
  if (disclaimer && disclaimer.parentElement !== grid) {
    disclaimer.classList.add('kiln-disclaimer');
    grid.appendChild(disclaimer);
  }
}
const getRoute = (hash = location.hash) => {
  const raw = hash.replace(/^#\/?/, '') || 'home';
  if (raw === 'about') return { name:'home', anchor:'about' };
  if (raw === 'archive') return { name:'home', anchor:'archive' };
  if (raw.startsWith('kiln/')) {
    const id = raw.split('/')[1];
    if (ceramics[id]) return { name:'kiln', id };
    return { name:'home' };
  }
  return { name:'home' };
};
const route = () => getRoute();
const setRoom = (room) => { body.dataset.room = room; };

function normalizeRemovedRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (raw.startsWith('kiln/') && !ceramics[raw.split('/')[1]]) {
    history.replaceState(null, '', '#home');
  }
}

function cancelFastScroll() {
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
  }
  if (scrollBehaviorBackup !== null) {
    document.documentElement.style.scrollBehavior = scrollBehaviorBackup;
    scrollBehaviorBackup = null;
  }
}

function fastScrollToAnchor(anchor, duration = 520) {
  const element = anchor === 'top' ? null : document.getElementById(anchor);
  if (anchor !== 'top' && !element) return;
  const targetY = anchor === 'top' ? 0 : element.getBoundingClientRect().top + window.scrollY;
  cancelFastScroll();
  if (reducedMotion.matches || duration <= 0) {
    window.scrollTo(0, targetY);
    return;
  }
  const startY = window.scrollY;
  const distance = targetY - startY;
  if (Math.abs(distance) < 2) return;
  const root = document.documentElement;
  scrollBehaviorBackup = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  const startedAt = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - startedAt) / duration);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    window.scrollTo(0, startY + distance * eased);
    if (t < 1) {
      scrollRaf = requestAnimationFrame(step);
    } else {
      scrollRaf = 0;
      cancelFastScroll();
    }
  };
  scrollRaf = requestAnimationFrame(step);
}

for (const eventName of ['wheel', 'touchstart']) {
  window.addEventListener(eventName, cancelFastScroll, { passive: true });
}
window.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelFastScroll();
});
const routeTransition = (next) => {
  if (reducedMotion.matches) { cancelFastScroll(); return render(next); }
  cancelFastScroll();
  window.clearTimeout(transitionTimer);
  body.classList.remove('is-transitioning'); void body.offsetWidth; body.classList.add('is-transitioning');
  window.setTimeout(() => render(next), 320);
  transitionTimer = window.setTimeout(() => body.classList.remove('is-transitioning'), 800);
};
const nav = (current) => {
  document.querySelectorAll('[data-nav]').forEach((link) => link.removeAttribute('aria-current'));
  document.querySelector(`[data-nav="${current}"]`)?.setAttribute('aria-current', 'page');
};
const homeTemplate = () => {
  const list = Object.values(ceramics);
  const count = list.length;
  const countCn = ['零', '一', '两', '三', '四'][count] || String(count);
  const total = String(count).padStart(2, '0');
  return `
  <section class="paper-hero" id="top"><div class="page hero-grid">
    <div class="hero-copy reveal"><span class="kicker">DIGITAL CERAMIC MUSEUM / 01</span><h1 class="hero-title">器息<small>QI XI</small></h1><a class="hero-enter" href="#archive">进入器谱 / ENTER ARCHIVE</a></div>

    <div class="scroll-mark"><i></i> SCROLL TO BREATHE</div>
  </div></section>
  <section class="section material-story" id="story"><div class="story-layer orbit" data-parallax="-.1"></div><div class="story-layer glaze" data-parallax="-.2"></div><div class="page story-layout"><div class="story-meta" aria-hidden="true"><span class="kicker">02 / FROM EARTH TO FORM</span><span class="story-stamp">MATERIAL / TIME / TRACE</span></div><div class="story-type" aria-label="02 材料与时间"><div class="story-type-inner"><div class="story-poem"><p class="story-main"><span class="story-line">入窑一色</span><span class="story-line story-line-offset">出窑万彩</span></p></div></div></div><div class="story-ceramic reveal" data-theme="ru" aria-label="02 区瓷器主题展示"><div class="story-ceramic-label"><span data-story-theme-name>汝窑 / RU</span><span data-story-theme-meta>THEME 01 / ${total} · 艺术化复原</span></div><button class="story-vessel" type="button" data-story-vessel aria-label="切换瓷器主题" title="点击切换主题"><img class="story-vessel-photo" data-story-photo src="assets/images/ru-lotus.webp" alt="汝窑莲花温碗，天青釉开片" loading="lazy" decoding="async" /><span class="story-vessel-turn" data-story-turn aria-hidden="true"></span></button><div class="story-stage" data-story-stage aria-hidden="true"></div></div></div></section>
  <section class="section archive-section" id="archive"><div class="page"><div class="section-head reveal"><div><span class="kicker">03 / THE ARCHIVE</span><h2 class="section-title">${countCn}种材质，<br>${countCn}种时间。</h2></div></div><div class="archive-list">${list.map((c) => `<a class="archive-item reveal" href="#kiln/${c.id}"><span class="archive-no">${c.index}</span><span class="archive-name">${c.name}</span><span class="archive-object ${c.palette}" aria-hidden="true"></span><span class="archive-cue">${c.cue}</span><span class="archive-arrow">↗</span></a>`).join('')}</div></div></section>
  <section class="section about" id="about"><div class="page about-grid"><div class="reveal"><span class="kicker">PROJECT NOTE</span><h2>让材料<br>拥有时间。</h2></div><div class="reveal"><div class="meta-list"><div>FORMAT<span>Digital Exhibition</span></div><div>STATUS<span>Visual Proposal V2</span></div><div>SPACE<span>Paper Room / Kiln Room</span></div><div>YEAR<span>2026</span></div></div></div></div></section>`;
};
const ruModelStage = `<div class="model-reserve is-live" aria-label="汝窑莲花温碗三维模型"><div class="model-stage is-fullscreen" data-model-stage data-model-fullscreen><span class="model-loading">LOADING / 3D</span><div class="model-fallback"><img src="assets/images/ru-lotus.webp" alt="汝窑莲花温碗，天青釉开片细节" /></div></div><div class="model-hit" data-model-hit tabindex="0" role="application" aria-label="汝窑莲花温碗三维模型：拖拽或方向键旋转，加减键缩放"></div><span class="model-disclaimer">艺术化复原 · 非文物复制</span><div class="firing-ui" data-firing-ui hidden><div class="firing-head"><span class="firing-stage" data-firing-stage aria-live="polite">成品 · 冷却</span><button class="firing-play" type="button" data-firing-play aria-pressed="false">烧成演示</button></div><input class="firing-range" data-firing-range type="range" min="0" max="1" step="0.001" value="1" aria-label="烧成进度，0 为泥坯，1 为成品" /></div></div>`;
const junModelStage = `<div class="model-reserve is-live is-jun" aria-label="钧窑玫瑰紫釉葵花式花盆三维模型"><div class="model-stage is-fullscreen" data-jun-stage data-model-fullscreen><span class="model-loading" data-jun-loading>LOADING / 3D</span></div><div class="model-hit" data-model-hit tabindex="0" role="application" aria-label="钧窑玫瑰紫釉葵花式花盆三维模型：拖拽或方向键旋转，加减键缩放"></div><span class="model-disclaimer">校准材质 · 艺术化复原</span><div class="firing-ui" data-firing-ui hidden><div class="firing-head"><span class="firing-stage" data-firing-stage aria-live="polite">成品 · 冷却</span><button class="firing-play" type="button" data-firing-play aria-pressed="false">窑变演示</button></div><input class="firing-range" data-firing-range type="range" min="0" max="1" step="0.001" value="1" aria-label="窑变进度，0 为泥坯，1 为成品" /></div></div>`;
const placeholderStage = `<div class="model-reserve" aria-label="未来陶瓷模型接入区"><div class="model-cross"></div><div class="model-shadow"></div><div class="model-placeholder"></div></div>`;
const kilnTemplate = (c) => `
  <section class="kiln-page" data-palette="${c.palette}" id="top"><div class="page"><div class="kiln-top"><div><a class="back-link" href="#home">← 返回纸室 / PAPER ROOM</a><h1 class="kiln-title">${esc(c.name)}</h1></div><p class="kiln-intro">${esc(c.note)}</p></div><div class="kiln-stage">${c.id === 'ru' ? ruModelStage : c.id === 'jun' ? junModelStage : placeholderStage}<div class="kiln-info"><div class="info-panel" data-info-panel id="info-panel" aria-live="polite">${c.id === 'ru' ? '<strong>汝窑莲花温碗</strong><span>天青釉色，开片细密；器身作莲瓣起伏，下承圈足。</span>' : c.id === 'jun' ? '<strong>钧窑玫瑰紫釉葵花式花盆</strong><span>六瓣葵花式口，外撇折沿；玫瑰紫与天青釉相交处现出窑变过渡。</span>' : '<strong>一件器物的静默入口</strong><span>形与光将在这里慢慢显现。此处保留一块安静的位置，等待器物真正抵达。</span>'}</div><div class="control-hint">${c.id === 'ru' ? '<b>3D STUDY</b><span>拖动旋转 · 滚轮缩放 · 天青开片细节</span>' : c.id === 'jun' ? '<b>3D STUDY</b><span>拖动旋转 · 滚轮缩放 · 八区窑变</span>' : '<b>INTERACTION RESERVED</b><span>未来：手势开合控制阶段 · 捏合控制观察角度</span>'}</div></div></div><div class="timeline" aria-label="工艺阶段">${c.stage.map((s,i) => `<div class="timeline-step ${i===0?'active':''}"${i===0?' aria-current="step"':''}>${String(i+1).padStart(2,'0')} / ${esc(s)}</div>`).join('')}</div><div class="kiln-switcher">${Object.values(ceramics).map((x) => `<a href="#kiln/${x.id}" ${x.id===c.id?'aria-current="page"':''}>${x.name}</a>`).join('')}</div></div></section>`;


function bindKiln() {
  const tabs = [...document.querySelectorAll('[data-info]')];
  const panel = document.querySelector('[data-info-panel]');
  if (!tabs.length || !panel) return;
  const palette = document.querySelector('.kiln-page')?.dataset.palette;
  const panels = {
    ru: { 看: ['汝窑莲花温碗','天青釉色，开片细密；器身作莲瓣起伏，下承圈足。'], 工:['工艺结构预留','未来将接入与该器种对应的阶段、工艺和材质变化。'], 火:['火候状态预留','未来将显示烧成进度、温度与阶段反馈。'], 辨:['资料与来源预留','未来将接入经过核验的文献、器物与来源信息。'] },
    jun: { 看: ['钧窑玫瑰紫釉葵花式花盆','六瓣葵花式口，外撇折沿；玫瑰紫与天青釉相接处现出窑变过渡，底部可见渗水孔。'],
           工: ['八区釉色分区','口沿、内壁与外壁六瓣各自使用独立底色与粗糙度分区；形制与开片为艺术化复原。'],
           火: ['窑变位置待考','呈色与窑变位置随火候偏移，不可复制；具体温度与气氛尚无实测数据。'],
           辨: ['来源与边界','几何为用户白模校准，材质取自同件器物的公开数字资料；精确度边界见交付记录，不作为文物复原依据。'] }
  };
  const labels = panels[palette] || panels.ru;
  const select = (button) => {
    tabs.forEach((tab) => {
      tab.setAttribute('aria-selected', tab === button ? 'true' : 'false');
      tab.tabIndex = tab === button ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', button.id);
    const [title, copy] = labels[button.dataset.info];
    panel.innerHTML = `<strong>${title}</strong><span>${copy}</span>`;
  };
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => select(button));
    button.addEventListener('keydown', (event) => {
      let next = null;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      if (next !== null) {
        event.preventDefault();
        tabs[next].focus();
        select(tabs[next]);
      }
    });
  });
}
function bindStoryTheme() {
  const object = document.querySelector('.story-ceramic');
  if (!object) return;
  // Blue-and-white is archived in data/ceramics-blue.js. Add its label and photo here when restoring.
  const labels = { ru:'汝窑 / RU', jun:'钧窑 / JUN' };
  const photos = {
    ru: ['assets/images/ru-lotus.webp', '汝窑莲花温碗，天青釉开片'],
    jun: ['assets/images/jun-planter.webp', '钧窑玫瑰紫釉葵花式花盆']
  };
  const photo = document.querySelector('[data-story-photo]');
  const turnEl = document.querySelector('[data-story-turn]');
  const themes = Object.keys(photos);
  const TURN = { cols: 8, rows: 5, frames: 40, loaded: false, img: null };
  let turnRaf = 0;
  const paintTurn = () => {
    if (!turnEl || !TURN.loaded) return;
    const w = turnEl.clientWidth || 0;
    if (!w) return;
    const step = 360 / TURN.frames;
    const raw = Math.round((window.scrollY * 0.22) / step);
    const i = ((raw % TURN.frames) + TURN.frames) % TURN.frames;
    if (i === paintTurn.last) return;
    paintTurn.last = i;
    turnEl.style.backgroundSize = `${w * TURN.cols}px ${w * TURN.rows}px`;
    turnEl.style.backgroundPosition = `${-(i % TURN.cols) * w}px ${-Math.floor(i / TURN.cols) * w}px`;
    turnEl.dataset.frame = String(i);
  };
  paintTurn.last = -1;
  const loadTurn = () => {
    if (TURN.img) return;
    TURN.img = new Image();
    TURN.img.decoding = 'async';
    TURN.img.onload = () => {
      TURN.loaded = true;
      if (turnEl) turnEl.style.backgroundImage = 'url("assets/images/jun-turn.webp")';
      object.classList.add('is-turning');
      paintTurn.last = -1;
      paintTurn();
    };
    TURN.img.src = 'assets/images/jun-turn.webp';
  };
  window.addEventListener('scroll', () => {
    if (!TURN.loaded || object.dataset.theme !== 'jun' || turnRaf) return;
    turnRaf = requestAnimationFrame(() => { turnRaf = 0; paintTurn(); });
  }, { passive: true });
  window.addEventListener('resize', () => { paintTurn.last = -1; paintTurn(); });
  const setTheme = (theme) => {
    object.dataset.theme = theme;
    document.querySelector('[data-story-theme-name]').textContent = labels[theme];
    const index = String(themes.indexOf(theme) + 1).padStart(2, '0');
    const total = String(themes.length).padStart(2, '0');
    document.querySelector('[data-story-theme-meta]').textContent = `THEME ${index} / ${total} · 艺术化复原`;
    const shot = photos[theme];
    if (photo && shot) { photo.src = shot[0]; photo.alt = shot[1]; }
    if (theme === 'jun') loadTurn();
  };
  const cycle = () => {
    const next = themes[(themes.indexOf(object.dataset.theme) + 1) % themes.length];
    setTheme(next);
  };
  document.querySelector('[data-story-vessel]')?.addEventListener('click', cycle);
  document.querySelector('[data-story-vessel]')?.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); cycle(); } });
}
function bindMotion() {
  const reveal = new IntersectionObserver((entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add('is-visible')), { threshold:.01 });
  document.querySelectorAll('.reveal').forEach((el) => reveal.observe(el));
  const updateReveal = () => {
    const viewport = window.innerHeight || 800;
    const scrollY = window.scrollY;
    document.querySelectorAll('.reveal').forEach((el) => {
      const rect = el.getBoundingClientRect();
      const progress = reducedMotion.matches ? 1 : Math.max(0, Math.min(1, (viewport * .86 - rect.top) / (viewport * .52)));
      const depth = reducedMotion.matches || el.closest('.material-story') ? 0 : Math.max(-18, Math.min(18, (viewport * .52 - rect.top) * .055));
      el.style.setProperty('--reveal-progress', progress.toFixed(3));
      el.style.setProperty('--reveal-depth', `${depth.toFixed(1)}px`);
    });
    const story = document.querySelector('.material-story');
    const storyType = story ? story.querySelector('.story-type') : null;
    if (story && storyType) {
      if (reducedMotion.matches) {
        storyType.style.setProperty('--type-y', '0vh');
        storyType.style.setProperty('--type-opacity', '1');
        storyType.style.setProperty('--main-y', '0vh');
        storyType.style.setProperty('--sub-y', '0vh');
      } else {
        const viewport = window.innerHeight || 800;
        const storyTop = story.getBoundingClientRect().top + scrollY;
        const start = storyTop - viewport * .8;
        const span = viewport * 1.6;
        const progress = Math.max(0, Math.min(1, (scrollY - start) / span));
        const mobile = window.matchMedia('(max-width: 900px)').matches;
        const fadeStart = mobile ? .8 : .9;
        const fade = Math.max(0, Math.min(1, (fadeStart - progress) / .12));
        const travel = mobile ? 18 : 58;
        const origin = mobile ? 10 : 30;
        storyType.style.setProperty('--type-y', `${(origin - progress * travel).toFixed(2)}vh`);
        storyType.style.setProperty('--type-opacity', fade.toFixed(3));
        storyType.style.setProperty('--main-y', `${(progress * (mobile ? -1.2 : -5.0)).toFixed(2)}vh`);
        storyType.style.setProperty('--sub-y', `${(progress * (mobile ? 0.8 : 3.0)).toFixed(2)}vh`);
      }
    }
  };
  updateReveal();
  if (reducedMotion.matches || motionBound) return;
  motionBound = true;
  window.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { document.documentElement.style.setProperty('--scroll-y', `${window.scrollY}px`); document.documentElement.style.setProperty('--scroll-turn', `${(window.scrollY * .22) % 360}deg`); updateReveal(); }); }, { passive:true });
}
let ruViewer = null;

function disposeRuViewer() {
  if (!ruViewer) return;
  const state = ruViewer;
  ruViewer = null;
  if (state.firing?.dispose) state.firing.dispose();
  cancelAnimationFrame(state.raf);
  if (state.observer) state.observer.disconnect();
  if (state.viewObserver) state.viewObserver.disconnect();
  window.removeEventListener('resize', state.resize);
  if (state.surface && state.handlers) {
    const { down, move, up, wheel, onKey } = state.handlers;
    state.surface.removeEventListener('pointerdown', down);
    state.surface.removeEventListener('pointermove', move);
    state.surface.removeEventListener('pointerup', up);
    state.surface.removeEventListener('pointercancel', up);
    state.surface.removeEventListener('wheel', wheel);
    state.surface.removeEventListener('keydown', onKey);
  }
  if (state.toggle && state.toggleHandler) state.toggle.removeEventListener('click', state.toggleHandler);
  if (state.pmrem) state.pmrem.dispose();
  if (state.renderer) {
    state.renderer.dispose();
    if (state.renderer.forceContextLoss) state.renderer.forceContextLoss();
  }
  if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
}

const RU_GLAZE_SPECULAR = 3.0;
const RU_GLAZE_POWER = 8;
const RU_GLAZE_AMBIENT = 0.02;
const GESTURE_FIRING_TURN_RANGE = Math.PI * 0.375;

function applyRuGlazeSpecular(material) {
  material.clearcoat = 1.0;
  material.clearcoatRoughness = 0.0;
  material.onBeforeCompile = (shader) => {
    if (!shader.fragmentShader.includes('#include <opaque_fragment>')) return;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRuWorldPos;\nvarying vec3 vRuWorldNormal;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvRuWorldNormal = normalize(mat3(modelMatrix) * objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRuWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const specularLayer = '#include <opaque_fragment>\n' +
      'vec3 ruV = normalize(cameraPosition - vRuWorldPos);\n' +
      'vec3 ruN = normalize(vRuWorldNormal);\n' +
      'vec3 ruL = normalize(vec3(-0.45, 0.62, 0.64));\n' +
      'vec3 ruH = normalize(ruL + ruV);\n' +
      'float ruSpec = pow(max(dot(ruN, ruH), 0.0), ' + RU_GLAZE_POWER.toFixed(1) + ') * ' + RU_GLAZE_SPECULAR.toFixed(3) + ';\n' +
      'float ruFres = pow(1.0 - max(dot(ruN, ruV), 0.0), 3.0);\n' +
      'ruSpec *= (0.6 + 0.4 * ruFres);\n' +
      'gl_FragColor.rgb += vec3(1.0, 0.995, 0.985) * (ruSpec + ' + RU_GLAZE_AMBIENT.toFixed(3) + ');';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRuWorldPos;\nvarying vec3 vRuWorldNormal;')
      .replace('#include <opaque_fragment>', specularLayer);
  };
  material.needsUpdate = true;
}

async function mountRuViewer(stage, mode = 'detail') {
  if (!stage || ruViewer) return;
  stage.classList.add('is-loading');
  let THREE;
  let GLTFLoader;
  let RoomEnvironment;
  try {
    THREE = await import('three');
    ({ GLTFLoader } = await import('./assets/vendor/three/GLTFLoader.js'));
    ({ RoomEnvironment } = await import('./assets/vendor/three/RoomEnvironment.js'));
  } catch (error) {
    stage.classList.remove('is-loading');
    stage.classList.add('is-static');
    return;
  }
  if (!stage.isConnected || ruViewer) return;
  hoistDetailChrome(stage);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(HIGH_PIXEL_RATIO);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x000000, 0);
  const fullBleed = stage.hasAttribute('data-model-fullscreen');
  const canvasHost = fullBleed ? stage.closest('.kiln-page') : stage;
  canvasHost.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  if (fullBleed) canvas.classList.add('model-canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '汝窑莲花温碗三维模型：拖拽或方向键旋转，加减键缩放');
  canvas.tabIndex = fullBleed ? -1 : 0;
  const surface = stage.parentElement?.querySelector('[data-model-hit]') || canvas;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.005).texture;
  scene.environmentIntensity = 0.65;

  const camera = new THREE.PerspectiveCamera(28, 1, 0.005, 5);
  let lookY = 0.05;
  const keyLight = new THREE.DirectionalLight(0xfff6e8, 2.2);
  keyLight.position.set(0.25, 0.45, 0.35);
  const rimLight = new THREE.DirectionalLight(0xcfe0e8, 1.1);
  rimLight.position.set(-0.35, 0.25, -0.25);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
  fillLight.position.set(0, 0.1, -0.4);
  scene.add(keyLight, rimLight, fillLight, new THREE.HemisphereLight(0xffffff, 0x8a8474, 0.55));

  const group = new THREE.Group();
  scene.add(group);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const isOverCeramic = (event) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    camera.updateMatrixWorld();
    group.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObject(group, true).length > 0;
  };

  let dragging = false;
  let gestureControlled = false;
  let rotX = 0;
  let rotY = 0;
  let targetX = 0;
  let targetY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastFiringProgress = -1;
  let lastMotionAt = 0;
  let needsRender = true;
  let renderedProgress = NaN;
  let renderedRotX = NaN;
  let renderedRotY = NaN;

  const resize = () => {
    const w = fullBleed ? window.innerWidth : stage.clientWidth;
    const h = fullBleed ? window.innerHeight : stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  };
  resize();
  window.addEventListener('resize', resize, { passive:true });

  const applyRenderScale = (active) => {
    const target = active ? ACTIVE_PIXEL_RATIO : HIGH_PIXEL_RATIO;
    if (Math.abs(renderer.getPixelRatio() - target) < 0.01) return;
    renderer.setPixelRatio(target);
    resize();
    needsRender = true;
  };

  const state = { renderer, pmrem, canvas, surface, raf: 0, observer: null, handlers: null };
  state.resize = resize;
  state.applyGestureRotation = (yaw, pitch) => {
    if (mode !== 'detail') return;
    gestureControlled = true;
    targetY -= yaw * 1.7;
    targetX = Math.max(-1.15, Math.min(1.15, targetX + pitch * 2.2));
  };
  ruViewer = state;

  let inView = true;
  let lastStoryTurn = null;
  if (typeof IntersectionObserver !== 'undefined') {
    state.viewObserver = new IntersectionObserver((entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      if (inView) lastStoryTurn = null;
    }, { threshold: 0 });
    state.viewObserver.observe(stage);
  }
  const animate = (now = performance.now()) => {
    if (!ruViewer) return;
    state.raf = requestAnimationFrame(animate);
    const cameraStatus = interaction?.getState?.().cameraStatus;
    const cameraActive = cameraStatus === 'ready';
    if (cameraActive && now - lastMotionAt < 14.5) return;
    lastMotionAt = now;
    if (mode === 'detail') {
      applyRenderScale(cameraActive || cameraStatus === 'requesting' || cameraStatus === 'loading' || Boolean(gestureIntro));
    }
    if (mode === 'story') {
      const ceramic = stage.closest('.story-ceramic');
      const active = !ceramic || ceramic.dataset.theme === 'ru';
      if (active && inView) {
        const turn = reducedMotion.matches ? 0 : (window.scrollY * 0.22) * Math.PI / 180;
        if (turn !== lastStoryTurn) {
          lastStoryTurn = turn;
          group.rotation.set(0.07, turn, 0);
          renderer.render(scene, camera);
        }
      }
    } else if (inView) {
      let introProgress = null;
      if (gestureIntro) {
        introProgress = sampleGestureIntro(now);
        if (state.firing) state.firing.setProgress(introProgress, false);
        lastFiringProgress = introProgress;
      } else if (interaction) {
        lastFiringProgress = syncFiringProgress(interaction, state, lastFiringProgress);
      }
      if (interaction) {
        const rotation = interaction.consumeRotation();
        if (rotation.yaw !== 0 || rotation.pitch !== 0) {
          state.applyGestureRotation(rotation.yaw, rotation.pitch);
        }
      }
      if (!dragging && !gestureControlled) {
        targetX += (0 - targetX) * 0.1;
        targetY += (0 - targetY) * 0.1;
      }
      rotX += (targetX - rotX) * 0.12;
      rotY += (targetY - rotY) * 0.12;
      const progress = introProgress ?? state.firing?.getProgress?.() ?? 0;
      const changed = needsRender
        || Math.abs(progress - renderedProgress) > 1e-5
        || Math.abs(rotX - renderedRotX) > 1e-5
        || Math.abs(rotY - renderedRotY) > 1e-5;
      if (changed) {
        syncFiringTimeline(progress);
        const firingTurn = progress * GESTURE_FIRING_TURN_RANGE;
        group.rotation.set(0.07 + rotX, firingTurn + rotY, 0);
        renderer.render(scene, camera);
        renderedProgress = progress;
        renderedRotX = rotX;
        renderedRotY = rotY;
        needsRender = false;
      }
    }
  };

  const down = (event) => {
    if (mode !== 'detail') return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    surface.focus?.({ preventScroll:true });
    if (surface.setPointerCapture) {
      try { surface.setPointerCapture(event.pointerId); } catch (error) { /* synthetic pointer */ }
    }
  };
  const move = (event) => {
    if (mode !== 'detail' || !dragging) return;
    targetY += (event.clientX - lastX) * 0.011;
    targetX += (event.clientY - lastY) * 0.008;
    targetX = Math.max(-1.15, Math.min(1.15, targetX));
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const up = (event) => {
    if (mode !== 'detail' || !dragging) return;
    dragging = false;
    if (surface.releasePointerCapture) {
      try { surface.releasePointerCapture(event.pointerId); } catch (error) { /* synthetic pointer */ }
    }
  };
  const zoomBy = (delta) => {
    camera.position.z = Math.max(0.12, Math.min(0.9, camera.position.z + delta));
    camera.lookAt(0, lookY, 0);
  };
  const wheel = (event) => {
    if (mode !== 'detail' || !isOverCeramic(event)) return;
    event.preventDefault();
    zoomBy(event.deltaY * 0.0004);
    needsRender = true;
  };
  const onKey = (event) => {
    if (mode !== 'detail') return;
    const step = event.shiftKey ? 0.06 : 0.18;
    let handled = true;
    if (event.key === 'ArrowLeft') targetY -= step;
    else if (event.key === 'ArrowRight') targetY += step;
    else if (event.key === 'ArrowUp') targetX -= step * 0.7;
    else if (event.key === 'ArrowDown') targetX += step * 0.7;
    else if (event.key === '+' || event.key === '=') zoomBy(-0.02);
    else if (event.key === '-') zoomBy(0.02);
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    targetX = Math.max(-1.15, Math.min(1.15, targetX));
    needsRender = true;
  };
  surface.addEventListener('pointerdown', down);
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', up);
  surface.addEventListener('pointercancel', up);
  surface.addEventListener('wheel', wheel, { passive: false });
  surface.addEventListener('keydown', onKey);

  state.handlers = { down, move, up, wheel, onKey };

  state.observer = new ResizeObserver(resize);
  state.observer.observe(stage);
  animate();

  new GLTFLoader().load('./assets/models/ru-lotus.glb', async (gltf) => {
    if (!ruViewer) return;
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    model.position.y += size.y * 0.5;
    group.add(model);

    const fov = camera.fov * Math.PI / 180;
    const fitH = mode === 'story' ? 1.06 : 1.72;
    const fitW = mode === 'story' ? 1.04 : 1.38;
    const distH = size.y * fitH / (2 * Math.tan(fov / 2));
    const distW = size.x * fitW / (2 * Math.tan(fov / 2) * Math.max(camera.aspect, 0.6));
    camera.position.set(0, size.y * 0.6, Math.max(distH, distW));
    lookY = size.y * 0.46;
    camera.lookAt(0, lookY, 0);

    model.traverse((object) => {
      if (object.isMesh && object.material) {
        object.material.envMapIntensity = 0.9;
        if (object.material.isMeshPhysicalMaterial) {
          if (mode === 'story') applyRuGlazeSpecular(object.material);
          const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
          for (const key of ['map', 'normalMap', 'roughnessMap']) {
            const texture = object.material[key];
            if (texture) {
              texture.anisotropy = Math.min(8, maxAnisotropy);
              texture.needsUpdate = true;
            }
          }
        }
        object.material.needsUpdate = true;
      }
    });

    if (mode === 'detail') {
      try {
        const { createRuFiring } = await import('./scene/ru-firing.js');
        state.firing = await createRuFiring({
          renderer, scene, camera, group, model, stage,
          keyLight, rimLight, fillLight,
          initialProgress: interaction?.getProgress?.() ?? 1,
          showPlay: false,
          onProgressRequest: requestManualProgress
        });
      } catch (error) {
        console.warn('Ru firing animation unavailable', error);
        if (model.getObjectByName('LotusBowl_continuous_wall')?.material?.isMeshPhysicalMaterial) {
          applyRuGlazeSpecular(model.getObjectByName('LotusBowl_continuous_wall').material);
        }
      }
      try {
        scene.updateMatrixWorld(true);
        if (typeof renderer.compileAsync === 'function') {
          await renderer.compileAsync(scene, camera);
        }
      } catch {
        // Shader compilation warm-up is optional.
      }
      needsRender = true;
      scheduleIdle(prefetchCameraMetadata, 3200);
    }

    stage.classList.remove('is-loading');
    stage.classList.add('is-ready');
    needsRender = true;
    if (fullBleed) canvas.classList.add('is-ready');
    if (mode === 'story') {
      const ceramic = stage.closest('.story-ceramic');
      if (ceramic) ceramic.classList.add('is-live');
    }
  }, undefined, () => {
    stage.classList.remove('is-loading');
    stage.classList.add('is-static');
  });
}

/* ---------------------------------------------------------------------------
   钧窑 / JUN — 与汝窑同一套交互（拖动旋转 · 滚轮缩放 · 键盘）
   资产：assets/models/jun-calibrated.glb
   几何按网页预算简化，8 张底色贴图与 UV 与交付文件逐字节一致。
   光泽度为验收确认值：粗糙度 ×0.76 · 清漆 ×2.00 · 清漆粗糙度 ×0.60
--------------------------------------------------------------------------- */
const JUN_MODEL_URL = './assets/models/jun-calibrated.glb';
const JUN_GLOSS = { roughness: 0.76, clearcoat: 2.0, clearcoatRoughness: 0.6 };
let junViewer = null;

function disposeJunViewer() {
  if (!junViewer) return;
  const state = junViewer;
  junViewer = null;
  cancelAnimationFrame(state.raf);
  if (state.firing?.dispose) state.firing.dispose();
  state.firing = null;
  if (state.observer) state.observer.disconnect();
  window.removeEventListener('resize', state.resize);
  if (state.surface && state.handlers) {
    const { down, move, up, wheel, onKey } = state.handlers;
    state.surface.removeEventListener('pointerdown', down);
    state.surface.removeEventListener('pointermove', move);
    state.surface.removeEventListener('pointerup', up);
    state.surface.removeEventListener('pointercancel', up);
    state.surface.removeEventListener('wheel', wheel);
    state.surface.removeEventListener('keydown', onKey);
  }
  if (state.pmrem) state.pmrem.dispose();
  if (state.env) state.env.dispose();
  if (state.renderer) {
    state.renderer.dispose();
    if (state.renderer.forceContextLoss) state.renderer.forceContextLoss();
  }
  if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
}

async function mountJunViewer(stage) {
  if (!stage || junViewer) return;
  stage.classList.add('is-loading');
  let THREE;
  let GLTFLoader;
  try {
    THREE = await import('three');
    ({ GLTFLoader } = await import('./assets/vendor/three/GLTFLoader.js'));
  } catch (error) {
    stage.classList.remove('is-loading');
    stage.classList.add('is-static');
    return;
  }
  if (!stage.isConnected || junViewer) return;
  hoistDetailChrome(stage);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(HIGH_PIXEL_RATIO);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.LinearToneMapping;   /* 与交付渲染的 Standard 转换一致 */
  renderer.toneMappingExposure = 2.2;               /* 按交付渲染亮度标定 */
  renderer.setClearColor(0x000000, 0);
  const fullBleed = stage.hasAttribute('data-model-fullscreen');
  const canvasHost = fullBleed ? stage.closest('.kiln-page') : stage;
  canvasHost.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  if (fullBleed) canvas.classList.add('model-canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '钧窑玫瑰紫釉葵花式花盆三维模型：拖拽或方向键旋转，加减键缩放');
  canvas.tabIndex = fullBleed ? -1 : 0;
  const surface = stage.parentElement?.querySelector('[data-model-hit]') || canvas;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  /* .blend 世界光：白 0.2833 */
  const envPixels = new Uint8Array(64 * 32 * 4).fill(255);
  const envTex = new THREE.DataTexture(envPixels, 64, 32, THREE.RGBAFormat);
  envTex.needsUpdate = true;
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  const env = pmrem.fromEquirectangular(envTex).texture;
  envTex.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.2833;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
  let lookY = 0.36;

  /* .blend 三盏面光的朝向，用平行光近似 */
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
  keyLight.position.set(-0.52, 0.69, -0.50);
  const topLight = new THREE.DirectionalLight(0xffffff, 3.0);
  topLight.position.set(0, 0.16, -0.99);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.9);
  fillLight.position.set(0.82, 0.52, -0.23);
  scene.add(keyLight, topLight, fillLight);

  const group = new THREE.Group();
  scene.add(group);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const isOverCeramic = (event) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    camera.updateMatrixWorld();
    group.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObject(group, true).length > 0;
  };

  let dragging = false;
  let gestureControlled = false;
  let rotX = 0;
  let rotY = 0;
  let targetX = 0;
  let targetY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastFiringProgress = -1;
  let lastMotionAt = 0;
  let needsRender = true;
  let renderedProgress = NaN;
  let renderedRotX = NaN;
  let renderedRotY = NaN;

  const resize = () => {
    const w = fullBleed ? window.innerWidth : stage.clientWidth;
    const h = fullBleed ? window.innerHeight : stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  };
  resize();
  window.addEventListener('resize', resize, { passive:true });

  const applyRenderScale = (active) => {
    const target = active ? ACTIVE_PIXEL_RATIO : HIGH_PIXEL_RATIO;
    if (Math.abs(renderer.getPixelRatio() - target) < 0.01) return;
    renderer.setPixelRatio(target);
    resize();
    needsRender = true;
  };

  const state = { renderer, pmrem, env, canvas, surface, raf: 0, observer: null, handlers: null };
  state.resize = resize;
  state.applyGestureRotation = (yaw, pitch) => {
    gestureControlled = true;
    targetY -= yaw * 1.7;
    targetX = Math.max(-1.15, Math.min(1.15, targetX + pitch * 2.2));
  };
  junViewer = state;

  const animate = (now = performance.now()) => {
    if (!junViewer) return;
    state.raf = requestAnimationFrame(animate);
    const cameraStatus = interaction?.getState?.().cameraStatus;
    const cameraActive = cameraStatus === 'ready';
    if (cameraActive && now - lastMotionAt < 14.5) return;
    lastMotionAt = now;
    applyRenderScale(cameraActive || cameraStatus === 'requesting' || cameraStatus === 'loading' || Boolean(gestureIntro));
    let introProgress = null;
    if (gestureIntro) {
      introProgress = sampleGestureIntro(now);
      if (state.firing) state.firing.setProgress(introProgress, false);
      lastFiringProgress = introProgress;
    } else if (interaction) {
      lastFiringProgress = syncFiringProgress(interaction, state, lastFiringProgress);
    }
    if (interaction) {
      const rotation = interaction.consumeRotation();
      if (rotation.yaw !== 0 || rotation.pitch !== 0) {
        state.applyGestureRotation(rotation.yaw, rotation.pitch);
      }
    }
    if (!dragging && !gestureControlled) {
      targetX += (0 - targetX) * 0.06;
      targetY += (0 - targetY) * 0.06;
    }
    rotX += (targetX - rotX) * 0.12;
    rotY += (targetY - rotY) * 0.12;
    const progress = introProgress ?? state.firing?.getProgress?.() ?? 1;
    const changed = needsRender
      || Math.abs(progress - renderedProgress) > 1e-5
      || Math.abs(rotX - renderedRotX) > 1e-5
      || Math.abs(rotY - renderedRotY) > 1e-5;
    if (changed) {
      syncFiringTimeline(progress);
      // Same 135° gesture-progress range as Ru; keep Jun's finished orientation at 0.
      const firingTurn = (progress - 1) * GESTURE_FIRING_TURN_RANGE;
      group.rotation.set(0.05 + rotX, firingTurn + rotY, 0);
      renderer.render(scene, camera);
      renderedProgress = progress;
      renderedRotX = rotX;
      renderedRotY = rotY;
      needsRender = false;
    }
  };

  const down = (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    surface.focus?.({ preventScroll:true });
    if (surface.setPointerCapture) {
      try { surface.setPointerCapture(event.pointerId); } catch (error) { /* synthetic pointer */ }
    }
  };
  const move = (event) => {
    if (!dragging) return;
    targetY += (event.clientX - lastX) * 0.011;
    targetX += (event.clientY - lastY) * 0.008;
    targetX = Math.max(-1.0, Math.min(1.0, targetX));
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const up = (event) => {
    if (!dragging) return;
    dragging = false;
    if (surface.releasePointerCapture) {
      try { surface.releasePointerCapture(event.pointerId); } catch (error) { /* synthetic pointer */ }
    }
  };
  const zoomBy = (delta) => {
    camera.position.z = Math.max(0.9, Math.min(4.2, camera.position.z + delta));
    camera.lookAt(0, lookY, 0);
  };
  const wheel = (event) => {
    if (!isOverCeramic(event)) return;
    event.preventDefault();
    zoomBy(event.deltaY * 0.0016);
    needsRender = true;
  };
  const onKey = (event) => {
    const step = event.shiftKey ? 0.06 : 0.18;
    let handled = true;
    if (event.key === 'ArrowLeft') targetY -= step;
    else if (event.key === 'ArrowRight') targetY += step;
    else if (event.key === 'ArrowUp') targetX -= step * 0.7;
    else if (event.key === 'ArrowDown') targetX += step * 0.7;
    else if (event.key === '+' || event.key === '=') zoomBy(-0.15);
    else if (event.key === '-') zoomBy(0.15);
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    targetX = Math.max(-1.0, Math.min(1.0, targetX));
  };
  surface.addEventListener('pointerdown', down);
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', up);
  surface.addEventListener('pointercancel', up);
  surface.addEventListener('wheel', wheel, { passive: false });
  surface.addEventListener('keydown', onKey);
  state.handlers = { down, move, up, wheel, onKey };

  state.observer = new ResizeObserver(resize);
  state.observer.observe(stage);
  animate();

  const loadingLabel = stage.querySelector('[data-jun-loading]');

  new GLTFLoader().load(JUN_MODEL_URL, async (gltf) => {
    if (!junViewer) return;
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    model.position.y += size.y * 0.5;
    group.add(model);

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    model.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      const material = object.material;
      if (material.isMeshPhysicalMaterial) {
        /* 验收确认的光泽度 */
        material.roughness *= JUN_GLOSS.roughness;
        material.clearcoat = Math.min(1, material.clearcoat * JUN_GLOSS.clearcoat);
        material.clearcoatRoughness *= JUN_GLOSS.clearcoatRoughness;
        material.envMapIntensity = 1.0;
        for (const key of ['map', 'roughnessMap']) {
          const texture = material[key];
          if (texture) {
            texture.anisotropy = Math.min(8, maxAnisotropy);
            texture.needsUpdate = true;
          }
        }
      }
      material.needsUpdate = true;
    });

    const fov = camera.fov * Math.PI / 180;
    const distH = size.y * 1.55 / (2 * Math.tan(fov / 2));
    const distW = size.x * 1.30 / (2 * Math.tan(fov / 2) * Math.max(camera.aspect, 0.6));
    camera.position.set(0, size.y * 0.62, Math.max(distH, distW));
    lookY = size.y * 0.46;
    camera.lookAt(0, lookY, 0);

    try {
      const { createJunFiring } = await import('./scene/jun-firing.js');
      if (!junViewer) return;
      state.firing = await createJunFiring({
        renderer, scene, camera, group, model, stage,
        keyLight, topLight, fillLight,
        initialProgress: interaction?.getProgress?.() ?? 1,
        showPlay: false,
        onProgressRequest: requestManualProgress
      });
    } catch (error) {
      console.warn('Jun firing animation unavailable', error);
    }
    try {
      scene.updateMatrixWorld(true);
      if (typeof renderer.compileAsync === 'function') {
        await renderer.compileAsync(scene, camera);
      }
    } catch {
      // Shader compilation warm-up is optional.
    }
    needsRender = true;
    scheduleIdle(prefetchCameraMetadata, 3200);
    if (!junViewer) return;

    stage.classList.remove('is-loading');
    stage.classList.add('is-ready');
    needsRender = true;
    if (fullBleed) canvas.classList.add('is-ready');
  }, (event) => {
    if (!loadingLabel || !event || !event.lengthComputable || !event.total) return;
    loadingLabel.textContent = `LOADING / 3D ${Math.round((event.loaded / event.total) * 100)}%`;
  }, () => {
    stage.classList.remove('is-loading');
    stage.classList.add('is-static');
  });
}

let storyStageObserver = null;

function disposeStoryObserver() {
  if (storyStageObserver) {
    storyStageObserver.disconnect();
    storyStageObserver = null;
  }
}

function observeStoryStage(stage) {
  disposeStoryObserver();
  if (typeof IntersectionObserver === 'undefined') {
    mountRuViewer(stage, 'story');
    return;
  }
  storyStageObserver = new IntersectionObserver((entries) => {
    if (!scrollRaf && entries.some((entry) => entry.isIntersecting)) {
      disposeStoryObserver();
      mountRuViewer(stage, 'story');
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  storyStageObserver.observe(stage);
}

function render(next = route()) {
  normalizeRemovedRoute();
  currentRoute = next;
  const isKiln = next.name === 'kiln';
  disposeInteraction();
  disposeRuViewer();
  disposeJunViewer();
  disposeStoryObserver();
  setRoom(isKiln ? 'kiln' : 'paper');
  nav(isKiln ? 'archive' : next.anchor === 'archive' ? 'archive' : 'home');
  app.innerHTML = isKiln ? kilnTemplate(ceramics[next.id]) : homeTemplate();
  lastTimelineKey = '';
  timelineCachePage = null;
  timelineCacheSteps = [];
  gestureIntro = null;
  app.focus({preventScroll:true});
  bindMotion();
  bindStoryTheme();
  if (isKiln) {
    bindKiln();
    if (next.id === 'ru' || next.id === 'jun') {
      interaction = createInteractionSystem({ workId: `gesture-${next.id}`, initialProgress: 1 });
      gestureControls = mountGestureControls({ system: interaction, onEnable: beginGestureIntro });
    }
    if (next.id === 'ru') mountRuViewer(document.querySelector('[data-model-stage]'), 'detail');
    else if (next.id === 'jun') mountJunViewer(document.querySelector('[data-jun-stage]'));
  } else {
    bindDetailPrefetch();
    const storyStage = document.querySelector('[data-story-stage]');
    if (storyStage) observeStoryStage(storyStage);
  }
  if (next.anchor) window.setTimeout(() => document.getElementById(next.anchor)?.scrollIntoView({behavior: reducedMotion.matches ? 'auto' : 'smooth'}), 30);
}
function handleRouteChange(next) {
  normalizeRemovedRoute();
  if (currentRoute?.name === 'home' && next.name === 'home') {
    const anchor = next.anchor || 'top';
    if (anchor === 'top' || document.getElementById(anchor)) {
      nav(anchor === 'archive' ? 'archive' : 'home');
      fastScrollToAnchor(anchor);
      currentRoute = next;
      return;
    }
  }
  routeTransition(next);
}

document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest('a[href]');
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search || !url.hash) return;
  const next = getRoute(url.hash);
  if (!currentRoute || currentRoute.name !== 'home' || next.name !== 'home') return;
  const anchor = next.anchor || 'top';
  if (anchor !== 'top' && !document.getElementById(anchor)) return;
  event.preventDefault();
  if (location.hash !== url.hash) history.pushState(null, '', url.hash);
  nav(anchor === 'archive' ? 'archive' : 'home');
  fastScrollToAnchor(anchor);
  currentRoute = next;
});

window.addEventListener('hashchange', () => handleRouteChange(route()));
window.addEventListener('popstate', () => handleRouteChange(route()));
render();
