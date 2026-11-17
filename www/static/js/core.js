/* 数学答疑 · 前端（无依赖，直连本地服务）v2 */

const LS = 'mathapp.v2';

const LS_OLD = 'mathapp.v1';

const S = {
  cfg: {
    base: '', key: '', model: '', maxTokens: 24000, temp: 0.6,
    model2: '', modelCheap: '', capDaily: 0,
    autoVerify: true, autoRetry: true, visionModel: '', vcap: {}, onboarded: 0
  },
  items: [],          // 记录（含收藏）
  cur: null,          // 当前这条记录
  abort: null,
  tab: 'all',
  q: '',
  ocrImg: '',      // 当前待识别图片（dataURL）
  ocrBusy: false,
};

function load() {
  try {
    let d = JSON.parse(localStorage.getItem(LS) || 'null');
    if (!d) {                       // 从 v1 迁移
      const o = JSON.parse(localStorage.getItem(LS_OLD) || '{}');
      d = { cfg: o.cfg || {}, items: (o.hist || []).map(normItem) };
    }
    if (d.cfg) Object.assign(S.cfg, d.cfg);
    if (Array.isArray(d.items)) S.items = d.items.map(normItem);
  } catch (e) { }
}

function normItem(h, i) {
  return {
    id: h.id || ('it' + (Date.now() + i)), problem: h.problem || '', answer: h.answer || '',
    think: h.think || '', model: h.model || '', verify: h.verify || null, claims: h.claims || null,
    rounds: h.rounds || 0, at: h.at || Date.now(), fav: !!h.fav,
    thread: Array.isArray(h.thread) ? h.thread.slice(0, 40) : [],
    wrong: !!h.wrong, rv: h.rv || null, meta: h.meta || null,
  };
}

function save() {
  try {
    localStorage.setItem(LS, JSON.stringify({ cfg: S.cfg, items: S.items.slice(0, 200) }));
  } catch (e) {
    console.warn('存储已满，只保留最近 50 条', e);
    S.items = S.items.slice(0, 50);
    try { localStorage.setItem(LS, JSON.stringify({ cfg: S.cfg, items: S.items })); } catch (e2) { }
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CLAIM_RE = /```claims[\s\S]*?```/;

const MATH_RE = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\$)[^$\n]{1,500}?\$)/g;

function texRender(tex, display) {
  if (typeof katex === 'undefined') return null;
  try {
    return katex.renderToString(tex, {
      displayMode: !!display, throwOnError: false, strict: false, output: 'html',
    });
  } catch (e) { return null; }
}

function renderPlain(t) {
  let x = esc(t);
  x = x.replace(/\\boxed\{([^{}]*)\}/g, '<span class="boxed">$1</span>');
  x = x.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
  x = x.replace(/^(\s*)[-*]\s+/gm, '$1<span class="li">•</span> ');
  x = x.replace(/^(\s*)(\d+[.)])\s+/gm, '$1<span class="li num">$2</span> ');
  return x;
}

function attr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function render(text) {
  let t = String(text == null ? '' : text).replace(CLAIM_RE, '').trimEnd();
  // 先把围栏代码块（含 mermaid）挖出来，避免被当成公式或标记
  const blocks = [];
  t = t.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const i = blocks.length;
    const l = String(lang || '').toLowerCase();
    const wantMmd = l === 'mermaid' && !(typeof Mods !== 'undefined' && Mods.has && !Mods.has('mermaid'));
    blocks.push(wantMmd
      ? '<div class="mmd" data-code="' + attr(code.trim()) + '">（图形渲染中…）</div>'
      : '<pre class="code">' + esc(code.replace(/\n+$/, '')) + '</pre>');
    return '\uE000B' + i + '\uE001';
  });

  let out = '';
  const segs = (typeof MathParse !== 'undefined' && MathParse && MathParse.split) ? MathParse.split(t) : null;
  if (segs && segs.length) {
    for (const seg of segs) {
      if (seg.t === 'math') {
        const h = texRender(seg.v, !!seg.d);
        out += h !== null ? h : renderPlain(seg.v);
      } else {
        out += renderPlain(seg.v);
      }
    }
  } else {                                   // 兜底：老的正则切分
    const parts = t.split(MATH_RE);
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      if (seg === undefined || seg === '') continue;
      if (i % 2 === 1) {
        const display = /^\$\$|^\\\[/.test(seg);
        const tex = seg.replace(/^\$\$|\$\$$/g, '')
          .replace(/^\\\[|\\\]$/g, '')
          .replace(/^\\\(|\\\)$/g, '')
          .replace(/^\$|\$$/g, '');
        const h = texRender(tex, display);
        out += h !== null ? h : renderPlain(seg);
      } else {
        out += renderPlain(seg);
      }
    }
  }
  out = out.replace(/\uE000B(\d+)\uE001/g, (m, i) => blocks[+i] || '');
  return out;
}

function plain(text) {
  return String(text == null ? '' : text).replace(CLAIM_RE, '').trim();
}

function fmtTok(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0); }

function fmtTime(ts) {
  const d = new Date(ts), now = Date.now();
  const same = new Date().toDateString() === d.toDateString();
  return same ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' +
      d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

async function copy(text, btn) {
  const s = String(text || '');
  try {
    await navigator.clipboard.writeText(s);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) { }
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }
}

async function health() {
  try {
    const r = await (window.apiFetch || fetch)('/api/health');
    const d = await r.json();
    const list = d.engines || [];
    $('engineHint').textContent = list.length ? list.join(' · ') : '无验证引擎';
    $('engineHint').style.color = list.length ? '' : 'var(--warn)';
    $('obEngines').textContent = '本机验证引擎：' + (list.join('、') || '无');
    $('verLine').textContent = '数学答疑 · ' + (d.version ? 'v' + d.version + ' · ' : '') +
      (list.length ? list.length + ' 个本地引擎就绪' : '验证引擎未就绪');
  } catch (e) {
    $('engineHint').textContent = '本地服务未连接';
    $('engineHint').style.color = 'var(--bad)';
    const nat = window.isNativeApp && window.isNativeApp();
    $('verLine').textContent = nat
      ? '验证引擎未就绪（引擎包未解压或正在启动）'
      : '本地服务未连接：请用 ./srv.sh start 启动';
  }
}

function envLine() {
  const d = new Date();
  const wd = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];
  const p2 = (n) => String(n).padStart(2, '0');
  const native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  return '【环境】' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + wd + '，' + (native ? 'Android App' : 'Web') + '，中文。';
}

/** 把错误翻成「人话 + 下一步动作」 */
function classifyErr(e) {
  const st = e && (e.status || e.statusCode);
  if (st === 'budget' || /单日.*上限|预算上限/.test(String((e && e.message) || ''))) return { text: String((e && e.message) || '已到单日上限'), act: 'cfg' };
  const msg = String((e && e.message) || e || '').slice(0, 300);
  if (st === 401 || /401|invalid.*(key|api)|unauthor|认证失败/i.test(msg)) return { text: 'API Key 不对或没有权限', act: 'cfg' };
  if (st === 402 || /insufficient|balance|余额|欠费/i.test(msg)) return { text: '账户余额不足', act: 'cfg' };
  if (st === 429 || /rate.?limit|too many|限流|频繁/i.test(msg)) return { text: '请求太频繁，等一会儿再试', act: 'retry' };
  if (/timeout|timed out|超时|ETIMEDOUT/i.test(msg)) return { text: '上游超时（压轴题常见，可降低强度或重试）', act: 'retry' };
  if (/未就绪|引擎|rootfs|ECONNREFUSED/i.test(msg)) return { text: msg, act: 'engine' };
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return { text: '网络不通（检查端点地址或代理）', act: 'retry' };
  return { text: msg || '请求失败', act: '' };
}

function flattenSystem(messages) {
  const sys = [], out = [];
  for (const m of messages || []) {
    if (m && m.role === 'system') sys.push(String(m.content || ''));
    else if (m) out.push(m);
  }
  if (!sys.length) return out;
  const pre = sys.join('\n\n');
  if (out.length && out[0].role === 'user') {
    out[0] = { role: 'user', content: pre + '\n\n---\n\n' + (out[0].content || '') };
  } else {
    out.unshift({ role: 'user', content: pre });
  }
  // 附一行环境快照（日期/星期/平台），模型答「本周」「今年」这类题才不会算错日期
  const cl = out.map((m) => ({ role: m.role, content: m.content }));
  for (let i = cl.length - 1; i >= 0; i--) {
    if (cl[i].role === 'user') { cl[i].content = String(cl[i].content || '') + '\n\n' + envLine(); break; }
  }
  return cl;
}

async function callLLM(messages, opt = {}) {
  if (window.nativeLLMCall) return window.nativeLLMCall(messages, opt, S);
  const ctl = new AbortController();
  S.abort = ctl;
  const body = {
    baseUrl: opt.base !== undefined ? opt.base : S.cfg.base,
    apiKey: opt.key !== undefined ? opt.key : S.cfg.key,
    model: opt.model || S.cfg.model,
    messages: flattenSystem(messages), maxTokens: opt.maxTokens || S.cfg.maxTokens,
    temperature: opt.temp === undefined ? S.cfg.temp : opt.temp,
    thinking: opt.thinking, stream: opt.stream !== false, timeout: 600,
  };
  const t0 = Date.now();
  const r = await fetch('/api/llm', { method: 'POST', body: JSON.stringify(body), signal: ctl.signal });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
    throw new Error(e.error || ('HTTP ' + r.status));
  }
  if (!body.stream) {
    const d = await r.json();
    const m = (d.choices || [{}])[0];
    return {
      content: (m.message || {}).content || '',
      reasoning: (m.message || {}).reasoning_content || '',
      finish: m.finish_reason || '',
      usage: d.usage || {}, secs: (Date.now() - t0) / 1000,
    };
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '', finish = '', usage = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) {
      const s = line.trim();
      if (!s || s.startsWith(':') || !s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch (e) { continue; }
      if (j.error) throw new Error(j.error);
      const ch = (j.choices || [])[0];
      if (!ch) { if (j.usage) usage = j.usage; continue; }
      const d = ch.delta || {};
      if (d.content) { content += d.content; opt.onText && opt.onText(content); }
      if (d.reasoning_content) { reasoning += d.reasoning_content; opt.onThink && opt.onThink(reasoning); }
      if (ch.finish_reason) finish = ch.finish_reason;
      if (j.usage) usage = j.usage;
    }
  }
  return { content, reasoning, finish, usage, secs: (Date.now() - t0) / 1000 };
}

async function callLLMRobust(messages, opt = {}) {
  let r = await callLLM(messages, opt);
  let tries = 0;
  while (S.cfg.autoRetry && !r.content.trim() && tries < 2) {
    tries++;
    const nm = Math.min((opt.maxTokens || S.cfg.maxTokens) * 2, 96000);
    opt.onNote && opt.onNote(`正文为空（思考吃光预算 ${fmtTok(r.usage.completion_tokens || 0)}），预算提到 ${fmtTok(nm)} 重试…`);
    r = await callLLM(messages, Object.assign({}, opt, { maxTokens: nm, stream: false }));
  }
  return r;
}

const SOLVE_SYS = `你是世界级数学解题引擎，能解高考压轴、CMO/IMO 及更难的证明与计算题。

工作方式：
1. 先用 3–6 行写「题型与计划」（代数/数论/组合/几何/不等式，关键突破口）。
2. 严格推理，每步给理由；需要构造就给构造；分类讨论必须穷尽并检查边界与退化情形；证明"不存在"时给完整反证。
3. 最终答案用 \\boxed{...}（多问写 \\boxed{(1)… (2)…}）。
4. 解答末尾**必须**输出机检结论块（缺了它这道题就算"未验证"），供本地 SymPy/z3/Arb 独立复核。只写你真正依赖的关键断言，禁止编造：

\`\`\`claims
[{"kind":"identity","lhs":"(a+b)^2","rhs":"a^2+2*a*b+b^2","vars":{"a":"real","b":"real"},"note":"展开式"},
 {"kind":"ineq","expr":"sin(x)-2*x/pi>=0","vars":{"x":"real"},"range":{"x":[0,1.5707963]},"universal":true,"note":"sin≥2x/π"},
 {"kind":"value","expr":"sqrt(13)","expected":"3.6055512754639893","note":"数值核对"},
 {"kind":"nt","expr":"2^61-1","assert":"prime","note":"梅森素数"},
 {"kind":"forall_int","expr":"floor(n/2)+ceil(n/2)==n","vars":{"n":[1,200]},"note":"取整恒等式穷举"},
 {"kind":"forall_int","expr":"isprime(n^2+n+41)","vars":{"n":[1,300]},"note":"素数性 n=40 会破功"},
 {"kind":"mod","expr":"a^3-a","mod":6,"vars":{"a":[1,300]},"note":"整除性"},
 {"kind":"exists_int","expr":"n*m==391","vars":{"n":[1,60],"m":[1,60]},"note":"存在性构造"},
 {"kind":"recurrence","closed":"2^n-1","rec":"2*a_prev+1","range":{"n":[2,60]},"note":"闭式与递推一致"},
 {"kind":"roots","expr":"x^2-5*x+6","claimed":["2","3"],"var":"x","note":"方程解集必须列全（含负根）"},
 {"kind":"forall_int","expr":"floor(alpha*n)==n+floor(n/2)","vars":{"n":[1,200]},"params":{"alpha":1.5},"note":"数值代进实数参数"},
 {"kind":"geom","hyps":["(x-4)+3*y","4*(x-1)"],"goal":"-3*x+3*y","vars":{"x":"real","y":"real"},"note":"坐标化几何：假设多项式=0，断言多项式恒为0"}]
\`\`\`

各类型怎么选（选错就拿不到反例）：
· 连续不等式/恒等式 → identity / ineq（多项式走 z3 严格判定，含 sin cos 走 numpy 密集扫描 + Arb 200 位区间、简单界还能被 cvc5 严格证明）；
· 取整、素数、整除、递推、整数解存在性 → forall_int / mod / exists_int / recurrence，**必须**给整数区间 vars（如 {"n":[1,300]}），总点数别超 200 万（超了自动交给 CP-SAT，可处理到 10⁹）；
· 解方程/求根 → roots，claimed 里列**全部**实解（正负都要），超越方程会自动退化成数值扫描；
· 具体数值结论 → value，给 15 位小数，**expr 只能含数字常量，不能写变量名**；
· **几何题** → geom：先把图形放进坐标系（把点设成变量），把每个已知条件写成多项式=0 放进 hyps，把要证的结论写成"多项式恒等于 0"放进 goal，退化成"点不重合/不为零"的条件写进 nondeg（如三角形非退化给 ["q"]）。引擎用 Gröbner 基做理想成员判定，秒级给严格证明；非退化条件缺失时会用 z3 找出真实反例构型；
· 需要固定实数常量（α=1.5、π 的倍数等）→ 放 params。

表达式用 Python 语法（** 或 ^ 表示幂，乘法星号可省，函数 sin/cos/tan/exp/log/sqrt/pi）；变量在 vars 里声明 real；有限区间用 range 给闭区间小数。5–8 条为宜；纯几何/组合题给能算的关键恒等式或数值。
注意：claims 块必须是最后一样东西，以三个反引号加 claims 开始，内容是一个 JSON 数组。`;

const REFINE_SYS = `本机验证器推翻了你的部分断言，下面给出反例或差值。
请：不要辩解，重新检查推理链，定位错误步骤，给出修正后的完整解答（含新的 \\boxed{} 与更新后的 \`\`\`claims 块）。
如果原最终答案是错的，明确写出新答案。`;

const PERSONA = {
  coach: '你是一位带出过 IMO 选手的竞赛教练。讲解只抓关键：这题的题眼、为什么想到这一步、最容易错的地方，最后给一句可迁移的经验。语言干脆，不罗列废话。',
  textbook: '你是一位教材作者。讲解严谨完整：定义、引理、逐步推导，不跳步，标出每个结论的依据。',
  socratic: '你是苏格拉底式老师。绝不直接给答案：先问一个能推动思考的问题，等我回答后再问下一个，一次只问一个问题。',
};

function parseClaimsLoose(raw) {
  raw = (raw || '').replace(/```[a-z]*/gi, '').trim();
  const i = raw.indexOf('['), j = raw.lastIndexOf(']');
  if (i >= 0 && j > i) {
    try { return JSON.parse(raw.slice(i, j + 1).replace(/,\s*([}\]])/g, '$1')).slice(0, 12); } catch (e) { }
  }
  const out = [];
  const re = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let m;
  while ((m = re.exec(raw)) && out.length < 12) {
    try {
      const o = JSON.parse(m[0].replace(/,\s*\}/g, '}'));
      if (o && o.kind) out.push(o);
    } catch (e) { }
  }
  return out;
}

async function auditClaims(problem, answer) {
  const msgs = [
    { role: 'system', content: '你是形式化校对员。只输出一个 JSON 数组：以 [ 开头、] 结尾，元素之间用逗号。不要编号、不要文字、不要代码围栏。' },
    { role: 'user', content: '题目：' + problem + '\n\n解答：' + answer.slice(0, 6000) +
      '\n\n输出 JSON 数组，元素从这些类型选：{"kind":"identity","lhs":"...","rhs":"...","vars":{"x":"real"}}、{"kind":"ineq","expr":"...","vars":{},"range":{"x":[0,1]}}、{"kind":"value","expr":"...","expected":"..."}、{"kind":"nt","expr":"...","assert":"prime"}、{"kind":"forall_int","expr":"...","vars":{"n":[1,300]}}、{"kind":"mod","expr":"...","mod":6,"vars":{}}、{"kind":"exists_int","expr":"...","vars":{}}、{"kind":"recurrence","closed":"...","rec":"...","range":{"n":[2,60]}}、{"kind":"roots","expr":"...","claimed":["..."],"var":"x"}、{"kind":"geom","hyps":["..."],"goal":"...","vars":{"x":"real"}}。取整/素数/整除/递推题优先用整数穷举类；解方程题一定给 roots；几何题给 geom。给 4–8 条。' },
  ];
  try {
    const r = await callLLM(msgs, { stream: false, temp: 0.2, maxTokens: 2500, thinking: false });
    return parseClaimsLoose(r.content);
  } catch (e) { return []; }
}

function buildRefinePrompt(v) {
  const bad = (v.results || []).filter((x) => x.status === 'refuted');
  let s = '本机验证器（SymPy/z3/Arb/CP-SAT/Gröbner）对下列断言给出了反例，请据此修正：\n';
  for (const b of bad) {
    s += `- 断言「${b.claim}」被推翻：${b.detail || ''} ${b.point ? '反例点 ' + JSON.stringify(b.point) : ''}\n`;
  }
  s += '\n请重新检查推理，给出修正后的完整解答。';
  return s;
}

function extractClaims(text) {
  const m = /```claims\s*([\s\S]*?)```/.exec(text || '');
  if (!m) return [];
  let raw = m[1].trim().replace(/,\s*([}\]])/g, '$1');
  let arr = null;
  try { arr = JSON.parse(raw); } catch (e) {
    const i = raw.indexOf('['), j = raw.lastIndexOf(']');
    if (i >= 0 && j > i) { try { arr = JSON.parse(raw.slice(i, j + 1)); } catch (e2) { } }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((c) => c && typeof c === 'object' && c.kind).slice(0, 12);
}

async function verify(claims) {
  $('verify').classList.remove('hide');
  $('verifyList').innerHTML = '<div class="vitem"><span class="vdetail">验证中…</span></div>';
  let d;
  try {
    const r = await (window.apiFetch || fetch)('/api/verify', { method: 'POST', body: JSON.stringify({ claims }) });
    d = await r.json();
  } catch (e) {
    $('verifyList').innerHTML = '<div class="vitem"><span class="err">验证服务不可用（服务端没起来？）</span></div>';
    return { results: [], summary: { total: 0, proved: 0, refuted: 0 }, coverage: 0 };
  }
  renderVerify(d);
  return d;
}

function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src;
  });
}

function shrinkImage(src, maxSide = 1400, quality = 0.85) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, maxSide / Math.max(im.width, im.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(im.width * k));
      cv.height = Math.max(1, Math.round(im.height * k));
      const g = cv.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(im, 0, 0, cv.width, cv.height);
      res(cv.toDataURL('image/jpeg', quality));
    };
    im.onerror = rej; im.src = src;
  });
}

const VISION_PROMPT = '把这张图片里的题目原文逐字抄下来。要求：①数学公式与符号写成 LaTeX 并用 $...$ 包裹；'
  + '②保留题号与分小题结构；③不要解答、不要解释、不要评论；④看不清的字符用 ? 代替，不要猜。';

const CLASSIFY_SYS = '你是数学题目的分类员。只输出一个 JSON 对象，不要代码围栏、不要解释。格式：'
  + '{"topic":"一级分类（函数与导数/三角/数列/不等式/解析几何/立体几何/数论/组合/概率统计/向量/复数/其他）",'
  + '"tags":["具体知识点，2-5 个，每个不超过 12 字"],"err":"如果解答里有被推翻的断言或明显错步，用一句话说错在哪；否则空字符串"}';

function parseJsonLoose(raw) {
  const t = String(raw || '').replace(/```[a-z]*/gi, '');
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(t.slice(i, j + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e) { return null; }
}

/** 从一段作答里抽出最终答案：优先 \\boxed{…}（支持嵌套花括号），退化用「答案是 …」 */
function boxedOf(text) {
  const t = String(text || '');
  let best = '', i = t.indexOf('\\boxed');
  while (i >= 0) {
    const j = t.indexOf('{', i);
    if (j < 0) break;
    let depth = 0, k = j;
    for (; k < t.length; k++) {
      const c = t[k];
      if (c === '\\') { k++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    const v = t.slice(j + 1, k).trim();
    if (v) best = v;
    i = t.indexOf('\\boxed', k);
  }
  if (best) return best;
  const m = t.match(/(?:答案|故|因此|所以)[是为：:\s]*\$?([^\n。;]{1,60})/);
  return m ? m[1].replace(/\$/g, '').trim() : '';
}

/** 答案归一化：去掉排版噪音再比较（宽松，只为判「一致/不一致」） */
function normAns(x) {
  return String(x || '')
    .replace(/\\left|\\right|\\,|\\!|\\;|\\ |\s+/g, '')
    .replace(/\$|\\text\{[^{}]*\}|\\mathrm\{[^{}]*\}/g, '')
    .replace(/\\[dt]?frac/g, '\\frac')
    .replace(/[−–—]/g, '-')
    .replace(/^答案[是为：:]*/, '')
    .toLowerCase();
}

/* ---- v2.3 诊断与流式渲染 ---- */

/** 环形错误日志：只留最近 40 条，用来回答「刚才为什么失败」 */
const ErrLog = (() => {
  const KEY = 'mathapp.errlog';
  let buf = [];
  try { buf = JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (e) { buf = []; }
  function flush() { try { localStorage.setItem(KEY, JSON.stringify(buf.slice(-40))); } catch (e) { } }
  function push(kind, msg, extra) {
    buf.push(Object.assign({ at: Date.now(), kind: String(kind || 'err'), msg: String(msg == null ? '' : msg).slice(0, 400) }, extra || {}));
    if (buf.length > 40) buf = buf.slice(-40);
    flush();
  }
  return { push, list: () => buf.slice().reverse(), clear() { buf = []; flush(); } };
})();

/** 流式渲染节流器：每 wait 毫秒最多整段重绘一次，收尾时再补一次终稿。
    长答案（3 万 token）不再每个 chunk 都编译一遍 KaTeX。 */
function mkStream(el, opts) {
  const wait = (opts && opts.wait) || 90;
  let timer = null, pend = null, last = 0, closed = false;
  function paint(t) {
    try { el.innerHTML = render(t); } catch (e) { el.textContent = t; }
  }
  function flush() {
    timer = null;
    if (pend == null || closed) return;
    const t = pend; pend = null; last = Date.now(); paint(t);
    if (typeof Mermaid !== 'undefined' && Mermaid.decorate) { try { Mermaid.decorate(el); } catch (e) { } }
  }
  return {
    push(t) {
      if (closed) return;
      pend = t;
      if (timer) return;
      timer = setTimeout(flush, Math.max(0, wait - (Date.now() - last)));
    },
    end(t) {
      if (timer) { clearTimeout(timer); timer = null; }
      closed = true; pend = null;
      if (t != null) paint(t);
      return t;
    },
  };
}
