/* 对话与复习层：同一道题的多轮追问、错题本与 SM-2 复习。
   依赖 core.js（S / save / render / esc / callLLMRobust / extractClaims / verify / SOLVE_SYS）与 store.js（Branch）。 */

/* ---------------- 多轮追问 ---------------- */
function renderChat() {
  const list = $('chatList');
  if (!list) return;
  const it = S.cur;
  const th = (it && it.thread) || [];
  const box = $('chat');
  if (!it || th.length <= 1) {
    if (box) box.classList.add('hide');
    list.innerHTML = '';
    return;
  }
  if (box) box.classList.remove('hide');
  list.innerHTML = th.slice(1).map((m, i) => {
    const isUser = m.role === 'user';
    const body = isUser ? esc(m.content) : render(m.content || '');
    return `<div class="bub ${isUser ? 'me' : 'ai'}" data-i="${i + 1}">${body}</div>`;
  }).join('');
  if (typeof Mermaid !== 'undefined') Mermaid.decorate(list).catch(() => { });
  list.scrollTop = list.scrollHeight;
  const stat = $('chatStat');
  if (stat) stat.textContent = th.length > 1 ? (th.length - 1) + ' 轮追问' : '';
}

async function askChat(text) {
  const q = String(text || '').trim();
  if (!q || !S.cur) return;
  const it = S.cur;
  it.thread = it.thread || [{ role: 'assistant', content: it.answer || '', at: Date.now() }];
  it.thread.push({ role: 'user', content: q, at: Date.now() });
  $('chatInput').value = '';
  renderChat();

  const list = $('chatList');
  const bubble = document.createElement('div');
  bubble.className = 'bub ai';
  bubble.innerHTML = '<span class="vdetail">思考中…</span>';
  list.appendChild(bubble);

  // 用完整线程重建上下文：系统提示 + 原题 + 历史问答
  const history = [
    { role: 'user', content: '题目：\n' + it.problem },
    { role: 'assistant', content: it.answer || '' },
    ...it.thread.slice(1).map((m) => ({ role: m.role, content: m.content })),
  ];
  const use = [{ role: 'system', content: SOLVE_SYS }, ...history];

  try {
    const r = await callLLMRobust(use, {
      temp: 0.5,
      onText: (t) => { bubble.innerHTML = render(t) || '<span class="vdetail">…</span>'; },
    });
    const ans = (r.content || '').trim();
    bubble.innerHTML = render(ans) || '<span class="vdetail">（空回复）</span>';
    it.thread.push({ role: 'assistant', content: ans, at: Date.now(), model: S.cfg.model });
    if (typeof Mermaid !== 'undefined') Mermaid.decorate(bubble).catch(() => { });

    // 追问里如果给了机检断言，也顺手验证
    if (S.cfg.autoVerify) {
      const cl = extractClaims(ans);
      if (cl.length) {
        const v = await verify(cl);
        const bad = v.summary.refuted || 0;
        const tag = document.createElement('div');
        tag.className = 'vdetail';
        tag.innerHTML = bad
          ? `<span class="warn">本机验证：${bad} 条断言被推翻</span>`
          : `本机验证：${v.summary.proved}/${v.summary.total} 条成立`;
        bubble.appendChild(tag);
      }
    }
    save();
    renderChat();
  } catch (e) {
    bubble.innerHTML = '<span class="err">' + esc(e.message || String(e)) + '</span>';
  }
}

/* ---------------- 错题本 + SM-2 复习 ---------------- */
function rvInit(it) {
  it.rv = it.rv || { ease: 2.5, interval: 0, reps: 0, due: Date.now(), last: 0 };
  return it.rv;
}

function markWrong() {
  if (!S.cur) return;
  S.cur.wrong = !S.cur.wrong;
  if (S.cur.wrong) rvInit(S.cur);
  save();
  $('btnWrong').textContent = S.cur.wrong ? '已在错题本' : '记入错题';
  updateDueBadge();
}

function updateDueBadge() {
  const now = Date.now();
  const due = S.items.filter((x) => x.wrong && x.rv && x.rv.due <= now).length;
  const all = S.items.filter((x) => x.wrong).length;
  const b = $('btnReviewStart');
  if (b) b.textContent = all ? `复习错题（${due}）` : '复习错题';
  const hint = $('dueHint');
  if (hint) hint.textContent = all ? `${due} 道到期 / 共 ${all} 道错题` : '';
  return due;
}

function dueList() {
  const now = Date.now();
  return S.items.filter((x) => x.wrong)
    .sort((a, b) => ((a.rv && a.rv.due) || 0) - ((b.rv && b.rv.due) || 0))
    .filter((x) => !x.rv || x.rv.due <= now);
}

function showReviewCard() {
  const L = dueList();
  const q = $('rvQ'), a = $('rvA'), meta = $('rvMeta'), cnt = $('rvCount');
  $('rvA').classList.add('hide');
  $('rvGrades').classList.add('hide');
  $('btnRvShow').classList.remove('hide');
  if (!L.length) {
    q.innerHTML = '<span class="vdetail">今天没有到期错题，休息一下。</span>';
    a.innerHTML = ''; meta.textContent = ''; cnt.textContent = '';
    $('btnRvShow').classList.add('hide');
    return;
  }
  const it = L[Math.min(S.rvIdx || 0, L.length - 1)];
  S.rvCur = it;
  q.innerHTML = render(it.problem);
  a.innerHTML = render(it.answer);
  const rv = it.rv || {};
  meta.textContent = `${it.meta ? '[' + it.meta.topic + '] ' : ''}复习 ${rv.reps || 0} 次 · 间隔 ${rv.interval || 0} 天`
    + (it.meta && it.meta.err ? ` · 错因：${it.meta.err}` : '');
  cnt.textContent = `${Math.min((S.rvIdx || 0) + 1, L.length)} / ${L.length}`;
}

function openReview() {
  S.rvIdx = 0;
  $('reviewSheet').classList.remove('hide');
  showReviewCard();
}

function gradeReview(g) {
  const it = S.rvCur;
  if (!it) return;
  const prev = rvInit(it);
  const now = Date.now();
  const nx = (typeof fsrsNext === 'function')
    ? fsrsNext(prev, g, now)
    : { interval: g < 3 ? 1 : Math.max(1, Math.round((prev.interval || 1) * 2)), reps: (prev.reps || 0) + 1, ease: 2.5, D: 5, S: 1 };
  const rv = prev;
  rv.reps = nx.reps; rv.interval = nx.interval; rv.last = now; rv.due = now + nx.interval * 86400000;
  rv.S = nx.S; rv.D = nx.D; rv.lapses = nx.lapses || 0; rv.grade = nx.grade || g;
  rv.ease = rv.ease || 2.5;
  it.reviewed = (it.reviewed || 0) + 1;
  save();
  S.rvIdx = (S.rvIdx || 0) + 1;
  updateDueBadge();
  showReviewCard();
}
