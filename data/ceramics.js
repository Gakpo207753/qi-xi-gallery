export const ceramics = {
  ru: { id: 'ru', name: '汝窑', roman: 'RU / STILL GLAZE', index: '01', cue: '静 · 润 · 裂', palette: 'ru', intro: '一层天青，像雨停之后留在玉上的光。', note: '开片不是装饰，而是釉与时间共同留下的呼吸。', stage: ['泥胚', '修坯', '施釉', '入窑', '烧成'], texture: 'craquelure',
    firing: { duration: 12, stages: [
      { id: 'clay', label: '泥坯', start: 0, end: .18 },
      { id: 'dry', label: '修坯 / 干燥', start: .18, end: .34 },
      { id: 'glaze', label: '浸釉', start: .34, end: .50 },
      { id: 'kiln', label: '装匣 / 升温', start: .50, end: .70 },
      { id: 'reduction', label: '还原烧成', start: .70, end: .90 },
      { id: 'cool', label: '冷却 / 定器', start: .90, end: 1 }
    ] } },
  jun: { id: 'jun', name: '钧窑', roman: 'JUN / TRANSFORMING FIRE', index: '02', cue: '火 · 流 · 变', palette: 'jun', intro: '颜色在火里相遇，流动到无法复制的边界。', note: '窑变的每一次偏移，都是温度写下的偶然。', stage: ['泥胚', '修坯', '施釉', '入窑', '窑变'], texture: 'flow',
    firing: { duration: 15, stages: [
      { id: 'clay', label: '泥坯', start: 0, end: .16 },
      { id: 'dry', label: '修坯 / 干燥', start: .16, end: .30 },
      { id: 'glaze', label: '浸釉', start: .30, end: .48 },
      { id: 'kiln', label: '装匣 / 升温', start: .48, end: .64 },
      { id: 'reduction', label: '还原烧成', start: .64, end: .88 },
      { id: 'cool', label: '冷却 / 定器', start: .88, end: 1 }
    ] } }
};
export const navItems = Object.values(ceramics);
