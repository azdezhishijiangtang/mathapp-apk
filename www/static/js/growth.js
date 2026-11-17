/* 成长模块 v2.0：遗忘曲线(FSRS) / 学习档案 / 认知画像 / 学习教练
 * 全部本地计算，只有教练对话会调用你配置的模型端点。
 */
const $g = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };

/* ---------------- FSRS（默认参数，未做个人拟合） ---------------- */
const FSRS_W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
  1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DECAY = -0.5, FACTOR = 19 / 81;

function fsrsInterval(S, rTarget = 0.9) {
  const iv = (S / FACTOR) * (Math.pow(rTarget, 1 / DECAY) - 1);
  return clamp(Math.round(iv), 1, 365 * 3);
}

/** grade: 0=忘了 3=困难 4=一般 5=容易 */
function fsrsNext(prev, grade, now = Date.now()) {
  const g = grade <= 1 ? 1 : grade <= 3 ? 2 : grade < 5 ? 3 : 4;
  const rv = Object.assign({ S: 0, D: 0, reps: 0, lapses: 0, last: 0 }, prev || {});
  let S = Number(rv.S) || 0, D = Number(rv.D) || 0;
  const elapsed = rv.last ? Math.max(0, (now - rv.last) / 86400000) : 0;
  const R = S > 0 ? Math.pow(1 + elapsed / (9 * S), DECAY) : 0;

  if (!rv.reps) {
    S = Math.max(0.1, FSRS_W[g - 1]);
    D = clamp(FSRS_W[4] - Math.exp(FSRS_W[5] * (g - 1)) + 1, 1, 10);
  } else {
    const D0 = clamp(FSRS_W[4] - Math.exp(FSRS_W[5] * 3) + 1, 1, 10);
    D = clamp(FSRS_W[7] * D0 + (1 - FSRS_W[7]) * (D - FSRS_W[6] * (g - 3)), 1, 10);
    if (g === 1) {
      S = Math.max(0.1, FSRS_W[11] * Math.pow(D, -FSRS_W[12]) * (Math.pow(S + 1, FSRS_W[13]) - 1) * Math.exp((1 - R) * FSRS_W[14]));
    } else {
      const hardPenalty = g === 2 ? FSRS_W[15] : 1;
      const easyBonus = g === 4 ? FSRS_W[16] : 1;
      S = S * (1 + Math.exp(FSRS_W[8]) * (11 - D) * Math.pow(S, -FSRS_W[9]) * (Math.exp((1 - R) * FSRS_W[10]) - 1) * hardPenalty * easyBonus);
    }
    S = clamp(S, 0.1, 36500);
  }
  const iv = fsrsInterval(S);
  return {
    S: +S.toFixed(3), D: +D.toFixed(2), reps: (rv.reps || 0) + 1,
    lapses: (rv.lapses || 0) + (g === 1 ? 1 : 0), last: now,
    interval: iv, due: now + iv * 86400000, grade: g,
  };
}

/* ---------------- 学习档案 ---------------- */
function archiveEntries() {
  return S.items.map((h) => ({
    id: h.id, at: h.at,
    problem: (h.problem || '').slice(0, 120),
    topic: h.meta && h.meta.topic ? h.meta.topic : '未分类',
    tags: (h.meta && h.meta.tags) || [],
    err: (h.meta && h.meta.err) || '',
    refuted: !!(h.verify && h.verify.summary && h.verify.summary.refuted),
    proved: h.verify && h.verify.summary ? h.verify.summary.proved : 0,
    total: h.verify && h.verify.summary ? h.verify.summary.total : 0,
    wrong: !!h.wrong,
  }));
}

/** 给模型看的「你踩过的坑」摘要，几百字 */
function archiveDigest(limit = 18) {
  const es = archiveEntries().slice(0, limit);
  if (!es.length) return '（暂无学习记录）';
  return es.map((e, i) =>
    (i + 1) + '. [' + e.topic + '] ' + e.problem.replace(/\s+/g, ' ').slice(0, 46) +
    (e.err ? '；错因：' + e.err : '') +
    (e.refuted ? '；有断言被反例推翻' : (e.total ? '；验证 ' + e.proved + '/' + e.total : ''))
  ).join('\n');
}

function archiveMd() {
  const es = archiveEntries();
  const byTopic = {};
  es.forEach((e) => { (byTopic[e.topic] = byTopic[e.topic] || []).push(e); });
  let md = '# 学习档案 · ' + dayKey(Date.now()) + '\n\n共 ' + es.length + ' 条。\n';
  Object.keys(byTopic).sort((a, b) => byTopic[b].length - byTopic[a].length).forEach((tp) => {
    md += '\n## ' + tp + '（' + byTopic[tp].length + '）\n';
    byTopic[tp].forEach((e) => {
      md += '\n- ' + dayKey(e.at) + ' ' + e.problem.replace(/\s+/g, ' ').slice(0, 80);
      if (e.err) md += '\n  - 错因：' + e.err;
      if (e.refuted) md += '\n  - 曾被反例推翻';
      if (e.tags.length) md += '\n  - 标签：' + e.tags.join(' / ');
    });
  });
  return md;
}

function renderArchive() {
  const box = $g('arcList'); if (!box) return;
  const es = archiveEntries();
  const kw = (($g('arcSearch') || {}).value || '').trim().toLowerCase();
  const list = kw ? es.filter((e) => (e.problem + e.topic + e.err + e.tags.join(' ')).toLowerCase().includes(kw)) : es;
  const tp = {}; list.forEach((e) => { tp[e.topic] = (tp[e.topic] || 0) + 1; });
  const top = Object.keys(tp).sort((a, b) => tp[b] - tp[a]).slice(0, 4)
    .map((k) => k + '×' + tp[k]).join(' · ');
  if ($g('arcSum')) $g('arcSum').textContent = list.length + ' 条' + (top ? ' · ' + top : '');
  box.innerHTML = list.slice(0, 200).map((e) =>
    '<div class="vitem"><div class="vclaim">[' + esc(e.topic) + '] ' + esc(e.problem.slice(0, 70)) + '</div>' +
    '<div class="vdetail">' + fmtTime(e.at) + (e.err ? ' · 错因：' + esc(e.err) : '') +
    (e.refuted ? ' · <span class="err">曾被打回</span>' : '') + (e.wrong ? ' · 错题' : '') + '</div></div>'
  ).join('') || '<div class="vdetail">还没有学习记录，先去解一道题。</div>';
}

function exportArchive() {
  try {
    const md = archiveMd();
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '学习档案-' + dayKey(Date.now()) + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { alert('导出失败：' + (e.message || e)); }
}

/* ---------------- 认知画像 ---------------- */
function portraitStats() {
  const now = Date.now(), DAY = 86400000;
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(now - i * DAY); days.push({ k: dayKey(d.getTime()), n: 0, label: (d.getMonth() + 1) + '/' + d.getDate() }); }
  const idx = {}; days.forEach((d) => { idx[d.k] = d; });
  const topic = {}, err = {}, vsum = { proved: 0, refuted: 0, checked: 0 };
  let wrong = 0, reviewed = 0;
  S.items.forEach((h) => {
    const d = idx[dayKey(h.at)]; if (d) d.n++;
    const tp = h.meta && h.meta.topic ? h.meta.topic : '未分类';
    topic[tp] = (topic[tp] || 0) + 1;
    const er = h.meta && h.meta.err ? h.meta.err : '';
    if (er) err[er] = (err[er] || 0) + 1;
    if (h.verify && h.verify.summary) {
      vsum.proved += h.verify.summary.proved || 0;
      vsum.refuted += h.verify.summary.refuted || 0;
      vsum.checked += (h.verify.summary.total || 0);
    }
    if (h.wrong) wrong++;
    if (h.rv && h.rv.reps) reviewed++;
  });
  const topObj = (o, n) => Object.keys(o).sort((a, b) => o[b] - o[a]).slice(0, n).map((k) => [k, o[k]]);
  return { days, topics: topObj(topic, 6), errs: topObj(err, 5), vsum, wrong, reviewed, total: S.items.length };
}

function bars(rows, unit) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return rows.map((r) =>
    '<div class="brow"><span class="blab">' + esc(String(r[0]).slice(0, 10)) + '</span>' +
    '<span class="btrack"><span class="bfill" style="width:' + Math.round(100 * r[1] / max) + '%"></span></span>' +
    '<span class="bval">' + r[1] + (unit || '') + '</span></div>').join('');
}

function renderPortrait() {
  const box = $g('portraitBody'); if (!box) return;
  const st = portraitStats();
  if (!st.total) { box.innerHTML = '<div class="vdetail">还没有数据，先解几道题。</div>'; return; }
  const passRate = st.vsum.checked ? Math.round(100 * st.vsum.proved / st.vsum.checked) : 0;
  const weak = st.topics.slice(0, 3).map((t) => t[0]).join('、') || '样本还太少';
  box.innerHTML =
    '<div class="kpis">' +
      '<div class="kpi"><b>' + st.total + '</b><span>总题数</span></div>' +
      '<div class="kpi"><b>' + st.vsum.proved + '/' + st.vsum.checked + '</b><span>断言通过</span></div>' +
      '<div class="kpi"><b>' + st.wrong + '</b><span>错题</span></div>' +
      '<div class="kpi"><b>' + st.reviewed + '</b><span>复习过</span></div>' +
    '</div>' +
    '<div class="cap">近 7 天题量</div>' + bars(st.days.map((d) => [d.label, d.n]), '') +
    '<div class="cap">知识点分布（前 6）</div>' + (st.topics.length ? bars(st.topics, '') : '<div class="vdetail">无</div>') +
    '<div class="cap">错因频次（前 5）</div>' + (st.errs.length ? bars(st.errs, '') : '<div class="vdetail">暂无错因标签</div>') +
    '<div class="cap">一句话</div><div class="bq">共 ' + st.total + ' 题，断言通过率 ' + passRate + '%，题量集中在 ' + weak + '。' +
    (st.total < 15 ? '样本还少，别急着下结论。' : '') + '</div>';
}

/* ---------------- 学习教练 ---------------- */
const COACH_SYS = {
  diag: '你是一位竞赛数学教练，正在看一位学生的真实学习记录。只依据记录说话：先给结论，再给依据，最后给 1–3 个今天就能做的动作。不要空泛鼓励，不要算命式断言；样本少就明说样本少。用中文，简洁，可用短列表。',
  plan: '你是一位竞赛数学教练，要用学生自己的学习记录排出未来 7 天的练习计划。按知识点缺口和遗忘曲线到期顺序排，每天 2–3 项，标出每项练什么、练多久、怎么判断自己练会了。用中文，直接给计划表，不要长篇解释。',
  socratic: '你是一位苏格拉底式数学教师。不直接给答案，用连续提问把学生推到下一步；每次最多问两个问题，等学生回答再继续。如果学生卡住，给一个更小的问题或一个具体例子。用中文。',
};
const COACH_TIP = {
  diag: '例如：我这周老在导数上出错，是哪里出了问题？',
  plan: '例如：帮我排未来一周的练习。',
  socratic: '例如：我想自己想出这道不等式，从头问我。',
};

function coachThread() {
  if (!Array.isArray(S.coach)) S.coach = [];
  return S.coach;
}

function renderCoach() {
  const box = $g('coachBody'); if (!box) return;
  const th = coachThread();
  box.innerHTML = th.length ? th.map((m) =>
    '<div class="bub ' + (m.role === 'user' ? 'me' : 'ai') + '"><div class="bwho">' + (m.role === 'user' ? '我' : '教练') + '</div><div class="body">' + render(m.content) + '</div></div>'
  ).join('') : '<div class="vdetail">' + esc(COACH_TIP[($g('coachMode') || {}).value || 'diag']) + '</div>';
  box.scrollTop = box.scrollHeight;
}

async function coachAsk() {
  const inp = $g('coachInput'); if (!inp) return;
  const q = (inp.value || '').trim(); if (!q) return;
  if (!S.cfg.base) { if (typeof openCfg === 'function') openCfg(); return; }
  inp.value = '';
  const mode = ($g('coachMode') || {}).value || 'diag';
  const th = coachThread();
  th.push({ role: 'user', content: q });
  renderCoach();
  const sys = COACH_SYS[mode] + '\n\n学生的真实学习记录摘要（按时间倒序，最多 18 条）：\n' + archiveDigest(18) +
    '\n\n统计：总题 ' + S.items.length + '，错题 ' + S.items.filter((x) => x.wrong).length +
    '，有反例被推翻 ' + S.items.filter((x) => x.verify && x.verify.summary && x.verify.summary.refuted).length + ' 条。';
  const msgs = [{ role: 'system', content: sys }].concat(th.slice(-10));
  const holder = document.createElement('div');
  holder.className = 'bub ai';
  holder.innerHTML = '<div class="bwho">教练</div><div class="body"></div>';
  $g('coachBody').appendChild(holder);
  const body = holder.querySelector('.body');
  try {
    const cStream = mkStream(body);
    const r = await callLLM(msgs, { onText: (t) => cStream.push(t) });
    cStream.end(r.content);
    th.push({ role: 'assistant', content: r.content });
    body.innerHTML = render(r.content);
    save();
  } catch (e) {
    const c = typeof classifyErr === 'function' ? classifyErr(e) : { text: e.message || String(e) };
    body.innerHTML = '<span class="err">' + esc(c.text) + '</span>';
  }
  renderCoach();
}

/* ---------------- 启动 ---------------- */
function growthBoot() {
  try {
    const open = (id) => { const s = $g(id); if (s) s.classList.remove('hide'); };
    const b = $g('btnPortrait'); if (b) b.onclick = () => { open('portraitSheet'); renderPortrait(); };
    const c = $g('btnCoach'); if (c) c.onclick = () => { open('coachSheet'); renderCoach(); };
    const a = $g('btnArchive'); if (a) a.onclick = () => { open('archiveSheet'); renderArchive(); };
    const cs = $g('coachSend'); if (cs) cs.onclick = coachAsk;
    const ci = $g('coachInput'); if (ci) ci.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); coachAsk(); } };
    const cm = $g('coachMode'); if (cm) cm.onchange = () => { $g('coachBody').innerHTML = ''; renderCoach(); };
    const cc = $g('coachClear'); if (cc) cc.onclick = () => { S.coach = []; save(); renderCoach(); };
    const as = $g('arcSearch'); if (as) as.oninput = renderArchive;
    const ae = $g('arcExport'); if (ae) ae.onclick = exportArchive;
    const pr = $g('portraitRefresh'); if (pr) pr.onclick = renderPortrait;
  } catch (e) { console.warn('成长模块绑定失败：', e && e.message); }
}

document.addEventListener('DOMContentLoaded', growthBoot);
