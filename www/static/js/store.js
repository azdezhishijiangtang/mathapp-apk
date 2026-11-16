/* 存储与新增能力层：IndexedDB 持久化、zip 导出/导入、解答分支、Mermaid 图。
   只依赖 core.js 暴露的全局（S / save / normItem / esc），不碰界面细节。 */

const Store = (() => {
  const DB = 'mathapp';
  const VER = 1;
  const ST = 'items';
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('本浏览器无 IndexedDB'));
      const rq = indexedDB.open(DB, VER);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains(ST)) d.createObjectStore(ST, { keyPath: 'id' });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error || new Error('IndexedDB 打不开'));
    });
    return dbp;
  }

  const tx = (mode) => open().then((d) => d.transaction(ST, mode).objectStore(ST));

  async function all() {
    const st = await tx('readonly');
    return new Promise((res, rej) => {
      const rq = st.getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
  }

  async function clear() {
    const st = await tx('readwrite');
    return new Promise((res, rej) => {
      const rq = st.clear();
      rq.onsuccess = () => res(true);
      rq.onerror = () => rej(rq.error);
    });
  }

  async function mirror() {
    try {
      await clear();
      const st = await tx('readwrite');
      for (const it of S.items) {
        // 图片单独留在索引库，避免 localStorage 撑爆
        st.put(it);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  let timer = null;
  function queue() {
    clearTimeout(timer);
    timer = setTimeout(mirror, 500);
  }

  // 启动：把库里的记录并回内存（localStorage 里的是精简副本）
  async function boot() {
    try {
      const rows = await all();
      if (rows.length) {
        const have = new Set(S.items.map((x) => x.id));
        for (const r of rows) if (!have.has(r.id)) S.items.push(normItem(r));
        S.items.sort((a, b) => (b.at || 0) - (a.at || 0));
      }
      await mirror();
      return rows.length;
    } catch (e) {
      return -1;
    }
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function u8ToB64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // 导出：真 zip（data.json + 原图），没有 fflate 就退回 JSON
  function exportZip() {
    const items = S.items;
    const payload = JSON.stringify({ app: 'mathapp', v: 3, at: Date.now(), items }, null, 1);
    if (typeof FF === 'undefined' || !FF.zipSync) {
      download(new Blob([payload], { type: 'application/json' }), 'mathapp-backup-' + stamp() + '.json');
      return 'json';
    }
    const files = { 'data.json': FF.strToU8(payload) };
    let imgs = 0;
    for (const it of items) {
      if (it.img && /^data:image\//.test(it.img)) {
        const i = it.img.indexOf(',');
        try {
          files['img/' + it.id + (it.img.slice(0, 20).includes('png') ? '.png' : '.jpg')] = b64ToU8(it.img.slice(i + 1));
          imgs++;
        } catch (e) { /* 单张图坏了不影响整体 */ }
      }
    }
    const z = FF.zipSync(files, { level: 6 });
    download(new Blob([z], { type: 'application/zip' }), 'mathapp-backup-' + stamp() + '.zip');
    return 'zip:' + imgs;
  }

  function readJson(buf) {
    try { return JSON.parse(buf); } catch (e) { return null; }
  }

  // 导入：.zip（含图片）或 .json；按 题目|时间 去重合并
  function importFile(file, done) {
    const fr = new FileReader();
    fr.onload = () => {
      let data = null;
      const u8 = new Uint8Array(fr.result);
      const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
      if (isZip) {
        if (typeof FF === 'undefined' || !FF.unzipSync) { alert('这个包是 zip，但解压模块没加载'); return; }
        let files;
        try { files = FF.unzipSync(u8); } catch (e) { alert('zip 解不开：' + e.message); return; }
        const d = files['data.json'];
        if (!d) { alert('zip 里没有 data.json'); return; }
        data = readJson(FF.strFromU8(d));
        if (data) {
          for (const it of (data.items || [])) {
            const k = 'img/' + it.id;
            for (const ext of ['.png', '.jpg']) {
              if (files[k + ext]) {
                it.img = 'data:image/' + ext.slice(1).replace('jpg', 'jpeg') + ';base64,' + u8ToB64(files[k + ext]);
                break;
              }
            }
          }
        }
      } else {
        data = readJson(fr.result);
      }
      if (!data) { alert('文件读不了'); return; }
      const items = (data.items || data.hist || []).map(normItem);
      if (!items.length) { alert('文件里没有记录'); return; }
      const have = new Set(S.items.map((x) => x.problem + '|' + x.at));
      let add = 0;
      for (const it of items) {
        const k = it.problem + '|' + it.at;
        if (have.has(k)) continue;
        S.items.push(it); add++;
      }
      S.items.sort((a, b) => b.at - a.at);
      save(); queue();
      alert(`导入完成：新增 ${add} 条，跳过 ${items.length - add} 条重复`);
      if (done) done();
    };
    fr.readAsArrayBuffer(file);
  }

  async function wipe() {
    S.items = [];
    S.cur = null;
    try { await clear(); } catch (e) { /* 忽略 */ }
  }

  return { open, all, mirror, queue, boot, exportZip, importFile, wipe, stamp };
})();

/* 解答分支：同一道题保留多个版本（标准版 / 严格版 / 再修正版） */
const Branch = {
  list(it) {
    if (!it) return [];
    if (!it.branches || !it.branches.length) {
      it.branches = [{
        id: 'b' + (it.at || Date.now()),
        answer: it.answer || '', think: it.think || '', model: it.model || '',
        verify: it.verify || null, claims: it.claims || [], rounds: it.rounds || 0, at: it.at || Date.now(),
      }];
      it.bi = 0;
    }
    return it.branches;
  },
  cur(it) {
    const L = Branch.list(it);
    return L[Math.min(it.bi || 0, L.length - 1)];
  },
  push(it, rec) {
    const L = Branch.list(it);
    L.push(rec);
    it.bi = L.length - 1;
    return it.bi;
  },
  use(it, i) {
    const L = Branch.list(it);
    const b = L[i];
    if (!b) return false;
    it.bi = i;
    it.answer = b.answer; it.think = b.think; it.model = b.model;
    it.verify = b.verify; it.claims = b.claims; it.rounds = b.rounds;
    return true;
  },
};

/* Mermaid：只在真的遇到图时才加载 5MB 的脚本 */
const Mermaid = {
  loading: null,
  load() {
    if (typeof mermaid !== 'undefined') return Promise.resolve(mermaid);
    if (!Mermaid.loading) {
      Mermaid.loading = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = '/static/vendor/mermaid/mermaid.min.js';
        s.onload = () => {
          try { mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' }); } catch (e) { }
          res(mermaid);
        };
        s.onerror = () => rej(new Error('mermaid 脚本加载失败'));
        document.head.appendChild(s);
      });
    }
    return Mermaid.loading;
  },
  async decorate(root) {
    const nodes = [...((root || document).querySelectorAll('.mmd[data-code]'))];
    if (!nodes.length) return 0;
    let m;
    try { m = await Mermaid.load(); } catch (e) {
      nodes.forEach((n) => { n.textContent = '（图形模块未加载）' + n.dataset.code.slice(0, 60); });
      return 0;
    }
    let ok = 0;
    for (const n of nodes) {
      const code = n.dataset.code;
      try {
        const out = await m.render('mmd' + Date.now() + '_' + (ok++), code);
        n.innerHTML = out.svg || '';
        n.classList.add('ok');
      } catch (e) {
        n.textContent = '图渲染失败：' + String(e.message || e).slice(0, 120);
      }
    }
    return ok;
  },
};
