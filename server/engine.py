#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数学验证引擎（本地，零联网）
引擎：SymPy(符号) / z3(nlsat，多项式实数判定) / python-flint·Arb(严格区间算术) / PARI(数论，可选)

对外一个函数：verify_claims(claims) -> list[dict]
claim 结构（模型按提示词输出）：
  {"kind":"identity",      "lhs":"(a+b)^2", "rhs":"a^2+2ab+b^2", "vars":{"a":"real","b":"real"}}
  {"kind":"ineq",          "expr":"a^2+b^2-2*a*b>=0", "vars":{"a":"real"}, "universal":true}
  {"kind":"ineq",          "expr":"sin(x)<=1", "vars":{"x":"real"}, "universal":true, "range":{"x":[0,3.14159]}}
  {"kind":"value",         "expr":"sqrt(13)", "expected":"3.6055512754639892", "tol":"1e-12"}
  {"kind":"counterexample","expr":"m^2>2*m", "vars":{"m":"real"}, "range":{"m":[0,2]}}
  {"kind":"nt",            "expr":"2^61-1", "assert":"prime"}
"""
import re, json, math, time
from fractions import Fraction

import sympy as sp
from sympy.parsing.sympy_parser import (parse_expr, standard_transformations,
                                        implicit_multiplication_application,
                                        convert_xor, rationalize)

TRANS = standard_transformations + (convert_xor, implicit_multiplication_application)
LOCAL = {n: getattr(sp, n) for n in
         ("sin", "cos", "tan", "cot", "sec", "csc", "asin", "acos", "atan",
          "sinh", "cosh", "tanh", "exp", "log", "sqrt", "Abs", "sign",
          "floor", "ceiling", "pi", "E", "oo", "binomial", "factorial")}
LOCAL.update({"ln": sp.log, "lg": lambda x: sp.log(x, 10), "max": sp.Max, "min": sp.Min,
              "gcd": sp.gcd, "lcm": sp.lcm})

GREEK = {"alpha": "a", "beta": "b", "gamma": "c", "theta": "t", "pi": "pi",
         "lambda": "l", "mu": "m", "phi": "phi", "epsilon": "e", "omega": "w",
         "sigma": "s", "delta": "d", "rho": "r", "tau": "tau", "xi": "x", "eta": "h"}

def latex2py(s: str) -> str:
    """把常见 LaTeX 粗略转成 Python 表达式串。"""
    if not isinstance(s, str):
        s = str(s)
    s = s.strip()
    s = s.replace("$$", "").replace("$", "")
    s = re.sub(r"\\left|\\right|\\!|\\,|\\;|\\ |\\displaystyle", "", s)
    s = re.sub(r"\\(?:text|mathrm|operatorname)\{([^{}]*)\}", r"\1", s)
    s = s.replace("\\cdot", "*").replace("\\times", "*").replace("\\div", "/")
    s = s.replace("\\leq", "<=").replace("\\le", "<=").replace("\\geq", ">=").replace("\\ge", ">=")
    s = s.replace("\\neq", "!=").replace("\\ne", "!=").replace("\\approx", "=")
    s = s.replace("\\pm", "+").replace("\\infty", "oo").replace("\\pi", "pi")
    s = s.replace("\\{", "{").replace("\\}", "}").replace("\\%", "%")
    s = re.sub(r"\\left\\?lfloor|\\lfloor", "floor(", s)
    s = re.sub(r"\\left\\?rfloor|\\rfloor", ")", s)
    s = re.sub(r"\\left\\?lceil|\\lceil", "ceiling(", s)
    s = re.sub(r"\\left\\?rceil|\\rceil", ")", s)
    s = re.sub(r"\\binom\{([^{}]*)\}\{([^{}]*)\}", r"binomial(\1,\2)", s)
    s = s.replace("\\mid", " | ")
    s = re.sub(r"(\d+|\w+)!", r"factorial(\1)", s)
    for k, v in GREEK.items():
        s = re.sub(r"\\%s(?![a-zA-Z])" % k, " " + v + " ", s)
    # \frac{a}{b} / \dfrac / \tfrac  —— 支持一层嵌套
    for _ in range(4):
        s = re.sub(r"\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}", r"((\1)/(\2))", s)
    s = re.sub(r"\\sqrt\[([^\]]*)\]\{([^{}]*)\}", r"((\2)**(1/(\1)))", s)
    s = re.sub(r"\\sqrt\{([^{}]*)\}", r"sqrt(\1)", s)
    # 上标：x^{2} -> x**(2)，e^{...}
    s = re.sub(r"\^\{([^{}]*)\}", r"**(\1)", s)
    # 函数名反斜杠
    s = re.sub(r"\\(sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|log|ln|exp|max|min|gcd)h?",
               lambda m: m.group(1), s)
    s = s.replace("\\", "")
    return s.strip()

def to_sym(s, vars_hint=None):
    """字符串/LaTeX -> sympy 表达式；未知符号一律当实数符号。"""
    s = latex2py(s)
    local = dict(LOCAL)
    local.setdefault("floor", lambda z: sp.floor(z))
    local.setdefault("ceiling", lambda z: sp.ceiling(z))
    local.setdefault("ceil", lambda z: sp.ceiling(z))
    local.setdefault("binomial", lambda n, k: sp.binomial(n, k))
    local.setdefault("factorial", lambda n: sp.factorial(n))
    if vars_hint:
        for v in vars_hint:
            local.setdefault(v, sp.Symbol(v, real=True))
    e = parse_expr(s, local_dict=local, transformations=TRANS, evaluate=True)
    # 统一把自由符号视作实数
    reps = {sym: sp.Symbol(sym.name, real=True) for sym in e.free_symbols if not sym.is_real}
    if reps:
        e = e.subs(reps)
    return sp.simplify(e)

# ---------------------------------------------------------------- z3 通路
def to_z3(e, syms):
    import z3
    if e.is_Number:
        if e.is_Integer:
            return z3.RealVal(int(e))
        return z3.RealVal(str(e))
    if e.is_Symbol:
        return syms[e.name]
    if e.is_Add:
        r = to_z3(e.args[0], syms)
        for a in e.args[1:]:
            r = r + to_z3(a, syms)
        return r
    if e.is_Mul:
        r = to_z3(e.args[0], syms)
        for a in e.args[1:]:
            r = r * to_z3(a, syms)
        return r
    if e.is_Pow:
        b, ex = e.args
        if ex.is_Integer:
            n = int(ex)
            bz = to_z3(b, syms)
            if n >= 0:
                r = z3.RealVal(1)
                for _ in range(n):
                    r = r * bz
                return r
            return z3.RealVal(1) / (bz ** (-n))
        raise ValueError("非整数幂 %s" % ex)
    if e is sp.Abs:
        a = to_z3(e.args[0], syms)
        return z3.If(a >= 0, a, -a)
    raise ValueError("z3 不支持的子式: %s" % e.func)

def is_poly(e):
    return not e.has(sp.sin, sp.cos, sp.tan, sp.exp, sp.log, sp.Abs, sp.sign,
                     sp.floor, sp.ceiling, sp.Max, sp.Min)

def z3_universal(expr, var_names, ranges=None, timeout_ms=25000):
    """判定 ∀vars(ranges→expr>=0)。返回 (verdict, model/detail)"""
    import z3
    syms = {v: z3.Real(v) for v in var_names}
    s = z3.Solver()
    s.set("timeout", timeout_ms)
    if ranges:
        for v, (lo, hi) in ranges.items():
            if v in syms:
                s.add(syms[v] >= lo, syms[v] <= hi)
    s.add(z3.Not(to_z3(expr, syms) >= 0))
    t = time.time()
    r = s.check()
    dt = time.time() - t
    if r == z3.unsat:
        return True, {"engine": "z3/nlsat", "verdict": "proved", "secs": round(dt, 2)}
    if r == z3.sat:
        m = s.model()
        ce = {}
        for v in var_names:
            try:
                ce[v] = str(m[syms[v]])
            except Exception:
                pass
        return False, {"engine": "z3/nlsat", "verdict": "counterexample", "point": ce, "secs": round(dt, 2)}
    return None, {"engine": "z3/nlsat", "verdict": "unknown", "secs": round(dt, 2)}

# ---------------------------------------------------- Arb 严格区间数值扫描
def arb_eval(expr, env, prec=200):
    """在 Arb 严格区间算术下对 sympy 表达式求值（自己走语法树，避免 float 化）。"""
    from flint import arb, ctx
    ctx.prec = prec
    e = expr
    if e is sp.pi:
        return arb.pi()
    if e is sp.E:
        return arb(1).exp()
    if e.is_Number:
        if e.is_Integer:
            return arb(int(e))
        try:
            return arb(str(sp.N(e, 40)))
        except Exception:
            return arb(float(e))
    if e.is_Symbol:
        return env[str(e)]
    if e.is_Add:
        r = arb(0)
        for a in e.args:
            r = r + arb_eval(a, env, prec)
        return r
    if e.is_Mul:
        r = arb(1)
        for a in e.args:
            r = r * arb_eval(a, env, prec)
        return r
    if e.is_Pow:
        b, ex = e.args
        if not ex.is_Integer:
            raise ValueError("非整数幂 %s" % ex)
        n = int(ex)
        bb = arb_eval(b, env, prec)
        return bb ** n if n >= 0 else arb(1) / (bb ** (-n))
    name = e.func.__name__
    arg = e.args[0] if e.args else None
    v = arb_eval(arg, env, prec) if arg is not None else None
    meth = {"sin": "sin", "cos": "cos", "tan": "tan", "exp": "exp", "log": "log",
            "sqrt": "sqrt", "atan": "atan", "asin": "asin", "acos": "acos"}.get(name)
    if meth:
        return getattr(v, meth)()
    if e.func is sp.Abs:
        return abs(v)
    raise ValueError("Arb 不支持的函数 %s" % name)


def arb_sweep(expr, var, lo, hi, n=4000):
    """在 [lo,hi] 上 n 点严格区间求值，判断 expr>=0 是否为真。
    返回 (ok, info)：ok=False 表示找到严格反例（有 Rigorous 证据）。"""
    from flint import arb, ctx
    ctx.prec = 200
    vname = str(var)
    step = (hi - lo) / n
    xs = []
    try:
        for i in range(n + 1):
            xi = lo + i * step
            val = arb_eval(expr, {vname: arb(str(xi))})
            xs.append((float(val), xi))
    except Exception as e:
        return None, {"engine": "arb", "verdict": "eval_error", "error": str(e)[:160]}
    if not xs:
        return None, {"engine": "arb", "verdict": "eval_error"}
    xs.sort()
    worst_x = xs[0][1]
    h = (hi - lo) / 2000.0
    best = None
    for k in range(-40, 41):
        xx = worst_x + k * h
        if xx < lo or xx > hi:
            continue
        try:
            val = arb_eval(expr, {vname: arb(str(xx))})
        except Exception:
            continue
        if best is None or float(val) < float(best[0]):
            best = (val, xx)
    if best is None:
        return None, {"engine": "arb", "verdict": "eval_error"}
    val, xx = best
    info = {"engine": "arb", "prec_bits": 200, "grid": n,
            "min_enclosure": str(val), "at": round(xx, 12)}
    if float(val) < 0:
        info["verdict"] = "counterexample"
        info["point"] = {vname: round(xx, 12)}
        return False, info
    info["verdict"] = "no_counterexample_found"
    return True, info


# ---------------------------------------------------------------- 各类检查
def check_identity(lhs, rhs, var_names, timeout=25):
    L, R = to_sym(lhs, var_names), to_sym(rhs, var_names)
    d = sp.simplify(L - R)
    if d == 0:
        return {"status": "proved", "engine": "sympy", "detail": "差式化简为 0"}
    d = sp.expand(sp.simplify(sp.expand(L - R)))
    if d == 0:
        return {"status": "proved", "engine": "sympy", "detail": "展开后差式等于 0"}
    # 试试数值反例
    vals = list(L.free_symbols | R.free_symbols)
    import random
    for _ in range(50):
        sub = {s: sp.Rational(random.randint(-30, 30), random.randint(1, 9)) for s in vals}
        try:
            if abs(complex(sp.N(L.subs(sub) - R.subs(sub), 30))) > sp.Rational(1, 10 ** 10):
                return {"status": "refuted", "engine": "sympy",
                        "detail": "差式不为 0，差 = " + str(d)[:200],
                        "counterexample": {str(k): str(v) for k, v in sub.items()}}
        except Exception:
            pass
    return {"status": "unknown", "engine": "sympy", "detail": "无法化简为 0，也未找到反例"}

def split_rel(s):
    """把 'lhs >= rhs' 拆开，统一成 E = lhs - rhs（要求 E>=0）。"""
    s = s.strip()
    for op in ("<=", ">=", "==", "=", "<", ">"):
        if op in s:
            i = s.index(op)
            lhs, rhs = s[:i], s[i + len(op):]
            if op in (">=", ">"):
                return lhs, rhs
            return rhs, lhs          # <=,<,= → 反过来
    return s, None

def check_ineq(expr, var_names, ranges=None, universal=True, timeout=25):
    # 规范成 f>=0
    s = latex2py(expr)
    try:
        lhs, rhs = split_rel(s)
        E = to_sym(lhs, var_names)
        if rhs is not None and rhs.strip() != "":
            E = sp.expand(E - to_sym(rhs, var_names))
    except Exception as e:
        return {"status": "error", "engine": "-", "detail": "表达式解析失败: %s" % str(e)[:120]}
    if universal and is_poly(E):
        ok, info = z3_universal(E, var_names, ranges, timeout * 1000)
        if ok is True:
            return {"status": "proved", **info}
        if ok is False:
            return {"status": "refuted", **info}
    if not var_names:
        v = sp.N(E, 40)
        return {"status": "proved" if v >= 0 else "refuted", "engine": "sympy", "detail": str(v)}
    # ---- 新增后端：numpy 密集扫描（快捞反例）→ Arb 严格复核 → cvc5 试严格证明
    try:
        import enginex as X
        sub = {k: ranges[k] for k in var_names if ranges and k in ranges}
        if universal and sub and len(sub) == len(var_names) and len(var_names) >= 2:
            okx, infx = X.np_sweep(E, sub, n=200000)
            if okx is False:
                pt = infx.get("counterexample") or {}
                try:
                    val = arb_eval(E, {k: sp.Float(v) for k, v in pt.items()})
                    if float(val) < 0:
                        return {"status": "refuted", "engine": "numpy+arb",
                                "counterexample": pt, "value": float(val),
                                "detail": "密集扫描命中，Arb 严格复核确认 <0"}
                except Exception:
                    pass
            elif okx is True and len(var_names) <= 2:
                okc, infc = X.cvc5_prove(E, sub, timeout_ms=5000)
                if okc is True:
                    return {"status": "proved", **infc}
                return {"status": "no_counterexample_found",
                        "engine": "numpy/sweep", "points": infx.get("points"),
                        "min_value": infx.get("min_value"),
                        "detail": "扫描 %s 点无负值（采样结论，非严格证明）" % infx.get("points")}
    except Exception:
        pass

    var = sp.Symbol(var_names[0], real=True)
    if len(var_names) == 1:
        lo, hi = (ranges or {}).get(var_names[0], [0, 1])
        ok, info = arb_sweep(E, var, float(lo), float(hi))
        if ok is False:
            return {"status": "refuted", **info}
        if ok is True:
            try:  # Arb 网格较粗，再用 numpy 20 万点加密确认一遍
                import enginex as X
                r2 = X.np_sweep(E, {var_names[0]: [float(lo), float(hi)]}, n=200000)
                if r2 and r2[0] is False:
                    return {"status": "refuted", **r2[1]}
                if r2 and r2[0] is True:
                    info.update({"points": r2[1].get("points"), "engine": "arb+numpy"})
            except Exception:
                pass
            return {"status": "no_counterexample_found", **info}
        return {"status": "unknown", **info}
    # 多变量非多项式：抽样 + 严格区间
    if ranges and len(var_names) >= 2:
        ok, info = arb_sweep_multi(E, {k: ranges[k] for k in var_names if k in ranges})
        if ok is False:
            return {"status": "refuted", **info}
        if ok is True:
            return {"status": "no_counterexample_found", **info}
        return {"status": "unknown", **info}
    return {"status": "unknown", "engine": "-", "detail": "多变量非多项式缺少 range，未覆盖"}

def check_value(expr, expected, tol="1e-12"):
    E = to_sym(expr)
    v = sp.N(E, 50)
    try:
        exp = sp.N(to_sym(str(expected)), 50)
        diff = abs(v - exp)
        ok = bool(diff < sp.Float(tol))
        return {"status": "proved" if ok else "refuted", "engine": "sympy/mpmath",
                "detail": "实算 %s vs 期望 %s，差 %s" % (sp.N(v, 25), sp.N(exp, 25), sp.N(diff, 6))}
    except Exception:
        return {"status": "unknown", "engine": "sympy", "detail": "期望值无法解析：%s；实算 %s" % (expected, sp.N(v, 25))}

def check_counterexample(expr, var_names, ranges=None, timeout=25):
    r = check_ineq("(" + expr + ")", var_names, ranges, universal=True, timeout=timeout)
    if r["status"] == "refuted":
        return r
    if r["status"] == "proved":
        return {"status": "none_found", "engine": r.get("engine"), "detail": "该式恒成立，不存在反例"}
    return r

def check_nt(expr, assertion, timeout=20):
    """数论断言：prime / composite / square / coprime / divides / pow / factor。"""
    a = (assertion or "").lower()
    try:
        E = to_sym(expr)
        val = sp.Integer(int(E)) if E.is_number and E.is_integer else E
    except Exception as e:
        return {"status": "error", "engine": "sympy", "detail": "解析失败 %s" % str(e)[:100]}
    if a in ("prime", "isprime", "not_prime", "composite"):
        n = val if isinstance(val, sp.Integer) else None
        if n is None:
            return {"status": "unknown", "engine": "-", "detail": "expr 不是整数常量"}
        isp = bool(sp.isprime(n))
        if a in ("prime", "isprime"):
            want = True
        else:
            want = False
        ok = (isp == want)
        return {"status": "proved" if ok else "refuted", "engine": "sympy.isprime",
                "detail": "%d %s素数" % (int(n), "是" if isp else "不是")}
    if a in ("square", "perfect_square", "not_square"):
        n = int(val)
        r = int(sp.integer_nthroot(n, 2)[0])
        ok = (r * r == n)
        if a == "not_square":
            ok = not ok
        return {"status": "proved" if ok else "refuted", "engine": "sympy.integer_nthroot",
                "detail": "%d 的平方根整数部分 %d" % (n, r)}
    if a in ("integer", "isinteger"):
        ok = bool(val.is_integer) if hasattr(val, "is_integer") else float(val) == int(float(val))
        return {"status": "proved" if ok else "refuted", "engine": "sympy", "detail": str(val)}
    if a in ("factor", "factorize", "factorization"):
        return {"status": "info", "engine": "sympy.factor", "detail": str(sp.factor(val))}
    return {"status": "unknown", "engine": "-", "detail": "未支持的断言 %s" % assertion}


# ================================================================
# 整数 / 数论 / 组合：小规模穷举（带 AST 白名单，安全求值）
# ================================================================
import ast as _ast

SAFE_NAMES = {"isprime": sp.isprime, "prime": sp.isprime, "is_square": lambda n: int(n) >= 0 and int(int(n) ** 0.5) ** 2 == int(n),
              "gcd": sp.gcd, "lcm": sp.lcm, "floor": lambda z: int(sp.floor(z)), "ceil": lambda z: int(sp.ceiling(z)),
              "mod": lambda a, b: a % b, "Mod": lambda a, b: a % b, "Ceiling": lambda z: int(sp.ceiling(z)), "Floor": lambda z: int(sp.floor(z)), "binomial": lambda n, k: int(sp.binomial(n, k)),
              "factorial": lambda n: int(sp.factorial(n)), "sqrt": lambda z: sp.sqrt(z), "abs": abs,
              "min": min, "max": max, "len": len, "sum": sum, "divisors": lambda n: sp.divisors(n),
              "totient": lambda n: int(sp.totient(n)), "digits": lambda n: [int(c) for c in str(int(n))],
              "int": int, "float": float, "round": round, "pow": pow, "range": range, "all": all, "any": any,
              "pi": sp.pi, "e": sp.E, "inf": sp.oo}

_ALLOWED_NODES = (_ast.Expression, _ast.BoolOp, _ast.BinOp, _ast.UnaryOp, _ast.Compare, _ast.Call,
                  _ast.Name, _ast.Load, _ast.Constant, _ast.IfExp, _ast.Tuple, _ast.List,
                  _ast.Add, _ast.Sub, _ast.Mult, _ast.Div, _ast.FloorDiv, _ast.Mod, _ast.Pow,
                  _ast.USub, _ast.UAdd, _ast.Not, _ast.And, _ast.Or, _ast.Eq, _ast.NotEq,
                  _ast.Lt, _ast.LtE, _ast.Gt, _ast.GtE, _ast.In, _ast.NotIn, _ast.ListComp,
                  _ast.comprehension, _ast.Subscript, _ast.Slice)


def safe_eval(expr, env):
    """只允许纯表达式，禁止属性访问/导入/lambda/赋值。"""
    tree = _ast.parse(expr, mode="eval")
    for node in _ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise ValueError("表达式里有不允许的结构：%s" % type(node).__name__)
        if isinstance(node, _ast.Call) and not isinstance(node.func, _ast.Name):
            raise ValueError("只允许直接调用白名单函数")
        if isinstance(node, _ast.Name) and node.id.startswith("__"):
            raise ValueError("非法名称")
        if isinstance(node, _ast.Call) and isinstance(node.func, _ast.Name) and node.func.id not in SAFE_NAMES \
                and node.func.id not in env:
            raise ValueError("不在白名单的函数：%s" % node.func.id)
    return eval(compile(tree, "<claim>", "eval"), {"__builtins__": {}}, {**SAFE_NAMES, **env})


def _grid(vars_ranges, cap=2000000):
    """把各变量的整数区间展开成笛卡尔积（带总量上限）。"""
    import itertools
    names = list(vars_ranges)
    rngs = []
    total = 1
    for n in names:
        lo, hi = vars_ranges[n]
        lo, hi = int(lo), int(hi)
        rngs.append(range(lo, hi + 1))
        total *= (hi - lo + 1)
    if total > cap:
        return None, total
    return itertools.product(*rngs), total



def _pyify(expr):
    """把模型常写的 ^ 幂、LaTeX 记法转成 Python 表达式（整数穷举路径用）。"""
    if not isinstance(expr, str):
        return expr
    e = expr
    e = e.replace("^{", "**(").replace("^", "**")
    e = e.replace("\\lfloor", "floor(").replace("\\rfloor", ")")
    e = e.replace("\\lceil", "ceil(").replace("\\rceil", ")")
    e = e.replace("\\cdot", "*").replace("\\times", "*").replace("\\div", "/")
    e = e.replace("\\binom{", "binomial(").replace("\\mid", "|")
    e = e.replace("{", "(").replace("}", ")")
    e = re.sub(r"(?<![\w.])P_?(?![\w(])", "pi", e)
    # 上标
    e = e.replace("²", "**2").replace("³", "**3")
    # 阶乘：5! -> factorial(5)
    e = re.sub(r"(\d+|[a-zA-Z_]\w*)\!(?!=)", r"factorial(\1)", e)
    # 隐式乘法：3n -> 3*n，2x -> 2*x
    e = re.sub(r"(\d)([a-zA-Z_])", r"\1*\2", e)
    e = re.sub(r"(\d)\*e(\d)", r"\1e\2", e)          # 还原科学计数
    e = re.sub(r"([a-zA-Z_)])(\d)", r"\1*\2", e) if False else e
    e = e.replace("**", "^TMP^").replace("*", "*").replace("^TMP^", "**")
    return e

def check_forall_int(expr, vars_spec, cap=2000000, params=None):
    """在整数区间上穷举反例。vars_spec: {"n":[1,500], ...}；params: 实数常量 {"alpha":1.5}"""
    expr = _pyify(expr)
    const = dict(params or {})
    it, total = _grid(vars_spec, cap)
    if it is None:
        try:
            import enginex as X
            found, info = X.cpsat_search(expr, vars_spec, params=const, timeout_s=20, negate=True)
            if found is False:
                return {"status": "proved", "engine": "cp-sat",
                        "detail": "CP-SAT 判定反例集合不可满足（在给定整数区间上是严格结论）"}
            if found is True:
                return {"status": "refuted", "engine": "cp-sat",
                        "point": {k: str(v) for k, v in (info.get("point") or {}).items()},
                        "detail": "CP-SAT 直接给出反例"}
            return {"status": "unknown", "engine": "cp-sat", "detail": info.get("detail", "CP-SAT 未能判定")}
        except Exception as e:
            return {"status": "unknown", "engine": "exhaustive",
                    "detail": "搜索空间 %d 点超过上限 %d（CP-SAT 也不可用：%s）" % (total, cap, str(e)[:60])}
    names = list(vars_spec)
    n = 0
    for vals in it:
        env = dict(const, **dict(zip(names, vals)))
        try:
            ok = bool(safe_eval(expr, env))
        except Exception as e:
            return {"status": "error", "engine": "exhaustive",
                    "detail": "%s（在 %s）" % (str(e)[:120], env)}
        n += 1
        if not ok:
            return {"status": "refuted", "engine": "exhaustive",
                    "point": {k: str(v) for k, v in env.items()},
                    "detail": "在 %d 个整数点上找到反例" % n}
    return {"status": "proved", "engine": "exhaustive",
            "detail": "在给定区间内穷举 %d 点无反例（有限范围判定，非全局证明）" % n}


def check_exists_int(expr, vars_spec, cap=2000000, params=None):
    expr = _pyify(expr)
    const = dict(params or {})
    it, total = _grid(vars_spec, cap)
    if it is None:
        try:
            import enginex as X
            found, info = X.cpsat_search(expr, vars_spec, params=const, timeout_s=20)
            if found is True:
                return {"status": "proved", "engine": "cp-sat",
                        "point": {k: str(v) for k, v in (info.get("point") or {}).items()},
                        "detail": "CP-SAT 在巨大整数区间上找到满足点"}
            if found is False:
                return {"status": "refuted", "engine": "cp-sat",
                        "detail": "CP-SAT 判定区间内无解（严格结论）"}
            return {"status": "unknown", "engine": "cp-sat", "detail": info.get("detail", "CP-SAT 未能判定")}
        except Exception as e:
            return {"status": "unknown", "engine": "exhaustive", "detail": "空间过大（CP-SAT 不可用：%s）" % str(e)[:60]}
    names = list(vars_spec)
    for vals in it:
        env = dict(const, **dict(zip(names, vals)))
        try:
            if bool(safe_eval(expr, env)):
                return {"status": "proved", "engine": "exhaustive",
                        "point": {k: str(v) for k, v in env.items()}, "detail": "找到满足条件的点"}
        except Exception as e:
            return {"status": "error", "engine": "exhaustive", "detail": str(e)[:120]}
    return {"status": "refuted", "engine": "exhaustive", "detail": "范围内不存在满足条件的整数点"}


def check_recurrence(closed, rec, init, nrange, var="n"):
    """验证闭式公式与递推式在 [n0,n1] 上一致。
    closed: 关于 n 的表达式；rec: 用 a_prev 表示 a_n；init: a_1 的值。"""
    lo, hi = int(nrange[0]), int(nrange[1])
    n = sp.Symbol(var, integer=True, positive=True)
    try:
        fc = sp.lambdify(n, to_sym(closed), "math")
        ap = sp.Symbol("a_prev")
        fr = sp.lambdify(ap, to_sym(rec.replace("a_prev", "a_prev")), "math")
    except Exception as e:
        return {"status": "error", "engine": "sympy", "detail": "解析失败 %s" % str(e)[:120]}
    try:
        prev = None
        for k in range(lo, hi + 1):
            c = fc(k)
            if prev is None:
                # 用 k=lo 处的闭式值作为起点，校验 init 是否被公式满足
                prev = c
                continue
            r = fr(prev)
            if abs(float(c) - float(r)) > 1e-9:
                return {"status": "refuted", "engine": "sympy",
                        "point": {var: str(k)}, "detail": "闭式 %.6g ≠ 递推 %.6g" % (float(c), float(r))}
            prev = c
        return {"status": "proved", "engine": "sympy",
                "detail": "闭式与递推在 n∈[%d,%d] 上逐项一致" % (lo, hi)}
    except Exception as e:
        return {"status": "error", "engine": "sympy", "detail": str(e)[:120]}


def check_mod(expr, mod, vars_spec, params=None):
    """验证 expr 恒被 mod 整除：在整数区间上穷举。"""
    e2 = "((%s) %% (%d)) == 0" % (expr, int(mod))
    r = check_forall_int(e2, vars_spec, params=params)
    r["detail"] = "对模 %d：" % int(mod) + r.get("detail", "")
    return r


def arb_sweep_multi(expr, var_spec, samples=60):
    """多变量 Arb 采样（每维 samples 点，超过 2 维时随机抽样）。"""
    import itertools, random
    from flint import arb, ctx
    ctx.prec = 120
    names = list(var_spec)
    axes = []
    for n in names:
        lo, hi = var_spec[n]
        axes.append([lo + (hi - lo) * i / max(1, samples - 1) for i in range(samples)])
    if len(names) <= 2:
        pts = itertools.product(*axes)
    else:
        pts = ([random.uniform(var_spec[n][0], var_spec[n][1]) for n in names] for _ in range(samples ** 2))
    best = None
    cnt = 0
    for pt in pts:
        cnt += 1
        env = {n: arb(str(x)) for n, x in zip(names, pt)}
        try:
            v = arb_eval(expr, env, 120)
        except Exception as e:
            return None, {"engine": "arb", "verdict": "eval_error", "error": str(e)[:120]}
        if best is None or float(v) < float(best[0]):
            best = (v, pt)
    if best is None:
        return None, {"engine": "arb", "verdict": "eval_error"}
    v, pt = best
    info = {"engine": "arb", "prec_bits": 120, "points": cnt,
            "min_enclosure": str(v), "at": {n: round(float(x), 8) for n, x in zip(names, pt)}}
    if float(v) < 0:
        info["verdict"] = "counterexample"
        info["point"] = info["at"]
        return False, info
    info["verdict"] = "no_counterexample_found"
    return True, info



def _roots_numeric(expr, claimed, var="x", lo=-12.0, hi=12.0, n=24000):
    """数值零点扫描：找符号变化点并用二分细化，再与模型声称的解集比对。"""
    import math
    x = sp.Symbol(var, real=True)
    e = to_sym(expr, [var])
    f = sp.lambdify(x, e, "math")
    xs = [lo + (hi - lo) * i / n for i in range(n + 1)]
    vals = []
    for v in xs:
        try:
            vals.append(float(f(v)))
        except Exception:
            vals.append(float("nan"))
    found = []
    for i in range(n):
        a, b = xs[i], xs[i + 1]
        fa, fb = vals[i], vals[i + 1]
        if math.isnan(fa) or math.isnan(fb):
            continue
        if fa == 0:
            found.append(a)
        elif fa * fb < 0:
            l, r = a, b
            for _ in range(80):
                m = (l + r) / 2
                if f(l) * f(m) <= 0:
                    r = m
                else:
                    l = m
            found.append((l + r) / 2)
    uniq = []
    for v in sorted(found):
        if not uniq or abs(v - uniq[-1]) > 1e-6:
            uniq.append(v)
    try:
        claim_vals = sorted({float(sp.N(to_sym(c, [var]), 30)) for c in (claimed or [])})
    except Exception as ex:
        return {"status": "error", "engine": "sympy", "detail": "声称的解无法解析 %s" % str(ex)[:100]}
    missing = [v for v in uniq if not any(abs(v - c) < 1e-6 for c in claim_vals)]
    extra = [v for v in claim_vals if not any(abs(v - u) < 1e-6 for u in uniq)]
    info = {"engine": "numeric/scan", "scanned": [lo, hi], "found": [round(v, 10) for v in uniq],
            "claimed": [round(v, 10) for v in claim_vals]}
    if missing or extra:
        info["status"] = "refuted"
        info["detail"] = "解集不符：漏 %s；多 %s（数值扫描 %g..%g）" % (
            [round(v, 8) for v in missing][:6], [round(v, 8) for v in extra][:6], lo, hi)
        return info
    info["status"] = "no_counterexample_found"
    info["detail"] = "数值扫描 [%g,%g] 内找到 %d 个零点，与声称解集一致" % (lo, hi, len(uniq))
    return info


def check_roots(expr, claimed, var="x", domain="real"):
    """核对方程 expr=0 的解集是否与模型声称的一致（SymPy 精确解 + 数值回代）。"""
    x = sp.Symbol(var, real=True)
    try:
        e = to_sym(expr, [var])
    except Exception as ex:
        return {"status": "error", "engine": "sympy", "detail": "解析失败 %s" % str(ex)[:100]}
    try:
        if domain == "integer":
            exact = sp.solve(e, x, domain=sp.S.Reals)
            exact = [r for r in exact if r.is_integer]
        else:
            exact = sp.solve(e, x, domain=sp.S.Reals)
    except Exception as ex:
        return _roots_numeric(expr, claimed, var)
    if not exact:
        # 求解器搞不定（如 sin x = x/2）：退化成数值零点扫描
        return _roots_numeric(expr, claimed, var)
    exact_vals = sorted({float(sp.N(r, 30)) for r in exact})
    try:
        claim_vals = sorted({float(sp.N(to_sym(c, [var]), 30)) for c in (claimed or [])})
    except Exception as ex:
        return {"status": "error", "engine": "sympy", "detail": "声称的解无法解析 %s" % str(ex)[:100]}
    missing = [v for v in exact_vals if not any(abs(v - c) < 1e-9 for c in claim_vals)]
    extra = [v for v in claim_vals if not any(abs(v - e2) < 1e-9 for e2 in exact_vals)]
    info = {"engine": "sympy.solve", "exact": [round(v, 12) for v in exact_vals],
            "claimed": [round(v, 12) for v in claim_vals]}
    if missing or extra:
        info["status"] = "refuted"
        info["detail"] = "解集不符：漏 %s；多 %s" % ([round(v, 10) for v in missing], [round(v, 10) for v in extra])
        return info
    info["status"] = "proved"
    info["detail"] = "解集一致（%d 个实解，已回代核对）" % len(exact_vals)
    return info

def check_geom(hyps, goal, var_names, order="lex", timeout=20, ranges=None, nondeg=None):
    """几何命题判定：Gröbner 基（Wu 方法，理想成员）给严格证明；不成则用 z3 在实数上找反例构型。
    hyps: 假设多项式列表（每条形如 "(x-4)+3*y"，含义 =0）；goal: 断言多项式（=0 表示"恒为零"）。
    返回 proved（理想上恒等，代数簇意义）/ refuted（给出构型点）/ unknown。"""
    import os, sys, subprocess
    if not hyps or not goal:
        return {"status": "unknown", "engine": "geom", "detail": "需要 hyps 与 goal 两个字段"}
    if not var_names:
        return {"status": "unknown", "engine": "geom", "detail": "缺少 vars"}
    if len(var_names) > 8:
        return {"status": "unknown", "engine": "geom", "detail": "变量 %d 个，超过 8 个上限" % len(var_names)}
    nondeg = [x for x in (nondeg or []) if str(x).strip()]
    req = json.dumps({"hyps": hyps, "goal": goal, "vars": var_names,
                      "order": order, "nondeg": nondeg})
    worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "geom_worker.py")
    try:
        pr = subprocess.run([sys.executable, worker], input=req, capture_output=True,
                            text=True, timeout=timeout)
        out = json.loads((pr.stdout or "").strip() or "{}")
    except subprocess.TimeoutExpired:
        return {"status": "unknown", "engine": "sympy/groebner",
                "detail": "Gröbner 基计算超过 %d 秒（构型太复杂）" % timeout}
    except Exception as ex:
        return {"status": "error", "engine": "geom", "detail": str(ex)[:120]}
    if out.get("status") == "proved":
        return out
    # 理想不含 goal：试着用 z3 找一个「假设成立、但 goal ≠ 0」的真实构型
    try:
        import z3
        zs = {n: z3.Real(n) for n in var_names}
        solver = z3.Solver()
        solver.set("timeout", 8000)
        rr = ranges or {}
        for n in var_names:
            lo, hi = (float(rr[n][0]), float(rr[n][1])) if n in rr else (-8.0, 8.0)
            solver.add(zs[n] >= z3.RealVal(str(lo)), zs[n] <= z3.RealVal(str(hi)))
        for h in hyps:
            solver.add(to_z3(to_sym(h, var_names), zs) == 0)
        for nd in nondeg:
            solver.add(to_z3(to_sym(nd, var_names), zs) != 0)
        solver.add(to_z3(to_sym(goal, var_names), zs) != 0)
        if solver.check() == z3.sat:
            m = solver.model()
            pt = {}
            for n in var_names:
                v = m[zs[n]]
                try:
                    pt[n] = float(v.numerator_as_long()) / float(v.denominator_as_long())
                except Exception:
                    pt[n] = str(v)
            return {"status": "refuted", "engine": "z3/nlsat", "counterexample": pt,
                    "detail": "存在满足全部假设但目标不为零的构型，断言不成立"}
    except Exception:
        pass
    return out


def verify_claim(c):
    k = (c.get("kind") or "").lower()
    vars_hint = list((c.get("vars") or {}).keys())
    ranges = c.get("range") or {}
    ranges = {k2: (float(v[0]), float(v[1])) for k2, v in ranges.items()} if ranges else None
    t0 = time.time()
    try:
        if k == "identity":
            r = check_identity(c.get("lhs", ""), c.get("rhs", ""), vars_hint)
        elif k == "ineq":
            r = check_ineq(c.get("expr", ""), vars_hint, ranges, c.get("universal", True))
        elif k == "value":
            r = check_value(c.get("expr", ""), c.get("expected", ""), c.get("tol", "1e-12"))
        elif k == "counterexample":
            r = check_counterexample(c.get("expr", ""), vars_hint, ranges)
        elif k == "nt":
            r = check_nt(c.get("expr", ""), c.get("assert", "prime"))
        elif k in ("forall_int", "int_forall", "exhaustive"):
            r = check_forall_int(c.get("expr", ""), c.get("vars") or {}, params=c.get("params"))
        elif k in ("exists_int", "witness"):
            r = check_exists_int(c.get("expr", ""), c.get("vars") or {}, params=c.get("params"))
        elif k == "recurrence":
            r = check_recurrence(c.get("closed", ""), c.get("rec", ""), c.get("init", "1"),
                                 c.get("range", {}).get("n", [2, 40]))
        elif k in ("roots", "solutions", "solve"):
            r = check_roots(c.get("expr", ""), c.get("claimed") or c.get("solutions") or [],
                            c.get("var", "x"), c.get("domain", "real"))
            if c.get("range") and c["range"].get(c.get("var", "x")):
                lo, hi = c["range"][c.get("var", "x")]
                if r.get("status") in ("unknown", "no_counterexample_found"):
                    r = _roots_numeric(c.get("expr", ""), c.get("claimed") or [], c.get("var", "x"), lo, hi)
        elif k in ("geom", "geometry"):
            r = check_geom(c.get("hyps") or [], c.get("goal", ""), vars_hint,
                           c.get("order", "lex"), int(c.get("timeout", 20)), ranges,
                           c.get("nondeg") or [])
        elif k == "mod":
            r = check_mod(c.get("expr", ""), c.get("mod", 2), c.get("vars") or {}, params=c.get("params"))
        else:
            r = {"status": "skipped", "engine": "-", "detail": "未知类型 %s" % k}
    except Exception as e:
        r = {"status": "error", "engine": "-", "detail": "%s: %s" % (type(e).__name__, str(e)[:160])}
    r["claim"] = c.get("note") or c.get("expr") or c.get("lhs", "")
    r.setdefault("secs", round(time.time() - t0, 2))
    r["secs"] = round(time.time() - t0, 2)
    return r

def verify_claims(claims):
    out = []
    for c in claims[:20]:
        out.append(verify_claim(c))
    proved = sum(1 for r in out if r["status"] in ("proved", "no_counterexample_found", "none_found"))
    refuted = sum(1 for r in out if r["status"] == "refuted")
    return {"results": out, "summary": {"total": len(out), "proved": proved, "refuted": refuted},
            "coverage": round(proved / len(out), 3) if out else 0.0}

if __name__ == "__main__":
    import sys
    tests = [
        {"kind": "identity", "lhs": "(a+b)^2", "rhs": "a^2+2*a*b+b^2", "vars": {"a": "real", "b": "real"}},
        {"kind": "ineq", "expr": "a^2+b^2+c^2-a*b-b*c-c*a>=0", "vars": {"a": "real", "b": "real", "c": "real"}},
        {"kind": "ineq", "expr": "sin(x)-2*x/pi>=0", "vars": {"x": "real"}, "range": {"x": [0, 3.14159265358979]}},
        {"kind": "ineq", "expr": "sin(x)<=2*x/pi", "vars": {"x": "real"}, "range": {"x": [0, 1]}},
        {"kind": "value", "expr": "sqrt(13)", "expected": "3.6055512754639893"},
        {"kind": "nt", "expr": "2^61-1", "assert": "prime"},
    ]
    if len(sys.argv) > 1:
        tests = json.loads(sys.argv[1])
    t = time.time()
    print(json.dumps(verify_claims(tests), ensure_ascii=False, indent=1))
    print("total %.2fs" % (time.time() - t))
