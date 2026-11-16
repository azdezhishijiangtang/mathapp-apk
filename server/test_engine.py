#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""engine.py 新判定器实测用例：每条都带预期结果，对不上就报 FAIL。"""
import json, sys, time
sys.path.insert(0, "/root/workspace/mathapp")
import engine as E

CASES = [
    # (说明, claim, 预期 status, 附加期望)
    ("取整恒等 floor(n/2)+ceil(n/2)=n", {"kind": "forall_int", "expr": "floor(n/2)+ceil(n/2)==n", "vars": {"n": [0, 200]}}, "proved", {}),
    ("取整反例 floor(3n/2)≠3floor(n/2)", {"kind": "forall_int", "expr": "floor(3*n/2)==3*floor(n/2)", "vars": {"n": [1, 60]}}, "refuted", {"point_has": "n"}),
    ("n²+n+41 素数性：n=40 破功", {"kind": "forall_int", "expr": "isprime(n^2+n+41)", "vars": {"n": [1, 500]}}, "refuted", {"point_is": {"n": "40"}}),
    ("a³-a 恒被 6 整除", {"kind": "mod", "expr": "a^3-a", "mod": 6, "vars": {"a": [1, 300]}}, "proved", {}),
    ("n²-n 不被 4 整除（应被推翻）", {"kind": "mod", "expr": "n^2-n", "mod": 4, "vars": {"n": [1, 50]}}, "refuted", {}),
    ("递推闭式 2^n-1 对 2a+1", {"kind": "recurrence", "closed": "2^n-1", "rec": "2*a_prev+1", "range": {"n": [2, 60]}}, "proved", {}),
    ("递推闭式写错 2^n", {"kind": "recurrence", "closed": "2^n", "rec": "2*a_prev+1", "range": {"n": [2, 30]}}, "refuted", {}),
    ("存在整数解 n*m=391", {"kind": "exists_int", "expr": "n*m==391", "vars": {"n": [1, 100], "m": [1, 100]}}, "proved", {}),
    ("不存在 n²=2m²", {"kind": "exists_int", "expr": "n*n==2*m*m", "vars": {"n": [1, 200], "m": [1, 200]}}, "refuted", {}),
    ("多变量 sin x+sin y≤2", {"kind": "ineq", "expr": "sin(x)+sin(y)<=2", "vars": {"x": "real", "y": "real"}, "range": {"x": [0, 3], "y": [0, 3]}}, "proved", {}),
    ("多变量 sin x+sin y≤1.5（有反例）", {"kind": "ineq", "expr": "sin(x)+sin(y)<=1.5", "vars": {"x": "real", "y": "real"}, "range": {"x": [0, 3], "y": [0, 3]}}, "refuted", {}),
    ("三变量 x²+y²+z²≥xy+yz+zx", {"kind": "ineq", "expr": "x^2+y^2+z^2-x*y-y*z-z*x>=0", "vars": {"x": "real", "y": "real", "z": "real"}, "range": {"x": [-1, 1], "y": [-1, 1], "z": [-1, 1]}}, "proved", {}),
    ("取整+实数参数 floor(1.5n)=n+floor(n/2)", {"kind": "forall_int", "expr": "floor(alpha*n)==n+floor(n/2)", "vars": {"n": [1, 300]}, "params": {"alpha": 1.5}}, "proved", {}),
    ("取整+实数参数反例 floor(αn)=αn", {"kind": "forall_int", "expr": "floor(alpha*n)==alpha*n", "vars": {"n": [1, 20]}, "params": {"alpha": 1.5}}, "refuted", {"point_is": {"alpha": "1.5", "n": "1"}}),
    ("阶乘 10! 位数", {"kind": "forall_int", "expr": "len(digits(factorial(10)))==7", "vars": {"k": [1, 2]}}, "proved", {}),
    ("1681 是合数", {"kind": "nt", "expr": "1681", "assert": "composite"}, "proved", {}),
    ("1601 是素数", {"kind": "nt", "expr": "1601", "assert": "prime"}, "proved", {}),
    ("1681=41²", {"kind": "nt", "expr": "1681", "assert": "square"}, "proved", {}),
    ("解集一致 x²-5x+6", {"kind": "roots", "expr": "x^2-5*x+6", "claimed": ["2", "3"], "var": "x"}, "proved", {}),
    ("解集漏根 x²-5x+6", {"kind": "roots", "expr": "x^2-5*x+6", "claimed": ["2"], "var": "x"}, "refuted", {}),
    ("超越方程 sin x=x/2 三根", {"kind": "roots", "expr": "sin(x)-x/2", "claimed": ["0", "1.89549426703398", "-1.89549426703398"], "var": "x"}, "no_counterexample_found", {}),
    ("超越方程漏负根", {"kind": "roots", "expr": "sin(x)-x/2", "claimed": ["0", "1.89549426703398"], "var": "x"}, "refuted", {}),
    ("CP-SAT 大区间 find n·m=391", {"kind": "exists_int", "expr": "n*m==391 and n>m", "vars": {"n": [1, 1000000000], "m": [1, 1000000000]}}, "proved", {}),
    ("CP-SAT 大区间证 n²≠2m²", {"kind": "forall_int", "expr": "n*n!=2*m*m", "vars": {"n": [1, 1000000], "m": [1, 1000000]}}, "proved", {}),
    ("CP-SAT 大区间找反例 n·m≠391", {"kind": "forall_int", "expr": "n*m!=391", "vars": {"n": [1, 1000000000], "m": [1, 1000000000]}}, "refuted", {}),
    ("CP-SAT 模 41 反例 n=40", {"kind": "forall_int", "expr": "Mod(n*n+n+41,41)!=0", "vars": {"n": [1, 200]}}, "refuted", {"point_is": {"n": "40"}}),
    ("cvc5 严格证明 sin x+sin y≤2", {"kind": "ineq", "expr": "sin(x)+sin(y)<=2", "vars": {"x": "real", "y": "real"}, "range": {"x": [0, 3], "y": [0, 3]}}, "proved", {}),
    ("numpy 扫描 深中(1) [0,π/2]", {"kind": "ineq", "expr": "(1+sin(x))/(pi+2*x)-1/pi>=0", "vars": {"x": "real"}, "range": {"x": [0, 1.5707963]}}, "no_counterexample_found", {"points_gt": 1000}),
    ("同一式放到 [0,π] 被推翻", {"kind": "ineq", "expr": "(1+sin(x))/(pi+2*x)-1/pi>=0", "vars": {"x": "real"}, "range": {"x": [0, 3.1415926]}}, "refuted", {}),
    ("几何 垂心 AH⊥BC", {"kind": "geom", "hyps": ["(x-4)+3*y", "4*(x-1)"], "goal": "-3*x+3*y", "vars": {"x": "real", "y": "real"}}, "proved", {}),
    ("几何 假断言 AH⊥AB", {"kind": "geom", "hyps": ["(x-4)+3*y", "4*(x-1)"], "goal": "4*x", "vars": {"x": "real", "y": "real"}}, "refuted", {}),
    ("几何 中位线平行底边", {"kind": "geom", "hyps": ["2*ym-b", "2*yn-b"], "goal": "ym-yn", "vars": {"ym": "real", "yn": "real", "b": "real"}}, "proved", {}),
    ("几何 欧拉线（含非退化）", {"kind": "geom", "hyps": ["ox^2+oy^2-((ox-1)^2+oy^2)", "ox^2+oy^2-((ox-p)^2+(oy-q)^2)", "(hx-1)*p+hy*q", "(hx-p)"], "goal": "(hx-ox)*((q/3)-oy)-((hy-oy)*(((1+p)/3)-ox))", "vars": {"ox": "real", "oy": "real", "hx": "real", "hy": "real", "p": "real", "q": "real"}, "nondeg": ["q"], "timeout": 60}, "proved", {}),
    ("空间过大要拒（CP-SAT 可证）", {"kind": "forall_int", "expr": "n>0", "vars": {"n": [1, 100000000]}}, "proved", {}),
]

def main():
    fails = 0
    for name, claim, want, extra in CASES:
        r = E.verify_claim(claim)
        got = r.get("status")
        ok = got == want
        notes = []
        if "point_is" in extra:
            pt = r.get("point") or {}
            if pt != extra["point_is"]:
                ok = False; notes.append("point=%s 期望 %s" % (pt, extra["point_is"]))
        if "point_has" in extra:
            if not (r.get("point") or {}).get(extra["point_has"]):
                ok = False; notes.append("缺少反例点")
        if "points_gt" in extra:
            n = (r.get("points") or (r.get("info") or {}).get("points") or 0)
            if n <= extra["points_gt"]:
                ok = False; notes.append("采样点仅 %s" % n)
        print(("PASS " if ok else "FAIL ") + name)
        print("   status=%s engine=%s %.2fs %s" % (got, r.get("engine"), r.get("secs", 0), (r.get("detail") or "")[:90]))
        if r.get("point"):
            print("   point=%s" % json.dumps(r["point"], ensure_ascii=False))
        for x in notes:
            print("   ! " + x)
        fails += (0 if ok else 1)

    # latex2py 覆盖
    lt = [("\\lfloor x \\rfloor", "floor(x)"), ("\\lceil y \\rceil", "ceiling(y)"),
          ("\\binom{5}{2}", "binomial(5,2)"), ("5!", "factorial(5)")]
    for src, want in lt:
        got = E.latex2py(src).replace(" ", "")
        ok = want.replace(" ", "") in got
        print(("PASS " if ok else "FAIL ") + "latex2py %-18s -> %s" % (src, got))
        fails += (0 if ok else 1)

    print("\n%s  失败 %d / %d" % ("全部通过" if not fails else "有失败", fails, len(CASES) + len(lt)))
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
