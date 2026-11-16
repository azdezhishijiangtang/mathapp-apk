#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""geom_worker.py —— Gröbner 基（Wu 方法）几何命题判定器，独立进程运行以便硬超时。

输入（stdin 的 JSON）：{"hyps": ["(x-4)+3*y", "4*(x-1)"], "goal": "-3*x+3*y", "vars": ["x", "y"], "order": "lex"}
输出（stdout 的 JSON）：{"status": "proved|not_in_ideal|unknown|error", ...}

判定逻辑：把几何条件化成多项式组 H，断言化成 g。若 g 落在 H 生成的理想里
（即 g 对 H 的 Gröbner 基约化为 0），则在「H 全部成立」的复代数簇上 g 恒为 0。
注意：这是代数簇上的结论，退化情形（分母为零、点重合）需要另加非退化条件。
"""
import json
import sys


def main():
    try:
        req = json.load(sys.stdin)
    except Exception as ex:
        print(json.dumps({"status": "error", "detail": "输入 JSON 解析失败 %s" % str(ex)[:80]}))
        return
    try:
        import sympy as sp
        names = req.get("vars") or []
        if not names:
            print(json.dumps({"status": "unknown", "detail": "缺少 vars"}))
            return
        syms = [sp.Symbol(v, real=True) for v in names]
        L = {v: s for v, s in zip(names, syms)}
        hyps = [sp.sympify(h.replace("^", "**"), locals=L) for h in (req.get("hyps") or []) if str(h).strip()]
        goal = sp.sympify(str(req.get("goal", "")).replace("^", "**"), locals=L)
        if not hyps:
            print(json.dumps({"status": "unknown", "detail": "没有假设多项式"}))
            return
        nondeg = [sp.sympify(h.replace("^", "**"), locals=L)
                  for h in (req.get("nondeg") or []) if str(h).strip()]
        aux = []
        if nondeg:
            # 局部化：加入 nondeg_i * s_i - 1，等价于"在 nondeg_i ≠ 0 的区域上"做判定
            aux = [sp.Symbol("_s%d" % i, real=True) for i in range(len(nondeg))]
            hyps = hyps + [n * sv - 1 for n, sv in zip(nondeg, aux)]
        syms_all = syms + aux
        if len(syms) > 8 or len(hyps) > 14:
            print(json.dumps({"status": "unknown", "detail": "规模超限（%d 变量 / %d 假设）" % (len(syms), len(hyps))}))
            return
        try:
            deg = int(max([sp.total_degree(sp.Poly(f, *syms)) for f in hyps + [goal]] or [0]))
        except Exception:
            deg = 0
        if deg < 0:
            deg = 0
        if deg > 12:
            print(json.dumps({"status": "unknown", "detail": "多项式次数 %d 过高" % deg}))
            return
        order = req.get("order") or "lex"
        G = sp.groebner(hyps, *syms_all, order=order, domain=sp.QQ)
        rem = G.reduce(goal)[1]
        zeros = (rem == 0)
        out = {"engine": "sympy/groebner", "order": order, "basis": len(G.exprs),
               "degree": deg, "nondeg": len(nondeg), "remainder": str(sp.nsimplify(rem))[:120]}
        if zeros:
            out["status"] = "proved"
            out["detail"] = ("目标多项式对假设的 Gröbner 基约化为 0：在假设的理想上恒成立"
                             "（代数簇意义，退化构型需另验证）")
        else:
            out["status"] = "not_in_ideal"
            out["detail"] = "目标不属于假设生成的理想，此构型下不恒成立（或假设不足）"
        print(json.dumps(out, ensure_ascii=False))
    except Exception as ex:
        print(json.dumps({"status": "error", "detail": "%s: %s" % (type(ex).__name__, str(ex)[:140])},
                         ensure_ascii=False))


if __name__ == "__main__":
    main()
