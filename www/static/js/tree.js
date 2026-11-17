/* 消息树 v2.1：一个问题可以有多个问法版本，每个问法下可以有多个答案版本。
   数据都挂在 item 上：item.qv=[{id,text,at}]、item.qsel、branches[].qid。
   只依赖 core.js / store.js 暴露的全局（S / save / Branch / solve / openItem）。 */

const Tree = (() => {
  const nid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  function qv(it) {
    if (!it) return [];
    if (!it.qv || !it.qv.length) {
      it.qv = [{ id: 'q0', text: it.problem || '', at: it.at || Date.now() }];
      it.qsel = 'q0';
    }
    if (!it.qsel || !it.qv.some((x) => x.id === it.qsel)) it.qsel = it.qv[0].id;
    return it.qv;
  }

  function q(it) { const L = qv(it); return L.find((x) => x.id === it.qsel) || L[0]; }
  function qId(it) { return q(it).id; }

  /* 当前问法下的答案版本（旧数据没有 qid，一律视作 q0） */
  function ans(it, qid) {
    const L = Branch.list(it);
    const out = [];
    L.forEach((b, i) => { if ((b.qid || 'q0') === qid) out.push({ b, i }); });
    if (!out.length && L.length) L.forEach((b, i) => out.push({ b, i }));   // 兜底：别让界面空着
    return out;
  }

  function useAns(it, branchId) {
    const L = Branch.list(it);
    const i = L.findIndex((b) => b.id === branchId);
    if (i < 0) return false;
    Branch.use(it, i);
    it.qsel = L[i].qid || 'q0';
    it.problem = (qv(it).find((x) => x.id === it.qsel) || {}).text || it.problem;
    save();
    return true;
  }

  function setQ(it, qid) {
    const L = qv(it);
    if (!L.some((x) => x.id === qid)) return false;
    it.qsel = qid;
    const cur = L.find((x) => x.id === qid);
    it.problem = cur.text;
    const A = ans(it, qid);
    if (A.length) {
      const last = A[A.length - 1];
      Branch.use(it, last.i);
      it.qsel = qid;
    } else {
      it.answer = ''; it.think = ''; it.verify = null; it.claims = []; it.bi = 0;
    }
    save();
    return true;
  }

  function regen(it) {
    if (!it) return;
    const cur = q(it);
    solve(cur.text, { into: it.id, qid: cur.id });
  }

  function editQ(it, text) {
    const t = String(text || '').trim();
    if (!it || !t) { alert('先写一句话'); return; }
    const L = qv(it);
    const id = nid('q');
    L.push({ id, text: t, at: Date.now() });
    it.qsel = id;
    it.problem = t;
    save();
    solve(t, { into: it.id, qid: id });
  }

  function render(it) {
    const box = $('treeBody');
    if (!box || !it) return;
    const L = qv(it);
    const cur = q(it);
    const A = ans(it, cur.id);
    const curB = (Branch.cur(it) || {}).id;
    let h = '<div class="ghd">问法（' + L.length + ' 个版本）</div><div class="chips">';
    h += L.map((x) => {
      const t = (x.text || '(空)').replace(/\s+/g, ' ').slice(0, 16);
      return '<button class="brchip ' + (x.id === cur.id ? 'on' : '') + '" data-q="' + x.id + '">' + esc(t) +
        ((x.text || '').length > 16 ? '…' : '') + '</button>';
    }).join('');
    h += '</div><div class="ghd">这个问法的答案（' + A.length + ' 版）</div><div class="chips">';
    h += A.map((x, k) => {
      const c = x.b;
      const v = c.verify && c.verify.summary;
      const mark = v ? (v.refuted ? ' ⚠' : (v.proved ? ' ✓' : '')) : '';
      return '<button class="brchip ' + (c.id === curB ? 'on' : '') + '" data-b="' + c.id + '">第 ' + (k + 1) +
        ' 版' + mark + ' · ' + esc(c.model || '-') + '</button>';
    }).join('') || '<span class="meta">这一问还没有答案</span>';
    h += '</div>';
    box.innerHTML = h;
    box.querySelectorAll('[data-q]').forEach((b) => {
      b.onclick = () => { if (setQ(it, b.dataset.q)) { openItem(it); render(it); } };
    });
    box.querySelectorAll('[data-b]').forEach((b) => {
      b.onclick = () => { if (useAns(it, b.dataset.b)) { openItem(it); render(it); } };
    });
  }

  function open(it) {
    const sh = $('treeSheet');
    if (!sh) return;
    if (!it) { alert('先解一道题'); return; }
    $('treeQ').value = '';
    sh.classList.remove('hide');
    render(it);
  }

  function boot() {
    const close = document.querySelector('#treeSheet [data-close]');
    if (close) close.onclick = () => $('treeSheet').classList.add('hide');
    const e = $('treeEdit');
    if (e) e.onclick = () => { const it = S.cur; if (!it) return; editQ(it, $('treeQ').value); $('treeSheet').classList.add('hide'); };
    const r = $('treeRegen');
    if (r) r.onclick = () => { const it = S.cur; if (!it) return; $('treeSheet').classList.add('hide'); regen(it); };
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  return { qv, q, qId, ans, useAns, setQ, regen, editQ, render, open, boot };
})();
