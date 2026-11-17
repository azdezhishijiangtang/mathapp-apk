/* 功能模块注册表 v2.0
 * 设计原则：功能全都在「功能市场」里列出来（可发现），
 * 界面只呈现已启用的模块（不复杂）。卸载不动数据，装回来数据还在。
 */
const MODULE_LIST = [
  { id: 'core', name: '解题核心', size: 0, core: true,
    desc: '题目 → 模型作答 → 学习卡存档。不可卸载。' },
  { id: 'engine', name: '本地验证引擎', size: 645 * 1024 * 1024,
    desc: 'sympy / z3 / Arb / PARI / numpy / CP-SAT / cvc5 / Gröbner 八引擎，离线复核每一步断言。卸载可回收 645 MB。' },
  { id: 'verify', name: '验证徽章与反例卡片', size: 0,
    desc: '把验证结果画成徽章（成立 / 被推翻 / 未发现反例），反例直接标在答案下方。' },
  { id: 'ocr', name: '拍照识别（本地 OCR）', size: 8 * 1024 * 1024,
    desc: 'tesseract + 中英语言包，离线把照片转成题目文字；装了能读图的模型时两路并发择优。' },
  { id: 'kbd', name: '公式键盘 MathLive', size: 1.2 * 1024 * 1024,
    desc: '手打分数、根号、上下标的可视化键盘。' },
  { id: 'chat', name: '多轮对话', size: 0,
    desc: '在同一道题上继续追问，上下文保留。' },
  { id: 'teach', name: '讲解与角色卡', size: 0,
    desc: '教练 / 教材 / 苏格拉底三种讲法，讲完可以继续追问。' },
  { id: 'review', name: '遗忘曲线复习', size: 30 * 1024,
    desc: '按 FSRS 排程安排到期复习，卡片式自评。' },
  { id: 'archive', name: '学习档案', size: 12 * 1024,
    desc: '把每道题的知识点、错因、是否被反例推翻记成档案，可搜索、可导出 markdown，也会作为教练的依据。' },
  { id: 'portrait', name: '认知画像', size: 20 * 1024,
    desc: '近 7 天题量、知识点弱项、验证通过率、错因频次四张图。' },
  { id: 'coach', name: '学习教练', size: 15 * 1024,
    desc: '诊断 / 规划 / 苏格拉底三种对话，用你的学习档案说话。' },
  { id: 'batch', name: '整页批改', size: 25 * 1024,
    desc: '拍一页作业，自动拆题、逐题判定、进错题本（依赖验证引擎）。' },
  { id: 'week', name: '周报与错题卷', size: 10 * 1024,
    desc: '本周统计、打印错题卷（题目页 + 答案错因页）。' },
  { id: 'g3', name: '立体画板', size: 12 * 1024,
    desc: '正方体 / 四面体 / 棱锥 / 棱柱，拖拽旋转后导出图片给模型看。' },
  { id: 'speech', name: '朗读与语音输入', size: 0,
    desc: '用系统语音念答案、用麦克风说题（不联网、零体积）。' },
  { id: 'mermaid', name: '流程图 Mermaid', size: 5.3 * 1024 * 1024,
    desc: '讲解里出现 ```mermaid 时画成流程图，5.3 MB 按需加载。' },
];

const DEFAULT_MODS = ['core', 'engine', 'verify', 'ocr', 'kbd', 'chat', 'teach', 'review', 'archive', 'batch', 'week', 'g3', 'speech'];

/* 模块 ↔ 界面元素。卸载只隐藏入口，不动数据。 */
const UI_MAP = {
  engine: ['#engCard'],
  verify: ['#verify'],
  ocr: ['#btnOcr', '#fileOcr', '#ocrBox'],
  kbd: ['#kbdWrap'],
  chat: ['#chat'],
  teach: ['#teach'],
  review: ['#btnReviewStart', '#reviewSheet', '#dueHint'],
  batch: ['#btnBatch', '#batchSheet'],
  week: ['#btnWeek', '#weekSheet', '#btnPrintWrong'],
  g3: ['#btnG3', '#g3Sheet'],
  speech: ['#btnSpeak', '#btnMic'],
  archive: ['#btnArchive', '#archiveSheet'],
  portrait: ['#btnPortrait', '#portraitSheet'],
  coach: ['#btnCoach', '#coachSheet'],
  mermaid: [],
};

const PRESETS = {
  '极简': ['core', 'verify'],
  '标准': DEFAULT_MODS.slice(),
  '全量': MODULE_LIST.map(m => m.id),
};

function modById(id) { return MODULE_LIST.find(m => m.id === id) || null; }

const Mods = {
  list() { return Array.isArray(S.cfg.mods) ? S.cfg.mods : DEFAULT_MODS.slice(); },
  has(id) { const m = modById(id); if (m && m.core) return true; return this.list().indexOf(id) >= 0; },
  set(ids) {
    const core = MODULE_LIST.filter(m => m.core).map(m => m.id);
    const next = core.concat(ids.filter(id => core.indexOf(id) < 0));
    S.cfg.mods = next.filter(id => modById(id));
    save();
    this.apply();
  },
  enable(id) { if (!this.has(id)) this.set(this.list().concat([id])); },
  disable(id) { const m = modById(id); if (m && m.core) return; this.set(this.list().filter(x => x !== id)); },
  toggle(id) { this.has(id) && !(modById(id) || {}).core ? this.disable(id) : this.enable(id); },
  apply() {
    Object.keys(UI_MAP).forEach(id => {
      const on = this.has(id);
      UI_MAP[id].forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.classList.toggle('hide', !on);
      });
    });
    const n = this.list().length;
    const total = MODULE_LIST.length;
    const hint = document.getElementById('modHint');
    if (hint) hint.textContent = '已启用 ' + n + ' / ' + total + ' 项';
  },
  bytes() {
    return this.list().reduce((a, id) => a + (modById(id) ? modById(id).size : 0), 0);
  },
};

function fmtSize(b) {
  if (!b) return '内置';
  if (b >= 1024 * 1024 * 1024) return (b / 1073741824).toFixed(1) + ' GB';
  if (b >= 1024 * 1024) return Math.round(b / 1048576) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}

function renderMarket() {
  const box = document.getElementById('marketList');
  if (!box) return;
  box.innerHTML = MODULE_LIST.map(m => {
    const on = Mods.has(m.id);
    const size = fmtSize(m.size);
    const btn = m.core
      ? '<span class="meta">必需</span>'
      : '<button class="' + (on ? 'ghost xs' : 'primary xs') + '" data-mod="' + m.id + '">' + (on ? '卸载' : '安装') + '</button>';
    return '<div class="mrow' + (on ? ' on' : '') + '">' +
      '<div class="mtop"><b>' + esc(m.name) + '</b><span class="meta">' + size + '</span>' + btn + '</div>' +
      '<div class="mdesc">' + esc(m.desc) + '</div>' +
      '</div>';
  }).join('');
  box.querySelectorAll('button[data-mod]').forEach(b => {
    b.onclick = () => { Mods.toggle(b.dataset.mod); renderMarket(); };
  });
  const sum = document.getElementById('marketSum');
  if (sum) sum.textContent = '已启用 ' + Mods.list().length + ' 项 · 约 ' + fmtSize(Mods.bytes() + 2 * 1024 * 1024);
}

function openMarket() {
  const sh = document.getElementById('marketSheet');
  if (!sh) return;
  renderMarket();
  sh.classList.remove('hide');
}

function modBoot() {
  if (!Array.isArray(S.cfg.mods)) { S.cfg.mods = DEFAULT_MODS.slice(); save(); }
  const b = document.getElementById('btnMarket');
  if (b) b.onclick = openMarket;
  const b2 = document.getElementById('btnMarket2');
  if (b2) b2.onclick = openMarket;
  const list = document.getElementById('marketPresets');
  if (list) {
    list.innerHTML = Object.keys(PRESETS).map(k =>
      '<button class="ghost xs" data-preset-mods="' + k + '">' + k + '</button>').join('');
    list.querySelectorAll('button[data-preset-mods]').forEach(btn => {
      btn.onclick = () => { Mods.set(PRESETS[btn.dataset.presetMods] || DEFAULT_MODS); renderMarket(); };
    });
  }
  Mods.apply();
}

document.addEventListener('DOMContentLoaded', modBoot);
