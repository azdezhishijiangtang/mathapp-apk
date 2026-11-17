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

const GAP_TIP = {
  identity: '把两边都展开成多项式，sympy 能直接判定',
  ineq: '写清自变量区间（例如 "x":[0,1.5708]）；单变量会走 Arb 200 位，简单的三角界还能被 cvc5 严格证明',
  value: '给出精确值（1/3、pi/6 这种），别写近似小数',
  nt: '把区间收窄到有限范围，或改写成 CP-SAT 能判的整数约束（可到 1e9）',
  forall_int: '区间写小一点，超过 200 万点会自动转 CP-SAT；简单命题它能直接证明',
  exists_int: '给出范围，CP-SAT 会去找见证；找不到就是「大概率不存在」',
  mod: '补上模数与变量范围，穷举判定需要有限区间',
  recurrence: '把初值和递推式都写全（前项用 a_prev 表示）',
  geom: '先建系写成坐标多项式：hyps 放各点约束（=0），goal 放待证多项式；非退化条件放 nondeg',
};
function gapAdvice(x) {
  const k = (x.kind || '').toLowerCase();
  const base = GAP_TIP[k] || '把这一步拆成更小的等式/不等式再交上来';
  if (x.status === 'unknown') return '未能判定：' + base;
  if (x.status === 'no_counterexample_found') return '只拿到抽样证据：' + base;
  if (x.status === 'error') return '没解析成功：检查 LaTeX 写法（\\frac{a}{b}，乘号用 \\cdot 或空格）';
  return base;
}

function renderVerify(d) {
  if (!d) return;
  $('verify').classList.remove('hide');
  const rs = d.results || [];
  $('verifyList').innerHTML = rs.map((x) => {
    const [cls, label] = V_MAP[x.status] || ['b-unk', x.status];
    const det = [x.detail, x.min_enclosure ? '最小包络 ' + x.min_enclosure : '', x.at ? '@' + x.at : '',
      x.point ? '反例 ' + JSON.stringify(x.point) : '', x.engine ? '[' + x.engine + ']' : '',
      x.secs !== undefined ? x.secs + 's' : ''].filter(Boolean).join(' · ');
    return `<div class="vitem"><div class="vhead"><span class="badge ${cls}">${label}</span>
      <span class="vclaim">${esc(x.claim || '')}</span></div><div class="vdetail">${esc(det)}</div></div>`;
  }).join('') || '<div class="vdetail">无断言</div>';

  const s = d.summary || {};
  const total = s.total || 0, proved = s.proved || 0, refuted = s.refuted || 0;
  const rest = Math.max(0, total - proved - refuted);
  const pct = (n) => (total ? Math.round((n * 100) / total) : 0);
  const bar = $('verifyBar');
  if (bar && total) {
    bar.classList.remove('hide');
    bar.innerHTML = '<div class="vbarIn">'
      + '<i class="ok" style="width:' + pct(proved) + '%"></i>'
      + '<i class="no" style="width:' + pct(rest) + '%"></i>'
      + '<i class="bad" style="width:' + pct(refuted) + '%"></i></div>'
      + '<div class="meta">严格证明 ' + proved + ' · 只到抽样 ' + rest + ' · 被推翻 ' + refuted
      + ' · 证据覆盖率 ' + Math.round((d.coverage || 0) * 100) + '%</div>';
  }
  $('verifySum').textContent = proved + '/' + total + ' 通过 · 覆盖率 '
    + Math.round((d.coverage || 0) * 100) + '%' + (refuted ? ' · ' + refuted + ' 条被推翻' : '');

  const gaps = rs.filter((x) => x.status !== 'proved' && x.status !== 'refuted');
  const box = $('verifyGap');
  if (box) {
    if (!gaps.length) { box.classList.add('hide'); box.innerHTML = ''; }
    else {
      box.classList.remove('hide');
      box.innerHTML = '<b>还差 ' + gaps.length + ' 条没被严格证明（下面是可以怎么改）</b>'
        + gaps.slice(0, 6).map((x) => '<div class="gapitem"><span class="vclaim">'
          + esc((x.claim || '').slice(0, 90)) + '</span><div class="vdetail">' + esc(gapAdvice(x)) + '</div></div>').join('');
    }
  }
}

/** 两个模型答案是否一致 —— 不一致就明确告诉用户「这题不可靠」 */
function renderCross(c) {
  const el = $('crossRow');
  if (!el) return;
  if (!c) { el.classList.add('hide'); el.innerHTML = ''; return; }
  el.classList.remove('hide');
  if (c.err) {
    el.className = 'cross warn';
    el.innerHTML = '<b>交叉复核没跑成</b><div class="meta">' + esc(c.err) + '（不影响上面的结果）</div>';
    return;
  }
  if (c.same) {
    el.className = 'cross ok';
    el.innerHTML = '<b>两个模型答案一致 ✓</b><div class="meta">' + esc(c.m1) + ' 与 ' + esc(c.m2)
      + ' 都给出 ' + esc(c.a1) + '</div>';
    return;
  }
  if (!c.a1 || !c.a2) {
    el.className = 'cross warn';
    el.innerHTML = '<b>没法和第二模型对答案</b><div class="meta">至少一方没写出 \\boxed{}，'
      + (c.a1 ? '主模型 ' + esc(c.a1) + '；' : '') + (c.a2 ? '副模型 ' + esc(c.a2) : '') + '</div>';
    return;
  }
  el.className = 'cross bad';
  el.innerHTML = '<b>⚠ 两个模型答案不一致，这题不可靠</b><div class="meta">'
    + esc(c.m1) + ' → ' + esc(c.a1) + ' ／ ' + esc(c.m2) + ' → ' + esc(c.a2)
    + '。建议看「问法 / 版本树」里再解一版，或人工判断。</div>';
}

async function solve(problem, opts = {}) {
  // 对话式：把提问显示成一条用户消息
  try {
    const echo = $('qEcho');
    if (echo && !opts.silentEcho) {
      echo.querySelector('.bubx').innerHTML = render(problem);
      echo.classList.remove('hide');
      ($('hero') || {}).classList && $('hero').classList.add('hide');
    }
  } catch (e) { }
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

  const __lvl = (($('level') && $('level').value) || 'std');
  const useModel = (__lvl === 'cheap' && S.cfg.modelCheap) ? S.cfg.modelCheap : S.cfg.model;
  renderCross(null);
  const ansStream = mkStream($('answerBody'));

  let messages = [
    { role: 'system', content: SOLVE_SYS },
    { role: 'user', content: problem },
  ];
  let round = 0, r = null, verifyResult = null, claims = [];

  try {
    while (true) {
      r = await callLLMRobust(messages, {
        model: useModel,
        onText: (t) => ansStream.push(t),
        onThink: (t) => {
          $('thinkWrap').classList.remove('hide');
          $('think').textContent = t.length > 6000 ? t.slice(-6000) : t;
          $('thinkLen').textContent = fmtTok(t.length) + ' 字符';
        },
        onNote: (m) => note(m),
      });
      ansStream.end(null);
      showAnswer(useModel, r.content, r.reasoning);
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
    else {
      const c = classifyErr(e);
      $('answerBody').innerHTML = '<span class="err">' + esc(c.text) + '</span>';
      const acts = $('verifyActs');
      if (acts && c.act) {
        acts.innerHTML = c.act === 'cfg'
          ? '<button class="ghost sm" id="errCfg">去检查端点与 Key</button>'
          : c.act === 'retry' ? '<button class="ghost sm" id="errRetry">重试</button>'
            : c.act === 'engine' ? '<button class="ghost sm" id="errEng">去装引擎</button>' : '';
        const b = $('errCfg'); if (b) b.onclick = openCfg;
        const b2 = $('errRetry'); if (b2) b2.onclick = () => solve(S.q || ($('q') || {}).value || '');
        const b3 = $('errEng'); if (b3) b3.onclick = () => { const e2 = $('engCard'); if (e2) e2.classList.remove('hide'); };
      }
      note('');
    }
  } finally {
    btn.disabled = false; $('btnStop').classList.add('hide'); S.abort = null;
  }

  let cross = null;
  if (r && r.content && S.cfg.model2 && S.cfg.model2 !== useModel) {
    note('交叉复核：' + S.cfg.model2 + ' 独立再解一遍…');
    try {
      const r2 = await callLLM([{ role: 'system', content: SOLVE_SYS }, { role: 'user', content: problem }],
        { model: S.cfg.model2, maxTokens: Math.min(S.cfg.maxTokens, 20000), stream: false, thinking: false });
      const a1 = boxedOf(r.content), a2 = boxedOf(r2.content);
      cross = { m1: useModel, m2: S.cfg.model2, a1, a2, same: !!a1 && !!a2 && normAns(a1) === normAns(a2) };
    } catch (e) {
      cross = { m1: useModel, m2: S.cfg.model2, err: String((e && e.message) || e).slice(0, 140) };
    }
    renderCross(cross);
  }

  if (r && r.content) {
    let item = into ? S.items.find((x) => x.id === into) : null;
    const qid = opts.qid || (item && typeof Tree !== 'undefined' ? Tree.qId(item) : 'q0');
    const rec = {
      id: 'b' + Date.now(), answer: r.content, think: r.reasoning || '',
      model: useModel, verify: verifyResult, claims, rounds: round, at: Date.now(), qid,
      ...(cross ? { cross } : {}),
    };
    if (item) {
      Branch.push(item, rec);
      item.at = Date.now();
    } else {
      item = {
        id: 'it' + Date.now(), problem, answer: rec.answer, think: rec.think, model: rec.model,
        verify: rec.verify, claims: rec.claims, rounds: rec.rounds, at: Date.now(), fav: false,
        branches: [rec], bi: 0,
        qv: [{ id: 'q0', text: problem, at: Date.now() }], qsel: 'q0',
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
  }).join('') + '<button class="brchip new" id="btnNewBranch">＋ 再解一版</button>' +
    '<button class="brchip" id="btnTree">问法 / 版本树</button>';
  el.querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => {
      if (!Branch.use(item, +b.dataset.i)) return;
      const L = Branch.list(item);
      const bb = L[+b.dataset.i];
      if (bb && bb.qid) item.qsel = bb.qid;
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
  const bt = $('btnTree');
  if (bt) bt.onclick = () => { if (typeof Tree !== 'undefined') Tree.open(S.cur || item); };
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
  const tStream = mkStream($('teachBody'));
  try {
    const r = await callLLMRobust(msgs, {
      temp: 0.7,
      onText: (t) => tStream.push(t),
    });
    tStream.end(r.content);
    $('teachBody').dataset.raw = r.content;
  } catch (e) {
    $('teachBody').innerHTML = '<span class="err">' + esc(e.message) + '</span>';
  }
}

function openCfg() {
  $('cfgBase').value = S.cfg.base; $('cfgKey').value = S.cfg.key;
  $('cfgModel').value = S.cfg.model; $('cfgMax').value = S.cfg.maxTokens;
  $('cfgVision').value = S.cfg.visionModel || '';
  if ($('cfgModel2')) $('cfgModel2').value = S.cfg.model2 || '';
  if ($('cfgModelCheap')) $('cfgModelCheap').value = S.cfg.modelCheap || '';
  if ($('cfgCapDaily')) $('cfgCapDaily').value = S.cfg.capDaily || 0;
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
    model2: (($('cfgModel2') && $('cfgModel2').value) || '').trim(),
    modelCheap: (($('cfgModelCheap') && $('cfgModelCheap').value) || '').trim(),
    capDaily: Math.max(0, +((($('cfgCapDaily') && $('cfgCapDaily').value) || 0)) || 0),
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
  const rows = list.map((h) => {
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
  });
  const grouped = (S.tab === 'all' && !kw) ? groupRows(list, rows) : rows;
  $('histList').innerHTML = grouped.join('') || '<div class="vdetail">没有记录</div>';

  [...$('histList').querySelectorAll('.hitem')].forEach((el) => {
    const id = el.dataset.id;
    const item = S.items.find((x) => x.id === id);
    el.querySelectorAll('[data-act]').forEach((b) => b.onclick = (ev) => {
      ev.stopPropagation();
      const act = b.dataset.act;
      if (act === 'open') { openItem(item); }
      if (act === 'fav') { item.fav = !item.fav; save(); renderHist(); }
      if (act === 'del') {
        const idx = S.items.indexOf(item);
        S.items = S.items.filter((x) => x.id !== id); save(); renderHist(); syncDueBar();
        toast('已删除 1 条记录', '撤销', () => {
          if (idx >= 0) S.items.splice(idx, 0, item); else S.items.unshift(item);
          save(); renderHist(); syncDueBar(); toast('已恢复这条记录');
        }, 6000);
      }
    });
  });
}

/** 记录按「今天 / 昨天 / 7 天内 / 30 天内 / 按月」分组，省掉搜索框的使用压力 */
function groupRows(list, rows) {
  const DAY = 86400000;
  const sod = (t) => new Date(t).setHours(0, 0, 0, 0);
  const now = Date.now();
  const out = [];
  let last = '';
  list.forEach((h, i) => {
    const diff = Math.floor((now - sod(h.at)) / DAY);
    let k;
    if (diff <= 0) k = '今天';
    else if (diff <= 1) k = '昨天';
    else if (diff < 7) k = '7 天内';
    else if (diff < 30) k = '30 天内';
    else { const d = new Date(h.at); k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
    if (k !== last) { out.push('<div class="ghd">' + k + '</div>'); last = k; }
    out.push(rows[i]);
  });
  return out;
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
  try { syncHero(); } catch (e) { }
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
  // 引导只在"没配端点 且 没看过"时出现一次；看过就永久不再打扰（菜单里可重新打开）
  const need = !S.cfg.base && !S.cfg.onboarded;
  $('onboard').classList.toggle('hide', !need);
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
  const bKbd = $('btnKbd');
  if (bKbd) bKbd.onclick = () => { const w = $('kbdWrap'); if (w) { w.classList.toggle('hide'); w.open = !w.classList.contains('hide'); } };
  const chips = document.querySelectorAll('#exChips [data-ex]');
  for (let i = 0; i < chips.length; i++) chips[i].onclick = () => {
    $('q').value = chips[i].getAttribute('data-ex');
    updateQMeta(); autoGrow(); $('q').focus();
  };
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
  $('obCfg').onclick = () => { S.cfg.onboarded = 1; save(); syncOnboard(); openCfg(); };
  const bHelp = $('btnHelp');
  if (bHelp) bHelp.onclick = () => {
    S.cfg.onboarded = 0; save(); syncOnboard();
    const ms = $('moreSheet'); if (ms) ms.classList.add('hide');
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { }
  };
  $('btnHist').onclick = openHist;
  $('cfgClose').onclick = () => $('cfgSheet').classList.add('hide');
  $('histClose').onclick = () => $('histSheet').classList.add('hide');
  $('cfgTest').onclick = testConn;
  $('cfgSave').onclick = () => {
    Object.assign(S.cfg, readCfgFromForm());
    S.cfg.onboarded = 1;
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

function alertOnce(card) {
  const b = card.querySelector('b');
  if (b) b.textContent = '本机验证引擎已就绪（离线，八条引擎）· 点此看详情';
  if (!card.__click) {
    card.__click = 1;
    card.onclick = () => { if (card.classList.contains('ready')) card.classList.toggle('open'); };
  }
}

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
      if (st.ready) {
        card.classList.remove('hide'); card.classList.add('ready');
        alertOnce(card);
        return;
      }
      card.classList.remove('ready', 'open');
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

/* ===== v2.2：提示条 / 今日复习入口 ===== */
let __toastT = null;
function toast(msg, action, fn, ms) {
  const el = $('toast');
  if (!el) return;
  el.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button id="toastAct">' + esc(action) + '</button>' : '');
  el.classList.remove('hide');
  const b = $('toastAct');
  if (b) b.onclick = () => { el.classList.add('hide'); try { fn && fn(); } catch (e) {} };
  clearTimeout(__toastT);
  __toastT = setTimeout(() => el.classList.add('hide'), ms || 4000);
}

/** 首页「今天有几道错题到期」——复习排程的唯一入口 */
function syncDueBar() {
  const bar = $('dueBar');
  if (!bar || typeof S === 'undefined' || !S.items) return;
  let due = 0, all = 0;
  try {
    due = (typeof dueList === 'function') ? dueList().length : 0;
  } catch (e) { due = 0; }
  all = S.items.filter((x) => x.wrong).length;
  const n = $('dueN'), a = $('dueAll');
  if (n) n.textContent = due;
  if (a) a.textContent = all ? '（共 ' + all + ' 道错题）' : '';
  bar.classList.toggle('hide', due === 0);
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const b = $('btnDueStart');
    if (b) b.onclick = () => { if (typeof openReview === 'function') openReview(); };
    syncDueBar();
    setInterval(syncDueBar, 20000);
    if (typeof updateDueBadge === 'function') {
      const _u = updateDueBadge;
      updateDueBadge = function () { const r = _u.apply(this, arguments); try { syncDueBar(); } catch (e) {} return r; };
    }
  } catch (e) {}
});

/* ---- v2.3 本机诊断 + 数据自检 ---- */

async function renderDiag() {
  const body = $('diagBody');
  if (!body) return;
  body.innerHTML = '<div class="meta">检查中…</div>';
  const L = [];
  let raw = '';
  try { raw = localStorage.getItem(LS) || ''; } catch (e) { }
  L.push(['记录', S.items.length + ' 条 · 本机存储 ' + (raw.length / 1024).toFixed(0) + ' KB']);
  try { const rows = await Store.all(); L.push(['索引库', rows.length + ' 条']); }
  catch (e) { L.push(['索引库', '不可用：' + e.message]); }
  let snaps = [];
  try { snaps = await Store.Snap.list(); } catch (e) { }
  L.push(['快照', snaps.length ? snaps.length + ' 份 · 最近 ' + new Date(snaps[0].at).toLocaleString() + '（' + snaps[0].n + ' 条）' : '还没有']);
  try {
    const r = await (window.apiFetch || fetch)('/api/health');
    const d = await r.json();
    L.push(['后端', 'v' + (d.version || '?') + ' · ' + (location.host || '本机')]);
    L.push(['引擎', (d.engines || []).length ? (d.engines || []).join('、') : '未就绪']);
  } catch (e) {
    L.push(['后端', '连不上：' + e.message]);
    try { ErrLog.push('health', e.message); } catch (e2) { }
  }
  if (window.isNativeApp && window.isNativeApp()) {
    try { const st = await window.engineStatus(); L.push(['引擎进程', JSON.stringify(st)]); } catch (e) { L.push(['引擎进程', String(e.message || e)]); }
  }
  let logTail = '';
  if (window.engineLog) { try { const t = await window.engineLog(); logTail = String((t && (t.text || t.log || t)) || ''); } catch (e) { } }
  const errs = (typeof ErrLog !== 'undefined') ? ErrLog.list().slice(0, 8) : [];
  body.innerHTML = L.map(([k, v]) => '<div class="drow"><span class="dk">' + esc(k) + '</span><span class="dv">' + esc(v) + '</span></div>').join('') +
    (snaps.length > 1 ? '<div class="meta">历史快照：' + snaps.slice(1).map((s) => new Date(s.at).toLocaleString() + '·' + s.n + '条').join(' ｜ ') + '</div>' : '') +
    (errs.length ? '<div class="meta">最近错误：</div>' + errs.map((e) => '<div class="der">' + esc(new Date(e.at).toLocaleTimeString() + ' · ' + e.kind + ' · ' + e.msg) + '</div>').join('') : '<div class="meta">没有记录到错误</div>') +
    (logTail ? '<div class="meta">引擎日志（尾部）：</div><pre class="code">' + esc(logTail.slice(-1600)) + '</pre>' : '');
}

async function diagCopy() {
  const rows = [...document.querySelectorAll('#diagBody .drow')].map((r) => r.textContent.trim());
  const errs = (typeof ErrLog !== 'undefined') ? ErrLog.list().slice(0, 8).map((e) => new Date(e.at).toLocaleString() + ' ' + e.kind + ' ' + e.msg) : [];
  const txt = '【数学答疑 · 本机诊断】\n' + rows.join('\n') + (errs.length ? '\n\n最近错误：\n' + errs.join('\n') : '');
  try { await copy(txt); toast('诊断信息已复制'); } catch (e) { alert(txt); }
}

async function openDiag() {
  const s = $('diagSheet');
  if (!s) return;
  s.classList.remove('hide');
  await renderDiag();
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('btnDiag', openDiag);
    on('btnDiag2', openDiag);
    on('btnSnapNow', async () => {
      const r = await Store.Snap.put('manual');
      toast(r ? ('已快照 ' + r.n + ' 条 · ' + (r.bytes / 1024).toFixed(0) + ' KB') : '快照失败（索引库不可用）');
      await renderDiag();
    });
    on('btnSnapRestore', async () => {
      const L = await Store.Snap.list();
      if (!L.length) return toast('还没有快照');
      const t = new Date(L[0].at).toLocaleString();
      if (!confirm('用最新快照（' + t + '，' + L[0].n + ' 条）覆盖当前记录？')) return;
      const n = await Store.Snap.restore(L[0].at);
      toast(n == null ? '恢复失败' : ('已恢复 ' + n + ' 条'));
      try { renderHist(); } catch (e) { }
      try { syncDueBar(); } catch (e) { }
      await renderDiag();
    });
    on('btnErrClear', () => { try { ErrLog.clear(); } catch (e) { } renderDiag(); });
    on('btnDiagCopy', diagCopy);

    /* 引擎看护事件（重启 / 版本重装）全局监听：不管用户在哪个页面都能看到 */
    if (window.onInstallProgress) {
      try {
        window.onInstallProgress((d) => {
          const ph = (d && d.phase) || '';
          if (ph !== 'watchdog' && ph !== 'version') return;
          const msg = d.msg || (ph === 'watchdog' ? '引擎正在重启' : '引擎包版本更新，正在重装');
          toast(msg, null, 6000);
          const tip = $('engTip'); if (tip) tip.textContent = msg;
          const card = $('engCard'); if (card) card.classList.remove('hide');
          try { ErrLog.push('engine', msg); } catch (e) { }
        });
      } catch (e) { }
    }

    /* 启动自检 + 每日自动快照（延迟一点，避开启动期的写入） */
    setTimeout(async () => {
      try {
        const rep = await Store.selfCheck();
        if (rep.repaired) toast(rep.repaired, null, 6000);
        if (!rep.ok) try { ErrLog.push('selfcheck', rep.notes.join(' / ')); } catch (e) { }
      } catch (e) { }
      try { await Store.Snap.maybeDaily(); } catch (e) { }
    }, 1500);
  } catch (e) { }
});

/* ---- v2.5 像聊天客户端一样：顶栏只有两个图标，空状态一句问候 ---- */

function openSheetCard(id) { const e = $(id); if (e) e.classList.remove('hide'); }

function syncHero() {
  const h = $('hero');
  if (!h) return;
  const ans = $('answer');
  const visible = !!(ans && !ans.classList.contains('hide'));
  h.classList.toggle('hide', visible);
}

function newSession() {
  try { if (S.abort) S.abort(); } catch (e) { }
  S.cur = null;
  const q = $('q');
  if (q) { q.value = ''; q.style.height = ''; }
  ['answer', 'verify', 'chat', 'teach', 'ocrBox', 'qEcho'].forEach((k) => { const e = $(k); if (e) e.classList.add('hide'); });
  ['answerBody', 'chatList', 'followList'].forEach((k) => { const e = $(k); if (e) e.innerHTML = ''; });
  if ($('qMeta')) $('qMeta').textContent = '';
  syncHero();
  if (q) q.focus();
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    syncHero();
    const m = $('btnMenu'), n = $('btnNew');
    if (m) m.onclick = () => openSheetCard('moreSheet');
    if (n) n.onclick = () => newSession();
  } catch (e) { }
});
