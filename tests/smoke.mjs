/**
 * 前端冒烟测试（jsdom）：验证 www/ 里的页面能加载、核心功能没被改坏。
 * 用法：node tests/smoke.mjs         （默认读 ./www）
 *       WEB_DIR=../mathapp/web node tests/smoke.mjs
 */
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

const WEB = path.resolve(process.env.WEB_DIR || 'www');
const JS = path.join(WEB, 'static/js');
const FILES = ['core.js', 'modules.js', 'store.js', 'app.js', 'chat.js', 'extra.js', 'growth.js', 'tree.js'];

const fail = [];
const ok = (name, cond, detail) => { if (!cond) fail.push(name + (detail ? ' :: ' + detail : '')); console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail && !cond ? ' :: ' + detail : '')); };

const dom = new JSDOM(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'), {
  runScripts: 'dangerously', url: 'http://127.0.0.1:8080/', pretendToBeVisual: true,
});
const w = dom.window;
w.alert = (m) => { (w.__alerts = w.__alerts || []).push(String(m)); };
w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
w.fetch = async () => ({ ok: true, json: async () => ({ engines: [], version: 'test' }), text: async () => '' });
// jsdom 不加载 vendor 里的 KaTeX，给个桩，验证「公式确实走了 KaTeX 管线」
w.katex = { renderToString: (tex) => '<span class="katex-stub">' + tex + '</span>' };

const src = FILES.map((f) => fs.readFileSync(path.join(JS, f), 'utf8')).join('\n;\n') +
  '\n;window.__exp={S,Mods,Tree,Store,Branch,render,toast,syncDueBar,boxedOf,normAns,renderVerify,renderCross,callLLM,mkStream,ErrLog,renderDiag,syncOnboard,save};';
try { w.eval(src); } catch (e) { fail.push('脚本加载失败: ' + e.message); }
w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
const X = w.__exp || {};

ok('脚本全部加载', !!X.S && !!X.Tree && !!X.Store && !!X.Mods && !!X.render);
ok('布局两栏容器存在', !!w.document.getElementById('colR'));
ok('今日复习条可用', !!w.document.getElementById('dueBar') && typeof X.syncDueBar === 'function');

// 问法/版本树
const it = { id: 't1', problem: 'p0', at: 1, bi: 0, fav: false, answer: 'A1', branches: [
  { id: 'b1', answer: 'A1', model: 'm1', at: 1, qid: 'q0' },
  { id: 'b2', answer: 'A2', model: 'm2', at: 2, qid: 'q0' }] };
X.S.items = [it]; X.S.cur = it;
ok('问法自动迁移', X.Tree.qv(it).length === 1 && it.qsel === 'q0');
ok('答案版本切换', X.Tree.useAns(it, 'b2') === true && it.answer === 'A2');

// 渲染：公式 + 代码块 + mermaid 开关
const md = '见 $x^2$ 与 $$\\frac{a}{b}$$\n```mermaid\ngraph TD;A-->B;\n```';
const off = X.render(md);
ok('行内公式进 KaTeX', /katex-stub/.test(off), off.slice(0, 80));
ok('mermaid 关掉时是代码块', /<pre class="code">/.test(off) && !/class="mmd"/.test(off));
X.Mods.enable('mermaid');
ok('mermaid 打开时占位', /class="mmd"/.test(X.render(md)));
X.Mods.disable('mermaid');

// 覆盖率仪表 / 缺口清单
X.renderVerify({ results: [
  { status: 'proved', claim: 'a', kind: 'identity' },
  { status: 'no_counterexample_found', claim: 'b', kind: 'ineq' },
  { status: 'refuted', claim: 'c', kind: 'ineq', point: { x: 0 } },
], summary: { total: 3, proved: 1, refuted: 1 }, coverage: 0.66 });
ok('覆盖率条出现', !w.document.getElementById('verifyBar').classList.contains('hide'));
ok('缺口清单有条目', w.document.querySelectorAll('#verifyGap .gapitem').length === 1);

// 交叉复核三种状态
X.renderCross({ m1: 'a', m2: 'b', a1: '1', a2: '1', same: true });
ok('交叉一致显示 ok', w.document.getElementById('crossRow').className === 'cross ok');
X.renderCross({ m1: 'a', m2: 'b', a1: '1', a2: '2', same: false });
ok('交叉不一致显示 bad', w.document.getElementById('crossRow').className === 'cross bad');
X.renderCross(null);
ok('交叉隐藏', w.document.getElementById('crossRow').classList.contains('hide'));

// 答案抽取（嵌套花括号）
ok('\\boxed 嵌套解析', X.boxedOf('所以 \\boxed{\\frac{\\pi}{2}} 完') === '\\frac{\\pi}{2}', X.boxedOf('所以 \\boxed{\\frac{\\pi}{2}} 完'));
ok('答案归一化', X.normAns('\\dfrac{\\pi}{2}') === X.normAns('\\frac{\\pi}{2}'));

// 单日预算护栏
X.S.cfg.capDaily = 1; X.S.cost.credit = 9;
let st = '';
try { await X.callLLM([{ role: 'user', content: 'x' }]); } catch (e) { st = e.status; }
ok('预算到顶会拦住', st === 'budget');
X.S.cfg.capDaily = 0;

// 删除撤销
let hit = 0; X.toast('删了', '撤销', () => hit++);
const t = w.document.getElementById('toastAct');
ok('撤销按钮存在', !!t);
if (t) t.click();
ok('撤销回调执行', hit === 1);

// v2.3：流式节流 / 错误日志 / 快照 / 启动自检 / 诊断面板
ok('诊断面板存在', !!w.document.getElementById('diagSheet') && !!w.document.getElementById('diagBody'));
const sbox = w.document.createElement('div');
const stx = X.mkStream(sbox, { wait: 10 });
stx.push('$a$'); stx.push('$a+b$');
ok('节流：未立刻重绘', sbox.innerHTML === '');
await new Promise((r) => setTimeout(r, 60));
ok('节流：合并后重绘一次', /katex-stub|a\+b/.test(sbox.innerHTML), sbox.innerHTML.slice(0, 60));
stx.end('$c$');
ok('节流：收尾用终稿', /katex-stub/.test(sbox.innerHTML));

X.ErrLog.push('test', 'boom');
ok('错误日志记录', X.ErrLog.list().some((e) => e.msg === 'boom'));
X.ErrLog.clear();
ok('错误日志清空', X.ErrLog.list().length === 0);

const sc = await X.Store.selfCheck();
ok('启动自检返回报告', !!sc && typeof sc.ok === 'boolean' && Array.isArray(sc.notes));
const sn = await X.Store.Snap.put('t');
ok('快照写入安全（无 IDB 时返回 null）', sn === null || typeof sn.n === 'number');
const sl = await X.Store.Snap.list();
ok('快照列表可用', Array.isArray(sl));
await X.renderDiag();
ok('诊断面板渲染出条目', w.document.querySelectorAll('#diagBody .drow').length >= 3);

// v2.4 排版：面板可滚 / 输入框 ≥16px / 提示条层级 / 正文限宽（读样式表做静态断言）
const css = fs.readFileSync(path.join(WEB, 'static/style.css'), 'utf8');
ok('长面板可滚动', /section\.sheet\{[^}]*overflow-y:auto/.test(css));
ok('输入框不小于 16px', /input:not\(\[type=checkbox\]\),select,textarea\{font-size:16px\}/.test(css));
ok('提示条在面板之上', /\.toast\{z-index:90\}/.test(css));
ok('正文限宽 72ch', /max-width:72ch/.test(css));

// v2.5 界面清晰度：顶栏只有两个图标、空状态问候、单列居中
ok('顶栏菜单按钮存在', !!w.document.getElementById('btnMenu'));
ok('顶栏新对话按钮存在', !!w.document.getElementById('btnNew'));
ok('顶栏不再堆三个文字按钮', !w.document.querySelector('header.bar #btnCfg'));
ok('空状态问候存在', !!w.document.getElementById('hero'));
ok('原入口搬进更多工具', !!w.document.querySelector('#moreSheet #btnHist') && !!w.document.querySelector('#moreSheet #btnCfg'));
ok('单列居中样式已写入', /main\{display:block!important;max-width:860px/.test(css));

// v2.6 配色：语义色走变量、深浅两套、主按钮与次按钮分得开
ok('主按钮用强调色而非渐变', /button\.primary\{background:var\(--acc2\)/.test(css));
ok('语义徽章用变量', /\.badge\.ok\{background:color-mix\(in srgb,var\(--acc\)/.test(css));
ok('浅色主题另有一套变量', /color-scheme: light/.test(css));
ok('焦点有可见描边', /input:focus,select:focus,textarea:focus\{[^}]*box-shadow/.test(css));

// v2.7 白底
ok('默认白底', /:root\{[\s\S]*?--bg:#ffffff/.test(css));
ok('主按钮是 DeepSeek 蓝', /--acc2:#4d6bfe/.test(css));
ok('不再跟随系统深色', /color-scheme: light/.test(css));

// v2.8 版式重排 + 引导只出现一次
ok('v2.8 样式层存在', /v2\.8 版式重排/.test(css));
ok('版心收成 760 居中', /body\{[^}]*max-width:760px/.test(css));
ok('卡片去掉硬边框', /#ef0f4|#eef0f4/.test(css) && /\.card\{[^}]*border:1px solid #eef0f4/.test(css));
ok('引擎卡就绪后收一行', /#engCard\.ready\{/.test(css) && /#engCard\.ready [^{]*\.row[^{]*\{display:none\}/.test(css));
const onb = w.document.getElementById('onboard');
X.S.cfg.base = ''; X.S.cfg.onboarded = 0; X.syncOnboard();
ok('首次进来看得见引导', !onb.classList.contains('hide'));
X.S.cfg.onboarded = 1; X.syncOnboard();
ok('看过之后不再出现引导', onb.classList.contains('hide'));
X.S.cfg.base = 'http://x/v1'; X.S.cfg.onboarded = 0; X.syncOnboard();
ok('已配端点不再出现引导', onb.classList.contains('hide'));
ok('菜单里能重新打开说明', !!w.document.getElementById('btnHelp'));

try { w.close(); } catch (e) {}
if (fail.length) { console.log('\n失败 ' + fail.length + ' 项'); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
