'use strict';
/* 界面层：只管 DOM 与交互。纯逻辑见 core.js，新增能力见 store.js。 */

'use strict';

const $ = (id) => document.getElementById(id);

function showAnswer(model, text, think) {
  $('answer').classList.remove('hide');
  $('modelTag').textContent = model || '—';
  $('answerBody').innerHTML = render(text || '');
  if (think) {
    $('thinkWrap').classList.remove('hide');
    $('think').textContent = think.length > 6000 ? think.slice(-6000) : think;
    $('thinkLen').textContent = fmtTok(think.length) + ' 字符';
  } else {
    $('thinkWrap').classList.add('hide');
  }
}

function note(t) { $('metaTag').textContent = t || ''; }

const V_MAP = {
  proved: ['b-ok', '成立'], no_counterexample_found: ['b-ok', '未发现反例'],
  none_found: ['b-ok', '无反例'], refuted: ['b-bad', '被推翻'], unknown: ['b-unk', '未能判定'],
  error: ['b-unk', '验证出错'], skipped: ['b-unk', '跳过'], info: ['b-unk', '信息'],
};

function renderVerify(d) {
  if (!d) return;
  $('verify').classList.remove('hide');
  $('verifyList').innerHTML = (d.results || []).map((x) => {
    const [cls, label] = V_MAP[x.status] || ['b-unk', x.status];
    const det = [x.detail, x.min_enclosure ? '最小包络 ' + x.min_enclosure : '', x.at ? '@' + x.at : '',
      x.point ? '反例 ' + JSON.stringify(x.point) : '', x.engine ? '[' + x.engine + ']' : '',
      x.secs !== undefined ? x.secs + 's' : ''].filter(Boolean).join(' · ');
    return `<div class="vitem"><div class="vhead"><span class="badge ${cls}">${label}</span>
      <span class="vclaim">${esc(x.claim || '')}</span></div><div class="vdetail">${esc(det)}</div></div>`;
  }).join('') || '<div class="vdetail">无断言</div>';
  const s = d.summary || {};
  $('verifySum').textContent = `${s.proved || 0}/${s.total || 0} 通过 · 证据覆盖率 ${Math.round((d.coverage || 0) * 100)}%` +
    (s.refuted ? ` · ${s.refuted} 条被推翻` : '');
}

async function solve(problem, opts = {}) {
  if (!S.cfg.base) { openCfg(); return; }
  const into = opts.into || null;          // 有则作为「新一版」并入已有记录
  const btn = $('btnSolve');
  btn.disabled = true; $('btnStop').classList.remove('hide');
  $('answer').classList.remove('hide');
  $('verify').classList.add('hide'); $('teach').classList.add('hide');
  $('thinkWrap').classList.add('hide'); $('followList').innerHTML = '';
  $('answerBody').textContent = '';
  note('思考中…');
  S.cur = null;

  let messages = [
    { role: 'system', content: SOLVE_SYS },
    { role: 'user', content: problem },
  ];
  let round = 0, r = null, verifyResult = null, claims = [];

  try {
    while (true) {
      r = await callLLMRobust(messages, {
        onText: (t) => { $('answerBody').innerHTML = render(t); },
        onThink: (t) => {
          $('thinkWrap').classList.remove('hide');
          $('think').textContent = t.length > 6000 ? t.slice(-6000) : t;
          $('thinkLen').textContent = fmtTok(t.length) + ' 字符';
        },
        onNote: (m) => note(m),
      });
      showAnswer(S.cfg.model, r.content, r.reasoning);
      note(`${r.secs.toFixed(0)}s · 入 ${fmtTok(r.usage.prompt_tokens)} / 出 ${fmtTok(r.usage.completion_tokens)} · ${r.finish || '-'}` +
        (r.usage.credit !== undefined ? ` · ${r.usage.credit} 积分` : ''));

      claims = extractClaims(r.content);
      if (!claims.length && S.cfg.autoVerify && opts.rounds !== 0) {
        note('未找到机检结论，补一次审计…');
        claims = await auditClaims(problem, r.content);
      }
      if (!claims.length || !S.cfg.autoVerify) break;

      note('本地验证中…');
      verifyResult = await verify(claims);
      if (verifyResult.summary.refuted === 0 || round >= (opts.rounds === undefined ? 2 : opts.rounds)) break;

      round++;
      note(`发现 ${verifyResult.summary.refuted} 条反例，第 ${round} 轮修正…`);
      messages = messages.concat([
        { role: 'assistant', content: r.content },
        { role: 'user', content: buildRefinePrompt(verifyResult) },
      ]);
    }
  } catch (e) {
    if (e.name === 'AbortError') { note('已停止'); }
    else { $('answerBody').innerHTML = '<span class="err">' + esc(e.message || String(e)) + '</span>'; note(''); }
  } finally {
    btn.disabled = false; $('btnStop').classList.add('hide'); S.abort = null;
  }

  if (r && r.content) {
    const rec = {
      id: 'b' + Date.now(), answer: r.content, think: r.reasoning || '',
      model: S.cfg.model, verify: verifyResult, claims, rounds: round, at: Date.now(),
    };
    let item = into ? S.items.find((x) => x.id === into) : null;
    if (item) {
      Branch.push(item, rec);
      item.at = Date.now();
    } else {
      item = {
        id: 'it' + Date.now(), problem, answer: rec.answer, think: rec.think, model: rec.model,
        verify: rec.verify, claims: rec.claims, rounds: rec.rounds, at: Date.now(), fav: false,
        branches: [rec], bi: 0,
      };
      if (S.ocrImg) item.img = S.ocrImg;
      S.items.unshift(item);
    }
    if (!item.thread || !item.thread.length) {
      item.thread = [{ role: 'assistant', content: rec.answer, at: Date.now(), model: rec.model }];
    } else {
      item.thread.push({ role: 'assistant', content: rec.answer, at: Date.now(), model: rec.model });
    }
    S.cur = item;
    save();
    $('teach').classList.remove('hide');
    renderChat();
    renderMeta(S.cur);
    classifyItem(S.cur);
    $('btnFav').textContent = '收藏';
    if (verifyResult) renderVerify(verifyResult);
    const acts = [];
    if (verifyResult && verifyResult.summary.refuted) acts.push('<button class="ghost sm" id="btnRedo">再修正一轮</button>');
    if (claims.length) acts.push('<button class="ghost sm" id="btnReVerify">重新验证</button>');
    $('verifyActs').innerHTML = acts.join('');
    if ($('btnRedo')) $('btnRedo').onclick = () => solve(problem, { rounds: 1 });
    if ($('btnReVerify')) $('btnReVerify').onclick = async () => {
      const d = await verify(claims);
      if (S.cur) { S.cur.verify = d; save(); }
    };
    renderBranches(S.cur);
    if (typeof Mermaid !== 'undefined') Mermaid.decorate($('answer')).catch(() => { });
  }
}

/* 分支条：第 1/2/3 版切换 + 再解一版 */
function renderBranches(item) {
  const el = $('branchBar');
  if (!el || !item) return;
  const L = Branch.list(item);
  if (!L.length) { el.innerHTML = ''; el.classList.add('hide'); return; }
  el.classList.remove('hide');
  const bi = Math.min(item.bi || 0, L.length - 1);
  el.innerHTML = L.map((b, i) => {
    const v = b.verify && b.verify.summary;
    const mark = v ? (v.refuted ? ' ⚠' : (v.proved ? ' ✓' : '')) : '';
    return '<button class="brchip ' + (i === bi ? 'on' : '') + '" data-i="' + i + '">第 ' + (i + 1) + ' 版' + mark + '</button>';
  }).join('') + '<button class="brchip new" id="btnNewBranch">＋ 再解一版</button>';
  el.querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => {
      if (!Branch.use(item, +b.dataset.i)) return;
      save();
      showAnswer(item.model, item.answer, item.think || '');
      renderBranches(item);
      if (item.verify) renderVerify(item.verify); else $('verify').classList.add('hide');
      if (typeof Mermaid !== 'undefined') Mermaid.decorate($('answer')).catch(() => { });
    };
  });
  const nb = $('btnNewBranch');
  if (nb) {
    nb.onclick = () => {
      const lv = $('level').value;
      solve(item.problem, { into: item.id, rounds: lv === 'cheap' ? 0 : (lv === 'strict' ? 3 : 2) });
    };
  }
}

let TESS = null;

function visionModelName() { return (S.cfg.visionModel || S.cfg.model || '').trim(); }

function visionState() {                       // {ok:true/false, at} 或 undefined
  return (S.cfg.vcap || {})[visionModelName()];
}

function visionAllowed() {
  const st = visionState();
  return st ? st.ok !== false : true;          // 没测过就先试一次
}

function setVisionState(ok, note) {
  S.cfg.vcap = S.cfg.vcap || {};
  S.cfg.vcap[visionModelName()] = { ok: !!ok, at: Date.now(), note: note || '' };
  save();
}

async function ocrInit() {
  if (TESS) return TESS;
  if (typeof Tesseract === 'undefined') throw new Error('本地 OCR 脚本未加载（vendor/tess/tesseract.min.js）');
  $('ocrStatus').textContent = '加载本地识别引擎（首次 1–3 秒）…';
  TESS = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
    workerPath: '/static/vendor/tess/worker.min.js',
    corePath: '/static/vendor/tess/core',
    langPath: '/static/vendor/tess/lang',
    cacheMethod: 'none',
    logger: (m) => {
      if (m.status === 'recognizing text') $('ocrStatus').textContent = '本地识别中 ' + Math.round((m.progress || 0) * 100) + '%';
    },
  });
  await TESS.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
  return TESS;
}

function ocrPreprocess(img) {
  const maxSide = 1800;
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h), a = d.data;
  let lo = 255, hi = 0;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < a.length; i += 4, j++) {
    const v = (a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114) | 0;
    gray[j] = v; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const span = Math.max(1, hi - lo);
  for (let j = 0, i = 0; j < gray.length; j++, i += 4) {
    const v = Math.max(0, Math.min(255, ((gray[j] - lo) * 255 / span) | 0));
    a[i] = a[i + 1] = a[i + 2] = v; a[i + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  return cv;
}

async function runLocalOcr(src) {
  const t0 = Date.now();
  const im = await loadImg(src);
  const cv = ocrPreprocess(im);
  const w = await ocrInit();
  const r = await w.recognize(cv);
  let txt = (r.data.text || '').replace(/\r/g, '').replace(/\u3000/g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: txt, conf: r.data.confidence ? Math.round(r.data.confidence) : null, secs: (Date.now() - t0) / 1000 };
}

async function runVision(src) {
  if (!S.cfg.base) throw new Error('还没配置模型端点');
  const t0 = Date.now();
  const durl = await shrinkImage(src);
  const r = await callLLM([{ role: 'user', content: [
    { type: 'text', text: VISION_PROMPT },
    { type: 'image_url', image_url: { url: durl } },
  ] }], { model: visionModelName(), temp: 0, maxTokens: 2000, thinking: false });
  const txt = (r.content || '').trim();
  if (!txt) throw new Error('模型没有返回文字');
  return { text: txt, secs: (Date.now() - t0) / 1000, kb: Math.round(durl.length * 0.75 / 1024) };
}

async function recognizeImage(src) {
  if (S.ocrBusy) return;
  S.ocrBusy = true;
  $('ocrBox').classList.remove('hide');
  $('ocrPrev').src = src;
  ['paneLocal', 'paneVision', 'ocrFillRow'].forEach((id) => $(id).classList.add('hide'));
  $('ocrStatus').style.color = '';
  $('ocrStatus').textContent = '开始识别…';
  const res = { local: null, vision: null };

  const jobs = [(async () => {
    try {
      res.local = await runLocalOcr(src);
      $('ocrText').textContent = res.local.text || '(没识别出文字)';
      $('localConf').textContent = (res.local.conf !== null ? `置信度 ${res.local.conf}% · ` : '') + `${res.local.secs.toFixed(1)}s`;
      $('paneLocal').classList.remove('hide');
    } catch (e) {
      $('ocrStatus').textContent = '本地 OCR 失败：' + (e.message || e);
    }
  })()];

  if (visionAllowed()) {
    jobs.push((async () => {
      try {
        res.vision = await runVision(src);
        $('ocrVision').textContent = res.vision.text;
        $('visionConf').textContent = `${visionModelName()} · ${res.vision.secs.toFixed(1)}s · 图 ${res.vision.kb}KB`;
        $('paneVision').classList.remove('hide');
        if (!visionState()) setVisionState(true, 'ok');
      } catch (e) {
        setVisionState(false, String(e.message || e).slice(0, 80));
        $('paneVision').classList.add('hide');
        $('ocrStatus').textContent = '当前模型读不了图（' + String(e.message || e).slice(0, 60) + '），已仅用本地 OCR';
      }
    })());
  } else {
    $('btnOcrModel').style.opacity = '0.55';
  }

  await Promise.all(jobs);
  // 择优填入：模型读图（公式保真）优先，其次本地 OCR
  const best = (res.vision && res.vision.text) || (res.local && res.local.text) || '';
  if (best) {
    $('q').value = best; updateQMeta(); autoGrow();
    $('ocrFillRow').classList.remove('hide');
  }
  const both = res.local && res.vision;
  const parts = [];
  if (res.vision) parts.push('模型读图 ' + res.vision.secs.toFixed(1) + 's');
  if (res.local) parts.push('本地 OCR ' + res.local.secs.toFixed(1) + 's' + (res.local.conf !== null ? `（${res.local.conf}%）` : ''));
  if (parts.length) {
    $('ocrStatus').textContent = parts.join(' · ') + (both ? ' · 两段结果都在下面，可切换采用' : '') + ' · 公式请核对';
    $('ocrStatus').style.color = 'var(--warn)';
  }
  S.ocrBusy = false;
}

function pickImage(file) {
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => { S.ocrImg = fr.result; recognizeImage(S.ocrImg); };
  fr.readAsDataURL(file);
}

async function classifyItem(item) {
  if (!item || item.meta || !S.cfg.base) return;
  const hint = item.verify && item.verify.summary
    ? `\n\n本机验证：${item.verify.summary.proved}/${item.verify.summary.total} 条断言成立，${item.verify.summary.refuted} 条被推翻。`
    : '';
  try {
    const r = await callLLM([
      { role: 'system', content: CLASSIFY_SYS },
      { role: 'user', content: '题目：\n' + (item.problem || '').slice(0, 1200) + '\n\n解答节选：\n' + (item.answer || '').slice(0, 1500) + hint },
    ], { stream: true, temp: 0, maxTokens: 260, thinking: false });
    const j = parseJsonLoose(r.content);
    if (j) {
      item.meta = {
        topic: String(j.topic || '其他').slice(0, 20),
        tags: (Array.isArray(j.tags) ? j.tags : []).map((x) => String(x).slice(0, 20)).slice(0, 6),
        err: String(j.err || '').slice(0, 120),
      };
      save();
      if (S.cur === item) renderMeta(item);
    }
  } catch (e) { /* 分类失败不影响主线 */ }
}

function renderMeta(item) {
  const el = $('tagChips');
  if (!item || !item.meta) { el.innerHTML = ''; return; }
  const m = item.meta;
  el.innerHTML = `<span class="chip topic">${esc(m.topic)}</span>`
    + (m.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')
    + (m.err ? `<span class="chip err">错因：${esc(m.err)}</span>` : '');
}

async function teach(extra) {
  if (!S.cur) return;
  const persona = PERSONA[$('persona').value] || PERSONA.coach;
  const msgs = [
    { role: 'system', content: persona + '\n\n下面是已完成的解答，请在此基础上讲解。' },
    { role: 'user', content: '题目：\n' + S.cur.problem + '\n\n解答：\n' + plain(S.cur.answer) +
      (S.cur.verify ? `\n\n本地验证：${S.cur.verify.summary.proved}/${S.cur.verify.summary.total} 条断言通过` : '') },
  ];
  if (extra) msgs.push({ role: 'assistant', content: $('teachBody').dataset.raw || '' }, { role: 'user', content: extra });
  $('teachWrap').classList.remove('hide');
  $('teachWrap').open = true;
  $('teachBody').textContent = '…';
  try {
    const r = await callLLMRobust(msgs, {
      temp: 0.7,
      onText: (t) => { $('teachBody').innerHTML = render(t); },
    });
    $('teachBody').innerHTML = render(r.content);
    $('teachBody').dataset.raw = r.content;
  } catch (e) {
    $('teachBody').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
}

function openCfg() {
  $('cfgBase').value = S.cfg.base; $('cfgKey').value = S.cfg.key;
  $('cfgModel').value = S.cfg.model; $('cfgMax').value = S.cfg.maxTokens;
  $('cfgVision').value = S.cfg.visionModel || '';
  $('cfgTemp').value = S.cfg.temp; $('cfgVerify').checked = S.cfg.autoVerify;
  $('cfgRetry').checked = S.cfg.autoRetry;
  $('cfgTestOut').textContent = '';
  $('cfgSheet').classList.remove('hide');
}

function readCfgFromForm() {
  return {
    base: $('cfgBase').value.trim().replace(/\/+$/, ''),
    key: $('cfgKey').value.trim(),
    model: $('cfgModel').value.trim(),
    visionModel: $('cfgVision').value.trim(),
    maxTokens: +$('cfgMax').value || 24000,
    temp: (() => { const v = parseFloat($('cfgTemp').value); return isNaN(v) ? 0.6 : v; })(),
    autoVerify: $('cfgVerify').checked,
    autoRetry: $('cfgRetry').checked,
  };
}

async function testConn() {
  const c = readCfgFromForm();
  const out = $('cfgTestOut');
  if (!c.base) { out.textContent = '先填端点地址'; return; }
  out.textContent = '测试中…';
  const t0 = Date.now();
  try {
    const r = await callLLM([{ role: 'user', content: '回答一个字：好' }],
      { base: c.base, key: c.key, model: c.model, maxTokens: 64, stream: false, temp: 0, thinking: false });
    out.textContent = `连通 OK · ${((Date.now() - t0) / 1000).toFixed(1)}s · 回复「${(r.content || '').trim().slice(0, 20)}」`;
    out.style.color = 'var(--acc)';
  } catch (e) {
    out.textContent = '失败：' + (e.message || e);
    out.style.color = 'var(--bad)';
  }
}

function openHist() {
  $('histSheet').classList.remove('hide');
  renderHist();
}

function renderTopicView(kw) {
  const groups = {};
  for (const it of S.items) {
    const tp = (it.meta && it.meta.topic) || '未分类';
    const g = groups[tp] || (groups[tp] = { n: 0, wrong: 0, refuted: 0, tags: {} });
    g.n++;
    if (it.wrong) g.wrong++;
    if (it.verify && it.verify.summary && it.verify.summary.refuted) g.refuted++;
    for (const t of ((it.meta && it.meta.tags) || [])) g.tags[t] = (g.tags[t] || 0) + 1;
  }
  let arr = Object.entries(groups);
  if (kw) arr = arr.filter(([k, g]) => (k + ' ' + Object.keys(g.tags).join(' ')).toLowerCase().includes(kw));
  arr.sort((a, b) => b[1].n - a[1].n);
  const max = arr.length ? arr[0][1].n : 1;
  $('histCount').textContent = arr.length + ' 个分类';
  $('histList').innerHTML = arr.map(([k, g]) => {
    const tags = Object.entries(g.tags).sort((x, y) => y[1] - x[1]).slice(0, 4)
      .map(([t, c]) => `${esc(t)}×${c}`).join(' · ');
    return `<div class="tgroup"><div class="th"><b>${esc(k)}</b>
      <span class="meta">${g.n} 题${g.wrong ? ' · 错 ' + g.wrong : ''}${g.refuted ? ' · 反例 ' + g.refuted : ''}</span></div>
      <div class="tb">${tags || '—'}<div class="bar" style="width:${Math.round(g.n / max * 100)}%"></div></div></div>`;
  }).join('') || '<div class="vdetail">还没有分类数据：解一道题后会自动打标签。</div>';
}

function renderHist() {
  const kw = ($('histSearch').value || '').trim().toLowerCase();
  if (S.tab === 'topic') { renderTopicView(kw); return; }
  let list = S.items;
  if (S.tab === 'fav') list = list.filter((x) => x.fav);
  if (S.tab === 'bad') list = list.filter((x) => x.verify && x.verify.summary && x.verify.summary.refuted);
  if (S.tab === 'due') {
    const now = Date.now();
    list = list.filter((x) => x.wrong).sort((a, b) => ((a.rv && a.rv.due) || 0) - ((b.rv && b.rv.due) || 0));
  }
  if (kw) list = list.filter((x) => (x.problem + ' ' + x.answer).toLowerCase().includes(kw));
  $('histCount').textContent = list.length + ' / ' + S.items.length;
  $('histList').innerHTML = list.map((h) => {
    const v = h.verify && h.verify.summary
      ? ` · 验证 ${h.verify.summary.proved}/${h.verify.summary.total}${h.verify.summary.refuted ? ' ⚠' : ''}` : '';
    const w = h.wrong ? ` · 错题${h.rv ? (h.rv.due <= Date.now() ? '（今天复习）' : '（' + new Date(h.rv.due).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + '）') : ''}` : '';
    return `<div class="vitem hitem" data-id="${h.id}">
      <div class="vclaim">${h.fav ? '★ ' : ''}${h.meta ? '[' + esc(h.meta.topic) + '] ' : ''}${esc((h.problem || '').slice(0, 90))}</div>
      <div class="vdetail">${fmtTime(h.at)} · ${esc(h.model || '')}${v}${w}</div>
      <div class="hacts">
        <button class="ghost xs" data-act="open">打开</button>
        <button class="ghost xs" data-act="fav">${h.fav ? '取消收藏' : '收藏'}</button>
        <button class="ghost xs danger" data-act="del">删除</button>
      </div></div>`;
  }).join('') || '<div class="vdetail">没有记录</div>';

  [...$('histList').querySelectorAll('.hitem')].forEach((el) => {
    const id = el.dataset.id;
    const item = S.items.find((x) => x.id === id);
    el.querySelectorAll('[data-act]').forEach((b) => b.onclick = (ev) => {
      ev.stopPropagation();
      const act = b.dataset.act;
      if (act === 'open') { openItem(item); }
      if (act === 'fav') { item.fav = !item.fav; save(); renderHist(); }
      if (act === 'del') {
        if (!confirm('删除这条记录？')) return;
        S.items = S.items.filter((x) => x.id !== id); save(); renderHist();
      }
    });
  });
}

function openItem(h) {
  if (!h) return;
  S.cur = h;
  $('q').value = h.problem; S.q = h.problem; updateQMeta();
  showAnswer(h.model, h.answer, h.think || '');
  renderBranches(h);
  if (typeof Mermaid !== 'undefined') Mermaid.decorate($('answer')).catch(() => { });
  note(fmtTime(h.at) + (h.rounds ? ` · 修正 ${h.rounds} 轮` : ''));
  $('btnFav').textContent = h.fav ? '已收藏' : '收藏';
  $('btnWrong').textContent = h.wrong ? '已在错题本' : '记入错题';
  renderMeta(h);
  if (!h.meta) classifyItem(h);
  if (h.verify) renderVerify(h.verify); else $('verify').classList.add('hide');
  const acts = [];
  if (h.claims && h.claims.length) acts.push('<button class="ghost sm" id="btnReVerify">重新验证</button>');
  $('verifyActs').innerHTML = acts.join('');
  if ($('btnReVerify')) $('btnReVerify').onclick = async () => {
    const d = await verify(h.claims); h.verify = d; save();
  };
  $('teach').classList.remove('hide');
  renderChat();
  $('histSheet').classList.add('hide');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function exportAll() {
  try {
    const how = Store.exportZip();
    alert(how.indexOf('zip') === 0
      ? '已导出 zip 备份（含 ' + how.split(':')[1] + ' 张原图）'
      : '已导出 JSON 备份（zip 模块未加载）');
  } catch (e) { alert('导出失败：' + e.message); }
}

function importAll(file) {
  Store.importFile(file, () => renderHist());
}

function updateQMeta() {
  const n = ($('q').value || '').trim().length;
  $('qMeta').textContent = n ? n + ' 字' : '';
}

function autoGrow() {
  const t = $('q');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.42) + 'px';
}

function syncOnboard() {
  $('onboard').classList.toggle('hide', !!S.cfg.base);
}

function bind() {
  try {
  $('btnOcr').onclick = () => $('fileOcr').click();
  $('fileOcr').onchange = (e) => { pickImage(e.target.files[0]); e.target.value = ''; };
  $('btnOcrAgain').onclick = async () => {
    if (!S.ocrImg) return;
    try {
      const r = await runLocalOcr(S.ocrImg);
      $('ocrText').textContent = r.text || '(没识别出文字)';
      $('localConf').textContent = (r.conf !== null ? `置信度 ${r.conf}% · ` : '') + r.secs.toFixed(1) + 's';
      $('paneLocal').classList.remove('hide'); $('ocrFillRow').classList.remove('hide');
    } catch (e) { $('ocrStatus').textContent = '本地 OCR 失败：' + (e.message || e); }
  };
  $('btnOcrModel').onclick = async () => {
    if (!S.ocrImg) return;
    try {
      const r = await runVision(S.ocrImg);
      $('ocrVision').textContent = r.text;
      $('visionConf').textContent = `${visionModelName()} · ${r.secs.toFixed(1)}s · 图 ${r.kb}KB`;
      $('paneVision').classList.remove('hide'); $('ocrFillRow').classList.remove('hide');
      setVisionState(true); $('btnOcrModel').style.opacity = '';
    } catch (e) {
      setVisionState(false, String(e.message || e).slice(0, 80));
      $('ocrStatus').textContent = '模型读图失败：' + (e.message || e) + '（本地 OCR 仍可用）';
      $('ocrStatus').style.color = 'var(--bad)';
    }
  };
  $('btnUseLocal').onclick = () => {
    $('q').value = $('ocrText').textContent.trim(); updateQMeta(); autoGrow();
  };
  $('btnUseVision').onclick = () => {
    $('q').value = $('ocrVision').textContent.trim(); updateQMeta(); autoGrow();
  };
  $('btnOcrFill').onclick = () => {
    const t = ($('paneVision').classList.contains('hide') ? $('ocrText') : $('ocrVision')).textContent.trim()
      || $('ocrText').textContent.trim();
    if (t) { $('q').value = t; updateQMeta(); autoGrow(); $('q').scrollIntoView({ block: 'center' }); }
  };
  $('btnOcrDrop').onclick = () => { S.ocrImg = ''; $('ocrBox').classList.add('hide'); };
  $('chatSend').onclick = () => askChat($('chatInput').value);
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askChat($('chatInput').value); }
  });
  $('btnChatClear').onclick = () => {
    if (!S.cur) return;
    if (!confirm('清空这道题的追问记录？')) return;
    S.cur.thread = [{ role: 'assistant', content: S.cur.answer || '', at: Date.now() }];
    save(); renderChat();
  };
  $('btnSolve').onclick = () => {
    const p = $('q').value.trim();
    if (!p) { $('q').focus(); return; }
    S.q = p;
    const lv = $('level').value;
    solve(p, { rounds: lv === 'cheap' ? 0 : (lv === 'strict' ? 3 : 2) });
  };
  $('btnStop').onclick = () => { if (S.abort) S.abort.abort(); };
  $('btnClearQ').onclick = () => { $('q').value = ''; updateQMeta(); autoGrow(); };
  $('btnPaste').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { $('q').value = t; updateQMeta(); autoGrow(); $('q').focus(); }
    } catch (e) { $('q').focus(); }
  };
  $('q').addEventListener('input', () => { updateQMeta(); autoGrow(); });
  $('q').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('btnSolve').click(); }
  });
  $('btnCopyAns').onclick = () => copy(plain(S.cur ? S.cur.answer : $('answerBody').innerText), $('btnCopyAns'));
  $('btnCopyTex').onclick = () => copy(S.cur ? S.cur.answer : $('answerBody').innerText, $('btnCopyTex'));
  $('btnFav').onclick = () => {
    if (!S.cur) return;
    S.cur.fav = !S.cur.fav; save();
    $('btnFav').textContent = S.cur.fav ? '已收藏' : '收藏';
  };
  if (typeof markWrong === 'function') $('btnWrong').onclick = markWrong;
  if (typeof openReview === 'function') $('btnReviewStart').onclick = openReview;
  $('btnRvShow').onclick = () => {
    $('rvA').classList.remove('hide'); $('rvGrades').classList.remove('hide');
    $('btnRvShow').classList.add('hide');
  };
  $('btnRvSkip').onclick = () => { S.rvIdx++; showReviewCard(); };
  $('rvClose').onclick = () => { $('reviewSheet').classList.add('hide'); updateDueBadge(); };
  document.querySelectorAll('#rvGrades [data-g]').forEach((b) => {
    b.onclick = () => gradeReview(+b.dataset.g);
  });
  $('btnTeach').onclick = () => teach();
  $('btnTeachCopy').onclick = () => copy($('teachBody').innerText, $('btnTeachCopy'));
  $('btnFollow').onclick = () => {
    const t = $('followup').value.trim();
    if (!t) return;
    $('followup').value = '';
    const div = document.createElement('div');
    div.className = 'vitem'; div.innerHTML = '<div class="vdetail">追问：' + esc(t) + '</div>';
    $('followList').prepend(div);
    teach(t);
  };
  $('btnCfg').onclick = openCfg;
  $('obCfg').onclick = openCfg;
  $('btnHist').onclick = openHist;
  $('cfgClose').onclick = () => $('cfgSheet').classList.add('hide');
  $('histClose').onclick = () => $('histSheet').classList.add('hide');
  $('cfgTest').onclick = testConn;
  $('cfgSave').onclick = () => {
    Object.assign(S.cfg, readCfgFromForm());
    save(); $('cfgSheet').classList.add('hide'); health(); syncOnboard();
  };
  document.querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => {
    const p = b.dataset.preset;
    if (p === 'wb') { $('cfgBase').value = 'http://127.0.0.1:7863/v1'; $('cfgModel').value = 'cn:deepseek-v4-pro'; }
    if (p === 'ds') { $('cfgBase').value = 'https://api.deepseek.com/v1'; $('cfgModel').value = 'deepseek-reasoner'; }
    if (p === 'oa') { $('cfgBase').value = 'https://api.openai.com/v1'; $('cfgModel').value = 'gpt-5.1'; }
  });
  $('btnExport').onclick = exportAll;
  $('btnImport').onclick = () => $('fileImport').click();
  $('fileImport').onchange = (e) => { if (e.target.files[0]) importAll(e.target.files[0]); e.target.value = ''; };
  $('btnWipe').onclick = () => {
    if (!confirm('清空全部记录与设置（不可恢复，建议先导出备份）？')) return;
    localStorage.removeItem(LS); localStorage.removeItem(LS_OLD);
    S.items = []; S.cur = null; S.cfg = { base: '', key: '', model: '', maxTokens: 24000, temp: 0.6, autoVerify: true, autoRetry: true };
    save();
    if (typeof Store !== 'undefined') Store.wipe();
    $('cfgSheet').classList.add('hide'); syncOnboard();
    $('answer').classList.add('hide'); $('verify').classList.add('hide'); $('teach').classList.add('hide');
  };
  $('histSearch').oninput = renderHist;
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    t.classList.add('on'); S.tab = t.dataset.tab; renderHist();
  });
  $('histSheet').onclick = (e) => { if (e.target.id === 'histSheet') $('histSheet').classList.add('hide'); };
  $('cfgSheet').onclick = (e) => { if (e.target.id === 'cfgSheet') $('cfgSheet').classList.add('hide'); };
  } catch (e) { console.warn('绑定中断：', e && e.message); }
}

/* 启动：等所有脚本就位后再绑定，避免与 extra.js 的加载顺序耦合 */
let __booted = false;

function bindEngine() {
  if (!(window.isNativeApp && window.isNativeApp())) return;
  const card = $('engCard');
  if (!card) return;
  const tip = $('engTip'), prog = $('engProg');
  const setProg = (t) => { if (prog) prog.textContent = t || ''; };
  const refresh = () => {
    if (typeof window.engineStatus !== 'function') return;
    window.engineStatus().then((st) => {
      if (!st) return;
      if (st.ready) { card.classList.add('hide'); return; }
      card.classList.remove('hide');
      if (!st.installed && !window.__autoEng) {
        window.__autoEng = true;                       // 单文件 APK：自动解压内置引擎包
        const off0 = window.onInstallProgress ? window.onInstallProgress((d) => {
          setProg((d.msg || d.phase || '') + (d.pct ? '（' + d.pct + '%）' : ''));
        }) : () => {};
        window.engineInstallAuto().then((r) => {
          setProg(r && r.ready ? '引擎已就绪 ✅' : '已解压，引擎正在启动…');
          setTimeout(() => { if (window.lbReset) window.lbReset(); refresh(); }, 1500);
        }).catch((e) => {
          tip.textContent = '自动解压失败：' + (e && (e.message || e)) + '（可用下面的「手动选择引擎包」）';
        }).finally(() => off0());
        return;
      }
      if (st.installed) {
        tip.textContent = st.starting ? '引擎正在启动…' : '引擎包已安装，但服务还没起来。点「启动 / 重试」，或看日志。';
      } else {
        tip.textContent = '正在准备内置引擎包（约 645 MB，2–5 分钟，只在第一次做）。';
      }
    }).catch(() => { card.classList.remove('hide'); });
  };
  const bIns = $('btnEngInstall'), bStart = $('btnEngStart'), bLog = $('btnEngLog');
  if (bIns) bIns.onclick = () => {
    setProg('准备选择文件…');
    const off = window.onInstallProgress ? window.onInstallProgress((d) => {
      setProg((d.msg || d.phase || '') + (d.pct && d.pct < 100 ? '（' + d.pct + '%）' : ''));
    }) : () => {};
    bIns.disabled = true;
    window.engineInstall().then((r) => {
      setProg(r && r.ready ? '引擎已就绪 ✅' : '已安装，正在启动…');
      setTimeout(() => { if (window.lbReset) window.lbReset(); refresh(); }, 1500);
    }).catch((e) => setProg('安装失败：' + (e && (e.message || e))))
      .finally(() => { bIns.disabled = false; off(); });
  };
  if (bStart) bStart.onclick = () => {
    setProg('正在启动…');
    window.engineStart().then(() => { if (window.lbReset) window.lbReset(); refresh(); })
      .catch((e) => setProg('启动失败：' + (e && (e.message || e))));
  };
  if (bLog) bLog.onclick = () => {
    window.engineLog().then((r) => { setProg(''); alert('后端日志尾部：\n\n' + ((r && r.text) || '(空)')); });
  };
  refresh();
  setInterval(refresh, 8000);
}

function bootUI() {
  if (__booted) return;
  __booted = true;
  try {
    load();
    if (typeof Store !== 'undefined') Store.boot();
    bind();
    if (typeof health === 'function') health();
    syncOnboard();
    updateQMeta();
    autoGrow();
    if (typeof updateDueBadge === 'function') updateDueBadge();
    bindEngine();
    if (typeof renderChat === 'function') renderChat();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
  } catch (e) {
    console.warn('启动异常：', e && e.message);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootUI);
else bootUI();
