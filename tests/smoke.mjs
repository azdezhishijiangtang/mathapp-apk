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
  '\n;window.__exp={S,Mods,Tree,Store,Branch,render,toast,syncDueBar,boxedOf,normAns,renderVerify,renderCross,callLLM};';
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

try { w.close(); } catch (e) {}
if (fail.length) { console.log('\n失败 ' + fail.length + ' 项'); process.exit(1); }
console.log('\n全部通过');
process.exit(0);
