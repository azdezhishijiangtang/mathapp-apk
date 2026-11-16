#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""enginex.py —— 三个「增量加强」后端（都不常驻、按需加载、算完释放）

1) np_sweep   ：numpy 向量化密集扫描，20 万点/0.2 秒，先把反例捞出来（真命中再用 Arb 做严格确认）
2) cpsat_*    ：OR-Tools CP-SAT 处理大范围整数问题（线性/乘积/模约束），把 200 万点穷举上限变成 10^9 也能秒解
3) cvc5_prove ：含 sin/cos/exp 的简单界，cvc5 能给出 UNSAT=严格证明（给不出就退回采样）

设计原则：任何一个后端失败都返回 None，调用方继续走原来的老路子，绝不因为新后端崩掉整条验证链。
"""
import math
import time

# ---------------------------------------------------------------- 1) numpy 密集扫描
def np_sweep(expr, var_spec, n=200000, params=None, seed=12345):
    """在 var_spec 给出的闭区间上做 n 点密集扫描，返回 (ok, info)。
    ok=True 表示没找到反例；ok=False 带反例点；None 表示这个后端干不了。"""
    try:
        import numpy as np
    except Exception:
        return None
    try:
        import engine as E
        import sympy as sp
        names = list(var_spec)
        k = max(1, len(names))
        per = max(2, min(int(round(n ** (1.0 / k))), 400000))  # n 是总点数，按维均分
        syms = [sp.Symbol(v, real=True) for v in names]
        e = E.to_sym(expr, names)
        f = sp.lambdify(syms, e, "numpy")
        axes = []
        for v in names:
            lo, hi = float(var_spec[v][0]), float(var_spec[v][1])
            axes.append(np.linspace(lo, hi, per))
        grid = np.meshgrid(*axes, indexing="ij")
        with np.errstate(all="ignore"):
            vals = f(*grid)
        vals = np.asarray(vals, dtype=float)
        if vals.shape != grid[0].shape:
            vals = np.broadcast_to(vals, grid[0].shape)
        bad = np.argwhere(np.isfinite(vals) & (vals < 0))
        total = int(vals.size)
        if bad.size:
            idx = tuple(bad[0])
            pt = {nm: float(grid[k][idx]) for k, nm in enumerate(names)}
            info = {"engine": "numpy/sweep", "points": total, "counterexample": pt,
                    "value": float(vals[idx])}
            return False, info
        info = {"engine": "numpy/sweep", "points": total,
                "min_value": float(np.nanmin(vals)) if total else None}
        return True, info
    except Exception as ex:
        last_err = str(ex)[:120]
        return None


# ---------------------------------------------------------------- 2) CP-SAT 大范围整数
def cpsat_search(pred, var_spec, params=None, timeout_s=20, negate=False):
    """在 var_spec 的整数区间上找满足 pred 的点。
    negate=True 时找满足 ¬pred 的点（用于整段「不存在反例」的严格证明）。
    返回 (found, info)：found=True 找到点；False 表示整段无解（严格结论）；None 表示这个后端干不了。
    """
    import ast as A
    try:
        from ortools.sat.python import cp_model as M
    except Exception:
        return None, {"engine": "cp-sat", "detail": "ortools 未安装"}

    try:
        tree = A.parse(_to_py(pred), mode="eval") if isinstance(pred, str) else pred
        body = tree.body if isinstance(tree, A.Expression) else tree
        if negate:
            body = _neg(body)
        model = M.CpModel()
        varmap = {}

        def ivar(name):
            if name in varmap:
                return varmap[name]
            if name in (params or {}):
                pv = float(params[name])
                if pv != int(pv):
                    raise TranslateError("参数 %s 非整数" % name)
                t = (int(pv), int(pv), int(pv))
                varmap[name] = t
                return t
            if name not in var_spec:
                raise TranslateError("未知变量 %s" % name)
            lo, hi = int(var_spec[name][0]), int(var_spec[name][1])
            v = model.NewIntVar(lo, hi, name)
            t = (v, lo, hi)
            varmap[name] = t
            return t

        def num(t):
            return t[0] if t[1] == t[2] else t[0]

        def arith(node):
            if isinstance(node, A.Expression):
                return arith(node.body)
            if isinstance(node, A.Constant):
                v = node.value
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    raise TranslateError("常量类型不支持")
                if isinstance(v, float):
                    if not v.is_integer():
                        raise TranslateError("非整数常量 %r" % v)
                    v = int(v)
                return (v, v, v)
            if isinstance(node, A.Name):
                return ivar(node.id)
            if isinstance(node, A.UnaryOp) and isinstance(node.op, A.USub):
                t = arith(node.operand)
                if t[1] == t[2]:
                    return (-t[1], -t[1], -t[1])
                v = model.NewIntVar(-t[2], -t[1], "")
                model.Add(v == -1 * t[0])
                return (v, -t[2], -t[1])
            if isinstance(node, A.Call):
                fn = node.func
                fname = fn.id if isinstance(fn, A.Name) else ""
                if fname in ("Mod", "mod") and len(node.args) == 2:
                    lt, rt = arith(node.args[0]), arith(node.args[1])
                    if rt[1] != rt[2] or rt[1] <= 0:
                        raise TranslateError("模数必须是正整数常量")
                    k = rt[1]
                    if lt[1] < 0:
                        model.Add(lt[0] >= 0)
                    v = model.NewIntVar(0, k - 1, "")
                    model.AddModuloEquality(v, lt[0], k)
                    return (v, 0, k - 1)
                if fname in ("Abs", "abs") and len(node.args) == 1:
                    t = arith(node.args[0])
                    lo = 0 if t[1] <= 0 <= t[2] else min(abs(t[1]), abs(t[2]))
                    hi = max(abs(t[1]), abs(t[2]))
                    v = model.NewIntVar(lo, hi, "")
                    model.AddAbsEquality(v, t[0])
                    return (v, lo, hi)
                raise TranslateError("函数 %s 不支持" % (fname or "?"))
            if isinstance(node, A.BinOp):
                lt, rt = arith(node.left), arith(node.right)
                if isinstance(node.op, A.Add):
                    return add(lt, rt)
                if isinstance(node.op, A.Sub):
                    return sub(lt, rt)
                if isinstance(node.op, A.Mult):
                    return mul(lt, rt)
                if isinstance(node.op, A.Pow):
                    if rt[1] != rt[2]:
                        raise TranslateError("指数必须是常数")
                    e = rt[1]
                    if e < 0 or e > 8:
                        raise TranslateError("指数超出 0..8")
                    out = (1, 1, 1)
                    for _ in range(e):
                        out = mul(out, lt)
                    return out
                if isinstance(node.op, A.Mod):
                    if rt[1] != rt[2] or rt[1] <= 0:
                        raise TranslateError("模数必须是正整数常量")
                    k = rt[1]
                    if lt[1] < 0:
                        model.Add(lt[0] >= 0)
                    v = model.NewIntVar(0, k - 1, "")
                    model.AddModuloEquality(v, lt[0], k)
                    return (v, 0, k - 1)
                raise TranslateError("运算符不支持")
            raise TranslateError("结构不支持 %s" % type(node).__name__)

        def add(a, b):
            if a[1] == a[2] and b[1] == b[2]:
                s = a[1] + b[1]; return (s, s, s)
            lo, hi = a[1] + b[1], a[2] + b[2]
            v = model.NewIntVar(lo, hi, "")
            model.Add(v == a[0] + b[0])
            return (v, lo, hi)

        def sub(a, b):
            if a[1] == a[2] and b[1] == b[2]:
                s = a[1] - b[1]; return (s, s, s)
            lo, hi = a[1] - b[2], a[2] - b[1]
            v = model.NewIntVar(lo, hi, "")
            model.Add(v == a[0] - b[0])
            return (v, lo, hi)

        def mul(a, b):
            if a[1] == a[2] and b[1] == b[2]:
                s = a[1] * b[1]; return (s, s, s)
            if a[1] == a[2]:
                a, b = b, a
            if b[1] == b[2]:
                k = b[1]
                cand = [a[1] * k, a[2] * k]
                lo, hi = min(cand), max(cand)
                v = model.NewIntVar(lo, hi, "")
                model.Add(v == a[0] * k)
                return (v, lo, hi)
            cand = [a[1] * b[1], a[1] * b[2], a[2] * b[1], a[2] * b[2]]
            if max(abs(c) for c in cand) > 2 ** 62:
                raise TranslateError("乘积值域过大")
            lo, hi = min(cand), max(cand)
            v = model.NewIntVar(lo, hi, "")
            model.AddMultiplicationEquality(v, [a[0], b[0]])
            return (v, lo, hi)

        def bbool(node):
            """布尔子式 -> BoolVar（只建正向蕴含，够做可行性判断）。"""
            if isinstance(node, A.BoolOp):
                subs = [bbool(v) for v in node.values]
                b = model.NewBoolVar("")
                if isinstance(node.op, A.And):
                    model.AddBoolAnd(subs).OnlyEnforceIf(b)
                else:
                    model.AddBoolOr(subs).OnlyEnforceIf(b)
                return b
            if isinstance(node, A.UnaryOp) and isinstance(node.op, A.Not):
                raise TranslateError("谓词里别直接写 not，改用 negate=True")
            if isinstance(node, A.Compare):
                lt = arith(node.left)
                ops = list(node.ops)
                comps = list(node.comparators)
                cons = []
                cur = lt
                for op, cn in zip(ops, comps):
                    rt = arith(cn)
                    x, y = cur[0], rt[0]
                    if isinstance(op, A.Lt):
                        cons.append(x < y)
                    elif isinstance(op, A.LtE):
                        cons.append(x <= y)
                    elif isinstance(op, A.Gt):
                        cons.append(x > y)
                    elif isinstance(op, A.GtE):
                        cons.append(x >= y)
                    elif isinstance(op, A.Eq):
                        cons.append(x == y)
                    elif isinstance(op, A.NotEq):
                        cons.append(x != y)
                    else:
                        raise TranslateError("比较符不支持")
                    cur = rt
                b = model.NewBoolVar("")
                for c in cons:
                    model.Add(c).OnlyEnforceIf(b)
                return b
            raise TranslateError("布尔结构不支持 %s" % type(node).__name__)

        root = bbool(body)
        model.Add(root == 1)
        solver = M.CpSolver()
        solver.parameters.max_time_in_seconds = float(timeout_s)
        solver.parameters.num_search_workers = 2
        st = solver.Solve(model)
        if st in (M.FEASIBLE, M.OPTIMAL):
            pt = {name: int(solver.Value(t[0])) for name, t in varmap.items() if t[1] != t[2]}
            return True, {"engine": "cp-sat", "point": pt, "secs": round(solver.WallTime(), 2)}
        if st == M.INFEASIBLE:
            return False, {"engine": "cp-sat", "secs": round(solver.WallTime(), 2)}
        return None, {"engine": "cp-sat", "detail": "求解超时"}
    except TranslateError as ex:
        return None, {"engine": "cp-sat", "detail": "翻不了：%s" % str(ex)[:80]}
    except Exception as ex:
        return None, {"engine": "cp-sat", "detail": "%s: %s" % (type(ex).__name__, str(ex)[:100])}


class TranslateError(Exception):
    """把 Python 表达式翻成 CP-SAT 模型失败时抛这个。"""


_FLIP = None


def _neg(node):
    """把 ¬ 推到比较符上（CP-SAT 的 BoolVar 只有单向蕴含，用 ¬BoolVar 做否定不可靠）。"""
    import ast as A
    global _FLIP
    if _FLIP is None:
        _FLIP = {A.Lt: A.GtE, A.LtE: A.Gt, A.Gt: A.LtE, A.GtE: A.Lt,
                 A.Eq: A.NotEq, A.NotEq: A.Eq}
    if isinstance(node, A.UnaryOp) and isinstance(node.op, A.Not):
        return _neg(node.operand)
    if isinstance(node, A.BoolOp):
        flipped = A.Or if isinstance(node.op, A.And) else A.And
        return A.BoolOp(op=flipped(), values=[_neg(v) for v in node.values])
    if isinstance(node, A.Compare):
        return A.Compare(left=node.left,
                         ops=[_FLIP[type(o)]() for o in node.ops],
                         comparators=list(node.comparators))
    raise TranslateError("无法取反的结构 %s" % type(node).__name__)


def _to_py(expr):
    try:
        import engine as E
        return E._pyify(expr)
    except Exception:
        return expr


# ---------------------------------------------------------------- 3) cvc5 严格证明
def cvc5_prove(expr, var_spec, timeout_ms=8000):
    """尝试证明 ∀vars∈区间: expr >= 0（expr 为 ≥0 形式的差式）。
    返回 (proved: True|None, info)。True 表示 cvc5 给出 UNSAT＝严格证明。"""
    try:
        import cvc5
        from cvc5 import Kind
        import sympy as sp
        import engine as E
    except Exception:
        return None, {"engine": "cvc5", "detail": "cvc5 未安装"}
    try:
        names = list(var_spec)
        e = E.to_sym(expr, names)
        tm = cvc5.TermManager()
        s = cvc5.Solver(tm)
        s.setLogic("QF_NRA")
        for k, v in {"tlimit-per": str(int(timeout_ms)), "nl-ext": "full", "nl-cov": "false"}.items():
            try:
                s.setOption(k, v)
            except Exception:
                pass
        cache = {}

        def conv(x):
            if x in cache:
                return cache[x]
            if x.is_Number:
                if x == sp.pi:
                    t = tm.mkTerm(Kind.PI)
                elif x.is_Rational:
                    t = tm.mkReal(int(x.p), int(x.q))
                else:
                    raise ValueError("数值不支持")
                cache[x] = t
                return t
            if x.is_Symbol:
                t = tm.mkConst(tm.getRealSort(), str(x))
                cache[x] = t
                return t
            if x is sp.pi:
                t = tm.mkTerm(Kind.PI); cache[x] = t; return t
            args = [conv(a) for a in x.args]
            f = x.func
            if f is sp.Add:
                t = args[0]
                for a in args[1:]:
                    t = tm.mkTerm(Kind.ADD, t, a)
            elif f is sp.Mul:
                t = args[0]
                for a in args[1:]:
                    t = tm.mkTerm(Kind.MULT, t, a)
            elif f is sp.Pow:
                if len(args) != 2 or not x.args[1].is_Integer:
                    raise ValueError("幂不支持")
                n = int(x.args[1])
                if n < 0:
                    t = tm.mkTerm(Kind.DIVISION, tm.mkReal(1), tm.mkTerm(Kind.POW, args[0], tm.mkReal(-n)))
                else:
                    t = tm.mkTerm(Kind.POW, args[0], tm.mkReal(n))
            elif f is sp.sin:
                t = tm.mkTerm(Kind.SINE, args[0])
            elif f is sp.cos:
                t = tm.mkTerm(Kind.COSINE, args[0])
            else:
                raise ValueError("函数不支持 %s" % f)
            cache[x] = t
            return t

        diff = conv(e)
        s.assertFormula(tm.mkTerm(Kind.LT, diff, tm.mkReal(0)))
        for nm in names:
            lo, hi = float(var_spec[nm][0]), float(var_spec[nm][1])
            v = cache[sp.Symbol(nm, real=True)]
            s.assertFormula(tm.mkTerm(Kind.GEQ, v, tm.mkReal(str(lo))))
            s.assertFormula(tm.mkTerm(Kind.LEQ, v, tm.mkReal(str(hi))))
        t0 = time.time()
        r = s.checkSat()
        dt = round(time.time() - t0, 2)
        if r.isUnsat():
            return True, {"engine": "cvc5/nl-ext", "secs": dt, "detail": "cvc5 判定反例不可满足（严格证明）"}
        if r.isSat():
            return None, {"engine": "cvc5/nl-ext", "secs": dt, "detail": "cvc5 认为有反例但给不出点，退回采样"}
        return None, {"engine": "cvc5/nl-ext", "secs": dt, "detail": "cvc5 超时/未知"}
    except Exception as ex:
        return None, {"engine": "cvc5", "detail": "%s: %s" % (type(ex).__name__, str(ex)[:100])}


if __name__ == "__main__":
    print(np_sweep("sin(x)+sin(y)-1.6", {"x": [0, 3], "y": [0, 3]}))
    print(cpsat_search("n*m==391", {"n": [1, 10 ** 9], "m": [1, 10 ** 9]}, timeout_s=10))
    print(cvc5_prove("1-sin(x)", {"x": [-6, 6]}))
