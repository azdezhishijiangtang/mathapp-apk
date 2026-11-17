/* ============================================================
   v1.6 扩展模块：数学键盘 / 语音 / 成本面板 / 整页批改 / 周报 / 立体画板
   ============================================================ */

/* ---------------- 通用：弹层 ---------------- */
function openSheet(id) { const e = $(id); if (e) { e.classList.remove('hide'); e.scrollTop = 0; } }
function closeSheet(id) { const e = $(id); if (e) e.classList.add('hide'); }
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-close]');
  if (t) closeSheet(t.dataset.close);
});
$('btnMore').onclick = () => openSheet('moreSheet');
$('btnBatch').onclick = () => { closeSheet('moreSheet'); openSheet('batchSheet'); };
$('btnWeek').onclick = () => { closeSheet('moreSheet'); openSheet('weekSheet'); renderWeek(); };
$('btnG3').onclick = () => { closeSheet('moreSheet'); openSheet('g3Sheet'); g3Draw(); };
$('btnPrintWrong').onclick = () => printWrongBook();

/* ---------------- 成本面板 ---------------- */
const LSC = 'mathapp.cost';
function todayKey() { return new Date().toISOString().slice(0, 10); }
function loadCost() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem(LSC) || 'null'); } catch (e) { }
  if (!c || c.day !== todayKey()) c = { day: todayKey(), calls: 0, ptok: 0, ctok: 0, credit: 0, est: 0 };
  return c;
}
S.cost = loadCost();
function saveCost() { try { localStorage.setItem(LSC, JSON.stringify(S.cost)); } catch (e) { } }
function renderCost() {
  const c = S.cost, el = $('costLine');
  if (!el) return;
  const cr = c.credit.toFixed(2);
  el.textContent = `今日 ${c.calls} 次 · 出 ${fmtTok(c.ctok)} tok · ≈${cr} 积分${c.est ? '（部分估算）' : ''}`;
}
/** 包一层 callLLM，把每次调用记进成本面板 */
const _callLLM = callLLM;
callLLM = async function (messages, opt = {}) {
  const cap = Number(S.cfg.capDaily || 0);
  if (cap > 0 && Number(S.cost.credit || 0) >= cap) {
    const e = new Error('今日已用 ' + Number(S.cost.credit || 0).toFixed(1) + ' 积分，已达单日上限 ' + cap + '（设置里可调高，或明天再来）');
    e.status = 'budget';
    throw e;
  }
  const r = await _callLLM(messages, opt);
  try {
    const u = r.usage || {};
    const ct = u.completion_tokens || 0, pt = u.prompt_tokens || 0;
    S.cost.calls += 1; S.cost.ctok += ct; S.cost.ptok += pt;
    if (typeof u.credit === 'number') S.cost.credit += u.credit;
    else { S.cost.credit += (ct + pt) * 0.00034; S.cost.est = 1; }
    saveCost(); renderCost();
  } catch (e) { }
  return r;
};
renderCost();

/* ---------------- 数学键盘（MathLive） ---------------- */
(function initMathLive() {
  if (typeof MathfieldElement === 'undefined') return;
  try {
    MathfieldElement.fontsDirectory = '/static/vendor/mathlive/fonts';
    MathfieldElement.soundsDirectory = null;
  } catch (e) { }
  const mf = $('mf');
  if (mf) { mf.mathVirtualKeyboardPolicy = 'manual'; mf.smartFence = true; }
})();
function mfInsert(newline) {
  const mf = $('mf');
  const q = $('q');
  const tex = (mf && mf.value || '').trim();
  if (!tex) return;
  const wrap = /\s|\^|_|\\frac|\\sqrt/.test(tex) ? '$$' + tex + '$$' : tex;
  const sep = q.value && !/\n$/.test(q.value) ? (newline ? '\n' : ' ') : '';
  q.value = q.value + sep + wrap + ' ';
  q.dispatchEvent(new Event('input'));
  mf.value = '';
  q.focus();
}
$('btnMfIns').onclick = () => mfInsert(false);
$('btnMfLine').onclick = () => mfInsert(true);
$('btnMfClear').onclick = () => { const mf = $('mf'); if (mf) mf.value = ''; };

/* ---------------- 语音：朗读 + 口述 ---------------- */
function texToSpeech(t) {
  return String(t || '')
    .replace(/```claims[\s\S]*?```/g, '')
    .replace(/\\boxed\{([^{}]*)\}/g, '答案是 $1。')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)除以($2)')
    .replace(/\\sqrt\{([^{}]*)\}/g, '根号($1)')
    .replace(/\\pi/g, 'π').replace(/\\leq|\\le/g, '小于等于').replace(/\\geq|\\ge/g, '大于等于')
    .replace(/\\times|\\cdot/g, '乘').replace(/\\pm/g, '正负').replace(/\\infty/g, '无穷')
    .replace(/\^2/g, '的平方').replace(/\^3/g, '的立方').replace(/\^\{?(-?\d+)\}?/g, '的$1次方')
    .replace(/\\[a-zA-Z]+/g, ' ').replace(/[${}]/g, ' ')
    .replace(/[ \t]+/g, ' ');
}
let speaking = false;
$('btnSpeak').onclick = () => {
  if (!('speechSynthesis' in window)) { alert('这个浏览器不支持朗读'); return; }
  if (speaking) { speechSynthesis.cancel(); speaking = false; $('btnSpeak').textContent = '朗读'; return; }
  const src = S.cur ? S.cur.answer : $('answerBody').innerText;
  const txt = texToSpeech(src).slice(0, 1200);
  if (!txt.trim()) return;
  const u = new SpeechSynthesisUtterance(txt);
  u.lang = 'zh-CN'; u.rate = 1.05;
  u.onend = () => { speaking = false; $('btnSpeak').textContent = '朗读'; };
  speechSynthesis.cancel(); speechSynthesis.speak(u);
  speaking = true; $('btnSpeak').textContent = '停止朗读';
};
let recog = null;
$('btnMic').onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('这个浏览器不支持语音输入'); return; }
  if (recog) { recog.stop(); recog = null; $('btnMic').textContent = '🎤 说题'; return; }
  recog = new SR();
  recog.lang = 'zh-CN'; recog.interimResults = true; recog.continuous = false;
  let base = $('q').value;
  $('btnMic').textContent = '● 听着…';
  recog.onresult = (ev) => {
    let s = '';
    for (let i = 0; i < ev.results.length; i++) s += ev.results[i][0].transcript;
    $('q').value = (base ? base + '\n' : '') + s;
  };
  recog.onerror = () => { $('btnMic').textContent = '🎤 说题'; recog = null; };
  recog.onend = () => { $('btnMic').textContent = '🎤 说题'; recog = null; };
  try { recog.start(); } catch (e) { $('btnMic').textContent = '🎤 说题'; recog = null; }
};

/* ---------------- 静默验证（不动页面上的验证卡） ---------------- */
async function verifyQuiet(claims) {
  try {
    const r = await (window.apiFetch || fetch)('/api/verify', { method: 'POST', body: JSON.stringify({ claims }) });
    return await r.json();
  } catch (e) { return null; }
}

/* ---------------- 整页批改 ---------------- */
const BATCH_MAX = 6;
S.batch = { img: '', list: [], busy: false };
$('btnBatchPick').onclick = () => $('batchFile').click();
$('batchFile').onchange = (ev) => {
  const f = (ev.target.files || [])[0];
  if (f) loadBatchImage(f);
};
async function loadBatchImage(file) {
  const src = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(file);
  });
  S.batch.img = await shrinkImage(src, 1600, 0.86);
  S.batch.list = [];
  $('batchList').innerHTML = '';
  $('batchStatus').textContent = '图片已就绪，点「开始批改」。';
  $('btnBatchRun').disabled = false;
}
$('btnBatchRun').onclick = async () => {
  if (S.batch.busy || !S.batch.img) return;
  S.batch.busy = true; $('btnBatchRun').disabled = true;
  const st = $('batchStatus');
  const setSt = (t) => { st.textContent = t; };
  try {
    setSt('读题中（模型读图）…');
    let pageText = '';
    try {
      const r = await runVision(S.batch.img);
      pageText = (r && r.text || '').trim();
      setVisionState(true);
    } catch (e) {
      setSt('模型读图失败，改用本地 OCR…');
      const r = await runLocalOcr(S.batch.img);
      pageText = (r && r.text || '').trim();
      setVisionState(false, String(e.message || e));
    }
    if (!pageText) throw new Error('这一页没读出来，换张清晰的图');
    setSt('拆题中…');
    const split = await callLLM([
      { role: 'system', content: '你是作业拆题员。只输出 JSON 数组，不要代码围栏、不要解释。' },
      { role: 'user', content: '把下面这一页作业拆成题目列表，最多 ' + BATCH_MAX + ' 道。格式：[{"no":"题号","problem":"完整题面（公式写 LaTeX）"}]。看不清的跳过。\n\n' + pageText.slice(0, 4000) },
    ], { stream: false, temp: 0, maxTokens: 1200, thinking: false });
    const arr = parseJsonLoose(split.content);
    const qs = (Array.isArray(arr) ? arr : []).filter((x) => x && x.problem).slice(0, BATCH_MAX);
    if (!qs.length) throw new Error('没拆出题目（模型返回：' + (split.content || '').slice(0, 80) + '）');
    S.batch.list = qs.map((x) => ({ no: String(x.no || '?'), problem: String(x.problem), answer: '', claims: [], verify: null, done: false }));
    renderBatch();
    for (let i = 0; i < S.batch.list.length; i++) {
      const it = S.batch.list[i];
      setSt(`第 ${i + 1}/${S.batch.list.length} 题：${it.no} 求解中…`);
      try {
        const msgs = [{ role: 'system', content: SOLVE_SYS }, { role: 'user', content: it.problem }];
        let r = await callLLM(msgs, { maxTokens: 16000, temp: 0.5, stream: false });
        if (!r.content.trim()) r = await callLLM(msgs, { maxTokens: 32000, temp: 0.5, stream: false });
        it.answer = r.content || '';
        let cl = extractClaims(it.answer);
        if (!cl.length) cl = await auditClaims(it.problem, it.answer);
        it.claims = cl;
        it.verify = cl.length ? await verifyQuiet(cl) : null;
        it.done = true;
      } catch (e) {
        it.answer = '（求解失败：' + (e.message || e) + '）'; it.done = true;
      }
      renderBatch();
      const rec = normItem({ problem: it.problem, answer: it.answer, model: S.cfg.model, verify: it.verify, claims: it.claims, at: Date.now() });
      rec.wrong = !!(it.verify && it.verify.summary && it.verify.summary.refuted);
      rec.meta = null;
      S.items.unshift(rec);
      save();
      classifyItem(rec);
    }
    setSt(`完成 ${S.batch.list.length} 题，已进记录。被判被推翻的自动标进错题。`);
  } catch (e) {
    setSt('出错：' + (e.message || e));
  } finally {
    S.batch.busy = false; $('btnBatchRun').disabled = false;
  }
};
function batchBadge(it) {
  if (!it.done) return '<span class="badge b-unk">排队中</span>';
  if (!it.verify) return '<span class="badge b-unk">未验证</span>';
  const s = it.verify.summary || {};
  if (s.refuted) return `<span class="badge b-bad">${s.refuted} 条被推翻</span>`;
  if (s.proved) return `<span class="badge b-ok">${s.proved}/${s.total} 成立</span>`;
  return `<span class="badge b-ok">未发现反例</span>`;
}
function renderBatch() {
  $('batchList').innerHTML = S.batch.list.map((it, i) => `
    <div class="bq">
      <div class="bqh"><b>第 ${esc(it.no)} 题</b>${batchBadge(it)}</div>
      <pre>${esc(it.problem.slice(0, 400))}</pre>
      ${it.answer ? `<pre class="ans">${render(it.answer).slice(0, 4000)}</pre>` : ''}
    </div>`).join('');
}

/* ---------------- 打印 / 存 PDF ---------------- */
function printDoc(title, bodyHtml) {
  const w = window.open('', '_blank');
  if (!w) { alert('浏览器拦了新窗口，允许弹窗后再试'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="stylesheet" href="/static/vendor/katex/katex.min.css">
<style>
body{font:15px/1.65 -apple-system,"Noto Sans CJK SC",sans-serif;color:#111;margin:22px;max-width:760px}
h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
.q{margin:12px 0 0;page-break-inside:avoid}.q .no{font-weight:600}
.a{margin:4px 0 14px;padding-left:10px;border-left:2px solid #eee;color:#333}
.meta{color:#777;font-size:12px}
.katex-display{margin:6px 0}
@media print{@page{margin:14mm}}
</style></head><body>${bodyHtml}</body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) { } }, 600);
}
function printWrongBook() {
  const list = S.items.filter((h) => h.wrong);
  if (!list.length) { alert('错题本是空的（在答案卡点「记入错题」）'); return; }
  const qs = list.map((h, i) => `<div class="q"><span class="no">${i + 1}.</span> ${render(h.problem)}
    <div class="meta">${h.meta ? esc(h.meta.topic || '') : ''} ${h.verify && h.verify.summary ? `· 验证 ${h.verify.summary.proved}/${h.verify.summary.total}` : ''}</div></div>`).join('');
  const as = list.map((h, i) => `<div class="q"><span class="no">${i + 1}.</span>${render(plain(h.answer))}
    ${h.meta && h.meta.err ? `<div class="meta">错因：${esc(h.meta.err)}</div>` : ''}</div>`).join('');
  printDoc('错题卷', `<h1>错题卷（${list.length} 题）</h1><div class="meta">${new Date().toLocaleDateString('zh-CN')} · 数学答疑</div>
    <h2>题目</h2>${qs}<h2 style="page-break-before:always">答案与错因</h2>${as}`);
}

/* ---------------- 学习周报 ---------------- */
function weekStats() {
  const now = Date.now(), WEEK = 7 * 86400000;
  const week = S.items.filter((h) => now - h.at < WEEK);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, label: (d.getMonth() + 1) + '/' + d.getDate(), n: week.filter((h) => new Date(h.at).toISOString().slice(0, 10) === key).length });
  }
  const topic = {}, err = {};
  let proved = 0, refuted = 0, checked = 0, wrong = 0, reviewed = 0, dueNow = 0;
  week.forEach((h) => {
    if (h.meta) {
      topic[h.meta.topic || '其他'] = (topic[h.meta.topic || '其他'] || 0) + 1;
      if (h.meta.err) err[h.meta.err] = (err[h.meta.err] || 0) + 1;
    }
    if (h.verify && h.verify.summary) { checked++; proved += h.verify.summary.proved || 0; refuted += h.verify.summary.refuted || 0; }
    if (h.wrong) wrong++;
    if (h.rv && h.rv.reps) reviewed++;
    if (h.rv && h.rv.due && h.rv.due < now) dueNow++;
  });
  return { week, days, topic, err, proved, refuted, checked, wrong, reviewed, dueNow, total: S.items.length };
}
function bars(obj, limit) {
  const ent = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit || 6);
  const max = Math.max(1, ...ent.map((x) => x[1]));
  return ent.map(([k, v]) => `<div class="wbar"><span class="lab">${esc(k)}</span>
    <span class="track"><span class="fill" style="width:${Math.round(v / max * 100)}%"></span></span>
    <span class="val">${v}</span></div>`).join('') || '<div class="meta">还没有数据</div>';
}
function renderWeek() {
  const s = weekStats();
  const verifyRate = s.checked ? Math.round(s.week.filter((h) => h.verify && !(h.verify.summary || {}).refuted).length / s.checked * 100) : 0;
  const maxDay = Math.max(1, ...s.days.map((d) => d.n));
  const dayBars = s.days.map((d) => `<div class="wbar"><span class="lab">${d.label}</span>
    <span class="track"><span class="fill" style="width:${Math.round(d.n / maxDay * 100)}%"></span></span>
    <span class="val">${d.n}</span></div>`).join('');
  $('weekBody').innerHTML = `
    <div class="wkpi">
      <div><b>${s.week.length}</b><span>本周新题</span></div>
      <div><b>${s.wrong}</b><span>错题</span></div>
      <div><b>${verifyRate}%</b><span>验证零反例</span></div>
      <div><b>${s.dueNow}</b><span>待复习</span></div>
    </div>
    <h2>每天做了多少</h2>${dayBars}
    <h2>知识点分布</h2>${bars(s.topic)}
    <h2>错因排行</h2>${bars(s.err)}
    <div class="meta">断言统计：本机验证共 ${s.proved} 条成立、${s.refuted} 条被推翻；累计记录 ${s.total} 条。</div>`;
}
$('btnWeekPrint').onclick = () => {
  renderWeek();
  printDoc('学习周报', `<h1>学习周报</h1><div class="meta">${new Date().toLocaleDateString('zh-CN')} · 数学答疑</div>${$('weekBody').innerHTML}`);
};

/* ---------------- 立体画板（3D 线框） ---------------- */
const G3 = { preset: 'cube', rotX: -0.42, rotY: 0.62, scale: 1, dash: true, drag: null };
const G3_SHAPES = {
  cube: { v: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    e: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
    l: ['A', 'B', 'C', 'D', 'A₁', 'B₁', 'C₁', 'D₁'] },
  tetra: { v: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
    e: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]], l: ['P', 'A', 'B', 'C'] },
  pyramid: { v: [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 0, 1.7]],
    e: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]], l: ['A', 'B', 'C', 'D', 'P'] },
  prism: { v: [[-1, -1, -1], [1, -1, -1], [0, 1, -1], [-1, -1, 1], [1, -1, 1], [0, 1, 1]],
    e: [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]],
    l: ['A', 'B', 'C', 'A₁', 'B₁', 'C₁'] },
};
function g3Proj(p) {
  let [x, y, z] = p;
  const cx = Math.cos(G3.rotX), sx = Math.sin(G3.rotX);
  let y1 = y * cx - z * sx, z1 = y * sx + z * cx;
  const cy = Math.cos(G3.rotY), sy = Math.sin(G3.rotY);
  let x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
  const d = 4.2, f = 460 * G3.scale;
  const k = f / (d - z2 * 0.55);
  return [320 + x2 * k, 320 - y1 * k, z2];
}
function g3Draw() {
  const c = $('g3c'); if (!c) return;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#0b1020'; g.fillRect(0, 0, c.width, c.height);
  const sh = G3_SHAPES[G3.preset] || G3_SHAPES.cube;
  const pts = sh.v.map(g3Proj);
  sh.e.forEach(([i, j]) => {
    const a = pts[i], b = pts[j];
    const far = (a[2] + b[2]) / 2 < 0;
    g.beginPath();
    if (G3.dash && far) g.setLineDash([6, 6]); else g.setLineDash([]);
    g.strokeStyle = far && G3.dash ? '#4a6a94' : '#8ecbff';
    g.lineWidth = far && G3.dash ? 1.4 : 2.2;
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  });
  g.setLineDash([]);
  pts.forEach((p, i) => {
    g.beginPath(); g.arc(p[0], p[1], 3.6, 0, 7); g.fillStyle = '#ffe08a'; g.fill();
    g.fillStyle = '#d8e6ff'; g.font = '16px -apple-system,sans-serif';
    g.fillText((sh.l && sh.l[i]) || String(i + 1), p[0] + 7, p[1] - 6);
  });
}
$('g3Preset').onchange = (e) => { G3.preset = e.target.value; g3Draw(); };
$('g3Reset').onclick = () => { G3.rotX = -0.42; G3.rotY = 0.62; G3.scale = 1; g3Draw(); };
$('g3Show').onclick = () => { G3.dash = !G3.dash; g3Draw(); };
(function g3Bind() {
  const c = $('g3c');
  c.addEventListener('pointerdown', (e) => { G3.drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
  c.addEventListener('pointermove', (e) => {
    if (!G3.drag) return;
    G3.rotY += (e.clientX - G3.drag.x) * 0.01;
    G3.rotX += (e.clientY - G3.drag.y) * 0.01;
    G3.rotX = Math.max(-1.45, Math.min(1.45, G3.rotX));
    G3.drag = { x: e.clientX, y: e.clientY };
    g3Draw();
  });
  c.addEventListener('pointerup', () => { G3.drag = null; });
  c.addEventListener('wheel', (e) => { e.preventDefault(); G3.scale = Math.max(0.5, Math.min(2, G3.scale * (e.deltaY > 0 ? 0.94 : 1.06))); g3Draw(); }, { passive: false });
})();
$('g3Png').onclick = () => {
  const c = $('g3c');
  S.ocrImg = c.toDataURL('image/png');
  closeSheet('g3Sheet');
  $('ocrPrev').src = S.ocrImg;
  $('ocrBox').classList.remove('hide');
  $('ocrStatus').textContent = '立体图已就绪：点「模型读图」让模型看图，或直接在题目里描述。';
  $('ocrFillRow').classList.remove('hide');
};
